#!/usr/bin/env bash
# Measures Kafka's write reach into write-reach.json beside this script (tests/live/kafka-write-reach.ts), on a fresh
# digest-pinned Apache Kafka 4.3.1 broker that would take any write Studio sent:
#
#   tests/fixtures/kafka/4.3.1/write-reach/run.sh
#
# One combined KRaft node named write-reach-kafka-4.3.1, with no authentication, no authorizer and automatic topic
# creation on, so a produce, a topic creation, an offset commit or a config change from Studio would land. Studio
# connects to the plaintext listener on 127.0.0.1:KAFKA_WRITE_REACH_PORT, a free port the script picks before the
# container starts unless the variable names one. Docker cannot pick it, because the broker advertises the port and a
# client follows the advertised address, so the port must be known before the broker starts. The broker's own tools
# read and write through a second listener inside the container. Run it under the team's docker lock; it touches only
# the container it names, which is removed when the run ends.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="apache/kafka:4.3.1@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837"
name="write-reach-kafka-4.3.1"
port="${KAFKA_WRITE_REACH_PORT:-$(bun -e 'const s = require("node:net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });')}"
cleanup() {
  docker rm -f -v "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker run -d --name "$name" --memory 1g --memory-swap 1g --cpus 1.5 -p "127.0.0.1:$port:9094" \
  -e KAFKA_NODE_ID=1 -e KAFKA_PROCESS_ROLES=broker,controller \
  -e KAFKA_LISTENERS="CONTROLLER://:29093,INTERNAL://:19092,PLAIN://:9094" \
  -e KAFKA_ADVERTISED_LISTENERS="INTERNAL://localhost:19092,PLAIN://localhost:$port" \
  -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP="CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,PLAIN:PLAINTEXT" \
  -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:29093 -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  -e KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL -e CLUSTER_ID=9L6g3nShT-eMCtK--X86sw \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
  -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 -e KAFKA_SHARE_COORDINATOR_STATE_TOPIC_REPLICATION_FACTOR=1 \
  -e KAFKA_SHARE_COORDINATOR_STATE_TOPIC_MIN_ISR=1 -e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 \
  -e KAFKA_AUTO_CREATE_TOPICS_ENABLE=true -e KAFKA_HEAP_OPTS="-Xms512m -Xmx512m" \
  "$image" >/dev/null
end=$((SECONDS + 180))
until docker exec "$name" /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:19092 --list >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$end" ]; then echo "The broker was not ready within 180 s." >&2; exit 1; fi
  sleep 2
done
KAFKA_WRITE_REACH_CONTAINER="$name" KAFKA_WRITE_REACH_IMAGE="$image" KAFKA_WRITE_REACH_OUT="$dir" \
  KAFKA_WRITE_REACH_PORT="$port" bun "$dir/../../../../live/kafka-write-reach.ts"
