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
  type Container,
  type ContainerLevelSpec,
  type DatabaseObject,
  type KindCount,
  type ObjectDetail,
  type ObjectDetailBatch,
  type ObjectKindSpec,
} from "../../types";
import {
  callerBoundTruncationReason,
  containerDepth,
  declaredKinds,
  findKind,
  isCountUnavailable,
} from "@/lib/db/object-kinds";
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
// Object surface (#789)
//
// MongoDB is the first NON-SQL engine in this epic to get one, so the four methods and
// the model are the shared ones and the catalog is not a query: `listDatabases` and
// `listCollections` are COMMANDS, and everything below was measured against a live
// MongoDB 8.3.9 holding `docker/mongodb-init/01-object-fixture.js`. That fixture is
// committed and the recipe that applies it is in `docs/providers/mongodb.md`, so every
// claim here can be re-measured rather than trusted.
//
// WHERE THE 5f SEAM IS ON A COMMAND CATALOG. The rule is that the LISTING must contain
// exactly what the COUNT counted, and on a SQL engine the two drift apart in a second
// WHERE clause. There is no WHERE clause here, so the seam moves to the CLASSIFIER: the
// count tallies `listCollections` rows by kind and the listing filters the same rows by
// kind, and if those two decisions were written twice they would be free to disagree.
// `mongoObjectKind()` is the one place that decision is made, and it is the only reader
// of both the `type` field and the internal-namespace rule. `countObjects`,
// `listObjects` and `describeObject` all route through it, over rows from the same
// `collectionInfos()` command. There is nothing left for the two answers to differ in.
//
// Five measurements shape this section, and each one produces a wrong tree if forgotten:
//
// 1. `listCollections` ANSWERS A THIRD `type`. Beside "collection" and "view" there is
//    "timeseries", which a time series collection reports. A classifier written
//    `type === "collection"` loses such a collection from the COUNT and the LISTING at
//    once, so ruling 5f would still hold while an object a person created was invisible
//    in the tree - the absence that passes every gate standing ruling 5a exists for. The
//    classifier is therefore "view versus everything else", and the fixture creates a
//    time series collection so the other spelling is refuted rather than unattractive.
// 2. A TIME SERIES COLLECTION IS NOT A KIND OF ITS OWN, and that is a decision. It holds
//    documents, `find` reads them, `listIndexes` answers real indexes and `collStats`
//    answers a size (all measured), so everything the tree does with a collection it
//    does with this one. MongoDB's own `show collections` lists it beside the others.
//    Splitting the folder would divide a person's collections by a storage detail.
// 3. AN INDEX NAME IS UNIQUE PER COLLECTION, NOT PER DATABASE. Measured: creating
//    `by_thing` on `app.customers` and again on `app.orders` both succeed, and creating
//    it twice on ONE collection is refused with "An existing index has the same name as
//    the requested index". So the catalog does not model an index as a first-class
//    container-level object, which is the test standing ruling 4 sets, and no `index`
//    kind is declared: an index appears in `describeObject`'s output, where it is.
// 4. THE RESERVED NAMESPACE PREFIX IS "system." WITH THE DOT. Measured: `createCollection
//    ("system.mine")` is refused with "not authorized on app to execute command", while
//    `systemetrics` is created without complaint. The fixture holds `systemetrics`, so a
//    rule written on the letters "system" without the dot hides a real collection and a
//    test says so by name. `system.views` and `system.buckets.<name>` are the two the
//    server creates by itself, both measured in the fixture's own listing.
// 5. THE THREE RESERVED DATABASES ARE EXCLUDED BY EXACT NAME. `admin`, `config` and
//    `local` are the server's own. Measured: databases named `configstore`, `localx` and
//    `adminx` are all created without complaint, so a prefix rule would hide a database a
//    person made. The fixture creates `configstore` for exactly that reason.
//
// Two absences are declarations rather than gaps. There is NO routine kind of any shape:
// `$function`, `$accumulator`, `$where` and `system.js` are all deprecated as of
// MongoDB 8.0, `mapReduce` since 5.0, `db.eval` was removed in 4.2, and Atlas Triggers
// and Atlas Functions are an Atlas CONTROL PLANE feature that the wire protocol this
// provider speaks cannot reach at all. And there is no kind for an on-demand
// materialized view: `$merge` and `$out` write an ordinary collection carrying no
// server-side marker of its provenance, so there is nothing to list.

/**
 * One level, and there is no second one to add: MongoDB has no container above a
 * database and none between a database and a collection. The structural `id` is `schema`
 * because that is what `ContainerLevelSpec` calls the innermost level on every engine;
 * the LABEL is the engine's own word, which is Database.
 */
const MONGODB_CONTAINER_LEVELS: readonly ContainerLevelSpec[] = Object.freeze([
  { id: "schema", label: "Database", labelPlural: "Databases" },
] as const);

const MONGODB_KIND_COLLECTION = "collection";
const MONGODB_KIND_VIEW = "view";

const MONGODB_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: MONGODB_KIND_COLLECTION,
    role: "relation",
    label: "Collection",
    labelPlural: "Collections",
    // A collection takes a document write, which is the per-KIND half and is
    // deliberately not conjoined with the engine-wide `supportsInlineRowEdit: false`
    // this provider also declares. That flag is about the results grid's
    // `UPDATE ... SET`, which has no MongoDB spelling; an import into a collection is
    // an ordinary `insertMany`. See `kindAcceptsRowWrites()` in object-kinds.ts.
    acceptsRowWrites: true,
  },
  {
    id: MONGODB_KIND_VIEW,
    role: "relation",
    label: "View",
    labelPlural: "Views",
    // No `acceptsRowWrites`. A view is read-only and the server says so on the same
    // call that classifies it: `info.readOnly` is true on every one, measured.
  },
] as const);

/**
 * The `type` a view reports, and the ONLY thing that distinguishes one. There is no
 * separate catalog: `listCollections` returns collections and views together and this
 * field is the whole difference, along with `options.viewOn` and `options.pipeline`,
 * which arrive on the same call and are what Phase 2 will read.
 */
const MONGODB_VIEW_TYPE = "view";

/**
 * The prefix the server reserves for its own namespaces, dot included.
 *
 * Not "system": `systemetrics` is a collection a person can create and does in the
 * fixture, while `system.mine` is refused outright. Both measured on 8.3.9.
 */
const MONGODB_INTERNAL_PREFIX = "system.";

/**
 * The databases the server owns, by exact NAME.
 *
 * `admin`, `config` and `local` are MongoDB's own three. An exact list rather than a
 * prefix, and that is refuted rather than preferred: `configstore`, `localx` and
 * `adminx` are all creatable, measured, and the fixture holds the first.
 */
const MONGODB_RESERVED_DATABASES: readonly string[] = Object.freeze(["admin", "config", "local"]);

/**
 * The `listDatabases` command, as one frozen document so the count and the listing of
 * containers cannot be asked two different questions.
 *
 * `authorizedDatabases: true` is load-bearing rather than tidy. The server's default for
 * it depends on whether the connecting role holds the cluster-wide `listDatabases`
 * action, so a role granted only `read` on one database is at the mercy of a default
 * this provider did not state. Measured both ways on 8.3.9: with the flag, a root role
 * still sees every database and a read-on-one role sees exactly its own.
 */
const MONGODB_LIST_DATABASES_COMMAND: Document = Object.freeze({
  listDatabases: 1,
  nameOnly: true,
  authorizedDatabases: true,
});

/** How many documents one object is sampled for, the same bound `getSchema()` uses. */
const OBJECT_SAMPLE_SIZE = 100;

/**
 * How many collections ONE sample aggregate covers (#789).
 *
 * `describeObjects` samples a whole folder in one `$unionWith` chain, which is one stage
 * per collection, and MongoDB bounds a pipeline's stage count (`internalPipelineLengthLimit`,
 * 1,000 by default). A folder wider than that would be refused outright, so the chain is
 * CHUNKED and the round trips grow as the folder divided by this number rather than with
 * the folder itself.
 *
 * 100 is measured rather than picked. On mongo:latest (8.2.12) over a 200-collection
 * database, sampling 100 documents from each: one 200-arm aggregate took 81 ms, two 100-arm
 * ones took 67 ms and four 50-arm ones took 55 ms, against 171 ms for the 400 sequential
 * reads a loop over `describeObject` costs. 100 keeps a tenfold margin under the server's own ceiling
 * and sits at the point where a smaller chunk stops buying much.
 */
const SAMPLE_CHUNK_SIZE = 100;

/**
 * The field one sample row carries its collection's name in.
 *
 * A `$unionWith` chain answers one flat stream, so every arm has to tag its own rows or
 * nothing downstream can tell which collection a document came from. `$` is one of the two
 * characters a MongoDB collection name may not contain (the other is the null byte), so this
 * key cannot collide with a real field name either.
 */
const SAMPLE_KEYSPACE_FIELD = "__ks";

/** The field one sample row carries the document itself in. */
const SAMPLE_DOCUMENT_FIELD = "d";

/** A string the server sent, or "" when it sent nothing usable. */
function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()`
 * reports.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by
 * two different rules. `containerDepth()` decides, never `containerLevels.length`:
 * absent and empty are the same fact.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The segment of `path` belonging to the declared container level `id`.
 *
 * NEVER `path[0]`, which is standing ruling 5g's general form: a container level's
 * POSITION is a property of the declaration and not a constant. MongoDB declares one
 * level, so the database IS the first segment here and every literal-index spelling
 * would be behaviour-identical on this engine - which is exactly why three of them
 * shipped across earlier providers and each was found a review later than the last. The
 * suite pins this with a two-level declaration swapped in through `getCapabilities` and
 * driven to the database name the driver was BOUND with.
 *
 * Both failure modes raise through one guard: a declaration carrying no level of this
 * `id`, and a path too short to hold it. Neither may fall through to `undefined`, which
 * would reach `MongoClient.db()` as the string "undefined" and quietly open a database
 * of that name - the driver accepts any string, so nothing downstream would complain.
 */
function containerSegment(
  capabilities: ProviderCapabilities,
  path: readonly string[],
  id: ContainerLevelSpec["id"],
): string {
  const levels = declaredLevels(capabilities);
  const index = levels.findIndex((level) => level.id === id);
  const segment = index < 0 ? undefined : path.slice(0, levels.length)[index];
  if (segment === undefined) {
    throw new QueryError(
      `A MongoDB path needs a "${id}" container level and a segment for it; the declaration is ` +
        `[${levels.map((level) => level.id).join(", ")}] and the path is ${JSON.stringify(path)}`,
      "mongodb",
    );
  }
  return segment;
}

/**
 * The one database a container path names.
 *
 * The expected depth is read through `containerDepth()` and the segment NAMES come from
 * the declared level labels, so the check and its message are the same array and nothing
 * here can inherit a hardcoded 1. A path of another length is a caller that built it
 * from another engine's model, and it raises rather than reading a segment and carrying
 * on: an empty folder looks exactly like a database holding nothing, which is the worst
 * way to report a caller mistake.
 */
function containerDatabase(capabilities: ProviderCapabilities, container: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  if (container.length !== levels.length) {
    throw new QueryError(
      `A MongoDB container path is [${levels.map((level) => level.label.toLowerCase()).join(", ")}], ` +
        `received ${JSON.stringify(container)}`,
      "mongodb",
    );
  }
  return containerSegment(capabilities, container, "schema");
}

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "this server has this kind and this database holds none" render
 * as a 0 badge. Building the record from the catalog rows alone would leave the kind out
 * entirely, and an absent kind already means something else and stronger: the server has
 * no such concept, so the tree draws no folder at all.
 */
function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * The server's own sentence, verbatim, for a catalog read that was refused.
 *
 * Deliberately NOT through this provider's error mapping: that gives a THROWN error a
 * type and this product's prefix, and nothing here throws. The sentence is rendered to a
 * person as the reason a folder has no number, so prefixing it would put our words in
 * front of MongoDB's. A refused read is never 0 - measured, a role holding `read` on one
 * database answers `listCollections` on any other with "not authorized on <db> to
 * execute command { listCollections: 1 ... }", and reporting that as an empty database
 * would say nothing is there when nobody has looked.
 */
function refusalReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Two paths compared SEGMENT BY SEGMENT, so a sort is over the address and never over
 * one joined string.
 *
 * `JSON.stringify(path)` is the obvious spelling and it is wrong twice. At MIXED DEPTH
 * the deeper path sorts first, because the separator `,` (0x2C) is below the terminator
 * `]` (0x5D). And JSON ESCAPES, so a name holding a quote or a backslash sorts by its
 * escape sequence rather than by its own code points - and a MongoDB collection name may
 * hold both, since the only characters it forbids are the null byte and `$`.
 *
 * This is the seventh copy of this function in the repo. Standing ruling 5h: Task 28
 * hoists it beside `containerDepth` in `src/lib/db/object-kinds.ts` once, rather than
 * each provider task hoisting it and colliding with the others.
 */
function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

/**
 * WHICH KIND one `listCollections` row is, or `undefined` for a namespace the server
 * owns.
 *
 * THIS IS THE WHOLE 5f SEAM, in one function, because the catalog here is a command and
 * not a query. `countObjects` tallies its answers and `listObjects` filters on them, so
 * the count and the listing cannot be looking at different sets: there is no second
 * predicate for them to drift apart in, the way Oracle, MySQL, ClickHouse and Trino each
 * drifted in a WHERE clause on a first pass.
 *
 * "View versus everything else" and not "collection versus view". `type` has a third
 * measured value, "timeseries", and a `=== "collection"` test would drop such an object
 * from both answers at once - which keeps ruling 5f true while hiding an object a person
 * created. The fixture holds one so that spelling stays refuted.
 */
function mongoObjectKind(info: Document): string | undefined {
  const name = readText(info.name);
  if (name.startsWith(MONGODB_INTERNAL_PREFIX)) return undefined;
  return readText(info.type) === MONGODB_VIEW_TYPE ? MONGODB_KIND_VIEW : MONGODB_KIND_COLLECTION;
}

/**
 * The objects of one kind in one container, from one catalog answer, sorted.
 *
 * ONE function because `listObjects` and `describeObjects` must name exactly the same set
 * in exactly the same order: every caller joins the two answers on PATH, and a bounded bulk
 * read's membership is decided by this sort, so two spellings of it would let the batch
 * describe an object the listing does not name.
 *
 * Ordering is done here rather than relying on the server: `listCollections` returns rows
 * in no documented order (measured, two fresh containers holding one fixture answered `app`
 * in two different orders), and the tree addresses by path.
 */
function objectsFrom(container: readonly string[], kind: string, infos: readonly Document[]): DatabaseObject[] {
  const objects: DatabaseObject[] = [];
  for (const info of infos) {
    if (mongoObjectKind(info) !== kind) continue;
    const name = readText(info.name);
    objects.push({ path: [...container, name], name, kind });
  }
  return objects.sort((left, right) => comparePaths(left.path, right.path));
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
      // collection name, so it is offered on a collection row only (#496).
      maintenanceOperationSpecs: {
        vacuum: { label: "Compact Collection", perEntity: true, global: true },
        analyze: { label: "Validate Collection", perEntity: true, global: true },
        check: { label: "Check Collection", perEntity: true, global: false },
      },
      supportsConnectionString: true,
      defaultPort: 27017,
      containerLevels: MONGODB_CONTAINER_LEVELS,
      objectKinds: MONGODB_OBJECT_KINDS,
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
      // used to name a PostgreSQL extension (#463).
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
      // `serverStatus`) drove it negative - and the tab formats bytes with its own local
      // threshold cascade, whose last arm returns its input unchanged, so the remainder
      // read "-1536 B": a negative byte count drawn as a measurement (measured against
      // the cascade). Absent, the tab says "No storage size information available."
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

  // ============================================================================
  // Object surface (#789)
  // ============================================================================

  /**
   * One database's catalog: every collection and view in it, internal namespaces already
   * dropped.
   *
   * The ONE read all three of `countObjects`, `listObjects` and `describeObject` go
   * through, against the database the CONTAINER names rather than the one the session
   * opened. `this.db` is bound to the connection's own database and is deliberately not
   * used here: `MongoClient.db(name)` is what ends the single-database confinement
   * section 3 of the provider doc records.
   */
  private async collectionInfos(database: string): Promise<Document[]> {
    return await this.client!.db(database).listCollections().toArray();
  }

  /**
   * The databases this connection can see, minus the server's own three.
   *
   * One level, so `parent` can only ever name a database, and nothing nests under one
   * here - that answers `[]` rather than raising, because "this level has no children"
   * is a true statement about MongoDB and not a caller mistake. It also answers without
   * a round trip, which is the difference between a tree that opens a database and one
   * that asks the server what is under it first.
   *
   * `isSessionDefault` compares against the database this connection was opened with,
   * which `getDatabaseName()` already resolves from the config or from a pasted
   * connection string. That is the same value `connect()` handed `MongoClient.db()`, so
   * the flag names the database every other read of this provider is bound to.
   *
   * This is the one place a path is CONSTRUCTED rather than read, which is the single
   * exception standing ruling 5g allows to the no-positional-index rule.
   */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.ensureConnected();
    if (parent !== undefined && parent.length > 0) return [];

    const result = await this.db!.admin().command(MONGODB_LIST_DATABASES_COMMAND);
    const sessionDatabase = this.getDatabaseName();
    const entries: Document[] = Array.isArray(result.databases) ? result.databases : [];

    const containers: Container[] = [];
    for (const entry of entries) {
      const name = readText(entry.name);
      if (MONGODB_RESERVED_DATABASES.includes(name)) continue;
      containers.push({ path: [name], name, level: 0, isSessionDefault: name === sessionDatabase });
    }
    return containers.sort((left, right) => comparePaths(left.path, right.path));
  }

  /**
   * How many objects of each declared kind one database holds, in ONE command.
   *
   * `listCollections` answers for both kinds at once, and the tally is over
   * `mongoObjectKind()` - the same function `listObjects` filters on. That is where
   * standing ruling 5f is held on a command catalog: there is no second predicate for a
   * count and a listing to disagree in.
   *
   * Three outcomes, and the type keeps all three apart. A kind the catalog answered for
   * carries its number. A kind it did not carries `{ count: 0 }`, because every declared
   * kind is seeded before the rows are read. A refused read carries the server's own
   * sentence, for every kind, which is right here and not a shortcut: the two kinds come
   * from ONE command, so a refusal is one fact about the whole database rather than a
   * per-kind privilege the way it is on Cassandra's seven catalog tables.
   *
   * The container path is checked BEFORE the read and raises, because a path of the
   * wrong shape is a caller mistake and not something the engine refused.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const database = containerDatabase(capabilities, container);
    const declared = declaredKinds(capabilities);
    const counts = seedZeroCounts(declared);

    let infos: Document[];
    try {
      infos = await this.collectionInfos(database);
    } catch (error) {
      const reason = refusalReason(error);
      return Object.fromEntries(declared.map((kind) => [kind.id, { unavailable: reason } as KindCount]));
    }

    for (const info of infos) {
      const kind = mongoObjectKind(info);
      // `Object.hasOwn` and not a bare index or an `in`: `in` walks the prototype chain,
      // so a classifier answering "toString" would find a function where a count belongs.
      // The record is seeded from the DECLARATION, so this guard is exactly "is this kind
      // declared" - and answering for an undeclared kind is what conformance invariant 2
      // fails a provider for.
      if (kind === undefined || !Object.hasOwn(counts, kind)) continue;
      const current = counts[kind];
      counts[kind] = { count: (isCountUnavailable(current) ? 0 : current.count) + 1 };
    }
    return counts;
  }

  /**
   * The objects of one kind in one database, names only.
   *
   * Two questions, asked in order, and only the DECLARATION answers the first. Deciding
   * "is this kind declared" from whether the classifier can produce it would make the two
   * methods disagree, and would report "declares no object kind" about a kind
   * `MONGODB_OBJECT_KINDS` does declare.
   *
   * No `rowCount` and no `sizeBytes` on any object, and that is a bound rather than a
   * gap: both would need `collStats` or `estimatedDocumentCount` PER COLLECTION, one
   * round trip each, and the folder this fills is the one a person opens to see what is
   * there. `describeObject` is where a single object's detail is paid for. It is also
   * the reason there is one command behind this method and behind the count.
   *
   * Ordering is done here rather than relying on the server: `listCollections` returns
   * rows in no documented order (the fixture's own listing comes back unsorted,
   * measured), and the tree addresses by PATH, so a code-point sort over the segments is
   * one rule shared with every other provider in #789.
   */
  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`MongoDB declares no object kind "${kind}"`, "mongodb");
    }
    const database = containerDatabase(capabilities, container);
    return objectsFrom(container, kind, await this.collectionInfos(database));
  }

  /**
   * One object's fields and indexes.
   *
   * The KIND decides, and nothing here reads the name to work out what it is holding: the
   * lookup requires the catalog row to classify as the kind that was asked for, so asking
   * for a view by the name of a collection is a miss rather than a collection described
   * as a view.
   *
   * Fields are INFERRED from a document sample, the same way `getSchema()` infers them
   * and with the same bound, because MongoDB stores no schema to read: a collection has
   * whatever fields its documents happen to carry. That works on a view exactly as it
   * works on a collection, which is why a view is worth listing at all.
   *
   * A VIEW is given no indexes, and that is measured rather than defensive: `listIndexes`
   * on one is refused with `CommandNotSupportedOnView` (code 166), and the indexes its
   * pipeline actually uses belong to the collection underneath it, so claiming them here
   * would misattribute them. `foreignKeys` is ALWAYS empty, because MongoDB has no
   * foreign key constraint at all - the same measurement behind `declaresForeignKeys:
   * false`.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`MongoDB declares no object kind "${kind}"`, "mongodb");
    }

    // Derived, not counted. One segment per declared container level plus the name. No
    // kind here declares `attachedTo`, so there is one shape, and it comes from the
    // declaration rather than from a literal written out here.
    const levels = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
    const shape = [...levels, "name"];
    if (path.length !== shape.length) {
      throw new QueryError(
        `A MongoDB "${kind}" path is [${shape.join(", ")}], received ${JSON.stringify(path)}`,
        "mongodb",
      );
    }

    // Neither read is positional. The database comes from the segment the DECLARATION
    // assigns to the `schema` level, and the object's own name is the LAST segment.
    const database = containerSegment(capabilities, path, "schema");
    const name = path[path.length - 1];

    const infos = await this.collectionInfos(database);
    const info = infos.find((candidate) => readText(candidate.name) === name && mongoObjectKind(candidate) === kind);
    if (info === undefined) {
      throw new QueryError(`No MongoDB ${kind} named ${name} in ${database}`, "mongodb");
    }

    const collection = this.client!.db(database).collection(name);
    const sample = await collection.find({}).limit(OBJECT_SAMPLE_SIZE).toArray();
    const indexes = kind === MONGODB_KIND_VIEW ? [] : await collection.indexes();

    return this.objectDetailFrom(path, sample, indexes);
  }

  /**
   * One sampled object turned into one `ObjectDetail`, shared by the single and the bulk
   * read.
   *
   * One function because a caller joins the two answers together: two copies would be two
   * chances for the bulk read to spell an index differently from the single read of the
   * same collection. `foreignKeys` is ALWAYS empty, which is the measurement behind
   * `declaresForeignKeys: false` - MongoDB has no foreign key constraint at all.
   */
  private objectDetailFrom(
    path: readonly string[],
    sample: readonly Document[],
    indexes: readonly Document[],
  ): ObjectDetail {
    return {
      path: [...path],
      columns: this.inferSchemaFromDocuments(sample as Document[]),
      indexes: indexes.map((index) => ({
        name: readText(index.name) || "unknown",
        columns: Object.keys(index.key || {}),
        unique: index.unique || false,
      })),
      foreignKeys: [],
    };
  }

  /**
   * Documents sampled from EVERY named collection, in one aggregate per chunk (#789).
   *
   * This is the bulk read's whole gain, and it exists because MongoDB stores no schema:
   * a collection has whatever fields its documents happen to carry, so a column list is a
   * SAMPLE and the only way to avoid one read per object is to ask for every sample in one
   * pipeline. `$unionWith` does exactly that - one arm per collection, each bounded by the
   * same `OBJECT_SAMPLE_SIZE` the single read uses, each tagging its rows with the
   * collection they came from because the chain answers one flat stream.
   *
   * It works on a VIEW and on a TIME SERIES collection as readily as on an ordinary one,
   * measured against the committed fixture: a `$unionWith` arm on
   * `active_customers` answers the view's own rows and one on `readings` answers the time
   * series documents.
   *
   * CHUNKED, so a wide folder cannot outgrow MongoDB's own pipeline-length ceiling, and the
   * chunks are issued in PARALLEL because they are independent reads of one stateless
   * server.
   */
  private async sampleByCollection(database: string, names: readonly string[]): Promise<Map<string, Document[]>> {
    const db = this.client!.db(database);
    const chunks: string[][] = [];
    for (let start = 0; start < names.length; start += SAMPLE_CHUNK_SIZE) {
      chunks.push(names.slice(start, start + SAMPLE_CHUNK_SIZE));
    }

    // One arm: take this collection's first `OBJECT_SAMPLE_SIZE` documents and tag them.
    const arm = (name: string): Document[] => [
      { $limit: OBJECT_SAMPLE_SIZE },
      { $project: { [SAMPLE_KEYSPACE_FIELD]: { $literal: name }, [SAMPLE_DOCUMENT_FIELD]: "$$ROOT" } },
    ];

    const pages = await Promise.all(
      chunks.map(async (chunk) => {
        const [first, ...rest] = chunk;
        // The first arm is the aggregate's own target and the rest are unioned onto it,
        // which is the only shape `$unionWith` has: there is no collectionless form.
        return await db
          .collection(first)
          .aggregate([...arm(first), ...rest.map((name) => ({ $unionWith: { coll: name, pipeline: arm(name) } }))])
          .toArray();
      }),
    );

    const byName = new Map<string, Document[]>(names.map((name) => [name, []]));
    for (const row of pages.flat()) {
      const bucket = byName.get(readText(row[SAMPLE_KEYSPACE_FIELD]));
      // A row whose tag is not one this call asked for cannot be placed, and there is no
      // honest place to put it. It cannot happen through this construction; dropping it is
      // the answer that keeps one collection's fields out of another's column list.
      if (bucket === undefined) continue;
      bucket.push(row[SAMPLE_DOCUMENT_FIELD] as Document);
    }
    return byName;
  }

  /**
   * Columns and indexes for EVERY object of one kind in one database (#789).
   *
   * WHAT THIS ENGINE CAN AND CANNOT BULK-READ, measured rather than assumed, because the
   * answer is not the same for the two halves of an `ObjectDetail`.
   *
   * The COLUMNS can. There is no catalog of fields to read - a collection has whatever its
   * documents carry - so the single read samples documents, and `$unionWith` samples every
   * collection in one pipeline. A 200-collection database: two aggregates and 67 ms, against
   * the 200 `find()` calls a loop costs.
   *
   * The INDEXES cannot, and three separate measurements say so:
   *
   *   1. `$listCatalog` is the only server-side bulk index listing, and its collectionless
   *      form must run against `admin` with `{aggregate: 1}`. A role holding `read` on one
   *      database - which `listCollections`, `listIndexes` and every other read in this
   *      surface accept - is refused it: "not authorized on admin to execute command
   *      { aggregate: 1, pipeline: [ { $listCatalog: {} } ... ] }". Using it would make this
   *      one method need a cluster privilege the other four do not.
   *   2. `$listCatalog` also answers the WRONG indexes for a time series collection. It
   *      reports `app.readings`, the namespace a person addresses, with NO indexes at all,
   *      and `app.system.buckets.readings` carrying `sensor_1_ts_1` under the bucket
   *      collection's rewritten keys (`meta`, `control.min.ts`, `control.max.ts`).
   *      `listIndexes` on the collection answers the index a person created, `sensor_1_ts_1`
   *      over `sensor` and `ts`, and the single read answers that one.
   *   3. `$indexStats` needs a privilege this surface does not have. A `$unionWith`
   *      sub-pipeline does accept it - measured, so "only valid as the first stage" is not
   *      what the server answers - but a role holding `read` on one database is refused it
   *      both directly and inside the chain, while the same role runs `listIndexes` on the
   *      same collection without complaint.
   *
   * So the index reads are one per described object, issued in PARALLEL and bounded by the
   * caller's `limit`, and this method is the ONE place in the seventeen providers where a
   * per-object read survives. It is still not the N+1 the inventory route removed: that was
   * up to 5,000 SEQUENTIAL round trips over the whole listing, while this is one parallel
   * batch over the objects the caller asked for. Measured over 200 collections: 171 ms for
   * the sequential fan-out a loop over `describeObject` costs, 67 ms for the same fan-out
   * in parallel, 63 ms for this shape. A VIEW folder pays none of it - a view has no
   * indexes of its own, `listIndexes` on one is refused with code 166, and nothing is sent.
   *
   * NO KIND HERE ANSWERS AN EMPTY BATCH FOR WANT OF COLUMNS. The reference's fourth guard
   * covers a routine, a trigger or a sequence, and MongoDB declares none: both kinds are
   * relations whose fields are inferred from documents. An empty FOLDER still sends nothing,
   * and there is deliberately no guard written for it: with no names there are no chunks and
   * no index reads, so an early return would be a branch no data can reach - a mutation
   * deleting it failed nothing, which is what dead means (standing ruling 5b).
   *
   * THE BOUND IS THE CALLER'S AND THERE IS NO `limit + 1`. That extra row exists to tell a
   * saturated read from an exact one without a second count, and it is unnecessary here:
   * `listCollections` answers the whole catalog in one command, so the target set is
   * COMPLETE before anything is cut and the comparison is exact. The driver's cursor cannot
   * be bounded anyway - `listCollections` takes no limit - so the cut is applied in code,
   * after `objectsFrom`'s sort, and a bounded read's membership on this engine is
   * `comparePaths`' rather than the server's. `getSchema()`'s silent `.slice(0, 200)` is not
   * carried here.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    // The four guards, in the reference's order: the DECLARATION first, because an
    // undeclared kind is a fact about the engine and an empty answer is a claim about the
    // data; then the container, through the same reader `listObjects` uses.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`MongoDB declares no object kind "${kind}"`, "mongodb");
    }
    const database = containerDatabase(capabilities, container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      // Not clamped and not ignored. A 0 would answer nothing while reporting a truncation
      // the caller never asked for, and a fraction cannot cut a list; both are caller
      // mistakes and neither has a right answer to guess at.
      throw new QueryError(
        `A MongoDB bulk column read limit must be a positive whole number, received ${limit}`,
        "mongodb",
      );
    }

    const listed = objectsFrom(container, kind, await this.collectionInfos(database));
    const bounded = limit !== undefined && listed.length > limit;
    const chosen = bounded ? listed.slice(0, limit) : listed;
    const names = chosen.map((object) => object.name);
    const db = this.client!.db(database);
    // A VIEW has no indexes of its own and asking is refused with code 166, so the whole
    // index half is skipped for that kind rather than guarded per object.
    const [samples, indexes] = await Promise.all([
      this.sampleByCollection(database, names),
      kind === MONGODB_KIND_VIEW
        ? Promise.resolve(names.map(() => [] as Document[]))
        : Promise.all(names.map((name) => db.collection(name).indexes())),
    ]);

    const details = chosen.map((object, index) =>
      this.objectDetailFrom(object.path, samples.get(object.name) ?? [], indexes[index]),
    );
    // The bound reported here is the CALLER's and there is no other on this engine:
    // `listCollections` answers the whole catalog in one command, so the target set is
    // complete before anything is cut, and no cap of this provider's own reaches the
    // answer. `getSchema()`'s silent `.slice(0, 200)` is NOT carried here, which is the
    // reference's first "do not copy": an unreported bound is the defect `truncated`
    // exists to prevent. The sentence itself is shared (#789), so one event reads one way
    // on every engine.
    return bounded ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
  }

  private formatDurationString(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }
}
