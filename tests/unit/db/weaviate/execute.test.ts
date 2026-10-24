/**
 * One Weaviate console request run end to end over a recording send (#1566 spec 3.3, 3.4, 5.7, 5.8, W6): the
 * collection read first, the tenant's own record before anything that names a tenant and a refusal unless it is HOT,
 * the path the version decides with the one fallback when a path is switched off, the path remembered for the
 * session, one permit for the whole request, one deadline fixed before the queue, and a cancel by `queryId`.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { ConnectionError, QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import type { WeaviateAnswer, WeaviateRequest } from "@/lib/db/providers/vector/weaviate/client";
import {
  executeWeaviate,
  type WeaviateExecution,
  type WeaviateFailure,
  type WeaviatePathState,
  weaviateDeadlineMs,
} from "@/lib/db/providers/vector/weaviate/execute";
import type { WeaviatePath, WeaviatePathKind } from "@/lib/db/providers/vector/weaviate/versions";
import {
  createRunRegistry,
  DuplicateRunError,
  engineLimiter,
  LimiterFullError,
  type ProviderLimiter,
} from "@/lib/db/utils/bounded-limiter";
import { expectCalls, type LoggedCall } from "../../../helpers/call-log";
import {
  type Answering,
  capturedServer,
  GRAPHQL_DISABLED,
  hanging,
  json,
  overriding,
  REST_SEARCH_DISABLED,
  rejection,
  routeAbsent,
  version,
} from "../../../helpers/weaviate-surface";

let keys = 0;
const freshLimiter = (perProvider = 4) => {
  keys += 1;
  return engineLimiter(`weaviate-execute-test-${keys}`, { perProvider, perEngine: 16, queueDepth: 64 })();
};

const REST = capturedServer("weaviate/searches.json");
const GRAPHQL = capturedServer("weaviate-1-38/searches.json");
const READS = capturedServer("weaviate/reads.json");

/** A 1.40 server for REST searches and a 1.38 one for GraphQL, the two answering the same seeded data. */
const BOTH: Answering = (request) => (request.op === "graphql" ? GRAPHQL(request) : REST(request));

function memory(initial: Partial<Record<WeaviatePathKind, WeaviatePath>> = {}): WeaviatePathState & {
  readonly known: Map<WeaviatePathKind, WeaviatePath>;
} {
  const known = new Map(Object.entries(initial) as [WeaviatePathKind, WeaviatePath][]);
  return { known, get: (kind) => known.get(kind), set: (kind, path) => void known.set(kind, path) };
}

interface Recording {
  readonly calls: LoggedCall[];
  readonly failures: WeaviateFailure[];
  readonly run: WeaviateExecution;
  readonly paths: ReturnType<typeof memory>;
  inFlight: number;
  maxInFlight: number;
}

function recording(answering: Answering, overrides: Partial<WeaviateExecution> = {}): Recording {
  const paths = memory();
  const record: Recording = {
    calls: [],
    failures: [],
    paths,
    inFlight: 0,
    maxInFlight: 0,
    run: undefined as unknown as WeaviateExecution,
  };
  const send = async (request: WeaviateRequest, signal: AbortSignal): Promise<WeaviateAnswer> => {
    record.calls.push({ method: request.op, args: [request] });
    record.inFlight += 1;
    record.maxInFlight = Math.max(record.maxInFlight, record.inFlight);
    try {
      return await answering(request, signal);
    } finally {
      record.inFlight -= 1;
    }
  };
  (record as { run: WeaviateExecution }).run = {
    send,
    limiter: freshLimiter(),
    runs: createRunRegistry(),
    version: version("1.40.2"),
    paths,
    fail: (failure) => {
      record.failures.push(failure);
      return new QueryError(
        failure.kind === "answer" ? `answer ${failure.answer.status} to ${failure.op}` : `thrown by ${failure.op}`,
      );
    },
    now: () => 0,
    deadline: () => new AbortController().signal,
    ...overrides,
  };
  return record;
}

const sent = (record: Recording, index: number): WeaviateRequest =>
  record.calls.at(index)?.args?.[0] as WeaviateRequest;
const ops = (record: Recording) => record.calls.map((call) => call.method);

const BM25 =
  'POST /v1/search/Article/bm25 {"query": "vector", "limit": 3, "returnProperties": ["title", "wordCount"], "returnMetadata": ["score"]}';
const BM25_REST = '{"query":"vector","limit":3,"returnProperties":["title","wordCount"],"returnMetadata":["score"]}';
const BM25_GRAPHQL = JSON.stringify({
  query: '{Get{Article(bm25:{query:"vector"},limit:3){title wordCount _additional{id score}}}}',
});
const VECTOR = "[0.1,-0.2,0.3,0.4,-0.5,0.6,0.7,-0.8,0.9,0.1,0.2,-0.3,0.4,0.5,-0.6,0.7]";
const NEAR_VECTOR = `POST /v1/search/Article/near-vector {"vector": ${VECTOR}, "limit": 2, "returnProperties": ["title"], "returnMetadata": ["distance"]}`;
const COLLECTION_READ = { op: "collection", params: { collection: "Article" }, query: {} };

describe("the deadline", () => {
  test("10 s for a metadata route and 30 s for a read, a search or an aggregate", () => {
    for (const op of [
      "meta",
      "schema",
      "collection",
      "shards",
      "tenants",
      "tenant",
      "aliases",
      "alias",
      "nodes",
    ] as const)
      expect(weaviateDeadlineMs(op, undefined), op).toBe(10_000);
    expect(weaviateDeadlineMs("collection_nodes", undefined)).toBe(10_000);
    for (const op of ["objects", "object", "search_bm25", "search_near_vector", "aggregate"] as const)
      expect(weaviateDeadlineMs(op, undefined), op).toBe(30_000);
  });

  test("at most the connection's query timeout; a missing or non-positive timeout bounds nothing", () => {
    expect(weaviateDeadlineMs("search_bm25", 5_000)).toBe(5_000);
    expect(weaviateDeadlineMs("meta", 60_000)).toBe(10_000);
    expect(weaviateDeadlineMs("search_bm25", 0)).toBe(30_000);
    expect(weaviateDeadlineMs("search_bm25", -1)).toBe(30_000);
  });

  test("the deadline is asked for once, before the queue, with the route's bound", async () => {
    const asked: number[] = [];
    const record = recording(READS, {
      queryTimeoutMs: 20_000,
      deadline: (ms) => {
        asked.push(ms);
        return new AbortController().signal;
      },
    });
    await executeWeaviate("GET /v1/objects?class=Article&limit=3", undefined, record.run);
    await executeWeaviate("GET /v1/meta", undefined, record.run);
    expect(asked).toEqual([20_000, 10_000]);
  });

  test("without an injected deadline the run still answers, on its own timer", async () => {
    const record = recording(READS, { deadline: undefined, now: undefined });
    const result = await executeWeaviate("GET /v1/meta", undefined, record.run);
    expect(result.rowCount).toBe(1);
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });
});

describe("the calls a request makes", () => {
  test("a route that names no collection is one call, and its answer is the result", async () => {
    const record = recording(READS, {
      now: (() => {
        let tick = 0;
        return () => (tick += 7);
      })(),
    });
    const result = await executeWeaviate("GET /v1/meta", undefined, record.run);
    expectCalls(record.calls, [{ method: "meta", args: [{ op: "meta", params: {}, query: {} }] }]);
    expect(result.fields).toContain("version");
    expect(result.rows[0]?.version).toBe("1.40.2");
    expect(result.executionTime).toBe(7);
  });

  test("GET /v1/schema/{collection} is its own definition read, sent once", async () => {
    const record = recording(READS);
    const result = await executeWeaviate("GET /v1/schema/Article", undefined, record.run);
    expectCalls(record.calls, [{ method: "collection", args: [COLLECTION_READ] }]);
    expect(result.rows[0]?.class).toBe("Article");
    expect(result.warnings).toBeUndefined();
  });

  test("a route that reads a collection reads its definition first, then itself", async () => {
    const record = recording(READS);
    const result = await executeWeaviate("GET /v1/schema/Article/shards", undefined, record.run);
    expectCalls(record.calls, [
      { method: "collection", args: [COLLECTION_READ] },
      { method: "shards", args: [{ op: "shards", params: { collection: "Article" }, query: {} }] },
    ]);
    expect(result.rows[0]?.status).toBe("READY");
  });

  test("an object list sends its query with no path parameter, the defaults written in", async () => {
    const record = recording(READS);
    await executeWeaviate("GET /v1/objects?class=Empty", undefined, record.run);
    expect(sent(record, 1)).toEqual({ op: "objects", params: {}, query: { class: "Empty", limit: "25" } });
  });

  test("a failed definition read is the request's failure, and nothing more is sent", async () => {
    const record = recording(READS);
    const error = await rejection(executeWeaviate("GET /v1/objects?class=Missing&limit=2", undefined, record.run));
    expect((error as Error).message).toBe("answer 404 to collection");
    expect(record.failures).toEqual([
      { kind: "answer", op: "collection", answer: expect.objectContaining({ status: 404 }) },
    ]);
    expectCalls(record.calls, ["collection"]);
  });

  test("a phase 0 refusal makes no call", async () => {
    const record = recording(READS);
    const error = await rejection(
      executeWeaviate('POST /v1/search/Article/hybrid {"query": "x", "alpha": 0.5}', undefined, record.run),
    );
    expect(error).toBeInstanceOf(RequestRefusal);
    expect((error as RequestRefusal).phase).toBe(0);
    expectCalls(record.calls, []);
  });

  test("a phase 1 refusal holds exactly the definition read", async () => {
    const record = recording(READS);
    const error = await rejection(executeWeaviate("GET /v1/objects?class=TenantNotes&limit=2", undefined, record.run));
    expect(error).toBeInstanceOf(RequestRefusal);
    expect((error as RequestRefusal).phase).toBe(1);
    expectCalls(record.calls, ["collection"]);
  });
});

describe("the tenant guard", () => {
  const TENANT_READ = (tenant: string) => ({
    op: "tenant",
    params: { collection: "TenantNotes", tenant },
    query: {},
  });

  test("a HOT tenant is looked up by its own record, then read", async () => {
    const record = recording(READS);
    const result = await executeWeaviate(
      "GET /v1/objects?class=TenantNotes&limit=2&tenant=acme",
      undefined,
      record.run,
    );
    expectCalls(record.calls, [
      "collection",
      { method: "tenant", args: [TENANT_READ("acme")] },
      {
        method: "objects",
        args: [{ op: "objects", params: {}, query: { class: "TenantNotes", limit: "2", tenant: "acme" } }],
      },
    ]);
    expect(result.rowCount).toBe(2);
  });

  test("ACTIVE, HOT's older name, is read too", async () => {
    const record = recording(overriding(READS, { tenant: () => json({ name: "acme", activityStatus: "ACTIVE" }) }));
    await executeWeaviate("GET /v1/objects?class=TenantNotes&limit=2&tenant=acme", undefined, record.run);
    expect(ops(record)).toEqual(["collection", "tenant", "objects"]);
  });

  test("a COLD tenant is refused after its record, naming its status, and nothing names it again", async () => {
    const record = recording(READS);
    const error = await rejection(
      executeWeaviate("GET /v1/objects?class=TenantNotes&limit=2&tenant=initech", undefined, record.run),
    );
    expect(error).toBeInstanceOf(RequestRefusal);
    expect((error as RequestRefusal).phase).toBe(1);
    expect((error as RequestRefusal).key).toBe("tenant");
    expect((error as Error).message).toBe(
      'The tenant "initech" is COLD. Studio does not activate a tenant by reading it, so nothing was read: set the tenant HOT on the server first.',
    );
    expectCalls(record.calls, ["collection", { method: "tenant", args: [TENANT_READ("initech")] }]);
  });

  test("a tenant named in a search body is guarded the same way", async () => {
    const record = recording(overriding(BOTH, { tenant: () => json({ name: "acme", activityStatus: "FROZEN" }) }));
    const error = await rejection(
      executeWeaviate('POST /v1/search/TenantNotes/bm25 {"query": "note", "tenant": "acme"}', undefined, record.run),
    );
    expect((error as Error).message).toStartWith('The tenant "acme" is FROZEN.');
    expect(ops(record)).toEqual(["collection", "tenant"]);
  });

  test("a record that is not JSON, or names no status, reads as UNKNOWN and is refused", async () => {
    for (const text of ["not json", '{"name":"acme"}', "null"]) {
      const record = recording(overriding(READS, { tenant: () => ({ ...json({}), text }) }));
      // oxlint-disable-next-line no-await-in-loop -- each case has its own log.
      const error = await rejection(
        executeWeaviate("GET /v1/objects?class=TenantNotes&limit=2&tenant=acme", undefined, record.run),
      );
      expect((error as Error).message, text).toStartWith('The tenant "acme" is UNKNOWN.');
      expect(ops(record)).toEqual(["collection", "tenant"]);
    }
  });

  test("the tenant route reads its record once, as the answer, with no guard read before it", async () => {
    const record = recording(READS);
    const result = await executeWeaviate("GET /v1/schema/TenantNotes/tenants/initech", undefined, record.run);
    expectCalls(record.calls, ["collection", { method: "tenant", args: [TENANT_READ("initech")] }]);
    expect(result.rows[0]?.activityStatus).toBe("COLD");
  });

  test("an unknown tenant's 404 is the request's failure", async () => {
    const record = recording(overriding(READS, { tenant: () => json("", 404) }));
    const error = await rejection(
      executeWeaviate("GET /v1/objects?class=TenantNotes&limit=2&tenant=nobody", undefined, record.run),
    );
    expect((error as Error).message).toBe("answer 404 to tenant");
    expect(ops(record)).toEqual(["collection", "tenant"]);
  });
});

describe("the path the version decides", () => {
  const pathOf = async (serverVersion: string, text: string) => {
    const record = recording(BOTH, { version: version(serverVersion) });
    const result = await executeWeaviate(text, undefined, record.run);
    return { record, result, op: sent(record, 1).op };
  };

  test("1.40.2 sends bm25 and near-vector over REST", async () => {
    const bm25 = await pathOf("1.40.2", BM25);
    expect(sent(bm25.record, 1)).toEqual({
      op: "search_bm25",
      params: { collection: "Article" },
      query: {},
      body: BM25_REST,
    });
    expect(bm25.result.warnings).toEqual([{ message: "Answered via REST search." }]);
    expect((await pathOf("1.40.2", NEAR_VECTOR)).op).toBe("search_near_vector");
  });

  test("1.39.7 sends bm25 over REST and near-vector over GraphQL; 1.39.8 sends both over REST", async () => {
    expect((await pathOf("1.39.7", BM25)).op).toBe("search_bm25");
    expect((await pathOf("1.39.7", NEAR_VECTOR)).op).toBe("graphql");
    expect((await pathOf("1.39.8", NEAR_VECTOR)).op).toBe("search_near_vector");
  });

  test("below 1.39.7, and on a version that cannot be read, a search goes over GraphQL", async () => {
    for (const serverVersion of ["1.39.6", "1.38.22", "1.37.4", "1.41.0-rc.1", "weaviate"]) {
      // oxlint-disable-next-line no-await-in-loop -- each version has its own log.
      const { record, result } = await pathOf(serverVersion, BM25);
      expect(sent(record, 1), serverVersion).toEqual({ op: "graphql", params: {}, query: {}, body: BM25_GRAPHQL });
      expect(result.warnings).toEqual([{ message: "Answered via GraphQL." }]);
    }
  });

  test("both paths answer the same rows", async () => {
    const rest = await pathOf("1.40.2", NEAR_VECTOR);
    const graphql = await pathOf("1.38.22", NEAR_VECTOR);
    expect(graphql.result.fields).toEqual(rest.result.fields);
    expect(graphql.result.rows.map((row) => row.$id)).toEqual(rest.result.rows.map((row) => row.$id));
  });

  test("the path that answered is remembered per kind, and the next search goes straight to it", async () => {
    const record = recording(BOTH, { version: version("1.39.7") });
    await executeWeaviate(BM25, undefined, record.run);
    await executeWeaviate(NEAR_VECTOR, undefined, record.run);
    expect([...record.paths.known]).toEqual([
      ["other", "rest"],
      ["near-vector", "graphql"],
    ]);
    const remembered = recording(BOTH, { version: version("1.40.2"), paths: memory({ other: "graphql" }) });
    await executeWeaviate(BM25, undefined, remembered.run);
    expect(ops(remembered)).toEqual(["collection", "graphql"]);
  });
});

describe("the one fallback", () => {
  test("GraphQL disabled on 1.39.0 to 1.39.6: the search is sent once more over REST, and REST is remembered", async () => {
    const record = recording(overriding(BOTH, { graphql: () => GRAPHQL_DISABLED }), { version: version("1.39.6") });
    const result = await executeWeaviate(BM25, undefined, record.run);
    expect(ops(record)).toEqual(["collection", "graphql", "search_bm25"]);
    expect(result.warnings).toEqual([{ message: "Answered via REST search." }]);
    expect(record.paths.get("other")).toBe("rest");
    const next = recording(BOTH, { version: version("1.39.6"), paths: record.paths });
    await executeWeaviate(BM25, undefined, next.run);
    expect(ops(next)).toEqual(["collection", "search_bm25"]);
  });

  test("a server that has neither path is refused with one sentence naming its version", async () => {
    const cases: [string, WeaviateAnswer][] = [
      ["1.39.0", routeAbsent("/v1/search/Article/bm25")],
      ["1.39.6", REST_SEARCH_DISABLED],
    ];
    for (const [serverVersion, restAnswer] of cases) {
      const record = recording(overriding(BOTH, { graphql: () => GRAPHQL_DISABLED, search_bm25: () => restAnswer }), {
        version: version(serverVersion),
      });
      // oxlint-disable-next-line no-await-in-loop -- each server has its own log.
      const error = await rejection(executeWeaviate(BM25, undefined, record.run));
      expect(error).toBeInstanceOf(RequestRefusal);
      expect((error as RequestRefusal).phase).toBe(1);
      expect((error as Error).message).toBe(
        `This Weaviate server (${serverVersion}) serves this search neither over REST search, which it lacks or keeps behind EXPERIMENTAL_REST_SEARCH_ENABLED, nor over GraphQL, which it has disabled. Browsing the collections still works.`,
      );
      expect(ops(record)).toEqual(["collection", "graphql", "search_bm25"]);
      expect(record.paths.known.size).toBe(0);
    }
  });

  test("a REST route the server lacks falls back to GraphQL", async () => {
    const record = recording(overriding(BOTH, { search_bm25: () => routeAbsent("/v1/search/Article/bm25") }), {
      version: version("1.40.2"),
    });
    const result = await executeWeaviate(BM25, undefined, record.run);
    expect(ops(record)).toEqual(["collection", "search_bm25", "graphql"]);
    expect(result.warnings).toEqual([{ message: "Answered via GraphQL." }]);
    expect(record.paths.get("other")).toBe("graphql");
  });

  test("a fallback that fails otherwise is that path's failure", async () => {
    const record = recording(
      overriding(BOTH, {
        graphql: () => GRAPHQL_DISABLED,
        search_bm25: () => json({ error: [{ message: "bad" }] }, 500),
      }),
      { version: version("1.38.22") },
    );
    expect(((await rejection(executeWeaviate(BM25, undefined, record.run))) as Error).message).toBe(
      "answer 500 to search_bm25",
    );
  });

  test("any other failure is not a fallback: one call, worded by its path", async () => {
    const rest = recording(overriding(BOTH, { search_bm25: () => json({ error: [{ message: "bad" }] }, 422) }));
    expect(((await rejection(executeWeaviate(BM25, undefined, rest.run))) as Error).message).toBe(
      "answer 422 to search_bm25",
    );
    expect(ops(rest)).toEqual(["collection", "search_bm25"]);
    const graphqlErrors = json({ errors: [{ message: "Cannot query field" }] });
    const graphql = recording(overriding(BOTH, { graphql: () => graphqlErrors }), { version: version("1.38.22") });
    expect(((await rejection(executeWeaviate(BM25, undefined, graphql.run))) as Error).message).toBe(
      "answer 200 to graphql",
    );
    expect(graphql.failures).toEqual([{ kind: "answer", op: "graphql", answer: graphqlErrors }]);
    expect(ops(graphql)).toEqual(["collection", "graphql"]);
    expect(graphql.paths.known.size).toBe(0);
  });
});

describe("one permit, one deadline, one cancel", () => {
  test("a request holds one permit for all its calls: a second request waits for the first to end", async () => {
    const limiter = freshLimiter(1);
    const order: string[] = [];
    const answering: Answering = async (request) => {
      order.push(`start ${request.op}`);
      await Bun.sleep(1);
      order.push(`end ${request.op}`);
      return REST(request);
    };
    const first = recording(answering, { limiter });
    const second = recording(answering, { limiter });
    await Promise.all([
      executeWeaviate(BM25, undefined, first.run),
      executeWeaviate("GET /v1/schema/Article", undefined, second.run),
    ]);
    expect(order).toEqual([
      "start collection",
      "end collection",
      "start search_bm25",
      "end search_bm25",
      "start collection",
      "end collection",
    ]);
  });

  test("a cancel by queryId aborts the running call with QueryCancelledError and frees the run", async () => {
    const record = recording(overriding(BOTH, { search_bm25: hanging }));
    const running = executeWeaviate(BM25, "q-1", record.run);
    await Bun.sleep(1);
    expect(record.run.runs.cancel("q-1")).toBe(true);
    const error = await rejection(running);
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(record.failures).toEqual([]);
    expect(record.run.runs.runsInFlight()).toBe(0);
    expect(record.run.runs.cancel("q-1")).toBe(false);
  });

  test("a queryId already running is refused before anything is sent", async () => {
    const record = recording(overriding(BOTH, { search_bm25: hanging }));
    const running = executeWeaviate(BM25, "q-2", record.run);
    expect(await rejection(executeWeaviate("GET /v1/meta", "q-2", record.run))).toBeInstanceOf(DuplicateRunError);
    record.run.runs.cancel("q-2");
    await rejection(running);
    expect(ops(record)).toEqual(["collection", "search_bm25"]);
  });

  test("the deadline aborts the running call as a TimeoutError naming its seconds", async () => {
    const deadline = new AbortController();
    const record = recording(overriding(READS, { objects: hanging }), { deadline: () => deadline.signal });
    const running = executeWeaviate("GET /v1/objects?class=Article&limit=3", undefined, record.run);
    await Bun.sleep(1);
    deadline.abort(new DOMException("timed out", "TimeoutError"));
    const error = await rejection(running);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe("The request did not finish within its 30 s deadline.");
    expect(record.failures).toEqual([]);
  });

  test("the deadline also bounds the queue: a request that never got its permit times out", async () => {
    const deadline = new AbortController();
    const queued: ProviderLimiter = {
      acquire: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    const record = recording(READS, { limiter: queued, deadline: () => deadline.signal, queryTimeoutMs: 4_000 });
    const running = executeWeaviate("GET /v1/meta", undefined, record.run);
    deadline.abort(new DOMException("timed out", "TimeoutError"));
    const error = await rejection(running);
    expect((error as Error).message).toBe("The request did not finish within its 4 s deadline.");
    expectCalls(record.calls, []);
  });

  test("a cancel while queued is a QueryCancelledError, and nothing is sent", async () => {
    const queued: ProviderLimiter = {
      acquire: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    const record = recording(READS, { limiter: queued });
    const running = executeWeaviate("GET /v1/meta", "q-3", record.run);
    record.run.runs.cancel("q-3");
    expect(await rejection(running)).toBeInstanceOf(QueryCancelledError);
    expectCalls(record.calls, []);
  });

  test("a full queue is refused as the limiter words it, and nothing is sent", async () => {
    const full = new LimiterFullError("The queue is full.");
    const record = recording(READS, { limiter: { acquire: () => Promise.reject(full) } });
    expect(await rejection(executeWeaviate("GET /v1/meta", undefined, record.run))).toBe(full);
    expectCalls(record.calls, []);
    expect(record.run.runs.runsInFlight()).toBe(0);
  });

  test("a transport failure is handed to errors.ts as thrown, with the operation that met it", async () => {
    const refused = new TransportError("network", "socket hang up");
    const record = recording(overriding(READS, { meta: () => Promise.reject(refused) }));
    expect(((await rejection(executeWeaviate("GET /v1/meta", undefined, record.run))) as Error).message).toBe(
      "thrown by meta",
    );
    expect(record.failures).toEqual([{ kind: "thrown", op: "meta", error: refused }]);
  });

  test("an unreachable endpoint is worded as such even when the deadline has passed", async () => {
    const deadline = new AbortController();
    const unreachable = new TransportError("unreachable", "Weaviate at 127.0.0.1:8080 did not answer within 10 s.");
    const record = recording(
      overriding(READS, {
        meta: () => {
          deadline.abort();
          return Promise.reject(unreachable);
        },
      }),
      {
        deadline: () => deadline.signal,
        fail: (failure) => new ConnectionError((failure as { error: Error }).error.message, "weaviate"),
      },
    );
    const error = await rejection(executeWeaviate("GET /v1/meta", undefined, record.run));
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toBe("Weaviate at 127.0.0.1:8080 did not answer within 10 s.");
  });

  test("the permit is released and the run ended on every outcome", async () => {
    const limiter = freshLimiter(1);
    const failing = recording(overriding(READS, { meta: () => json({}, 500) }), { limiter });
    await rejection(executeWeaviate("GET /v1/meta", undefined, failing.run));
    const refused = recording(READS, { limiter, runs: failing.run.runs });
    await rejection(
      executeWeaviate("GET /v1/objects?class=TenantNotes&limit=2&tenant=initech", undefined, refused.run),
    );
    const after = recording(READS, { limiter, runs: failing.run.runs });
    expect((await executeWeaviate("GET /v1/meta", undefined, after.run)).rowCount).toBe(1);
    expect(failing.run.runs.runsInFlight()).toBe(0);
  });
});

describe("the aggregate", () => {
  test("a body-less aggregate is sent as {} over REST and as a meta count over GraphQL", async () => {
    const rest = recording(BOTH);
    const restResult = await executeWeaviate("POST /v1/aggregate/Article", undefined, rest.run);
    expect(sent(rest, 1)).toEqual({ op: "aggregate", params: { collection: "Article" }, query: {}, body: "{}" });
    expect(restResult.rows).toEqual([Object.assign(Object.create(null), { count: 500 })]);
    const graphql = recording(BOTH, { version: version("1.37.4") });
    const graphqlResult = await executeWeaviate("POST /v1/aggregate/Article", undefined, graphql.run);
    expect(sent(graphql, 1).body).toBe(JSON.stringify({ query: "{Aggregate{Article{meta{count}}}}" }));
    expect(graphqlResult.rows).toEqual(restResult.rows);
  });
});
