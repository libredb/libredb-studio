/**
 * The columns of a result whose rows do not share one shape: a document store answers
 * documents, and two documents of one collection need not carry the same keys.
 */
import { describe, expect, test } from "bun:test";
import { unionFields } from "@/lib/db/utils/result-fields";

describe("unionFields", () => {
  test("no rows, no columns", () => {
    expect(unionFields([])).toEqual([]);
  });

  test("uniform rows answer the first row's keys in its order", () => {
    expect(
      unionFields([
        { _id: "1", name: "Ada", city: "Istanbul" },
        { _id: "2", name: "Grace", city: "Ankara" },
      ]),
    ).toEqual(["_id", "name", "city"]);
  });

  test("a key only a later row carries is a column, after the keys seen before it", () => {
    // The defect this exists for: the columns were the first row's keys, so `score`
    // and `tags` below were in the rows and in the JSON export but in no grid column
    // and in no CSV or SQL export.
    expect(
      unionFields([
        { _id: "b", ts: 1 },
        { _id: "a", balance: 10, score: 3, tags: ["x"] },
        { _id: "c", tags: [], ts: 2, re: "^a" },
      ]),
    ).toEqual(["_id", "ts", "balance", "score", "tags", "re"]);
  });

  test("a key present with an undefined or null value is still a column", () => {
    expect(unionFields([{ a: 1 }, { b: undefined }, { c: null }])).toEqual(["a", "b", "c"]);
  });

  test("a wide result keeps every key, first seen first", () => {
    // 1000 documents of 200 keys each, every document adding one key of its own:
    // 1200 columns, first seen first.
    const rows = Array.from({ length: 1000 }, (_, index) => {
      const row: Record<string, unknown> = {};
      for (let key = 0; key < 200; key++) row[`k${key}`] = key;
      row[`own${index}`] = index;
      return row;
    });
    const fields = unionFields(rows);
    expect(fields.length).toBe(1200);
    expect(fields.slice(0, 201)).toEqual([...Array.from({ length: 200 }, (_, key) => `k${key}`), "own0"]);
    expect(fields.at(-1)).toBe("own999");
  });
});
