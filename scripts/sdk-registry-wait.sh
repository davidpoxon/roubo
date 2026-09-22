#!/usr/bin/env bash
#
# Wait until every named package resolves from the npm registry at <version>
# (issue #1346).
#
# Usage: scripts/sdk-registry-wait.sh <version> <pkg>...
#
# A just-published version can take minutes to show up on the registry. An
# install that runs before then fails with ETARGET, which looks the same as a
# broken release. So scripts/sdk-smoke.sh calls this first: it polls
# `npm view <pkg>@<version> version` with a backoff until each package answers
# with exactly <version>. The exit code alone is not trusted, because older npm
# releases exit 0 with empty output for an unknown version.
#
# All packages share one deadline, so a publish that never landed fails the job
# within a bounded time, not at the job timeout. Every log line gives the
# elapsed wait, so the log alone shows how long propagation took.
#
# Tunables (seconds, integers):
#   SDK_SMOKE_REGISTRY_TIMEOUT_S  total wait ceiling           (default 600)
#   SDK_SMOKE_REGISTRY_POLL_S     first poll interval, doubles (default 10)
#   SDK_SMOKE_REGISTRY_POLL_MAX_S poll interval cap            (default 60)

set -euo pipefail

VERSION="${1:?usage: sdk-registry-wait.sh <version> <pkg>...}"
shift
if (( $# == 0 )); then
  echo "usage: sdk-registry-wait.sh <version> <pkg>..." >&2
  exit 1
fi

TIMEOUT_S="${SDK_SMOKE_REGISTRY_TIMEOUT_S:-600}"
POLL_S="${SDK_SMOKE_REGISTRY_POLL_S:-10}"
POLL_MAX_S="${SDK_SMOKE_REGISTRY_POLL_MAX_S:-60}"

SECONDS=0
ERR_FILE="$(mktemp)"
trap 'rm -f "${ERR_FILE}"' EXIT

for pkg in "$@"; do
  spec="${pkg}@${VERSION}"
  interval="${POLL_S}"
  while true; do
    # Only stdout is compared: npm can print warnings on stderr (for example
    # about the runner's .npmrc) even when the lookup succeeds.
    answer=""
    if answer="$(npm view "${spec}" version --prefer-online 2>"${ERR_FILE}")" && [[ "${answer}" == "${VERSION}" ]]; then
      echo "${spec} resolvable after ${SECONDS}s"
      break
    fi

    remaining=$(( TIMEOUT_S - SECONDS ))
    if (( remaining <= 0 )); then
      if [[ -n "${answer}" || -s "${ERR_FILE}" ]]; then
        echo "Last npm view answer for ${spec}:"
        [[ -z "${answer}" ]] || echo "${answer}"
        cat "${ERR_FILE}"
      fi
      echo "::error::${spec} did not become resolvable from the registry after waiting ${SECONDS}s (limit ${TIMEOUT_S}s); registry propagation lag or a publish that never landed"
      exit 1
    fi

    sleep_s=$(( interval < remaining ? interval : remaining ))
    echo "${spec} not yet on the registry (propagation lag); waited ${SECONDS}s, next check in ${sleep_s}s"
    sleep "${sleep_s}"
    interval=$(( interval * 2 > POLL_MAX_S ? POLL_MAX_S : interval * 2 ))
  done
done
