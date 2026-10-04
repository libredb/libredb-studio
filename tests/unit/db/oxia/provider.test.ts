/**
 * What `index.ts` itself owns (contract section 17, decision D14), over the shared fake through the client factory:
 * the connect sequence, the brief snapshot cache and its invalidation, the deadline re-read of SB1-9.4, the order
 * verdict's lifetime (SB1-7.2), the server-side re-parse, the run registry (SB2-5.3), the engine limiter (SB1-9.1),
 * the delegation of every surface, and the declared empty answers.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { ConnectionError, DatabaseConfigError, QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import { DEFAULT_QUERY_TIMEOUT } from "@/lib/db/types";
import { DuplicateRunError } from "@/lib/db/utils/bounded-limiter";
import type { OxiaCallOptions, OxiaClient, OxiaSnapshot } from "@/lib/db/providers/keyvalue/oxia/client";
import { writeCommandSentence } from "@/lib/db/providers/keyvalue/oxia/commands";
import {
  buildOxiaConnectionOptions,
  type OxiaConnectionOptions,
  oxiaEndpointText,
  oxiaErrorConnection,
} from "@/lib/db/providers/keyvalue/oxia/connection-options";
import {
  OXIA_HEALTH_DEADLINE_MS,
  OXIA_SNAPSHOT_TTL_MS,
  OXIA_SURFACE_DEADLINE_MS,
} from "@/lib/db/providers/keyvalue/oxia/constants";
import {
  deadlineSeconds,
  OXIA_HEALTH_NO_SHARD_MAP,
  OxiaError,
  silentAssignmentsSentence,
  toProviderError,
} from "@/lib/db/providers/keyvalue/oxia/errors";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { OXIA_LABELS } from "@/lib/db/providers/keyvalue/oxia/labels";
import { OXIA_RECORD_FIELDS } from "@/lib/db/providers/keyvalue/oxia/results";
import { shardFor } from "@/lib/db/providers/keyvalue/oxia/routing";
import type { DatabaseConnection, ProviderOptions } from "@/lib/db/types";
import { createFakeOxiaClient, type FakeOxiaClient, type FakeOxiaRecord } from "../../../helpers/oxia-fake-client";
import { oxiaConnection } from "../../../helpers/oxia-connection";

afterEach(() => {
  setSystemTime();
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const call = (): OxiaCallOptions => ({ signal: new AbortController().signal, deadline: Date.now() + 10_000 });

/** The options and the error facts a default test connection resolves to, so a test words a failure as index.ts does. */
function resolved(connection: DatabaseConnection = oxiaConnection()): OxiaConnectionOptions {
  return buildOxiaConnectionOptions(connection, { executionReadOnly: false, queryTimeout: DEFAULT_QUERY_TIMEOUT });
}

/** The sentence `error` words to; `timeoutMs` is the deadline the failed call ran under, the query timeout by default. */
function sentence(error: unknown, operation: string, timeoutMs?: number): string {
  const connection = { ...oxiaErrorConnection(resolved()), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  return toProviderError(error, { operation, connection }).message;
}

function fakeOf(records: readonly FakeOxiaRecord[] = [], shards?: number): FakeOxiaClient {
  return createFakeOxiaClient({ order: "hierarchical", records, ...(shards === undefined ? {} : { shards }) });
}

/** A provider over `clients`, handed out one per connect, with every factory call's options kept. */
function providerOver(
  clients: OxiaClient | readonly OxiaClient[],
  connection: DatabaseConnection = oxiaConnection(),
  options: ProviderOptions = {},
) {
  const queue = Array.isArray(clients) ? [...clients] : [clients as OxiaClient];
  const asked: OxiaConnectionOptions[] = [];
  const provider = new OxiaProvider(connection, options, {}, (resolvedOptions) => {
    asked.push(resolvedOptions);
    return queue.length > 1 ? (queue.shift() as OxiaClient) : queue[0];
  });
  return { provider, asked };
}

/** The fake behind a client that keeps every call's options, with `beforeSnapshot` run as each map read begins. */
function spied(fake: FakeOxiaClient, beforeSnapshot: () => void = () => {}) {
  const options: OxiaCallOptions[] = [];
  const client: OxiaClient = {
    getSnapshot: (call) => {
      options.push(call);
      beforeSnapshot();
      return fake.getSnapshot(call);
    },
    read: (shard, gets, call) => {
      options.push(call);
      return fake.read(shard, gets, call);
    },
    list: (shard, range, call) => {
      options.push(call);
      return fake.list(shard, range, call);
    },
    rangeScan: (shard, range, call) => {
      options.push(call);
      return fake.rangeScan(shard, range, call);
    },
    health: (call) => {
      options.push(call);
      return fake.health(call);
    },
    close: () => fake.close(),
  };
  return { client, options };
}

const snapshotReads = (fake: FakeOxiaClient): number =>
  fake.calls.filter((entry) => entry.rpc === "GetShardAssignments").length;

/** Order probes: rounds of the probe's CEILING get on "/", one Read per shard each. */
const probeRounds = (fake: FakeOxiaClient, shards = 3): number =>
  fake.calls.filter(
    (entry) => entry.rpc === "Read" && entry.gets?.some((get) => get.key === "/" && get.comparison === "CEILING"),
  ).length / shards;

describe("connect (SB1-5.1)", () => {
  test("one snapshot read through the factory's client, and no order probe", async () => {
    const fake = fakeOf([{ key: "/a" }]);
    const { provider, asked } = providerOver(fake);
    await provider.connect();

    expect(provider.isConnected()).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].namespace).toBe("default");
    expect(fake.calls.map((entry) => entry.rpc)).toEqual(["GetShardAssignments"]);
  });

  test("a field the connection rules refuse is refused before any client is built", async () => {
    const { provider, asked } = providerOver(fakeOf(), oxiaConnection({ user: "someone" }));
    await expect(provider.connect()).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(asked).toEqual([]);
    expect(provider.isConnected()).toBe(false);
  });

  test("a connect that fails closes the client and words the failure as a connection test", async () => {
    const fake = fakeOf();
    const failure = new OxiaError("namespace-not-found", { rpc: "GetShardAssignments" });
    fake.failNext({ rpc: "GetShardAssignments" }, failure);
    const { provider } = providerOver(fake);

    const error = await provider.connect().catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(sentence(failure, "connection test"));
    expect(fake.closed).toBe(true);
    expect(provider.isConnected()).toBe(false);
  });

  test("connecting again closes the first client, and a disconnect closes the last", async () => {
    const first = fakeOf();
    const second = fakeOf();
    const { provider } = providerOver([first, second]);
    await provider.connect();
    await provider.connect();
    expect([first.closed, second.closed]).toEqual([true, false]);
    await provider.disconnect();
    expect(second.closed).toBe(true);
    await expect(provider.countObjects([])).rejects.toThrow("Provider is not connected. Call connect() first.");
    // A second disconnect has nothing to close.
    await provider.disconnect();
  });
});

describe("the brief snapshot cache (SB1-5.3)", () => {
  test("calls within 5 s share the connect's snapshot; the first after it reads a new one", async () => {
    const fake = fakeOf([{ key: "/a" }]);
    const { provider } = providerOver(fake);
    await provider.connect();
    await provider.countObjects([]);
    await provider.listObjects([], "shard");
    expect(snapshotReads(fake)).toBe(1);

    setSystemTime(new Date(Date.now() + OXIA_SNAPSHOT_TTL_MS + 1));
    await provider.countObjects([]);
    expect(snapshotReads(fake)).toBe(2);
  });

  test.each(["not-leader", "leader-changing", "shard-not-found"] as const)(
    "a %s failure drops the cache, so the next call reads the map afresh",
    async (category) => {
      const fake = fakeOf([{ key: "/a", value: utf8("1") }]);
      const { provider } = providerOver(fake);
      await provider.connect();
      const snapshot = await fake.getSnapshot(call());
      const shard = shardFor(snapshot, "/a");
      const failure = new OxiaError(category, { shardId: shard.id, leader: shard.leader.address, rpc: "Read" });
      fake.failNext({ rpc: "Read" }, failure);
      const reads = snapshotReads(fake);

      const error = await provider.query("get /a").catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(sentence(failure, "get"));
      await provider.query("get /a");
      expect(snapshotReads(fake)).toBe(reads + 1);
    },
  );
});

describe("a deadline on a shard call (SB1-9.4)", () => {
  /** A provider whose get on /a meets a deadline, with the map the re-read answers set by `moved`. */
  async function deadlineOnGet(moved: (snapshot: OxiaSnapshot) => OxiaSnapshot | undefined) {
    const fake = fakeOf([{ key: "/a", value: utf8("1") }]);
    const { provider } = providerOver(fake);
    await provider.connect();
    const snapshot = await fake.getSnapshot(call());
    const shard = shardFor(snapshot, "/a");
    const deadline = new OxiaError("deadline-exceeded", {
      shardId: shard.id,
      leader: shard.leader.address,
      rpc: "Read",
    });
    const next = moved(snapshot);
    if (next !== undefined) fake.setSnapshot(next);
    fake.failNext({ rpc: "Read" }, deadline);
    const reads = snapshotReads(fake);
    const error = await provider.query("get /a").catch((caught: unknown) => caught);
    return { error: error as Error, deadline, shard, rereads: snapshotReads(fake) - reads };
  }

  test("the map unchanged: the deadline's own sentence, after one re-read and no retry", async () => {
    const { error, deadline, rereads } = await deadlineOnGet(() => undefined);
    expect(error.message).toBe(sentence(deadline, "get"));
    expect(rereads).toBe(1);
  });

  test("the shard gone from the map: the shard-not-found sentence", async () => {
    const { error, shard } = await deadlineOnGet((snapshot) => ({
      ...snapshot,
      shards: snapshot.shards.filter((candidate) => candidate.id !== shardFor(snapshot, "/a").id),
    }));
    expect(error.message).toBe(sentence(new OxiaError("shard-not-found", { shardId: shard.id, rpc: "Read" }), "get"));
  });

  test("the shard's leader moved: the leader-changing sentence", async () => {
    const { error, shard } = await deadlineOnGet((snapshot) => ({
      ...snapshot,
      shards: snapshot.shards.map((candidate) =>
        candidate.id === shardFor(snapshot, "/a").id
          ? { ...candidate, leader: { host: "other", port: 6648, address: "other:6648", bootstrap: false } }
          : candidate,
      ),
    }));
    expect(error.message).toBe(sentence(new OxiaError("leader-changing", { shardId: shard.id, rpc: "Read" }), "get"));
  });

  test("a re-read that fails too leaves the deadline as what happened", async () => {
    const fake = fakeOf([{ key: "/a", value: utf8("1") }]);
    const { provider } = providerOver(fake);
    await provider.connect();
    const shard = shardFor(await fake.getSnapshot(call()), "/a");
    const deadline = new OxiaError("deadline-exceeded", {
      shardId: shard.id,
      leader: shard.leader.address,
      rpc: "Read",
    });
    fake.failNext({ rpc: "Read" }, deadline);
    fake.failNext({ rpc: "GetShardAssignments" }, new OxiaError("unknown", { rpc: "GetShardAssignments" }));
    const error = await provider.query("get /a").catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(sentence(deadline, "get"));
  });

  test("the re-read runs under the run's signal: a cancel during it leaves the deadline, even when the shard is gone", async () => {
    const fake = fakeOf([{ key: "/a", value: utf8("1") }]);
    let cancelOnMapRead = false;
    const { client } = spied(fake, () => {
      // Runs only once the provider below exists: the connect read leaves it unarmed.
      if (cancelOnMapRead) void provider.cancelQuery("r");
    });
    const { provider } = providerOver(client);
    await provider.connect();
    const snapshot = await fake.getSnapshot(call());
    const shard = shardFor(snapshot, "/a");
    const deadline = new OxiaError("deadline-exceeded", {
      shardId: shard.id,
      leader: shard.leader.address,
      rpc: "Read",
    });
    fake.setSnapshot({ ...snapshot, shards: snapshot.shards.filter((candidate) => candidate.id !== shard.id) });
    fake.failNext({ rpc: "Read" }, deadline);
    cancelOnMapRead = true;

    const error = await provider.query("get /a", [], "r").catch((caught: unknown) => caught);
    // A re-read under the session's signal alone would see the shard gone and say shard-not-found.
    expect((error as Error).message).toBe(sentence(deadline, "get"));
  });
});

describe("each call's deadline and the session's lifetime (SB1-5.1, ruling R4)", () => {
  const within = (deadline: number, before: number, after: number, ms: number): boolean =>
    deadline >= before + ms && deadline <= after + ms;

  test.each([
    ["the default query timeout, capped at the surface deadline", undefined, OXIA_SURFACE_DEADLINE_MS],
    ["a query timeout below the surface deadline", 2_000, 2_000],
  ] as const)("connect and a Keys panel page carry %s", async (_name, queryTimeout, expectedMs) => {
    const fake = fakeOf([{ key: "/a/1" }]);
    const { client, options } = spied(fake);
    const { provider } = providerOver(client, oxiaConnection(), queryTimeout === undefined ? {} : { queryTimeout });
    const before = Date.now();
    await provider.connect();
    await provider.scanKeysPage({ cursor: "0", count: 500 });
    const after = Date.now();
    expect(options.length).toBeGreaterThan(1);
    // The connect read carries the deadline itself; a walk may shorten a call's (folder discovery), never lengthen it.
    expect(within(options[0].deadline, before, after, expectedMs)).toBe(true);
    for (const option of options) expect(option.deadline).toBeLessThanOrEqual(after + expectedMs);
    const latest = Math.max(...options.slice(1).map((option) => option.deadline));
    expect(within(latest, before, after, expectedMs)).toBe(true);
  });

  test("a surface read's deadline sentence names the surface deadline, not the query timeout", async () => {
    const fake = fakeOf();
    const { provider } = providerOver(fake);
    await provider.connect();
    setSystemTime(new Date(Date.now() + OXIA_SNAPSHOT_TTL_MS + 1));
    const failure = new OxiaError("deadline-exceeded", { rpc: "GetShardAssignments" });
    fake.failNext({ rpc: "GetShardAssignments" }, failure);
    const error = await provider.countObjects([]).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(sentence(failure, "object read", OXIA_SURFACE_DEADLINE_MS));
    expect((error as Error).message).not.toBe(sentence(failure, "object read"));
  });

  test("health's deadline is capped by a query timeout below it", async () => {
    const fake = fakeOf();
    const { client, options } = spied(fake);
    const { provider } = providerOver(client, oxiaConnection(), { queryTimeout: 2_000 });
    await provider.connect();
    const before = Date.now();
    await provider.getHealth();
    const after = Date.now();
    const healthCalls = options.slice(1);
    expect(healthCalls).toHaveLength(2);
    for (const option of healthCalls) expect(within(option.deadline, before, after, 2_000)).toBe(true);

    const failure = new OxiaError("deadline-exceeded", { rpc: "Health/Check" });
    fake.failNext({ rpc: "Health/Check" }, failure);
    const error = await provider.getHealth().catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(sentence(failure, "health check", 2_000));
  });

  test("a disconnect aborts the signal of a call still in flight", async () => {
    const fake = fakeOf([{ key: "/a", value: utf8("1") }]);
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fake.onCall(async (entry) => {
      if (entry.rpc === "Read") await gate;
    });
    const { client, options } = spied(fake);
    const { provider } = providerOver(client);
    await provider.connect();
    const running = provider.query("get /a").catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const readCall = options.at(-1) as OxiaCallOptions;
    expect(readCall.signal.aborted).toBe(false);

    await provider.disconnect();
    expect(readCall.signal.aborted).toBe(true);
    open();
    expect(await running).toBeInstanceOf(Error);
  });
});

describe("the order verdict's lifetime (SB1-7.2)", () => {
  test("a decided verdict is probed once for the provider's life, and again after a reconnect", async () => {
    const fake = fakeOf([{ key: "/a/b", value: utf8("1") }]);
    // A reconnect builds a new client: the first was closed at disconnect, and a closed client refuses every call.
    const reconnected = fakeOf([{ key: "/a/b", value: utf8("1") }]);
    const { provider } = providerOver([fake, reconnected]);
    await provider.connect();
    await provider.query("get -t floor /z");
    await provider.query("get -t floor /y");
    expect(probeRounds(fake)).toBe(1);

    await provider.disconnect();
    await provider.connect();
    await provider.query("get -t floor /z");
    expect([probeRounds(fake), probeRounds(reconnected)]).toEqual([1, 1]);
  });

  test("an empty verdict is probed again on every walk, until a key decides it", async () => {
    const fake = fakeOf();
    const { provider } = providerOver(fake);
    await provider.connect();
    await provider.query("list");
    await provider.query("list");
    expect(probeRounds(fake)).toBe(2);

    fake.put({ key: "/a/b", value: utf8("1") });
    await provider.query("list");
    await provider.query("list");
    expect(probeRounds(fake)).toBe(3);
  });
});

describe("query (SB2-5.2, SB2-5.3)", () => {
  test("bound parameters are refused before anything is sent", async () => {
    const fake = fakeOf();
    const { provider } = providerOver(fake);
    await provider.connect();
    const refusal = provider.query("get /a", ["x"]);
    await expect(refusal).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(refusal).rejects.toThrow("Oxia commands take no parameters: write the values in the command.");
    // An empty list binds nothing and is not a refusal.
    await provider.query("get /a", []);
    expect(fake.calls.filter((entry) => entry.rpc === "Read")).toHaveLength(1);
  });

  test("the server re-parses with the connection's context: -a and -n naming another connection are refused", async () => {
    const fake = fakeOf();
    const { provider } = providerOver(fake);
    await provider.connect();
    const endpoint = oxiaEndpointText(resolved());

    await expect(provider.query("-a elsewhere:1 get /a")).rejects.toThrow(
      `-a names another address than this connection's ${endpoint}: Host and Port on the connection decide where Studio connects.`,
    );
    await expect(provider.query("-n other get /a")).rejects.toThrow(
      "-n names another namespace than this connection's `default`: Namespace is set on the connection, and empty means default.",
    );
    expect(fake.calls.map((entry) => entry.rpc)).toEqual(["GetShardAssignments"]);
  });

  test("a matching -a runs, with its notice", async () => {
    const { provider } = providerOver(fakeOf([{ key: "/a", value: utf8("1") }]));
    await provider.connect();
    const result = await provider.query(`-a ${oxiaEndpointText(resolved())} get /a`);
    expect(result.warnings?.map((warning) => warning.message)).toContain(
      "-a names this connection's own endpoint, so it changes nothing: Host and Port on the connection decide where Studio connects.",
    );
  });

  test("a parser refusal is a QueryError with the parser's sentence", async () => {
    const { provider } = providerOver(fakeOf());
    await provider.connect();
    const refusal = provider.query("put k v");
    await expect(refusal).rejects.toBeInstanceOf(QueryError);
    await expect(refusal).rejects.toThrow(writeCommandSentence("put", false));
  });

  test("a read answers the grid's result", async () => {
    const { provider } = providerOver(fakeOf([{ key: "/a", value: utf8('{"x":1}') }]));
    await provider.connect();
    const result = await provider.query("get /a");
    expect(result.fields).toEqual([...OXIA_RECORD_FIELDS]);
    expect(result.rows[0]).toMatchObject({ key: "/a", value: '{"x":1}', value_encoding: "json" });
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });
});

describe("the run registry and the limiter (SB2-5.3, SB1-9.1)", () => {
  /** A fake whose Reads wait at a gate the test opens. */
  function gated(records: readonly FakeOxiaRecord[]) {
    const fake = fakeOf(records);
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fake.onCall(async (entry) => {
      if (entry.rpc === "Read") await gate;
    });
    return { fake, open: () => open() };
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  test("a repeated queryId is refused while it runs; a cancel reaches a run waiting for a permit; an unknown id answers false", async () => {
    const { fake, open } = gated([{ key: "/a", value: utf8("1") }]);
    const { provider } = providerOver(fake);
    await provider.connect();
    // Four runs hold the provider's four permits.
    const holding = ["q1", "q2", "q3", "q4"].map((id) => provider.query("get /a", [], id));
    await settle();
    const waiting = provider.query("get /a", [], "x");
    await settle();
    const readsBefore = fake.calls.filter((entry) => entry.rpc === "Read").length;

    await expect(provider.query("get /a", [], "q1")).rejects.toBeInstanceOf(DuplicateRunError);
    expect(await provider.cancelQuery("x")).toBe(true);
    await expect(waiting).rejects.toBeInstanceOf(QueryCancelledError);
    expect(await provider.cancelQuery("nobody")).toBe(false);
    // The cancelled run sent nothing.
    expect(fake.calls.filter((entry) => entry.rpc === "Read")).toHaveLength(readsBefore);

    open();
    await Promise.all(holding);
    // Its id names no run once it ended.
    expect(await provider.cancelQuery("q1")).toBe(false);
  });

  test("a run that waits past its query timeout fails with the deadline sentence, and sends nothing", async () => {
    const { fake, open } = gated([{ key: "/a", value: utf8("1") }]);
    const { provider } = providerOver(fake, oxiaConnection(), { queryTimeout: 200 });
    await provider.connect();
    const holding = ["h1", "h2", "h3", "h4"].map((id) => provider.query("get /a", [], id).catch(() => undefined));
    await settle();
    const readsBefore = fake.calls.filter((entry) => entry.rpc === "Read").length;
    const rereadsBefore = snapshotReads(fake);

    const error = await provider.query("get /a", [], "late").catch((caught: unknown) => caught);
    // The permit wait's TimeoutError is the deadline, on no shard: worded, never the raw DOMException.
    expect(error).not.toBeInstanceOf(DOMException);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe(sentence(new OxiaError("deadline-exceeded"), "get", 200));
    // No shard, so no re-read of the map.
    expect(snapshotReads(fake)).toBe(rereadsBefore);
    expect(fake.calls.filter((entry) => entry.rpc === "Read")).toHaveLength(readsBefore);
    open();
    await Promise.all(holding);
  });

  test("a cancel of a run waiting for a permit answers the cancelled sentence, not the deadline", async () => {
    const { fake, open } = gated([{ key: "/a", value: utf8("1") }]);
    const { provider } = providerOver(fake, oxiaConnection(), { queryTimeout: 10_000 });
    await provider.connect();
    const holding = ["c1", "c2", "c3", "c4"].map((id) => provider.query("get /a", [], id).catch(() => undefined));
    await settle();
    const readsBefore = fake.calls.filter((entry) => entry.rpc === "Read").length;
    const waiting = provider.query("get /a", [], "stop").catch((caught: unknown) => caught);
    await settle();

    expect(await provider.cancelQuery("stop")).toBe(true);
    const error = await waiting;
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect((error as Error).message).toBe("The query was cancelled.");
    expect(fake.calls.filter((entry) => entry.rpc === "Read")).toHaveLength(readsBefore);
    open();
    await Promise.all(holding);
  });

  test("a Read held past the query timeout meets its deadline: one re-read, then the deadline sentence", async () => {
    const fake = fakeOf([{ key: "/a", value: utf8("1") }]);
    // Held past the 200 ms deadline, with no failNext: the fake's own deadline answers (T15 rule 10).
    fake.onCall(async (entry) => {
      if (entry.rpc === "Read") await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const { provider } = providerOver(fake, oxiaConnection(), { queryTimeout: 200 });
    await provider.connect();
    const shard = shardFor(await fake.getSnapshot(call()), "/a");
    const reads = snapshotReads(fake);

    const error = await provider.query("get /a", [], "held").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe(
      sentence(
        new OxiaError("deadline-exceeded", { shardId: shard.id, leader: shard.leader.address, rpc: "Read" }),
        "get",
        200,
      ),
    );
    expect((error as Error).message).not.toContain("cancelled");
    // SB1-9.4's one re-read ran (the getSnapshot above is the test's own read).
    expect(snapshotReads(fake) - reads).toBe(1);
  });

  // Five walks over 1,024 shards: seconds under a full parallel coverage run, so it carries its own timeout.
  test("on a 1,024-shard map a provider has at most 4 calls in flight, and five providers at most 16", async () => {
    let inFlight = 0;
    let peak = 0;
    /** The fake, with every Read counted while it is in flight across every provider. */
    const counted = (fake: FakeOxiaClient): OxiaClient => ({
      getSnapshot: (options) => fake.getSnapshot(options),
      read: async (shard, gets, options) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          // Held for a turn of the event loop, so the calls of every provider are in flight together.
          await new Promise((resolve) => setTimeout(resolve, 0));
          return await fake.read(shard, gets, options);
        } finally {
          inFlight -= 1;
        }
      },
      list: (shard, range, options) => fake.list(shard, range, options),
      rangeScan: (shard, range, options) => fake.rangeScan(shard, range, options),
      health: (options) => fake.health(options),
      close: () => fake.close(),
    });
    const fakes = Array.from({ length: 5 }, () => fakeOf([{ key: "/a/b", value: utf8("1") }], 1_024));
    const providers = fakes.map((fake) => providerOver(counted(fake)).provider);
    await Promise.all(providers.map((provider) => provider.connect()));

    await Promise.all(providers.map((provider) => provider.query("get -t floor /z")));

    for (const fake of fakes) expect(fake.peakInFlight).toBeLessThanOrEqual(4);
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(4);
  }, 30_000);
});

describe("the surfaces, delegated", () => {
  test("no container level: listContainers is empty, and a container is refused", async () => {
    const { provider } = providerOver(fakeOf());
    await provider.connect();
    expect(await provider.listContainers()).toEqual([]);
    const refusal = 'An Oxia connection has no container level; received ["x"]';
    await expect(provider.countObjects(["x"])).rejects.toThrow(refusal);
    await expect(provider.listObjects(["x"], "shard")).rejects.toThrow(refusal);
    await expect(provider.describeObjects(["x"], "shard")).rejects.toThrow(refusal);
  });

  test("count, list, describe and Source answer through objects.ts", async () => {
    const { provider } = providerOver(fakeOf([{ key: "/a", value: utf8("x") }]));
    await provider.connect();
    expect(await provider.countObjects([])).toEqual({ shard: { count: 3 } });
    const rows = await provider.listObjects([], "shard");
    expect(rows).toHaveLength(3);
    expect(await provider.describeObject(rows[0].path, "shard")).toEqual({
      path: rows[0].path,
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(await provider.describeObjects([], "shard")).toEqual({ details: [] });
    expect((await provider.readObjectSource(rows[0].path, "shard")).kind).toBe("shard");
    expect((await provider.readObjectSource(["/a"], "key")).parts).toHaveLength(2);
  });

  test("a Keys panel page answers through key-scan.ts; a refused option sends nothing", async () => {
    const fake = fakeOf([{ key: "/a/1" }, { key: "/b/1" }]);
    const { provider } = providerOver(fake);
    await provider.connect();
    const calls = fake.calls.length;
    await expect(provider.scanKeysPage({ cursor: "0", count: 0 })).rejects.toThrow("A page holds 1 to 1,000 keys.");
    expect(fake.calls).toHaveLength(calls);
    const page = await provider.scanKeysPage({ cursor: "0", count: 500 });
    expect(new Set(page.keys)).toEqual(new Set(["/a/1", "/b/1"]));
    expect(page.total).toBe(0);
  });

  test("health connects when it must, with no connect read, then reads the map afresh and asks Check", async () => {
    const fake = fakeOf();
    const { provider } = providerOver(fake);
    expect(await provider.getHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(provider.isConnected()).toBe(true);
    // The health read is the one snapshot read: the session was built without the connect read (ruling R3).
    expect(snapshotReads(fake)).toBe(1);
  });

  test("an unconnected provider whose shard map is silent and whose Check is SERVING: SB1-9.5's composed sentence", async () => {
    const fake = fakeOf();
    fake.failNext({ rpc: "GetShardAssignments" }, new OxiaError("silent-assignments", { rpc: "GetShardAssignments" }));
    const { provider } = providerOver(fake);

    const error = await provider.getHealth().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toBe(
      `${OXIA_HEALTH_NO_SHARD_MAP}: ${silentAssignmentsSentence(deadlineSeconds(Math.min(OXIA_HEALTH_DEADLINE_MS, DEFAULT_QUERY_TIMEOUT)))}`,
    );
    // Check was asked, and the session built for it was closed with the failure.
    expect(fake.calls.map((entry) => entry.rpc)).toEqual(["GetShardAssignments", "Health/Check"]);
    expect(provider.isConnected()).toBe(false);
    expect(fake.closed).toBe(true);
  });

  test("a health failure is worded as a health check", async () => {
    const fake = fakeOf();
    const { provider } = providerOver(fake);
    await provider.connect();
    const failure = new OxiaError("unauthenticated", { rpc: "Health/Check" });
    fake.failNext({ rpc: "Health/Check" }, failure);
    const error = await provider.getHealth().catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(sentence(failure, "health check"));
  });

  test("a health deadline names the health deadline, not the query timeout (ruling R4)", async () => {
    const fake = fakeOf();
    const { provider } = providerOver(fake);
    await provider.connect();
    const failure = new OxiaError("deadline-exceeded", { rpc: "Health/Check" });
    fake.failNext({ rpc: "Health/Check" }, failure);
    const error = await provider.getHealth().catch((caught: unknown) => caught);
    const healthMs = Math.min(OXIA_HEALTH_DEADLINE_MS, DEFAULT_QUERY_TIMEOUT);
    expect((error as Error).message).toBe(sentence(failure, "health check", healthMs));
    expect((error as Error).message).not.toBe(sentence(failure, "health check"));
  });

  test("the overview counts no table, whatever the shard count (ruling R34)", async () => {
    const { provider } = providerOver(fakeOf());
    await provider.connect();
    expect((await provider.getOverview()).tableCount).toBe(0);
  });

  test("an object read's failure is worded as an object read", async () => {
    const fake = fakeOf();
    const { provider } = providerOver(fake);
    await provider.connect();
    setSystemTime(new Date(Date.now() + OXIA_SNAPSHOT_TTL_MS + 1));
    const failure = new OxiaError("unknown", { rpc: "GetShardAssignments" });
    fake.failNext({ rpc: "GetShardAssignments" }, failure);
    const error = await provider.countObjects([]).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(sentence(failure, "object read"));
  });

  test("the empty monitoring answers, and maintenance refused in the label's words", async () => {
    const { provider } = providerOver(fakeOf());
    expect(await provider.getStorageStats()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    const refusal = provider.runMaintenance();
    await expect(refusal).rejects.toBeInstanceOf(QueryError);
    await expect(refusal).rejects.toThrow(OXIA_LABELS.vacuumGlobalDesc);
  });
});
