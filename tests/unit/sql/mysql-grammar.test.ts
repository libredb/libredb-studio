import { describe, expect, test } from "bun:test";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

const grammar = resolveSqlGrammar("mysql");

describe("the MySQL grammar", () => {
  test("declares the confirmation forms of the statements that overwrite rows through an INSERT", () => {
    // REPLACE, with or without INTO, deletes the row a new one collides with on a primary or unique key, and ON
    // DUPLICATE KEY UPDATE updates it (MySQL 8.4 reference, "REPLACE Statement" and "INSERT ... ON DUPLICATE KEY UPDATE
    // Statement"); INSERT OVERWRITE, StarRocks' and Apache Doris', replaces every row of a table or of the partitions it
    // names.
    expect(grammar.confirmForms).toContainEqual(["REPLACE"]);
    expect(grammar.confirmForms).toContainEqual(["INSERT", "OVERWRITE"]);
    expect(grammar.confirmCodeForms).toContainEqual(["ON", "DUPLICATE", "KEY", "UPDATE"]);
  });

  test("declares the confirmation forms of the loads and the CREATE that replace rows", () => {
    // LOAD DATA and LOAD XML with REPLACE before INTO TABLE delete the row a loaded one collides with (MySQL 8.4
    // reference, "LOAD DATA Statement" and "LOAD XML Statement"), and MariaDB's CREATE OR REPLACE TABLE drops the table
    // and its TEMPORARY form the session's temporary table (MariaDB reference, "CREATE TABLE"); MariaDB connects through
    // this type id.
    expect(grammar.confirmCodeForms).toContainEqual(["REPLACE", "INTO", "TABLE"]);
    expect(grammar.confirmForms).toContainEqual(["CREATE", "OR", "REPLACE", "TABLE"]);
    expect(grammar.confirmForms).toContainEqual(["CREATE", "OR", "REPLACE", "TEMPORARY", "TABLE"]);
  });
});
