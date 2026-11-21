import { describe, expect, test } from "bun:test";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

const grammar = resolveSqlGrammar("duckdb");

describe("the DuckDB grammar", () => {
  test("declares INSERT OR REPLACE as a confirmation form", () => {
    // INSERT OR REPLACE overwrites the row a new one collides with (DuckDB reference, "INSERT Statement"); OR IGNORE
    // and ON CONFLICT DO NOTHING skip it, and ON CONFLICT ... DO UPDATE SET asks through the shared UPDATE ... SET
    // reading.
    expect(grammar.confirmForms).toEqual([["INSERT", "OR", "REPLACE"]]);
    expect(grammar.confirmCodeForms).toBeUndefined();
  });
});
