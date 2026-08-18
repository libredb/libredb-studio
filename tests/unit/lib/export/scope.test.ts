import { describe, test, expect } from "bun:test";
import { describeExportScope } from "@/lib/export/scope";

const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i }));

describe("describeExportScope", () => {
  test("counts the rows the file will actually contain", () => {
    expect(describeExportScope({ rows: rows(3) }).rowCount).toBe(3);
  });

  test("groups the digits, so a large count is readable at a glance", () => {
    expect(describeExportScope({ rows: rows(1234) }).countLabel).toBe("1,234");
  });

  test("says the whole result is written when nothing was held back", () => {
    const scope = describeExportScope({ rows: rows(42) });

    expect(scope.summary).toBe("Writes all 42 rows.");
    expect(scope.shortfall).toBeNull();
  });

  test("agrees with itself about a single row", () => {
    expect(describeExportScope({ rows: rows(1) }).summary).toBe("Writes all 1 row.");
  });

  test("says nothing is written for an empty result", () => {
    expect(describeExportScope({ rows: [] }).summary).toBe("Writes all 0 rows.");
  });

  // The grid holds one page. Exporting it produces a well-formed file with a
  // plausible number of rows in it, which is exactly why the shortfall has to be
  // stated rather than left for the user to discover downstream.
  test("says only the loaded rows are written when the engine held more back", () => {
    const scope = describeExportScope({
      rows: rows(500),
      pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 500, wasLimited: true },
    });

    expect(scope.summary).toBe("Writes the 500 rows loaded here.");
    expect(scope.shortfall).toBe("More rows are still on the server — load them first to include them.");
  });

  test("a limit the result fit inside is not a shortfall", () => {
    const scope = describeExportScope({
      rows: rows(12),
      pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 12, wasLimited: true },
    });

    expect(scope.summary).toBe("Writes all 12 rows.");
    expect(scope.shortfall).toBeNull();
  });
});
