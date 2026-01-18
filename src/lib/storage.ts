import { DatabaseConnection, QueryHistoryItem, SavedQuery } from './types';

const CONNECTIONS_KEY = 'orchids_db_connections';
const HISTORY_KEY = 'orchids_db_history';
const SAVED_QUERIES_KEY = 'orchids_db_saved';
const MAX_HISTORY_ITEMS = 500;

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
  }
};
