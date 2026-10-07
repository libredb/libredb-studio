/**
 * The columns of a result whose rows do not share one shape: a document store answers
 * documents, and two documents of one collection need not carry the same keys.
 * And the names a result's columns are keyed under when a driver declares a column with no
 * name, or two columns with one name.
 */
import { describe, expect, test } from "bun:test";
import { UNNAMED_FIELD, unionFields, uniqueFieldNames } from "@/lib/db/utils/result-fields";

describe("uniqueFieldNames", () => {
  test("names that are already unique and non-empty are kept as declared, in order", () => {
    expect(uniqueFieldNames(["id", "name", "ID"])).toEqual(["id", "name", "ID"]);
    expect(uniqueFieldNames([])).toEqual([]);
  });

  test("a column with no name is named the way SQL Server's own tools name it", () => {
    // `SELECT @@VERSION` or `SELECT COUNT(*) FROM t` on SQL Server: the driver declares the
    // column with an empty name, and a row keyed by "" crashed the results grid.
    expect(UNNAMED_FIELD).toBe("(No column name)");
    expect(uniqueFieldNames([""])).toEqual(["(No column name)"]);
  });

  test("a repeated name is numbered from 2, so every value keeps a column of its own", () => {
    // A join that projects `id` from both tables: keyed by name, the second value replaced the first.
    expect(uniqueFieldNames(["id", "customer_id", "item", "id", "name"])).toEqual([
      "id",
      "customer_id",
      "item",
      "id (2)",
      "name",
    ]);
    expect(uniqueFieldNames(["?column?", "?column?", "?column?"])).toEqual([
      "?column?",
      "?column? (2)",
      "?column? (3)",
    ]);
    expect(uniqueFieldNames(["", ""])).toEqual(["(No column name)", "(No column name) (2)"]);
  });

  test("a generated name never takes a name the result itself declares", () => {
    // The statement may already use the spelling a number would produce, before or after the repeat.
    expect(uniqueFieldNames(["a", "a (2)", "a"])).toEqual(["a", "a (2)", "a (3)"]);
    expect(uniqueFieldNames(["a", "a", "a (2)"])).toEqual(["a", "a (3)", "a (2)"]);
    expect(uniqueFieldNames(["", "(No column name)"])).toEqual(["(No column name) (2)", "(No column name)"]);
  });

  test("names differing only in letter case are different columns, as row keys are", () => {
    expect(uniqueFieldNames(["Id", "id", "id"])).toEqual(["Id", "id", "id (2)"]);
  });
});

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
