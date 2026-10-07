/**
 * E6's end-to-end test (#1089, section 3.6 E6, gate 1): the fail-open class closed from the seed file to the
 * provider. A seed with `readOnly: true`, loaded, resolved through `resolveConnection` and built through
 * `getOrCreateProvider`, refuses a write and sends nothing, and the same write on the seed without `readOnly` is
 * sent, so a field dropped anywhere in the schema, the mapper or the resolver fails here. A provider an
 * execution profile opens on that writable seed refuses the write too (E12's operations profile).
 *
 * The one unit file that substitutes `grpc-client.ts` with `mock.module()` (spec E6; reconciliation K-60):
 * `getOrCreateProvider` reaches the provider's constructor through `createDatabaseProvider`, which passes no
 * client factory, and returns the provider only after `connect()` succeeds, so no other seam reaches the
 * client it builds. bun's module mocks are process-wide and have no undo, and the test runner gives this file
 * a process of its own (tests/run-tests.ts), so the substitution reaches no other file.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import type { EtcdStatus } from "@/lib/db/providers/keyvalue/etcd/client";
import { readOnlySentence } from "@/lib/db/providers/keyvalue/etcd/write-policy";
import { createFakeEtcdClient, type FakeEtcdClient } from "../../../helpers/etcd-fake-client";
import { KEY_SPACE_HEADER, keySpaceRange } from "../../../helpers/etcd-key-space";

/** A single-member cluster with authentication off: what the adapter would have connected to. */
const STATUS: EtcdStatus = {
  header: KEY_SPACE_HEADER,
  version: "3.7.2",
  dbSize: "20480",
  dbSizeInUse: "16384",
  dbSizeQuota: "0",
  leader: "10276657743932975437",
  raftIndex: "40",
  raftTerm: "2",
  raftAppliedIndex: "40",
  errors: [],
  isLearner: false,
  storageVersion: "3.7.0",
};

/** Every client the substituted adapter handed out, in order, each recording every call it was sent. */
const clients: FakeEtcdClient[] = [];

function cluster(): FakeEtcdClient {
  return createFakeEtcdClient({
    authStatus: async () => ({ enabled: false, authRevision: "1" }),
    status: async () => STATUS,
    range: keySpaceRange([{ key: "/app/cfg", value: "old" }]),
    txn: async () => ({
      header: KEY_SPACE_HEADER,
      succeeded: true,
      responses: [{ op: "put", response: { header: KEY_SPACE_HEADER } }],
    }),
    close: async () => {},
  });
}

mock.module("@/lib/db/providers/keyvalue/etcd/grpc-client", () => ({
  createGrpcEtcdClient: async () => {
    const client = cluster();
    clients.push(client);
    return client;
  },
}));

process.env.SEED_CONFIG_PATH = path.resolve(
  import.meta.dir,
  "../../../fixtures/seed-connections/etcd-read-only-config.yaml",
);

// After the substitution, so the factory and the provider it imports read the substituted adapter.
const { acquireExecutionProfileProvider, clearProviderCache, getOrCreateProvider } = await import("@/lib/db/factory");
const { resetCache } = await import("@/lib/seed");
const { resolveConnection } = await import("@/lib/seed/resolve-connection");

const WRITE = "put /app/cfg value";

/** The calls a client was sent after it connected, by method. */
const sentAfter = (client: FakeEtcdClient, mark: number) => client.calls.slice(mark).map((call) => call.method);

beforeEach(() => {
  resetCache();
  clients.length = 0;
});

afterEach(async () => {
  await clearProviderCache();
});

describe("a read-only etcd seed, from the seed file to the provider (#1089 E6)", () => {
  test("the seed's readOnly survives the load, the mapper and the resolver, and its provider sends no write", async () => {
    const connection = await resolveConnection({ connectionId: "seed:cluster-read" }, { role: "user", username: "u" });
    expect(connection).toMatchObject({ id: "seed:cluster-read", seedId: "cluster-read", type: "etcd", readOnly: true });

    const provider = await getOrCreateProvider(connection);
    expect(clients).toHaveLength(1);
    const [client] = clients;
    const mark = client.calls.length;

    await expect(provider.query(WRITE)).rejects.toThrow(readOnlySentence("seed"));
    expect(sentAfter(client, mark)).toEqual([]);
  });

  test("the same write on the seed without readOnly is sent, so the refusal above is the mode's", async () => {
    const connection = await resolveConnection(
      { connectionId: "seed:cluster-write" },
      { role: "admin", username: "a" },
    );
    // The mapper carries the field through as the seed has it: absent there, so undefined here.
    expect(connection.readOnly).toBeUndefined();

    const provider = await getOrCreateProvider(connection);
    const [client] = clients;
    const mark = client.calls.length;

    const result = await provider.query(WRITE);
    expect(result.rowCount).toBeGreaterThan(0);
    expect(sentAfter(client, mark)).toContain("txn");
  });

  test("a user is never handed the writable seed, whose roles admit only an admin", async () => {
    await expect(
      resolveConnection({ connectionId: "seed:cluster-write" }, { role: "user", username: "u" }),
    ).rejects.toThrow();
    expect(clients).toHaveLength(0);
  });

  test("a provider the operations profile opens on the writable seed refuses the write, and sends nothing (E12)", async () => {
    const connection = await resolveConnection(
      { connectionId: "seed:cluster-write" },
      { role: "admin", username: "a" },
    );

    const provider = await acquireExecutionProfileProvider(connection, "agent-operations");
    expect(clients).toHaveLength(1);
    const [client] = clients;
    const mark = client.calls.length;

    await expect(provider.query(WRITE)).rejects.toThrow(readOnlySentence("execution-profile"));
    expect(sentAfter(client, mark)).toEqual([]);
  });
});
