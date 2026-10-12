/**
 * The Firestore object surface (spec 5.1, 5.2, 5.5): the two kinds, top-level collections listed and counted from one
 * id listing each, a field expand sampling 20 documents of the collection read, a bulk describe reading no document
 * and reporting the caller's bound, and a document's Source tab of three parts; every request names its surface.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import { SENTENCES } from "@/lib/db/providers/document/firestore/constants";
import {
  countFirestoreObjects,
  describeFirestoreObject,
  describeFirestoreObjects,
  FIRESTORE_OBJECT_KINDS,
  FIRESTORE_OBJECT_SENTENCES as O,
  listFirestoreObjects,
  readFirestoreSource,
} from "@/lib/db/providers/document/firestore/objects";
import {
  foreignDocumentSentence,
  nameColumn,
  outsideCollectionSentence,
} from "@/lib/db/providers/document/firestore/sampling";
import { decodeFields, type RestValue } from "@/lib/db/providers/document/firestore/values";
import {
  docName,
  FAKE_BASE,
  FAKE_TARGET,
  type FakeHandler,
  fakeFirestore,
  googleFailure,
} from "../../../helpers/firestore-fake-client";

const SIGNAL = new AbortController().signal;
const B = FAKE_BASE;
const TIME = "2026-10-12T00:00:00.000000Z";
const rootIds =
  (...ids: string[]): FakeHandler =>
  (request) => {
    if (request.kind !== "listCollectionIds") throw new Error(`unexpected request ${request.kind}`);
    return { collectionIds: ids };
  };
/** A fresh id listing that always has a next page, so the 10-request cap stops it. */
const capped = (): FakeHandler => {
  let served = 0;
  return () => {
    served += 1;
    return { collectionIds: [`c${String(served).padStart(3, "0")}`], nextPageToken: `T${served}` };
  };
};

describe("the kinds", () => {
  test("collection is a relation with columns named by Browse Keys; document is the Keys panel's kind with a source", () => {
    expect(FIRESTORE_OBJECT_KINDS).toEqual([
      {
        id: "collection",
        role: "relation",
        label: "Collection",
        labelPlural: "Collections",
        hasColumns: true,
        countIsListing: true,
      },
      {
        id: "document",
        role: "config",
        label: "Document",
        labelPlural: "Documents",
        enumeratedBy: "key-browser",
        hasSource: true,
        sourceLanguage: "json",
      },
    ]);
    expect(Object.isFrozen(FIRESTORE_OBJECT_KINDS)).toBe(true);
  });
});

describe("listing and counting", () => {
  test("top-level collections, each named by its bare id, in UTF-8 order, from one id listing", async () => {
    const fake = fakeFirestore(rootIds("users", "orders"));
    expect(await listFirestoreObjects(fake.client, [], "collection", SIGNAL, B)).toEqual([
      { path: ["orders"], name: "orders", kind: "collection" },
      { path: ["users"], name: "users", kind: "collection" },
    ]);
    expect(fake.sent.map((sent) => sent.request)).toEqual([{ kind: "listCollectionIds", parent: [], pageSize: 1000 }]);
    expect(fake.sent[0].options.context.surface).toBe("tree");
  });

  test("a listing the id cap stopped answers the ids its 10 requests returned (spec 5.1)", async () => {
    const fake = fakeFirestore(capped());
    const listed = await listFirestoreObjects(fake.client, [], "collection", SIGNAL, B);
    expect(fake.sent).toHaveLength(10);
    expect(listed.map((object) => object.name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `c${String(index + 1).padStart(3, "0")}`),
    );
  });

  test("documents, unknown kinds and container paths are refused before any request", async () => {
    const fake = fakeFirestore(rootIds("users"));
    await expect(listFirestoreObjects(fake.client, [], "document", SIGNAL, B)).rejects.toThrow(O.documentsElsewhere);
    await expect(listFirestoreObjects(fake.client, [], "table", SIGNAL, B)).rejects.toThrow(O.kind("table"));
    await expect(listFirestoreObjects(fake.client, ["db"], "collection", SIGNAL, B)).rejects.toThrow(
      O.container(["db"]),
    );
    await expect(countFirestoreObjects(fake.client, ["db"], SIGNAL, B)).rejects.toBeInstanceOf(QueryError);
    expect(fake.sent).toHaveLength(0);
  });

  test("the count is the listing's, marked as a sample when the cap stopped it", async () => {
    expect(await countFirestoreObjects(fakeFirestore(rootIds("a", "b")).client, [], SIGNAL, B)).toEqual({
      collection: { count: 2 },
    });
    expect(await countFirestoreObjects(fakeFirestore(capped()).client, [], SIGNAL, B)).toEqual({
      collection: { count: 10, sampledFrom: O.sampledFrom },
    });
  });
});

describe("describing", () => {
  test("a field expand samples 20 documents in __name__ order and infers sampled columns", async () => {
    const fake = fakeFirestore(() => [
      {
        document: { name: docName("users", "a"), fields: { age: { integerValue: "1" } }, createTime: TIME },
        readTime: TIME,
      },
      {
        document: { name: docName("users", "b"), fields: { age: { integerValue: "2" } }, createTime: TIME },
        readTime: TIME,
        done: true,
      },
    ]);
    const detail = await describeFirestoreObject(fake.client, ["users"], "collection", SIGNAL, B);
    expect(fake.sent[0].options.context.surface).toBe("tree");
    expect(fake.sent.map((sent) => sent.request)).toEqual([
      {
        kind: "runQuery",
        parent: [],
        body: {
          structuredQuery: {
            from: [{ collectionId: "users" }],
            orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
            limit: 20,
          },
        },
      },
    ]);
    expect(detail).toEqual({
      path: ["users"],
      columns: [
        nameColumn(),
        { name: "age", type: "integer", nullable: false, isPrimary: false, provenance: "sampled" },
      ],
      indexes: [],
      foreignKeys: [],
    });
  });

  test("a sampled document of another collection is refused, and one whose id breaks the id rules is not sampled (S5)", async () => {
    const stray = docName("orders", "x");
    const other = fakeFirestore(() => [
      {
        document: { name: stray, fields: { total: { integerValue: "1" } }, createTime: TIME },
        readTime: TIME,
        done: true,
      },
    ]);
    await expect(describeFirestoreObject(other.client, ["users"], "collection", SIGNAL, B)).rejects.toThrow(
      outsideCollectionSentence(stray),
    );
    const refusedId = fakeFirestore(() => [
      {
        document: { name: docName("users", "__bad__"), fields: { secret: { integerValue: "1" } }, createTime: TIME },
        readTime: TIME,
      },
      {
        document: { name: docName("users", "a"), fields: { age: { integerValue: "1" } }, createTime: TIME },
        readTime: TIME,
        done: true,
      },
    ]);
    const detail = await describeFirestoreObject(refusedId.client, ["users"], "collection", SIGNAL, B);
    expect(detail.columns.map((column) => column.name)).toEqual(["__name__", "age"]);
  });

  test("a bad collection path and the document kind are refused before any request", async () => {
    const fake = fakeFirestore(() => []);
    await expect(describeFirestoreObject(fake.client, ["users", "a"], "collection", SIGNAL, B)).rejects.toThrow(
      O.collectionPath(["users", "a"]),
    );
    await expect(describeFirestoreObject(fake.client, ["__x__"], "collection", SIGNAL, B)).rejects.toThrow(
      O.collectionPath(["__x__"]),
    );
    await expect(describeFirestoreObject(fake.client, ["users/a"], "document", SIGNAL, B)).rejects.toThrow(
      O.documentsElsewhere,
    );
    expect(fake.sent).toHaveLength(0);
  });

  test("the bulk describe reads no document: every listed collection with __name__ alone", async () => {
    const fake = fakeFirestore(rootIds("users", "orders"));
    expect(await describeFirestoreObjects(fake.client, [], "collection", undefined, SIGNAL, B)).toEqual({
      details: [
        { path: ["orders"], columns: [nameColumn()], indexes: [], foreignKeys: [] },
        { path: ["users"], columns: [nameColumn()], indexes: [], foreignKeys: [] },
      ],
    });
    expect(fake.sent.every((sent) => sent.request.kind === "listCollectionIds")).toBe(true);
  });

  test("the caller's bound is reported with the caller-bound sentence, and the cap with its own", async () => {
    const two = fakeFirestore(rootIds("users", "orders"));
    expect(await describeFirestoreObjects(two.client, [], "collection", 1, SIGNAL, B)).toEqual({
      details: [{ path: ["orders"], columns: [nameColumn()], indexes: [], foreignKeys: [] }],
      truncated: { limit: 1, reason: callerBoundTruncationReason(1) },
    });
    expect((await describeFirestoreObjects(two.client, [], "collection", 5, SIGNAL, B)).truncated).toBeUndefined();
    const cut = await describeFirestoreObjects(fakeFirestore(capped()).client, [], "collection", undefined, SIGNAL, B);
    expect(cut.truncated).toEqual({ limit: 10, reason: O.idCapReason });
    const none = fakeFirestore(rootIds("users"));
    expect(await describeFirestoreObjects(none.client, [], "document", undefined, SIGNAL, B)).toEqual({ details: [] });
    expect(none.sent).toHaveLength(0);
  });
});

describe("the document Source tab", () => {
  const fields: Record<string, RestValue> = { age: { integerValue: "30" }, big: { integerValue: "9007199254740993" } };
  const alice = { name: docName("users", "alice"), fields, createTime: TIME, updateTime: TIME };
  const source: FakeHandler = (request) => (request.kind === "get" ? alice : { collectionIds: ["orders", "likes"] });

  test("Data, Document and Subcollections, from one get and one id listing", async () => {
    const fake = fakeFirestore(source);
    const document = await readFirestoreSource(fake.client, ["users/alice"], "document", undefined, SIGNAL, B);
    expect(fake.sent.map((sent) => sent.request)).toEqual([
      { kind: "get", path: ["users", "alice"] },
      { kind: "listCollectionIds", parent: ["users", "alice"], pageSize: 1000 },
    ]);
    expect(fake.sent.map((sent) => sent.options.context.surface)).toEqual(["source", "source"]);
    expect(document).toEqual({
      path: ["users/alice"],
      kind: "document",
      parts: [
        {
          id: "data",
          label: "Data",
          text: JSON.stringify(decodeFields(fields, FAKE_TARGET), null, 2),
          language: "json",
          form: "complete",
          origin: "rendered",
        },
        {
          id: "document",
          label: "Document",
          text: JSON.stringify(alice, null, 2),
          language: "json",
          form: "complete",
          origin: "rendered",
        },
        {
          id: "subcollections",
          label: "Subcollections",
          text: JSON.stringify(["likes", "orders"], null, 2),
          language: "json",
          form: "complete",
          origin: "rendered",
        },
      ],
    });
  });

  test("a document id holding a colon answers two parts and says why its subcollections are not listed", async () => {
    const fake = fakeFirestore(() => ({ ...alice, name: docName("users", "a:b") }));
    const document = await readFirestoreSource(fake.client, ["users/a:b"], "document", undefined, SIGNAL, B);
    expect(document.parts[2]).toEqual({
      id: "subcollections",
      label: "Subcollections",
      unavailable: SENTENCES.colonSubcollections("users/a:b"),
    });
    expect(fake.sent).toHaveLength(1);
  });

  test("a missing document answers a sentence naming its path; other failures stay Google's", async () => {
    const missing = fakeFirestore(() => {
      throw googleFailure(404, "NOT_FOUND", "Document not found");
    });
    await expect(
      readFirestoreSource(missing.client, ["users/ghost"], "document", undefined, SIGNAL, B),
    ).rejects.toThrow(O.missing("users/ghost"));
    expect(O.missing("users/ghost")).toContain("users/ghost");
    const denied = googleFailure(403, "PERMISSION_DENIED", "Missing or insufficient permissions.");
    const refused = fakeFirestore(() => {
      throw denied;
    });
    await expect(readFirestoreSource(refused.client, ["users/alice"], "document", undefined, SIGNAL, B)).rejects.toBe(
      denied,
    );
  });

  test("the caller's bound applies to each part, and the id cap marks the Subcollections part", async () => {
    const bounded = await readFirestoreSource(fakeFirestore(source).client, ["users/alice"], "document", 5, SIGNAL, B);
    for (const part of bounded.parts) {
      expect("text" in part && part.text.length <= 5).toBe(true);
      expect("truncated" in part && part.truncated?.limit === 5).toBe(true);
    }
    const listing = capped();
    const capping: FakeHandler = (request, built, options) =>
      request.kind === "get" ? alice : listing(request, built, options);
    const cut = await readFirestoreSource(
      fakeFirestore(capping).client,
      ["users/alice"],
      "document",
      undefined,
      SIGNAL,
      B,
    );
    expect(cut.parts[2]).toMatchObject({ truncated: { limit: 10, reason: O.idCapReason } });
  });

  test("paths, kinds and answers it cannot use are refused", async () => {
    const fake = fakeFirestore(source);
    await expect(readFirestoreSource(fake.client, ["users"], "collection", undefined, SIGNAL, B)).rejects.toThrow(
      O.noSource,
    );
    await expect(readFirestoreSource(fake.client, ["users"], "document", undefined, SIGNAL, B)).rejects.toThrow(
      O.documentPath(["users"]),
    );
    await expect(
      readFirestoreSource(fake.client, ["users", "alice"], "document", undefined, SIGNAL, B),
    ).rejects.toThrow(O.documentPath(["users", "alice"]));
    expect(fake.sent).toHaveLength(0);
    const other = fakeFirestore(() => ({ ...alice, name: docName("users", "bob") }));
    await expect(readFirestoreSource(other.client, ["users/alice"], "document", undefined, SIGNAL, B)).rejects.toThrow(
      foreignDocumentSentence(docName("users", "bob")),
    );
    const broken = fakeFirestore(() => [1]);
    await expect(readFirestoreSource(broken.client, ["users/alice"], "document", undefined, SIGNAL, B)).rejects.toThrow(
      O.malformedDocument,
    );
  });
});
