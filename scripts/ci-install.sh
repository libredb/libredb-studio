#!/usr/bin/env bash
#
# `bun install --frozen-lockfile` with a retry, for every CI job.
#
# bun has no retry of its own, so a single failed package download fails the
# whole step: "error: Fail extracting tarball for <package>". On 2026-07-29 that
# took out three runs in one day - two CI runs and, worse, the npm publish of
# release 0.9.61, which left the release published while npm sat on the previous
# version. Nothing about it was reproducible or code-related; the same commit
# passed on a re-run.
#
# Every attempt is logged, so a registry that is degrading rather than broken
# shows up as warnings instead of hiding behind a green step. Tuning knobs exist
# for the unit tests (tests/unit/ci-install.test.ts), not for callers.
set -uo pipefail

attempts=${CI_INSTALL_ATTEMPTS:-3}
backoff=${CI_INSTALL_BACKOFF_SECONDS:-10}

attempt=1
while [ "$attempt" -le "$attempts" ]; do
  if bun install --frozen-lockfile; then
    exit 0
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    delay=$((backoff * attempt))
    echo "::warning::bun install failed (attempt ${attempt}/${attempts}); retrying in ${delay}s"
    sleep "$delay"
  fi
  attempt=$((attempt + 1))
done

echo "::error::bun install failed after ${attempts} attempts - see the attempt logs above"
exit 1
