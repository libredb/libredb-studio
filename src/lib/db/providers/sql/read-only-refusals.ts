import {
  MSSQL_CUT_VALUE_PREFIX,
  MSSQL_CUT_VALUE_TEXT,
  MSSQL_SERIALISED_PREFIX,
  MSSQL_SERIALISED_TEXT,
  MSSQL_TIME_BUDGET_PREFIX,
} from "./mssql-read-only-refusals";
import { BYTE_BUDGET_PREFIX, ROW_BUDGET_PREFIX, TIME_BUDGET_PREFIX } from "./read-only-budget";

/** The kinds of read-only budget refusal a provider raises. */
export type ReadOnlyRefusalKind = "rows" | "bytes" | "cut-value" | "serialised" | "time";

/**
 * One refusal opening, with its kind. The row and byte kinds take the reader's own answer; a kind only one engine
 * raises carries that engine's answer for a result too large to read.
 */
export type ReadOnlyRefusalOpening =
  | { readonly prefix: string; readonly kind: "rows" | "bytes" | "time" }
  | { readonly prefix: string; readonly kind: "cut-value" | "serialised"; readonly tooLargeText: string };

/**
 * Every opening a provider's read-only refusal starts with, each declared beside the provider that raises it, so a
 * reader classifies a refusal by its opening without naming an engine.
 */
export const READ_ONLY_REFUSAL_OPENINGS: readonly ReadOnlyRefusalOpening[] = [
  { prefix: ROW_BUDGET_PREFIX, kind: "rows" },
  { prefix: BYTE_BUDGET_PREFIX, kind: "bytes" },
  { prefix: MSSQL_CUT_VALUE_PREFIX, kind: "cut-value", tooLargeText: MSSQL_CUT_VALUE_TEXT },
  { prefix: MSSQL_SERIALISED_PREFIX, kind: "serialised", tooLargeText: MSSQL_SERIALISED_TEXT },
  { prefix: TIME_BUDGET_PREFIX, kind: "time" },
  { prefix: MSSQL_TIME_BUDGET_PREFIX, kind: "time" },
];
