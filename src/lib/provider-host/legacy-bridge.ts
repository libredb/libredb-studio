/**
 * The legacy bridge (docs/providers/CONTRACT.md, clause C-50): a legacy `DatabaseProvider` served as one session of
 * console execute, cancel, endScope and transaction, so today's providers run through the host core's console calls. It lives in
 * the calling bundle, beside the accessor, and is built per call by the caller's facade (`runEditorQuery` and
 * `cancelEditorRun` in src/lib/api/editor-query.ts, the transaction calls in src/lib/api/editor-transaction.ts); the
 * bridge and the facades leave together, once every provider is a contract provider.
 *
 * Its calls are declared once: execute honours `params` and `offset` for every engine, so each provider answers both as
 * it always has, its own `OffsetUnsupportedError` included; `console.cancel` is offered exactly when the provider can
 * cancel (`supportsQueryCancel`); `console.endScope` is offered exactly when the provider ends the transactions its
 * query path left open (`endsOpenQueryTransactions`), and its `endScope` runs the provider's `endOpenQueryTransaction`
 * with the request's scope and answers its outcome; `console.transaction` is offered exactly when the provider holds a
 * transaction session (`isTransactionProvider`). The bridge is the one caller of a provider's ender: the caller that
 * minted a run's scope ends it through the host core's endScope call (clause C-60). `objects.tree` is offered on every
 * session, since every legacy provider holds the five tree members. `maintenance.run` is offered on every session,
 * since every legacy provider holds `runMaintenance`, and `maintenance.preview` exactly where the provider holds
 * `previewMaintenance`. `monitoring.panel` is offered on every session, and `monitoring.poolStats` exactly where the
 * provider holds a pool statistics read (`getPoolStats`, a function on the provider or its prototype). The session's
 * panels are its engine's `ENGINE_FACETS` row (`engineFacetsFor`), by identity, where the provider holds the member of
 * every panel the row offers, as every shipped provider does; otherwise a frozen copy of the row with each panel whose
 * member the provider does not hold, read as `getPoolStats` is, not offered, so the host core refuses a call for it as
 * `request-panel-not-offered` before the call and never calls a member that is not there. `health` is served on every
 * session, since every legacy provider holds `getHealth`.
 *
 * Its panel call runs the panel's own member with today's argument through `readPanel`, the one mapping
 * `getMonitoringData` reads through too, and answers the member's answer by reference under the panel's key. Its pool
 * statistics call answers the provider's own `getPoolStats()` by reference, a synchronous throw answered as the call's
 * rejection. Its health call runs `getHealth()` with no argument and answers its health by reference, a synchronous
 * throw answered as the call's rejection. None calls `forCatalog`, and each passes a provider's error by reference. The
 * facade that reads them is `providerMonitoring` in src/lib/api/provider-monitoring.ts.
 *
 * Its maintenance run calls `runMaintenance` with exactly three arguments, the request's operation, target and
 * container, `undefined` for an absent one, and its preview calls `previewMaintenance` with the operation and a fresh
 * copy of the frozen request's path, so a legacy member may write what it receives. Each answers the provider's answer
 * by reference, never calls `forCatalog`, and passes a provider's error by reference.
 *
 * The session's maintenance is `bridgedMaintenance`'s answer, which the caller lays beside the session: the provider's
 * maintenance as declared before it connects, in the engine declaration's form, narrowed through the SDK's own
 * `sessionMaintenance` by a refinement the bridge answers from the connected provider's capabilities. The refinement
 * names, for each declared operation with a spec, the placements both the declaration and the connected provider say
 * true, both false when the connected provider no longer lists the operation, and only where that differs from the
 * declaration, so it never names an operation the declaration does not list and never widens it
 * (tests/unit/provider-sdk/call-surface-parity.test.ts holds it to `narrowMaintenance` for every shipped spec).
 *
 * Its tree call runs the provider's own member for the action with today's arguments: `listContainers` with one
 * argument, the parent or `undefined` at the top level, `countObjects`, `listObjects`, `describeObject`, and
 * `describeObjects` with the limit, and `{ defaultSql: true }` as a fourth argument only when the request sends it.
 * Each path is a fresh copy of the frozen request's array, so a legacy member may write what it receives. It answers
 * the member's answer by reference in its action's form (`{ containers }`, `{ counts }`, `{ objects }`, `{ detail }`,
 * or the batch itself) and never calls `forCatalog`. A provider's error passes by reference. A top-level `containers`
 * read of a provider holding `inventoryNeedsConfiguration` (a function on the provider or its prototype) asks it
 * first, and a reason answers `{ containers: [], needsConfiguration }` without listing (clause C-61). The session's
 * third input, `objectReads`, is the host-side input a tree request does not carry: a session built with a billed-read
 * allowance hands a fresh `{ readAllowance }` as the trailing argument of `countObjects`, `listObjects` and
 * `describeObjects`, and one built without passes today's arguments. The facades that read it are `objectTree` and
 * `grantedObjectTree` in src/lib/api/object-tree.ts.
 *
 * Its transaction call runs the provider's own method for the action: `beginTransaction` with `requireReportedState`
 * as the transaction route has always passed it, answering `stateReported` exactly when the provider answered a result,
 * `commitTransaction`, `rollbackTransaction`, or nothing for `state`. Every answer's session state is the provider's
 * `isInTransaction()` read after the call, so it is `in-transaction` or `not-in-transaction` and never a state the
 * bridge kept. A statement sent with `transaction` runs `prepareQuery`, the probe and `queryInTransaction` with the
 * probe's text and a new array of the request's params, with no run id, no scope and no ender, since it runs on the
 * transaction's own connection, and answers the state read after it. A provider's error passes by reference.
 *
 * Its execute runs today's provider steps: `prepareQuery` on a fresh copy of the caller's own options object (the
 * request's resolved page is the contract's view; the options are what a legacy provider has always received), the
 * probe row past the page (`probePastPage`), `query` with the probe's text, a new array of the request's params, the
 * run id only for a provider that cancels, and the request's scope, absent when the request carries none, and
 * `noteAppendedBound` on a failure; it ends nothing itself. It keeps the prepared query and the legacy result on `run`,
 * the facade's per-call record, beside whether its cancel was sent, and answers one source per result set, the main
 * rows first.
 *
 * A source reads each legacy row positionally under the result's `fields`, in the form the page budget measures: its
 * value codec form, or, when the codec refuses a cell (`undefined`, a class instance, a `Map`), the JSON form the
 * answer writes for that row, `undefined` as `null`. It sizes that array with the measure of the pull that asks for it,
 * `limit.measure`, and answers that same array, so the pump takes the size its measure recorded and each row is
 * encoded once. Which cells the codec refuses is found before encoding, so no `ValueCodecError` is thrown per row;
 * every error measuring throws passes by reference. This is how a row is measured, not how it is answered: the facade
 * answers the legacy rows themselves, by the page's count. A key a row holds outside `fields` is answered and not
 * measured.
 *
 * `pumpLimits` sets the page's row limit once execute answered: the probe limit, one past the page, when the provider
 * applied the page, otherwise every row the provider returned, at least one, so a result the limiter did not bound
 * answers every row as before, bounded by bytes alone.
 *
 * The console session is no read-only statement session (`readOnlyStatements` false): it serves the editor's and the
 * operations profile's sessions, none of which is sent read-only statements. A provider's read-only statement path is
 * served by `bridgedReadOnlyStatements`, a session of its own built per call by its facade, `runReadOnlyExecute` in
 * src/lib/api/read-only-execute.ts (clause C-78). Its open refuses a provider without `queryReadOnly` by name, before
 * anything is called, so the plain `query()` is never the fallback (clause C-39); its calls offer execute alone,
 * honouring `readOnly`; its execute runs `queryReadOnly` with the statement, a fresh budget of the open's statement
 * timeout and read allowance, by reference, and the request's rows and bytes, and the request's mode, and answers one
 * source per result set, `pageApplied` false. Its page limits read every row the provider returned, at least one,
 * within one page, and it keeps the legacy result for the facade to answer from.
 *
 * A statement Studio composed, which must reach the provider exactly as composed, is served by
 * `bridgedComposedStatements`, a session of its own built per call by `runComposedStatement` in
 * src/lib/api/composed-statement.ts: its calls offer execute alone, honouring no request field, and its execute runs
 * the plain `query` with the statement alone, never `prepareQuery` or the probe, so no page bound is appended. It
 * answers and limits its page as the read-only statement session does, through the same result record.
 *
 * Each unit of a script of `POST /api/db/multi-query` is served by `bridgedScriptUnit`, a session of its own built per
 * unit by `openEditorScript` in src/lib/api/editor-script.ts: its execute sends the unit's text as the script route
 * always sent it, every unit as written but the last, whose last read statement is bounded by `prepareQuery` and
 * spliced back unless the unit is a module body, never probed, with the run id where the provider cancels and the
 * request's scope. Its calls offer execute honouring `offset`, and cancel and endScope as the console session offers
 * them; it answers through the same result record, `pageApplied` exactly when the prepare bounded the unit.
 *
 * Each unit of a script of `POST /api/db/transaction` is served by `bridgedTransactionScriptUnit`, a session of its own
 * built per unit by `openTransactionScript` in src/lib/api/editor-script.ts: its execute takes only a statement sent
 * with `transaction`, sends the unit's text as the transaction route always sent it, every unit as written but a last
 * unit of one statement, which the provider's prepare bounds whole, never probed, through `queryInTransaction` with
 * that text alone, and answers the session state read after it. Its calls offer execute honouring `offset` and the
 * transaction facet with the console session's member; it answers through the same result record.
 */
import {
  BATCH_MAX_BYTES,
  type BatchLimit,
  type CancelAnswer,
  type CancelRequest,
  type EndScopeAnswer,
  type EndScopeRequest,
  type EngineMaintenance,
  type ExecuteAnswer,
  type ExecuteRequest,
  type HealthInfo,
  type MaintenancePreview,
  type MaintenancePreviewRequest,
  type MaintenanceRunAnswer,
  type MaintenanceRunRequest,
  type MaintenanceAccepted,
  type MonitoringPanelRequest,
  PAGE_MAX_BYTES,
  type PoolStats,
  type PumpLimits,
  type ResultSource,
  type RowBatch,
  sessionCalls,
  sessionMaintenance,
  type TransactionAnswer,
  type TransactionRequest,
  type TreeAnswer,
  type TreeContainersAnswer,
  type TreeDescribeManyRequest,
  type TreeRequest,
  type Warning,
} from "@libredb/provider-sdk/calls";
import type { SessionState } from "@libredb/provider-sdk/errors";
import type { Calls, ExecuteRequestField, MaintenanceSpec } from "@libredb/provider-sdk/manifest";
import { probePastPage } from "@/lib/api/page-probe";
import { engineFacetsFor } from "@/lib/db/engine-facets";
import { StudioProfileRefusal } from "@/lib/db/errors";
import { type PanelReads, readPanel } from "@/lib/db/engine-facets/monitoring";
import { MONITORING_PANELS, type MonitoringPanel, type MonitoringPanelOffer } from "@/lib/db/engine-facets/types";
import { type QueryCancelProvider, supportsQueryCancel } from "@/lib/db/query-cancel";
import {
  type DatabaseProvider,
  endsOpenQueryTransactions,
  isTransactionProvider,
  type MaintenanceDeclaration,
  type MaintenanceOperation,
  type MaintenanceOperationSpec,
  type ObjectReadOptions,
  type PreparedQuery,
  type ProviderCapabilities,
  type QueryPrepareOptions,
  type ReadOnlyStatementBudget,
  type TransactionProvider,
} from "@/lib/db/types";
import type { RunReadAllowance } from "@/lib/db/read-allowance";
import { isSelectQuery, noteAppendedBound } from "@/lib/db/utils/query-limiter";
import type { ConsoleSession } from "@/lib/provider-host/core/console";
import type { MaintenanceSession } from "@/lib/provider-host/core/maintenance";
import type { HealthSession, MonitoringSession } from "@/lib/provider-host/core/monitoring";
import type { ObjectsSession } from "@/lib/provider-host/core/objects";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { type ExecutionUnit, unitIsModuleBody } from "@/lib/sql/statement-splitter";
import type { DatabaseType, QueryResult, QueryWarning } from "@/lib/types";

/**
 * What one bridged execute left for the facade: the prepared query and the legacy result, and whether the session's
 * cancel was sent.
 */
export interface LegacyRun {
  prepared?: PreparedQuery;
  result?: QueryResult;
  cancelSent: boolean;
}

/** What a bridged execute that answered left: its prepared query and its legacy result. */
export interface AnsweredRun {
  readonly prepared: PreparedQuery;
  readonly result: QueryResult;
}

/**
 * A bridged session, the run its execute fills, and the page limits read from that run. The session's maintenance is
 * not the bridge's to hold: the caller lays it beside the session.
 */
export interface BridgedConsole {
  readonly session: ConsoleSession &
    ObjectsSession &
    Omit<MaintenanceSession, "maintenance"> &
    MonitoringSession &
    HealthSession;
  readonly run: LegacyRun;
  /**
   * What the execute that answered left, for the facade to answer from.
   *
   * @throws {Error} When execute has not answered, a host defect.
   */
  readonly answered: () => AnsweredRun;
  /**
   * The pump's limits for the answer execute gave.
   *
   * @throws {Error} When execute has not answered, a host defect.
   */
  readonly pumpLimits: (answer: ExecuteAnswer) => PumpLimits;
}

/** A legacy warning as the contract's `Warning`. */
function contractWarning(warning: QueryWarning): Warning {
  return {
    message: warning.message,
    ...(warning.code === undefined ? {} : { code: warning.code }),
    ...(warning.severity === undefined ? {} : { severity: warning.severity }),
  };
}

/** The value codec's integer range (docs/providers/CONTRACT.md, "Values"): a bigint outside it is refused. */
const MIN_I64 = -(BigInt(2) ** BigInt(63));
const MAX_U64 = BigInt(2) ** BigInt(64) - BigInt(1);

/**
 * Whether the value codec refuses `value`, found without encoding it, so a refused row costs no thrown
 * `ValueCodecError` (a MongoDB result read under its union of fields has an undefined cell in every document that lacks
 * a field). The codec's domain, read the way `encodeValue` reads it: strings, booleans, numbers, bigints in its integer
 * range, null, arrays without holes, `Uint8Array`s, valid `Date`s and plain objects, each array element and own
 * enumerable property in the domain too. tests/unit/lib/provider-host/legacy-bridge-measure.test.ts holds it to the
 * codec's own answer for every kind.
 */
function outsideCodec(value: unknown): boolean {
  switch (typeof value) {
    case "string":
    case "boolean":
    case "number":
      return false;
    case "bigint":
      return value < MIN_I64 || value > MAX_U64;
    case "undefined":
    case "function":
    case "symbol":
      return true;
  }
  if (value === null) return false;
  // Indexed, not `some`, which skips a hole: a hole reads as `undefined`, refused as the codec refuses the hole.
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (outsideCodec(value[index])) return true;
    }
    return false;
  }
  if (value instanceof Uint8Array) return false;
  if (value instanceof Date) return Number.isNaN(value.getTime());
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return true;
  return Object.values(value as object).some((member) => outsideCodec(member));
}

/**
 * `row` read positionally under `fields`, in its value codec form, or in its JSON form when the codec refuses a cell,
 * a bigint written as its decimal text, as a row read for a read budget is measured (`measureRowBytes` in
 * src/lib/db/read-only-budget.ts), so a bigint beside a refused cell is measured rather than failing the JSON form. The
 * form is a measure, never the answer: a facade answers the legacy rows.
 *
 * @throws Any error reading the row or writing its JSON form throws, by reference.
 */
function rowForm(fields: readonly string[], row: Readonly<Record<string, unknown>>): readonly unknown[] {
  const cells = fields.map((field) => row[field]);
  if (!outsideCodec(cells)) return cells;
  return JSON.parse(
    JSON.stringify(cells, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)),
  ) as readonly unknown[];
}

/** A result source over a legacy result set's rows, each in its measured form, sized with its pull's measure. */
function legacySource(
  fields: readonly string[],
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount?: number,
): ResultSource {
  let at = 0;
  let closed = false;
  return Object.freeze({
    columns: Object.freeze(fields.map((name) => Object.freeze({ name }))),
    ...(rowCount === undefined ? {} : { rowCount }),
    async next(limit: BatchLimit): Promise<RowBatch> {
      if (closed) throw new Error("The bridged result source was closed, so it answers no more batches.");
      const batch: (readonly unknown[])[] = [];
      let bytes = 0;
      while (at < rows.length && batch.length < limit.maxRows) {
        const row = rowForm(fields, rows[at] as Readonly<Record<string, unknown>>);
        const size = limit.measure(row);
        if (batch.length > 0 && bytes + size > limit.maxBytes) break;
        batch.push(row);
        bytes += size;
        at += 1;
        if (bytes >= limit.maxBytes) break;
      }
      return { rows: batch, done: at >= rows.length };
    },
    async close(): Promise<void> {
      closed = true;
    },
  });
}

/** The session state a legacy transaction provider reports now: its `isInTransaction()`, read once. */
function sessionStateOf(provider: TransactionProvider): SessionState {
  return provider.isInTransaction() ? "in-transaction" : "not-in-transaction";
}

/**
 * The execute answer over a legacy `result`: one source per result set, `pageApplied` whether the provider rewrote the
 * statement to apply the page.
 */
function answerOf(result: QueryResult, pageApplied: boolean): ExecuteAnswer {
  const others = (result.resultSets ?? []).slice(1).map((set) => legacySource(set.fields, set.rows));
  return {
    results: [legacySource(result.fields, result.rows, result.rowCount), ...others],
    warnings: (result.warnings ?? []).map((warning) => contractWarning(warning)),
    executionTimeMs: result.executionTime,
    pageApplied,
    ...(result.pagination?.wasLimited === true ? { boundApplied: true as const } : {}),
    ...(result.explainPlan === undefined ? {} : { explainPlan: result.explainPlan }),
  };
}

/** Runs `request`'s action on `provider` and answers the session state read after it. */
async function legacyTransaction(
  provider: TransactionProvider,
  request: TransactionRequest,
): Promise<TransactionAnswer> {
  if (request.action === "begin") {
    // `void` from a provider that reads no transaction state when it opens one: it reports nothing either way.
    const opened = await provider.beginTransaction({ requireReportedState: request.requireReportedState === true });
    return { sessionState: sessionStateOf(provider), ...(opened ? { stateReported: opened.stateReported } : {}) };
  }
  if (request.action === "commit") await provider.commitTransaction();
  if (request.action === "rollback") await provider.rollbackTransaction();
  return { sessionState: sessionStateOf(provider) };
}

/** A provider's answer to the inventory's configuration question, which only some providers declare. */
interface ConfigurationAsker {
  inventoryNeedsConfiguration(): Promise<string | undefined>;
}

/**
 * Whether `provider` asks the configuration question: `inventoryNeedsConfiguration` is a function on it or its
 * prototype.
 */
function asksConfiguration(provider: DatabaseProvider): provider is DatabaseProvider & ConfigurationAsker {
  return (
    "inventoryNeedsConfiguration" in provider &&
    typeof (provider as Partial<ConfigurationAsker>).inventoryNeedsConfiguration === "function"
  );
}

/**
 * The containers answer for `parent`: at the top level, on a provider that asks the configuration question, its reason
 * answers no container and the reason without listing; otherwise `listContainers` with one argument, by reference.
 */
async function legacyContainers(
  provider: DatabaseProvider,
  parent: readonly string[] | undefined,
): Promise<TreeContainersAnswer> {
  if (parent === undefined && asksConfiguration(provider)) {
    const needsConfiguration = await provider.inventoryNeedsConfiguration();
    if (needsConfiguration !== undefined) return { containers: [], needsConfiguration };
  }
  return { containers: await provider.listContainers(parent === undefined ? undefined : [...parent]) };
}

/**
 * Runs `request`'s action on `provider`'s own tree member with today's arguments, each path a fresh copy of the
 * request's array, and answers the member's answer by reference in its action's form. A session built with a read
 * allowance hands a fresh `{ readAllowance }` holding it by reference as the trailing argument of the count, the
 * listing and the bulk describe; a session built without one passes today's argument counts.
 */
async function legacyTree(
  provider: DatabaseProvider,
  request: TreeRequest,
  objectReads: ObjectReadOptions,
): Promise<TreeAnswer> {
  const { readAllowance } = objectReads;
  const billed = readAllowance === undefined ? undefined : { readAllowance };
  switch (request.action) {
    case "containers":
      return legacyContainers(provider, request.parent);
    case "count":
      return {
        counts: await (billed === undefined
          ? provider.countObjects([...request.container])
          : provider.countObjects([...request.container], billed)),
      };
    case "list":
      return {
        objects: await (billed === undefined
          ? provider.listObjects([...request.container], request.kind)
          : provider.listObjects([...request.container], request.kind, billed)),
      };
    case "describe":
      return { detail: await provider.describeObject([...request.path], request.kind) };
    case "describeMany":
      return legacyDescribeMany(provider, request, billed);
  }
}

/**
 * `describeObjects` with the request's limit, and a fourth argument only where the request sends `defaultSql` or the
 * session holds a read allowance: `defaultSql: true` and a fresh `readAllowance` beside it, each only where present.
 */
function legacyDescribeMany(
  provider: DatabaseProvider,
  request: TreeDescribeManyRequest,
  billed: ObjectReadOptions | undefined,
): Promise<TreeAnswer> {
  const container = [...request.container];
  if (request.defaultSql !== true && billed === undefined) {
    return provider.describeObjects(container, request.kind, request.limit);
  }
  return provider.describeObjects(container, request.kind, request.limit, {
    ...(request.defaultSql === true ? { defaultSql: true } : {}),
    ...billed,
  });
}

/** One spec of Studio's in the engine declaration's form, every member Studio leaves out written as null or false. */
function declaredSpec(operation: MaintenanceOperation, spec: MaintenanceOperationSpec): MaintenanceSpec {
  return {
    operation,
    label: spec.label,
    perEntity: spec.perEntity,
    global: spec.global,
    title: spec.title ?? null,
    description: spec.description ?? null,
    confirmation: spec.confirmation ?? null,
    preview: spec.preview === true,
    kinds: spec.kinds === undefined ? null : [...spec.kinds],
  };
}

/** Studio's maintenance declaration in the engine declaration's form: the operations in order, one spec for each that has one. */
function declarationForm(declared: MaintenanceDeclaration): EngineMaintenance {
  const specs = declared.maintenanceOperationSpecs ?? {};
  return {
    maintenance: [...declared.maintenanceOperations],
    maintenanceSpecs: declared.maintenanceOperations.flatMap((operation) => {
      const spec = specs[operation];
      return spec === undefined ? [] : [declaredSpec(operation, spec)];
    }),
  };
}

/**
 * The placements `connected`, the connected provider's capabilities, still accepts for each operation `declared` lists
 * with a spec, where they differ from the declaration: both placements the two say true, and both false for an
 * operation the connected provider no longer lists, its list read as empty when it does not support maintenance.
 */
function acceptedPlacements(declared: EngineMaintenance, connected: ProviderCapabilities): MaintenanceAccepted[] {
  const listed: readonly MaintenanceOperation[] =
    connected.supportsMaintenance === true ? connected.maintenanceOperations : [];
  const items: MaintenanceAccepted[] = [];
  for (const spec of declared.maintenanceSpecs) {
    const stillListed = listed.includes(spec.operation);
    const now = connected.maintenanceOperationSpecs?.[spec.operation];
    const perEntity = stillListed && spec.perEntity && (now?.perEntity ?? true);
    const global = stillListed && spec.global && (now?.global ?? true);
    if (stillListed && perEntity === spec.perEntity && global === spec.global) continue;
    items.push({ operation: spec.operation, perEntity, global });
  }
  return items;
}

/**
 * The maintenance of a session the bridge serves for `provider`: `declared`, the provider's maintenance before it
 * connects, in the engine declaration's form, narrowed through `sessionMaintenance` by the placements the connected
 * provider's capabilities still accept, frozen at every depth.
 */
export function bridgedMaintenance(provider: DatabaseProvider, declared: MaintenanceDeclaration): EngineMaintenance {
  const form = declarationForm(declared);
  return sessionMaintenance(form, { maintenance: acceptedPlacements(form, provider.getCapabilities()) });
}

/**
 * The provider's own `runMaintenance` with the request's operation, target and container, `undefined` for an absent
 * one, answering its result by reference.
 */
function legacyRun(provider: DatabaseProvider, request: MaintenanceRunRequest): Promise<MaintenanceRunAnswer> {
  return provider.runMaintenance(request.operation, request.target, request.container);
}

/** A provider's pool statistics read, which `DatabaseProvider` does not declare. */
interface PoolStatsReader {
  getPoolStats(): PoolStats;
}

/** Whether `provider` reads its pool statistics: `getPoolStats` is a function on it or its prototype. */
function readsPoolStats(provider: DatabaseProvider): provider is DatabaseProvider & PoolStatsReader {
  return "getPoolStats" in provider && typeof (provider as Partial<PoolStatsReader>).getPoolStats === "function";
}

/** The provider member each monitoring panel is read through, as `readPanel` calls it. */
const PANEL_MEMBER: Readonly<Record<MonitoringPanel, keyof PanelReads>> = Object.freeze({
  overview: "getOverview",
  performance: "getPerformanceMetrics",
  slowQueries: "getSlowQueries",
  activeSessions: "getActiveSessions",
  tables: "getTableStats",
  indexes: "getIndexStats",
  storage: "getStorageStats",
});

/** Whether `provider` holds the member `panel` is read through: a function on the provider or its prototype. */
function holdsPanelMember(provider: DatabaseProvider, panel: MonitoringPanel): boolean {
  const member = PANEL_MEMBER[panel];
  return member in provider && typeof (provider as Partial<PanelReads>)[member] === "function";
}

/**
 * The monitoring panels of `provider`'s session: its engine's row by identity where the provider holds the member of
 * every panel the row offers, and otherwise a frozen copy of the row with each such panel it cannot read not offered.
 */
function bridgedPanels(provider: DatabaseProvider): MonitoringPanelOffer {
  const row = engineFacetsFor(provider.type).monitoring;
  const unread = MONITORING_PANELS.filter((panel) => row[panel] === "offered" && !holdsPanelMember(provider, panel));
  if (unread.length === 0) return row;
  const panels: Record<MonitoringPanel, MonitoringPanelOffer[MonitoringPanel]> = { ...row };
  for (const panel of unread) panels[panel] = "not-offered";
  return Object.freeze(panels);
}

/**
 * `provider` served as one session of console execute, cancel and transaction, of the object tree, of maintenance and
 * of monitoring, its execute run with a copy of `options`, the caller's own page options. `objectReads` is the
 * host-side input a tree request does not carry: the billed-read allowance its count, listing and bulk describe are
 * handed.
 */
export function bridgedConsole(
  provider: DatabaseProvider,
  options: QueryPrepareOptions,
  objectReads: ObjectReadOptions = {},
): BridgedConsole {
  const canceller: QueryCancelProvider | undefined = supportsQueryCancel(provider) ? provider : undefined;
  const transactional: TransactionProvider | undefined = isTransactionProvider(provider) ? provider : undefined;
  const ender = endsOpenQueryTransactions(provider) ? provider : undefined;
  const previewer = provider.previewMaintenance === undefined ? undefined : provider.previewMaintenance.bind(provider);
  const pooled: PoolStatsReader | undefined = readsPoolStats(provider) ? provider : undefined;
  const run: LegacyRun = { cancelSent: false };

  async function execute(request: ExecuteRequest): Promise<ExecuteAnswer> {
    const { statement } = request;
    const ownOptions: QueryPrepareOptions = { ...options };
    const prepared = provider.prepareQuery(statement, ownOptions);
    run.prepared = prepared;
    // The statement that runs asks for a row past the page (#1440); see `probePastPage`.
    const probe = probePastPage(provider, statement, ownOptions, prepared);
    const params = request.params === undefined ? undefined : [...request.params];
    if (Object.hasOwn(request, "transaction")) {
      // On the transaction's own connection, which the transaction's own calls end: no run id, no scope, no ender.
      if (transactional === undefined) {
        throw new Error(
          "The bridge was sent a statement inside a transaction for a provider that holds no transaction session, a defect of the host.",
        );
      }
      let inTransaction: QueryResult;
      try {
        inTransaction = await transactional.queryInTransaction(probe.query, params);
      } catch (error) {
        throw noteAppendedBound(error, statement, probe.query);
      }
      run.result = inTransaction;
      return { ...answerOf(inTransaction, prepared.wasLimited), sessionState: sessionStateOf(transactional) };
    }
    const cancelId = canceller === undefined ? undefined : request.runId;
    let result: QueryResult;
    try {
      result = await provider.query(probe.query, params, cancelId, request.scope);
    } catch (error) {
      // An error that names the bound the limiter added says so, rather than pointing into text the user never wrote.
      throw noteAppendedBound(error, statement, probe.query);
    }
    run.result = result;
    return answerOf(result, prepared.wasLimited);
  }

  const calls = sessionCalls(
    {
      console: {
        execute: { honours: ["params", "offset"] },
        cancel: canceller === undefined ? "not-offered" : "offered",
        endScope: ender === undefined ? "not-offered" : "offered",
        transaction: transactional === undefined ? "not-offered" : "offered",
      },
      objects: { tree: "offered" },
      maintenance: { run: "offered", preview: previewer === undefined ? "not-offered" : "offered" },
      monitoring: { panel: "offered", poolStats: pooled === undefined ? "not-offered" : "offered" },
    },
    undefined,
  );

  function answered(): AnsweredRun {
    const { prepared, result } = run;
    if (prepared === undefined || result === undefined) {
      throw new Error("The bridge's run was read before its execute answered, a defect of the host.");
    }
    return { prepared, result };
  }

  function pumpLimits(): PumpLimits {
    const { prepared, result } = answered();
    const maxRows = prepared.wasLimited ? prepared.limit + 1 : Math.max(1, result.rows.length);
    return { maxRows, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES };
  }

  return {
    session: Object.freeze({
      calls,
      readOnlyStatements: false,
      execute,
      tree: (request: TreeRequest) => legacyTree(provider, request, objectReads),
      run: (request: MaintenanceRunRequest) => legacyRun(provider, request),
      panels: bridgedPanels(provider),
      panel: (request: MonitoringPanelRequest) => readPanel(provider, request),
      health: async (): Promise<HealthInfo> => provider.getHealth(),
      ...(pooled === undefined ? {} : { poolStats: async (): Promise<PoolStats> => pooled.getPoolStats() }),
      ...(previewer === undefined
        ? {}
        : {
            preview: (request: MaintenancePreviewRequest): Promise<MaintenancePreview> =>
              previewer(request.operation, [...request.path]),
          }),
      ...(canceller === undefined
        ? {}
        : {
            cancel: async (request: CancelRequest): Promise<CancelAnswer> => {
              run.cancelSent = true;
              return { cancelled: await canceller.cancelQuery(request.runId) };
            },
          }),
      ...(ender === undefined
        ? {}
        : {
            endScope: async (request: EndScopeRequest): Promise<EndScopeAnswer> => ({
              openTransaction: await ender.endOpenQueryTransaction(request.scope),
            }),
          }),
      ...(transactional === undefined
        ? {}
        : { transaction: (request: TransactionRequest) => legacyTransaction(transactional, request) }),
    }),
    run,
    answered,
    pumpLimits,
  };
}

/**
 * What a read-only statement session is opened with: the connection's type, named in the refusal of a provider without
 * a read-only statement path, and the budget members the contract's request does not carry, the statement timeout the
 * provider bounds its statement by and the billed-read allowance, handed over by reference (clause C-78).
 */
export interface ReadOnlyStatementsOpen {
  readonly type: DatabaseType;
  readonly statementTimeoutMs: number;
  readonly readAllowance?: RunReadAllowance;
}

/**
 * A bridged read-only statement session, or, typed as `BridgedComposedStatements`, a bridged composed statement session
 * whose execute sends the statement exactly as composed, as plan mode's statistics read is sent; the legacy result its
 * execute answered, and the page limits read from it.
 */
export interface BridgedReadOnlyStatements {
  readonly session: ConsoleSession;
  /**
   * The legacy result the execute that answered left, for the facade to answer from.
   *
   * @throws {Error} When execute has not answered, a host defect.
   */
  readonly answered: () => QueryResult;
  /**
   * The pump's limits for the answer execute gave: every row the provider returned, at least one, within one page.
   *
   * @throws {Error} When execute has not answered, a host defect.
   */
  readonly pumpLimits: (answer: ExecuteAnswer) => PumpLimits;
}

/** The calls of a session that offers execute alone, honouring `honours`. */
function executeAloneCalls(honours: readonly ExecuteRequestField[]): Calls {
  return sessionCalls(
    {
      console: {
        execute: { honours: [...honours] },
        cancel: "not-offered",
        endScope: "not-offered",
        transaction: "not-offered",
      },
      objects: { tree: "not-offered" },
      maintenance: { run: "not-offered", preview: "not-offered" },
      monitoring: { panel: "not-offered", poolStats: "not-offered" },
    },
    undefined,
  );
}

/** The calls of every read-only statement session: execute alone, honouring `readOnly`. */
const READ_ONLY_STATEMENT_CALLS: Calls = executeAloneCalls(["readOnly"]);

/**
 * `provider`'s read-only statement path served as a read-only statement session (clause C-50): its open refuses, by
 * name and before anything is called, a provider without `queryReadOnly`, in the words the execution-profile
 * acquisition refuses it with, so the plain `query()` is never the fallback (clause C-39). Its execute runs
 * `queryReadOnly` with the statement, a fresh budget of the open's timeout and read allowance and the request's rows
 * and bytes, and the request's mode, absent where the request names none; it never calls `query`, `prepareQuery` or
 * the probe. Its calls offer execute alone, honouring `readOnly`, and it is a read-only statement session, so the host
 * core refuses any execute without `readOnly` before the call. The caller states the policy: it builds this session
 * only over a provider it acquired under a profile whose open policy has both `readOnly` and `sendsStatements`.
 *
 * @throws {StudioProfileRefusal} `PROFILE_UNSUPPORTED_BY_PROVIDER` for a provider without `queryReadOnly`.
 */
export function bridgedReadOnlyStatements(
  provider: DatabaseProvider,
  open: ReadOnlyStatementsOpen,
): BridgedReadOnlyStatements {
  if (typeof provider.queryReadOnly !== "function") {
    throw new StudioProfileRefusal(
      `Provider type "${open.type}" implements no read-only statement path (queryReadOnly)`,
      "PROFILE_UNSUPPORTED_BY_PROVIDER",
    );
  }
  const queryReadOnly = provider.queryReadOnly.bind(provider);
  const record = resultRecord("read-only statement");

  async function execute(request: ExecuteRequest): Promise<ExecuteAnswer> {
    const { readOnly } = request;
    if (readOnly === undefined) {
      throw new Error(
        "The bridge's read-only statement session was sent an execute without readOnly, which the host core refuses before the call, so this is a defect of the host.",
      );
    }
    const budget: ReadOnlyStatementBudget = {
      statementTimeoutMs: open.statementTimeoutMs,
      maxResultRows: readOnly.budget.maxRows,
      maxResultBytes: readOnly.budget.maxBytes,
      ...(open.readAllowance === undefined ? {} : { readAllowance: open.readAllowance }),
    };
    return record.keep(await queryReadOnly(request.statement, budget, readOnly.mode), false);
  }

  return {
    session: Object.freeze({ calls: READ_ONLY_STATEMENT_CALLS, readOnlyStatements: true, execute }),
    answered: record.answered,
    pumpLimits: record.pumpLimits,
  };
}

/**
 * The legacy result one statement session's execute answered: `keep` records it and answers its execute answer, one
 * source per result set, `pageApplied` as the session says; `answered` reads it back, and `pumpLimits` reads every row
 * it holds, at least one, within one page. `session` names the session in the defect a read before execute answered is.
 */
function resultRecord(session: string): {
  readonly keep: (result: QueryResult, pageApplied: boolean) => ExecuteAnswer;
  readonly answered: () => QueryResult;
  readonly pumpLimits: (answer: ExecuteAnswer) => PumpLimits;
} {
  let kept: QueryResult | undefined;
  function answered(): QueryResult {
    if (kept === undefined) {
      throw new Error(`The bridge's ${session} run was read before its execute answered, a defect of the host.`);
    }
    return kept;
  }
  return {
    keep: (result, pageApplied) => {
      kept = result;
      return answerOf(result, pageApplied);
    },
    answered,
    pumpLimits: () => ({
      maxRows: Math.max(1, answered().rows.length),
      maxBytes: PAGE_MAX_BYTES,
      batchMaxBytes: BATCH_MAX_BYTES,
    }),
  };
}

/** A bridged composed statement session, the legacy result its execute answered, and the page limits read from it. */
export type BridgedComposedStatements = BridgedReadOnlyStatements;

/** The calls of every composed statement session: execute alone, honouring no request field. */
const COMPOSED_STATEMENT_CALLS: Calls = executeAloneCalls([]);

/**
 * `provider`'s plain `query` served as a composed statement session (clause C-50), for a statement Studio composed and
 * its statement guard admitted, which must reach the provider exactly as composed: its execute runs `query` with
 * exactly one argument, the request's statement, never `prepareQuery`, the probe, params, a run id or a scope, so no
 * page bound is appended to it. Its calls offer execute alone, honouring no request field, and it is no read-only
 * statement session. It reads no `type` and no monitoring row. Its one caller is `runComposedStatement` in
 * src/lib/api/composed-statement.ts.
 */
export function bridgedComposedStatements(provider: DatabaseProvider): BridgedComposedStatements {
  const record = resultRecord("composed statement");
  return {
    session: Object.freeze({
      calls: COMPOSED_STATEMENT_CALLS,
      readOnlyStatements: false,
      execute: async (request: ExecuteRequest): Promise<ExecuteAnswer> =>
        record.keep(await provider.query(request.statement), false),
    }),
    answered: record.answered,
    pumpLimits: record.pumpLimits,
  };
}

/**
 * What a script unit session is opened with: the unit it serves, and, for the script's last unit only, `tailBound`,
 * the dialect its last statement is read under and the caller's own page options it is bounded with.
 */
export interface ScriptUnitOpen {
  readonly unit: ExecutionUnit;
  readonly tailBound?: { readonly dialect: DatabaseType; readonly options: QueryPrepareOptions };
}

/** A bridged script unit session, the legacy result and page limits it answered, and whether its cancel was sent. */
export interface BridgedScriptUnit extends BridgedReadOnlyStatements {
  /** Whether the session's cancel was sent, so the cancellation answer to it is not logged as a late failure. */
  readonly cancelSent: () => boolean;
}

/** The text a script's unit is sent as, and whether the provider's prepare bounded it. */
interface UnitText {
  readonly text: string;
  readonly wasLimited: boolean;
}

/**
 * The text the script's LAST unit is sent as: its last statement bounded when that statement is a read, and everything
 * else as written.
 *
 * A unit of several statements is a T-SQL batch sent as one request (#1312). Its last statement is bounded by the
 * provider's prepare, on a fresh copy of the caller's options, and spliced back in place, so `SELECT 1; SELECT * FROM
 * big` is as bounded as it was when the two were separate requests - unless the batch is a module definition (`CREATE
 * PROCEDURE … AS …`), whose last statement is part of the body the server stores, where a `TOP` would change the
 * procedure rather than the result. No row past the page is probed: a script's answer is every row its statement
 * returned.
 */
function boundedText(
  provider: DatabaseProvider,
  unit: ExecutionUnit,
  dialect: DatabaseType,
  options: QueryPrepareOptions,
): UnitText {
  const asWritten = { text: unit.sql, wasLimited: false };
  const tail = unit.statements[unit.statements.length - 1];
  if (!isSelectQuery(tail.sql, dialect)) return asWritten;
  if (unit.statements.length > 1 && unitIsModuleBody(unit, resolveSqlGrammar(dialect))) return asWritten;
  const { query, wasLimited } = provider.prepareQuery(tail.sql, { ...options });
  return {
    text: unit.sql.slice(0, tail.start - unit.start) + query + unit.sql.slice(tail.end - unit.start),
    wasLimited,
  };
}

/**
 * One unit of a script of `POST /api/db/multi-query` served as a script unit session (clause C-50), built per unit by
 * `openEditorScript` in src/lib/api/editor-script.ts: its execute takes only the unit's own text as the request's
 * statement, any other text a host defect thrown by name before anything is called, and sends it as the script route
 * always sent it: as written, or, for a unit opened with `tailBound`, the text `boundedText` builds, never probed. It
 * calls `query` with that text, no params, the run id only for a provider that cancels, and the request's scope, absent
 * when the request carries none, and throws `noteAppendedBound` on a failure, by reference. Its calls offer execute
 * honouring `offset`, the last unit's page, and `console.cancel` and `console.endScope` exactly as `bridgedConsole`
 * offers them, with the same members; it offers no transaction, tree, maintenance or monitoring facet and is no
 * read-only statement session. It answers one source per result set, the main rows first, `pageApplied` exactly when
 * the prepare bounded the unit, and its page's row limit is every row the provider returned, at least one.
 */
export function bridgedScriptUnit(provider: DatabaseProvider, open: ScriptUnitOpen): BridgedScriptUnit {
  const canceller: QueryCancelProvider | undefined = supportsQueryCancel(provider) ? provider : undefined;
  const ender = endsOpenQueryTransactions(provider) ? provider : undefined;
  const record = resultRecord("script unit");
  let cancelSent = false;

  async function execute(request: ExecuteRequest): Promise<ExecuteAnswer> {
    const { unit, tailBound } = open;
    if (request.statement !== unit.sql) {
      throw new Error(
        "The bridge's script unit session was sent a statement other than its unit's text, a defect of the host.",
      );
    }
    const sent =
      tailBound === undefined
        ? { text: unit.sql, wasLimited: false }
        : boundedText(provider, unit, tailBound.dialect, tailBound.options);
    const cancelId = canceller === undefined ? undefined : request.runId;
    let result: QueryResult;
    try {
      result = await provider.query(sent.text, undefined, cancelId, request.scope);
    } catch (error) {
      // An error that names the bound the limiter added says so, rather than pointing into text the user never wrote.
      throw noteAppendedBound(error, unit.sql, sent.text);
    }
    return record.keep(result, sent.wasLimited);
  }

  const calls = sessionCalls(
    {
      console: {
        execute: { honours: ["offset"] },
        cancel: canceller === undefined ? "not-offered" : "offered",
        endScope: ender === undefined ? "not-offered" : "offered",
        transaction: "not-offered",
      },
      objects: { tree: "not-offered" },
      maintenance: { run: "not-offered", preview: "not-offered" },
      monitoring: { panel: "not-offered", poolStats: "not-offered" },
    },
    undefined,
  );

  return {
    session: Object.freeze({
      calls,
      readOnlyStatements: false,
      execute,
      ...(canceller === undefined
        ? {}
        : {
            cancel: async (request: CancelRequest): Promise<CancelAnswer> => {
              cancelSent = true;
              return { cancelled: await canceller.cancelQuery(request.runId) };
            },
          }),
      ...(ender === undefined
        ? {}
        : {
            endScope: async (request: EndScopeRequest): Promise<EndScopeAnswer> => ({
              openTransaction: await ender.endOpenQueryTransaction(request.scope),
            }),
          }),
    }),
    answered: record.answered,
    pumpLimits: record.pumpLimits,
    cancelSent: () => cancelSent,
  };
}

/**
 * What a transaction script unit session is opened with: the unit it serves, and, for the script's last unit only,
 * `lastUnitOptions`, the caller's own page options a unit of one statement is prepared with.
 */
export interface TransactionScriptUnitOpen {
  readonly unit: ExecutionUnit;
  readonly lastUnitOptions?: QueryPrepareOptions;
}

/** A bridged transaction script unit session, the legacy result its execute answered, and its page limits. */
export type BridgedTransactionScriptUnit = BridgedReadOnlyStatements;

/** The calls of every transaction script unit session: execute honouring `offset`, and the transaction facet. */
const TRANSACTION_SCRIPT_UNIT_CALLS: Calls = sessionCalls(
  {
    console: {
      execute: { honours: ["offset"] },
      cancel: "not-offered",
      endScope: "not-offered",
      transaction: "offered",
    },
    objects: { tree: "not-offered" },
    maintenance: { run: "not-offered", preview: "not-offered" },
    monitoring: { panel: "not-offered", poolStats: "not-offered" },
  },
  undefined,
);

/**
 * One unit of a script of `POST /api/db/transaction` served as a transaction script unit session (clause C-50), built
 * per unit by `openTransactionScript` in src/lib/api/editor-script.ts. Its execute takes only the unit's own text as
 * the request's statement, and only sent with `transaction`, either other request a host defect thrown by name before
 * anything is called, and sends the text as the transaction route always sent it: as written, or, for a unit opened
 * with `lastUnitOptions` that holds exactly one statement, the query the provider's `prepareQuery` answers for it on a
 * fresh copy of those options, never probed. It calls `queryInTransaction` with that text alone, no params, run id or
 * scope, since it runs on the transaction's own connection, throws `noteAppendedBound` on a failure, by reference, and
 * reads nothing after a failure. Its calls offer execute honouring `offset`, the last unit's page, and
 * `console.transaction` with the member `bridgedConsole` offers; it offers no cancel, endScope, tree, maintenance or
 * monitoring facet and is no read-only statement session. It answers one source per result set, the main rows first,
 * `pageApplied` exactly when the prepare bounded the unit, and the session state read after the statement, and its
 * page's row limit is every row the provider returned, at least one.
 */
export function bridgedTransactionScriptUnit(
  provider: DatabaseProvider & TransactionProvider,
  open: TransactionScriptUnitOpen,
): BridgedTransactionScriptUnit {
  const record = resultRecord("transaction script unit");

  async function execute(request: ExecuteRequest): Promise<ExecuteAnswer> {
    const { unit, lastUnitOptions } = open;
    if (request.statement !== unit.sql) {
      throw new Error(
        "The bridge's transaction script unit session was sent a statement other than its unit's text, a defect of the host.",
      );
    }
    if (!Object.hasOwn(request, "transaction")) {
      throw new Error(
        "The bridge's transaction script unit session was sent a statement without transaction, which it serves only inside the transaction, a defect of the host.",
      );
    }
    const sent =
      lastUnitOptions !== undefined && unit.statements.length === 1
        ? provider.prepareQuery(unit.sql, { ...lastUnitOptions })
        : { query: unit.sql, wasLimited: false };
    let result: QueryResult;
    try {
      result = await provider.queryInTransaction(sent.query);
    } catch (error) {
      // An error that names the bound the limiter added says so, rather than pointing into text the user never wrote.
      throw noteAppendedBound(error, unit.sql, sent.query);
    }
    return { ...record.keep(result, sent.wasLimited), sessionState: sessionStateOf(provider) };
  }

  return {
    session: Object.freeze({
      calls: TRANSACTION_SCRIPT_UNIT_CALLS,
      readOnlyStatements: false,
      execute,
      transaction: (request: TransactionRequest) => legacyTransaction(provider, request),
    }),
    answered: record.answered,
    pumpLimits: record.pumpLimits,
  };
}
