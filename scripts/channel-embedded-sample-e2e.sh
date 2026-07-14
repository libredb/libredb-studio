#!/usr/bin/env bash
# ==============================================================================
# Per-channel browser E2E for the embedded samples (e2e/embedded-samples.spec.ts).
#
# Every distribution channel boots the same standalone payload through a
# different launcher, cwd and STORAGE_SQLITE_PATH — a packaging bug (payload
# missing seed-assets/, wrong data dir, dropped fileset entry) surfaces only
# in the affected channel. This script boots the packaged artifact for one
# channel, waits for health, then runs the shared Playwright spec against it
# via playwright.channel.config.ts (no webServer; CHANNEL_E2E_BASE_URL points
# at the booted server).
#
# Usage:
#   scripts/channel-embedded-sample-e2e.sh <channel> [artifact]
#   scripts/channel-embedded-sample-e2e.sh all [tarball]
#
#   channel   tarball | npx | docker | deb | rpm | snap | homebrew | all
#   artifact  channel-specific:
#     tarball   path to libredb-studio-standalone-*.tar.gz
#               (default: newest dist/libredb-studio-standalone-*.tar.gz)
#     npx       same tarball (booted through bin/studio.js --archive)
#     docker    image reference (default: build a local image tagged
#               libredb-studio:channel-e2e)
#     deb/rpm   path to the .deb/.rpm package (no default; SKIP when absent)
#     snap      path to the .snap file (no default; SKIP when absent)
#     homebrew  path to a rendered formula .rb (darwin only; SKIP otherwise)
#
# 'all' runs every channel feasible on this machine and reports a summary;
# infeasible channels SKIP (missing artifact, no docker daemon, no sudo, not
# darwin, ...). SKIPs do not fail the run — CI pins each channel explicitly.
#
# Fixed test credentials (same values as playwright.config.ts webServer.env);
# no zero-config log parsing. Each channel gets an isolated work dir and
# STORAGE_SQLITE_PATH, so the async SQLite sample seed lands in a known spot.
# ==============================================================================

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <tarball|npx|docker|deb|rpm|snap|homebrew|all> [artifact]" >&2
  exit 1
fi

CHANNEL=$1
ARTIFACT=${2:-}

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

BASE_PORT=${CHANNEL_E2E_PORT:-3140}

# Fixed auth env — mirrors playwright.config.ts webServer.env.
export JWT_SECRET="test-jwt-secret-for-e2e-tests-32ch"
export ADMIN_EMAIL="admin@libredb.org"
export ADMIN_PASSWORD="test-admin"
export USER_EMAIL="user@libredb.org"
export USER_PASSWORD="test-user"

AUTH_ENV=(
  "JWT_SECRET=$JWT_SECRET"
  "ADMIN_EMAIL=$ADMIN_EMAIL"
  "ADMIN_PASSWORD=$ADMIN_PASSWORD"
  "USER_EMAIL=$USER_EMAIL"
  "USER_PASSWORD=$USER_PASSWORD"
)

WORK=""
SERVER_PID=""
SERVER_SUDO=false
DOCKER_CONTAINER=""
SNAP_INSTALLED=false
DEB_INSTALLED=false
BREW_INSTALLED=false

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    # sudo-spawned servers are root-owned; a plain kill gets EPERM and the
    # node process leaks, breaking the next run on the same ports.
    if [ "$SERVER_SUDO" = "true" ]; then
      sudo kill "$SERVER_PID" 2>/dev/null || true
    else
      kill "$SERVER_PID" 2>/dev/null || true
    fi
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    SERVER_SUDO=false
  fi
  if [ -n "$DOCKER_CONTAINER" ]; then
    docker rm -f "$DOCKER_CONTAINER" >/dev/null 2>&1 || true
    DOCKER_CONTAINER=""
  fi
  if [ "$SNAP_INSTALLED" = "true" ]; then
    sudo snap remove libredb-studio >/dev/null 2>&1 || true
    SNAP_INSTALLED=false
  fi
  if [ "$DEB_INSTALLED" = "true" ]; then
    sudo dpkg -r libredb-studio >/dev/null 2>&1 || true
    DEB_INSTALLED=false
  fi
  if [ "$BREW_INSTALLED" = "true" ]; then
    brew uninstall libredb-studio >/dev/null 2>&1 || true
    BREW_INSTALLED=false
  fi
  if [ -n "$WORK" ]; then
    rm -rf "$WORK"
    WORK=""
  fi
}
trap cleanup EXIT

log() { echo "==> [$1] $2"; }

wait_health() { # wait_health <channel> <base-url> <log-file>
  for _ in $(seq 1 90); do
    if curl -sf -o /dev/null "$2/api/db/health"; then return 0; fi
    sleep 1
  done
  echo "FAIL [$1]: $2/api/db/health never returned 200; server log:" >&2
  cat "$3" >&2 || true
  return 1
}

wait_seed_file() { # wait_seed_file <channel> <path> [sudo]
  local found=false
  for _ in $(seq 1 30); do
    if [ "${3:-}" = "sudo" ]; then
      if sudo test -f "$2"; then found=true; break; fi
    elif [ -f "$2" ]; then
      found=true
      break
    fi
    sleep 1
  done
  if [ "$found" = "true" ]; then
    log "$1" "SQLite sample seeded at $2"
  else
    # Fail-open by design: the server stays up and Playwright decides —
    # the spec's 45s appear-timeout is the authoritative gate.
    log "$1" "WARNING: $2 not seeded within 30s; Playwright will decide"
  fi
}

run_playwright() { # run_playwright <channel> <base-url>
  log "$1" "running Playwright against $2"
  CHANNEL_E2E_BASE_URL="$2" bunx playwright test --config=playwright.channel.config.ts
}

default_tarball() {
  ls -t "$ROOT_DIR"/dist/libredb-studio-standalone-*.tar.gz 2>/dev/null | head -1 || true
}

# ------------------------------------------------------------------------------
# Channels. Each returns 0 (pass) or fails the script; SKIPs return 0 after
# recording the skip (only meaningful under 'all'; a directly requested
# channel that cannot run is an error).
# ------------------------------------------------------------------------------
RESULTS=()
record() { RESULTS+=("$1: $2"); }

skip_or_fail() { # skip_or_fail <channel> <reason>
  if [ "$RUN_ALL" = "true" ]; then
    log "$1" "SKIP - $2"
    record "$1" "SKIP ($2)"
    return 0
  fi
  echo "FAIL [$1]: $2" >&2
  exit 1
}

channel_tarball() {
  local tarball=${1:-$(default_tarball)}
  [ -n "$tarball" ] && [ -f "$tarball" ] || { skip_or_fail tarball "no standalone tarball (build with scripts/build-standalone-payload.sh dist)"; return; }
  WORK=$(mktemp -d)
  local port=$BASE_PORT base="http://127.0.0.1:$BASE_PORT"
  log tarball "extracting $(basename "$tarball")"
  mkdir -p "$WORK/app" "$WORK/data"
  tar -xzf "$tarball" -C "$WORK/app" --strip-components=1
  (
    cd "$WORK/app" && exec env "${AUTH_ENV[@]}" \
      NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
      HOSTNAME=127.0.0.1 PORT="$port" \
      STORAGE_PROVIDER=sqlite STORAGE_SQLITE_PATH="$WORK/data/storage.db" \
      node server.js
  ) >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  wait_health tarball "$base" "$WORK/server.log"
  wait_seed_file tarball "$WORK/data/sample-employees.db"
  run_playwright tarball "$base"
  record tarball PASS
  cleanup
}

channel_npx() {
  local tarball=${1:-$(default_tarball)}
  [ -n "$tarball" ] && [ -f "$tarball" ] || { skip_or_fail npx "no standalone tarball (build with scripts/build-standalone-payload.sh dist)"; return; }
  WORK=$(mktemp -d)
  local port=$((BASE_PORT + 1)) base="http://127.0.0.1:$((BASE_PORT + 1))"
  log npx "booting via bin/studio.js --archive"
  env "${AUTH_ENV[@]}" "HOME=$WORK" \
    STORAGE_PROVIDER=sqlite STORAGE_SQLITE_PATH="$WORK/data/storage.db" \
    node "$ROOT_DIR/bin/studio.js" --archive "$tarball" --port "$port" --host 127.0.0.1 \
    >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  wait_health npx "$base" "$WORK/server.log"
  wait_seed_file npx "$WORK/data/sample-employees.db"
  run_playwright npx "$base"
  record npx PASS
  cleanup
}

channel_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { skip_or_fail docker "docker daemon not available"; return; }
  local image=${1:-}
  if [ -z "$image" ]; then
    image="libredb-studio:channel-e2e"
    log docker "no image given - building $image from the repo Dockerfile"
    docker build -t "$image" "$ROOT_DIR" >/dev/null
  fi
  WORK=$(mktemp -d)
  chmod 777 "$WORK" # the container entrypoint chowns the mounted data dir to its app user
  mkdir -p "$WORK/data"
  chmod 777 "$WORK/data"
  local port=$((BASE_PORT + 2)) base="http://127.0.0.1:$((BASE_PORT + 2))"
  DOCKER_CONTAINER="libredb-channel-e2e"
  docker rm -f "$DOCKER_CONTAINER" >/dev/null 2>&1 || true
  log docker "running $image"
  docker run -d --name "$DOCKER_CONTAINER" \
    -p "127.0.0.1:$port:3000" \
    -v "$WORK/data:/app/data" \
    -e "JWT_SECRET=$JWT_SECRET" -e "ADMIN_EMAIL=$ADMIN_EMAIL" -e "ADMIN_PASSWORD=$ADMIN_PASSWORD" \
    -e "USER_EMAIL=$USER_EMAIL" -e "USER_PASSWORD=$USER_PASSWORD" \
    "$image" >/dev/null
  docker logs -f "$DOCKER_CONTAINER" >"$WORK/server.log" 2>&1 &
  wait_health docker "$base" "$WORK/server.log"
  wait_seed_file docker "$WORK/data/sample-employees.db"
  run_playwright docker "$base"
  record docker PASS
  cleanup
}

# Boot an extracted deb/rpm payload tree through the packaged wrapper without
# installing (no root needed): the wrapper honors LIBREDB_STUDIO_HOME.
run_extracted_linux_tree() { # <channel> <tree-root> <port>
  local channel=$1 tree=$2 port=$3 base="http://127.0.0.1:$3"
  local home="$tree/usr/lib/libredb-studio"
  [ -f "$home/server.js" ] || { echo "FAIL [$channel]: extracted package lacks $home/server.js" >&2; exit 1; }
  mkdir -p "$WORK/data"
  env "${AUTH_ENV[@]}" \
    LIBREDB_STUDIO_HOME="$home" \
    NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    PORT="$port" \
    STORAGE_PROVIDER=sqlite STORAGE_SQLITE_PATH="$WORK/data/storage.db" \
    "$tree/usr/bin/libredb-studio" >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  wait_health "$channel" "$base" "$WORK/server.log"
  wait_seed_file "$channel" "$WORK/data/sample-employees.db"
  run_playwright "$channel" "$base"
}

channel_deb() {
  local pkg=${1:-}
  [ -n "$pkg" ] && [ -f "$pkg" ] || { skip_or_fail deb "no .deb artifact given"; return; }
  command -v dpkg-deb >/dev/null 2>&1 || { skip_or_fail deb "dpkg-deb not available"; return; }
  WORK=$(mktemp -d)
  local port=$((BASE_PORT + 3))
  if command -v dpkg >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    # Real install (CI): exercises maintainer scripts and the installed wrapper.
    log deb "installing $(basename "$pkg") via dpkg"
    sudo dpkg -i "$pkg" >/dev/null
    DEB_INSTALLED=true
    mkdir -p "$WORK/data"
    sudo chmod 777 "$WORK" "$WORK/data"
    sudo env "${AUTH_ENV[@]}" \
      PORT="$port" HOSTNAME=127.0.0.1 \
      STORAGE_PROVIDER=sqlite STORAGE_SQLITE_PATH="$WORK/data/storage.db" \
      libredb-studio >"$WORK/server.log" 2>&1 &
    SERVER_PID=$!
    SERVER_SUDO=true
    wait_health deb "http://127.0.0.1:$port" "$WORK/server.log"
    wait_seed_file deb "$WORK/data/sample-employees.db" sudo
    run_playwright deb "http://127.0.0.1:$port"
  else
    # No passwordless sudo (local dev): extract and boot the payload tree.
    log deb "no passwordless sudo - extracting $(basename "$pkg") and booting from the tree"
    dpkg-deb -x "$pkg" "$WORK/root"
    run_extracted_linux_tree deb "$WORK/root" "$port"
  fi
  record deb PASS
  cleanup
}

channel_rpm() {
  local pkg=${1:-}
  [ -n "$pkg" ] && [ -f "$pkg" ] || { skip_or_fail rpm "no .rpm artifact given"; return; }
  command -v rpm2cpio >/dev/null 2>&1 && command -v cpio >/dev/null 2>&1 || { skip_or_fail rpm "rpm2cpio/cpio not available"; return; }
  WORK=$(mktemp -d)
  local port=$((BASE_PORT + 4))
  # Debian-family hosts (local dev and GitHub runners) cannot rpm -i; extract
  # the payload tree and boot it through the packaged wrapper instead — this
  # still validates the rpm's content and boot path.
  log rpm "extracting $(basename "$pkg") and booting from the tree"
  mkdir -p "$WORK/root"
  (cd "$WORK/root" && rpm2cpio "$pkg" | cpio -idm --quiet)
  run_extracted_linux_tree rpm "$WORK/root" "$port"
  record rpm PASS
  cleanup
}

channel_snap() {
  local pkg=${1:-}
  [ -n "$pkg" ] && [ -f "$pkg" ] || { skip_or_fail snap "no .snap artifact given"; return; }
  command -v snap >/dev/null 2>&1 || { skip_or_fail snap "snapd not available"; return; }
  sudo -n true 2>/dev/null || { skip_or_fail snap "snap install requires passwordless sudo"; return; }
  WORK=$(mktemp -d)
  # The snap's app env pins PORT=3000/HOSTNAME=127.0.0.1 — port 3000 must be
  # free. Plain TCP probe: ANY occupant must trigger the skip, not just
  # another libredb-studio answering on /api/db/health.
  if (exec 3<>/dev/tcp/127.0.0.1/3000) 2>/dev/null; then
    exec 3>&- 3<&- || true
    skip_or_fail snap "port 3000 is already in use"
    return
  fi
  log snap "installing $(basename "$pkg") (--dangerous)"
  sudo snap install --dangerous "$pkg" >/dev/null
  SNAP_INSTALLED=true
  # The auto-started daemon booted with zero-config credentials; run our own
  # foreground instance with the fixed test env instead (snap run inherits
  # the calling environment for vars the snap does not pin).
  sudo snap stop libredb-studio >/dev/null 2>&1 || true
  sudo rm -f /var/snap/libredb-studio/current/sample-employees.db /var/snap/libredb-studio/current/libredb-storage.db 2>/dev/null || true
  sudo env "${AUTH_ENV[@]}" snap run libredb-studio >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  SERVER_SUDO=true
  wait_health snap "http://127.0.0.1:3000" "$WORK/server.log"
  wait_seed_file snap "/var/snap/libredb-studio/current/sample-employees.db" sudo
  run_playwright snap "http://127.0.0.1:3000"
  record snap PASS
  cleanup
}

channel_homebrew() {
  [ "$(uname -s)" = "Darwin" ] || { skip_or_fail homebrew "not macOS"; return; }
  command -v brew >/dev/null 2>&1 || { skip_or_fail homebrew "brew not available"; return; }
  local formula=${1:-}
  [ -n "$formula" ] && [ -f "$formula" ] || { skip_or_fail homebrew "no formula .rb given (render with scripts/render-homebrew-formula.mjs)"; return; }
  WORK=$(mktemp -d)
  local port=$((BASE_PORT + 5)) base="http://127.0.0.1:$((BASE_PORT + 5))"
  log homebrew "installing formula $(basename "$formula")"
  brew install --formula "$formula"
  BREW_INSTALLED=true
  env "${AUTH_ENV[@]}" \
    PORT="$port" \
    STORAGE_PROVIDER=sqlite STORAGE_SQLITE_PATH="$WORK/data/storage.db" \
    libredb-studio >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  wait_health homebrew "$base" "$WORK/server.log"
  wait_seed_file homebrew "$WORK/data/sample-employees.db"
  run_playwright homebrew "$base"
  record homebrew PASS
  cleanup # also uninstalls the formula (BREW_INSTALLED)
}

# ------------------------------------------------------------------------------
# Dispatch
# ------------------------------------------------------------------------------
RUN_ALL=false
case "$CHANNEL" in
  tarball) channel_tarball "$ARTIFACT" ;;
  npx) channel_npx "$ARTIFACT" ;;
  docker) channel_docker "$ARTIFACT" ;;
  deb) channel_deb "$ARTIFACT" ;;
  rpm) channel_rpm "$ARTIFACT" ;;
  snap) channel_snap "$ARTIFACT" ;;
  homebrew) channel_homebrew "$ARTIFACT" ;;
  all)
    RUN_ALL=true
    channel_tarball "$ARTIFACT"
    channel_npx "$ARTIFACT"
    channel_docker ""
    channel_deb "$(ls -t "$ROOT_DIR"/dist/*.deb 2>/dev/null | head -1 || true)"
    channel_rpm "$(ls -t "$ROOT_DIR"/dist/*.rpm 2>/dev/null | head -1 || true)"
    channel_snap "$(ls -t "$ROOT_DIR"/dist/*.snap 2>/dev/null | head -1 || true)"
    channel_homebrew ""
    echo ""
    echo "==> channel-embedded-sample-e2e summary:"
    for r in "${RESULTS[@]}"; do echo "    $r"; done
    ;;
  *)
    echo "Unknown channel '$CHANNEL' (expected tarball|npx|docker|deb|rpm|snap|homebrew|all)" >&2
    exit 1
    ;;
esac

echo "==> channel-embedded-sample-e2e: done"
