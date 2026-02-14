import { mock } from 'bun:test';
import type { DatabaseProvider, HealthInfo, MaintenanceResult, MonitoringData, DatabaseOverview, PerformanceMetrics, SlowQueryStats, ActiveSessionDetails, TableStats, IndexStats, StorageStats, PreparedQuery, ProviderCapabilities, ProviderLabels } from '@/lib/db/types';
import type { QueryResult, TableSchema, DatabaseConnection } from '@/lib/types';
import { mockSchema } from '../fixtures/schemas';
import { mockSelectResult } from '../fixtures/query-results';

const defaultHealthInfo: HealthInfo = {
  activeConnections: 5,
  databaseSize: '256 MB',
  cacheHitRatio: '99.2%',
  slowQueries: [],
  activeSessions: [],
};

const defaultOverview: DatabaseOverview = {
  version: 'PostgreSQL 16.1',
  uptime: '10 days',
  activeConnections: 5,
  maxConnections: 100,
  databaseSize: '256 MB',
  databaseSizeBytes: 268435456,
  tableCount: 15,
  indexCount: 30,
};

const defaultPerformance: PerformanceMetrics = {
  cacheHitRatio: 99.2,
  transactionsPerSecond: 120,
  queriesPerSecond: 350,
  bufferPoolUsage: 45.5,
  deadlocks: 0,
};

const defaultMonitoringData: MonitoringData = {
  timestamp: new Date(),
  overview: defaultOverview,
  performance: defaultPerformance,
  slowQueries: [],
  activeSessions: [],
};

const defaultCapabilities: ProviderCapabilities = {
  queryLanguage: 'sql',
  supportsExplain: true,
  supportsExternalQueryLimiting: true,
  supportsCreateTable: true,
  supportsMaintenance: true,
  maintenanceOperations: ['vacuum', 'analyze', 'reindex'],
  supportsConnectionString: true,
  defaultPort: 5432,
  schemaRefreshPattern: '(?:CREATE|ALTER|DROP|TRUNCATE)\\s',
};

const defaultLabels: ProviderLabels = {
  entityName: 'Table',
  entityNamePlural: 'Tables',
  rowName: 'Row',
  rowNamePlural: 'Rows',
  selectAction: 'SELECT * FROM',
  generateAction: 'Generate SQL',
  analyzeAction: 'Analyze',
  vacuumAction: 'Vacuum',
  searchPlaceholder: 'Search tables...',
  analyzeGlobalLabel: 'Analyze All',
  analyzeGlobalTitle: 'Analyze All Tables',
  analyzeGlobalDesc: 'Update statistics for all tables',
  vacuumGlobalLabel: 'Vacuum All',
  vacuumGlobalTitle: 'Vacuum All Tables',
  vacuumGlobalDesc: 'Reclaim storage for all tables',
};

export interface MockProviderOverrides {
  type?: DatabaseProvider['type'];
  config?: DatabaseConnection;
  connected?: boolean;
  queryResult?: QueryResult;
  schema?: TableSchema[];
  health?: HealthInfo;
  monitoring?: MonitoringData;
  capabilities?: Partial<ProviderCapabilities>;
  labels?: Partial<ProviderLabels>;
  maintenanceResult?: MaintenanceResult;
  prepareQueryResult?: PreparedQuery;
  overview?: DatabaseOverview;
  performance?: PerformanceMetrics;
  slowQueries?: SlowQueryStats[];
  activeSessions?: ActiveSessionDetails[];
  tableStats?: TableStats[];
  indexStats?: IndexStats[];
  storageStats?: StorageStats[];
}

export function createMockProvider(overrides: MockProviderOverrides = {}): DatabaseProvider {
  let connected = overrides.connected ?? false;

  return {
    type: overrides.type ?? 'postgres',
    config: overrides.config ?? {
      id: 'mock-1',
      name: 'Mock DB',
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'mockdb',
      createdAt: new Date(),
    },
    connect: mock(async () => { connected = true; }),
    disconnect: mock(async () => { connected = false; }),
    isConnected: mock(() => connected),
    query: mock(async () => overrides.queryResult ?? mockSelectResult),
    getSchema: mock(async () => overrides.schema ?? mockSchema),
    getTables: mock(async () => (overrides.schema ?? mockSchema).map(t => t.name)),
    getHealth: mock(async () => overrides.health ?? defaultHealthInfo),
    getMonitoringData: mock(async () => overrides.monitoring ?? defaultMonitoringData),
    getOverview: mock(async () => overrides.overview ?? defaultOverview),
    getPerformanceMetrics: mock(async () => overrides.performance ?? defaultPerformance),
    getSlowQueries: mock(async () => overrides.slowQueries ?? []),
    getActiveSessions: mock(async () => overrides.activeSessions ?? []),
    getTableStats: mock(async () => overrides.tableStats ?? []),
    getIndexStats: mock(async () => overrides.indexStats ?? []),
    getStorageStats: mock(async () => overrides.storageStats ?? []),
    runMaintenance: mock(async () => overrides.maintenanceResult ?? { success: true, executionTime: 100, message: 'OK' }),
    validate: mock(() => {}),
    getCapabilities: mock(() => ({ ...defaultCapabilities, ...overrides.capabilities })),
    getLabels: mock(() => ({ ...defaultLabels, ...overrides.labels })),
    prepareQuery: mock((query: string) => overrides.prepareQueryResult ?? {
      query: `${query} LIMIT 50`,
      wasLimited: true,
      limit: 50,
      offset: 0,
    }),
  };
}
