/**
 * Read-only execution budget validation (#328).
 *
 * Shared by every provider that implements `queryReadOnly`, so the agent
 * execution profile cannot end up with one provider validating its budget and
 * another trusting it. The check is fail-closed: the whole call is refused
 * unless every field is a positive integer in range.
 *
 * The upper bound matters doubly on PostgreSQL, where the timeout is
 * interpolated into `SET LOCAL statement_timeout = N` (SET takes no bind
 * parameters), so nothing that is not a positive integer may reach it.
 */

import type { DatabaseType, ReadOnlyStatementBudget } from "../../types";
import { QueryError } from "../../errors";

/** PostgreSQL's statement_timeout is a 32-bit millisecond setting; the same
 * ceiling is applied everywhere — a timeout beyond ~24 days is not a budget. */
const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;

export function assertReadOnlyBudget(budget: ReadOnlyStatementBudget, provider: DatabaseType): void {
  const fields: Array<[name: string, value: unknown, max: number]> = [
    ["statementTimeoutMs", budget?.statementTimeoutMs, MAX_STATEMENT_TIMEOUT_MS],
    ["maxResultRows", budget?.maxResultRows, Number.MAX_SAFE_INTEGER],
    ["maxResultBytes", budget?.maxResultBytes, Number.MAX_SAFE_INTEGER],
  ];
  for (const [name, value, max] of fields) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
      throw new QueryError(`Read-only execution budget field ${name} must be a positive integer <= ${max}`, provider);
    }
  }
}

/**
 * Byte size of a result set as it would be serialized to the caller. BigInt
 * values (node:sqlite and pg both emit them for 64-bit integers) have no JSON
 * representation, so they are measured as their decimal text.
 */
export function measureResultBytes(rows: unknown[]): number {
  return Buffer.byteLength(
    JSON.stringify(rows, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)),
  );
}
