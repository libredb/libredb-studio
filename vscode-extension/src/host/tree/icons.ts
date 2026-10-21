// The Connections tree's icons (part 3, "Icons"): each engine's logo and label from media/engines/index.json, which
// scripts/engine-icons.tsx writes at build time, and the codicon of every other node. The engine lookup is membership in
// that generated file, never a branch on a type id.
import * as vscode from "vscode";
import type { ObjectRole } from "@/lib/db/types";
import type { TreeNode } from "./nodes";

/** media/engines/index.json as the build wrote it. */
export type EngineIndex = Readonly<Record<string, { readonly label: string }>>;

function notAnIndex(why: string): Error {
  return new Error(`media/engines/index.json is not an engine index: ${why}.`);
}

/** Parses the file's text; throws "media/engines/index.json is not an engine index: <why>." on anything but an object of { label: string } objects. */
export function readEngineIndex(text: string): EngineIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw notAnIndex((error as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw notAnIndex("it is not an object");
  for (const [type, entry] of Object.entries(parsed)) {
    if (typeof entry !== "object" || entry === null || typeof (entry as { label?: unknown }).label !== "string") {
      throw notAnIndex(`${type} has no string label`);
    }
  }
  return parsed as EngineIndex;
}

export class EngineIcons {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: EngineIndex,
  ) {}

  /** The two generated files of the type; throws like label() when the index does not hold it, with no fallback. */
  iconPath(type: string): { readonly light: vscode.Uri; readonly dark: vscode.Uri } {
    this.entry(type);
    return {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "engines", `${type}.light.svg`),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "engines", `${type}.dark.svg`),
    };
  }

  /** The engine label; throws when the index does not hold the type, since the build refuses to write one without it. */
  label(type: string): string {
    return this.entry(type).label;
  }

  /** The index's entry for the type; membership in a generated file, not a branch on a type id. */
  private entry(type: string): { readonly label: string } {
    if (!Object.hasOwn(this.index, type)) {
      throw new Error(`media/engines/index.json has no label for ${type}; rebuild the extension.`);
    }
    return this.index[type];
  }
}

/** Each role's codicon (builder's call in part 3): exhaustive, so a role LibreDB adds fails the typecheck. */
export const ROLE_ICONS: Readonly<Record<ObjectRole, string>> = {
  relation: "table",
  routine: "symbol-method",
  attached: "symbol-method",
  group: "folder-library",
  config: "file-code",
};

/** Every node but a connection, whose icon is its engine logo from EngineIcons. */
export type IconNode = Exclude<TreeNode, { readonly node: "connection" }>;

/** The codicon of every node but a connection; undefined for an empty node and an object with no role. */
export function nodeIcon(node: IconNode): vscode.ThemeIcon | undefined {
  switch (node.node) {
    case "invalid":
      return new vscode.ThemeIcon("error");
    case "container":
      return new vscode.ThemeIcon("symbol-namespace");
    case "group":
    case "folder":
      return new vscode.ThemeIcon("folder");
    case "object":
      return node.role === undefined ? undefined : new vscode.ThemeIcon(ROLE_ICONS[node.role]);
    case "column":
      return new vscode.ThemeIcon(node.column.isPrimary ? "key" : "symbol-field");
    case "empty":
      return undefined;
    case "error":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("list.errorForeground"));
  }
}
