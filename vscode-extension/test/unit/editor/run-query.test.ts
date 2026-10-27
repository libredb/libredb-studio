import assert from "node:assert/strict";
import type { Container } from "@/lib/db/types";
import { BackendError } from "../../../src/host/backend-client";
import { CredentialsNotGivenError } from "../../../src/host/connections/connection-source";
import type { ProfileEntry, ProfileItem } from "../../../src/host/connections/profile";
import { BindingStore } from "../../../src/host/editor/bindings";
import { type PreparingRun, RunRegistry } from "../../../src/host/editor/run-registry";
import {
  documentLabel,
  EDITOR_NOT_VISIBLE,
  HIGHLIGHT_MS,
  NO_ACTIVE_EDITOR,
  NOTHING_TO_RUN,
  ROW_LIMIT_MAX,
  RUN_ANYWAY,
  RowLimitError,
  readRowLimit,
  runQuery,
  untilCancelled,
} from "../../../src/host/editor/run-query";
import type { RunRequest } from "../../../src/host/editor/run-service";
import type { ContainersParams, ProviderDescription, RunTargetParams, RunTargetResult } from "../../../src/protocol";
import { FakeTextDocument, FakeTextEditor } from "../../fakes/documents";
import { CATALOG_SESSIONS, ONE_LEVEL, ZERO_LEVELS } from "../../fakes/descriptions";
import { MONGO, PG } from "../../fakes/profiles";
import {
  answerMessages,
  answerQuickPicks,
  CancellationTokenSource,
  decorationTypes,
  settings,
  shownMessages,
  shownQuickPicks,
  ThemeColor,
  Uri,
  window,
  workspace,
} from "../../fakes/vscode";

const UNTITLED = "untitled:Untitled-1";
const LABELS: Record<string, string> = { postgres: "PostgreSQL", mongodb: "MongoDB" };
const SHOP: Container = { path: ["shop"], name: "shop", level: 0 };

type Call = [string, unknown];

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

/**
 * Run's deps over the fake window and workspace, a real BindingStore and RunRegistry, a scripted client and a recording
 * execute that settles its run as RunService does. The editor shows `text` in Untitled-1 and is active and visible.
 */
function setup(text = "select 1;") {
  const document = new FakeTextDocument(Uri.parse(UNTITLED), text);
  const editor = new FakeTextEditor(document);
  window.activeTextEditor = editor.asEditor();
  window.visibleTextEditors = [editor.asEditor()];
  settings.set("libredb.query.rowLimit", 500);
  const calls: Call[] = [];
  const descriptions: Record<string, ProviderDescription> = { [PG.id]: ZERO_LEVELS, [MONGO.id]: ZERO_LEVELS };
  const entries: Record<string, ProfileEntry | undefined> = { [PG.id]: PG, [MONGO.id]: MONGO };
  const scripts = {
    ensureOpen: (connectionId: string): Promise<ProviderDescription> => Promise.resolve(descriptions[connectionId]),
    runTarget: (params: RunTargetParams): Promise<RunTargetResult> => Promise.resolve({ statement: params.text }),
    listContainers: (): Promise<Container[]> => Promise.resolve([SHOP]),
    execute: (): Promise<void> => Promise.resolve(),
  };
  const bindings = new BindingStore();
  const runs = new RunRegistry(() => new CancellationTokenSource());
  const executed: [PreparingRun, RunRequest][] = [];
  const timers: [() => void, number][] = [];
  const lines: string[] = [];
  const counts = { showLog: 0, openUserSettings: 0, addConnection: 0 };
  const items: ProfileItem[] = [
    { kind: "valid", entry: PG },
    { kind: "valid", entry: MONGO },
  ];
  const deps = {
    window,
    workspace,
    store: { list: () => items, get: (id: string) => entries[id] },
    icons: { label: (type: string) => LABELS[type] },
    client: {
      ensureOpen: (connectionId: string) => {
        calls.push(["ensureOpen", connectionId]);
        return scripts.ensureOpen(connectionId);
      },
      runTarget: (params: RunTargetParams) => {
        calls.push(["runTarget", params]);
        return scripts.runTarget(params);
      },
      listContainers: (params: ContainersParams) => {
        calls.push(["listContainers", params]);
        return scripts.listContainers();
      },
    },
    bindings,
    runs,
    service: {
      execute: (prepared: PreparingRun, request: RunRequest) => {
        executed.push([prepared, request]);
        return scripts.execute().finally(() => runs.settle(prepared));
      },
    },
    timers: { setTimeout: (run: () => void, ms: number) => timers.push([run, ms]) },
    log: { error: (line: string | Error) => lines.push(String(line)) },
    showLog: () => {
      counts.showLog += 1;
      return Promise.resolve();
    },
    openUserSettings: () => {
      counts.openUserSettings += 1;
      return Promise.resolve();
    },
    addConnection: () => {
      counts.addConnection += 1;
      return Promise.resolve();
    },
  };
  return {
    deps,
    document,
    editor,
    calls,
    descriptions,
    entries,
    scripts,
    bindings,
    runs,
    executed,
    timers,
    lines,
    counts,
  };
}

/** Binds the setup's document to PG. */
function bound(text?: string) {
  const env = setup(text);
  env.bindings.bind(UNTITLED, { connectionId: PG.id });
  return env;
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const messages = () => shownMessages.map(({ level, message, items }) => ({ level, message, items }));

describe("runQuery", () => {
  describe("step 1: the editor", () => {
    it("asks for an editor from the palette when none is active", async () => {
      const { deps, calls } = bound();
      window.activeTextEditor = undefined;
      await runQuery(deps);
      assert.deepEqual(messages(), [{ level: "info", message: "Open an editor to run a query.", items: [] }]);
      assert.equal(NO_ACTIVE_EDITOR, "Open an editor to run a query.");
      assert.deepEqual(calls, []);
    });

    it("refuses a URI that no visible editor shows", async () => {
      const { deps, calls } = bound();
      await runQuery(deps, Uri.parse("file:///w/other.sql"));
      assert.deepEqual(messages(), [{ level: "info", message: "The editor to run is not visible.", items: [] }]);
      assert.equal(EDITOR_NOT_VISIBLE, "The editor to run is not visible.");
      assert.deepEqual(calls, []);
    });

    it("runs the visible editor that shows the title's URI, not the active one", async () => {
      const { deps, executed } = bound();
      const other = new FakeTextEditor(new FakeTextDocument(Uri.parse("file:///w/q.sql"), "select 2;"));
      window.activeTextEditor = other.asEditor();
      window.visibleTextEditors = [other.asEditor(), ...window.visibleTextEditors];
      await runQuery(deps, Uri.parse(UNTITLED));
      assert.equal(executed.length, 1);
      assert.equal(executed[0][0].uri, UNTITLED);
      assert.equal(executed[0][1].statement, "select 1;");
    });

    it("rejects a target that is neither a URI nor nothing", async () => {
      const { deps } = bound();
      await assert.rejects(runQuery(deps, "x"), { message: "libredb.runQuery takes an editor's URI or nothing." });
    });
  });

  describe("step 2: an unbound document", () => {
    it("asks for a connection and runs nothing when the pick is dismissed", async () => {
      const { deps, calls, bindings } = setup();
      await runQuery(deps);
      assert.equal(shownQuickPicks.length, 1);
      assert.equal(shownQuickPicks[0].options?.placeHolder, "Choose a connection for this editor");
      assert.deepEqual(calls, []);
      assert.equal(bindings.get(UNTITLED), undefined);
    });

    it("binds the chosen connection and runs on it", async () => {
      const { deps, calls, bindings, executed } = setup();
      answerQuickPicks((shown) => shown.items[0]);
      await runQuery(deps);
      assert.deepEqual(bindings.get(UNTITLED), { connectionId: PG.id });
      assert.deepEqual(calls[0], ["ensureOpen", PG.id]);
      assert.equal(executed.length, 1);
    });
  });

  it("step 3: refuses a document that already holds a run", async () => {
    const { deps, calls, runs } = bound();
    runs.prepare(UNTITLED, PG.id);
    await runQuery(deps);
    assert.deepEqual(messages(), [{ level: "info", message: "A query is already running in this editor.", items: [] }]);
    assert.deepEqual(calls, []);
  });

  it("step 4: refuses a blank document before any open", async () => {
    const { deps, calls, runs } = bound("  \n\t");
    await runQuery(deps);
    assert.deepEqual(messages(), [{ level: "info", message: "Nothing to run.", items: [] }]);
    assert.equal(NOTHING_TO_RUN, "Nothing to run.");
    assert.deepEqual(calls, []);
    assert.deepEqual(runs.running(), []);
  });

  describe("step 5: libredb.query.rowLimit", () => {
    for (const [value, shown] of [
      [0, "0"],
      [10001, "10001"],
      [2.5, "2.5"],
      ["500", '"500"'],
    ] as const) {
      it(`refuses ${shown} with Open User Settings and prepares nothing`, async () => {
        const { deps, calls, runs, counts } = bound();
        settings.set("libredb.query.rowLimit", value);
        answerMessages(() => "Open User Settings");
        await runQuery(deps);
        await settle();
        assert.deepEqual(messages(), [
          {
            level: "error",
            message: `libredb.query.rowLimit must be a whole number from 1 to 10000; it is ${shown}.`,
            items: ["Open User Settings"],
          },
        ]);
        assert.equal(counts.openUserSettings, 1);
        assert.deepEqual(calls, []);
        assert.deepEqual(runs.running(), []);
      });
    }

    it("refuses an unset value, which a real host answers with the manifest's default", async () => {
      const { deps, counts } = bound();
      settings.delete("libredb.query.rowLimit");
      await runQuery(deps);
      await settle();
      assert.equal(
        messages()[0].message,
        "libredb.query.rowLimit must be a whole number from 1 to 10000; it is undefined.",
      );
      assert.equal(counts.openUserSettings, 0);
    });

    it("reads the setting at each run", async () => {
      const { deps, executed } = bound();
      settings.set("libredb.query.rowLimit", 2);
      await runQuery(deps);
      settings.set("libredb.query.rowLimit", 3);
      await runQuery(deps);
      assert.deepEqual(
        executed.map(([, request]) => request.limit),
        [2, 3],
      );
    });

    it("readRowLimit answers a whole number from 1 to ROW_LIMIT_MAX and throws RowLimitError otherwise", () => {
      settings.set("libredb.query.rowLimit", ROW_LIMIT_MAX);
      assert.equal(readRowLimit(workspace), 10_000);
      settings.set("libredb.query.rowLimit", 1);
      assert.equal(readRowLimit(workspace), 1);
      settings.set("libredb.query.rowLimit", -1);
      assert.throws(() => readRowLimit(workspace), RowLimitError);
    });
  });

  describe("step 6 and 7: the open", () => {
    it("is running and cancellable while the open waits, and a cancel ends it with nothing sent or shown", async () => {
      const { deps, calls, runs, scripts, executed } = bound();
      const open = deferred<ProviderDescription>();
      scripts.ensureOpen = () => open.promise;
      const run = runQuery(deps);
      await settle();
      assert.deepEqual(runs.running(), [UNTITLED]);
      assert.deepEqual(runs.cancellable(), [UNTITLED]);
      runs.of(UNTITLED)?.tokenSource.cancel();
      await run;
      assert.deepEqual(runs.running(), []);
      open.resolve(ZERO_LEVELS);
      await settle();
      assert.deepEqual(
        calls.map(([method]) => method),
        ["ensureOpen"],
      );
      assert.deepEqual(executed, []);
      assert.deepEqual(shownMessages, []);
    });

    it("leaves a late rejection of a cancelled open unread", async () => {
      const { deps, runs, scripts } = bound();
      const open = deferred<ProviderDescription>();
      scripts.ensureOpen = () => open.promise;
      const run = runQuery(deps);
      await settle();
      runs.of(UNTITLED)?.tokenSource.cancel();
      await run;
      open.reject(new BackendError(503, "CONNECTION_ERROR", "late"));
      await settle();
      assert.deepEqual(shownMessages, []);
    });

    it("shows a failed open's sentence with Show Log once and settles", async () => {
      const { deps, runs, scripts, executed } = bound();
      scripts.ensureOpen = () => Promise.reject(new BackendError(500, "CONNECTION_ERROR", "connect ECONNREFUSED"));
      await runQuery(deps);
      assert.deepEqual(messages(), [{ level: "error", message: "connect ECONNREFUSED", items: ["Show Log"] }]);
      assert.deepEqual(runs.running(), []);
      assert.deepEqual(executed, []);
    });

    it("shows nothing when a secret prompt is declined", async () => {
      const { deps, runs, scripts } = bound();
      scripts.ensureOpen = () => Promise.reject(new CredentialsNotGivenError("shop"));
      await runQuery(deps);
      assert.deepEqual(shownMessages, []);
      assert.deepEqual(runs.running(), []);
    });
  });

  describe("step 8: the catalog", () => {
    it("asks for a catalog on a connection with catalog sessions, rebinds it and sends it", async () => {
      const { deps, descriptions, bindings, executed } = bound();
      descriptions[PG.id] = CATALOG_SESSIONS;
      answerQuickPicks((shown) => shown.items[0]);
      await runQuery(deps);
      assert.equal(shownQuickPicks[0].options?.title, "Choose a Database");
      assert.deepEqual(bindings.get(UNTITLED), { connectionId: PG.id, catalog: "shop" });
      assert.equal(executed[0][1].catalog, "shop");
    });

    it("binds the picked catalog under the document's key after a rename during the pick, not the old key", async () => {
      const { deps, descriptions, bindings, runs, executed } = bound();
      descriptions[PG.id] = CATALOG_SESSIONS;
      const RENAMED = "file:///w/renamed.sql";
      answerQuickPicks((shown) => {
        bindings.rename(UNTITLED, RENAMED);
        runs.rename(UNTITLED, RENAMED);
        return shown.items[0];
      });
      await runQuery(deps);
      assert.equal(bindings.get(UNTITLED), undefined);
      assert.deepEqual(bindings.get(RENAMED), { connectionId: PG.id, catalog: "shop" });
      assert.equal(executed[0][1].catalog, "shop");
    });

    it("binds the dropped catalog under the document's key after a rename during the open", async () => {
      const { deps, descriptions, bindings, runs, scripts } = bound();
      descriptions[PG.id] = ONE_LEVEL;
      bindings.bind(UNTITLED, { connectionId: PG.id, catalog: "old" });
      const RENAMED = "file:///w/renamed.sql";
      const open = deferred<ProviderDescription>();
      scripts.ensureOpen = () => open.promise;
      const run = runQuery(deps);
      await settle();
      bindings.rename(UNTITLED, RENAMED);
      runs.rename(UNTITLED, RENAMED);
      open.resolve(ONE_LEVEL);
      await run;
      assert.equal(bindings.get(UNTITLED), undefined);
      assert.deepEqual(bindings.get(RENAMED), { connectionId: PG.id });
    });

    it("sends the bound catalog without asking", async () => {
      const { deps, descriptions, bindings, executed } = bound();
      descriptions[PG.id] = CATALOG_SESSIONS;
      bindings.bind(UNTITLED, { connectionId: PG.id, catalog: "stage" });
      await runQuery(deps);
      assert.deepEqual(shownQuickPicks, []);
      assert.equal(executed[0][1].catalog, "stage");
    });

    it("runs nothing when the catalog pick is dismissed", async () => {
      const { deps, descriptions, runs, calls, executed } = bound();
      descriptions[PG.id] = CATALOG_SESSIONS;
      await runQuery(deps);
      assert.deepEqual(runs.running(), []);
      assert.equal(
        calls.some(([method]) => method === "runTarget"),
        false,
      );
      assert.deepEqual(executed, []);
    });

    it("ends with nothing shown when the run is cancelled during the catalog step", async () => {
      const { deps, descriptions, runs, scripts, executed } = bound();
      descriptions[PG.id] = CATALOG_SESSIONS;
      const listed = deferred<Container[]>();
      scripts.listContainers = () => listed.promise;
      const run = runQuery(deps);
      await settle();
      runs.of(UNTITLED)?.tokenSource.cancel();
      await run;
      assert.deepEqual(runs.running(), []);
      assert.deepEqual(executed, []);
      assert.deepEqual(shownMessages, []);
    });

    it("drops a catalog the description no longer declares sessions for", async () => {
      const { deps, descriptions, bindings, executed } = bound();
      descriptions[PG.id] = ONE_LEVEL;
      bindings.bind(UNTITLED, { connectionId: PG.id, catalog: "old" });
      await runQuery(deps);
      assert.deepEqual(bindings.get(UNTITLED), { connectionId: PG.id });
      assert.equal(Object.hasOwn(executed[0][1], "catalog"), false);
    });
  });

  describe("step 9: query/target", () => {
    const TWO = "select 1;\nselect 2;";

    /** The selection and cursor runTarget received after the editor selected anchor to active. */
    async function sentFor(anchor: number, active: number) {
      const { deps, editor, calls } = bound(TWO);
      editor.select(anchor, active);
      await runQuery(deps);
      const [, params] = calls.find(([method]) => method === "runTarget") as Call;
      return params as RunTargetParams;
    }

    it("sends the cursor with an empty selection", async () => {
      assert.deepEqual(await sentFor(3, 3), {
        connectionId: PG.id,
        text: TWO,
        selection: { start: 3, end: 3 },
        cursor: 3,
      });
    });

    it("sends a selection and its active end", async () => {
      const params = await sentFor(10, 18);
      assert.deepEqual(params.selection, { start: 10, end: 18 });
      assert.equal(params.cursor, 18);
    });

    it("sends a reversed selection in order, with the cursor at its active end", async () => {
      const params = await sentFor(18, 10);
      assert.deepEqual(params.selection, { start: 10, end: 18 });
      assert.equal(params.cursor, 10);
    });

    it("sends the text, selection and cursor as they were when Run was invoked, not after an edit during the open", async () => {
      const { deps, document, editor, calls, scripts } = bound("select 1;");
      editor.select(3, 3);
      const open = deferred<ProviderDescription>();
      scripts.ensureOpen = () => open.promise;
      const run = runQuery(deps);
      await settle();
      document.edit("delete from t;\nselect 1;");
      open.resolve(ZERO_LEVELS);
      await run;
      const [, params] = calls.find(([method]) => method === "runTarget") as Call;
      assert.deepEqual(params, { connectionId: PG.id, text: "select 1;", selection: { start: 3, end: 3 }, cursor: 3 });
    });

    it("shows a refused target with Show Log", async () => {
      const { deps, scripts, runs, executed } = bound();
      scripts.runTarget = () => Promise.reject(new BackendError(-32602, null, "selection is out of range"));
      await runQuery(deps);
      assert.deepEqual(messages(), [{ level: "error", message: "selection is out of range", items: ["Show Log"] }]);
      assert.deepEqual(runs.running(), []);
      assert.deepEqual(executed, []);
    });

    it("ends with nothing shown when the run is cancelled while the target is read", async () => {
      const { deps, scripts, runs, executed } = bound();
      const target = deferred<RunTargetResult>();
      scripts.runTarget = () => target.promise;
      const run = runQuery(deps);
      await settle();
      runs.of(UNTITLED)?.tokenSource.cancel();
      await run;
      assert.deepEqual(runs.running(), []);
      assert.deepEqual(executed, []);
      assert.deepEqual(shownMessages, []);
    });
  });

  it("step 10: a target with no code answers Nothing to run. and starts no run", async () => {
    const { deps, scripts, runs, executed } = bound("-- only a comment");
    scripts.runTarget = () => Promise.resolve({ statement: "" });
    await runQuery(deps);
    assert.deepEqual(messages(), [{ level: "info", message: "Nothing to run.", items: [] }]);
    assert.deepEqual(executed, []);
    assert.deepEqual(runs.running(), []);
  });

  describe("step 11: the highlight", () => {
    it("highlights the target's range and disposes the decoration after HIGHLIGHT_MS", async () => {
      const { deps, editor, scripts, timers } = bound("select 1;\nselect 2;");
      scripts.runTarget = () => Promise.resolve({ statement: "select 2;", range: { start: 10, end: 19 } });
      await runQuery(deps);
      assert.equal(decorationTypes.length, 1);
      const [type] = decorationTypes;
      assert.deepEqual(type.options, { backgroundColor: new ThemeColor("editor.rangeHighlightBackground") });
      assert.equal(editor.decorations.length, 1);
      assert.equal(editor.decorations[0][0], type);
      assert.deepEqual(
        editor.decorations[0][1].map(({ start, end }) => [start.line, start.character, end.line, end.character]),
        [[1, 0, 1, 9]],
      );
      assert.equal(timers.length, 1);
      assert.equal(timers[0][1], HIGHLIGHT_MS);
      assert.equal(HIGHLIGHT_MS, 1000);
      assert.equal(type.disposed, false);
      timers[0][0]();
      assert.equal(type.disposed, true);
    });

    it("highlights nothing when the document changed since Run was invoked", async () => {
      const { deps, document, editor, scripts, timers, executed } = bound("select 1;");
      const open = deferred<ProviderDescription>();
      scripts.ensureOpen = () => open.promise;
      scripts.runTarget = () => Promise.resolve({ statement: "select 1;", range: { start: 0, end: 9 } });
      const run = runQuery(deps);
      await settle();
      document.edit("delete from t;\nselect 1;");
      open.resolve(ZERO_LEVELS);
      await run;
      assert.deepEqual(decorationTypes, []);
      assert.deepEqual(editor.decorations, []);
      assert.deepEqual(timers, []);
      assert.equal(executed[0][1].statement, "select 1;");
    });

    it("highlights nothing when the target has no range", async () => {
      const { deps, editor } = bound();
      await runQuery(deps);
      assert.deepEqual(decorationTypes, []);
      assert.deepEqual(editor.decorations, []);
    });
  });

  describe("step 11b: the confirmation", () => {
    const DELETE = "delete from t";
    const asks = () => {
      const env = bound(DELETE);
      env.scripts.runTarget = () => Promise.resolve({ statement: DELETE, dangerous: true });
      return env;
    };

    it("asks in a modal that shows the statement, and runs it once the person chooses Run Anyway", async () => {
      const { deps, executed } = asks();
      answerMessages(() => RUN_ANYWAY);
      await runQuery(deps);
      assert.deepEqual(shownMessages, [
        {
          level: "warning",
          message:
            "This statement may change data, database objects, or permissions. Review it before running it on shop.",
          options: { modal: true, detail: DELETE },
          items: ["Run Anyway"],
        },
      ]);
      assert.equal(executed.length, 1);
      assert.equal(executed[0][1].statement, DELETE);
    });

    it("sends nothing and settles the run when the person dismisses it", async () => {
      const { deps, runs, executed } = asks();
      await runQuery(deps);
      assert.equal(shownMessages.length, 1);
      assert.deepEqual(executed, []);
      assert.deepEqual(runs.running(), []);
    });

    it("sends nothing when the run is cancelled during the question, whatever the person then chose", async () => {
      const { deps, runs, executed } = asks();
      answerMessages(() => {
        runs.of(UNTITLED)?.tokenSource.cancel();
        return RUN_ANYWAY;
      });
      await runQuery(deps);
      assert.deepEqual(executed, []);
      assert.deepEqual(runs.running(), []);
    });

    it("asks nothing for a target the child did not flag", async () => {
      const { deps, executed } = bound("select 1;");
      await runQuery(deps);
      assert.deepEqual(shownMessages, []);
      assert.equal(executed.length, 1);
    });
  });

  describe("step 12: the run", () => {
    it("hands the prepared run and its request to the service, and resolves once it settled", async () => {
      const { deps, scripts, executed, runs } = bound();
      const done = deferred<void>();
      scripts.execute = () => done.promise;
      let resolved = false;
      const run = runQuery(deps).then(() => {
        resolved = true;
      });
      await settle();
      assert.equal(executed.length, 1);
      const [prepared, request] = executed[0];
      assert.equal(prepared.uri, UNTITLED);
      assert.equal(prepared.connectionId, PG.id);
      assert.deepEqual(request, {
        documentLabel: "Untitled-1",
        connectionName: "shop",
        connectionType: "postgres",
        description: ZERO_LEVELS,
        statement: "select 1;",
        limit: 500,
      });
      assert.equal(resolved, false);
      assert.deepEqual(runs.running(), [UNTITLED]);
      done.resolve();
      await run;
      assert.equal(resolved, true);
    });

    it("shows a profile removed while the run prepared, and runs nothing", async () => {
      const { deps, entries, runs, executed } = bound();
      entries[PG.id] = undefined;
      await runQuery(deps);
      assert.deepEqual(messages(), [
        {
          level: "error",
          message: `The connection ${PG.id} is no longer in libredb.connections.`,
          items: ["Show Log"],
        },
      ]);
      assert.deepEqual(runs.running(), []);
      assert.deepEqual(executed, []);
    });

    it("shows the service's refusal of a run a crash cleared", async () => {
      const { deps, scripts } = bound();
      scripts.execute = () => Promise.reject(new Error("The run of untitled:Untitled-1 is no longer registered."));
      await runQuery(deps);
      assert.deepEqual(messages(), [
        { level: "error", message: "The run of untitled:Untitled-1 is no longer registered.", items: ["Show Log"] },
      ]);
    });
  });
});

describe("documentLabel", () => {
  it("is the last segment of the document's path", () => {
    assert.equal(documentLabel({ uri: Uri.parse(UNTITLED) }), "Untitled-1");
    assert.equal(documentLabel({ uri: Uri.parse("file:///w/q.sql") }), "q.sql");
  });
});

describe("untilCancelled", () => {
  it("answers cancelled at once for a token already cancelled, and leaves the answer unread", async () => {
    const source = new CancellationTokenSource();
    source.cancel();
    const late = deferred<number>();
    assert.deepEqual(await untilCancelled(late.promise, source.token), { cancelled: true });
    late.reject(new Error("late"));
    await settle();
  });
});
