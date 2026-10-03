/**
 * Read-only mode, from the connection to the provider's own client. A provider built as the factory builds it, with
 * no injected client factory, refuses Load and Release and sends nothing, whether the mode was set on the connection
 * or by an execution profile; every read still answers; and the same Load on a writable connection is sent, so the
 * refusal above is the mode's and not a client that sends nothing.
 *
 * The one unit file that substitutes `grpc-client.ts` with `mock.module()`: the provider's default client factory is
 * the adapter, and no other seam reaches the client it builds. bun's module mocks are process-wide and have no undo,
 * and the test runner gives this file a process of its own (tests/run-tests.ts), so the substitution reaches no other
 * file.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
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

// After the substitution, so the provider reads the substituted adapter.
const { MilvusProvider } = await import("@/lib/db/providers/vector/milvus/index");

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
  clients.length = 0;
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

  test("every read still answers in read-only mode, the Load preview among them", async () => {
    const { provider, client, mark } = await connected({ ...CONNECTION, readOnly: true });
    expect(await provider.listObjects(["default"], "collection")).toHaveLength(1);
    expect((await provider.previewMaintenance("load", ["default", "docs_int64"])).refusal).toBeUndefined();
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
