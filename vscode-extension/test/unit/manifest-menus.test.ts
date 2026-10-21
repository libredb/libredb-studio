import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObjectKindSpec, ObjectRole } from "@/lib/db/types";
import { COMMANDS, CONNECTIONS_VIEW, VIEW_CONTAINER } from "../../src/host/names";
import { contextValueOf, type TreeNode } from "../../src/host/tree/nodes";
import { PG } from "../fakes/profiles";

interface MenuEntry {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
}

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));
const menus: Record<string, MenuEntry[]> = manifest.contributes.menus;
const entries = Object.values(menus).flat();
const commandIds = new Set<string>(Object.values(COMMANDS));

const TABLE: ObjectKindSpec = { id: "table", role: "relation", label: "Table", labelPlural: "Tables" };
const ORDERS = { path: ["public", "orders"], name: "orders", kind: "table" };
const connection: TreeNode = { id: "c/1kq2v7x93j0ab", node: "connection", connectionId: PG.id, entry: PG };

function objectNode(role: ObjectRole | undefined): TreeNode {
  return {
    id: "o/1kq2v7x93j0ab/public/orders/table",
    node: "object",
    connectionId: PG.id,
    object: ORDERS,
    kindLabel: "Table",
    role,
    hasColumns: true,
  };
}

/** One node per node value and per role, by a name the cases below use. */
const NODES: Record<string, TreeNode> = {
  connection,
  invalid: { id: "i/1", node: "invalid", connectionId: "bad1", name: "bad", reason: "R" },
  malformed: { id: "i/2", node: "invalid", reason: "S" },
  container: {
    id: "k/1kq2v7x93j0ab/public",
    node: "container",
    connectionId: PG.id,
    parent: connection,
    container: { path: ["public"], name: "public", level: 0 },
    levelLabel: "Schema",
  },
  group: {
    id: "g/1kq2v7x93j0ab/public/programmability",
    node: "group",
    connectionId: PG.id,
    containerPath: ["public"],
    group: { id: "programmability", label: "Programmability" },
    kinds: [],
    counts: undefined,
  },
  folder: {
    id: "f/1kq2v7x93j0ab/public/table",
    node: "folder",
    connectionId: PG.id,
    containerPath: ["public"],
    kind: TABLE,
  },
  "object;role=relation": objectNode("relation"),
  "object;role=routine": objectNode("routine"),
  "object;role=group": objectNode("group"),
  "object;role=attached": objectNode("attached"),
  "object;role=config": objectNode("config"),
  object: objectNode(undefined),
  column: {
    id: "l/1kq2v7x93j0ab/public/orders/table/id",
    node: "column",
    connectionId: PG.id,
    object: ORDERS,
    column: { name: "id", type: "integer", nullable: false, isPrimary: true },
  },
  empty: { id: "n/f%2F1", node: "empty", connectionId: PG.id, label: "No Tables" },
  error: { id: "x/f%2F1", node: "error", connectionId: PG.id, message: "boom" },
};

/** The names of the nodes whose context value the entry's viewItem regex matches. */
function matched(entry: MenuEntry): string[] {
  const source = /viewItem =~ \/(.+)\/$/.exec(entry.when ?? "")?.[1];
  if (source === undefined) throw new Error(`${entry.command} has no viewItem regex`);
  const pattern = new RegExp(source);
  return Object.entries(NODES)
    .filter(([, node]) => pattern.test(contextValueOf(node)))
    .map(([name]) => name);
}

function contextEntry(command: string): MenuEntry {
  const found = menus["view/item/context"].find((entry) => entry.command === command);
  if (found === undefined) throw new Error(`no context menu entry for ${command}`);
  return found;
}

describe("the manifest's menus", () => {
  it("names only commands of COMMANDS that the manifest contributes, and contributes no command without its constant", () => {
    const contributed: string[] = manifest.contributes.commands.map((each: { command: string }) => each.command);
    for (const entry of entries) {
      assert.ok(commandIds.has(entry.command), entry.command);
      assert.ok(contributed.includes(entry.command), entry.command);
    }
    assert.deepEqual([...contributed].sort(), [...commandIds].sort());
  });

  it("names only the Connections view in a when clause, which is the first view of the LibreDB container", () => {
    const views = entries.flatMap((entry) => [...(entry.when ?? "").matchAll(/view == ([\w.]+)/g)].map((m) => m[1]));
    assert.equal(views.length, entries.length);
    assert.deepEqual(new Set(views), new Set([CONNECTIONS_VIEW]));
    assert.equal(manifest.contributes.views[VIEW_CONTAINER][0].id, CONNECTIONS_VIEW);
  });

  it("offers Refresh on the connection, container, folder and object nodes, with or without a role (criterion 10)", () => {
    assert.deepEqual(matched(contextEntry(COMMANDS.refresh)), [
      "connection",
      "container",
      "folder",
      "object;role=relation",
      "object;role=routine",
      "object;role=group",
      "object;role=attached",
      "object;role=config",
      "object",
    ]);
  });

  it("offers Remove on the connection node and on an invalid entry with an id, never on a malformed one", () => {
    assert.deepEqual(matched(contextEntry(COMMANDS.removeConnection)), ["connection", "invalid"]);
  });

  it("puts Add Connection then Refresh in the view's title bar, and contributes no keybinding", () => {
    assert.deepEqual(menus["view/title"], [
      { command: COMMANDS.addConnection, when: `view == ${CONNECTIONS_VIEW}`, group: "navigation@1" },
      { command: COMMANDS.refresh, when: `view == ${CONNECTIONS_VIEW}`, group: "navigation@2" },
    ]);
    assert.deepEqual(Object.keys(menus), ["view/title", "view/item/context"]);
    assert.equal(manifest.contributes.keybindings, undefined);
  });
});
