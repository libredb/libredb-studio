// The Connections tree's nodes (part 3, "The Connections tree"), their ids ("TreeItem ids") and their context values
// ("contextValue grammar and menus"). A node carries what its tree item shows, computed when the node is built, so
// neither the id nor the context value reads a ProviderDescription.
import type { Container, DatabaseObject, KindCount, ObjectKindSpec, ObjectRole } from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";
import type { ProfileEntry } from "../connections/profile";

export type NodeTag = "c" | "i" | "k" | "g" | "f" | "o" | "l" | "n" | "x";

interface NodeBase {
  readonly id: string;
  readonly connectionId: string;
  readonly parent?: TreeNode;
}

export type TreeNode =
  | (NodeBase & { readonly node: "connection"; readonly entry: ProfileEntry })
  /** connectionId is the entry's id when it has one, so Remove can delete it; a malformed entry has none. */
  | {
      readonly id: string;
      readonly node: "invalid";
      readonly connectionId?: string;
      readonly name?: string;
      readonly reason: string;
    }
  | (NodeBase & { readonly node: "container"; readonly container: Container; readonly levelLabel: string })
  | (NodeBase & {
      readonly node: "group";
      readonly containerPath: readonly string[];
      readonly group: { readonly id: string; readonly label: string };
      readonly kinds: readonly ObjectKindSpec[];
      readonly counts: Readonly<Record<string, KindCount>> | undefined;
    })
  | (NodeBase & {
      readonly node: "folder";
      readonly containerPath: readonly string[];
      readonly kind: ObjectKindSpec;
      readonly count?: KindCount;
    })
  | (NodeBase & {
      readonly node: "object";
      readonly object: DatabaseObject;
      readonly kindLabel: string;
      readonly role?: ObjectRole;
      readonly hasColumns: boolean;
    })
  | (NodeBase & { readonly node: "column"; readonly object: DatabaseObject; readonly column: ColumnSchema })
  | (NodeBase & { readonly node: "empty"; readonly label: string })
  | (NodeBase & { readonly node: "error"; readonly message: string; readonly code?: string });

/** [tag, ...segments], each encodeURIComponent'd, joined by "/": injective, and stable across refreshes and restarts. */
export function nodeId(tag: NodeTag, segments: readonly string[]): string {
  return [tag, ...segments].map(encodeURIComponent).join("/");
}

/** "libredb;node=<value>", plus ";role=<role>" on an object whose kind declares one; the only writer. */
export function contextValueOf(node: TreeNode): string {
  switch (node.node) {
    case "invalid":
      return `libredb;node=${node.connectionId === undefined ? "malformed" : "invalid"}`;
    case "object":
      return node.role === undefined ? "libredb;node=object" : `libredb;node=object;role=${node.role}`;
    default:
      return `libredb;node=${node.node}`;
  }
}

const NODE_VALUES: ReadonlySet<unknown> = new Set<TreeNode["node"]>([
  "connection",
  "invalid",
  "container",
  "group",
  "folder",
  "object",
  "column",
  "empty",
  "error",
]);

/** libredb.refresh's argument: undefined, or a tree node (an object with a string id and one of the nine node values); throws otherwise. */
export function refreshTarget(target: unknown): TreeNode | undefined {
  if (target === undefined) return undefined;
  if (
    typeof target === "object" &&
    target !== null &&
    typeof (target as { id?: unknown }).id === "string" &&
    NODE_VALUES.has((target as { node?: unknown }).node)
  ) {
    return target as TreeNode;
  }
  throw new Error("libredb.refresh takes a tree node or nothing.");
}
