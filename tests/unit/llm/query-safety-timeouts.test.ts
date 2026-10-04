import { describe, test, expect } from "bun:test";
import { QUERY_SAFETY_ANALYSIS_TIMEOUT_MS, QUERY_SAFETY_ROUTE_TIMEOUT_MS } from "@/lib/llm/query-safety";

describe("query safety timeouts", () => {
  test("the dialog stops waiting after 15 seconds", () => {
    expect(QUERY_SAFETY_ANALYSIS_TIMEOUT_MS).toBe(15_000);
  });

  // The dialog aborts its own request at its deadline. The route's bound is the backstop for a caller
  // that does not, so it must not cut an analysis the dialog is still willing to wait for.
  test("the route waits longer than the dialog does", () => {
    expect(QUERY_SAFETY_ROUTE_TIMEOUT_MS).toBe(30_000);
    expect(QUERY_SAFETY_ROUTE_TIMEOUT_MS).toBeGreaterThan(QUERY_SAFETY_ANALYSIS_TIMEOUT_MS);
  });
});
