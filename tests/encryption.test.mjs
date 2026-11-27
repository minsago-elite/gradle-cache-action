// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  configureEncryption,
  validateEncryptionKey,
  encryptArchive,
  decryptArchive,
  packConfiguration,
  unpackConfiguration,
  saveConfiguration,
  restoreConfiguration,
  LIMITS,
} from '../src/encryption.mjs';
const key = Buffer.alloc(16, 42).toString('base64');
async function fixture(fn) {
  const root = await fs.mkdtemp(path.resolve('.encryption-test-'));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test('AES keys are validated and exported before Gradle', () => {
  const calls = [];
  assert.equal(configureEncryption('', {}), false);
  configureEncryption(key, {
    setSecret: (v) => calls.push(v),
    exportVariable: (n, v) => calls.push([n, v]),
  });
  assert.deepEqual(calls, [key, ['GRADLE_ENCRYPTION_KEY', key]]);
  for (const n of [16, 24, 32])
    assert.equal(validateEncryptionKey(Buffer.alloc(n).toString('base64')).length, n);
  for (const bad of ['abc', '!!!!!!!!!!!!!!!!!!!!!!!!', 'YQ=='])
    assert.throws(() => validateEncryptionKey(bad));
});
test('authenticated encryption decrypts and rejects tampering or rotated key', () => {
  const data = Buffer.from('secret credential'),
    encrypted = encryptArchive(data, key);
  assert.equal(encrypted.includes(data), false);
  assert.deepEqual(decryptArchive(encrypted, key), data);
  encrypted[17] ^= 1;
  assert.throws(() => decryptArchive(encrypted, key));
  assert.throws(() =>
    decryptArchive(encryptArchive(data, key), Buffer.alloc(16, 3).toString('base64')),
  );
});
test('relative archive relocates and rejects traversal and symlinks', () =>
  fixture(async (root) => {
    const source = path.join(root, 'source'),
      target = path.join(root, 'target');
    await fs.mkdir(path.join(source, 'nested'), { recursive: true });
    await fs.writeFile(path.join(source, 'nested/entry.bin'), 'secret');
    await unpackConfiguration(target, await packConfiguration(source));
    assert.equal(await fs.readFile(path.join(target, 'nested/entry.bin'), 'utf8'), 'secret');
    for (const name of ['../escape', '/escape', 'C:/escape', 'a/../../escape', 'a\\b'])
      await assert.rejects(
        unpackConfiguration(target, Buffer.from(JSON.stringify([[name, 'eA==']]))),
      );
    await fs.symlink(source, path.join(target, 'link'));
    await assert.rejects(
      unpackConfiguration(target, Buffer.from(JSON.stringify([['link/escape', 'eA==']]))),
    );
    await assert.rejects(packConfiguration(target));
  }));
test('cache adapter receives only ciphertext and relocatable paths; policies gate calls', () =>
  fixture(async (root) => {
    const first = path.join(root, 'one'),
      second = path.join(root, 'two');
    await fs.mkdir(path.join(first, '.gradle/configuration-cache'), { recursive: true });
    await fs.mkdir(second);
    await fs.writeFile(path.join(first, '.gradle/configuration-cache/entry'), 'sensitive');
    let stored,
      storedKey,
      calls = 0;
    const cache = {
      saveCache: async (paths, k) => {
        calls++;
        assert.equal(path.isAbsolute(paths[0]), false);
        stored = await fs.readFile(paths[0]);
        storedKey = k;
        assert.equal(stored.includes(Buffer.from('sensitive')), false);
        return 1;
      },
      restoreCache: async (paths, k, prefixes, options) => {
        if (options?.lookupOnly) return undefined;
        calls++;
        assert.deepEqual(prefixes, []);
        assert.equal(k, storedKey);
        await fs.writeFile(paths[0], stored);
        return storedKey;
      },
    };
    assert.equal(
      (await saveConfiguration({ workspace: first, key, cache, runnerTemp: root })).saved,
      true,
    );
    assert.equal(
      (
        await restoreConfiguration({
          workspace: second,
          key,
          cache,
          runnerTemp: root,
          restoreKey: storedKey,
        })
      ).hit,
      true,
    );
    assert.equal(
      await fs.readFile(path.join(second, '.gradle/configuration-cache/entry'), 'utf8'),
      'sensitive',
    );
    await saveConfiguration({ workspace: first, key, cache, readOnly: true });
    await restoreConfiguration({ workspace: first, key, cache, writeOnly: true });
    await saveConfiguration({ workspace: first, cache });
    await restoreConfiguration({ workspace: first, cache });
    assert.equal(calls, 2);
  }));

test('existing workspace files and configuration cache are preserved', () =>
  fixture(async (root) => {
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspace, '.gradle-cache-action'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.gradle/configuration-cache'), { recursive: true });
    const owned = path.join(workspace, '.gradle-cache-action/configuration.enc');
    const entry = path.join(workspace, '.gradle/configuration-cache/entry');
    await fs.writeFile(owned, 'project file');
    await fs.writeFile(entry, 'existing configuration');
    const cache = {
      restoreCache: async (paths, k, prefixes, options) => {
        assert.equal(options?.lookupOnly, true);
        return undefined;
      },
      saveCache: async (paths) => {
        assert.equal(process.env.GITHUB_WORKSPACE, process.cwd());
        assert.ok(process.cwd().startsWith(root + path.sep + 'gradle-configuration-'));
        assert.equal(paths[0], 'configuration.enc');
        return 1;
      },
    };
    assert.equal(
      await restoreConfiguration({ workspace, key, cache, runnerTemp: root }),
      undefined,
    );
    await assert.rejects(
      unpackConfiguration(
        path.dirname(entry),
        Buffer.from(JSON.stringify([['replacement', 'eA==']])),
      ),
    );
    await saveConfiguration({ workspace, key, cache, runnerTemp: root });
    assert.equal(await fs.readFile(owned, 'utf8'), 'project file');
    assert.equal(await fs.readFile(entry, 'utf8'), 'existing configuration');
    assert.deepEqual((await fs.readdir(root)).sort(), ['workspace']);
  }));
test('corrupt, conflicting, oversized, and unsafe archives publish no state', () =>
  fixture(async (root) => {
    const destination = path.join(root, 'project/configuration-cache');
    for (const bytes of [
      Buffer.from('{'),
      Buffer.from('{}'),
      Buffer.from(
        JSON.stringify([
          ['a', 'eA=='],
          ['a/b', 'eA=='],
        ]),
      ),
      Buffer.from(JSON.stringify([['a', '*invalid*']])),
      Buffer.alloc(LIMITS.archive + 1),
      Buffer.from(
        JSON.stringify(Array.from({ length: LIMITS.files + 1 }, (_, i) => [String(i), ''])),
      ),
    ]) {
      await assert.rejects(unpackConfiguration(destination, bytes));
      await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    }
    await fs.mkdir(path.join(root, 'source'));
    const oversized = await fs.open(path.join(root, 'source/large'), 'w');
    await oversized.truncate(LIMITS.bytes + 1);
    await oversized.close();
    await assert.rejects(packConfiguration(path.join(root, 'source')), /size limit/);
  }));

test('manifest exact keys isolate concurrent producers and reuse identical immutable content', () =>
  fixture(async (root) => {
    const producer = path.join(root, 'producer');
    const config = path.join(producer, '.gradle/configuration-cache');
    await fs.mkdir(config, { recursive: true });
    const stored = new Map();
    let uploads = 0,
      restores = 0,
      wrongHit = false;
    const cache = {
      saveCache: async (paths, k) => {
        uploads++;
        stored.set(k, await fs.readFile(paths[0]));
        return uploads;
      },
      restoreCache: async (paths, k, prefixes, options) => {
        assert.deepEqual(prefixes, []);
        if (options?.lookupOnly) return stored.has(k) ? k : undefined;
        restores++;
        if (wrongHit) return [...stored.keys()].find((candidate) => candidate !== k);
        if (!stored.has(k)) return undefined;
        await fs.writeFile(paths[0], stored.get(k));
        return k;
      },
    };
    const base = { workspace: producer, key, cache, runnerTemp: root, scope: 'producer' };
    await fs.writeFile(path.join(config, 'entry'), 'A');
    const a = await saveConfiguration(base);
    assert.equal(a.available, true);
    const duplicate = await saveConfiguration(base);
    assert.deepEqual(duplicate, { key: a.key, saved: false, available: true });
    assert.equal(uploads, 1);
    await fs.writeFile(path.join(config, 'entry'), 'B');
    const b = await saveConfiguration(base);
    assert.notEqual(a.key, b.key);
    const consumer = path.join(root, 'consumer');
    await fs.mkdir(consumer);
    const restore = {
      ...base,
      workspace: consumer,
      scope: 'consumer',
      restoreScope: 'producer',
      restoreKey: a.key,
    };
    assert.equal((await restoreConfiguration(restore)).key, a.key);
    assert.equal(
      await fs.readFile(path.join(consumer, '.gradle/configuration-cache/entry'), 'utf8'),
      'A',
    );
    await fs.rm(path.join(consumer, '.gradle'), { recursive: true });
    wrongHit = true;
    assert.equal(await restoreConfiguration(restore), undefined);
    await assert.rejects(fs.stat(path.join(consumer, '.gradle/configuration-cache')), {
      code: 'ENOENT',
    });
    wrongHit = false;
    stored.set(a.key, stored.get(b.key));
    assert.equal(await restoreConfiguration(restore), undefined);
    assert.equal(
      await restoreConfiguration({ ...restore, restoreKey: a.key + 'extra' }),
      undefined,
    );
    assert.equal(await restoreConfiguration({ ...restore, restoreScope: 'unrelated' }), undefined);
    assert.equal(await restoreConfiguration({ ...restore, restoreKey: undefined }), undefined);
    assert.equal(restores, 3);
  }));
test('save race reports availability only after exact lookup confirmation', () =>
  fixture(async (root) => {
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspace, '.gradle/configuration-cache'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.gradle/configuration-cache/entry'), 'same');
    let uploaded = false;
    const cache = {
      saveCache: async () => {
        uploaded = true;
        return -1;
      },
      restoreCache: async (paths, k, prefixes, opts) => {
        assert.equal(opts.lookupOnly, true);
        return uploaded ? k : undefined;
      },
    };
    const result = await saveConfiguration({ workspace, key, cache, runnerTemp: root });
    assert.equal(result.saved, false);
    assert.equal(result.available, true);
    cache.restoreCache = async () => undefined;
    assert.equal(
      (await saveConfiguration({ workspace, key, cache, runnerTemp: root })).available,
      false,
    );
  }));
