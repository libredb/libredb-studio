"use client";

import React from 'react';
import { DatabaseConnection, TableSchema } from '@/lib/types';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';
import { Plus, Zap, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SchemaExplorer } from '@/components/schema-explorer';
import { ConnectionsList } from './ConnectionsList';

interface SidebarProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  schema: TableSchema[];
  isLoadingSchema: boolean;
  onSelectConnection: (connection: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onEditConnection?: (conn: DatabaseConnection) => void;
  onAddConnection: () => void;
  onTableClick?: (tableName: string) => void;
  onGenerateSelect?: (tableName: string) => void;
  onCreateTableClick?: () => void;
  onShowDiagram?: () => void;
  isAdmin?: boolean;
  onOpenMaintenance?: (tab?: 'global' | 'tables' | 'sessions', table?: string) => void;
  databaseType?: string;
  metadata?: ProviderMetadata | null;
  onProfileTable?: (tableName: string) => void;
  onGenerateCode?: (tableName: string) => void;
  onGenerateTestData?: (tableName: string) => void;
}

export function Sidebar({
  connections,
  activeConnection,
  schema,
  isLoadingSchema,
  onSelectConnection,
  onDeleteConnection,
  onEditConnection,
  onAddConnection,
  onTableClick,
  onGenerateSelect,
  onCreateTableClick,
  onShowDiagram,
  isAdmin = false,
  onOpenMaintenance,
  databaseType,
  metadata,
  onProfileTable,
  onGenerateCode,
  onGenerateTestData,
}: SidebarProps) {
  return (
    <div className="flex w-full h-full border-r border-border flex-col bg-background select-none">
      <div className="h-14 px-4 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-blue-600 rounded flex items-center justify-center">
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
            onAddConnection={onAddConnection}
          />

          {activeConnection && (
            <SchemaExplorer
              schema={schema}
              isLoadingSchema={isLoadingSchema}
              onTableClick={onTableClick}
              onGenerateSelect={onGenerateSelect}
              onCreateTableClick={onCreateTableClick}
              isAdmin={isAdmin}
              onOpenMaintenance={onOpenMaintenance}
              databaseType={databaseType}
              metadata={metadata}
              onProfileTable={onProfileTable}
              onGenerateCode={onGenerateCode}
              onGenerateTestData={onGenerateTestData}
            />
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-border bg-card/50 backdrop-blur-md">
        <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/30 border border-border/50">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs font-medium text-muted-foreground">Connected</span>
          </div>
          <span className="text-xs font-mono text-muted-foreground/70">v1.2.5</span>
        </div>
      </div>
    </div>
  );
}
