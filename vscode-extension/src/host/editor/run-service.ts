// A run's request and its outcome (part 3, "The run" and "Cancel"; part 4, "How a run arrives" and the PageRunner
// contract): one query/run per run and per page read, each under a fresh queryId and registered under its document.
import type * as vscode from "vscode";
import type { BackendApi, CancelResult, QueryPage, RunConfirmationParam, RunQueryParams } from "../../protocol";
import { BackendError } from "../backend-client";
import { RESULTS_VIEW } from "../names";
import type { OpenConnections } from "../open-connections";
import type { PageRead, PageRunner, ResultsPresenter, RunStart } from "../results/results-presenter";
import { type ConfirmationAnswer, type ConfirmationAsk, RunNotConfirmedError } from "./run-confirmation";
import type { PreparingRun, RunEntry, RunRegistry } from "./run-registry";
import { untilCancelled } from "./run-query";

export interface RunServiceDeps {
  readonly client: Pick<BackendApi, "runQuery" | "cancelQuery">;
  readonly runs: RunRegistry;
  readonly presenter: ResultsPresenter;
  /** Where a page read finds whether its connection can cancel; no recorded description means it cannot. */
  readonly opened: Pick<OpenConnections, "get">;
  /** Where each query/run shows its progress: the Results view (part 3, "The run"). */
  readonly window: Pick<typeof vscode.window, "withProgress">;
  /** crypto.randomUUID in activate. */
  newQueryId(): string;
  /** askToRun on the window in activate: the question a 428 the child answers is asked with. */
  confirm(ask: ConfirmationAsk, token: vscode.CancellationToken): Promise<ConfirmationAnswer | undefined>;
}

/**
 * What Run knows of a run before its queryId is minted, and the confirmation its query/run carries: the token Run's
 * question answered, or none, which sends "ask". The confirmation goes into that request only, never into RunStart.
 */
export type RunRequest = Omit<RunStart, "queryId" | "documentUri" | "connectionId"> & {
  confirmation?: ConfirmationAnswer;
};

export class RunService implements PageRunner {
  constructor(private readonly deps: RunServiceDeps) {}

  /**
   * Mints the queryId, starts the registry entry, calls presenter.runStarted, sends runQuery with offset 0 and the
   * entry's token, hands the page or the error to the presenter, and settles the entry. Rejects only when the prepared
   * run is no longer registered (a backend crash cleared it), before anything is sent or presented.
   */
  async execute(prepared: PreparingRun, { confirmation, ...request }: RunRequest): Promise<void> {
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
      presenter.runSucceeded(
        queryId,
        await this.inProgress(() => this.confirmed(entry, 0, request.connectionName, confirmation ?? "ask")),
      );
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
      return await this.inProgress(() => this.confirmed(entry, read.offset, read.connectionName, "ask"));
    } finally {
      runs.settle(entry);
    }
  }

  /**
   * One query/run with `confirmation`. A 428 to a request that sent "ask" is asked, with the offer it carries, and the
   * request is sent once more under the same queryId with the answer; a declined question rejects with
   * RunNotConfirmedError. Any other error, a 428 to a request that carried a token and a second 428 included, rejects
   * as it is: no loop and no second question. The question is raced against the entry's token, as prepare's are: an
   * entry cancelled while it is open (Cancel, a settings change, a backend stop) rejects with RunNotConfirmedError at
   * once, and the answer picked after is never read, so nothing is resent.
   */
  private async confirmed(
    entry: RunEntry,
    offset: number,
    connectionName: string,
    confirmation: RunConfirmationParam,
  ): Promise<QueryPage> {
    try {
      return await send(this.deps.client, entry, offset, confirmation);
    } catch (error) {
      const offer = error instanceof BackendError && error.status === 428 ? error.confirmation : undefined;
      if (confirmation !== "ask" || offer === undefined) throw error;
      const answer = await untilCancelled(
        this.deps.confirm({ connectionName, statement: entry.statement, offer }, entry.tokenSource.token),
        entry.tokenSource.token,
      );
      if (answer.cancelled || answer.value === undefined) throw new RunNotConfirmedError();
      return await send(this.deps.client, entry, offset, answer.value);
    }
  }

  /** The task inside the progress the Results view shows while a query/run is in flight. */
  private inProgress<T>(task: () => Promise<T>): Thenable<T> {
    return this.deps.window.withProgress({ location: { viewId: RESULTS_VIEW } }, task);
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
function send(
  client: RunServiceDeps["client"],
  entry: RunEntry,
  offset: number,
  confirmation: RunConfirmationParam,
): Promise<QueryPage> {
  const params: RunQueryParams = {
    connectionId: entry.connectionId,
    queryId: entry.queryId,
    statement: entry.statement,
    ...(entry.catalog === undefined ? {} : { catalog: entry.catalog }),
    limit: entry.limit,
    offset,
    confirmation,
  };
  return client.runQuery(params, entry.tokenSource.token);
}
