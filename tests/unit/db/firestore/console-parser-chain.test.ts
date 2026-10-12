/**
 * The console chain as the Admin SDK's state machine (spec 5.4): every row of the state table, the implicit ends,
 * repeated calls, cursor slots, and the near misses a statement copied from Firebase docs or Stack Overflow hits,
 * each with its own sentence, line and column.
 */
import { describe, expect, test } from "bun:test";
import { LEXER_SENTENCES } from "@/lib/db/providers/document/firestore/console/lexer";
import { PARSER_SENTENCES, parseStatement } from "@/lib/db/providers/document/firestore/console/parser";
import { refusal } from "../../../helpers/firestore-console";

const S = PARSER_SENTENCES;
const refused = (text: string, sentence: string, position: number): void => {
  const error = refusal(() => parseStatement(text));
  expect(error.message.startsWith(sentence)).toBe(true);
  expect(error.position).toBe(position);
};
const startsWith = (text: string, prefix: string): void => {
  expect(refusal(() => parseStatement(text)).message.startsWith(prefix)).toBe(true);
};

describe("from db", () => {
  test("collection() takes an odd path and starts a collection", () => {
    expect(parseStatement('db.collection("users")')).toEqual({
      kind: "query",
      source: { kind: "collection", path: ["users"], at: 14 },
      ops: { where: [], orderBy: [] },
    });
    expect(parseStatement('db.collection("users/alice/orders")')).toMatchObject({
      source: { path: ["users", "alice", "orders"] },
    });
    refused('db.collection("users/alice")', S.collectionPath, 14);
  });

  test("collectionGroup() takes one valid id", () => {
    expect(parseStatement('db.collectionGroup("orders")')).toMatchObject({
      kind: "query",
      source: { kind: "collectionGroup", collectionId: "orders", at: 19 },
    });
    refused('db.collectionGroup("a/b")', S.groupId, 19);
    refused("db.collectionGroup(5)", S.groupId, 19);
  });

  test("doc() takes an even path and ends as a document get", () => {
    expect(parseStatement('db.doc("users/alice")')).toEqual({ kind: "getDocument", path: ["users", "alice"], at: 7 });
    refused('db.doc("users")', S.documentPath, 7);
    refused("db.doc()", S.newDoc, 3);
  });

  test("listCollections() and getAll() end the chain", () => {
    expect(parseStatement("db.listCollections()")).toEqual({ kind: "listCollections", parent: [], at: 3 });
    expect(parseStatement('db.getAll(db.doc("users/a"), db.doc("users/b"))')).toEqual({
      kind: "getAll",
      refs: [
        ["users", "a"],
        ["users", "b"],
      ],
    });
    refused("db.getAll()", S.getAllRefs, 3);
    refused('db.getAll("users/a")', S.getAllRefs, 10);
    refused(`db.getAll(${Array(1_001).fill('db.doc("u/a")').join(",")})`, S.getAllRefs, 3);
    refused("db.listCollections(1)", S.noArgs("listCollections"), 3);
  });

  test("any other call on db is refused with the calls it takes", () => {
    startsWith("db.frobnicate()", "frobnicate() cannot be called on db; it takes collection()");
  });
});

describe("from a collection and a document", () => {
  test("collection.doc() resolves a relative path to a document", () => {
    expect(parseStatement('db.collection("users").doc("alice")')).toEqual({
      kind: "getDocument",
      path: ["users", "alice"],
      at: 27,
    });
    expect(parseStatement('db.collection("users").doc("alice/orders/o1")')).toMatchObject({
      path: ["users", "alice", "orders", "o1"],
    });
    refused('db.collection("users").doc()', S.newDoc, 23);
    refused('db.collection("users").doc("alice/orders")', S.documentPath, 27);
  });

  test("collection.listDocuments() ends the chain", () => {
    expect(parseStatement('db.collection("users").listDocuments()')).toEqual({
      kind: "listDocuments",
      collection: ["users"],
      at: 23,
    });
  });

  test("document.collection(), get() and listCollections()", () => {
    expect(parseStatement('db.doc("users/alice").collection("orders")')).toMatchObject({
      kind: "query",
      source: { kind: "collection", path: ["users", "alice", "orders"], at: 33 },
    });
    refused('db.doc("users/alice").collection("orders/o1")', S.collectionPath, 33);
    expect(parseStatement('db.doc("users/alice").get()')).toEqual({
      kind: "getDocument",
      path: ["users", "alice"],
      at: 7,
    });
    expect(parseStatement('db.doc("users/alice").listCollections()')).toEqual({
      kind: "listCollections",
      parent: ["users", "alice"],
      at: 22,
    });
    startsWith('db.doc("users/alice").where("a", "==", 1)', "where() cannot be called on a document");
  });
});

describe("query calls", () => {
  test("where combines, orderBy appends, and limit, offset, select and each cursor slot replace", () => {
    const statement = parseStatement(
      'db.collection("users").where("age", ">=", 21).where(Filter.or(Filter.where("a", "==", 1), Filter.where("b", "==", 2)))' +
        '.orderBy("age", "desc").orderBy("name").limit(5).limit(7).offset(3).select("a").select("b", "c.d")' +
        ".startAt(1).startAfter(2).endAt(3).endBefore(4, 5)",
    );
    expect(statement).toMatchObject({
      kind: "query",
      ops: {
        where: [{ kind: "compare", op: ">=" }, { kind: "or" }],
        orderBy: [
          { field: { path: ["age"] }, direction: "DESCENDING" },
          { field: { path: ["name"] }, direction: "ASCENDING" },
        ],
        limit: { value: 7 },
        offset: { value: 3 },
        select: [{ path: ["b"] }, { path: ["c", "d"] }],
        start: { values: [{ kind: "integer", text: "2" }], before: false },
        end: {
          values: [
            { kind: "integer", text: "4" },
            { kind: "integer", text: "5" },
          ],
          before: true,
        },
      },
    });
    expect(parseStatement('db.collection("a").startAt(1).endAt(2)')).toMatchObject({
      ops: { start: { before: true }, end: { before: false } },
    });
    expect(parseStatement('db.collection("a").select()')).toMatchObject({ ops: { select: [] } });
  });

  test("where or orderBy after a cursor is refused, as the SDK refuses it", () => {
    refused('db.collection("a").orderBy("x").startAt(1).where("b", "==", 1)', S.afterCursor("where"), 43);
    refused('db.collection("a").startAt(1).orderBy("x")', S.afterCursor("orderBy"), 30);
  });

  test("argument shapes are refused where they stand", () => {
    refused('db.collection("a").limitToLast(1)', S.limitToLast, 19);
    refused('db.collection("a").orderBy("x", "up")', S.direction, 32);
    refused('db.collection("a").orderBy()', S.arguments("orderBy()", "a field and an optional direction"), 19);
    refused('db.collection("a").where("x")', S.filter, 25);
    refused('db.collection("a").where("a", "==")', S.whereArguments, 19);
    refused('db.collection("a").limit(1.5)', S.integerExpected("limit()"), 25);
    refused('db.collection("a").startAt()', S.cursorValues("startAt"), 19);
    startsWith(
      'db.collection("a").frobnicate()',
      "frobnicate() cannot be called on a query; it takes doc(), listDocuments(), where()",
    );
    startsWith('db.collectionGroup("a").doc("x")', "doc() cannot be called on a query; it takes where()");
  });
});

describe("aggregations, vector queries and explain", () => {
  test("count() and aggregate() move to the aggregation state", () => {
    expect(parseStatement('db.collection("a").count()')).toMatchObject({
      kind: "aggregate",
      aggregations: [{ key: "count", op: "count", at: 19 }],
    });
    expect(
      parseStatement(
        'db.collection("a").aggregate({ total: AggregateField.sum("p"), n: AggregateField.count() }).get()',
      ),
    ).toMatchObject({
      kind: "aggregate",
      aggregations: [
        { key: "total", op: "sum", field: { path: ["p"] } },
        { key: "n", op: "count" },
      ],
    });
    refused('db.collection("a").count(1)', S.noArgs("count"), 19);
    refused('db.collection("a").aggregate(1)', S.aggregateShape, 19);
    startsWith(
      'db.collection("a").count().limit(1)',
      "limit() cannot be called on an aggregation; it takes get() or explain()",
    );
  });

  test("findNearest() reads its options and moves to the vector state", () => {
    expect(
      parseStatement(
        'db.collection("a").where("k", "==", 1).findNearest({ vectorField: "e", queryVector: [1, 2], limit: 5, distanceMeasure: "COSINE", distanceResultField: "d", distanceThreshold: 0 })',
      ),
    ).toMatchObject({
      kind: "vector",
      ops: { where: [{ kind: "compare" }] },
      nearest: {
        field: { path: ["e"] },
        queryVector: [1, 2],
        limit: 5,
        distanceMeasure: "COSINE",
        distanceResultField: { path: ["d"] },
        distanceThreshold: 0,
        at: 39,
      },
    });
    expect(
      parseStatement(
        'db.collection("a").findNearest({ vectorField: "e", queryVector: FieldValue.vector([1.5]), limit: 1, distanceMeasure: "DOT_PRODUCT" }).get()',
      ),
    ).toMatchObject({ kind: "vector", nearest: { queryVector: [1.5], distanceMeasure: "DOT_PRODUCT" } });
  });

  const options: Record<string, string> = {
    vectorField: '"e"',
    queryVector: "[1]",
    limit: "5",
    distanceMeasure: '"COSINE"',
  };
  test.each(Object.keys(options))("findNearest() without %s is refused", (missing) => {
    const body = Object.entries(options)
      .filter(([key]) => key !== missing)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");
    refused(`db.collection("a").findNearest({ ${body} })`, S.nearestMissing(missing), 19);
  });

  test("findNearest() refuses a bad shape, option, measure and vector", () => {
    refused('db.collection("a").findNearest(1)', S.nearestShape, 19);
    refused('db.collection("a").findNearest({ k: 1 })', S.nearestOption("k"), 33);
    const measure =
      'db.collection("a").findNearest({ vectorField: "e", queryVector: [1], limit: 5, distanceMeasure: "MANHATTAN" })';
    refused(measure, S.measure, measure.indexOf('"MANHATTAN"'));
    const vector =
      'db.collection("a").findNearest({ vectorField: "e", queryVector: "x", limit: 5, distanceMeasure: "COSINE" })';
    refused(vector, S.queryVector, vector.indexOf('"x"'));
    startsWith(
      'db.collection("a").findNearest({ vectorField: "e", queryVector: [1], limit: 5, distanceMeasure: "COSINE" }).where("a", "==", 1)',
      "where() cannot be called on a vector query; it takes get() or explain()",
    );
  });

  test("explain() ends any query, vector query or aggregation with its options", () => {
    expect(parseStatement('db.collection("a").explain()')).toMatchObject({
      kind: "query",
      explain: { analyze: false, at: 19 },
    });
    expect(parseStatement('db.collection("a").explain({})')).toMatchObject({ explain: { analyze: false } });
    expect(parseStatement('db.collection("a").count().explain({ analyze: true })')).toMatchObject({
      kind: "aggregate",
      explain: { analyze: true },
    });
    expect(
      parseStatement(
        'db.collection("a").findNearest({ vectorField: "e", queryVector: [1], limit: 5, distanceMeasure: "COSINE" }).explain()',
      ),
    ).toMatchObject({ kind: "vector", explain: { analyze: false } });
    refused('db.collection("a").explain({ analyze: 1 })', S.explainShape, 19);
    refused('db.collection("a").explain({ verbose: true })', S.explainShape, 19);
    refused('db.collection("a").explain(1, 2)', S.explainShape, 19);
  });
});

describe("ends and the statement around the chain", () => {
  test("get() ends a chain, and nothing follows an end", () => {
    expect(parseStatement('await db.collection("a").get();')).toMatchObject({ kind: "query" });
    refused('db.collection("a").get(1)', S.noArgs("get"), 19);
    refused('db.collection("a").get().limit(1)', S.afterEnd("get"), 25);
  });

  test("an empty chain, a missing call, a stray token and a foreign root are refused", () => {
    refused("db", S.emptyChain, 2);
    refused("db;", S.emptyChain, 3);
    refused("db.collection", S.parens("collection"), 13);
    refused('db.collection("a") [0]', S.expected('"." or the end of the statement'), 19);
    refused("db.5", S.expected("a method name"), 3);
    refused('foo.collection("a")', S.root, 0);
  });
});

describe("near misses copied from Firebase docs and Stack Overflow", () => {
  test.each([
    [
      "const snapshot = await db.collection('cities').where('capital', '==', true).get();",
      S.oneChain,
      "line 1, column 1",
    ],
    ["let ref = db.collection('cities')", S.oneChain, "line 1, column 1"],
    ["citiesRef = db.collection('cities')", S.oneChain, "line 1, column 1"],
    ["db.collection('a').get();\ndb.collection('b').get();", S.oneChain, "line 2, column 1"],
    ["const q = query(collection(db, 'cities'), where('capital', '==', true));", S.oneChain, "line 1, column 1"],
    ["query(collection(db, 'cities'), where('capital', '==', true))", S.modular, "line 1, column 1"],
    ["await getDocs(collection(db, 'cities'))", S.modular, "line 1, column 7"],
    ["doc(db, 'cities', 'SF')", S.modular, "line 1, column 1"],
    ["setDoc(doc(db, 'cities', 'LA'), { name: 'Los Angeles' })", S.readOnly, "line 1, column 1"],
    ["admin.firestore().collection('users').get()", S.root, "line 1, column 1"],
    ["firestore().collection('users')", S.root, "line 1, column 1"],
    ["getFirestore().collection('users')", S.root, "line 1, column 1"],
    ["await admin.firestore().collection('users').get()", S.root, "line 1, column 7"],
    [
      "db.collection('cities').doc('SF').get().then(doc => {\n  console.log(doc.data());\n})",
      S.runsItself,
      "line 1, column 41",
    ],
    ["db.collection('cities')\n  .onSnapshot(snapshot => {})", S.runsItself, "line 2, column 4"],
    ["db.collection('cities').stream()", S.runsItself, "line 1, column 25"],
    ["db.collection('cities').withConverter(converter)", S.runsItself, "line 1, column 25"],
    ["db.collection('cities').doc('LA').set({ name: 'Los Angeles' })", S.readOnly, "line 1, column 35"],
    ["db.collection('cities').add({ name: 'Tokyo' })", S.readOnly, "line 1, column 25"],
    ["db.doc('cities/DC').update({ capital: true })", S.readOnly, "line 1, column 21"],
    ["db.doc('cities/DC').delete()", S.readOnly, "line 1, column 21"],
    ["db.collection('cities').doc('BJ').create({})", S.readOnly, "line 1, column 35"],
    ["db.batch()", S.readOnly, "line 1, column 4"],
    ["db.runTransaction(async (t) => {})", S.readOnly, "line 1, column 4"],
    ["db.bulkWriter()", S.readOnly, "line 1, column 4"],
    ["db.recursiveDelete(db.collection('old'))", S.readOnly, "line 1, column 4"],
    ["db.collection(`users/${uid}/orders`)", LEXER_SENTENCES.placeholder, "line 1, column 22"],
    [
      "db.collection('c').where('t', '==', FieldValue.serverTimestamp())",
      S.writeValue("FieldValue.serverTimestamp"),
      "line 1, column 37",
    ],
  ])("%j answers its own sentence at its line and column", (text, sentence, where) => {
    const error = refusal(() => parseStatement(text));
    expect(error.message.startsWith(sentence)).toBe(true);
    expect(error.message).toContain(`(${where}:`);
  });
});
