/**
 * The Keys panel's id levels (spec 5.3): the root lists top-level collection ids and a document level its
 * subcollection ids, each read whole with `listCollectionIdsSorted` on every page (at most 10 requests of 1,000 ids),
 * filtered by the partial, sorted by UTF-8 bytes and paged after the cursor's last entry; every option, pattern and
 * cursor refusal comes before any request, a document id holding a colon is refused with its own sentence, and every
 * request carries the credential's forms, so a Google message quoting the credential is withheld (S7).
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE, SENTENCES } from "@/lib/db/providers/document/firestore/constants";
import { encodeLevelCursor, FIRESTORE_CURSOR_SENTENCES as C } from "@/lib/db/providers/document/firestore/cursor";
import { ERROR_SENTENCES } from "@/lib/db/providers/document/firestore/errors";
import {
  FIRESTORE_KEY_SCAN,
  FIRESTORE_KEY_SCAN_SENTENCES as S,
  parseLevelPattern,
  readLevelRequest,
  scanIdLevel,
} from "@/lib/db/providers/document/firestore/key-scan";
import { idRefusal } from "@/lib/db/providers/document/firestore/names";
import {
  type CallBase,
  callContext,
  FIRESTORE_LISTING_SENTENCES as L,
  listCollectionIdsSorted,
} from "@/lib/db/providers/document/firestore/objects";
import type { KeyScanOptions } from "@/lib/db/types";
import {
  FAKE_BASE,
  FAKE_TARGET,
  type FakeHandler,
  fakeFirestore,
  googleFailure,
  tooLargeFailure,
} from "../../../helpers/firestore-fake-client";

const SIGNAL = new AbortController().signal;
const ids = (collectionIds: string[], nextPageToken?: string) => ({
  collectionIds,
  ...(nextPageToken === undefined ? {} : { nextPageToken }),
});
const options = (overrides: Partial<KeyScanOptions>): KeyScanOptions => ({
  cursor: "0",
  count: 100,
  level: true,
  ...overrides,
});

async function page(handler: FakeHandler, overrides: Partial<KeyScanOptions>, base: CallBase = FAKE_BASE) {
  const fake = fakeFirestore(handler);
  const result = await scanIdLevel(readLevelRequest(options(overrides)), fake.client, SIGNAL, base);
  return { result, fake };
}

function refused(overrides: Partial<KeyScanOptions>): string {
  try {
    readLevelRequest(options(overrides));
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as DatabaseConfigError).provider).toBe(FIRESTORE_TYPE);
    return (error as Error).message;
  }
  throw new Error("the request was not refused");
}

describe("the declaration and the pattern", () => {
  test("the Keys panel declaration", () => {
    expect(FIRESTORE_KEY_SCAN).toEqual({
      defaultCount: 100,
      maxCount: 1000,
      separator: "/",
      cursor: "opaque",
      pattern: "prefix",
      totalScope: "none",
      levels: { rootKind: "collection" },
    });
    expect(Object.isFrozen(FIRESTORE_KEY_SCAN)).toBe(true);
  });

  test("complete segments name the level and the text after the last slash filters it", () => {
    expect(parseLevelPattern("")).toEqual({ complete: [], partial: "" });
    expect(parseLevelPattern("us")).toEqual({ complete: [], partial: "us" });
    expect(parseLevelPattern("users/")).toEqual({ complete: ["users"], partial: "" });
    expect(parseLevelPattern("users/al")).toEqual({ complete: ["users"], partial: "al" });
    expect(parseLevelPattern("users/alice/")).toEqual({ complete: ["users", "alice"], partial: "" });
    expect(parseLevelPattern("users/alice/or")).toEqual({ complete: ["users", "alice"], partial: "or" });
  });

  test("every option, pattern and cursor refusal comes before any request", () => {
    expect(refused({ count: 0 })).toBe(S.count);
    expect(refused({ count: 1001 })).toBe(S.count);
    expect(refused({ count: 1.5 })).toBe(S.count);
    expect(refused({ database: 0 })).toBe(S.database);
    expect(refused({ level: undefined })).toBe(S.levelOnly);
    expect(refused({ pattern: "us\ud800" })).toBe(S.notText);
    expect(refused({ pattern: "users//" })).toBe(S.emptySegment);
    expect(refused({ pattern: "/users" })).toBe(S.emptySegment);
    expect(refused({ pattern: "__x__/" })).toBe(idRefusal("__x__", "collection") as string);
    expect(refused({ pattern: "users/../" })).toBe(idRefusal("..", "document") as string);
    expect(() => readLevelRequest(options({ pattern: `users/${"x".repeat(1500)}` }))).not.toThrow();
    expect(refused({ pattern: `users/${"x".repeat(1501)}` })).toBe(S.partialTooLong);
    expect(refused({ cursor: "zzz" })).toBe(C.notEnvelope);
    expect(refused({ cursor: encodeLevelCursor({ v: 1, p: "users/", a: "users/x/" }) })).toBe(C.otherLevel);
  });
});

describe("the root level", () => {
  test("lists top-level collections as folders in UTF-8 byte order, with one id listing", async () => {
    const { result, fake } = await page(() => ids(["\u{1D11E}", "｡x", "users", "a", "a-b"]), {});
    // UTF-16 puts U+1D11E (D834) before U+FF61, and UTF-8 the other way round; "a-b/" sorts before "a/".
    expect(result).toEqual({
      keys: [],
      prefixes: ["a-b/", "a/", "users/", "｡x/", "\u{1D11E}/"],
      cursor: "0",
      types: {},
      total: 0,
    });
    expect(fake.sent.map((sent) => sent.request)).toEqual([{ kind: "listCollectionIds", parent: [], pageSize: 1000 }]);
    expect(fake.sent[0].options.context).toEqual(callContext(fake.client, FAKE_BASE, "listing", "keys"));
  });

  test("a partial id filters the root", async () => {
    const { result } = await page(() => ids(["users", "usage", "orders"]), { pattern: "us" });
    expect(result.prefixes).toEqual(["usage/", "users/"]);
  });

  test("pages after the last entry and re-reads the list on every page, so a new id neither skips nor repeats", async () => {
    const first = await page(() => ids(["a", "b", "c", "d", "e"]), { count: 2 });
    expect(first.result.prefixes).toEqual(["a/", "b/"]);
    expect(first.result.cursor).toBe(encodeLevelCursor({ v: 1, p: "", a: "b/" }));
    const second = await page(() => ids(["a", "b", "bb", "c", "d", "e"]), { count: 2, cursor: first.result.cursor });
    expect(second.result.prefixes).toEqual(["bb/", "c/"]);
    expect(second.fake.sent).toHaveLength(1);
    const third = await page(() => ids(["a", "b", "c", "d", "e"]), {
      count: 2,
      cursor: encodeLevelCursor({ v: 1, p: "", a: "d/" }),
    });
    expect(third.result).toMatchObject({ prefixes: ["e/"], cursor: "0" });
  });

  test("a level whose remaining ids exactly fill the page ends it", async () => {
    const exact = await page(() => ids(["a", "b"]), { count: 2 });
    expect(exact.result).toMatchObject({ prefixes: ["a/", "b/"], cursor: "0" });
  });

  test("a cursor of the collection level's shape is refused before any request", async () => {
    const fake = fakeFirestore(() => ids(["users"]));
    const request = readLevelRequest(options({ cursor: encodeLevelCursor({ v: 1, p: "", t: "T" }) }));
    await expect(scanIdLevel(request, fake.client, SIGNAL, FAKE_BASE)).rejects.toThrow(C.malformed);
    expect(fake.sent).toHaveLength(0);
  });

  test("ids the id rules refuse are counted on the first page and not listed", async () => {
    const answer = () => ids(["users", "__bad__", ".", "users"]);
    const { result } = await page(answer, {});
    expect(result.prefixes).toEqual(["users/"]);
    expect(result.skipped).toEqual({ count: 2, reason: S.skipped });
    const later = await page(answer, { cursor: encodeLevelCursor({ v: 1, p: "", a: "a/" }) });
    expect(later.result.skipped).toBeUndefined();
  });

  test("a list that stops at the page cap answers an incomplete read naming the cap", async () => {
    let served = 0;
    const { result, fake } = await page(() => {
      served += 1;
      return ids([`c${String(served).padStart(2, "0")}`], `T${served}`);
    }, {});
    expect(fake.sent).toHaveLength(10);
    expect(fake.sent[0].request).toEqual({ kind: "listCollectionIds", parent: [], pageSize: 1000 });
    expect(fake.sent[1].request).toEqual({ kind: "listCollectionIds", parent: [], pageSize: 1000, pageToken: "T1" });
    expect(result.prefixes).toHaveLength(10);
    expect(result.readOutcome).toEqual({ scope: "incomplete", endReason: L.idCap });
    expect(L.idCap).toBe(
      "Studio stops after 10 id listing requests at one level, so ids past the ones those requests returned are not listed.",
    );
  });

  test("an id listing too large for its cap answers the Keys panel's sentence", async () => {
    const failure = page((_request, _built, sent) => {
      throw tooLargeFailure(sent.context);
    }, {});
    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(SENTENCES.keysTooLarge);
  });

  test("a Google message quoting the pasted token is withheld on a Keys page (S7)", async () => {
    const base: CallBase = { credential: "access_token", secretForms: ["ya29.pasted-secret"] };
    const failure = (await page(
      (_request, _built, sent) => {
        throw googleFailure(403, "PERMISSION_DENIED", "Bearer ya29.pasted-secret lacks access", sent.context);
      },
      {},
      base,
    ).then(
      () => undefined,
      (error: unknown) => error,
    )) as Error;
    expect(failure.message).not.toContain("ya29.pasted-secret");
    expect(failure.message).toContain(ERROR_SENTENCES.withheld);
  });
});

describe("the document level", () => {
  test("lists a document's subcollections, filtered by a partial", async () => {
    const all = await page(() => ids(["orders", "likes"]), { pattern: "users/alice/" });
    expect(all.fake.sent[0].request).toEqual({ kind: "listCollectionIds", parent: ["users", "alice"], pageSize: 1000 });
    expect(all.result.prefixes).toEqual(["users/alice/likes/", "users/alice/orders/"]);
    const typed = await page(() => ids(["orders", "likes"]), { pattern: "users/alice/or" });
    expect(typed.result.prefixes).toEqual(["users/alice/orders/"]);
  });

  test("a document id holding a colon is refused with its own sentence before any request", async () => {
    const fake = fakeFirestore(() => ids(["orders"]));
    const request = readLevelRequest(options({ pattern: "users/a:b/" }));
    await expect(scanIdLevel(request, fake.client, SIGNAL, FAKE_BASE)).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(scanIdLevel(request, fake.client, SIGNAL, FAKE_BASE)).rejects.toThrow(
      SENTENCES.colonSubcollections("users/a:b"),
    );
    expect(fake.sent).toHaveLength(0);
  });

  test("ids with reserved URL characters round-trip through the encoded path", async () => {
    const { result, fake } = await page(() => ids(["s p", "%x"]), { pattern: "c o/d%#?`é\u{1D11E}/" });
    expect(fake.sent[0].request).toEqual({
      kind: "listCollectionIds",
      parent: ["c o", "d%#?`é\u{1D11E}"],
      pageSize: 1000,
    });
    expect(fake.sent[0].built.path).toContain("/documents/c%20o/d%25%23%3F%60%C3%A9%F0%9D%84%9E:listCollectionIds");
    expect(result.prefixes).toEqual(["c o/d%#?`é\u{1D11E}/%x/", "c o/d%#?`é\u{1D11E}/s p/"]);
    const root = await page(() => ids(["a b#?"]), {});
    expect(root.result.prefixes).toEqual(["a b#?/"]);
  });
});

describe("listCollectionIdsSorted", () => {
  test("joins pages, drops repeats, sorts by UTF-8 bytes and stops at the last page", async () => {
    let served = 0;
    const fake = fakeFirestore(() => (++served === 1 ? ids(["b", "a"], "T") : ids(["c", "b"], "")));
    expect(await listCollectionIdsSorted(fake.client, [], SIGNAL, FAKE_BASE, "tree")).toEqual({
      ids: ["a", "b", "c"],
      complete: true,
      skipped: 0,
    });
    expect(fake.sent).toHaveLength(2);
  });

  test("every request carries the surface that asked", async () => {
    for (const surface of ["keys", "tree", "source", "console"] as const) {
      const fake = fakeFirestore(() => ({}));
      // oxlint-disable-next-line no-await-in-loop -- each surface gets its own client, checked in turn.
      await listCollectionIdsSorted(fake.client, [], SIGNAL, FAKE_BASE, surface);
      expect(fake.sent[0].options.context).toEqual(callContext(fake.client, FAKE_BASE, "listing", surface));
    }
  });

  test("an answer it cannot read is refused", async () => {
    for (const answer of [[], { collectionIds: "users" }, { collectionIds: [1] }, { nextPageToken: 5 }]) {
      const fake = fakeFirestore(() => answer);
      const read = listCollectionIdsSorted(fake.client, [], SIGNAL, FAKE_BASE, "tree");
      // oxlint-disable-next-line no-await-in-loop -- each answer gets its own client, checked in turn.
      await expect(read).rejects.toBeInstanceOf(QueryError);
      // oxlint-disable-next-line no-await-in-loop -- the same read, checked for its sentence.
      await expect(read).rejects.toThrow(L.malformed);
    }
  });

  test("an empty answer lists nothing", async () => {
    const fake = fakeFirestore(() => ({}));
    expect(await listCollectionIdsSorted(fake.client, ["users", "alice"], SIGNAL, FAKE_BASE, "source")).toEqual({
      ids: [],
      complete: true,
      skipped: 0,
    });
  });

  test("callContext names the phase, the credential, its forms, the target and the surface", () => {
    const fake = fakeFirestore(() => ({}));
    const base: CallBase = { credential: "access_token", secretForms: ["ya29.x"] };
    expect(callContext(fake.client, base, "listing", "keys")).toEqual({
      phase: "listing",
      credential: "access_token",
      secretForms: ["ya29.x"],
      target: FAKE_TARGET,
      surface: "keys",
    });
    expect(callContext(fake.client, base, "connect")).toEqual({
      phase: "connect",
      credential: "access_token",
      secretForms: ["ya29.x"],
      target: FAKE_TARGET,
    });
  });
});
