#!/bin/sh
# Captures the Prometheus agent path's boundary into boundary.json beside this script
# (tests/live/prometheus-agent-boundary.ts): a fresh prom/prometheus v3.13.3 by digest with the admin API, the
# remote-write receiver and the lifecycle endpoints all on, and a fresh VictoriaMetrics v1.152.0 by digest, the
# wire-compatible relative the same provider serves, each on its own port and removed at the end.
#
#   sh tests/fixtures/prometheus/v3.13.3/agent-boundary/run.sh
#
# The scrape targets carry a token in their query string and a user name and password in an address, generated per run
# into a temporary directory outside the repository, so the capture can show what the agent path keeps of them; the
# capture script checks that none of them reaches boundary.json before it writes it, and records no credential value at
# all. The raw admin, remote-write, OTLP, import and lifecycle requests are sent by the capture script, never by Studio.
# `--query.max-samples` is lowered so the server's own sample-limit refusal can be measured without loading the host.
# Run it under the team's docker lock; it touches only the containers and the network it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
PROM_IMAGE="prom/prometheus@sha256:6976aa8a60fec930796ce5772b8d12da7a318a5daa8d40d69c5c7819a05eeed7"
VM_IMAGE="victoriametrics/victoria-metrics@sha256:86ca5fdb6d87d56ba047b044039019ba2bd9042b36e35f6ea34e437b6c825cef"
PROM_NAME="pr33-agent-prometheus"
VM_NAME="pr33-agent-victoriametrics"
NET="pr33-agent-net"
PROM_PORT=19090
VM_PORT=18428
work="$(mktemp -d)"

cleanup() {
  docker rm -f "$PROM_NAME" "$VM_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
cleanup
work="$(mktemp -d)"

# Values generated for this run only: never printed, never written inside the repository.
PROMETHEUS_AGENT_TOKEN="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
PROMETHEUS_AGENT_USER="u$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
export PROMETHEUS_AGENT_TOKEN PROMETHEUS_AGENT_USER

mkdir -p "$work/prom/rules"
cat >"$work/prom/prometheus.yml" <<CONFIG
global:
  scrape_interval: 5s
  evaluation_interval: 5s
rule_files:
  - /etc/prometheus/rules/*.yml
scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
  - job_name: studio-token-query
    params:
      token: ["$PROMETHEUS_AGENT_TOKEN"]
    static_configs:
      - targets: ["localhost:9090"]
  - job_name: studio-token-down
    params:
      token: ["$PROMETHEUS_AGENT_TOKEN"]
    static_configs:
      - targets: ["127.0.0.1:1"]
  - job_name: studio-userinfo
    static_configs:
      - targets: ["$PROMETHEUS_AGENT_USER:$PROMETHEUS_AGENT_TOKEN@localhost:9090"]
CONFIG
cat >"$work/prom/rules/capture.yml" <<RULES
groups:
  - name: studio-capture
    rules:
      - record: studio_capture_seed
        expr: vector(1)
      - alert: StudioCaptureFiring
        expr: vector(1)
        annotations:
          runbook_url: "https://$PROMETHEUS_AGENT_USER:$PROMETHEUS_AGENT_TOKEN@runbooks.example.invalid/page?token=$PROMETHEUS_AGENT_TOKEN#section"
          summary: "see http://example.invalid/a?token=$PROMETHEUS_AGENT_TOKEN for more"
RULES
mkdir -p "$work/vm"
sed -e 's/localhost:9090/'"$PROM_NAME"':9090/' -e '/evaluation_interval/d' -e '/rule_files/,/rules\/\*/d' \
  "$work/prom/prometheus.yml" >"$work/vm/scrape.yml"
chmod -R a+rX "$work"

docker network create "$NET" >/dev/null
docker run -d --name "$PROM_NAME" --network "$NET" -p "127.0.0.1:$PROM_PORT:9090" -v "$work/prom:/etc/prometheus:ro" \
  "$PROM_IMAGE" --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus \
  --web.enable-admin-api --web.enable-remote-write-receiver --web.enable-lifecycle --query.max-samples=100000 >/dev/null
docker run -d --name "$VM_NAME" --network "$NET" -p "127.0.0.1:$VM_PORT:8428" -v "$work/vm:/etc/vm:ro" \
  "$VM_IMAGE" -promscrape.config=/etc/vm/scrape.yml >/dev/null

i=0
until curl -fsS "http://127.0.0.1:$PROM_PORT/-/ready" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$VM_PORT/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "run.sh: the servers never became ready" >&2; exit 1; }
  sleep 1
done
# Long enough for every target to be scraped and the rules evaluated a few times, and past VictoriaMetrics' 30-second
# latency offset, inside which an instant query does not yet see a sample.
sleep 45

cd "$repo"
PROMETHEUS_AGENT_URL="http://127.0.0.1:$PROM_PORT" VICTORIAMETRICS_AGENT_URL="http://127.0.0.1:$VM_PORT" \
  PROMETHEUS_AGENT_OUT="$here" PROMETHEUS_AGENT_IMAGE="$PROM_IMAGE" VICTORIAMETRICS_AGENT_IMAGE="$VM_IMAGE" \
  bun tests/live/prometheus-agent-boundary.ts
