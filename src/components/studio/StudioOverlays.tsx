"use client";

import React from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderCapabilities } from "@/lib/db/types";
import { MobileNav } from "@/components/MobileNav";
import { CommandPalette } from "@/components/CommandPalette";
import { ShortcutsDialog, type ShortcutsDialogRef } from "@/components/ShortcutsDialog";
import { CreateTableModal } from "@/components/CreateTableModal";
import { ChunkBoundary } from "@/components/LazyView";
import { lazyRetry } from "@/lib/lazy";
import { Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// The connection modal owns `framer-motion` (its expandable fields animate in and out),
// so it is split out of the shell's first load the same way the diagram is (X5). It is
// mounted only while a connection modal is actually on screen.
const ConnectionModal = React.lazy(
  lazyRetry(() => import("@/components/ConnectionModal").then((m) => ({ default: m.ConnectionModal }))),
);

/**
 * The overlays only the STANDALONE shell draws: the connection modal, the create-table modal,
 * the delete confirmation, the command palette, the shortcuts dialog and the mobile nav. They
 * live in their own file so `StudioWorkspace` never imports them — `CommandPalette` pulls
 * `cmdk` and the published workspace bundle must not.
 *
 * Not `React.memo` for the same reason `StudioModals` is not: the palette reads live props and
 * the dialogs are closed by default and render nothing, so a keystroke costs nothing measurable.
 */
interface StudioOverlaysProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  schema: readonly DetailedObject[];
  capabilities?: ProviderCapabilities;
  databaseType?: DatabaseConnection["type"];
  connectionModalOpen: boolean;
  editingConnection: DatabaseConnection | null;
  onCloseConnectionModal: () => void;
  onConnectConnection: (connection: DatabaseConnection) => void;
  createTableModalOpen: boolean;
  /** Where the table is created: the container path of the folder it was asked for in. */
  createTableContainer?: readonly string[];
  onCloseCreateTable: () => void;
  onTableCreated: (sql: string) => void;
  pendingDeleteConnectionId: string | null;
  onDeleteDialogOpenChange: (open: boolean) => void;
  deleteReturnFocus: { onOpenAutoFocus: () => void; onCloseAutoFocus: (event: Event) => void };
  onConfirmDelete: () => void;
  onSelectConnection: (connection: DatabaseConnection) => void;
  onTableClick: (path: readonly string[]) => void;
  onAddConnection: () => void;
  onExecuteQuery: () => void;
  onLoadSavedQuery: (query: string) => void;
  onLoadHistoryQuery: (query: string) => void;
  onNavigateMonitoring: () => void;
  onShowDiagram: () => void;
  onFormatQuery: () => void;
  onOpenSaveQuery: () => void;
  onAskAgent?: () => void;
  onShowShortcuts: () => void;
  onLogout: () => void;
  shortcutsDialogRef: React.RefObject<ShortcutsDialogRef | null>;
  activeMobileTab: "database" | "schema" | "editor";
  onMobileTabChange: (tab: "database" | "schema" | "editor") => void;
  hasResult: boolean;
  onOpenAgent?: () => void;
}

export function StudioOverlays({
  connections,
  activeConnection,
  schema,
  capabilities,
  databaseType,
  connectionModalOpen,
  editingConnection,
  onCloseConnectionModal,
  onConnectConnection,
  createTableModalOpen,
  createTableContainer,
  onCloseCreateTable,
  onTableCreated,
  pendingDeleteConnectionId,
  onDeleteDialogOpenChange,
  deleteReturnFocus,
  onConfirmDelete,
  onSelectConnection,
  onTableClick,
  onAddConnection,
  onExecuteQuery,
  onLoadSavedQuery,
  onLoadHistoryQuery,
  onNavigateMonitoring,
  onShowDiagram,
  onFormatQuery,
  onOpenSaveQuery,
  onAskAgent,
  onShowShortcuts,
  onLogout,
  shortcutsDialogRef,
  activeMobileTab,
  onMobileTabChange,
  hasResult,
  onOpenAgent,
}: StudioOverlaysProps) {
  const deleteConnectionName =
    connections.find((connection) => connection.id === pendingDeleteConnectionId)?.name || "This connection";

  return (
    <>
      {(connectionModalOpen || editingConnection !== null) && (
        // The dialog has no place of its own in the layout, so its failure notice covers
        // the shell the way the dialog would have, and Close hands the shell back.
        <ChunkBoundary label="The connection dialog" className="fixed inset-0 z-50" onDismiss={onCloseConnectionModal}>
          <React.Suspense fallback={null}>
            <ConnectionModal
              isOpen={connectionModalOpen}
              onClose={onCloseConnectionModal}
              onConnect={onConnectConnection}
              editConnection={editingConnection}
            />
          </React.Suspense>
        </ChunkBoundary>
      )}

      <CreateTableModal
        isOpen={createTableModalOpen}
        onClose={onCloseCreateTable}
        onTableCreated={onTableCreated}
        dbType={databaseType}
        container={createTableContainer}
        capabilities={capabilities}
      />

      {/* Delete Connection Confirmation */}
      <AlertDialog open={pendingDeleteConnectionId !== null} onOpenChange={onDeleteDialogOpenChange}>
        <AlertDialogContent
          className="bg-overlay border-hairline max-w-sm p-0 gap-0 overflow-hidden"
          {...deleteReturnFocus}
        >
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500/20 to-red-500/10 flex items-center justify-center shrink-0">
                <Trash2 strokeWidth={1.5} className="w-5 h-5 text-danger" />
              </div>
              <div className="flex-1 min-w-0">
                <AlertDialogTitle className="text-[0.8125rem] font-medium text-fg mb-1">
                  Delete connection?
                </AlertDialogTitle>
                <AlertDialogDescription className="text-xs text-fg-muted leading-relaxed">
                  <span className="text-fg-tertiary">{deleteConnectionName}</span> will be removed. This cannot be
                  undone.
                </AlertDialogDescription>
              </div>
            </div>
          </div>
          <div className="px-6 pb-6 flex gap-2">
            <AlertDialogCancel className="flex-1 h-9 bg-fill border-0 text-fg-tertiary text-xs font-medium hover:bg-fill-strong hover:text-fg dark:bg-fill dark:hover:bg-fill-strong">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmDelete}
              className="flex-1 h-9 bg-danger-solid border-0 text-white text-xs font-medium hover:bg-danger-solid-hover"
            >
              Delete
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <CommandPalette
        connections={connections}
        activeConnection={activeConnection}
        schema={schema}
        capabilities={capabilities}
        onSelectConnection={onSelectConnection}
        onTableClick={onTableClick}
        onAddConnection={onAddConnection}
        onExecuteQuery={onExecuteQuery}
        onLoadSavedQuery={onLoadSavedQuery}
        onLoadHistoryQuery={onLoadHistoryQuery}
        onNavigateHealth={onNavigateMonitoring}
        onNavigateMonitoring={onNavigateMonitoring}
        onShowDiagram={onShowDiagram}
        onFormatQuery={onFormatQuery}
        onSaveQuery={onOpenSaveQuery}
        onAskAgent={onAskAgent}
        onShowShortcuts={onShowShortcuts}
        onLogout={onLogout}
      />

      <ShortcutsDialog ref={shortcutsDialogRef} />

      <MobileNav
        activeTab={activeMobileTab}
        onTabChange={onMobileTabChange}
        hasResult={hasResult}
        // Absent while the runtime is off, so the nav carries no control that
        // would open a rail that does not exist.
        onOpenAgent={onOpenAgent}
      />
    </>
  );
}
