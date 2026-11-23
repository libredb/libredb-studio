/**
 * Each engine's connect budget, how long the host waits for its open and for its Test connection, declared in one
 * central table (docs/providers/CONTRACT.md, clause M-51).
 *
 * The census in tests/unit/db/engine-declarations.test.ts reads each declaration back to `CONNECT_BUDGET`; this file
 * holds the table's own facts: the host's default and why it has that value, which engines state a budget of their
 * own, the refusal of a value that is no type id, and the provider documents that state a budget.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONNECT_BUDGET_MS } from "@libredb/provider-sdk/calls";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { CONNECT_BUDGET, connectBudgetFor, openDeadlineSentence } from "@/lib/db/connect-budget";
import { DEFAULT_POOL_CONFIG } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../../helpers/outside-the-union";
import { providerTriad } from "../../helpers/provider-layout";

const ROOT = path.resolve(import.meta.dir, "../../..");

/** The heading of the subsection a provider document states its engine's connect budget under. */
const HEADING = /^### Connect budget$/m;

describe("CONNECT_BUDGET", () => {
  test("the host's default is the pools' 60 s acquire bound plus 10 s", () => {
    expect(DEFAULT_CONNECT_BUDGET_MS).toBe(DEFAULT_POOL_CONFIG.acquireTimeout + 10_000);
  });

  test("only BigQuery and Snowflake declare a connect budget of their own", () => {
    expect(Object.keys(CONNECT_BUDGET).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    expect(Object.entries(CONNECT_BUDGET).filter(([, budget]) => budget !== null)).toEqual([
      ["bigquery", 140_000],
      ["snowflake", 80_000],
    ]);
    expect(Object.isFrozen(CONNECT_BUDGET)).toBe(true);
  });

  test("connectBudgetFor answers the declared budget, or the host's default where the row is null", () => {
    expect(connectBudgetFor("bigquery")).toBe(140_000);
    expect(connectBudgetFor("snowflake")).toBe(80_000);
    expect(connectBudgetFor("postgres")).toBe(DEFAULT_CONNECT_BUDGET_MS);
  });

  test.each(OUTSIDE_THE_UNION)(
    "connectBudgetFor refuses a value that is not a type id by name: %s",
    (_label, value) => {
      expect(refusalThrownBy(() => connectBudgetFor(value as DatabaseType))).toEqual(refusalOf(value));
    },
  );

  test("openDeadlineSentence names the budget in seconds and that nothing was sent", () => {
    expect(openDeadlineSentence(70_000)).toBe(
      "The connection did not open within 70 seconds, so Studio stopped waiting for it and sent nothing.",
    );
    expect(openDeadlineSentence(140_000)).toBe(
      "The connection did not open within 140 seconds, so Studio stopped waiting for it and sent nothing.",
    );
  });

  test("the document of each engine that declares a connect budget states it in seconds, and no other provider document states one", () => {
    const misstated = SHIPPED_DATABASE_TYPES.filter((type) => {
      const text = readFileSync(providerTriad(ROOT, type).doc, "utf8");
      const budget = CONNECT_BUDGET[type];
      if (budget === null) return HEADING.test(text);
      const section = text.slice(text.search(HEADING)).split(/\n#{2,3} /)[0];
      return !(
        HEADING.test(text) &&
        section.includes(`${budget / 1000} seconds`) &&
        section.includes("src/lib/db/connect-budget.ts")
      );
    });

    expect(misstated).toEqual([]);
  });
});
