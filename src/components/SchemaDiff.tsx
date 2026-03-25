'use client';

import React, { useState, useMemo, useCallback } from 'react';
import {
  GitCompare,
  Plus,
  Minus,
  Edit3,
  Camera,
  FileCode,
  ChevronRight,
  ChevronDown,
  Clock,
  Database,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { TableSchema, SchemaSnapshot, DatabaseType, DatabaseConnection } from '@/lib/types';
import { storage } from '@/lib/storage';
import { diffSchemas } from '@/lib/schema-diff/diff-engine';
import { generateMigrationSQL } from '@/lib/schema-diff/migration-generator';
import type { SchemaDiff as SchemaDiffType, TableDiff } from '@/lib/schema-diff/types';
import { SnapshotTimeline } from '@/components/SnapshotTimeline';

interface SchemaDiffProps {
  schema: TableSchema[];
  connection: DatabaseConnection | null;
}

export function SchemaDiff({ schema, connection }: SchemaDiffProps) {
  const [snapshots, setSnapshots] = useState<SchemaSnapshot[]>(() =>
    storage.getSchemaSnapshots()
  );
  const [sourceId, setSourceId] = useState<string>('current');
  const [targetId, setTargetId] = useState<string>('');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [showMigration, setShowMigration] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [showLabelInput, setShowLabelInput] = useState(false);

  // Take snapshot of current schema
  const takeSnapshot = useCallback(() => {
    if (!connection) return;
    const snapshot: SchemaSnapshot = {
      id: Date.now().toString(),
      connectionId: connection.id,
      connectionName: connection.name,
      databaseType: connection.type,
      schema: JSON.parse(JSON.stringify(schema)),
      createdAt: new Date(),
      label: snapshotLabel.trim() || undefined,
    };
    storage.saveSchemaSnapshot(snapshot);
    setSnapshots(storage.getSchemaSnapshots());
    setSnapshotLabel('');
    setShowLabelInput(false);
  }, [schema, connection, snapshotLabel]);

  // Delete snapshot
  const deleteSnapshot = useCallback((id: string) => {
    storage.deleteSchemaSnapshot(id);
    setSnapshots(storage.getSchemaSnapshots());
    if (sourceId === id) setSourceId('current');
    if (targetId === id) setTargetId('');
  }, [sourceId, targetId]);

  // Compute diff
  const diff = useMemo<SchemaDiffType | null>(() => {
    if (!targetId) return null;

    const sourceSchema = sourceId === 'current'
      ? schema
      : snapshots.find(s => s.id === sourceId)?.schema || [];

    const targetSchema = targetId === 'current'
      ? schema
      : snapshots.find(s => s.id === targetId)?.schema || [];

    if (sourceId === targetId) return null;

    return diffSchemas(sourceSchema, targetSchema);
  }, [sourceId, targetId, schema, snapshots]);

  // Generate migration SQL
  const migrationSQL = useMemo(() => {
    if (!diff || !diff.hasChanges) return '';
    const dialect = connection?.type || 'postgres';
    return generateMigrationSQL(diff, dialect as DatabaseType);
  }, [diff, connection]);

  // Get all connections for cross-connection comparison
  const allConnections = useMemo(() => storage.getConnections(), []);
  const [fetchingRemote, setFetchingRemote] = useState(false);

  // Fetch schema from a remote connection
  const fetchRemoteSchema = useCallback(async (connId: string) => {
    const conn = allConnections.find(c => c.id === connId);
    if (!conn) return;

    setFetchingRemote(true);
    try {
      const res = await fetch('/api/db/schema-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection: conn }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Auto-save as snapshot
      const snapshot: SchemaSnapshot = {
        id: `remote-${Date.now()}`,
        connectionId: conn.id,
        connectionName: conn.name,
        databaseType: conn.type,
        schema: data.schema,
        createdAt: new Date(),
        label: `Live: ${conn.name}`,
      };
      storage.saveSchemaSnapshot(snapshot);
      setSnapshots(storage.getSchemaSnapshots());
      setTargetId(snapshot.id);
    } catch (err) {
      console.error('Failed to fetch remote schema:', err);
    } finally {
      setFetchingRemote(false);
    }
  }, [allConnections]);

  const getActionBadge = (action: string) => {
    switch (action) {
      case 'added': return <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-[10px]"><Plus className="w-2.5 h-2.5 mr-0.5" />Added</Badge>;
      case 'removed': return <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[10px]"><Minus className="w-2.5 h-2.5 mr-0.5" />Removed</Badge>;
      case 'modified': return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-[10px]"><Edit3 className="w-2.5 h-2.5 mr-0.5" />Modified</Badge>;
      default: return null;
    }
  };

  const formatSnapshotLabel = (s: SchemaSnapshot) => {
    const date = new Date(s.createdAt).toLocaleString();
    return `${s.label || s.connectionName} (${date})`;
  };

  return (
    <div className="h-full flex flex-col bg-[#080808]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-[#0a0a0a] flex-wrap">
        <GitCompare className="w-4 h-4 text-rose-400" />
        <span className="text-[10px] font-bold uppercase text-zinc-400 tracking-wider">Schema Diff</span>

        <div className="h-4 w-px bg-white/10" />

        {/* Source selector */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-zinc-600 uppercase">Source</span>
          <Select value={sourceId} onValueChange={setSourceId}>
            <SelectTrigger className="h-7 w-[180px] text-xs bg-white/5 border-white/10">
              <SelectValue placeholder="Select source" />
            </SelectTrigger>
            <SelectContent className="bg-[#111] border-white/10">
              <SelectItem value="current" className="text-xs">
                <div className="flex items-center gap-1">
                  <Database className="w-3 h-3" /> Current Schema
                </div>
              </SelectItem>
              {snapshots.map(s => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  <div className="flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {formatSnapshotLabel(s)}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="text-zinc-600 text-xs">vs</span>

        {/* Target selector */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-zinc-600 uppercase">Target</span>
          <Select value={targetId} onValueChange={(v) => {
            if (v.startsWith('conn:')) {
              fetchRemoteSchema(v.replace('conn:', ''));
            } else {
              setTargetId(v);
            }
          }}>
            <SelectTrigger className="h-7 w-[180px] text-xs bg-white/5 border-white/10">
              <SelectValue placeholder="Select target" />
            </SelectTrigger>
            <SelectContent className="bg-[#111] border-white/10">
              <SelectItem value="current" className="text-xs">
                <div className="flex items-center gap-1">
                  <Database className="w-3 h-3" /> Current Schema
                </div>
              </SelectItem>
              {snapshots.map(s => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  <div className="flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {formatSnapshotLabel(s)}
                  </div>
                </SelectItem>
              ))}
              {allConnections.filter(c => c.id !== connection?.id).length > 0 && (
                <>
                  <div className="px-2 py-1 text-[9px] text-zinc-600 uppercase border-t border-white/5 mt-1">
                    Fetch from connection
                  </div>
                  {allConnections.filter(c => c.id !== connection?.id).map(c => (
                    <SelectItem key={`conn:${c.id}`} value={`conn:${c.id}`} className="text-xs">
                      <div className="flex items-center gap-1">
                        <Database className="w-3 h-3 text-blue-400" /> {c.name}
                        {c.environment === 'production' && (
                          <AlertTriangle className="w-3 h-3 text-red-400" />
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </>
              )}
            </SelectContent>
          </Select>
          {fetchingRemote && <span className="text-[10px] text-zinc-500 animate-pulse">Fetching...</span>}
        </div>

        <div className="flex-1" />

        {/* Snapshot controls */}
        {showLabelInput ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              placeholder="Label (optional)..."
              value={snapshotLabel}
              onChange={(e) => setSnapshotLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && takeSnapshot()}
              className="h-7 px-2 text-xs bg-white/5 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-blue-500 w-32"
              autoFocus
            />
            <Button variant="ghost" size="sm" className="h-7 text-xs text-blue-400" onClick={takeSnapshot}>
              Save
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs text-zinc-500" onClick={() => setShowLabelInput(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[10px] font-bold uppercase text-zinc-500 hover:text-white gap-1"
            onClick={() => setShowLabelInput(true)}
            disabled={!connection}
          >
            <Camera className="w-3 h-3" /> Snapshot
          </Button>
        )}

        {diff?.hasChanges && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[10px] font-bold uppercase text-zinc-500 hover:text-white gap-1"
            onClick={() => setShowMigration(!showMigration)}
          >
            <FileCode className="w-3 h-3" /> {showMigration ? 'Diff View' : 'SQL Migration'}
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex">
        {!targetId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 gap-3">
            <GitCompare className="w-10 h-10 opacity-30" />
            <p className="text-sm">Select source and target to compare schemas</p>
            <p className="text-xs text-zinc-700">Take a snapshot first, then compare with the current schema</p>

            {/* Snapshot Timeline */}
            {snapshots.length > 0 && (
              <div className="mt-4 w-full max-w-2xl px-4">
                <SnapshotTimeline
                  snapshots={snapshots}
                  onCompare={(sourceId, targetId) => {
                    setSourceId(sourceId);
                    setTargetId(targetId);
                  }}
                  onDelete={deleteSnapshot}
                />
              </div>
            )}
          </div>
        ) : showMigration && migrationSQL ? (
          <div className="flex-1 overflow-auto p-4">
            <pre className="text-xs font-mono text-zinc-300 bg-[#0d0d0d] border border-white/10 rounded-lg p-4 overflow-auto whitespace-pre-wrap">
              {migrationSQL}
            </pre>
          </div>
        ) : diff && diff.hasChanges ? (
          <>
            {/* Table List */}
            <div className="w-64 border-r border-white/5 overflow-auto">
              <div className="p-2 border-b border-white/5">
                <div className="text-[10px] text-zinc-500 uppercase px-2 mb-1">
                  {diff.summary.added} added, {diff.summary.removed} removed, {diff.summary.modified} modified
                </div>
              </div>
              {diff.tables.map(table => (
                <button
                  key={table.tableName}
                  onClick={() => setSelectedTable(table.tableName)}
                  className={cn(
                    "w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-white/5 transition-colors",
                    selectedTable === table.tableName && "bg-white/10"
                  )}
                >
                  {selectedTable === table.tableName ? (
                    <ChevronDown className="w-3 h-3 text-zinc-500" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-zinc-500" />
                  )}
                  <span className="text-zinc-300">{table.tableName}</span>
                  <span className="ml-auto">{getActionBadge(table.action)}</span>
                </button>
              ))}
            </div>

            {/* Table Detail */}
            <div className="flex-1 overflow-auto p-4">
              {selectedTable ? (
                <TableDiffDetail diff={diff.tables.find(t => t.tableName === selectedTable)!} />
              ) : (
                <div className="h-full flex items-center justify-center text-zinc-600 text-sm">
                  Select a table to view diff details
                </div>
              )}
            </div>
          </>
        ) : diff && !diff.hasChanges ? (
          <div className="flex-1 flex items-center justify-center text-zinc-600 gap-2">
            <span className="text-sm">No differences found between source and target</span>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-600 gap-2">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-sm">Cannot compare same schema with itself</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TableDiffDetail({ diff }: { diff: TableDiff }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-zinc-400" />
        <h3 className="text-sm font-bold text-zinc-200">{diff.tableName}</h3>
        <Badge className={cn(
          "text-[10px]",
          diff.action === 'added' && "bg-green-500/20 text-green-400",
          diff.action === 'removed' && "bg-red-500/20 text-red-400",
          diff.action === 'modified' && "bg-yellow-500/20 text-yellow-400",
        )}>
          {diff.action}
        </Badge>
      </div>

      {/* Columns */}
      {diff.columns.length > 0 && (
        <div>
          <h4 className="text-[10px] uppercase text-zinc-500 mb-2 font-bold">Columns</h4>
          <div className="space-y-1">
            {diff.columns.map((col, i) => (
              <div key={i} className={cn(
                "px-3 py-2 rounded text-xs flex items-center gap-2",
                col.action === 'added' && "bg-green-500/5 border border-green-500/10",
                col.action === 'removed' && "bg-red-500/5 border border-red-500/10",
                col.action === 'modified' && "bg-yellow-500/5 border border-yellow-500/10",
              )}>
                <span className="font-mono text-zinc-300 min-w-[120px]">{col.columnName}</span>
                {col.action === 'modified' && (
                  <div className="flex flex-col gap-0.5">
                    {col.changes.map((change, j) => (
                      <span key={j} className="text-[10px] text-zinc-500">{change}</span>
                    ))}
                  </div>
                )}
                {col.action === 'added' && (
                  <span className="text-[10px] text-green-400 font-mono">{col.targetType}</span>
                )}
                {col.action === 'removed' && (
                  <span className="text-[10px] text-red-400 font-mono">{col.sourceType}</span>
                )}
                <span className="ml-auto">{getActionIcon(col.action)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Indexes */}
      {diff.indexes.length > 0 && (
        <div>
          <h4 className="text-[10px] uppercase text-zinc-500 mb-2 font-bold">Indexes</h4>
          <div className="space-y-1">
            {diff.indexes.map((idx, i) => (
              <div key={i} className={cn(
                "px-3 py-2 rounded text-xs flex items-center gap-2",
                idx.action === 'added' && "bg-green-500/5 border border-green-500/10",
                idx.action === 'removed' && "bg-red-500/5 border border-red-500/10",
                idx.action === 'modified' && "bg-yellow-500/5 border border-yellow-500/10",
              )}>
                <span className="font-mono text-zinc-300">{idx.indexName}</span>
                {idx.changes.map((change, j) => (
                  <span key={j} className="text-[10px] text-zinc-500">{change}</span>
                ))}
                <span className="ml-auto">{getActionIcon(idx.action)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Foreign Keys */}
      {diff.foreignKeys.length > 0 && (
        <div>
          <h4 className="text-[10px] uppercase text-zinc-500 mb-2 font-bold">Foreign Keys</h4>
          <div className="space-y-1">
            {diff.foreignKeys.map((fk, i) => (
              <div key={i} className={cn(
                "px-3 py-2 rounded text-xs flex items-center gap-2",
                fk.action === 'added' && "bg-green-500/5 border border-green-500/10",
                fk.action === 'removed' && "bg-red-500/5 border border-red-500/10",
              )}>
                <span className="font-mono text-zinc-300">{fk.columnName}</span>
                {fk.changes.map((change, j) => (
                  <span key={j} className="text-[10px] text-zinc-500">{change}</span>
                ))}
                <span className="ml-auto">{getActionIcon(fk.action)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function getActionIcon(action: string) {
  switch (action) {
    case 'added': return <Plus className="w-3 h-3 text-green-400" />;
    case 'removed': return <Minus className="w-3 h-3 text-red-400" />;
    case 'modified': return <Edit3 className="w-3 h-3 text-yellow-400" />;
    default: return null;
  }
}
