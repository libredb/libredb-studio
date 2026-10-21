// The ResultsPresenter until the results view lands: one LibreDB log line per run event, with the query id, the
// document label and the connection name, and never the statement or a row.
import type * as vscode from "vscode";
import type { QueryPage } from "../../protocol";
import { backendStoppedSentence } from "../../webview/notices";
import { BackendError, BackendExitedError } from "../backend-client";
import type { ResultsPresenter, RunStart } from "./results-presenter";

/** Writes each run's outcome to the LibreDB log, deciding by error class and BackendError.code, never by message text. */
export class LogResultsPresenter implements ResultsPresenter {
  constructor(private readonly log: Pick<vscode.LogOutputChannel, "info" | "warn" | "error">) {}

  runStarted(run: RunStart): void {
    this.log.info(`Run ${run.queryId} started on ${run.documentLabel} (${run.connectionName}).`);
  }

  runSucceeded(queryId: string, page: QueryPage): void {
    this.log.info(`Run ${queryId} answered ${rowsText(page.rows.length)} in ${page.executionTime} ms.`);
  }

  runFailed(queryId: string, error: unknown): void {
    if (error instanceof BackendError && error.code === "QUERY_CANCELLED") {
      this.log.warn(`Run ${queryId} was cancelled.`);
    } else if (error instanceof BackendExitedError) {
      this.log.warn(`Run ${queryId}: ${backendStoppedSentence(error.exitCode, error.signal)}`);
    } else if (error instanceof BackendError) {
      this.log.error(`Run ${queryId} failed: ${error.message}`);
    } else if (error instanceof Error) {
      this.log.error(`Run ${queryId} failed: ${error.message}\n${error.stack}`);
    } else {
      this.log.error(`Run ${queryId} failed: ${String(error)}`);
    }
  }

  documentClosed(): void {}

  documentMoved(): void {}
}

/** "1 row", or "<n> rows" for any other count. */
function rowsText(count: number): string {
  return count === 1 ? "1 row" : `${count} rows`;
}
