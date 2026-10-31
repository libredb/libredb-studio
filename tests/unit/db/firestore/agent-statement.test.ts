/**
 * The agent's reader of one Firestore statement: the closed table of four metadata reads, read with the console's own
 * parser, and every other statement refused before anything is sent, in agent mode's own words with the list of reads.
 */
import { describe, expect, test } from "bun:test";
import {
  FIRESTORE_AGENT_SENTENCES,
  type FirestoreAgentReading,
  readFirestoreAgentStatement,
} from "@/lib/db/providers/document/firestore/agent-statement";

function admitted(text: string) {
  const reading = readFirestoreAgentStatement(text);
  if (!reading.ok) throw new Error(`expected an admitted read, got: ${reading.message}`);
  return reading.plan;
}

function refused(text: string): Extract<FirestoreAgentReading, { ok: false }> {
  const reading = readFirestoreAgentStatement(text);
  if (reading.ok) throw new Error(`expected a refusal, got ${JSON.stringify(reading.plan)}`);
  return reading;
}

describe("the four reads of the closed table", () => {
  test("the root collection ids", () => {
    expect(admitted("db.listCollections()")).toEqual({ op: "list-collections", parent: [] });
    expect(admitted("await db.listCollections();")).toEqual({ op: "list-collections", parent: [] });
  });

  test("the subcollection ids of one document the statement names in full, written either way", () => {
    expect(admitted('db.doc("users/alice").listCollections()')).toEqual({
      op: "list-collections",
      parent: ["users", "alice"],
    });
    expect(admitted('db.collection("users").doc("alice").listCollections()')).toEqual({
      op: "list-collections",
      parent: ["users", "alice"],
    });
  });

  test("a whole collection's count, at the root or under a named document, with or without get()", () => {
    const users = { op: "count", source: { kind: "collection", path: ["users"] } } as const;
    expect(admitted('db.collection("users").count()')).toEqual(users);
    expect(admitted('db.collection("users").count().get()')).toEqual(users);
    expect(admitted('db.collection("users").aggregate({ n: AggregateField.count() }).get()')).toEqual(users);
    expect(admitted('db.collection("users/alice/orders").count().get()')).toEqual({
      op: "count",
      source: { kind: "collection", path: ["users", "alice", "orders"] },
    });
    expect(admitted('db.doc("users/alice").collection("orders").count()')).toEqual({
      op: "count",
      source: { kind: "collection", path: ["users", "alice", "orders"] },
    });
  });

  test("a whole collection group's count", () => {
    expect(admitted('db.collectionGroup("orders").count().get()')).toEqual({
      op: "count",
      source: { kind: "collectionGroup", collectionId: "orders" },
    });
  });

  test("one document the statement names in full: its existence and times, with or without get()", () => {
    const alice = { op: "document", path: ["users", "alice"] } as const;
    expect(admitted('db.doc("users/alice").get()')).toEqual(alice);
    expect(admitted('db.doc("users/alice")')).toEqual(alice);
    expect(admitted('db.collection("users").doc("alice").get()')).toEqual(alice);
  });
});

describe("refused before anything is sent, in agent mode's own words", () => {
  test("an empty statement", () => {
    expect(refused("   ")).toEqual({ ok: false, code: "request", message: FIRESTORE_AGENT_SENTENCES.empty });
  });

  test.each([
    ['db.collection("users").where("age", ">=", 18).count()'],
    ['db.collection("users").where(Filter.or(Filter.where("a", "==", 1), Filter.where("b", "==", 2))).count()'],
    ['db.collection("users").orderBy("age").count()'],
    ['db.collection("users").orderBy("age").startAt(18).count()'],
    ['db.collection("users").orderBy("age").startAfter(18).count()'],
    ['db.collection("users").orderBy("age").endAt(18).count()'],
    ['db.collection("users").orderBy("age").endBefore(18).count()'],
    ['db.collection("users").offset(5).count()'],
    ['db.collection("users").limit(5).count()'],
    ['db.collection("users").select("age").count()'],
    ['db.collectionGroup("orders").where("total", ">", 0).count()'],
  ])("a narrowed count bisects stored values: %s", (text) => {
    expect(refused(text)).toEqual({ ok: false, code: "oracle", message: FIRESTORE_AGENT_SENTENCES.narrowed });
  });

  test.each([
    ['db.collection("users").aggregate({ total: AggregateField.sum("age") }).get()'],
    ['db.collection("users").aggregate({ mean: AggregateField.average("age") }).get()'],
    ['db.collection("users").aggregate({ n: AggregateField.count(), total: AggregateField.sum("age") }).get()'],
    [
      'db.collection("users").findNearest({ vectorField: "e", queryVector: [1, 2], limit: 1, distanceMeasure: "COSINE" })',
    ],
  ])("a sum, an average or a nearest-neighbour search reads stored values: %s", (text) => {
    expect(refused(text)).toEqual({ ok: false, code: "oracle", message: FIRESTORE_AGENT_SENTENCES.valueOracle });
  });

  test.each([
    ['db.collection("users").get()'],
    ['db.collection("users")'],
    ['db.collection("users").limit(1).get()'],
    ['db.collection("users").select().get()'],
    ['db.collectionGroup("orders").get()'],
  ])("a query returns documents: %s", (text) => {
    expect(refused(text)).toEqual({ ok: false, code: "metadata-only", message: FIRESTORE_AGENT_SENTENCES.documents });
  });

  test("listDocuments lists document ids, which are stored values", () => {
    expect(refused('db.collection("users").listDocuments()')).toEqual({
      ok: false,
      code: "metadata-only",
      message: FIRESTORE_AGENT_SENTENCES.documentIds,
    });
  });

  test("getAll returns documents", () => {
    expect(refused('db.getAll(db.doc("users/alice"), db.doc("users/bob"))')).toEqual({
      ok: false,
      code: "metadata-only",
      message: FIRESTORE_AGENT_SENTENCES.documents,
    });
  });

  test.each([
    ['db.collection("users").count().explain()'],
    ['db.collection("users").explain({ analyze: true })'],
    ['db.collection("users").where("a", "==", 1).explain()'],
  ])("explain names indexed fields: %s", (text) => {
    expect(refused(text)).toEqual({ ok: false, code: "metadata-only", message: FIRESTORE_AGENT_SENTENCES.explain });
  });

  test("a write is refused with the parser's sentence and the agent's reads, quoting nothing a document holds", () => {
    const refusal = refused('db.collection("users").doc("alice").set({ admin: true })');
    expect(refusal.code).toBe("request");
    expect(refusal.message).toContain("Studio is read-only for Firestore in this version");
    expect(refusal.message.endsWith(`${FIRESTORE_AGENT_SENTENCES.reads} Nothing was sent.`)).toBe(true);
  });

  test("a statement the console's parser cannot read is refused with the parser's sentence and the reads", () => {
    for (const text of [
      "db.collection(",
      "db.users.find({})",
      'const x = db.collection("users")',
      'db.collection("users").count(); db.listCollections()',
      'db.collection("a/b").count()',
      'db.doc("users").get()',
      'db.doc("users/..").get()',
      'db.doc("users/.").listCollections()',
      'db.collection("users/alice/orders/../x").count()',
      'db.doc("users/__x__").get()',
      'db.doc("users/a\\u0000b").get()',
    ]) {
      const refusal = refused(text);
      expect(refusal.code).toBe("request");
      expect(refusal.message.endsWith(`${FIRESTORE_AGENT_SENTENCES.reads} Nothing was sent.`)).toBe(true);
    }
  });

  test("an id that holds a colon cannot be a verb's parent, refused before anything is sent", () => {
    expect(refused('db.doc("users/a:b").listCollections()')).toEqual({
      ok: false,
      code: "request",
      message: FIRESTORE_AGENT_SENTENCES.colon,
    });
    expect(refused('db.collection("users/a:b/notes").count()')).toEqual({
      ok: false,
      code: "request",
      message: FIRESTORE_AGENT_SENTENCES.colon,
    });
    // The document read names its own path, where a colon is fine.
    expect(admitted('db.doc("users/a:b").get()')).toEqual({ op: "document", path: ["users", "a:b"] });
  });

  test.each([
    ['db.doc("users/a\\u0000b").get()'],
    ['db.doc("users/a\\u007fb").listCollections()'],
    ['db.collection("users/a\\u0001b/orders").count()'],
    ['db.collectionGroup("o\\u0000").count()'],
  ])("a path holding a control character, NUL included: %s", (text) => {
    expect(refused(text)).toEqual({ ok: false, code: "request", message: FIRESTORE_AGENT_SENTENCES.control });
  });

  test("percent-encoded text is an id of its own, never decoded into a path", () => {
    expect(admitted('db.doc("users/a%2Fb").get()')).toEqual({ op: "document", path: ["users", "a%2Fb"] });
  });

  test("no refusal quotes the path the statement named", () => {
    for (const text of [
      'db.collection("secret-tenant").where("x", "==", 1).count()',
      'db.collection("secret-tenant").listDocuments()',
      'db.doc("secret-tenant/x").collection("y").get()',
      'db.collection("secret-tenant").aggregate({ s: AggregateField.sum("v") })',
      'db.doc("secret-tenant/a:b").listCollections()',
    ]) {
      expect(refused(text).message).not.toContain("secret-tenant");
    }
  });

  test("every refusal lists the reads and says nothing was sent", () => {
    for (const sentence of [
      FIRESTORE_AGENT_SENTENCES.empty,
      FIRESTORE_AGENT_SENTENCES.narrowed,
      FIRESTORE_AGENT_SENTENCES.valueOracle,
      FIRESTORE_AGENT_SENTENCES.documents,
      FIRESTORE_AGENT_SENTENCES.documentIds,
      FIRESTORE_AGENT_SENTENCES.explain,
      FIRESTORE_AGENT_SENTENCES.colon,
    ]) {
      expect(sentence).toContain(FIRESTORE_AGENT_SENTENCES.reads);
      expect(sentence.endsWith("Nothing was sent.")).toBe(true);
    }
  });
});
