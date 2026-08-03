#!/usr/bin/env bash
#
# Standalone SDK compatibility smoke for ONE bundled plugin (issue #507, AP-NFR-004).
#
# Usage: scripts/sdk-smoke.sh <plugin> <version>
#
# Assembles the named plugin's build inputs in a workdir OUTSIDE the monorepo
# checkout, so nothing can resolve through the workspace symlinks and only the
# live npm registry can satisfy the @roubo/* dependencies at <version>. Then:
#
#   1. installs (with retries, since registry propagation lags a publish),
#   2. asserts every @roubo/* dep came from the registry at the expected version
#      with no surviving file:/workspace link,
#   3. typechecks and builds the plugin unchanged,
#   4. runs the plugin's own test suite unchanged.
#
# Step 3 is what catches a breaking SDK type change (AP-TC-124): a plugin whose
# source no longer compiles against the published types fails here, and because
# the caller runs one matrix leg per plugin, the failing leg names the plugin.
#
# Not every test file in a plugin's src/ is standalone-runnable: the component
# plugins' `parity.test.ts` imports the host's own lifecycle-engine through a
# monorepo-relative path, which is deliberately NOT part of the published SDK
# surface. Those files stay in the monorepo test run (pr-check `npm run
# coverage`) and are excluded here via SMOKE_TEST_FILTER, which is scoped to the
# tests that actually exercise the published surface. The filter is a vitest
# positional path filter (a substring match), not a shell glob; vitest exits
# non-zero when it matches no files, so a mis-scoped filter fails loudly.

set -euo pipefail

PLUGIN="${1:?usage: sdk-smoke.sh <plugin> <version>}"
VERSION="${2:?usage: sdk-smoke.sh <plugin> <version>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${REPO_ROOT}/plugins/${PLUGIN}"

if [[ ! -d "${PLUGIN_DIR}" ]]; then
  echo "::error::Unknown plugin '${PLUGIN}' (no ${PLUGIN_DIR})"
  exit 1
fi

# Tooling versions mirror the monorepo root and the plugin workspaces.
TSUP_VERSION="8.5.1"
TYPESCRIPT_VERSION="6.0.3"
TYPES_NODE_VERSION="26.0.1"
VITEST_VERSION="4.1.9"

case "${PLUGIN}" in
  github-com)
    EXTRA_DEPS='"octokit": "5.0.5",'
    # Matches both src/__tests__/ and the absorbed helpers' src/shared/__tests__/.
    SMOKE_TEST_FILTER="__tests__/"
    ;;
  *)
    EXTRA_DEPS=''
    SMOKE_TEST_FILTER="src/translate.test.ts"
    ;;
esac

SMOKE_DIR="$(mktemp -d)"
echo "Smoke-testing plugins/${PLUGIN} against published @roubo/* ${VERSION} in ${SMOKE_DIR}"

cp -R "${PLUGIN_DIR}/src" "${SMOKE_DIR}/src"
cp "${PLUGIN_DIR}/tsup.config.ts" "${SMOKE_DIR}/tsup.config.ts"
if [[ -f "${PLUGIN_DIR}/roubo-plugin.yaml" ]]; then
  cp "${PLUGIN_DIR}/roubo-plugin.yaml" "${SMOKE_DIR}/roubo-plugin.yaml"
fi

# Self-contained tsconfig: the in-repo plugin tsconfigs extend
# ../../tsconfig.json, which does not exist standalone, so inline the merged
# compiler options here (root + plugin, plugin wins on conflict). Project
# references are dropped: every helper the plugin needs now lives under its own
# src/, so there is nothing left to reference.
write_tsconfig() {
  cat > "$1/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "ignoreDeprecations": "6.0",
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["./src/**/*.ts"],
  "exclude": ["dist", "./src/**/*.test.ts", "./src/**/__tests__/**"]
}
JSON
}

write_tsconfig "${SMOKE_DIR}"

# Standalone package.json: pin both published packages at the release version so
# install can only succeed from the live registry.
cat > "${SMOKE_DIR}/package.json" <<JSON
{
  "name": "roubo-sdk-smoke-${PLUGIN}",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit && tsup"
  },
  "dependencies": {
    ${EXTRA_DEPS}
    "@roubo/plugin-sdk": "${VERSION}",
    "@roubo/shared": "${VERSION}"
  },
  "devDependencies": {
    "@types/node": "${TYPES_NODE_VERSION}",
    "tsup": "${TSUP_VERSION}",
    "typescript": "${TYPESCRIPT_VERSION}",
    "vitest": "${VITEST_VERSION}"
  }
}
JSON

install_with_retry() {
  local attempt=1
  local max_attempts=5
  until npm install --no-audit --no-fund; do
    if (( attempt >= max_attempts )); then
      echo "::error::npm install failed after ${max_attempts} attempts in $(pwd); the published ${VERSION} packages did not resolve from the registry"
      exit 1
    fi
    echo "npm install attempt ${attempt} failed (registry propagation lag?); retrying in 15s"
    attempt=$(( attempt + 1 ))
    sleep 15
  done
}

cd "${SMOKE_DIR}"
install_with_retry

# Assert every published @roubo/* dep resolved to a real registry tarball at the
# expected version, with no surviving file:/workspace link.
export VERSION_EXPECTED="${VERSION}"
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const expected = process.env.VERSION_EXPECTED;
const pkgs = ['@roubo/plugin-sdk', '@roubo/shared'];
let failed = false;
for (const name of pkgs) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry) {
    console.error(`::error::${name} is missing from the lockfile`);
    failed = true;
    continue;
  }
  if (entry.link) {
    console.error(`::error::${name} resolved to a workspace/file link, not the registry`);
    failed = true;
  }
  if (!entry.resolved || !entry.resolved.startsWith('https://registry.npmjs.org/')) {
    console.error(`::error::${name} did not resolve from the live registry (resolved='${entry.resolved ?? ''}')`);
    failed = true;
  }
  if (entry.version !== expected) {
    console.error(`::error::${name} resolved to version '${entry.version}', expected '${expected}'`);
    failed = true;
  }
  if (entry.resolved && entry.version === expected && !entry.link) {
    console.log(`${name}@${entry.version} resolved from ${entry.resolved}`);
  }
}
if (failed) process.exit(1);
NODE

# Build the real plugin against the published packages; any non-zero exit fails
# the workflow loudly and names this matrix leg's plugin.
if ! npm run build; then
  echo "::error::plugin '${PLUGIN}' failed to build against @roubo/* ${VERSION}"
  exit 1
fi

# Run the plugin's own suite unchanged against the published packages. vitest
# fails the run when the filter matches no files, so an empty match is an error
# rather than a silent pass.
if ! npx vitest run "${SMOKE_TEST_FILTER}"; then
  echo "::error::plugin '${PLUGIN}' test suite failed against @roubo/* ${VERSION}"
  exit 1
fi

echo "plugin '${PLUGIN}' built and tested against @roubo/* ${VERSION} from the live registry"
