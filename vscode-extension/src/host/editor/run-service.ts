// A run's request and its outcome (part 3, "The run" and "Cancel"; part 4, "How a run arrives" and the PageRunner
// contract): one query/run per run and per page read, each under a fresh queryId and registered under its document.
import type { BackendApi, CancelResult, QueryPage, RunQueryParams } from "../../protocol";
import type { OpenConnections } from "../open-connections";
import type { PageRead, PageRunner, ResultsPresenter, RunStart } from "../results/results-presenter";
import type { PreparingRun, RunEntry, RunRegistry } from "./run-registry";

export interface RunServiceDeps {
  readonly client: Pick<BackendApi, "runQuery" | "cancelQuery">;
  readonly runs: RunRegistry;
  readonly presenter: ResultsPresenter;
  /** Where a page read finds whether its connection can cancel; no recorded description means it cannot. */
  readonly opened: Pick<OpenConnections, "get">;
  /** crypto.randomUUID in activate. */
  newQueryId(): string;
}

/** What Run knows of a run before its queryId is minted. */
export type RunRequest = Omit<RunStart, "queryId" | "documentUri" | "connectionId">;

export class RunService implements PageRunner {
  constructor(private readonly deps: RunServiceDeps) {}

  /**
   * Mints the queryId, starts the registry entry, calls presenter.runStarted, sends runQuery with offset 0 and the
   * entry's token, hands the page or the error to the presenter, and settles the entry. Rejects only when the prepared
   * run is no longer registered (a backend crash cleared it), before anything is sent or presented.
   */
  async execute(prepared: PreparingRun, request: RunRequest): Promise<void> {
    const { runs, presenter } = this.deps;
    const queryId = this.deps.newQueryId();
    const entry = runs.start(prepared, {
      queryId,
      catalog: request.catalog,
      statement: request.statement,
      limit: request.limit,
      cancellable: request.description.capabilities.supportsQueryCancel,
    });
    try {
      presenter.runStarted({ ...request, queryId, documentUri: entry.uri, connectionId: entry.connectionId });
      presenter.runSucceeded(queryId, await send(this.deps.client, entry, 0));
    } catch (error) {
      presenter.runFailed(queryId, error);
    } finally {
      runs.settle(entry);
    }
  }

  /** A page read: prepared and started under its document (RunInFlightError while it holds a run), sent, settled. */
  async runPage(read: PageRead): Promise<QueryPage> {
    const { runs } = this.deps;
    const prepared = runs.prepare(read.documentUri, read.connectionId);
    const entry = runs.start(prepared, {
      queryId: this.deps.newQueryId(),
      catalog: read.catalog,
      statement: read.statement,
      limit: read.limit,
      cancellable: this.deps.opened.get(read.connectionId)?.description.capabilities.supportsQueryCancel ?? false,
    });
    try {
      return await send(this.deps.client, entry, read.offset);
    } finally {
      runs.settle(entry);
    }
  }

  /** Cancel: a preparing run's token is cancelled; a running, cancellable run is sent query/cancel; undefined when nothing was sent. */
  async cancel(uri: string): Promise<CancelResult | undefined> {
    const run = this.deps.runs.of(uri);
    if (run === undefined) return undefined;
    if (run.phase === "preparing") {
      run.tokenSource.cancel();
      return undefined;
    }
    if (!run.cancellable) return undefined;
    return await this.deps.client.cancelQuery({ connectionId: run.connectionId, queryId: run.queryId });
  }
}

/** One query/run of the entry at the offset, with a catalog key only when the entry has a catalog. */
function send(client: RunServiceDeps["client"], entry: RunEntry, offset: number): Promise<QueryPage> {
  const params: RunQueryParams = {
    connectionId: entry.connectionId,
    queryId: entry.queryId,
    statement: entry.statement,
    ...(entry.catalog === undefined ? {} : { catalog: entry.catalog }),
    limit: entry.limit,
    offset,
  };
  return client.runQuery(params, entry.tokenSource.token);
}
