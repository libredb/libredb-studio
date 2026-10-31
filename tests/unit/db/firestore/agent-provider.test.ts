/**
 * The Firestore provider's agent paths, over the real transport and the fake seams: `queryReadOnly` only on a handle
 * opened under the agent read-only profile and only with the run's read allowance, the closed table refused before
 * anything is sent, every request charged before it is sent, answers projected to metadata, failures worded by
 * category, and every other surface of an agent-mode handle reading metadata only or answering its reason. The
 * editor's handles keep every surface.
 */
// oxlint-disable no-await-in-loop -- each surface runs after the one before, so each request is one surface's.
import { describe, expect, test } from "bun:test";
import { QueryError, ReadAllowanceExceededError, RefusedBeforeSendError } from "@/lib/db/errors";
import { FIRESTORE_PROVIDER_SENTENCES as S, FirestoreProvider } from "@/lib/db/providers/document/firestore";
import { FIRESTORE_AGENT_FAILURE_SENTENCES as F } from "@/lib/db/providers/document/firestore/agent-metadata-read";
import { FIRESTORE_AGENT_SENTENCES } from "@/lib/db/providers/document/firestore/agent-statement";
import { FIRESTORE_AGENT_WITHHELD as W } from "@/lib/db/providers/document/firestore/agent-surface";
import { TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import { READ_ALLOWANCE_PREFIX, RunReadAllowance } from "@/lib/db/read-allowance";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import { type FakeFirestoreSeams, fakeSeams, jsonAnswer } from "../../../helpers/firestore-seams";
import {
  firestoreConnection,
  googleServer,
  HANG,
  isProbe,
  PROVIDER_DOCS,
  requestsOf,
  type WireHandler,
  wire,
} from "../../../helpers/firestore-provider";

const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true };
const EMULATOR = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" };
const BASE = "/v1/projects/demo-studio/databases/%28default%29/documents";

const budget = (allowance?: RunReadAllowance): ReadOnlyStatementBudget => ({
  statementTimeoutMs: 4_000,
  maxResultRows: 3,
  maxResultBytes: 10_000,
  ...(allowance === undefined ? {} : { readAllowance: allowance }),
});

const counted = (n: string) => jsonAnswer([{ result: { aggregateFields: { count: { integerValue: n } } } }]);

/** A Google server with users, orders and a document users/alice that holds fields the agent never reads. */
const SERVER: WireHandler = googleServer(undefined, (request) => {
  if (request.path.endsWith(":listCollectionIds"))
    return jsonAnswer({
      collectionIds: request.path === `${BASE}:listCollectionIds` ? ["users", "orders"] : ["orders"],
    });
  if (request.path.endsWith(":runAggregationQuery")) return counted("2");
  if (request.path.endsWith(":batchGet"))
    return jsonAnswer([
      {
        found: {
          name: `${PROVIDER_DOCS}/users/alice`,
          createTime: "2026-10-31T04:59:47.809191Z",
          updateTime: "2026-10-31T05:00:00Z",
          fields: { ssn: { stringValue: "marker-value-ssn" } },
        },
      },
    ]);
  return jsonAnswer({ name: `${PROVIDER_DOCS}/users/alice`, fields: { ssn: { stringValue: "marker-value-ssn" } } });
});

async function open(
  execution: ProviderExecutionContext,
  handler: WireHandler = SERVER,
  env: Record<string, string> = {},
): Promise<{
  provider: FirestoreProvider;
  seams: FakeFirestoreSeams;
  afterProbe: () => ReturnType<typeof requestsOf>;
}> {
  const seams = fakeSeams({ env, answer: wire(handler) });
  const connection = firestoreConnection(env.FIRESTORE_EMULATOR_HOST === undefined ? {} : { password: undefined });
  const provider = new FirestoreProvider(connection, { queryTimeout: 30_000 }, execution, seams);
  await provider.connect();
  const probes = requestsOf(seams).length;
  return { provider, seams, afterProbe: () => requestsOf(seams).slice(probes) };
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("queryReadOnly's preconditions", () => {
  test.each([
    ["an editor handle", {}],
    ["an operations handle, which sends no statement", OPERATIONS],
  ])("refused on %s, before anything is sent", async (_name, execution) => {
    const { provider, afterProbe } = await open(execution);
    const error = await rejected(provider.queryReadOnly("db.listCollections()", budget(new RunReadAllowance(10))));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(S.profileRequired);
    expect(afterProbe()).toEqual([]);
  });

  test("refused without the run's read allowance, since every read is billed", async () => {
    const { provider, afterProbe } = await open(READ_ONLY);
    const error = await rejected(provider.queryReadOnly("db.listCollections()", budget()));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(S.noAllowance);
    expect(afterProbe()).toEqual([]);
  });

  test("refused for an estimating plan, which Firestore never composes for the agent", async () => {
    const { provider } = await open(READ_ONLY);
    const error = await rejected(
      provider.queryReadOnly("db.listCollections()", budget(new RunReadAllowance(10)), "estimate-plan"),
    );
    expect(error.message).toBe(S.noEstimate);
  });

  test("a budget that does not read is refused", async () => {
    const { provider } = await open(READ_ONLY);
    await expect(
      provider.queryReadOnly("db.listCollections()", { ...budget(new RunReadAllowance(10)), maxResultRows: -1 }),
    ).rejects.toThrow();
  });
});

describe("the closed table, refused before anything is sent", () => {
  test.each([
    ['db.collection("users").where("ssn", "==", "x").count()', FIRESTORE_AGENT_SENTENCES.narrowed],
    ['db.collection("users").listDocuments()', FIRESTORE_AGENT_SENTENCES.documentIds],
    ['db.collection("users").get()', FIRESTORE_AGENT_SENTENCES.documents],
    ['db.collection("users").aggregate({ s: AggregateField.sum("age") })', FIRESTORE_AGENT_SENTENCES.valueOracle],
    ['db.collection("users").count().explain()', FIRESTORE_AGENT_SENTENCES.explain],
  ])("%s", async (statement, sentence) => {
    const { provider, afterProbe } = await open(READ_ONLY);
    const allowance = new RunReadAllowance(10);
    const error = await rejected(provider.queryReadOnly(statement, budget(allowance)));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(sentence);
    expect(afterProbe()).toEqual([]);
    expect(allowance.spent()).toBe(0);
  });
});

describe("the four reads", () => {
  test("the root collection ids: one listing, charged, answered by id", async () => {
    const { provider, afterProbe } = await open(READ_ONLY);
    const allowance = new RunReadAllowance(10);
    const result = await provider.queryReadOnly("db.listCollections()", budget(allowance));
    expect(result.fields).toEqual(["collection"]);
    expect(result.rows).toEqual([{ collection: "orders" }, { collection: "users" }]);
    expect(afterProbe().map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: `${BASE}:listCollectionIds`, body: { pageSize: 4 } },
    ]);
    expect(allowance.spent()).toBe(1);
  });

  test("a whole collection's count with upTo one past the budget", async () => {
    const { provider, afterProbe } = await open(READ_ONLY);
    const result = await provider.queryReadOnly('db.collection("users").count()', budget(new RunReadAllowance(10)));
    expect(result.rows).toEqual([{ collection: "users", documents: 2 }]);
    expect(afterProbe().map(({ path, body }) => ({ path, body }))).toEqual([
      {
        path: `${BASE}:runAggregationQuery`,
        body: {
          structuredAggregationQuery: {
            structuredQuery: { from: [{ collectionId: "users" }] },
            aggregations: [{ alias: "count", count: { upTo: "4" } }],
          },
        },
      },
    ]);
  });

  test("a named document's existence and times, never its fields or its path", async () => {
    const { provider, afterProbe } = await open(READ_ONLY);
    const result = await provider.queryReadOnly('db.doc("users/alice").get()', budget(new RunReadAllowance(10)));
    expect(result.rows).toEqual([
      { collection: "users", exists: true, created: "2026-10-31T04:59:47.809191Z", updated: "2026-10-31T05:00:00Z" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/marker-value-ssn|ssn|alice/);
    expect(afterProbe().map(({ path, body }) => ({ path, body }))).toEqual([
      { path: `${BASE}:batchGet`, body: { documents: [`${PROVIDER_DOCS}/users/alice`], mask: { fieldPaths: [] } } },
    ]);
  });

  test("no state is kept from one call for the next: a page token is never reused", async () => {
    let calls = 0;
    const { provider, afterProbe } = await open(
      READ_ONLY,
      googleServer(undefined, () => {
        calls += 1;
        return jsonAnswer(calls === 1 ? { collectionIds: ["a"], nextPageToken: "T1" } : { collectionIds: ["b"] });
      }),
    );
    await provider.queryReadOnly("db.listCollections()", budget(new RunReadAllowance(10)));
    await provider.queryReadOnly("db.listCollections()", budget(new RunReadAllowance(10)));
    expect(afterProbe().map(({ body }) => body)).toEqual([
      { pageSize: 4 },
      { pageSize: 4, pageToken: "T1" },
      { pageSize: 4 },
    ]);
  });
});

describe("the allowance", () => {
  test("a read past what is left is refused in Studio's words, before it is sent", async () => {
    const { provider, afterProbe } = await open(READ_ONLY);
    const allowance = new RunReadAllowance(1);
    allowance.charge(1, "earlier");
    const error = await rejected(provider.queryReadOnly("db.listCollections()", budget(allowance)));
    expect(error).toBeInstanceOf(ReadAllowanceExceededError);
    expect(error.message.startsWith(READ_ALLOWANCE_PREFIX)).toBe(true);
    expect(afterProbe()).toEqual([]);
  });

  test("the last unit is spent by the read that takes it, and the next is refused", async () => {
    const { provider, afterProbe } = await open(READ_ONLY);
    const allowance = new RunReadAllowance(1);
    await provider.queryReadOnly("db.listCollections()", budget(allowance));
    expect(allowance.remaining()).toBe(0);
    await expect(provider.queryReadOnly('db.doc("users/alice").get()', budget(allowance))).rejects.toBeInstanceOf(
      ReadAllowanceExceededError,
    );
    expect(afterProbe()).toHaveLength(1);
  });
});

describe("failures", () => {
  test("Google's refusal is worded by its status, and the document path it quotes never reaches the agent", async () => {
    const { provider } = await open(
      READ_ONLY,
      googleServer(undefined, () =>
        jsonAnswer(
          {
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: `Missing permission on ${PROVIDER_DOCS}/users/bob`,
            },
          },
          403,
        ),
      ),
    );
    const error = await rejected(
      provider.queryReadOnly('db.doc("users/alice").get()', budget(new RunReadAllowance(10))),
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(F.denied);
    expect(error.message).not.toContain("bob");
  });

  test("the read's own deadline is the time budget's refusal", async () => {
    const { provider, seams } = await open(READ_ONLY, googleServer(undefined, HANG));
    const reading = provider.queryReadOnly("db.listCollections()", budget(new RunReadAllowance(10)));
    await Promise.resolve();
    const index = seams.deadlines.map((deadline) => deadline.ms).lastIndexOf(4_000);
    expect(index).toBeGreaterThanOrEqual(0);
    seams.fireDeadline(index);
    expect((await rejected(reading)).message).toBe(`${TIME_BUDGET_PREFIX}: no answer within 4000ms`);
  });

  test("a probe refused by Google on an agent-mode handle is worded by category; Studio's own probe sentences pass", async () => {
    const refusedProbe: WireHandler = (request) =>
      isProbe(request)
        ? jsonAnswer({ error: { code: 403, status: "PERMISSION_DENIED", message: "users/bob is mentioned" } }, 403)
        : jsonAnswer({});
    for (const execution of [READ_ONLY, OPERATIONS]) {
      const seams = fakeSeams({ answer: wire(refusedProbe) });
      const provider = new FirestoreProvider(firestoreConnection(), { queryTimeout: 30_000 }, execution, seams);
      const error = await rejected(provider.connect());
      expect(error.message).toBe(F.denied);
    }
    const datastore: WireHandler = googleServer({ type: "DATASTORE_MODE" });
    const seams = fakeSeams({ answer: wire(datastore) });
    const provider = new FirestoreProvider(firestoreConnection(), { queryTimeout: 30_000 }, READ_ONLY, seams);
    expect((await rejected(provider.connect())).message).toContain("Datastore mode");
  });
});

describe("every other surface of an agent-mode handle", () => {
  test.each([
    ["the agent read-only profile", READ_ONLY],
    ["the operations profile", OPERATIONS],
  ])(
    "on %s: the grounding reads collection ids within the allowance, and nothing without one",
    async (_name, execution) => {
      const { provider, afterProbe } = await open(execution);
      // No allowance: the count is its reason, and nothing is sent.
      expect(await provider.countObjects([])).toEqual({ collection: { unavailable: W.noAllowance } });
      expect((await rejected(provider.listObjects([], "collection"))).message).toBe(W.noAllowance);
      expect((await rejected(provider.describeObjects([], "collection", 10))).message).toBe(W.noAllowance);
      expect(afterProbe()).toEqual([]);

      const allowance = new RunReadAllowance(10);
      expect(await provider.countObjects([], { readAllowance: allowance })).toEqual({ collection: { count: 2 } });
      expect(await provider.listObjects([], "collection", { readAllowance: allowance })).toEqual([
        { path: ["orders"], name: "orders", kind: "collection" },
        { path: ["users"], name: "users", kind: "collection" },
      ]);
      const described = await provider.describeObjects([], "collection", 10, { readAllowance: allowance });
      expect(described.details.map((detail) => detail.columns.map((column) => column.name))).toEqual([
        ["__name__"],
        ["__name__"],
      ]);
      expect(allowance.spent()).toBe(3);
      expect(afterProbe().every((request) => request.path === `${BASE}:listCollectionIds`)).toBe(true);
    },
  );

  test("documents, fields, the Keys panel, the Source tab and the console are refused with their reasons", async () => {
    const { provider, afterProbe } = await open(OPERATIONS);
    const allowance = new RunReadAllowance(10);
    expect((await rejected(provider.listObjects([], "document", { readAllowance: allowance }))).message).toBe(
      W.documents,
    );
    expect(await provider.describeObjects([], "document", 10, { readAllowance: allowance })).toEqual({ details: [] });
    expect((await rejected(provider.describeObject(["users"], "collection"))).message).toBe(W.fields);
    expect((await rejected(provider.readObjectSource(["users/alice"], "document"))).message).toBe(W.source);
    expect((await rejected(provider.scanKeysPage({ cursor: "0", count: 10 }))).message).toBe(W.keys);
    const consoleError = await rejected(provider.query('db.doc("users/alice").get()'));
    expect(consoleError).toBeInstanceOf(RefusedBeforeSendError);
    expect(consoleError.message).toBe(W.query);
    expect(afterProbe()).toEqual([]);
    expect(allowance.spent()).toBe(0);
  });

  test("a container or an unknown kind is refused before anything is sent", async () => {
    const { provider, afterProbe } = await open(OPERATIONS);
    const allowance = new RunReadAllowance(10);
    await expect(provider.countObjects(["x"], { readAllowance: allowance })).rejects.toThrow("no container level");
    await expect(provider.listObjects([], "index", { readAllowance: allowance })).rejects.toThrow(
      'no object kind "index"',
    );
    await expect(provider.describeObjects([], "index", 1, { readAllowance: allowance })).rejects.toThrow(
      'no object kind "index"',
    );
    expect(afterProbe()).toEqual([]);
  });

  test("every Operate reading Firestore does not report answers its reason, never an empty reading", async () => {
    const { provider, afterProbe } = await open(OPERATIONS);
    expect((await rejected(provider.getOverview())).message).toBe(W.overview);
    expect((await rejected(provider.getPerformanceMetrics())).message).toBe(W.performance);
    expect((await rejected(provider.getSlowQueries())).message).toBe(W.slowQueries);
    expect((await rejected(provider.getActiveSessions())).message).toBe(W.sessions);
    expect((await rejected(provider.getTableStats())).message).toBe(W.tableStats);
    expect((await rejected(provider.getIndexStats())).message).toBe(W.indexStats);
    expect((await rejected(provider.getStorageStats())).message).toBe(W.storage);
    expect((await provider.getHealth()).databaseSize).toBe(W.databaseSize);
    expect(afterProbe()).toEqual([]);
  });

  test("a failure of a grounding listing is worded by category", async () => {
    const { provider } = await open(
      OPERATIONS,
      googleServer(undefined, () =>
        jsonAnswer({ error: { code: 404, status: "NOT_FOUND", message: "users/bob is gone" } }, 404),
      ),
    );
    const error = await rejected(provider.listObjects([], "collection", { readAllowance: new RunReadAllowance(5) }));
    expect(error.message).toBe(F.notFound);
  });

  test("on the emulator the agent reads go to the emulator lane and are charged the same", async () => {
    const { provider, seams } = await open(
      READ_ONLY,
      (request) =>
        request.path.endsWith(":listCollectionIds") ? jsonAnswer({ collectionIds: ["users"] }) : jsonAnswer({}),
      EMULATOR,
    );
    const allowance = new RunReadAllowance(10);
    await provider.queryReadOnly("db.listCollections()", budget(allowance));
    expect(allowance.spent()).toBe(1);
    expect(requestsOf(seams).every((request) => request.lane === "emulator")).toBe(true);
  });
});

describe("the editor's handles keep every surface", () => {
  test("the tree lists collections with no allowance, the console reads documents, and Operate answers as before", async () => {
    const { provider, afterProbe } = await open({});
    expect(await provider.countObjects([])).toEqual({ collection: { count: 2 } });
    expect((await provider.getHealth()).databaseSize).toBe("N/A");
    expect(await provider.getTableStats()).toEqual([]);
    const result = await provider.query('db.doc("users/alice").get()');
    expect(JSON.stringify(result.rows)).toContain("marker-value-ssn");
    expect(afterProbe().length).toBeGreaterThan(1);
  });
});
