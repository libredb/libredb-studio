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
 * - M6 no `queryTimeout` and no `cancelQuery`, and a transaction statement bounded by closing its
 *   session instead (`boundByClose`, `driver.ts`); M7 a duplicate column kept, under a numbered name
 *   (`values.ts`); a lost LOB edit named, and kept out of the preview (K24, `values.ts`);
 * - a driver failure classified by its `driverCode` (K17, `driver.ts`);
 * - TLS that fails closed, and a tunnel that is never dialled around (`connection.ts`).
 *
 * One shared client per provider, no pool: four concurrent queries on one client were measured
 * correct, and a pool would multiply the cleartext-password exposure of a connection that opted
 * out of TLS. An interactive transaction opens a second client, its session, for its own life, so
 * that nothing else this provider sends runs inside it; COMMIT and ROLLBACK close it. So does each
 * agent statement under the read-only profile (`queryReadOnly`, `agent-read.ts`).
 *
 * Absent on purpose: `endOpenQueryTransaction` (`query()` autocommits on the shared client),
 * `cancelQuery` (the driver's `Client.cancel()` and server-side `queryTimeout` need monitoring and
 * cancel privileges and are a change of their own, D392), and the object-edit pair.
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
  ProviderExecutionContext,
  ProviderLabels,
  ProviderOptions,
  QueryPrepareOptions,
  QueryResult,
  ReadOnlyStatementBudget,
  ReadOnlyStatementMode,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "../../../types";
import {
  ConnectionError,
  DatabaseConfigError,
  ExecutionProfileError,
  NO_ACTIVE_TRANSACTION,
  QueryError,
} from "../../../errors";
import { analyzeQuery, assertRowBounds, DEFAULT_QUERY_LIMIT, MAX_UNLIMITED_ROWS } from "../../../utils/query-limiter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { assertReadOnlyBudget, TIME_BUDGET_PREFIX } from "../read-only-budget";
import { SQLBaseProvider } from "../sql-base";
import {
  assertAgentColumnTypes,
  boundAgentStatement,
  describeAgentStatement,
  readAgentAnswer,
  verifyAgentPrincipal,
} from "./agent-read";
import { db2Capabilities, db2Labels } from "./capabilities";
import { CODE_PAGE_SQL, decodeCatalogRow } from "./catalog";
import {
  type CaFileSystem,
  type Db2Connection,
  NODE_CA_FILE_SYSTEM,
  type OpenedClient,
  openClient,
  resolveTarget,
} from "./connection";
import {
  type Db2Client,
  type Db2Driver,
  type Db2Transaction,
  boundByClose,
  loadDb2Driver,
  mapDb2Error,
} from "./driver";
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

/** An interactive transaction: the client it holds for its own life, and its unit of work there. */
interface Db2Session extends OpenedClient {
  transaction: Db2Transaction;
}

/** What a statement past the deadline means to the transaction it ran in. */
const TRANSACTION_ENDED =
  "That ends this transaction: Db2 rolls back everything it did once the connection closes. Begin a new transaction to continue.";

/** What a statement past the deadline means to the agent call it ran in. */
const AGENT_CALL_ENDED = "Db2 rolls back the call's unit of work once the connection closes.";

/** The refusal a BEGIN gets when the provider was disconnected while it opened its session. */
const DISCONNECTED_WHILE_OPENING =
  "The connection was closed while this transaction was opening, so it was not opened. Begin it again.";

export class Db2Provider extends SQLBaseProvider {
  private client: Db2Client | null = null;
  /** The open transaction, or null. */
  private session: Db2Session | null = null;
  /** True while `beginTransaction()` opens a session, so a second BEGIN is refused before it opens another. */
  private opening = false;
  /** Raised by every `disconnect()`, so a BEGIN that was opening across one knows its session is stale. */
  private generation = 0;
  private caDir: string | undefined;
  private codePageValue: number | undefined;
  private readonly loadDriver: () => Promise<Db2Driver>;
  private readonly caFileSystem: CaFileSystem;

  /**
   * Whether this provider was opened to send an agent's statements: under an execution profile (`readOnly`) whose
   * acquisition calls `queryReadOnly` (`sendsStatements`). Only then does `queryReadOnly` answer, and only after the
   * user is proved on the statement's own connection (`verifyAgentPrincipal` in `agent-read.ts`). The operations
   * profile sends no statement, so plan mode keeps grounding on a connection whose user is privileged.
   */
  private readonly readOnlyProfile: boolean;

  /** The object surface's way to the catalog: decoded rows, and the code page they need. */
  private readonly reader: objects.CatalogReader = {
    read: (sql, params) => this.readCatalog(sql, params),
    codePage: () => this.codePage(),
  };

  constructor(
    config: Db2Connection,
    options: ProviderOptions = {},
    execution: ProviderExecutionContext = {},
    seams: Db2ProviderSeams = {},
  ) {
    super(config, options);
    this.readOnlyProfile = execution.readOnly === true && execution.sendsStatements === true;
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

  /**
   * Closes the client and removes the CA file, whichever of the two fails. An open transaction's
   * session is closed too, without waiting, and Db2 rolls back what the transaction did.
   */
  public async disconnect(): Promise<void> {
    this.generation += 1;
    if (this.session !== null) this.retireSession(this.session);
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
   * One agent statement under the read-only profile.
   *
   * The boundary is the agent user's: it holds CONNECT and SELECT, and the check proves it reaches nothing that writes
   * or runs code with another's authority (`agent-read.ts`). Each call opens a connection of its own with the profile's
   * user, as `beginTransaction()` opens a session, never the shared client: a session keeps its special registers
   * (`CURRENT SCHEMA`, `CURRENT PATH`) and its declared temporary tables across statements (measured), and the shared
   * client is the editor's. On it the call begins a unit of work, runs the check, keeping no verdict between calls, so
   * a grant or a control added after one call refuses the next and a lifted refusal admits it, describes the statement
   * without fetching a row, refusing a LOB or XML column, then sends it in a derived table bounded at one row past the
   * row budget (`boundAgentStatement`), rolls the unit of work back and closes the connection, on every path. A
   * statement that derived table cannot be proved to hold whole is refused before the connection opens.
   *
   * The deadline is the statement budget, over the whole call: past it the wait ends with the shared time refusal and
   * the connection is closed without waiting (`boundByClose`), which ends the wait, not the work. Db2 rolls the unit of
   * work back when the connection closes. No server-side cancel is sent, so the user needs no WLM privilege.
   *
   * Refused outside the profile: a provider opened without it has no proven user to run agent semantics on.
   */
  public async queryReadOnly(
    sql: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    this.connected();
    if (!this.readOnlyProfile) {
      throw new QueryError(
        "Read-only execution requires a provider opened under the agent read-only profile",
        "db2",
        sql,
      );
    }
    assertReadOnlyBudget(budget, "db2");
    if (mode !== "execute") throw new QueryError("Db2 composes no estimating plan for the agent", "db2", sql);
    // Both refuse, before any connection opens, a statement the derived table cannot be proved to hold whole.
    const describe = describeAgentStatement(sql);
    const bounded = boundAgentStatement(sql, budget.maxResultRows);

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(() =>
        this.withAgentSession(sql, budget, async (transaction) => {
          await this.verifyAgentPrincipalOn(transaction);
          try {
            const described = await transaction.query(describe, undefined, { rowMode: "array" });
            assertAgentColumnTypes(described.columns, sql);
            return await transaction.query(bounded, undefined, { rowMode: "array" });
          } catch (error) {
            if (error instanceof QueryError) throw error;
            throw mapDb2Error(error, sql);
          }
        }),
      );
      return readAgentAnswer({ ...readResult(result, sql), executionTime }, budget, sql);
    });
  }

  /** The check of the agent user, on the call's own connection, before the statement. */
  private async verifyAgentPrincipalOn(transaction: Db2Transaction): Promise<void> {
    try {
      await verifyAgentPrincipal(async (check) => (await transaction.query(check, undefined)).rows);
    } catch (error) {
      if (error instanceof ExecutionProfileError) throw error;
      // The environment's failure, not the statement's: the agent must not offer it to the model as one to repair.
      throw new ConnectionError(
        `The agent read-only execution profile's check of the Db2 user could not be read: ${mapDb2Error(error).message}`,
        "db2",
      );
    }
  }

  /**
   * Runs `work` in a unit of work on a connection opened for it alone, under the budget's deadline, then rolls it back
   * and closes the connection. Past the deadline the connection is retired instead, without waiting, and the call
   * answers the time refusal.
   */
  private async withAgentSession<T>(
    sql: string,
    budget: ReadOnlyStatementBudget,
    work: (transaction: Db2Transaction) => Promise<T>,
  ): Promise<T> {
    const opened = await openClient(this.config, this.loadDriver, this.caFileSystem);
    let transaction: Db2Transaction | undefined;
    let retired = false;
    try {
      return await boundByClose(
        (async () => {
          transaction = await opened.client.beginTransaction();
          return work(transaction);
        })(),
        budget.statementTimeoutMs,
        () => {
          retired = true;
          this.retireSession(opened);
        },
        sql,
        AGENT_CALL_ENDED,
      );
    } catch (error) {
      if (retired) {
        throw new QueryError(`${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`, "db2", sql);
      }
      throw error;
    } finally {
      if (!retired) {
        // A rollback that fails leaves the unit of work to the close, which rolls it back all the same.
        await transaction?.rollback().catch(() => {});
        await this.closeSession(opened).catch((error: unknown) => {
          console.warn(`[Db2] Closing an agent call's connection failed: ${(error as Error).message}`);
        });
      }
    }
  }

  // ============================================================================
  // Transactions
  // ============================================================================

  /**
   * Opens the transaction's session: a client of its own, connected as the shared one is, with
   * autocommit off. A refused BEGIN closes that client again, and so does a disconnect that ran
   * while the session was opening: the transaction is refused rather than left on a provider that
   * no longer holds it.
   */
  public async beginTransaction(): Promise<void> {
    this.ensureConnected();
    if (this.session !== null || this.opening) throw new QueryError("Transaction already active", "db2");
    this.opening = true;
    const generation = this.generation;
    try {
      const opened = await openClient(this.config, this.loadDriver, this.caFileSystem);
      let transaction: Db2Transaction;
      try {
        transaction = await opened.client.beginTransaction();
      } catch (error) {
        this.retireSession(opened);
        throw mapDb2Error(error);
      }
      if (this.generation !== generation) {
        this.retireSession(opened);
        throw new QueryError(DISCONNECTED_WHILE_OPENING, "db2");
      }
      this.session = { ...opened, transaction };
    } finally {
      this.opening = false;
    }
  }

  public async commitTransaction(): Promise<void> {
    await this.endTransaction("COMMIT", (transaction) => transaction.commit());
  }

  public async rollbackTransaction(): Promise<void> {
    await this.endTransaction("ROLLBACK", (transaction) => transaction.rollback());
  }

  public isInTransaction(): boolean {
    return this.session !== null;
  }

  /**
   * One statement inside the transaction, read as `query()` reads one. It is bounded by the
   * connection's query timeout: at the deadline the wait ends and the session is retired, which
   * ends the transaction (`boundByClose`).
   */
  public async queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult> {
    const session = this.heldSession();
    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const statement = session.transaction.query(sql, normaliseParams(params), { rowMode: "array" });
          return await boundByClose(
            statement,
            this.queryTimeout,
            () => this.retireSession(session),
            sql,
            TRANSACTION_ENDED,
          );
        } catch (error) {
          throw mapDb2Error(error, sql);
        }
      });
      return { ...readResult(result, sql), executionTime };
    });
  }

  /** The open transaction's session, or the refusal every engine gives without one. */
  private heldSession(): Db2Session {
    if (this.session === null) throw new QueryError(NO_ACTIVE_TRANSACTION, "db2");
    return this.session;
  }

  /**
   * COMMIT or ROLLBACK, then the session closed whichever way the statement went. The session is
   * forgotten first, so a statement sent meanwhile is refused rather than run on a closing one.
   */
  private async endTransaction(word: string, end: (transaction: Db2Transaction) => Promise<void>): Promise<void> {
    const session = this.heldSession();
    this.session = null;
    try {
      await end(session.transaction);
    } catch (error) {
      throw mapDb2Error(error, word);
    } finally {
      await this.closeSession(session);
    }
  }

  /**
   * Forgets a session and closes it without waiting: a close returns only once the statement
   * running on it has ended (`boundByClose`). A failed close has no caller left to answer, so it
   * is logged.
   */
  private retireSession(session: OpenedClient): void {
    if (this.session === session) this.session = null;
    void this.closeSession(session).catch((error: unknown) => {
      console.warn(`[Db2] Closing a transaction's connection failed: ${(error as Error).message}`);
    });
  }

  /** Closes a session's client and removes its CA file, whichever of the two fails. */
  private async closeSession(session: OpenedClient): Promise<void> {
    try {
      await session.client.close();
    } catch (error) {
      throw mapDb2Error(error);
    } finally {
      if (session.caDir !== undefined) await this.caFileSystem.rm(session.caDir, { recursive: true, force: true });
    }
  }

  /**
   * The row bound as `FETCH FIRST n ROWS ONLY`, or `OFFSET m ROWS FETCH NEXT n ROWS ONLY` past
   * the first page, between the statement and its trailing trivia, as Oracle's provider places it.
   * A statement whose end cannot be found is returned untouched rather than bounded on a guess.
   */
  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    assertRowBounds(effectiveLimit, offset, this.type);
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
