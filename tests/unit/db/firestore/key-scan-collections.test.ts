/**
 * The Keys panel's collection levels (spec 5.3): `listDocuments` with `showMissing`, no mask, `pageSize` half the
 * page's room (at most 50), each present document as a key and a folder, a missing parent as a folder only, the
 * folder an odd count leaves owed carried by the cursor, the too-large and expired-listing sentences; and a typed id,
 * read with a names-only `runQuery` over the `__name__` range up to the id's successor, with its `readOutcome`.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { SENTENCES } from "@/lib/db/providers/document/firestore/constants";
import { encodeLevelCursor, FIRESTORE_CURSOR_SENTENCES as C } from "@/lib/db/providers/document/firestore/cursor";
import {
  FIRESTORE_KEY_SCAN_SENTENCES as S,
  idSuccessor,
  scanFirestoreLevel,
} from "@/lib/db/providers/document/firestore/key-scan";
import { FIRESTORE_LISTING_SENTENCES as L } from "@/lib/db/providers/document/firestore/objects";
import { foreignDocumentSentence, outsideCollectionSentence } from "@/lib/db/providers/document/firestore/sampling";
import type { KeyScanOptions } from "@/lib/db/types";
import {
  docName,
  FAKE_BASE,
  type FakeHandler,
  fakeFirestore,
  googleFailure,
  tooLargeFailure,
} from "../../../helpers/firestore-fake-client";

const SIGNAL = new AbortController().signal;
const TIME = "2026-10-12T00:00:00.000000Z";
const present = (...segments: string[]) => ({ name: docName(...segments), createTime: TIME, updateTime: TIME });
const missing = (...segments: string[]) => ({ name: docName(...segments) });
const listed = (documents: object[], nextPageToken?: string) => ({
  documents,
  ...(nextPageToken === undefined ? {} : { nextPageToken }),
});
const stream = (...names: string[]) =>
  names.length === 0
    ? [{ readTime: TIME, done: true }]
    : names.map((name, index) =>
        Object.assign(
          { document: { name, createTime: TIME, updateTime: TIME }, readTime: TIME },
          index === names.length - 1 ? { done: true } : {},
        ),
      );

async function scan(handler: FakeHandler, overrides: Partial<KeyScanOptions>) {
  const fake = fakeFirestore(handler);
  const result = await scanFirestoreLevel(
    { cursor: "0", count: 100, level: true, ...overrides },
    fake.client,
    SIGNAL,
    FAKE_BASE,
  );
  return { result, fake };
}

describe("the collection level", () => {
  test("present documents are a key and a folder, a missing parent a folder only, with no mask", async () => {
    const { result, fake } = await scan(
      () => listed([present("users", "alice"), missing("users", "ghost"), present("users", "bob")]),
      { pattern: "users/" },
    );
    expect(fake.sent.map((sent) => sent.request)).toEqual([
      { kind: "listDocuments", parent: [], collectionId: "users", pageSize: 50, showMissing: true },
    ]);
    expect(result).toEqual({
      keys: ["users/alice", "users/bob"],
      prefixes: ["users/alice/", "users/ghost/", "users/bob/"],
      cursor: "0",
      types: {},
      total: 0,
    });
  });

  test("an empty present document is a key: presence is createTime, not fields", async () => {
    const { result } = await scan(() => listed([{ name: docName("users", "empty"), createTime: TIME }]), {
      pattern: "users/",
    });
    expect(result.keys).toEqual(["users/empty"]);
  });

  test("pageSize is half the page's room, at least 1 and at most 50", async () => {
    for (const [count, pageSize] of [
      [1, 1],
      [2, 1],
      [7, 3],
      [100, 50],
      [1000, 50],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one count at a time, so a failure names its page size.
      const { fake } = await scan(() => listed([]), { pattern: "users/", count });
      expect(fake.sent[0].request).toMatchObject({ kind: "listDocuments", pageSize });
    }
  });

  test("Google's page token is carried by the cursor and sent back", async () => {
    const first = await scan(() => listed([present("users", "alice")], "T1"), { pattern: "users/", count: 3 });
    expect(first.result).toMatchObject({ keys: ["users/alice"], prefixes: ["users/alice/"] });
    expect(first.result.cursor).toBe(encodeLevelCursor({ v: 1, p: "users/", t: "T1" }));
    const second = await scan(() => listed([present("users", "bob")]), {
      pattern: "users/",
      count: 3,
      cursor: first.result.cursor,
    });
    expect(second.fake.sent[0].request).toMatchObject({ pageToken: "T1" });
    expect(second.result.cursor).toBe("0");
  });

  test("an odd count that splits a pair owes the folder to the next page", async () => {
    const first = await scan(() => listed([present("users", "alice")], "T1"), { pattern: "users/", count: 1 });
    expect(first.result).toMatchObject({ keys: ["users/alice"], prefixes: [] });
    expect(first.result.cursor).toBe(encodeLevelCursor({ v: 1, p: "users/", t: "T1", o: "users/alice/" }));
    const owed = await scan(() => listed([]), { pattern: "users/", count: 1, cursor: first.result.cursor });
    expect(owed.fake.sent).toHaveLength(0);
    expect(owed.result).toMatchObject({ keys: [], prefixes: ["users/alice/"] });
    expect(owed.result.cursor).toBe(encodeLevelCursor({ v: 1, p: "users/", t: "T1" }));
    const last = await scan(() => listed([present("users", "bob")]), { pattern: "users/", count: 1 });
    expect(last.result.cursor).toBe(encodeLevelCursor({ v: 1, p: "users/", o: "users/bob/" }));
    const end = await scan(() => listed([]), { pattern: "users/", count: 1, cursor: last.result.cursor });
    expect(end.result).toMatchObject({ prefixes: ["users/bob/"], cursor: "0" });
    expect(end.fake.sent).toHaveLength(0);
    const two = await scan(() => listed([present("users", "carol")]), {
      pattern: "users/",
      count: 2,
      cursor: encodeLevelCursor({ v: 1, p: "users/", t: "T2", o: "users/bob/" }),
    });
    expect(two.fake.sent[0].request).toMatchObject({ pageSize: 1, pageToken: "T2" });
    expect(two.result).toMatchObject({ keys: ["users/carol"], prefixes: ["users/bob/"] });
    expect(two.result.cursor).toBe(encodeLevelCursor({ v: 1, p: "users/", o: "users/carol/" }));
  });

  test("a cursor of the id levels' shape, or owing a folder of another level, is refused before any request", async () => {
    const fake = fakeFirestore(() => listed([]));
    for (const cursor of [
      encodeLevelCursor({ v: 1, p: "users/", a: "users/alice/" }),
      encodeLevelCursor({ v: 1, p: "users/", o: "orders/x/" }),
      encodeLevelCursor({ v: 1, p: "users/", o: "users/a/b/" }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one cursor at a time, so a failure names its cursor.
      await expect(
        scanFirestoreLevel({ cursor, count: 10, level: true, pattern: "users/" }, fake.client, SIGNAL, FAKE_BASE),
      ).rejects.toThrow(C.malformed);
    }
    expect(fake.sent).toHaveLength(0);
  });

  test("documents too large for the response cap answer the level's own sentence", async () => {
    const fake = fakeFirestore((_request, _built, sent) => {
      throw tooLargeFailure(sent.context);
    });
    const page = scanFirestoreLevel(
      { cursor: "0", count: 100, level: true, pattern: "users/" },
      fake.client,
      SIGNAL,
      FAKE_BASE,
    );
    await expect(page).rejects.toBeInstanceOf(QueryError);
    await expect(page).rejects.toThrow(`${SENTENCES.keysTooLarge}.`);
    expect(fake.sent[0].options.context.surface).toBe("keys");
  });

  test("a page token Google refuses answers the expired sentence; the same refusal with no token stays Google's", async () => {
    // Production's own answer to an expired or undecodable page token, measured 2026-10-12 against a real project:
    // HTTP 400 {"code": 400, "status": "INVALID_ARGUMENT", "message": "invalid page token"}.
    const refusal = googleFailure(400, "INVALID_ARGUMENT", "invalid page token");
    const fake = fakeFirestore(() => {
      throw refusal;
    });
    const cursor = encodeLevelCursor({ v: 1, p: "users/", t: "garbage" });
    const expired = scanFirestoreLevel(
      { cursor, count: 10, level: true, pattern: "users/" },
      fake.client,
      SIGNAL,
      FAKE_BASE,
    );
    await expect(expired).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(expired).rejects.toThrow(C.expired);
    await expect(
      scanFirestoreLevel({ cursor: "0", count: 10, level: true, pattern: "users/" }, fake.client, SIGNAL, FAKE_BASE),
    ).rejects.toBe(refusal);
  });

  test("ids the id rules refuse are counted, foreign and stray names refused, an oversized page refused", async () => {
    const skipped = await scan(() => listed([present("users", "__bad__"), present("users", "ok")]), {
      pattern: "users/",
    });
    expect(skipped.result).toMatchObject({ keys: ["users/ok"], skipped: { count: 1, reason: S.skipped } });
    const foreign = "projects/other/databases/(default)/documents/users/x";
    await expect(scan(() => listed([{ name: foreign, createTime: TIME }]), { pattern: "users/" })).rejects.toThrow(
      foreignDocumentSentence(foreign),
    );
    await expect(scan(() => listed([present("orders", "x")]), { pattern: "users/" })).rejects.toThrow(
      outsideCollectionSentence(docName("orders", "x")),
    );
    await expect(
      scan(() => listed([present("users", "a"), present("users", "b")]), { pattern: "users/", count: 2 }),
    ).rejects.toThrow(L.malformed);
    for (const answer of [[], { documents: "x" }, { documents: [{}] }, { nextPageToken: 1 }]) {
      // oxlint-disable-next-line no-await-in-loop -- one answer at a time, so a failure names its shape.
      await expect(scan(() => answer, { pattern: "users/" })).rejects.toThrow(L.malformed);
    }
  });

  test("a nested collection and reserved characters round-trip, a colon parent included", async () => {
    const parent = ["c o", "d%#?`\u00e9\u{1D11E}"];
    const { result, fake } = await scan(() => listed([present(...parent, "sub", "x y")]), {
      pattern: "c o/d%#?`\u00e9\u{1D11E}/sub/",
    });
    expect(fake.sent[0].request).toMatchObject({ parent, collectionId: "sub" });
    expect(fake.sent[0].built.path).toContain("/documents/c%20o/d%25%23%3F%60%C3%A9%F0%9D%84%9E/sub");
    expect(result.keys).toEqual(["c o/d%#?`\u00e9\u{1D11E}/sub/x y"]);
    const colon = await scan(() => listed([present("users", "a:b", "orders", "o1")]), {
      pattern: "users/a:b/orders/",
    });
    expect(colon.fake.sent[0].built.path).toContain("/documents/users/a%3Ab/orders");
    expect(colon.result.keys).toEqual(["users/a:b/orders/o1"]);
  });
});

describe("the collection level with a typed id", () => {
  test("a names-only runQuery over the __name__ range answers keys and folders with its readOutcome", async () => {
    const { result, fake } = await scan(() => stream(docName("users", "alfred"), docName("users", "alice")), {
      pattern: "users/al",
    });
    expect(fake.sent[0].request).toEqual({
      kind: "runQuery",
      parent: [],
      body: {
        structuredQuery: {
          select: { fields: [{ fieldPath: "__name__" }] },
          from: [{ collectionId: "users" }],
          where: {
            compositeFilter: {
              op: "AND",
              filters: [
                {
                  fieldFilter: {
                    field: { fieldPath: "__name__" },
                    op: "GREATER_THAN_OR_EQUAL",
                    value: { referenceValue: docName("users", "al") },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: "__name__" },
                    op: "LESS_THAN",
                    value: { referenceValue: docName("users", "am") },
                  },
                },
              ],
            },
          },
          orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
          limit: 50,
        },
      },
    });
    expect(result).toEqual({
      keys: ["users/alfred", "users/alice"],
      prefixes: ["users/alfred/", "users/alice/"],
      cursor: "0",
      types: {},
      total: 0,
      readOutcome: { scope: "unknown", endReason: S.partialUnknown },
    });
    expect(S.partialUnknown).toBe(
      "A typed id lists stored documents only; parents that exist only through their subcollections appear when the collection is listed without one.",
    );
  });

  test("a full page resumes after its last entry, and an odd count owes the folder through the last entry", async () => {
    const full = await scan(() => stream(docName("users", "alfred")), { pattern: "users/al", count: 3 });
    expect(full.result.cursor).toBe(encodeLevelCursor({ v: 1, p: "users/al", a: "users/alfred/" }));
    const next = await scan(() => stream(), { pattern: "users/al", count: 3, cursor: full.result.cursor });
    expect(next.fake.sent[0].request).toMatchObject({
      body: {
        structuredQuery: {
          startAt: { values: [{ referenceValue: docName("users", "alfred") }], before: false },
          limit: 1,
        },
      },
    });
    expect(next.result.cursor).toBe("0");
    const odd = await scan(() => stream(docName("users", "alfred")), { pattern: "users/al", count: 1 });
    expect(odd.result).toMatchObject({ keys: ["users/alfred"], prefixes: [] });
    expect(odd.result.cursor).toBe(encodeLevelCursor({ v: 1, p: "users/al", a: "users/alfred" }));
    const owed = await scan(() => stream(), { pattern: "users/al", count: 1, cursor: odd.result.cursor });
    expect(owed.fake.sent).toHaveLength(0);
    expect(owed.result).toMatchObject({ prefixes: ["users/alfred/"] });
    expect(owed.result.cursor).toBe(encodeLevelCursor({ v: 1, p: "users/al", a: "users/alfred/" }));
  });

  test("the successor increments the last code point, skips surrogates, and has none after U+10FFFF", () => {
    expect(idSuccessor("al")).toBe("am");
    expect(idSuccessor("a\uD7FF")).toBe("a\uE000");
    expect(idSuccessor("a\u{1D11E}")).toBe("a\u{1D11F}");
    expect(idSuccessor("a\u{10FFFF}")).toBeNull();
  });

  test("after U+10FFFF there is no upper bound and the walk stops at the first id outside the partial", async () => {
    const partial = "a\u{10FFFF}";
    const { result, fake } = await scan(() => stream(docName("users", `${partial}x`), docName("users", "b")), {
      pattern: `users/${partial}`,
      count: 4,
    });
    expect(fake.sent[0].request).toMatchObject({
      body: {
        structuredQuery: {
          where: {
            fieldFilter: {
              field: { fieldPath: "__name__" },
              op: "GREATER_THAN_OR_EQUAL",
              value: { referenceValue: docName("users", partial) },
            },
          },
          limit: 2,
        },
      },
    });
    expect(result).toMatchObject({ keys: [`users/${partial}x`], cursor: "0" });
  });

  test("numeric-id partials, colon parents and foreign cursors are refused before any request", async () => {
    const fake = fakeFirestore(() => stream());
    const page = (pattern: string, cursor = "0") =>
      scanFirestoreLevel({ cursor, count: 10, level: true, pattern }, fake.client, SIGNAL, FAKE_BASE);
    await expect(page("users/__id1")).rejects.toThrow(S.numericPartial);
    await expect(page("users/a:b/orders/x")).rejects.toThrow(S.colonSearch);
    await expect(page("users/al", encodeLevelCursor({ v: 1, p: "users/al", t: "T" }))).rejects.toThrow(C.malformed);
    await expect(page("users/al", encodeLevelCursor({ v: 1, p: "users/al", a: "users/bob" }))).rejects.toThrow(
      C.malformed,
    );
    await expect(page("users/al", encodeLevelCursor({ v: 1, p: "users/al", a: "users/al/x" }))).rejects.toThrow(
      C.malformed,
    );
    expect(fake.sent).toHaveLength(0);
  });

  test("refused ids are counted, an oversized answer refused, and a cap failure worded for the level", async () => {
    // Only "." and ".." themselves are refused, so "al.." is an id like any other.
    const kept = await scan(() => stream(docName("users", "al.."), docName("users", "alice")), {
      pattern: "users/al",
    });
    expect(kept.result).toMatchObject({ keys: ["users/al..", "users/alice"] });
    const counted = await scan(() => stream(docName("users", "__a__"), docName("users", "__b__")), {
      pattern: "users/_",
    });
    expect(counted.result.skipped).toEqual({ count: 2, reason: S.skipped });
    await expect(
      scan(() => stream(docName("users", "ala"), docName("users", "alb")), { pattern: "users/al", count: 2 }),
    ).rejects.toThrow(L.malformed);
    await expect(
      scan(
        (_request, _built, sent) => {
          throw tooLargeFailure(sent.context);
        },
        { pattern: "users/al" },
      ),
    ).rejects.toThrow(SENTENCES.keysTooLarge);
  });

  test("scanFirestoreLevel sends the root and document levels to the id listing", async () => {
    const { result } = await scan(() => ({ collectionIds: ["users"] }), {});
    expect(result.prefixes).toEqual(["users/"]);
  });
});
