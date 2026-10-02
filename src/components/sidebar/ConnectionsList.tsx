import React, { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, FolderPlus, MoreHorizontal } from "lucide-react";
import { DatabaseConnection } from "@/lib/types";
import { applyConnectionOrder } from "@/lib/connection-order";
import { buildConnectionSections, type ConnectionSection } from "@/lib/connection-groups";
import type { ConnectionGroup } from "@/lib/storage/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConnectionItem } from "./ConnectionItem";
import { GroupNameDialog } from "./GroupNameDialog";

interface ConnectionsListProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  onSelectConnection: (conn: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onEditConnection?: (conn: DatabaseConnection) => void;
  onDuplicateConnection?: (conn: DatabaseConnection) => void;
  /** Connection ids the user has starred. Renders as a "Favorites" group above the rest. */
  favoriteConnectionIds?: Set<string>;
  onToggleFavoriteConnection?: (id: string) => void;
  /** The user's saved custom order (#748). Absent means reordering is not wired up. */
  connectionOrder?: string[];
  /** Persists a new full order after a drag-and-drop completes. */
  onReorderConnections?: (order: string[]) => void;
  /**
   * The user's own sections (#1170). Group management is on only for the callbacks a parent
   * hands over: with none, the panel is the flat Connections list it always was.
   */
  connectionGroups?: ConnectionGroup[];
  /** Returns the new group's id, or null when the name was blank. */
  onCreateGroup?: (name: string) => string | null;
  onRenameGroup?: (id: string, name: string) => void;
  onDeleteGroup?: (id: string) => void;
  onToggleGroupCollapsed?: (id: string) => void;
  /** Files a connection under a group; null means Ungrouped. */
  onMoveConnectionToGroup?: (connectionId: string, groupId: string | null) => void;
  onAddConnection: () => void;
}

type NameDialog = { mode: "create"; moveConnectionId?: string } | { mode: "rename"; groupId: string; name: string };

/** Section header matching the "Connections" label + divider style already used below. */
function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
  actions,
}: {
  label: string;
  count?: number;
  /** Defined only for a collapsible section. */
  collapsed?: boolean;
  onToggle?: () => void;
  actions?: React.ReactNode;
}) {
  const text = (
    <span className="text-xs font-medium text-muted-foreground">
      {label}
      {count !== undefined && <span className="ml-1.5 font-normal text-muted-foreground/60">{count}</span>}
    </span>
  );
  return (
    <div className="px-3 mb-2 flex items-center justify-between">
      {onToggle ? (
        <button
          className="flex items-center gap-1 rounded hover:text-foreground"
          aria-expanded={!collapsed}
          aria-label={`${label} group`}
          onClick={onToggle}
        >
          {collapsed ? (
            <ChevronRight strokeWidth={1.5} className="w-3 h-3 text-muted-foreground" />
          ) : (
            <ChevronDown strokeWidth={1.5} className="w-3 h-3 text-muted-foreground" />
          )}
          {text}
        </button>
      ) : (
        text
      )}
      <div className="h-[1px] flex-1 bg-border/30 ml-3" />
      {actions}
    </div>
  );
}

export const ConnectionsList = React.memo(function ConnectionsList({
  connections,
  activeConnection,
  onSelectConnection,
  onDeleteConnection,
  onEditConnection,
  onDuplicateConnection,
  favoriteConnectionIds,
  onToggleFavoriteConnection,
  connectionOrder,
  onReorderConnections,
  connectionGroups,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onToggleGroupCollapsed,
  onMoveConnectionToGroup,
  onAddConnection,
}: ConnectionsListProps) {
  const ordered = applyConnectionOrder(connections, connectionOrder ?? []);
  const reorderable = onReorderConnections !== undefined;
  const groups = connectionGroups ?? [];
  const sections = buildConnectionSections(ordered, groups, favoriteConnectionIds ?? new Set());
  const groupOf = (connectionId: string) => groups.find((g) => g.connectionIds.includes(connectionId))?.id ?? null;

  // Drag state lives here, not in ConnectionItem: a drop needs the full ordered list to
  // compute the new order, and only this component holds it. A starred row renders in two
  // sections, so a row is identified by its section too, or both copies would highlight.
  const [dragged, setDragged] = useState<{ sectionKey: string; id: string } | null>(null);
  const [dragOver, setDragOver] = useState<{ sectionKey: string; id: string } | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);

  const clearDragState = useCallback(() => {
    setDragged(null);
    setDragOver(null);
  }, []);

  const handleDrop = (sectionKey: string, targetId: string) => {
    // A drop across sections is ignored. The dragged row stays in its own section either way,
    // so accepting it would only change the saved order in a way nothing on screen shows.
    if (dragged !== null && dragged.sectionKey === sectionKey && dragged.id !== targetId) {
      const ids = ordered.map((c) => c.id);
      const fromIndex = ids.indexOf(dragged.id);
      const toIndex = ids.indexOf(targetId);
      if (fromIndex !== -1 && toIndex !== -1) {
        const reordered = [...ids];
        const [moved] = reordered.splice(fromIndex, 1);
        reordered.splice(toIndex, 0, moved);
        onReorderConnections?.(reordered);
      }
    }
    clearDragState();
  };

  const groupsManaged = onMoveConnectionToGroup !== undefined;

  const renderItem = (conn: DatabaseConnection, section: ConnectionSection) => (
    <ConnectionItem
      key={conn.id}
      connection={conn}
      isActive={activeConnection?.id === conn.id}
      onSelect={onSelectConnection}
      onDelete={onDeleteConnection}
      onEdit={onEditConnection}
      onDuplicate={onDuplicateConnection}
      isFavorite={favoriteConnectionIds?.has(conn.id) ?? false}
      onToggleFavorite={onToggleFavoriteConnection}
      groups={groupsManaged ? groups : undefined}
      currentGroupId={groupOf(conn.id)}
      onMoveToGroup={onMoveConnectionToGroup}
      onMoveToNewGroup={
        groupsManaged && onCreateGroup ? (id) => setNameDialog({ mode: "create", moveConnectionId: id }) : undefined
      }
      draggable={reorderable && section.connections.length > 1}
      isDragging={dragged?.sectionKey === section.key && dragged.id === conn.id}
      isDragOver={
        dragOver?.sectionKey === section.key &&
        dragOver.id === conn.id &&
        dragged !== null &&
        dragged.sectionKey === section.key &&
        dragged.id !== conn.id
      }
      onDragStart={() => setDragged({ sectionKey: section.key, id: conn.id })}
      onDragEnter={() => setDragOver({ sectionKey: section.key, id: conn.id })}
      onDragEnd={clearDragState}
      onDrop={() => handleDrop(section.key, conn.id)}
    />
  );

  // The "New group" button sits on the first section that is not Favorites, so it is always
  // reachable: that is the Connections section until a group exists, and the first group after.
  const newGroupHost = sections.find((section) => section.kind !== "favorites")?.key;

  const renderActions = (section: ConnectionSection) => (
    <>
      {onCreateGroup && section.key === newGroupHost && (
        <button
          className="ml-2 p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="New group"
          title="New group"
          onClick={() => setNameDialog({ mode: "create" })}
        >
          <FolderPlus strokeWidth={1.5} className="w-3 h-3" />
        </button>
      )}
      {section.kind === "group" && (onRenameGroup || onDeleteGroup) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="ml-1 p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={`Options for ${section.label}`}
            >
              <MoreHorizontal strokeWidth={1.5} className="w-3 h-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onRenameGroup && (
              <DropdownMenuItem
                onSelect={() => setNameDialog({ mode: "rename", groupId: section.groupId!, name: section.label })}
              >
                Rename
              </DropdownMenuItem>
            )}
            {onDeleteGroup && (
              <DropdownMenuItem onSelect={() => onDeleteGroup(section.groupId!)}>Delete group</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );

  return (
    <>
      {sections.map((section) => (
        <section key={section.key} className="mb-4 last:mb-0">
          <SectionHeader
            label={section.label}
            count={section.kind === "connections" ? undefined : section.connections.length}
            collapsed={section.kind === "group" ? section.collapsed : undefined}
            onToggle={
              section.kind === "group" && onToggleGroupCollapsed
                ? () => onToggleGroupCollapsed(section.groupId!)
                : undefined
            }
            actions={renderActions(section)}
          />

          {!(section.kind === "group" && section.collapsed) && (
            <div className="space-y-0.5">
              {section.kind === "connections" && connections.length === 0 ? (
                <div className="px-3 py-6 text-center border border-dashed border-border/50 rounded-lg mx-2">
                  <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                    No database connections established yet.
                  </p>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAddConnection}>
                    Add Connection
                  </Button>
                </div>
              ) : (
                section.connections.map((conn) => renderItem(conn, section))
              )}
            </div>
          )}
        </section>
      ))}

      {nameDialog?.mode === "create" && onCreateGroup && (
        <GroupNameDialog
          title="New group"
          submitLabel="Create"
          onClose={() => setNameDialog(null)}
          onSubmit={(name) => {
            const id = onCreateGroup(name);
            if (id !== null && nameDialog.moveConnectionId !== undefined) {
              onMoveConnectionToGroup?.(nameDialog.moveConnectionId, id);
            }
            setNameDialog(null);
          }}
        />
      )}
      {nameDialog?.mode === "rename" && onRenameGroup && (
        <GroupNameDialog
          title="Rename group"
          submitLabel="Rename"
          initialName={nameDialog.name}
          onClose={() => setNameDialog(null)}
          onSubmit={(name) => {
            onRenameGroup(nameDialog.groupId, name);
            setNameDialog(null);
          }}
        />
      )}
    </>
  );
});
