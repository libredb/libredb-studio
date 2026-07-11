#!/usr/bin/env bash
#
# Gate script — mechanical definition of "done" for one maintainer-loop iteration.
# Mirrors CLAUDE.md's Pre-Commit Verification exactly; do not reorder or drop a step.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "=== gate: format ==="
bun run format

echo "=== gate: lint ==="
bun run lint

echo "=== gate: typecheck ==="
bun run typecheck

echo "=== gate: test ==="
bun run test

echo "=== gate: build ==="
bun run build

echo "=== gate: ALL GREEN ==="
