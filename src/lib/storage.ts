import { DatabaseConnection, QueryHistoryItem, SavedQuery, SchemaSnapshot, SavedChartConfig } from './types';

const CONNECTIONS_KEY = 'libredb_connections';
const HISTORY_KEY = 'libredb_history';
const SAVED_QUERIES_KEY = 'libredb_saved_queries';
const SCHEMA_SNAPSHOTS_KEY = 'libredb_schema_snapshots';
const SAVED_CHARTS_KEY = 'libredb_saved_charts';
const ACTIVE_CONNECTION_KEY = 'libredb_active_connection_id';
const MAX_HISTORY_ITEMS = 500;
const MAX_SNAPSHOTS = 50;

export const storage = {
  // Connections
  getConnections: (): DatabaseConnection[] => {
    if (typeof window === 'undefined') return [];
    const stored = localStorage.getItem(CONNECTIONS_KEY);
    if (!stored) return [];
    try {
      return JSON.parse(stored).map((conn: DatabaseConnection) => ({
        ...conn,
        createdAt: new Date(conn.createdAt)
      }));
    } catch (e) {
      console.error('Failed to parse connections', e);
      return [];
    }
  },

  saveConnection: (connection: DatabaseConnection) => {
    const connections = storage.getConnections();
    const existingIndex = connections.findIndex(c => c.id === connection.id);
    
    if (existingIndex > -1) {
      connections[existingIndex] = connection;
    } else {
      connections.push(connection);
    }
    
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(connections));
  },

  deleteConnection: (id: string) => {
    const connections = storage.getConnections();
    const filtered = connections.filter(c => c.id !== id);
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(filtered));
  },

  // History
  getHistory: (): QueryHistoryItem[] => {
    if (typeof window === 'undefined') return [];
    const stored = localStorage.getItem(HISTORY_KEY);
    if (!stored) return [];
    try {
      return JSON.parse(stored).map((item: QueryHistoryItem) => ({
        ...item,
        executedAt: new Date(item.executedAt)
      }));
    } catch (e) {
      console.error('Failed to parse history', e);
      return [];
    }
  },

  addToHistory: (item: QueryHistoryItem) => {
    const history = storage.getHistory();
    const newHistory = [item, ...history].slice(0, MAX_HISTORY_ITEMS);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory));
  },

  clearHistory: () => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([]));
  },

  // Saved Queries
  getSavedQueries: (): SavedQuery[] => {
    if (typeof window === 'undefined') return [];
    const stored = localStorage.getItem(SAVED_QUERIES_KEY);
    if (!stored) return [];
    try {
      return JSON.parse(stored).map((q: SavedQuery) => ({
        ...q,
        createdAt: new Date(q.createdAt),
        updatedAt: new Date(q.updatedAt)
      }));
    } catch (e) {
      console.error('Failed to parse saved queries', e);
      return [];
    }
  },

  saveQuery: (query: SavedQuery) => {
    const queries = storage.getSavedQueries();
    const existingIndex = queries.findIndex(q => q.id === query.id);
    
    if (existingIndex > -1) {
      queries[existingIndex] = { ...query, updatedAt: new Date() };
    } else {
      queries.push({ ...query, createdAt: new Date(), updatedAt: new Date() });
    }
    
    localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(queries));
  },

  deleteSavedQuery: (id: string) => {
    const queries = storage.getSavedQueries();
    const filtered = queries.filter(q => q.id !== id);
    localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(filtered));
  },

  // Schema Snapshots
  getSchemaSnapshots: (connectionId?: string): SchemaSnapshot[] => {
    if (typeof window === 'undefined') return [];
    const stored = localStorage.getItem(SCHEMA_SNAPSHOTS_KEY);
    if (!stored) return [];
    try {
      const snapshots: SchemaSnapshot[] = JSON.parse(stored).map((s: SchemaSnapshot) => ({
        ...s,
        createdAt: new Date(s.createdAt),
      }));
      if (connectionId) {
        return snapshots.filter(s => s.connectionId === connectionId);
      }
      return snapshots;
    } catch (e) {
      console.error('Failed to parse schema snapshots', e);
      return [];
    }
  },

  saveSchemaSnapshot: (snapshot: SchemaSnapshot) => {
    const snapshots = storage.getSchemaSnapshots();
    snapshots.push({ ...snapshot, createdAt: new Date() });
    // Keep only the latest MAX_SNAPSHOTS
    const trimmed = snapshots.slice(-MAX_SNAPSHOTS);
    localStorage.setItem(SCHEMA_SNAPSHOTS_KEY, JSON.stringify(trimmed));
  },

  deleteSchemaSnapshot: (id: string) => {
    const snapshots = storage.getSchemaSnapshots();
    const filtered = snapshots.filter(s => s.id !== id);
    localStorage.setItem(SCHEMA_SNAPSHOTS_KEY, JSON.stringify(filtered));
  },

  // Saved Charts
  getSavedCharts: (): SavedChartConfig[] => {
    if (typeof window === 'undefined') return [];
    const stored = localStorage.getItem(SAVED_CHARTS_KEY);
    if (!stored) return [];
    try {
      return JSON.parse(stored).map((c: SavedChartConfig) => ({
        ...c,
        createdAt: new Date(c.createdAt),
      }));
    } catch (e) {
      console.error('Failed to parse saved charts', e);
      return [];
    }
  },

  saveChart: (chart: SavedChartConfig) => {
    const charts = storage.getSavedCharts();
    const existingIndex = charts.findIndex(c => c.id === chart.id);
    if (existingIndex > -1) {
      charts[existingIndex] = chart;
    } else {
      charts.push({ ...chart, createdAt: new Date() });
    }
    localStorage.setItem(SAVED_CHARTS_KEY, JSON.stringify(charts));
  },

  deleteChart: (id: string) => {
    const charts = storage.getSavedCharts();
    const filtered = charts.filter(c => c.id !== id);
    localStorage.setItem(SAVED_CHARTS_KEY, JSON.stringify(filtered));
  },

  // Active Connection ID
  getActiveConnectionId: (): string | null => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(ACTIVE_CONNECTION_KEY);
  },

  setActiveConnectionId: (id: string | null) => {
    if (typeof window === 'undefined') return;
    if (id) {
      localStorage.setItem(ACTIVE_CONNECTION_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_CONNECTION_KEY);
    }
  },
};
