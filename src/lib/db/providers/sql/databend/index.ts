/**
 * Databend provider (design 2): self-hosted Databend and Databend Cloud over the HTTP query API, one statement per
 * request, every statement in a session of its own.
 *
 * COMPOSITION AND DELEGATION ONLY (design 2.2). The connection rules live in `connection-options.ts`, the I/O loop in
 * `http-transport.ts` and the pure modules it calls, the statement guard in `sql-text.ts`, the cell decoding in
 * `decode.ts`, the object surface in `objects.ts`, monitoring in `introspect.ts`, the labels in `labels.ts`, the
 * session sentences in `session.ts` and every failure's category and sentence in `errors.ts`. What stays here is the
 * lifecycle, the `getCapabilities()` literal, each statement's permit, deadline and run, and the mapping of a
 * `DatabendError` onto the house classes at this boundary (`toDatabaseError`). It names no request, page, header or
 * `system.` table: `seam-guard.test.ts` fails the build if it starts to.
 *
 * It extends `SQLBaseProvider` for the inherited `prepareQuery`: `LIMIT n OFFSET m` is native, so the shared limiter's
 * clauses run as written under the Databend grammar row, and no `prepareQuery` is overridden.
 *
 * One limiter covers every statement (design 2.3, 3.12) [X04]: a run, the connect probe and its cautions, the tree,
 * describe, source and monitoring each hold one permit of the engine key `databend` for the statement's whole loop,
 * two per provider and two per engine, so with three sockets a kill always has one. The kill, final, ROLLBACK and
 * logout a statement sends run inside that statement and never wait for a permit. A permit wait counts inside the
 * statement's deadline, and a deadline or a cancel that ends the wait sends nothing [X16].
 *
 * A user statement runs under its run in `createRunRegistry()` with the connection's query timeout, so `cancelQuery`
 * reaches it by id; every provider statement runs under the surface deadline. The registry answers a cancel as soon as
 * it aborts a run, before Databend has said anything, so `cancelQuery` waits for the run to end and answers true only
 * when it ended `cancelled` [X02]. Every deadline is the injected `deadline(ms)` of the transport deps, so no test
 * waits on a real timer. `disconnect()` aborts every statement, waiting or running, and the transport's close then
 * kills each running one under its own 5 s [X31].
 *
 * The constructor never dials or throws, so a census can build the provider unconnected; every refusal of the
 * connection comes from `connect()`, before any socket.
 */
import { QueryError } from "@/lib/db/errors";
import {
  assertContainerPathShape,
  assertObjectPathShape,
  type ContainerPathShapeEngine,
  findKind,
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
import {
  createRunRegistry,
  engineLimiter,
  LimiterFullError,
  type LimiterTicket,
  type ProviderLimiter,
  type RunRegistry,
} from "@/lib/db/utils/bounded-limiter";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";
import { SQLBaseProvider } from "../sql-base";
import { DATABEND_ANSWER_SENTENCES } from "./answer";
import { databendCloudHostWarehouse, isDatabendCloudHost } from "./cloud-host";
import {
  buildDatabendConnectionOptions,
  DATABEND_DEFAULT_PORT,
  DATABEND_LIMITER_OPTIONS,
  type DatabendConnectionOptions,
} from "./connection-options";
import { decodeOutcome } from "./decode";
import { type DatabendFailureContext, toDatabaseError, unsentStopError } from "./errors";
import { createDatabendHttpTransport, DATABEND_WARNING_LIMIT, type DatabendHttpTransportDeps } from "./http-transport";
import {
  DATABEND_MONITORING_SENTENCES,
  getActiveSessions as readActiveSessions,
  getHealth as readHealth,
  getIndexStats as readIndexStats,
  getOverview as readOverview,
  getPerformanceMetrics as readPerformanceMetrics,
  getSlowQueries as readSlowQueries,
  getStorageStats as readStorageStats,
  getTableStats as readTableStats,
  killSession,
} from "./introspect";
import { DATABEND_KILL_SPEC, DATABEND_LABELS } from "./labels";
import {
  countObjects as countContainerObjects,
  DATABEND_DEFAULT_CATALOG,
  DATABEND_OBJECT_SENTENCES,
  DATABEND_SURFACE_ROW_CUT,
  DATABEND_VERSION_SQL,
  type DatabendContainer,
  type DatabendStatementRunner,
  describeObject as describeOneObject,
  describeObjects as describeContainerObjects,
  listCatalogs,
  listDatabases,
  listObjects as listContainerObjects,
  readNoPasswordCaution,
  readObjectSource as readOneObjectSource,
} from "./objects";
import {
  globalSettingsChangedWarning,
  ROLE_NOT_CARRIED,
  SETTINGS_NOT_CARRIED,
  TEMP_TABLES_DROPPED,
  TRANSACTION_ENDED,
  TRANSACTION_MAY_STAY_OPEN,
  USE_NOT_CARRIED,
} from "./session";
import { databendStatementRefusal } from "./sql-text";
import {
  type DatabendCloseStep,
  DatabendError,
  type DatabendNotice,
  type DatabendTransport,
  type DatabendTruncation,
  type StatementOrigin,
  type StatementOutcome,
} from "./transport";

const DATABEND = "databend";

const databendLimiter = engineLimiter(DATABEND, DATABEND_LIMITER_OPTIONS);

/** The steps a `close-failed`, `close-refused` or `close-skipped` notice names, as a sentence says them. */
const CLOSE_STEPS: Readonly<Record<DatabendCloseStep, string>> = {
  final: "close the finished statement (final)",
  rollback: "roll back the transaction it left open",
  logout: "end its session (logout)",
};

/** Every sentence this file shows, so the provider doc can quote them and a test read them back. */
export const DATABEND_PROVIDER_SENTENCES = Object.freeze({
  params: "Databend's HTTP API takes no bound parameters from Studio; write the value in the statement.",
  resultCut: (cut: DatabendTruncation) =>
    `The result reached Studio's statement budget of ${DATABEND_OBJECT_SENTENCES.bound(cut)}, so only the rows before it are shown.`,
  closeFailed: (step: keyof typeof CLOSE_STEPS) =>
    `The statement finished, but Studio's request to ${CLOSE_STEPS[step]} got no answer within 5 seconds.`,
  closeRefused: (step: keyof typeof CLOSE_STEPS) =>
    `The statement finished, but Studio's request to ${CLOSE_STEPS[step]} was answered with an error.`,
  closeSkipped: (step: keyof typeof CLOSE_STEPS) =>
    `The statement finished, but Databend then refused the sign-in, so Studio did not send its request to ${CLOSE_STEPS[step]}, or any further request for this statement.`,
  warningsLeftOut: (count: number) =>
    `Studio shows the first ${DATABEND_WARNING_LIMIT} different warnings of this statement and left out the ${count} more that Databend sent past them, repeats included.`,
  databaseMissing: (database: string) =>
    `Database "${database}" is not in the default catalog's databases, so unqualified names will not resolve: check Database, or leave it empty.`,
  unverifiedTls:
    "This connection does not check Databend's TLS certificate (SSL mode require), so an active man in the middle can read the password every request sends. Choose a verify mode with the server's CA under SSL / TLS.",
  slotsBusy: (seconds: string) =>
    `Studio's Databend statement slots stayed busy for ${seconds} seconds, so nothing was sent. Try again when a running statement finishes.`,
  maintenanceRefused: (operation: string) =>
    `Databend has no "${operation}" operation in Studio: the only one it runs is stopping a session's current statement (kill).`,
});

/**
 * The closes a stopped run may still send, each under its own close timeout: the kill, then the ROLLBACK and the
 * logout of the end-open (design 3.4). A cancel waits no longer than these for the run to end.
 */
const CLOSES_AFTER_STOP = 3;

/** Below the last container level nothing nests: an answer, not a refusal. */
const CONTAINER_DEPTH = 2;

/** The database a session opens in when Database is blank, the one the tree marks as the session's own. */
const DEFAULT_DATABASE = "default";

/** The two databases every catalog generates, which the database list leaves out and no caution names. */
const GENERATED_DATABASES: ReadonlySet<string> = new Set(["system", "information_schema"]);

/** A leading statement word that changes what the object tree shows (design 2.4). */
const SCHEMA_REFRESH_PATTERN = "^\\s*(CREATE|DROP|ALTER|RENAME|UNDROP|TRUNCATE|REPLACE)\\b";

/** How `assertContainerPathShape` and `assertObjectPathShape` name this engine in a refusal. */
const DATABEND_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: DATABEND,
  label: "A Databend",
  shapeNames: "label",
};
const OBJECT_ENGINE = { code: DATABEND, label: "A Databend", attachedSegment: "required" } as const;

/** One relation kind of design 2.4: columns and source, no row or source writes. */
function relationKind(id: string, label: string, labelPlural: string) {
  return {
    id,
    role: "relation",
    label,
    labelPlural,
    hasSource: true,
    sourceLanguage: "sql",
    hasColumns: true,
  } as const;
}

/** A notice of the transport as the warning a person reads, in the sentences of `session.ts` and `answer.ts` (I18). */
function noticeWarning(notice: DatabendNotice): QueryWarning {
  switch (notice.kind) {
    case "use-not-carried":
      return { message: USE_NOT_CARRIED };
    case "settings-not-carried":
      return { message: SETTINGS_NOT_CARRIED };
    case "global-settings-changed":
      return { message: globalSettingsChangedWarning(notice.keys) };
    case "role-not-carried":
      return { message: ROLE_NOT_CARRIED };
    case "transaction-ended":
      return { message: TRANSACTION_ENDED };
    case "transaction-may-stay-open":
      return { message: TRANSACTION_MAY_STAY_OPEN };
    case "temp-tables-dropped":
      return { message: TEMP_TABLES_DROPPED };
    case "close-failed":
      return { message: DATABEND_PROVIDER_SENTENCES.closeFailed(notice.step) };
    case "close-refused":
      return { message: DATABEND_PROVIDER_SENTENCES.closeRefused(notice.step) };
    case "close-skipped":
      return { message: DATABEND_PROVIDER_SENTENCES.closeSkipped(notice.step) };
    case "result-mode":
      return { message: DATABEND_ANSWER_SENTENCES.resultMode(notice.mode) };
    case "server-warning":
      return { message: notice.text };
    case "warnings-left-out":
      return { message: DATABEND_PROVIDER_SENTENCES.warningsLeftOut(notice.count) };
  }
}

/**
 * One completed user statement as the grid's result. The rows are `decode.ts`'s, a DML count row kept as Trino keeps
 * it (I18); a cut at the statement budget is reported on `pagination.wasLimited`, which the query route carries, and
 * as a warning.
 */
function toQueryResult(outcome: StatementOutcome, sql: string, executionTime: number): QueryResult {
  const decoded = decodeOutcome(outcome, sql);
  const warnings = outcome.notices.map(noticeWarning);
  if (outcome.truncated !== null) warnings.push({ message: DATABEND_PROVIDER_SENTENCES.resultCut(outcome.truncated) });
  return {
    fields: decoded.fields,
    rows: decoded.rows,
    rowCount: decoded.rowCount,
    executionTime,
    ...(decoded.fields.length === 0 ? {} : { columnTypes: decoded.columnTypes }),
    // Absent, never empty, when the run gave no notice.
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(outcome.truncated === null
      ? {}
      : {
          pagination: {
            limit: MAX_UNLIMITED_ROWS,
            offset: 0,
            hasMore: false,
            totalReturned: decoded.rows.length,
            wasLimited: true,
          },
        }),
  };
}

/**
 * Whether a request on this connection can resume, and bill, a Databend Cloud warehouse (design 2.4): it names a
 * Warehouse, or its host is Databend Cloud's, whose older form reaches the warehouse it names with Warehouse empty
 * (section 4.4). Read from the raw connection, so an unconnected provider answers it; the dialog writes "" for a blank
 * box, and under a tunnel the server is the far end, never the local forward.
 */
function resumesBilledCompute(config: DatabaseConnection & WithTunnelFarEnd): boolean {
  const warehouse: unknown = config.warehouse;
  const host: unknown = config[TUNNEL_FAR_END]?.host ?? config.host;
  return (typeof warehouse === "string" && warehouse !== "") || (typeof host === "string" && isDatabendCloudHost(host));
}

/** Which of Studio's own stops ended a permit wait: the deadline carries a `TimeoutError` reason. */
function isDeadline(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "TimeoutError";
}

/** A connected provider's transport, what it was opened with, and the signal `disconnect()` aborts. */
interface DatabendSession {
  readonly options: DatabendConnectionOptions;
  readonly transport: DatabendTransport;
  readonly lifetime: AbortController;
}

export class DatabendProvider extends SQLBaseProvider {
  private session: DatabendSession | null = null;
  private cautions: QueryWarning[] = [];
  private readonly limiter: ProviderLimiter = databendLimiter();
  private readonly runs: RunRegistry = createRunRegistry();
  /** Each registered run's end, by its `queryId`: whether it ended `cancelled`, and how long its closes may take. */
  private readonly runEnds = new Map<string, { readonly cancelled: Promise<boolean>; readonly closesMs: number }>();
  private readonly deadline: (ms: number) => AbortSignal;

  /** Validates nothing and opens nothing: the connection's rules run in `connect()`, before any socket. */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly deps: Partial<DatabendHttpTransportDeps> = {},
  ) {
    super(config, options);
    this.deadline = deps.deadline ?? ((ms) => AbortSignal.timeout(ms));
  }

  // ==========================================================================
  // Declarations (design 2.4)
  // ==========================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      // Plain EXPLAIN, never ANALYZE, and a declined screen for the shapes that execute while binding (design 5.6).
      supportsExplain: true,
      explainFormat: "databend-text",
      // `LIMIT n OFFSET m` is native, so the inherited `prepareQuery` runs as written.
      supportsExternalQueryLimiting: true,
      supportsResultPagination: true,
      supportsCreateTable: false,
      // Databend declares no key, so an edit has no row identity.
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      // Each statement runs in its own session; end-open rolls back what one leaves open (design 5.8).
      supportsTransactions: false,
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: ["kill"],
      maintenanceOperationSpecs: { kill: DATABEND_KILL_SPEC },
      // An address is split by the Host box's own reader and a DSN by Paste URL (design 6.2), never a connection string.
      supportsConnectionString: false,
      defaultPort: DATABEND_DEFAULT_PORT,
      // Every name in backticks, so a mixed-case or reserved name is never bare (design 5.1); no terminator is set.
      identifierQuoting: "backtick-always",
      schemaRefreshPattern: SCHEMA_REFRESH_PATTERN,
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
      containerPathShapes: "exact",
      objectKinds: [
        relationKind("table", "Table", "Tables"),
        relationKind("view", "View", "Views"),
        relationKind("materialized_view", "Materialized View", "Materialized Views"),
        relationKind("dynamic_table", "Dynamic Table", "Dynamic Tables"),
      ],
      // A Databend Cloud warehouse resumes, and bills, on any request; self-hosted without one keeps its pulse.
      ...(resumesBilledCompute(this.config) ? { resumesBilledCompute: true as const } : {}),
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...DATABEND_LABELS };
  }

  // ==========================================================================
  // Lifecycle (design 5.4, 6.4)
  // ==========================================================================

  /**
   * The connection's options, then the version probe under the surface deadline, then the best-effort cautions. A
   * failure closes the transport it opened and is worded by `errors.ts`; the probe's own deadline on a named warehouse
   * is the resuming sentence [X07].
   */
  public async connect(): Promise<void> {
    let session: DatabendSession | undefined;
    try {
      const built = buildDatabendConnectionOptions(this.config as DatabaseConnection & WithTunnelFarEnd, {
        queryTimeout: this.queryTimeout,
      });
      // The sentences name the warehouse an older Databend Cloud host carries as they name a Warehouse (section 4.4);
      // the header is the Warehouse field's alone, already set when the options were built.
      const options = { ...built, warehouse: built.warehouse ?? databendCloudHostWarehouse(built.endpoint.host) };
      session = {
        options,
        transport: createDatabendHttpTransport(options, this.deps),
        lifetime: new AbortController(),
      };
      await this.runner(session).run(DATABEND_VERSION_SQL, DATABEND_SURFACE_ROW_CUT);
      this.cautions = await this.readCautions(session);
    } catch (error) {
      await session?.transport.close();
      // Only the probe throws once the session exists: the cautions are best effort.
      const failure =
        session === undefined ? error : this.failure(error, this.surfaceContext(session.options, DATABEND_VERSION_SQL));
      this.setError(failure as Error);
      throw failure;
    }
    const previous = this.session;
    this.session = session;
    // A second connect replaces the session; the first one's statements are stopped, not left running.
    if (previous !== null) {
      previous.lifetime.abort();
      await previous.transport.close();
    }
    this.setConnected(true);
  }

  /** The cautions of design 6.4, each best effort: a read that fails is no caution, never a failed connect. */
  private async readCautions(session: DatabendSession): Promise<QueryWarning[]> {
    const { run } = this.runner(session);
    const { database, user, tls, hasPassword } = session.options;
    const cautions: string[] = [];
    if (database !== undefined && (await this.databaseMissing(run, database))) {
      cautions.push(DATABEND_PROVIDER_SENTENCES.databaseMissing(database));
    }
    const noPassword = await readNoPasswordCaution(run, user);
    if (noPassword !== null) cautions.push(noPassword);
    if (tls !== null && !tls.rejectUnauthorized && hasPassword)
      cautions.push(DATABEND_PROVIDER_SENTENCES.unverifiedTls);
    return cautions.map((message) => ({ message }));
  }

  private async databaseMissing(run: DatabendStatementRunner, database: string): Promise<boolean> {
    if (GENERATED_DATABASES.has(database)) return false;
    try {
      const databases = await listDatabases(run, DATABEND_DEFAULT_CATALOG);
      return !databases.some((container) => container.name === database);
    } catch {
      return false;
    }
  }

  public connectWarnings(): QueryWarning[] {
    return this.cautions.map((caution) => ({ ...caution }));
  }

  /** Aborts every statement, waiting or running; the transport's close kills each running one [X31]. */
  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.cautions = [];
    this.setConnected(false);
    if (session === null) return;
    session.lifetime.abort();
    await session.transport.close();
  }

  private requireSession(): DatabendSession {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session as DatabendSession;
  }

  // ==========================================================================
  // Statements (design 2.3)
  // ==========================================================================

  /** What `errors.ts` needs to word a failure of one statement. */
  private context(
    options: DatabendConnectionOptions,
    origin: StatementOrigin,
    sql: string,
    timeoutMs: number,
  ): DatabendFailureContext {
    return {
      request: "post",
      origin,
      sql,
      warehouse: options.warehouse,
      endpoint: options.endpoint,
      timeoutMs,
      secretForms: options.secretForms,
    };
  }

  private surfaceContext(options: DatabendConnectionOptions, sql: string): DatabendFailureContext {
    return this.context(options, "provider", sql, options.surfaceTimeoutMs);
  }

  /** A `DatabendError` as its house class; anything else is already one, or a refusal of the limiter or registry. */
  private failure(error: unknown, context: DatabendFailureContext): unknown {
    return error instanceof DatabendError ? toDatabaseError(error, context) : error;
  }

  /**
   * One statement under one permit, held for its whole loop. A wait the deadline or a cancel ends sends nothing, and
   * a full queue refuses at once; both raise before any request.
   */
  private async statement(
    session: DatabendSession,
    sql: string,
    origin: StatementOrigin,
    rowCut: number,
    signal: AbortSignal,
  ): Promise<StatementOutcome> {
    const statementSignal = AbortSignal.any([signal, session.lifetime.signal]);
    let ticket: LimiterTicket;
    try {
      ticket = await this.limiter.acquire(statementSignal);
    } catch (error) {
      if (error instanceof LimiterFullError) throw error;
      const context = this.context(
        session.options,
        origin,
        sql,
        origin === "user" ? session.options.callTimeoutMs : session.options.surfaceTimeoutMs,
      );
      // Nothing was sent, so neither the warehouse nor the statement is to blame for the wait, and no statement timed
      // out: the slots were not available in time, `unavailable` as a resuming warehouse is, so a route shows this.
      if (!isDeadline(statementSignal.reason)) throw unsentStopError("cancel", context);
      throw new DatabendError("unavailable", DATABEND_PROVIDER_SENTENCES.slotsBusy(String(context.timeoutMs / 1000)));
    }
    try {
      return await session.transport.run({ sql, origin, rowCut, signal: statementSignal });
    } finally {
      ticket.release();
    }
  }

  /**
   * The runner `objects.ts` and `introspect.ts` read through: each statement a provider statement under the surface
   * deadline. It throws the raw `DatabendError`, whose code a monitoring panel reads, so `last` names the statement
   * the surface's failure is worded with.
   */
  private runner(session: DatabendSession): { readonly run: DatabendStatementRunner; readonly last: () => string } {
    let last = "";
    return {
      run: (sql, rowCut) => {
        last = sql;
        return this.statement(session, sql, "provider", rowCut, this.deadline(session.options.surfaceTimeoutMs));
      },
      last: () => last,
    };
  }

  /** One surface call over the runner, its failure worded at this boundary. */
  private async surface<T>(read: (run: DatabendStatementRunner) => Promise<T>): Promise<T> {
    const session = this.requireSession();
    const runner = this.runner(session);
    try {
      return await read(runner.run);
    } catch (error) {
      throw this.failure(error, this.surfaceContext(session.options, runner.last()));
    }
  }

  /**
   * One statement, as the editor sends it: bound parameters and a text the guard refuses never reach a socket
   * (design 5.3). The run is registered under `queryId` with the query timeout, so `cancelQuery` reaches it, and its
   * end is kept beside it until it ends, so `cancelQuery` can read whether it ended `cancelled`.
   */
  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) {
      throw new QueryError(DATABEND_PROVIDER_SENTENCES.params, this.type, sql);
    }
    const session = this.requireSession();
    const refusal = databendStatementRefusal(sql);
    if (refusal !== null) throw new QueryError(refusal, this.type, sql);
    const { options } = session;
    const handle = this.runs.begin(queryId, this.deadline(options.callTimeoutMs));
    const ended = Promise.withResolvers<boolean>();
    const runEnd = { cancelled: ended.promise, closesMs: CLOSES_AFTER_STOP * options.closeTimeoutMs };
    if (queryId !== undefined) this.runEnds.set(queryId, runEnd);
    let cancelled = false;
    try {
      const { result, executionTime } = await this.trackQuery(() =>
        this.measureExecution(() => this.statement(session, sql, "user", MAX_UNLIMITED_ROWS, handle.signal)),
      );
      return toQueryResult(result, sql, executionTime);
    } catch (error) {
      cancelled = error instanceof DatabendError && error.category === "cancelled";
      throw this.failure(error, this.context(options, "user", sql, options.callTimeoutMs));
    } finally {
      handle.end();
      // Only this run's own entry: once it ended, the same id may name a newer run.
      if (queryId !== undefined && this.runEnds.get(queryId) === runEnd) this.runEnds.delete(queryId);
      ended.resolve(cancelled);
    }
  }

  /**
   * Stops a running or waiting run by its id, and answers true only once the run ended `cancelled`: Databend
   * acknowledged its kill or reported 1043, or nothing had been sent [X02]. A kill that got no answer, one Databend
   * refused, and a statement that finished first each answer false, which the editor shows as a cancel not confirmed.
   * The wait is bounded by the closes the run may still send, so a cancel never waits longer than the run can close.
   * An unknown id answers false and sends nothing.
   */
  public async cancelQuery(queryId: string): Promise<boolean> {
    const runEnd = this.runEnds.get(queryId);
    if (runEnd === undefined || !this.runs.cancel(queryId)) return false;
    const expiry = this.deadline(runEnd.closesMs);
    const expired = Promise.withResolvers<boolean>();
    const expire = () => expired.resolve(false);
    expiry.addEventListener("abort", expire, { once: true });
    try {
      return await Promise.race([runEnd.cancelled, expired.promise]);
    } finally {
      expiry.removeEventListener("abort", expire);
    }
  }

  // ==========================================================================
  // Object surface (design 5.4), answered by objects.ts
  // ==========================================================================

  private container(container: readonly string[]): DatabendContainer {
    assertContainerPathShape(this.getCapabilities(), container, DATABEND_CONTAINER_PATH_ENGINE);
    return { catalog: container[0], database: container[1] };
  }

  /** The container and name of an object path, its kind declared and its shape `[catalog, database, name]`. */
  private object(path: readonly string[], kind: string): { container: DatabendContainer; name: string } {
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) throw new QueryError(DATABEND_OBJECT_SENTENCES.unknownKind(kind), this.type);
    assertObjectPathShape(capabilities, spec, kind, path, OBJECT_ENGINE);
    return { container: { catalog: path[0], database: path[1] }, name: path[2] };
  }

  /**
   * Every catalog, one catalog's databases, or nothing below a database. The session's own database is marked in the
   * default catalog, the one a session opens in.
   */
  public async listContainers(parent: readonly string[] = []): Promise<Container[]> {
    if (parent.length >= CONTAINER_DEPTH) {
      this.ensureConnected();
      return [];
    }
    const database = this.requireSession().options.database ?? DEFAULT_DATABASE;
    if (parent.length === 0) return this.surface((run) => listCatalogs(run));
    const [catalog] = parent;
    return this.surface((run) =>
      listDatabases(run, catalog, catalog === DATABEND_DEFAULT_CATALOG ? database : undefined),
    );
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    const address = this.container(container);
    const { secretForms } = this.requireSession().options;
    return this.surface((run) => countContainerObjects(run, address, secretForms));
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const address = this.container(container);
    return this.surface((run) => listContainerObjects(run, address, kind));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const { container, name } = this.object(path, kind);
    return this.surface((run) => describeOneObject(run, container, kind, name));
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    const address = this.container(container);
    return this.surface((run) => describeContainerObjects(run, address, kind, limit));
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    const { container, name } = this.object(path, kind);
    const { secretForms } = this.requireSession().options;
    return this.surface((run) => readOneObjectSource(run, container, kind, name, secretForms, limit));
  }

  // ==========================================================================
  // Monitoring (design 5.5), answered by introspect.ts
  // ==========================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    return this.surface((run) => readOverview(run));
  }

  /** Nothing is measured, so each figure is absent, never 0 [12 #18]. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return readPerformanceMetrics();
  }

  public async getSlowQueries(options: { limit?: number } = {}): Promise<SlowQueryStats[]> {
    return this.surface((run) => readSlowQueries(run, options));
  }

  public async getActiveSessions(options: { limit?: number } = {}): Promise<ActiveSessionDetails[]> {
    return this.surface((run) => readActiveSessions(run, options));
  }

  public async getTableStats(options: { schema?: string } = {}): Promise<TableStats[]> {
    return this.surface((run) => readTableStats(run, options));
  }

  public async getIndexStats(options: { schema?: string } = {}): Promise<IndexStats[]> {
    return this.surface((run) => readIndexStats(run, options));
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    return this.surface((run) => readStorageStats(run));
  }

  public async getHealth(): Promise<HealthInfo> {
    return this.surface((run) => readHealth(run));
  }

  /** `kill` only [X08]: `KILL QUERY` on a session id from the Sessions panel; every other operation sends nothing. */
  public async runMaintenance(type: MaintenanceOperation, target?: string): Promise<MaintenanceResult> {
    if (type !== "kill") throw new QueryError(DATABEND_PROVIDER_SENTENCES.maintenanceRefused(type), this.type);
    const pid = target ?? "";
    const { executionTime } = await this.measureExecution(() => this.surface((run) => killSession(run, pid)));
    return { success: true, executionTime, message: DATABEND_MONITORING_SENTENCES.killAsked(pid) };
  }
}
