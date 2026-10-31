/**
 * The agent read path's structural closed table, pinned at the library: every agent-mode surface of a KafkaProvider,
 * run over the real adapter and a recorded library, sends Metadata with auto-creation off and ListOffsets at the
 * earliest (-2) and latest (-1) sentinels, and no other library call at all: no Fetch, no timestamp lookup, no group,
 * config, log-directory or coordinator read, and nothing that writes. Each read's full requests are pinned, so a
 * changed flag, sentinel or isolation level fails here. The live run that measured what the broker does with each
 * refused call sent raw is tests/live/kafka-agent-boundary.ts, captured under tests/fixtures/kafka/4.3.1/agent-boundary/
 * and tests/fixtures/redpanda/26.2.2/agent-boundary/.
 */
// oxlint-disable no-await-in-loop -- each surface runs after the one before, so each refusal and each recorded call is its own.
import { describe, expect, test } from "bun:test";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import { createPlatformaticClient } from "@/lib/db/providers/stream/kafka/platformatic-client";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { kafkaFixture, recordedLib } from "../../../helpers/kafka-fixtures";

const CONNECTION = {
  id: "k1",
  name: "kafka",
  type: "kafka",
  host: "localhost",
  createdAt: new Date(0),
} as unknown as DatabaseConnection;

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 };
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };

/** The library calls an agent-mode handle may make, and nothing else. */
const AGENT_CALLS: ReadonlySet<string> = new Set(["admin.metadata", "admin.listTopics", "consumer.listOffsets"]);

const EARLIEST = BigInt(-2);
const LATEST = BigInt(-1);
const READ_UNCOMMITTED = 0;
const READ_COMMITTED = 1;

async function agentHandle(execution: ProviderExecutionContext) {
  const recorded = recordedLib({
    "admin.metadata": (o) => {
      const { topics } = o as { topics: string[] };
      // The capture holds orders; a brokers-only read answers the brokers of the same capture.
      const answer = kafkaFixture<{ topics: Map<string, unknown> }>("metadata-orders");
      return topics.length === 0 ? { ...answer, topics: new Map() } : answer;
    },
    "admin.listTopics": () => ["orders"],
  });
  const provider = new KafkaProvider(CONNECTION, { queryTimeout: 4_000 }, execution, async (options) =>
    createPlatformaticClient(options, recorded.lib),
  );
  await provider.connect();
  // connect()'s own forced broker read is left behind.
  recorded.calls.length = 0;
  return { provider, calls: recorded.calls };
}

describe("each agent read's full requests", () => {
  test("the topic listing: every name, then the page's topics, auto-creation off", async () => {
    const { provider, calls } = await agentHandle(READ_ONLY);
    await provider.queryReadOnly('{"read": "topics"}', BUDGET);
    expect(calls).toEqual([
      ["admin.listTopics", []],
      ["admin.metadata", [{ topics: ["orders"], autocreateTopics: false }]],
    ]);
  });

  test("the broker listing: one forced brokers-only Metadata", async () => {
    const { provider, calls } = await agentHandle(READ_ONLY);
    await provider.queryReadOnly('{"read": "brokers"}', BUDGET);
    expect(calls).toEqual([["admin.metadata", [{ topics: [], autocreateTopics: false, forceUpdate: true }]]]);
  });

  test("one topic's partitions: one Metadata naming the topic, auto-creation off", async () => {
    const { provider, calls } = await agentHandle(READ_ONLY);
    await provider.queryReadOnly('{"read": "partitions", "topic": "orders"}', BUDGET);
    expect(calls).toEqual([["admin.metadata", [{ topics: ["orders"], autocreateTopics: false }]]]);
  });

  test("one topic's offsets: Metadata, then ListOffsets at -2 and at -1, and no timestamp lookup", async () => {
    const { provider, calls } = await agentHandle(READ_ONLY);
    await provider.queryReadOnly('{"read": "offsets", "topic": "orders"}', BUDGET);
    const metadata = ["admin.metadata", [{ topics: ["orders"], autocreateTopics: false }]];
    expect(calls).toEqual([
      metadata,
      metadata,
      ["consumer.listOffsets", [{ topics: ["orders"], timestamp: EARLIEST, isolationLevel: READ_COMMITTED }]],
      metadata,
      ["consumer.listOffsets", [{ topics: ["orders"], timestamp: LATEST, isolationLevel: READ_UNCOMMITTED }]],
    ]);
  });
});

describe("every agent-mode surface stays inside the closed table", () => {
  test.each([
    ["read-only", READ_ONLY],
    ["operations", OPERATIONS],
  ] as const)("on the %s profile", async (_label, execution) => {
    const { provider, calls } = await agentHandle(execution);
    const surfaces: Array<() => Promise<unknown>> = [
      () => provider.countObjects([]),
      () => provider.listObjects([], "topic"),
      () => provider.listObjects([], "broker"),
      () => provider.listObjects([], "consumer_group"),
      () => provider.describeObject(["orders"], "topic"),
      () => provider.describeObjects([], "topic"),
      () => provider.readObjectSource(["orders"], "topic"),
      () => provider.readObjectSource(["1"], "broker"),
      () => provider.getHealth(),
      () => provider.getOverview(),
      () => provider.getStorageStats(),
      () => provider.getTableStats(),
      () => provider.query('{"topic": "orders"}'),
    ];
    if (execution === READ_ONLY) {
      for (const read of ["topics", "brokers", "partitions", "offsets"]) {
        const topic = read === "partitions" || read === "offsets" ? ', "topic": "orders"' : "";
        surfaces.push(() => provider.queryReadOnly(`{"read": "${read}"${topic}}`, BUDGET));
      }
    }
    for (const surface of surfaces) await surface().catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(([name]) => !AGENT_CALLS.has(name))).toEqual([]);
    for (const [name, args] of calls) {
      if (name === "admin.metadata") expect((args[0] as { autocreateTopics: unknown }).autocreateTopics).toBe(false);
      if (name === "consumer.listOffsets") {
        expect([EARLIEST, LATEST]).toContain((args[0] as { timestamp: bigint }).timestamp);
      }
    }
  });

  test("the control: an editor handle's source reads configs, outside the closed table", async () => {
    const { provider, calls } = await agentHandle({});
    await provider.readObjectSource(["orders"], "topic");
    expect(calls.map(([name]) => name)).toContain("admin.describeConfigs");
  });
});
