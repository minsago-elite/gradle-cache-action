// SPDX-License-Identifier: AGPL-3.0-or-later
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
await build({
  entryPoints: ['src/index.mjs'],
  outfile: 'dist/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  legalComments: 'eof',
  sourcemap: false,
  banner: {
    js: '/*! SPDX-License-Identifier: AGPL-3.0-or-later; corresponding source is distributed in src/ and tooling/. See LICENSE and THIRD_PARTY_NOTICES.txt. */',
  },
});
// Include full package notices, including transitive runtime dependencies. The lockfile
// supplies the exact package/version inventory; build-only dependencies are omitted.
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const notices = [
  'Third-party notices for bundled gradle-cache-action\nGenerated from package-lock.json; original license texts follow.\n',
];
for (const [directory, metadata] of Object.entries(lock.packages).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  if (!directory || metadata.dev) continue;
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && metadata.optional) continue;
    throw error;
  }
  notices.push(
    `\n${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nLicense: ${pkg.license || metadata.license || 'See original notices'}\n`,
  );
  let found = false;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!/^(licen[cs]e|notice|copying)([._-]|$)/i.test(entry.name)) continue;
    async function append(file) {
      const stat = await fs.stat(file);
      if (stat.isDirectory()) {
        for (const name of await fs.readdir(file)) await append(path.join(file, name));
      } else {
        notices.push(
          `\n--- ${path.relative(directory, file)} ---\n${await fs.readFile(file, 'utf8')}\n`,
        );
        found = true;
      }
    }
    await append(path.join(directory, entry.name));
  }
  if (!found && pkg.name === '@nodable/entities') {
    notices.push(
      'Original source: https://github.com/nodable/val-parsers/blob/b89ecb0d419969e2989b74c5304bc9b66931727e/LICENSE\n' +
        (await fs.readFile('tooling/licenses/nodable-entities-LICENSE', 'utf8')),
    );
    found = true;
  }
  if (!found) throw new Error(`Missing distribution license file for ${pkg.name}`);
}
await fs.writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join(''));
