/**
 * Demo Database Provider
 * Mock provider for demonstration and testing purposes
 */

import { BaseDatabaseProvider } from '../base-provider';
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from '../types';

// ============================================================================
// Mock Data
// ============================================================================

const MOCK_USERS = [
  { id: 1, email: 'john@example.com', full_name: 'John Doe', created_at: '2024-01-15T10:30:00Z' },
  { id: 2, email: 'jane@example.com', full_name: 'Jane Smith', created_at: '2024-02-20T14:45:00Z' },
  { id: 3, email: 'bob@example.com', full_name: 'Bob Wilson', created_at: '2024-03-10T09:15:00Z' },
  { id: 4, email: 'alice@example.com', full_name: 'Alice Brown', created_at: '2024-03-25T16:20:00Z' },
  { id: 5, email: 'charlie@example.com', full_name: 'Charlie Davis', created_at: '2024-04-05T11:00:00Z' },
];

const MOCK_PRODUCTS = [
  { id: 1, name: 'MacBook Pro 16"', price: 2499.99, stock: 15, category: 'Electronics' },
  { id: 2, name: 'iPhone 15 Pro', price: 999.99, stock: 42, category: 'Electronics' },
  { id: 3, name: 'AirPods Pro', price: 249.99, stock: 128, category: 'Electronics' },
  { id: 4, name: 'Magic Keyboard', price: 99.99, stock: 67, category: 'Accessories' },
  { id: 5, name: 'Studio Display', price: 1599.99, stock: 8, category: 'Electronics' },
];

const MOCK_ORDERS = [
  { id: 101, user_id: 1, total_amount: 2749.98, status: 'completed', order_date: '2024-04-01T12:00:00Z' },
  { id: 102, user_id: 2, total_amount: 999.99, status: 'completed', order_date: '2024-04-02T15:30:00Z' },
  { id: 103, user_id: 1, total_amount: 249.99, status: 'shipped', order_date: '2024-04-05T09:00:00Z' },
  { id: 104, user_id: 3, total_amount: 1699.98, status: 'processing', order_date: '2024-04-08T14:00:00Z' },
  { id: 105, user_id: 4, total_amount: 99.99, status: 'pending', order_date: '2024-04-10T10:00:00Z' },
];

// ============================================================================
// Demo Provider
// ============================================================================

export class DemoProvider extends BaseDatabaseProvider {
  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    // Demo mode is always "connected"
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.setConnected(false);
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string): Promise<QueryResult> {
    const { result, executionTime } = await this.measureExecution(async () => {
      const lowerSql = sql.toLowerCase().trim();

      // Parse query to determine response
      if (lowerSql.includes('from users')) {
        return this.handleUsersQuery(lowerSql);
      }

      if (lowerSql.includes('from products')) {
        return this.handleProductsQuery(lowerSql);
      }

      if (lowerSql.includes('from orders')) {
        return this.handleOrdersQuery(lowerSql);
      }

      // Handle aggregate queries
      if (lowerSql.includes('count(*)')) {
        return {
          rows: [{ count: 100 }],
          fields: ['count'],
        };
      }

      // Default response for unknown queries
      return {
        rows: [{
          message: "Demo mode supports: 'SELECT * FROM users', 'SELECT * FROM products', 'SELECT * FROM orders'",
          hint: "Try: SELECT * FROM users WHERE id = 1",
        }],
        fields: ['message', 'hint'],
      };
    });

    return {
      rows: result.rows,
      fields: result.fields,
      rowCount: result.rows.length,
      executionTime,
    };
  }

  private handleUsersQuery(sql: string): { rows: unknown[]; fields: string[] } {
    let rows = [...MOCK_USERS];

    // Simple WHERE clause parsing
    const whereMatch = sql.match(/where\s+(\w+)\s*=\s*['"]?(\w+)['"]?/i);
    if (whereMatch) {
      const [, field, value] = whereMatch;
      rows = rows.filter((r) => {
        const fieldValue = String(r[field as keyof typeof r]);
        return fieldValue.toLowerCase() === value.toLowerCase();
      });
    }

    // LIMIT parsing
    const limitMatch = sql.match(/limit\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1]));
    }

    return {
      rows,
      fields: ['id', 'email', 'full_name', 'created_at'],
    };
  }

  private handleProductsQuery(sql: string): { rows: unknown[]; fields: string[] } {
    let rows = [...MOCK_PRODUCTS];

    const whereMatch = sql.match(/where\s+(\w+)\s*=\s*['"]?(\w+)['"]?/i);
    if (whereMatch) {
      const [, field, value] = whereMatch;
      rows = rows.filter((r) => {
        const fieldValue = String(r[field as keyof typeof r]);
        return fieldValue.toLowerCase() === value.toLowerCase();
      });
    }

    const limitMatch = sql.match(/limit\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1]));
    }

    return {
      rows,
      fields: ['id', 'name', 'price', 'stock', 'category'],
    };
  }

  private handleOrdersQuery(sql: string): { rows: unknown[]; fields: string[] } {
    let rows = [...MOCK_ORDERS];

    const whereMatch = sql.match(/where\s+(\w+)\s*=\s*['"]?(\w+)['"]?/i);
    if (whereMatch) {
      const [, field, value] = whereMatch;
      rows = rows.filter((r) => {
        const fieldValue = String(r[field as keyof typeof r]);
        return fieldValue.toLowerCase() === value.toLowerCase();
      });
    }

    const limitMatch = sql.match(/limit\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1]));
    }

    return {
      rows,
      fields: ['id', 'user_id', 'total_amount', 'status', 'order_date'],
    };
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    return [
      {
        name: 'users',
        rowCount: MOCK_USERS.length * 250, // Simulated larger count
        size: '144 KB',
        columns: [
          { name: 'id', type: 'integer', nullable: false, isPrimary: true },
          { name: 'email', type: 'varchar(255)', nullable: false, isPrimary: false },
          { name: 'full_name', type: 'varchar(255)', nullable: true, isPrimary: false },
          { name: 'created_at', type: 'timestamp', nullable: false, isPrimary: false },
        ],
        indexes: [
          { name: 'users_pkey', columns: ['id'], unique: true },
          { name: 'users_email_key', columns: ['email'], unique: true },
        ],
        foreignKeys: [],
      },
      {
        name: 'products',
        rowCount: MOCK_PRODUCTS.length * 90, // Simulated larger count
        size: '64 KB',
        columns: [
          { name: 'id', type: 'integer', nullable: false, isPrimary: true },
          { name: 'name', type: 'varchar(255)', nullable: false, isPrimary: false },
          { name: 'price', type: 'decimal(10,2)', nullable: false, isPrimary: false },
          { name: 'stock', type: 'integer', nullable: false, isPrimary: false },
          { name: 'category', type: 'varchar(100)', nullable: true, isPrimary: false },
        ],
        indexes: [
          { name: 'products_pkey', columns: ['id'], unique: true },
          { name: 'products_name_idx', columns: ['name'], unique: false },
        ],
        foreignKeys: [],
      },
      {
        name: 'orders',
        rowCount: MOCK_ORDERS.length * 1780, // Simulated larger count
        size: '1.2 MB',
        columns: [
          { name: 'id', type: 'integer', nullable: false, isPrimary: true },
          { name: 'user_id', type: 'integer', nullable: false, isPrimary: false },
          { name: 'total_amount', type: 'decimal(10,2)', nullable: false, isPrimary: false },
          { name: 'status', type: 'varchar(50)', nullable: false, isPrimary: false },
          { name: 'order_date', type: 'timestamp', nullable: false, isPrimary: false },
        ],
        indexes: [
          { name: 'orders_pkey', columns: ['id'], unique: true },
          { name: 'orders_user_id_idx', columns: ['user_id'], unique: false },
          { name: 'orders_status_idx', columns: ['status'], unique: false },
        ],
        foreignKeys: [
          { columnName: 'user_id', referencedTable: 'users', referencedColumn: 'id' },
        ],
      },
    ];
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    return {
      activeConnections: 12,
      databaseSize: '124 MB',
      cacheHitRatio: '98.5%',
      slowQueries: [
        {
          query: 'SELECT * FROM users JOIN orders ON users.id = orders.user_id...',
          calls: 150,
          avgTime: '301.3ms',
        },
        {
          query: 'UPDATE products SET stock = stock - 1 WHERE id = ?...',
          calls: 1200,
          avgTime: '10.4ms',
        },
        {
          query: 'SELECT COUNT(*) FROM orders WHERE status = ?...',
          calls: 890,
          avgTime: '45.2ms',
        },
      ],
      activeSessions: [
        {
          pid: 1234,
          user: 'app_user',
          database: 'demo_db',
          state: 'active',
          query: 'SELECT * FROM users WHERE id = 1',
          duration: '0.05s',
        },
        {
          pid: 5678,
          user: 'admin',
          database: 'demo_db',
          state: 'idle',
          query: 'BEGIN',
          duration: '2.3s',
        },
        {
          pid: 9012,
          user: 'app_user',
          database: 'demo_db',
          state: 'active',
          query: 'INSERT INTO orders (user_id, total_amount) VALUES (?, ?)',
          duration: '0.02s',
        },
      ],
    };
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(
    type: MaintenanceType,
    target?: string
  ): Promise<MaintenanceResult> {
    // Simulate maintenance operation with delay
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));

    const messages: Record<MaintenanceType, string> = {
      vacuum: `VACUUM ${target || 'all tables'} completed. Reclaimed 12 MB of space.`,
      analyze: `ANALYZE ${target || 'all tables'} completed. Updated statistics for 3 tables.`,
      reindex: `REINDEX ${target || 'database'} completed. Rebuilt 8 indexes.`,
      kill: target ? `Terminated connection ${target}.` : 'No connection specified.',
      optimize: `OPTIMIZE ${target || 'all tables'} completed.`,
      check: `CHECK ${target || 'all tables'} completed. All tables are healthy.`,
    };

    return {
      success: true,
      executionTime: Math.round(500 + Math.random() * 1000),
      message: messages[type] || `${type.toUpperCase()} completed successfully.`,
    };
  }

  // ============================================================================
  // Monitoring Operations
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    return {
      version: 'PostgreSQL 16.2 (Demo)',
      uptime: '14d 6h',
      startTime: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      activeConnections: 12,
      maxConnections: 100,
      databaseSize: '124 MB',
      databaseSizeBytes: 124 * 1024 * 1024,
      tableCount: 3,
      indexCount: 8,
    };
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    // Add slight variance to make it feel more realistic
    const baseHitRatio = 98.5;
    const variance = (Math.random() - 0.5) * 2;

    return {
      cacheHitRatio: Math.round((baseHitRatio + variance) * 100) / 100,
      queriesPerSecond: Math.round((45 + Math.random() * 10) * 100) / 100,
      bufferPoolUsage: Math.round((72 + Math.random() * 5) * 100) / 100,
      deadlocks: 0,
    };
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    return [
      {
        queryId: '1234567890abcdef',
        query: 'SELECT u.*, o.* FROM users u JOIN orders o ON u.id = o.user_id WHERE o.status = $1 ORDER BY o.order_date DESC LIMIT 100',
        calls: 1542,
        totalTime: 465120.5,
        avgTime: 301.63,
        minTime: 45.2,
        maxTime: 1250.8,
        rows: 154200,
      },
      {
        queryId: '2345678901bcdef0',
        query: 'UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1',
        calls: 12850,
        totalTime: 133640,
        avgTime: 10.4,
        minTime: 2.1,
        maxTime: 89.5,
        rows: 12850,
      },
      {
        queryId: '3456789012cdef01',
        query: 'SELECT COUNT(*) FROM orders WHERE status = $1 AND order_date > $2',
        calls: 8920,
        totalTime: 403144,
        avgTime: 45.2,
        minTime: 12.4,
        maxTime: 234.7,
        rows: 8920,
      },
      {
        queryId: '4567890123def012',
        query: 'INSERT INTO orders (user_id, total_amount, status, order_date) VALUES ($1, $2, $3, $4) RETURNING id',
        calls: 3456,
        totalTime: 24192,
        avgTime: 7.0,
        minTime: 1.5,
        maxTime: 45.2,
        rows: 3456,
      },
      {
        queryId: '5678901234ef0123',
        query: 'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.stock > 0 ORDER BY p.name',
        calls: 2145,
        totalTime: 85800,
        avgTime: 40.0,
        minTime: 8.5,
        maxTime: 156.3,
        rows: 964800,
      },
    ];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return [
      {
        pid: 1234,
        user: 'app_user',
        database: 'demo_db',
        applicationName: 'LibreDB Studio',
        clientAddr: '192.168.1.100',
        state: 'active',
        query: 'SELECT * FROM users WHERE id = 1',
        queryStart: new Date(Date.now() - 50),
        duration: '0.05s',
        durationMs: 50,
      },
      {
        pid: 5678,
        user: 'admin',
        database: 'demo_db',
        applicationName: 'psql',
        clientAddr: '192.168.1.1',
        state: 'idle in transaction',
        query: 'BEGIN; UPDATE products SET price = price * 1.1 WHERE category = \'Electronics\'',
        queryStart: new Date(Date.now() - 2300),
        duration: '2.3s',
        durationMs: 2300,
        waitEventType: 'Client',
        waitEvent: 'ClientRead',
      },
      {
        pid: 9012,
        user: 'app_user',
        database: 'demo_db',
        applicationName: 'LibreDB Studio',
        clientAddr: '192.168.1.101',
        state: 'active',
        query: 'INSERT INTO orders (user_id, total_amount, status) VALUES (3, 249.99, \'pending\')',
        queryStart: new Date(Date.now() - 20),
        duration: '0.02s',
        durationMs: 20,
      },
      {
        pid: 3456,
        user: 'reporting',
        database: 'demo_db',
        applicationName: 'Metabase',
        clientAddr: '192.168.1.50',
        state: 'idle',
        query: '',
        duration: '5m 12s',
        durationMs: 312000,
      },
      {
        pid: 7890,
        user: 'app_user',
        database: 'demo_db',
        applicationName: 'LibreDB Studio',
        clientAddr: '192.168.1.102',
        state: 'active',
        query: 'SELECT COUNT(*) FROM orders WHERE status = \'completed\'',
        queryStart: new Date(Date.now() - 15),
        duration: '0.015s',
        durationMs: 15,
      },
    ];
  }

  public async getTableStats(): Promise<TableStats[]> {
    return [
      {
        schemaName: 'public',
        tableName: 'orders',
        rowCount: 8900,
        liveRowCount: 8850,
        deadRowCount: 50,
        tableSize: '1.1 MB',
        tableSizeBytes: 1153434,
        indexSize: '256 KB',
        totalSize: '1.4 MB',
        totalSizeBytes: 1415578,
        lastVacuum: new Date(Date.now() - 3600000),
        lastAnalyze: new Date(Date.now() - 7200000),
        bloatRatio: 2.3,
      },
      {
        schemaName: 'public',
        tableName: 'users',
        rowCount: 1250,
        liveRowCount: 1248,
        deadRowCount: 2,
        tableSize: '144 KB',
        tableSizeBytes: 147456,
        indexSize: '64 KB',
        totalSize: '208 KB',
        totalSizeBytes: 212992,
        lastVacuum: new Date(Date.now() - 86400000),
        lastAnalyze: new Date(Date.now() - 86400000),
        bloatRatio: 0.5,
      },
      {
        schemaName: 'public',
        tableName: 'products',
        rowCount: 450,
        liveRowCount: 450,
        deadRowCount: 0,
        tableSize: '64 KB',
        tableSizeBytes: 65536,
        indexSize: '32 KB',
        totalSize: '96 KB',
        totalSizeBytes: 98304,
        lastVacuum: new Date(Date.now() - 172800000),
        lastAnalyze: new Date(Date.now() - 172800000),
        bloatRatio: 0.1,
      },
    ];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return [
      {
        schemaName: 'public',
        tableName: 'orders',
        indexName: 'orders_pkey',
        indexType: 'btree',
        columns: ['id'],
        isUnique: true,
        isPrimary: true,
        indexSize: '128 KB',
        indexSizeBytes: 131072,
        scans: 15420,
        usageRatio: 98.5,
      },
      {
        schemaName: 'public',
        tableName: 'orders',
        indexName: 'orders_user_id_idx',
        indexType: 'btree',
        columns: ['user_id'],
        isUnique: false,
        isPrimary: false,
        indexSize: '64 KB',
        indexSizeBytes: 65536,
        scans: 8750,
        usageRatio: 87.2,
      },
      {
        schemaName: 'public',
        tableName: 'orders',
        indexName: 'orders_status_idx',
        indexType: 'btree',
        columns: ['status'],
        isUnique: false,
        isPrimary: false,
        indexSize: '64 KB',
        indexSizeBytes: 65536,
        scans: 12340,
        usageRatio: 92.1,
      },
      {
        schemaName: 'public',
        tableName: 'users',
        indexName: 'users_pkey',
        indexType: 'btree',
        columns: ['id'],
        isUnique: true,
        isPrimary: true,
        indexSize: '32 KB',
        indexSizeBytes: 32768,
        scans: 24560,
        usageRatio: 99.8,
      },
      {
        schemaName: 'public',
        tableName: 'users',
        indexName: 'users_email_key',
        indexType: 'btree',
        columns: ['email'],
        isUnique: true,
        isPrimary: false,
        indexSize: '32 KB',
        indexSizeBytes: 32768,
        scans: 4520,
        usageRatio: 45.2,
      },
      {
        schemaName: 'public',
        tableName: 'products',
        indexName: 'products_pkey',
        indexType: 'btree',
        columns: ['id'],
        isUnique: true,
        isPrimary: true,
        indexSize: '16 KB',
        indexSizeBytes: 16384,
        scans: 18900,
        usageRatio: 99.2,
      },
      {
        schemaName: 'public',
        tableName: 'products',
        indexName: 'products_name_idx',
        indexType: 'btree',
        columns: ['name'],
        isUnique: false,
        isPrimary: false,
        indexSize: '16 KB',
        indexSizeBytes: 16384,
        scans: 2150,
        usageRatio: 21.5,
      },
      {
        schemaName: 'public',
        tableName: 'products',
        indexName: 'products_category_idx',
        indexType: 'btree',
        columns: ['category'],
        isUnique: false,
        isPrimary: false,
        indexSize: '8 KB',
        indexSizeBytes: 8192,
        scans: 890,
        usageRatio: 8.9,
      },
    ];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    return [
      {
        name: 'pg_default',
        location: '/var/lib/postgresql/16/main',
        size: '120 MB',
        sizeBytes: 125829120,
        usagePercent: 12.5,
      },
      {
        name: 'pg_global',
        location: '/var/lib/postgresql/16/main/global',
        size: '4 MB',
        sizeBytes: 4194304,
        usagePercent: 0.4,
      },
      {
        name: 'WAL',
        location: '/var/lib/postgresql/16/main/pg_wal',
        size: '48 MB',
        sizeBytes: 50331648,
        walSize: '48 MB',
        walSizeBytes: 50331648,
      },
    ];
  }
}
