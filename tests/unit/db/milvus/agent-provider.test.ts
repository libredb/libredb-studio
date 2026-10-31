/**
 * MilvusProvider under the agent read-only profile, through the real gRPC adapter over a recorded wire, so every RPC,
 * request and metadata entry is the one Studio would send, answered from what 3.0.2 answered the same call
 * (tests/fixtures/milvus/3.0.2/agent-boundary/): a connection that names no user refused before any client is built,
 * the read-only proof at the open and again before every request, the metadata-only answer, every entity route and
 * every other database refused before the network, a server refusal worded without the server's words, and the
 * budgets. The operations profile and an editor handle open as before and are refused `queryReadOnly`.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { createGrpcMilvusClient, type MilvusRpc } from "@/lib/db/providers/vector/milvus/grpc-client";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import { MILVUS_METADATA_ONLY } from "@/lib/db/providers/vector/milvus/metadata-read";
import { MILVUS_AGENT_SENTENCES } from "@/lib/db/providers/vector/milvus/metadata-request";
import { MILVUS_PROOF_SENTENCES } from "@/lib/db/providers/vector/milvus/read-only-proof";
import type { DatabaseConnection, ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import { agentMilvusWire, MILVUS_AGENT_USERS } from "../../../helpers/milvus-agent";
import { okStatus, type RecordedMilvusAnswer, type RecordedMilvusWire } from "../../../helpers/milvus-wire";

const PASSWORD = "not-a-real-password";
const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 100, maxResultBytes: 65_536 };
const STORED = /stored-|not-a-real/;

const CONNECTION: DatabaseConnection = {
  id: "milvus-agent",
  name: "Milvus",
  type: "milvus",
  host: "127.0.0.1",
  port: 19530,
  createdAt: new Date(0),
};

const authorization = (user: string) => ({
  authorization: Buffer.from(`${user}:${PASSWORD}`, "utf8").toString("base64"),
});

function agentProvider(
  principal: string,
  execution: ProviderExecutionContext = AGENT,
  options: Parameters<typeof agentMilvusWire>[1] = {},
  connection: Partial<DatabaseConnection> = { user: MILVUS_AGENT_USERS[principal], password: PASSWORD },
) {
  const wire = agentMilvusWire(principal, options);
  let built = 0;
  const provider = new MilvusProvider({ ...CONNECTION, ...connection }, {}, execution, (built_options) => {
    built += 1;
    return createGrpcMilvusClient(built_options, wire.transport);
  });
  return { provider, wire, built: () => built };
}

const rpcs = (wire: RecordedMilvusWire) => wire.calls.map((logged) => logged.method);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("resolved");
}

async function connected(principal = "reader", options: Parameters<typeof agentMilvusWire>[1] = {}) {
  const made = agentProvider(principal, AGENT, options);
  await made.provider.connect();
  made.wire.calls.length = 0;
  return made;
}

const request = (route: string, body?: unknown) =>
  body === undefined ? `POST /v2/vectordb/${route}` : `POST /v2/vectordb/${route}\n${JSON.stringify(body)}`;

const PROOF: MilvusRpc[] = ["ListCredUsers", "SelectUser", "SelectGrant", "SelectGrant"];

describe("the open under the agent read-only profile", () => {
  test("proves the reader after GetVersion, every call carrying its authorization and nothing else", async () => {
    const { provider, wire } = agentProvider("reader");
    await provider.connect();
    const metadata = authorization("agent_reader");
    expect(wire.calls).toEqual([
      { method: "GetVersion", args: [{}, metadata] },
      { method: "ListCredUsers", args: [{}, metadata] },
      { method: "SelectUser", args: [{ user: { name: "agent_reader" }, include_role_info: true }, metadata] },
      { method: "SelectGrant", args: [{ entity: { role: { name: "agent_reader_role" }, db_name: "*" } }, metadata] },
      { method: "SelectGrant", args: [{ entity: { role: { name: "public" }, db_name: "*" } }, metadata] },
    ]);
    expect(provider.isConnected()).toBe(true);
  });

  test("a connection that names no user is refused before any client is built", async () => {
    const { provider, built } = agentProvider("reader", AGENT, {}, { user: "", password: "" });
    const error = await rejection(provider.connect());
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as Error).message).toBe(MILVUS_PROOF_SENTENCES.noUser);
    expect(built()).toBe(0);
  });

  test.each([
    ["root", MILVUS_PROOF_SENTENCES.root, ["GetVersion"]],
    ["admin", MILVUS_PROOF_SENTENCES.admin, ["GetVersion", "ListCredUsers", "SelectUser"]],
    ["rw", MILVUS_PROOF_SENTENCES.grant("CollectionReadWrite"), ["GetVersion", ...PROOF.slice(0, 3)]],
    ["open-reader", MILVUS_PROOF_SENTENCES.unenforced, ["GetVersion", ...PROOF]],
  ])("%s is refused at the open, and its channel closed", async (principal, sentence, sent) => {
    const { provider, wire } = agentProvider(principal);
    const error = await rejection(provider.connect());
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as Error).message).toBe(sentence);
    expect(rpcs(wire)).toEqual(sent);
    expect(wire.closes()).toBe(1);
    expect(provider.isConnected()).toBe(false);
  });

  test.each([
    ["the operations profile", OPERATIONS],
    ["an editor", {}],
  ])("%s opens root with no proof, as before", async (_name, execution) => {
    const { provider, wire } = agentProvider("root", execution);
    await provider.connect();
    expect(rpcs(wire)).toEqual(["GetVersion"]);
  });

  test("the capability states the metadata-only projections", () => {
    expect(agentProvider("reader").provider.getCapabilities().metadataOnly).toBe(MILVUS_METADATA_ONLY);
  });
});

describe("an agent request", () => {
  test("is proved again, then read, and answered as names, counts and flags", async () => {
    const { provider, wire } = await connected();
    const result = await provider.queryReadOnly(request("collections/list"), BUDGET);
    expect(rpcs(wire)).toEqual([...PROOF, "ShowCollections"]);
    expect(wire.calls.at(-1)).toEqual({
      method: "ShowCollections",
      args: [{ db_name: "default" }, authorization("agent_reader")],
    });
    expect(result).toMatchObject({
      fields: ["collection"],
      rows: [{ collection: "agent_docs" }, { collection: "agent_scratch" }],
      rowCount: 2,
    });
  });

  test("collections/describe answers the schema without a default value, a description or a parameter", async () => {
    const { provider } = await connected();
    const result = await provider.queryReadOnly(
      request("collections/describe", { collectionName: "agent_docs" }),
      BUDGET,
    );
    expect(result.rowCount).toBe(8);
    expect(JSON.stringify(result)).not.toMatch(STORED);
  });

  test.each([
    request("entities/query", { collectionName: "agent_docs", filter: "id > 0", outputFields: ["title", "note"] }),
    request("entities/get", { collectionName: "agent_docs", id: 1 }),
    request("entities/search", { collectionName: "agent_docs", annsField: "sparse", data: ["vectors"] }),
  ])("%s is refused before anything is sent: it answers stored values", async (text) => {
    const { provider, wire } = await connected();
    const error = await rejection(provider.queryReadOnly(text, BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect((error as Error).message).toContain("is not one of agent mode's reads");
    expect(wire.calls).toEqual([]);
  });

  test.each([
    request("collections/load", { collectionName: "agent_docs" }),
    request("collections/release", { collectionName: "agent_docs" }),
    request("entities/insert", { collectionName: "agent_docs", data: [] }),
    request("collections/create", { collectionName: "x" }),
  ])("%s is no route of the closed table and is refused before anything is sent", async (text) => {
    const { provider, wire } = await connected();
    expect(await rejection(provider.queryReadOnly(text, BUDGET))).toBeInstanceOf(RefusedBeforeSendError);
    expect(wire.calls).toEqual([]);
  });

  test("a request naming another database is refused before anything is sent", async () => {
    const { provider, wire } = await connected();
    const error = await rejection(provider.queryReadOnly(request("collections/list", { dbName: "probe_db" }), BUDGET));
    expect((error as Error).message).toBe(MILVUS_AGENT_SENTENCES.database);
    expect(wire.calls).toEqual([]);
  });

  test("a grant made since the open is caught at the next request, and nothing of it is read", async () => {
    let grants = "select-grant-own-role";
    const { provider, wire } = await connected("midrun", { ownGrants: () => grants });
    await provider.queryReadOnly(request("collections/list"), BUDGET);
    grants = "select-grant-own-role-after-grant";
    wire.calls.length = 0;
    const error = await rejection(provider.queryReadOnly(request("collections/list"), BUDGET));
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as Error).message).toBe(MILVUS_PROOF_SENTENCES.grant("Insert"));
    expect(rpcs(wire)).toEqual(PROOF.slice(0, 3));
  });

  test("a server refusal is worded by its category, never the server's words", async () => {
    const { provider } = await connected("reader", {
      overrides: {
        DescribeAlias: (() =>
          Promise.reject(
            Object.assign(new Error("7 PERMISSION_DENIED: stored-title-value"), {
              code: 7,
              details: "stored-title-value",
              metadata: {},
            }),
          )) satisfies RecordedMilvusAnswer,
      },
    });
    const error = await rejection(
      provider.queryReadOnly(request("aliases/describe", { aliasName: "agent_alias" }), BUDGET),
    );
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toContain("permission-denied");
    expect((error as Error).message).not.toMatch(STORED);
  });

  test("an answer past the row budget is refused, never cut", async () => {
    const { provider } = await connected();
    const error = await rejection(provider.queryReadOnly(request("collections/list"), { ...BUDGET, maxResultRows: 1 }));
    expect(error).toBeInstanceOf(QueryError);
  });

  test("a request still unanswered at its deadline is the time budget's refusal", async () => {
    const { provider } = await connected("reader", { overrides: { ShowCollections: () => new Promise(() => {}) } });
    const error = await rejection(
      provider.queryReadOnly(request("collections/list"), { ...BUDGET, statementTimeoutMs: 50 }),
    );
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toContain("50ms");
  });

  test("a close while the request waits ends it, worded as a cancel", async () => {
    const { provider } = await connected("reader", { overrides: { ShowCollections: () => new Promise(() => {}) } });
    const pending = rejection(provider.queryReadOnly(request("collections/list"), BUDGET));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await provider.disconnect();
    const error = await pending;
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toContain("cancelled");
  });

  test("an answer the reads cannot walk is passed on as the defect it is, never worded as the server's", async () => {
    const { provider } = await connected("reader", { overrides: { ListDatabases: () => ({ status: okStatus }) } });
    const error = await rejection(provider.queryReadOnly(request("databases/list"), BUDGET));
    expect(error).toBeInstanceOf(TypeError);
  });

  test("a request still waiting for a permit at its deadline sends nothing and is the time budget's refusal", async () => {
    const { provider, wire } = await connected("reader", {
      overrides: { ShowCollections: () => new Promise(() => {}) },
    });
    // Four in flight hold every permit of the provider, so a fifth waits.
    const holding = Array.from({ length: 4 }, () =>
      rejection(provider.queryReadOnly(request("collections/list"), BUDGET)),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sent = wire.calls.length;
    const error = await rejection(
      provider.queryReadOnly(request("collections/list"), { ...BUDGET, statementTimeoutMs: 50 }),
    );
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toContain("50ms");
    expect(wire.calls.length).toBe(sent);
    await provider.disconnect();
    // The close ends the four held requests too, each worded as a cancel.
    for (const held of await Promise.all(holding)) expect((held as Error).message).toContain("cancelled");
  });

  test("a failure outside the client's is passed on as it is", async () => {
    const { provider } = await connected("reader", {
      overrides: { ShowCollections: () => ({ status: null, collection_names: [] }) },
    });
    const error = await rejection(provider.queryReadOnly(request("collections/list"), BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toContain("malformed");
  });
});

describe("queryReadOnly off the agent profile", () => {
  test.each([
    ["an editor handle", {}],
    ["the operations profile", OPERATIONS],
  ])("on %s is refused before anything is sent", async (_name, execution) => {
    const { provider, wire } = agentProvider("reader", execution);
    await provider.connect();
    wire.calls.length = 0;
    const error = await rejection(provider.queryReadOnly(request("collections/list"), BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(wire.calls).toEqual([]);
  });

  test("an estimate is refused: Milvus composes no plan for the agent", async () => {
    const { provider, wire } = await connected();
    const error = await rejection(provider.queryReadOnly(request("collections/list"), BUDGET, "estimate-plan"));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(wire.calls).toEqual([]);
  });

  test("on a provider that is not connected, it refuses as every surface does", async () => {
    const { provider } = agentProvider("reader");
    await expect(provider.queryReadOnly(request("collections/list"), BUDGET)).rejects.toThrow();
  });
});
