import { describe, expect, test } from "bun:test";
import { explainRequestEngine, NO_CONNECTION_EXPLAIN_ENGINE } from "@/lib/db/execution-ui/explain-request";

describe("explain request engine", () => {
  test('no connection type names postgres, as today\'s `databaseType || "postgres"` does', () => {
    expect(NO_CONNECTION_EXPLAIN_ENGINE).toBe("postgres");
    expect(explainRequestEngine(undefined)).toBe("postgres");
    expect(explainRequestEngine("")).toBe("postgres");
  });

  test("any other string is passed through unchanged", () => {
    for (const type of ["mysql", "constructor", "__proto__", "not-an-engine"]) {
      expect(explainRequestEngine(type)).toBe(type);
    }
  });
});
