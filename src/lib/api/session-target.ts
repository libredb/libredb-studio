/**
 * What a caller facade of the provider host core runs its calls on: a session target (`SessionTarget`), the session,
 * the environment every call of it is given, its statement timeout and the run marks of the cache entry it lives in.
 *
 * Every builder of a legacy provider's session target lives here, the object tree's (`providerTreeTarget`), the object
 * source's (`providerSourceTarget`), the monitoring and health reads' (`providerMonitoringTarget`), the maintenance
 * calls' (`providerMaintenanceTarget`) and the console's, of the cancel, the editor's statements and the transaction
 * calls (`providerConsoleTarget`), so this is the one module of the caller facades that builds a bridged session for
 * them (`bridgedConsole` and `bridgedMaintenance` in
 * src/lib/provider-host/legacy-bridge.ts), and every builder of a target from a cache entry of the provider factory, by
 * the entry's form, so no facade and no route forks on who serves an engine. This module value-imports no provider
 * factory module (src/lib/db/factory.ts), so the VS Code backend, which is handed the factory's functions and imports
 * none of them, builds its targets here too; the builders that open through the factory live in
 * src/lib/api/editor-provider.ts and call these.
 * A provider package's entry's maintenance opening is built here too (`packageMaintenanceOpening`); a legacy
 * provider's reads the factory's declarations.
 *
 * A target's marks count a call on its cache entry while the call runs, so the factory's idle sweep keeps the entry: a
 * provider package's session is marked from `started` until the call answered, or until the call a stop answered has
 * settled, a statement and a unit of a script inside a transaction among its calls; a legacy provider's target marks
 * nothing, since its provider reports its own runs in flight (`hasRunsInFlight`), as it did before targets.
 *
 * A console target also states how a statement and a unit of a script inside a transaction run on its session
 * (`StatementForm`, `ScriptUnitForm`): through the legacy bridge for a legacy provider, on the session itself for a
 * provider package's, so `runEditorQuery`, the transaction calls and the script inside a transaction run on a target and
 * none of them forks on who serves the engine.
 *
 * A caller that answers a provider package's failure by its record (`packageFailureAnswer` in ./package-errors), the
 * object routes and MCP's `inspect_schema`, answers so only what the package's own tree or source read raised: it
 * reads its target through `recordingRaised`, which names each raised value by the read of the member that raised it,
 * and asks of each failure whether the session raised it (`raisedByTreeRead` for MCP, `raisedCall` in ./object-route
 * for the object routes, which answer it as the read that raised it), so a failure Studio raised after the open is
 * answered as Studio's own, never as the package's.
 */
import {
  BATCH_MAX_BYTES,
  type CallContext,
  type Column,
  type EngineMaintenance,
  type EnvReader,
  type ExecuteAnswer,
  envReader,
  PAGE_MAX_BYTES,
  type PageBound,
  type PumpLimits,
} from "@libredb/provider-sdk/calls";
import type { Calls, MaintenanceSpec } from "@libredb/provider-sdk/manifest";
import { encodeValue } from "@libredb/provider-sdk/values";
import {
  type EditorQueryAnswer,
  type EditorQueryRun,
  editorPageBody,
  packagePageBody,
  pageBound,
  statementTimeout,
} from "@/lib/api/editor-query";
import type { CachedSession } from "@/lib/db/factory";
import { StudioByteBudgetRefusal } from "@/lib/db/errors";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { EngineConnection } from "@/lib/db/server-catalog";
import {
  DEFAULT_QUERY_TIMEOUT,
  type DatabaseProvider,
  isTransactionProvider,
  type MaintenanceDeclaration,
  type MaintenanceOperation,
  type MaintenanceOperationSpec,
  type ObjectReadOptions,
  type ProviderCapabilities,
} from "@/lib/db/types";
import type { ConsoleSession, PageRecord, StoppedRecord } from "@/lib/provider-host/core/console";
import type { MaintenanceSession } from "@/lib/provider-host/core/maintenance";
import type { HealthSession, MonitoringSession } from "@/lib/provider-host/core/monitoring";
import type { ObjectsSession } from "@/lib/provider-host/core/objects";
import { HostDefectError } from "@/lib/provider-host/access";
import {
  bridgedConsole,
  bridgedMaintenance,
  bridgedTransactionScriptUnit,
  type TransactionScriptUnitOpen,
} from "@/lib/provider-host/legacy-bridge";
import type { OpenedPackageSession } from "@/lib/provider-host/open-engine";
import type { DatabaseType, QueryResult } from "@/lib/types";

/**
 * How a call on a target ended, as its marks read it: an execute's page among the answers; undefined for a call that
 * threw, which has settled.
 */
export type CallEnd =
  | { readonly kind: "answered" | "refused" | "page" }
  | Pick<StoppedRecord, "kind" | "settled">
  | undefined;

/** A session a caller facade runs its calls on, and what each call of it is given. */
export interface SessionTarget<Session> {
  readonly session: Session;
  /** The environment every call's context carries: none for a legacy provider, the declared one for a package's. */
  readonly env: EnvReader;
  /**
   * The statement timeout a call's deadline is taken from, the connection's own or Studio's default, read when a call
   * takes its deadline from it; a facade whose caller holds a deadline of its own reads none.
   */
  timeout(): number;
  /** Marks a call as running on the target's cache entry, before the call. */
  started(): void;
  /** Ends the mark `started` set, once the call ended as `record` and, for a stopped call, once it has settled. */
  ended(record: CallEnd): void;
}

/** A session target of the object tree's reads (src/lib/api/object-tree.ts). */
export interface TreeTarget extends SessionTarget<ObjectsSession> {
  /**
   * The legacy type of a connection that reaches every database on its server, whose provider declares catalog
   * sessions, which a walk over every container must not read (`assertNotWholeServer` in src/lib/db/catalog-scope.ts);
   * null for every other connection, a provider package's among them, whose record offers no catalog session. Read
   * when asked, so only a walk over every container reads a provider's capabilities for it.
   */
  wholeServer(): DatabaseType | null;
}

/** The maintenance a session's server accepts, in the form Studio's maintenance checks and its clients read. */
export type AcceptedMaintenance = Pick<
  ProviderCapabilities,
  "supportsMaintenance" | "maintenanceOperations" | "maintenanceOperationSpecs"
>;

/** A session target of the monitoring and health reads (src/lib/api/provider-monitoring.ts). */
export interface MonitoringTarget extends SessionTarget<MonitoringSession & HealthSession> {
  /**
   * The maintenance the session's server accepts, read when asked: the monitoring route answers it beside the
   * dashboard's panels, since the connection metadata route never connects and answers only the declaration.
   */
  accepted(): AcceptedMaintenance;
}

/** A session target of the maintenance calls (src/lib/api/provider-maintenance.ts). */
export interface MaintenanceTarget extends SessionTarget<Omit<MaintenanceSession, "maintenance">> {
  /**
   * The session's maintenance, read when a call is made: a legacy provider's is its declaration narrowed by what the
   * connected provider accepts (`bridgedMaintenance`), which the SDK refuses as `CallRefusalError` for a narrowing its
   * declaration cannot have, so a run answers that refusal as not sent, after the route admitted it; a provider
   * package's is the maintenance its open narrowed, which its open already checked.
   */
  maintenance(): EngineMaintenance;
  /**
   * The engine principal the session acts as, read when asked: a user name, never any part of a secret, which the
   * maintenance audit names (docs/providers/CONTRACT.md, clause C-67); undefined where the session names none.
   */
  engineUser(): string | undefined;
}

/** What a maintenance request opened: the maintenance its server accepts, and the target its call is made on. */
export interface MaintenanceOpening {
  /** The maintenance the opened session's server accepts, read when asked: the route's accepted and placement checks. */
  accepted(): AcceptedMaintenance;
  /**
   * The target the request's call is made on, built when asked, after those checks passed: a legacy provider's reads
   * its declarations first, so a refused request reads none.
   */
  target(): Promise<MaintenanceTarget>;
}

/**
 * What a statement's run form reads of the request: its page options, core's scrub of its connection, and the route a
 * provider package's warnings are logged under.
 */
export type StatementRun = Pick<EditorQueryRun, "options" | "scrub" | "route">;

/**
 * How one statement runs on a console target: the session its execute is sent to, the page it asks for, the pump's
 * limits, whether the run's cancel was sent, and the answer body of the page a record holds, which releases the record.
 */
export interface StatementForm {
  readonly session: ConsoleSession;
  readonly page: PageBound;
  readonly pumpLimits: (answer: ExecuteAnswer) => PumpLimits;
  readonly cancelSent: () => boolean;
  readonly body: (record: PageRecord) => EditorQueryAnswer;
}

/**
 * How one unit of a script inside a transaction runs on a console target: its session, the pump's limits, and the
 * unit's result read from the page its execute answered; the caller releases the record.
 */
export interface ScriptUnitForm {
  readonly session: ConsoleSession;
  readonly pumpLimits: (answer: ExecuteAnswer) => PumpLimits;
  /** @throws {StudioByteBudgetRefusal} For a provider package's page the host cut by bytes. */
  readonly answered: (record: PageRecord) => QueryResult;
}

/**
 * A session target of the console's calls: the cancel (`cancelEditorRun` in src/lib/api/editor-query.ts), the editor's
 * statement (`runEditorQuery`), and the transaction calls and the script inside a transaction
 * (src/lib/api/editor-transaction.ts, `openTransactionScript` in src/lib/api/editor-script.ts).
 */
export interface ConsoleTarget extends SessionTarget<ConsoleSession> {
  /** How the statement `run` names runs on the target, built when asked, once per statement. */
  statement(run: StatementRun): StatementForm;
  /** How the unit `open` names, of a script inside a transaction, runs on the target, built when asked, once per unit. */
  transactionScriptUnit(open: TransactionScriptUnitOpen): ScriptUnitForm;
  /** The plan the target's session supports, read when asked: whether it explains a statement, and in which format. */
  explainSupport(): Pick<ProviderCapabilities, "supportsExplain" | "explainFormat">;
}

/** A legacy provider reads no declared environment, so its calls get a reader of none. */
const NO_ENVIRONMENT = envReader([], () => undefined);

/** The marks of a target that counts nothing: a legacy provider's. */
const NO_MARKS = Object.freeze({ started: () => undefined, ended: () => undefined });

/**
 * The marks of a call on `entry`: `running` counts the call from its start until it ended, or, when a stop ended it,
 * until the call it stopped waiting for has settled, so the idle sweep never closes a session under a call in flight;
 * `lastUsed` is the time the call ended.
 */
function entryMarks(entry: CachedSession): Pick<SessionTarget<unknown>, "started" | "ended"> {
  return {
    started: () => {
      entry.running += 1;
    },
    ended: (record) => {
      entry.lastUsed = Date.now();
      if (record?.kind === "stopped") {
        void record.settled.then(() => {
          entry.running -= 1;
        });
      } else {
        entry.running -= 1;
      }
    },
  };
}

/**
 * The target of `provider`: one bridged session of it, built when this is called, which reads the provider's
 * capabilities once for its object model, before any host core is read; no environment, no marks, and, when asked,
 * the provider's statement timeout. `objectReads` is handed to the bridge as it is.
 */
function providerTarget(provider: DatabaseProvider, objectReads: ObjectReadOptions): SessionTarget<ObjectsSession> {
  return { session: bridgedConsole(provider, {}, objectReads).session, ...providerFields(provider) };
}

/**
 * The tree target of `provider`: its target (`providerTarget`) and, when asked, the provider's type as `wholeServer`
 * where its capabilities declare catalog sessions.
 * `objectReads` is handed to the bridge as it is: the agent's billed-read allowance, where the walk has one.
 */
export function providerTreeTarget(provider: DatabaseProvider, objectReads: ObjectReadOptions = {}): TreeTarget {
  return {
    ...providerTarget(provider, objectReads),
    wholeServer: () => (provider.getCapabilities().catalogSessions === true ? provider.type : null),
  };
}

/**
 * What every target of `provider` holds beside its session: no environment, the provider's statement timeout read when
 * asked, and no marks.
 */
function providerFields(provider: DatabaseProvider): Omit<SessionTarget<unknown>, "session"> {
  return { env: NO_ENVIRONMENT, timeout: () => statementTimeout(provider), ...NO_MARKS };
}

/**
 * The monitoring target of `provider`: one bridged session of it, built when this is called, whose panels are its
 * engine's and whose health is the provider's; no environment, no marks, and, when asked, the provider's statement
 * timeout and its capabilities as the maintenance it accepts.
 */
export function providerMonitoringTarget(provider: DatabaseProvider): MonitoringTarget {
  return {
    session: bridgedConsole(provider, {}).session,
    accepted: () => provider.getCapabilities(),
    ...providerFields(provider),
  };
}

/**
 * The maintenance target of `provider`: one bridged session of it, built when this is called, as
 * `providerMonitoringTarget` builds it, its maintenance read when a call reads it, `declared`, the provider's
 * maintenance before it connected, narrowed by what the connected provider accepts at that call (`bridgedMaintenance`),
 * and its engine user the provider's, read when asked.
 */
export function providerMaintenanceTarget(
  provider: DatabaseProvider,
  declared: MaintenanceDeclaration,
): MaintenanceTarget {
  return {
    session: bridgedConsole(provider, {}).session,
    maintenance: () => bridgedMaintenance(provider, declared),
    engineUser: () => provider.engineUser?.(),
    ...providerFields(provider),
  };
}

/**
 * The console target of `provider`: one bridged session of it, built when this is called, whose `console.cancel` is
 * offered exactly where the provider can cancel and `console.transaction` exactly where it holds a transaction session;
 * no environment, no marks, and, when asked, the provider's statement timeout and its capabilities as the plan it
 * supports.
 *
 * Each statement runs on a bridged session of its own, built with the run's page options (`bridgedConsole`): it asks
 * the page as the request bounds it, the bridge adding the probe row in its prepare, with the bridge's pump limits and
 * cancel, and its body is built from the legacy result (`editorPageBody`). Each unit of a script inside a transaction
 * runs on the bridge's transaction script unit session (`bridgedTransactionScriptUnit`, clause C-50) where the provider
 * holds a transaction session, and otherwise on its bridged console session, whose calls do not offer
 * `console.transaction`, so the host core refuses the unit's request before the call, not-sent, as it refuses that
 * request for every session that does not offer it.
 */
export function providerConsoleTarget(provider: DatabaseProvider): ConsoleTarget {
  return {
    session: bridgedConsole(provider, {}).session,
    ...providerFields(provider),
    statement: (run) => {
      const bridged = bridgedConsole(provider, run.options);
      return {
        session: bridged.session,
        page: pageBound(run.options),
        pumpLimits: bridged.pumpLimits,
        cancelSent: () => bridged.run.cancelSent,
        body: (record) => editorPageBody(record, bridged.answered, run.scrub),
      };
    },
    transactionScriptUnit: (open) => {
      if (isTransactionProvider(provider)) return bridgedTransactionScriptUnit(provider, open);
      const bridged = bridgedConsole(provider, {});
      return { session: bridged.session, pumpLimits: bridged.pumpLimits, answered: () => bridged.answered().result };
    },
    explainSupport: () => provider.getCapabilities(),
  };
}

/**
 * The page a statement on a provider package's session asks for, and its pump's limits: one row past the page
 * (#1440), whether or not the package applies the page, so a next page is known to exist; the host pumps the first
 * result within that row count and the page's 32 MiB, and the first result's columns are kept from the answer the pump
 * reads, since a page record carries none. The body is `packagePageBody`'s (src/lib/api/editor-query.ts): the page's
 * rows as records keyed by their column names, each cell in the value codec's wire form, a next page offered only
 * where the session honours `offset`, and the warnings by how the entry's engine record grants the package its own
 * words.
 */
function packageStatement(entry: CachedSession, session: ConsoleSession, run: StatementRun): StatementForm {
  const limit = run.options.limit ?? DEFAULT_QUERY_LIMIT;
  const offset = run.options.offset ?? 0;
  let columns: readonly Column[] = [];
  return {
    session,
    page: { limit: limit + 1, offset },
    pumpLimits: (answer) => {
      columns = answer.results[0]?.columns ?? [];
      return { maxRows: limit + 1, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES };
    },
    cancelSent: () => false,
    body: (record) => {
      const honoursOffset = session.calls.console.execute.honours.includes("offset");
      const { ownWords } = entry.engine.grants;
      return packagePageBody(record, columns, { limit, offset, honoursOffset }, ownWords, run.scrub, run.route);
    },
  };
}

/** Studio's sentence for a unit of a script inside a transaction whose page the host cut by bytes. */
const UNIT_OVER_PAGE_SENTENCE = `The unit's result is more than the ${PAGE_MAX_BYTES} bytes one page of a result may hold, and a script's answer has no field to say where a page ends, so Studio answers none of its rows.`;

/**
 * A unit of a script inside a transaction on a provider package's session: the session itself, whose unit's rows exist
 * only in its page, so the pump takes every row of a unit but the last, and the request's page for the last
 * (`lastUnitOptions`), no row past it, since a script's answer carries no pagination. Its result is the page's rows as
 * records keyed by their column names, each cell in the value codec's wire form, its fields, the declared types of the
 * columns that state one, the package's own row count where the page holds every row and the package stated one, and
 * the rows answered otherwise, and the package's execution time; it carries no warnings, which the transaction route's
 * answer does not read. A page the host cut by bytes is `StudioByteBudgetRefusal`, outcome unknown, since the
 * statement ran, naming none of its rows: never a shorter result. The unit's text is the facade's request; the form
 * reads nothing else of `open`.
 */
function packageScriptUnit(session: ConsoleSession, open: TransactionScriptUnitOpen): ScriptUnitForm {
  const page = open.lastUnitOptions === undefined ? undefined : pageBound(open.lastUnitOptions);
  const maxRows = page === undefined || "unlimited" in page ? Number.MAX_SAFE_INTEGER : page.limit;
  let columns: readonly Column[] = [];
  return {
    session,
    pumpLimits: (answer) => {
      columns = answer.results[0]?.columns ?? [];
      return { maxRows, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES };
    },
    answered: (record) => {
      if (record.page.end === "byte-limit") throw new StudioByteBudgetRefusal(UNIT_OVER_PAGE_SENTENCE);
      const fields = columns.map((column) => column.name);
      const rows = record.page.rows.map((row) =>
        Object.fromEntries(fields.map((field, index) => [field, encodeValue(row[index])])),
      );
      const typed = columns.filter((column) => typeof column.type === "string");
      return {
        rows,
        fields,
        ...(typed.length > 0 && {
          columnTypes: Object.fromEntries(typed.map((column) => [column.name, column.type as string])),
        }),
        rowCount: record.page.end === "done" && record.rowCount !== undefined ? record.rowCount : rows.length,
        executionTime: record.executionTimeMs,
      };
    },
  };
}

/** The plan a provider package's session supports: none, since the provider contract has no plan call. */
const NO_PLAN = Object.freeze({ supportsExplain: false });

/**
 * The console target of `entry`, an entry of the provider factory's caches for `connection`, by its form: a legacy
 * provider's through `providerConsoleTarget`; a provider package's session with its declared environment, the
 * connection's own statement timeout or Studio's default, the marks of each call on the entry, its statements and the
 * units of a script inside a transaction on the session itself (`packageStatement`, `packageScriptUnit`), and no plan.
 */
export function entryConsoleTarget(entry: CachedSession, connection: EngineConnection): ConsoleTarget {
  const { opened } = entry;
  if (opened.form === "provider") return providerConsoleTarget(opened.provider);
  const { session } = opened;
  return {
    session,
    env: opened.env,
    timeout: () => connection.queryTimeout ?? DEFAULT_QUERY_TIMEOUT,
    ...entryMarks(entry),
    statement: (run) => packageStatement(entry, session, run),
    transactionScriptUnit: (open) => packageScriptUnit(session, open),
    explainSupport: () => NO_PLAN,
  };
}

/**
 * `call`, one host core call on `target`'s session, counted on the target's entry from its start until it ended
 * (`started`, `ended`), `undefined` for a call that threw; its record, or its error as the same object.
 */
export async function markedCall<Record extends CallEnd>(
  target: Pick<SessionTarget<unknown>, "started" | "ended">,
  call: () => Promise<Record>,
): Promise<Record> {
  target.started();
  let record: Record | undefined;
  try {
    record = await call();
    return record;
  } finally {
    target.ended(record);
  }
}

/**
 * The source target of `provider` (src/lib/api/object-source.ts): its target (`providerTarget`), whose session offers
 * `objects.source` exactly where the provider defines `readObjectSource`.
 */
export function providerSourceTarget(provider: DatabaseProvider): SessionTarget<ObjectsSession> {
  return providerTarget(provider, {});
}

/**
 * The tree target of `entry`, an entry of the provider factory's caches for `connection`, by its form: a legacy
 * provider's through `providerTreeTarget`; a provider package's session with its declared environment, the
 * connection's own statement timeout or Studio's default, no whole server, and the marks of each read on the entry.
 */
export function entryTreeTarget(entry: CachedSession, connection: EngineConnection): TreeTarget {
  const { opened } = entry;
  if (opened.form === "provider") return providerTreeTarget(opened.provider);
  return { ...packageTarget(entry, opened.session, opened.env, connection), wholeServer: () => null };
}

/**
 * The source target of `entry`, an entry of the provider factory's caches for `connection`, by its form: a legacy
 * provider's through `providerSourceTarget`, whose session offers `objects.source` exactly where the provider defines
 * `readObjectSource`; a provider package's session with its declared environment, the connection's own statement
 * timeout or Studio's default, and the marks of each read on the entry.
 */
export function entrySourceTarget(entry: CachedSession, connection: EngineConnection): SessionTarget<ObjectsSession> {
  const { opened } = entry;
  if (opened.form === "provider") return providerSourceTarget(opened.provider);
  return packageTarget(entry, opened.session, opened.env, connection);
}

/**
 * The target of a provider package's `session` held by `entry`, the one the tree, source, monitoring and maintenance
 * targets of an entry build on (`entryTreeTarget`, `entrySourceTarget`, `entryMonitoringTarget`,
 * `packageMaintenanceOpening`): its declared environment `env`, the connection's own statement timeout or Studio's
 * default, and the marks of each call on the entry.
 */
function packageTarget<Session>(
  entry: CachedSession,
  session: Session,
  env: EnvReader,
  connection: EngineConnection,
): SessionTarget<Session> {
  return { session, env, timeout: () => connection.queryTimeout ?? DEFAULT_QUERY_TIMEOUT, ...entryMarks(entry) };
}

/**
 * `spec`, one spec of a session's maintenance in the SDK's form, in Studio's form: the card fields `title`,
 * `description`, `confirmation` and `kinds` present only where the spec states them, and `preview` only where it is
 * true, the inverse of the bridge's `declaredSpec` (src/lib/provider-host/legacy-bridge.ts).
 */
function studioSpec(spec: MaintenanceSpec): MaintenanceOperationSpec {
  return {
    label: spec.label,
    perEntity: spec.perEntity,
    global: spec.global,
    ...(spec.title === null ? {} : { title: spec.title }),
    ...(spec.description === null ? {} : { description: spec.description }),
    ...(spec.confirmation === null ? {} : { confirmation: spec.confirmation }),
    ...(spec.preview ? { preview: true as const } : {}),
    ...(spec.kinds === null ? {} : { kinds: [...spec.kinds] }),
  };
}

/** A read of an object facet a raised value is named by: the read of the session's member that raised it. */
export type ObjectRead = "tree read" | "source read";

/**
 * `target` with each function its session holds, the tree read where the session offers `objects.tree` and the source
 * read where it offers `objects.source`, recording in `raised` each value it threw or rejected with by the read of the
 * member that raised it, passed on as the same value, so a caller answers by the record only what the session's own
 * calls raised, and the object routes as the read that raised it. The session handed on holds exactly the members
 * `target`'s session holds, so a function is present exactly where the session offers its call, as `ObjectsSession`
 * states.
 */
export function recordingRaised<Target extends SessionTarget<ObjectsSession>>(
  target: Target,
  raised: Map<unknown, ObjectRead>,
): Target {
  const { session } = target;
  const { tree, source } = session;
  const recorded =
    <Request, Answer>(call: (request: Request, ctx: CallContext) => Promise<Answer>, read: ObjectRead) =>
    async (request: Request, ctx: CallContext): Promise<Answer> => {
      try {
        return await call.call(session, request, ctx);
      } catch (error) {
        raised.set(error, read);
        throw error;
      }
    };
  return {
    ...target,
    session: {
      calls: session.calls,
      ...(session.objectModel === undefined ? {} : { objectModel: session.objectModel }),
      ...(tree === undefined ? {} : { tree: recorded(tree, "tree read") }),
      ...(source === undefined ? {} : { source: recorded(source, "source read") }),
    },
  };
}

/**
 * The maintenance `session`, a provider package's, accepts, in Studio's form: its narrowed maintenance where it offers
 * `maintenance.run`, and none where it does not, since no control may be offered for a run its session cannot make.
 */
function acceptedOf(session: { readonly calls: Calls; readonly maintenance: EngineMaintenance }): AcceptedMaintenance {
  if (session.calls.maintenance.run !== "offered") {
    return Object.freeze({ supportsMaintenance: false, maintenanceOperations: [], maintenanceOperationSpecs: {} });
  }
  const { maintenance, maintenanceSpecs } = session.maintenance;
  const specs: Partial<Record<MaintenanceOperation, MaintenanceOperationSpec>> = {};
  for (const spec of maintenanceSpecs) specs[spec.operation] = studioSpec(spec);
  return Object.freeze({
    supportsMaintenance: maintenance.length > 0,
    maintenanceOperations: [...maintenance],
    maintenanceOperationSpecs: specs,
  });
}

/**
 * The monitoring target of `entry`, an entry of the provider factory's caches for `connection`, by its form: a legacy
 * provider's through `providerMonitoringTarget`; a provider package's session with its declared environment, the
 * connection's own statement timeout or Studio's default, the marks of each read on the entry, and the session's
 * narrowed maintenance as the maintenance it accepts (`acceptedOf`).
 */
export function entryMonitoringTarget(entry: CachedSession, connection: EngineConnection): MonitoringTarget {
  const { opened } = entry;
  if (opened.form === "provider") return providerMonitoringTarget(opened.provider);
  const { session } = opened;
  return { ...packageTarget(entry, session, opened.env, connection), accepted: () => acceptedOf(session) };
}

/**
 * Whether `error`, a failure of a tree or source read on a target `recordingRaised` read, is the session's own: a value
 * one of the session's functions raised, or a host defect, whose refusals name whose defect it is (`REFUSAL_AUTHOR` in
 * ./package-errors), such as a tree answer the host core refused. Any other failure is Studio's own.
 */
export function raisedByTreeRead(raised: ReadonlyMap<unknown, ObjectRead>, error: unknown): boolean {
  return raised.has(error) || error instanceof HostDefectError;
}

/**
 * The maintenance opening of `entry`, an entry of the provider factory's caches for `connection` holding `opened`, a
 * provider package's session: the maintenance it accepts is the session's narrowed maintenance (`acceptedOf`), and its
 * target is the session with its declared environment, the connection's own statement timeout or Studio's default,
 * the marks of each call on the entry, the session's narrowed maintenance, and the engine user its open answered. A
 * legacy provider's opening reads the factory's declarations, so it is built where the factory is imported
 * (`editorMaintenanceOpening` in src/lib/api/editor-provider.ts).
 */
export function packageMaintenanceOpening(
  entry: CachedSession,
  opened: OpenedPackageSession,
  connection: EngineConnection,
): MaintenanceOpening {
  const { session } = opened;
  return {
    accepted: () => acceptedOf(session),
    target: async () => ({
      ...packageTarget(entry, session, opened.env, connection),
      maintenance: () => session.maintenance,
      engineUser: () => opened.engineUser,
    }),
  };
}
