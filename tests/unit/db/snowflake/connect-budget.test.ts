/**
 * Snowflake's connect budget is derived from its connect (docs/providers/CONTRACT.md, clause M-51; docs/providers/snowflake.md,
 * "Connect budget"): `connect()` sends two Studio statements, the connect statement and the role check, each cut at
 * `SNOWFLAKE_SURFACE_TIMEOUT_S` plus its grace, so the budget its declaration authors, `connection.connectBudgetMs`,
 * covers both and 10 s for the provider's own answer to arrive after them.
 */
import { expect, test } from "bun:test";
import { connectBudgetFor } from "@/lib/db/connect-budget";
import { deadlineMsFor, SNOWFLAKE_SURFACE_TIMEOUT_S } from "@/lib/db/providers/sql/snowflake/statements";

test("Snowflake's connect budget covers its connect's two Studio statements at their deadline, plus 10 s", () => {
  expect(connectBudgetFor("snowflake")).toBe(2 * deadlineMsFor(SNOWFLAKE_SURFACE_TIMEOUT_S) + 10_000);
});
