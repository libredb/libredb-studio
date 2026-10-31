/**
 * The agent's Firestore client (`createFirestoreAgentClient` in `agent-client.ts`): three reads and no other member,
 * each pinned to the full request it sends (method, path, query and body), each admitted by the closed table, then
 * charged to the run's read allowance, then sent, and each answer read for its facts alone.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, ReadAllowanceExceededError } from "@/lib/db/errors";
import {
  COUNT_ENTRIES_PER_READ,
  countCharge,
  createFirestoreAgentClient,
  FIRESTORE_AGENT_CLIENT_MEMBERS,
  FIRESTORE_AGENT_CLIENT_SENTENCES as C,
  type FirestoreAgentCall,
} from "@/lib/db/providers/document/firestore/agent-client";
import { READ_ALLOWANCE_PREFIX, RunReadAllowance } from "@/lib/db/read-allowance";
import { docName, FAKE_BASE, type FakeHandler, fakeFirestore } from "../../../helpers/firestore-fake-client";

const BASE = "/v1/projects/demo-studio/databases/%28default%29/documents";

function call(limit = 100): FirestoreAgentCall {
  return { signal: new AbortController().signal, base: FAKE_BASE, allowance: new RunReadAllowance(limit) };
}

function agent(handler: FakeHandler) {
  const fake = fakeFirestore(handler);
  return { client: createFirestoreAgentClient(fake.client), fake };
}

const wire = (fake: ReturnType<typeof fakeFirestore>) =>
  fake.sent.map(({ built }) => ({ method: built.method, path: built.path, query: built.query, body: built.body }));

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("the agent client's members", () => {
  test("are the three reads, and no query, document get with fields, listing of documents or explain", () => {
    const { client } = agent(() => ({}));
    expect(Object.keys(client).sort()).toEqual([...FIRESTORE_AGENT_CLIENT_MEMBERS].sort());
    expect([...FIRESTORE_AGENT_CLIENT_MEMBERS]).toEqual(["listCollectionIds", "countDocuments", "documentTimes"]);
    expect(Object.isFrozen(client)).toBe(true);
  });
});

describe("the collection id listing", () => {
  test("sends one listCollectionIds at the root, charged one read, and answers the ids and the next token", async () => {
    const { client, fake } = agent(() => ({ collectionIds: ["users", "orders"], nextPageToken: "T1" }));
    const spend = call();
    expect(await client.listCollectionIds({ parent: [], pageSize: 201 }, spend)).toEqual({
      ids: ["users", "orders"],
      next: "T1",
    });
    expect(wire(fake)).toEqual([
      { method: "POST", path: `${BASE}:listCollectionIds`, query: [], body: '{"pageSize":201}' },
    ]);
    expect(spend.allowance.spent()).toBe(1);
    expect(fake.sent[0].options.context).toEqual({
      phase: "statement",
      credential: FAKE_BASE.credential,
      secretForms: FAKE_BASE.secretForms,
      target: fake.client.target,
    });
  });

  test("under a named document, with the token of the page before, and an empty token read as the last page", async () => {
    const { client, fake } = agent(() => ({ collectionIds: ["orders"], nextPageToken: "" }));
    expect(
      await client.listCollectionIds({ parent: ["users", "alice"], pageSize: 5, pageToken: "T1" }, call()),
    ).toEqual({ ids: ["orders"] });
    expect(wire(fake)).toEqual([
      {
        method: "POST",
        path: `${BASE}/users/alice:listCollectionIds`,
        query: [],
        body: '{"pageSize":5,"pageToken":"T1"}',
      },
    ]);
  });

  test("an answer with no ids is an empty page", async () => {
    const { client } = agent(() => ({}));
    expect(await client.listCollectionIds({ parent: [], pageSize: 5 }, call())).toEqual({ ids: [] });
  });

  test.each([
    ["not an object", []],
    ["ids that are not strings", { collectionIds: [1] }],
    ["ids that are not a list", { collectionIds: "users" }],
    ["a token that is not a string", { collectionIds: [], nextPageToken: 1 }],
  ])("an answer it cannot read is refused: %s", async (_name, answer) => {
    const { client } = agent(() => answer);
    const error = await failure(client.listCollectionIds({ parent: [], pageSize: 5 }, call()));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(C.unreadable);
  });
});

describe("the count", () => {
  const counted = (n: string) => [{ result: { aggregateFields: { count: { integerValue: n } } }, readTime: "t" }];

  test("a root collection: one runAggregationQuery over the whole collection with upTo, and nothing narrowing it", async () => {
    const { client, fake } = agent(() => counted("4"));
    const spend = call();
    expect(await client.countDocuments({ kind: "collection", path: ["users"] }, 201, spend)).toBe(4);
    expect(wire(fake)).toEqual([
      {
        method: "POST",
        path: `${BASE}:runAggregationQuery`,
        query: [],
        body: '{"structuredAggregationQuery":{"structuredQuery":{"from":[{"collectionId":"users"}]},"aggregations":[{"alias":"count","count":{"upTo":"201"}}]}}',
      },
    ]);
    expect(spend.allowance.spent()).toBe(1);
  });

  test("a subcollection is counted under its parent document", async () => {
    const { client, fake } = agent(() => counted("2"));
    expect(await client.countDocuments({ kind: "collection", path: ["users", "alice", "orders"] }, 3, call())).toBe(2);
    expect(wire(fake)).toEqual([
      {
        method: "POST",
        path: `${BASE}/users/alice:runAggregationQuery`,
        query: [],
        body: '{"structuredAggregationQuery":{"structuredQuery":{"from":[{"collectionId":"orders"}]},"aggregations":[{"alias":"count","count":{"upTo":"3"}}]}}',
      },
    ]);
  });

  test("a collection group is counted from the root over all descendants", async () => {
    const { client, fake } = agent(() => counted("0"));
    expect(await client.countDocuments({ kind: "collectionGroup", collectionId: "orders" }, 3, call())).toBe(0);
    expect(wire(fake)).toEqual([
      {
        method: "POST",
        path: `${BASE}:runAggregationQuery`,
        query: [],
        body: '{"structuredAggregationQuery":{"structuredQuery":{"from":[{"collectionId":"orders","allDescendants":true}]},"aggregations":[{"alias":"count","count":{"upTo":"3"}}]}}',
      },
    ]);
  });

  test("is charged one read per 1,000 index entries it may read, and at least one", async () => {
    expect(COUNT_ENTRIES_PER_READ).toBe(1_000);
    expect([1, 999, 1_000, 1_001, 10_001].map(countCharge)).toEqual([1, 1, 1, 2, 11]);
    const { client } = agent(() => counted("1"));
    const spend = call(100);
    await client.countDocuments({ kind: "collection", path: ["users"] }, 2_001, spend);
    expect(spend.allowance.spent()).toBe(3);
  });

  test.each([
    ["not a stream", {}],
    ["no result", [{ readTime: "t" }]],
    ["two results", [...counted("1"), ...counted("2")]],
    ["another alias", [{ result: { aggregateFields: { n: { integerValue: "1" } } } }]],
    ["a double", [{ result: { aggregateFields: { count: { doubleValue: 1 } } } }]],
    ["a negative count", counted("-1")],
    ["a padded count", counted("01")],
    ["a count past a safe integer", counted("9007199254740993")],
    ["a result that is not an object", [{ result: "x" }]],
  ])("an answer it cannot read is refused: %s", async (_name, answer) => {
    const { client } = agent(() => answer);
    const error = await failure(client.countDocuments({ kind: "collection", path: ["users"] }, 3, call()));
    expect((error as Error).message).toBe(C.unreadable);
  });
});

describe("the document read", () => {
  test("one batchGet of the named document with a mask naming no field, charged one read", async () => {
    const { client, fake } = agent(() => [
      {
        found: {
          name: docName("users", "alice"),
          createTime: "2026-10-31T04:59:47.809191Z",
          updateTime: "u",
          fields: { secret: { stringValue: "x" } },
        },
        readTime: "t",
      },
    ]);
    const spend = call();
    expect(await client.documentTimes(["users", "alice"], spend)).toEqual({
      exists: true,
      createTime: "2026-10-31T04:59:47.809191Z",
      updateTime: "u",
    });
    expect(wire(fake)).toEqual([
      {
        method: "POST",
        path: `${BASE}:batchGet`,
        query: [],
        body: `{"documents":["${docName("users", "alice")}"],"mask":{"fieldPaths":[]}}`,
      },
    ]);
    expect(spend.allowance.spent()).toBe(1);
  });

  test("a missing document is answered as not existing", async () => {
    const { client } = agent(() => [{ missing: docName("users", "nobody"), readTime: "t" }]);
    expect(await client.documentTimes(["users", "nobody"], call())).toEqual({ exists: false });
  });

  test("a found document with no times answers its existence alone", async () => {
    const { client } = agent(() => [{ found: { name: docName("users", "alice") } }]);
    expect(await client.documentTimes(["users", "alice"], call())).toEqual({ exists: true });
  });

  test.each([
    ["not a stream", {}],
    ["no element", [{ readTime: "t" }]],
    ["two elements", [{ missing: docName("users", "a") }, { missing: docName("users", "a") }]],
    ["another document found", [{ found: { name: docName("users", "bob") } }]],
    ["another document missing", [{ missing: docName("users", "bob") }]],
    ["a found that is not an object", [{ found: "x" }]],
    ["a time that is not a string", [{ found: { name: docName("users", "a"), createTime: 1 } }]],
    ["an update time that is not a string", [{ found: { name: docName("users", "a"), updateTime: 1 } }]],
  ])("an answer it cannot read is refused: %s", async (_name, answer) => {
    const { client } = agent(() => answer);
    const error = await failure(client.documentTimes(["users", "a"], call()));
    expect((error as Error).message).toBe(C.unreadable);
  });
});

describe("the allowance and the closed table", () => {
  test("a request past what is left is refused before it is sent, and spends nothing", async () => {
    const { client, fake } = agent(() => ({ collectionIds: [] }));
    const spend = call(2);
    spend.allowance.charge(2, "earlier reads");
    const error = await failure(client.listCollectionIds({ parent: [], pageSize: 5 }, spend));
    expect(error).toBeInstanceOf(ReadAllowanceExceededError);
    expect((error as Error).message).toBe(
      `${READ_ALLOWANCE_PREFIX}: ${C.listingLabel} needs 1 billed reads, and 0 of the 2 this run may spend is left`,
    );
    expect(fake.sent).toEqual([]);
    expect(spend.allowance.spent()).toBe(2);
  });

  test("a count that may cost more than is left is refused whole, before it is sent", async () => {
    const { client, fake } = agent(() => []);
    const spend = call(2);
    const error = await failure(client.countDocuments({ kind: "collection", path: ["users"] }, 2_001, spend));
    expect((error as Error).message).toContain(C.countLabel(2_001));
    expect(fake.sent).toEqual([]);
    expect(spend.allowance.spent()).toBe(0);
  });

  test("a request the closed table refuses costs nothing and sends nothing", async () => {
    const { client, fake } = agent(() => ({}));
    const spend = call();
    // Firestore reads a colon in a verb parent's last id as the start of the verb.
    const error = await failure(client.listCollectionIds({ parent: ["users", "a:b"], pageSize: 5 }, spend));
    expect(error).toBeInstanceOf(QueryError);
    expect(fake.sent).toEqual([]);
    expect(spend.allowance.spent()).toBe(0);
  });

  test("the charge comes before the send: a handler sees the read already spent", async () => {
    const spend = call();
    const { client } = agent(() => {
      expect(spend.allowance.spent()).toBe(1);
      return { collectionIds: [] };
    });
    await client.listCollectionIds({ parent: [], pageSize: 5 }, spend);
  });

  test("the labels a charge names carry no path and no id", () => {
    expect([C.listingLabel, C.countLabel(201), C.documentLabel]).toEqual([
      "a collection id listing request",
      "a document count of up to 201 documents",
      "a document read",
    ]);
  });
});
