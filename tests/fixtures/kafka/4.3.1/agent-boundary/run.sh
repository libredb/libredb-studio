#!/usr/bin/env bash
# Re-records boundary.json in this directory on a fresh digest-pinned Apache Kafka 4.3.1 broker:
#
#   tests/fixtures/kafka/4.3.1/agent-boundary/run.sh
#
# One combined KRaft node named <KAFKA_PREFIX>4.3.1 (default prefix libredb-agent-kafka-), with the kafka-auth
# fixture's shape (database-compose.yml): SCRAM-SHA-512 over TLS on 127.0.0.1:KAFKA_AGENT_SASL_PORT (default 29094)
# with StandardAuthorizer, and a plaintext listener on 127.0.0.1:KAFKA_AGENT_PLAIN_PORT (default 29095) whose
# ANONYMOUS principal is a super user, with automatic topic creation on. The broker's own tools send the raw calls as
# the reader through a third SCRAM-over-TLS listener, advertised at an address inside the container. The certificates are made here for the
# run in a temporary directory and the reader's password by the probe; neither is written to a capture. The container
# and the directory are removed when the run ends.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="apache/kafka:4.3.1@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837"
name="${KAFKA_PREFIX:-libredb-agent-kafka-}4.3.1"
sasl_port="${KAFKA_AGENT_SASL_PORT:-29094}"
plain_port="${KAFKA_AGENT_PLAIN_PORT:-29095}"
certs="$(mktemp -d)"
cleanup() {
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  rm -rf "$certs"
}
trap cleanup EXIT
docker rm -f -v "$name" >/dev/null 2>&1 || true
(
  cd "$certs"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -subj "/CN=libredb-agent-kafka-ca" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout broker.key -out broker.csr -subj "/CN=localhost" 2>/dev/null
  printf "subjectAltName=DNS:localhost,IP:127.0.0.1\n" >san.ext
  openssl x509 -req -in broker.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out broker.crt -days 2 -extfile san.ext 2>/dev/null
  openssl pkcs8 -topk8 -nocrypt -in broker.key -out broker.pk8
  cat broker.pk8 broker.crt >broker.pem
  chmod 755 . && chmod 644 ca.pem broker.pem
)
docker run -d --name "$name" --memory 1g --memory-swap 1g --cpus 1.5 \
  -p "127.0.0.1:$sasl_port:9093" -p "127.0.0.1:$plain_port:9094" -v "$certs:/certs:ro" \
  -e KAFKA_NODE_ID=1 -e KAFKA_PROCESS_ROLES=broker,controller \
  -e KAFKA_LISTENERS="CONTROLLER://:29093,INTERNAL://:19092,EXTERNAL://:9093,PLAIN://:9094,READER://:9095" \
  -e KAFKA_ADVERTISED_LISTENERS="INTERNAL://localhost:19092,EXTERNAL://localhost:$sasl_port,PLAIN://localhost:$plain_port,READER://localhost:9095" \
  -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP="CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,EXTERNAL:SASL_SSL,PLAIN:PLAINTEXT,READER:SASL_SSL" \
  -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:29093 -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  -e KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL -e CLUSTER_ID=8L6g3nShT-eMCtK--X86sw \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
  -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 -e KAFKA_SHARE_COORDINATOR_STATE_TOPIC_REPLICATION_FACTOR=1 \
  -e KAFKA_SHARE_COORDINATOR_STATE_TOPIC_MIN_ISR=1 -e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 \
  -e KAFKA_AUTO_CREATE_TOPICS_ENABLE=true \
  -e KAFKA_SASL_ENABLED_MECHANISMS=SCRAM-SHA-512 \
  -e KAFKA_LISTENER_NAME_EXTERNAL_SCRAM___SHA___512_SASL_JAAS_CONFIG="org.apache.kafka.common.security.scram.ScramLoginModule required;" \
  -e KAFKA_LISTENER_NAME_READER_SCRAM___SHA___512_SASL_JAAS_CONFIG="org.apache.kafka.common.security.scram.ScramLoginModule required;" \
  -e KAFKA_SSL_KEYSTORE_TYPE=PEM -e KAFKA_SSL_KEYSTORE_LOCATION=/certs/broker.pem \
  -e KAFKA_AUTHORIZER_CLASS_NAME=org.apache.kafka.metadata.authorizer.StandardAuthorizer \
  -e KAFKA_SUPER_USERS="User:ANONYMOUS" -e KAFKA_HEAP_OPTS="-Xms512m -Xmx512m" \
  "$image" >/dev/null
end=$((SECONDS + 180))
until docker exec "$name" /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:19092 --list >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$end" ]; then echo "The broker was not ready within 180 s." >&2; exit 1; fi
  sleep 2
done
KAFKA_AGENT_FLAVOR=kafka KAFKA_AGENT_CONTAINER="$name" KAFKA_AGENT_IMAGE="$image" KAFKA_AGENT_OUT="$dir" \
  KAFKA_AGENT_SASL_PORT="$sasl_port" KAFKA_AGENT_PLAIN_PORT="$plain_port" KAFKA_AGENT_CA="$certs/ca.pem" \
  bun "$dir/../../../../live/kafka-agent-boundary.ts"
