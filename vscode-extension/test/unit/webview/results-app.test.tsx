import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Clock, install } from "@sinonjs/fake-timers";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { QueryPage } from "../../../src/protocol";
import type { GridContext, HostToWebview, RunFailure } from "../../../src/results-protocol";
import { connectHost } from "../../../src/webview/host-channel";
import {
  backendStoppedSentence,
  CANCELLED_SENTENCE,
  CANCELLED_TITLE,
  COPY_FAILED_SENTENCE,
  DISPLAY_FAILED_TITLE,
  EMPTY_SENTENCE,
  PAGE_FAILED_TITLE,
  RUN_FAILED_TITLE,
} from "../../../src/webview/notices";
import { createResultsStore, type ResultsStore, type VsCodeApi } from "../../../src/webview/results-store";
import { useDom } from "../../setup/dom";

const A = "6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4";
const B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const pagination = (totalReturned: number, hasMore: boolean) => ({
  limit: 2,
  offset: 0,
  hasMore,
  totalReturned,
  wasLimited: false,
});

const page = (rows: Record<string, unknown>[], extra: Partial<QueryPage> = {}): QueryPage => ({
  rows,
  fields: rows.length > 0 ? Object.keys(rows[0]) : [],
  rowCount: rows.length,
  executionTime: 4,
  pagination: pagination(rows.length, false),
  ...extra,
});

const grid = (changes: Partial<GridContext> = {}): GridContext => ({
  databaseType: "postgres",
  supportsResultPagination: true,
  commitKeyword: "COMMIT",
  ...changes,
});

const started = (runId = A, statement = "select n\nfrom t"): HostToWebview => ({
  v: 1,
  type: "runStarted",
  runId,
  statement,
  startedAt: 10_000,
});
const succeeded = (runId: string, p: QueryPage, g = grid()): HostToWebview => ({
  v: 1,
  type: "runSucceeded",
  runId,
  page: p,
  grid: g,
});
const failed = (failure: RunFailure, runId = A): HostToWebview => ({ v: 1, type: "runFailed", runId, failure });

const twoRows = [{ n: 1 }, { n: 2 }];

// Radix's useLayoutEffect is chosen once, at module load, by whether a document exists then; loaded before useDom
// registers one, it is a no-op, and no portal (the context menu, the row detail sheet) ever mounts. So the app and
// the grid behind it are imported once the DOM is registered, and every test file reaches them the same way.
let ResultsApp: typeof import("../../../src/webview/results-app").ResultsApp;
let GridErrorBoundary: typeof import("../../../src/webview/results-app").GridErrorBoundary;

describe("the results app", () => {
  useDom();
  before(async function () {
    // The first load transpiles the grid's whole graph, which takes seconds on a loaded machine.
    this.timeout(30_000);
    ({ ResultsApp, GridErrorBoundary } = await import("../../../src/webview/results-app"));
    const radix = await import("@radix-ui/react-use-layout-effect");
    const react = await import("react");
    assert.equal(
      radix.useLayoutEffect,
      react.useLayoutEffect,
      "A test file loaded a Radix module before useDom registered a document: import it after useDom, as this file does.",
    );
  });

  let posted: unknown[];
  let saved: unknown[];
  let stored: unknown;
  let clock: Clock | undefined;
  const api: VsCodeApi = {
    postMessage: (message) => posted.push(message),
    getState: () => stored,
    setState: (state) => {
      saved.push(state);
      stored = state;
    },
  };

  // The virtualizer reads the scroll element's size, which happy-dom lays out as 0 by 0: @tanstack/virtual-core reads
  // clientWidth and clientHeight since 3.19.6, and offsetWidth and offsetHeight before it.
  const sizes: [string, PropertyDescriptor | undefined][] = [];
  beforeEach(() => {
    for (const [name, value] of [
      ["offsetHeight", 600],
      ["offsetWidth", 1000],
      ["clientHeight", 600],
      ["clientWidth", 1000],
    ] as const) {
      sizes.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    }
  });
  afterEach(() => {
    for (const [name, descriptor] of sizes.splice(0)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  beforeEach(() => {
    posted = [];
    saved = [];
    stored = undefined;
  });

  afterEach(() => {
    cleanup();
    clock?.uninstall();
    clock = undefined;
    connectHost(undefined);
    document.documentElement.className = "";
    delete document.documentElement.dataset.libredbContrast;
    // setState never holds a row, a statement or a message.
    for (const state of saved) assert.deepEqual(Object.keys(state as object).sort(), ["maskingEnabled", "scroll", "v"]);
  });

  const mount = (): ResultsStore => {
    const store = createResultsStore(api, document.documentElement);
    render(<ResultsApp store={store} />);
    return store;
  };
  const receive = (store: ResultsStore, ...messages: HostToWebview[]) =>
    act(() => {
      for (const message of messages) store.receive(message);
    });
  const flush = () => act(async () => {});
  // screen binds to the document at import, before useDom registers one, so queries go through within(document.body).
  const page_ = () => within(document.body);
  const desktopGrid = () => document.querySelector<HTMLElement>("[data-desktop-grid]")!;

  it("shows the empty sentence before any run", () => {
    mount();
    page_().getByText(EMPTY_SENTENCE);
  });

  it("shows the running statement's first line and the whole seconds since it started", () => {
    clock = install({ now: 10_000 + 3_200, toFake: ["Date", "setInterval", "clearInterval"] });
    const store = mount();
    receive(store, started());
    assert.match(page_().getByRole("status").textContent ?? "", /^Running query\.\.\. 3s/);
    page_().getByText("select n");
    assert.equal(page_().queryByText(/from t/), null);
    act(() => {
      clock!.tick(1_000);
    });
    assert.match(page_().getByRole("status").textContent ?? "", /^Running query\.\.\. 4s/);
  });

  it("offers Load More, posts loadMore, disables it while a page loads and appends the page", () => {
    const store = mount();
    receive(store, started(), succeeded(A, page(twoRows, { pagination: pagination(2, true) })));
    page_().getByText(/^2 rows/);
    const more = page_().getByRole("button", { name: /load 2 more/ });
    fireEvent.click(more);
    assert.deepEqual(posted.at(-1), { v: 1, type: "loadMore", runId: A });
    receive(store, { v: 1, type: "pageStarted", runId: A });
    assert.equal((page_().getByRole("button", { name: /load 2 more|loading/i }) as HTMLButtonElement).disabled, true);
    receive(store, {
      v: 1,
      type: "pageAppended",
      runId: A,
      page: page([{ n: 3 }, { n: 4 }], { pagination: { ...pagination(2, false), offset: 2 } }),
    });
    page_().getByText(/^4 rows/);
    assert.equal(page_().queryByText(/load \d+ more/), null);
  });

  it("offers no Load More when the provider declares no result pagination", () => {
    const store = mount();
    receive(
      store,
      started(),
      succeeded(A, page(twoRows, { pagination: pagination(2, true) }), grid({ supportsResultPagination: false })),
    );
    page_().getByText(/^2 rows/);
    assert.equal(page_().queryByText(/load 2 more/), null);
  });

  it("shows the grid's empty states and the notice lines", () => {
    const store = mount();
    receive(store, started(), succeeded(A, page([], { rowCount: 3 })));
    page_().getByText("3 rows affected");
    receive(store, started(B), succeeded(B, page([], { rowCount: 0 })));
    page_().getByText("Query returned no data");
    receive(store, started(A), succeeded(A, page(twoRows, { openTransaction: "rolled-back" })));
    page_().getByText(/Add COMMIT to keep them\.$/);
    receive(store, started(B), succeeded(B, page(twoRows, { resultSetCount: 2 })));
    page_().getByText("This text produced 2 result sets; the first is shown.");
  });

  it("shows a MongoDB page as the web app does: hex ids, one-line nested JSON, an indented row detail", async () => {
    const id = "65f1c0ffee0000000000abcd";
    const store = mount();
    receive(
      store,
      started(A, "db.people.find({})"),
      succeeded(
        A,
        page(
          [
            { _id: id, name: "Ada", address: { city: "Izmir", zip: "35000" }, tags: ["a"] },
            { _id: "65f1c0ffee0000000000abce", name: "Lin", address: { city: "Ankara", zip: "06000" } },
          ],
          { fields: ["_id", "name", "address", "tags"] },
        ),
        grid({ databaseType: "mongodb", supportsResultPagination: false }),
      ),
    );
    const table = desktopGrid();
    for (const field of ["_id", "name", "address", "tags"]) {
      assert.ok(
        within(table)
          .getAllByRole("columnheader")
          .some((h) => h.textContent?.includes(field)),
        field,
      );
    }
    within(table).getByText(id);
    within(table).getByText('{"city":"Izmir","zip":"35000"}');
    fireEvent.click(within(table).getByRole("button", { name: "Show row 1 field by field" }));
    await flush();
    const dialog = page_().getByRole("dialog");
    assert.ok(
      [...dialog.querySelectorAll("*")].some(
        (node) => node.textContent === JSON.stringify({ city: "Izmir", zip: "35000" }, null, 2),
      ),
      "the address is printed indented over several lines",
    );
  });

  it("shows each run failure", async () => {
    const store = mount();
    receive(
      store,
      started(),
      failed({
        kind: "error",
        message: 'relation "nope" does not exist',
        detail: "LINE 1: select * from nope",
        fixStatement: "CREATE TABLE nope ();",
      }),
    );
    page_().getByText(RUN_FAILED_TITLE);
    page_().getByText('relation "nope" does not exist');
    page_().getByText("LINE 1: select * from nope");
    page_().getByText("CREATE TABLE nope ();");
    fireEvent.click(page_().getByRole("button", { name: "Copy" }));
    assert.deepEqual(posted.at(-1), {
      v: 1,
      type: "copy",
      requestId: (posted.at(-1) as { requestId: number }).requestId,
      text: "CREATE TABLE nope ();",
    });
    receive(store, { v: 1, type: "copied", requestId: (posted.at(-1) as { requestId: number }).requestId, ok: false });
    await flush();
    assert.deepEqual(posted.at(-1), { v: 1, type: "notify", level: "error", message: COPY_FAILED_SENTENCE });

    receive(store, started(B), failed({ kind: "cancelled" }, B));
    page_().getByText(CANCELLED_TITLE);
    page_().getByText(CANCELLED_SENTENCE);

    receive(store, started(A), failed({ kind: "backendExited", exitCode: null, signal: "SIGKILL" }));
    page_().getByText(backendStoppedSentence(null, "SIGKILL"));

    receive(store, started(B), failed({ kind: "error", message: "syntax error" }, B));
    page_().getByText("syntax error");
    assert.equal(page_().queryByRole("button", { name: "Copy" }), null);
  });

  it("keeps the rows when a page fails and shows the page failure above them", () => {
    const store = mount();
    receive(store, started(), succeeded(A, page(twoRows, { pagination: pagination(2, true) })));
    receive(store, { v: 1, type: "pageFailed", runId: A, failure: { kind: "error", message: "connection reset" } });
    page_().getByText(PAGE_FAILED_TITLE);
    page_().getByText("connection reset");
    page_().getByText(/^2 rows/);
  });

  it("passes no editingEnabled: a double-click opens no editor, and the row detail column is there", () => {
    const store = mount();
    receive(store, started(), succeeded(A, page(twoRows)));
    const table = desktopGrid();
    // The value's own text, so the double-click bubbles through the element the grid would open its editor from.
    fireEvent.doubleClick(within(within(table).getAllByRole("gridcell")[0]).getByText("1"));
    assert.equal(table.querySelector("input, textarea"), null);
    within(table).getByRole("button", { name: "Show row 1 field by field" });
  });

  it("copies through the host from the cell menu and reports the grid's toast as notify", async () => {
    const store = mount();
    receive(store, started(), succeeded(A, page([{ n: 1, name: "Ada" }])));
    const cell = within(desktopGrid())
      .getAllByRole("gridcell")
      .find((c) => c.textContent === "Ada")!;
    fireEvent.contextMenu(cell);
    await flush();
    fireEvent.click(page_().getByRole("menuitem", { name: "Copy Cell" }));
    const copy = posted.at(-1) as { type: string; requestId: number; text: string };
    assert.deepEqual(copy, { v: 1, type: "copy", requestId: copy.requestId, text: "Ada" });
    receive(store, { v: 1, type: "copied", requestId: copy.requestId, ok: true });
    await flush();
    assert.deepEqual(posted.at(-1), { v: 1, type: "notify", level: "info", message: "Cell copied to clipboard" });

    fireEvent.contextMenu(cell);
    await flush();
    fireEvent.click(page_().getByRole("menuitem", { name: "Copy Row as JSON" }));
    const row = posted.at(-1) as { type: string; text: string };
    assert.equal(row.type, "copy");
    assert.deepEqual(JSON.parse(row.text), { n: 1, name: "Ada" });
  });

  it("masks through the grid's switch, reveals a cell, and keeps the switch across a rebuild", async () => {
    const store = mount();
    receive(store, started(), succeeded(A, page([{ n: 1, email: "ada@example.com" }])));
    within(desktopGrid()).getByText("ada@example.com");
    fireEvent.click(page_().getByTitle("Mask sensitive data"));
    assert.equal(within(desktopGrid()).queryByText("ada@example.com"), null);
    assert.deepEqual(saved.at(-1), { v: 1, maskingEnabled: true, scroll: null });
    fireEvent.click(within(desktopGrid()).getByTitle("Reveal value (10s)"));
    within(desktopGrid()).getByText("ada@example.com");

    cleanup();
    connectHost(undefined);
    const rebuilt = mount();
    receive(rebuilt, started(), succeeded(A, page([{ n: 1, email: "ada@example.com" }])));
    page_().getByTitle("Show sensitive data");
    assert.equal(within(desktopGrid()).queryByText("ada@example.com"), null);
  });

  it("saves the desktop grid's scroll 200 ms after the last scroll and restores it for the same run only", () => {
    clock = install({ toFake: ["setTimeout", "clearTimeout"] });
    const rows = Array.from({ length: 40 }, (_, n) => ({ n }));
    const store = mount();
    receive(store, started(), succeeded(A, page(rows)));
    const element = desktopGrid();
    element.scrollTop = 120;
    fireEvent.scroll(element);
    act(() => {
      clock!.tick(199);
    });
    assert.deepEqual(saved, []);
    act(() => {
      clock!.tick(1);
    });
    assert.deepEqual(saved, [{ v: 1, maskingEnabled: false, scroll: { runId: A, top: 120, left: 0 } }]);

    cleanup();
    connectHost(undefined);
    const replayA = mount();
    receive(replayA, started(), succeeded(A, page(rows)));
    assert.equal(desktopGrid().scrollTop, 120);

    cleanup();
    connectHost(undefined);
    const replayB = mount();
    receive(replayB, started(B), succeeded(B, page(rows)));
    assert.equal(desktopGrid().scrollTop, 0);
  });

  it("retries the restore as a replay's pages arrive, until the grid reaches the saved position or the person acts", () => {
    // happy-dom has no layout, so scrollTop is clamped here as a grid holding only its first page clamps it.
    let scrollMax = 300;
    const tops = new WeakMap<object, number>();
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return tops.get(this) ?? 0;
      },
      set(value: number) {
        tops.set(this, Math.min(value, scrollMax));
      },
    });
    const rows = Array.from({ length: 40 }, (_, n) => ({ n }));
    const firstPage = page(rows, { pagination: pagination(40, true) });
    const appended: HostToWebview[] = [
      { v: 1, type: "pageStarted", runId: A },
      { v: 1, type: "pageAppended", runId: A, page: page(rows) },
    ];
    try {
      stored = { v: 1, maskingEnabled: false, scroll: { runId: A, top: 500, left: 0 } };
      const store = mount();
      receive(store, started(), succeeded(A, firstPage));
      assert.equal(desktopGrid().scrollTop, 300);
      scrollMax = 1000;
      receive(store, ...appended);
      assert.equal(desktopGrid().scrollTop, 500);
      // Reached, so a later page leaves the grid where the person put it.
      desktopGrid().scrollTop = 50;
      receive(store, ...appended);
      assert.equal(desktopGrid().scrollTop, 50);

      cleanup();
      connectHost(undefined);
      scrollMax = 300;
      const rebuilt = mount();
      receive(rebuilt, started(), succeeded(A, firstPage));
      assert.equal(desktopGrid().scrollTop, 300);
      // The person scrolls before the saved position can be reached: their scroll wins.
      fireEvent.wheel(desktopGrid());
      desktopGrid().scrollTop = 20;
      scrollMax = 1000;
      receive(rebuilt, ...appended);
      assert.equal(desktopGrid().scrollTop, 20);
    } finally {
      if (own) Object.defineProperty(HTMLElement.prototype, "scrollTop", own);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop;
    }
  });

  it("puts the theme kind on <html>", () => {
    const store = mount();
    receive(store, { v: 1, type: "init", theme: "highContrast" });
    assert.equal(document.documentElement.classList.contains("dark"), true);
    assert.equal(document.documentElement.dataset.libredbContrast, "high");
  });

  it("shows a render failure and reports it to the host", () => {
    connectHost((message) => posted.push(message));
    const Boom = (): never => {
      throw new Error("boom");
    };
    // React reports a caught error on the console as well; silenced for this case only.
    const consoleError = console.error;
    console.error = () => {};
    try {
      render(
        <GridErrorBoundary>
          <Boom />
        </GridErrorBoundary>,
      );
    } finally {
      console.error = consoleError;
    }
    page_().getByText(DISPLAY_FAILED_TITLE);
    page_().getByText("boom");
    assert.deepEqual(posted, [{ v: 1, type: "reportError", message: "boom" }]);
  });

  it("never renders markup from a string: no dangerouslySetInnerHTML under src/webview", () => {
    const dir = join(__dirname, "..", "..", "..", "src", "webview");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f));
    assert.ok(files.includes("results-app.tsx"));
    for (const file of files) {
      assert.equal(readFileSync(join(dir, file), "utf8").includes("dangerouslySetInnerHTML"), false, file);
    }
  });
});
