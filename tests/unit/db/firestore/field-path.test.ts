/**
 * Field paths as the console reads them and as the REST API takes them (spec 5.4).
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE } from "@/lib/db/providers/document/firestore/constants";
import {
  DOCUMENT_ID,
  displayFieldPath,
  FIELD_PATH_SENTENCES as F,
  fieldPathOf,
  isDocumentId,
  parseFieldPathString,
  wireFieldPath,
} from "@/lib/db/providers/document/firestore/field-path";

function refusal(run: () => unknown): string {
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

describe("parseFieldPathString", () => {
  test("splits on dots", () => {
    expect(parseFieldPathString("a")).toEqual(["a"]);
    expect(parseFieldPathString("a.b.c")).toEqual(["a", "b", "c"]);
    expect(parseFieldPathString("a b.ç")).toEqual(["a b", "ç"]);
    expect(parseFieldPathString("`a`")).toEqual(["`a`"]);
    expect(Object.isFrozen(parseFieldPathString("a.b"))).toBe(true);
  });

  test("__name__ is the document id", () => {
    expect(parseFieldPathString("__name__")).toEqual(DOCUMENT_ID);
    expect(isDocumentId(parseFieldPathString("__name__"))).toBe(true);
  });

  test.each(["", "a*b", "a~b", "a/b", "a[0]", "a]b"])("%p is refused for its characters", (text) => {
    expect(refusal(() => parseFieldPathString(text))).toBe(F.characters);
  });

  test.each(["a..b", ".a", "a.", "."])("%p is refused for an empty segment", (text) => {
    expect(refusal(() => parseFieldPathString(text))).toBe(F.emptySegment);
  });

  test("a lone surrogate is refused", () => {
    expect(refusal(() => parseFieldPathString("a\uD800"))).toBe(F.malformed);
  });
});

describe("fieldPathOf (new FieldPath(...))", () => {
  test("takes the segments verbatim, dots and all", () => {
    expect(fieldPathOf(["a.b", "c"])).toEqual(["a.b", "c"]);
    expect(fieldPathOf(["*", "[x]"])).toEqual(["*", "[x]"]);
    expect(Object.isFrozen(fieldPathOf(["a"]))).toBe(true);
  });

  test("refuses no segment, an empty segment and a lone surrogate", () => {
    expect(refusal(() => fieldPathOf([]))).toBe(F.noSegments);
    expect(refusal(() => fieldPathOf(["a", ""]))).toBe(F.emptyName);
    expect(refusal(() => fieldPathOf(["\uD800"]))).toBe(F.malformed);
  });
});

describe("wireFieldPath, displayFieldPath, isDocumentId", () => {
  test("simple segments go bare, every other is backtick-quoted with \\ and ` escaped", () => {
    expect(wireFieldPath(["a", "b_1"])).toBe("a.b_1");
    expect(wireFieldPath(["_x", "Y9"])).toBe("_x.Y9");
    expect(wireFieldPath(["a.b"])).toBe("`a.b`");
    expect(wireFieldPath(["1a"])).toBe("`1a`");
    expect(wireFieldPath(["a b", "c"])).toBe("`a b`.c");
    expect(wireFieldPath(["ç"])).toBe("`ç`");
    expect(wireFieldPath(["a`b"])).toBe("`a\\`b`");
    expect(wireFieldPath(["a\\b"])).toBe("`a\\\\b`");
    expect(wireFieldPath(DOCUMENT_ID)).toBe("__name__");
  });

  test("display joins segments with dots", () => {
    expect(displayFieldPath(["a.b", "c"])).toBe("a.b.c");
    expect(displayFieldPath(DOCUMENT_ID)).toBe("__name__");
  });

  test("only the one-segment __name__ is the document id", () => {
    expect(isDocumentId(DOCUMENT_ID)).toBe(true);
    expect(isDocumentId(["__name__", "x"])).toBe(false);
    expect(isDocumentId(["x"])).toBe(false);
    expect(Object.isFrozen(DOCUMENT_ID)).toBe(true);
  });
});
