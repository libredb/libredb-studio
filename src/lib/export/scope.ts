import type { QueryResult } from "@/lib/types";

/**
 * How much of the result an export will actually write.
 *
 * An export writes the rows the grid HOLDS, and the grid holds one page: statements
 * are run under a limit (`DEFAULT_QUERY_LIMIT`), and paging fetches more only when
 * the user asks. So "Export CSV" on a table of two million rows produces five
 * hundred, and nothing on the way out says so — the same silent wrongness as a
 * shifted column, and harder to notice, because the file is well formed and the
 * number in it looks like an answer.
 *
 * Saying the count on the button is the cheap half of the fix. The other half — a
 * server-side export that streams the whole result — is `docs/BACKLOG.md` X2.
 */

/** Grouped digits, fixed to one locale so the number reads the same everywhere. */
const GROUPED = new Intl.NumberFormat("en-US");

export interface ExportScope {
  /** How many rows the file will contain. */
  rowCount: number;
  /** That count as it is shown, e.g. `12,480`. */
  countLabel: string;
  /** What the file will contain, as a sentence. */
  summary: string;
  /** Why it is not everything, or null when it is. */
  shortfall: string | null;
}

export function describeExportScope(result: Pick<QueryResult, "rows" | "pagination">): ExportScope {
  const rowCount = result.rows.length;
  const countLabel = GROUPED.format(rowCount);
  const unit = rowCount === 1 ? "row" : "rows";
  // `hasMore` is the engine's own answer about THIS run: the statement was limited
  // and the limit was reached. `wasLimited` without `hasMore` means the limit was
  // applied and the result fit inside it, which is not a shortfall.
  const truncated = result.pagination?.hasMore === true;

  return {
    rowCount,
    countLabel,
    summary: truncated ? `Writes the ${countLabel} ${unit} loaded here.` : `Writes all ${countLabel} ${unit}.`,
    shortfall: truncated ? "More rows are still on the server — load them first to include them." : null,
  };
}
