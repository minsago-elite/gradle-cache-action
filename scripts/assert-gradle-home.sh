#!/usr/bin/env bash
set -euo pipefail

mode="${1:?usage: assert-gradle-home.sh cold|warm}"
gradle_home="${GRADLE_USER_HOME:?GRADLE_USER_HOME must be set}"
wrapper_home="$gradle_home/wrapper/dists/gradle-8.0.2-bin"
generated_jar="$gradle_home/caches/8.0.2/generated-gradle-jars/gradle-api-8.0.2.jar"

wrapper_distribution="$(find "$wrapper_home" -mindepth 1 -maxdepth 1 -type d -name '*' -print -quit 2>/dev/null || true)"
[[ -n "$wrapper_distribution" ]] || { echo "Gradle wrapper distribution missing from $wrapper_home" >&2; exit 1; }
wrapper_marker="$wrapper_distribution/gradle-8.0.2-bin.zip.ok"
wrapper_executable="$wrapper_distribution/gradle-8.0.2/bin/gradle"
wrapper_jar="$wrapper_distribution/gradle-8.0.2/lib/gradle-launcher-8.0.2.jar"
[[ -f "$wrapper_marker" ]] || { echo "Gradle wrapper completion marker missing: $wrapper_marker" >&2; exit 1; }
[[ -x "$wrapper_executable" ]] || { echo "Restored Gradle executable missing or not executable: $wrapper_executable" >&2; exit 1; }
[[ -s "$wrapper_jar" ]] || { echo "Gradle launcher JAR missing: $wrapper_jar" >&2; exit 1; }
[[ -s "$generated_jar" ]] || { echo "Gradle generated API JAR missing: $generated_jar" >&2; exit 1; }

wrapper_digest="$(
  cd "$wrapper_distribution"
  sha256sum gradle-8.0.2-bin.zip.ok gradle-8.0.2/bin/gradle gradle-8.0.2/lib/gradle-launcher-8.0.2.jar | sha256sum | cut -d ' ' -f 1
)"
generated_jar_digest="$(sha256sum "$generated_jar" | cut -d ' ' -f 1)"
generated_jar_bytes="$(stat -c '%s' "$generated_jar")"

echo "Gradle distribution: $(basename "$(dirname "$(dirname "$wrapper_executable")")") at $wrapper_distribution"
echo "Generated cache: $(basename "$generated_jar") ($generated_jar_bytes bytes, sha256 $generated_jar_digest)"
echo "Wrapper state digest: $wrapper_digest"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "wrapper-digest=$wrapper_digest"
    echo "generated-jar-digest=$generated_jar_digest"
    echo "generated-jar-bytes=$generated_jar_bytes"
  } >> "$GITHUB_OUTPUT"
fi

if [[ "$mode" == "cold" ]]; then
  :
elif [[ "$mode" == "warm" ]]; then
  :
else
  echo "unknown mode: $mode" >&2
  exit 2
fi

echo "Verified $mode Gradle wrapper and generated cache content under $gradle_home"
