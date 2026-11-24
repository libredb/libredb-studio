import assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { RunConfirmationOffer } from "@/lib/api/run-confirmation";
import { BackendError, BackendExitedError } from "../../../src/host/backend-client";
import { type ConfirmationAsk, RunNotConfirmedError } from "../../../src/host/editor/run-confirmation";
import { type PreparingRun, RunInFlightError, RunRegistry } from "../../../src/host/editor/run-registry";
import { type RunRequest, RunService } from "../../../src/host/editor/run-service";
import type { OpenedConnection } from "../../../src/host/open-connections";
import type { ResultsPresenter, RunStart } from "../../../src/host/results/results-presenter";
import type {
  CancelParams,
  CancelResult,
  ProviderDescription,
  QueryPage,
  RunConfirmationParam,
  RunQueryParams,
} from "../../../src/protocol";
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

/** What the question answers: the token and typed value, or undefined when it is dismissed. */
type Confirmed = Exclude<RunConfirmationParam, "ask"> | undefined;

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
  const asks: ConfirmationAsk[] = [];
  const confirmTokens: vscode.CancellationToken[] = [];
  let confirmAnswer: (ask: ConfirmationAsk) => Confirmed | Promise<Confirmed> = () => undefined;
  const service = new RunService({
    client,
    runs,
    presenter,
    window,
    confirm: (ask: ConfirmationAsk, token: vscode.CancellationToken) => {
      asks.push(ask);
      confirmTokens.push(token);
      return Promise.resolve(confirmAnswer(ask));
    },
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
    asks,
    confirmTokens,
    answerCancel: (answer: () => Promise<CancelResult>) => {
      cancelAnswer = answer;
    },
    answerConfirm: (answer: typeof confirmAnswer) => {
      confirmAnswer = answer;
    },
  };
}

/** An offer as the child answers it, with a token generated for the test. */
function offer(typedConfirmation: RunConfirmationOffer["typedConfirmation"] = null): RunConfirmationOffer {
  return {
    token: crypto.randomUUID(),
    expiresAt: new Date(0).toISOString(),
    unreadable: false,
    typedConfirmation,
    classificationFailed: false,
  };
}

/** The child's 428, carrying `offered`. */
function required(offered: RunConfirmationOffer): BackendError {
  return new BackendError(428, "CONFIRMATION_REQUIRED", "This statement needs a confirmation before it runs.", {
    confirmation: offered,
  });
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
        confirmation: "ask",
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
        confirm: () => Promise.reject(new Error("unreached")),
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

  describe("the confirmation a run sends", () => {
    it("sends the request's token and typed value when it has them, else ask, and never hands them to the presenter", async () => {
      const { service, runs, sent, pending, calls } = setup();
      const confirmation = { token: crypto.randomUUID(), typed: crypto.randomUUID() };
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request({ confirmation }));
      await settle();
      assert.deepEqual(sent[0][0].confirmation, confirmation);
      const [, started] = calls[0] as [string, RunStart];
      assert.equal("confirmation" in started, false);
      assert.equal(JSON.stringify(calls).includes(confirmation.token), false);
      pending[0].resolve(PAGE);
      await done;
      assert.equal(JSON.stringify(calls).includes(confirmation.typed), false);
    });
  });

  describe("a confirmation the child asks for", () => {
    it("asks with the 428's offer and resends once under the same queryId, then presents the page", async () => {
      const { service, runs, sent, pending, calls, asks, answerConfirm } = setup();
      const offered = offer();
      answerConfirm(() => ({ token: offered.token }));
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      pending[0].reject(required(offered));
      await settle();
      assert.deepEqual(asks, [{ connectionName: "shop", statement: STATEMENT, offer: offered }]);
      assert.equal(sent.length, 2);
      assert.equal(sent[1][0].queryId, sent[0][0].queryId);
      assert.deepEqual(sent[1][0].confirmation, { token: offered.token });
      assert.equal(sent[1][1], sent[0][1]);
      pending[1].resolve(PAGE);
      await done;
      assert.deepEqual(calls.at(-1), ["runSucceeded", "q1", PAGE]);
      assert.deepEqual(runs.running(), []);
    });

    it("ends the run as not confirmed when the question is declined, and resends nothing", async () => {
      const { service, runs, sent, pending, calls } = setup();
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      pending[0].reject(required(offer()));
      await done;
      assert.equal(sent.length, 1);
      const [method, queryId, error] = calls.at(-1) as [string, string, unknown];
      assert.equal(method, "runFailed");
      assert.equal(queryId, "q1");
      assert.ok(error instanceof RunNotConfirmedError);
      assert.deepEqual(runs.running(), []);
    });

    it("asks nothing for a 428 to a request that carried a token, and fails the run with the child's sentence", async () => {
      const { service, runs, sent, pending, calls, asks } = setup();
      const done = service.execute(
        runs.prepare(UNTITLED, "c1"),
        request({ confirmation: { token: crypto.randomUUID() } }),
      );
      await settle();
      const answer = required(offer());
      pending[0].reject(answer);
      await done;
      assert.deepEqual(asks, []);
      assert.equal(sent.length, 1);
      assert.deepEqual(calls.at(-1), ["runFailed", "q1", answer]);
    });

    it("asks once: a second 428 on the resend fails the run", async () => {
      const { service, runs, sent, pending, calls, asks, answerConfirm } = setup();
      answerConfirm((ask) => ({ token: ask.offer.token }));
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      pending[0].reject(required(offer()));
      await settle();
      const second = required(offer());
      pending[1].reject(second);
      await done;
      assert.equal(asks.length, 1);
      assert.equal(sent.length, 2);
      assert.deepEqual(calls.at(-1), ["runFailed", "q1", second]);
      assert.deepEqual(runs.running(), []);
    });

    it("asks nothing for a CONFIRMATION_INVALID, and fails the run with its sentence", async () => {
      const { service, runs, pending, calls, asks } = setup();
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      const invalid = new BackendError(400, "CONFIRMATION_INVALID", "this confirmation has already been used");
      pending[0].reject(invalid);
      await done;
      assert.deepEqual(asks, []);
      assert.deepEqual(calls.at(-1), ["runFailed", "q1", invalid]);
    });

    it("resends nothing when the run is cancelled while the modal is open, ends cancelled, and ignores Run Anyway picked after", async () => {
      const { service, runs, sent, pending, calls, asks, answerConfirm } = setup();
      const offered = offer();
      const question = deferred<Confirmed>();
      answerConfirm(() => question.promise);
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      pending[0].reject(required(offered));
      await settle();
      assert.equal(asks.length, 1);
      runs.cancelConnection("c1");
      await done;
      const [method, queryId, error] = calls.at(-1) as [string, string, unknown];
      assert.equal(method, "runFailed");
      assert.equal(queryId, "q1");
      assert.ok(error instanceof RunNotConfirmedError);
      assert.deepEqual(runs.running(), []);
      question.resolve({ token: offered.token });
      await settle();
      assert.equal(sent.length, 1);
    });

    it("resends nothing when the run is cancelled while the typed ask is open, which the token closes", async () => {
      const { service, runs, sent, pending, calls, confirmTokens, answerConfirm } = setup();
      const question = deferred<Confirmed>();
      answerConfirm(() => question.promise);
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      pending[0].reject(required(offer({ type: "connection-name", expected: "shop", targets: [] })));
      await settle();
      confirmTokens[0].onCancellationRequested(() => question.resolve(undefined));
      runs.cancelConnection("c1");
      await done;
      assert.equal(sent.length, 1);
      const [method, , error] = calls.at(-1) as [string, string, unknown];
      assert.equal(method, "runFailed");
      assert.ok(error instanceof RunNotConfirmedError);
      assert.deepEqual(runs.running(), []);
    });

    it("resends once when the run is not cancelled while the question is open", async () => {
      const { service, runs, sent, pending, calls, answerConfirm } = setup();
      const offered = offer();
      const question = deferred<Confirmed>();
      answerConfirm(() => question.promise);
      const done = service.execute(runs.prepare(UNTITLED, "c1"), request());
      await settle();
      pending[0].reject(required(offered));
      await settle();
      assert.equal(sent.length, 1);
      question.resolve({ token: offered.token });
      await settle();
      assert.equal(sent.length, 2);
      assert.deepEqual(sent[1][0].confirmation, { token: offered.token });
      pending[1].resolve(PAGE);
      await done;
      assert.deepEqual(calls.at(-1), ["runSucceeded", "q1", PAGE]);
    });

    it("a page read asks with the read's connection name and resends once, and rejects as not confirmed when declined", async () => {
      const name = crypto.randomUUID();
      const read = {
        documentUri: UNTITLED,
        connectionId: "c1",
        connectionName: name,
        statement: STATEMENT,
        limit: 2,
        offset: 2,
      };
      const { service, runs, sent, pending, asks, answerConfirm } = setup();
      const offered = offer({ type: "connection-name", expected: name, targets: [] });
      answerConfirm(() => ({ token: offered.token, typed: name }));
      const page = service.runPage(read);
      await settle();
      pending[0].reject(required(offered));
      await settle();
      assert.deepEqual(asks, [{ connectionName: name, statement: STATEMENT, offer: offered }]);
      assert.deepEqual(sent[1][0], { ...sent[0][0], confirmation: { token: offered.token, typed: name } });
      pending[1].resolve(PAGE);
      assert.equal(await page, PAGE);

      answerConfirm(() => undefined);
      const declined = service.runPage(read);
      await settle();
      pending[2].reject(required(offer()));
      await assert.rejects(declined, RunNotConfirmedError);
      assert.deepEqual(runs.running(), []);
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
    const READ = {
      documentUri: UNTITLED,
      connectionId: "c1",
      connectionName: "shop",
      statement: STATEMENT,
      limit: 2,
      offset: 2,
    };

    it("registers the read as a run of its document, sends it at its offset and answers the page", async () => {
      const { service, runs, sent, pending } = setup({ c1: cancellable(true) });
      const read = service.runPage(READ);
      await settle();
      assert.deepEqual(runs.running(), [UNTITLED]);
      assert.deepEqual(runs.cancellable(), [UNTITLED]);
      assert.deepEqual(sent[0][0], {
        connectionId: "c1",
        queryId: "q1",
        statement: STATEMENT,
        limit: 2,
        offset: 2,
        confirmation: "ask",
      });
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
