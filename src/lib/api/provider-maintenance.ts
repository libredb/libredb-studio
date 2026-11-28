import type {
  MaintenancePreview,
  MaintenancePreviewRequest,
  MaintenanceRunAnswer,
  MaintenanceRunRequest,
} from "@libredb/provider-sdk/calls";
import { callContext, EXECUTE_SLACK_MS, executeDeadlineFor } from "@/lib/api/editor-query";
import type { PackageAnswers } from "@/lib/api/package-errors";
import { type MaintenanceTarget, markedCall } from "@/lib/api/session-target";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { type QueryCancelledError, type StudioTimeoutRefusal, waitedSeconds } from "@/lib/db/errors";
import type { MaintenanceOperation } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { type CallerView, refusalError, stopError } from "@/lib/provider-host/access";
import type { HostCore } from "@/lib/provider-host/core/host-core";
import type { MaintenanceRunRecord, MaintenanceSession } from "@/lib/provider-host/core/maintenance";
import { hostCore } from "@/lib/provider-host/instance";

/*
 * MAINTENANCE ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clause C-70).
 *
 * `providerMaintenance` is the caller facade of the two maintenance routes, `POST /api/db/maintenance` and
 * `POST /api/db/maintenance/preview`. Each run and preview is one host core maintenance call on the session of the
 * target the route hands it (`MaintenanceTarget` in src/lib/api/session-target.ts), a legacy provider's bridged session
 * (`providerMaintenanceTarget`) or a provider package's, under the target's environment, counted on the target's entry
 * while it runs (`markedCall`), with the session's maintenance the target reads when the call is made: for a legacy
 * provider `bridgedMaintenance`'s answer, the declaration its maintenance opening read before the provider connected
 * narrowed by what the connected provider still accepts (clause C-68), and for a provider package the maintenance its
 * open narrowed. The core is the one the process's composition root
 * installed, read before anything else, so a call made before the install fails by name and reaches no provider. It
 * builds a fresh request for each call, `target` and `container` present only when given and a copy of the path, so
 * the core freezes nothing a caller holds.
 *
 * Deadlines. Each call waits until its own deadline, `executeDeadlineFor` taken at that call's start, the target's
 * statement timeout plus `EXECUTE_SLACK_MS`, and until the caller's signal, the request's: the rule each tree read
 * follows. On an engine that bounds its maintenance statement by the statement timeout the engine's own answer arrives
 * first; on one that does not, a run longer than the deadline is cut, and the engine is not told (the backlog, D730).
 *
 * Answers. A run answers how it ended, since the route writes its audit row and its query event by that and only the
 * facade knows whether the provider was called: answered with the provider's own result by reference, which the host
 * core read with the SDK's `checkMaintenanceRunAnswer` (clause C-112); not-sent, the host refused before the call, with
 * the accessor's error (`QueryCancelledError` or `StudioTimeoutRefusal`, outcome not-sent, or a defect of Studio's
 * bridge), or raised before it, with its own error (a core the process never installed, or a refusal of the session's
 * maintenance); or stopped, the caller left or the deadline passed while the provider ran, with the accessor's error,
 * outcome unknown. A run whose answer the core refused ran, so it is thrown as the accessor's error, a defect of
 * Studio's bridge, as a provider's error is, and the route audits it as a run that failed. A preview answers the
 * provider's own preview by reference, read with `checkMaintenancePreviewAnswer`, and throws every refusal and stop as
 * the accessor's error, as a tree read does. A run's failure after the call and a preview's every failure pass through
 * the request's `PackageAnswers` (./package-errors, clause C-112), the record of the engine's failures the route handed
 * it, which answers each as `packageFailureAnswer` does: a legacy record's provider error and Studio's own error pass
 * as the same object, by run and by preview, so each route keeps its own mapping of it, and a provider package's
 * failure is logged once and answered by the record's grant, a run whose answer the core refused as the package's
 * defect. A call's failure after its wait ended is logged by route, facet, kind and
 * code, never its text, and a run that answers after its wait ended, which the route audited as an unknown outcome, is
 * logged by route and facet, never its answer.
 */

/** How a maintenance run ended, for the route's audit row and query event. */
export type MaintenanceRunOutcome =
  /** The provider answered: its own result, by reference. */
  | { readonly kind: "answered"; readonly result: MaintenanceRunAnswer }
  /** The host refused the run before the call, so nothing reached the provider. */
  | { readonly kind: "not-sent"; readonly error: Error }
  /** The caller left, or the deadline passed, while the provider ran: whether the engine completed it is not known. */
  | { readonly kind: "stopped"; readonly error: QueryCancelledError | StudioTimeoutRefusal };

/** The maintenance of one session as the two maintenance routes reach it. The calls hold no `this`. */
export interface ProviderMaintenance {
  /** Whether the session offers `maintenance.preview`: a legacy provider's does where it holds `previewMaintenance`. */
  readonly previewOffered: boolean;
  run(operation: MaintenanceOperation, target?: string, container?: string): Promise<MaintenanceRunOutcome>;
  preview(operation: MaintenanceOperation, path: readonly string[]): Promise<MaintenancePreview>;
}

type Facet = "run" | "preview";

/** The late port of one maintenance call, and the line for a call the caller stopped waiting for that answered. */
interface MaintenanceLate {
  readonly late: (failure: unknown) => void;
  /** Logs that the call answered once `settled` resolves, unless `late` was handed a failure first. */
  readonly answeredAfter: (settled: Promise<void>) => void;
}

/**
 * The late port of a maintenance call: a failure after the caller stopped waiting, logged under `route` and `facet` by
 * its kind and code, never its text, which can carry a server's words. A call that settled after the stop with no such
 * failure answered, since the bridged provider is never handed the call's signal, and is logged under `route` and
 * `facet` alone, never its answer, so an operator can match an unknown-outcome audit row to the engine's completion.
 */
function maintenanceLate(route: string, facet: Facet): MaintenanceLate {
  let failed = false;
  return {
    late: (failure) => {
      failed = true;
      logger.warn("A maintenance call Studio stopped waiting for failed afterwards", {
        route,
        facet,
        kind: errorKind(failure),
        code: errorCode(failure),
      });
    },
    answeredAfter: (settled) => {
      void settled.then(() => {
        if (!failed) logger.warn("A maintenance call Studio stopped waiting for answered afterwards", { route, facet });
      });
    },
  };
}

/**
 * The maintenance of `target`'s session, the engine's of `answers`, each run and preview a host core maintenance call
 * under its own deadline, taken from `clock` at its start and the target's timeout, the target's environment and
 * `caller`, on the session's maintenance as the target reads it when the call is made (`maintenance()`), counted on the
 * target's entry while it runs; a failure of each answered through the request's `answers`, and its failures after the
 * caller left logged under its route.
 */
export function providerMaintenance(
  target: MaintenanceTarget,
  answers: PackageAnswers,
  caller: AbortSignal,
  clock: () => number = Date.now,
): ProviderMaintenance {
  const { route } = answers;
  /** The session with its maintenance read for this call, and the caller's view under the call's deadline. */
  function callOf(facet: Facet) {
    const session: MaintenanceSession = Object.freeze({ ...target.session, maintenance: target.maintenance() });
    const view: CallerView = {
      caller,
      deadlineSentence: `The maintenance ${facet} did not answer within the statement timeout of ${waitedSeconds(target.timeout())} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`,
    };
    return {
      session,
      view,
      ctx: callContext(executeDeadlineFor(target.timeout(), clock()), caller, target.env),
      after: maintenanceLate(route, facet),
    };
  }

  return {
    previewOffered: target.session.calls.maintenance.preview === "offered",
    run: async (operation, operationTarget, container) => {
      const request: MaintenanceRunRequest = {
        operation,
        ...(operationTarget === undefined ? {} : { target: operationTarget }),
        ...(container === undefined ? {} : { container }),
      };
      // The core and the session's maintenance are read before the call, so what either raises reached no provider.
      let core: HostCore;
      let built: ReturnType<typeof callOf>;
      try {
        core = hostCore();
        built = callOf("run");
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { kind: "not-sent", error };
      }
      const { session, view, ctx, after } = built;
      let record: MaintenanceRunRecord;
      try {
        record = await markedCall(target, () => core.maintenanceRunCall(session, request, ctx, { late: after.late }));
      } catch (error) {
        throw answers.answer("maintenance run", error);
      }
      if (record.kind === "refused") {
        const error = refusalError(record, view);
        // Refused after the call: the session ran, and the core refused its answer (`checkMaintenanceRunAnswer`), so it
        // is thrown as the run's failure, which the route audits as a run, never answered as one not sent.
        if (record.called) throw answers.answer("maintenance run", error);
        return { kind: "not-sent", error };
      }
      if (record.kind === "stopped") {
        // The engine may still complete the run the route audits as an unknown outcome: its answer is logged.
        after.answeredAfter(record.settled);
        return { kind: "stopped", error: stopError(record.reason, view) };
      }
      return { kind: "answered", result: record.answer };
    },
    preview: async (operation, path) => {
      const core = hostCore();
      const request: MaintenancePreviewRequest = { operation, path: [...path] };
      const { session, view, ctx, after } = callOf("preview");
      try {
        const record = await markedCall(target, () =>
          core.maintenancePreviewCall(session, request, ctx, { late: after.late }),
        );
        if (record.kind === "refused") throw refusalError(record, view);
        if (record.kind === "stopped") throw stopError(record.reason, view);
        return record.answer;
      } catch (error) {
        throw answers.answer("maintenance preview", error);
      }
    },
  };
}
