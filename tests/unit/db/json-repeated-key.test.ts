import { describe, expect, test } from "bun:test";
import { repeatsAKey } from "@/lib/db/utils/json-repeated-key";

describe("repeatsAKey", () => {
  test.each([
    ['{"read": "window", "read": "topic"}', true],
    ['{"read": "topic", "topic": "a", "t\\u006fpic": "b"}', true],
    ['{"a": {"b": 1, "b": 2}}', true],
    ['{"a": [{"b": 1}, {"b": 2}], "c": 3}', false],
    ['{"a": {"b": 1}, "b": 2}', false],
    ['{"a": "b", "b": "a"}', false],
    ['{"a": "\\"b\\"", "b": 1}', false],
    ['{"a": [1, "a"], "b": 2}', false],
    ["{}", false],
  ])("%s is %p", (text, expected) => {
    expect(JSON.parse(text)).toBeDefined();
    expect(repeatsAKey(text)).toBe(expected);
  });
});
