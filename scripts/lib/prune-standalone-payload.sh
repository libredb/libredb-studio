#!/usr/bin/env bash
# ==============================================================================
# Prune non-runtime repo-root extras from an assembled standalone payload
# (issue #124): Next.js output file tracing sweeps the repo root, dragging
# docs, source, tooling configs, the lockfile and deploy manifests into
# .next/standalone - and from there into every payload-derived artifact
# (release tarballs, .deb/.rpm, snap, npx cache). On a local (non-CI)
# checkout the sweep also picks up gitignored build leftovers (dist/,
# coverage/, *.snap); the deny-list covers the project-conventional ones,
# but arbitrary personal files at the repo root can still leak into LOCAL
# builds - CI release checkouts are clean, so releases are unaffected.
#
# Deny-list semantics, payload-ROOT entries only: nothing nested inside a
# kept directory (node_modules/, .next/, public/, ...) is touched, and no
# dot-directory is on the list - the runtime needs the hidden .next dir
# (see the snap 0.9.52 fileset incident for how easily it gets dropped).
# The runtime keep-list documented in scripts/build-standalone-payload.sh
# (server.js, package.json, .next, node_modules, public, data) must always
# survive this step; LICENSE and README.md are deliberately kept too
# (release-artifact convention; the MIT notice travels with the payload).
#
# Usage: prune-standalone-payload.sh <payload-dir>
# ==============================================================================

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <payload-dir>" >&2
  exit 1
fi

PAYLOAD_DIR=$1

if [ ! -d "$PAYLOAD_DIR" ]; then
  echo "Payload dir not found: $PAYLOAD_DIR" >&2
  exit 1
fi

# Refuse to prune anything that does not look like an assembled standalone
# payload - the deny-list below is applied with rm -rf, so a mistaken
# invocation (a repo checkout, or / itself) must fail BEFORE any removal.
# The markers are the runtime keep-list's anchors; all must pre-exist.
for marker in server.js package.json .next; do
  if [ ! -e "$PAYLOAD_DIR/$marker" ]; then
    echo "Refusing to prune: '$PAYLOAD_DIR' does not look like a standalone payload (missing $marker)" >&2
    exit 1
  fi
done

# Repo-root extras that output file tracing pulls into the standalone
# output. Directories and files alike; missing entries are a no-op.
PRUNE_LIST=(
  # Tracked repo content - non-runtime; ships even in clean CI builds.
  bin
  charts
  conductor
  deploy
  docker
  docs
  e2e
  loop
  packaging
  scripts
  snap
  src
  tests
  artifacthub-repo.yml
  biome.json
  bun.lock
  bunfig.toml
  CLAUDE.md
  CODE_OF_CONDUCT.md
  components.json
  CONTRIBUTING.md
  database-compose.yml
  Dockerfile
  docker-entrypoint.sh
  DOCKERHUB.md
  eslint.config.mjs
  fly.toml
  knip.json
  next.config.ts
  playwright.config.ts
  postcss.config.mjs
  render.yaml
  SECURITY.md
  sonar-project.properties
  tsconfig.json
  tsconfig.lib.json
  tsup.config.ts
  # Local build/test leftovers - local builds only (CI is clean). All
  # project-conventional: named in .gitignore, except logs/ (an untracked
  # local server-log dir).
  coverage
  dist
  logs
  npmjs-token
  snap-payload
  testdb
  testdb-shm
  testdb-wal
  seed-connections.yaml
  tsconfig.tsbuildinfo
)

for entry in "${PRUNE_LIST[@]}"; do
  rm -rf "${PAYLOAD_DIR:?}/${entry:?}"
done

# Pattern entries: deploy manifests (docker-compose.yml,
# docker-compose.example.yml, ...), locally built snap binaries
# (libredb-studio_<version>_<arch>.snap), packed tarballs, logs, and
# key/cert files. An unmatched glob stays literal and rm -f ignores it.
# Leading-dot entries (.gitignore, .github, .npmrc, ...) never get traced
# into the standalone output in the first place - only non-dot repo-root
# files need pruning.
rm -f "$PAYLOAD_DIR"/docker-compose*.yml "$PAYLOAD_DIR"/docker-compose*.yaml \
  "$PAYLOAD_DIR"/*.snap "$PAYLOAD_DIR"/*.tgz "$PAYLOAD_DIR"/*.log "$PAYLOAD_DIR"/*.pem
