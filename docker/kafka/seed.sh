#!/usr/bin/env bash
# Seeds the fixture every Kafka provider test and the live read-only check rely on.
#   seed.sh <bootstrap> [topics|groups|all] [replication-factor]
# The replication factor defaults to 1 (the single node and Redpanda); the three-node
# cluster's seed passes 3.
# "topics" writes the topics and records only, so a broker seeded that far has never been
# asked for a group coordinator and holds no __consumer_offsets (the live check's tripwire
# pass); "groups" adds the consumer groups; "all", the default, does both.
# Each codec topic is created with a TOPIC-level compression.type AND produced with the
# same producer-side codec: Apache Kafka stores the topic's codec, and Redpanda ignores the
# topic property and stores what the producer sent. A producer-side property once failed
# silently here and left every "compressed" topic uncompressed, so the capture checks the
# stored codec from the fetched batches on both brokers.
set -euo pipefail
B="$1"
MODE="${2:-all}"
RF="${3:-1}"
T=/opt/kafka/bin
topic() { "$T/kafka-topics.sh" --bootstrap-server "$B" --create --if-not-exists "$@" >/dev/null; }

if [ "$MODE" = "topics" ] || [ "$MODE" = "all" ]; then
  # The image has bash, seq, sed and printf but no python3 (checked on apache/kafka:4.3.1).
  # Each record carries two `trace` headers, so a header name repeated in one record is seeded.
  topic --topic orders --partitions 3 --replication-factor "$RF"
  countries=(TR DE US)
  for i in $(seq 0 59); do
    printf 'trace:t%d,trace:u%d,h1:v%d\tkey-%d\t{"id": %d, "country": "%s", "note": "ü ö 日本"}\n' \
      $((i % 3)) $((i % 3)) "$i" $((i % 5)) "$i" "${countries[$((i % 3))]}"
  done | "$T/kafka-console-producer.sh" --bootstrap-server "$B" --topic orders \
    --reader-property parse.key=true --reader-property parse.headers=true \
    --reader-property key.separator=$'\t' --reader-property headers.delimiter=$'\t' \
    --reader-property headers.separator=,

  for c in gzip snappy lz4 zstd; do
    topic --topic "codec-$c" --partitions 1 --replication-factor "$RF" --config compression.type="$c"
    seq 1 20 | sed "s/^/{\"n\":/; s/$/,\"codec\":\"$c\"}/" |
      "$T/kafka-console-producer.sh" --bootstrap-server "$B" --topic "codec-$c" --compression-codec "$c"
  done

  topic --topic big --partitions 1 --replication-factor "$RF"
  { head -c 900000 /dev/zero | tr '\0' 'x'; printf '\n'; } | "$T/kafka-console-producer.sh" --bootstrap-server "$B" --topic big

  # Offset 0 of `bytes`: a Confluent-framed value. Every byte is ASCII or NUL, which the
  # console producer passes through. The non-UTF-8 value at offset 1 is written by
  # docker/kafka/seed-binary.ts instead: the console producer re-encodes invalid UTF-8,
  # measured on 2026-09-23 (`\xff\xfe\x00\x01` was stored as `efbfbdefbfbd0001`).
  topic --topic bytes --partitions 1 --replication-factor "$RF"
  printf '\x00\x00\x00\x00\x2a{"framed":true}\n' | "$T/kafka-console-producer.sh" --bootstrap-server "$B" --topic bytes

  # A LogAppendTime topic: the broker stamps its own time on each batch's maxTimestamp,
  # and the records keep the producer's deltas.
  topic --topic ts-append --partitions 1 --replication-factor "$RF" --config message.timestamp.type=LogAppendTime
  printf '{"stamped":1}\n{"stamped":2}\n' | "$T/kafka-console-producer.sh" --bootstrap-server "$B" --topic ts-append

  # Written by docker/kafka/seed-binary.ts: one committed and one aborted transaction.
  topic --topic txn --partitions 1 --replication-factor "$RF"

  topic --topic lag-partial --partitions 1 --replication-factor "$RF"
  printf '{"partial":1}\n' | "$T/kafka-console-producer.sh" --bootstrap-server "$B" --topic lag-partial
fi

if [ "$MODE" = "groups" ] || [ "$MODE" = "all" ]; then
  "$T/kafka-console-consumer.sh" --bootstrap-server "$B" --topic orders --group lag-classic \
    --from-beginning --max-messages 10 --consumer-property group.protocol=classic >/dev/null
  "$T/kafka-console-consumer.sh" --bootstrap-server "$B" --topic orders --group lag-kip848 \
    --from-beginning --max-messages 25 --consumer-property group.protocol=consumer >/dev/null
  # A partition added after the group committed has no committed offset: the lag row the
  # provider shows as null with "no committed offset".
  "$T/kafka-console-consumer.sh" --bootstrap-server "$B" --topic lag-partial --group lag-partial \
    --from-beginning --max-messages 1 --consumer-property group.protocol=classic >/dev/null
  "$T/kafka-topics.sh" --bootstrap-server "$B" --alter --topic lag-partial --partitions 2
fi
echo "seeded $MODE"
