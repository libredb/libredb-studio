/**
 * IBM Db2 LUW provider (#786), over db2-node 1.0.25.
 *
 * The driver's known defects are listed in `docs/providers/db2.md` under "Known issues"; the ones
 * 1.0.22 had were fixed in 1.0.24 (gurungabit/db2-node#12) and most of the rest in 1.0.25
 * (gurungabit/db2-node#19 to #25). This class contains what a provider still can:
 *
 * - M1 no LOB in a catalog row beside other columns, and catalog text read as HEX (`catalog.ts`);
 * - M3 an array or object parameter refused before the driver reads it as bytes (`params.ts`);
 * - M4 the schema always bound, never the session's; M5 padded CHAR trimmed (`catalog.ts`);
 * - M6 no `queryTimeout` and no `cancelQuery`; M7 a duplicate column kept, under a numbered name
 *   (`values.ts`); a lost LOB edit named, and kept out of the preview (K24, `values.ts`);
 * - a driver failure classified by its `driverCode` (K17, `driver.ts`);
 * - TLS that fails closed, and a tunnel that is never dialled around (`connection.ts`).
 *
 * One client per provider, no pool: four concurrent queries on one client were measured
 * correct, and a pool would multiply the cleartext-password exposure of a connection that opted
 * out of TLS.
 *
 * Absent on purpose: `queryReadOnly` and `endOpenQueryTransaction` (no read-only profile in this
 * version), `cancelQuery` (the driver's `Client.cancel()` and server-side `queryTimeout` need
 * monitoring and cancel privileges and are a change of their own, D148), interactive
 * transactions, and the object-edit pair.
 */

import type {
  ActiveSessionDetails,
  Container,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KindCount,
  MaintenanceOperation,
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectSourceDocument,
  PerformanceMetrics,
  PreparedQuery,
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  QueryPrepareOptions,
  QueryResult,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "../../../types";
import { DatabaseConfigError, QueryError } from "../../../errors";
import { analyzeQuery, DEFAULT_QUERY_LIMIT, MAX_UNLIMITED_ROWS } from "../../../utils/query-limiter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { SQLBaseProvider } from "../sql-base";
import { db2Capabilities, db2Labels } from "./capabilities";
import { CODE_PAGE_SQL, decodeCatalogRow } from "./catalog";
import { type CaFileSystem, type Db2Connection, NODE_CA_FILE_SYSTEM, openClient, resolveTarget } from "./connection";
import { type Db2Client, type Db2Driver, loadDb2Driver, mapDb2Error } from "./driver";
import { MAINTAINED_TABLE_TYPES, MAINTENANCE_TARGET_TYPE_SQL, maintenanceStatement } from "./maintenance";
import { neutralHealth, readOverview, TABLE_STATS_SQL, tableStatsRow } from "./monitoring";
import * as objects from "./objects";
import { normaliseParams } from "./params";
import { readResult } from "./values";

/** The seams a test replaces; production uses the defaults. */
export interface Db2ProviderSeams {
  loadDriver?: () => Promise<Db2Driver>;
  caFileSystem?: CaFileSystem;
}

export class Db2Provider extends SQLBaseProvider {
  private client: Db2Client | null = null;
  private caDir: string | undefined;
  private codePageValue: number | undefined;
  private readonly loadDriver: () => Promise<Db2Driver>;
  private readonly caFileSystem: CaFileSystem;

  /** The object surface's way to the catalog: decoded rows, and the code page they need. */
  private readonly reader: objects.CatalogReader = {
    read: (sql, params) => this.readCatalog(sql, params),
    codePage: () => this.codePage(),
  };

  constructor(config: Db2Connection, options: ProviderOptions = {}, seams: Db2ProviderSeams = {}) {
    super(config, options);
    this.loadDriver = seams.loadDriver ?? loadDb2Driver;
    this.caFileSystem = seams.caFileSystem ?? NODE_CA_FILE_SYSTEM;
    this.validate();
  }

  public override getCapabilities(): ProviderCapabilities {
    return db2Capabilities(super.getCapabilities());
  }

  public override getLabels(): ProviderLabels {
    return db2Labels(super.getLabels());
  }

  /** The connection read into a target, refusing what cannot be honoured, before any socket. */
  public override validate(): void {
    super.validate();
    resolveTarget(this.config);
  }

  // ============================================================================
  // Connection
  // ============================================================================

  public async connect(): Promise<void> {
    try {
      const opened = await openClient(this.config, this.loadDriver, this.caFileSystem);
      this.client = opened.client;
      this.caDir = opened.caDir;
      this.setConnected(true);
    } catch (error) {
      const mapped = mapDb2Error(error);
      this.setError(mapped);
      throw mapped;
    }
  }

  /** Closes the client and removes the CA file, whichever of the two fails. */
  public async disconnect(): Promise<void> {
    const client = this.client;
    const caDir = this.caDir;
    this.client = null;
    this.caDir = undefined;
    this.codePageValue = undefined;
    this.setConnected(false);
    try {
      if (client !== null) await client.close();
    } catch (error) {
      throw mapDb2Error(error);
    } finally {
      if (caDir !== undefined) await this.caFileSystem.rm(caDir, { recursive: true, force: true });
    }
  }

  /** The connected client, or the base class's own "not connected" refusal. */
  private connected(): Db2Client {
    this.ensureConnected();
    return this.client as Db2Client;
  }

  // ============================================================================
  // Queries
  // ============================================================================

  /**
   * One statement, sent as written with its parameters checked (M3), and read as array rows so a
   * duplicated column keeps every value (M7, K15). db2-node 1.0.24 classifies a statement past its
   * leading comments, which 1.0.22 refused (K18, fixed). No timeout is passed (M6).
   */
  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const client = this.connected();
    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return await client.query(sql, normaliseParams(params), { rowMode: "array" });
        } catch (error) {
          throw mapDb2Error(error, sql);
        }
      });
      return { ...readResult(result, sql), executionTime };
    });
  }

  /**
   * The row bound as `FETCH FIRST n ROWS ONLY`, or `OFFSET m ROWS FETCH NEXT n ROWS ONLY` past
   * the first page, between the statement and its trailing trivia, as Oracle's provider places it.
   * A statement whose end cannot be found is returned untouched rather than bounded on a guess.
   */
  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    const queryInfo = analyzeQuery(query, this.type);

    if (queryInfo.type === "SELECT" && !queryInfo.hasLimit) {
      const source = query.trim();
      const { end, rewritable } = readStatementEnd(source, resolveSqlGrammar(this.type));
      if (!rewritable) {
        return { query, wasLimited: false, limit: effectiveLimit, offset };
      }
      const clause =
        offset > 0
          ? `OFFSET ${offset} ROWS FETCH NEXT ${effectiveLimit} ROWS ONLY`
          : `FETCH FIRST ${effectiveLimit} ROWS ONLY`;
      return {
        query: `${source.slice(0, end)} ${clause}${source.slice(end)}`,
        wasLimited: true,
        limit: effectiveLimit,
        offset,
      };
    }

    return { query, wasLimited: false, limit: effectiveLimit, offset };
  }

  /**
   * One catalog statement's rows, `_HEX` columns decoded. Errors travel UNMAPPED, so a refused
   * count read can carry the server's own sentence; each public method maps what reaches it.
   */
  private async readCatalog(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const codePage = await this.codePage();
    const result = await this.connected().query(sql, normaliseParams(params));
    return result.rows.map((row) => decodeCatalogRow(row, codePage));
  }

  /** The database's code page, read once per connection. */
  private async codePage(): Promise<number> {
    if (this.codePageValue !== undefined) return this.codePageValue;
    const result = await this.connected().query(CODE_PAGE_SQL, undefined);
    const codePage = result.rows[0]?.CODEPAGE;
    if (typeof codePage !== "number") {
      throw new QueryError(`Db2 answered no code page for this database (${String(codePage)})`, "db2");
    }
    this.codePageValue = codePage;
    return codePage;
  }

  /** An object-surface call, its errors mapped. */
  private async surface<T>(read: () => Promise<T>): Promise<T> {
    this.connected();
    try {
      return await read();
    } catch (error) {
      throw mapDb2Error(error);
    }
  }

  // ============================================================================
  // Object surface
  // ============================================================================

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    return this.surface(() => objects.listContainers(this.reader, parent));
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    return this.surface(() => objects.countObjects(this.reader, this.getCapabilities(), container));
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    return this.surface(() => objects.listObjects(this.reader, this.getCapabilities(), container, kind));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return this.surface(() => objects.describeObject(this.reader, this.getCapabilities(), path, kind));
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    return this.surface(() => objects.describeObjects(this.reader, this.getCapabilities(), container, kind, limit));
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    return this.surface(() => objects.readObjectSource(this.reader, this.getCapabilities(), path, kind, limit));
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  /**
   * RUNSTATS or REORG on one table or materialized query table, named by the request's schema
   * and table. Anything else is refused before the command is sent, a view included.
   */
  public async runMaintenance(
    type: MaintenanceOperation,
    target?: string,
    container?: string,
  ): Promise<MaintenanceResult> {
    const client = this.connected();
    const statement = maintenanceStatement(type, target, container);
    const schema = container as string;
    const table = target as string;
    const { executionTime } = await this.measureExecution(async () => {
      const [row] = await this.surface(() => this.readCatalog(MAINTENANCE_TARGET_TYPE_SQL, [schema, table]));
      if (row === undefined) {
        throw new QueryError(`Db2 holds no table called "${table}" in ${schema}`, "db2");
      }
      if (!Object.hasOwn(MAINTAINED_TABLE_TYPES, String(row.TYPE))) {
        throw new DatabaseConfigError(
          `${statement.word} runs on a table or a materialized query table, and ${schema}.${table} is neither ` +
            `(SYSCAT.TABLES.TYPE ${String(row.TYPE)}).`,
          "db2",
        );
      }
      try {
        await client.query(statement.sql, undefined);
      } catch (error) {
        throw mapDb2Error(error, statement.sql);
      }
    });
    return { success: true, executionTime, message: statement.message };
  }

  // ============================================================================
  // Monitoring (neutral in this version)
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.connected();
    return neutralHealth();
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.connected();
    return readOverview((sql) => this.readCatalog(sql, []));
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.connected();
    return {};
  }

  public async getSlowQueries(_options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.connected();
    return [];
  }

  public async getActiveSessions(_options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.connected();
    return [];
  }

  /** Every user table and materialized query table; a refused read is thrown, mapped (`monitoring.ts`). */
  public async getTableStats(_options?: { schema?: string }): Promise<TableStats[]> {
    const rows = await this.surface(() => this.readCatalog(TABLE_STATS_SQL, []));
    return rows.map(tableStatsRow);
  }

  public async getIndexStats(_options?: { schema?: string }): Promise<IndexStats[]> {
    this.connected();
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.connected();
    return [];
  }
}
