#!/bin/bash
# Core test runner with PER-FILE mock isolation.
#
# bun's mock.module() is process-wide: when one test file mocks a shared module
# (e.g. @/lib/db/factory, @/lib/oidc, the audit module) the mock leaks into every
# other file that runs in the same bun process. A file that imports the real
# export then sees the partial mock — producing nondeterministic failures such as
# "clearProviderCache is not a function" or "Export named 'removeProvider' not
# found", depending purely on file load order. This passes locally and fails in
# CI (different order).
#
# Running each core test file in its OWN bun process makes cross-file
# contamination structurally impossible. This mirrors tests/run-components.sh,
# which isolates the component tests for the same reason. It is slower than a
# single invocation, but correctness beats speed for the coverage gate.
#
# Usage: bash tests/run-core.sh [extra bun test args]
#   When --coverage-dir=DIR is passed, each file writes to DIR/file-N so the
#   per-file lcov reports can be merged afterwards.

set -uo pipefail

EXTRA_BUN_ARGS=()
COVERAGE_BASE_DIR=""
for arg in "$@"; do
  if [[ "$arg" == --coverage-dir=* ]]; then
    COVERAGE_BASE_DIR="${arg#--coverage-dir=}"
  else
    EXTRA_BUN_ARGS+=("$arg")
  fi
done

# Deterministic, sorted list of every core test file.
mapfile -t FILES < <(find tests/unit tests/api tests/integration tests/hooks \
  -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "run-core.sh: no core test files found" >&2
  exit 1
fi

TOTAL="${#FILES[@]}"
PASS=0
FAIL=0
FAILED_FILES=()
INDEX=0

for file in "${FILES[@]}"; do
  INDEX=$((INDEX + 1))
  RUN_ARGS=("${EXTRA_BUN_ARGS[@]}")
  if [ -n "$COVERAGE_BASE_DIR" ]; then
    RUN_ARGS+=("--coverage-dir=${COVERAGE_BASE_DIR}/file-${INDEX}")
  fi

  echo "=== [${INDEX}/${TOTAL}] ${file} ==="
  if bun test "${RUN_ARGS[@]}" "$file"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED_FILES+=("$file")
  fi
done

echo ""
echo "========================================"
if [ "$FAIL" -eq 0 ]; then
  echo "All ${TOTAL} core test files passed!"
else
  echo "${FAIL}/${TOTAL} core test files FAILED:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
