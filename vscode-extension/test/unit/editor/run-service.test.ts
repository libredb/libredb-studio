import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { BackendError, BackendExitedError } from "../../../src/host/backend-client";
import { type PreparingRun, RunInFlightError, RunRegistry } from "../../../src/host/editor/run-registry";
import { type RunRequest, RunService } from "../../../src/host/editor/run-service";
import type { OpenedConnection } from "../../../src/host/open-connections";
import type { ResultsPresenter, RunStart } from "../../../src/host/results/results-presenter";
import type { CancelParams, CancelResult, ProviderDescription, QueryPage, RunQueryParams } from "../../../src/protocol";
import { ZERO_LEVELS } from "../../fakes/descriptions";
import { CancellationTokenSource, progressRuns, window } from "../../fakes/vscode";

const UNTITLED = "untitled:Untitled-1";
const FILE = "file:///w/q.sql";
const STATEMENT = "select 1;";

/** ZERO_LEVELS with supportsQueryCancel set as given. */
function cancellable(supportsQueryCancel: boolean): ProviderDescription {
  return { ...ZERO_LEVELS, capabilities: { ...ZERO_LEVELS.capabilities, supportsQueryCancel } };
}

const PAGE: QueryPage = {
  rows: [{ v: 1 }],
  fields: ["v"],
  rowCount: 1,
  executionTime: 2,
  pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 1, wasLimited: false },
};

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A service over a real registry, a client whose runQuery waits for the test, and a presenter that records each call. */
function setup(opened: Record<string, ProviderDescription> = {}) {
  const sent: [RunQueryParams, vscode.CancellationToken | undefined][] = [];
  const pending: ReturnType<typeof deferred<QueryPage>>[] = [];
  const cancels: CancelParams[] = [];
  let cancelAnswer: () => Promise<CancelResult> = () => Promise.resolve({ cancelled: true });
  const client = {
    runQuery: (params: RunQueryParams, token?: vscode.CancellationToken) => {
      sent.push([params, token]);
      const answer = deferred<QueryPage>();
      pending.push(answer);
      return answer.promise;
    },
    cancelQuery: (params: CancelParams) => {
      cancels.push(params);
      return cancelAnswer();
    },
  };
  const calls: [keyof ResultsPresenter, ...unknown[]][] = [];
  const presenter: ResultsPresenter = {
    runStarted: (run: RunStart) => calls.push(["runStarted", run]),
    runSucceeded: (queryId: string, page: QueryPage) => calls.push(["runSucceeded", queryId, page]),
    runFailed: (queryId: string, error: unknown) => calls.push(["runFailed", queryId, error]),
    documentClosed: (uri: string) => calls.push(["documentClosed", uri]),
    documentMoved: (from: string, to: string) => calls.push(["documentMoved", from, to]),
  };
  const runs = new RunRegistry(() => new CancellationTokenSource());
  let minted = 0;
  const service = new RunService({
    client,
    runs,
    presenter,
    window,
    opened: {
      get: (connectionId: string): OpenedConnection | undefined =>
        opened[connectionId] === undefined ? undefined : { description: opened[connectionId], generation: 1 },
    },
    newQueryId: () => {
      minted += 1;
      return `q${minted}`;
    },
  });
  return {
    service,
    runs,
    sent,
    pending,
    cancels,
    calls,
    answerCancel: (answer: () => Promise<CancelResult>) => {
      cancelAnswer = answer;
    },
  };
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    documentLabel: "Untitled-1",
    connectionName: "shop",
    connectionType: "postgres",
    description: cancellable(true),
    statement: STATEMENT,
    limit: 500,
    ...overrides,
  };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The options every query/run's progress is shown with: the Results view (part 3, "The run"). */
const ON_RESULTS = { location: { viewId: "libredb.results" } };

describe("RunService", () => {
  describe("execute", () => {
    it("starts the run, sends it with the entry's token and hands the page to the presenter", async () => {
      const { service, runs, sent, pending, calls } = setup();
      const prepared = runs.prepare(UNTITLED, "c1");
      const done = service.execute(prepared, request({ catalog: "shop" }));
      await settle();
      assert.deepEqual(calls, [
        [
          "runStarted",
          {
            queryId: "q1",
            documentUri: UNTITLED,
            connectionId: "c1",
            documentLabel: "Untitled-1",
            connectionName: "shop",
            connectionType: "postgres",
            description: cancellable(true),
            statement: STATEMENT,
            catalog: "shop",
            limit: 500,
          },
        ],
      ]);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0][0], {
        connectionId: "c1",
        queryId: "q1",
        statement: STATEMENT,
        catalog: "shop",
        limit: 500,
        offset: 0,
      });
      assert.equal(sent[0][1], prepared.tokenSource.token);
      const entry = runs.of(UNTITLED);
      assert.equal(entry?.phase, "running");
      assert.deepEqual(runs.cancellable(), [UNTITLED]);
      pending[0].resolve(PAGE);
      await done;
      assert.deepEqual(calls.slice(1), [["runSucceeded", "q1", PAGE]]);
      assert.deepEqual(runs.running(), []);
    });

    it("sends the run inside one progress on the Results view, opened after runStarted and settled once presented", async () => {
      const { service, runs, pending, calls } = setup();
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      assert.equal(calls[0][0], "runStarted");
      assert.deepEqual(
        progressRuns.map((run) => [run.options, run.settled]),
        [[ON_RESULTS, false]],
      );
      pending[0].resolve(PAGE);
      await done;
      assert.deepEqual(
        progressRuns.map((run) => [run.options, run.settled]),
        [[ON_RESULTS, true]],
      );

      const failing = setup();
      const failed = failing.service.execute(failing.runs.prepare(FILE, "c1"), request());
      await settle();
      failing.pending[0].reject(new BackendError(400, "QUERY_ERROR", "boom"));
      await failed;
      assert.deepEqual(
        progressRuns.map((run) => [run.options, run.settled]),
        [
          [ON_RESULTS, true],
          [ON_RESULTS, true],
        ],
      );
    });

    it("opens no progress when runStarted throws", async () => {
      const { runs, calls, sent } = setup();
      const presenterError = new Error("the view is gone");
      const prepared = runs.prepare(UNTITLED, "c1");
      const throwing = new RunService({
        client: { runQuery: () => Promise.reject(new Error("unreached")), cancelQuery: () => Promise.reject() },
        runs,
        window,
        opened: { get: () => undefined },
        presenter: {
          runStarted: () => {
            throw presenterError;
          },
          runSucceeded: () => {},
          runFailed: (queryId, error) => calls.push(["runFailed", queryId, error]),
          documentClosed: () => {},
          documentMoved: () => {},
        },
        newQueryId: () => "q9",
      });
      await throwing.execute(prepared, request());
      assert.deepEqual(progressRuns, []);
      assert.deepEqual(sent, []);
      assert.deepEqual(calls, [["runFailed", "q9", presenterError]]);
    });

    it("sends no catalog key when the request carries none", async () => {
      const { service, runs, sent, pending } = setup();
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      assert.equal(Object.hasOwn(sent[0][0], "catalog"), false);
      pending[0].resolve(PAGE);
      await done;
    });

    it("registers a run that cannot be cancelled when the description says so", async () => {
      const { service, runs, pending } = setup();
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request({ description: cancellable(false) }));
      await settle();
      assert.deepEqual(runs.running(), [UNTITLED]);
      assert.deepEqual(runs.cancellable(), []);
      pending[0].resolve(PAGE);
      await done;
    });

    it("mints a fresh query id for each run", async () => {
      const { service, runs, sent, pending } = setup();
      const first = service.execute(runs.prepare(UNTITLED, "c1"), request());
      const second = service.execute(runs.prepare(FILE, "c1"), request());
      await settle();
      assert.deepEqual(
        sent.map(([params]) => params.queryId),
        ["q1", "q2"],
      );
      for (const answer of pending) answer.resolve(PAGE);
      await Promise.all([first, second]);
    });

    for (const [name, error] of [
      ["a cancelled run", new BackendError(500, "QUERY_CANCELLED", "cancelled")],
      ["a lost backend", new BackendExitedError({ exitCode: null, signal: "SIGKILL" })],
      ["any other error", new TypeError("boom")],
    ] as const) {
      it(`hands ${name} to the presenter, resolves and settles`, async () => {
        const { service, runs, pending, calls } = setup();
        const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
        await settle();
        pending[0].reject(error);
        await done;
        assert.deepEqual(calls.at(-1), ["runFailed", "q1", error]);
        assert.equal(calls.at(-1)?.[2], error);
        assert.deepEqual(runs.running(), []);
      });
    }

    it("rejects, sending nothing, when the prepared run is no longer registered", async () => {
      const { service, runs, sent, calls } = setup();
      const prepared = runs.prepare(UNTITLED, "c1");
      runs.clear();
      await assert.rejects(service.execute(prepared, request()), /no longer registered/);
      assert.deepEqual(sent, []);
      assert.deepEqual(calls, []);
    });
  });

  describe("cancel", () => {
    it("cancels a preparing run's token and sends nothing", async () => {
      const { service, runs, cancels } = setup();
      const prepared: PreparingRun = runs.prepare(UNTITLED, "c1");
      assert.equal(await service.cancel(UNTITLED), undefined);
      assert.equal(prepared.tokenSource.token.isCancellationRequested, true);
      assert.deepEqual(cancels, []);
    });

    it("sends query/cancel for a running, cancellable run and answers its result", async () => {
      const { service, runs, cancels, pending } = setup();
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      assert.deepEqual(await service.cancel(UNTITLED), { cancelled: true });
      assert.deepEqual(cancels, [{ connectionId: "c1", queryId: "q1" }]);
      pending[0].resolve(PAGE);
      await done;
    });

    it("sends nothing for a running run that cannot be cancelled", async () => {
      const { service, runs, cancels, pending } = setup();
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request({ description: cancellable(false) }));
      await settle();
      assert.equal(await service.cancel(UNTITLED), undefined);
      assert.deepEqual(cancels, []);
      pending[0].resolve(PAGE);
      await done;
    });

    it("answers undefined for a document with no run", async () => {
      const { service, cancels } = setup();
      assert.equal(await service.cancel(UNTITLED), undefined);
      assert.deepEqual(cancels, []);
    });

    it("rejects with query/cancel's error", async () => {
      const { service, runs, pending, answerCancel } = setup();
      const error = new BackendError(500, "INTERNAL_ERROR", "cancel failed");
      answerCancel(() => Promise.reject(error));
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      await assert.rejects(service.cancel(UNTITLED), error);
      pending[0].resolve(PAGE);
      await done;
    });
  });

  describe("runPage", () => {
    const READ = { documentUri: UNTITLED, connectionId: "c1", statement: STATEMENT, limit: 2, offset: 2 };

    it("registers the read as a run of its document, sends it at its offset and answers the page", async () => {
      const { service, runs, sent, pending } = setup({ c1: cancellable(true) });
      const read = service.runPage(READ);
      await settle();
      assert.deepEqual(runs.running(), [UNTITLED]);
      assert.deepEqual(runs.cancellable(), [UNTITLED]);
      assert.deepEqual(sent[0][0], { connectionId: "c1", queryId: "q1", statement: STATEMENT, limit: 2, offset: 2 });
      assert.equal(sent[0][1], runs.of(UNTITLED)?.tokenSource.token);
      pending[0].resolve(PAGE);
      assert.equal(await read, PAGE);
      assert.deepEqual(runs.running(), []);
    });

    it("sends the read inside one progress on the Results view, settled when the read settles", async () => {
      const { service, pending } = setup();
      const read = service.runPage(READ);
      await settle();
      assert.deepEqual(
        progressRuns.map((run) => [run.options, run.settled]),
        [[ON_RESULTS, false]],
      );
      pending[0].reject(new BackendError(400, "QUERY_ERROR", "boom"));
      await assert.rejects(read);
      assert.deepEqual(
        progressRuns.map((run) => [run.options, run.settled]),
        [[ON_RESULTS, true]],
      );
    });

    it("is a run of its document: Cancel sends the read's own queryId, and a cancelled read rejects (H6)", async () => {
      const { service, runs, pending, cancels } = setup({ c1: cancellable(true) });
      const done = service.execute(runs.prepare(FILE, "c1"), request());
      await settle();
      pending[0].resolve(PAGE);
      await done;

      const read = service.runPage({ ...READ, documentUri: FILE });
      await settle();
      assert.deepEqual(runs.running(), [FILE]);
      assert.deepEqual(runs.cancellable(), [FILE]);
      assert.deepEqual(await service.cancel(FILE), { cancelled: true });
      assert.deepEqual(cancels, [{ connectionId: "c1", queryId: "q2" }]);
      const cancelled = new BackendError(499, "QUERY_CANCELLED", "Query was cancelled");
      pending[1].reject(cancelled);
      await assert.rejects(read, cancelled);
      assert.deepEqual(runs.running(), []);
      assert.deepEqual(runs.cancellable(), []);
    });

    it("is running but not cancellable on a connection that cannot cancel, and Cancel sends nothing", async () => {
      const { service, runs, pending, cancels } = setup({ c1: cancellable(false) });
      const read = service.runPage({ ...READ, documentUri: FILE });
      await settle();
      assert.deepEqual(runs.running(), [FILE]);
      assert.deepEqual(runs.cancellable(), []);
      assert.equal(await service.cancel(FILE), undefined);
      assert.deepEqual(cancels, []);
      pending[0].resolve(PAGE);
      await read;
    });

    it("refuses a second read and a Run's prepare on its document while it is pending", async () => {
      const { service, runs, sent, pending } = setup();
      const read = service.runPage({ ...READ, documentUri: FILE });
      await settle();
      await assert.rejects(service.runPage({ ...READ, documentUri: FILE }), RunInFlightError);
      assert.throws(() => runs.prepare(FILE, "c1"), RunInFlightError);
      assert.equal(sent.length, 1);
      pending[0].resolve(PAGE);
      await read;
    });

    it("sends the read's catalog, and is not cancellable when the connection's description cannot cancel", async () => {
      const { service, runs, sent, pending } = setup({ c1: cancellable(false) });
      const read = service.runPage({ ...READ, catalog: "shop" });
      await settle();
      assert.equal(sent[0][0].catalog, "shop");
      assert.deepEqual(runs.cancellable(), []);
      pending[0].resolve(PAGE);
      await read;
    });

    it("is not cancellable when no description is recorded", async () => {
      const { service, runs, pending } = setup();
      const read = service.runPage(READ);
      await settle();
      assert.deepEqual(runs.cancellable(), []);
      pending[0].resolve(PAGE);
      await read;
    });

    it("settles and rejects with runQuery's error", async () => {
      const { service, runs, pending } = setup();
      const error = new BackendError(500, "QUERY_CANCELLED", "cancelled");
      const read = service.runPage(READ);
      await settle();
      pending[0].reject(error);
      await assert.rejects(read, error);
      assert.deepEqual(runs.running(), []);
    });

    it("throws RunInFlightError on a document that holds a run", async () => {
      const { service, runs, sent } = setup();
      runs.prepare(UNTITLED, "c1");
      await assert.rejects(service.runPage(READ), RunInFlightError);
      assert.deepEqual(sent, []);
    });
  });
});
