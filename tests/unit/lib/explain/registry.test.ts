import { describe, test, expect } from "bun:test";
import { getExplainStrategy } from "@/lib/explain";

describe("getExplainStrategy", () => {
  test("resolves postgres-json", () => {
    expect(getExplainStrategy("postgres-json")?.format).toBe("postgres-json");
  });

  test("resolves mysql-json", () => {
    expect(getExplainStrategy("mysql-json")?.format).toBe("mysql-json");
  });

  test("resolves postgres-text", () => {
    expect(getExplainStrategy("postgres-text")?.format).toBe("postgres-text");
  });

  test("resolves postgres-text-analyze", () => {
    expect(getExplainStrategy("postgres-text-analyze")?.format).toBe("postgres-text-analyze");
  });

  test("resolves mysql-text", () => {
    expect(getExplainStrategy("mysql-text")?.format).toBe("mysql-text");
  });

  test("returns null for undefined (provider without explain support)", () => {
    expect(getExplainStrategy(undefined)).toBeNull();
  });
});
