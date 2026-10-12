import { describe, test, expect } from "bun:test";
import { describeExportScope } from "@/lib/export/scope";

const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i }));

describe("describeExportScope", () => {
  test("counts the rows the file will actually contain", () => {
    expect(describeExportScope({ rows: rows(3) }, false).rowCount).toBe(3);
  });

  test("groups the digits, so a large count is readable at a glance", () => {
    expect(describeExportScope({ rows: rows(1234) }, false).countLabel).toBe("1,234");
  });

  test("says the whole result is written when nothing was held back", () => {
    const scope = describeExportScope({ rows: rows(42) }, false);

    expect(scope.summary).toBe("Writes all 42 rows.");
    expect(scope.shortfall).toBeNull();
  });

  test("agrees with itself about a single row", () => {
    expect(describeExportScope({ rows: rows(1) }, false).summary).toBe("Writes all 1 row.");
  });

  test("says nothing is written for an empty result", () => {
    expect(describeExportScope({ rows: [] }, false).summary).toBe("Writes all 0 rows.");
  });

  // The grid holds one page. Exporting it produces a well-formed file with a
  // plausible number of rows in it, which is exactly why the shortfall has to be
  // stated rather than left for the user to discover downstream.
  test("says only the loaded rows are written when the engine held more back", () => {
    const scope = describeExportScope(
      {
        rows: rows(500),
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 500, wasLimited: true },
      },
      true,
    );

    expect(scope.summary).toBe("Writes the 500 rows loaded here.");
    expect(scope.shortfall).toBe("More rows are still on the server — load them first to include them.");
  });

  const CUT = "The result was cut, so the file is not the whole result.";
  const cutBy = (count: number) => ({ limit: 500, offset: 0, hasMore: false, totalReturned: count, wasLimited: true });

  /**
   * A RESULT THE PROVIDER CUT AT ITS OWN BOUND (`wasLimited` without `hasMore`).
   *
   * No page can fetch the rest, so the menu says the file holds the rows shown and that the result was cut, beside
   * the grid's "limited" badge, and names no action.
   */
  test.each([
    [500, false, "Writes the 500 rows shown."],
    [500, true, "Writes the 500 rows shown."],
    [1, false, "Writes the 1 row shown."],
    [1, true, "Writes the 1 row shown."],
    [0, false, "Writes the 0 rows shown."],
    [0, true, "Writes the 0 rows shown."],
  ])("a provider-cut result of %p rows (page fetchable: %p) reads as the rows shown", (count, fetchable, summary) => {
    const scope = describeExportScope({ rows: rows(count), pagination: cutBy(count) }, fetchable);
    expect(scope.summary).toBe(summary);
    expect(scope.shortfall).toBe(CUT);
  });

  test.each([
    [500, "Writes the 500 rows shown."],
    [1, "Writes the 1 row shown."],
  ])("a route-bounded result of %p rows with no page offered reads as the rows shown", (count, summary) => {
    const scope = describeExportScope(
      {
        rows: rows(count),
        pagination: { limit: count, offset: 0, hasMore: true, totalReturned: count, wasLimited: true },
      },
      false,
    );
    expect(scope.summary).toBe(summary);
    expect(scope.shortfall).toBe(CUT);
    expect(scope.shortfall).not.toContain("load");
  });

  test("a cut result's count is grouped", () => {
    expect(describeExportScope({ rows: rows(1234), pagination: cutBy(1234) }, false).countLabel).toBe("1,234");
    expect(describeExportScope({ rows: rows(1234), pagination: cutBy(1234) }, false).summary).toBe(
      "Writes the 1,234 rows shown.",
    );
  });

  test("a page really offered stays the loadable case even when the provider also cut", () => {
    const scope = describeExportScope(
      { rows: rows(500), pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 500, wasLimited: true } },
      true,
    );
    expect(scope.summary).toBe("Writes the 500 rows loaded here.");
    expect(scope.shortfall).toBe("More rows are still on the server — load them first to include them.");
  });

  test("hasMore without wasLimited and no page offered still reads as all the rows", () => {
    const scope = describeExportScope(
      { rows: rows(20), pagination: { limit: 20, offset: 0, hasMore: true, totalReturned: 20, wasLimited: false } },
      false,
    );
    expect(scope.summary).toBe("Writes all 20 rows.");
    expect(scope.shortfall).toBeNull();
  });

  /**
   * A bound the USER typed is not a shortfall either (#816).
   *
   * `SELECT * FROM t LIMIT 500` returning exactly 500 rows used to report
   * `hasMore: true` — 500 rows against an execution limit of 500 — and this dialog then
   * warned of rows on the server and told the user to "load them first". There is no
   * Load More on such a statement and there never was: the limiter returns it untouched
   * and drops the offset with it, which is the defect #816 fixed. The advice named an
   * action the UI does not offer.
   *
   * The route's `hasMore` now also requires `wasLimited`, so the case arrives here as
   * "nothing was held back", and the file really does contain every row the statement
   * returns. Widening the statement is the user's move, not ours.
   */
  test("a bound the statement carried itself is not a shortfall, even filled exactly", () => {
    const scope = describeExportScope(
      {
        rows: rows(500),
        pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 500, wasLimited: false },
      },
      false,
    );

    expect(scope.summary).toBe("Writes all 500 rows.");
    expect(scope.shortfall).toBeNull();
  });

  /**
   * AN ENGINE THAT CANNOT PAGE HAS A SHORTFALL WITH NO LOAD TO NAME (#816).
   *
   * Measured 2026-09-20 with an unconnected provider: a tree click on Cassandra now
   * generates `SELECT * FROM app.orders;`, the limiter bounds it at the preview page size
   * (`wasLimited: true`, `limit: 50`) and a table of more than 50 rows fills it, and since
   * #1440 the route answers `hasMore: true` only when its probe found a row past the bound
   * (`src/lib/api/page-probe.ts:32`). Elasticsearch measures identically. Both declare
   * `supportsResultPagination: false` — `prepareQuery` throws on any `offset > 0` — so the
   * grid correctly offers no control.
   *
   * The menu says the file holds the rows shown and that the result was cut, and names no
   * load, because no control exists to fetch the rest.
   */
  test("an engine that cannot page is not asked to load more first", () => {
    const scope = describeExportScope(
      {
        rows: rows(50),
        pagination: { limit: 50, offset: 0, hasMore: true, totalReturned: 50, wasLimited: true },
      },
      false,
    );

    expect(scope.summary).toBe("Writes the 50 rows shown.");
    expect(scope.shortfall).toBe("The result was cut, so the file is not the whole result.");
    expect(scope.shortfall).not.toContain("load");
  });

  /**
   * A result that fit inside the route's bound has carried `wasLimited: false` since
   * `src/app/api/db/query/route.ts:319` set it from the probe.
   */
  test("a limit the result fit inside is not a shortfall", () => {
    const scope = describeExportScope(
      {
        rows: rows(12),
        pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 12, wasLimited: false },
      },
      true,
    );

    expect(scope.summary).toBe("Writes all 12 rows.");
    expect(scope.shortfall).toBeNull();
  });
});
