import { describe, test, expect } from "bun:test";
import { getExplainStrategy } from "@/lib/explain";

describe("getExplainStrategy", () => {
  test("resolves postgres-json", () => {
    expect(getExplainStrategy("postgres-json")?.format).toBe("postgres-json");
  });

  test("resolves mysql-json", () => {
    expect(getExplainStrategy("mysql-json")?.format).toBe("mysql-json");
  });

  test("returns null for undefined (provider without explain support)", () => {
    expect(getExplainStrategy(undefined)).toBeNull();
  });
});
