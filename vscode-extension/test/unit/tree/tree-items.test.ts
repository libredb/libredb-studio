import assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { KindCount, ObjectKindSpec } from "@/lib/db/types";
import type { ProfileEntry } from "../../../src/host/connections/profile";
import { EngineIcons } from "../../../src/host/tree/icons";
import { nodeId, type TreeNode } from "../../../src/host/tree/nodes";
import {
  type ConnectionState,
  countPresentation,
  ERROR_LABEL_LIMIT,
  NOT_CONNECTED,
  treeItemOf,
} from "../../../src/host/tree/tree-items";
import { PG } from "../../fakes/profiles";
import { MarkdownString, ThemeIcon, TreeItemCollapsibleState, Uri } from "../../fakes/vscode";

const icons = new EngineIcons(Uri.file("/ext"), {
  postgres: { label: "PostgreSQL" },
  mongodb: { label: "MongoDB" },
});

const TABLE: ObjectKindSpec = {
  id: "table",
  role: "relation",
  label: "Table",
  labelPlural: "Tables",
  hasColumns: true,
};
const ORDERS = { path: ["public", "orders"], name: "orders", kind: "table" };

/** Every item a case built, with its node, so the last case can hold all of them to the id and command rules. */
const built: [TreeNode, vscode.TreeItem][] = [];

function item(node: TreeNode, state?: ConnectionState): vscode.TreeItem {
  const answer = treeItemOf(node, icons, state);
  built.push([node, answer]);
  return answer;
}

function connectionNode(entry: ProfileEntry): TreeNode {
  return { id: nodeId("c", [entry.id]), node: "connection", connectionId: entry.id, entry };
}

const pgNode = connectionNode(PG);

function containerNode(isSessionDefault?: boolean): TreeNode {
  return {
    id: nodeId("k", [PG.id, "public"]),
    node: "container",
    connectionId: PG.id,
    parent: pgNode,
    container: { path: ["public"], name: "public", level: 0, isSessionDefault },
    levelLabel: "Schema",
  };
}

function folderNode(count?: KindCount): TreeNode {
  return {
    id: nodeId("f", [PG.id, "public", "table"]),
    node: "folder",
    connectionId: PG.id,
    containerPath: ["public"],
    kind: TABLE,
    count,
  };
}

function objectNode(hasColumns: boolean, object = ORDERS): TreeNode {
  return {
    id: nodeId("o", [PG.id, ...object.path, object.kind]),
    node: "object",
    connectionId: PG.id,
    object,
    kindLabel: "Table",
    role: "relation",
    hasColumns,
  };
}

function columnNode(column: { name: string; type: string; nullable: boolean; isPrimary: boolean }): TreeNode {
  return {
    id: nodeId("l", [PG.id, ...ORDERS.path, ORDERS.kind, column.name]),
    node: "column",
    connectionId: PG.id,
    object: ORDERS,
    column,
  };
}

function errorNode(message: string, code?: string): TreeNode {
  return { id: nodeId("x", ["f/c1/public/table"]), node: "error", connectionId: PG.id, message, code };
}

function tooltipParts(answer: vscode.TreeItem): MarkdownString["parts"] {
  assert.ok(answer.tooltip instanceof MarkdownString);
  return answer.tooltip.parts;
}

/** How many items the cases above build, so a case that builds none fails the last one. */
const BUILT_COUNT = 22;

const SEPARATOR = { kind: "markdown", value: "\n\n" } as const;
const text = (value: string) => ({ kind: "text", value }) as const;

describe("tree items", () => {
  describe("a connection", () => {
    it("draws a closed connection with its logo, its context value and no description or command", () => {
      const answer = item(pgNode);
      assert.equal(answer.id, "c/1kq2v7x93j0ab");
      assert.equal(answer.label, "shop");
      assert.equal(answer.description, undefined);
      assert.equal(answer.collapsibleState, TreeItemCollapsibleState.Collapsed);
      assert.equal((answer.iconPath as { light: vscode.Uri }).light.fsPath, "/ext/media/engines/postgres.light.svg");
      assert.equal(answer.contextValue, "libredb;node=connection");
      assert.equal(answer.command, undefined);
      assert.deepEqual(tooltipParts(answer), [
        text("PostgreSQL"),
        SEPARATOR,
        text("app@localhost:5432/shop"),
        SEPARATOR,
        text(NOT_CONNECTED),
      ]);
      assert.equal((answer.tooltip as MarkdownString).isTrusted, undefined);
    });

    it("says connected in the description and the tooltip", () => {
      const answer = item(pgNode, { connected: true });
      assert.equal(answer.description, "connected");
      assert.deepEqual(tooltipParts(answer).at(-1), text("connected"));
    });

    it("says connection failed and carries the last open error", () => {
      const answer = item(pgNode, { connected: false, failure: "connect ECONNREFUSED 127.0.0.1:5432" });
      assert.equal(answer.description, "connection failed");
      assert.deepEqual(tooltipParts(answer).slice(-3), [
        text("connection failed"),
        SEPARATOR,
        text("Last open error: connect ECONNREFUSED 127.0.0.1:5432"),
      ]);
    });

    it("leaves out an empty address", () => {
      const bare: ProfileEntry = { id: "b1", name: "bare", type: "mongodb", createdAt: PG.createdAt };
      assert.deepEqual(tooltipParts(item(connectionNode(bare))), [text("MongoDB"), SEPARATOR, text(NOT_CONNECTED)]);
    });

    it("puts a name that looks like a command link into a text part only", () => {
      const name = "[x](command:libredb.removeConnection)";
      const answer = item(connectionNode({ ...PG, name, user: name }));
      assert.equal(answer.label, name);
      const parts = tooltipParts(answer);
      assert.ok(parts.some((part) => part.kind === "text" && part.value.includes(name)));
      for (const part of parts.filter((each) => each.kind === "markdown")) assert.equal(part.value, "\n\n");
    });
  });

  describe("an invalid entry", () => {
    it("shows its name, the word invalid and the reason", () => {
      const answer = item({ id: "i/1", node: "invalid", connectionId: "bad1", name: "bad", reason: "R" });
      assert.equal(answer.label, "bad");
      assert.equal(answer.description, "invalid");
      assert.equal(answer.tooltip, "R");
      assert.equal(answer.collapsibleState, TreeItemCollapsibleState.None);
      assert.equal((answer.iconPath as ThemeIcon).id, "error");
      assert.equal(answer.contextValue, "libredb;node=invalid");
    });

    it("names an entry with no usable name", () => {
      assert.equal(item({ id: "i/2", node: "invalid", reason: "S" }).label, "Invalid connection entry");
    });
  });

  describe("a container", () => {
    it("shows the level word, opens the session default and closes the rest", () => {
      const open = item(containerNode(true));
      assert.equal(open.label, "public");
      assert.equal(open.description, "Schema");
      assert.equal(open.tooltip, "Schema public");
      assert.equal(open.collapsibleState, TreeItemCollapsibleState.Expanded);
      assert.equal((open.iconPath as ThemeIcon).id, "symbol-namespace");
      assert.equal(item(containerNode()).collapsibleState, TreeItemCollapsibleState.Collapsed);
    });
  });

  describe("a group", () => {
    it("shows its label, no description and a folder", () => {
      const answer = item({
        id: nodeId("g", [PG.id, "public", "programmability"]),
        node: "group",
        connectionId: PG.id,
        containerPath: ["public"],
        group: { id: "programmability", label: "Programmability" },
        kinds: [],
        counts: undefined,
      });
      assert.equal(answer.label, "Programmability");
      assert.equal(answer.description, undefined);
      assert.equal(answer.collapsibleState, TreeItemCollapsibleState.Collapsed);
      assert.equal((answer.iconPath as ThemeIcon).id, "folder");
    });
  });

  describe("a folder", () => {
    it("formats a count", () => {
      const answer = item(folderNode({ count: 1234 }));
      assert.equal(answer.label, "Tables");
      assert.equal(answer.description, "1,234");
      assert.equal(answer.tooltip, undefined);
      assert.equal(answer.collapsibleState, TreeItemCollapsibleState.Collapsed);
    });

    it("marks a sampled count as a lower bound", () => {
      const answer = item(folderNode({ count: 1000, sampledFrom: "pg_class.reltuples" }));
      assert.equal(answer.description, "1,000+");
      assert.equal(answer.tooltip, "At least 1,000: counted from pg_class.reltuples");
    });

    it("draws a refused count as a leaf with the engine's sentence", () => {
      const sentence = "Counting views needs the VIEW SERVER STATE permission.";
      const answer = item(folderNode({ unavailable: sentence }));
      assert.equal(answer.description, "unavailable");
      assert.equal(answer.tooltip, sentence);
      assert.equal(answer.collapsibleState, TreeItemCollapsibleState.None);
    });

    it("shows nothing for a kind the counts left out", () => {
      const answer = item(folderNode());
      assert.equal(answer.description, undefined);
      assert.equal(answer.collapsibleState, TreeItemCollapsibleState.Collapsed);
    });

    it("answers countPresentation for each count shape", () => {
      assert.deepEqual(countPresentation(undefined), { leaf: false });
      assert.deepEqual(countPresentation({ count: 7 }), { description: "7", leaf: false });
    });
  });

  describe("an object", () => {
    it("shows its name, its kind and path, and a twisty when its kind has columns", () => {
      const answer = item(objectNode(true));
      assert.equal(answer.label, "orders");
      assert.equal(answer.tooltip, "Table public.orders");
      assert.equal(answer.collapsibleState, TreeItemCollapsibleState.Collapsed);
      assert.equal((answer.iconPath as ThemeIcon).id, "table");
      assert.equal(answer.contextValue, "libredb;node=object;role=relation");
      assert.equal(item(objectNode(false)).collapsibleState, TreeItemCollapsibleState.None);
    });

    it("shows the object's name rather than its last path segment", () => {
      const routine = { path: ["app", "order_total(integer)"], name: "order_total", kind: "table" };
      assert.equal(item(objectNode(false, routine)).label, "order_total");
    });
  });

  describe("a column", () => {
    it("shows a primary key column's type, nullability and key", () => {
      const answer = item(columnNode({ name: "id", type: "integer", nullable: false, isPrimary: true }));
      assert.equal(answer.label, "id");
      assert.equal(answer.description, "integer");
      assert.equal(answer.tooltip, "id integer, not null, primary key");
      assert.equal(answer.collapsibleState, TreeItemCollapsibleState.None);
      assert.equal((answer.iconPath as ThemeIcon).id, "key");
    });

    it("shows a nullable column", () => {
      const answer = item(columnNode({ name: "label", type: "varchar(20)", nullable: true, isPrimary: false }));
      assert.equal(answer.tooltip, "label varchar(20), nullable");
      assert.equal((answer.iconPath as ThemeIcon).id, "symbol-field");
    });
  });

  describe("an empty node", () => {
    it("shows its label and no icon", () => {
      const answer = item({
        id: nodeId("n", ["f/c1/public/table"]),
        node: "empty",
        connectionId: PG.id,
        label: "No Tables",
      });
      assert.equal(answer.label, "No Tables");
      assert.equal(answer.collapsibleState, TreeItemCollapsibleState.None);
      assert.equal(answer.iconPath, undefined);
    });
  });

  describe("an error node", () => {
    it("shows the first line and keeps the whole message and the code in the tooltip", () => {
      const answer = item(errorNode('relation "x" does not exist\nLINE 1: select', "QUERY_ERROR"));
      assert.equal(answer.label, 'relation "x" does not exist');
      assert.equal(answer.tooltip, 'relation "x" does not exist\nLINE 1: select\n\ncode: QUERY_ERROR');
      assert.equal(answer.collapsibleState, TreeItemCollapsibleState.None);
      assert.equal((answer.iconPath as ThemeIcon).color?.id, "list.errorForeground");
    });

    it("cuts a long line at the limit", () => {
      const answer = item(errorNode("e".repeat(300)));
      assert.equal(ERROR_LABEL_LIMIT, 200);
      assert.equal(answer.label, "e".repeat(200));
      assert.equal(answer.tooltip, "e".repeat(300));
    });
  });

  // A suite of its own, last: mocha runs a suite's own cases before its child suites.
  describe("every item above", () => {
    it("carries its node's id and no command", () => {
      assert.equal(built.length, BUILT_COUNT);
      for (const [node, answer] of built) {
        assert.equal(answer.id, node.id);
        assert.equal(answer.command, undefined);
      }
    });
  });
});
