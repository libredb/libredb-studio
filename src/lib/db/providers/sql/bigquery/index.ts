/**
 * Google BigQuery over REST v2, no Google SDK.
 *
 * Connection fields: `database` = project id, `schema` = optional default dataset,
 * `password` = service-account key JSON or access token; an operator-seeded connection may omit it to use the server's ADC.
 * EXPLAIN is a dry run: it reports the bytes the statement would scan and bills nothing.
 */

import { BIGQUERY_DRY_RUN_MARKER } from "@/lib/explain/bigquery-dryrun";
import { AuthenticationError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  assertContainerPathShape,
  assertObjectPathShape,
  callerBoundTruncationReason,
  type ContainerPathShapeEngine,
  type ObjectPathShapeEngine,
} from "@/lib/db/object-kinds";
import { comparePaths } from "@/lib/db/object-path";
import { formatBytes } from "@/lib/db/utils/pool-manager";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import type {
  ActiveSessionDetails,
  ColumnSchema,
  Container,
  ContainerLevels,
  DatabaseConnection,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KindCount,
  MaintenanceResult,
  MaintenanceType,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  PerformanceMetrics,
  ProviderCapabilities,
  ProviderOptions,
  QueryResult,
  QueryWarning,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { SQLBaseProvider } from "../sql-base";
import { readCredentials } from "./auth";
import {
  BigQueryApiError,
  type BigQueryField,
  type BigQueryDatasetRef,
  type BigQueryQueryResult,
  type BigQueryTableRef,
  type BigQueryTransport,
  createBigQueryTransport,
} from "./transport";

const CLIENT_GRACE_MS = 5_000;
const CATALOG_TIMEOUT_MS = 30_000;
// The inventory lists each dataset once per kind and again per bulk read; one REST listing serves them all.
const TABLE_LIST_TTL_MS = 30_000;
const DESCRIBE_CONCURRENCY = 8;
const CATALOG_TTL_MS = 5 * 60_000;
/** A catalog no region could be read for: kept shorter, but kept, since every retry bills two 10 MB jobs per region. */
const NULL_CATALOG_TTL_MS = 60_000;
const MONITORING_MAX_ENTRIES = 50;
/** A mutable object so a test can lower the cap; a region that reaches it is treated as unread, never truncated. */
export const catalogLimits = { maxRows: 2_000_000 };

/**
 * Every table and column of the project, read with two INFORMATION_SCHEMA queries per region.
 * `tables` holds only the datasets of regions that were read in full; any other dataset is answered over REST.
 */
interface Catalog {
  readonly tables: ReadonlyMap<string, BigQueryTableRef[]>;
  readonly columns: ReadonlyMap<string, ColumnSchema[]>;
}

const MONITORING_TTL_MS = 60_000;
/** Storage moves slowly and a project-wide TABLE_STORAGE read can bill a GB or more in a project with many datasets. */
const STORAGE_TTL_MS = 15 * 60_000;
const MONITORING_MAX_ROWS = 1_000;

/** A GoogleSQL string literal: backslash escapes, quote never doubled. */
function bqString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const tableKey = (dataset: string, table: string) => `${dataset}\u0000${table}`;

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Dataset", labelPlural: "Datasets" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
  { id: "view", role: "relation", label: "View", labelPlural: "Views", hasColumns: true },
  {
    id: "materialized_view",
    role: "relation",
    label: "Materialized View",
    labelPlural: "Materialized Views",
    hasColumns: true,
  },
] as const);

const BIGQUERY_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: "bigquery",
  label: "A BigQuery",
  shapeNames: "label",
};
const BIGQUERY_OBJECT_PATH_ENGINE: ObjectPathShapeEngine = {
  code: "bigquery",
  label: "A BigQuery",
  attachedSegment: "required",
};

/** REST `tables.list` type -> declared kind. TABLE also covers EXTERNAL, SNAPSHOT and CLONE. */
function kindOf(restType: string): string {
  if (restType === "VIEW") return "view";
  if (restType === "MATERIALIZED_VIEW") return "materialized_view";
  return "table";
}

/**
 * The location every job is sent to: the default dataset's, else the one most datasets share. A query that names no
 * table (a probe, a half-typed dry run) would otherwise run in US and miss an EU project.
 */
export function jobLocation(datasets: readonly BigQueryDatasetRef[], defaultDataset?: string): string | undefined {
  const own = datasets.find((d) => d.id === defaultDataset)?.location;
  if (own) return own;
  const counts = new Map<string, number>();
  for (const d of datasets) if (d.location) counts.set(d.location, (counts.get(d.location) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** The promise, or the signal's reason once it aborts first; the listener is removed when either settles. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** `tables.get` uses legacy type names; INFORMATION_SCHEMA uses these. */
const LEGACY_TYPES: Readonly<Record<string, string>> = { INTEGER: "INT64", FLOAT: "FLOAT64", BOOLEAN: "BOOL" };

function columnType(field: BigQueryField): string {
  const base =
    field.fields && field.fields.length > 0
      ? `STRUCT<${field.fields.map((f) => `${f.name} ${columnType(f)}`).join(", ")}>`
      : (LEGACY_TYPES[field.type] ?? field.type);
  return field.mode === "REPEATED" ? `ARRAY<${base}>` : base;
}

function resultOf(result: BigQueryQueryResult): QueryResult {
  const warnings = bytesWarning(result);
  // A DML answer carries the table's schema; the grid shows the affected-row count only without fields.
  const fields = result.affectedRows === null ? result.fields.map((f) => f.name) : [];
  return {
    rows: result.rows,
    fields,
    rowCount: result.affectedRows ?? result.rows.length,
    executionTime: Math.round(result.executionTimeMs),
    ...(fields.length > 0
      ? { columnTypes: Object.fromEntries(result.fields.map((f) => [f.name, columnType(f)])) }
      : {}),
    ...(warnings ? { warnings } : {}),
  };
}

function bytesWarning(result: BigQueryQueryResult): QueryWarning[] | undefined {
  if (result.totalBytesProcessed === null) return undefined;
  const billed = result.totalBytesBilled === null ? "" : `, billed ${formatBytes(result.totalBytesBilled)}`;
  const cache = result.cacheHit ? " (cache hit)" : "";
  return [{ message: `Processed ${formatBytes(result.totalBytesProcessed)}${billed}${cache}`, severity: "info" }];
}

export class BigQueryProvider extends SQLBaseProvider {
  private transport: BigQueryTransport | null = null;
  private location: string | undefined;
  private readonly monitoringCache = new Map<
    string,
    { at: number; ttl: number; rows: Promise<Record<string, unknown>[] | null> }
  >();
  private readonly tableLists = new Map<string, { at: number; tables: Promise<BigQueryTableRef[]> }>();
  private catalogCache: { at: number; ttl: number; catalog: Promise<Catalog | null> } | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "bigquery-dryrun",
      supportsExternalQueryLimiting: true,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: true,
      supportsTransactions: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: null,
      identifierQuoting: "backtick",
      schemaRefreshPattern: "\\b(CREATE|DROP|ALTER)\\b",
      containerLevels: CONTAINER_LEVELS,
      containerPathShapes: "exact",
      tablesNeedContainer: true,
      objectKinds: OBJECT_KINDS,
      // The agent's identity is a service-account key of its own in `agentPassword`, from which `auth.ts` mints the
      // token, so no token minted at a scope Studio cannot read is taken.
      agentCredential: "service-account-key",
    };
  }

  public override validate(): void {
    super.validate();
    if (!this.config.database) {
      throw new DatabaseConfigError("BigQuery requires a project id in the database field", this.type);
    }
  }

  protected override escapeIdentifier(identifier: string): string {
    return `\`${identifier.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
  }

  /**
   * Set only on a connection resolved from the operator's seed file: `resolveConnection` forces `managed: false` on a
   * connection the caller supplied inline, so a client cannot claim it.
   */
  private operatorSeeded(): boolean {
    return this.config.managed === true;
  }

  private project(): string {
    // validate() guarantees it.
    return this.config.database!;
  }

  public async connect(): Promise<void> {
    if (!this.config.password?.trim() && !this.operatorSeeded()) {
      throw new DatabaseConfigError(
        "BigQuery needs a service-account key or an access token in the password field: the server's own credentials are used only for operator-seeded connections",
        this.type,
      );
    }
    const transport = createBigQueryTransport(this.project(), readCredentials(this.config.password));
    try {
      // Without datasets.list the job location is left to BigQuery to infer; bad credentials still fail here.
      this.location =
        this.config.location?.trim() ||
        jobLocation(
          await transport.listDatasets(this.deadline()).catch((error: unknown) => {
            if (error instanceof AuthenticationError || (error instanceof BigQueryApiError && error.status === 401)) {
              throw error;
            }
            return [];
          }),
          this.config.schema,
        );
      await transport.query("SELECT 1", {
        jobTimeoutMs: this.queryTimeout,
        maxRows: 1,
        ...(this.location ? { location: this.location } : {}),
        signal: this.deadline(),
      });
    } catch (error) {
      transport.close();
      const mapped = this.mapBigQueryError(error);
      this.setError(mapped);
      throw mapped;
    }
    this.transport = transport;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.transport?.close();
    this.transport = null;
    this.invalidateCatalog();
    this.monitoringCache.clear();
    this.setConnected(false);
  }

  private requireTransport(): BigQueryTransport {
    this.ensureConnected();
    return this.transport!;
  }

  private invalidateCatalog(): void {
    this.catalogCache = null;
    this.tableLists.clear();
  }

  private deadline(ms: number = this.queryTimeout): AbortSignal {
    return AbortSignal.timeout(ms + CLIENT_GRACE_MS);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const transport = this.requireTransport();
    // ponytail: no queryParameters mapping yet; add typed positional params when a caller needs them.
    if (params && params.length > 0) {
      throw new QueryError("BigQuery parameters are not supported yet; inline the values", this.type, sql);
    }
    const dryRun = sql.startsWith(BIGQUERY_DRY_RUN_MARKER);

    return this.trackQuery(async () => {
      try {
        const result = await transport.query(sql, {
          dryRun,
          jobTimeoutMs: this.queryTimeout,
          maxRows: MAX_UNLIMITED_ROWS,
          ...(this.config.schema ? { defaultDataset: this.config.schema } : {}),
          ...(this.location ? { location: this.location } : {}),
          signal: this.deadline(),
        });
        if (dryRun) {
          const bytes = result.totalBytesProcessed ?? 0;
          return {
            rows: [{ bytes_processed: bytes, bytes_processed_human: formatBytes(bytes) }],
            fields: ["bytes_processed", "bytes_processed_human"],
            rowCount: 1,
            executionTime: Math.round(result.executionTimeMs),
          };
        }
        return resultOf(result);
      } catch (error) {
        throw this.mapBigQueryError(error, sql);
      } finally {
        if (!dryRun && this.isSchemaModifyingQuery(sql)) this.invalidateCatalog();
      }
    });
  }

  private mapBigQueryError(error: unknown, sql?: string, timeoutMs: number = this.queryTimeout): Error {
    if (!(error instanceof BigQueryApiError)) {
      if (error instanceof TransportError && error.kind === "timeout") {
        return new TimeoutError(error.message, this.type, timeoutMs, sql);
      }
      return this.mapError(error, sql);
    }
    if (error.status === 401) return new AuthenticationError(error.message, this.type);
    return new QueryError(error.message, this.type, sql);
  }

  private async guarded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return await operation(this.deadline(CATALOG_TIMEOUT_MS));
    } catch (error) {
      throw this.mapBigQueryError(error);
    }
  }

  /**
   * The project's catalog, or null when no region could be read (REST answers instead). Metadata queries bill the 10 MB
   * minimum each, so it is cached rather than read per dataset; a null for a shorter time.
   */
  private readCatalog(transport: BigQueryTransport): Promise<Catalog | null> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < this.catalogCache.ttl)
      return this.catalogCache.catalog;
    const catalog = this.loadCatalog(transport).catch(() => null);
    const entry = { at: Date.now(), ttl: CATALOG_TTL_MS, catalog };
    this.catalogCache = entry;
    void catalog.then((loaded) => {
      if (!loaded) entry.ttl = NULL_CATALOG_TTL_MS;
    });
    return catalog;
  }

  private async loadCatalog(transport: BigQueryTransport): Promise<Catalog | null> {
    const signal = this.deadline(CATALOG_TIMEOUT_MS * 4);
    const datasets = await transport.listDatasets(signal);
    const tables = new Map<string, BigQueryTableRef[]>();
    const columns = new Map<string, ColumnSchema[]>();
    const project = this.escapeIdentifier(this.project());
    const cap = catalogLimits.maxRows;
    // ponytail: the transport stops paging at cap + 1 rows, so an over-cap region decodes up to 2M rows before it is
    // dropped; a smaller per-location cap would trade that memory for catalogs of large projects.
    const read = async (sql: string) => {
      const result = await transport.query(sql, { jobTimeoutMs: CATALOG_TIMEOUT_MS * 4, maxRows: cap + 1, signal });
      if (result.rows.length > cap)
        throw new QueryError("INFORMATION_SCHEMA read exceeds the catalog row cap", this.type);
      return result.rows;
    };

    const locations = [...new Set(datasets.flatMap((d) => (d.location ? [d.location.toLowerCase()] : [])))];
    const outcomes = await Promise.all(
      locations.map(async (location) => {
        const schema = `${project}.${this.escapeIdentifier(`region-${location}`)}.INFORMATION_SCHEMA`;
        try {
          const [tableRows, columnRows] = await Promise.all([
            read(`SELECT table_schema, table_name, table_type FROM ${schema}.TABLES`),
            read(
              `SELECT table_schema, table_name, column_name, data_type, is_nullable FROM ${schema}.COLUMNS ` +
                "ORDER BY table_schema, table_name, ordinal_position",
            ),
          ]);
          for (const d of datasets) if (d.location?.toLowerCase() === location) tables.set(d.id, []);
          for (const row of tableRows) {
            const dataset = String(row.table_schema);
            const list = tables.get(dataset) ?? [];
            list.push({ id: String(row.table_name), type: String(row.table_type).replace(/ /g, "_") });
            tables.set(dataset, list);
          }
          for (const row of columnRows) {
            const key = tableKey(String(row.table_schema), String(row.table_name));
            const list = columns.get(key) ?? [];
            list.push({
              name: String(row.column_name),
              type: String(row.data_type),
              nullable: row.is_nullable === "YES",
              isPrimary: false,
            });
            columns.set(key, list);
          }
          return true;
        } catch {
          return false;
        }
      }),
    );
    return outcomes.some(Boolean) ? { tables, columns } : null;
  }

  private async listTables(
    transport: BigQueryTransport,
    dataset: string,
    signal: AbortSignal,
  ): Promise<BigQueryTableRef[]> {
    const cached = () => {
      const hit = this.tableLists.get(dataset);
      return hit && Date.now() - hit.at < TABLE_LIST_TTL_MS ? hit.tables : undefined;
    };
    const early = cached();
    if (early) return raceSignal(early, signal);
    const known = (await raceSignal(this.readCatalog(transport), signal))?.tables.get(dataset);
    if (known) return known;
    // A concurrent caller may have started the listing while this one read the catalog.
    let tables = cached();
    if (!tables) {
      // Shared by concurrent callers, so it runs on its own deadline: one caller's abort must not fail the others.
      tables = transport.listTables(dataset, this.deadline(CATALOG_TIMEOUT_MS));
      this.tableLists.set(dataset, { at: Date.now(), tables });
      tables.catch(() => this.tableLists.delete(dataset));
    }
    return raceSignal(tables, signal);
  }

  private requireKind(kind: string): void {
    if (!OBJECT_KINDS.some((spec) => spec.id === kind)) {
      throw new QueryError(`BigQuery declares no object kind "${kind}"`, this.type);
    }
  }

  private dataset(container: readonly string[]): string {
    assertContainerPathShape(this.getCapabilities(), container, BIGQUERY_CONTAINER_PATH_ENGINE);
    return container[0];
  }

  // ==========================================================================
  // Object surface: datasets -> tables / views, read over REST (free, no bytes scanned)
  // ==========================================================================

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    if (parent !== undefined && parent.length > 0) return [];
    const transport = this.requireTransport();
    const datasets = await this.guarded((signal) => transport.listDatasets(signal));
    return datasets
      .map((d) => d.id)
      .sort()
      .map((id) => ({ path: [id], name: id, level: 0, isSessionDefault: id === this.config.schema }));
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    const transport = this.requireTransport();
    const dataset = this.dataset(container);
    try {
      const tables = await this.listTables(transport, dataset, this.deadline(CATALOG_TIMEOUT_MS));
      const counts: Record<string, KindCount> = Object.fromEntries(OBJECT_KINDS.map((k) => [k.id, { count: 0 }]));
      for (const t of tables) {
        const kind = kindOf(t.type);
        counts[kind] = { count: (counts[kind] as { count: number }).count + 1 };
      }
      return counts;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return Object.fromEntries(OBJECT_KINDS.map((k) => [k.id, { unavailable: reason }]));
    }
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    const transport = this.requireTransport();
    const dataset = this.dataset(container);
    const tables = await this.guarded((signal) => this.listTables(transport, dataset, signal));
    return tables
      .filter((t) => kindOf(t.type) === kind)
      .map((t) => ({ path: [dataset, t.id], name: t.id, kind }))
      .sort((a, b) => comparePaths(a.path, b.path));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.requireKind(kind);
    const spec = OBJECT_KINDS.find((candidate) => candidate.id === kind)!;
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, BIGQUERY_OBJECT_PATH_ENGINE);
    const transport = this.requireTransport();
    const table = await this.guarded((signal) => transport.getTable(path[0], path[1], signal));
    return {
      path: [...path],
      columns: table.fields.map((f) => ({
        name: f.name,
        type: columnType(f),
        nullable: f.mode !== "REQUIRED",
        isPrimary: false,
      })),
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A BigQuery bulk column read limit must be a positive whole number, received ${limit}`,
        this.type,
      );
    }
    const objects = await this.listObjects(container, kind);
    const truncated = limit !== undefined && objects.length > limit;
    const targets = truncated ? objects.slice(0, limit) : objects;
    const bound = (details: ObjectDetail[]): ObjectDetailBatch =>
      truncated ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };

    const catalog = await this.readCatalog(this.requireTransport());
    if (catalog?.tables.has(container[0])) {
      return bound(
        targets.map((o) => ({
          path: [...o.path],
          columns: catalog.columns.get(tableKey(o.path[0], o.path[1])) ?? [],
          indexes: [],
          foreignKeys: [],
        })),
      );
    }

    // A table that cannot be read (permission, dropped since the listing, rate limit) loses its columns, not the whole
    // inventory: the route reads datasets sequentially and one throw would leave the editor with no schema at all.
    const details: ObjectDetail[] = new Array(targets.length);
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const index = next++;
        const object = targets[index];
        details[index] = await this.describeObject(object.path, kind).catch(() => ({
          path: [...object.path],
          columns: [],
          indexes: [],
          foreignKeys: [],
        }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(DESCRIBE_CONCURRENCY, targets.length) }, worker));
    return bound(details);
  }

  // ==========================================================================
  // Monitoring: BigQuery is serverless; nothing here maps to a server's counters.
  // ==========================================================================

  /**
   * One region INFORMATION_SCHEMA read for the monitoring panels, cached (STORAGE_TTL_MS for TABLE_STORAGE, else
   * MONITORING_TTL_MS) since the panel polls every 30 s and each read bills at least 10 MB. A refused read (no
   * bigquery.jobs.listAll, no location) is null.
   */
  private monitoringRead(view: string, select: (from: string) => string): Promise<Record<string, unknown>[] | null> {
    if (!this.location) return Promise.resolve(null);
    const from = `${this.escapeIdentifier(this.project())}.${this.escapeIdentifier(`region-${this.location.toLowerCase()}`)}.INFORMATION_SCHEMA.${view}`;
    const sql = select(from);
    const hit = this.monitoringCache.get(sql);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.rows;
    const rows = this.requireTransport()
      .query(sql, {
        jobTimeoutMs: CATALOG_TIMEOUT_MS,
        maxRows: MONITORING_MAX_ROWS,
        location: this.location,
        signal: this.deadline(CATALOG_TIMEOUT_MS),
      })
      .then((result) => result.rows)
      .catch(() => {
        // Not cached, so the next poll retries.
        if (this.monitoringCache.get(sql)?.rows === rows) this.monitoringCache.delete(sql);
        return null;
      });
    const now = Date.now();
    for (const [key, entry] of this.monitoringCache) if (now - entry.at >= entry.ttl) this.monitoringCache.delete(key);
    // Map order is insertion order, so the first key is the oldest.
    while (this.monitoringCache.size >= MONITORING_MAX_ENTRIES) {
      this.monitoringCache.delete(this.monitoringCache.keys().next().value!);
    }
    this.monitoringCache.set(sql, {
      at: now,
      ttl: view === "TABLE_STORAGE" ? STORAGE_TTL_MS : MONITORING_TTL_MS,
      rows,
    });
    return rows;
  }

  /** Tables and logical bytes per dataset: one read serves the overview and the storage panel. */
  private storageBySchema(): Promise<Record<string, unknown>[] | null> {
    return this.monitoringRead(
      "TABLE_STORAGE",
      (from) =>
        "SELECT table_schema, COUNT(*) AS tables, SUM(total_logical_bytes) AS bytes " +
        `FROM ${from} WHERE project_id = ${bqString(this.project())} AND NOT deleted ` +
        "GROUP BY table_schema ORDER BY bytes DESC",
    );
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const rows = await this.storageBySchema();
    const read = rows !== null;
    const bytes = (rows ?? []).reduce((sum, row) => sum + Number(row.bytes ?? 0), 0);
    return {
      version: `BigQuery${this.location ? ` (${this.location})` : ""}`,
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: read ? formatBytes(bytes) : "N/A",
      ...(read ? { databaseSizeBytes: bytes } : {}),
      tableCount: (rows ?? []).reduce((sum, row) => sum + Number(row.tables ?? 0), 0),
      indexCount: 0,
    };
  }

  /** Over the last hour of query jobs: share answered from cache, and jobs per second. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    const [jobs] =
      (await this.monitoringRead(
        "JOBS_BY_PROJECT",
        (from) =>
          `SELECT COUNT(*) AS total, COUNTIF(cache_hit) AS cached FROM ${from} ` +
          "WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) AND job_type = 'QUERY'",
      )) ?? [];
    const total = Number(jobs?.total ?? 0);
    if (!jobs || total === 0) return {};
    return {
      cacheHitRatio: Math.round((Number(jobs.cached) / total) * 1000) / 10,
      queriesPerSecond: Math.round((total / 3600) * 100) / 100,
    };
  }

  /** The last day's query texts by total run time. `rows` is 0: JOBS records bytes and slots, not result rows. */
  public async getSlowQueries(options: { limit?: number } = {}): Promise<SlowQueryStats[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 200);
    const rows = await this.monitoringRead(
      "JOBS_BY_PROJECT",
      (from) =>
        "SELECT query, COUNT(*) AS calls, " +
        "SUM(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND)) AS total_ms, " +
        "MIN(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND)) AS min_ms, " +
        "MAX(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND)) AS max_ms " +
        `FROM ${from} WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) ` +
        "AND job_type = 'QUERY' AND state = 'DONE' AND statement_type != 'SCRIPT' " +
        `GROUP BY query ORDER BY total_ms DESC LIMIT ${limit}`,
    );
    return (rows ?? []).map((row) => {
      const calls = Number(row.calls);
      const totalTime = Number(row.total_ms ?? 0);
      return {
        query: String(row.query),
        calls,
        totalTime,
        avgTime: calls > 0 ? Math.round(totalTime / calls) : 0,
        minTime: Number(row.min_ms ?? 0),
        maxTime: Number(row.max_ms ?? 0),
        rows: 0,
      };
    });
  }

  /** Jobs still pending or running. */
  public async getActiveSessions(options: { limit?: number } = {}): Promise<ActiveSessionDetails[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 500);
    const rows = await this.monitoringRead(
      "JOBS_BY_PROJECT",
      (from) =>
        "SELECT job_id, user_email, state, query, creation_time, start_time, " +
        "TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), COALESCE(start_time, creation_time), MILLISECOND) AS ms " +
        `FROM ${from} WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) AND state != 'DONE' ` +
        `ORDER BY creation_time LIMIT ${limit}`,
    );
    return (rows ?? []).map((row) => {
      const durationMs = Number(row.ms ?? 0);
      return {
        pid: String(row.job_id),
        user: String(row.user_email ?? ""),
        database: this.project(),
        state: String(row.state).toLowerCase(),
        query: String(row.query ?? ""),
        ...(row.start_time ? { queryStart: new Date(String(row.start_time)) } : {}),
        duration: `${Math.round(durationMs / 1000)}s`,
        durationMs,
      };
    });
  }

  /** Rows and logical bytes per table, largest first. */
  public async getTableStats(options: { schema?: string } = {}): Promise<TableStats[]> {
    const rows = await this.monitoringRead(
      "TABLE_STORAGE",
      (from) =>
        "SELECT table_schema, table_name, total_rows, total_logical_bytes " +
        `FROM ${from} WHERE project_id = ${bqString(this.project())} AND NOT deleted` +
        (options.schema ? ` AND table_schema = ${bqString(options.schema)}` : "") +
        " ORDER BY total_logical_bytes DESC LIMIT 500",
    );
    return (rows ?? []).map((row) => {
      const bytes = Number(row.total_logical_bytes ?? 0);
      return {
        schemaName: String(row.table_schema),
        tableName: String(row.table_name),
        rowCount: Number(row.total_rows ?? 0),
        totalSize: formatBytes(bytes),
        totalSizeBytes: bytes,
      };
    });
  }

  /** Logical bytes per dataset. */
  public async getStorageStats(): Promise<StorageStats[]> {
    const rows = await this.storageBySchema();
    return (rows ?? []).map((row) => {
      const bytes = Number(row.bytes ?? 0);
      return {
        name: String(row.table_schema),
        ...(this.location ? { location: this.location } : {}),
        size: formatBytes(bytes),
        sizeBytes: bytes,
      };
    });
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }

  public async getHealth(): Promise<HealthInfo> {
    this.requireTransport();
    return { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
  }

  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    throw new QueryError(`BigQuery has no maintenance operation "${type}"`, this.type);
  }
}
