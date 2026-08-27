/**
 * MongoDB Database Provider
 * Document database support using official MongoDB driver
 */

import { MongoClient, ObjectId, Binary, Decimal128, type Db, type Document, type MongoClientOptions } from "mongodb";
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
  type ProviderCapabilities,
  type ProviderLabels,
  type PreparedQuery,
  type QueryPrepareOptions,
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
import { DatabaseConfigError, ConnectionError, QueryError, mapDatabaseError } from "../../errors";
import { formatBytes } from "../../utils/pool-manager";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio, measuredNumber } from "@/lib/monitoring-cache-ratio";

// ============================================================================
// Types
// ============================================================================

interface MongoQuery {
  collection: string;
  operation:
    | "find"
    | "findOne"
    | "aggregate"
    | "count"
    | "distinct"
    | "insertOne"
    | "insertMany"
    | "updateOne"
    | "updateMany"
    | "deleteOne"
    | "deleteMany";
  filter?: Document;
  pipeline?: Document[];
  update?: Document;
  documents?: Document[];
  // `distinct` only, and the driver's own parameter name. Typed as unknown because
  // parseQuery() casts unvalidated JSON: the dispatch re-checks it the way it
  // re-checks `operation`.
  field?: unknown;
  options?: {
    limit?: number;
    skip?: number;
    sort?: Document;
    projection?: Document;
  };
}

// Operations query() accepts. parseQuery() casts unvalidated JSON, so the
// operation value is re-checked against this set at runtime before dispatch.
const SUPPORTED_OPERATIONS: ReadonlySet<MongoQuery["operation"]> = new Set([
  "find",
  "findOne",
  "aggregate",
  "count",
  "distinct",
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
]);

/**
 * How deep `inferSchemaFromDocuments` walks a subdocument, counting the top level as
 * 1 — so `shipping.geo.lat` is named and `shipping.geo.deep.tooFar` is not. Three
 * levels is where the dotted paths a query actually groups or filters on live; past
 * that the tree stops describing the collection and starts transcribing one document.
 * The container at the boundary is still listed, so the nesting continuing is visible.
 */
const MAX_NESTED_FIELD_DEPTH = 3;

/**
 * Upper bound on the fields one collection reports. Nesting multiplies, and both
 * consumers of this list are bounded surfaces: the schema tree a person scrolls and
 * the inventory an agent run is given.
 */
const MAX_INFERRED_FIELDS = 200;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The WiredTiger cache hit ratio, or `undefined` when there is nothing to compute
 * one from.
 *
 * Two different absences, and neither is a number: a deployment can publish no
 * `wiredTiger` section at all (mongos, the in-memory storage engine, the
 * wire-compatible services), and a freshly opened one publishes the section with a
 * request count of 0, where there are no hits and no misses rather than perfect
 * hits. Both used to reach the panel as 99% - a figure this provider invented, not
 * one the server ever reported (#424, and the rule #448/#452 settled).
 */
function wiredTigerCacheHitRatio(cache: Document | undefined): number | undefined {
  const requested = measuredNumber(cache?.["pages requested from the cache"]);
  const read = measuredNumber(cache?.["pages read into cache"]);
  if (requested === undefined || read === undefined || requested === 0) return undefined;
  return round2(Math.max(0, Math.min(100, (1 - read / requested) * 100)));
}

/**
 * How much of the configured WiredTiger cache currently holds data, or `undefined`
 * when the section is absent. A measured 0 is kept: an untouched cache really does
 * hold nothing.
 */
function wiredTigerCacheUsage(cache: Document | undefined): number | undefined {
  const bytes = measuredNumber(cache?.["bytes currently in the cache"]);
  const maxBytes = measuredNumber(cache?.["maximum bytes configured"]);
  if (bytes === undefined || maxBytes === undefined || maxBytes === 0) return undefined;
  return round2(Math.max(0, Math.min(100, (bytes / maxBytes) * 100)));
}

// Maintenance operations runMaintenance() accepts; validated the same way.
const SUPPORTED_MAINTENANCE_TYPES: ReadonlySet<MaintenanceType> = new Set([
  "analyze",
  "reindex",
  "vacuum",
  "optimize",
  "check",
  "kill",
]);

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
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "json",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      // The query language is JSON commands, not SQL, so the inline row editor's
      // `UPDATE ... SET` has nothing here to run against (issue #269).
      supportsInlineRowEdit: false,
      // Multi-document transactions need a client session this provider does not hold.
      supportsTransactions: false,
      // MongoDB has no foreign key constraint at all, so `getSchema()`'s empty
      // `foreignKeys` is the engine's model rather than this database's shape. A
      // reader told only "none were found" would hedge over causes that do not apply
      // here (#414).
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "analyze", "check"],
      // `validate` and `compact` are both per-collection commands that this provider
      // also loops over `listCollections()` when no target is named, so both
      // placements are real. `dbCheck` is not looped and refuses to run without a
      // collection name, so it is offered on a collection row only (#U9).
      maintenanceOperationSpecs: {
        vacuum: { label: "Compact Collection", perEntity: true, global: true },
        analyze: { label: "Validate Collection", perEntity: true, global: true },
        check: { label: "Check Collection", perEntity: true, global: false },
      },
      supportsConnectionString: true,
      defaultPort: 27017,
      schemaRefreshPattern: '"operation"\\s*:\\s*"(insert|delete|update)',
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      entityName: "Collection",
      entityNamePlural: "Collections",
      rowName: "document",
      rowNamePlural: "documents",
      selectAction: "Find Documents",
      generateAction: "Generate Find",
      analyzeAction: "Validate Collection",
      vacuumAction: "Compact Collection",
      searchPlaceholder: "Search collections or fields...",
      analyzeGlobalLabel: "Run Validate",
      analyzeGlobalTitle: "Validate Collections",
      analyzeGlobalDesc: "Checks collection structure and indexes integrity for all collections.",
      vacuumGlobalLabel: "Run Compact",
      vacuumGlobalTitle: "Compact Storage",
      vacuumGlobalDesc: "Defragments and compacts collection storage to reclaim disk space.",
      // Stated verbatim in the agent's plan contract, and needed for the reason the
      // search products needed theirs: told to write "one runnable statement in this
      // MongoDB database's own query language", a live plan run on 2026-08-22 wrote
      // mongosh - `db.orders.aggregate([{ $group: ... }])`. That is correct MongoDB
      // and unrunnable here, because `query()` parses the JSON command object and
      // nothing else, so what the user was handed was a plan they could not execute.
      // The sentence therefore carries the envelope itself and names the shell form
      // it excludes: naming only what the language IS did not survive contact with
      // the model's prior on Elasticsearch, and does not here either.
      statementLanguage:
        'the JSON command object this editor executes - {"collection": "<name>", "operation": "find" | "findOne" | "aggregate" | "count" | "distinct", "filter": {...}, "pipeline": [...], "field": "<name>" (distinct only), "options": {"limit": 50}} - and NOT mongosh shell syntax: a statement that starts with `db.` cannot be run here',
      // `getSlowQueries()` reads `system.profile`, which does not exist until the
      // profiler is switched on - so the empty panel is the ordinary case here, and it
      // used to name a PostgreSQL extension (#U12).
      slowQueriesEmptyState:
        "Query stats come from the database profiler - run db.setProfilingLevel() to start recording into system.profile.",
    };
  }

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    return { query, wasLimited: false, limit: options.limit || 100, offset: 0 };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError("Host or connection string is required for MongoDB", "mongodb");
      }
      if (!this.config.database) {
        throw new DatabaseConfigError("Database name is required for MongoDB", "mongodb");
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
        ...this.buildTLSOptions(),
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
        "mongodb",
        this.config.host,
        this.config.port,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } finally {
        this.client = null;
        this.db = null;
        this.setConnected(false);
      }
    }
  }

  /**
   * `tls`, `ca`, `cert`, `key` and `rejectUnauthorized` are all on the driver's own
   * allow-list of TLS options (`LEGAL_TLS_SOCKET_OPTIONS` in mongodb/lib/cmap/connect.js)
   * and reach `tls.connect` under Node's names, so the connection form's material maps
   * the same way it does for PostgreSQL, MySQL and Couchbase. `require` encrypts
   * without checking the chain, because a self-hosted replica set presents a
   * self-signed certificate; the verifying modes check it. An explicit flag wins.
   *
   * Unlike `authSource`, this is applied with a pasted `connectionString` as well: the
   * URI is returned verbatim so a `tls=` cannot be appended to it, but the options
   * object is a second channel the driver reads, and the dialog shows the SSL panel in
   * connection-string mode too.
   */
  private buildTLSOptions(): MongoClientOptions {
    const ssl = this.config.ssl;
    if (!ssl || ssl.mode === "disable") return {};

    const options: MongoClientOptions = {
      tls: true,
      // `require` encrypts without checking; every other mode verifies. `verify-system`
      // does it against the runtime's own trust store, which is what an Atlas / `tls=true`
      // paste needs - no `ca` is set below unless the form carries one (D26).
      rejectUnauthorized: ssl.rejectUnauthorized ?? ssl.mode !== "require",
    };
    if (ssl.caCert) options.ca = ssl.caCert;
    if (ssl.clientCert) options.cert = ssl.clientCert;
    if (ssl.clientKey) options.key = ssl.clientKey;
    return options;
  }

  private buildConnectionString(): string {
    if (this.config.connectionString) {
      return this.config.connectionString;
    }

    const auth =
      this.config.user && this.config.password
        ? `${encodeURIComponent(this.config.user)}:${encodeURIComponent(this.config.password)}@`
        : "";

    const host = this.config.host || "localhost";
    const port = this.config.port || 27017;
    const database = this.config.database || "test";

    // The database the credentials live in, which is not always the one being opened:
    // without it the driver authenticates against the database in the path, so users
    // in `admin` and data elsewhere - the ordinary deployment - failed as a
    // credentials error. A pasted connection string returned above carries its own.
    const authSource = this.config.authSource ? `?authSource=${encodeURIComponent(this.config.authSource)}` : "";

    return `mongodb://${auth}${host}:${port}/${database}${authSource}`;
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

    return "test";
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

          if (!SUPPORTED_OPERATIONS.has(query.operation)) {
            throw new QueryError(`Unsupported operation: ${query.operation}`, "mongodb");
          }

          let rows: Document[] = [];
          let affectedCount = 0;

          switch (query.operation) {
            case "find": {
              const cursor = collection.find(query.filter || {});
              if (query.options?.projection) cursor.project(query.options.projection);
              if (query.options?.sort) cursor.sort(query.options.sort);
              if (query.options?.skip) cursor.skip(query.options.skip);
              if (query.options?.limit) cursor.limit(query.options.limit);
              else cursor.limit(100); // Default limit
              try {
                rows = await cursor.toArray();
              } finally {
                await cursor.close();
              }
              break;
            }

            case "findOne": {
              const doc = await collection.findOne(query.filter || {}, {
                projection: query.options?.projection,
              });
              rows = doc ? [doc] : [];
              break;
            }

            case "aggregate":
              rows = await collection.aggregate(query.pipeline || []).toArray();
              break;

            case "count":
              const count = await collection.countDocuments(query.filter || {});
              rows = [{ count }];
              break;

            case "distinct": {
              // Named, and required. The field used to be the FIRST KEY of
              // `options.projection` with `_id` as the fallback, which meant
              // `{"operation":"distinct","field":"category"}` - the driver's own
              // spelling - answered 120 rows of `_id` on a live probe (2026-08-22,
              // 120 products in five categories). A plausible list is worse than an
              // error, so the projection spelling is gone rather than aliased:
              // nothing in the product generates a `distinct`.
              const field = query.field;
              if (typeof field !== "string" || field.length === 0) {
                throw new QueryError(
                  'distinct requires a "field": the name of the field to collect values of',
                  "mongodb",
                );
              }
              const values = await collection.distinct(field, query.filter || {});
              rows = values.map((v) => ({ [field]: v }));
              break;
            }

            case "insertOne":
              if (!query.documents || query.documents.length === 0) {
                throw new QueryError("Document is required for insertOne", "mongodb");
              }
              const insertOneResult = await collection.insertOne(query.documents[0]);
              rows = [{ insertedId: insertOneResult.insertedId, acknowledged: insertOneResult.acknowledged }];
              affectedCount = insertOneResult.acknowledged ? 1 : 0;
              break;

            case "insertMany":
              if (!query.documents || query.documents.length === 0) {
                throw new QueryError("Documents are required for insertMany", "mongodb");
              }
              const insertManyResult = await collection.insertMany(query.documents);
              rows = [{ insertedCount: insertManyResult.insertedCount, insertedIds: insertManyResult.insertedIds }];
              affectedCount = insertManyResult.insertedCount;
              break;

            case "updateOne":
              if (!query.update) {
                throw new QueryError("Update document is required for updateOne", "mongodb");
              }
              const updateOneResult = await collection.updateOne(query.filter || {}, query.update);
              rows = [{ matchedCount: updateOneResult.matchedCount, modifiedCount: updateOneResult.modifiedCount }];
              affectedCount = updateOneResult.modifiedCount;
              break;

            case "updateMany":
              if (!query.update) {
                throw new QueryError("Update document is required for updateMany", "mongodb");
              }
              const updateManyResult = await collection.updateMany(query.filter || {}, query.update);
              rows = [{ matchedCount: updateManyResult.matchedCount, modifiedCount: updateManyResult.modifiedCount }];
              affectedCount = updateManyResult.modifiedCount;
              break;

            case "deleteOne":
              const deleteOneResult = await collection.deleteOne(query.filter || {});
              rows = [{ deletedCount: deleteOneResult.deletedCount }];
              affectedCount = deleteOneResult.deletedCount;
              break;

            case "deleteMany":
              const deleteManyResult = await collection.deleteMany(query.filter || {});
              rows = [{ deletedCount: deleteManyResult.deletedCount }];
              affectedCount = deleteManyResult.deletedCount;
              break;
          }

          // Convert ObjectId to string for display
          const serializedRows = rows.map((row) => this.serializeDocument(row));

          return {
            rows: serializedRows,
            fields: serializedRows.length > 0 ? Object.keys(serializedRows[0]) : [],
            affectedCount,
          };
        } catch (error) {
          if (error instanceof QueryError) throw error;
          throw mapDatabaseError(error, "mongodb", queryStr);
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
        throw new QueryError("Collection name is required in query", "mongodb");
      }
      if (!parsed.operation) {
        throw new QueryError("Operation is required in query (find, findOne, aggregate, etc.)", "mongodb");
      }

      return parsed as MongoQuery;
    } catch (error) {
      if (error instanceof QueryError) throw error;
      throw new QueryError(
        `Invalid MongoDB query format. Expected JSON with "collection" and "operation" fields. Example: {"collection": "users", "operation": "find", "filter": {}}`,
        "mongodb",
      );
    }
  }

  private serializeDocument(doc: Document): Record<string, unknown> {
    const serialized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(doc)) {
      if (value === null || value === undefined) {
        serialized[key] = value;
      } else if (typeof value === "object") {
        if (value instanceof ObjectId) {
          serialized[key] = value.toString();
        } else if (value instanceof Binary) {
          serialized[key] = `<Binary: ${value.length()} bytes>`;
        } else if (value instanceof Decimal128) {
          serialized[key] = value.toString();
        } else if (value instanceof Date) {
          serialized[key] = value.toISOString();
        } else if (Array.isArray(value)) {
          serialized[key] = value.map((v) => (typeof v === "object" && v !== null ? this.serializeDocument(v) : v));
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
   *
   * A VIEW is listed like any other object, with the three questions a view cannot
   * answer simply not asked of it. `listCollections()` returns views, and MongoDB
   * rejects `count`, `listIndexes` and `collStats` on one with
   * `CommandNotSupportedOnView` (code 166) — so before #414 a single view in the
   * database threw out of this loop and the user lost the WHOLE schema read, not just
   * the view.
   *
   * Filtering views out of the listing was the alternative and it loses more than it
   * fixes: a view is an object the user created, they see it in this product's own
   * sidebar, and its fields are readable by exactly the document sample taken below.
   * Hiding it would answer "your view does not exist" to keep three commands quiet.
   *
   * The guard reads `collInfo.type`, which the server has already told us, rather than
   * wrapping the calls in `try/catch`. A catch cannot tell code 166 from a genuine
   * failure without inspecting the error anyway, and the honest fallback for a caught
   * count is not `0` — a view is not empty, its row count is unknown. Reading the type
   * also spends no round trip on a command known to be refused.
   */
  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const allCollections = await this.db!.listCollections().toArray();
    // Skip system collections and limit to 200 collections for performance
    const collections = allCollections.filter((c) => !c.name.startsWith("system.")).slice(0, 200);
    const schemas: TableSchema[] = [];

    for (const collInfo of collections) {
      const collName = collInfo.name;
      const collection = this.db!.collection(collName);
      const isView = collInfo.type === "view";

      // Get document count. Left ABSENT on a view rather than reported as 0: a view
      // holds no documents of its own, and a zero would read as "this view is empty".
      const rowCount = isView ? undefined : await collection.estimatedDocumentCount();

      // Get collection stats for size. A view stores nothing, so it has no size to
      // state; the try/catch stays for a collection whose stats are unavailable.
      let sizeBytes: number | undefined;
      if (!isView) {
        // Unchanged for a collection, including its long-standing fallback: a
        // collection whose stats this role cannot read still reports 0 B.
        sizeBytes = 0;
        try {
          const stats = await this.db!.command({ collStats: collName });
          sizeBytes = stats.size || 0;
        } catch {
          // Stats might not be available
        }
      }

      // Sample documents to infer schema. This works on a view exactly as it works on
      // a collection, which is why a view is worth listing at all.
      const sampleDocs = await collection.find({}).limit(100).toArray();
      const columns = this.inferSchemaFromDocuments(sampleDocs);

      // Get indexes. A view has none of its own — the indexes its query uses belong to
      // the collection underneath it, and claiming them here would misattribute them.
      const indexList = isView ? [] : await collection.indexes();
      const indexes = indexList.map((idx) => ({
        name: idx.name || "unknown",
        columns: Object.keys(idx.key || {}),
        unique: idx.unique || false,
      }));

      schemas.push({
        name: collName,
        ...(rowCount === undefined ? {} : { rowCount }),
        ...(sizeBytes === undefined ? {} : { size: formatBytes(sizeBytes) }),
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
      this.extractFieldTypes(doc, "", fieldTypes);
    }

    const columns: ColumnSchema[] = [];

    for (const [fieldName, types] of fieldTypes) {
      const typeArray = Array.from(types);
      const type = typeArray.length === 1 ? typeArray[0] : `mixed(${typeArray.join("|")})`;

      columns.push({
        name: fieldName,
        type,
        nullable: types.has("null") || types.has("undefined"),
        isPrimary: fieldName === "_id",
        defaultValue: undefined,
      });
    }

    // Sort: _id first, then alphabetically
    columns.sort((a, b) => {
      if (a.name === "_id") return -1;
      if (b.name === "_id") return 1;
      return a.name.localeCompare(b.name);
    });

    // Bounded AFTER sorting, so what survives is a deterministic prefix rather than
    // whichever fields the sampled documents happened to mention first - and `_id`,
    // the field every generated statement addresses, always survives. The bound
    // exists because nesting multiplies: a document with 60 subdocuments of 10 fields
    // each is 661 rows in the schema tree and 661 lines in a model's context window,
    // for one collection. Same reason `getSchema` already stops at 200 collections.
    return columns.slice(0, MAX_INFERRED_FIELDS);
  }

  private extractFieldTypes(doc: Document, prefix: string, fieldTypes: Map<string, Set<string>>, depth = 1): void {
    for (const [key, value] of Object.entries(doc)) {
      const fieldName = prefix ? `${prefix}.${key}` : key;

      if (!fieldTypes.has(fieldName)) {
        fieldTypes.set(fieldName, new Set());
      }

      const type = this.getMongoType(value);
      fieldTypes.get(fieldName)!.add(type);

      // Descend into subdocuments, because `shipping.city` is a field name in this
      // engine's own query language and a schema that stops at `shipping: object`
      // does not name it. That absence is not only cosmetic: the same inventory
      // grounds an agent plan run, and a run on 2026-08-22 grouped by
      // `$shipping.region` - a path the database does not have - which MongoDB
      // answers with a single null group rather than an error, so the plan read as
      // runnable and was silently wrong.
      //
      // `getMongoType` has already ruled out every object that is really a scalar
      // (Date, ObjectId, Binary, Decimal128) and arrays, which are deliberately left
      // closed: `items.sku` addresses one value PER ARRAY ENTRY, so it does not mean
      // on an array what the same syntax means on a subdocument, and listing it
      // beside the others would invite exactly that confusion.
      if (type === "object" && depth < MAX_NESTED_FIELD_DEPTH) {
        this.extractFieldTypes(value as Document, fieldName, fieldTypes, depth + 1);
      }
    }
  }

  private getMongoType(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) return "array";
    if (value instanceof Date) return "date";
    if (value instanceof ObjectId) return "objectId";
    if (value instanceof Binary) return "binary";
    if (value instanceof Decimal128) return "decimal";
    if (typeof value === "object") return "object";
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
          pid: op.opid || "N/A",
          user: op.client || "N/A",
          database: op.ns || this.getDatabaseName(),
          state: op.active ? "active" : "idle",
          query: JSON.stringify(op.command || {}).substring(0, 100),
          duration:
            typeof op.microsecs_running === "number" && op.microsecs_running > 0
              ? `${(op.microsecs_running / 1000000).toFixed(2)}s`
              : "N/A",
        }));

      const slowQueries: SlowQuery[] = [];

      // Try to get slow query info from profiler
      try {
        const profilerDocs = await this.db!.collection("system.profile").find({}).sort({ ts: -1 }).limit(5).toArray();

        for (const doc of profilerDocs) {
          slowQueries.push({
            query: JSON.stringify(doc.command || doc.query || {}).substring(0, 100),
            calls: 1,
            avgTime: `${doc.millis || 0}ms`,
          });
        }
      } catch {
        slowQueries.push({
          query: "Profiler not enabled. Run db.setProfilingLevel(1) to enable.",
          calls: 0,
          avgTime: "N/A",
        });
      }

      const healthCacheHitRatio = wiredTigerCacheHitRatio(serverStatus.wiredTiger?.cache);

      // measuredNumber and a conditional spread, not `|| 0`, for the same reason
      // `HealthInfo.activeConnections` is optional: an API-compatible service - or any
      // deployment whose serverStatus answers without a `connections` section - publishes
      // no figure. `connections` is a network-layer field, so unlike `wiredTiger` above
      // its absence is not tied to the storage engine, and which deployments omit it is
      // not measured here. The agent's curated health reading forwards this key to
      // the model (`src/lib/agent/tools.ts` projects it with `?? null`), so a
      // fabricated 0 told the model a server it could not measure had nothing
      // connected. A server that really has 0 open connections keeps the 0.
      const currentConnections = measuredNumber(serverStatus.connections?.current);

      // The byte figure has the same two inputs, and this is the method whose reading
      // reaches the model - the curated `health` projection sends `databaseSize` verbatim
      // - so `dbStats.dataSize || 0` reported a `db.stats()` that answered without the
      // field as a measured "0 B". `HealthInfo.databaseSize` is a required string, and
      // "N/A" is the absence this method's own catch below already spells. MongoDB's
      // dbStats reference documents `dataSize` unconditionally (only the three
      // `freeStorage*` fields are gated, on the command's own `freeStorage: 1` option), so
      // this arm is not a deployment measured here; a database that really holds 0 bytes
      // still formats as "0 B".
      const healthDataSize = measuredNumber(dbStats.dataSize);

      return {
        ...(currentConnections === undefined ? {} : { activeConnections: currentConnections }),
        databaseSize: healthDataSize === undefined ? "N/A" : formatBytes(healthDataSize),
        cacheHitRatio:
          healthCacheHitRatio === undefined
            ? CACHE_HIT_RATIO_UNAVAILABLE
            : `${formatCacheHitRatio(healthCacheHitRatio)}%`,
        slowQueries,
        activeSessions,
      };
    } catch (error) {
      this.logError("getHealth", error);
      // A resolved HealthInfo on purpose, NOT a rethrow: `POST /api/db/health`
      // serialises what this resolves with and `POST /api/admin/fleet-health` reads
      // `healthy` from a read that returned, so rethrowing here would report a server
      // that is up as an error - the health-gate lockout class. What it must not do is
      // name a figure: nothing was read, so `activeConnections` is omitted entirely
      // rather than resolved as a measured 0.
      return {
        databaseSize: "N/A",
        cacheHitRatio: "N/A",
        slowQueries: [{ query: "Error fetching health info", calls: 0, avgTime: "N/A" }],
        activeSessions: [],
      };
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      try {
        // Callers pass unvalidated JSON, so the type is re-checked before dispatch
        // (same pattern as SUPPORTED_OPERATIONS in query()).
        if (!SUPPORTED_MAINTENANCE_TYPES.has(type)) {
          throw new QueryError(`Unsupported maintenance type for MongoDB: ${type}`, "mongodb");
        }
        switch (type) {
          case "analyze":
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

          case "reindex":
            // reIndex was removed in MongoDB 6.0+
            return {
              success: false,
              message: "Reindex is not supported in MongoDB 6.0+. Use compact instead to defragment collections.",
            };

          case "vacuum":
          case "optimize":
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

          case "check": {
            // Run dbCheck — requires a collection name as target
            if (!target) {
              throw new QueryError("Collection name is required for dbCheck operation", "mongodb");
            }
            const checkResult = await this.db!.command({ dbCheck: target });
            return {
              success: true,
              message: `Database check completed for ${target}: ${JSON.stringify(checkResult)}`,
            };
          }

          case "kill":
            if (!target) {
              throw new QueryError("Operation ID is required for kill operation", "mongodb");
            }
            await this.db!.admin().command({ killOp: 1, op: parseInt(target, 10) });
            return { success: true, message: `Killed operation: ${target}` };
        }
      } catch (error) {
        if (error instanceof QueryError) throw error;
        throw mapDatabaseError(error, "mongodb");
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

      // The limit is what the server has plus what it is still willing to hand out.
      // A truthiness test read an exhausted pool (`available: 0`) as "not published"
      // and substituted 100 - a limit no server stated, which the Overview card then
      // divided the live connection count by. 0 is how every provider in this repo
      // spells "no limit published", and the card renders it as exactly that.
      //
      // `current` is also the connection count itself, and it stays optional for the
      // reason `getHealth()` above spells out: a deployment whose serverStatus answers
      // without a `connections` section publishes no figure, and `?.current || 0`
      // reported that as zero open connections - while destroying a genuinely idle
      // server's real 0 into the same value. The Overview card prints the figure and
      // its history plots one point per refresh, dropping absent samples and plotting
      // present ones, so a fabricated 0 became a flat line nobody measured.
      const current = measuredNumber(serverStatus.connections?.current);
      const available = measuredNumber(serverStatus.connections?.available);
      const maxConnections = current === undefined || available === undefined ? undefined : current + available;

      // `databaseSizeBytes` is optional and `|| 0` could not tell its two inputs apart:
      // a database that measures 0 bytes and a `db.stats()` that answers without
      // `dataSize` both arrived as a measured 0. MongoDB's dbStats reference documents
      // `dataSize` unconditionally - only the three `freeStorage*` fields are gated, on
      // the command's own `freeStorage: 1` option - so this arm is not a deployment
      // measured here; it is the absence the optional field exists to carry, and the
      // Storage tab keys its whole breakdown off the key being present.
      const dataSizeBytes = measuredNumber(dbStats.dataSize);

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
        version: `MongoDB ${serverInfo.version || "Unknown"}`,
        uptime,
        startTime: new Date(Date.now() - uptimeSeconds * 1000),
        ...(current === undefined ? {} : { activeConnections: current }),
        maxConnections: maxConnections ?? 0,
        databaseSize: dataSizeBytes === undefined ? "N/A" : formatBytes(dataSizeBytes),
        ...(dataSizeBytes === undefined ? {} : { databaseSizeBytes: dataSizeBytes }),
        tableCount: collections.length,
        indexCount,
      };
    } catch (error) {
      this.logError("getOverview", error);
      // A resolved DatabaseOverview, NOT a rethrow: `getMonitoringData()` in
      // `base-provider.ts` reads this panel through `Promise.allSettled`, so a rethrow
      // would drop the whole overview in favour of an `errors.overview` entry instead of
      // the placeholders the tab renders. What it must not do is name a figure it did
      // not read, so BOTH optional fields - `activeConnections` and `databaseSizeBytes`
      // - are omitted entirely rather than resolved as measured 0s. `StorageTab.tsx`
      // keys its whole breakdown off `databaseSizeBytes !== undefined`: with the key
      // present as 0 it drew tables, indexes and an "Other (unattributed)" remainder
      // over a 0 B total, and that remainder is `0 - tables - indexes`, so a table read
      // that answered (it goes through `listCollections` + `collStats`, not
      // `serverStatus`) drove it negative - and `formatBytes` renders a negative as the
      // literal "NaN undefined", because `Math.log` of one is `NaN` and the unit indexes
      // out of its array. Absent, the tab says "No storage size information available."
      //
      // The three figures below stay because their types leave nothing else: `0` MEANS
      // "no limit published" for `maxConnections` (its docblock in `types.ts` says
      // absence and zero are the same fact there), and `tableCount` / `indexCount` are
      // required numbers, so 0 is the only value available on a path that counted
      // nothing. Those two remain the one place this object states more than it read.
      return {
        version: "MongoDB Unknown",
        uptime: "N/A",
        maxConnections: 0,
        databaseSize: "N/A",
        tableCount: 0,
        indexCount: 0,
      };
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    try {
      const serverStatus = await this.db!.admin().serverStatus();

      // Every reading below is optional on purpose: a metric nobody measured must
      // stay absent rather than arrive as a number the panels would then rate.
      const cache = serverStatus.wiredTiger?.cache;
      const cacheHitRatio = wiredTigerCacheHitRatio(cache);
      const bufferPoolUsage = wiredTigerCacheUsage(cache);

      // Queries per second from opcounters. A server that publishes no opcounters
      // has not counted zero operations, it has counted nothing.
      const opcounters = serverStatus.opcounters;
      const uptimeSeconds = measuredNumber(serverStatus.uptime);
      const totalOps =
        opcounters === undefined
          ? undefined
          : (measuredNumber(opcounters.query) ?? 0) +
            (measuredNumber(opcounters.insert) ?? 0) +
            (measuredNumber(opcounters.update) ?? 0) +
            (measuredNumber(opcounters.delete) ?? 0);

      return {
        ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
        ...(totalOps === undefined || !uptimeSeconds ? {} : { queriesPerSecond: round2(totalOps / uptimeSeconds) }),
        ...(bufferPoolUsage === undefined ? {} : { bufferPoolUsage }),
        // MongoDB has no deadlocks to count: WiredTiger aborts and retries a write
        // conflict instead of holding two waiters. The 0 is a statement about the
        // engine, and it is only made when serverStatus answered at all.
        deadlocks: 0,
      };
    } catch (error) {
      this.logError("getPerformanceMetrics", error);
      // serverStatus failed - an unprivileged user, a proxied deployment - so
      // nothing was measured and nothing is reported. This branch used to answer
      // the panel with a 99% cache hit ratio and three zeroes.
      return {};
    }
  }

  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    try {
      // Try to get slow queries from system.profile
      const profilerDocs = await this.db!.collection("system.profile")
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

      return (currentOps.inprog || []).slice(0, limit).map((op: Document) => {
        const microseconds = op.microsecs_running || 0;
        const durationMs = microseconds / 1000;

        return {
          pid: op.opid || "N/A",
          user: op.client || "N/A",
          database: op.ns?.split(".")[0] || this.getDatabaseName(),
          applicationName: op.appName || undefined,
          clientAddr: op.client?.split(":")[0] || undefined,
          state: op.active ? "active" : "idle",
          query: JSON.stringify(op.command || {}).substring(0, 500),
          duration: this.formatDurationString(durationMs),
          durationMs,
          waitEventType: op.waitingForLock ? "Lock" : undefined,
          waitEvent: op.lockStats ? "Acquiring lock" : undefined,
        };
      });
    } catch (error) {
      this.logError("getActiveSessions", error);
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
          // `collStats.totalIndexSize` is a byte count the server measured; it was formatted for
          // display and then dropped, leaving the storage panel with no index total to add up.
          indexSizeBytes: collStats.totalIndexSize || 0,
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
            indexName: idx.name || "unknown",
            indexType: idx.key ? (Object.values(idx.key).includes("text") ? "text" : "btree") : "btree",
            columns: Object.keys(idx.key || {}),
            isUnique: idx.unique || false,
            isPrimary: idx.name === "_id_",
            indexSize: "N/A",
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
        name: "Data",
        location: this.getDatabaseName(),
        size: formatBytes(dbStats.dataSize || 0),
        sizeBytes: dbStats.dataSize || 0,
      });

      // Index size
      stats.push({
        name: "Indexes",
        size: formatBytes(dbStats.indexSize || 0),
        sizeBytes: dbStats.indexSize || 0,
      });

      // Storage size (includes pre-allocated space)
      stats.push({
        name: "Storage",
        size: formatBytes(dbStats.storageSize || 0),
        sizeBytes: dbStats.storageSize || 0,
      });

      // WiredTiger cache if available
      if (serverStatus.wiredTiger?.cache) {
        const bytesInCache = serverStatus.wiredTiger.cache["bytes currently in the cache"] || 0;
        const maxCache = serverStatus.wiredTiger.cache["maximum bytes configured"] || 0;

        stats.push({
          name: "WiredTiger Cache",
          size: formatBytes(bytesInCache),
          sizeBytes: bytesInCache,
          usagePercent: maxCache > 0 ? (bytesInCache / maxCache) * 100 : 0,
        });
      }
    } catch (error) {
      this.logError("getStorageStats", error);
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
