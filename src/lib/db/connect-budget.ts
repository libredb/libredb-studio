/**
 * Each engine's connect budget: how long the host waits for an open of the engine, and for its Test connection, from
 * the open's start (docs/providers/CONTRACT.md, clause M-51). Each engine declaration authors its budget as
 * `connection.connectBudgetMs` (src/lib/db/engine-declarations/<type-id>.json), and the engine catalog projects it
 * (`./engine-catalog/catalog.generated.ts`, clause M-70), which `connectBudgetFor` reads.
 *
 * A budget is the engine's own connect bound at Studio's default statement timeout, plus 10 s for the provider's own
 * answer to arrive after it, so a provider that bounds its connect answers in its own words before the host does. An
 * engine whose own bound fits in the host's default, `DEFAULT_CONNECT_BUDGET_MS` (70 s, the pools' 60 s acquire bound
 * plus 10 s), states null. Two do not fit:
 * - `bigquery`, 140 s: its connect lists the datasets and then runs a probe job, each cut at the statement timeout plus
 *   the provider's 5 s client grace, so 2 x (60 s + 5 s) + 10 s;
 * - `snowflake`, 80 s: its connect sends two Studio statements, the connect statement and the role check, each cut at
 *   Snowflake's 30 s surface timeout plus its 5 s grace, so 2 x (30 s + 5 s) + 10 s.
 * A test beside each provider holds its budget to that provider's own constants (tests/unit/db/bigquery/connect-budget.test.ts
 * and tests/unit/db/snowflake/connect-budget.test.ts).
 *
 * Pure and UI-free: it imports types, the SDK's constant, the generated catalog and the type-id reader only.
 */
import { DEFAULT_CONNECT_BUDGET_MS } from "@libredb/provider-sdk/calls";
import { BUNDLED_CATALOG } from "@/lib/db/engine-catalog/catalog.generated";
import { waitedSeconds } from "@/lib/db/errors";
import { typeIdRow } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";

/**
 * How long the host waits for an open of `type` and for its Test connection, in milliseconds: the budget its
 * declaration authors, or the host's default where it states null.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no provider.
 */
export function connectBudgetFor(type: DatabaseType): number {
  return typeIdRow(BUNDLED_CATALOG, type).connectBudgetMs ?? DEFAULT_CONNECT_BUDGET_MS;
}

/** Studio's sentence for an open its connect budget of `budgetMs` ended: nothing was sent. */
export function openDeadlineSentence(budgetMs: number): string {
  return `The connection did not open within ${waitedSeconds(budgetMs)}, so Studio stopped waiting for it and sent nothing.`;
}
