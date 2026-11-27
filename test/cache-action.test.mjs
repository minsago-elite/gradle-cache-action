// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configuration, runMain, runPost } from '../src/action.mjs';
import { snapshotPath, fingerprint, descriptorUnit, stageSnapshot } from '../src/engine.mjs';

function core(inputs = {}) {
  const state = {},
    outputs = {},
    messages = [];
  const summary = {
    addHeading() {
      return this;
    },
    addTable() {
      return this;
    },
    addRaw() {
      return this;
    },
    async write() {},
  };
  return {
    state,
    outputs,
    messages,
    summary,
    getInput: (n) => inputs[n] || '',
    saveState: (n, v) => (state[n] = v),
    getState: (n) => state[n] || '',
    setOutput: (n, v) => (outputs[n] = v),
    exportVariable() {},
    setSecret() {},
    notice: (m) => messages.push(m),
    info: (m) => messages.push(m),
    warning: (m) => messages.push(m),
  };
}
async function fixture(fn) {
  const cwd = process.cwd(),
    workspace = process.env.GITHUB_WORKSPACE;
  const root = await fs.mkdtemp(path.join(cwd, '.action-test-'));
  try {
    await fn(root);
  } finally {
    process.chdir(cwd);
    if (workspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = workspace;
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function put(home, name, value = 'payload') {
  const file = path.join(home, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}
function backend(root) {
  const entries = new Map(),
    restores = [],
    saves = [];
  return {
    entries,
    restores,
    saves,
    async restoreCache(paths, key, prefixes) {
      restores.push({ paths, key, prefixes });
      const hit = entries.has(key)
        ? key
        : [...entries.keys()].reverse().find((k) => (prefixes || []).some((p) => k.startsWith(p)));
      if (!hit) return undefined;
      for (const p of paths) await fs.cp(entries.get(hit), p, { recursive: true });
      return hit;
    },
    async saveCache(paths, key) {
      saves.push({ paths, key });
      if (entries.has(key)) return -1;
      const target = path.join(root, 'store', String(saves.length));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(paths[0], target, { recursive: true });
      entries.set(key, target);
      return entries.size;
    },
  };
}
async function session(root, name, cache, extra = {}, envOverrides = {}, defaultBranch = 'main') {
  const home = path.join(root, name),
    event = path.join(root, 'event.json');
  await fs.writeFile(event, JSON.stringify({ repository: { default_branch: defaultBranch } }));
  const env = {
    GITHUB_WORKSPACE: path.join(root, 'workspace'),
    RUNNER_TEMP: root,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: name,
    GITHUB_RUN_ID: name,
    GITHUB_EVENT_PATH: event,
    ...envOverrides,
  };
  const c = core({ 'gradle-user-home': home, 'job-status': 'success', ...extra });
  await runMain(c, cache, env);
  return { home, c, env, post: () => runPost(c, cache, env) };
}

test('cold save and warm restore relocate snapshots and deduplicate by content', () =>
  fixture(async (root) => {
    const cache = backend(root),
      first = await session(root, 'first', cache);
    assert.equal(first.c.outputs['cache-hit'], 'false');
    await put(first.home, 'caches/modules-2/files-2.1/library.jar');
    await first.post();
    assert.equal(first.c.outputs['cache-saved-count'], 1);
    assert.equal(cache.saves[0].paths[0], snapshotPath({ name: 'dependencies' }));
    const second = await session(root, 'second', cache);
    assert.equal(second.c.outputs['cache-hit'], 'true');
    assert.equal(
      await fs.readFile(path.join(second.home, 'caches/modules-2/files-2.1/library.jar'), 'utf8'),
      'payload',
    );
    await second.post();
    assert.equal(cache.saves.filter((s) => s.paths[0] !== 'manifest.json').length, 1);
    const third = await session(root, 'third', cache);
    await put(third.home, 'caches/modules-2/files-2.1/library.jar', 'changed');
    await third.post();
    const contents = cache.saves.filter((s) => s.paths[0] !== 'manifest.json');
    assert.equal(contents.length, 2);
    assert.notEqual(contents[0].key, contents[1].key);
    assert.equal(
      await fs.stat(second.c.state.stage).then(
        () => true,
        () => false,
      ),
      false,
    );
  }));

test('read-only and write-only policies gate the cache backend', () =>
  fixture(async (root) => {
    const cache = backend(root),
      read = await session(root, 'read', cache, { 'cache-read-only': 'true' });
    await put(read.home, 'caches/modules-2/files-2.1/library.jar');
    await read.post();
    assert.equal(cache.saves.length, 0);
    const before = cache.restores.length,
      write = await session(root, 'write', cache, { 'cache-write-only': 'true' });
    assert.equal(cache.restores.length, before);
    await put(write.home, 'caches/modules-2/files-2.1/library.jar');
    await write.post();
    assert.equal(cache.saves.filter((s) => s.paths[0] !== 'manifest.json').length, 1);
  }));

test('snapshots exclude credentials, configuration, transient files, custom exclusions and symlinks', () =>
  fixture(async (root) => {
    const cache = backend(root),
      s = await session(root, 'home', cache, { 'cache-exclude': '**/excluded.jar' });
    for (const file of [
      'gradle.properties',
      'init.d/credentials.gradle',
      'caches/8.0/configuration-cache/secret',
      'caches/modules-2/files-2.1/a.lock',
      'caches/modules-2/files-2.1/a.tmp',
      'caches/modules-2/files-2.1/excluded.jar',
    ])
      await put(s.home, file, 'secret');
    await put(s.home, 'caches/modules-2/files-2.1/good.jar');
    await fs.symlink(
      path.join(s.home, 'gradle.properties'),
      path.join(s.home, 'caches/modules-2/files-2.1/link.jar'),
    );
    await assert.rejects(s.post(), /Symlink/);
    assert.equal(cache.saves.length, 0);
    await fs.unlink(path.join(s.home, 'caches/modules-2/files-2.1/link.jar'));
    const clean = await session(root, 'clean', cache, { 'cache-exclude': '**/excluded.jar' });
    for (const file of [
      'gradle.properties',
      'init.d/credentials.gradle',
      'caches/8.0/configuration-cache/secret',
      'caches/modules-2/files-2.1/a.lock',
      'caches/modules-2/files-2.1/a.tmp',
      'caches/modules-2/files-2.1/excluded.jar',
    ])
      await put(clean.home, file, 'secret');
    await put(clean.home, 'caches/modules-2/files-2.1/good.jar');
    await clean.post();
    assert.equal(cache.saves.filter((s) => s.paths[0] !== 'manifest.json').length, 1);
    const target = cache.entries.values().next().value;
    assert.deepEqual(await fs.readdir(path.join(target, 'caches/modules-2/files-2.1')), [
      'good.jar',
    ]);
    assert.equal(
      await fs.readFile(path.join(s.home, 'caches/modules-2/files-2.1/a.tmp'), 'utf8'),
      'secret',
    );
  }));

test('backend errors propagate and failed saves remove staging files', () =>
  fixture(async (root) => {
    await assert.rejects(
      session(root, 'restore-failure', {
        restoreCache: async () => {
          throw Error('backend missing');
        },
      }),
      /backend missing/,
    );
    const s = await session(root, 'save-failure', {
      restoreCache: async () => undefined,
      saveCache: async () => {
        throw Error('backend unavailable');
      },
    });
    await put(s.home, 'caches/modules-2/files-2.1/library.jar');
    await assert.rejects(s.post(), /backend unavailable/);
    assert.equal(
      await fs.stat(s.c.state.stage).then(
        () => true,
        () => false,
      ),
      false,
    );
  }));

test('default branch is writable only with repository event evidence', () => {
  const c = core();
  assert.equal(configuration(c, { GITHUB_REF: 'refs/heads/main' }).readOnly, true);
  const event = JSON.stringify({ repository: { default_branch: 'main' } });
  assert.equal(
    configuration(c, { GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH_CONTENT: event }).readOnly,
    false,
  );
  for (const ref of ['refs/heads/topic', 'refs/pull/1/merge'])
    assert.equal(
      configuration(c, { GITHUB_REF: ref, GITHUB_EVENT_PATH_CONTENT: event }).readOnly,
      true,
    );
  assert.throws(
    () => configuration(core({ 'cache-read-only': 'true', 'cache-write-only': 'true' })),
    /cannot both/,
  );
});

test('restore refuses cache archive member symlinks before writing live files', () =>
  fixture(async (root) => {
    const cache = backend(root),
      first = await session(root, 'seed', cache);
    await put(first.home, 'caches/modules-2/files-2.1/good.jar');
    await first.post();
    const original = cache.restoreCache.bind(cache);
    cache.restoreCache = async (paths, ...args) => {
      const hit = await original(paths, ...args);
      if (hit && paths[0] === snapshotPath({ name: 'dependencies' }))
        await fs.symlink(root, path.join(paths[0], 'caches/modules-2/files-2.1/escape'));
      return hit;
    };
    await assert.rejects(session(root, 'home', cache), /Symlink/);
    assert.equal(
      await fs.stat(path.join(root, 'home/wrapper')).then(
        () => true,
        () => false,
      ),
      false,
    );
  }));

test('prepopulated Gradle home disables caching unless explicitly allowed', () =>
  fixture(async (root) => {
    await put(path.join(root, 'existing'), 'wrapper/dists/already.zip');
    const cache = backend(root),
      s = await session(root, 'existing', cache);
    await s.post();
    assert.equal(s.c.state.disabled, 'true');
    assert.equal(cache.restores.length, 0);
    assert.equal(cache.saves.length, 0);
  }));

test('cleanup policies prune unused restored versions after observed access and preserve live caches', () =>
  fixture(async (root) => {
    const cache = backend(root),
      seed = await session(root, 'seed', cache);
    const used = 'caches/modules-2/files-2.1/group/name/1/hash/used.jar',
      stale = 'caches/modules-2/files-2.1/group/name/2/hash/stale.jar';
    await put(seed.home, used);
    await put(seed.home, stale);
    await seed.post();
    const seedEntries = new Map(cache.entries);
    for (const [policy, status, pruned] of [
      ['always', 'failure', true],
      ['on-success', 'success', true],
      ['on-success', 'failure', false],
      ['never', 'success', false],
    ]) {
      cache.entries.clear();
      for (const [k, v] of seedEntries) cache.entries.set(k, v);
      const s = await session(root, `${policy}-${status}`, cache, {
        'cache-cleanup': policy,
        'job-status': status,
      });
      const stat = await fs.stat(path.join(s.home, used));
      await fs.utimes(path.join(s.home, used), new Date(stat.atimeMs + 10000), stat.mtime);
      const before = cache.saves.length;
      await s.post();
      const contentSave = cache.saves
        .slice(before)
        .find((x) => x.paths[0] === snapshotPath({ name: 'dependencies' }));
      if (pruned) {
        assert.ok(contentSave, 'pruned content receives a new content key');
        const archive = cache.entries.get(contentSave.key);
        assert.equal(
          await fs.stat(path.join(archive, stale)).then(
            () => true,
            () => false,
          ),
          false,
        );
        assert.equal(
          await fs.stat(path.join(archive, used)).then(
            () => true,
            () => false,
          ),
          true,
        );
      } else assert.equal(contentSave, undefined);
      assert.equal(await fs.readFile(path.join(s.home, stale), 'utf8'), 'payload');
    }
  }));

test('strict restore removes wider workflow fallback and preserves same-job history', () =>
  fixture(async (root) => {
    const cache = backend(root);
    await session(root, 'strict', cache, { 'cache-strict-match': 'true' });
    assert.equal(cache.restores[0].paths[0], 'manifest.json');
    assert.equal(cache.restores[0].prefixes.length, 2);
    await session(root, 'relaxed', cache);
    assert.equal(cache.restores[1].prefixes.length, 3);
    assert.ok(cache.restores[0].prefixes[0].startsWith(cache.restores[0].prefixes[1]));
  }));

test('wrapper distributions and generated Gradle API jars save independently by version', () =>
  fixture(async (root) => {
    const cache = backend(root),
      first = await session(root, 'first', cache, { 'cache-cleanup': 'never' });
    const distribution = (version) =>
      `wrapper/dists/gradle-${version}-bin/hash/gradle-${version}/lib/gradle-core.jar`;
    const api = (version) => `caches/${version}/generated-gradle-jars/gradle-api-${version}.jar`;
    await put(first.home, distribution('8.14'));
    await put(first.home, api('8.14'));
    await first.post();
    const original = cache.saves.filter((s) => s.paths[0] !== 'manifest.json');
    assert.equal(original.length, 2);
    const second = await session(root, 'second', cache, { 'cache-cleanup': 'never' });
    assert.equal(
      await fs.readFile(path.join(second.home, distribution('8.14')), 'utf8'),
      'payload',
    );
    assert.equal(await fs.readFile(path.join(second.home, api('8.14')), 'utf8'), 'payload');
    await put(second.home, distribution('9.2'));
    await put(second.home, api('9.2'));
    await second.post();
    const all = cache.saves.filter((s) => s.paths[0] !== 'manifest.json');
    assert.equal(all.length, 4);
    for (const entry of original)
      assert.equal(
        all.filter((s) => s.key === entry.key).length,
        1,
        'old physical entry is not uploaded again',
      );
    assert.equal(
      new Set(all.map((s) => s.paths[0])).size,
      4,
      'each version has a separate archive path',
    );
  }));

test('failed cache reservations cannot publish dangling manifest references', () =>
  fixture(async (root) => {
    let published;
    const cache = {
      restoreCache: async () => undefined,
      saveCache: async (paths) => {
        if (paths[0] !== 'manifest.json') return -1;
        published = JSON.parse(await fs.readFile(paths[0], 'utf8'));
        return 1;
      },
    };
    const s = await session(root, 'home', cache);
    await put(s.home, 'caches/modules-2/files-2.1/library.jar');
    await s.post();
    assert.deepEqual(published.units, {});
    assert.equal(s.c.outputs['cache-saved-count'], 0);
  }));

test('shared cache family restores seed bytes across workflows and matrices without writes', () =>
  fixture(async (root) => {
    const cache = backend(root);
    const inputs = {
      'cache-family': 'shared',
      'cache-key-prefix': 'shared-namespace',
      matrix: '{"os":"linux","java":17}',
    };
    const producer = await session(
      root,
      'seed-master',
      cache,
      inputs,
      {
        GITHUB_REF: 'refs/heads/master',
        GITHUB_WORKFLOW: 'Seed workflow',
        GITHUB_JOB: 'seed',
      },
      'master',
    );
    assert.equal(JSON.parse(producer.c.state.config).readOnly, false);
    const files = [
      'caches/modules-2/files-2.1/library.jar',
      'caches/modules-2/metadata-2.1/descriptor.bin',
      'caches/8.14/kotlin-dsl/generated.bin',
      'wrapper/dists/gradle-8.14-bin/hash/lib.jar',
      'caches/8.14/generated-gradle-jars/gradle-api-8.14.jar',
    ];
    for (const file of files) await put(producer.home, file, `seed:${file}`);
    await producer.post();
    const before = cache.saves.length;
    const consumer = await session(
      root,
      'consumer',
      cache,
      { ...inputs, matrix: '{"os":"linux","java":21}', 'cache-read-only': 'true' },
      {
        GITHUB_REF: 'refs/pull/12/merge',
        GITHUB_WORKFLOW: 'Pull request checks',
        GITHUB_JOB: 'verify',
      },
      'master',
    );
    assert.equal(consumer.c.outputs['cache-hit'], 'true');
    for (const file of files)
      assert.equal(await fs.readFile(path.join(consumer.home, file), 'utf8'), `seed:${file}`);
    await consumer.post();
    assert.equal(cache.saves.length, before);
    for (const [name, overrides] of [
      ['different-family', { 'cache-family': 'other' }],
      ['strict', { 'cache-strict-match': 'true' }],
      ['different-namespace', { 'cache-key-prefix': 'other-namespace' }],
    ]) {
      const negative = await session(
        root,
        name,
        cache,
        { ...inputs, ...overrides, matrix: '{"java":21}', 'cache-read-only': 'true' },
        { GITHUB_WORKFLOW: 'Other workflow', GITHUB_JOB: 'consumer' },
      );
      assert.equal(negative.c.outputs['cache-hit'], 'false');
      assert.equal(
        await fs.stat(path.join(negative.home, files[0])).then(
          () => true,
          () => false,
        ),
        false,
      );
      await negative.post();
    }
    assert.equal(cache.saves.length, before);
  }));

test('archive descriptors reject parent and current directory wrapper members', () => {
  for (const member of ['wrapper/dists/.', 'wrapper/dists/..'])
    assert.throws(() => descriptorUnit({ kind: 'wrapper', path: member }, 'scope', 'prefix'));
  assert.equal(
    configuration(core(), {
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'pull_request_target',
      GITHUB_EVENT_PATH_CONTENT: JSON.stringify({ repository: { default_branch: 'main' } }),
    }).readOnly,
    true,
  );
});

test('content hashes distinguish multiple files from a stream embedding file boundaries', () =>
  fixture(async (root) => {
    const home = path.join(root, 'hash-home');
    const first = 'caches/modules-2/files-2.1/a',
      second = 'caches/modules-2/files-2.1/b';
    await put(home, first, 'first');
    await put(home, second, 'second');
    process.chdir(home);
    const unit = { paths: ['caches/modules-2/files-2.1'] };
    const separate = await fingerprint(unit);
    const mode = String((await fs.stat(second)).mode & 0o777);
    await fs.writeFile(first, Buffer.from(`first\0${second}\0${mode}\0second`));
    await fs.unlink(second);
    const embedded = await fingerprint(unit);
    assert.notEqual(
      separate.hash,
      embedded.hash,
      'binary payload delimiters must not impersonate path and mode framing',
    );
  }));

test('archive key hashes immutable staged bytes when live files change around capture', () =>
  fixture(async (root) => {
    const home = path.join(root, 'live'),
      stage = path.join(root, 'private-stage');
    const relative = 'caches/modules-2/files-2.1/library.jar';
    const unit = { name: 'dependencies', paths: ['caches/modules-2/files-2.1'] };
    await put(home, relative, 'before');
    process.chdir(home);
    const earlierLive = await fingerprint(unit);
    await put(home, relative, 'captured revision');
    const captured = await stageSnapshot(unit, [], () => true, stage, home);
    assert.notEqual(
      captured.hash,
      earlierLive.hash,
      'an earlier live fingerprint cannot become the archive key',
    );
    await put(home, relative, 'changed after capture');
    const archive = path.join(stage, snapshotPath(unit));
    assert.equal(await fs.readFile(path.join(archive, relative), 'utf8'), 'captured revision');
    process.chdir(archive);
    assert.equal(
      (await fingerprint(unit)).hash,
      captured.hash,
      'cache key describes exactly the uploaded archive',
    );
    process.chdir(home);
    assert.notEqual(
      (await fingerprint(unit)).hash,
      captured.hash,
      'later live writes cannot change staged content or its key',
    );
  }));
