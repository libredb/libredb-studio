/**
 * The tagged JSON values a console body is read into (vector-family spec 3.4): integer literals keep their digits
 * whatever their size, other number literals keep their text, and no JSON text can produce a tag.
 */
import { describe, expect, test } from "bun:test";
import {
  checkIntRange,
  isTaggedFloat,
  isTaggedInt,
  type TaggedJson,
  type TaggedObject,
  taggedNumber,
  toJsonText,
} from "@/lib/db/console/tagged-json";

const int = (digits: string) => {
  const value = taggedNumber(digits);
  if (!isTaggedInt(value)) throw new Error(`${digits} did not read as an integer`);
  return value;
};

const object = (entries: Record<string, TaggedJson>): TaggedObject =>
  Object.freeze(Object.assign(Object.create(null) as Record<string, TaggedJson>, entries));

describe("taggedNumber", () => {
  test("a literal with no fraction and no exponent is an integer, whatever its size", () => {
    for (const literal of ["0", "-0", "42", "-7", "18446744073709551615", "123456789012345678901234567890"]) {
      const value = taggedNumber(literal);
      expect(isTaggedInt(value)).toBe(true);
      expect(isTaggedFloat(value)).toBe(false);
      expect((value as { digits: string }).digits).toBe(literal);
    }
  });

  test("a literal with a fraction or an exponent is a float that keeps its typed text", () => {
    for (const literal of ["1.0", "235.0", "-0.5", "1e3", "1E-7", "3.4e+38", "1.50"]) {
      const value = taggedNumber(literal);
      expect(isTaggedFloat(value)).toBe(true);
      expect(isTaggedInt(value)).toBe(false);
      expect((value as { text: string }).text).toBe(literal);
    }
  });

  test("the nodes are frozen", () => {
    expect(Object.isFrozen(taggedNumber("1"))).toBe(true);
    expect(Object.isFrozen(taggedNumber("1.5"))).toBe(true);
  });

  test("text that is not a JSON number literal is a programming error and throws", () => {
    for (const text of ["", "01", "+1", ".5", "1.", "NaN", "Infinity", "0x10", "1e"]) {
      expect(() => taggedNumber(text)).toThrow(`Not a JSON number literal: ${text}`);
    }
  });
});

describe("isTaggedInt and isTaggedFloat", () => {
  test("an object shaped like a tag is not one", () => {
    const shaped = object({ kind: "int", digits: "42" });
    const floatShaped = object({ kind: "float", text: "1.5", value: 1.5 });
    expect(isTaggedInt(shaped)).toBe(false);
    expect(isTaggedFloat(shaped)).toBe(false);
    expect(isTaggedInt(floatShaped)).toBe(false);
    expect(isTaggedFloat(floatShaped)).toBe(false);
  });

  test("plain values are neither", () => {
    for (const value of [42, 1.5, "42", true, null, [], object({})] as TaggedJson[]) {
      expect(isTaggedInt(value)).toBe(false);
      expect(isTaggedFloat(value)).toBe(false);
    }
  });
});

describe("checkIntRange", () => {
  test.each([
    ["int64", "-9223372036854775808", true],
    ["int64", "9223372036854775807", true],
    ["int64", "9223372036854775808", false],
    ["int64", "-9223372036854775809", false],
    ["uint64", "0", true],
    ["uint64", "18446744073709551615", true],
    ["uint64", "18446744073709551616", false],
    ["uint64", "-1", false],
    ["uint32", "4294967295", true],
    ["uint32", "4294967296", false],
    ["safe", "9007199254740991", true],
    ["safe", "9007199254740992", false],
    ["safe", "-9007199254740991", true],
    ["safe", "-9007199254740992", false],
  ] as const)("%s holds %s: %p", (range, digits, holds) => {
    expect(checkIntRange(int(digits), range)).toBe(holds);
  });
});

describe("toJsonText", () => {
  test("writes an integer as its digits and a float as its typed text, never through a JS number", () => {
    expect(toJsonText(int("18446744073709551615"))).toBe("18446744073709551615");
    expect(toJsonText(taggedNumber("1.50"))).toBe("1.50");
    expect(toJsonText(taggedNumber("235.0"))).toBe("235.0");
  });

  test("writes a number Studio produced as its shortest decimal, with .0 when it is integral", () => {
    expect(toJsonText(235)).toBe("235.0");
    expect(toJsonText(0.1)).toBe("0.1");
    expect(toJsonText(1e21)).toBe("1e+21");
    expect(toJsonText(-2)).toBe("-2.0");
  });

  test("throws on a non-finite number, which only a programming error produces", () => {
    expect(() => toJsonText(Number.POSITIVE_INFINITY)).toThrow(
      "A non-finite number cannot be written as JSON: Infinity",
    );
    expect(() => toJsonText(Number.NaN)).toThrow("A non-finite number cannot be written as JSON: NaN");
  });

  test("writes strings, booleans, null, lists and objects as compact JSON, keys in order", () => {
    const value = object({ b: 'x"y', a: [true, false, null, int("7")], c: object({}) });
    expect(toJsonText(value)).toBe('{"b":"x\\"y","a":[true,false,null,7],"c":{}}');
  });

  test("writes a tag-shaped object back as the object it is", () => {
    expect(toJsonText(object({ kind: "int", digits: "42" }))).toBe('{"kind":"int","digits":"42"}');
  });
});
