/**
 * The statements Studio writes for the tree and the Source tab, and the plan-mode sentence: every generated
 * statement re-parses to the same path for every valid id (spec 5.4, 9).
 */
import { describe, expect, test } from "bun:test";
import {
  countStatement,
  FIRESTORE_STATEMENT_EXAMPLES,
  FIRESTORE_STATEMENT_LANGUAGE,
  jsString,
  previewStatement,
} from "@/lib/db/providers/document/firestore/console/generators";
import { parseStatement } from "@/lib/db/providers/document/firestore/console/parser";
import { idRefusal } from "@/lib/db/providers/document/firestore/names";
import { seededRandom } from "../../../helpers/firestore-console";

const ALPHABET = [
  "a",
  "Z",
  "0",
  "_",
  " ",
  '"',
  "'",
  "\\",
  "\n",
  "\r",
  "\t",
  "$",
  "{",
  "}",
  "`",
  ":",
  "%",
  "#",
  "?",
  ".",
  "-",
  "é",
  "中",
  "𠀀",
  String.fromCharCode(0x2028),
  "\u0001",
  "\ud800",
];

function randomId(random: () => number, kind: "collection" | "document"): string {
  for (;;) {
    const length = 1 + Math.floor(random() * 12);
    let id = "";
    for (let index = 0; index < length; index++) id += ALPHABET[Math.floor(random() * ALPHABET.length)];
    if (idRefusal(id, kind) === null) return id;
  }
}

describe("generated statements", () => {
  test("the tree's preview and count", () => {
    expect(previewStatement(["users"])).toBe('db.collection("users").limit(100)');
    expect(countStatement(["users", "alice", "orders"])).toBe('db.collection("users/alice/orders").count()');
  });

  test("jsString escapes what a double-quoted string cannot hold and keeps the rest", () => {
    expect(jsString('a"b\\c\n\r\t')).toBe('"a\\"b\\\\c\\n\\r\\t"');
    expect(jsString(`\u0001\u007f${String.fromCharCode(0x2028, 0x2029)}`)).toBe('"\\u0001\\u007f\\u2028\\u2029"');
    expect(jsString("\ud800x")).toBe('"\\ud800x"');
    expect(jsString("\udc00")).toBe('"\\udc00"');
    expect(jsString("é𠀀`${'")).toBe('"é𠀀`${\'"');
  });

  test("every generated statement parses back to the same path for random valid ids", () => {
    const random = seededRandom(0x5eed);
    for (let iteration = 0; iteration < 2_000; iteration++) {
      const segments = 1 + 2 * Math.floor(random() * 3);
      const path = Array.from({ length: segments }, (_, index) =>
        randomId(random, index % 2 === 0 ? "collection" : "document"),
      );
      expect(parseStatement(previewStatement(path))).toMatchObject({
        kind: "query",
        source: { kind: "collection", path },
        ops: { limit: { value: 100 } },
      });
      expect(parseStatement(countStatement(path))).toMatchObject({ kind: "aggregate", source: { path } });
    }
  });
});

describe("the plan-mode sentence", () => {
  test("names the subset and quotes one example, which parses", () => {
    expect(FIRESTORE_STATEMENT_EXAMPLES).toHaveLength(1);
    for (const example of FIRESTORE_STATEMENT_EXAMPLES) {
      expect(FIRESTORE_STATEMENT_LANGUAGE).toContain(example);
      expect(() => parseStatement(example)).not.toThrow();
    }
    expect(FIRESTORE_STATEMENT_LANGUAGE).toContain("starting at db");
  });
});
