/**
 * The column-name rule of spec 6.5 (R51 U14q): a pure function of the key, injective, with an image disjoint from
 * the engine's and Studio's own column names.
 */
import { describe, expect, test } from "bun:test";
import {
  isReservedPayloadKey,
  payloadColumnName,
  QDRANT_ENGINE_COLUMNS,
  QDRANT_STUDIO_COLUMNS,
  renameWarning,
  vectorColumnName,
} from "@/lib/db/providers/vector/qdrant/columns";

describe("vector columns", () => {
  test("the unnamed vector is vector, a named one vector. and its name", () => {
    expect(vectorColumnName("")).toBe("vector");
    expect(vectorColumnName("text")).toBe("vector.text");
  });
});

describe("payload columns", () => {
  test.each([
    ["category", "category"],
    ["id", "payload.id"],
    ["score", "payload.score"],
    ["vector", "payload.vector"],
    ["order_value", "payload.order_value"],
    ["shard_key", "payload.shard_key"],
    ["vector.text", "payload.vector.text"],
    ["$search", "payload.$search"],
    ["payload.id", "payload.payload.id"],
    ["", "payload."],
    ["__proto__", "payload.__proto__"],
    ["constructor", "constructor"],
    ["toString", "toString"],
    ["Id", "Id"],
    ["vectors", "vectors"],
  ])("%j is shown as %s", (key, column) => {
    expect(payloadColumnName(key)).toBe(column);
    expect(isReservedPayloadKey(key)).toBe(column !== key);
  });

  test("the mapping is injective and never takes an engine or a Studio name, over every key of up to three tokens", () => {
    const tokens = [
      "",
      "id",
      "score",
      "vector",
      "order_value",
      "shard_key",
      "payload",
      "payload.",
      "vector.",
      "$",
      ".",
      "a",
      "__proto__",
      "$search",
      "x.",
    ];
    const keys = new Set<string>();
    for (const a of tokens) for (const b of tokens) for (const c of tokens) keys.add(`${a}${b}${c}`);
    const engine = new Set<string>([...QDRANT_ENGINE_COLUMNS, ...Object.values(QDRANT_STUDIO_COLUMNS)]);
    const seen = new Map<string, string>();
    for (const key of keys) {
      const column = payloadColumnName(key);
      expect(engine.has(column), key).toBe(false);
      expect(column.startsWith("vector."), key).toBe(false);
      expect(seen.get(column) ?? key, `${key} and ${seen.get(column)} share ${column}`).toBe(key);
      seen.set(column, key);
    }
    expect(keys.size).toBeGreaterThan(2_000);
  });
});

describe("renameWarning", () => {
  test("is absent with no rename, lists the first five as key -> column, and counts the rest", () => {
    expect(renameWarning(new Map())).toBeUndefined();
    const renames = new Map(
      ["id", "score", "vector", "$a", "payload.b", "order_value", "shard_key"].map((key) => [
        key,
        payloadColumnName(key),
      ]),
    );
    expect(renameWarning(renames)?.message).toBe(
      'Payload keys that read as a column Qdrant or Studio names are shown under payload.: "id" -> payload.id, "score" -> payload.score, "vector" -> payload.vector, "$a" -> payload.$a, "payload.b" -> payload.payload.b, and 2 more. A filter names the key itself.',
    );
  });
});
