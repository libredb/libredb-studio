/**
 * Writes the records the console producer cannot:
 * - `bytes` offset 1, a value that is not valid UTF-8: kafka-console-producer.sh re-encodes
 *   invalid UTF-8 to U+FFFD (measured 2026-09-23);
 * - `txn`, one committed and one aborted transaction of two records each, so a read shows
 *   what READ_COMMITTED keeps and that no transaction marker becomes a row.
 * Run once after docker/kafka/seed.sh has created both topics:
 *   bun docker/kafka/seed-binary.ts localhost:9092
 * It is fixture infrastructure: the provider never imports it, and the seam guard names
 * it as the one importer of the client outside the provider.
 */
import { Producer } from "@platformatic/kafka";

const bootstrapBrokers = [process.argv[2] ?? "localhost:9092"];
const record = (txn: string, n: number) => ({ topic: "txn", value: Buffer.from(JSON.stringify({ txn, n })) });

const producer = new Producer({ clientId: "libredb-seed", bootstrapBrokers, autocreateTopics: false });
try {
  await producer.send({ messages: [{ topic: "bytes", value: Buffer.from([0xff, 0xfe, 0x00, 0x01]) }] });
  console.log("seeded bytes offset 1");
} finally {
  await producer.close();
}

const transactional = new Producer({
  clientId: "libredb-seed-txn",
  bootstrapBrokers,
  autocreateTopics: false,
  idempotent: true,
  transactionalId: "libredb-seed-txn",
});
try {
  const committed = await transactional.beginTransaction();
  await committed.send({ messages: [record("committed", 1), record("committed", 2)] });
  await committed.commit();
  const aborted = await transactional.beginTransaction();
  await aborted.send({ messages: [record("aborted", 3), record("aborted", 4)] });
  await aborted.abort();
  console.log("seeded txn");
} finally {
  await transactional.close();
}
