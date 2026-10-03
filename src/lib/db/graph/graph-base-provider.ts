/**
 * The provider half every graph engine shares (Neo4j provider spec 4.1 to 4.3, 5.1, 5.4, 5.5;
 * revisions SR4, SR10, SR15, SR16, SR17).
 *
 * Server only. An engine supplies a `GraphEngineProfile` (its policy lists, port, catalog reads,
 * statement gate and error table) and this class does the rest, so an engine provider holds
 * declarations and monitoring reads and nothing of the query path.
 *
 * Every statement takes one road: the read policy over its tokens, then the engine's statement
 * gate unless it is an allowed `SHOW` form, then one `GraphClient.run` in a READ session on the
 * connection's database, bounded by `DEFAULT_QUERY_LIMIT` rows and the connection's query timeout.
 * A refusal at either check is a `QueryError` and nothing reaches the server as a run. Cancelling,
 * like the row-bound cut, goes through the run's `AbortSignal`, which the Bolt client turns into a
 * session close (SR15).
 *
 * A connection is one database (SR4): the connection's `database`, or the user's home database
 * resolved at connect through the catalog. Another database is another connection, so every
 * object path is checked against that one container.
 *
 * The constructor validates nothing and opens nothing: the endpoint is built and refused in
 * `connect()`, so a provider made only for its declarations touches no socket.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseError, QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  Container,
  DatabaseConnection,
  DatabaseObject,
  HealthInfo,
  KindCount,
  MaintenanceOperation,
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  PreparedQuery,
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
} from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { createBoltClient } from "./bolt/bolt-client";
import {
  type GraphClient,
  GraphClientError,
  type GraphClientFactory,
  type GraphRunOptions,
  type GraphRunResult,
  type GraphServerInfo,
} from "./bolt/client";
import { boltEndpointOf } from "./bolt/uri";
import { type CypherReadVerdict, type CypherRefusal, checkCypherRead } from "./cypher/read-policy";
import {
  columnsOf,
  GRAPH_OBJECT_KINDS,
  type GraphCatalogEntry,
  type GraphIndexRow,
  type GraphKindId,
  type GraphPropertyRow,
  indexesOf,
  parseGraphObjectSegment,
  toDatabaseObjects,
} from "./objects";
import type { GraphPolicyProfile } from "./profile";
import { graphColumnType } from "./values";

/** An engine's catalog reads: each runs its own fixed statements through the client it is handed. */
export interface GraphCatalog {
  /** The user's home database, used when the connection names no database (SR4). */
  homeDatabase(client: Pick<GraphClient, "run">): Promise<string>;
  /** The names of one kind; `truncated` when the catalog's own row bound cut the answer (SR16). */
  listKind(
    client: Pick<GraphClient, "run">,
    database: string,
    kind: GraphKindId,
  ): Promise<{ entries: readonly GraphCatalogEntry[]; truncated: boolean }>;
  propertyRows(
    client: Pick<GraphClient, "run">,
    database: string,
    kind: "label" | "relationship_type",
  ): Promise<{ rows: readonly GraphPropertyRow[]; truncated: boolean }>;
  indexRows(
    client: Pick<GraphClient, "run">,
    database: string,
  ): Promise<{ rows: readonly GraphIndexRow[]; truncated: boolean }>;
}

/**
 * The server's own classification of a statement the policy allowed (SR10): undefined lets it run,
 * a refusal stops it. It is handed the options of the run that follows, so a cancel reaches it too.
 */
export type GraphStatementGate = (
  client: Pick<GraphClient, "run">,
  verdict: Extract<CypherReadVerdict, { allowed: true }>,
  options: GraphRunOptions,
) => Promise<CypherRefusal | undefined>;

/** The server half of an engine profile: what only the provider needs. */
export interface GraphEngineProfile extends GraphPolicyProfile {
  readonly defaultPort: number;
  readonly statementGate?: GraphStatementGate;
  readonly catalog: GraphCatalog;
  /** A transport failure to the repository's error classes. */
  readonly mapError: (error: GraphClientError) => Error;
}

/** How long a property or index read is kept before it is read again (SR17). */
const CATALOG_CACHE_MS = 60_000;

/** The product's name in the server's transaction metadata and in the Bolt user agent. */
const PRODUCT = "libredb-studio";
const RUN_METADATA: Readonly<Record<string, string>> = Object.freeze({ app: PRODUCT });

/** A listing the catalog's row bound cut, phrased to follow "counted from" (`KindCount.sampledFrom`). */
const CATALOG_CUT_SAMPLE = "one catalog read that stopped at its row bound";
/** The same cut as a bulk describe's own bound, joined after the caller's one when both bit. */
const CATALOG_CUT_REASON = "the catalog's listing stopped at its row bound";

const RELATION_ENTITY = { label: "NODE", relationship_type: "RELATIONSHIP" } as const;

const GRAPH_KIND_IDS: ReadonlySet<string> = new Set(GRAPH_OBJECT_KINDS.map((kind) => kind.id));

interface GraphSession {
  readonly client: GraphClient;
  /** The one container: the connection's database or the resolved home database. */
  readonly database: string;
}

/** One kept catalog read: concurrent callers share the promise; a rejected one is evicted. */
interface CachedRead<T> {
  readonly value: Promise<T>;
  readonly readAt: number;
}

type PropertyRead = Awaited<ReturnType<GraphCatalog["propertyRows"]>>;
type IndexRead = Awaited<ReturnType<GraphCatalog["indexRows"]>>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The shared result shape: `pagination` only when the row bound cut the result, `warnings` only when
 * the transport replaced a value, `columnTypes` only for columns that hold graph values (SR19).
 */
function toQueryResult(result: GraphRunResult, executionTime: number): QueryResult {
  const fields = [...result.fields];
  const rows = [...result.rows];
  // Built as entries, so a column named `__proto__` is a key and never the object's prototype.
  const typed = fields.flatMap((field) => {
    const type = graphColumnType(rows.map((row) => row[field]));
    return type === undefined ? [] : [[field, type] as const];
  });
  return {
    fields,
    rows,
    rowCount: rows.length,
    executionTime,
    ...(result.truncated
      ? {
          pagination: {
            limit: DEFAULT_QUERY_LIMIT,
            offset: 0,
            hasMore: true,
            totalReturned: rows.length,
            wasLimited: true,
          },
        }
      : {}),
    ...(result.warnings !== undefined && result.warnings.length > 0
      ? { warnings: result.warnings.map((message) => ({ message })) }
      : {}),
    ...(typed.length > 0 ? { columnTypes: Object.fromEntries(typed) } : {}),
  };
}

export abstract class GraphBaseProvider extends BaseDatabaseProvider {
  protected readonly profile: GraphEngineProfile;
  private readonly createClient: GraphClientFactory;
  private session: GraphSession | null = null;
  /** Statements in flight under the caller's id, so `cancelQuery` reaches them (spec 5.5). */
  private readonly running = new Map<string, AbortController>();
  private readonly propertyCache = new Map<string, CachedRead<PropertyRead>>();
  private readonly indexCache = new Map<string, CachedRead<IndexRead>>();

  protected constructor(
    config: DatabaseConnection,
    options: ProviderOptions,
    profile: GraphEngineProfile,
    createClient: GraphClientFactory = createBoltClient,
  ) {
    super(config, options);
    this.profile = profile;
    this.createClient = createClient;
  }

  // Every flag is the engine's decision: the base class's defaults are SQL's.
  public abstract override getCapabilities(): ProviderCapabilities;
  public abstract override getLabels(): ProviderLabels;

  /** The connected client; throws when not connected. */
  protected client(): GraphClient {
    return this.requireSession().client;
  }

  /** The one container's database, or undefined when not connected. */
  protected currentDatabase(): string | undefined {
    return this.session?.database;
  }

  /** The clock the catalog cache reads; a test subclass replaces it. */
  protected now(): number {
    return Date.now();
  }

  /** The health figures after a successful verify; an engine overrides it with what it can read. */
  protected async healthOf(server: GraphServerInfo): Promise<HealthInfo> {
    void server;
    return { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
  }

  private requireSession(): GraphSession {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session as GraphSession;
  }

  /** A transport failure through the engine's error table; anything else is itself. */
  private providerError(error: unknown): unknown {
    return error instanceof GraphClientError ? this.profile.mapError(error) : error;
  }

  private async mapped<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw this.providerError(error);
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  public async connect(): Promise<void> {
    let client: GraphClient | undefined;
    try {
      const endpoint = boltEndpointOf(this.config, this.profile.defaultPort);
      client = this.createClient({
        uri: endpoint.uri,
        ...(endpoint.trustedCertificatePem === undefined
          ? {}
          : { trustedCertificatePem: endpoint.trustedCertificatePem }),
        user: this.config.user,
        password: this.config.password,
        // The connect deadline is the query timeout, as etcd's connect steps take it.
        connectionTimeoutMs: this.queryTimeout,
        userAgent: PRODUCT,
      });
      await client.verify();
      const configured = this.config.database;
      const database =
        configured !== undefined && configured !== "" ? configured : await this.profile.catalog.homeDatabase(client);
      this.session = { client, database };
    } catch (error) {
      // A client that was built holds a driver, so a connect that fails after it closes it. A close
      // that fails too is logged, never thrown over the failure that explains the connect.
      await client?.close().catch((closeError: unknown) => this.logError("connect cleanup", closeError));
      const mapped = this.providerError(error);
      this.setError(mapped as Error);
      throw mapped;
    }
    this.clearCatalogCache();
    this.setConnected(true);
  }

  /** Aborts every statement in flight, then closes the client. */
  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    for (const controller of this.running.values()) controller.abort(cancelled());
    this.running.clear();
    this.clearCatalogCache();
    this.setConnected(false);
    await session?.client.close();
  }

  // ==========================================================================
  // Query path (spec 5.1, 5.4, 5.5)
  // ==========================================================================

  /** No limit is added and there is no page two: the run itself stops at `DEFAULT_QUERY_LIMIT` rows. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: DEFAULT_QUERY_LIMIT, offset: 0 };
  }

  /** Policy, gate, then one READ run (see the file comment). */
  public async query(text: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    // Every statement is literal text in this version (SR2), and dropping the values would run
    // another statement than the one the caller built. An empty list binds nothing.
    if (params !== undefined && params.length > 0) {
      throw new QueryError(`Parameters are not supported for ${this.profile.engineLabel} in this version.`, this.type);
    }
    const { client, database } = this.requireSession();
    const verdict = checkCypherRead(text, this.profile);
    if (!verdict.allowed) {
      throw new QueryError(verdict.refusal.message, this.type, text, verdict.refusal.position);
    }

    const controller = new AbortController();
    if (queryId !== undefined) this.running.set(queryId, controller);
    const options: GraphRunOptions = {
      database,
      timeoutMs: this.queryTimeout,
      maxRows: DEFAULT_QUERY_LIMIT,
      signal: controller.signal,
      metadata: RUN_METADATA,
    };
    try {
      await this.passGate(client, verdict, options);
      const { result, executionTime } = await this.trackQuery(() =>
        this.measureExecution(() => this.mapped(() => client.run(verdict.statement.text, options))),
      );
      return toQueryResult(result, executionTime);
    } finally {
      if (queryId !== undefined && this.running.get(queryId) === controller) this.running.delete(queryId);
    }
  }

  /**
   * The engine's statement gate (SR10), skipped for an allowed `SHOW` form. A refusal, or any error
   * while checking, stops the statement; a cancel during the check reports the cancellation.
   */
  private async passGate(
    client: GraphClient,
    verdict: Extract<CypherReadVerdict, { allowed: true }>,
    options: GraphRunOptions,
  ): Promise<void> {
    const gate = this.profile.statementGate;
    if (gate === undefined || verdict.isShow) return;
    let refusal: CypherRefusal | undefined;
    try {
      refusal = await gate(client, verdict, options);
    } catch (error) {
      const mapped = this.providerError(error);
      if (options.signal?.aborted) throw mapped;
      throw new QueryError(
        `The statement could not be checked by the server, so it was not run: ${messageOf(mapped)}`,
        this.type,
        verdict.statement.text,
      );
    }
    if (refusal !== undefined) {
      throw new QueryError(refusal.message, this.type, verdict.statement.text, refusal.position);
    }
  }

  /** Aborts the statement running under `queryId`, which closes its session; false when none runs. */
  public async cancelQuery(queryId: string): Promise<boolean> {
    const controller = this.running.get(queryId);
    if (controller === undefined) return false;
    controller.abort(cancelled());
    return true;
  }

  // ==========================================================================
  // Object surface (spec 4.1 to 4.3)
  // ==========================================================================

  /** The one database (SR4); listing it starts the tree's refresh, so the catalog cache is dropped. */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    const { database } = this.requireSession();
    if (parent !== undefined && parent.length > 0) return [];
    this.clearCatalogCache();
    return [{ path: [database], name: database, level: 0, isSessionDefault: true }];
  }

  /** One listing per kind; a refused read is that kind's sentence, a cut one a floor (SR16). */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    const database = this.databaseOf(container);
    const client = this.client();
    const counts = await Promise.all(
      GRAPH_OBJECT_KINDS.map(async ({ id }): Promise<[string, KindCount]> => {
        try {
          const { entries, truncated } = await this.profile.catalog.listKind(client, database, id as GraphKindId);
          const count = new Set(entries.map((entry) => entry.name)).size;
          return [id, truncated ? { count, sampledFrom: CATALOG_CUT_SAMPLE } : { count }];
        } catch (error) {
          return [id, { unavailable: this.refusedReadMessage(error) }];
        }
      }),
    );
    return Object.fromEntries(counts);
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const id = this.graphKind(kind);
    const database = this.databaseOf(container);
    const { entries } = await this.mapped(() => this.profile.catalog.listKind(this.client(), database, id));
    return toDatabaseObjects(container, id, entries);
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const id = this.graphKind(kind);
    const database = this.databaseOf(path.slice(0, -1));
    const segment = path[path.length - 1] as string;
    const parsed = parseGraphObjectSegment(segment);
    if (parsed === undefined || parsed.kind !== id) {
      throw new QueryError(`${JSON.stringify(segment)} does not address a ${kind}`, this.type);
    }
    return this.detailOf(database, path, id, parsed.name);
  }

  /** One listing, then every object from one read of each catalog call (the cache shares them). */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    const id = this.graphKind(kind);
    const database = this.databaseOf(container);
    const listing = await this.mapped(() => this.profile.catalog.listKind(this.client(), database, id));
    const objects = toDatabaseObjects(container, id, listing.entries);
    const kept = limit === undefined ? objects : objects.slice(0, limit);
    const details = await Promise.all(kept.map((object) => this.detailOf(database, object.path, id, object.name)));
    const reasons = [
      ...(kept.length < objects.length ? [callerBoundTruncationReason(limit as number)] : []),
      ...(listing.truncated ? [CATALOG_CUT_REASON] : []),
    ];
    return reasons.length === 0
      ? { details }
      : { details, truncated: { limit: details.length, reason: reasons.join("; ") } };
  }

  /** Columns and indexes for a label or a relationship type; an index or a constraint has neither. */
  private async detailOf(
    database: string,
    path: readonly string[],
    kind: GraphKindId,
    name: string,
  ): Promise<ObjectDetail> {
    if (kind !== "label" && kind !== "relationship_type") {
      return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
    }
    const [properties, indexes] = await Promise.all([this.propertyRows(database, kind), this.indexRows(database)]);
    return {
      path: [...path],
      columns: columnsOf(name, properties.rows),
      indexes: indexesOf(name, RELATION_ENTITY[kind], indexes.rows),
      foreignKeys: [],
    };
  }

  /** The one container's database; any other container is refused, since another database is another connection (SR4). */
  private databaseOf(container: readonly string[]): string {
    const { database } = this.requireSession();
    if (container.length !== 1 || container[0] !== database) {
      throw new QueryError(
        `A ${this.profile.engineLabel} connection has one container, the database ${JSON.stringify(database)}; received ${JSON.stringify(container)}`,
        this.type,
      );
    }
    return database;
  }

  private graphKind(kind: string): GraphKindId {
    if (!GRAPH_KIND_IDS.has(kind)) {
      throw new QueryError(`${this.profile.engineLabel} has no object kind ${JSON.stringify(kind)}`, this.type);
    }
    return kind as GraphKindId;
  }

  /** A refused catalog read's sentence; a defect is not a refusal and is thrown. */
  private refusedReadMessage(error: unknown): string {
    const mapped = this.providerError(error);
    if (mapped instanceof DatabaseError) return mapped.message;
    throw mapped;
  }

  // ==========================================================================
  // Catalog cache (SR17)
  // ==========================================================================

  private propertyRows(database: string, kind: "label" | "relationship_type"): Promise<PropertyRead> {
    return this.cached(this.propertyCache, JSON.stringify([database, kind]), () =>
      this.profile.catalog.propertyRows(this.client(), database, kind),
    );
  }

  private indexRows(database: string): Promise<IndexRead> {
    return this.cached(this.indexCache, database, () => this.profile.catalog.indexRows(this.client(), database));
  }

  /** A read kept for `CATALOG_CACHE_MS` and shared by concurrent callers; a rejected one is evicted. */
  private cached<T>(cache: Map<string, CachedRead<T>>, key: string, read: () => Promise<T>): Promise<T> {
    const now = this.now();
    const kept = cache.get(key);
    if (kept !== undefined && now - kept.readAt < CATALOG_CACHE_MS) return kept.value;
    const entry: CachedRead<T> = { value: this.mapped(read), readAt: now };
    cache.set(key, entry);
    entry.value.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return entry.value;
  }

  private clearCatalogCache(): void {
    this.propertyCache.clear();
    this.indexCache.clear();
  }

  // ==========================================================================
  // Health and maintenance
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    const client = this.client();
    const server = await this.mapped(() => client.verify());
    return this.healthOf(server);
  }

  /** Read-only in this version: `supportsMaintenance` is false, and a call that arrives anyway is refused. */
  public async runMaintenance(type: MaintenanceOperation): Promise<MaintenanceResult> {
    void type;
    throw new QueryError(
      `${this.profile.engineLabel} connections are read-only in this version: no maintenance operation runs.`,
      this.type,
    );
  }
}

/** The abort reason of a cancel or a disconnect, as etcd words it. */
function cancelled(): DOMException {
  return new DOMException("The query was cancelled", "AbortError");
}
