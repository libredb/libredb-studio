/**
 * The statement budgets over the fake: 100,000 rows, 16 MiB of decoded cost and 32 MiB received per stream, each cut
 * shown with the rows before it after one Interrupt by the run's tag; a result that ends exactly on the row budget
 * whole and uninterrupted; an inline command answer under the same budget; a first batch that cannot fit under 32 MiB
 * refused as batch-too-large; and a VARIANT's text counted against the decoded budget still left, so that a row whose
 * text, or whose cost alone, passes what the texts before it left is cut before it.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { buildSparkConnectionOptions } from "@/lib/db/providers/sql/spark/connection-options";
import { SPARK_BATCH_OVERHEAD_BYTES } from "@/lib/db/providers/sql/spark/constants";
import type { SparkError } from "@/lib/db/providers/sql/spark/errors";
import { SparkRuns } from "@/lib/db/providers/sql/spark/execute";
import { grpcWireTransport, type SparkWireChannel } from "@/lib/db/providers/sql/spark/grpc-client";
import { SparkHeartbeat } from "@/lib/db/providers/sql/spark/heartbeat";
import { configSetRequest, releaseSessionRequest } from "@/lib/db/providers/sql/spark/requests";
import { SparkSessions } from "@/lib/db/providers/sql/spark/session";
import type { DatabaseConnection } from "@/lib/types";
import { type SparkFakeAnswer, type SparkFakeServer, startSparkFake } from "../../../helpers/spark-connect-server";
import { columnsStream, int64Batch, stringBatch } from "../../../helpers/spark-ipc";

const SV_SCHEMA = {
  struct: {
    fields: [
      { name: "s", data_type: { string: {} }, nullable: true },
      { name: "v", data_type: { variant: {} }, nullable: true },
    ],
  },
};
/** A VARIANT long string (basic type 0, primitive 16): the header 0x40, a 4-byte little-endian length, then the bytes. */
const variantString = (length: number) => {
  const bytes = new Uint8Array(5 + length).fill(0x61);
  bytes[0] = 0x40;
  new DataView(bytes.buffer).setUint32(1, length, true);
  return bytes;
};
/** One row: `s`, `sLength` x's, and `v`, a VARIANT string of `vLength` a's with an empty metadata dictionary. */
const variantRow = (sLength: number, vLength: number) =>
  columnsStream([
    { name: "s", kind: "utf8", values: ["x".repeat(sLength)] },
    {
      name: "v",
      kind: "struct",
      length: 1,
      children: [
        { name: "value", kind: "binary", values: [variantString(vLength)] },
        { name: "metadata", kind: "binary", values: [Uint8Array.of(0x01, 0x00, 0x00)], metadata: { variant: "true" } },
      ],
    },
  ]);
/** One row: `s`, `sLength` x's, and a null `v`, which writes no VARIANT text. */
const nullVariantRow = (sLength: number) =>
  columnsStream([
    { name: "s", kind: "utf8", values: ["x".repeat(sLength)] },
    {
      name: "v",
      kind: "struct",
      length: 1,
      valid: [false],
      children: [
        { name: "value", kind: "binary", values: [null] },
        { name: "metadata", kind: "binary", values: [null], metadata: { variant: "true" } },
      ],
    },
  ]);

const MiB = 1_048_576;
const ID_SCHEMA = { struct: { fields: [{ name: "id", data_type: { long: {} }, nullable: true }] } };
const V_SCHEMA = { struct: { fields: [{ name: "v", data_type: { string: {} }, nullable: true }] } };
const ids = (batches: number, last = 1_000) =>
  Array.from({ length: batches }, (_, index) => int64Batch(index * 1_000, index === batches - 1 ? last : 1_000));
const statements: Record<string, SparkFakeAnswer> = {
  "FROM range(0, 100001) SELECT id": { kind: "relation", schema: ID_SCHEMA, ipc: ids(101, 1) },
  "FROM range(0, 100000) SELECT id": { kind: "relation", schema: ID_SCHEMA, ipc: ids(100) },
  "WIDE ROWS": { kind: "relation", schema: V_SCHEMA, ipc: Array.from({ length: 20 }, () => stringBatch(100, 10_000)) },
  "SMALL THEN HUGE": { kind: "relation", schema: V_SCHEMA, ipc: [stringBatch(4, 3), stringBatch(1, 30 * MiB)] },
  "HUGE FIRST": { kind: "relation", schema: V_SCHEMA, ipc: [stringBatch(1, 30 * MiB)] },
  "BIG INLINE": { kind: "command", ipc: int64Batch(0, 100_001) },
  "VARIANT PAST BUDGET": {
    kind: "relation",
    schema: SV_SCHEMA,
    ipc: [variantRow(16, 16), variantRow(4 * MiB, 6 * MiB)],
  },
  "VARIANT THEN WIDE": { kind: "relation", schema: SV_SCHEMA, ipc: [variantRow(16, 6 * MiB), nullVariantRow(5 * MiB)] },
};
let fake: SparkFakeServer;
let channel: SparkWireChannel;
let runs: SparkRuns;
let sessions: SparkSessions;
const control = () => ({ metadata: {}, deadline: new Date(Date.now() + 5_000), signal: new AbortController().signal });
const interrupts = () => fake.log.entries.filter((entry) => entry.rpc === "Interrupt");
const run = (sql: string) =>
  runs.run({ sql, session: () => sessions.forScope(sql), deadline: new Date(Date.now() + 10_000) });

beforeAll(async () => {
  fake = await startSparkFake({ statements });
  const port = Number(fake.target.slice(fake.target.lastIndexOf(":") + 1));
  channel = grpcWireTransport(
    buildSparkConnectionOptions(
      { id: "c", name: "c", type: "spark", host: "127.0.0.1", port } as unknown as DatabaseConnection,
      { queryTimeout: 10_000 },
    ),
  );
  sessions = new SparkSessions(
    {
      configSet: async (session, pairs) =>
        (
          (await channel.unary("Config", configSetRequest(session, pairs), control())) as {
            server_side_session_id: string;
          }
        ).server_side_session_id,
      runSetup: async () => "",
      release: async (session) => {
        await channel.unary("ReleaseSession", releaseSessionRequest(session), control());
      },
    },
    {},
  );
  runs = new SparkRuns({
    channel: () => channel,
    metadata: {},
    heartbeat: new SparkHeartbeat(async () => undefined),
    sessions,
    errorConnection: { host: "127.0.0.1", port, secretForms: [] },
    timeoutMs: 10_000,
  });
});
afterAll(async () => {
  await sessions.releaseAll();
  channel.close();
  fake.close();
});
beforeEach(() => fake.log.clear());

test("100,001 rows: the row budget keeps 100,000, cuts, and interrupts once", async () => {
  const result = await run("FROM range(0, 100001) SELECT id");
  expect(result.rows).toHaveLength(100_000);
  expect(result.cut).toBe("rows");
  expect(interrupts()).toHaveLength(1);
});

test("exactly 100,000 rows is whole and sends no Interrupt", async () => {
  const result = await run("FROM range(0, 100000) SELECT id");
  expect(result.rows).toHaveLength(100_000);
  expect(result.cut).toBeNull();
  expect(interrupts()).toHaveLength(0);
});

test("wide rows: the 16 MiB budget cuts before the row that would pass it, and interrupts once", async () => {
  const result = await run("WIDE ROWS");
  expect(result.cut).toBe("bytes");
  // 100-row batches of 10,008 a row, each kept batch paying its overhead once: 16 whole, then the rest.
  const wholeBatch = 100 * 10_008 + SPARK_BATCH_OVERHEAD_BYTES;
  const left = 16 * MiB - 16 * wholeBatch;
  expect(result.rows.length).toBe(16 * 100 + 1 + Math.floor((left - 10_008 - SPARK_BATCH_OVERHEAD_BYTES) / 10_008));
  expect(interrupts()).toHaveLength(1);
});

test("a batch that cannot fit under 32 MiB after a kept one: the cut stream with the rows before it, one Interrupt", async () => {
  const result = await run("SMALL THEN HUGE");
  expect(result.cut).toBe("stream");
  expect(result.rows).toHaveLength(4);
  expect(interrupts()).toHaveLength(1);
});

test("a first batch that cannot fit is batch-too-large, with no row, after one Interrupt", async () => {
  const error = await run("HUGE FIRST").then(
    () => undefined,
    (failure: unknown) => failure as SparkError,
  );
  expect(error?.category).toBe("batch-too-large");
  expect(error?.message).toMatch(/Arrow batches of about \d+ MiB/);
  expect(interrupts()).toHaveLength(1);
});

test("an inline command answer is under the same row budget", async () => {
  const result = await run("BIG INLINE");
  expect(result.rows).toHaveLength(100_000);
  expect(result.cut).toBe("rows");
  expect(interrupts()).toHaveLength(1);
});

test("a VARIANT text past the decoded budget still left cuts bytes before its row, and interrupts once", async () => {
  // Row 2 costs about 10 MiB by rowCost, so the batch is kept; its VARIANT text of 6 MiB and 2 quotes passes the
  // 6 MiB less a few bytes the budget still has, so the run keeps row 1 only.
  const result = await run("VARIANT PAST BUDGET");
  expect(result.cut).toBe("bytes");
  expect(result.rows).toStrictEqual([{ s: "x".repeat(16), v: `"${"a".repeat(16)}"` }]);
  expect(interrupts()).toHaveLength(1);
});

test("a row whose cost alone passes what a VARIANT text before it left cuts bytes before it, and interrupts once", async () => {
  // Row 1 costs about 6 MiB by rowCost and writes a text of 6 MiB and 2 quotes, so about 4 MiB is left. Row 2 writes
  // no text, and its cost of about 5 MiB fits what keepRows counts (rowCost alone, about 11 MiB in all), so both
  // batches are kept; it passes the decoded budget the text left, so the run keeps row 1 only.
  const result = await run("VARIANT THEN WIDE");
  expect(result.cut).toBe("bytes");
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]?.s).toBe("x".repeat(16));
  // Compared without printing: a failure shows two booleans, not two texts of 6 MiB.
  expect(result.rows[0]?.v === `"${"a".repeat(6 * MiB)}"`).toBe(true);
  expect(interrupts()).toHaveLength(1);
});
