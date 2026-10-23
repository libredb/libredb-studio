// The Results view's state, as one pure function of the host's parsed messages.
// One reducer serves the live sequence and the replay on ready, since a replay is the live sequence (part 4).
import { appendResultPage } from "@/lib/results/append-page";
import type { QueryResult } from "@/lib/types";
import type { QueryPage } from "../protocol";
import type { GridContext, HostToWebview, RunFailure, ThemeKind } from "../results-protocol";

export type ResultsView =
  | { kind: "empty" }
  | { kind: "running"; runId: string; statement: string; startedAt: number }
  | {
      kind: "rows";
      runId: string;
      statement: string;
      result: QueryResult;
      grid: GridContext;
      openTransaction?: "rolled-back";
      resultSetCount?: number;
      loadingMore: boolean;
      pageFailure?: RunFailure;
    }
  | { kind: "failed"; runId: string; statement: string; failure: RunFailure };

export interface ResultsState {
  theme: ThemeKind | null;
  view: ResultsView;
}

export const INITIAL_RESULTS_STATE: ResultsState = { theme: null, view: { kind: "empty" } };

type RowsView = Extract<ResultsView, { kind: "rows" }>;

/** The grid's QueryResult from a page: the page without openTransaction and resultSetCount. */
export function pageToResult(page: QueryPage): QueryResult {
  const result: QueryPage = { ...page };
  delete result.openTransaction;
  delete result.resultSetCount;
  return result;
}

/** The view a run message for `runId` may change: the shown view when it is of `kind` and that run, else undefined. */
function same<K extends ResultsView["kind"]>(
  view: ResultsView,
  kind: K,
  runId: string,
): Extract<ResultsView, { kind: K }> | undefined {
  return view.kind === kind && "runId" in view && view.runId === runId
    ? (view as Extract<ResultsView, { kind: K }>)
    : undefined;
}

/** The rows view without its page failure, with `changes` applied. */
function rowsWith(view: RowsView, changes: Partial<RowsView>): ResultsState["view"] {
  const next: RowsView = { ...view, ...changes };
  delete next.pageFailure;
  return next;
}

/**
 * Pure: the state a parsed host message leaves. A run message for another runId, or one that arrives in a view it
 * does not apply to, returns the same state object, so React does not render; copied is not a state change.
 */
export function resultsReducer(state: ResultsState, message: HostToWebview): ResultsState {
  const withView = (view: ResultsView): ResultsState => ({ ...state, view });
  switch (message.type) {
    case "init":
    case "theme":
      return state.theme === message.theme ? state : { ...state, theme: message.theme };
    case "clear":
      return state.view.kind === "empty" ? state : withView({ kind: "empty" });
    case "runStarted":
      return withView({
        kind: "running",
        runId: message.runId,
        statement: message.statement,
        startedAt: message.startedAt,
      });
    case "runSucceeded": {
      const view = same(state.view, "running", message.runId);
      if (!view) return state;
      const { openTransaction, resultSetCount } = message.page;
      return withView({
        kind: "rows",
        runId: view.runId,
        statement: view.statement,
        result: pageToResult(message.page),
        grid: message.grid,
        ...(openTransaction !== undefined && { openTransaction }),
        ...(resultSetCount !== undefined && { resultSetCount }),
        loadingMore: false,
      });
    }
    case "runFailed": {
      const view = same(state.view, "running", message.runId);
      if (!view) return state;
      return withView({ kind: "failed", runId: view.runId, statement: view.statement, failure: message.failure });
    }
    case "pageStarted": {
      const view = same(state.view, "rows", message.runId);
      return view ? withView(rowsWith(view, { loadingMore: true })) : state;
    }
    case "pageAppended": {
      const view = same(state.view, "rows", message.runId);
      if (!view) return state;
      return withView(
        rowsWith(view, { result: appendResultPage(view.result, pageToResult(message.page)), loadingMore: false }),
      );
    }
    case "pageFailed": {
      const view = same(state.view, "rows", message.runId);
      return view ? withView({ ...view, loadingMore: false, pageFailure: message.failure }) : state;
    }
    case "copied":
      return state;
  }
}
