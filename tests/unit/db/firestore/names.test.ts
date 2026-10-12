/**
 * Firestore ids, paths and resource names. The encoding table is gap lane G4's: every id there survived the emulator
 * once each path segment was percent-encoded on its own, and the shared rfc3986Encode spells each the same way, so
 * the browser-safe encoder here is pinned to it. The order is gap lane G2's: UTF-8 bytes, which UTF-16 order is not.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { rfc3986Encode } from "@/lib/db/http/endpoint";
import { FIRESTORE_TYPE } from "@/lib/db/providers/document/firestore/constants";
import {
  compareUtf8,
  databaseIdRefusal,
  databaseName,
  documentsName,
  encodeSegment,
  encodeSegments,
  type FirestoreTarget,
  fullDocumentName,
  idRefusal,
  isDocumentPath,
  NAME_SENTENCES as N,
  projectIdRefusal,
  relativeSegments,
  segmentsRefusal,
  splitPath,
  verbParentHasColon,
} from "@/lib/db/providers/document/firestore/names";

const T: FirestoreTarget = { projectId: "demo-libredb", databaseId: "(default)" };
const ROOT = "projects/demo-libredb/databases/(default)/documents";

/** Gap lane G4's ids, each with the spelling a path segment must carry. */
const G4_IDS: readonly (readonly [string, string])[] = [
  ["a:b", "a%3Ab"],
  ["x:runQuery", "x%3ArunQuery"],
  ["a b", "a%20b"],
  ["a%b", "a%25b"],
  ["a%2Fb", "a%252Fb"],
  ["a#b", "a%23b"],
  ["a?b", "a%3Fb"],
  ["a`b", "a%60b"],
  ["\u00e7a\u011fr\u0131-\u65e5\u672c", "%C3%A7a%C4%9Fr%C4%B1-%E6%97%A5%E6%9C%AC"],
  ["e\u{1F600}", "e%F0%9F%98%80"],
  ["a+b", "a%2Bb"],
  ["a!b", "a%21b"],
  ["a'b", "a%27b"],
  ["a*b", "a%2Ab"],
  ["(default)", "%28default%29"],
  ["~._-", "~._-"],
];

/** Gap lane G2's ids: ASCII case and punctuation, a combining mark, CJK, U+FF5E, an astral character, U+FFFD. */
const G2_IDS: readonly string[] = [
  "Zed",
  "alpha",
  "Alpha",
  "10",
  "9",
  "_under",
  "a_b",
  "aZ",
  "a~",
  "\u00e9mile",
  "e\u0301",
  "\u65e5\u672c",
  "\uFF5E",
  "\u{1F600}",
  "\uFFFD",
  "z",
  "\u00e9",
];

function queryRefusal(run: () => unknown): string {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(QueryError);
  expect((caught as QueryError).provider).toBe(FIRESTORE_TYPE);
  return (caught as Error).message;
}

describe("per-segment encoding (G4)", () => {
  test.each(G4_IDS)("%p is sent as %p, the shared encoder's spelling, and decodes back exactly", (id, encoded) => {
    expect(encodeSegment(id)).toBe(encoded);
    expect(encodeSegment(id)).toBe(rfc3986Encode(id));
    expect(decodeURIComponent(encoded)).toBe(id);
  });

  test("each id stays one segment as a document id, as a parent and as a collection id, and round-trips by name", () => {
    for (const [id, encoded] of G4_IDS) {
      expect(idRefusal(id, "document")).toBeNull();
      expect(idRefusal(id, "collection")).toBeNull();
      expect(encodeSegments(["c", id])).toBe(`c/${encoded}`);
      expect(encodeSegments(["c", id, "sub", "d"])).toBe(`c/${encoded}/sub/d`);
      expect(encodeSegments([id])).toBe(encoded);
      expect(encodeSegments(["c", "plain", id])).toBe(`c/plain/${encoded}`);
      const name = fullDocumentName(T, ["c", id]);
      expect(name).toBe(`${ROOT}/c/${id}`);
      expect(relativeSegments(T, name)).toEqual(["c", id]);
      expect(splitPath(`c/${id}/sub/d`)).toEqual(["c", id, "sub", "d"]);
    }
  });

  test("a lone surrogate is refused here as in the shared encoder", () => {
    expect(() => encodeSegment("a\uD800")).toThrow(DatabaseConfigError);
    expect(() => encodeSegment("a\uD800")).toThrow(N.invalidText);
    expect(() => rfc3986Encode("a\uD800")).toThrow(N.invalidText);
  });

  test("a colon in the last segment of a verb parent is caught; in an earlier segment it is not", () => {
    expect(verbParentHasColon(["c", "a:b"])).toBe(true);
    expect(verbParentHasColon(["c", "x:runQuery"])).toBe(true);
    expect(verbParentHasColon(["c", "a:b", "sub", "d"])).toBe(false);
    expect(verbParentHasColon(["c", "plain"])).toBe(false);
    expect(verbParentHasColon([])).toBe(false);
  });
});

describe("compareUtf8 (G2)", () => {
  test("sorts as UTF-8 bytes, where UTF-16 code-unit order differs", () => {
    const bytes = [...G2_IDS].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    expect([...G2_IDS].sort(compareUtf8)).toEqual(bytes);
    expect(compareUtf8("\uFF5E", "\u{1F600}")).toBe(-1);
    expect("\uFF5E" < "\u{1F600}").toBe(false);
  });

  test("equal strings, prefixes and astral neighbours", () => {
    expect(compareUtf8("a", "a")).toBe(0);
    expect(compareUtf8("", "")).toBe(0);
    expect(compareUtf8("a", "ab")).toBe(-1);
    expect(compareUtf8("ab", "a")).toBe(1);
    expect(compareUtf8("\u{1F600}", "\u{1F601}")).toBe(-1);
    expect(compareUtf8("\u{1F600}b", "\u{1F600}a")).toBe(1);
  });
});

describe("id rules (spec 4.1)", () => {
  test.each([
    "demo-libredb",
    "abcdef",
    `a${"b".repeat(29)}`,
    "my-project-123",
    "example.com:my-project",
    "a-b:my-project",
  ])("project id %p is accepted", (id) => expect(projectIdRefusal(id)).toBeNull());

  test.each([
    "",
    "abcde",
    `a${"b".repeat(30)}`,
    "1project",
    "Project-x",
    "project-",
    ":project1",
    "my_project",
    "EX.com:project1",
  ])("project id %p is refused", (id) => expect(projectIdRefusal(id)).toBe(N.projectId));

  test.each(["(default)", "default", "orders", "abcd", `a${"b".repeat(62)}`, "orders-2026"])(
    "database id %p is accepted",
    (id) => expect(databaseIdRefusal(id)).toBeNull(),
  );

  test.each(["", "abc", `a${"b".repeat(63)}`, "Orders", "1db", "db-", "abcdef01-2345-6789-abcd-ef0123456789"])(
    "database id %p is refused",
    (id) => expect(databaseIdRefusal(id)).toBe(N.databaseId),
  );

  test("collection and document ids", () => {
    expect(idRefusal("", "document")).toBe(N.idEmpty("document"));
    expect(idRefusal("a\uD800", "collection")).toBe(N.idMalformed("collection"));
    expect(idRefusal("x".repeat(1_500), "document")).toBeNull();
    expect(idRefusal("x".repeat(1_501), "document")).toBe(N.idTooLong("document"));
    expect(idRefusal("\u00e9".repeat(751), "collection")).toBe(N.idTooLong("collection"));
    expect(idRefusal("a/b", "document")).toBe(N.idSlash("document"));
    expect(idRefusal(".", "collection")).toBe(N.idDots("collection"));
    expect(idRefusal("..", "document")).toBe(N.idDots("document"));
    expect(idRefusal("__x__", "document")).toBe(N.idReserved("document"));
    expect(idRefusal("____", "collection")).toBe(N.idReserved("collection"));
    expect(idRefusal("__id42__", "document")).toBeNull();
    expect(idRefusal("__id42__", "collection")).toBe(N.idReserved("collection"));
    expect(idRefusal("__idx__", "document")).toBe(N.idReserved("document"));
    expect(idRefusal("___", "document")).toBeNull();
    expect(idRefusal("__a", "document")).toBeNull();
  });

  test("the sentences", () => {
    expect(N.idEmpty("document")).toBe("A document id cannot be empty");
    expect(N.idReserved("document")).toBe(
      'A document id cannot start and end with "__", except a numeric id from a Datastore import, such as __id42__',
    );
    expect(N.idReserved("collection")).toBe('A collection id cannot start and end with "__"');
    expect(N.pathSegment(2, "document", "A document id cannot be empty")).toBe(
      "Segment 2 of the Firestore path is not a valid document id: A document id cannot be empty",
    );
  });
});

describe("paths and resource names", () => {
  test("splitPath gives each segment, collection ids at odd positions and document ids at even ones", () => {
    expect(splitPath("users")).toEqual(["users"]);
    expect(splitPath("users/alice/orders/o1")).toEqual(["users", "alice", "orders", "o1"]);
    expect(splitPath("users/__id7__")).toEqual(["users", "__id7__"]);
  });

  test("splitPath refuses with the bad segment's position and kind", () => {
    expect(queryRefusal(() => splitPath(""))).toBe(N.pathEmpty);
    expect(queryRefusal(() => splitPath("users//x"))).toBe(N.pathSegment(2, "document", N.idEmpty("document")));
    expect(queryRefusal(() => splitPath("users/"))).toBe(N.pathSegment(2, "document", N.idEmpty("document")));
    expect(queryRefusal(() => splitPath("/users"))).toBe(N.pathSegment(1, "collection", N.idEmpty("collection")));
    expect(queryRefusal(() => splitPath("__x__/a"))).toBe(N.pathSegment(1, "collection", N.idReserved("collection")));
    expect(queryRefusal(() => splitPath("users/alice/__id7__"))).toBe(
      N.pathSegment(3, "collection", N.idReserved("collection")),
    );
    expect(queryRefusal(() => splitPath("users/./x"))).toBe(N.pathSegment(2, "document", N.idDots("document")));
  });

  test("segmentsRefusal answers null for valid segments and the first refusal otherwise", () => {
    expect(segmentsRefusal([])).toBeNull();
    expect(segmentsRefusal(["users", "alice"])).toBeNull();
    expect(segmentsRefusal(["users", "..", "__x__"])).toBe(N.pathSegment(2, "document", N.idDots("document")));
  });

  test("isDocumentPath: a non-zero even count", () => {
    expect(isDocumentPath([])).toBe(false);
    expect(isDocumentPath(["users"])).toBe(false);
    expect(isDocumentPath(["users", "alice"])).toBe(true);
    expect(isDocumentPath(["users", "alice", "orders"])).toBe(false);
  });

  test("database, documents and full document names", () => {
    expect(databaseName(T)).toBe("projects/demo-libredb/databases/(default)");
    expect(databaseName({ projectId: "demo-libredb", databaseId: "orders" })).toBe(
      "projects/demo-libredb/databases/orders",
    );
    expect(documentsName(T)).toBe(ROOT);
    expect(fullDocumentName(T, [])).toBe(ROOT);
    expect(fullDocumentName(T, ["users", "alice"])).toBe(`${ROOT}/users/alice`);
  });

  test("relativeSegments answers this database's names and null for every other", () => {
    expect(relativeSegments(T, ROOT)).toEqual([]);
    expect(relativeSegments(T, `${ROOT}/users`)).toEqual(["users"]);
    expect(relativeSegments(T, `${ROOT}/users/alice`)).toEqual(["users", "alice"]);
    expect(relativeSegments(T, "projects/other-project/databases/(default)/documents/users/alice")).toBeNull();
    expect(relativeSegments(T, "projects/demo-libredb/databases/orders/documents/users/alice")).toBeNull();
    expect(relativeSegments(T, "projects/demo-libredb/databases/(default)/documentsX/users")).toBeNull();
    expect(relativeSegments(T, `${ROOT}/users/__x__`)).toBeNull();
    expect(relativeSegments(T, `${ROOT}/users//x`)).toBeNull();
    expect(relativeSegments(T, "users/alice")).toBeNull();
  });
});
