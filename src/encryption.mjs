// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
export const LIMITS = Object.freeze({
  files: 4096,
  bytes: 16 * 1024 * 1024,
  archive: 24 * 1024 * 1024,
  depth: 64,
});
const aad = Buffer.from('gradle-cache-action:configuration:v1');
export function validateEncryptionKey(value) {
  if (!value) return undefined;
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error('cache-encryption-key must be a base64 AES key');
  const key = Buffer.from(value, 'base64');
  if (![16, 24, 32].includes(key.length) || key.toString('base64') !== value)
    throw new Error('cache-encryption-key must encode 16, 24, or 32 AES key bytes');
  return key;
}
export function configureEncryption(key, core) {
  if (!validateEncryptionKey(key)) return false;
  core?.setSecret(key);
  core?.exportVariable('GRADLE_ENCRYPTION_KEY', key);
  return true;
}
export function encryptArchive(bytes, key) {
  if (bytes.length > LIMITS.archive) throw new Error('Configuration archive exceeds size limit');
  const secret = validateEncryptionKey(key),
    iv = randomBytes(12);
  if (!secret) throw new Error('Encryption key required');
  const cipher = createCipheriv(`aes-${secret.length * 8}-gcm`, secret, iv);
  cipher.setAAD(aad);
  return Buffer.concat([
    Buffer.from('GCC1'),
    iv,
    cipher.update(bytes),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
export function decryptArchive(bytes, key) {
  const secret = validateEncryptionKey(key);
  if (bytes.length > LIMITS.archive + 32)
    throw new Error('Configuration archive exceeds size limit');
  if (!secret || bytes.length < 32 || bytes.subarray(0, 4).toString() !== 'GCC1')
    throw new Error('Invalid encrypted configuration cache');
  const decipher = createDecipheriv(`aes-${secret.length * 8}-gcm`, secret, bytes.subarray(4, 16));
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(16, -16)), decipher.final()]);
}
async function safePath(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error('Symlink in configuration cache path');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
}
function member(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.split('/').some((p) => !p || p === '.' || p === '..') ||
    /^[A-Za-z]:/.test(name) ||
    path.posix.isAbsolute(name)
  )
    throw new Error('Unsafe configuration cache member');
  if (name.length > 4096 || name.split('/').length > LIMITS.depth)
    throw new Error('Configuration member exceeds path limit');
  return name;
}
export async function packConfiguration(root) {
  await safePath(root);
  const entries = [];
  let total = 0,
    visited = 0;
  async function walk(directory, prefix = '') {
    let files;
    try {
      files = await fs.opendir(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for await (const entry of files) {
      if (++visited > LIMITS.files) throw new Error('Configuration cache exceeds file limit');
      const name = member(prefix + entry.name),
        file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symlink in configuration cache');
      if (entry.isDirectory()) await walk(file, name + '/');
      else if (entry.isFile() && !/\.(lock|lck|tmp)$/.test(entry.name)) {
        const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || total + stat.size > LIMITS.bytes)
            throw new Error('Configuration cache exceeds size limit');
          // A bounded read also protects against a file growing after stat.
          const data = Buffer.alloc(Math.min(stat.size + 1, LIMITS.bytes - total + 1));
          let offset = 0;
          while (offset < data.length) {
            const { bytesRead } = await handle.read(data, offset, data.length - offset, null);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          if (offset > stat.size || total + offset > LIMITS.bytes)
            throw new Error('Configuration cache changed or exceeds size limit');
          total += offset;
          entries.push([name, data.subarray(0, offset).toString('base64')]);
        } finally {
          await handle.close();
        }
      }
    }
  }
  await walk(root);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const result = Buffer.from(JSON.stringify(entries));
  if (result.length > LIMITS.archive) throw new Error('Configuration archive exceeds size limit');
  return result;
}
function decodeEntries(bytes) {
  if (bytes.length > LIMITS.archive) throw new Error('Configuration archive exceeds size limit');
  const entries = JSON.parse(bytes.toString());
  if (!Array.isArray(entries) || entries.length > LIMITS.files)
    throw new Error('Invalid configuration archive');
  const seen = new Set();
  let total = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[1] !== 'string')
      throw new Error('Invalid configuration archive member');
    const name = member(entry[0]),
      data = entry[1];
    if (seen.has(name)) throw new Error('Duplicate configuration cache member');
    seen.add(name);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
      throw new Error('Invalid configuration member encoding');
    total += Buffer.byteLength(data, 'base64');
    if (total > LIMITS.bytes) throw new Error('Configuration cache exceeds size limit');
  }
  for (const name of seen) {
    const parts = name.split('/');
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join('/'))) throw new Error('Conflicting configuration cache members');
      parts.pop();
    }
  }
  return entries;
}
async function readEncrypted(file) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMITS.archive + 32)
      throw new Error('Invalid encrypted configuration archive size');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size)
      throw new Error('Encrypted configuration archive changed during read');
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
export async function unpackConfiguration(root, bytes) {
  const entries = decodeEntries(bytes);
  await safePath(root);
  if (await exists(root)) throw new Error('Existing project configuration cache is preserved');
  await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  // Build in a fresh sibling so parse/write failures cannot expose partial state.
  const stage = await fs.mkdtemp(path.join(path.dirname(root), '.configuration-cache-action-'));
  try {
    for (const [name, data] of entries) {
      const file = path.join(stage, name);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, Buffer.from(data, 'base64'), { mode: 0o600, flag: 'wx' });
    }
    await safePath(root);
    if (await exists(root)) throw new Error('Existing project configuration cache is preserved');
    await fs.rename(stage, root);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
  return entries.length;
}
function options(o, scope = o.scope) {
  const workspace = path.resolve(o.workspace || process.env.GITHUB_WORKSPACE || process.cwd());
  const secret = validateEncryptionKey(o.key);
  return {
    root: path.join(workspace, '.gradle/configuration-cache'),
    prefix: `${o.prefix || 'gradle'}-${process.platform}-${process.arch}-${scope || 'default'}-configuration-v2-${hash(secret).slice(0, 24)}-`,
  };
}
async function withStage(o, operation) {
  const temp = o.runnerTemp || process.env.RUNNER_TEMP;
  if (!temp || !path.isAbsolute(temp))
    throw new Error('RUNNER_TEMP must be absolute for encrypted configuration caching');
  await safePath(temp);
  const stage = await fs.mkdtemp(path.join(temp, 'gradle-configuration-'));
  const previous = process.cwd(),
    workspace = process.env.GITHUB_WORKSPACE;
  try {
    process.chdir(stage);
    process.env.GITHUB_WORKSPACE = stage;
    return await operation(stage, 'configuration.enc');
  } finally {
    process.chdir(previous);
    if (workspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = workspace;
    await fs.rm(stage, { recursive: true, force: true });
  }
}
export async function restoreConfiguration(o) {
  if (!o.key || o.disabled || o.writeOnly || !o.restoreKey) return undefined;
  const c = options(o, o.restoreScope || o.scope);
  if (
    typeof o.restoreKey !== 'string' ||
    !o.restoreKey.startsWith(c.prefix) ||
    !/^[a-f0-9]{64}$/.test(o.restoreKey.slice(c.prefix.length))
  )
    return undefined;
  await safePath(c.root);
  if (await exists(c.root)) return undefined;
  try {
    return await withStage(o, async (stage, relative) => {
      const hit = await o.cache.restoreCache([relative], o.restoreKey, []);
      if (hit !== o.restoreKey) return undefined;
      const file = path.join(stage, relative);
      await safePath(file);
      const archive = decryptArchive(await readEncrypted(file), o.key);
      if (c.prefix + hash(archive) !== o.restoreKey)
        throw new Error('Configuration cache digest mismatch');
      await unpackConfiguration(c.root, archive);
      return { key: hit, hit: true };
    });
  } catch {
    o.core?.warning(
      'Encrypted configuration cache could not be restored; Gradle will recreate it.',
    );
    return undefined;
  }
}
export async function saveConfiguration(o) {
  if (!o.key || o.disabled || o.readOnly) return undefined;
  const c = options(o),
    archive = await packConfiguration(c.root);
  if (archive.toString() === '[]') return undefined;
  return withStage(o, async (stage, relative) => {
    const cacheKey = c.prefix + hash(archive);
    const lookup = () => o.cache.restoreCache([relative], cacheKey, [], { lookupOnly: true });
    if ((await lookup()) === cacheKey) return { key: cacheKey, saved: false, available: true };
    await fs.writeFile(path.join(stage, relative), encryptArchive(archive, o.key), {
      mode: 0o600,
      flag: 'wx',
    });
    const id = await o.cache.saveCache([relative], cacheKey);
    const saved = typeof id === 'number' && id >= 0;
    return { key: cacheKey, saved, available: saved || (await lookup()) === cacheKey };
  });
}
