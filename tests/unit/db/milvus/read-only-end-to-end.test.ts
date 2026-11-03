/**
 * Read-only mode, from the connection to the provider's own client. A provider built as the factory builds it, with
 * no injected client factory, refuses Load and Release and sends nothing, whether the mode was set on the connection,
 * by an execution profile or in the operator's seed file (loaded, resolved and built through `getOrCreateProvider`);
 * every read still answers; and the same Load on a writable connection is sent, so the refusal above is the mode's and
 * not a client that sends nothing.
 *
 * The one unit file that substitutes `grpc-client.ts` with `mock.module()`: the provider's default client factory is
 * the adapter, and no other seam reaches the client it builds. bun's module mocks are process-wide and have no undo,
 * and the test runner gives this file a process of its own (tests/run-tests.ts), so the substitution reaches no other
 * file.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { readOnlySentence } from "@/lib/db/providers/vector/milvus/write-policy";
import type { DatabaseConnection, ProviderExecutionContext } from "@/lib/db/types";
import {
  createFakeMilvusClient,
  DOCS_INT64,
  DOCS_INT64_INDEX,
  type FakeMilvusClient,
  SYSTEM_INFO,
} from "../../../helpers/milvus-catalog-client";

/** Every client the substituted adapter handed out, in order, each recording every call it was sent. */
const clients: FakeMilvusClient[] = [];

mock.module("@/lib/db/providers/vector/milvus/grpc-client", () => ({
  createGrpcMilvusClient: async () => {
    const client = createFakeMilvusClient({
      databases: { default: [{ describe: DOCS_INT64, indexes: [DOCS_INT64_INDEX], rowCount: "2000" }] },
      metrics: SYSTEM_INFO,
    });
    clients.push(client);
    return client;
  },
}));

process.env.SEED_CONFIG_PATH = path.resolve(
  import.meta.dir,
  "../../../fixtures/seed-connections/milvus-read-only-config.yaml",
);
process.env.MILVUS_READER_PASSWORD = "not-a-real-password";

// After the substitution, so the provider and the factory read the substituted adapter.
const { MilvusProvider } = await import("@/lib/db/providers/vector/milvus/index");
const { clearProviderCache, getOrCreateProvider } = await import("@/lib/db/factory");
const { resetCache } = await import("@/lib/seed");
const { resolveConnection } = await import("@/lib/seed/resolve-connection");

const CONNECTION: DatabaseConnection = {
  id: "milvus-read-only",
  name: "milvus read-only",
  type: "milvus",
  host: "127.0.0.1",
  port: 19530,
  createdAt: new Date(0),
};

async function connected(connection: DatabaseConnection, execution: ProviderExecutionContext = {}) {
  const provider = new MilvusProvider(connection, {}, execution);
  await provider.connect();
  const client = clients[clients.length - 1];
  return { provider, client, mark: client.calls.length };
}

/** The calls a client was sent after it connected, by method. */
const sentAfter = (client: FakeMilvusClient, mark: number) => client.calls.slice(mark).map((call) => call.method);

beforeEach(() => {
  resetCache();
  clients.length = 0;
});

afterEach(async () => {
  await clearProviderCache();
});

describe("a read-only Milvus connection, down to the client the adapter built", () => {
  test.each([
    ["the connection's own toggle", { ...CONNECTION, readOnly: true }, {}, "connection"],
    ["an execution profile", CONNECTION, { readOnly: true }, "execution-profile"],
  ] as const)(
    "set by %s: Load and Release are refused and nothing is sent",
    async (_where, connection, execution, source) => {
      const { provider, client, mark } = await connected(connection, execution);
      expect(clients).toHaveLength(1);
      await expect(provider.runMaintenance("load", "docs_int64", "default")).rejects.toThrow(readOnlySentence(source));
      await expect(provider.runMaintenance("release", "docs_int64", "default")).rejects.toThrow(
        readOnlySentence(source),
      );
      expect(sentAfter(client, mark)).toEqual([]);
    },
  );

  test("set in the operator's seed file: the mode survives the load and the resolver, and Load and Release are refused with nothing sent", async () => {
    const connection = await resolveConnection({ connectionId: "seed:vectors-read" }, { role: "user", username: "u" });
    expect(connection).toMatchObject({ seedId: "vectors-read", type: "milvus", readOnly: true });
    const provider = await getOrCreateProvider(connection);
    expect(clients).toHaveLength(1);
    const [client] = clients;
    const mark = client.calls.length;
    for (const operation of ["load", "release"] as const) {
      await expect(provider.runMaintenance(operation, "docs_int64", "default")).rejects.toThrow(
        readOnlySentence("seed"),
      );
    }
    expect(sentAfter(client, mark)).toEqual([]);
  });

  test("every read still answers in read-only mode, and the Load preview is refused as the Load is", async () => {
    const { provider, client, mark } = await connected({ ...CONNECTION, readOnly: true });
    expect(await provider.listObjects(["default"], "collection")).toHaveLength(1);
    // The preview describes a run the mode refuses, so it answers the mode's sentence in place of one (#1418): a
    // dialog that drew it would offer a confirm button the maintenance route then answers 400 to.
    await expect(provider.previewMaintenance("load", ["default", "docs_int64"])).rejects.toThrow(
      readOnlySentence("connection"),
    );
    const sent = sentAfter(client, mark);
    expect(sent).toContain("showCollections");
    expect(sent).not.toContain("loadCollection");
    expect(sent).not.toContain("releaseCollection");
  });

  test("the same Load on a writable connection is sent, so the refusal above is the mode's", async () => {
    const { provider, client, mark } = await connected(CONNECTION);
    const result = await provider.runMaintenance("load", "docs_int64", "default");
    expect(result.success).toBe(true);
    expect(sentAfter(client, mark)).toEqual(["getLoadState", "loadCollection", "getLoadingProgress"]);
  });
});
