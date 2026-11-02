#!/usr/bin/env bash
# Re-records mcp-boundary.json in this directory on a fresh digest-pinned RabbitMQ 4.3.6 broker:
#
#   tests/fixtures/rabbitmq/4.3.6/mcp-boundary/run.sh
#
# One container named <RABBITMQ_PREFIX>4.3.6 (default prefix libredb-mcp-rabbitmq-), plaintext, on
# 127.0.0.1:RABBITMQ_MCP_AMQP_PORT and 127.0.0.1:RABBITMQ_MCP_MANAGEMENT_PORT (defaults 25673 and 35673), removed
# when the run ends. The administrator's password is made here for the run and the narrow user's by the probe; neither
# is written to a capture.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="rabbitmq:4.3.6-management@sha256:8dd6e3570ddaa2ef82a6c3a8950e79c1f73893adfbdddbc374fc1f1ac8a0f5dd"
name="${RABBITMQ_PREFIX:-libredb-mcp-rabbitmq-}4.3.6"
amqp_port="${RABBITMQ_MCP_AMQP_PORT:-25673}"
http_port="${RABBITMQ_MCP_MANAGEMENT_PORT:-35673}"
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
RABBITMQ_MCP_HOST=127.0.0.1 RABBITMQ_MCP_AMQP_PORT="$amqp_port" RABBITMQ_MCP_MANAGEMENT_PORT="$http_port" \
  RABBITMQ_MCP_ADMIN_PASSWORD="$admin_password" RABBITMQ_MCP_IMAGE="$image" RABBITMQ_MCP_OUT="$dir" \
  bun "$dir/../../../../live/rabbitmq-mcp-boundary.ts"
