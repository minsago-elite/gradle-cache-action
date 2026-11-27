// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs/promises';
import path from 'node:path';
import { configureEncryption, restoreConfiguration, saveConfiguration } from './encryption.mjs';
import {
  boolean,
  digest,
  safeHome,
  units,
  populated,
  fingerprint,
  exclusions,
  snapshotPath,
  resetSnapshot,
  snapshot,
  restoreSnapshot,
  withCacheRoot,
  assertSafePath,
  discoverUnits,
  descriptorUnit,
  walk,
} from './engine.mjs';

export function configuration(core, env = process.env) {
  const get = (name) => core.getInput(name),
    event = JSON.parse(env.GITHUB_EVENT_PATH_CONTENT || '{}');
  const pullRequest =
    !!event.pull_request || ['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME);
  const trusted =
    !pullRequest &&
    !!event.repository?.default_branch &&
    env.GITHUB_REF === `refs/heads/${event.repository.default_branch}`;
  const writeOnly = boolean(get('cache-write-only')),
    readOnly = boolean(get('cache-read-only'), !trusted && !writeOnly);
  if (readOnly && writeOnly)
    throw new Error('cache-read-only and cache-write-only cannot both be true');
  const policy = get('cache-cleanup') || 'on-success';
  if (!['always', 'on-success', 'never'].includes(policy))
    throw new Error('cache-cleanup must be always, on-success or never');
  const matrix = JSON.parse(get('matrix') || '{}') ?? {};
  if (!matrix || Array.isArray(matrix) || typeof matrix !== 'object')
    throw new Error('matrix must be a JSON object');
  const canonical = Object.fromEntries(
    Object.entries(matrix).sort(([a], [b]) => a.localeCompare(b)),
  );
  const prefix = get('cache-key-prefix') || 'gradle-cache-v1';
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(prefix))
    throw new Error(
      'cache-key-prefix must contain 1–100 letters, digits, dots, underscores or hyphens',
    );
  const family = get('cache-family');
  if (family && !/^[a-zA-Z0-9_.-]{1,100}$/.test(family))
    throw new Error(
      'cache-family must contain 1–100 letters, digits, dots, underscores or hyphens',
    );
  const workflowScope = digest(JSON.stringify([env.GITHUB_WORKFLOW || '', canonical])).slice(0, 16);
  const scope = digest(
    JSON.stringify([env.GITHUB_WORKFLOW || '', env.GITHUB_JOB || '', canonical]),
  ).slice(0, 16);
  return {
    readOnly,
    writeOnly,
    policy,
    prefix,
    family,
    scope,
    workflowScope,
    overwrite: boolean(get('cache-overwrite-existing')),
    strict: boolean(get('cache-strict-match')),
    excluded: exclusions(get('cache-exclude')),
    inputHome: get('gradle-user-home'),
  };
}
function manifestKeys(config, env) {
  const family = config.family
    ? `${config.prefix}-${process.platform}-${process.arch}-manifest-family-${digest(config.family).slice(0, 16)}-`
    : undefined;
  const wide = family
    ? `${family}${config.workflowScope}-`
    : `${config.prefix}-${process.platform}-${process.arch}-manifest-${config.workflowScope}-`;
  const job = `${wide}${config.scope}-`,
    revision = `${job}${env.GITHUB_SHA || 'local'}-`;
  return {
    key: `${revision}${env.GITHUB_RUN_ID || 'local'}-${env.GITHUB_RUN_ATTEMPT || '1'}`,
    prefixes: [revision, job, ...(config.strict ? [] : [wide, ...(family ? [family] : [])])],
  };
}
async function staging(env) {
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP))
    throw new Error('Absolute RUNNER_TEMP is required for private cache staging');
  await assertSafePath(env.RUNNER_TEMP);
  return fs.mkdtemp(path.join(env.RUNNER_TEMP, 'gradle-cache-'));
}
async function loadManifest(stage, key, cache, core) {
  const hit = await withCacheRoot(stage, () =>
    cache.restoreCache(['manifest.json'], key.key, key.prefixes),
  );
  if (!hit) return undefined;
  await assertSafePath(path.join(stage, 'manifest.json'));
  const stat = await fs.stat(path.join(stage, 'manifest.json'));
  if (stat.size > 1024 * 1024) throw new Error('Cache manifest exceeds size limit');
  const manifest = JSON.parse(await fs.readFile(path.join(stage, 'manifest.json'), 'utf8'));
  if (
    manifest.version !== 1 ||
    !manifest.units ||
    typeof manifest.units !== 'object' ||
    Array.isArray(manifest.units)
  )
    throw new Error('Invalid Gradle cache manifest');
  core.info(`Restored manifest ${hit}`);
  return manifest;
}
export async function runMain(core, cache, env = process.env) {
  core.saveState('post', 'true');
  const encryptionKey = core.getInput('cache-encryption-key');
  configureEncryption(encryptionKey, core);
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  const config = configuration(core, { ...env, GITHUB_EVENT_PATH_CONTENT: JSON.stringify(event) });
  const home = await safeHome(config.inputHome, env);
  core.exportVariable('GRADLE_USER_HOME', home);
  for (const [name, value] of Object.entries({
    'cache-hit': 'false',
    'cache-restored-key': '{}',
    'cache-restored-count': 0,
    'cache-saved-count': 0,
  }))
    core.setOutput(name, value);
  if ((await populated(home)) && !config.overwrite) {
    core.notice(
      'Gradle user home already contains caches; caching is disabled. Set cache-overwrite-existing to opt in.',
    );
    core.saveState('disabled', 'true');
    return;
  }
  await fs.mkdir(home, { recursive: true });
  const stage = await staging(env),
    restored = {},
    baseline = {};
  core.saveState('home', home);
  core.saveState('stage', stage);
  core.saveState('config', JSON.stringify(config));
  const manifest = config.writeOnly
    ? undefined
    : await loadManifest(stage, manifestKeys(config, env), cache, core);
  const restoreScope = manifest?.scope || config.scope;
  if (!/^[a-f0-9]{16}$/.test(restoreScope)) throw new Error('Invalid manifest scope');
  const restoreUnits = units(home, restoreScope, config.prefix);
  if (manifest?.descriptors) {
    if (!Array.isArray(manifest.descriptors) || manifest.descriptors.length > 4096)
      throw new Error('Invalid cache descriptors');
    for (const descriptor of manifest.descriptors)
      restoreUnits.push(descriptorUnit(descriptor, restoreScope, config.prefix));
  }
  if (manifest)
    for (const unit of restoreUnits) {
      const key = manifest.units[unit.name];
      if (
        typeof key !== 'string' ||
        !key.startsWith(unit.prefix) ||
        !/^[a-f0-9]{64}$/.test(key.slice(unit.prefix.length))
      )
        continue;
      await resetSnapshot(unit, stage);
      const hit = await withCacheRoot(stage, () =>
        cache.restoreCache([snapshotPath(unit)], key, []),
      );
      if (hit === key) {
        Object.assign(baseline, await restoreSnapshot(unit, config.excluded, stage, home));
        restored[unit.name] = hit;
      }
      core.info(
        `${unit.name}: ${hit === key ? `restored ${hit}` : 'cache miss (manifest unit unavailable)'}`,
      );
      await fs.rm(path.join(stage, snapshotPath(unit)), { recursive: true, force: true });
    }
  if (manifest?.units.configuration && encryptionKey) {
    const encrypted = await restoreConfiguration({
      ...config,
      home,
      key: encryptionKey,
      restoreKey: manifest.units.configuration,
      scope: restoreScope,
      cache,
      core,
      workspace: env.GITHUB_WORKSPACE,
    });
    if (encrypted?.hit) restored.configuration = encrypted.key;
  }
  await fs.writeFile(path.join(stage, 'restore-state.json'), JSON.stringify(baseline));
  core.saveState('restored', JSON.stringify(restored));
  core.setOutput('cache-hit', Object.keys(restored).length > 0 ? 'true' : 'false');
  core.setOutput('cache-restored-key', JSON.stringify(restored));
  core.setOutput('cache-restored-count', Object.keys(restored).length);
  await core.summary
    .addHeading('Gradle cache restore')
    .addTable([
      [
        { data: 'Unit', header: true },
        { data: 'Restored key', header: true },
      ],
      ...restoreUnits.map((u) => [
        u.label || u.name,
        restored[u.name] || (config.writeOnly ? 'write only' : 'miss'),
      ]),
    ])
    .addRaw(
      `\nRead only: ${config.readOnly}. Configuration cache: ${encryptionKey ? 'authenticated encryption enabled' : 'excluded (no encryption key)'}.\n`,
    )
    .write();
}
function cleanupGroup(relative) {
  const parts = relative.split(path.sep);
  if (parts[0] === 'wrapper') return parts.slice(0, 4).join('/');
  if (parts[1] === 'modules-2' && parts[2] === 'files-2.1') return parts.slice(0, 6).join('/');
  return parts.slice(0, parts[1] === 'modules-2' ? 3 : 2).join('/');
}
async function retention(home, baseline, enabled) {
  if (!enabled) return () => true;
  const groups = new Map();
  let observedAccess = false;
  for (const [relative, before] of Object.entries(baseline)) {
    let stat;
    try {
      stat = await fs.stat(path.join(home, relative));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const accessed = stat.atimeMs > before.atimeMs;
    observedAccess ||= accessed;
    const changed =
      stat.mtimeMs !== before.mtimeMs ||
      stat.ctimeMs !== before.ctimeMs ||
      stat.size !== before.size;
    const group = cleanupGroup(relative);
    groups.set(group, groups.get(group) || false || accessed || changed);
  }
  for (const directory of ['caches', 'wrapper']) {
    await assertSafePath(path.join(home, directory));
    await walk(path.join(home, directory), async (file) => {
      const relative = path.relative(home, file);
      if (!baseline[relative]) groups.set(cleanupGroup(relative), true);
    });
  }
  // Without evidence that the filesystem records reads, retain everything. Whole
  // wrapper installs, dependency versions and generated stores remain atomic.
  if (!observedAccess) return () => true;
  return (file) => {
    const relative = path.relative(home, file);
    return !baseline[relative] || groups.get(cleanupGroup(relative)) !== false;
  };
}
export async function runPost(core, cache, env = process.env) {
  if (core.getState('disabled') === 'true' || !core.getState('home')) return;
  const home = await safeHome(core.getState('home'), env),
    stage = core.getState('stage');
  if (
    !env.RUNNER_TEMP ||
    path.dirname(stage) !== path.resolve(env.RUNNER_TEMP) ||
    !path.basename(stage).startsWith('gradle-cache-')
  )
    throw new Error('Invalid private cache staging path');
  await assertSafePath(stage);
  const config = JSON.parse(core.getState('config'));
  try {
    if (config.readOnly) {
      core.info('Read-only policy: skipping cache save and cleanup.');
      return;
    }
    const baseline = JSON.parse(await fs.readFile(path.join(stage, 'restore-state.json'), 'utf8'));
    const retain = await retention(
      home,
      baseline,
      config.policy === 'always' ||
        (config.policy === 'on-success' && core.getInput('job-status') === 'success'),
    );
    const restored = JSON.parse(core.getState('restored') || '{}'),
      manifest = { version: 1, scope: config.scope, units: {}, descriptors: [] },
      rows = [];
    let saved = 0;
    for (const unit of await discoverUnits(home, config.scope, config.prefix)) {
      const content = await withCacheRoot(home, () => fingerprint(unit, config.excluded, retain));
      if (!content.count) {
        rows.push([unit.name, 'empty']);
        continue;
      }
      if (unit.descriptor) manifest.descriptors.push(unit.descriptor);
      const key = `${unit.prefix}${content.hash}`;
      if (restored[unit.name] === key) {
        manifest.units[unit.name] = key;
        rows.push([unit.name, 'unchanged (deduplicated)']);
        continue;
      }
      await snapshot(unit, content.files, stage, home);
      let id;
      try {
        id = await withCacheRoot(stage, () => cache.saveCache([snapshotPath(unit)], key));
      } finally {
        await fs.rm(path.join(stage, snapshotPath(unit)), { recursive: true, force: true });
      }
      // A -1 can also mean a cache service failure. Verify existence before publishing
      // the reference; missing independent units never poison the completed manifest.
      if (id !== -1) {
        saved++;
        manifest.units[unit.name] = key;
      } else if (
        (await withCacheRoot(stage, () =>
          cache.restoreCache([snapshotPath(unit)], key, [], { lookupOnly: true }),
        )) === key
      )
        manifest.units[unit.name] = key;
      rows.push([unit.name, id === -1 ? 'already cached or unavailable' : key]);
    }
    const encrypted = await saveConfiguration({
      ...config,
      home,
      key: core.getInput('cache-encryption-key'),
      cache,
      core,
      workspace: env.GITHUB_WORKSPACE,
    });
    if (encrypted?.available || encrypted?.saved) {
      if (encrypted.saved) saved++;
      manifest.units.configuration = encrypted.key;
      rows.push(['configuration', encrypted.key]);
    }
    await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
    const manifestId = await withCacheRoot(stage, () =>
      cache.saveCache(['manifest.json'], manifestKeys(config, env).key),
    );
    core.info(
      `Manifest ${manifestId === -1 ? 'not published' : 'published'}; saved ${saved} content units.`,
    );
    core.setOutput('cache-saved-count', saved);
    await core.summary
      .addHeading('Gradle cache save')
      .addTable([
        [
          { data: 'Unit', header: true },
          { data: 'Result', header: true },
        ],
        ...rows,
      ])
      .write();
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
