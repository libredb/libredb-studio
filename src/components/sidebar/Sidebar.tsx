"use client";

import React from "react";
import { DatabaseConnection } from "@/lib/types";
import type { DatabaseObject } from "@/lib/db/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { Plus, Zap, Layers, LoaderCircle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ObjectTree } from "@/components/object-tree";
import { GitHubRepoLink } from "@/components/github-repo-link";
import { getAppVersion } from "@/lib/app-version";
import { ConnectionsList } from "./ConnectionsList";

interface SidebarProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  onSelectConnection: (connection: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onEditConnection?: (conn: DatabaseConnection) => void;
  onDuplicateConnection?: (conn: DatabaseConnection) => void;
  onAddConnection: () => void;
  /** A row the reader activated, handed over whole: path, kind and the fields the tree loaded. */
  onObjectClick?: (object: DatabaseObject) => void;
  onShowDiagram?: () => void;
  /**
   * What the provider declares about this connection. The object tree is DRIVEN by the
   * declaration - the container levels decide what it reads first, and the kinds decide
   * which folders exist - so there is nothing to draw until it arrives.
   */
  metadata?: ProviderMetadata | null;
  /** The active connection reads no catalog until asked (#765). */
  objectScanDeferred?: boolean;
  /** Perform the read the active connection deferred. */
  onLoadObjects?: () => void;
}

export function Sidebar({
  connections,
  activeConnection,
  onSelectConnection,
  onDeleteConnection,
  onEditConnection,
  onDuplicateConnection,
  onAddConnection,
  onObjectClick,
  onShowDiagram,
  metadata,
  objectScanDeferred = false,
  onLoadObjects,
}: SidebarProps) {
  const appVersion = getAppVersion();

  return (
    <div className="flex w-full h-full border-r border-border flex-col bg-background select-none">
      <div className="h-14 px-4 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-brand-solid rounded flex items-center justify-center">
            <Zap strokeWidth={1.5} className="w-3 h-3 text-white fill-current" />
          </div>
          <span className="font-medium text-xs tracking-tight bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
            LibreDB Studio
          </span>
        </div>
        <div className="flex items-center gap-1">
          {activeConnection && (
            <button
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              onClick={onShowDiagram}
              title="Show ERD Diagram"
            >
              <Layers strokeWidth={1.5} className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            onClick={onAddConnection}
          >
            <Plus strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0 px-2 py-4">
        <div className="space-y-6">
          <ConnectionsList
            connections={connections}
            activeConnection={activeConnection}
            onSelectConnection={onSelectConnection}
            onDeleteConnection={onDeleteConnection}
            onEditConnection={onEditConnection}
            onDuplicateConnection={onDuplicateConnection}
            onAddConnection={onAddConnection}
          />

          {/*
            The object tree replaces the flat table list (#789). It reads the catalog
            itself, lazily, so the sidebar hands it the connection and the declaration and
            keeps no copy of what it found.

            Nothing is drawn while the declaration is missing, and that is not caution: an
            absent `containerLevels` reads as depth 0, which is a REAL answer for five
            engines, so a placeholder declaration would make a one-level engine read the
            counts of a container that does not exist instead of listing its schemas.
          */}
          {activeConnection &&
            (metadata ? (
              <div className="h-[60vh]">
                <ObjectTree
                  connection={activeConnection}
                  capabilities={metadata.capabilities}
                  deferred={objectScanDeferred}
                  onLoad={onLoadObjects}
                  onObjectClick={onObjectClick}
                />
              </div>
            ) : (
              <div
                data-testid="sidebar-provider-pending"
                className="flex flex-col items-center justify-center py-12 text-muted-foreground"
              >
                <LoaderCircle strokeWidth={1.5} className="w-6 h-6 animate-spin text-brand/40" />
                <span className="mt-3 text-xs font-medium">Reading the connection...</span>
              </div>
            ))}
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-border bg-card/50 backdrop-blur-md">
        <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/30 border border-border/50">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-hue-green-tint animate-pulse" />
            <span className="text-xs font-medium text-muted-foreground">Connected</span>
          </div>
          <div className="flex items-center gap-2">
            {/*
              The sidebar is the one piece of chrome BOTH modes render - the
              standalone app and the embedded workspace, which supplies its own
              header - so the invitation to the repository lives here to reach
              every user rather than only the standalone ones.
            */}
            <GitHubRepoLink className="text-muted-foreground/70 hover:text-foreground" />
            {appVersion && <span className="text-xs font-mono text-muted-foreground/70">v{appVersion}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
