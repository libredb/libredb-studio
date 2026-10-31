#!/usr/bin/env bash
# Re-records boundary.json in this directory on a fresh digest-pinned Redpanda v26.2.2 broker:
#
#   tests/fixtures/redpanda/26.2.2/agent-boundary/run.sh
#
# One dev-container node named <KAFKA_PREFIX>redpanda-26.2.2 (default prefix libredb-agent-kafka-), plaintext with no
# authentication on 127.0.0.1:KAFKA_AGENT_PLAIN_PORT (default 29096), with automatic topic creation on. The raw calls
# are sent by Apache Kafka 4.3.1's own tools from a second container in the broker's network namespace; both are
# removed when the run ends.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="redpandadata/redpanda:v26.2.2@sha256:468bd13a9f2bd24794cb7fddc867c767fb1008b9a07b297b89fde48c564d7d96"
tools="apache/kafka:4.3.1@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837"
name="${KAFKA_PREFIX:-libredb-agent-kafka-}redpanda-26.2.2"
plain_port="${KAFKA_AGENT_PLAIN_PORT:-29096}"
cleanup() {
  docker rm -f -v "$name" "$name-tools" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker run -d --name "$name" --memory 1536m --memory-swap 1536m --cpus 1 -p "127.0.0.1:$plain_port:29092" "$image" \
  redpanda start --mode=dev-container --smp=1 --memory=1G \
  --kafka-addr=internal://0.0.0.0:9092,external://0.0.0.0:29092 \
  --advertise-kafka-addr="internal://127.0.0.1:9092,external://127.0.0.1:$plain_port" >/dev/null
end=$((SECONDS + 120))
until docker exec "$name" rpk cluster health 2>/dev/null | grep -q "Healthy:.*true"; do
  if [ "$SECONDS" -ge "$end" ]; then echo "The broker was not ready within 120 s." >&2; exit 1; fi
  sleep 1
done
docker exec "$name" rpk cluster config set auto_create_topics_enabled true >/dev/null
# The tools container shares the broker's network namespace and sleeps until the run ends.
docker run -d --name "$name-tools" --network "container:$name" --memory 512m --entrypoint sleep "$tools" infinity >/dev/null
KAFKA_AGENT_FLAVOR=redpanda KAFKA_AGENT_CONTAINER="$name" KAFKA_AGENT_TOOLS="$name-tools" KAFKA_AGENT_IMAGE="$image" \
  KAFKA_AGENT_OUT="$dir" KAFKA_AGENT_PLAIN_PORT="$plain_port" \
  bun "$dir/../../../../live/kafka-agent-boundary.ts"
