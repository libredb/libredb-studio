#!/usr/bin/env bash
# ==============================================================================
# Functional smoke - the maintainer loop's LAST gate before a milestone may
# complete: boot the real app, create a PostgreSQL connection through the real
# UI, run a SQL query, assert the rows render (e2e/functional-smoke.spec.ts).
#
# The mechanical gate (gate.sh) proves the pieces work; this proves the
# PRODUCT still works: no milestone's combined changes may break
# login -> connect -> query -> results.
#
# Runs the spec via playwright.smoke.config.ts (port 3105, never reuses an
# existing server - a locally installed Snap daemon shadows port 3000).
# Unlike the spec's own CI behavior (skip without Docker), this wrapper
# HARD-FAILS when Docker is unavailable: the loop must never pass this gate
# vacuously.
#
# Usage: loop/scripts/functional-smoke.sh
# ==============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "=== functional smoke: preflight ==="
if ! docker info > /dev/null 2>&1; then
  echo "Docker daemon is not available - the functional smoke cannot run." >&2
  echo "The loop must not complete a milestone without this gate; fix Docker first." >&2
  exit 1
fi

# The smoke config boots `bun start` without building (the gate has usually
# just built); make sure a build exists for direct/manual invocations.
if [ ! -f .next/BUILD_ID ]; then
  echo "=== functional smoke: no build found, building ==="
  bun run build
fi

# No-op when the browser is already cached.
bunx playwright install chromium

echo "=== functional smoke: run ==="
bunx playwright test --config=playwright.smoke.config.ts

echo "=== functional smoke: GREEN ==="
