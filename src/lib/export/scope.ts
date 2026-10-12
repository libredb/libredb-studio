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
   * declares `supportsResultPagination: false`, and their 50-row table preview reports
   * `hasMore: true` when the route's probe found a row past the bound
   * (`src/lib/api/page-probe.ts:32`). Without this, the dialog told those users to load
   * rows that nothing can load. Such a preview now reads as the rows shown, with the cut
   * shortfall.
   */
  nextPageFetchable: boolean,
): ExportScope {
  const rowCount = result.rows.length;
  const countLabel = GROUPED.format(rowCount);
  const unit = rowCount === 1 ? "row" : "rows";
  // `hasMore` with a fetchable page means a next page can be asked for, so the menu says
  // to load it first. Otherwise a result whose `wasLimited` is true is limited and no page
  // can extend it: a provider cut its own result (#1085, section 5.4), or the route bounded
  // it on an engine with no Load More, where since #1440 `hasMore` means its probe found a
  // row past the bound. So the menu says the file holds the rows shown and that the result
  // was cut, and names no load, because nothing offers one.
  //
  // It narrowed with #816: the route now requires `wasLimited` too, so a statement
  // carrying its OWN bound and filling it exactly — `SELECT * FROM t LIMIT 500` giving
  // 500 rows — reads as complete here where it once warned of rows on the server. That
  // is the correction, not a loss: no Load More exists for such a statement, so the
  // shortfall sentence below was naming an action the UI does not offer.
  const loadable = nextPageFetchable && result.pagination?.hasMore === true;
  if (loadable) {
    return {
      rowCount,
      countLabel,
      summary: `Writes the ${countLabel} ${unit} loaded here.`,
      shortfall: "More rows are still on the server — load them first to include them.",
    };
  }
  if (result.pagination?.wasLimited === true) {
    return {
      rowCount,
      countLabel,
      summary: `Writes the ${countLabel} ${unit} shown.`,
      shortfall: "The result was cut, so the file is not the whole result.",
    };
  }
  return { rowCount, countLabel, summary: `Writes all ${countLabel} ${unit}.`, shortfall: null };
}
