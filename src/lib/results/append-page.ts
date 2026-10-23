import type { QueryResult } from "@/lib/types";

/**
 * The Load More append rule, in one place for both of its callers: `executeQuery` in
 * `src/hooks/use-query-execution.ts`, and the VS Code extension's results webview reducer.
 *
 * The module imports nothing but types, so the webview can bundle it with no Node, React or Next
 * code behind it.
 */

/** The rows on screen and the shape they are rendered under. */
export type ShownResult = Pick<QueryResult, "rows" | "fields" | "vectorColumns">;

/**
 * The result a page leaves once it is appended to the rows on screen: the rows concatenated, the
 * shape kept from the rows on screen where the page names none, `rowCount` the merged count, and
 * every other key from the newest page. Neither input is changed.
 */
export function appendResultPage(shown: ShownResult, page: QueryResult): QueryResult {
  const rows = [...shown.rows, ...page.rows];
  // The vector declaration describes those rows too, so a page that declares none keeps theirs, as
  // the embedded adapter's load-more does (`carriedChannels` in `use-query-adapter.ts`).
  const vectorColumns = page.vectorColumns ?? shown.vectorColumns;
  return {
    ...page,
    // THE SHAPE COMES FROM THE ROWS ON SCREEN, NOT FROM THE PAGE THAT ARRIVED.
    //
    // A page of the same statement cannot legitimately name different columns,
    // and an empty page often names none at all: SQLite answers `... LIMIT 50
    // OFFSET 100` on a hundred-row table with `rows: 0, fields: []`. Spreading
    // that over the tab left the grid holding its hundred rows under zero
    // columns - the strip read "100 rows / 0 columns" and the table rendered
    // header-less, cell-less stripes. A table whose size is an exact multiple
    // of the page size reaches that state in one click.
    fields: page.fields.length > 0 ? page.fields : shown.fields,
    ...(vectorColumns !== undefined && { vectorColumns }),
    rows,
    rowCount: rows.length,
  };
}
