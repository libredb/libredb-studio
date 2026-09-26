# Kafka fixtures

Verbatim answers of `@platformatic/kafka` 2.11.0 against the compose `kafka`, `redpanda` and `kafka-auth` services, captured before any provider code was written (#1088, spec section 10, gate 4).
A test that needs a real broker answer loads one of these files through `tests/helpers/kafka-fixtures.ts` instead of writing its own.
The capture harness is local and never committed; it called every surface separately, recorded a pass or the verbatim error, and rendered the tables below from the files, so no value in them was typed by hand.

## Provenance

| Item | Value |
|---|---|
| Kafka | `apache/kafka:4.3.1`, `apache/kafka@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837`, cluster id `4L6g3nShT-eMCtK--X86sw`, captured 2026-09-24T18:56:45.127Z |
| Redpanda | `redpandadata/redpanda:v26.2.2`, `redpandadata/redpanda@sha256:468bd13a9f2bd24794cb7fddc867c767fb1008b9a07b297b89fde48c564d7d96`, cluster id `redpanda.1a4a61b6-33c7-4ff6-90db-fa12346feb59`, captured 2026-09-24T18:58:18.530Z |
| kafka-auth | `apache/kafka:4.3.1`, cluster id `7L6g3nShT-eMCtK--X86sw`, principal `reader` with no ACL, captured 2026-09-24T18:58:40.194Z |
| No broker | the transport failures, captured 2026-09-24T18:56:39.621Z |
| Fake broker | a local server answering ApiVersions v3 and Metadata v12 with a leaderless partition, captured 2026-09-24T18:56:28.640Z |
| Client | `@platformatic/kafka` 2.11.0 under Bun 1.4.2, with the options the provider builds: `retries: 1`, `autocreateTopics: false`, and a Consumer in group `libredb-studio-never-joined` with `groupProtocol: "classic"` that never joins it |

The brokers were seeded by `docker/kafka/seed.sh` and `docker/kafka/seed-binary.ts`:

```bash
docker compose -f database-compose.yml up -d kafka kafka-init redpanda
test "$(docker wait libredb-kafka-init)" = 0
bun docker/kafka/seed-binary.ts localhost:9092
docker run --rm --network host -v "$PWD/docker/kafka/seed.sh:/seed.sh:ro" --entrypoint bash apache/kafka:4.3.1 /seed.sh localhost:29092
bun docker/kafka/seed-binary.ts localhost:29092
```

Before and after each broker's whole capture the harness took the broker state the read-only guarantee covers (topics, groups and their committed offsets, every partition's earliest and latest offset, the topic and broker configs, and on `kafka-auth` the ACLs), and the two snapshots were identical on all three brokers.
On Kafka and Redpanda the broker log of that window named neither the never-joined group nor an auto-created topic.

## Encoding

Each file is `{ "$captured": { image, clusterId, date, surface }, "outcome": "pass" | "fail", "payload": ... }`.
A `bigint` is `{ "$bigint": "<digits>" }`, a `Buffer` is `{ "$bytes": "<base64>" }` and a `Map` is `{ "$map": [[key, value], ...] }`.
A failure's payload is the error's enumerable fields plus its `class`, `message`, `code`, `errors` and `cause`, nested the same way, so the response a `ResponseError` carries is kept whole.
Every pass file was revived the way the helper revives it and compared with the live value before it was written.
JSON has no `undefined`, so an own key whose value was `undefined` is absent from the file: `redpanda-api-versions.json` has no `name` on API key 15000, which the client does not know, and `redpanda-list-groups.json` has no `groupType`, because Redpanda answers ListGroups below v5.

## What the captures show

- The four codec topics hold batches whose `attributes & 7` is 1, 2, 3 and 4 (gzip, snappy, lz4, zstd) on both brokers, asserted from the fetched batches, not from the topic config.
- `fetch-txn.json` holds the committed transaction's batch and two control batches (its COMMIT and the ABORT); the aborted batch is absent because the client drops an aborted range whose ABORT marker arrives in the same response, while a range whose marker is in a later response is kept.
- `fetch-ts-append.json` is one LogAppendTime batch (attribute bit `0x08`), whose records keep the producer's timestamp deltas.
- `fetch-bytes.json` holds a Confluent-framed value at offset 0 and the four bytes `ff fe 00 01` at offset 1.
- `fetch-big.json` asked for 1024 bytes and received the whole 900,000-byte record.
- `offsets-timestamp-future.json` answers offset `-1` for every partition, for a timestamp one day ahead.
- `error-consumer-group-describe-mixed.json` is ConsumerGroupDescribe (API 69) for a KIP-848 group and a classic one: the whole call fails, with the response kept on the error.
- On Redpanda v26.2.2, API 69 is not offered and a request for it closes the connection (`redpanda-consumer-group-describe.json`), and Fetch stops at v13.
  The seed's KIP-848 group does not exist there: the console consumer failed with `UnsupportedVersionException: The cluster does not support the new CONSUMER group protocol`.
- `error-authorization.json` is a copy of `error-topic-authorization.json`.

## Kafka

| File | Outcome | Surface |
|---|---|---|
| `api-versions.json` | pass | admin.listApis() |
| `committed-offsets.json` | pass | admin.listConsumerGroupOffsets({ groups: [lag-classic, lag-kip848, lag-partial] }) |
| `configs-broker-1.json` | pass | admin.describeConfigs({ resources: [{ resourceType: BROKER, resourceName: "1" }] }) |
| `configs-topic-orders.json` | pass | admin.describeConfigs({ resources: [{ resourceType: TOPIC, resourceName: "orders" }] }) |
| `consumer-group-describe.json` | pass | consumerGroupDescribeV0.api.async(conn, ["lag-kip848"], false) |
| `describe-groups-classic.json` | pass | admin.describeGroups({ groups: ["lag-classic"] }) |
| `error-consumer-group-describe-mixed.json` | fail | consumerGroupDescribeV0.api.async(conn, ["lag-kip848", "lag-classic"], false) |
| `error-offset-out-of-range.json` | fail | consumer.fetch(orders partition 1 offset 1000) |
| `error-unknown-topic.json` | fail | admin.metadata({ topics: ["no-such-topic"], autocreateTopics: false }) |
| `fetch-big.json` | pass | consumer.fetch(big partition 0 offset 0, maxBytes 1024) |
| `fetch-bytes.json` | pass | consumer.fetch(bytes partition 0 offset 0, READ_COMMITTED) |
| `fetch-codec-gzip.json` | pass | consumer.fetch(codec-gzip partition 0 offset 0, READ_COMMITTED) |
| `fetch-codec-lz4.json` | pass | consumer.fetch(codec-lz4 partition 0 offset 0, READ_COMMITTED) |
| `fetch-codec-snappy.json` | pass | consumer.fetch(codec-snappy partition 0 offset 0, READ_COMMITTED) |
| `fetch-codec-zstd.json` | pass | consumer.fetch(codec-zstd partition 0 offset 0, READ_COMMITTED) |
| `fetch-orders-p1-o5.json` | pass | consumer.fetch(orders partition 1 offset 5, READ_COMMITTED) |
| `fetch-ts-append.json` | pass | consumer.fetch(ts-append partition 0 offset 0, READ_COMMITTED) |
| `fetch-txn.json` | pass | consumer.fetch(txn partition 0 offset 0, READ_COMMITTED) |
| `find-coordinator.json` | pass | admin.findCoordinator({ keyType: GROUP, keys: ["lag-kip848"] }) |
| `list-groups.json` | pass | admin.listGroups({ types: ["consumer", "classic"] }) |
| `list-topics.json` | pass | admin.listTopics() |
| `log-dirs.json` | pass | admin.describeLogDirs({ topics: [{ name: "orders", partitions: [0, 1, 2] }] }) |
| `metadata-all.json` | pass | admin.metadata({ topics: <every seeded topic>, autocreateTopics: false }) |
| `metadata-brokers.json` | pass | admin.metadata({ topics: [], autocreateTopics: false, forceUpdate: true }) |
| `metadata-orders.json` | pass | admin.metadata({ topics: ["orders"], autocreateTopics: false }) |
| `offsets-earliest-big.json` | pass | consumer.listOffsets({ topics: ["big"], timestamp: -2 }) |
| `offsets-earliest-bytes.json` | pass | consumer.listOffsets({ topics: ["bytes"], timestamp: -2 }) |
| `offsets-earliest-codec-gzip.json` | pass | consumer.listOffsets({ topics: ["codec-gzip"], timestamp: -2 }) |
| `offsets-earliest-codec-lz4.json` | pass | consumer.listOffsets({ topics: ["codec-lz4"], timestamp: -2 }) |
| `offsets-earliest-codec-snappy.json` | pass | consumer.listOffsets({ topics: ["codec-snappy"], timestamp: -2 }) |
| `offsets-earliest-codec-zstd.json` | pass | consumer.listOffsets({ topics: ["codec-zstd"], timestamp: -2 }) |
| `offsets-earliest-lag-partial.json` | pass | consumer.listOffsets({ topics: ["lag-partial"], timestamp: -2 }) |
| `offsets-earliest-ts-append.json` | pass | consumer.listOffsets({ topics: ["ts-append"], timestamp: -2 }) |
| `offsets-earliest-txn.json` | pass | consumer.listOffsets({ topics: ["txn"], timestamp: -2 }) |
| `offsets-earliest.json` | pass | consumer.listOffsets({ topics: ["orders"], timestamp: -2 }) |
| `offsets-latest-big.json` | pass | consumer.listOffsets({ topics: ["big"], timestamp: -1 }) |
| `offsets-latest-bytes.json` | pass | consumer.listOffsets({ topics: ["bytes"], timestamp: -1 }) |
| `offsets-latest-codec-gzip.json` | pass | consumer.listOffsets({ topics: ["codec-gzip"], timestamp: -1 }) |
| `offsets-latest-codec-lz4.json` | pass | consumer.listOffsets({ topics: ["codec-lz4"], timestamp: -1 }) |
| `offsets-latest-codec-snappy.json` | pass | consumer.listOffsets({ topics: ["codec-snappy"], timestamp: -1 }) |
| `offsets-latest-codec-zstd.json` | pass | consumer.listOffsets({ topics: ["codec-zstd"], timestamp: -1 }) |
| `offsets-latest-lag-partial.json` | pass | consumer.listOffsets({ topics: ["lag-partial"], timestamp: -1 }) |
| `offsets-latest-ts-append.json` | pass | consumer.listOffsets({ topics: ["ts-append"], timestamp: -1 }) |
| `offsets-latest-txn.json` | pass | consumer.listOffsets({ topics: ["txn"], timestamp: -1 }) |
| `offsets-latest.json` | pass | consumer.listOffsets({ topics: ["orders"], timestamp: -1 }) |
| `offsets-timestamp-future.json` | pass | consumer.listOffsetsWithTimestamps({ topics: ["orders"], timestamp: <now + 1 day> }) |
| `offsets-timestamp.json` | pass | consumer.listOffsetsWithTimestamps({ topics: ["orders"], timestamp: 1790275771460 }) |

## kafka-auth

| File | Outcome | Surface |
|---|---|---|
| `error-authorization.json` | fail | admin.metadata({ topics: ["orders"], autocreateTopics: false }) as reader (no ACL) |
| `error-cluster-authorization.json` | fail | admin.describeConfigs({ resources: [{ resourceType: BROKER, resourceName: "1" }] }) as reader (no ACL) |
| `error-refused.json` | fail | admin.listTopics() to localhost:19099, where nothing listens |
| `error-requires-tls.json` | fail | admin.listTopics() in plaintext, no SASL, to kafka-auth's TLS port |
| `error-sasl.json` | fail | admin.listTopics() to kafka-auth with a wrong SCRAM-SHA-512 password |
| `error-tls-ca.json` | fail | admin.listTopics() to kafka-auth with TLS verified against a different CA |
| `error-tls-handshake.json` | fail | admin.listTopics() with TLS to the plaintext port localhost:9092 |
| `error-topic-authorization.json` | fail | admin.metadata({ topics: ["orders"], autocreateTopics: false }) as reader (no ACL) |

## Transport failures and the leaderless fake

| File | Outcome | Surface |
|---|---|---|
| `error-connect-timeout.json` | fail | admin.metadata({ topics: [] }) to the unroutable 10.255.255.1:9092, retries 0, connectTimeout 800 |
| `error-connection-closed.json` | fail | admin.metadata({ topics: [] }) to a listener that destroys each socket |
| `error-leaderless-list-topics.json` | fail | admin.listTopics() against a broker whose orders partition 1 has no leader |
| `error-leaderless-metadata.json` | fail | admin.metadata({ topics: ["orders"], autocreateTopics: false }) against a broker whose orders partition 1 has no leader |
| `error-request-timeout.json` | fail | admin.metadata({ topics: [] }) to a listener that accepts and never writes, requestTimeout 800 |

## Redpanda

| File | Outcome | Surface |
|---|---|---|
| `redpanda-api-versions.json` | pass | admin.listApis() |
| `redpanda-committed-offsets.json` | pass | admin.listConsumerGroupOffsets({ groups: [lag-classic, lag-kip848, lag-partial] }) |
| `redpanda-configs-broker-0.json` | pass | admin.describeConfigs({ resources: [{ resourceType: BROKER, resourceName: "0" }] }) |
| `redpanda-configs-topic-orders.json` | pass | admin.describeConfigs({ resources: [{ resourceType: TOPIC, resourceName: "orders" }] }) |
| `redpanda-consumer-group-describe.json` | fail | consumerGroupDescribeV0.api.async(conn, ["lag-kip848"], false) |
| `redpanda-describe-groups-classic.json` | pass | admin.describeGroups({ groups: ["lag-classic"] }) |
| `redpanda-error-consumer-group-describe-mixed.json` | fail | consumerGroupDescribeV0.api.async(conn, ["lag-kip848", "lag-classic"], false) |
| `redpanda-error-offset-out-of-range.json` | fail | consumer.fetch(orders partition 1 offset 1000) |
| `redpanda-error-unknown-topic.json` | fail | admin.metadata({ topics: ["no-such-topic"], autocreateTopics: false }) |
| `redpanda-fetch-big.json` | pass | consumer.fetch(big partition 0 offset 0, maxBytes 1024) |
| `redpanda-fetch-bytes.json` | pass | consumer.fetch(bytes partition 0 offset 0, READ_COMMITTED) |
| `redpanda-fetch-codec-gzip.json` | pass | consumer.fetch(codec-gzip partition 0 offset 0, READ_COMMITTED) |
| `redpanda-fetch-codec-lz4.json` | pass | consumer.fetch(codec-lz4 partition 0 offset 0, READ_COMMITTED) |
| `redpanda-fetch-codec-snappy.json` | pass | consumer.fetch(codec-snappy partition 0 offset 0, READ_COMMITTED) |
| `redpanda-fetch-codec-zstd.json` | pass | consumer.fetch(codec-zstd partition 0 offset 0, READ_COMMITTED) |
| `redpanda-fetch-orders-p1-o5.json` | pass | consumer.fetch(orders partition 1 offset 5, READ_COMMITTED) |
| `redpanda-fetch-ts-append.json` | pass | consumer.fetch(ts-append partition 0 offset 0, READ_COMMITTED) |
| `redpanda-fetch-txn.json` | pass | consumer.fetch(txn partition 0 offset 0, READ_COMMITTED) |
| `redpanda-find-coordinator.json` | pass | admin.findCoordinator({ keyType: GROUP, keys: ["lag-kip848"] }) |
| `redpanda-list-groups.json` | pass | admin.listGroups({ types: ["consumer", "classic"] }) |
| `redpanda-list-topics.json` | pass | admin.listTopics() |
| `redpanda-log-dirs.json` | pass | admin.describeLogDirs({ topics: [{ name: "orders", partitions: [0, 1, 2] }] }) |
| `redpanda-metadata-all.json` | pass | admin.metadata({ topics: <every seeded topic>, autocreateTopics: false }) |
| `redpanda-metadata-brokers.json` | pass | admin.metadata({ topics: [], autocreateTopics: false, forceUpdate: true }) |
| `redpanda-metadata-orders.json` | pass | admin.metadata({ topics: ["orders"], autocreateTopics: false }) |
| `redpanda-offsets-earliest-big.json` | pass | consumer.listOffsets({ topics: ["big"], timestamp: -2 }) |
| `redpanda-offsets-earliest-bytes.json` | pass | consumer.listOffsets({ topics: ["bytes"], timestamp: -2 }) |
| `redpanda-offsets-earliest-codec-gzip.json` | pass | consumer.listOffsets({ topics: ["codec-gzip"], timestamp: -2 }) |
| `redpanda-offsets-earliest-codec-lz4.json` | pass | consumer.listOffsets({ topics: ["codec-lz4"], timestamp: -2 }) |
| `redpanda-offsets-earliest-codec-snappy.json` | pass | consumer.listOffsets({ topics: ["codec-snappy"], timestamp: -2 }) |
| `redpanda-offsets-earliest-codec-zstd.json` | pass | consumer.listOffsets({ topics: ["codec-zstd"], timestamp: -2 }) |
| `redpanda-offsets-earliest-lag-partial.json` | pass | consumer.listOffsets({ topics: ["lag-partial"], timestamp: -2 }) |
| `redpanda-offsets-earliest-ts-append.json` | pass | consumer.listOffsets({ topics: ["ts-append"], timestamp: -2 }) |
| `redpanda-offsets-earliest-txn.json` | pass | consumer.listOffsets({ topics: ["txn"], timestamp: -2 }) |
| `redpanda-offsets-earliest.json` | pass | consumer.listOffsets({ topics: ["orders"], timestamp: -2 }) |
| `redpanda-offsets-latest-big.json` | pass | consumer.listOffsets({ topics: ["big"], timestamp: -1 }) |
| `redpanda-offsets-latest-bytes.json` | pass | consumer.listOffsets({ topics: ["bytes"], timestamp: -1 }) |
| `redpanda-offsets-latest-codec-gzip.json` | pass | consumer.listOffsets({ topics: ["codec-gzip"], timestamp: -1 }) |
| `redpanda-offsets-latest-codec-lz4.json` | pass | consumer.listOffsets({ topics: ["codec-lz4"], timestamp: -1 }) |
| `redpanda-offsets-latest-codec-snappy.json` | pass | consumer.listOffsets({ topics: ["codec-snappy"], timestamp: -1 }) |
| `redpanda-offsets-latest-codec-zstd.json` | pass | consumer.listOffsets({ topics: ["codec-zstd"], timestamp: -1 }) |
| `redpanda-offsets-latest-lag-partial.json` | pass | consumer.listOffsets({ topics: ["lag-partial"], timestamp: -1 }) |
| `redpanda-offsets-latest-ts-append.json` | pass | consumer.listOffsets({ topics: ["ts-append"], timestamp: -1 }) |
| `redpanda-offsets-latest-txn.json` | pass | consumer.listOffsets({ topics: ["txn"], timestamp: -1 }) |
| `redpanda-offsets-latest.json` | pass | consumer.listOffsets({ topics: ["orders"], timestamp: -1 }) |
| `redpanda-offsets-timestamp-future.json` | pass | consumer.listOffsetsWithTimestamps({ topics: ["orders"], timestamp: <now + 1 day> }) |
| `redpanda-offsets-timestamp.json` | pass | consumer.listOffsetsWithTimestamps({ topics: ["orders"], timestamp: 1790275839935 }) |
