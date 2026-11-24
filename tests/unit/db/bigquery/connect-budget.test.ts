/**
 * BigQuery's connect budget is derived from its connect (docs/providers/CONTRACT.md, clause M-51; docs/providers/bigquery.md,
 * "Connect budget"): `connect()` lists the datasets and then runs a probe job, each cut at the statement timeout plus
 * `CLIENT_GRACE_MS`, so the budget its declaration authors, `connection.connectBudgetMs`, covers both at Studio's
 * default statement timeout and 10 s for the provider's own answer to arrive after them.
 */
import { expect, test } from "bun:test";
import { connectBudgetFor } from "@/lib/db/connect-budget";
import { CLIENT_GRACE_MS } from "@/lib/db/providers/sql/bigquery";
import { DEFAULT_QUERY_TIMEOUT } from "@/lib/db/types";

test("BigQuery's connect budget covers its connect's dataset list and probe job at the default statement timeout, plus 10 s", () => {
  expect(connectBudgetFor("bigquery")).toBe(2 * (DEFAULT_QUERY_TIMEOUT + CLIENT_GRACE_MS) + 10_000);
});
