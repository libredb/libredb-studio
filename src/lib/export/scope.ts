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

export function describeExportScope(
  result: Pick<QueryResult, "rows" | "pagination">,
  /**
   * Whether the surface holding these rows can actually fetch the next page: the grid's
   * own `pageOfferFor` decision, passed in rather than re-derived.
   *
   * It is the second half of the same narrowing as the `hasMore` conjunct below.
   * `hasMore` answers "is there another page of this statement", and on Cassandra and
   * Elasticsearch the answer is yes while no control exists to fetch it: their provider
   * declares `supportsResultPagination: false`, and since the preview cap left the SQL
   * text their 50-row table preview fills its bound exactly and reports `hasMore: true`.
   * Without this, the dialog told those users to load rows that nothing can load.
   */
  nextPageFetchable: boolean,
): ExportScope {
  const rowCount = result.rows.length;
  const countLabel = GROUPED.format(rowCount);
  const unit = rowCount === 1 ? "row" : "rows";
  // `hasMore` is the route's own answer about THIS run: OUR bound was applied and it
  // was reached, so a next page can be asked for. `wasLimited` without `hasMore` means
  // either that the bound was applied and the result fit inside it, which is not a
  // shortfall, or that a provider cut its own result (#1085, section 5.4), which no
  // page can fetch: the grid's "limited" badge already says so, and the shortfall
  // sentence below would name a load that nothing offers.
  //
  // It narrowed with #816: the route now requires `wasLimited` too, so a statement
  // carrying its OWN bound and filling it exactly — `SELECT * FROM t LIMIT 500` giving
  // 500 rows — reads as complete here where it once warned of rows on the server. That
  // is the correction, not a loss: no Load More exists for such a statement, so the
  // shortfall sentence below was naming an action the UI does not offer.
  const truncated = nextPageFetchable && result.pagination?.hasMore === true;

  return {
    rowCount,
    countLabel,
    summary: truncated ? `Writes the ${countLabel} ${unit} loaded here.` : `Writes all ${countLabel} ${unit}.`,
    shortfall: truncated ? "More rows are still on the server — load them first to include them." : null,
  };
}
