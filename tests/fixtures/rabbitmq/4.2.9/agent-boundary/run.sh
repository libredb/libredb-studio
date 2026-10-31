#!/usr/bin/env bash
# Re-records boundary.json in this directory on a fresh digest-pinned RabbitMQ 4.2.9 broker:
#
#   tests/fixtures/rabbitmq/4.2.9/agent-boundary/run.sh
#
# One container named <RABBITMQ_PREFIX>4.2.9 (default prefix libredb-agent-rabbitmq-), plaintext, on
# 127.0.0.1:RABBITMQ_AGENT_AMQP_PORT and 127.0.0.1:RABBITMQ_AGENT_MANAGEMENT_PORT (defaults 25673 and 35673), removed
# when the run ends. The administrator's password is made here for the run and the reader's by the probe; neither is
# written to a capture.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="rabbitmq:4.2.9-management@sha256:9e9fd21d60f060acc9ecbd847cd1dcb87e6550bdb0297c27e79a40bfe1766ce4"
name="${RABBITMQ_PREFIX:-libredb-agent-rabbitmq-}4.2.9"
amqp_port="${RABBITMQ_AGENT_AMQP_PORT:-25673}"
http_port="${RABBITMQ_AGENT_MANAGEMENT_PORT:-35673}"
cleanup() { docker rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
admin_password="$(openssl rand -hex 16)"
docker run -d --name "$name" --ulimit nofile=65536:65536 \
  -e RABBITMQ_DEFAULT_USER=libredb-admin -e RABBITMQ_DEFAULT_PASS="$admin_password" \
  -p "127.0.0.1:$amqp_port:5672" -p "127.0.0.1:$http_port:15672" "$image" >/dev/null
end=$((SECONDS + 120))
until curl -fsS -o /dev/null -u "libredb-admin:$admin_password" "http://127.0.0.1:$http_port/api/overview" \
  && docker exec "$name" rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$end" ]; then echo "The broker was not ready within 120 s." >&2; exit 1; fi
  sleep 1
done
RABBITMQ_AGENT_HOST=127.0.0.1 RABBITMQ_AGENT_AMQP_PORT="$amqp_port" RABBITMQ_AGENT_MANAGEMENT_PORT="$http_port" \
  RABBITMQ_AGENT_ADMIN_PASSWORD="$admin_password" RABBITMQ_AGENT_IMAGE="$image" RABBITMQ_AGENT_OUT="$dir" \
  bun "$dir/../../../../live/rabbitmq-agent-boundary.ts"
