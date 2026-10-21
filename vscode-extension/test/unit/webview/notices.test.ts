import assert from "node:assert/strict";
import type { QueryResult } from "@/lib/types";
import type { RunFailure } from "../../../src/results-protocol";
import {
  backendStoppedSentence,
  noticesFor,
  PAGE_CANCELLED_SENTENCE,
  PAGE_FAILED_TITLE,
} from "../../../src/webview/notices";
import type { ResultsView } from "../../../src/webview/results-reducer";

type RowsView = Extract<ResultsView, { kind: "rows" }>;

const result: QueryResult = {
  rows: [{ n: 1 }],
  fields: ["n"],
  rowCount: 1,
  executionTime: 2,
  pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 1, wasLimited: false },
};

const rows = (changes: Partial<RowsView> = {}, commitKeyword = "COMMIT"): RowsView => ({
  kind: "rows",
  runId: "6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4",
  statement: "select 1",
  result,
  grid: { databaseType: "postgres", supportsResultPagination: true, commitKeyword },
  loadingMore: false,
  ...changes,
});

const rolledBack = (keyword: string) =>
  `Transaction rolled back. This left a transaction open and it was rolled back, so its changes were discarded. Add ${keyword} to keep them.`;

describe("the results view's notices", () => {
  it("spells a missing exit code or signal as none", () => {
    assert.equal(
      backendStoppedSentence(null, "SIGKILL"),
      "The LibreDB backend stopped while this query ran (exit code none, signal SIGKILL). The statement may already have run on the server.",
    );
    assert.equal(
      backendStoppedSentence(1, null),
      "The LibreDB backend stopped while this query ran (exit code 1, signal none). The statement may already have run on the server.",
    );
  });

  it("gives no notice for plain rows", () => {
    assert.deepEqual(noticesFor(rows()), []);
  });

  it("names the grid context's commit keyword in the rolled-back notice", () => {
    assert.deepEqual(noticesFor(rows({ openTransaction: "rolled-back" })), [{ text: rolledBack("COMMIT") }]);
    assert.deepEqual(noticesFor(rows({ openTransaction: "rolled-back" }, "COMMIT TRANSACTION")), [
      { text: rolledBack("COMMIT TRANSACTION") },
    ]);
  });

  it("states how many result sets the text produced", () => {
    assert.deepEqual(noticesFor(rows({ resultSetCount: 2 })), [
      { text: "This text produced 2 result sets; the first is shown." },
    ]);
  });

  it("gives a page failure's words for each failure kind", () => {
    const cases: [RunFailure, string][] = [
      [{ kind: "error", message: "connection reset" }, "connection reset"],
      [{ kind: "error", message: "connection reset", detail: "at offset 500" }, "connection reset\nat offset 500"],
      [{ kind: "cancelled" }, PAGE_CANCELLED_SENTENCE],
      [{ kind: "backendExited", exitCode: null, signal: "SIGKILL" }, backendStoppedSentence(null, "SIGKILL")],
    ];
    for (const [pageFailure, text] of cases) {
      assert.deepEqual(noticesFor(rows({ pageFailure })), [{ title: PAGE_FAILED_TITLE, text }]);
    }
    assert.equal(PAGE_FAILED_TITLE, "Load More Error");
    assert.equal(PAGE_CANCELLED_SENTENCE, "Loading more rows was cancelled.");
  });

  it("shows every notice that applies, page failure first, then the rollback, then the result sets", () => {
    const view = rows({
      pageFailure: { kind: "cancelled" },
      openTransaction: "rolled-back",
      resultSetCount: 3,
    });
    assert.deepEqual(noticesFor(view), [
      { title: PAGE_FAILED_TITLE, text: PAGE_CANCELLED_SENTENCE },
      { text: rolledBack("COMMIT") },
      { text: "This text produced 3 result sets; the first is shown." },
    ]);
  });
});
