export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'demo';

export type ConnectionEnvironment = 'production' | 'staging' | 'development' | 'local' | 'other';

export const ENVIRONMENT_COLORS: Record<ConnectionEnvironment, string> = {
  production: '#ef4444',
  staging: '#eab308',
  development: '#22c55e',
  local: '#3b82f6',
  other: '#6b7280',
};

export const ENVIRONMENT_LABELS: Record<ConnectionEnvironment, string> = {
  production: 'PROD',
  staging: 'STAGING',
  development: 'DEV',
  local: 'LOCAL',
  other: '',
};

export type SSLMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export interface SSLConfig {
  mode: SSLMode;
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  rejectUnauthorized?: boolean;
}

export interface SSHTunnelConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'privateKey';
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface DatabaseConnection {
  id: string;
  name: string;
  type: DatabaseType;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionString?: string;
  createdAt: Date;
  isDemo?: boolean;
  color?: string;
  environment?: ConnectionEnvironment;
  group?: string;
  ssl?: SSLConfig;
  sshTunnel?: SSHTunnelConfig;
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
  foreignKeys?: ForeignKeySchema[];
  rowCount?: number;
  size?: string;
}

export interface ForeignKeySchema {
  columnName: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  isPrimary: boolean;
  defaultValue?: string;
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface QueryPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
  totalReturned: number;
  wasLimited: boolean;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  fields: string[];
  rowCount: number;
  executionTime: number;
  explainPlan?: unknown;
  pagination?: QueryPagination;
}

export interface QueryTab {
  id: string;
  name: string;
  query: string;
  result: QueryResult | null;
  isExecuting: boolean;
  type: 'sql' | 'mongodb' | 'redis';
  viewMode?: 'results' | 'explain' | 'history' | 'saved';
  explainPlan?: unknown;
  // Pagination state
  currentOffset?: number;
  isLoadingMore?: boolean;
  allRows?: Record<string, unknown>[];
}

export interface QueryHistoryItem {
  id: string;
  connectionId: string;
  connectionName?: string;
  tabName?: string;
  query: string;
  executionTime: number;
  status: 'success' | 'error';
  executedAt: Date;
  rowCount?: number;
  errorMessage?: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  query: string;
  description?: string;
  connectionType: DatabaseType;
  createdAt: Date;
  updatedAt: Date;
  tags?: string[];
}

export interface SchemaSnapshot {
  id: string;
  connectionId: string;
  connectionName: string;
  databaseType: DatabaseType;
  schema: TableSchema[];
  createdAt: Date;
  label?: string;
}

export type AggregationType = 'none' | 'sum' | 'avg' | 'count' | 'min' | 'max';
export type DateGrouping = 'hour' | 'day' | 'week' | 'month' | 'year';

export interface SavedChartConfig {
  id: string;
  name: string;
  chartType: string;
  xAxis: string;
  yAxis: string[];
  query?: string;
  connectionId?: string;
  createdAt: Date;
  aggregation?: AggregationType;
  dateGrouping?: DateGrouping;
}