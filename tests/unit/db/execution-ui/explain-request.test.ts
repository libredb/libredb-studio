import { describe, expect, test } from "bun:test";
import { DEFAULT_CONNECTION_TYPE } from "@/lib/db/default-connection-type";
import { explainRequestEngine } from "@/lib/db/execution-ui/explain-request";

describe("explain request engine", () => {
  test('no connection type names the default connection type, as today\'s `databaseType || "postgres"` does', () => {
    expect(DEFAULT_CONNECTION_TYPE).toBe("postgres");
    expect(explainRequestEngine(undefined)).toBe("postgres");
    expect(explainRequestEngine("")).toBe("postgres");
  });

  test("any other string is passed through unchanged", () => {
    for (const type of ["mysql", "constructor", "__proto__", "not-an-engine"]) {
      expect(explainRequestEngine(type)).toBe(type);
    }
  });
});
