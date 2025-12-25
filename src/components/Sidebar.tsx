"use client";

import React from 'react';
import { DatabaseConnection, TableSchema } from '@/lib/types';
import { Plus, Database, HardDrive, Cpu, Cloud, Trash2, Zap, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import { SchemaExplorer } from './SchemaExplorer';

interface ConnectionsListProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  onSelectConnection: (conn: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onAddConnection: () => void;
}

export function ConnectionsList({ 
  connections, 
  activeConnection, 
  onSelectConnection, 
  onDeleteConnection, 
  onAddConnection 
}: ConnectionsListProps) {
  return (
    <section>
      <div className="px-3 mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
          Connections
        </span>
        <div className="h-[1px] flex-1 bg-border/30 ml-3" />
      </div>

      <div className="space-y-0.5">
        {connections.length === 0 ? (
          <div className="px-3 py-6 text-center border border-dashed border-border/50 rounded-lg mx-2">
            <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">No database connections established yet.</p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              onClick={onAddConnection}
            >
              Add Connection
            </Button>
          </div>
        ) : (
          connections.map((conn) => (
            <motion.div
              key={conn.id}
              initial={false}
              className={cn(
                "group flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-all duration-200 text-sm relative overflow-hidden",
                activeConnection?.id === conn.id
                  ? "bg-blue-600/10 text-blue-400"
                  : "hover:bg-accent/50 text-muted-foreground hover:text-foreground"
              )}
              onClick={() => onSelectConnection(conn)}
            >
              {activeConnection?.id === conn.id && (
                <motion.div
                  layoutId="active-indicator"
                  className="absolute left-0 w-1 h-4 bg-blue-500 rounded-r-full"
                />
              )}
              <div className={cn(
                "p-1 rounded transition-colors",
                activeConnection?.id === conn.id ? "bg-blue-500/20" : "bg-muted group-hover:bg-accent"
              )}>
                {conn.type === 'postgres' && <Cloud className="w-3 h-3" />}
                {conn.type === 'mysql' && <HardDrive className="w-3 h-3" />}
                {conn.type === 'mongodb' && <Layers className="w-3 h-3" />}
                {conn.type === 'redis' && <Cpu className="w-3 h-3" />}
                {conn.type === 'sqlite' && <Database className="w-3 h-3" />}
                {conn.type === 'demo' && <Zap className="w-3 h-3 text-yellow-500" />}
              </div>
              <span className="truncate flex-1 font-medium text-[13px]">{conn.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6 opacity-50 group-hover:opacity-100 transition-opacity hover:bg-red-500/20 hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteConnection(conn.id);
                }}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </motion.div>
          ))
        )}
      </div>
    </section>
  );
}

interface SidebarProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  schema: TableSchema[];
  isLoadingSchema: boolean;
  onSelectConnection: (connection: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onAddConnection: () => void;
  onTableClick?: (tableName: string) => void;
  onGenerateSelect?: (tableName: string) => void;
  onCreateTableClick?: () => void;
  onShowDiagram?: () => void;
  isAdmin?: boolean;
  onOpenMaintenance?: (tab?: 'global' | 'tables' | 'sessions', table?: string) => void;
}

export function Sidebar({ 
  connections, 
  activeConnection, 
  schema, 
  isLoadingSchema,
  onSelectConnection, 
  onDeleteConnection,
  onAddConnection,
  onTableClick,
  onGenerateSelect,
  onCreateTableClick,
  onShowDiagram,
  isAdmin = false,
  onOpenMaintenance
}: SidebarProps) {
  return (
    <div className="flex w-full h-full border-r border-border flex-col bg-background select-none">
      <div className="h-14 px-4 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-blue-600 rounded-md flex items-center justify-center">
            <Zap className="w-3.5 h-3.5 text-white fill-current" />
          </div>
          <span className="font-bold text-sm tracking-tight bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
            LibreDB Studio
          </span>
        </div>
        <div className="flex items-center gap-1">
          {activeConnection && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              onClick={onShowDiagram}
              title="Show ERD Diagram"
            >
              <Layers className="w-4 h-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            onClick={onAddConnection}
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 px-2 py-4">
        <div className="space-y-6">
          <ConnectionsList
            connections={connections}
            activeConnection={activeConnection}
            onSelectConnection={onSelectConnection}
            onDeleteConnection={onDeleteConnection}
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
            />
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-border bg-card/50 backdrop-blur-md">
        <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/30 border border-border/50">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            <span className="text-[10px] font-medium text-muted-foreground">Connected</span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground/70">v1.2.5</span>
        </div>
      </div>
    </div>
  );
}
