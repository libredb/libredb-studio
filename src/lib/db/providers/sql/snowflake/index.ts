/**
 * Snowflake provider: the SQL API v2 over HTTPS, every statement submitted asynchronously, polled and read on its
 * own, signed in with a key-pair JWT or a programmatic access token.
 *
 * Composition and delegation only. The Account field's reading lives in `account-host.ts` and `account.ts`, the key
 * and the tokens in `auth.ts`, the token lanes and the retry ladder in `transport.ts`, each run's permit, deadline
 * and cancel and the role check in `statements.ts`, the object surface and the connect cautions in `introspect.ts`,
 * the panels in `monitoring.ts` and every failure's category and sentence in `errors.ts`. What stays here is the
 * lifecycle, the `getCapabilities()` literal, the labels and object kinds, and the mapping of a `SnowflakeError` onto
 * the house classes at this boundary (`toDatabaseError`).
 *
 * It extends `SQLBaseProvider` for the inherited `prepareQuery`: Snowflake reads `LIMIT n OFFSET m` natively, so the
 * shared limiter's clauses run as written, and no `prepareQuery` is overridden.
 *
 * The constructor never dials or throws, so a census can build the provider unconnected; every refusal of the
 * connection comes from `connect()`, before any socket. The third argument replaces any of the transport's deps for a
 * test; the factory never passes it, and no connection field or environment variable stands in for the origin, which
 * `account.ts` builds from the Account field alone.
 *
 * Every run, the connect statement and the role check included, is counted by its statements object until it ends
 * at its deadline, so `hasRunsInFlight()` keeps a cached provider through the idle sweep while one runs, and
 * `disconnect()` cancels each one that Snowflake has accepted.
 */
import { QueryError } from "@/lib/db/errors";
import {
  assertContainerPathShape,
  assertObjectPathShape,
  type ContainerPathShapeEngine,
  findKind,
  type ObjectPathShapeEngine,
} from "@/lib/db/object-kinds";
import type {
  ActiveSessionDetails,
  Container,
  DatabaseConnection,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KindCount,
  MaintenanceOperation,
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
  PerformanceMetrics,
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
  QueryWarning,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { SQLBaseProvider } from "../sql-base";
import { snowflakeEndpoint, type SnowflakeEndpoint } from "./account";
import { SNOWFLAKE_FIELD_SENTENCES } from "./account-host";
import { jwtClaim, keyPairTokenSource, type LoadedKey, loadPrivateKey, patTokenSource } from "./auth";
import { SNOWFLAKE, SNOWFLAKE_ERROR_SENTENCES, SnowflakeError, toDatabaseError } from "./errors";
import {
  connectCautions,
  connectStatement,
  countObjects as countSchemaObjects,
  describeObject as describeOneObject,
  describeObjects as describeSchemaObjects,
  getHealth as readHealth,
  listDatabases,
  listObjects as listSchemaObjects,
  listSchemas,
  readObjectSource as readOneObjectSource,
  type SchemaColumnsMemo,
  SNOWFLAKE_INTROSPECT_SENTENCES,
} from "./introspect";
import { createSnowflakeMonitoring, SNOWFLAKE_MONITORING_LABELS, type SnowflakeMonitoring } from "./monitoring";
import {
  createSnowflakeStatements,
  foldIdentifier,
  SNOWFLAKE_QUERY_TAGS,
  type SnowflakeResult,
  type SnowflakeStatementRunner,
  type SnowflakeStatements,
} from "./statements";
import { createSnowflakeTransport, snowflakeProductionDeps, type SnowflakeTransportDeps } from "./transport";

/** Every sentence this file shows, so the provider doc can quote them and a test read them back. */
export const SNOWFLAKE_PROVIDER_SENTENCES = Object.freeze({
  params: "Snowflake's SQL API takes no bound parameters from Studio; write the value in the statement.",
  maintenanceRefused: "Snowflake has no maintenance operations in Studio.",
});

/** How long one schema's column read is shared by the inventory's table and view reads. */
const SCHEMA_COLUMNS_TTL_MS = 10_000;

/** Below the schema level nothing nests: an answer, not a refusal. */
const CONTAINER_DEPTH = 2;

/** A leading statement word that changes what the object tree shows. */
const SCHEMA_REFRESH_PATTERN = "^\\s*(CREATE|DROP|ALTER|UNDROP|TRUNCATE|RENAME)\\b";

const SIGN_IN_METHODS: ReadonlySet<string> = new Set(["keypair", "pat"]);

/** How `assertContainerPathShape` and `assertObjectPathShape` name this engine in a refusal. */
const SNOWFLAKE_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: SNOWFLAKE,
  label: "A Snowflake",
  shapeNames: "label",
};
const SNOWFLAKE_OBJECT_PATH_ENGINE: ObjectPathShapeEngine = {
  code: SNOWFLAKE,
  label: "A Snowflake",
  attachedSegment: "required",
};

/**
 * The ten kinds the tree lists, in `introspect.ts`'s order. Only tables and views carry columns, since describe reads
 * only those two; every kind but a stage has a definition, which `GET_DDL` or the view's own text answers in SQL.
 */
export const SNOWFLAKE_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: "table",
    role: "relation",
    label: "Table",
    labelPlural: "Tables",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "sql",
  },
  {
    id: "view",
    role: "relation",
    label: "View",
    labelPlural: "Views",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "sql",
  },
  { id: "stream", role: "relation", label: "Stream", labelPlural: "Streams", hasSource: true, sourceLanguage: "sql" },
  { id: "task", role: "config", label: "Task", labelPlural: "Tasks", hasSource: true, sourceLanguage: "sql" },
  {
    id: "sequence",
    role: "config",
    label: "Sequence",
    labelPlural: "Sequences",
    hasSource: true,
    sourceLanguage: "sql",
  },
  { id: "stage", role: "config", label: "Stage", labelPlural: "Stages" },
  {
    id: "file-format",
    role: "config",
    label: "File format",
    labelPlural: "File formats",
    hasSource: true,
    sourceLanguage: "sql",
  },
  { id: "pipe", role: "config", label: "Pipe", labelPlural: "Pipes", hasSource: true, sourceLanguage: "sql" },
  {
    id: "function",
    role: "routine",
    label: "Function",
    labelPlural: "Functions",
    hasSource: true,
    sourceLanguage: "sql",
  },
  {
    id: "procedure",
    role: "routine",
    label: "Procedure",
    labelPlural: "Procedures",
    hasSource: true,
    sourceLanguage: "sql",
  },
] as const);

/**
 * The labels, in Snowflake's terms. Snowflake keeps statistics and reclaims storage itself and Studio declares no
 * maintenance operation, so the analyze and vacuum cards are never drawn; they are worded true all the same.
 */
const SNOWFLAKE_LABELS: ProviderLabels = Object.freeze({
  entityName: "Table",
  entityNamePlural: "Tables",
  rowName: "row",
  rowNamePlural: "rows",
  selectAction: "Select Top 50",
  generateAction: "Generate Query",
  analyzeAction: "Analyze Table",
  vacuumAction: "Vacuum Table",
  searchPlaceholder: "Search tables or columns...",
  analyzeGlobalLabel: "Run Analyze",
  analyzeGlobalTitle: "Not Run from Studio",
  analyzeGlobalDesc: "Snowflake keeps table statistics itself; there is no statement to refresh them.",
  vacuumGlobalLabel: "Run Vacuum",
  vacuumGlobalTitle: "Not Run from Studio",
  vacuumGlobalDesc: "Snowflake reclaims storage itself, after Time Travel and Fail-safe; there is no VACUUM.",
  slowQueriesEmptyState: SNOWFLAKE_MONITORING_LABELS.slowQueriesEmptyState,
  sessionsEmptyState: SNOWFLAKE_MONITORING_LABELS.sessionsEmptyState,
});

/** The connection's values `connect()` reads, each refused before any socket. */
interface SnowflakeSettings {
  readonly endpoint: SnowflakeEndpoint;
  readonly user: string;
  readonly role: string;
  readonly method: "keypair" | "pat";
}

const isBlank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";

function refuse(sentence: string): never {
  throw new SnowflakeError("config", sentence);
}

/**
 * The account, the user, the sign-in method and its credential, then the role, in that order. An absent
 * method reads as `keypair`; a seed can write any other string, which is refused.
 */
function readSettings(config: DatabaseConnection): SnowflakeSettings {
  const endpoint = snowflakeEndpoint(config.host);
  if (isBlank(config.user)) refuse(SNOWFLAKE_FIELD_SENTENCES.userEmpty);
  const method: unknown = config.authMethod ?? "keypair";
  if (typeof method !== "string" || !SIGN_IN_METHODS.has(method)) refuse(SNOWFLAKE_FIELD_SENTENCES.method);
  if (method === "keypair" && isBlank(config.privateKey)) refuse(SNOWFLAKE_FIELD_SENTENCES.keyEmpty);
  if (method === "pat" && isBlank(config.password)) refuse(SNOWFLAKE_FIELD_SENTENCES.tokenEmpty);
  if (isBlank(config.role)) refuse(SNOWFLAKE_FIELD_SENTENCES.roleEmpty);
  return {
    endpoint,
    user: config.user as string,
    role: config.role as string,
    method: method as "keypair" | "pat",
  };
}

/** A column read kept for `SCHEMA_COLUMNS_TTL_MS` by the injected clock; an older entry is dropped when met. */
function schemaColumnsMemo(now: () => number): SchemaColumnsMemo {
  const entries = new Map<string, { readonly at: number; readonly result: SnowflakeResult }>();
  const sweep = (at: number): void => {
    for (const [key, entry] of entries) if (at - entry.at >= SCHEMA_COLUMNS_TTL_MS) entries.delete(key);
  };
  return {
    get(key) {
      sweep(now());
      return entries.get(key)?.result;
    },
    set(key, result) {
      const at = now();
      sweep(at);
      entries.set(key, { at, result });
    },
  };
}

/** One completed user statement as the grid's result; a cut is reported on `pagination.wasLimited`. */
function toQueryResult(result: SnowflakeResult, executionTime: number): QueryResult {
  return {
    fields: result.fields,
    rows: result.rows,
    rowCount: result.rows.length,
    executionTime,
    ...(result.fields.length === 0 ? {} : { columnTypes: result.columnTypes }),
    // Absent, never empty, when the run gave no warning.
    ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }),
    ...(result.cut
      ? {
          pagination: {
            limit: MAX_UNLIMITED_ROWS,
            offset: 0,
            hasMore: false,
            totalReturned: result.rows.length,
            wasLimited: true,
          },
        }
      : {}),
  };
}

/** A connected provider's statements, panels and column memo, and what the surface reads are scoped by. */
interface SnowflakeSession {
  readonly statements: SnowflakeStatements;
  readonly monitoring: SnowflakeMonitoring;
  readonly memo: SchemaColumnsMemo;
}

export class SnowflakeProvider extends SQLBaseProvider {
  private session: SnowflakeSession | null = null;
  /** The session `connect()` is still opening, so `disconnect()` can end its statement too. */
  private connecting: SnowflakeSession | null = null;
  /** Sessions whose close is still ending their runs; their runs count as in flight until it returns. */
  private readonly closing = new Set<SnowflakeSession>();
  /** Sessions whose close has begun, so a failed connect() and a disconnect() never close one twice. */
  private readonly closed = new WeakSet<SnowflakeSession>();
  private cautions: QueryWarning[] = [];

  /** Validates nothing and opens nothing: the connection's rules run in `connect()`, before any socket. */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly deps: Partial<SnowflakeTransportDeps> = {},
  ) {
    super(config, options);
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      // EXPLAIN USING JSON compiles without running and needs no running warehouse, so the estimate sends it too.
      supportsExplain: true,
      explainFormat: "snowflake-json",
      // The inherited prepareQuery appends LIMIT 500, which Snowflake reads natively.
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      // Explicit, since the base default is true: an apply would be several warehouse statements and commits.
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      // A page is a full warehouse re-execution, and pages without ORDER BY can repeat or drop rows.
      supportsResultPagination: false,
      // A profile's full-column scans would bill a warehouse on every click and cannot be cancelled.
      supportsColumnProfiling: false,
      // Each statement runs in its own session, so no transaction spans two.
      supportsTransactions: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      // A pasted Snowflake address is decomposed into fields; no connection string is stored.
      supportsConnectionString: false,
      defaultPort: null,
      // Every name double-quoted, so a lower-case catalog name always round-trips.
      identifierQuoting: "double-always",
      schemaRefreshPattern: SCHEMA_REFRESH_PATTERN,
      containerLevels: [
        { id: "catalog", label: "Database", labelPlural: "Databases" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
      containerPathShapes: "exact",
      objectKinds: SNOWFLAKE_OBJECT_KINDS,
      // With a Database and no Schema the session has no schema, so the walk reads that database's schemas; its
      // INFORMATION_SCHEMA is about sixty catalog views that would crowd the walk and say nothing of the user's data.
      agentWalkScope: {
        mode: "session-default",
        whenNoDefault: { walk: "parent-default-children", skip: ["INFORMATION_SCHEMA"] },
      },
      // Every statement that needs a warehouse can resume it and bills at least a minute: read from configuration alone.
      resumesBilledCompute: true,
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...SNOWFLAKE_LABELS };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * The configuration, the key, then the connect statement and the role check, each under the surface timeout. Both
   * need no running warehouse (M100), so a browse-only connection passes them; another role than the configured one
   * fails the connect, and active secondary roles add their caution to the connect warnings. A failure closes what it
   * opened and is worded by `errors.ts`; a second `connect()` replaces the first session and closes it, and a connect
   * still running when a second one starts closes its own session.
   */
  public async connect(): Promise<void> {
    let opened: SnowflakeSession | null = null;
    let cautions: QueryWarning[];
    try {
      const settings = readSettings(this.config);
      const loaded: LoadedKey | null =
        settings.method === "keypair" ? loadPrivateKey(this.config.privateKey, this.config.privateKeyPassphrase) : null;
      const deps: SnowflakeTransportDeps = { ...snowflakeProductionDeps(), ...this.deps };
      const { endpoint, user, role } = settings;
      const claim = jwtClaim(endpoint.accountClaim, user);
      const tokens =
        loaded === null ? patTokenSource(this.config.password as string) : keyPairTokenSource(loaded, claim, deps.now);
      const transport = createSnowflakeTransport(
        { origin: endpoint.origin, tls: { rejectUnauthorized: true, identity: endpoint.host }, tokens },
        deps,
      );
      const { database, schema, warehouse } = this.config;
      const statements = createSnowflakeStatements({
        transport,
        origin: endpoint.origin,
        context: { database, schema, warehouse, role },
        queryTimeoutMs: this.queryTimeout,
        failure: {
          host: endpoint.host,
          user,
          role,
          authMethod: settings.method,
          accountClaim: claim.account,
          userClaim: claim.user,
          fingerprint: loaded?.fingerprint.text ?? null,
          fingerprintHex8: loaded?.fingerprint.hex8 ?? null,
          publicKeyBody: loaded?.fingerprint.publicKeyBody ?? null,
        },
        secrets: () => this.secrets(),
        deps,
      });
      const session: SnowflakeSession = {
        statements,
        monitoring: createSnowflakeMonitoring({
          run: statements.runSurface,
          warehouse,
          database,
          schema,
          role,
          now: deps.now,
        }),
        memo: schemaColumnsMemo(deps.now),
      };
      opened = session;
      this.connecting = session;
      const answer = await statements.runSurface(connectStatement(warehouse), SNOWFLAKE_QUERY_TAGS.connect);
      const roleCautions = await statements.checkRole();
      // A disconnect() while either statement ran took the session and closed it: this connect ended cancelled.
      if (this.connecting !== session) throw new SnowflakeError("cancelled", SNOWFLAKE_ERROR_SENTENCES.cancelled);
      cautions = [...connectCautions(answer, warehouse, role), ...roleCautions];
    } catch (error) {
      // A second connect() displaces this one from `connecting`: its session is closed here whoever holds it, and
      // its failure leaves the state of the connect that replaced it alone.
      const displaced = opened !== null && this.connecting !== opened && (this.connecting ?? this.session) !== null;
      if (opened !== null) {
        if (this.connecting === opened) this.connecting = null;
        await this.close(opened);
      }
      const failure = toDatabaseError(error) as Error;
      if (!displaced) this.setError(failure);
      throw failure;
    }
    this.connecting = null;
    const previous = this.session;
    this.session = opened;
    this.cautions = cautions;
    this.setConnected(true);
    if (previous !== null) await this.close(previous);
  }

  /** Closes one session, counting its runs until every one has ended or the close's bound fired. */
  private async close(session: SnowflakeSession): Promise<void> {
    if (this.closed.has(session)) return;
    this.closed.add(session);
    this.closing.add(session);
    try {
      await session.statements.close();
    } finally {
      this.closing.delete(session);
    }
  }

  /** The secret forms no failure text may echo, read from the connection at each call: the token and the passphrase. */
  private secrets(): readonly string[] {
    const { password, privateKeyPassphrase } = this.config;
    return [password, privateKeyPassphrase].filter(
      (value): value is string => typeof value === "string" && value !== "",
    );
  }

  public connectWarnings(): QueryWarning[] {
    return this.cautions.map((caution) => ({ ...caution }));
  }

  /** Ends every run, the connect's two included: each one Snowflake accepted is cancelled under its own 5 s. */
  public async disconnect(): Promise<void> {
    const sessions = [this.session, this.connecting].filter((session): session is SnowflakeSession => session !== null);
    this.session = null;
    this.connecting = null;
    this.cautions = [];
    this.setConnected(false);
    await Promise.all(sessions.map((session) => this.close(session)));
  }

  /** Whether a run is running or waiting for a permit; synchronous, sends nothing, never throws. */
  public hasRunsInFlight(): boolean {
    const sessions = [this.session, this.connecting, ...this.closing];
    return sessions.some((session) => session !== null && session.statements.runsInFlight() > 0);
  }

  private requireSession(): SnowflakeSession {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session as SnowflakeSession;
  }

  // ==========================================================================
  // Statements
  // ==========================================================================

  /** One editor statement under `queryId`, so `cancelQuery` reaches it; bound parameters are never sent. */
  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) {
      throw new QueryError(SNOWFLAKE_PROVIDER_SENTENCES.params, this.type, sql);
    }
    const { statements } = this.requireSession();
    try {
      const { result, executionTime } = await this.trackQuery(() =>
        this.measureExecution(() => statements.runUser(sql, queryId)),
      );
      return toQueryResult(result, executionTime);
    } catch (error) {
      throw toDatabaseError(error, sql);
    }
  }

  /** Answers true only once the run ended cancelled; an unknown id, or no session, answers false and sends nothing. */
  public async cancelQuery(queryId: string): Promise<boolean> {
    const session = this.session;
    if (session === null) return false;
    return session.statements.cancel(queryId);
  }

  /** One surface call over the session's runner, its failure worded at this boundary with the statement it sent. */
  private async surface<T>(read: (run: SnowflakeStatementRunner, session: SnowflakeSession) => Promise<T>): Promise<T> {
    const session = this.requireSession();
    let last: string | undefined;
    const run: SnowflakeStatementRunner = (sql, tag) => {
      last = sql;
      return session.statements.runSurface(sql, tag);
    };
    try {
      return await read(run, session);
    } catch (error) {
      throw toDatabaseError(error, last);
    }
  }

  // ==========================================================================
  // Object surface, answered by introspect.ts
  // ==========================================================================

  private container(container: readonly string[]): readonly [string, string] {
    assertContainerPathShape(this.getCapabilities(), container, SNOWFLAKE_CONTAINER_PATH_ENGINE);
    return [container[0], container[1]];
  }

  /** An object path `[database, schema, name]` of a declared kind. */
  private objectPath(path: readonly string[], kind: string): readonly [string, string, string] {
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) throw new QueryError(SNOWFLAKE_INTROSPECT_SENTENCES.unknownKind(kind), this.type);
    assertObjectPathShape(capabilities, spec, kind, path, SNOWFLAKE_OBJECT_PATH_ENGINE);
    return [path[0], path[1], path[2]];
  }

  /** Every database the role sees, one database's schemas, or nothing below a schema. */
  public async listContainers(parent: readonly string[] = []): Promise<Container[]> {
    if (parent.length >= CONTAINER_DEPTH) {
      this.ensureConnected();
      return [];
    }
    if (parent.length === 0) return this.surface((run) => listDatabases(run, this.config.database));
    const configured = this.config.database ? foldIdentifier(this.config.database) : null;
    const sessionSchema = parent[0] === configured ? this.config.schema : undefined;
    return this.surface((run) => listSchemas(run, parent[0], sessionSchema));
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    const schema = this.container(container);
    return this.surface((run) => countSchemaObjects(run, schema));
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const schema = this.container(container);
    return this.surface((run) => listSchemaObjects(run, schema, kind));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const object = this.objectPath(path, kind);
    return this.surface((run) => describeOneObject(run, object, kind));
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    const schema = this.container(container);
    return this.surface((run, session) => describeSchemaObjects(run, schema, kind, limit, session.memo));
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    const object = this.objectPath(path, kind);
    return this.surface((run) => readOneObjectSource(run, object, kind, limit));
  }

  // ==========================================================================
  // Monitoring, answered by monitoring.ts
  // ==========================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    return this.surface((_, session) => session.monitoring.getOverview());
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return this.surface((_, session) => session.monitoring.getPerformanceMetrics());
  }

  public async getSlowQueries(options: { limit?: number } = {}): Promise<SlowQueryStats[]> {
    return this.surface((_, session) => session.monitoring.getSlowQueries(options));
  }

  public async getActiveSessions(options: { limit?: number } = {}): Promise<ActiveSessionDetails[]> {
    return this.surface((_, session) => session.monitoring.getActiveSessions(options));
  }

  public async getTableStats(options: { schema?: string } = {}): Promise<TableStats[]> {
    return this.surface((_, session) => session.monitoring.getTableStats(options));
  }

  public async getIndexStats(options: { schema?: string } = {}): Promise<IndexStats[]> {
    return this.surface((_, session) => session.monitoring.getIndexStats(options));
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    return this.surface((_, session) => session.monitoring.getStorageStats());
  }

  public async getHealth(): Promise<HealthInfo> {
    return this.surface((run) => readHealth(run, this.config.warehouse));
  }

  /** No operation runs: a kill would reach other users' statements, and the base defaults are PostgreSQL's. */
  public async runMaintenance(_type: MaintenanceOperation, _target?: string): Promise<MaintenanceResult> {
    throw new QueryError(SNOWFLAKE_PROVIDER_SENTENCES.maintenanceRefused, this.type);
  }
}
