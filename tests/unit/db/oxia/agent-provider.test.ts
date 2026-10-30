/**
 * The Oxia provider's agent path: `queryReadOnly` only under the agent read-only profile, each read's calls pinned
 * whole, the shard map read afresh for every command, a key count refused past the row budget rather than cut, every
 * failure worded by its category, and the object surface and monitoring reads of a handle opened for either agent
 * profile, which name no key and read no value. An editor handle keeps every read it had.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import {
  OXIA_AGENT_COUNT_SENTENCES,
  OXIA_AGENT_FAILURE_SENTENCES,
} from "@/lib/db/providers/keyvalue/oxia/agent-metadata-read";
import { OXIA_AGENT_SENTENCES } from "@/lib/db/providers/keyvalue/oxia/agent-statement";
import { OxiaError } from "@/lib/db/providers/keyvalue/oxia/errors";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { shardFor } from "@/lib/db/providers/keyvalue/oxia/routing";
import { TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import type { ProviderExecutionContext } from "@/lib/db/types";
import {
  createFakeOxiaClient,
  type FakeOxiaCall,
  type FakeOxiaClient,
  type FakeOxiaRecord,
} from "../../../helpers/oxia-fake-client";
import { oxiaConnection } from "../../../helpers/oxia-connection";

const BUDGET = { maxResultRows: 5, maxResultBytes: 64 * 1024, statementTimeoutMs: 10_000 };
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };
const encode = (text: string) => new TextEncoder().encode(text);

const PROFILE_REQUIRED = "Read-only execution requires a provider opened under the agent read-only profile";
const SURFACE_REFUSED =
  "An Oxia handle opened for agent mode answers only the agent's metadata reads, through queryReadOnly, and lists no key or value: key names count as stored values.";

const SECRET_KEY = "/admin/policies/tenant-secret-marker";
const SECRET_VALUE = "value-secret-marker";

/** Four keys under /admin/, three under /ledgers/, one ephemeral, one under a partition key. */
const RECORDS: readonly FakeOxiaRecord[] = [
  { key: SECRET_KEY, value: encode(SECRET_VALUE) },
  { key: "/admin/policies/b", value: encode("b") },
  { key: "/admin/policies/c", value: encode("c") },
  { key: "/admin/clusters/x", value: encode("x") },
  { key: "/ledgers/1" },
  { key: "/ledgers/2" },
  { key: "/ledgers/3" },
  { key: "/sessions/live", value: encode("e"), sessionId: "41", clientIdentity: "identity-secret-marker" },
  { key: "/pk/1", value: encode("pk"), partitionKey: "tenant-a" },
];

function build(execution: ProviderExecutionContext = READ_ONLY, records: readonly FakeOxiaRecord[] = RECORDS) {
  const fake = createFakeOxiaClient({ order: "hierarchical", records });
  const provider = new OxiaProvider(oxiaConnection(), {}, execution, () => fake);
  return { provider, fake };
}

async function connected(execution: ProviderExecutionContext = READ_ONLY, records?: readonly FakeOxiaRecord[]) {
  const built = build(execution, records);
  await built.provider.connect();
  return built;
}

/** The calls made after `from`, as the pinned requests. */
function callsAfter(fake: FakeOxiaClient, from: number) {
  return fake.calls.slice(from).map((call) => {
    const pinned: { rpc: string; shard?: string; gets?: FakeOxiaCall["gets"]; range?: FakeOxiaCall["range"] } = {
      rpc: call.rpc,
    };
    if (call.shard !== undefined) pinned.shard = call.shard;
    if (call.gets !== undefined) pinned.gets = call.gets;
    if (call.range !== undefined) pinned.range = call.range;
    return pinned;
  });
}

describe("queryReadOnly's profile", () => {
  test("an editor handle, and an operations handle, are refused before anything is sent", async () => {
    for (const execution of [{}, OPERATIONS]) {
      // oxlint-disable-next-line no-await-in-loop -- each handle is opened and asked on its own.
      const { provider, fake } = await connected(execution);
      const before = fake.calls.length;
      // oxlint-disable-next-line no-await-in-loop -- each handle is opened and asked on its own.
      await expect(provider.queryReadOnly("shards", BUDGET)).rejects.toThrow(
        new RefusedBeforeSendError(PROFILE_REQUIRED, "oxia", "shards"),
      );
      expect(fake.calls.length).toBe(before);
    }
  });

  test("a disconnected provider is refused, a budget out of range is refused, and no estimate is composed", async () => {
    const { provider } = build();
    await expect(provider.queryReadOnly("shards", BUDGET)).rejects.toThrow();
    await provider.connect();
    await expect(provider.queryReadOnly("shards", { ...BUDGET, maxResultRows: 0 })).rejects.toThrow();
    await expect(provider.queryReadOnly("shards", BUDGET, "estimate-plan")).rejects.toThrow(
      "Oxia composes no estimating plan for the agent",
    );
  });

  test("a command outside the table is refused in the agent's words before anything is sent", async () => {
    const { provider, fake } = await connected();
    const before = fake.calls.length;
    await expect(provider.queryReadOnly("range-scan --prefix /admin/", BUDGET)).rejects.toThrow(
      new RefusedBeforeSendError(OXIA_AGENT_SENTENCES.metadataOnly, "oxia", "range-scan --prefix /admin/"),
    );
    await expect(provider.queryReadOnly("get -p tenant-a /pk/1", BUDGET)).rejects.toThrow(OXIA_AGENT_SENTENCES.flags);
    expect(fake.calls.length).toBe(before);
  });
});

describe("the reads", () => {
  test("shards reads the shard map afresh, every time, and answers its counts", async () => {
    const { provider, fake } = await connected();
    const from = fake.calls.length;
    const first = await provider.queryReadOnly("shards", BUDGET);
    await provider.queryReadOnly("shards", BUDGET);
    expect(first.rows).toEqual([{ namespace: "default", shards: 3, leaders: 1 }]);
    expect(callsAfter(fake, from)).toEqual([{ rpc: "GetShardAssignments" }, { rpc: "GetShardAssignments" }]);
  });

  test("get sends one EQUAL get with its value on the key's own shard, no index or partition key", async () => {
    const { provider, fake } = await connected();
    const from = fake.calls.length;
    const result = await provider.queryReadOnly(`get ${SECRET_KEY}`, BUDGET);
    const calls = callsAfter(fake, from);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ rpc: "GetShardAssignments" });
    expect(calls[1]).toMatchObject({
      rpc: "Read",
      gets: [{ key: SECRET_KEY, includeValue: true, comparison: "EQUAL" }],
    });
    expect(result.rows[0]).toMatchObject({ exists: true, value_bytes: SECRET_VALUE.length, ephemeral: false });
    const text = JSON.stringify(result);
    expect(text).not.toContain("tenant-secret-marker");
    expect(text).not.toContain(SECRET_VALUE);
  });

  test("an ephemeral key is flagged, never its session id or client identity", async () => {
    const { provider } = await connected();
    const result = await provider.queryReadOnly("get /sessions/live", BUDGET);
    expect(result.rows[0]).toMatchObject({ exists: true, ephemeral: true });
    expect(JSON.stringify(result)).not.toMatch(/identity-secret-marker|"41"/);
  });

  test("a key stored under a partition key is found by asking every shard, with no value, then reading it", async () => {
    const { provider, fake } = await connected();
    const from = fake.calls.length;
    const result = await provider.queryReadOnly("get /pk/1", BUDGET);
    expect(result.rows[0]).toMatchObject({ exists: true, value_bytes: 2 });
    for (const call of callsAfter(fake, from).filter((call) => call.rpc === "Read")) {
      for (const get of call.gets ?? []) {
        expect(get).toEqual({ key: "/pk/1", includeValue: get.includeValue, comparison: "EQUAL" });
      }
    }
  });

  test("a missing key answers that it does not exist", async () => {
    const { provider } = await connected();
    const result = await provider.queryReadOnly("get /admin/none", BUDGET);
    expect(result.rows[0]?.exists).toBe(false);
  });

  test("a key two shards hold under different partition keys is refused without its name", async () => {
    const shards = createFakeOxiaClient({ order: "hierarchical", records: [] });
    const snapshot = await shards.getSnapshot({ signal: new AbortController().signal, deadline: Date.now() + 1_000 });
    const home = shardFor(snapshot, "/twice").id;
    // Two partition keys whose shards differ from each other and from the key's own.
    const partitions = new Map<string, string>();
    for (let index = 0; partitions.size < 2; index += 1) {
      const id = shardFor(snapshot, "/twice", `p-${index}`).id;
      if (id !== home && !partitions.has(id)) partitions.set(id, `p-${index}`);
    }
    const { provider } = await connected(
      READ_ONLY,
      [...partitions.values()].map((partitionKey) => ({ key: "/twice", partitionKey })),
    );
    const error = await provider.queryReadOnly("get /twice", BUDGET).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(OXIA_AGENT_COUNT_SENTENCES.manyHolders(2));
    expect((error as Error).message).not.toContain("/twice");
  });

  test("list counts the keys of the range it names, sending only List calls, and answers no key", async () => {
    const { provider, fake } = await connected();
    const from = fake.calls.length;
    const result = await provider.queryReadOnly("list --prefix /admin/policies/", BUDGET);
    expect(result.rows).toEqual([{ keys: 3 }]);
    expect(JSON.stringify(result)).not.toContain("tenant-secret-marker");
    const rpcs = new Set(callsAfter(fake, from).map((call) => call.rpc));
    expect([...rpcs].every((rpc) => ["GetShardAssignments", "List", "Read"].includes(rpc))).toBe(true);
    for (const call of callsAfter(fake, from)) {
      if (call.range !== undefined) expect(call.range.secondaryIndexName).toBeUndefined();
      for (const get of call.gets ?? []) expect(get.includeValue).toBe(false);
    }
    expect((await provider.queryReadOnly("list -s /ledgers/ -e /ledgers//", BUDGET)).rows).toEqual([{ keys: 3 }]);
  });

  test("a count of exactly the row budget is answered; one past it is refused, never cut", async () => {
    const { provider } = await connected();
    expect((await provider.queryReadOnly("list --prefix /admin/", { ...BUDGET, maxResultRows: 4 })).rows).toEqual([
      { keys: 4 },
    ]);
    await expect(provider.queryReadOnly("list --prefix /admin/", { ...BUDGET, maxResultRows: 3 })).rejects.toThrow(
      OXIA_AGENT_COUNT_SENTENCES.overRows(3),
    );
    await expect(provider.queryReadOnly("list", BUDGET)).rejects.toThrow(OXIA_AGENT_COUNT_SENTENCES.overRows(5));
  });

  test("a count Studio could not read to the range's end is refused", async () => {
    const long = "k".repeat(60_000);
    const records = Array.from({ length: 150 }, (_, index) => ({ key: `/long/${index}-${long}` }));
    const { provider } = await connected(READ_ONLY, records);
    await expect(provider.queryReadOnly("list --prefix /long/", { ...BUDGET, maxResultRows: 500 })).rejects.toThrow(
      OXIA_AGENT_COUNT_SENTENCES.overBytes,
    );
  });
});

describe("the failures", () => {
  test("an Oxia failure is worded by its category; the server's words never reach the agent", async () => {
    const { provider, fake } = await connected();
    fake.failNext({ rpc: "Read" }, new OxiaError("namespace-not-found", { rpc: "Read" }));
    await expect(provider.queryReadOnly(`get ${SECRET_KEY}`, BUDGET)).rejects.toThrow(
      OXIA_AGENT_FAILURE_SENTENCES.refused("namespace-not-found"),
    );
    fake.failNext({ rpc: "GetShardAssignments" }, new OxiaError("unauthenticated", { rpc: "GetShardAssignments" }));
    await expect(provider.queryReadOnly("shards", BUDGET)).rejects.toThrow(
      OXIA_AGENT_FAILURE_SENTENCES.refused("unauthenticated"),
    );
  });

  test("a deadline is the time budget's refusal", async () => {
    const { provider, fake } = await connected();
    fake.failNext({ rpc: "GetShardAssignments" }, new OxiaError("deadline-exceeded"));
    await expect(provider.queryReadOnly("shards", BUDGET)).rejects.toThrow(
      `${TIME_BUDGET_PREFIX}: no answer within 10000ms`,
    );
  });

  test("a defect passes on as it is", async () => {
    const { provider, fake } = await connected();
    fake.failNext({ rpc: "GetShardAssignments" }, new TypeError("a defect"));
    await expect(provider.queryReadOnly("shards", BUDGET)).rejects.toThrow("a defect");
  });
});

describe("a handle opened for an agent-mode profile", () => {
  test.each([
    ["read-only", READ_ONLY],
    ["operations", OPERATIONS],
  ] as const)(
    "%s: the editor's command path, the Keys panel and a key's listing and source are refused",
    async (_n, execution) => {
      const { provider, fake } = await connected(execution);
      const before = fake.calls.length;
      await expect(provider.query(`get ${SECRET_KEY}`)).rejects.toThrow(SURFACE_REFUSED);
      await expect(provider.scanKeysPage({ cursor: "0", count: 10 })).rejects.toThrow(SURFACE_REFUSED);
      await expect(provider.listObjects([], "key")).rejects.toThrow(SURFACE_REFUSED);
      await expect(provider.readObjectSource([SECRET_KEY], "key")).rejects.toThrow(SURFACE_REFUSED);
      expect(fake.calls.length).toBe(before);
    },
  );

  test.each([
    ["read-only", READ_ONLY],
    ["operations", OPERATIONS],
  ] as const)(
    "%s: the shard listing, the counts and every Operate reading name no key or value",
    async (_n, execution) => {
      const { provider } = await connected(execution);
      const answers = [
        await provider.countObjects([]),
        await provider.listObjects([], "shard"),
        await provider.readObjectSource(["0"], "shard"),
        await provider.getHealth(),
        await provider.getOverview(),
        await provider.getTableStats(),
        await provider.getIndexStats(),
        await provider.getStorageStats(),
        await provider.getSlowQueries(),
        await provider.getActiveSessions(),
        await provider.getPerformanceMetrics(),
      ];
      const text = JSON.stringify(answers);
      for (const secret of ["tenant-secret-marker", SECRET_VALUE, "identity-secret-marker", "/ledgers/", "/pk/1"]) {
        expect({ secret, leaked: text.includes(secret) }).toEqual({ secret, leaked: false });
      }
    },
  );

  test("a disconnected agent handle refuses its surfaces as not connected, before anything else", async () => {
    const { provider } = build(READ_ONLY);
    await expect(provider.scanKeysPage({ cursor: "0", count: 10 })).rejects.not.toThrow(SURFACE_REFUSED);
    await expect(provider.listObjects([], "key")).rejects.not.toThrow(SURFACE_REFUSED);
    await expect(provider.readObjectSource([SECRET_KEY], "key")).rejects.not.toThrow(SURFACE_REFUSED);
  });
});

describe("an editor handle", () => {
  test("keeps the command path, the Keys panel and a key's source", async () => {
    const { provider } = await connected({});
    expect((await provider.query(`get ${SECRET_KEY}`)).rowCount).toBe(1);
    expect((await provider.scanKeysPage({ cursor: "0", count: 10 })).keys.length).toBeGreaterThan(0);
    const source = await provider.readObjectSource([SECRET_KEY], "key");
    expect(JSON.stringify(source)).toContain(SECRET_VALUE);
  });
});
