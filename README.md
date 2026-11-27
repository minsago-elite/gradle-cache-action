# Gradle Cache Action

Restore reusable Gradle state on a fresh GitHub Actions runner and save changes when the job finishes. Each saved manifest references immutable cache entries. Jobs can share a wrapper distribution or a generated Gradle API JAR even when their dependency sets differ.

The cache engine is an independent implementation using the open-source GitHub Actions toolkit. It uses GitHub's hosted Actions cache service. The action's source, runnable JavaScript bundle, dependency lockfile and third-party notices are in this repository.

## Use with the Gradle wrapper

Check out your project, set up Java, then run the cache action before invoking the wrapper. Pin the cache action to a reviewed full commit SHA in production. The action supports the Node 24 GitHub Actions runtime.

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: actions/setup-java@v5
    with:
      distribution: temurin
      java-version: '21'
  - uses: minsago-elite/gradle-cache-action@main
    with:
      cache-cleanup: on-success
  - run: ./gradlew build
```

Configure one cache owner per Gradle user home. If you use this action, leave the Gradle cache option off in setup-java. Use your existing Gradle wrapper validation step when migrating from setup-gradle. Java installation, wrapper validation and project-specific output caches have separate owners.

## What gets cached

Wrapper distributions and generated Gradle API JARs have independent content keys. Downloaded dependency artifacts, module metadata, compiled build scripts, transforms and the Gradle local build cache are grouped by category. Changing the dependency set can therefore require a new dependency archive. Publishing the manifest after its content entries allows future jobs to request the exact entries it names. GitHub controls branch visibility, quota and eviction.

The action selects specific Gradle user-home directories. Keep private repository credentials in secrets or Gradle properties. Anyone with cache read access can inspect the dependency or build-output files you choose to cache. Downloaded JDKs and arbitrary additional directories are outside the current selection.

| Input | Purpose |
| --- | --- |
| `gradle-user-home` | Absolute Gradle home. Defaults to `GRADLE_USER_HOME`, then the user's `.gradle` directory. |
| `cache-read-only` | Restore entries and skip publication. The default permits writes on the default branch. |
| `cache-write-only` | Populate the cache from a fresh build without restoring a manifest. |
| `cache-key-prefix` | Select a cache namespace. Use distinct prefixes for incompatible workloads. |
| `cache-family` | Opt into a shared fallback manifest across workflows using the same cache key prefix, platform and architecture. Strict matching disables this fallback. |
| `matrix` | JSON object identifying the matrix variant. Pass `${{ toJSON(matrix) }}` in matrix jobs. Omit this input for single jobs. |
| `cache-strict-match` | Limit fallback to manifests from the same workflow, job and matrix. |
| `cache-overwrite-existing` | Permit a restore into a populated home. The default skips caching when the home already contains cache state. |
| `cache-cleanup` | Select `on-success` (default), `always`, or `never`. Cleanup affects the snapshot published to the service. When filesystem access times provide evidence of use, the action can omit unused restored groups. |
| `cache-exclude` | Newline-separated path patterns relative to the Gradle home. |
| `cache-encryption-key` | Opt into authenticated encryption for the project configuration cache. Pass a Base64 AES key from an Actions secret. |

For the configuration cache, the action exports the key as `GRADLE_ENCRYPTION_KEY` and archives the workspace root's `.gradle/configuration-cache`. The encrypted archive has limits of 4,096 files and 16 MiB of plaintext file data. Supply the same key on jobs that should share this state. Treat key rotation as a cold start.

The setup step exposes `cache-hit`, `cache-restored-count` and `cache-restored-key`. The post step reports saved entries in the job summary. Cache misses and service eviction can require an online build to repopulate state.

## Develop

With Node 24, run `npm ci --ignore-scripts`, `npm test` and `npm run build`. Commit the generated `dist/index.cjs` and `dist/THIRD_PARTY_NOTICES.txt` alongside source changes. Hosted qualification uses separate runners and Gradle homes to verify a cold build and a read-only offline build.

## License

This project is free software. You may redistribute it and modify it under the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License or, at your option, any later version. See [LICENSE](LICENSE). Dependencies retain the licenses in [third-party notices](dist/THIRD_PARTY_NOTICES.txt). The Gradle wrapper in the test fixture carries its [Apache license and attribution](fixture/gradle/wrapper/LICENSE).
