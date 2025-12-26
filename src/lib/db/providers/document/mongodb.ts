/**
 * MongoDB Database Provider
 * Document database support using official MongoDB driver
 */

import { MongoClient, type Db, type Document, type MongoClientOptions } from 'mongodb';
import { BaseDatabaseProvider } from '../../base-provider';
import {
  type DatabaseConnection,
  type TableSchema,
  type ColumnSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type SlowQuery,
  type ActiveSession,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from '../../types';
import {
  DatabaseConfigError,
  ConnectionError,
  QueryError,
  mapDatabaseError,
} from '../../errors';
import { formatBytes } from '../../utils/pool-manager';

// ============================================================================
// Types
// ============================================================================

interface MongoQuery {
  collection: string;
  operation: 'find' | 'findOne' | 'aggregate' | 'count' | 'distinct' | 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';
  filter?: Document;
  pipeline?: Document[];
  update?: Document;
  documents?: Document[];
  options?: {
    limit?: number;
    skip?: number;
    sort?: Document;
    projection?: Document;
  };
}

// ============================================================================
// MongoDB Provider
// ============================================================================

export class MongoDBProvider extends BaseDatabaseProvider {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError('Host or connection string is required for MongoDB', 'mongodb');
      }
      if (!this.config.database) {
        throw new DatabaseConfigError('Database name is required for MongoDB', 'mongodb');
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.client && this.db) {
      return;
    }

    try {
      const connectionString = this.buildConnectionString();
      const options: MongoClientOptions = {
        maxPoolSize: this.poolConfig.max,
        minPoolSize: this.poolConfig.min,
        maxIdleTimeMS: this.poolConfig.idleTimeout,
        connectTimeoutMS: this.poolConfig.acquireTimeout,
        serverSelectionTimeoutMS: this.poolConfig.acquireTimeout,
      };

      this.client = new MongoClient(connectionString, options);
      await this.client.connect();

      // Get database name from connection string or config
      const dbName = this.getDatabaseName();
      this.db = this.client.db(dbName);

      // Test connection
      await this.db.command({ ping: 1 });

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to MongoDB: ${error instanceof Error ? error.message : error}`,
        'mongodb',
        this.config.host,
        this.config.port
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.setConnected(false);
    }
  }

  private buildConnectionString(): string {
    if (this.config.connectionString) {
      return this.config.connectionString;
    }

    const auth = this.config.user && this.config.password
      ? `${encodeURIComponent(this.config.user)}:${encodeURIComponent(this.config.password)}@`
      : '';

    const host = this.config.host || 'localhost';
    const port = this.config.port || 27017;
    const database = this.config.database || 'test';

    return `mongodb://${auth}${host}:${port}/${database}`;
  }

  private getDatabaseName(): string {
    if (this.config.database) {
      return this.config.database;
    }

    // Extract from connection string
    if (this.config.connectionString) {
      const match = this.config.connectionString.match(/\/([^/?]+)(\?|$)/);
      if (match) {
        return match[1];
      }
    }

    return 'test';
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  /**
   * Execute a MongoDB query
   * Accepts JSON-formatted MQL queries
   *
   * @example
   * // Find documents
   * {"collection": "users", "operation": "find", "filter": {"age": {"$gt": 18}}, "options": {"limit": 10}}
   *
   * // Aggregate
   * {"collection": "orders", "operation": "aggregate", "pipeline": [{"$group": {"_id": "$status", "count": {"$sum": 1}}}]}
   *
   * // Insert
   * {"collection": "users", "operation": "insertOne", "documents": [{"name": "John", "email": "john@example.com"}]}
   */
  public async query(queryStr: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const query = this.parseQuery(queryStr);
          const collection = this.db!.collection(query.collection);

          let rows: Document[] = [];
          let affectedCount = 0;

          switch (query.operation) {
            case 'find':
              const cursor = collection.find(query.filter || {});
              if (query.options?.projection) cursor.project(query.options.projection);
              if (query.options?.sort) cursor.sort(query.options.sort);
              if (query.options?.skip) cursor.skip(query.options.skip);
              if (query.options?.limit) cursor.limit(query.options.limit);
              else cursor.limit(100); // Default limit
              rows = await cursor.toArray();
              break;

            case 'findOne':
              const doc = await collection.findOne(query.filter || {}, {
                projection: query.options?.projection,
              });
              rows = doc ? [doc] : [];
              break;

            case 'aggregate':
              rows = await collection.aggregate(query.pipeline || []).toArray();
              break;

            case 'count':
              const count = await collection.countDocuments(query.filter || {});
              rows = [{ count }];
              break;

            case 'distinct':
              const field = query.options?.projection ? Object.keys(query.options.projection)[0] : '_id';
              const values = await collection.distinct(field, query.filter || {});
              rows = values.map(v => ({ [field]: v }));
              break;

            case 'insertOne':
              if (!query.documents || query.documents.length === 0) {
                throw new QueryError('Document is required for insertOne', 'mongodb');
              }
              const insertOneResult = await collection.insertOne(query.documents[0]);
              rows = [{ insertedId: insertOneResult.insertedId, acknowledged: insertOneResult.acknowledged }];
              affectedCount = insertOneResult.acknowledged ? 1 : 0;
              break;

            case 'insertMany':
              if (!query.documents || query.documents.length === 0) {
                throw new QueryError('Documents are required for insertMany', 'mongodb');
              }
              const insertManyResult = await collection.insertMany(query.documents);
              rows = [{ insertedCount: insertManyResult.insertedCount, insertedIds: insertManyResult.insertedIds }];
              affectedCount = insertManyResult.insertedCount;
              break;

            case 'updateOne':
              if (!query.update) {
                throw new QueryError('Update document is required for updateOne', 'mongodb');
              }
              const updateOneResult = await collection.updateOne(query.filter || {}, query.update);
              rows = [{ matchedCount: updateOneResult.matchedCount, modifiedCount: updateOneResult.modifiedCount }];
              affectedCount = updateOneResult.modifiedCount;
              break;

            case 'updateMany':
              if (!query.update) {
                throw new QueryError('Update document is required for updateMany', 'mongodb');
              }
              const updateManyResult = await collection.updateMany(query.filter || {}, query.update);
              rows = [{ matchedCount: updateManyResult.matchedCount, modifiedCount: updateManyResult.modifiedCount }];
              affectedCount = updateManyResult.modifiedCount;
              break;

            case 'deleteOne':
              const deleteOneResult = await collection.deleteOne(query.filter || {});
              rows = [{ deletedCount: deleteOneResult.deletedCount }];
              affectedCount = deleteOneResult.deletedCount;
              break;

            case 'deleteMany':
              const deleteManyResult = await collection.deleteMany(query.filter || {});
              rows = [{ deletedCount: deleteManyResult.deletedCount }];
              affectedCount = deleteManyResult.deletedCount;
              break;

            default:
              throw new QueryError(`Unsupported operation: ${query.operation}`, 'mongodb');
          }

          // Convert ObjectId to string for display
          const serializedRows = rows.map(row => this.serializeDocument(row));

          return {
            rows: serializedRows,
            fields: serializedRows.length > 0 ? Object.keys(serializedRows[0]) : [],
            affectedCount,
          };
        } catch (error) {
          if (error instanceof QueryError) throw error;
          throw mapDatabaseError(error, 'mongodb', queryStr);
        }
      });

      return {
        rows: result.rows,
        fields: result.fields,
        rowCount: result.rows.length || result.affectedCount,
        executionTime,
      };
    });
  }

  private parseQuery(queryStr: string): MongoQuery {
    try {
      // Try to parse as JSON
      const parsed = JSON.parse(queryStr.trim());

      if (!parsed.collection) {
        throw new QueryError('Collection name is required in query', 'mongodb');
      }
      if (!parsed.operation) {
        throw new QueryError('Operation is required in query (find, findOne, aggregate, etc.)', 'mongodb');
      }

      return parsed as MongoQuery;
    } catch (error) {
      if (error instanceof QueryError) throw error;
      throw new QueryError(
        `Invalid MongoDB query format. Expected JSON with "collection" and "operation" fields. Example: {"collection": "users", "operation": "find", "filter": {}}`,
        'mongodb'
      );
    }
  }

  private serializeDocument(doc: Document): Record<string, unknown> {
    const serialized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(doc)) {
      if (value && typeof value === 'object') {
        if (value.constructor?.name === 'ObjectId') {
          serialized[key] = value.toString();
        } else if (value instanceof Date) {
          serialized[key] = value.toISOString();
        } else if (Array.isArray(value)) {
          serialized[key] = value.map(v =>
            typeof v === 'object' && v !== null ? this.serializeDocument(v) : v
          );
        } else {
          serialized[key] = this.serializeDocument(value as Document);
        }
      } else {
        serialized[key] = value;
      }
    }

    return serialized;
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  /**
   * Get schema by listing collections and sampling documents to infer field types
   */
  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const collections = await this.db!.listCollections().toArray();
    const schemas: TableSchema[] = [];

    for (const collInfo of collections) {
      const collName = collInfo.name;
      const collection = this.db!.collection(collName);

      // Get document count
      const rowCount = await collection.estimatedDocumentCount();

      // Get collection stats for size
      let sizeBytes = 0;
      try {
        const stats = await this.db!.command({ collStats: collName });
        sizeBytes = stats.size || 0;
      } catch {
        // Stats might not be available
      }

      // Sample documents to infer schema
      const sampleDocs = await collection.find({}).limit(100).toArray();
      const columns = this.inferSchemaFromDocuments(sampleDocs);

      // Get indexes
      const indexList = await collection.indexes();
      const indexes = indexList.map(idx => ({
        name: idx.name || 'unknown',
        columns: Object.keys(idx.key || {}),
        unique: idx.unique || false,
      }));

      schemas.push({
        name: collName,
        rowCount,
        size: formatBytes(sizeBytes),
        columns,
        indexes,
        foreignKeys: [], // MongoDB doesn't have foreign keys
      });
    }

    return schemas;
  }

  private inferSchemaFromDocuments(docs: Document[]): ColumnSchema[] {
    const fieldTypes = new Map<string, Set<string>>();

    for (const doc of docs) {
      this.extractFieldTypes(doc, '', fieldTypes);
    }

    const columns: ColumnSchema[] = [];

    for (const [fieldName, types] of fieldTypes) {
      const typeArray = Array.from(types);
      const type = typeArray.length === 1 ? typeArray[0] : `mixed(${typeArray.join('|')})`;

      columns.push({
        name: fieldName,
        type,
        nullable: types.has('null') || types.has('undefined'),
        isPrimary: fieldName === '_id',
        defaultValue: undefined,
      });
    }

    // Sort: _id first, then alphabetically
    columns.sort((a, b) => {
      if (a.name === '_id') return -1;
      if (b.name === '_id') return 1;
      return a.name.localeCompare(b.name);
    });

    return columns;
  }

  private extractFieldTypes(doc: Document, prefix: string, fieldTypes: Map<string, Set<string>>): void {
    for (const [key, value] of Object.entries(doc)) {
      const fieldName = prefix ? `${prefix}.${key}` : key;

      if (!fieldTypes.has(fieldName)) {
        fieldTypes.set(fieldName, new Set());
      }

      const type = this.getMongoType(value);
      fieldTypes.get(fieldName)!.add(type);

      // Don't recurse into nested objects for now (keep it flat)
      // Uncomment below to include nested fields
      // if (type === 'object' && value !== null && !Array.isArray(value)) {
      //   this.extractFieldTypes(value as Document, fieldName, fieldTypes);
      // }
    }
  }

  private getMongoType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Date) return 'date';
    if (typeof value === 'object') {
      if (value.constructor?.name === 'ObjectId') return 'objectId';
      if (value.constructor?.name === 'Binary') return 'binary';
      if (value.constructor?.name === 'Decimal128') return 'decimal';
      return 'object';
    }
    return typeof value;
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    try {
      const serverStatus = await this.db!.admin().serverStatus();
      const dbStats = await this.db!.stats();

      // Get current operations
      const currentOps = await this.db!.admin().command({ currentOp: 1 });

      const activeSessions: ActiveSession[] = (currentOps.inprog || [])
        .slice(0, 10)
        .map((op: Record<string, unknown>) => ({
          pid: op.opid || 'N/A',
          user: op.client || 'N/A',
          database: op.ns || this.getDatabaseName(),
          state: op.active ? 'active' : 'idle',
          query: JSON.stringify(op.command || {}).substring(0, 100),
          duration: (typeof op.microsecs_running === 'number' && op.microsecs_running > 0)
            ? `${(op.microsecs_running / 1000000).toFixed(2)}s`
            : 'N/A',
        }));

      const slowQueries: SlowQuery[] = [];

      // Try to get slow query info from profiler
      try {
        const profilerDocs = await this.db!.collection('system.profile')
          .find({})
          .sort({ ts: -1 })
          .limit(5)
          .toArray();

        for (const doc of profilerDocs) {
          slowQueries.push({
            query: JSON.stringify(doc.command || doc.query || {}).substring(0, 100),
            calls: 1,
            avgTime: `${doc.millis || 0}ms`,
          });
        }
      } catch {
        slowQueries.push({
          query: 'Profiler not enabled. Run db.setProfilingLevel(1) to enable.',
          calls: 0,
          avgTime: 'N/A',
        });
      }

      return {
        activeConnections: serverStatus.connections?.current || 0,
        databaseSize: formatBytes(dbStats.dataSize || 0),
        cacheHitRatio: serverStatus.wiredTiger?.cache
          ? `${((1 - (serverStatus.wiredTiger.cache['pages read into cache'] || 0) /
              Math.max(1, serverStatus.wiredTiger.cache['pages requested from the cache'] || 1)) * 100).toFixed(1)}%`
          : 'N/A',
        slowQueries,
        activeSessions,
      };
    } catch (error) {
      this.logError('getHealth', error);
      return {
        activeConnections: 0,
        databaseSize: 'N/A',
        cacheHitRatio: 'N/A',
        slowQueries: [{ query: 'Error fetching health info', calls: 0, avgTime: 'N/A' }],
        activeSessions: [],
      };
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(
    type: MaintenanceType,
    target?: string
  ): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      try {
        switch (type) {
          case 'analyze':
            // Validate collection
            if (target) {
              await this.db!.command({ validate: target });
              return { success: true, message: `Validated collection: ${target}` };
            } else {
              const collections = await this.db!.listCollections().toArray();
              for (const coll of collections) {
                await this.db!.command({ validate: coll.name });
              }
              return { success: true, message: `Validated ${collections.length} collections` };
            }

          case 'reindex':
            // Reindex collection
            if (target) {
              await this.db!.command({ reIndex: target });
              return { success: true, message: `Reindexed collection: ${target}` };
            } else {
              const collections = await this.db!.listCollections().toArray();
              for (const coll of collections) {
                await this.db!.command({ reIndex: coll.name });
              }
              return { success: true, message: `Reindexed ${collections.length} collections` };
            }

          case 'vacuum':
          case 'optimize':
            // Compact collection (similar to vacuum)
            if (target) {
              await this.db!.command({ compact: target });
              return { success: true, message: `Compacted collection: ${target}` };
            } else {
              const collections = await this.db!.listCollections().toArray();
              for (const coll of collections) {
                try {
                  await this.db!.command({ compact: coll.name });
                } catch {
                  // Some collections might not be compactable
                }
              }
              return { success: true, message: `Compacted collections` };
            }

          case 'check':
            // Run dbCheck
            const result = await this.db!.command({ dbCheck: this.getDatabaseName() });
            return {
              success: true,
              message: `Database check completed: ${JSON.stringify(result)}`
            };

          case 'kill':
            if (!target) {
              throw new QueryError('Operation ID is required for kill operation', 'mongodb');
            }
            await this.db!.admin().command({ killOp: 1, op: parseInt(target, 10) });
            return { success: true, message: `Killed operation: ${target}` };

          default:
            throw new QueryError(`Unsupported maintenance type for MongoDB: ${type}`, 'mongodb');
        }
      } catch (error) {
        if (error instanceof QueryError) throw error;
        throw mapDatabaseError(error, 'mongodb');
      }
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }

  // ============================================================================
  // Monitoring Operations
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    try {
      const serverStatus = await this.db!.admin().serverStatus();
      const dbStats = await this.db!.stats();
      const serverInfo = await this.db!.admin().command({ buildInfo: 1 });

      // Calculate uptime
      const uptimeSeconds = serverStatus.uptime || 0;
      const uptime = this.formatUptimeString(uptimeSeconds);

      // Get collection count
      const collections = await this.db!.listCollections().toArray();

      // Get index count
      let indexCount = 0;
      for (const coll of collections) {
        try {
          const indexes = await this.db!.collection(coll.name).indexes();
          indexCount += indexes.length;
        } catch {
          // Skip if can't get indexes
        }
      }

      return {
        version: `MongoDB ${serverInfo.version || 'Unknown'}`,
        uptime,
        startTime: new Date(Date.now() - uptimeSeconds * 1000),
        activeConnections: serverStatus.connections?.current || 0,
        maxConnections: serverStatus.connections?.available
          ? serverStatus.connections.current + serverStatus.connections.available
          : 100,
        databaseSize: formatBytes(dbStats.dataSize || 0),
        databaseSizeBytes: dbStats.dataSize || 0,
        tableCount: collections.length,
        indexCount,
      };
    } catch (error) {
      this.logError('getOverview', error);
      return {
        version: 'MongoDB Unknown',
        uptime: 'N/A',
        activeConnections: 0,
        maxConnections: 100,
        databaseSize: 'N/A',
        databaseSizeBytes: 0,
        tableCount: 0,
        indexCount: 0,
      };
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    try {
      const serverStatus = await this.db!.admin().serverStatus();

      // Calculate cache hit ratio from WiredTiger
      let cacheHitRatio = 99;
      if (serverStatus.wiredTiger?.cache) {
        const pagesRead = serverStatus.wiredTiger.cache['pages read into cache'] || 0;
        const pagesRequested = serverStatus.wiredTiger.cache['pages requested from the cache'] || 1;
        cacheHitRatio = Math.max(0, Math.min(100, (1 - pagesRead / Math.max(1, pagesRequested)) * 100));
      }

      // Calculate queries per second from opcounters
      const opcounters = serverStatus.opcounters || {};
      const uptimeSeconds = serverStatus.uptime || 1;
      const totalOps = (opcounters.query || 0) + (opcounters.insert || 0) +
                       (opcounters.update || 0) + (opcounters.delete || 0);
      const queriesPerSecond = totalOps / uptimeSeconds;

      // Get buffer pool usage (WiredTiger cache usage)
      let bufferPoolUsage = 0;
      if (serverStatus.wiredTiger?.cache) {
        const bytesInCache = serverStatus.wiredTiger.cache['bytes currently in the cache'] || 0;
        const maxCacheBytes = serverStatus.wiredTiger.cache['maximum bytes configured'] || 1;
        bufferPoolUsage = (bytesInCache / maxCacheBytes) * 100;
      }

      return {
        cacheHitRatio: Math.round(cacheHitRatio * 100) / 100,
        queriesPerSecond: Math.round(queriesPerSecond * 100) / 100,
        bufferPoolUsage: Math.round(bufferPoolUsage * 100) / 100,
        deadlocks: 0, // MongoDB doesn't have traditional deadlocks
      };
    } catch (error) {
      this.logError('getPerformanceMetrics', error);
      return {
        cacheHitRatio: 99,
        queriesPerSecond: 0,
        bufferPoolUsage: 0,
        deadlocks: 0,
      };
    }
  }

  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    try {
      // Try to get slow queries from system.profile
      const profilerDocs = await this.db!.collection('system.profile')
        .find({})
        .sort({ millis: -1 })
        .limit(limit)
        .toArray();

      return profilerDocs.map((doc) => ({
        query: JSON.stringify(doc.command || doc.query || {}).substring(0, 500),
        calls: 1,
        totalTime: doc.millis || 0,
        avgTime: doc.millis || 0,
        rows: doc.nreturned || 0,
      }));
    } catch {
      // Profiler not enabled or system.profile doesn't exist
      return [];
    }
  }

  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    try {
      const currentOps = await this.db!.admin().command({ currentOp: 1, $all: true });

      return (currentOps.inprog || [])
        .slice(0, limit)
        .map((op: Document) => {
          const microseconds = op.microsecs_running || 0;
          const durationMs = microseconds / 1000;

          return {
            pid: op.opid || 'N/A',
            user: op.client || 'N/A',
            database: op.ns?.split('.')[0] || this.getDatabaseName(),
            applicationName: op.appName || undefined,
            clientAddr: op.client?.split(':')[0] || undefined,
            state: op.active ? 'active' : 'idle',
            query: JSON.stringify(op.command || {}).substring(0, 500),
            duration: this.formatDurationString(durationMs),
            durationMs,
            waitEventType: op.waitingForLock ? 'Lock' : undefined,
            waitEvent: op.lockStats ? 'Acquiring lock' : undefined,
          };
        });
    } catch (error) {
      this.logError('getActiveSessions', error);
      return [];
    }
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();

    const collections = await this.db!.listCollections().toArray();
    const stats: TableStats[] = [];

    for (const collInfo of collections) {
      const collName = collInfo.name;

      try {
        const collStats = await this.db!.command({ collStats: collName });

        stats.push({
          schemaName: this.getDatabaseName(),
          tableName: collName,
          rowCount: collStats.count || 0,
          tableSize: formatBytes(collStats.size || 0),
          tableSizeBytes: collStats.size || 0,
          indexSize: formatBytes(collStats.totalIndexSize || 0),
          totalSize: formatBytes((collStats.size || 0) + (collStats.totalIndexSize || 0)),
          totalSizeBytes: (collStats.size || 0) + (collStats.totalIndexSize || 0),
        });
      } catch {
        // Skip if can't get stats for this collection
      }
    }

    // Sort by total size descending
    return stats.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes);
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();

    const collections = await this.db!.listCollections().toArray();
    const stats: IndexStats[] = [];

    for (const collInfo of collections) {
      const collName = collInfo.name;
      const collection = this.db!.collection(collName);

      try {
        // Get index stats using aggregation
        const indexStatsDocs = await collection.aggregate([{ $indexStats: {} }]).toArray();

        // Get index definitions
        const indexes = await collection.indexes();

        for (const idx of indexes) {
          const indexStats = indexStatsDocs.find((s) => s.name === idx.name);

          stats.push({
            schemaName: this.getDatabaseName(),
            tableName: collName,
            indexName: idx.name || 'unknown',
            indexType: idx.key ? Object.values(idx.key).includes('text') ? 'text' : 'btree' : 'btree',
            columns: Object.keys(idx.key || {}),
            isUnique: idx.unique || false,
            isPrimary: idx.name === '_id_',
            indexSize: 'N/A',
            indexSizeBytes: 0,
            scans: indexStats?.accesses?.ops || 0,
          });
        }
      } catch {
        // Skip if can't get index stats for this collection
      }
    }

    return stats;
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    const stats: StorageStats[] = [];

    try {
      const dbStats = await this.db!.stats();
      const serverStatus = await this.db!.admin().serverStatus();

      // Database data size
      stats.push({
        name: 'Data',
        location: this.getDatabaseName(),
        size: formatBytes(dbStats.dataSize || 0),
        sizeBytes: dbStats.dataSize || 0,
      });

      // Index size
      stats.push({
        name: 'Indexes',
        size: formatBytes(dbStats.indexSize || 0),
        sizeBytes: dbStats.indexSize || 0,
      });

      // Storage size (includes pre-allocated space)
      stats.push({
        name: 'Storage',
        size: formatBytes(dbStats.storageSize || 0),
        sizeBytes: dbStats.storageSize || 0,
      });

      // WiredTiger cache if available
      if (serverStatus.wiredTiger?.cache) {
        const bytesInCache = serverStatus.wiredTiger.cache['bytes currently in the cache'] || 0;
        const maxCache = serverStatus.wiredTiger.cache['maximum bytes configured'] || 0;

        stats.push({
          name: 'WiredTiger Cache',
          size: formatBytes(bytesInCache),
          sizeBytes: bytesInCache,
          usagePercent: maxCache > 0 ? (bytesInCache / maxCache) * 100 : 0,
        });
      }
    } catch (error) {
      this.logError('getStorageStats', error);
    }

    return stats;
  }

  private formatUptimeString(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  private formatDurationString(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }
}
