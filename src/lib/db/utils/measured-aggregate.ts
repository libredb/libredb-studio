/**
 * Read a nullable SQL aggregate without collapsing a missing result row into zero.
 *
 * Aggregate queries normally return one row whose value is `NULL` when there is
 * nothing to aggregate. That is a measured zero. A missing row or column did not
 * publish a measurement, and non-finite values cannot be displayed as one.
 */
export function measuredNullableAggregate(
  row: Record<string, unknown> | undefined,
  column: string,
): number | undefined {
  if (!row || !(column in row)) return undefined;
  const parsed = Number(row[column] ?? 0);
  return Number.isFinite(parsed) ? parsed : undefined;
}
