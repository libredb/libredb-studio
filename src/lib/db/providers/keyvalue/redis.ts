/**
 * Redis Database Provider
 * Key-value store support using ioredis
 */

import Redis, { type RedisOptions } from "ioredis";
import { BaseDatabaseProvider } from "../../base-provider";
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
} from "../../types";
import {
  DatabaseConfigError,
  ConnectionError,
  QueryError,
  mapDatabaseError,
} from "../../errors";
import { formatBytes } from "../../utils/pool-manager";

// ============================================================================
// Types
// ============================================================================

interface RedisCommand {
  command: string;
  args?: (string | number | Buffer)[];
}

// ============================================================================
// Redis Provider
// ============================================================================

export class RedisProvider extends BaseDatabaseProvider {
  private client: Redis | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString && !this.config.host) {
      throw new DatabaseConfigError(
        "Host or connection string is required for Redis",
        "redis"
      );
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.client && this.client.status === "ready") {
      return;
    }

    try {
      const options: RedisOptions = {
        host: this.config.host || "localhost",
        port: this.config.port || 6379,
        password: this.config.password,
        db: this.config.database ? parseInt(this.config.database, 10) : 0,
        connectTimeout: this.poolConfig.acquireTimeout,
        retryStrategy: (times) => {
          if (times > 3) return null;
          return Math.min(times * 200, 2000);
        },
      };

      // Use connection string if provided
      if (this.config.connectionString) {
        this.client = new Redis(this.config.connectionString, {
          connectTimeout: this.poolConfig.acquireTimeout,
          retryStrategy: options.retryStrategy,
        });
      } else {
        this.client = new Redis(options);
      }

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Connection timeout"));
        }, this.poolConfig.acquireTimeout);

        this.client!.once("ready", () => {
          clearTimeout(timeout);
          resolve();
        });

        this.client!.once("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Test connection
      await this.client.ping();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to Redis: ${
          error instanceof Error ? error.message : error
        }`,
        "redis",
        this.config.host,
        this.config.port
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.setConnected(false);
    }
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  /**
   * Execute a Redis command
   * Accepts JSON-formatted commands or direct Redis command strings
   *
   * @example
   * // JSON format
   * {"command": "GET", "args": ["user:123"]}
   * {"command": "SET", "args": ["user:123", "John Doe"]}
   * {"command": "KEYS", "args": ["user:*"]}
   *
   * // Direct command format
   * GET user:123
   * SET user:123 "John Doe"
   * KEYS user:*
   */
  public async query(queryStr: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(
        async () => {
          try {
            const { command, args } = this.parseQuery(queryStr);

            // Execute command
            const rawResult = await this.client!.call(command, ...(args || []));

            // Format result as table rows
            const rows = this.formatResult(command, rawResult, args || []);
            const fields = rows.length > 0 ? Object.keys(rows[0]) : [];

            return {
              rows,
              fields,
              rowCount: rows.length,
            };
          } catch (error) {
            if (error instanceof QueryError) throw error;
            throw mapDatabaseError(error, "redis", queryStr);
          }
        }
      );

      return {
        rows: result.rows,
        fields: result.fields,
        rowCount: result.rowCount,
        executionTime,
      };
    });
  }

  private parseQuery(queryStr: string): RedisCommand {
    const trimmed = queryStr.trim();

    // Try JSON format first
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed.command) {
          throw new QueryError("Command is required in query", "redis");
        }
        return {
          command: parsed.command.toUpperCase(),
          args: parsed.args || [],
        };
      } catch (error) {
        if (error instanceof QueryError) throw error;
        throw new QueryError("Invalid JSON format for Redis query", "redis");
      }
    }

    // Parse direct command format
    const parts = this.parseCommandString(trimmed);
    if (parts.length === 0) {
      throw new QueryError("Empty command", "redis");
    }

    return {
      command: parts[0].toUpperCase(),
      args: parts.slice(1),
    };
  }

  private parseCommandString(str: string): string[] {
    const parts: string[] = [];
    let current = "";
    let inQuotes = false;
    let quoteChar = "";

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if ((char === '"' || char === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuotes) {
        inQuotes = false;
        quoteChar = "";
      } else if (char === " " && !inQuotes) {
        if (current) {
          parts.push(current);
          current = "";
        }
      } else {
        current += char;
      }
    }

    if (current) {
      parts.push(current);
    }

    return parts;
  }

  private formatResult(
    command: string,
    result: unknown,
    args: (string | number | Buffer)[]
  ): Record<string, unknown>[] {
    // Handle null/undefined
    if (result === null || result === undefined) {
      return [{ result: null }];
    }

    // Handle different command types
    switch (command) {
      case "GET":
      case "GETRANGE":
      case "GETSET":
        return [{ key: args[0], value: result }];

      case "SET":
      case "SETEX":
      case "SETNX":
      case "DEL":
      case "EXPIRE":
      case "EXPIREAT":
      case "PERSIST":
        return [{ result: result === "OK" ? "OK" : result }];

      case "KEYS":
      case "SCAN":
        if (Array.isArray(result)) {
          return result.map((key) => ({ key }));
        }
        return [{ keys: result }];

      case "MGET":
        if (Array.isArray(result)) {
          return result.map((value, idx) => ({
            key: args[idx],
            value,
          }));
        }
        return [{ result }];

      case "HGETALL":
        if (typeof result === "object" && result !== null) {
          return Object.entries(result).map(([field, value]) => ({
            field,
            value,
          }));
        }
        return [{ result }];

      case "HGET":
        return [{ field: args[1], value: result }];

      case "HKEYS":
      case "HVALS":
        if (Array.isArray(result)) {
          return result.map((item) => ({ value: item }));
        }
        return [{ result }];

      case "SMEMBERS":
      case "SINTER":
      case "SUNION":
      case "SDIFF":
        if (Array.isArray(result)) {
          return result.map((member) => ({ member }));
        }
        return [{ result }];

      case "LRANGE":
        if (Array.isArray(result)) {
          return result.map((value, index) => ({ index, value }));
        }
        return [{ result }];

      case "ZRANGE":
      case "ZREVRANGE":
        if (Array.isArray(result)) {
          return result.map((member, index) => ({ rank: index, member }));
        }
        return [{ result }];

      case "INFO":
        if (typeof result === "string") {
          const lines = result
            .split("\r\n")
            .filter((line) => line && !line.startsWith("#"));
          return lines.map((line) => {
            const [key, value] = line.split(":");
            return { property: key, value: value || "" };
          });
        }
        return [{ result }];

      case "DBSIZE":
      case "TTL":
      case "STRLEN":
      case "LLEN":
      case "SCARD":
      case "HLEN":
      case "ZCARD":
        return [{ result }];

      default:
        // Generic handling
        if (Array.isArray(result)) {
          return result.map((item, index) => ({ index, value: item }));
        }
        if (typeof result === "object" && result !== null) {
          return [result as Record<string, unknown>];
        }
        return [{ result }];
    }
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  /**
   * Get schema by analyzing key patterns
   * Groups keys by pattern (e.g., user:*, session:*, etc.)
   */
  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    try {
      // Get all keys (use SCAN for production, KEYS for simplicity)
      const keys = await this.client!.keys("*");

      // Group keys by pattern
      const patterns = this.groupKeysByPattern(keys);
      const schemas: TableSchema[] = [];

      for (const [pattern, patternKeys] of Object.entries(patterns)) {
        // Sample a few keys to infer structure
        const sampleSize = Math.min(10, patternKeys.length);
        const samples = patternKeys.slice(0, sampleSize);

        const columns = await this.inferColumnsFromKeys(samples);

        schemas.push({
          name: pattern,
          rowCount: patternKeys.length,
          size: "N/A",
          columns,
          indexes: [],
          foreignKeys: [],
        });
      }

      // If no patterns found, create a default table
      if (schemas.length === 0) {
        schemas.push({
          name: "all_keys",
          rowCount: 0,
          size: "0 B",
          columns: [
            { name: "key", type: "string", nullable: false, isPrimary: true },
            { name: "type", type: "string", nullable: false, isPrimary: false },
            { name: "value", type: "string", nullable: true, isPrimary: false },
          ],
          indexes: [],
          foreignKeys: [],
        });
      }

      return schemas;
    } catch (error) {
      this.logError("getSchema", error);
      return [];
    }
  }

  private groupKeysByPattern(keys: string[]): Record<string, string[]> {
    const patterns: Record<string, string[]> = {};

    for (const key of keys) {
      // Extract pattern (e.g., "user:123" -> "user:*")
      const pattern = this.extractPattern(key);

      if (!patterns[pattern]) {
        patterns[pattern] = [];
      }
      patterns[pattern].push(key);
    }

    return patterns;
  }

  private extractPattern(key: string): string {
    // Common patterns: prefix:id, prefix:id:suffix, etc.
    const parts = key.split(":");

    if (parts.length === 1) {
      return "simple_keys";
    }

    // Replace numeric or UUID-like parts with *
    const pattern = parts
      .map((part) => {
        if (/^\d+$/.test(part)) return "*";
        if (
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            part
          )
        )
          return "*";
        return part;
      })
      .join(":");

    return pattern;
  }

  private async inferColumnsFromKeys(keys: string[]): Promise<ColumnSchema[]> {
    const columns: ColumnSchema[] = [
      { name: "key", type: "string", nullable: false, isPrimary: true },
      { name: "type", type: "string", nullable: false, isPrimary: false },
    ];

    if (keys.length === 0) {
      columns.push({
        name: "value",
        type: "string",
        nullable: true,
        isPrimary: false,
      });
      return columns;
    }

    // Check the type of the first key
    const firstKey = keys[0];
    const keyType = await this.client!.type(firstKey);

    switch (keyType) {
      case "string":
        columns.push({
          name: "value",
          type: "string",
          nullable: true,
          isPrimary: false,
        });
        columns.push({
          name: "ttl",
          type: "integer",
          nullable: true,
          isPrimary: false,
        });
        break;

      case "hash":
        columns.push({
          name: "field",
          type: "string",
          nullable: false,
          isPrimary: false,
        });
        columns.push({
          name: "value",
          type: "string",
          nullable: true,
          isPrimary: false,
        });
        break;

      case "list":
        columns.push({
          name: "index",
          type: "integer",
          nullable: false,
          isPrimary: false,
        });
        columns.push({
          name: "value",
          type: "string",
          nullable: true,
          isPrimary: false,
        });
        break;

      case "set":
        columns.push({
          name: "member",
          type: "string",
          nullable: false,
          isPrimary: false,
        });
        break;

      case "zset":
        columns.push({
          name: "member",
          type: "string",
          nullable: false,
          isPrimary: false,
        });
        columns.push({
          name: "score",
          type: "float",
          nullable: false,
          isPrimary: false,
        });
        break;

      default:
        columns.push({
          name: "value",
          type: "string",
          nullable: true,
          isPrimary: false,
        });
    }

    return columns;
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    try {
      const info = await this.client!.info();
      const infoObj = this.parseInfo(info);

      // Parse server section
      const server = infoObj.Server || {};
      const stats = infoObj.Stats || {};
      const memory = infoObj.Memory || {};
      const clients = infoObj.Clients || {};

      // Get slow log
      const slowLog = (await this.client!.call(
        "SLOWLOG",
        "GET",
        "5"
      )) as unknown[];
      const slowQueries: SlowQuery[] = (
        Array.isArray(slowLog) ? slowLog : []
      ).map((entry: unknown) => {
        const e = entry as any[];
        return {
          query: Array.isArray(e[3]) ? e[3].join(" ") : String(e[3]),
          calls: 1,
          avgTime: `${((e[2] || 0) / 1000).toFixed(2)}ms`,
        };
      });

      // Get client list for active sessions
      const clientList = (await this.client!.call("CLIENT", "LIST")) as string;
      const activeSessions: ActiveSession[] = this.parseClientList(
        clientList
      ).slice(0, 10);

      return {
        activeConnections: parseInt(clients.connected_clients || "0", 10),
        databaseSize: formatBytes(parseInt(memory.used_memory || "0", 10)),
        cacheHitRatio: this.calculateHitRatio(stats),
        slowQueries,
        activeSessions,
      };
    } catch (error) {
      this.logError("getHealth", error);
      return {
        activeConnections: 0,
        databaseSize: "N/A",
        cacheHitRatio: "N/A",
        slowQueries: [],
        activeSessions: [],
      };
    }
  }

  private parseInfo(info: string): Record<string, Record<string, string>> {
    const sections: Record<string, Record<string, string>> = {};
    let currentSection = "General";

    const lines = info.split("\r\n");
    for (const line of lines) {
      if (line.startsWith("#")) {
        currentSection = line.substring(2).trim();
        sections[currentSection] = {};
      } else if (line.includes(":")) {
        const [key, value] = line.split(":");
        if (key && value !== undefined) {
          sections[currentSection][key] = value;
        }
      }
    }

    return sections;
  }

  private calculateHitRatio(stats: Record<string, string>): string {
    const hits = parseInt(stats.keyspace_hits || "0", 10);
    const misses = parseInt(stats.keyspace_misses || "0", 10);
    const total = hits + misses;

    if (total === 0) return "N/A";

    const ratio = (hits / total) * 100;
    return `${ratio.toFixed(1)}%`;
  }

  private parseClientList(clientList: string): ActiveSession[] {
    const lines = clientList.split("\n").filter((line) => line.trim());

    return lines.map((line) => {
      const fields: Record<string, string> = {};
      line.split(" ").forEach((field) => {
        const [key, value] = field.split("=");
        if (key && value) fields[key] = value;
      });

      return {
        pid: fields.id || "N/A",
        user: fields.user || "default",
        database: fields.db || "0",
        state: fields.flags?.includes("b") ? "blocked" : "active",
        query: fields.cmd || "N/A",
        duration: fields.age ? `${fields.age}s` : "N/A",
      };
    });
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
          case "analyze":
            const dbsize = await this.client!.dbsize();
            const info = await this.client!.info("memory");
            return {
              success: true,
              message: `Database contains ${dbsize} keys. Memory info retrieved.`,
            };

          case "vacuum":
          case "optimize":
            await this.client!.bgrewriteaof();
            return {
              success: true,
              message: "Background AOF rewrite started",
            };

          case "check":
            await this.client!.ping();
            return {
              success: true,
              message: "Redis server is responding",
            };

          case "kill":
            if (!target) {
              throw new QueryError(
                "Client ID is required for kill operation",
                "redis"
              );
            }
            await this.client!.call("CLIENT", "KILL", "ID", target);
            return {
              success: true,
              message: `Killed client: ${target}`,
            };

          default:
            throw new QueryError(
              `Unsupported maintenance type for Redis: ${type}`,
              "redis"
            );
        }
      } catch (error) {
        if (error instanceof QueryError) throw error;
        throw mapDatabaseError(error, "redis");
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
      const info = await this.client!.info();
      const infoObj = this.parseInfo(info);

      const server = infoObj.Server || {};
      const memory = infoObj.Memory || {};
      const clients = infoObj.Clients || {};
      const keyspace = infoObj.Keyspace || {};

      const uptimeSeconds = parseInt(server.uptime_in_seconds || "0", 10);
      await this.client!.dbsize();

      return {
        version: `Redis ${server.redis_version || "Unknown"}`,
        uptime: this.formatUptimeString(uptimeSeconds),
        startTime: new Date(Date.now() - uptimeSeconds * 1000),
        activeConnections: parseInt(clients.connected_clients || "0", 10),
        maxConnections: parseInt(clients.maxclients || "10000", 10),
        databaseSize: formatBytes(parseInt(memory.used_memory || "0", 10)),
        databaseSizeBytes: parseInt(memory.used_memory || "0", 10),
        tableCount: Object.keys(keyspace).length,
        indexCount: 0,
      };
    } catch (error) {
      this.logError("getOverview", error);
      return {
        version: "Redis Unknown",
        uptime: "N/A",
        activeConnections: 0,
        maxConnections: 10000,
        databaseSize: "N/A",
        databaseSizeBytes: 0,
        tableCount: 0,
        indexCount: 0,
      };
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    try {
      const info = await this.client!.info();
      const infoObj = this.parseInfo(info);

      const stats = infoObj.Stats || {};
      const server = infoObj.Server || {};

      const hits = parseInt(stats.keyspace_hits || "0", 10);
      const misses = parseInt(stats.keyspace_misses || "0", 10);
      const total = hits + misses;
      const cacheHitRatio = total > 0 ? (hits / total) * 100 : 99;

      const uptimeSeconds = parseInt(server.uptime_in_seconds || "1", 10);
      const totalCommands = parseInt(stats.total_commands_processed || "0", 10);
      const queriesPerSecond = totalCommands / uptimeSeconds;

      return {
        cacheHitRatio: Math.round(cacheHitRatio * 100) / 100,
        queriesPerSecond: Math.round(queriesPerSecond * 100) / 100,
        bufferPoolUsage: 0,
        deadlocks: 0,
      };
    } catch (error) {
      this.logError("getPerformanceMetrics", error);
      return {
        cacheHitRatio: 99,
        queriesPerSecond: 0,
        bufferPoolUsage: 0,
        deadlocks: 0,
      };
    }
  }

  public async getSlowQueries(options?: {
    limit?: number;
  }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    try {
      const slowLog = (await this.client!.call(
        "SLOWLOG",
        "GET",
        String(limit)
      )) as unknown[];

      return (Array.isArray(slowLog) ? slowLog : []).map((entry: unknown) => {
        const e = entry as any[];
        return {
          query: Array.isArray(e[3]) ? e[3].join(" ") : String(e[3]),
          calls: 1,
          totalTime: (e[2] || 0) / 1000,
          avgTime: (e[2] || 0) / 1000,
          rows: 0,
        };
      });
    } catch (error) {
      this.logError("getSlowQueries", error);
      return [];
    }
  }

  public async getActiveSessions(options?: {
    limit?: number;
  }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    try {
      const clientList = (await this.client!.call("CLIENT", "LIST")) as string;
      const lines = clientList
        .split("\n")
        .filter((line: string) => line.trim())
        .slice(0, limit);

      return lines.map((line: string) => {
        const fields: Record<string, string> = {};
        line.split(" ").forEach((field: string) => {
          const [key, value] = field.split("=");
          if (key && value) fields[key] = value;
        });

        const age = parseInt(fields.age || "0", 10);
        const durationMs = age * 1000;

        return {
          pid: fields.id || "N/A",
          user: fields.user || "default",
          database: `db${fields.db || "0"}`,
          applicationName: fields.name,
          clientAddr: fields.addr?.split(":")[0],
          state: fields.flags?.includes("b") ? "blocked" : "active",
          query: fields.cmd || "N/A",
          duration: this.formatDurationString(durationMs),
          durationMs,
        };
      });
    } catch (error) {
      this.logError("getActiveSessions", error);
      return [];
    }
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();

    try {
      const keys = await this.client!.keys("*");
      const patterns = this.groupKeysByPattern(keys);
      const stats: TableStats[] = [];

      for (const [pattern, patternKeys] of Object.entries(patterns)) {
        let totalSize = 0;

        // Sample some keys to estimate size
        const sampleSize = Math.min(10, patternKeys.length);
        for (let i = 0; i < sampleSize; i++) {
          try {
            const memoryUsage = (await this.client!.call(
              "MEMORY",
              "USAGE",
              patternKeys[i]
            )) as number;
            totalSize += memoryUsage || 0;
          } catch {
            // Skip if memory usage not available
          }
        }

        // Extrapolate to all keys
        const avgSize = sampleSize > 0 ? totalSize / sampleSize : 0;
        const estimatedTotal = avgSize * patternKeys.length;

        stats.push({
          schemaName: "redis",
          tableName: pattern,
          rowCount: patternKeys.length,
          tableSize: formatBytes(estimatedTotal),
          tableSizeBytes: estimatedTotal,
          totalSize: formatBytes(estimatedTotal),
          totalSizeBytes: estimatedTotal,
        });
      }

      return stats.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes);
    } catch (error) {
      this.logError("getTableStats", error);
      return [];
    }
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    try {
      const info = await this.client!.info();
      const infoObj = this.parseInfo(info);
      const memory = infoObj.Memory || {};
      const persistence = infoObj.Persistence || {};

      const stats: StorageStats[] = [];

      stats.push({
        name: "Used Memory",
        size: formatBytes(parseInt(memory.used_memory || "0", 10)),
        sizeBytes: parseInt(memory.used_memory || "0", 10),
      });

      stats.push({
        name: "Peak Memory",
        size: formatBytes(parseInt(memory.used_memory_peak || "0", 10)),
        sizeBytes: parseInt(memory.used_memory_peak || "0", 10),
      });

      if (persistence.rdb_last_save_time) {
        stats.push({
          name: "RDB Size",
          size: formatBytes(parseInt(persistence.rdb_last_cow_size || "0", 10)),
          sizeBytes: parseInt(persistence.rdb_last_cow_size || "0", 10),
        });
      }

      if (persistence.aof_enabled === "1") {
        stats.push({
          name: "AOF Size",
          size: formatBytes(parseInt(persistence.aof_current_size || "0", 10)),
          sizeBytes: parseInt(persistence.aof_current_size || "0", 10),
        });
      }

      return stats;
    } catch (error) {
      this.logError("getStorageStats", error);
      return [];
    }
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
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }
}
