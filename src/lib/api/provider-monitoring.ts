import type {
  MonitoringFacet,
  MonitoringPanelAnswer,
  MonitoringPanelRequest,
  PoolStats,
} from "@libredb/provider-sdk/calls";
import { callContext, EXECUTE_SLACK_MS, executeDeadline, statementTimeout } from "@/lib/api/editor-query";
import { readDeclaredPanels } from "@/lib/db/engine-facets/monitoring";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { waitedSeconds } from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import type { DatabaseProvider, MonitoringData, MonitoringOptions } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { type CallerView, refusalError, stopError } from "@/lib/provider-host/access";
import { hostCore } from "@/lib/provider-host/instance";
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";

/*
 * MONITORING ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clause C-74).
 *
 * `providerMonitoring` is the caller facade of the monitoring and pool-stats routes, `POST /api/db/monitoring` and
 * `POST /api/db/pool-stats`. Each panel read and each pool statistics read is one host core monitoring call on the
 * legacy bridge's session of the provider the route resolved, built as `objectTree` builds it. The core is the one the
 * process's composition root installed, read before anything else, so a read made before the install fails by name and
 * reaches no provider.
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
 * Answers. A read answers the provider's own answer by reference and throws every refusal and stop as the accessor's
 * error: `QueryCancelledError` when the caller left, `StudioTimeoutRefusal` naming the read at its deadline, outcome
 * not-sent when refused before the call and unknown once the provider was called, or a defect of Studio's bridge. A
 * provider's error passes as the same object. A read's failure after its wait ended is logged by route, facet, panel,
 * kind and code, never its text, and a later answer is dropped, since nothing waits on it.
 */

/** The monitoring of one provider as the monitoring and pool-stats routes reach it. The calls hold no `this`. */
export interface ProviderMonitoring {
  /** Whether the bridged session offers `monitoring.poolStats`: the provider reads its pool statistics. */
  readonly poolStatsOffered: boolean;
  readDashboard(options: MonitoringOptions): Promise<MonitoringData>;
  readPoolStats(): Promise<PoolStats>;
}

/** The read each deadline sentence names. */
const READ_NAME: Readonly<Record<MonitoringFacet, string>> = {
  panel: "A monitoring panel read",
  poolStats: "The pool statistics read",
};

/**
 * The late port of one monitoring read: a failure after the caller stopped waiting, logged under `route`, `facet` and,
 * for a panel, its `panel`, by its kind and code, never its text, which can carry a server's words.
 */
function monitoringLate(route: string, facet: MonitoringFacet, panel?: string): (failure: unknown) => void {
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

/**
 * The monitoring of `provider`, each panel read and pool statistics read a host core monitoring call under its own
 * deadline, taken from `clock` at its start, and `caller`, its failures after the caller left logged under `route`.
 */
export function providerMonitoring(
  provider: DatabaseProvider,
  caller: AbortSignal,
  route: string,
  clock: () => number = Date.now,
): ProviderMonitoring {
  /** The caller's view of a read of `facet`, under its deadline sentence. */
  function viewOf(facet: MonitoringFacet): CallerView {
    return {
      caller,
      deadlineSentence: `${READ_NAME[facet]} did not answer within the statement timeout of ${waitedSeconds(statementTimeout(provider))} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`,
    };
  }

  return {
    poolStatsOffered: bridgedConsole(provider, {}).session.calls.monitoring.poolStats === "offered",
    readDashboard: async (options) => {
      const core = hostCore();
      const { session } = bridgedConsole(provider, {});
      const view = viewOf("panel");
      const read = async (request: MonitoringPanelRequest): Promise<MonitoringPanelAnswer> => {
        const ctx = callContext(executeDeadline(provider, clock()), caller);
        const record = await core.panelCall(session, request, ctx, {
          late: monitoringLate(route, "panel", request.panel),
        });
        if (record.kind === "refused") throw refusalError(record, view);
        if (record.kind === "stopped") throw stopError(record.reason, view);
        return record.answer;
      };
      return readDeclaredPanels(read, session.panels, options, (error) => mapDatabaseError(error, provider.type));
    },
    readPoolStats: async () => {
      const core = hostCore();
      const { session } = bridgedConsole(provider, {});
      const view = viewOf("poolStats");
      const ctx = callContext(executeDeadline(provider, clock()), caller);
      const record = await core.poolStatsCall(session, ctx, { late: monitoringLate(route, "poolStats") });
      if (record.kind === "refused") throw refusalError(record, view);
      if (record.kind === "stopped") throw stopError(record.reason, view);
      return record.answer;
    },
  };
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
