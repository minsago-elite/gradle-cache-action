// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as glob from '@actions/glob';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function boolean(value, fallback = false) {
  if (!value) return fallback;
  if (!['true', 'false'].includes(value))
    throw new Error(`Expected true or false, received ${value}`);
  return value === 'true';
}
export async function safeHome(input, env = process.env) {
  const home = path.resolve(input || env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'));
  if (!path.isAbsolute(input || env.GRADLE_USER_HOME || home))
    throw new Error('Gradle user home must be absolute');
  const forbidden = [path.parse(home).root, os.homedir(), env.GITHUB_WORKSPACE, env.RUNNER_TEMP]
    .filter(Boolean)
    .map((p) => path.resolve(p));
  if (forbidden.includes(home))
    throw new Error('Refusing to cache a filesystem, workspace, temporary, or user root');
  // Reject symlink traversal, including symlinked ancestors, before any restore or deletion.
  let cursor = home;
  while (cursor !== path.dirname(cursor)) {
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink())
        throw new Error(`Symlink in Gradle home path: ${cursor}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    cursor = path.dirname(cursor);
  }
  return home;
}
export function units(home, scope, prefix) {
  const base = `${prefix}-${process.platform}-${process.arch}-`;
  return [
    { name: 'dependencies', paths: ['caches/modules-2/files-2.1'], prefix: `${base}dependencies-` },
    {
      name: 'local-build',
      paths: ['caches/build-cache-*'],
      prefix: `${base}${scope}-local-build-`,
    },
    {
      name: 'metadata',
      paths: ['caches/modules-2/metadata-*'],
      prefix: `${base}${scope}-metadata-`,
    },
    // Only explicit generated-cache directories are included. Project configuration caches,
    // credentials, init scripts and daemon state are never archived.
    {
      name: 'generated',
      paths: [
        'jars-*',
        'transforms-*',
        '*/kotlin-dsl',
        '*/groovy-dsl',
        '*/transforms',
        '*/scripts*',
      ].map((p) => path.posix.join('caches', p)),
      prefix: `${base}${scope}-generated-`,
    },
  ];
}
export async function walk(root, callback) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(file, callback);
    else if (entry.isFile()) await callback(file);
  }
}
export async function populated(home) {
  for (const child of ['caches', 'wrapper']) {
    try {
      if ((await fs.readdir(path.join(home, child))).length) return true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return false;
}

export function exclusions(value) {
  return value
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..') || p.startsWith('!'))
        throw new Error('Cache exclusions must be relative patterns within Gradle home');
      return `!${p}`;
    });
}
export function patterns(unit, excluded = []) {
  return [...unit.paths, '!**/*.lock', '!**/*.lck', '!**/*.tmp', '!**/*.part', ...excluded];
}
export async function fingerprint(unit, excluded = [], retain = () => true) {
  const files = await (
    await glob.create(patterns(unit, excluded).join('\n'), {
      followSymbolicLinks: false,
      matchDirectories: false,
      implicitDescendants: true,
    })
  ).glob();
  const hash = createHash('sha256');
  let count = 0;
  const retained = new Set();
  for (const file of files.sort()) {
    // Refuse symlinked ancestors even where the glob implementation returns their children.
    let cursor = file;
    while (cursor !== process.cwd() && cursor !== path.dirname(cursor)) {
      if ((await fs.lstat(cursor)).isSymbolicLink())
        throw new Error(`Symlink cannot be cached: ${cursor}`);
      cursor = path.dirname(cursor);
    }
    if (!(await fs.lstat(file)).isFile() || !retain(file, await fs.stat(file))) continue;
    retained.add(file);
    hash.update(path.relative(process.cwd(), file));
    hash.update('\0');
    hash.update(String((await fs.stat(file)).mode & 0o777));
    hash.update('\0');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    hash.update('\0');
    count++;
  }
  return { hash: hash.digest('hex'), count, files: files.filter((file) => retained.has(file)) };
}

export async function assertSafePath(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error(`Symlink in cache path: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
}
export const snapshotPath = (unit) => `payload/${unit.name}`;
export async function resetSnapshot(unit, stage = process.cwd()) {
  const root = path.join(stage, snapshotPath(unit));
  await assertSafePath(root);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  return root;
}
export async function snapshot(unit, files, stage = process.cwd(), home = process.cwd()) {
  const root = await resetSnapshot(unit, stage);
  for (const source of files) {
    if (!(await fs.lstat(source)).isFile()) continue;
    await assertSafePath(source);
    const target = path.join(root, path.relative(home, source));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    await fs.chmod(target, (await fs.stat(source)).mode);
  }
  return root;
}
export async function restoreSnapshot(
  unit,
  excluded = [],
  stage = process.cwd(),
  home = process.cwd(),
) {
  const root = path.join(stage, snapshotPath(unit));
  const members = [];
  async function visit(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('Symlink in restored cache snapshot');
      if (item.isDirectory()) await visit(source);
      else if (item.isFile()) members.push(source);
    }
  }
  await assertSafePath(root);
  await visit(root);
  for (const source of members) {
    const relative = path.relative(root, source);
    if (!['wrapper', 'caches'].includes(relative.split(path.sep)[0]))
      throw new Error('Unexpected snapshot member');
    await assertSafePath(path.join(home, relative));
  }
  const scoped = { ...unit, paths: unit.paths.map((p) => path.join(root, p)) };
  const allowed = new Set(
    await (
      await glob.create(
        patterns(
          scoped,
          excluded.map((p) => '!' + path.join(root, p.slice(1))),
        ).join('\n'),
        { followSymbolicLinks: false, matchDirectories: false },
      )
    ).glob(),
  );
  const baseline = {};
  for (const source of members) {
    if (!allowed.has(source)) continue;
    const relative = path.relative(root, source),
      target = path.join(home, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    await fs.chmod(target, (await fs.stat(source)).mode);
    const stat = await fs.stat(target);
    baseline[relative] = {
      atimeMs: stat.atimeMs,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
    };
  }
  return baseline;
}
export async function withCacheRoot(root, operation) {
  const previous = process.env.GITHUB_WORKSPACE,
    directory = process.cwd();
  process.env.GITHUB_WORKSPACE = root;
  process.chdir(root);
  try {
    return await operation();
  } finally {
    process.chdir(directory);
    if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previous;
  }
}

export function descriptorUnit(descriptor, scope, prefix) {
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.path !== 'string')
    throw new Error('Invalid cache unit descriptor');
  const relative = descriptor.path;
  if (
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative
      .split('/')
      .some(
        (part) =>
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error('Unsafe cache unit descriptor');
  if (
    descriptor.kind === 'wrapper'
      ? !/^wrapper\/dists\/[A-Za-z0-9_.-]+$/.test(relative)
      : descriptor.kind === 'gradle-api'
        ? !/^caches\/[0-9][A-Za-z0-9_.+-]*\/generated-gradle-jars\/[A-Za-z0-9_.+-]+\.jar$/.test(
            relative,
          )
        : true
  )
    throw new Error('Unsafe cache unit descriptor');
  const id = digest(relative).slice(0, 24),
    name = `${descriptor.kind}-${id}`;
  return {
    name,
    label: relative,
    paths: [relative],
    prefix: `${prefix}-${process.platform}-${process.arch}-${name}-`,
    descriptor,
  };
}
export async function discoverUnits(home, scope, prefix) {
  const result = units(home, scope, prefix);
  async function entries(relative) {
    const directory = path.join(home, relative);
    await assertSafePath(directory);
    try {
      return await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  for (const item of await entries('wrapper/dists')) {
    if (item.isSymbolicLink()) throw new Error('Symlink in wrapper distributions');
    if (item.isDirectory())
      result.push(
        descriptorUnit({ kind: 'wrapper', path: `wrapper/dists/${item.name}` }, scope, prefix),
      );
  }
  for (const version of await entries('caches')) {
    if (!version.isDirectory() || !/^[0-9][A-Za-z0-9_.+-]*$/.test(version.name)) continue;
    for (const item of await entries(`caches/${version.name}/generated-gradle-jars`)) {
      if (item.isSymbolicLink()) throw new Error('Symlink in generated Gradle API jars');
      if (item.isFile() && item.name.endsWith('.jar'))
        result.push(
          descriptorUnit(
            {
              kind: 'gradle-api',
              path: `caches/${version.name}/generated-gradle-jars/${item.name}`,
            },
            scope,
            prefix,
          ),
        );
    }
  }
  return result;
}
