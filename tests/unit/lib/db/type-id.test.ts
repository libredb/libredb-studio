/**
 * The one check of a connection's `type` against the `DatabaseType` union (FND-1). A stored or submitted record may
 * carry any value there, so a surface that reads a per-engine table asks this module first and refuses by name.
 */
import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DatabaseConfigError, UnknownProviderError } from "@/lib/db/errors";
import {
  ABSENT_TYPE_SENTENCE,
  assertDatabaseType,
  isDatabaseType,
  quoteTypeId,
  typeIdRefusal,
  unknownTypeSentence,
} from "@/lib/db/type-id";

describe("isDatabaseType and typeIdRefusal", () => {
  test("every shipped type id is a type id", () => {
    for (const id of SHIPPED_DATABASE_TYPES) {
      expect(isDatabaseType(id)).toBe(true);
      expect(typeIdRefusal(id)).toBeNull();
    }
  });

  test.each(["acmefoo", "Postgres", " postgres", "postgres "])(
    "a string that is not exactly a type id is unknown: %p",
    (value) => {
      expect(isDatabaseType(value)).toBe(false);
      expect(typeIdRefusal(value)).toEqual({
        reason: "unknown",
        typeId: value,
        sentence: unknownTypeSentence(value),
      });
    },
  );

  test.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "a prototype key is unknown: %p",
    (value) => {
      expect(isDatabaseType(value)).toBe(false);
      expect(typeIdRefusal(value)).toEqual({ reason: "unknown", typeId: value, sentence: unknownTypeSentence(value) });
    },
  );

  // Each value in a one-element row: test.each spreads an array row into arguments, which would turn `[]` and
  // `["postgres"]` into something else.
  test.each([[undefined], [null], [""], [5], [true], [{}], [[]], [["postgres"]], [{ id: "postgres" }]] as const)(
    "a missing, empty or non-string type is absent: %p",
    (value: unknown) => {
      expect(isDatabaseType(value)).toBe(false);
      expect(typeIdRefusal(value)).toEqual({ reason: "absent", sentence: ABSENT_TYPE_SENTENCE });
    },
  );

  test("the unknown sentence quotes the type id as given", () => {
    expect(unknownTypeSentence("acmefoo")).toBe(
      'No provider for the connection type "acmefoo" is installed in this LibreDB Studio.',
    );
    expect(ABSENT_TYPE_SENTENCE).toBe(
      "This connection names no type, so no provider in this LibreDB Studio can open it.",
    );
  });

  test("the sentence escapes a control character", () => {
    const refusal = typeIdRefusal("a\nb");
    expect(refusal?.sentence).toContain('"a\\nb"');
    expect(refusal?.sentence).not.toContain("\n");
  });

  // JSON.stringify escapes only U+0000 to U+001F, the quote and the backslash; these code points would otherwise reach
  // the sentence raw: C1 controls, the Unicode line and paragraph separators, and the bidirectional controls, the
  // Arabic letter mark and the left-to-right and right-to-left marks included.
  test.each([
    ["\u0085", "\\u0085"],
    ["\u0080", "\\u0080"],
    ["\u009b", "\\u009b"],
    ["\u009f", "\\u009f"],
    ["\u061c", "\\u061c"],
    ["\u200e", "\\u200e"],
    ["\u200f", "\\u200f"],
    ["\u2028", "\\u2028"],
    ["\u2029", "\\u2029"],
    ["\u202a", "\\u202a"],
    ["\u202e", "\\u202e"],
    ["\u2066", "\\u2066"],
    ["\u2069", "\\u2069"],
  ])("the sentence escapes %j", (codePoint, escaped) => {
    const refusal = typeIdRefusal(`a${codePoint}b`);
    expect(refusal?.sentence).toContain(`"a${escaped}b"`);
    expect(refusal?.sentence).not.toContain(codePoint);
    // The error keeps the value as given.
    expect(refusal?.reason === "unknown" ? refusal.typeId : undefined).toBe(`a${codePoint}b`);
  });

  test("quoteTypeId is the quoted form the sentence carries", () => {
    expect(quoteTypeId("acmefoo")).toBe('"acmefoo"');
    expect(quoteTypeId("a\u202eb\n")).toBe('"a\\u202eb\\n"');
    expect(unknownTypeSentence("a\u2028b")).toContain(quoteTypeId("a\u2028b"));
  });
});

describe("assertDatabaseType", () => {
  test("assertDatabaseType throws UnknownProviderError carrying the refusal", () => {
    let thrown: unknown;
    try {
      assertDatabaseType("acmefoo");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownProviderError);
    expect(thrown).toBeInstanceOf(DatabaseConfigError);
    const error = thrown as UnknownProviderError;
    expect(error.reason).toBe("unknown");
    expect(error.typeId).toBe("acmefoo");
    expect(error.message).toBe(unknownTypeSentence("acmefoo"));
  });

  test("an absent type throws UnknownProviderError with no type id", () => {
    expect(() => assertDatabaseType(undefined)).toThrow(UnknownProviderError);
    try {
      assertDatabaseType(undefined);
    } catch (error) {
      expect((error as UnknownProviderError).reason).toBe("absent");
      expect((error as UnknownProviderError).typeId).toBeUndefined();
      expect((error as UnknownProviderError).message).toBe(ABSENT_TYPE_SENTENCE);
    }
  });

  test("a type id returns", () => {
    expect(() => assertDatabaseType("postgres")).not.toThrow();
  });
});
