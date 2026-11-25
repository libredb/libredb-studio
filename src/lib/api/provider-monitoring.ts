import {
  type CallContext,
  type DatabaseOverview,
  deadlineSignal,
  type HealthInfo,
  type MonitoringFacet,
  type MonitoringPanelAnswer,
  type MonitoringPanelRequest,
  type PoolStats,
} from "@libredb/provider-sdk/calls";
import { callContext, contextOn, EXECUTE_SLACK_MS, executeDeadline, statementTimeout } from "@/lib/api/editor-query";
import { memberOf, type PanelMember, readDeclaredPanels } from "@/lib/db/engine-facets/monitoring";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { waitedSeconds } from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import type { DatabaseProvider, MonitoringData, MonitoringOptions } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import {
  type BudgetView,
  budgetRefusalError,
  budgetStopError,
  type CallerView,
  refusalError,
  stopError,
} from "@/lib/provider-host/access";
import type { RefusedRecord, StoppedRecord } from "@/lib/provider-host/core/console";
import type { HostCore } from "@/lib/provider-host/core/host-core";
import type { HealthSession, MonitoringSession } from "@/lib/provider-host/core/monitoring";
import { hostCore } from "@/lib/provider-host/instance";
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";

/*
 * MONITORING AND HEALTH ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clauses C-74, C-75 and C-76).
 *
 * `providerMonitoring` is the caller facade of the monitoring and pool-stats routes, `POST /api/db/monitoring` and
 * `POST /api/db/pool-stats`, of the health route, `POST /api/db/health`, and of fleet health's health and overview
 * reads, `POST /api/admin/fleet-health`. Each panel read, each pool statistics read and each health read is one host
 * core call on the legacy bridge's session of the provider the route resolved, built as `objectTree` builds it. The
 * core is the one the process's composition root installed, read before anything else, so a read made before the
 * install fails by name and reaches no provider.
 *
 * An overview read is one panel call for the overview, made only where the session's engine offers the overview panel,
 * and its answer is held to the overview panel's form by `memberOf`, the check the dashboard's orchestration makes; it
 * answers `undefined` with no call where the engine does not offer it.
 *
 * `readHealthWithin` is Test Connection's health read (src/lib/api/test-connection.ts): one health call on the session
 * of the provider the test holds, on the test's own deadline and its deadline signal by reference (`contextOn`), so the
 * test keeps one deadline. It answers the health, or that the test's wait ended, which the test answers in its own
 * error, since its deadline is its connect budget and its error class its own.
 *
 * A dashboard read is `readDeclaredPanels`, the declared panels' one orchestration, which `getMonitoringData` runs too,
 * here over the core's panel calls: it asks only the panels the session's engine offers and the caller requests, each
 * through one fresh panel request, holds each answer to the requested panel's form, and answers the four panel states.
 * It runs in the calling bundle, since the core holds no Studio class and no `mapDatabaseError`. A dashboard whose
 * panels failed with several sentences answers `mapDatabaseError` of the joined sentences for the session's engine,
 * which is what every provider's own `mapError` does: no provider overrides it, which
 * tests/isolated/monitoring-panels-census.test.ts holds.
 *
 * Deadlines. Each read waits until its own deadline, `executeDeadline` taken at that read's start, the statement
 * timeout plus `EXECUTE_SLACK_MS`, and until the caller's signal, the request's: the rule each tree read follows. The
 * orchestration starts every panel read of a dashboard in one turn, within 0.06 ms of each other as measured on
 * PostgreSQL on the editor's pool and on a pool of two (2026-11-24), so a per-read deadline is the dashboard's to within
 * that, and the dashboard has no deadline of its own.
 *
 * `readGrantedPanel` and `readGrantedHealth` are the agent's curated readings' reads (src/lib/agent/tools.ts, clause
 * C-76): one panel call or one health call on the session of the provider the run acquired, under the deadline its call
 * was granted and, as its caller's signal, one that never aborts (`driveCaller`), since the agent's drive has none.
 * Each reads the core and builds the session synchronously, so a read made before the install throws
 * `HostCoreBootOrderError` before any promise, and builds a fresh request copy and a fresh context of the grant's
 * deadline, its deadline signal and the empty environment. A panel the session does not offer answers `not-offered`
 * with no call. A read its deadline stopped hands the stopped call's settlement to the grant's `holdUntilSettled`, so
 * the run counts the provider call until it settles, and throws `StudioTimeoutRefusal` with the grant's sentence.
 *
 * Answers. A read answers the provider's own answer by reference and throws every refusal and stop as the accessor's
 * error: `QueryCancelledError` when the caller left, `StudioTimeoutRefusal` naming the read at its deadline, outcome
 * not-sent when refused before the call and unknown once the provider was called, or a defect of Studio's bridge. A
 * provider's error passes as the same object. A read's failure after its wait ended is logged by route, facet, panel,
 * kind and code, never its text, and a later answer is dropped, since nothing waits on it.
 */

/**
 * The monitoring and health of one provider as the monitoring, pool-stats, health and fleet health routes reach them.
 * The calls hold no `this`.
 */
export interface ProviderMonitoring {
  /** Whether the bridged session offers `monitoring.poolStats`: the provider reads its pool statistics. */
  readonly poolStatsOffered: boolean;
  readDashboard(options: MonitoringOptions): Promise<MonitoringData>;
  readPoolStats(): Promise<PoolStats>;
  readHealth(): Promise<HealthInfo>;
  /** The overview's figures, or `undefined` with no call where the session's engine does not offer the overview. */
  readOverview(): Promise<DatabaseOverview | undefined>;
}

/** What Test Connection's health read answers: the provider's health, or that the test's wait ended. */
export type HealthWithin = { readonly kind: "answered"; readonly health: HealthInfo } | { readonly kind: "ended" };

/** What a read is: a monitoring facet, or the health call. */
type MonitoringRead = MonitoringFacet | "health";

/** The read each deadline sentence names. */
const READ_NAME: Readonly<Record<MonitoringRead, string>> = {
  panel: "A monitoring panel read",
  poolStats: "The pool statistics read",
  health: "The health read",
};

/**
 * The late port of one monitoring or health read: a failure after the caller stopped waiting, logged under `route`,
 * `facet`, `health` for the health call, and, for a panel, its `panel`, by its kind and code, never its text, which can
 * carry a server's words.
 */
function monitoringLate(route: string, facet: MonitoringRead, panel?: string): (failure: unknown) => void {
  return (failure) => {
    logger.warn("A monitoring read Studio stopped waiting for failed afterwards", {
      route,
      facet,
      ...(panel === undefined ? {} : { panel }),
      kind: errorKind(failure),
      code: errorCode(failure),
    });
  };
}

/** A record's answer, or the accessor's error for a refusal or a stop, read under `view`. */
function answerOf<Answer>(
  record: RefusedRecord | StoppedRecord | { readonly kind: "answered"; readonly answer: Answer },
  view: CallerView,
): Answer {
  if (record.kind === "refused") throw refusalError(record, view);
  if (record.kind === "stopped") throw stopError(record.reason, view);
  return record.answer;
}

/**
 * The monitoring and health of `provider`, each panel read, pool statistics read and health read a host core call
 * under its own deadline, taken from `clock` at its start, and `caller`, its failures after the caller left logged
 * under `route`.
 */
export function providerMonitoring(
  provider: DatabaseProvider,
  caller: AbortSignal,
  route: string,
  clock: () => number = Date.now,
): ProviderMonitoring {
  /** The caller's view of a read, under its deadline sentence. */
  function viewOf(read: MonitoringRead): CallerView {
    return {
      caller,
      deadlineSentence: `${READ_NAME[read]} did not answer within the statement timeout of ${waitedSeconds(statementTimeout(provider))} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`,
    };
  }

  /** One panel read of `session` through `core`, under its own deadline and `caller`. */
  async function readPanelOf(
    core: HostCore,
    session: MonitoringSession,
    request: MonitoringPanelRequest,
  ): Promise<MonitoringPanelAnswer> {
    const ctx = callContext(executeDeadline(provider, clock()), caller);
    const record = await core.panelCall(session, request, ctx, {
      late: monitoringLate(route, "panel", request.panel),
    });
    return answerOf(record, viewOf("panel"));
  }

  return {
    poolStatsOffered: bridgedConsole(provider, {}).session.calls.monitoring.poolStats === "offered",
    readDashboard: async (options) => {
      const core = hostCore();
      const { session } = bridgedConsole(provider, {});
      const read = (request: MonitoringPanelRequest) => readPanelOf(core, session, request);
      return readDeclaredPanels(read, session.panels, options, (error) => mapDatabaseError(error, provider.type));
    },
    readPoolStats: async () => {
      const core = hostCore();
      const { session } = bridgedConsole(provider, {});
      const ctx = callContext(executeDeadline(provider, clock()), caller);
      const record = await core.poolStatsCall(session, ctx, { late: monitoringLate(route, "poolStats") });
      return answerOf(record, viewOf("poolStats"));
    },
    readHealth: async () => {
      const core = hostCore();
      const { session } = bridgedConsole(provider, {});
      const ctx = callContext(executeDeadline(provider, clock()), caller);
      const record = await core.healthCall(session, ctx, { late: monitoringLate(route, "health") });
      return answerOf(record, viewOf("health"));
    },
    readOverview: async () => {
      const core = hostCore();
      const { session } = bridgedConsole(provider, {});
      if (session.panels.overview !== "offered") return undefined;
      const request = { panel: "overview" } as const;
      return memberOf(request, await readPanelOf(core, session, request));
    },
  };
}

/**
 * Test Connection's health read of `provider`, the provider the test holds: one host core health call on the bridged
 * session, its context's deadline `deadline` and its signal `signal` itself, the test's own wait
 * (docs/providers/CONTRACT.md, clauses C-56 and C-75). The promise answers the provider's health by reference, or
 * `ended` when the wait ended before the call or while it was pending; a failure after the wait ended is logged under
 * `route` by kind and code.
 *
 * The host core is read and the session built before the call starts, synchronously, so a read made before the core
 * is installed throws `HostCoreBootOrderError` at once rather than as the promise's rejection: the caller starts the
 * read outside the code that answers a provider's health error, and the defect is never taken for one.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed.
 * @returns A promise that rejects with the provider's error as the same object.
 */
export function readHealthWithin(
  provider: DatabaseProvider,
  deadline: number,
  signal: AbortSignal,
  route: string,
): Promise<HealthWithin> {
  const core = hostCore();
  const { session } = bridgedConsole(provider, {});
  return readSessionHealthWithin(core, session, contextOn(deadline, signal), route);
}

/**
 * Test Connection's health read of `session`, a session the test holds, a legacy provider's bridged one or a provider
 * package's own (docs/providers/CONTRACT.md, clauses C-75 and C-112): one health call of `core` with the context
 * `ctx`, the test's own deadline, its signal and the environment the session's calls are given. Answers as
 * `readHealthWithin` answers.
 *
 * @returns A promise that rejects with the session's error as the same object.
 */
export function readSessionHealthWithin(
  core: HostCore,
  session: HealthSession,
  ctx: CallContext,
  route: string,
): Promise<HealthWithin> {
  return core
    .healthCall(session, ctx, { late: monitoringLate(route, "health") })
    .then((record) => (record.kind === "answered" ? { kind: "answered", health: record.answer } : { kind: "ended" }));
}

/**
 * What a granted read is given: the deadline its call was granted, the sentence a read that deadline ended answers,
 * the route its late failures are logged under, and the hold that keeps the caller counting a stopped call until it
 * settles.
 */
export interface GrantedRead {
  readonly deadline: number;
  readonly deadlineSentence: string;
  readonly route: string;
  readonly holdUntilSettled: (settled: Promise<unknown>) => void;
}

/** What a granted panel read answers: the panel's member by reference, or that the session does not offer the panel. */
export type GrantedPanel<P extends MonitoringPanelRequest["panel"]> =
  | { readonly kind: "answered"; readonly member: PanelMember<P> }
  | { readonly kind: "not-offered" };

/** A granted read's context: the grant's deadline, a signal that aborts at it alone, and the empty environment. */
function grantedContext(grant: GrantedRead) {
  return contextOn(grant.deadline, deadlineSignal(grant.deadline));
}

/**
 * The caller signal of one call the agent's drive makes, a granted read or a statement (`runReadOnlyExecute`): a signal
 * that never aborts, made for that call. The agent's drive has no signal of its own, since its cancellation is the
 * run's checkpoint between tool calls, so the drive cannot leave a call mid-way, and the accessor reads a call that
 * ended as its deadline's, never as the caller leaving.
 */
export function driveCaller(): AbortSignal {
  return new AbortController().signal;
}

/**
 * What a call the agent's drive was granted time for is given, where its time refusal is its own (clause C-80): the
 * deadline its call was granted, the error a call that deadline ended answers, built fresh where the caller builds it
 * fresh, the route its late failures are logged under, and the hold that keeps the run counting a stopped call until
 * it settles. The grounding walk's tree reads (`grantedObjectTree`) and the statistics read (`runComposedStatement`)
 * read it.
 */
export interface BudgetGrant {
  readonly deadline: number;
  readonly timeRefusal: () => Error;
  readonly route: string;
  readonly holdUntilSettled: (settled: Promise<unknown>) => void;
}

/**
 * The error a granted call that did not answer throws: a stopped call's settlement handed to the grant's hold first,
 * then the accessor's budget error under the drive's caller signal, which never aborts, so every end at the deadline,
 * a stop at any wait or a start refused after it, is the grant's own time refusal.
 */
export function budgetGrantEnd(record: RefusedRecord | StoppedRecord, grant: BudgetGrant): Error {
  const view: BudgetView = { caller: driveCaller(), timeRefusal: grant.timeRefusal };
  if (record.kind === "refused") return budgetRefusalError(record, view);
  grant.holdUntilSettled(record.settled);
  return budgetStopError(record.reason, view);
}

/**
 * A granted read's record as its answer: a stopped call's settlement handed to the grant's hold before the accessor's
 * error is thrown for it, under the drive's caller signal, which never aborts.
 */
function grantedAnswer<Answer>(
  record: RefusedRecord | StoppedRecord | { readonly kind: "answered"; readonly answer: Answer },
  grant: GrantedRead,
): Answer {
  if (record.kind === "stopped") grant.holdUntilSettled(record.settled);
  return answerOf(record, { caller: driveCaller(), deadlineSentence: grant.deadlineSentence });
}

/** Whether a refused record's one refusal is of a panel the session does not offer. */
function panelNotOffered(record: RefusedRecord): boolean {
  return record.refusals.length === 1 && record.refusals[0]?.rule === "request-panel-not-offered";
}

/**
 * One panel read of `provider` for the agent, on a fresh copy of `request`, within `grant`: one host core panel call on
 * the bridged session, its context the grant's deadline and that deadline's signal alone.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed.
 * @returns A promise of the panel's member by reference, or `not-offered` with no call where the session does not
 * offer the panel; it rejects with `StudioTimeoutRefusal` with the grant's sentence when the deadline ended the read,
 * after handing the stopped call's settlement to the grant's hold, and with the provider's error as the same object.
 */
export function readGrantedPanel<R extends MonitoringPanelRequest>(
  provider: DatabaseProvider,
  request: R,
  grant: GrantedRead,
): Promise<GrantedPanel<R["panel"]>> {
  const core = hostCore();
  const { session } = bridgedConsole(provider, {});
  const ownRequest: R = { ...request };
  const late = monitoringLate(grant.route, "panel", request.panel);
  return core.panelCall(session, ownRequest, grantedContext(grant), { late }).then((record) => {
    if (record.kind === "refused" && panelNotOffered(record)) return { kind: "not-offered" };
    return { kind: "answered", member: memberOf(request, grantedAnswer(record, grant)) };
  });
}

/**
 * One health read of `provider` for the agent within `grant`: one host core health call on the bridged session, its
 * context the grant's deadline and that deadline's signal alone.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed.
 * @returns A promise of the provider's health by reference; it rejects as `readGrantedPanel`'s does.
 */
export function readGrantedHealth(provider: DatabaseProvider, grant: GrantedRead): Promise<HealthInfo> {
  const core = hostCore();
  const { session } = bridgedConsole(provider, {});
  const late = monitoringLate(grant.route, "health");
  return core.healthCall(session, grantedContext(grant), { late }).then((record) => grantedAnswer(record, grant));
}

/** Whether `value`, a present limit, is a whole number of at least 1 that JavaScript holds exactly. */
function isLimit(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The sentence refusing the monitoring `options` a caller sent, or `undefined` when they are taken: a present
 * `slowQueryLimit` or `sessionLimit` that is not a whole number of at least 1, then a present `schemaFilter` that is
 * not text or is empty, the first in that order. An absent option keeps its default. The sentence names the option,
 * never its value. The `include` flags are not read here: they choose which panels are read and reach no provider.
 */
export function monitoringOptionsRefusal(options: Readonly<Record<string, unknown>>): string | undefined {
  for (const name of ["slowQueryLimit", "sessionLimit"] as const) {
    if (options[name] !== undefined && !isLimit(options[name])) {
      return `options.${name} must be a whole number of at least 1`;
    }
  }
  const { schemaFilter } = options;
  if (schemaFilter !== undefined && (typeof schemaFilter !== "string" || schemaFilter.length === 0)) {
    return "options.schemaFilter must name a schema, as text that is not empty";
  }
  return undefined;
}
