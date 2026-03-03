/**
 * Storage Facade — public API for all storage operations.
 * Maintains the same sync interface as the original storage.ts.
 * Dispatches CustomEvent on every mutation for the sync hook.
 */

import {
  DatabaseConnection,
  QueryHistoryItem,
  SavedQuery,
  SchemaSnapshot,
  SavedChartConfig,
} from '../types';
import { type AuditEvent } from '../audit';
import { DEFAULT_MASKING_CONFIG, type MaskingConfig } from '../data-masking';
import { DEFAULT_THRESHOLDS, type ThresholdConfig } from '../monitoring-thresholds';
import { readJSON, writeJSON, readString, writeString, remove } from './local-storage';
import type { StorageCollection } from './types';

const MAX_HISTORY_ITEMS = 500;
const MAX_SNAPSHOTS = 50;
const MAX_AUDIT_EVENTS = 1000;

/** Dispatch a custom event to notify the sync hook of a mutation */
function dispatchChange(collection: StorageCollection, data: unknown): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('libredb-storage-change', {
      detail: { collection, data },
    })
  );
}

/** Revive Date fields from JSON-parsed objects */
function reviveDates<T>(items: T[], ...dateFields: string[]): T[] {
  return items.map((item) => {
    const revived = { ...item } as Record<string, unknown>;
    for (const field of dateFields) {
      if (revived[field]) {
        revived[field] = new Date(revived[field] as string);
      }
    }
    return revived as unknown as T;
  });
}

export const storage = {
  // ═══════════════════════════════════════════════════════════════════════════
  // Connections
  // ═══════════════════════════════════════════════════════════════════════════

  getConnections: (): DatabaseConnection[] => {
    const data = readJSON<DatabaseConnection[]>('connections');
    if (!data) return [];
    return reviveDates(data, 'createdAt');
  },

  saveConnection: (connection: DatabaseConnection) => {
    const connections = storage.getConnections();
    const existingIndex = connections.findIndex((c) => c.id === connection.id);

    if (existingIndex > -1) {
      connections[existingIndex] = connection;
    } else {
      connections.push(connection);
    }

    writeJSON('connections', connections);
    dispatchChange('connections', connections);
  },

  deleteConnection: (id: string) => {
    const connections = storage.getConnections();
    const filtered = connections.filter((c) => c.id !== id);
    writeJSON('connections', filtered);
    dispatchChange('connections', filtered);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // History
  // ═══════════════════════════════════════════════════════════════════════════

  getHistory: (): QueryHistoryItem[] => {
    const data = readJSON<QueryHistoryItem[]>('history');
    if (!data) return [];
    return reviveDates(data, 'executedAt');
  },

  addToHistory: (item: QueryHistoryItem) => {
    const history = storage.getHistory();
    const newHistory = [item, ...history].slice(0, MAX_HISTORY_ITEMS);
    writeJSON('history', newHistory);
    dispatchChange('history', newHistory);
  },

  clearHistory: () => {
    writeJSON('history', []);
    dispatchChange('history', []);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Saved Queries
  // ═══════════════════════════════════════════════════════════════════════════

  getSavedQueries: (): SavedQuery[] => {
    const data = readJSON<SavedQuery[]>('saved_queries');
    if (!data) return [];
    return reviveDates(data, 'createdAt', 'updatedAt');
  },

  saveQuery: (query: SavedQuery) => {
    const queries = storage.getSavedQueries();
    const existingIndex = queries.findIndex((q) => q.id === query.id);

    if (existingIndex > -1) {
      queries[existingIndex] = { ...query, updatedAt: new Date() };
    } else {
      queries.push({ ...query, createdAt: new Date(), updatedAt: new Date() });
    }

    writeJSON('saved_queries', queries);
    dispatchChange('saved_queries', queries);
  },

  deleteSavedQuery: (id: string) => {
    const queries = storage.getSavedQueries();
    const filtered = queries.filter((q) => q.id !== id);
    writeJSON('saved_queries', filtered);
    dispatchChange('saved_queries', filtered);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Schema Snapshots
  // ═══════════════════════════════════════════════════════════════════════════

  getSchemaSnapshots: (connectionId?: string): SchemaSnapshot[] => {
    const data = readJSON<SchemaSnapshot[]>('schema_snapshots');
    if (!data) return [];
    const snapshots = reviveDates(data, 'createdAt');
    if (connectionId) {
      return snapshots.filter((s) => s.connectionId === connectionId);
    }
    return snapshots;
  },

  saveSchemaSnapshot: (snapshot: SchemaSnapshot) => {
    const snapshots = storage.getSchemaSnapshots();
    snapshots.push({ ...snapshot, createdAt: new Date() });
    const trimmed = snapshots.slice(-MAX_SNAPSHOTS);
    writeJSON('schema_snapshots', trimmed);
    dispatchChange('schema_snapshots', trimmed);
  },

  deleteSchemaSnapshot: (id: string) => {
    const snapshots = storage.getSchemaSnapshots();
    const filtered = snapshots.filter((s) => s.id !== id);
    writeJSON('schema_snapshots', filtered);
    dispatchChange('schema_snapshots', filtered);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Saved Charts
  // ═══════════════════════════════════════════════════════════════════════════

  getSavedCharts: (): SavedChartConfig[] => {
    const data = readJSON<SavedChartConfig[]>('saved_charts');
    if (!data) return [];
    return reviveDates(data, 'createdAt');
  },

  saveChart: (chart: SavedChartConfig) => {
    const charts = storage.getSavedCharts();
    const existingIndex = charts.findIndex((c) => c.id === chart.id);
    if (existingIndex > -1) {
      charts[existingIndex] = chart;
    } else {
      charts.push({ ...chart, createdAt: new Date() });
    }
    writeJSON('saved_charts', charts);
    dispatchChange('saved_charts', charts);
  },

  deleteChart: (id: string) => {
    const charts = storage.getSavedCharts();
    const filtered = charts.filter((c) => c.id !== id);
    writeJSON('saved_charts', filtered);
    dispatchChange('saved_charts', filtered);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Active Connection ID
  // ═══════════════════════════════════════════════════════════════════════════

  getActiveConnectionId: (): string | null => {
    return readString('active_connection_id');
  },

  setActiveConnectionId: (id: string | null) => {
    if (typeof window === 'undefined') return;
    if (id) {
      writeString('active_connection_id', id);
    } else {
      remove('active_connection_id');
    }
    dispatchChange('active_connection_id', id);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Audit Log (consolidated from audit.ts)
  // ═══════════════════════════════════════════════════════════════════════════

  getAuditLog: (): AuditEvent[] => {
    const data = readJSON<AuditEvent[]>('audit_log');
    return data ?? [];
  },

  saveAuditLog: (events: AuditEvent[]) => {
    const trimmed = events.slice(-MAX_AUDIT_EVENTS);
    writeJSON('audit_log', trimmed);
    dispatchChange('audit_log', trimmed);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Masking Config (consolidated from data-masking.ts)
  // ═══════════════════════════════════════════════════════════════════════════

  getMaskingConfig: (): MaskingConfig => {
    const data = readJSON<MaskingConfig>('masking_config');
    if (!data) return DEFAULT_MASKING_CONFIG;

    // Merge with defaults to ensure new builtin patterns are included
    const builtinIds = new Set(
      DEFAULT_MASKING_CONFIG.patterns.filter((p) => p.isBuiltin).map((p) => p.id)
    );
    const storedIds = new Set(data.patterns.map((p) => p.id));

    for (const defaultPattern of DEFAULT_MASKING_CONFIG.patterns) {
      if (defaultPattern.isBuiltin && !storedIds.has(defaultPattern.id)) {
        data.patterns.push(defaultPattern);
      }
    }

    if (!data.roleSettings) {
      data.roleSettings = DEFAULT_MASKING_CONFIG.roleSettings;
    }

    data.patterns = data.patterns.filter(
      (p) => !p.isBuiltin || builtinIds.has(p.id) || !p.id.startsWith('builtin-')
    );

    return data;
  },

  saveMaskingConfig: (config: MaskingConfig) => {
    writeJSON('masking_config', config);
    dispatchChange('masking_config', config);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Threshold Config (consolidated from SecurityTab.tsx)
  // ═══════════════════════════════════════════════════════════════════════════

  getThresholdConfig: (): ThresholdConfig[] => {
    const data = readJSON<ThresholdConfig[]>('threshold_config');
    return data ?? DEFAULT_THRESHOLDS;
  },

  saveThresholdConfig: (thresholds: ThresholdConfig[]) => {
    writeJSON('threshold_config', thresholds);
    dispatchChange('threshold_config', thresholds);
  },
};
