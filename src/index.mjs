// SPDX-License-Identifier: AGPL-3.0-or-later
import * as core from '@actions/core';
import * as cache from '@actions/cache';
import { runMain, runPost } from './action.mjs';
async function main() {
  if (!cache.isFeatureAvailable())
    core.warning('GitHub Actions cache service is unavailable; caching is skipped.');
  else if (core.getState('post') === 'true') await runPost(core, cache);
  else await runMain(core, cache);
}
main().catch((error) => core.setFailed(`Gradle cache: ${error.message}`));
