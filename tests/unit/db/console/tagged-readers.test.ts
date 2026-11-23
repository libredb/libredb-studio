/**
 * The readers of a tagged JSON request body every console language shares: each accepts the value of its type and
 * refuses anything else through the refusal function the language passes, with the sentence and the place.
 */
import { describe, expect, test } from "bun:test";
import { type TaggedJson, type TaggedObject, taggedNumber } from "@/lib/db/console/tagged-json";
import { hasValue, isTaggedObject, kindOf, shownText, taggedReaders } from "@/lib/db/console/tagged-readers";

const object = (entries: Record<string, TaggedJson>): TaggedObject =>
  Object.freeze(Object.assign(Object.create(null) as Record<string, TaggedJson>, entries));

class Refused extends Error {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message);
  }
}

const calls: [string, string][] = [];
const readers = taggedReaders((message, key) => {
  calls.push([message, key]);
  throw new Refused(message, key);
});

/** The sentence and the place a read refused with, after checking the refusal function saw exactly them. */
function refusal(read: () => unknown): [string, string] {
  calls.length = 0;
  try {
    read();
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    expect(calls).toEqual([[error.message, error.key]]);
    return [error.message, error.key];
  }
  throw new Error("the read did not refuse");
}

describe("kindOf", () => {
  test("names every JSON kind, never the value", () => {
    expect(kindOf(undefined)).toBe("nothing");
    expect(kindOf(null)).toBe("null");
    expect(kindOf([])).toBe("a list");
    expect(kindOf(taggedNumber("7"))).toBe("a number");
    expect(kindOf(taggedNumber("7.5"))).toBe("a number");
    expect(kindOf(object({ a: 1 }))).toBe("an object");
    expect(kindOf(true)).toBe("a boolean");
    expect(kindOf("secret")).toBe("a string");
    expect(kindOf(3)).toBe("a number");
  });
});

describe("isTaggedObject and hasValue", () => {
  test("an object is neither a list, null nor a tagged number", () => {
    expect(isTaggedObject(object({}))).toBe(true);
    for (const value of [undefined, null, [], taggedNumber("1"), taggedNumber("1.5"), "x", true]) {
      expect(isTaggedObject(value)).toBe(false);
    }
  });

  test("a key written as null is a key left out", () => {
    const value = object({ set: 1, empty: null });
    expect(hasValue(value, "set")).toBe(true);
    expect(hasValue(value, "empty")).toBe(false);
    expect(hasValue(value, "absent")).toBe(false);
    expect(hasValue(object({}), "toString")).toBe(false);
  });
});

describe("shownText", () => {
  test("quotes a text and cuts it after 80 characters", () => {
    expect(shownText('a"b')).toBe('"a\\"b"');
    expect(shownText("x".repeat(80))).toBe(JSON.stringify("x".repeat(80)));
    expect(shownText("x".repeat(81))).toBe(JSON.stringify(`${"x".repeat(80)}...`));
  });
});

describe("taggedReaders", () => {
  test("objectAt", () => {
    const value = object({ a: 1 });
    expect(readers.objectAt(value, "body")).toBe(value);
    expect(refusal(() => readers.objectAt([], "body.filter"))).toEqual([
      "body.filter must be an object, found a list.",
      "body.filter",
    ]);
  });

  test("listAt", () => {
    const value: TaggedJson[] = ["a"];
    expect(readers.listAt(value, "body.ids")).toBe(value);
    expect(refusal(() => readers.listAt(undefined, "body.ids"))).toEqual([
      "body.ids must be a list, found nothing.",
      "body.ids",
    ]);
  });

  test("stringAt", () => {
    expect(readers.stringAt("text", "body.query")).toBe("text");
    expect(refusal(() => readers.stringAt(taggedNumber("1"), "body.query"))).toEqual([
      "body.query must be a string, found a number.",
      "body.query",
    ]);
  });

  test("booleanAt", () => {
    expect(readers.booleanAt(false, "body.exact")).toBe(false);
    expect(refusal(() => readers.booleanAt("true", "body.exact"))).toEqual([
      "body.exact must be true or false, found a string.",
      "body.exact",
    ]);
  });

  test("integerAt", () => {
    expect(readers.integerAt(taggedNumber("10"), "body.limit", 1, 10)).toBe(10);
    expect(readers.integerAt(taggedNumber("1"), "body.limit", 1, 10)).toBe(1);
    expect(refusal(() => readers.integerAt(taggedNumber("1.0"), "body.limit", 1, 10))).toEqual([
      "body.limit must be an integer, found a number.",
      "body.limit",
    ]);
    expect(refusal(() => readers.integerAt(undefined, "body.limit", 1, 10))).toEqual([
      "body.limit must be an integer, found nothing.",
      "body.limit",
    ]);
    expect(refusal(() => readers.integerAt(taggedNumber("0"), "body.limit", 1, 10))).toEqual([
      "body.limit is 0; it takes an integer from 1 to 10.",
      "body.limit",
    ]);
    expect(refusal(() => readers.integerAt(taggedNumber("11"), "body.limit", 1, 10))).toEqual([
      "body.limit is 11; it takes an integer from 1 to 10.",
      "body.limit",
    ]);
    expect(refusal(() => readers.integerAt(taggedNumber("9007199254740993"), "body.limit", 1, 10))).toEqual([
      "body.limit is 9007199254740993; it takes an integer from 1 to 10.",
      "body.limit",
    ]);
  });

  test("numberAt", () => {
    expect(readers.numberAt(taggedNumber("0.25"), "body.score")).toBe(0.25);
    expect(readers.numberAt(taggedNumber("-3"), "body.score")).toBe(-3);
    expect(refusal(() => readers.numberAt(null, "body.score"))).toEqual([
      "body.score must be a number, found null.",
      "body.score",
    ]);
    expect(refusal(() => readers.numberAt(undefined, "body.score"))).toEqual([
      "body.score must be a number, found nothing.",
      "body.score",
    ]);
  });

  test("wordAt", () => {
    const words = ["and", "or"];
    expect(readers.wordAt("or", "body.operator", words)).toBe("or");
    expect(refusal(() => readers.wordAt("xor", "body.operator", words))).toEqual([
      'body.operator takes one of and, or, not "xor".',
      "body.operator",
    ]);
    expect(refusal(() => readers.wordAt(true, "body.operator", words))).toEqual([
      "body.operator takes one of and, or, not a boolean.",
      "body.operator",
    ]);
    expect(refusal(() => readers.wordAt("y".repeat(81), "body.operator", words))[0]).toBe(
      `body.operator takes one of and, or, not ${JSON.stringify(`${"y".repeat(80)}...`)}.`,
    );
  });
});
