// The Connections tree's items (part 3, "Levels", the count rules, and "Empty, failed and refused reads"): each node's
// label, description, tooltip, collapsible state, icon and context value. No item has a command: a click selects or
// expands, and every action is an explicit menu entry.
import * as vscode from "vscode";
import { isCountSampled, isCountUnavailable } from "@/lib/db/object-kinds";
import { objectPathLabel } from "@/lib/db/object-path";
import type { KindCount } from "@/lib/db/types";
import { describeEntry } from "../connections/remove-connection";
import { type EngineIcons, nodeIcon } from "./icons";
import { contextValueOf, type TreeNode } from "./nodes";

/** What the tree knows of a connection beside its node: open in the current generation, and the last open's failure. */
export interface ConnectionState {
  readonly connected: boolean;
  readonly failure?: string;
}

export const ERROR_LABEL_LIMIT = 200;
export const NOT_CONNECTED = "not connected";
const CONNECTED = "connected";
const CONNECTION_FAILED = "connection failed";

/** The web tree's formatCount (src/components/object-tree/flatten.ts), with a refused count as a description and a leaf. */
export function countPresentation(count: KindCount | undefined): {
  readonly description?: string;
  readonly tooltip?: string;
  readonly leaf: boolean;
} {
  if (count === undefined) return { leaf: false };
  if (isCountUnavailable(count)) return { description: "unavailable", tooltip: count.unavailable, leaf: true };
  const formatted = count.count.toLocaleString("en-US");
  if (!isCountSampled(count)) return { description: formatted, leaf: false };
  return {
    description: `${formatted}+`,
    tooltip: `At least ${formatted}: counted from ${count.sampledFrom}`,
    leaf: false,
  };
}

/** The connection's state word: the description shows the first two, the tooltip all three. */
function stateWord(state: ConnectionState | undefined): string {
  if (state?.connected) return CONNECTED;
  if (state?.failure !== undefined) return CONNECTION_FAILED;
  return NOT_CONNECTED;
}

/** Built with appendText only, between markdown paragraph breaks, so no name or address can inject a link. */
function connectionTooltip(
  node: Extract<TreeNode, { node: "connection" }>,
  icons: EngineIcons,
  state: ConnectionState | undefined,
): vscode.MarkdownString {
  const address = describeEntry(node.entry);
  const parts = [icons.label(node.entry.type), ...(address === "" ? [] : [address]), stateWord(state)];
  if (state?.failure !== undefined) parts.push(`Last open error: ${state.failure}`);
  const tooltip = new vscode.MarkdownString();
  parts.forEach((part, index) => {
    if (index > 0) tooltip.appendMarkdown("\n\n");
    tooltip.appendText(part);
  });
  return tooltip;
}

function columnTooltip(column: { name: string; type: string; nullable: boolean; isPrimary: boolean }): string {
  const nullability = column.nullable ? "nullable" : "not null";
  return `${column.name} ${column.type}, ${nullability}${column.isPrimary ? ", primary key" : ""}`;
}

/** The node's TreeItem: id, label, description, tooltip, collapsible state, icon and contextValue; never a command. */
export function treeItemOf(node: TreeNode, icons: EngineIcons, state: ConnectionState | undefined): vscode.TreeItem {
  const { None, Collapsed, Expanded } = vscode.TreeItemCollapsibleState;
  let item: vscode.TreeItem;
  switch (node.node) {
    case "connection": {
      item = new vscode.TreeItem(node.entry.name, Collapsed);
      const word = stateWord(state);
      if (word !== NOT_CONNECTED) item.description = word;
      item.tooltip = connectionTooltip(node, icons, state);
      item.iconPath = icons.iconPath(node.entry.type);
      break;
    }
    case "invalid":
      item = new vscode.TreeItem(node.name ?? "Invalid connection entry", None);
      item.description = "invalid";
      item.tooltip = node.reason;
      break;
    case "container":
      item = new vscode.TreeItem(node.container.name, node.container.isSessionDefault ? Expanded : Collapsed);
      item.description = node.levelLabel;
      item.tooltip = `${node.levelLabel} ${node.container.name}`;
      break;
    case "group":
      item = new vscode.TreeItem(node.group.label, Collapsed);
      break;
    case "folder": {
      const count = countPresentation(node.count);
      item = new vscode.TreeItem(node.kind.labelPlural, count.leaf ? None : Collapsed);
      item.description = count.description;
      item.tooltip = count.tooltip;
      break;
    }
    case "object":
      item = new vscode.TreeItem(node.object.name, node.hasColumns ? Collapsed : None);
      item.tooltip = `${node.kindLabel} ${objectPathLabel(node.object.path)}`;
      break;
    case "column":
      item = new vscode.TreeItem(node.column.name, None);
      item.description = node.column.type;
      item.tooltip = columnTooltip(node.column);
      break;
    case "empty":
      item = new vscode.TreeItem(node.label, None);
      break;
    case "error":
      item = new vscode.TreeItem(node.message.split("\n")[0].slice(0, ERROR_LABEL_LIMIT), None);
      item.tooltip = node.code === undefined ? node.message : `${node.message}\n\ncode: ${node.code}`;
      break;
  }
  item.id = node.id;
  item.contextValue = contextValueOf(node);
  if (node.node !== "connection") item.iconPath = nodeIcon(node);
  return item;
}
