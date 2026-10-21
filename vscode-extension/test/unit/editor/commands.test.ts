import assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { Container, DatabaseObject, ObjectKindSpec } from "@/lib/db/types";
import { BackendError } from "../../../src/host/backend-client";
import type { ProfileEntry, ProfileItem } from "../../../src/host/connections/profile";
import { BindingStore } from "../../../src/host/editor/bindings";
import {
  CHANGE_REFUSED,
  cancelQuery,
  changeConnection,
  newQuery,
  queryNodeOf,
  SERVER_DID_NOT_STOP,
  selectRows,
} from "../../../src/host/editor/commands";
import { type PreparingRun, RunRegistry } from "../../../src/host/editor/run-registry";
import type { RunRequest } from "../../../src/host/editor/run-service";
import { issueNode, type TreeNode } from "../../../src/host/tree/nodes";
import type {
  CancelResult,
  ContainersParams,
  ProviderDescription,
  RunTargetParams,
  RunTargetResult,
  SelectStatementParams,
  SelectStatementResult,
} from "../../../src/protocol";
import { CATALOG_SESSIONS, ZERO_LEVELS } from "../../fakes/descriptions";
import { FakeTextDocument, FakeTextEditor } from "../../fakes/documents";
import { MONGO, PG } from "../../fakes/profiles";
import {
  answerQuickPicks,
  CancellationTokenSource,
  languages,
  openedDocuments,
  ProgressLocation,
  progressRuns,
  settings,
  shownDocuments,
  shownMessages,
  shownQuickPicks,
  Uri,
  languageChanges,
  window,
  workspace,
} from "../../fakes/vscode";

const LABELS: Record<string, string> = { postgres: "PostgreSQL", mongodb: "MongoDB" };
const SHOP: Container = { path: ["shop"], name: "shop", level: 0 };
const JSON_DESCRIPTION: ProviderDescription = { ...ZERO_LEVELS, editorLanguage: "json" };
const TABLE: ObjectKindSpec = { id: "table", role: "relation", label: "Table", labelPlural: "Tables" };
const ORDERS: DatabaseObject = { path: ["public", "orders"], name: "orders", kind: "table" };

type Call = [string, unknown];

const connectionNode = (entry: ProfileEntry = PG): TreeNode =>
  issueNode({
    id: `c/${entry.id}`,
    node: "connection",
    connectionId: entry.id,
    entry,
  });
const containerNode: TreeNode = issueNode({
  id: "k/shop",
  node: "container",
  connectionId: PG.id,
  container: SHOP,
  levelLabel: "Database",
});
const folderNode: TreeNode = issueNode({
  id: "f/shop/public/table",
  node: "folder",
  connectionId: PG.id,
  containerPath: ["shop", "public"],
  kind: TABLE,
});
const objectNode = (object: DatabaseObject = ORDERS, role: "relation" | "routine" = "relation"): TreeNode =>
  issueNode({
    id: `o/${object.path.join("/")}`,
    node: "object",
    connectionId: PG.id,
    object,
    kindLabel: "Table",
    role,
    hasColumns: true,
  });
const groupNode: TreeNode = issueNode({
  id: "g/programmability",
  node: "group",
  connectionId: PG.id,
  containerPath: [],
  group: { id: "programmability", label: "Programmability" },
  kinds: [],
  counts: undefined,
});
const emptyNode: TreeNode = issueNode({ id: "n/empty", node: "empty", connectionId: PG.id, label: "No tables" });

/**
 * The editor commands' deps over the fake window, workspace and languages, a real BindingStore and RunRegistry, a
 * scripted client and a service whose execute records and settles its run as RunService does.
 */
function setup() {
  settings.set("libredb.query.rowLimit", 500);
  const calls: Call[] = [];
  const descriptions: Record<string, ProviderDescription> = { [PG.id]: ZERO_LEVELS, [MONGO.id]: JSON_DESCRIPTION };
  const entries: Record<string, ProfileEntry | undefined> = { [PG.id]: PG, [MONGO.id]: MONGO };
  const scripts = {
    ensureOpen: (connectionId: string): Promise<ProviderDescription> => Promise.resolve(descriptions[connectionId]),
    selectStatement: (): Promise<SelectStatementResult> =>
      Promise.resolve({ statement: 'SELECT * FROM "public"."orders";' }),
    runTarget: (params: RunTargetParams): Promise<RunTargetResult> => Promise.resolve({ statement: params.text }),
    listContainers: (): Promise<Container[]> => Promise.resolve([SHOP]),
    cancel: (): Promise<CancelResult | undefined> => Promise.resolve(undefined),
  };
  const bindings = new BindingStore();
  const runs = new RunRegistry(() => new CancellationTokenSource());
  const executed: [PreparingRun, RunRequest][] = [];
  const cancelled: string[] = [];
  const lines: string[] = [];
  const items: ProfileItem[] = [
    { kind: "valid", entry: PG },
    { kind: "valid", entry: MONGO },
  ];
  const deps = {
    window,
    workspace,
    languages,
    store: { list: () => items, get: (id: string) => entries[id] },
    icons: { label: (type: string) => LABELS[type] },
    client: {
      ensureOpen: (connectionId: string) => {
        calls.push(["ensureOpen", connectionId]);
        return scripts.ensureOpen(connectionId);
      },
      selectStatement: (params: SelectStatementParams) => {
        calls.push(["selectStatement", params]);
        return scripts.selectStatement();
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
        runs.settle(prepared);
        return Promise.resolve();
      },
      cancel: (uri: string) => {
        cancelled.push(uri);
        return scripts.cancel();
      },
    },
    timers: { setTimeout: () => undefined },
    log: { error: (line: string | Error) => lines.push(String(line)) },
    showLog: () => Promise.resolve(),
    openUserSettings: () => Promise.resolve(),
    addConnection: () => Promise.resolve(),
  };
  return { deps, calls, descriptions, entries, scripts, bindings, runs, executed, cancelled };
}

const messages = () => shownMessages.map(({ level, message, items }) => ({ level, message, items }));

/** The one document the command opened, its key, and the options it was shown with. */
function openedOne() {
  assert.equal(openedDocuments.length, 1);
  const [document] = openedDocuments;
  assert.equal(shownDocuments.length, 1);
  assert.equal(shownDocuments[0][0], document.asDocument());
  return { document, uri: document.uri.toString(), options: shownDocuments[0][1] };
}

describe("queryNodeOf", () => {
  it("answers undefined for nothing", () => {
    assert.equal(queryNodeOf(undefined), undefined);
  });

  it("answers the connection and the path whose catalog binds each node", () => {
    assert.deepEqual(queryNodeOf(connectionNode()), { connectionId: PG.id, path: [] });
    assert.deepEqual(queryNodeOf(containerNode), { connectionId: PG.id, path: ["shop"] });
    assert.deepEqual(queryNodeOf(folderNode), { connectionId: PG.id, path: ["shop", "public"] });
    assert.deepEqual(queryNodeOf(objectNode({ ...ORDERS, path: ["shop", "public", "orders"] })), {
      connectionId: PG.id,
      path: ["shop", "public", "orders"],
    });
  });

  for (const [name, target] of [
    ["a group node", groupNode],
    ["an empty node", emptyNode],
    ["a connection node the tree did not issue", { ...connectionNode() }],
    ["an object node the tree did not issue", { ...objectNode() }],
    ["a string", "x"],
    ["null", null],
  ] as const) {
    it(`throws for ${name}`, () => {
      assert.throws(() => queryNodeOf(target), {
        message: "libredb.newQuery takes a connection, container, folder or object node, or nothing.",
      });
    });
  }
});

describe("newQuery", () => {
  it("opens an empty editor in the engine's language from a connection node, bound with no catalog", async () => {
    const { deps, calls, bindings } = setup();
    await newQuery(deps, connectionNode());
    assert.deepEqual(calls, [["ensureOpen", PG.id]]);
    assert.deepEqual(
      progressRuns.map(({ options }) => options),
      [{ location: { viewId: "libredb.connections" } }],
    );
    const { document, uri, options } = openedOne();
    assert.equal(document.languageId, "sql");
    assert.equal(document.getText(), "");
    assert.deepEqual(options, { preview: false });
    assert.deepEqual(bindings.get(uri), { connectionId: PG.id });
    assert.equal(Object.hasOwn(bindings.get(uri) as object, "catalog"), false);
  });

  it("binds a container node's catalog without asking", async () => {
    const { deps, descriptions, bindings } = setup();
    descriptions[PG.id] = CATALOG_SESSIONS;
    await newQuery(deps, containerNode);
    assert.deepEqual(shownQuickPicks, []);
    assert.deepEqual(bindings.get(openedOne().uri), { connectionId: PG.id, catalog: "shop" });
  });

  it("asks for a catalog from a connection node with catalog sessions", async () => {
    const { deps, descriptions, bindings } = setup();
    descriptions[PG.id] = CATALOG_SESSIONS;
    answerQuickPicks((shown) => shown.items[0]);
    await newQuery(deps, connectionNode());
    assert.equal(shownQuickPicks[0].options?.title, "Choose a Database");
    assert.deepEqual(bindings.get(openedOne().uri), { connectionId: PG.id, catalog: "shop" });
  });

  it("opens nothing when the catalog pick is dismissed", async () => {
    const { deps, descriptions } = setup();
    descriptions[PG.id] = CATALOG_SESSIONS;
    await newQuery(deps, connectionNode());
    assert.deepEqual(openedDocuments, []);
  });

  it("shows a failed catalog listing and opens nothing", async () => {
    const { deps, descriptions, scripts } = setup();
    descriptions[PG.id] = CATALOG_SESSIONS;
    scripts.listContainers = () => Promise.reject(new BackendError(500, "QUERY_ERROR", "permission denied"));
    await newQuery(deps, connectionNode());
    assert.deepEqual(messages(), [{ level: "error", message: "permission denied", items: ["Show Log"] }]);
    assert.deepEqual(openedDocuments, []);
  });

  it("asks for a connection from the palette and opens it under window progress", async () => {
    const { deps, bindings } = setup();
    answerQuickPicks((shown) => shown.items[1]);
    await newQuery(deps);
    assert.equal(shownQuickPicks[0].options?.placeHolder, "Choose a connection for the new query");
    assert.deepEqual(
      progressRuns.map(({ options }) => options),
      [{ location: ProgressLocation.Window, title: "LibreDB: opening orders" }],
    );
    const { document, uri } = openedOne();
    assert.equal(document.languageId, "json");
    assert.deepEqual(bindings.get(uri), { connectionId: MONGO.id });
  });

  it("opens nothing when the palette's connection pick is dismissed", async () => {
    const { deps, calls } = setup();
    await newQuery(deps);
    assert.deepEqual(calls, []);
    assert.deepEqual(openedDocuments, []);
  });

  it("shows a profile the store no longer holds, from the palette, and opens nothing", async () => {
    const { deps, entries, calls } = setup();
    entries[PG.id] = undefined;
    answerQuickPicks((shown) => shown.items[0]);
    await newQuery(deps);
    assert.deepEqual(messages(), [
      { level: "error", message: `The connection ${PG.id} is no longer in libredb.connections.`, items: ["Show Log"] },
    ]);
    assert.deepEqual(calls, []);
  });

  it("shows a failed open once with Show Log and opens no editor", async () => {
    const { deps, scripts } = setup();
    scripts.ensureOpen = () => Promise.reject(new BackendError(503, "CONNECTION_ERROR", "connect ECONNREFUSED"));
    await newQuery(deps, connectionNode());
    assert.deepEqual(messages(), [{ level: "error", message: "connect ECONNREFUSED", items: ["Show Log"] }]);
    assert.deepEqual(openedDocuments, []);
  });
});

describe("selectRows", () => {
  it("opens the statement in a bound editor and runs it whole with the row limit", async () => {
    const { deps, calls, bindings, executed, runs } = setup();
    settings.set("libredb.query.rowLimit", 2);
    await selectRows(deps, objectNode());
    assert.deepEqual(calls, [
      ["ensureOpen", PG.id],
      ["selectStatement", { connectionId: PG.id, object: ORDERS }],
    ]);
    assert.deepEqual(
      progressRuns.map(({ options }) => options),
      [{ location: { viewId: "libredb.connections" } }],
    );
    const { document, uri, options } = openedOne();
    assert.equal(document.languageId, "sql");
    assert.equal(document.getText(), 'SELECT * FROM "public"."orders";');
    assert.deepEqual(options, { preview: false });
    assert.deepEqual(bindings.get(uri), { connectionId: PG.id });
    assert.equal(executed.length, 1);
    const [prepared, request] = executed[0];
    assert.equal(prepared.uri, uri);
    assert.equal(prepared.connectionId, PG.id);
    assert.deepEqual(request, {
      documentLabel: "Untitled-1",
      connectionName: "shop",
      connectionType: "postgres",
      description: ZERO_LEVELS,
      statement: 'SELECT * FROM "public"."orders";',
      limit: 2,
    });
    assert.deepEqual(runs.running(), []);
  });

  it("binds and sends the object's catalog on a connection with catalog sessions", async () => {
    const { deps, descriptions, bindings, executed } = setup();
    descriptions[PG.id] = CATALOG_SESSIONS;
    await selectRows(deps, objectNode({ ...ORDERS, path: ["shop", "public", "orders"] }));
    assert.deepEqual(bindings.get(openedOne().uri), { connectionId: PG.id, catalog: "shop" });
    assert.equal(executed[0][1].catalog, "shop");
  });

  it("opens a JSON command in a json editor", async () => {
    const { deps, descriptions, scripts, executed } = setup();
    const command = JSON.stringify({ database: "orders", collection: "events", operation: "find" }, null, 2);
    descriptions[PG.id] = JSON_DESCRIPTION;
    scripts.selectStatement = () => Promise.resolve({ statement: command });
    await selectRows(deps, objectNode());
    const { document } = openedOne();
    assert.equal(document.languageId, "json");
    assert.equal(document.getText(), command);
    assert.equal(executed[0][1].statement, command);
  });

  for (const [name, target] of [
    ["a routine node", objectNode(ORDERS, "routine")],
    ["a folder node", folderNode],
    ["a relation node the tree did not issue", { ...objectNode() }],
    ["nothing", undefined],
  ] as const) {
    it(`rejects ${name}`, async () => {
      const { deps } = setup();
      await assert.rejects(selectRows(deps, target), { message: "libredb.selectRows takes a table or view node." });
    });
  }

  it("shows a failed selectStatement with Show Log and opens nothing", async () => {
    const { deps, scripts } = setup();
    scripts.selectStatement = () => Promise.reject(new BackendError(500, "QUERY_ERROR", "no such table"));
    await selectRows(deps, objectNode());
    assert.deepEqual(messages(), [{ level: "error", message: "no such table", items: ["Show Log"] }]);
    assert.deepEqual(openedDocuments, []);
  });

  it("shows a profile the store no longer holds and opens nothing", async () => {
    const { deps, entries } = setup();
    entries[PG.id] = undefined;
    await selectRows(deps, objectNode());
    assert.equal(messages()[0].message, `The connection ${PG.id} is no longer in libredb.connections.`);
    assert.deepEqual(openedDocuments, []);
  });

  it("shows a refused row limit after opening the editor, and runs nothing", async () => {
    const { deps, executed, runs } = setup();
    settings.set("libredb.query.rowLimit", 0);
    await selectRows(deps, objectNode());
    assert.deepEqual(messages(), [
      {
        level: "error",
        message: "libredb.query.rowLimit must be a whole number from 1 to 10000; it is 0.",
        items: ["Open User Settings"],
      },
    ]);
    openedOne();
    assert.deepEqual(executed, []);
    assert.deepEqual(runs.running(), []);
  });

  it("shows the service's refusal of a run a crash cleared", async () => {
    const { deps } = setup();
    deps.service.execute = () => Promise.reject(new Error("The run of untitled:Untitled-1 is no longer registered."));
    await selectRows(deps, objectNode());
    assert.equal(messages()[0].message, "The run of untitled:Untitled-1 is no longer registered.");
  });
});

/** Shows `uri` in an editor that is active and visible, in the given language. */
function showEditor(uri: string, languageId = "sql"): FakeTextDocument {
  const document = new FakeTextDocument(Uri.parse(uri), "select 1;", languageId);
  const editor = new FakeTextEditor(document);
  window.activeTextEditor = editor.asEditor();
  window.visibleTextEditors = [...window.visibleTextEditors, editor.asEditor()];
  return document;
}

const UNTITLED = "untitled:Untitled-1";
const FILE = "file:///w/q.sql";

describe("cancelQuery", () => {
  it("cancels the active editor's run, and warns when the server did not stop it", async () => {
    const { deps, cancelled, scripts } = setup();
    showEditor(UNTITLED);
    scripts.cancel = () => Promise.resolve({ cancelled: false });
    await cancelQuery(deps);
    assert.deepEqual(cancelled, [UNTITLED]);
    assert.deepEqual(messages(), [{ level: "warning", message: "The server did not stop the statement.", items: [] }]);
    assert.equal(SERVER_DID_NOT_STOP, "The server did not stop the statement.");
  });

  for (const [name, answer] of [
    ["a stopped statement", { cancelled: true }],
    ["nothing sent", undefined],
  ] as const) {
    it(`shows nothing for ${name}`, async () => {
      const { deps, cancelled, scripts } = setup();
      showEditor(UNTITLED);
      scripts.cancel = () => Promise.resolve(answer);
      await cancelQuery(deps);
      assert.deepEqual(cancelled, [UNTITLED]);
      assert.deepEqual(shownMessages, []);
    });
  }

  it("cancels the editor the title names", async () => {
    const { deps, cancelled } = setup();
    showEditor(FILE);
    showEditor(UNTITLED);
    await cancelQuery(deps, Uri.parse(FILE));
    assert.deepEqual(cancelled, [FILE]);
  });

  it("does nothing with no active editor but say so", async () => {
    const { deps, cancelled } = setup();
    await cancelQuery(deps);
    assert.deepEqual(cancelled, []);
    assert.deepEqual(messages(), [{ level: "info", message: "Open an editor to run a query.", items: [] }]);
  });

  it("rejects a target that is neither a URI nor nothing", async () => {
    const { deps } = setup();
    await assert.rejects(cancelQuery(deps, "x"), { message: "libredb.cancelQuery takes an editor's URI or nothing." });
  });

  it("shows a refused cancel with Show Log", async () => {
    const { deps, scripts } = setup();
    showEditor(UNTITLED);
    scripts.cancel = () => Promise.reject(new BackendError(500, "INTERNAL_ERROR", "cancel failed"));
    await cancelQuery(deps);
    assert.deepEqual(messages(), [{ level: "error", message: "cancel failed", items: ["Show Log"] }]);
  });
});

describe("changeConnection", () => {
  for (const phase of ["preparing", "running"] as const) {
    it(`is refused while the document holds a ${phase} run`, async () => {
      const { deps, runs, bindings } = setup();
      showEditor(UNTITLED);
      bindings.bind(UNTITLED, { connectionId: PG.id });
      const prepared = runs.prepare(UNTITLED, PG.id);
      if (phase === "running") {
        runs.start(prepared, { queryId: "q1", statement: "select 1;", limit: 500, cancellable: true });
      }
      await changeConnection(deps);
      assert.deepEqual(messages(), [
        {
          level: "warning",
          message: "A query is running in this editor. Cancel it or let it finish before changing its connection.",
          items: [],
        },
      ]);
      assert.equal(
        CHANGE_REFUSED,
        "A query is running in this editor. Cancel it or let it finish before changing its connection.",
      );
      assert.deepEqual(shownQuickPicks, []);
      assert.deepEqual(bindings.get(UNTITLED), { connectionId: PG.id });
    });
  }

  it("marks the bound profile current and offers Unbind this editor last, which unbinds", async () => {
    const { deps, bindings, calls } = setup();
    showEditor(UNTITLED);
    bindings.bind(UNTITLED, { connectionId: PG.id });
    answerQuickPicks((shown) => shown.items.at(-1));
    await changeConnection(deps);
    const [pick] = shownQuickPicks;
    assert.equal(pick.options?.placeHolder, "Choose the connection for this editor");
    assert.deepEqual(
      pick.items.map(({ label, description }) => [label, description]),
      [
        ["shop", "current"],
        ["orders", "MongoDB"],
        ["Unbind this editor", undefined],
      ],
    );
    assert.equal(bindings.get(UNTITLED), undefined);
    assert.deepEqual(calls, []);
  });

  it("offers no Unbind item on an unbound document", async () => {
    const { deps } = setup();
    showEditor(UNTITLED);
    await changeConnection(deps);
    assert.deepEqual(
      shownQuickPicks[0].items.map(({ description }) => description),
      ["PostgreSQL", "MongoDB"],
    );
  });

  it("changes nothing when the pick is dismissed", async () => {
    const { deps, bindings, calls } = setup();
    showEditor(UNTITLED);
    bindings.bind(UNTITLED, { connectionId: PG.id });
    await changeConnection(deps);
    assert.deepEqual(bindings.get(UNTITLED), { connectionId: PG.id });
    assert.deepEqual(calls, []);
  });

  it("rebinds an untitled document and then sets the new engine's language", async () => {
    const { deps, bindings, calls } = setup();
    const document = showEditor(UNTITLED);
    bindings.bind(UNTITLED, { connectionId: PG.id });
    const atCall: unknown[] = [];
    const changing = {
      ...deps,
      languages: {
        setTextDocumentLanguage: (changed: vscode.TextDocument, language: string) => {
          atCall.push(bindings.get(changed.uri.toString()));
          return languages.setTextDocumentLanguage(changed, language);
        },
      },
    };
    answerQuickPicks((shown) => shown.items[1]);
    await changeConnection(changing);
    assert.deepEqual(calls, [["ensureOpen", MONGO.id]]);
    assert.deepEqual(
      progressRuns.map(({ options }) => options),
      [{ location: ProgressLocation.Window, title: "LibreDB: opening orders" }],
    );
    assert.deepEqual(bindings.get(UNTITLED), { connectionId: MONGO.id });
    assert.deepEqual(languageChanges, [[UNTITLED, "json"]]);
    assert.deepEqual(atCall, [{ connectionId: MONGO.id }]);
    assert.equal(document.languageId, "json");
  });

  it("keeps an untitled document's language when it already matches", async () => {
    const { deps, bindings } = setup();
    showEditor(UNTITLED);
    answerQuickPicks((shown) => shown.items[0]);
    await changeConnection(deps);
    assert.deepEqual(bindings.get(UNTITLED), { connectionId: PG.id });
    assert.deepEqual(languageChanges, []);
  });

  it("keeps a file's language, from the editor the title names", async () => {
    const { deps, bindings } = setup();
    showEditor(FILE);
    showEditor(UNTITLED);
    bindings.bind(FILE, { connectionId: PG.id });
    answerQuickPicks((shown) => shown.items[1]);
    await changeConnection(deps, Uri.parse(FILE));
    assert.deepEqual(bindings.get(FILE), { connectionId: MONGO.id });
    assert.equal(bindings.get(UNTITLED), undefined);
    assert.deepEqual(languageChanges, []);
  });

  it("asks for a catalog on a connection with catalog sessions and binds it", async () => {
    const { deps, bindings, descriptions } = setup();
    showEditor(UNTITLED);
    descriptions[MONGO.id] = CATALOG_SESSIONS;
    let picks = 0;
    answerQuickPicks((shown) => {
      picks += 1;
      return picks === 1 ? shown.items[1] : shown.items[0];
    });
    await changeConnection(deps);
    assert.equal(shownQuickPicks[1].options?.title, "Choose a Database");
    assert.deepEqual(bindings.get(UNTITLED), { connectionId: MONGO.id, catalog: "shop" });
  });

  it("keeps the old binding when the catalog pick is dismissed", async () => {
    const { deps, bindings, descriptions } = setup();
    showEditor(UNTITLED);
    bindings.bind(UNTITLED, { connectionId: PG.id });
    descriptions[MONGO.id] = CATALOG_SESSIONS;
    answerQuickPicks((shown) => (shown.options?.title === undefined ? shown.items[1] : undefined));
    await changeConnection(deps);
    assert.deepEqual(bindings.get(UNTITLED), { connectionId: PG.id });
  });

  it("shows a failed open once with Show Log and keeps the old binding", async () => {
    const { deps, bindings, scripts } = setup();
    showEditor(UNTITLED);
    bindings.bind(UNTITLED, { connectionId: PG.id });
    scripts.ensureOpen = () => Promise.reject(new BackendError(503, "CONNECTION_ERROR", "connect ECONNREFUSED"));
    answerQuickPicks((shown) => shown.items[1]);
    await changeConnection(deps);
    assert.deepEqual(messages(), [{ level: "error", message: "connect ECONNREFUSED", items: ["Show Log"] }]);
    assert.deepEqual(bindings.get(UNTITLED), { connectionId: PG.id });
    assert.deepEqual(languageChanges, []);
  });

  it("is refused, changing nothing, when a run started while the person chose", async () => {
    const { deps, bindings, runs } = setup();
    showEditor(UNTITLED);
    bindings.bind(UNTITLED, { connectionId: PG.id });
    answerQuickPicks((shown) => {
      runs.prepare(UNTITLED, PG.id);
      return shown.items[1];
    });
    await changeConnection(deps);
    assert.deepEqual(messages(), [{ level: "warning", message: CHANGE_REFUSED, items: [] }]);
    assert.deepEqual(bindings.get(UNTITLED), { connectionId: PG.id });
    assert.deepEqual(languageChanges, []);
  });

  it("rejects a target that is neither a URI nor nothing", async () => {
    const { deps } = setup();
    await assert.rejects(changeConnection(deps, "x"), {
      message: "libredb.changeConnection takes an editor's URI or nothing.",
    });
  });

  it("does nothing with no active editor but say so", async () => {
    const { deps } = setup();
    await changeConnection(deps);
    assert.deepEqual(shownQuickPicks, []);
    assert.deepEqual(messages(), [{ level: "info", message: "Open an editor to run a query.", items: [] }]);
  });
});
