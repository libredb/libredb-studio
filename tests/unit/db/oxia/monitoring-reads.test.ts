/**
 * Health and the overview of an Oxia connection, over the shared fake (SB2-9.5, SB1-9.5): the healthy answer, the
 * snapshot read afresh and never from the cache, each call under the deadline handed in, each failure passed through,
 * the server that answers Check and serves no shard map, and the overview's shape.
 */
import { describe, expect, test } from "bun:test";
import { ConnectionError } from "@/lib/db/errors";
import type { OxiaCallOptions, OxiaClient, OxiaHealth, OxiaSnapshot } from "@/lib/db/providers/keyvalue/oxia/client";
import { OxiaError } from "@/lib/db/providers/keyvalue/oxia/errors";
import { oxiaHealth, oxiaOverview } from "@/lib/db/providers/keyvalue/oxia/monitoring-reads";
import type { OxiaSurface } from "@/lib/db/providers/keyvalue/oxia/walks";
import { createFakeOxiaClient, type FakeOxiaClient } from "../../../helpers/oxia-fake-client";

const SILENT =
  "The server accepted the connection but its shard map did not arrive within 5 s, so nothing was read. A data server that has not yet received its shard assignments from the coordinator answers this way: check the coordinator, then try again.";

/** The fake with Check answering `status`, and every call's options recorded, in order. */
function clientOver(fake: FakeOxiaClient, status: OxiaHealth = "SERVING") {
  const seen: { readonly method: "getSnapshot" | "health"; readonly call: OxiaCallOptions }[] = [];
  const client: OxiaClient = {
    getSnapshot: (call) => {
      seen.push({ method: "getSnapshot", call });
      return fake.getSnapshot(call);
    },
    read: (shard, gets, call) => fake.read(shard, gets, call),
    list: (shard, range, call) => fake.list(shard, range, call),
    rangeScan: (shard, range, call) => fake.rangeScan(shard, range, call),
    health: async (call) => {
      seen.push({ method: "health", call });
      return status;
    },
    close: () => fake.close(),
  };
  return { client, seen };
}

/** A surface whose cached snapshot is counted, so a read that bypasses it shows. */
function surfaceOf(client: OxiaClient) {
  let cachedReads = 0;
  let snapshot: OxiaSnapshot | undefined;
  const surface: OxiaSurface = {
    client,
    snapshot: async (call) => {
      cachedReads += 1;
      snapshot ??= await client.getSnapshot(call);
      return snapshot;
    },
    order: async () => ({ order: "hierarchical", learnedBy: "empty" }),
  };
  return { surface, cachedReads: () => cachedReads };
}

describe("oxiaHealth (SB1-9.5)", () => {
  test("healthy: the snapshot read afresh, then Check, each under the deadline and the signal handed in", async () => {
    const fake = createFakeOxiaClient({ order: "hierarchical", records: [] });
    const { client, seen } = clientOver(fake);
    const { surface, cachedReads } = surfaceOf(client);
    const before = Date.now();
    const signal = new AbortController().signal;

    const health = await oxiaHealth(surface, 5_000, signal);

    expect(health).toEqual({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
    // No count of connections is reported, which is a different fact from zero.
    expect("activeConnections" in health).toBe(false);
    expect(seen.map((entry) => entry.method)).toEqual(["getSnapshot", "health"]);
    expect(cachedReads()).toBe(0);
    for (const entry of seen) {
      expect(entry.call.signal).toBe(signal);
      expect(entry.call.deadline).toBeGreaterThanOrEqual(before + 5_000);
      expect(entry.call.deadline).toBeLessThanOrEqual(Date.now() + 5_000);
    }
  });

  test("a snapshot failure passes through, and Check is not asked", async () => {
    const fake = createFakeOxiaClient({ order: "hierarchical", records: [] });
    const failure = new OxiaError("namespace-not-found", { rpc: "GetShardAssignments" });
    fake.failNext({ rpc: "GetShardAssignments" }, failure);
    const { client, seen } = clientOver(fake);

    await expect(oxiaHealth(surfaceOf(client).surface, 5_000, new AbortController().signal)).rejects.toBe(failure);
    expect(seen.map((entry) => entry.method)).toEqual(["getSnapshot"]);
  });

  test("a Check failure passes through", async () => {
    const fake = createFakeOxiaClient({ order: "hierarchical", records: [] });
    const failure = new OxiaError("unauthenticated", { rpc: "Health/Check" });
    fake.failNext({ rpc: "Health/Check" }, failure);

    await expect(oxiaHealth(surfaceOf(fake).surface, 5_000, new AbortController().signal)).rejects.toBe(failure);
  });

  test.each(["NOT_SERVING", "UNKNOWN", "SERVICE_UNKNOWN"] as const)(
    "a Check that answers %s is unhealthy, named by its status",
    async (status) => {
      const fake = createFakeOxiaClient({ order: "hierarchical", records: [] });
      const { client } = clientOver(fake, status);
      const health = oxiaHealth(surfaceOf(client).surface, 5_000, new AbortController().signal);
      await expect(health).rejects.toBeInstanceOf(ConnectionError);
      await expect(health).rejects.toThrow(`Oxia answered the health check with ${status}: it serves no reads now.`);
    },
  );

  test("a server that answers Check SERVING and sends no shard map: the silent-assignments sentence, no restart remedy", async () => {
    const fake = createFakeOxiaClient({ order: "hierarchical", records: [] });
    fake.failNext({ rpc: "GetShardAssignments" }, new OxiaError("silent-assignments", { rpc: "GetShardAssignments" }));
    const { client, seen } = clientOver(fake, "SERVING");
    const before = Date.now();
    const signal = new AbortController().signal;

    const health = oxiaHealth(surfaceOf(client).surface, 5_000, signal);
    await expect(health).rejects.toBeInstanceOf(ConnectionError);
    await expect(health).rejects.toThrow(`The server answers health but serves no shard map: ${SILENT}`);
    await health.catch((error: Error) => expect(error.message).not.toContain("restart"));
    expect(seen.map((entry) => entry.method)).toEqual(["getSnapshot", "health"]);
    // The Check that follows a silent shard map has the same deadline and signal as any other.
    const check = seen[1].call;
    expect(check.signal).toBe(signal);
    expect(check.deadline).toBeGreaterThanOrEqual(before + 5_000);
    expect(check.deadline).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  test("a silent shard map with a Check that is not SERVING passes the silent-assignments failure through", async () => {
    const fake = createFakeOxiaClient({ order: "hierarchical", records: [] });
    const silent = new OxiaError("silent-assignments", { rpc: "GetShardAssignments" });
    fake.failNext({ rpc: "GetShardAssignments" }, silent);
    const { client } = clientOver(fake, "NOT_SERVING");

    await expect(oxiaHealth(surfaceOf(client).surface, 5_000, new AbortController().signal)).rejects.toBe(silent);
  });

  test("the deadline is named in whole seconds, rounded up", async () => {
    const fake = createFakeOxiaClient({ order: "hierarchical", records: [] });
    fake.failNext({ rpc: "GetShardAssignments" }, new OxiaError("silent-assignments", { rpc: "GetShardAssignments" }));
    const { client } = clientOver(fake, "SERVING");

    await expect(oxiaHealth(surfaceOf(client).surface, 2_500, new AbortController().signal)).rejects.toThrow(
      "did not arrive within 3 s",
    );
  });
});

describe("oxiaOverview (SB2-9.5)", () => {
  test("no version, uptime or size, and the shard count as the one counted object", async () => {
    const fake = createFakeOxiaClient({ order: "hierarchical", records: [], shards: 4 });
    const overview = await oxiaOverview(surfaceOf(fake).surface, {
      signal: new AbortController().signal,
      deadline: Date.now() + 10_000,
    });
    expect(overview).toEqual({
      version: "N/A",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 4,
      indexCount: 0,
    });
  });
});
