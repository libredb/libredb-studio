#!/usr/bin/env bash
#
# Gate script — mechanical definition of "done" for one maintainer-loop iteration.
# Mirrors CLAUDE.md's Pre-Commit Verification and the required CI checks
# (.github/workflows/ci.yml: "Lint, Typecheck and Build" + "Unit & Integration Tests");
# do not reorder or drop a step.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "=== gate: format ==="
bun run format

echo "=== gate: lint ==="
bun run lint

echo "=== gate: typecheck ==="
bun run typecheck

echo "=== gate: knip ==="
bun run knip

# One run of the suite, not two. `bun run test:coverage` is `bun run test` with
# --coverage: the same runner over the same files, so a separate `bun run test` step
# would run all of them twice and catch nothing the coverage run does not. It used to
# be a different command, which is why both steps existed. The required "Unit &
# Integration Tests" job runs exactly these two; scripts/check-coverage.mjs enforces
# 100% of lines on the merged lcov.
echo "=== gate: test (with coverage) ==="
bun run test:coverage
bun run coverage:check

echo "=== gate: build ==="
bun run build

echo "=== gate: ALL GREEN ==="
