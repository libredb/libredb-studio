#!/bin/sh
# Measures Prometheus's write reach into write-reach.json beside this script (tests/live/prometheus-write-reach.ts):
# a fresh prom/prometheus v3.13.3 by digest with the admin API, the remote-write receiver and the lifecycle endpoints
# all on, so a write Studio sent would land, removed at the end.
#
#   sh tests/fixtures/prometheus/v3.13.3/write-reach/run.sh
#
# The server scrapes nothing, itself included, because its own request metrics would add a series for every new
# handler Studio reads; its series come from recording and alerting rules alone, so the TSDB head's series count moves
# when a new series is written (remote write, OTLP). The admin and lifecycle endpoints leave the count unchanged, so the
# capture also records every request Studio sent, which shows none of them was asked. The capture script reads the count
# before and after every provider surface, then sends one raw remote write, never through Studio, to show the count
# does move when a new series lands.
# Run it under the team's docker lock; it touches only the container it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
PROM_IMAGE="prom/prometheus@sha256:6976aa8a60fec930796ce5772b8d12da7a318a5daa8d40d69c5c7819a05eeed7"
PROM_NAME="write-reach-prometheus"
PROM_PORT=19091
work="$(mktemp -d)"

cleanup() {
  docker rm -f "$PROM_NAME" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
cleanup
work="$(mktemp -d)"

mkdir -p "$work/rules"
cat >"$work/prometheus.yml" <<'CONFIG'
global:
  evaluation_interval: 2s
rule_files:
  - /etc/prometheus/rules/*.yml
CONFIG
cat >"$work/rules/write-reach.yml" <<'RULES'
groups:
  - name: write-reach
    rules:
      - record: write_reach_seed
        expr: vector(1)
      - record: write_reach_seed_by_job
        expr: label_replace(vector(2), "job", "seed", "", "")
      - alert: WriteReachFiring
        expr: vector(1)
RULES
chmod -R a+rX "$work"

docker run -d --name "$PROM_NAME" -p "127.0.0.1:$PROM_PORT:9090" -v "$work:/etc/prometheus:ro" \
  "$PROM_IMAGE" --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus \
  --web.enable-admin-api --web.enable-remote-write-receiver --web.enable-lifecycle >/dev/null

i=0
until curl -fsS "http://127.0.0.1:$PROM_PORT/-/ready" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "run.sh: the server never became ready" >&2; exit 1; }
  sleep 1
done
# Long enough for the rules to be evaluated several times, so every rule series is in the head before the first read.
sleep 15

cd "$repo"
PROMETHEUS_WRITE_REACH_URL="http://127.0.0.1:$PROM_PORT" PROMETHEUS_WRITE_REACH_OUT="$here" \
  PROMETHEUS_WRITE_REACH_IMAGE="$PROM_IMAGE" bun tests/live/prometheus-write-reach.ts
