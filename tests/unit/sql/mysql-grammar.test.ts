import { describe, expect, test } from "bun:test";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

const grammar = resolveSqlGrammar("mysql");

describe("the MySQL grammar", () => {
  test("declares the confirmation forms of the statements that overwrite rows through an INSERT", () => {
    // REPLACE, with or without INTO, deletes the row a new one collides with on a primary or unique key, and ON
    // DUPLICATE KEY UPDATE updates it (MySQL 8.4 reference, "REPLACE Statement" and "INSERT ... ON DUPLICATE KEY UPDATE
    // Statement").
    expect(grammar.confirmForms).toEqual([["REPLACE"]]);
    expect(grammar.confirmCodeForms).toEqual([["ON", "DUPLICATE", "KEY", "UPDATE"]]);
  });
});
