/**
 * One console request run end to end over a recording send (vector-family spec 3.6, 3.9, 6.6, QE12, QE15): phase 0
 * and the version gates make no call, phase 1 makes exactly its collection reads, the request holds one permit and
 * never two calls at once, one deadline covers the queue, the reads and the call, `timeout` is written from what
 * is left of it, and a run is cancelled by its `queryId`.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import type { QdrantAnswer, QdrantOp, QdrantRequest } from "@/lib/db/providers/vector/qdrant/client";
import {
  executeQdrant,
  type QdrantExecution,
  type QdrantFailure,
  qdrantDeadlineMs,
  qdrantServerTimeout,
} from "@/lib/db/providers/vector/qdrant/execute";
import { createRunRegistry, DuplicateRunError, engineLimiter } from "@/lib/db/utils/bounded-limiter";
import { expectCalls, type LoggedCall } from "../../../helpers/call-log";
import { capturedText, seededFacts } from "../../../helpers/qdrant-facts";

let keys = 0;
const freshLimiter = () => {
  keys += 1;
  return engineLimiter(`qdrant-execute-test-${keys}`, { perProvider: 4, perEngine: 16, queueDepth: 64 })();
};

const ok = (text: string): QdrantAnswer => ({ status: 200, contentType: "application/json", retryAfter: null, text });
const envelope = (result: string) => `{"result":${result},"status":"ok","time":0.001}`;

interface Recording {
  readonly calls: LoggedCall[];
  readonly run: QdrantExecution;
  inFlight: number;
  maxInFlight: number;
}

/** A run over a send that answers by operation, records every call, and a clock a test moves. */
function recording(
  answers: Partial<Record<QdrantOp, (request: QdrantRequest) => QdrantAnswer | Promise<QdrantAnswer>>>,
  overrides: Partial<QdrantExecution> = {},
): Recording {
  const record: Recording = {
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    run: undefined as unknown as QdrantExecution,
  };
  const send = async (request: QdrantRequest, signal: AbortSignal): Promise<QdrantAnswer> => {
    record.calls.push({ method: request.op, args: [request] });
    record.inFlight += 1;
    record.maxInFlight = Math.max(record.maxInFlight, record.inFlight);
    try {
      if (signal.aborted) throw new Error("aborted before it was sent");
      const answer = answers[request.op];
      if (answer === undefined) throw new Error(`no answer for ${request.op}`);
      return await answer(request);
    } finally {
      record.inFlight -= 1;
    }
  };
  (record as { run: QdrantExecution }).run = {
    send,
    limiter: freshLimiter(),
    runs: createRunRegistry(),
    version: "1.19.1",
    factsOf: () => seededFacts("docs"),
    fail: (failure: QdrantFailure) =>
      new QueryError(
        failure.kind === "answer" ? `answer ${failure.answer.status} to ${failure.op}` : `thrown by ${failure.op}`,
      ),
    now: () => 0,
    deadline: () => new AbortController().signal,
    ...overrides,
  };
  return record;
}

const describeDocs = () => ok(capturedText("describe-docs"));
const QUERY = 'POST /collections/docs/points/query\n{"query": 42, "using": "text", "limit": 3}';
const POINTS = envelope('{"points":[{"id":1,"score":0.9}]}');

/** The request a recorded call sent. */
const sent = (record: Recording, index: number): QdrantRequest => record.calls.at(index)?.args?.[0] as QdrantRequest;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("resolved");
}

describe("the phases and their calls", () => {
  test("a query reads its collection once, then sends the one execution call; never two in flight", async () => {
    const record = recording({ get_collection: describeDocs, query_points: () => ok(POINTS) });
    const result = await executeQdrant(QUERY, undefined, record.run);
    expect(result.rows).toEqual([Object.assign(Object.create(null), { id: "1", score: 0.9 })]);
    expectCalls(record.calls, [
      { method: "get_collection", args: [{ op: "get_collection", params: { collection_name: "docs" }, query: {} }] },
      {
        method: "query_points",
        args: [
          {
            op: "query_points",
            params: { collection_name: "docs" },
            query: { timeout: "29" },
            body: '{"query":42,"using":"text","limit":3}',
          },
        ],
      },
    ]);
    expect(record.maxInFlight).toBe(1);
  });

  test("a phase 0 refusal and a version gate make no call of any kind", async () => {
    const record = recording({}, { version: "1.18.3" });
    for (const text of [
      'POST /collections/docs/points/scroll\n{"fliter": {}}',
      'POST /collections/docs/points/query\n{"query": {"text": "t", "model": "openai/text-embedding-3-small"}}',
      'POST /collections/docs/points/query\n{"query": [0.1], "using": "text", "params": {"idf": "global"}}',
      "POST /collections/../points/count",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each case runs alone, so its call log is its own.
      const error = await rejection(executeQdrant(text, undefined, record.run));
      expect(error, text).toBeInstanceOf(RequestRefusal);
      expect((error as RequestRefusal).phase).toBe(0);
    }
    expectCalls(record.calls, []);
  });

  test("a phase 1 refusal makes exactly its collection read and no execution call", async () => {
    const record = recording({ get_collection: describeDocs });
    const error = await rejection(
      executeQdrant(
        'POST /collections/docs/points/query\n{"query": {"text": "t", "model": "bm25"}, "using": "text"}',
        undefined,
        record.run,
      ),
    );
    expect((error as RequestRefusal).phase).toBe(1);
    expectCalls(record.calls, ["get_collection"]);
  });

  test("a route that answers no points reads no collection", async () => {
    const record = recording({
      count_points: () => ok(envelope('{"count":3}')),
      get_collections: () => ok(envelope('{"collections":[]}')),
    });
    await executeQdrant("POST /collections/docs/points/count", undefined, record.run);
    await executeQdrant("GET /collections", undefined, record.run);
    expectCalls(record.calls, ["count_points", "get_collections"]);
    expect(sent(record, 0).query).toEqual({ timeout: "29" });
    expect(sent(record, 1).query).toEqual({});
  });

  test("a lookup_from collection is read once more, after the request's own", async () => {
    const record = recording({ get_collection: describeDocs, query_points: () => ok(POINTS) });
    await executeQdrant(
      'POST /collections/docs/points/query\n{"query": 42, "using": "text", "lookup_from": {"collection": "other"}}',
      undefined,
      record.run,
    );
    expectCalls(record.calls, [
      { method: "get_collection", args: [{ op: "get_collection", params: { collection_name: "docs" }, query: {} }] },
      { method: "get_collection", args: [{ op: "get_collection", params: { collection_name: "other" }, query: {} }] },
      "query_points",
    ]);
  });

  test("a failed answer is the error errors.ts words, and the execution call is not sent after a failed read", async () => {
    const record = recording({
      get_collection: () => ({ status: 404, contentType: "application/json", retryAfter: null, text: "{}" }),
    });
    const error = await rejection(executeQdrant(QUERY, undefined, record.run));
    expect((error as Error).message).toBe("answer 404 to get_collection");
    expectCalls(record.calls, ["get_collection"]);
    const thrown = recording({
      get_collection: describeDocs,
      query_points: () => Promise.reject(new Error("socket hang up")),
    });
    expect(((await rejection(executeQdrant(QUERY, undefined, thrown.run))) as Error).message).toBe(
      "thrown by query_points",
    );
  });
});

describe("the deadline and timeout (QE15)", () => {
  test("a metadata route has 10 s and a point read 30 s, at most the connection's query timeout", () => {
    expect(qdrantDeadlineMs("get_collections", undefined)).toBe(10_000);
    expect(qdrantDeadlineMs("query_points", undefined)).toBe(30_000);
    expect(qdrantDeadlineMs("query_points", 5_000)).toBe(5_000);
    expect(qdrantDeadlineMs("get_collection", 60_000)).toBe(10_000);
    expect(qdrantDeadlineMs("scroll_points", 0)).toBe(30_000);
  });

  test("timeout is max(1, floor(D) - 1) whole seconds; with D = 4.7 it is 3", () => {
    expect(qdrantServerTimeout(4_700)).toBe(3);
    expect(qdrantServerTimeout(30_000)).toBe(29);
    expect(qdrantServerTimeout(1_500)).toBe(1);
    expect(qdrantServerTimeout(0)).toBe(1);
  });

  test("timeout is on exactly the eight routes that declare it", async () => {
    const answers: Partial<Record<QdrantOp, () => QdrantAnswer>> = {
      root: () => ok('{"title":"qdrant","version":"1.19.1"}'),
      get_collections: () => ok(envelope('{"collections":[]}')),
      get_collection: describeDocs,
      collection_exists: () => ok(envelope('{"exists":true}')),
      get_collections_aliases: () => ok(envelope('{"aliases":[]}')),
      get_collection_aliases: () => ok(envelope('{"aliases":[]}')),
      get_points: () => ok(envelope("[]")),
      get_point: () => ok(envelope('{"id":42}')),
      scroll_points: () => ok(envelope('{"points":[],"next_page_offset":null}')),
      count_points: () => ok(envelope('{"count":0}')),
      facet: () => ok(envelope('{"hits":[]}')),
      query_points: () => ok(envelope('{"points":[]}')),
      query_batch_points: () => ok(envelope('[{"points":[]}]')),
      query_points_groups: () => ok(envelope('{"groups":[]}')),
      get_optimizations: () => ok(envelope("{}")),
      list_snapshots: () => ok(envelope("[]")),
      collection_cluster_info: () => ok(envelope('{"peer_id":1}')),
    };
    const texts: Readonly<Record<QdrantOp, string>> = {
      root: "GET /",
      get_collections: "GET /collections",
      get_collection: "GET /collections/docs",
      collection_exists: "GET /collections/docs/exists",
      get_collections_aliases: "GET /aliases",
      get_collection_aliases: "GET /collections/docs/aliases",
      get_points: 'POST /collections/docs/points\n{"ids": [1]}',
      get_point: "GET /collections/docs/points/42",
      scroll_points: "POST /collections/docs/points/scroll",
      count_points: "POST /collections/docs/points/count",
      facet: 'POST /collections/docs/facet\n{"key": "category"}',
      query_points: QUERY,
      query_batch_points: 'POST /collections/docs/points/query/batch\n{"searches": [{"query": 42, "using": "text"}]}',
      query_points_groups:
        'POST /collections/docs/points/query/groups\n{"query": 42, "using": "text", "group_by": "category"}',
      get_optimizations: "GET /collections/docs/optimizations",
      list_snapshots: "GET /collections/docs/snapshots",
      collection_cluster_info: "GET /collections/docs/cluster",
    };
    const withTimeout: string[] = [];
    for (const [op, text] of Object.entries(texts) as [QdrantOp, string][]) {
      const record = recording(answers);
      // oxlint-disable-next-line no-await-in-loop -- each case runs alone, so its call log is its own.
      await executeQdrant(text, undefined, record.run);
      const last = sent(record, -1);
      expect(last.op).toBe(op);
      if (last.query.timeout !== undefined) withTimeout.push(op);
    }
    expect(withTimeout.sort()).toEqual(
      [
        "get_points",
        "get_point",
        "scroll_points",
        "count_points",
        "facet",
        "query_points",
        "query_batch_points",
        "query_points_groups",
      ].sort(),
    );
  });

  test("a user's timeout above the ceiling is clamped to it, and one at or below it is kept", async () => {
    for (const [asked, expected] of [
      ["60", "29"],
      ["29", "29"],
      ["5", "5"],
    ]) {
      const record = recording({ count_points: () => ok(envelope('{"count":0}')) });
      // oxlint-disable-next-line no-await-in-loop -- each case runs alone, so its call log is its own.
      await executeQdrant(`POST /collections/docs/points/count?timeout=${asked}`, undefined, record.run);
      expect(sent(record, 0).query.timeout, asked).toBe(expected);
    }
  });

  test("a phase 1 read that takes 8 s of a 30 s deadline leaves D near 22 for the execution call", async () => {
    let clock = 0;
    const record = recording(
      {
        get_collection: () => {
          clock = 8_000;
          return describeDocs();
        },
        query_points: () => ok(POINTS),
      },
      { now: () => clock },
    );
    await executeQdrant(QUERY, undefined, record.run);
    expect(sent(record, 1).query.timeout).toBe("21");
  });

  test("a deadline that passes while the request waits or runs is the timeout sentence, and nothing more is sent", async () => {
    const controller = new AbortController();
    const record = recording(
      {
        get_collection: () => {
          controller.abort(new DOMException("timed out", "TimeoutError"));
          return Promise.reject(new Error("the transport saw the abort"));
        },
      },
      { deadline: () => controller.signal },
    );
    const error = await rejection(executeQdrant(QUERY, undefined, record.run));
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe("The request did not finish within its 30 s deadline.");
    expectCalls(record.calls, ["get_collection"]);
  });
});

describe("cancel and the run registry", () => {
  test("a run cancelled by its queryId while its call is in flight is cancelled, and the id is free again", async () => {
    let release: (answer: QdrantAnswer) => void = () => {};
    const record = recording({
      get_collection: describeDocs,
      query_points: (request) =>
        new Promise<QdrantAnswer>((resolve, reject) => {
          release = resolve;
          void request;
          setTimeout(() => reject(new Error("aborted by the signal")), 5);
        }),
    });
    const running = executeQdrant(QUERY, "q-1-abc", record.run);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(record.run.runs.cancel("q-1-abc")).toBe(true);
    const error = await rejection(running);
    expect(error).toBeInstanceOf(QueryCancelledError);
    release(ok(POINTS));
    expect(record.run.runs.cancel("q-1-abc")).toBe(false);
  });

  test("a queryId already running is refused with no call, and a malformed one too", async () => {
    let finish: (answer: QdrantAnswer) => void = () => {};
    const record = recording({
      get_collection: describeDocs,
      query_points: () =>
        new Promise<QdrantAnswer>((resolve) => {
          finish = resolve;
        }),
    });
    const first = executeQdrant(QUERY, "q-2-abc", record.run);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const calls = record.calls.length;
    expect(await rejection(executeQdrant(QUERY, "q-2-abc", record.run))).toBeInstanceOf(DuplicateRunError);
    expect(await rejection(executeQdrant(QUERY, "has space", record.run))).toBeInstanceOf(QueryError);
    expect(record.calls.length).toBe(calls);
    finish(ok(POINTS));
    await first;
  });

  test("a request queued behind the provider's bound and cancelled there leaves having sent nothing", async () => {
    const limiter = freshLimiter();
    const held = await Promise.all(Array.from({ length: 4 }, () => limiter.acquire(new AbortController().signal)));
    const record = recording({ get_collection: describeDocs, query_points: () => ok(POINTS) }, { limiter });
    const queued = executeQdrant(QUERY, "q-3-abc", record.run);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(record.run.runs.cancel("q-3-abc")).toBe(true);
    expect(await rejection(queued)).toBeInstanceOf(QueryCancelledError);
    expectCalls(record.calls, []);
    for (const ticket of held) ticket.release();
  });

  test("the permit is released when the request settles, a failed one included", async () => {
    const limiter = freshLimiter();
    const record = recording({ get_collection: () => Promise.reject(new Error("down")) }, { limiter });
    await rejection(executeQdrant(QUERY, undefined, record.run));
    const tickets = await Promise.all(Array.from({ length: 4 }, () => limiter.acquire(new AbortController().signal)));
    expect(tickets).toHaveLength(4);
    for (const ticket of tickets) ticket.release();
  });

  test("a full queue is the limiter's refusal, with no call", async () => {
    const limiter = engineLimiter(`qdrant-execute-full-${keys++}`, { perProvider: 1, perEngine: 1, queueDepth: 0 })();
    const held = await limiter.acquire(new AbortController().signal);
    const record = recording({}, { limiter });
    const error = await rejection(executeQdrant(QUERY, undefined, record.run));
    expect((error as Error).name).toBe("LimiterFullError");
    expectCalls(record.calls, []);
    held.release();
  });
});
