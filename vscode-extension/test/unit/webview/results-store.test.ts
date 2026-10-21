import assert from "node:assert/strict";
import { type HostToWebview, INITIAL_VIEW_STATE, type ResultsViewState } from "../../../src/results-protocol";
import { requestCopy } from "../../../src/webview/clipboard";
import { connectHost } from "../../../src/webview/host-channel";
import { createResultsStore, type VsCodeApi } from "../../../src/webview/results-store";
import { useDom } from "../../setup/dom";

const A = "6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4";
const B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const started = (runId = A): HostToWebview => ({
  v: 1,
  type: "runStarted",
  runId,
  statement: "select 1",
  startedAt: 5,
});
const succeeded = (runId = A): HostToWebview => ({
  v: 1,
  type: "runSucceeded",
  runId,
  page: {
    rows: [{ n: 1 }],
    fields: ["n"],
    rowCount: 1,
    executionTime: 2,
    pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 1, wasLimited: false },
  },
  grid: { databaseType: "postgres", supportsResultPagination: true, commitKeyword: "COMMIT" },
});

describe("the results store", () => {
  useDom();

  let posted: unknown[];
  let saved: unknown[];
  let stored: unknown;
  let getStateCalls: number;
  const api: VsCodeApi = {
    postMessage: (message) => posted.push(message),
    getState: () => {
      getStateCalls++;
      return stored;
    },
    setState: (state) => saved.push(state),
  };

  beforeEach(() => {
    posted = [];
    saved = [];
    stored = undefined;
    getStateCalls = 0;
  });

  afterEach(() => {
    connectHost(undefined);
    document.documentElement.className = "";
  });

  const create = () => createResultsStore(api, document.documentElement);

  it("posts nothing at creation and reads the saved state once", () => {
    const store = create();
    assert.deepEqual(posted, []);
    assert.equal(getStateCalls, 1);
    assert.equal(store.viewState(), INITIAL_VIEW_STATE);
    store.viewState();
    assert.equal(getStateCalls, 1);
  });

  it("starts from a valid saved state", () => {
    stored = { v: 1, maskingEnabled: true, scroll: { runId: A, top: 40, left: 8 } };
    assert.deepEqual(create().viewState(), stored);
  });

  it("reports a saved state it cannot read and starts from the initial one", () => {
    stored = { v: 1, maskingEnabled: "yes", scroll: null };
    const store = create();
    assert.deepEqual(posted, [
      { v: 1, type: "reportError", message: "Ignored the saved view state: maskingEnabled: expected a boolean" },
    ]);
    assert.equal(store.viewState(), INITIAL_VIEW_STATE);
  });

  it("throws on anything but a guard's refusal, from the saved state or a message", () => {
    const broken = new Error("getState broke");
    assert.throws(
      () =>
        createResultsStore(
          {
            ...api,
            getState: () => {
              throw broken;
            },
          },
          document.documentElement,
        ),
      broken,
    );
    const store = create();
    const hostile = {
      get v(): number {
        throw new Error("a getter threw");
      },
    };
    assert.throws(() => store.receive(hostile), { message: "a getter threw" });
    assert.deepEqual(posted, []);
  });

  it("keeps messages that arrive before any subscriber", () => {
    const store = create();
    store.receive(started());
    store.receive(succeeded());
    let calls = 0;
    store.subscribe(() => calls++);
    assert.equal(store.getSnapshot().view.kind, "rows");
    assert.equal(calls, 0);
  });

  it("reports a refused host message and changes nothing", () => {
    const store = create();
    const before = store.getSnapshot();
    let calls = 0;
    store.subscribe(() => calls++);
    store.receive({ v: 1, type: "clear", extra: 1 });
    assert.deepEqual(posted, [
      { v: 1, type: "reportError", message: "Refused a host message: extra: not a field of clear" },
    ]);
    assert.equal(store.getSnapshot(), before);
    assert.equal(calls, 0);
  });

  it("cuts a refusal's report to the length the host accepts", () => {
    const store = create();
    store.receive({ v: 1, type: "x".repeat(20_000) });
    assert.equal(posted.length, 1);
    const report = posted[0] as { type: string; message: string };
    assert.equal(report.type, "reportError");
    assert.equal(report.message.length, 10_000);
    assert.ok(report.message.startsWith("Refused a host message: type: unknown message type xxx"));
  });

  it("runs a listener once per state change, not for a dropped run message, and stops on unsubscribe", () => {
    const store = create();
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    store.receive(started());
    assert.equal(calls, 1);
    store.receive(succeeded(B));
    assert.equal(calls, 1);
    store.receive(succeeded());
    assert.equal(calls, 2);
    unsubscribe();
    store.receive({ v: 1, type: "clear" });
    assert.equal(calls, 2);
    assert.equal(store.getSnapshot().view.kind, "empty");
  });

  it("puts the theme on <html>: dark on init, removed by a light theme", () => {
    const store = create();
    store.receive({ v: 1, type: "init", theme: "dark" });
    assert.equal(document.documentElement.classList.contains("dark"), true);
    assert.equal(store.getSnapshot().theme, "dark");
    store.receive({ v: 1, type: "theme", theme: "light" });
    assert.equal(document.documentElement.classList.contains("dark"), false);
  });

  it("does not touch <html> for a message that leaves the theme as it is", () => {
    const store = create();
    store.receive({ v: 1, type: "init", theme: "dark" });
    document.documentElement.classList.remove("dark");
    store.receive(started());
    assert.equal(document.documentElement.classList.contains("dark"), false);
  });

  it("settles a pending copy on copied and leaves the state", async () => {
    const store = create();
    const before = store.getSnapshot();
    const copied = requestCopy("a");
    const request = posted[0] as { type: string; requestId: number };
    assert.equal(request.type, "copy");
    store.receive({ v: 1, type: "copied", requestId: request.requestId, ok: true });
    assert.equal(await copied, true);
    assert.equal(store.getSnapshot(), before);
  });

  it("posts as is, and saves only the three fields of the view state", () => {
    const store = create();
    store.post({ v: 1, type: "loadMore", runId: A });
    assert.deepEqual(posted, [{ v: 1, type: "loadMore", runId: A }]);

    const next = {
      v: 1,
      maskingEnabled: true,
      scroll: { runId: A, top: 1, left: 2, rows: [{ n: 1 }] },
      rows: [{ n: 1 }],
    } as unknown as ResultsViewState;
    store.setViewState(next);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0], { v: 1, maskingEnabled: true, scroll: { runId: A, top: 1, left: 2 } });
    assert.deepEqual(Object.keys(saved[0] as object), ["v", "maskingEnabled", "scroll"]);
    assert.deepEqual(store.viewState(), saved[0]);

    store.setViewState({ v: 1, maskingEnabled: false, scroll: null });
    assert.deepEqual(saved[1], { v: 1, maskingEnabled: false, scroll: null });
  });
});
