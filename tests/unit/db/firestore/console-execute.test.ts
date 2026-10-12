/**
 * One console run (spec 5.4, 5.7): the explain marker at offset 0, the statement refused before any request when it
 * must be, one request sent with the statement phase, the answer shaped with every warning, collection ids read in
 * pages up to the cap, and the explain answer that carries no plan.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { COMPILE_SENTENCES, COMPILE_WARNINGS } from "@/lib/db/providers/document/firestore/console/compile";
import { type ExecuteDeps, executeStatement } from "@/lib/db/providers/document/firestore/console/execute";
import { PARSER_SENTENCES } from "@/lib/db/providers/document/firestore/console/parser";
import { FIRESTORE_TYPE, LIMITS, SENTENCES } from "@/lib/db/providers/document/firestore/constants";
import { mapTransportFailure } from "@/lib/db/providers/document/firestore/errors";
import type { FirestoreRequest } from "@/lib/db/providers/document/firestore/requests";
import { RESULT_SENTENCES } from "@/lib/db/providers/document/firestore/results";
import type { FirestoreClient, SendOptions } from "@/lib/db/providers/document/firestore/transport";
import { FIRESTORE_EXPLAIN_MARKER } from "@/lib/explain/firestore-explain";
import { full, refusalAsync, TARGET } from "../../../helpers/firestore-console";

const TIME = "2026-10-12T00:00:00Z";
interface Sent {
  readonly request: FirestoreRequest;
  readonly options: SendOptions;
}

function fakeClient(answers: readonly unknown[], mode: "google" | "emulator" = "google") {
  const sent: Sent[] = [];
  const queue = [...answers];
  const client: FirestoreClient = {
    mode,
    target: TARGET,
    async send(request, options) {
      sent.push({ request, options });
      if (queue.length === 0) throw new Error("no answer queued for this request");
      return queue.shift();
    },
    close() {},
  };
  return { client, sent };
}

function deps(client: FirestoreClient): ExecuteDeps {
  const ticks = [1_000, 1_042];
  return {
    client,
    signal: new AbortController().signal,
    now: () => ticks.shift() ?? 1_042,
    credential: "service_account",
  };
}

const alice = {
  name: full("users/alice"),
  fields: { age: { integerValue: "30" } },
  createTime: TIME,
  updateTime: TIME,
};

describe("a run", () => {
  test("one runQuery with the statement phase, shaped with its warnings and timing", async () => {
    const { client, sent } = fakeClient([[{ readTime: TIME }, { document: alice, readTime: TIME }]]);
    const run = deps(client);
    expect(await executeStatement('db.collection("users")', run)).toEqual({
      rows: [{ __name__: "users/alice", age: 30 }],
      fields: ["__name__", "age"],
      rowCount: 1,
      executionTime: 42,
      columnTypes: { __name__: "string", age: "integer" },
      warnings: [{ message: COMPILE_WARNINGS.defaultLimit }],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].request.kind).toBe("runQuery");
    expect(sent[0].options.signal).toBe(run.signal);
    expect(sent[0].options.context).toEqual({
      phase: "statement",
      credential: "service_account",
      target: TARGET,
      surface: "console",
      aggregation: false,
    });
  });

  test("no warnings key when nothing warned, and vector columns when a column holds vectors", async () => {
    const { client } = fakeClient([[]]);
    const quiet = await executeStatement('db.collection("users").limit(5)', deps(client));
    expect("warnings" in quiet).toBe(false);
    expect(quiet).toMatchObject({ rows: [], fields: ["__name__"], rowCount: 0 });
    const vector = {
      mapValue: {
        fields: { __type__: { stringValue: "__vector__" }, value: { arrayValue: { values: [{ doubleValue: 1 }] } } },
      },
    };
    const { client: vectors } = fakeClient([
      [{ document: { name: full("d/1"), fields: { e: vector }, createTime: TIME } }],
    ]);
    const shaped = await executeStatement('db.collection("d").limit(1)', deps(vectors));
    expect(shaped.vectorColumns).toEqual({ e: { kind: "dense", dtype: "float64", dimension: 1 } });
  });

  test("an aggregation is sent with the aggregation context and answers one row", async () => {
    const { client, sent } = fakeClient([
      [{ result: { aggregateFields: { aggregate_0: { integerValue: "3" } } }, readTime: TIME }],
    ]);
    expect(await executeStatement('db.collection("users").count()', deps(client))).toMatchObject({
      rows: [{ count: 3 }],
      warnings: [{ message: COMPILE_WARNINGS.aggregationCost }],
    });
    expect(sent[0].options.context.aggregation).toBe(true);
  });

  test("a client error passes through unchanged", async () => {
    const denied = new QueryError("denied", undefined);
    const client: FirestoreClient = { mode: "google", target: TARGET, send: () => Promise.reject(denied), close() {} };
    await expect(executeStatement('db.collection("users")', deps(client))).rejects.toBe(denied);
  });

  test("the credential's secret forms reach the error context, so a Google message echoing one is withheld (S7)", async () => {
    const { client, sent } = fakeClient([[]]);
    await executeStatement('db.collection("users").limit(1)', { ...deps(client), secretForms: ["ya29.pasted-secret"] });
    expect(sent[0].options.context.secretForms).toEqual(["ya29.pasted-secret"]);
  });

  test("an answer past the size cap gets the console's query sentence", async () => {
    // The client maps a transport failure with the request kind added, as transport.ts's send does.
    const client: FirestoreClient = {
      mode: "google",
      target: TARGET,
      send: (request, options) =>
        Promise.reject(
          mapTransportFailure(new TransportError("too-large", "too large"), {
            ...options.context,
            requestKind: request.kind,
          }),
        ),
      close() {},
    };
    const error = await refusalAsync(() => executeStatement('db.collection("users").limit(1000)', deps(client)));
    expect(error.message).toBe(`${SENTENCES.answerTooLarge}.`);
  });
});

describe("refusals before any request", () => {
  test("a parse error, a compile error and an explain-button refusal send nothing", async () => {
    for (const [text, sentence] of [
      ["db.collection(", PARSER_SENTENCES.expected("a value")],
      ['db.collection("users").limit(5000)', COMPILE_SENTENCES.queryLimit],
      [`${FIRESTORE_EXPLAIN_MARKER}db.doc("users/a")`, COMPILE_SENTENCES.explainKind("a document read")],
    ] as const) {
      const { client, sent } = fakeClient([]);
      // oxlint-disable-next-line no-await-in-loop -- each statement gets its own client, checked in turn.
      const error = await refusalAsync(() => executeStatement(text, deps(client)));
      expect(error.message.startsWith(sentence)).toBe(true);
      expect(sent).toHaveLength(0);
    }
  });

  test("the marker is recognised only at offset 0 and stripped once", async () => {
    for (const text of [
      ` ${FIRESTORE_EXPLAIN_MARKER}db.collection("users")`,
      `${FIRESTORE_EXPLAIN_MARKER}${FIRESTORE_EXPLAIN_MARKER}db.collection("users")`,
    ]) {
      const { client, sent } = fakeClient([]);
      // oxlint-disable-next-line no-await-in-loop -- each text gets its own client, checked in turn.
      const error = await refusalAsync(() => executeStatement(text, deps(client)));
      expect(error.message.startsWith(PARSER_SENTENCES.root)).toBe(true);
      expect(sent).toHaveLength(0);
    }
  });
});

describe("explain", () => {
  test("the marker plans the statement, plan-only, and answers the explain row", async () => {
    expect(FIRESTORE_EXPLAIN_MARKER).toBe("-- libredb:firestore-explain\n");
    const { client, sent } = fakeClient([
      [{ explainMetrics: { planSummary: { indexesUsed: [{ query_scope: "Collection" }] } } }],
    ]);
    const result = await executeStatement(`${FIRESTORE_EXPLAIN_MARKER}db.collection("users").limit(5)`, deps(client));
    expect(sent[0].request).toMatchObject({ kind: "runQuery", body: { explainOptions: { analyze: false } } });
    expect(result).toMatchObject({
      rows: [{ indexesUsed: [{ query_scope: "Collection" }], executionStats: null }],
      fields: ["indexesUsed", "executionStats"],
      warnings: [{ message: RESULT_SENTENCES.explainReturned(0) }],
    });
  });

  test("on an emulator server every explain is refused with the emulator sentence before any request (spec 4.3)", async () => {
    for (const text of [
      'db.collection("users").explain()',
      'db.collection("users").count().explain({ analyze: true })',
      `${FIRESTORE_EXPLAIN_MARKER}db.collection("users").limit(5)`,
    ]) {
      const emulator = fakeClient([[{ readTime: TIME }]], "emulator");
      // oxlint-disable-next-line no-await-in-loop -- each statement gets its own client, checked in turn.
      const error = await refusalAsync(() => executeStatement(text, deps(emulator.client)));
      expect(error.message).toBe(SENTENCES.emulatorExplain);
      expect(error.provider).toBe(FIRESTORE_TYPE);
      expect(emulator.sent).toHaveLength(0);
    }
  });

  test("on Google, an answer without explainMetrics is an error", async () => {
    const google = fakeClient([[{ readTime: TIME }]]);
    const fromGoogle = await refusalAsync(() =>
      executeStatement('db.collection("users").explain()', deps(google.client)),
    );
    expect(fromGoogle.message).toBe(RESULT_SENTENCES.noPlan);
    expect(google.sent).toHaveLength(1);
  });
});

describe("collection id listings", () => {
  test("pages are read with their page token until the last one", async () => {
    const { client, sent } = fakeClient([{ collectionIds: ["b", "a"], nextPageToken: "t1" }, { collectionIds: ["c"] }]);
    const result = await executeStatement("db.listCollections()", deps(client));
    expect(sent.map((call) => call.request)).toEqual([
      { kind: "listCollectionIds", parent: [], pageSize: LIMITS.idListingPageSize },
      { kind: "listCollectionIds", parent: [], pageSize: LIMITS.idListingPageSize, pageToken: "t1" },
    ]);
    expect(result.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect("warnings" in result).toBe(false);
  });

  test("reading stops at the page cap with a warning", async () => {
    const pages = Array.from({ length: LIMITS.idListingRequests }, (_, index) => ({
      collectionIds: [`c${index}`],
      nextPageToken: "more",
    }));
    const { client, sent } = fakeClient(pages);
    const result = await executeStatement("db.listCollections()", deps(client));
    expect(sent).toHaveLength(LIMITS.idListingRequests);
    expect(result.rows).toHaveLength(LIMITS.idListingRequests);
    expect(result.warnings).toEqual([{ message: RESULT_SENTENCES.idCap }]);
  });

  test("the same cap, page size, repeat rule, id filter and UTF-8 order as objects.ts's listCollectionIdsSorted", async () => {
    const { client, sent } = fakeClient([
      { collectionIds: ["é", "b", "a/b"], nextPageToken: "t1" },
      { collectionIds: ["b", "z", "a"] },
    ]);
    const result = await executeStatement("db.listCollections()", deps(client));
    expect(
      sent.every(
        (call) => call.request.kind === "listCollectionIds" && call.request.pageSize === LIMITS.idListingPageSize,
      ),
    ).toBe(true);
    expect(sent.every((call) => call.options.context.phase === "statement")).toBe(true);
    expect(result.rows.map((row) => row.id)).toEqual(["a", "b", "z", "é"]);
    expect(result.warnings).toEqual([{ message: RESULT_SENTENCES.droppedIds(1) }]);
  });

  test("a malformed page is an explicit error", async () => {
    for (const page of [5, { collectionIds: "x" }]) {
      const { client } = fakeClient([page]);
      // oxlint-disable-next-line no-await-in-loop -- each page gets its own client, checked in turn.
      const error = await refusalAsync(() => executeStatement("db.listCollections()", deps(client)));
      expect(error.message).toBe(RESULT_SENTENCES.malformed("a collection listing"));
    }
  });
});

describe("document name listings", () => {
  const page = (from: number, nextPageToken?: string) => ({
    documents: Array.from({ length: LIMITS.collectionPageSizeUnmasked }, (_, index) => ({
      name: full(`users/u${from + index}`),
      createTime: TIME,
    })),
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  });
  const request = {
    kind: "listDocuments" as const,
    parent: [],
    collectionId: "users",
    pageSize: LIMITS.collectionPageSizeUnmasked,
    showMissing: true,
  };

  test("unmasked pages of 50 are read up to the 100-row bound, and more pages are a warning", async () => {
    const { client, sent } = fakeClient([page(0, "t1"), page(50, "t2")]);
    const result = await executeStatement('db.collection("users").listDocuments()', deps(client));
    expect(sent.map((call) => call.request)).toEqual([request, { ...request, pageToken: "t1" }]);
    expect(result.rows).toHaveLength(LIMITS.consoleListDocumentsRows);
    expect(result.warnings).toEqual([{ message: RESULT_SENTENCES.moreDocuments }]);
  });

  test("a last page ends the listing with no warning, and a malformed page is an explicit error", async () => {
    const { client, sent } = fakeClient([page(0)]);
    const result = await executeStatement('db.collection("users").listDocuments()', deps(client));
    expect(sent).toHaveLength(1);
    expect(result.rows).toHaveLength(LIMITS.collectionPageSizeUnmasked);
    expect("warnings" in result).toBe(false);
    const malformed = fakeClient([{ documents: 5 }]);
    const error = await refusalAsync(() =>
      executeStatement('db.collection("users").listDocuments()', deps(malformed.client)),
    );
    expect(error.message).toBe(RESULT_SENTENCES.malformed("a document listing"));
  });
});
