import assert from "node:assert/strict";
import type { ConnectionsChange } from "../../../src/host/connections/connection-store";
import type { ProfileEntry } from "../../../src/host/connections/profile";
import { BindingStore } from "../../../src/host/editor/bindings";
import { RunRegistry } from "../../../src/host/editor/run-registry";
import { ConnectionStatusBar, STATUS_ITEM_NAME } from "../../../src/host/editor/status-bar";
import { STATUS_ITEM } from "../../../src/host/names";
import { FakeTextDocument, FakeTextEditor } from "../../fakes/documents";
import { PG } from "../../fakes/profiles";
import {
  CancellationTokenSource,
  EventEmitter,
  setActiveTextEditor,
  StatusBarAlignment,
  statusBarItems,
  Uri,
  window,
} from "../../fakes/vscode";

const UNTITLED = "untitled:Untitled-1";
const LABELS: Record<string, string> = { postgres: "PostgreSQL" };

/** An editor over an empty document at the uri. */
function editorAt(uri: string) {
  return new FakeTextEditor(new FakeTextDocument(Uri.parse(uri), "")).asEditor();
}

/** The item over the fake window, a real BindingStore and RunRegistry, a scripted store and the PG label. */
function setup() {
  const entries = new Map<string, ProfileEntry>([[PG.id, PG]]);
  const changes = new EventEmitter<ConnectionsChange>();
  const store = { get: (id: string) => entries.get(id), onDidChange: changes.event };
  const bindings = new BindingStore();
  const runs = new RunRegistry(() => new CancellationTokenSource());
  const bar = new ConnectionStatusBar({
    window,
    bindings,
    runs,
    store,
    icons: { label: (type: string) => LABELS[type] },
  });
  const item = () => {
    assert.equal(statusBarItems.length, 1);
    return statusBarItems[0];
  };
  const storeChanged = (change: Partial<ConnectionsChange>) =>
    changes.fire({ added: [], removed: [], changed: [], ...change });
  return { entries, bindings, runs, bar, item, storeChanged };
}

describe("ConnectionStatusBar", () => {
  it("creates its item once, on the right at priority 100, named and clicking to Change Connection", () => {
    const { item } = setup();
    assert.equal(STATUS_ITEM, "libredb.connection");
    assert.equal(STATUS_ITEM_NAME, "LibreDB Connection");
    assert.equal(item().id, "libredb.connection");
    assert.equal(item().alignment, StatusBarAlignment.Right);
    assert.equal(item().priority, 100);
    assert.equal(item().name, "LibreDB Connection");
    assert.equal(item().command, "libredb.changeConnection");
  });

  it("is hidden with no active editor, and for an unbound active document", () => {
    const { item, bar } = setup();
    assert.equal(item().visible, false);
    setActiveTextEditor(editorAt(UNTITLED));
    assert.equal(item().visible, false);
    bar.refresh();
    assert.equal(item().visible, false);
  });

  it("names the bound connection and its engine, with the catalog when the binding has one", () => {
    const { item, bindings } = setup();
    setActiveTextEditor(editorAt(UNTITLED));
    bindings.bind(UNTITLED, { connectionId: PG.id });
    assert.equal(item().visible, true);
    assert.equal(item().text, "$(database) shop");
    assert.equal(item().tooltip, 'PostgreSQL connection "shop". Click to change.');
    bindings.bind(UNTITLED, { connectionId: PG.id, catalog: "sales" });
    assert.equal(item().text, "$(database) shop (sales)");
  });

  it("spins while the document holds a run, preparing or running, and only for its own run", () => {
    const { item, bindings, runs } = setup();
    bindings.bind(UNTITLED, { connectionId: PG.id, catalog: "sales" });
    setActiveTextEditor(editorAt(UNTITLED));
    const prepared = runs.prepare(UNTITLED, PG.id);
    assert.equal(item().text, "$(loading~spin) shop (sales)");
    const entry = runs.start(prepared, {
      queryId: "q1",
      catalog: "sales",
      statement: "select 1",
      limit: 500,
      cancellable: true,
    });
    assert.equal(item().text, "$(loading~spin) shop (sales)");
    runs.settle(entry);
    assert.equal(item().text, "$(database) shop (sales)");
    runs.prepare("untitled:Untitled-2", PG.id);
    assert.equal(item().text, "$(database) shop (sales)");
  });

  it("hides for an unbound active document and shows again for the bound one", () => {
    const { item, bindings } = setup();
    bindings.bind(UNTITLED, { connectionId: PG.id });
    setActiveTextEditor(editorAt(UNTITLED));
    assert.equal(item().visible, true);
    setActiveTextEditor(editorAt("untitled:Untitled-2"));
    assert.equal(item().visible, false);
    setActiveTextEditor(editorAt(UNTITLED));
    assert.equal(item().visible, true);
    assert.equal(item().text, "$(database) shop");
  });

  it("follows a renamed profile, and hides once its profile is removed", () => {
    const { item, bindings, entries, storeChanged } = setup();
    bindings.bind(UNTITLED, { connectionId: PG.id });
    setActiveTextEditor(editorAt(UNTITLED));
    entries.set(PG.id, { ...PG, name: "shop2" });
    storeChanged({ changed: [PG.id] });
    assert.equal(item().text, "$(database) shop2");
    entries.delete(PG.id);
    storeChanged({ removed: [PG.id] });
    assert.equal(item().visible, false);
  });

  it("disposes its item and stops following every source", () => {
    const { item, bar, bindings, runs, storeChanged } = setup();
    bar.dispose();
    assert.equal(item().disposed, true);
    const before = { shown: item().shown, hidden: item().hidden };
    setActiveTextEditor(editorAt(UNTITLED));
    bindings.bind(UNTITLED, { connectionId: PG.id });
    runs.prepare(UNTITLED, PG.id);
    storeChanged({ changed: [PG.id] });
    assert.deepEqual({ shown: item().shown, hidden: item().hidden }, before);
  });
});
