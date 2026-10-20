// The Results view's sentences, in one place (part 4 "What the person sees" and "Several result sets, errors and
// empty results"). Pure, so the words are tested without a DOM.
import type { RunFailure } from "../results-protocol";
import type { ResultsView } from "./results-reducer";

export const EMPTY_SENTENCE = "No results yet. Run a query in a LibreDB editor to see its rows here.";
export const RUNNING_SENTENCE = "Running query...";
export const RUN_FAILED_TITLE = "The query failed.";
export const CANCELLED_TITLE = "Query Cancelled";
export const CANCELLED_SENTENCE = "Query execution was cancelled.";
export const PAGE_FAILED_TITLE = "Load More Error";
export const PAGE_CANCELLED_SENTENCE = "Loading more rows was cancelled.";
export const DISPLAY_FAILED_TITLE = "This result could not be displayed.";
/** Follows the grid's own "copied" notice, which goes out before the host answers, when the host did not write. */
export const COPY_FAILED_SENTENCE = "Could not copy to the clipboard.";

/** One line above the grid: an optional title over its text. */
export interface Notice {
  title?: string;
  text: string;
}

/** The architecture's sentence for a backend that stopped during a run, with a null code or signal as "none". */
export function backendStoppedSentence(exitCode: number | null, signal: string | null): string {
  return `The LibreDB backend stopped while this query ran (exit code ${exitCode ?? "none"}, signal ${signal ?? "none"}). The statement may already have run on the server.`;
}

function pageFailureText(failure: RunFailure): string {
  switch (failure.kind) {
    case "error":
      return failure.detail === undefined ? failure.message : `${failure.message}\n${failure.detail}`;
    case "cancelled":
      return PAGE_CANCELLED_SENTENCE;
    case "backendExited":
      return backendStoppedSentence(failure.exitCode, failure.signal);
  }
}

/** Every notice line that applies above the grid, in order: a page failure, the rolled-back transaction, several result sets. */
export function noticesFor(view: Extract<ResultsView, { kind: "rows" }>): Notice[] {
  const notices: Notice[] = [];
  if (view.pageFailure) notices.push({ title: PAGE_FAILED_TITLE, text: pageFailureText(view.pageFailure) });
  if (view.openTransaction === "rolled-back") {
    notices.push({
      text: `Transaction rolled back. This left a transaction open and it was rolled back, so its changes were discarded. Add ${view.grid.commitKeyword} to keep them.`,
    });
  }
  if (view.resultSetCount !== undefined) {
    notices.push({ text: `This text produced ${view.resultSetCount} result sets; the first is shown.` });
  }
  return notices;
}
