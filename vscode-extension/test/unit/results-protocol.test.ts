import assert from "node:assert/strict";
import {
  type HostToWebview,
  INITIAL_VIEW_STATE,
  parseHostMessage,
  parseViewState,
  parseWebviewMessage,
  RESULTS_LIMITS,
  RESULTS_PROTOCOL_VERSION,
  ResultsProtocolError,
  type WebviewToHost,
} from "../../src/results-protocol";

const RUN = "6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4";

const page = () => ({
  rows: [{ n: 1 }],
  fields: ["n"],
  rowCount: 1,
  executionTime: 3,
  pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 1, wasLimited: false },
});

const grid = () => ({ databaseType: "postgres" as const, supportsResultPagination: true, commitKeyword: "COMMIT" });

const fullPage = () => ({
  ...page(),
  warnings: [
    { message: "a notice", code: "01000", severity: "NOTICE" },
    { message: "two", code: 7 },
  ],
  columnTypes: { n: "int4" },
  vectorColumns: { n: { kind: "dense" as const, dtype: "float32" as const, dimension: 3 } },
  rolledBack: false,
  openTransaction: "rolled-back" as const,
  resultSetCount: 2,
});

const HOST_EXAMPLES: HostToWebview[] = [
  { v: 1, type: "init", theme: "dark" },
  { v: 1, type: "theme", theme: "highContrastLight" },
  { v: 1, type: "clear" },
  { v: 1, type: "runStarted", runId: RUN, statement: "select n from t", startedAt: 1_700_000_000_000 },
  { v: 1, type: "runSucceeded", runId: RUN, page: page(), grid: grid() },
  {
    v: 1,
    type: "runSucceeded",
    runId: RUN,
    page: fullPage(),
    grid: { ...grid(), maskingExemptColumns: { column: "_id", reason: "the document key" } },
  },
  { v: 1, type: "runFailed", runId: RUN, failure: { kind: "error", message: "boom", detail: "d", fixStatement: "f" } },
  { v: 1, type: "runFailed", runId: RUN, failure: { kind: "error", message: "boom" } },
  { v: 1, type: "runFailed", runId: RUN, failure: { kind: "cancelled" } },
  { v: 1, type: "runFailed", runId: RUN, failure: { kind: "backendExited", exitCode: null, signal: "SIGKILL" } },
  { v: 1, type: "runFailed", runId: RUN, failure: { kind: "backendExited", exitCode: 1, signal: null } },
  { v: 1, type: "pageStarted", runId: RUN },
  { v: 1, type: "pageAppended", runId: RUN, page: page() },
  { v: 1, type: "pageFailed", runId: RUN, failure: { kind: "cancelled" } },
  { v: 1, type: "copied", requestId: 0, ok: true },
];

const WEBVIEW_EXAMPLES: WebviewToHost[] = [
  { v: 1, type: "ready" },
  { v: 1, type: "loadMore", runId: RUN },
  { v: 1, type: "copy", requestId: 3, text: "a\tb" },
  { v: 1, type: "notify", level: "error", message: "Could not copy cell" },
  { v: 1, type: "reportError", message: "" },
];

const refused = (fn: () => unknown, field: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ResultsProtocolError, String(e));
    assert.equal(e.field, field, e.message);
    return true;
  });

type Json = Record<string, unknown>;

/** A copy of `message` with the dotted `path` set to `value`, or removed when `value` is the REMOVE marker. */
const REMOVE = Symbol("remove");
function at(message: Json, path: string, value: unknown): Json {
  const copy = JSON.parse(JSON.stringify(message)) as Json;
  const keys = path.split(".");
  const last = keys.pop() as string;
  let node = copy;
  for (const key of keys) node = node[key] as Json;
  if (value === REMOVE) delete node[last];
  else node[last] = value;
  return copy;
}

const succeeded = (): Json => ({ v: 1, type: "runSucceeded", runId: RUN, page: page(), grid: grid() });
const failedWith = (failure: Json): Json => ({ v: 1, type: "runFailed", runId: RUN, failure });

describe("the results protocol", () => {
  it("is version 1", () => assert.equal(RESULTS_PROTOCOL_VERSION, 1));

  it("bounds copy text to 16 MiB, a notice to 1,000 characters and a reported error to 10,000", () => {
    assert.deepEqual(RESULTS_LIMITS, { copyTextChars: 16 * 1024 * 1024, notifyChars: 1_000, reportErrorChars: 10_000 });
  });

  it("parses every host message, and each survives JSON", () => {
    for (const message of HOST_EXAMPLES) {
      assert.deepEqual(parseHostMessage(JSON.parse(JSON.stringify(message))), message);
    }
  });

  it("parses every webview message, and each survives JSON", () => {
    for (const message of WEBVIEW_EXAMPLES) {
      assert.deepEqual(parseWebviewMessage(JSON.parse(JSON.stringify(message))), message);
    }
  });

  it("refuses a message of another version whatever its type", () => {
    refused(() => parseHostMessage({ v: 2, type: "clear" }), "v");
    refused(() => parseWebviewMessage({ v: 0, type: "nope" }), "v");
    refused(() => parseHostMessage({ type: "clear" }), "v");
    refused(() => parseHostMessage({ v: "1", type: "clear" }), "v");
  });

  it("refuses an unknown type, a non-object and an array", () => {
    refused(() => parseHostMessage({ v: 1, type: "snapshot" }), "type");
    refused(() => parseHostMessage({ v: 1 }), "type");
    refused(() => parseWebviewMessage({ v: 1, type: "clear" }), "type");
    refused(() => parseHostMessage({ v: 1, type: "toString" }), "type");
    refused(() => parseWebviewMessage("ready"), "$");
    refused(() => parseHostMessage([]), "$");
    refused(() => parseHostMessage(null), "$");
    refused(() => parseHostMessage(new Date()), "$");
  });

  it("names the field and the reason in the error's message", () => {
    try {
      parseHostMessage({ v: 1, type: "clear", extra: 1 });
      assert.fail("expected a refusal");
    } catch (error) {
      assert.ok(error instanceof ResultsProtocolError);
      assert.equal(error.message, "extra: not a field of clear");
      assert.equal(error.field, "extra");
      assert.equal(error.name, "ResultsProtocolError");
    }
    assert.throws(() => parseHostMessage({ v: 1, type: "snapshot" }), {
      message: "type: unknown message type snapshot",
    });
    assert.throws(() => parseHostMessage({ v: 1, type: 7 }), { message: "type: unknown message type 7" });
    assert.throws(() => parseHostMessage({ v: 2 }), { message: "v: expected 1" });
    assert.throws(() => parseHostMessage([]), { message: "$: expected an object" });
    assert.throws(() => parseHostMessage({ v: 1, type: "pageStarted" }), { message: "runId: missing" });
  });

  it("never lets the webview name what the host runs (trust rule 1)", () => {
    for (const key of ["statement", "connectionId", "queryId", "catalog", "limit", "offset", "path"]) {
      refused(() => parseWebviewMessage({ v: 1, type: "loadMore", runId: RUN, [key]: "x" }), key);
    }
    refused(() => parseWebviewMessage({ v: 1, type: "ready", statement: "drop table t" }), "statement");
  });

  it("refuses an extra key on every message type, both ways", () => {
    for (const message of HOST_EXAMPLES) refused(() => parseHostMessage({ ...message, extra: 1 }), "extra");
    for (const message of WEBVIEW_EXAMPLES) refused(() => parseWebviewMessage({ ...message, extra: 1 }), "extra");
  });

  it("bounds what the webview sends (trust rule 4)", () => {
    refused(
      () =>
        parseWebviewMessage({ v: 1, type: "copy", requestId: 1, text: "x".repeat(RESULTS_LIMITS.copyTextChars + 1) }),
      "text",
    );
    refused(() => parseWebviewMessage({ v: 1, type: "notify", level: "info", message: "x".repeat(1_001) }), "message");
    refused(() => parseWebviewMessage({ v: 1, type: "notify", level: "info", message: "" }), "message");
    refused(() => parseWebviewMessage({ v: 1, type: "reportError", message: "x".repeat(10_001) }), "message");
    assert.equal(
      parseWebviewMessage({ v: 1, type: "notify", level: "info", message: "x".repeat(1_000) }).type,
      "notify",
    );
    assert.equal(
      parseWebviewMessage({ v: 1, type: "copy", requestId: 1, text: "x".repeat(RESULTS_LIMITS.copyTextChars) }).type,
      "copy",
    );
    assert.throws(() => parseWebviewMessage({ v: 1, type: "reportError", message: "x".repeat(10_001) }), {
      message: "message: longer than 10000 characters",
    });
  });

  it("takes a 10 MB cell in a page: pages carry no size bound", () => {
    const big = { ...page(), rows: [{ n: "x".repeat(10 * 1024 * 1024) }] };
    assert.equal(parseHostMessage({ v: 1, type: "pageAppended", runId: RUN, page: big }).type, "pageAppended");
  });

  it("keeps a page key the protocol does not name", () => {
    const message = { v: 1, type: "pageAppended", runId: RUN, page: { ...page(), inTransaction: true } };
    assert.deepEqual(parseHostMessage(message), message);
  });

  // One case per field: the message it starts from, the dotted path, a wrong value, and whether it may be absent.
  const host: { field: string; base: () => Json; bad: unknown[]; optional?: boolean }[] = [
    {
      field: "runId",
      base: () => ({ v: 1, type: "pageStarted", runId: RUN }),
      bad: ["1", RUN.toUpperCase(), 1],
    },
    {
      field: "statement",
      base: () => ({ v: 1, type: "runStarted", runId: RUN, statement: "s", startedAt: 0 }),
      bad: [1],
    },
    {
      field: "startedAt",
      base: () => ({ v: 1, type: "runStarted", runId: RUN, statement: "s", startedAt: 0 }),
      bad: ["0", Number.POSITIVE_INFINITY],
    },
    { field: "theme", base: () => ({ v: 1, type: "init", theme: "dark" }), bad: ["sepia", 1] },
    { field: "theme", base: () => ({ v: 1, type: "theme", theme: "light" }), bad: ["sepia"] },
    { field: "requestId", base: () => ({ v: 1, type: "copied", requestId: 0, ok: true }), bad: [-1, 1.5, "1"] },
    { field: "ok", base: () => ({ v: 1, type: "copied", requestId: 0, ok: true }), bad: ["true"] },
    { field: "page", base: succeeded, bad: [[], null, "page"] },
    { field: "page.rows", base: succeeded, bad: [{}] },
    { field: "page.fields", base: succeeded, bad: ["n"] },
    { field: "page.rowCount", base: succeeded, bad: ["1"] },
    { field: "page.executionTime", base: succeeded, bad: [null] },
    { field: "page.pagination", base: succeeded, bad: [[], "p"] },
    { field: "page.pagination.limit", base: succeeded, bad: [-1, 1.5] },
    { field: "page.pagination.offset", base: succeeded, bad: [0.5, -1] },
    { field: "page.pagination.hasMore", base: succeeded, bad: ["true"] },
    { field: "page.pagination.wasLimited", base: succeeded, bad: [0] },
    { field: "page.pagination.totalReturned", base: succeeded, bad: ["1"] },
    { field: "page.warnings", base: succeeded, bad: [{}], optional: true },
    { field: "page.columnTypes", base: succeeded, bad: [[]], optional: true },
    { field: "page.vectorColumns", base: succeeded, bad: [[], "v"], optional: true },
    { field: "page.rolledBack", base: succeeded, bad: ["yes"], optional: true },
    { field: "page.openTransaction", base: succeeded, bad: ["committed"], optional: true },
    { field: "page.resultSetCount", base: succeeded, bad: [1, 2.5, "3"], optional: true },
    { field: "grid", base: succeeded, bad: [[], null] },
    { field: "grid.databaseType", base: succeeded, bad: ["", "x".repeat(65), 1] },
    { field: "grid.supportsResultPagination", base: succeeded, bad: ["true"] },
    { field: "grid.commitKeyword", base: succeeded, bad: ["", "x".repeat(33)] },
    {
      field: "grid.maskingExemptColumns",
      base: succeeded,
      bad: [[], "c"],
      optional: true,
    },
    { field: "failure", base: () => failedWith({ kind: "cancelled" }), bad: ["cancelled", []] },
    { field: "failure.kind", base: () => failedWith({ kind: "cancelled" }), bad: ["timeout", 1] },
    { field: "failure.message", base: () => failedWith({ kind: "error", message: "m" }), bad: [1] },
    { field: "failure.detail", base: () => failedWith({ kind: "error", message: "m" }), bad: [1], optional: true },
    {
      field: "failure.fixStatement",
      base: () => failedWith({ kind: "error", message: "m" }),
      bad: [1],
      optional: true,
    },
    {
      field: "failure.exitCode",
      base: () => failedWith({ kind: "backendExited", exitCode: 1, signal: null }),
      bad: ["1", 1.5],
    },
    {
      field: "failure.signal",
      base: () => failedWith({ kind: "backendExited", exitCode: 1, signal: null }),
      bad: [9],
    },
  ];

  for (const { field, base, bad, optional } of host) {
    it(`refuses ${field} ${optional ? "mistyped" : "missing or mistyped"} in ${String(base().type)}`, () => {
      if (optional) assert.doesNotThrow(() => parseHostMessage(at(base(), field, REMOVE)));
      else refused(() => parseHostMessage(at(base(), field, REMOVE)), field);
      for (const value of bad) refused(() => parseHostMessage(at(base(), field, value)), field);
    });
  }

  it("names the item that failed inside an array or a record", () => {
    refused(() => parseHostMessage(at(succeeded(), "page.rows", [1])), "page.rows.0");
    refused(() => parseHostMessage(at(succeeded(), "page.rows", [{ n: 1 }, []])), "page.rows.1");
    refused(() => parseHostMessage(at(succeeded(), "page.fields", [1])), "page.fields.0");
    refused(() => parseHostMessage(at(succeeded(), "page.warnings", [{}])), "page.warnings.0.message");
    refused(() => parseHostMessage(at(succeeded(), "page.warnings", ["w"])), "page.warnings.0");
    refused(
      () => parseHostMessage(at(succeeded(), "page.warnings", [{ message: "m", code: true }])),
      "page.warnings.0.code",
    );
    refused(
      () => parseHostMessage(at(succeeded(), "page.warnings", [{ message: "m", severity: 1 }])),
      "page.warnings.0.severity",
    );
    refused(() => parseHostMessage(at(succeeded(), "page.columnTypes", { n: 1 })), "page.columnTypes.n");
    refused(
      () => parseHostMessage(at(succeeded(), "grid.maskingExemptColumns", { column: 1 })),
      "grid.maskingExemptColumns.column",
    );
    refused(
      () => parseHostMessage(at(succeeded(), "grid.maskingExemptColumns", { column: "c", reason: 1 })),
      "grid.maskingExemptColumns.reason",
    );
    refused(
      () => parseHostMessage(at(succeeded(), "grid.maskingExemptColumns", { column: "c", reason: "r", x: 1 })),
      "grid.maskingExemptColumns.x",
    );
    refused(() => parseHostMessage(at(succeeded(), "grid.extra", 1)), "grid.extra");
  });

  it("holds each failure kind to its own keys", () => {
    refused(() => parseHostMessage(failedWith({ kind: "cancelled", message: "m" })), "failure.message");
    refused(() => parseHostMessage(failedWith({ kind: "error", message: "m", code: "X" })), "failure.code");
    refused(() => parseHostMessage(failedWith({ kind: "backendExited", exitCode: 1 })), "failure.signal");
    refused(() => parseHostMessage(failedWith({ kind: "backendExited", signal: null })), "failure.exitCode");
    refused(
      () => parseHostMessage({ v: 1, type: "pageFailed", runId: RUN, failure: { kind: "nope" } }),
      "failure.kind",
    );
  });

  const webview: { field: string; base: () => Json; bad: unknown[] }[] = [
    { field: "runId", base: () => ({ v: 1, type: "loadMore", runId: RUN }), bad: ["1", 1] },
    {
      field: "requestId",
      base: () => ({ v: 1, type: "copy", requestId: 0, text: "t" }),
      bad: [-1, 1.5, Number.MAX_SAFE_INTEGER + 1],
    },
    { field: "text", base: () => ({ v: 1, type: "copy", requestId: 0, text: "t" }), bad: [1] },
    { field: "level", base: () => ({ v: 1, type: "notify", level: "info", message: "m" }), bad: ["warn"] },
    { field: "message", base: () => ({ v: 1, type: "notify", level: "info", message: "m" }), bad: [1] },
    { field: "message", base: () => ({ v: 1, type: "reportError", message: "m" }), bad: [null] },
  ];

  for (const { field, base, bad } of webview) {
    it(`refuses ${field} missing or mistyped in the webview's ${String(base().type)}`, () => {
      refused(() => parseWebviewMessage(at(base(), field, REMOVE)), field);
      for (const value of bad) refused(() => parseWebviewMessage(at(base(), field, value)), field);
    });
  }
});

describe("the saved view state", () => {
  it("starts from the initial state when nothing was saved", () => {
    assert.deepEqual(INITIAL_VIEW_STATE, { v: 1, maskingEnabled: false, scroll: null });
    assert.equal(parseViewState(undefined), INITIAL_VIEW_STATE);
  });

  it("round-trips a saved state", () => {
    const state = { v: 1, maskingEnabled: true, scroll: { runId: RUN, top: 10.5, left: 0 } };
    assert.deepEqual(parseViewState(JSON.parse(JSON.stringify(state))), state);
    assert.deepEqual(parseViewState({ v: 1, maskingEnabled: false, scroll: null }), INITIAL_VIEW_STATE);
  });

  it("holds the saved state to its shape", () => {
    const valid = () => ({ v: 1, maskingEnabled: true, scroll: { runId: RUN, top: 10, left: 0 } });
    refused(() => parseViewState(null), "$");
    refused(() => parseViewState({ ...valid(), v: 2 }), "v");
    refused(() => parseViewState({ ...valid(), maskingEnabled: "yes" }), "maskingEnabled");
    refused(() => parseViewState({ v: 1, scroll: null }), "maskingEnabled");
    refused(() => parseViewState({ v: 1, maskingEnabled: true }), "scroll");
    refused(() => parseViewState({ ...valid(), scroll: "top" }), "scroll");
    refused(() => parseViewState({ ...valid(), scroll: { runId: RUN, top: -1, left: 0 } }), "scroll.top");
    refused(() => parseViewState({ ...valid(), scroll: { runId: RUN, top: 0, left: "0" } }), "scroll.left");
    refused(() => parseViewState({ ...valid(), scroll: { runId: "r", top: 0, left: 0 } }), "scroll.runId");
    refused(() => parseViewState({ ...valid(), scroll: { runId: RUN, top: 0, left: 0, rows: [] } }), "scroll.rows");
    refused(() => parseViewState({ ...valid(), rows: [{ n: 1 }] }), "rows");
    assert.throws(() => parseViewState({ ...valid(), maskingEnabled: "yes" }), {
      message: "maskingEnabled: expected a boolean",
    });
  });
});
