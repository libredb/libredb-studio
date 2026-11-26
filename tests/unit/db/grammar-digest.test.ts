/**
 * The grammar digest (src/lib/db/grammar-digest.ts): the SHA-256 of a SQL grammar's canonical text, which the grant
 * reader compares with the grammar a register row reviewed. The canonical text is read here on hand-made values, and
 * the digest against node's SHA-256 of that text; the census of every legacy row's digest against its declaration's
 * grammar is tests/unit/db/grant-register-legacy-rows.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalGrammarText, grammarSha256 } from "@/lib/db/grammar-digest";

describe("the canonical text", () => {
  test("every object's members are written in ascending code-unit order and every list in its own order, with no white space", () => {
    expect(canonicalGrammarText({ b: [2, { z: null, a: "x" }], a: true, B: "upper" })).toBe(
      '{"B":"upper","a":true,"b":[2,{"a":"x","z":null}]}',
    );
    expect(canonicalGrammarText({ a: 1, b: 2 })).toBe(canonicalGrammarText({ b: 2, a: 1 }));
    expect(canonicalGrammarText([1, 2])).not.toBe(canonicalGrammarText([2, 1]));
  });

  test("a value that is not JSON is refused by name, never written as a default", () => {
    for (const [value, name] of [
      [undefined, "undefined"],
      [Number.NaN, "number"],
      [() => 1, "function"],
      [{ a: { b: undefined } }, "undefined"],
    ] as const) {
      expect(() => canonicalGrammarText(value)).toThrow(
        `a grammar's canonical text holds JSON values only, and this grammar holds a value of type ${name}`,
      );
    }
  });
});

describe("the digest", () => {
  test("the digest is node's SHA-256 of the canonical text, in lower-case hex: one digest whatever the member order, another for any changed fact", () => {
    const grammar = { hash: "comment", script: { unit: "statement", blocks: "none" }, confirmExemptForms: [["ALTER"]] };
    const reordered = {
      confirmExemptForms: [["ALTER"]],
      script: { blocks: "none", unit: "statement" },
      hash: "comment",
    };

    expect(grammarSha256(grammar)).toBe(createHash("sha256").update(canonicalGrammarText(grammar)).digest("hex"));
    expect(grammarSha256(grammar)).toMatch(/^[0-9a-f]{64}$/);
    expect(grammarSha256(reordered)).toBe(grammarSha256(grammar));
    expect(grammarSha256({ ...grammar, hash: "code" })).not.toBe(grammarSha256(grammar));
    expect(grammarSha256({ ...grammar, confirmExemptForms: [] })).not.toBe(grammarSha256(grammar));
  });
});
