/**
 * What an agent's Firestore read sends and answers (`agent-metadata-read.ts`): each read of the closed table over the
 * agent's client, its answer projected to names, counts and flags, budgets that refuse rather than cut, and failures
 * worded by their category, never by Google's words.
 */
import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  ReadAllowanceExceededError,
  RefusedBeforeSendError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  createFirestoreAgentClient,
  FIRESTORE_AGENT_CLIENT_SENTENCES,
  type FirestoreAgentCall,
  studioWorded,
} from "@/lib/db/providers/document/firestore/agent-client";
import {
  FIRESTORE_AGENT_FAILURE_SENTENCES as F,
  FIRESTORE_METADATA_ONLY,
  type FirestoreAgentAnswer,
  firestoreAgentFailure,
  firestoreAgentResult,
  runFirestoreAgentRead,
} from "@/lib/db/providers/document/firestore/agent-metadata-read";
import type { FirestoreAgentPlan } from "@/lib/db/providers/document/firestore/agent-statement";
import { LIMITS } from "@/lib/db/providers/document/firestore/constants";
import { FIRESTORE_TRANSPORT_SENTENCES } from "@/lib/db/providers/document/firestore/transport";
import { ROW_BUDGET_PREFIX, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import { MetadataProjectionError } from "@/lib/db/redaction/metadata-only";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import {
  docName,
  FAKE_BASE,
  type FakeHandler,
  fakeFirestore,
  googleFailure,
} from "../../../helpers/firestore-fake-client";

const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 3, maxResultBytes: 10_000 };

function context(limit = 100) {
  const call: FirestoreAgentCall = {
    signal: new AbortController().signal,
    base: FAKE_BASE,
    allowance: new RunReadAllowance(limit),
  };
  return { budget: BUDGET, call };
}

function run(handler: FakeHandler, plan: FirestoreAgentPlan, limit = 100) {
  const fake = fakeFirestore(handler);
  const ctx = context(limit);
  return { fake, ctx, answer: runFirestoreAgentRead(createFirestoreAgentClient(fake.client), plan, ctx) };
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("the capability", () => {
  test("states each operation's columns and kinds, and nothing that names a document or a field", () => {
    expect(FIRESTORE_METADATA_ONLY).toEqual({
      "list-collections": [{ column: "collection", kind: "name" }],
      count: [
        { column: "collection", kind: "name" },
        { column: "documents", kind: "count" },
      ],
      document: [
        { column: "collection", kind: "name" },
        { column: "exists", kind: "flag" },
        { column: "created", kind: "name" },
        { column: "updated", kind: "name" },
      ],
    });
  });
});

describe("the collection id listing", () => {
  test("every id under the parent, in UTF-8 order, one page of at most the budget plus one", async () => {
    const { fake, answer } = run(() => ({ collectionIds: ["users", "orders", "Ａ-col"] }), {
      op: "list-collections",
      parent: [],
    });
    expect(await answer).toEqual({ op: "list-collections", ids: ["orders", "users", "Ａ-col"], skipped: 0 });
    expect(fake.sent.map(({ built }) => built.body)).toEqual(['{"pageSize":4}']);
  });

  test("reads each page with the token of the page before, and holds none of it afterwards", async () => {
    const pages = [{ collectionIds: ["a"], nextPageToken: "T1" }, { collectionIds: ["b"] }];
    const { fake, ctx, answer } = run(() => pages.shift(), { op: "list-collections", parent: ["users", "alice"] });
    expect(await answer).toEqual({ op: "list-collections", ids: ["a", "b"], skipped: 0 });
    expect(fake.sent.map(({ built }) => built.body)).toEqual(['{"pageSize":4}', '{"pageSize":4,"pageToken":"T1"}']);
    expect(ctx.call.allowance.spent()).toBe(2);
  });

  test("an id the id rules refuse is counted and not listed", async () => {
    const { answer } = run(() => ({ collectionIds: ["users", "__x__"] }), { op: "list-collections", parent: [] });
    const listed = await answer;
    expect(listed).toEqual({ op: "list-collections", ids: ["users"], skipped: 1 });
    expect(firestoreAgentResult(listed, BUDGET, 1).warnings).toEqual([{ message: F.skippedIds(1) }]);
    expect(F.skippedIds(2)).toBe(
      "2 collection ids break Firestore's id rules, so they are counted here and not listed.",
    );
  });

  test("more ids than the row budget are refused, never cut", async () => {
    const { answer } = run(() => ({ collectionIds: ["a", "b", "c", "d"] }), { op: "list-collections", parent: [] });
    expect((await rejected(answer)).message).toBe(`${ROW_BUDGET_PREFIX}: 4 rows > 3 allowed`);
  });

  test("a repeated page token is refused rather than read again", async () => {
    const { answer } = run(() => ({ collectionIds: [], nextPageToken: "T" }), { op: "list-collections", parent: [] });
    expect((await rejected(answer)).message).toBe(F.repeatedToken);
  });

  test("a listing past the id-listing cap is refused rather than answered in part", async () => {
    let served = 0;
    const { fake, answer } = run(
      () => {
        served += 1;
        return { collectionIds: [], nextPageToken: `T${served}` };
      },
      { op: "list-collections", parent: [] },
    );
    expect((await rejected(answer)).message).toBe(F.listingCut);
    expect(fake.sent).toHaveLength(LIMITS.idListingRequests);
  });
});

describe("the count", () => {
  const counted = (n: string) => () => [{ result: { aggregateFields: { count: { integerValue: n } } } }];

  test("a whole collection's count, asked to stop one past the budget, named by the collection's id", async () => {
    const { fake, answer } = run(counted("3"), {
      op: "count",
      source: { kind: "collection", path: ["users", "alice", "orders"] },
    });
    expect(await answer).toEqual({ op: "count", collection: "orders", documents: 3 });
    expect(fake.sent[0].built.body).toContain('"count":{"upTo":"4"}');
  });

  test("a collection group's count is named by its id", async () => {
    const { answer } = run(counted("0"), { op: "count", source: { kind: "collectionGroup", collectionId: "orders" } });
    expect(await answer).toEqual({ op: "count", collection: "orders", documents: 0 });
  });

  test("a count that reaches one past the budget is refused, never cut", async () => {
    const { answer } = run(counted("4"), { op: "count", source: { kind: "collection", path: ["users"] } });
    expect((await rejected(answer)).message).toBe(F.countOverRows(3));
    expect(F.countOverRows(3).startsWith(ROW_BUDGET_PREFIX)).toBe(true);
  });
});

describe("the document read", () => {
  test("existence and times, named by the collection the document sits in, never its path or id", async () => {
    const { answer } = run(
      () => [
        {
          found: {
            name: docName("users", "alice"),
            createTime: "2026-10-31T04:59:47.809191Z",
            updateTime: "2026-10-31T05:00:00Z",
          },
        },
      ],
      { op: "document", path: ["users", "alice"] },
    );
    const read = await answer;
    const result = firestoreAgentResult(read, BUDGET, 7);
    expect(result).toEqual({
      fields: ["collection", "exists", "created", "updated"],
      rows: [
        { collection: "users", exists: true, created: "2026-10-31T04:59:47.809191Z", updated: "2026-10-31T05:00:00Z" },
      ],
      rowCount: 1,
      executionTime: 7,
    });
    expect(JSON.stringify(result)).not.toContain("alice");
  });

  test("a missing document answers false and no times", async () => {
    const { answer } = run(() => [{ missing: docName("users", "nobody") }], {
      op: "document",
      path: ["users", "nobody"],
    });
    expect(firestoreAgentResult(await answer, BUDGET, 1).rows).toEqual([
      { collection: "users", exists: false, created: null, updated: null },
    ]);
  });

  test("a time that is not a server time is answered as null, never as the server's text", () => {
    const answer: FirestoreAgentAnswer = {
      op: "document",
      collection: "users",
      exists: true,
      createTime: "users/alice/secret",
      updateTime: "2026-10-31",
    };
    expect(firestoreAgentResult(answer, BUDGET, 1).rows).toEqual([
      { collection: "users", exists: true, created: null, updated: null },
    ]);
  });

  test("a server time followed by anything else is answered as null, and the rest never reaches the result", () => {
    const answer: FirestoreAgentAnswer = {
      op: "document",
      collection: "users",
      exists: true,
      createTime: "2024-01-01T00:00:00Zmarker",
      updateTime: "2024-01-01T00:00:00.5Z users/alice",
    };
    const result = firestoreAgentResult(answer, BUDGET, 1);
    expect(result.rows).toEqual([{ collection: "users", exists: true, created: null, updated: null }]);
    expect(JSON.stringify(result)).not.toContain("marker");
    expect(JSON.stringify(result)).not.toContain("alice");
  });
});

describe("the result", () => {
  test("rows from the declaration alone, with the listing's ids as rows", () => {
    expect(firestoreAgentResult({ op: "list-collections", ids: ["a", "b"], skipped: 0 }, BUDGET, 2)).toEqual({
      fields: ["collection"],
      rows: [{ collection: "a" }, { collection: "b" }],
      rowCount: 2,
      executionTime: 2,
    });
    expect(firestoreAgentResult({ op: "count", collection: "users", documents: 2 }, BUDGET, 1).rows).toEqual([
      { collection: "users", documents: 2 },
    ]);
  });

  test("an answer past the byte budget is refused, never cut", () => {
    const error = (() => {
      try {
        firestoreAgentResult(
          { op: "list-collections", ids: ["a", "b"], skipped: 0 },
          { ...BUDGET, maxResultBytes: 5 },
          1,
        );
      } catch (thrown) {
        return thrown as Error;
      }
      throw new Error("expected a refusal");
    })();
    expect(error.message).toMatch(/^Read-only execution exceeded the byte budget: \d+ bytes > 5 allowed$/);
    expect(firestoreAgentFailure(error, BUDGET, "s", false)).toBeUndefined();
  });

  test("an id that is not a name refuses the whole answer, naming the column and never the value", () => {
    expect(() =>
      firestoreAgentResult({ op: "list-collections", ids: ["x".repeat(513)], skipped: 0 }, BUDGET, 1),
    ).toThrow(MetadataProjectionError);
  });
});

describe("the wording of a failure", () => {
  const statusOf = (status: number, grpc: string) =>
    firestoreAgentFailure(
      googleFailure(status, grpc, "Document projects/p/databases/(default)/documents/users/alice"),
      BUDGET,
      "s",
      false,
    );

  test.each([
    [401, "UNAUTHENTICATED", F.denied],
    [403, "PERMISSION_DENIED", F.denied],
    [404, "NOT_FOUND", F.notFound],
    [400, "FAILED_PRECONDITION", F.invalid],
    [429, "RESOURCE_EXHAUSTED", F.quota],
    [500, "INTERNAL", F.status(500)],
    [503, "UNAVAILABLE", F.status(503)],
  ])("Google's %d is worded by its status, never by its message", (status, grpc, sentence) => {
    const worded = statusOf(status, grpc);
    expect(worded).toBeInstanceOf(QueryError);
    expect(worded?.message).toBe(sentence);
    expect(worded?.message).not.toContain("alice");
  });

  test("a stream that failed after it began is worded by its element's own code", () => {
    const error = googleFailure(200, "RESOURCE_EXHAUSTED", "quota for users/alice");
    expect(firestoreAgentFailure(error, BUDGET, "s", false)?.message).toBe(F.quota);
  });

  test.each([
    [403, "PERMISSION_DENIED", F.denied],
    [404, "NOT_FOUND", F.notFound],
  ])(
    "a stream answered 200 whose element carries %i is worded by that code, never as HTTP 200",
    (code, grpc, sentence) => {
      const error = googleFailure(200, grpc, "Document users/alice", undefined, code);
      const message = firestoreAgentFailure(error, BUDGET, "s", false)?.message;
      expect(message).toBe(sentence);
      expect(message).not.toContain("200");
    },
  );

  test("the read's own deadline and a transport timeout are the time budget's refusal", () => {
    const sentence = `${TIME_BUDGET_PREFIX}: no answer within 5000ms`;
    expect(firestoreAgentFailure(new QueryCancelledError("x"), BUDGET, "s", true)?.message).toBe(sentence);
    expect(firestoreAgentFailure(new TimeoutError("x", "firestore"), BUDGET, "s", false)?.message).toBe(sentence);
  });

  test("a cancel, a refused token, a transport failure and any other failure are worded by category", () => {
    expect(firestoreAgentFailure(new QueryCancelledError("x"), BUDGET, "s", false)?.message).toBe(F.closed);
    expect(firestoreAgentFailure(new AuthenticationError("Google said users/alice"), BUDGET, "s", false)?.message).toBe(
      F.credential,
    );
    expect(firestoreAgentFailure(new TransportError("network", "host 10.0.0.1"), BUDGET, "s", false)?.message).toBe(
      F.unreachable,
    );
    expect(firestoreAgentFailure(new DatabaseConfigError("users/alice"), BUDGET, "s", false)?.message).toBe(F.failed);
    expect(
      firestoreAgentFailure(new QueryError(FIRESTORE_TRANSPORT_SENTENCES.notJson), BUDGET, "s", false)?.message,
    ).toBe(F.unreadableAnswer);
  });

  test("Studio's own refusals pass as they are, and a defect is not worded at all", () => {
    expect(firestoreAgentFailure(new ReadAllowanceExceededError("spent"), BUDGET, "s", false)).toBeUndefined();
    expect(firestoreAgentFailure(new RefusedBeforeSendError("table"), BUDGET, "s", false)).toBeUndefined();
    expect(
      firestoreAgentFailure(studioWorded(FIRESTORE_AGENT_CLIENT_SENTENCES.unreadable), BUDGET, "s", false),
    ).toBeUndefined();
    expect(firestoreAgentFailure(new TypeError("defect"), BUDGET, "s", false)).toBeUndefined();
  });

  test("a projection refusal is worded by its own sentence", () => {
    const worded = firestoreAgentFailure(new MetadataProjectionError("collection", "name"), BUDGET, "s", false);
    expect(worded?.message).toBe(new MetadataProjectionError("collection", "name").message);
  });

  test("no failure sentence names a path, an id, a project or Google's text", () => {
    for (const sentence of [
      F.denied,
      F.notFound,
      F.invalid,
      F.quota,
      F.status(500),
      F.credential,
      F.unreachable,
      F.failed,
    ]) {
      expect(sentence).toContain("Google's own words are not passed on to agent mode");
    }
  });
});
