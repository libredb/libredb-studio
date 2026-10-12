import { describe, expect, spyOn, test } from "bun:test";
import * as parser from "@/lib/db/providers/document/firestore/console/parser";
import { getExplainStrategy } from "@/lib/explain";
import {
  FIRESTORE_EXPLAIN_DECLINES,
  FIRESTORE_EXPLAIN_MARKER,
  firestoreExplainStrategy,
} from "@/lib/explain/firestore-explain";

const MODES = ["estimate", "analyze"] as const;

describe("the firestore-explain strategy (Firestore spec 5.7)", () => {
  test("is the registry's entry for its format", () => {
    expect(getExplainStrategy("firestore-explain")).toBe(firestoreExplainStrategy);
    expect(firestoreExplainStrategy.format).toBe("firestore-explain");
  });

  test("marks with a line the console grammar has no token for", () => {
    expect(FIRESTORE_EXPLAIN_MARKER).toBe("-- libredb:firestore-explain\n");
  });

  test.each([
    ['db.collection("users").where("age", ">=", 18).limit(10)'],
    ['db.collectionGroup("orders").orderBy("total", "desc")'],
    ['db.collection("users").count()'],
    [
      'db.collection("docs").findNearest({ vectorField: "embedding", queryVector: [0.1, 0.2], limit: 3, distanceMeasure: "COSINE" })',
    ],
    ['db.collection("users")'],
  ])("marks an explainable statement in both modes: %s", (text) => {
    for (const mode of MODES) {
      expect(firestoreExplainStrategy.buildSql(text, mode)).toBe(`${FIRESTORE_EXPLAIN_MARKER}${text}`);
      expect(firestoreExplainStrategy.declineReason?.(text, mode)).toBeNull();
    }
  });

  test("marks text the parser refuses, so the server answers with the parser's sentence and runs nothing", () => {
    for (const text of ['db.collection("users").doc("a").set({ age: 1 })', "SELECT 1"]) {
      for (const mode of MODES) {
        expect(firestoreExplainStrategy.buildSql(text, mode)).toBe(`${FIRESTORE_EXPLAIN_MARKER}${text}`);
        expect(firestoreExplainStrategy.declineReason?.(text, mode)).toBeNull();
      }
    }
  });

  test.each([
    ['db.doc("users/alice").get()', FIRESTORE_EXPLAIN_DECLINES.getDocument],
    ['db.collection("users").doc("alice")', FIRESTORE_EXPLAIN_DECLINES.getDocument],
    ['db.getAll(db.doc("users/a"), db.doc("users/b"))', FIRESTORE_EXPLAIN_DECLINES.getAll],
    ["db.listCollections()", FIRESTORE_EXPLAIN_DECLINES.listCollections],
    ['db.doc("users/alice").listCollections()', FIRESTORE_EXPLAIN_DECLINES.listCollections],
    ['db.collection("users").listDocuments()', FIRESTORE_EXPLAIN_DECLINES.listDocuments],
    ['db.collection("users").limit(5).explain()', FIRESTORE_EXPLAIN_DECLINES.alreadyExplained],
    ['db.collection("users").count().explain({ analyze: true })', FIRESTORE_EXPLAIN_DECLINES.alreadyExplained],
  ])("declines %s with its own sentence", (text, sentence) => {
    for (const mode of MODES) {
      expect(firestoreExplainStrategy.buildSql(text, mode)).toBeNull();
      expect(firestoreExplainStrategy.declineReason?.(text, mode)).toBe(sentence);
    }
  });

  test("each decline is its own sentence", () => {
    expect(new Set(Object.values(FIRESTORE_EXPLAIN_DECLINES)).size).toBe(5);
  });

  test("a failure that is not the parser's refusal is raised, never read as text to mark", () => {
    const spy = spyOn(parser, "parseStatement").mockImplementation(() => {
      throw new TypeError("not a refusal");
    });
    try {
      expect(() => firestoreExplainStrategy.buildSql("db.listCollections()", "estimate")).toThrow(TypeError);
      expect(() => firestoreExplainStrategy.declineReason?.("db.listCollections()", "estimate")).toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });

  test("extractPlan reads the one explain row", () => {
    const row = { indexesUsed: [], executionStats: null };
    expect(firestoreExplainStrategy.extractPlan({ rows: [row] })).toBe(row);
    expect(firestoreExplainStrategy.extractPlan({ rows: [] })).toBeNull();
    expect(firestoreExplainStrategy.extractPlan({})).toBeNull();
  });

  test("draws one node per index used, reading the scope under either spelling and keeping unknown keys", () => {
    const raw = {
      indexesUsed: [
        { query_scope: "Collection", properties: "(age ASC, __name__ ASC)" },
        { queryScope: "Collection group", properties: "(total DESC)", newKey: { a: 1 } },
        { properties: ["a"] },
        "raw",
        {},
      ],
      executionStats: null,
    };
    expect(firestoreExplainStrategy.toRenderModel(raw)).toEqual({
      kind: "tree",
      raw,
      root: {
        label: "Firestore query plan",
        detail: "5 indexes used",
        children: [
          { label: "Index (age ASC, __name__ ASC)", detail: "scope: Collection", children: [] },
          { label: "Index (total DESC)", detail: 'scope: Collection group; newKey: {"a":1}', children: [] },
          { label: "Index", detail: 'properties: ["a"]', children: [] },
          { label: "Index", detail: "raw", children: [] },
          { label: "Index", children: [] },
        ],
      },
    });
  });

  test("draws the execution statistics as a node with the returned count as its metric", () => {
    const raw = {
      indexesUsed: [{ query_scope: "Collection", properties: "(__name__ ASC)" }],
      executionStats: {
        resultsReturned: "3",
        executionDuration: "0.012s",
        readOperations: "3",
        debugStats: { documents_scanned: "3" },
      },
    };
    expect(firestoreExplainStrategy.toRenderModel(raw)).toEqual({
      kind: "tree",
      raw,
      root: {
        label: "Firestore query plan",
        detail: "1 index used",
        children: [
          { label: "Index (__name__ ASC)", detail: "scope: Collection", children: [] },
          {
            label: "Execution statistics",
            detail:
              'resultsReturned: 3; executionDuration: 0.012s; readOperations: 3; debugStats: {"documents_scanned":"3"}',
            metrics: { actualRows: 3 },
            children: [],
          },
        ],
      },
    });
    const numeric = { indexesUsed: [], executionStats: { resultsReturned: 5 } };
    expect(firestoreExplainStrategy.toRenderModel(numeric)).toEqual({
      kind: "tree",
      raw: numeric,
      root: {
        label: "Firestore query plan",
        detail: "0 indexes used",
        children: [
          { label: "Execution statistics", detail: "resultsReturned: 5", metrics: { actualRows: 5 }, children: [] },
        ],
      },
    });
    const uncounted = { indexesUsed: [], executionStats: { executionDuration: "1s" } };
    expect(firestoreExplainStrategy.toRenderModel(uncounted)).toEqual({
      kind: "tree",
      raw: uncounted,
      root: {
        label: "Firestore query plan",
        detail: "0 indexes used",
        children: [{ label: "Execution statistics", detail: "executionDuration: 1s", children: [] }],
      },
    });
  });

  test.each([
    [null],
    [[]],
    [{}],
    [{ indexesUsed: "x", executionStats: null }],
    [{ indexesUsed: [], executionStats: "x" }],
    [{ indexesUsed: [] }],
  ])("answers null for a foreign shape: %j", (raw) => {
    expect(firestoreExplainStrategy.toRenderModel(raw)).toBeNull();
  });

  test("sends no plan beside an ordinary run, because Firestore bills every plan request", () => {
    expect(firestoreExplainStrategy.backgroundPlan).toBe(false);
  });
});
