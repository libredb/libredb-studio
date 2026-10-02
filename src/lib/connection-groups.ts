import type { DatabaseConnection } from "@/lib/types";
import type { ConnectionGroup } from "@/lib/storage/types";

export interface ConnectionSection<T extends DatabaseConnection = DatabaseConnection> {
  /** Stable React key: "favorites", "connections", "ungrouped", or the group's id. */
  key: string;
  kind: "favorites" | "connections" | "group" | "ungrouped";
  label: string;
  /** Present only for a user group. */
  groupId?: string;
  /** Only a user group can be collapsed; its flag is stored with it. */
  collapsed: boolean;
  connections: T[];
}

/**
 * Lays the Connections panel out as sections (#1170). `connections` must already be in the
 * user's saved order (`applyConnectionOrder`): every section is cut from that one list, so a
 * row keeps its relative position in each section it appears in.
 *
 * A star is a mark, not a move: a starred row appears under Favorites and stays in its own
 * section. With no groups there is a single Connections section, as before; once any group
 * exists, connections in no group render under Ungrouped, which is hidden while empty. A
 * connection is in at most one group, so one named by two groups renders only in the first.
 */
export function buildConnectionSections<T extends DatabaseConnection>(
  connections: T[],
  groups: ConnectionGroup[],
  favoriteIds: Set<string>,
): ConnectionSection<T>[] {
  const sections: ConnectionSection<T>[] = [];

  const favorites = connections.filter((conn) => favoriteIds.has(conn.id));
  if (favorites.length > 0) {
    sections.push({
      key: "favorites",
      kind: "favorites",
      label: "Favorites",
      collapsed: false,
      connections: favorites,
    });
  }

  if (groups.length === 0) {
    sections.push({ key: "connections", kind: "connections", label: "Connections", collapsed: false, connections });
    return sections;
  }

  const placed = new Set<string>();
  for (const group of groups) {
    const members = new Set(group.connectionIds);
    const inGroup = connections.filter((conn) => members.has(conn.id) && !placed.has(conn.id));
    for (const conn of inGroup) placed.add(conn.id);
    sections.push({
      key: group.id,
      kind: "group",
      label: group.name,
      groupId: group.id,
      collapsed: group.collapsed,
      connections: inGroup,
    });
  }

  const ungrouped = connections.filter((conn) => !placed.has(conn.id));
  if (ungrouped.length > 0) {
    sections.push({
      key: "ungrouped",
      kind: "ungrouped",
      label: "Ungrouped",
      collapsed: false,
      connections: ungrouped,
    });
  }
  return sections;
}
