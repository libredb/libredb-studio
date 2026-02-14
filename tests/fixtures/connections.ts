import type { DatabaseConnection } from '@/lib/types';

export const mockPostgresConnection: DatabaseConnection = {
  id: 'test-pg-1',
  name: 'Test PostgreSQL',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  user: 'testuser',
  password: 'testpass',
  database: 'testdb',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  environment: 'development',
};

export const mockMySQLConnection: DatabaseConnection = {
  id: 'test-mysql-1',
  name: 'Test MySQL',
  type: 'mysql',
  host: 'localhost',
  port: 3306,
  user: 'testuser',
  password: 'testpass',
  database: 'testdb',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  environment: 'development',
};

export const mockSQLiteConnection: DatabaseConnection = {
  id: 'test-sqlite-1',
  name: 'Test SQLite',
  type: 'sqlite',
  database: ':memory:',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  environment: 'local',
};

export const mockMongoDBConnection: DatabaseConnection = {
  id: 'test-mongo-1',
  name: 'Test MongoDB',
  type: 'mongodb',
  host: 'localhost',
  port: 27017,
  database: 'testdb',
  connectionString: 'mongodb://localhost:27017/testdb',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  environment: 'development',
};

export const mockRedisConnection: DatabaseConnection = {
  id: 'test-redis-1',
  name: 'Test Redis',
  type: 'redis',
  host: 'localhost',
  port: 6379,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  environment: 'development',
};

export const mockOracleConnection: DatabaseConnection = {
  id: 'test-oracle-1',
  name: 'Test Oracle',
  type: 'oracle',
  host: 'localhost',
  port: 1521,
  user: 'testuser',
  password: 'testpass',
  database: 'testdb',
  serviceName: 'XEPDB1',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  environment: 'staging',
};

export const mockMSSQLConnection: DatabaseConnection = {
  id: 'test-mssql-1',
  name: 'Test MSSQL',
  type: 'mssql',
  host: 'localhost',
  port: 1433,
  user: 'sa',
  password: 'testpass',
  database: 'testdb',
  instanceName: 'SQLEXPRESS',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  environment: 'staging',
};

export const mockDemoConnection: DatabaseConnection = {
  id: 'test-demo-1',
  name: 'Demo',
  type: 'demo',
  isDemo: true,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

export const allMockConnections: DatabaseConnection[] = [
  mockPostgresConnection,
  mockMySQLConnection,
  mockSQLiteConnection,
  mockMongoDBConnection,
  mockRedisConnection,
  mockOracleConnection,
  mockMSSQLConnection,
  mockDemoConnection,
];
