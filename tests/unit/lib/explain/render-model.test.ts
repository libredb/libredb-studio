import { describe, test, expect } from "bun:test";
import { resolveExplainPlan } from "@/lib/explain";
import { postgresJsonStrategy } from "@/lib/explain/postgres-json";
import { mysqlJsonStrategy } from "@/lib/explain/mysql-json";

const PG_PLAN = [{ Plan: { "Node Type": "Seq Scan" } }];

describe("toRenderModel", () => {
  test("postgres-json wraps a non-empty array", () => {
    expect(postgresJsonStrategy.toRenderModel(PG_PLAN)).toEqual({ kind: "postgres-json", plan: PG_PLAN });
  });

  test("postgres-json rejects foreign shapes", () => {
    expect(postgresJsonStrategy.toRenderModel(null)).toBeNull();
    expect(postgresJsonStrategy.toRenderModel({})).toBeNull();
    expect(postgresJsonStrategy.toRenderModel([])).toBeNull();
  });

  // The B4 passthrough is gone (#1389): a MySQL plan is a tree of its own, never the PostgreSQL model.
  test("mysql-json draws its plan as a tree", () => {
    const rows: Record<string, unknown>[] = [{ EXPLAIN: '{"query_block":{"select_id":1}}' }];
    expect(mysqlJsonStrategy.toRenderModel(rows)?.kind).toBe("tree");
  });
});

describe("resolveExplainPlan", () => {
  test("dispatches a stored wrapper through its format's strategy", () => {
    expect(resolveExplainPlan({ format: "postgres-json", raw: PG_PLAN })).toEqual({
      kind: "postgres-json",
      plan: PG_PLAN,
    });
  });

  test("tolerates legacy pre-wrapper tab state (raw postgres array)", () => {
    expect(resolveExplainPlan(PG_PLAN)).toEqual({ kind: "postgres-json", plan: PG_PLAN });
  });

  test("returns null for null, garbage, and unknown formats", () => {
    expect(resolveExplainPlan(null)).toBeNull();
    expect(resolveExplainPlan(undefined)).toBeNull();
    expect(resolveExplainPlan("nope")).toBeNull();
    expect(resolveExplainPlan({ format: "not-a-format", raw: [] })).toBeNull();
    expect(resolveExplainPlan({ format: "postgres-json" })).toBeNull();
  });

  test("rejects prototype-chain keys masquerading as formats", () => {
    expect(resolveExplainPlan({ format: "toString", raw: [] })).toBeNull();
    expect(resolveExplainPlan({ format: "constructor", raw: [] })).toBeNull();
  });
});
