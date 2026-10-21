// The seams between a run and the place its outcome shows (part 4, "How a run arrives"), and the Results view's
// presenter: one record per document, the current record, and the replay that rebuilds the view on its ready.
import * as vscode from "vscode";
import type { DatabaseType } from "@/lib/types";
import type { ProviderDescription, QueryPage } from "../../protocol";
import type { GridContext, HostToWebview, RunFailure } from "../../results-protocol";
import { documentLabel } from "../editor/run-query";
import { toRunFailure } from "./failure";

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

/** The view as the presenter sees it; ResultsViewProvider implements it. */
export interface ResultsSurface {
  /** Posts to a live, visible view and drops the message otherwise: the replay on the next ready brings it back. */
  post(message: HostToWebview): void;
  /** Shows the view without taking focus. */
  reveal(): void;
  /** "<document label> on <connection name>", or undefined when no record is current. */
  describe(description: string | undefined): void;
}

/** What the view provider asks of the presenter. */
export interface ResultsSession {
  /** The current record's live sequence, or [clear] when none is current. */
  replay(): readonly HostToWebview[];
  /** Trust rule 3, then one page read; resolves once the read settled or was refused. */
  loadMore(runId: string): Promise<void>;
}

export interface ResultsViewPresenterDeps {
  readonly surface: ResultsSurface;
  readonly pages: PageRunner;
  readonly log: Pick<vscode.LogOutputChannel, "warn" | "error">;
  /** crypto.randomUUID in activate: trust rule 2's runId, never the backend's queryId. */
  newRunId(): string;
  /** Date.now in activate: runStarted.startedAt. */
  now(): number;
}

/** Why a loadMore was refused, each logged as "Load More was refused: <reason>." (criterion 7). */
export const LOAD_MORE_REFUSED = {
  unknownRun: "no current run of this window has that id",
  notSucceeded: "the run has no answered page",
  noMore: "the last page said no more rows follow",
  noPagination: "the connection does not page its results",
  inFlight: "a page is already loading",
} as const;

/** A run's outcome as its record keeps it. */
type RecordState =
  | { readonly kind: "running" }
  | { readonly kind: "failed"; readonly failure: RunFailure }
  | {
      readonly kind: "succeeded";
      /** The first page, then each appended page, in order. */
      readonly pages: QueryPage[];
      /** The first page's pagination.limit, the bound of every page read (#816). */
      readonly limit: number;
      /** The offset of the next page read: the rows every page so far returned. */
      nextOffset: number;
      /** The last answered page's pagination.hasMore. */
      hasMore: boolean;
      /** Whether a page read is in flight. */
      reading: boolean;
      /** The last page read's failure, cleared by the next pageStarted. */
      pageFailure?: RunFailure;
    };

/** What the presenter keeps for one document: its last run, and that run's outcome. */
interface ResultsRecord {
  readonly runId: string;
  readonly queryId: string;
  /** The document's last path segment, recomputed when a Save As or a rename moves the record. */
  documentLabel: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly statement: string;
  readonly catalog?: string;
  readonly startedAt: number;
  readonly grid: GridContext;
  state: RecordState;
}

/**
 * The Results view's presenter (part 4, "Which result the view shows" and "How a run arrives"): one record per
 * document URI, the current one shown, an answer stored on its record and posted only while that record is current.
 */
export class ResultsViewPresenter implements ResultsPresenter, ResultsSession {
  private readonly records = new Map<string, ResultsRecord>();
  private current: string | undefined;

  constructor(private readonly deps: ResultsViewPresenterDeps) {}

  runStarted(run: RunStart): void {
    const record: ResultsRecord = {
      runId: this.deps.newRunId(),
      queryId: run.queryId,
      documentLabel: run.documentLabel,
      connectionId: run.connectionId,
      connectionName: run.connectionName,
      statement: run.statement,
      ...(run.catalog === undefined ? {} : { catalog: run.catalog }),
      startedAt: this.deps.now(),
      grid: gridContextOf(run.connectionType, run.description),
      state: { kind: "running" },
    };
    // A second run on a document replaces its record, so the first run's answers find nothing (run step 5).
    this.records.set(run.documentUri, record);
    this.current = run.documentUri;
    this.deps.surface.describe(descriptionOf(record));
    this.deps.surface.reveal();
    this.deps.surface.post(startedMessage(record));
  }

  runSucceeded(queryId: string, page: QueryPage): void {
    const record = this.byQueryId(queryId);
    if (record === undefined) return;
    record.state = {
      kind: "succeeded",
      pages: [page],
      limit: page.pagination.limit,
      nextOffset: page.pagination.offset + page.rows.length,
      hasMore: page.pagination.hasMore,
      reading: false,
    };
    this.postIfCurrent(record, { v: 1, type: "runSucceeded", runId: record.runId, page, grid: record.grid });
  }

  runFailed(queryId: string, error: unknown): void {
    const record = this.byQueryId(queryId);
    if (record === undefined) return;
    // LogResultsPresenter logs a run's failure beside this presenter (fanOut in activate), so no log is passed.
    const failure = toRunFailure(error);
    record.state = { kind: "failed", failure };
    this.postIfCurrent(record, { v: 1, type: "runFailed", runId: record.runId, failure });
  }

  /** A closed document's record goes; the view clears when it was the one shown (part 4). */
  documentClosed(documentUri: string): void {
    if (!this.records.delete(documentUri) || this.current !== documentUri) return;
    this.current = undefined;
    this.deps.surface.describe(undefined);
    this.deps.surface.post({ v: 1, type: "clear" });
  }

  /**
   * A Save As or a rename moves the record to the new URI, replacing any record kept there, and the description names
   * the new document; a read in flight finds the record by identity, so its answer still lands.
   */
  documentMoved(fromUri: string, toUri: string): void {
    const record = this.records.get(fromUri);
    if (record === undefined) return;
    this.records.delete(fromUri);
    this.records.set(toUri, record);
    record.documentLabel = documentLabel({ uri: vscode.Uri.parse(toUri) });
    if (this.current === fromUri) {
      this.current = toUri;
      this.deps.surface.describe(descriptionOf(record));
    } else if (this.current === toUri) {
      // The shown record was replaced: the view shows the moved one in its place.
      this.show(toUri, record);
    }
  }

  /** The active editor's record becomes the one shown; an editor without one leaves the view as it is (part 4). */
  activeDocumentChanged(documentUri: string | undefined): void {
    if (documentUri === undefined || documentUri === this.current) return;
    const record = this.records.get(documentUri);
    if (record === undefined) return;
    this.show(documentUri, record);
  }

  async loadMore(runId: string): Promise<void> {
    const record = this.byRunId(runId);
    const reason = refusalOf(record);
    if (reason !== undefined) {
      this.deps.log.warn(`Load More was refused: ${reason}.`);
      return;
    }
    const known = record as ResultsRecord;
    const state = known.state as Extract<RecordState, { kind: "succeeded" }>;
    state.reading = true;
    state.pageFailure = undefined;
    this.postIfCurrent(known, { v: 1, type: "pageStarted", runId });
    // Trust rule 3: the statement, catalog, connection and bounds come from the record, never from the view.
    const read: PageRead = {
      documentUri: this.uriOf(known) as string,
      connectionId: known.connectionId,
      statement: known.statement,
      ...(known.catalog === undefined ? {} : { catalog: known.catalog }),
      limit: state.limit,
      offset: state.nextOffset,
    };
    let page: QueryPage;
    try {
      page = await this.deps.pages.runPage(read);
    } catch (error) {
      // A read whose record a new run replaced, or a close dropped, answers nothing: identity, not URI.
      if (this.uriOf(known) === undefined) return;
      state.reading = false;
      state.pageFailure = toRunFailure(error, this.deps.log);
      this.postIfCurrent(known, { v: 1, type: "pageFailed", runId, failure: state.pageFailure });
      return;
    }
    if (this.uriOf(known) === undefined) return;
    state.reading = false;
    state.pages.push(page);
    state.nextOffset += page.rows.length;
    state.hasMore = page.pagination.hasMore;
    this.postIfCurrent(known, { v: 1, type: "pageAppended", runId, page });
  }

  replay(): readonly HostToWebview[] {
    const record = this.current === undefined ? undefined : this.records.get(this.current);
    if (record === undefined) return [{ v: 1, type: "clear" }];
    const sequence: HostToWebview[] = [startedMessage(record)];
    const { state } = record;
    if (state.kind === "failed") {
      sequence.push({ v: 1, type: "runFailed", runId: record.runId, failure: state.failure });
    } else if (state.kind === "succeeded") {
      const [first, ...appended] = state.pages;
      sequence.push({ v: 1, type: "runSucceeded", runId: record.runId, page: first, grid: record.grid });
      // Each appended page replays as it was posted: its pageStarted, then its pageAppended.
      for (const page of appended) {
        sequence.push(
          { v: 1, type: "pageStarted", runId: record.runId },
          { v: 1, type: "pageAppended", runId: record.runId, page },
        );
      }
      // A read in flight ends the replay with pageStarted; otherwise a failed last read ends it with pageFailed.
      if (state.reading || state.pageFailure !== undefined) {
        sequence.push({ v: 1, type: "pageStarted", runId: record.runId });
      }
      if (!state.reading && state.pageFailure !== undefined) {
        sequence.push({ v: 1, type: "pageFailed", runId: record.runId, failure: state.pageFailure });
      }
    }
    return sequence;
  }

  /** Makes record, kept under documentUri, the one shown, and posts its live sequence. */
  private show(documentUri: string, record: ResultsRecord): void {
    this.current = documentUri;
    this.deps.surface.describe(descriptionOf(record));
    for (const message of this.replay()) this.deps.surface.post(message);
  }

  /** The record holding the run runId names, among this window's records. */
  private byRunId(runId: string): ResultsRecord | undefined {
    for (const record of this.records.values()) {
      if (record.runId === runId) return record;
    }
    return undefined;
  }

  /** The document URI record is kept under, or undefined once a new run replaced it or its document closed. */
  private uriOf(record: ResultsRecord): string | undefined {
    for (const [uri, held] of this.records) {
      if (held === record) return uri;
    }
    return undefined;
  }

  /** The record whose run sent queryId, when a record still holds that run. */
  private byQueryId(queryId: string): ResultsRecord | undefined {
    for (const record of this.records.values()) {
      if (record.queryId === queryId) return record;
    }
    return undefined;
  }

  /** Posts message when record is the one the view shows; a record not shown keeps it for its replay. */
  private postIfCurrent(record: ResultsRecord, message: HostToWebview): void {
    if (this.current !== undefined && this.records.get(this.current) === record) this.deps.surface.post(message);
  }
}

/** GridContext from what the run was sent under; maskingExemptColumns only when the description has it. */
export function gridContextOf(connectionType: DatabaseType, description: ProviderDescription): GridContext {
  const { supportsResultPagination, maskingExemptColumns } = description.capabilities;
  return {
    databaseType: connectionType,
    supportsResultPagination: supportsResultPagination === true,
    ...(maskingExemptColumns === undefined ? {} : { maskingExemptColumns }),
    commitKeyword: description.commitKeyword,
  };
}

/** One presenter that hands every call to each of `presenters` in order: the view, then the LibreDB log. */
export function fanOut(...presenters: ResultsPresenter[]): ResultsPresenter {
  return {
    runStarted: (run) => {
      for (const presenter of presenters) presenter.runStarted(run);
    },
    runSucceeded: (queryId, page) => {
      for (const presenter of presenters) presenter.runSucceeded(queryId, page);
    },
    runFailed: (queryId, error) => {
      for (const presenter of presenters) presenter.runFailed(queryId, error);
    },
    documentClosed: (documentUri) => {
      for (const presenter of presenters) presenter.documentClosed(documentUri);
    },
    documentMoved: (fromUri, toUri) => {
      for (const presenter of presenters) presenter.documentMoved(fromUri, toUri);
    },
  };
}

/** The first of criterion 7's checks record fails, in LOAD_MORE_REFUSED's order, or undefined when a read may start. */
function refusalOf(record: ResultsRecord | undefined): string | undefined {
  if (record === undefined) return LOAD_MORE_REFUSED.unknownRun;
  const { state } = record;
  if (state.kind !== "succeeded") return LOAD_MORE_REFUSED.notSucceeded;
  if (!state.hasMore) return LOAD_MORE_REFUSED.noMore;
  if (!record.grid.supportsResultPagination) return LOAD_MORE_REFUSED.noPagination;
  if (state.reading) return LOAD_MORE_REFUSED.inFlight;
  return undefined;
}

/** "<document label> on <connection name>": the view's description while record is current. */
function descriptionOf(record: ResultsRecord): string {
  return `${record.documentLabel} on ${record.connectionName}`;
}

function startedMessage(record: ResultsRecord): HostToWebview {
  return { v: 1, type: "runStarted", runId: record.runId, statement: record.statement, startedAt: record.startedAt };
}
