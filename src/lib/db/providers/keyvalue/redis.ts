/**
 * Redis Database Provider
 * Key-value store support with ioredis
 *
 * Query format (JSON):
 * { "command": "GET", "args": ["key"] }
 * { "command": "KEYS", "args": ["user:*"] }
 * { "command": "HGETALL", "args": ["user:1"] }
 * { "command": "SET", "args": ["key", "value"] }
 *
 * Or plain Redis commands:
 * GET key
 * KEYS user:*
 * HGETALL user:1
 */

import Redis from "ioredis";
import { BaseDatabaseProvider } from "../../base-provider";
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
  type ProviderLabels,
  type PreparedQuery,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from "../../types";
import { DatabaseConfigError, QueryError, ConnectionError } from "../../errors";

// JSON query payload: { "command": "GET", "args": ["key"] }
type RedisJsonCommand = { command: string; args?: string[] };

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
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "json",
      // Redis says "json" only because it is not SQL. Without this the client-side
      // generators fall through to their MongoDB branch and every schema-explorer
      // action emits `{"collection":...}` that `executeRedisCommand` rejects (#427).
      queryDialect: "redis",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      // Redis commands are not SQL, so the inline row editor's `UPDATE ... SET` has
      // nothing here to run against (issue #269).
      supportsInlineRowEdit: false,
      // Redis has no constraints of any kind, and this provider's "tables" are key
      // prefixes it grouped rather than declared objects. It emits no `foreignKeys`
      // field at all; this says why (#414).
      declaresForeignKeys: false,
      // `getSchema()` SCANs 1000 keys and groups them by the text before the first
      // colon, so every row it returns is this server's own summary of real key names
      // — `user:*` is a grouping, not a key, and nothing can be addressed by it (#414).
      tablesAreDerivedGroupings: true,
      supportsMaintenance: true,
      maintenanceOperations: ["analyze"],
      supportsConnectionString: false,
      defaultPort: 6379,
      schemaRefreshPattern: "(DEL|FLUSHDB|FLUSHALL|RENAME)\\b",
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      entityName: "Key Pattern",
      entityNamePlural: "Key Patterns",
      rowName: "key",
      rowNamePlural: "keys",
      selectAction: "Scan Keys",
      generateAction: "Generate Command",
      analyzeAction: "Key Info",
      vacuumAction: "Memory Doctor",
      searchPlaceholder: "Search keys...",
      analyzeGlobalLabel: "Run Info",
      analyzeGlobalTitle: "Server Info",
      analyzeGlobalDesc: "Get Redis server information and statistics.",
      vacuumGlobalLabel: "Memory Doctor",
      vacuumGlobalTitle: "Memory Analysis",
      vacuumGlobalDesc: "Analyze memory usage and provide optimization suggestions.",
      // Stated verbatim in the agent's plan contract. Unlike MongoDB's, this sentence
      // is not about the LANGUAGE - a plan run on 2026-08-22 wrote real Redis
      // commands - but about the SHAPE it packaged them in:
      //
      //   1) KEYS session:*
      //   2) GET session:1
      //
      // `executeRedisCommand` reads the whole body as one command, so the server
      // answered `ERR unknown command '1)'`. The list numbering and the second
      // command are what made it unrunnable, so those are what this names. The
      // prefix-group sentence is here for the same reason `tablesAreDerivedGroupings`
      // exists: the inventory's rows are named `session:*`, which reads as something
      // addressable and is not (#427).
      statementLanguage:
        'exactly one Redis command, in the plain form `SCAN 0 MATCH session:* COUNT 50` or the lossless form {"command": "GET", "args": ["session:1"]} - one command and no more, with no list numbering, no bullet, no `redis-cli` prefix and no trailing semicolon; and the inventory\'s `prefix:*` rows are groupings this server summarised, not keys, so reach a prefix with SCAN ... MATCH and a key by its real name',
      // `getSlowQueries()` maps SLOWLOG GET, so an empty panel means the log is empty
      // rather than absent - a different fact from the PostgreSQL extension this used
      // to advertise (#U12), and the one a Redis operator can act on.
      slowQueriesEmptyState:
        "Redis lists what SLOWLOG holds, and nothing has yet run slower than slowlog-log-slower-than.",
    };
  }

  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: 500, offset: 0 };
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public override validate(): void {
    super.validate();
    if (!this.config.host) {
      throw new DatabaseConfigError("Redis host is required", "redis");
    }
  }

  public async connect(): Promise<void> {
    try {
      this.client = new Redis({
        host: this.config.host,
        port: this.config.port || 6379,
        password: this.config.password || undefined,
        db: this.config.database ? parseInt(this.config.database, 10) : 0,
        connectTimeout: this.queryTimeout,
        lazyConnect: true,
      });

      await this.client.connect();
      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to Redis: ${error instanceof Error ? error.message : String(error)}`,
        "redis",
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // quit() may fail if already disconnected; force disconnect
        try {
          this.client.disconnect();
        } catch {
          /* ignore */
        }
      } finally {
        this.client = null;
      }
    }
    this.setConnected(false);
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        return this.executeRedisCommand(sql);
      });

      return { ...result, executionTime };
    });
  }

  /**
   * Advance the plain tokenizer's quote state across one line of text, using the
   * SAME rule `executePlainCommand` uses: outside a quote any `"` or `'` opens
   * one, inside a quote only the matching character closes it, and there is no
   * escape handling. Returns the open quote character, or '' when none is open.
   */
  private static quoteStateAfter(text: string, quoteChar: string): string {
    let open = quoteChar;
    for (const ch of text) {
      if (open === "") {
        if (ch === '"' || ch === "'") open = ch;
      } else if (ch === open) {
        open = "";
      }
    }
    return open;
  }

  /**
   * Reduce a buffer to the ONE command it should run: drop every `#` comment
   * line, then take the first blank-line-delimited block and join its lines back
   * with a NEWLINE. A line is a comment only when it *starts* with `#` (after
   * trimming) AND no quoted argument is open across it, so a `#` inside a key or
   * value is never mistaken for one. Returns '' when nothing runnable remains
   * (#427).
   *
   * Why a block rather than a line: outside quotes the tokenizer treats a
   * newline as ordinary whitespace, so a single command wrapped across several
   * lines (`HSET k a 1` / `b 2`) has always run whole, and a pretty-printed JSON
   * command is legitimately multi-line — picking only line 1 would silently
   * half-execute both. Why not the whole buffer: the schema-explorer "Generate
   * Command" cheatsheet is a list of alternatives separated by blank lines, and
   * running the buffer must run only its first command, not all of them.
   *
   * Why the join character is a newline and not a space: the tokenizer's
   * whitespace branch is guarded by `!inQuote`, so a newline INSIDE a quoted
   * argument is data. `SET note "line1\nline2"` stores a two-line value, and
   * joining with a space silently rewrote it to `line1 line2`. A newline join
   * keeps both behaviours exactly, and lines are appended verbatim so
   * indentation inside a quoted value survives too.
   */
  /**
   * What a buffer line is to `commandBody`. Both chrome kinds require that no
   * quoted argument is open across the line: inside one, a line-leading `#` and
   * an empty line are data, not structure (#427).
   */
  private static lineKind(raw: string, quoteChar: string): "comment" | "blank" | "content" {
    if (quoteChar !== "") return "content";
    const line = raw.trim();
    if (line.startsWith("#")) return "comment";
    return line === "" ? "blank" : "content";
  }

  private commandBody(input: string): string {
    const block: string[] = [];
    let quoteChar = "";
    let isJsonBlock = false;
    for (const raw of input.split("\n")) {
      const kind = RedisProvider.lineKind(raw, quoteChar);
      if (kind === "comment") continue;
      if (kind === "blank") {
        // A blank line ends the first block; blank lines before it are leading padding.
        if (block.length > 0) break;
        continue;
      }
      // The block's kind is fixed by its first content line, using the SAME test
      // `executeRedisCommand` uses to pick a parser. Quote tracking exists only to
      // protect a `#` inside a quoted argument of a PLAIN command, and its rules
      // are the plain tokenizer's — no escape handling. Applying them to a JSON
      // body counted `\"` inside a string as a real quote, so a key named `say"hi`
      // left a phantom quote open, every later comment line stopped being dropped,
      // and the buffer reached `JSON.parse` with comments in it (#427). A JSON
      // body cannot hide a line-leading `#` inside a string — JSON strings carry
      // no literal newline — so it needs no tracking at all.
      if (block.length === 0) isJsonBlock = raw.trimStart().startsWith("{");
      block.push(raw);
      if (!isJsonBlock) quoteChar = RedisProvider.quoteStateAfter(raw, quoteChar);
    }
    return block.join("\n");
  }

  private async executeRedisCommand(input: string): Promise<Omit<QueryResult, "executionTime">> {
    const body = this.commandBody(input);
    if (body.trim() === "") {
      throw new QueryError("No command to run (only comments or blank lines)", "redis");
    }

    // Try JSON format first — over the whole block, because `JSON.stringify(cmd,
    // null, 2)` is what the MongoDB-shaped generator emits and what users paste.
    // It is also the lossless form the Redis generators fall back to for any
    // argument the plain tokenizer cannot round-trip. Trailing `#` comment lines
    // are dropped with every other comment; trailing non-comment text is not —
    // it joins the block and fails JSON.parse (#427).
    if (body.trimStart().startsWith("{")) {
      try {
        const parsed = JSON.parse(body);
        return this.executeJsonCommand(parsed);
      } catch {
        throw new QueryError("Invalid JSON command format", "redis");
      }
    }

    // Plain text command format: COMMAND arg1 arg2 ...
    return this.executePlainCommand(body);
  }

  private async executeJsonCommand(cmd: RedisJsonCommand): Promise<Omit<QueryResult, "executionTime">> {
    if (!cmd.command) {
      throw new QueryError('Command is required in JSON format: { "command": "GET", "args": ["key"] }', "redis");
    }

    const command = cmd.command.toUpperCase();
    const args = cmd.args || [];

    return this.runCommand(command, args);
  }

  private async executePlainCommand(input: string): Promise<Omit<QueryResult, "executionTime">> {
    // Parse plain text command, respecting quoted strings
    const parts: string[] = [];
    let current = "";
    let inQuote = false;
    let quoteChar = "";

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (!inQuote && (ch === '"' || ch === "'")) {
        inQuote = true;
        quoteChar = ch;
      } else if (inQuote && ch === quoteChar) {
        inQuote = false;
      } else if (!inQuote && /\s/.test(ch)) {
        if (current) {
          parts.push(current);
          current = "";
        }
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);

    if (parts.length === 0) {
      throw new QueryError("Empty command", "redis");
    }

    const command = parts[0].toUpperCase();
    const args = parts.slice(1);

    return this.runCommand(command, args);
  }

  private async runCommand(command: string, args: string[]): Promise<Omit<QueryResult, "executionTime">> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (this.client as any).call(command, ...args);
      return this.formatResult(command, result);
    } catch (error) {
      throw new QueryError(`Redis error: ${error instanceof Error ? error.message : String(error)}`, "redis");
    }
  }

  private formatResult(command: string, result: unknown): Omit<QueryResult, "executionTime"> {
    // Handle null/nil
    if (result === null || result === undefined) {
      return { rows: [{ result: "(nil)" }], fields: ["result"], rowCount: 0 };
    }

    // Handle arrays (KEYS, SMEMBERS, LRANGE, etc.)
    if (Array.isArray(result)) {
      if (result.length === 0) {
        return { rows: [{ result: "(empty list)" }], fields: ["result"], rowCount: 0 };
      }

      // HGETALL returns flat [key, val, key, val...]
      if (command === "HGETALL" && result.length % 2 === 0) {
        const rows: Record<string, unknown>[] = [];
        for (let i = 0; i < result.length; i += 2) {
          rows.push({ field: String(result[i]), value: String(result[i + 1]) });
        }
        return { rows, fields: ["field", "value"], rowCount: rows.length };
      }

      // Regular array result
      const rows = result.map((item, index) => ({
        index: index + 1,
        value: typeof item === "object" ? JSON.stringify(item) : String(item),
      }));
      return { rows, fields: ["index", "value"], rowCount: rows.length };
    }

    // Handle integers
    if (typeof result === "number") {
      return { rows: [{ result: `(integer) ${result}` }], fields: ["result"], rowCount: 1 };
    }

    // Handle strings
    if (typeof result === "string") {
      // INFO command — parse into structured output
      if (command === "INFO") {
        return this.parseInfoResult(result);
      }
      return { rows: [{ result }], fields: ["result"], rowCount: 1 };
    }

    // Fallback
    return {
      rows: [{ result: JSON.stringify(result) }],
      fields: ["result"],
      rowCount: 1,
    };
  }

  private parseInfoResult(info: string): Omit<QueryResult, "executionTime"> {
    const rows: Record<string, unknown>[] = [];
    let currentSection = "";

    for (const line of info.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) {
        currentSection = trimmed.replace("# ", "");
        continue;
      }
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        rows.push({
          section: currentSection,
          key: trimmed.substring(0, colonIdx),
          value: trimmed.substring(colonIdx + 1),
        });
      }
    }

    return { rows, fields: ["section", "key", "value"], rowCount: rows.length };
  }

  // ============================================================================
  // Schema Operations (Key patterns as "tables")
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    try {
      // Use SCAN to sample keys and group by prefix pattern
      const keyPatterns = new Map<string, { count: number; types: Set<string> }>();
      let cursor = "0";
      let totalScanned = 0;
      const maxScan = 1000;

      do {
        const [nextCursor, keys] = await this.client!.scan(cursor, "COUNT", 100);
        cursor = nextCursor;

        for (const key of keys) {
          totalScanned++;
          const prefix = this.getKeyPrefix(key);
          if (!keyPatterns.has(prefix)) {
            keyPatterns.set(prefix, { count: 0, types: new Set() });
          }
          keyPatterns.get(prefix)!.count++;

          // Sample type for first few keys per pattern
          if (keyPatterns.get(prefix)!.types.size < 3) {
            try {
              const type = await this.client!.type(key);
              keyPatterns.get(prefix)!.types.add(type);
            } catch {
              // ignore
            }
          }
        }
      } while (cursor !== "0" && totalScanned < maxScan);

      // Convert patterns to TableSchema
      const schemas: TableSchema[] = [];
      for (const [pattern, info] of keyPatterns) {
        const types = Array.from(info.types);
        schemas.push({
          name: pattern,
          columns: [
            { name: "key", type: "string", nullable: false, isPrimary: true },
            { name: "value", type: types.join("/"), nullable: true, isPrimary: false },
            { name: "type", type: types.join(", "), nullable: false, isPrimary: false },
          ],
          indexes: [],
          rowCount: info.count,
        });
      }

      return schemas.sort((a, b) => (b.rowCount || 0) - (a.rowCount || 0));
    } catch (error) {
      throw new QueryError(
        `Failed to scan Redis keys: ${error instanceof Error ? error.message : String(error)}`,
        "redis",
      );
    }
  }

  private getKeyPrefix(key: string): string {
    // Extract prefix: "user:123" -> "user:*", "session:abc:data" -> "session:*"
    const colonIdx = key.indexOf(":");
    if (colonIdx > 0) {
      return key.substring(0, colonIdx) + ":*";
    }
    return key;
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    try {
      const info = await this.client!.info();
      const parsed = this.parseRedisInfo(info);

      return {
        activeConnections: parseInt(parsed.connected_clients || "0"),
        databaseSize: parsed.used_memory_human || "0B",
        cacheHitRatio: this.calculateHitRatio(parsed),
        slowQueries: [],
        activeSessions: [],
      };
    } catch (error) {
      throw new QueryError(
        `Failed to get Redis health: ${error instanceof Error ? error.message : String(error)}`,
        "redis",
      );
    }
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();
    const info = await this.client!.info();
    const parsed = this.parseRedisInfo(info);
    const dbsize = await this.client!.dbsize();

    return {
      version: parsed.redis_version || "unknown",
      uptime: this.formatDuration(parseInt(parsed.uptime_in_seconds || "0") * 1000),
      activeConnections: parseInt(parsed.connected_clients || "0"),
      maxConnections: parseInt(parsed.maxclients || "0"),
      databaseSize: parsed.used_memory_human || "0B",
      databaseSizeBytes: parseInt(parsed.used_memory || "0"),
      tableCount: dbsize,
      indexCount: 0,
    };
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    const info = await this.client!.info();
    const parsed = this.parseRedisInfo(info);

    return {
      cacheHitRatio: parseFloat(this.calculateHitRatio(parsed)),
      queriesPerSecond: parseFloat(parsed.instantaneous_ops_per_sec || "0"),
    };
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const slowlog = (await (this.client as any).call("SLOWLOG", "GET", "10")) as unknown[][];
      if (!Array.isArray(slowlog)) return [];

      return slowlog.map((entry) => ({
        queryId: String(entry[0]),
        query: Array.isArray(entry[3]) ? (entry[3] as string[]).join(" ") : String(entry[3]),
        calls: 1,
        totalTime: Number(entry[2]) / 1000, // microseconds to ms
        avgTime: Number(entry[2]) / 1000,
        rows: 0,
      }));
    } catch {
      return [];
    }
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    try {
      const clientList = (await this.client!.client("LIST")) as string;
      const sessions: ActiveSessionDetails[] = [];

      for (const line of clientList.split("\n")) {
        if (!line.trim()) continue;
        const fields = Object.fromEntries(
          line.split(" ").map((pair) => {
            const eq = pair.indexOf("=");
            return eq > 0 ? [pair.substring(0, eq), pair.substring(eq + 1)] : [pair, ""];
          }),
        );

        sessions.push({
          pid: fields.id || "0",
          user: fields.name || "default",
          database: fields.db || "0",
          state: fields.flags || "N",
          query: fields.cmd || "idle",
          duration: `${Math.round(parseInt(fields.idle || "0"))}s`,
          durationMs: parseInt(fields.idle || "0") * 1000,
          clientAddr: fields.addr || "",
        });
      }

      return sessions;
    } catch {
      return [];
    }
  }

  public async getTableStats(): Promise<TableStats[]> {
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    const info = await this.client!.info("memory");
    const parsed = this.parseRedisInfo(info);

    return [
      {
        name: "Memory",
        size: parsed.used_memory_human || "0B",
        sizeBytes: parseInt(parsed.used_memory || "0"),
        usagePercent:
          parsed.maxmemory && parsed.maxmemory !== "0"
            ? (parseInt(parsed.used_memory || "0") / parseInt(parsed.maxmemory)) * 100
            : undefined,
      },
    ];
  }

  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    this.ensureConnected();
    const startTime = performance.now();

    try {
      switch (type) {
        case "analyze": {
          const info = await this.client!.info();
          const executionTime = Math.round(performance.now() - startTime);
          const lines = info.split("\n").length;
          return { success: true, executionTime, message: `Server info retrieved (${lines} metrics)` };
        }
      }
      throw new QueryError(`Unsupported maintenance type for Redis: ${type}`, "redis");
    } catch (error) {
      if (error instanceof QueryError) throw error;
      const executionTime = Math.round(performance.now() - startTime);
      return { success: false, executionTime, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private parseRedisInfo(info: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of info.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        result[trimmed.substring(0, colonIdx)] = trimmed.substring(colonIdx + 1);
      }
    }
    return result;
  }

  private calculateHitRatio(info: Record<string, string>): string {
    const hits = parseInt(info.keyspace_hits || "0");
    const misses = parseInt(info.keyspace_misses || "0");
    const total = hits + misses;
    if (total === 0) return "100.0";
    return ((hits / total) * 100).toFixed(1);
  }
}
