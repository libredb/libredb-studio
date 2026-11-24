import { describe, expect, test } from "bun:test";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

const grammar = resolveSqlGrammar("databend");

describe("the Databend grammar", () => {
  test("declares REPLACE, which its ON clause always follows, as a confirmation form", () => {
    // REPLACE [INTO] t ON (key) deletes the row a new one collides with on that key (Databend reference, "REPLACE"),
    // and Databend refuses a REPLACE without ON, so the form asks when ON follows: a replace() call without one does not.
    expect(grammar.confirmFormsWhen).toEqual([{ form: ["REPLACE"], when: "ON" }]);
    expect(grammar.confirmForms).toBeUndefined();
  });
});
