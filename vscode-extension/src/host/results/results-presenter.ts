// The seams between a run and the place its outcome shows (part 4, "How a run arrives"). Types only: until the
// results view lands, LogResultsPresenter (log-presenter.ts) is the one ResultsPresenter.
import type { DatabaseType } from "@/lib/types";
import type { ProviderDescription, QueryPage } from "../../protocol";

/** What a presenter learns when a run's statement is sent. */
export interface RunStart {
  /** The run's backend queryId, for its first page at offset 0. */
  queryId: string;
  documentUri: string;
  documentLabel: string;
  connectionId: string;
  connectionName: string;
  /** The profile's type: GridContext.databaseType, which the results view builds. */
  connectionType: DatabaseType;
  /** The description the run was sent under: the results view reads its capabilities and labels here. */
  description: ProviderDescription;
  /** The text sent to query/run. */
  statement: string;
  catalog?: string;
  /** libredb.query.rowLimit, read at the run. */
  limit: number;
}

/** Where a run's outcome goes: one place for each outcome, never a notification (part 3, "The run"). */
export interface ResultsPresenter {
  runStarted(run: RunStart): void;
  runSucceeded(queryId: string, page: QueryPage): void;
  runFailed(queryId: string, error: unknown): void;
  documentClosed(documentUri: string): void;
  documentMoved(fromUri: string, toUri: string): void;
}

/** One further page of a run's statement, read under its document's key. */
export interface PageRead {
  documentUri: string;
  connectionId: string;
  statement: string;
  catalog?: string;
  limit: number;
  offset: number;
}

/** Implemented by the run service: one page read, registered in the run registry under documentUri. */
export interface PageRunner {
  runPage(read: PageRead): Promise<QueryPage>;
}
