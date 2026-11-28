import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { scrubMaintenanceResult } from "@/lib/db/operations/provider-text";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import { maintenanceControl, type MaintenancePlacement } from "@/lib/db/types";
import { auditRoleDenial, guardRoute, adminRequiredResponse } from "@/lib/api/require-session";
import { handleMaintenanceRequest, type MaintenanceRouteForm } from "@/lib/api/maintenance-route";
import { type MaintenanceRunOutcome, providerMaintenance } from "@/lib/api/provider-maintenance";
import { type EngineConnection, legacyProviderType } from "@/lib/db/server-catalog";
import { QueryCancelledError } from "@/lib/db/errors";
import { clientAddress } from "@/lib/api/client-address";
import { ApiErrorCode } from "@/lib/api/error-codes";
import type { UserPayload } from "@/lib/auth";
import type { GovernedConnection } from "@/lib/governance/visible";
import { admitQueryExecution } from "@/lib/query-events/admission";
import { queryEventStart } from "@/lib/query-events/build";
import { recordQueryEvent } from "@/lib/query-events/sink";
import type { QueryEventInput, QueryEventStatus } from "@/lib/query-events/types";
import { logger } from "@/lib/logger";

const ROUTE = "POST /api/db/maintenance";

/**
 * The run's form of the shared path: a `target` text or absent, an empty one the whole-database form, so no provider is
 * sent empty text; a kill on the record's metadata session.
 */
const RUN: MaintenanceRouteForm<string | undefined> = {
  route: ROUTE,
  errorRoute: "api/db/maintenance",
  readTarget: (target) =>
    target !== undefined && typeof target !== "string"
      ? { refusal: `"target" must be a string naming the object to run against` }
      : { target: target || undefined },
  killOnMetadata: true,
};

/**
 * Runs one maintenance operation, for an admin, on any engine the server serves: a legacy provider's bridged session or
 * a provider package's own (docs/providers/CONTRACT.md, clause C-107). The request is checked in this order, and
 * nothing is run or recorded for a request refused on the way: the guard and the admin check; the checks the preview
 * shares, in `handleMaintenanceRequest` (src/lib/api/maintenance-route.ts): a JSON object body; the connection and the
 * record of its engine (`resolveServedConnection`); `type` present and text; `container` and `target` text or absent;
 * the operation listed in the record's maintenance, before any session opens (`400 FACET_NOT_OFFERED`, outcome
 * not-sent); a catalog the record does not offer, refused by name before any open (clause C-111); then, on the opened
 * session, the operation its server accepts (the same code and outcome, before any call); and the placement its spec
 * declares.
 *
 * The run goes through the host core (docs/providers/CONTRACT.md, clause C-70): after those checks the route builds the
 * opening's target, which for a legacy provider reads its declarations as the query route reads them, and runs the
 * operation through `providerMaintenance` on the session's maintenance, a legacy provider's declaration narrowed by
 * what the connected provider accepts or a package's narrowed maintenance, until the statement timeout plus ten
 * seconds and until the request leaves. A run the host refused before the call, or failed before it by an error the
 * host raised, reached no provider and writes no audit row; a run Studio stopped waiting for is audited as an unknown
 * outcome, since the engine may still complete it, and answers 499 or 504 with outcome unknown. Each row names the
 * engine user the session acts as, where it names one (clause C-67).
 *
 * A kill runs on the record's metadata session (clause C-66), in the request's catalog, opened under the same editor
 * posture and checks, so it never waits behind the editor's statements; every other operation runs on the editor's
 * session. A package's failure, of its open or of the run, is answered and logged once through the request's
 * `PackageAnswers` (clause C-112), and the run's sentence reaches the client under the record's grant of its words.
 */
export async function POST(request: Request) {
  // Session, rate limit and denial audit share the same door as every other provider-reaching
  // route, on the "query" bucket: an admin session is still one identity, and a stolen or
  // careless one hammering maintenance operations is the exact threat this guard exists to stop.
  // Authentication now yields 401 (was folded into a blanket 403 before); role is checked
  // separately below so "no session" and "wrong role" stay distinguishable, matching every
  // other guarded route's contract.
  const guard = await guardRoute({ route: ROUTE, bucket: "query", request });
  if ("response" in guard) return guard.response;

  if (guard.session.role !== "admin") {
    auditRoleDenial({ route: ROUTE, user: guard.session.username, request });
    return adminRequiredResponse();
  }

  return await handleMaintenanceRequest(request, guard.session, RUN, async (served) => {
    const { connection, engine, type, target, container: requestedContainer, answers, words } = served;
    const capabilities = served.accepted;

    // The session's `maintenanceOperations`, checked on the shared path, says only that the
    // operation EXISTS here. What KIND of target it takes is a separate declaration - `maintenanceOperationSpecs` - and until
    // U20 this route never read it, while both UI surfaces gated on it. The gap is the one
    // the U20 backlog entry reports from a live SQLite run: POST {type:"vacuum",
    // target:"users"} answered 200 and vacuumed the whole file, which is exactly the reading
    // `vacuum: { perEntity: false }` exists to withhold. What THIS change measured is
    // narrower and should not be read as that run repeated: the status code only, against
    // SQLite-SHAPED mock capabilities rather than a live engine - the request that answered
    // 200 now answers 400 and never reaches `runMaintenance`. `maintenanceControl` is asked
    // here rather than the spec read directly so the route cannot disagree with the two
    // surfaces about what a provider declared.
    //
    // A non-empty `target` is the "perEntity" request and its absence the "global" one - the
    // same reading the audit row below uses (`target ?? "all"`), and `RUN` reads `target: ""`
    // as absent, so it is a whole-database request, not an unnamed object.
    //
    // Both halves false is NOT "takes no target": every provider that declares `kill`
    // declares it false/false because its target is a session or query id, which neither a
    // table row nor a whole-database card can supply. The gate therefore only speaks when the
    // provider claimed at least one of the two placements it describes; otherwise the target
    // comes from somewhere this field says nothing about and the request passes through.
    //
    // The `labels.vacuumActionOperation` redirect is deliberately NOT honoured here. It is a
    // wording concern: it says which operation a provider's *vacuum* copy names, and both
    // callers (`TableItem`, `OperationsTab`) resolve it before sending - the request carries
    // the resolved operation id, never the literal `vacuum`. Rewriting a caller's stated
    // operation into a different one is the opposite of what a gate does, and it would make
    // the shared path's `FACET_NOT_OFFERED` refusal unreachable for exactly the four providers
    // whose vacuum wording names something else.
    const placement: MaintenancePlacement = target ? "perEntity" : "global";
    const perEntityControl = maintenanceControl(capabilities, type, "perEntity");
    const globalControl = maintenanceControl(capabilities, type, "global");
    const requestedControl = placement === "perEntity" ? perEntityControl : globalControl;

    if (!requestedControl.offered && (perEntityControl.offered || globalControl.offered)) {
      // Exactly one placement is available here (the other is the refused one), so the
      // message can name what the operation does accept, in the provider's own wording.
      //
      // The `??` is defensive against untyped capabilities, not a reachable path: entering
      // this branch requires a spec to exist for `type` - with no spec `maintenanceControl`
      // reports BOTH placements offered, so neither half of the condition holds - and
      // `MaintenanceOperationSpec.label` is a required string, so any provider that went
      // through the type carries a name here. The fallback stands only for a capabilities
      // object that reached this route without doing so, where inventing a name would put a
      // word the engine does not use in front of an operator.
      const name = requestedControl.label ?? `Operation '${type}'`;
      const error =
        placement === "perEntity"
          ? `${name} takes no target on this database: it runs over the whole database. Omit 'target'.`
          : `${name} requires a target on this database: it runs against one object at a time.`;
      return NextResponse.json({ error }, { status: 400 });
    }

    // The target the run is made on, built only now the checks above passed: a legacy provider's reads its
    // maintenance as declared before it connects, as the query route reads it, under the session's editor posture.
    const runTarget = await served.opened.target();
    const maintenance = providerMaintenance(runTarget, answers, request.signal);

    // The engine principal the session acts as, where it names one (spec 3.11, clause C-67): a user name, never any part
    // of a secret, so it is recorded beside the Studio user on every row below.
    const engineUser = runTarget.engineUser();

    // The fields every row of this run shares, built once so the completed row and the thrown row
    // cannot disagree about which operation was run against what.
    const auditFields = {
      type: type === "kill" ? "kill_session" : "maintenance",
      action: type.toUpperCase(),
      target: target ?? "all",
      // The container the request named, omitted when it named none. `app.orders` and
      // `public.orders` recorded identically while this row carried only `target`, and an
      // operator reconstructing what was done to a database could not tell the two apart
      // (#1091 review). Optional on the EVENT the way `reason` and `bucket` are, so a
      // whole-database row does not grow a field claiming a container it never had.
      container: requestedContainer,
      connectionName: connection.name || connection.database || "unknown",
      user: guard.session.username || "admin",
      // Omitted, not undefined, for a session that names no engine principal, so its rows keep their shape.
      ...(engineUser === undefined ? {} : { engineUser }),
    } as const;

    // The query event of this action (docs/GOVERNANCE.md, "Query events"), recorded under governance only. The
    // admission gate runs before the action reaches the engine, so a refused action runs nothing and leaves one
    // `refused` event. The statement is null: the provider builds it inside `runMaintenance` and never returns it.
    const started = queryEventStart();
    const recordMaintenanceEvent = (status: QueryEventStatus, errorCode?: string) =>
      recordQueryEvent(maintenanceEvent(guard.session, connection, request, started, status, errorCode));
    try {
      admitQueryExecution();
    } catch (error) {
      recordMaintenanceEvent("refused", ApiErrorCode.AUDIT_UNAVAILABLE);
      throw error;
    }

    const startTime = Date.now();
    let outcome: MaintenanceRunOutcome;
    try {
      outcome = await maintenance.run(type, target, requestedContainer);
    } catch (error) {
      recordMaintenanceEvent("error");
      // A run that THREW is still a run: it may have reached the engine before it failed, and
      // until #1091's review recorded the gap (R04 G8) it left no row at all. The row takes the
      // closed reason `maintenance_execution_failed` and never the thrown message, which
      // `emitAuditEvent`'s docblock forbids by name. It is isolated for the same reason as the
      // completed row below: a broken sink must not replace the operation's own failure with its
      // own, so the caller reads exactly what the thrown error maps to, as it did before this row.
      try {
        emitAuditEvent({
          ...auditFields,
          result: "failure",
          reason: "maintenance_execution_failed",
          duration: Date.now() - startTime,
        });
      } catch (auditError) {
        logger.error("Failed to record maintenance audit event", auditError, { route: ROUTE });
      }
      // The driver's error, typed (#1387). A provider hands the engine's refusal on as the driver
      // raised it, and the outer catch read every untyped error as Studio's own failure: an engine
      // that refuses the statement (CockroachDB's `VACUUM` syntax error, TiDB's `CHECK TABLE`)
      // answered 500 INTERNAL_ERROR. Mapped here, a refusal the driver codes as the statement's
      // own fault answers 400 with the engine's sentence, and anything else keeps a 5xx. A provider
      // package's failure is already the request's answer of it (`PackageAnswers`), never mapped.
      const legacyType = legacyProviderType(engine);
      throw legacyType === undefined ? error : mapDatabaseError(error, legacyType);
    }
    // A run that ended without the provider's answer is Studio's own error, answered as the accessor built it and
    // never mapped as the engine's: a caller that left is `cancelled`, every other end an `error`.
    if (outcome.kind !== "answered") {
      recordMaintenanceEvent(outcome.error instanceof QueryCancelledError ? "cancelled" : "error");
    }
    // Refused, or failed by an error the host raised, before the call: nothing reached the provider, so no maintenance
    // row is written.
    if (outcome.kind === "not-sent") throw outcome.error;
    if (outcome.kind === "stopped") {
      // Studio stopped waiting while the provider ran: the engine may still complete the operation, so the row records
      // an unknown outcome and the time waited, never a failure the engine answered. Isolated as the rows below are.
      try {
        emitAuditEvent({
          ...auditFields,
          result: "failure",
          reason: "maintenance_outcome_unknown",
          duration: Date.now() - startTime,
        });
      } catch (auditError) {
        logger.error("Failed to record maintenance audit event", auditError, { route: ROUTE });
      }
      throw outcome.error;
    }
    const result = outcome.result;
    const duration = Date.now() - startTime;
    // The engine's verdict, read as the audit row below reads it.
    recordMaintenanceEvent(result.success === false ? "error" : "success");

    // Isolated in its own try/catch: runMaintenance() above has already succeeded and its result
    // is already decided by the time this runs, so a broken audit sink must never turn a
    // completed maintenance operation into a 500 that invites the client to retry it - the shared
    // path's catch is for failures of the operation itself, not for failures to record it.
    try {
      emitAuditEvent({
        ...auditFields,
        // The engine's verdict, not the request's. `runMaintenance` resolving is only the
        // statement having reached the engine: since 2026-08-25 MySQL and Oracle read the
        // server's own answer, so `success: false` on a 200 is the ordinary reply for a
        // target the engine would not touch - and recording that as a completed operation
        // is worse than not recording it, because this log is where an operator
        // reconstructs what was done to a database. A provider that reports no verdict
        // keeps the old reading: only an explicit `false` is a failure.
        result: result.success === false ? "failure" : "success",
        duration,
      });
    } catch (auditError) {
      logger.error("Failed to record maintenance audit event", auditError, { route: ROUTE });
    }

    // The message is the engine's sentence, answered under the record's grant of its words: through the connection's
    // scrub, or Studio's sentence where no register row grants a package its words; the verdict above reads
    // `success`, which neither changes.
    return NextResponse.json(scrubMaintenanceResult(words, result));
  });
}

/**
 * The query event of one maintenance action: an administrator's action on the connection this request resolved. Under
 * governance the connection is a governed record, which carries the level of its credential, and the session carries
 * the identity provider subject its grant names.
 */
function maintenanceEvent(
  session: UserPayload,
  connection: EngineConnection,
  request: Request,
  started: QueryEventInput["started"],
  status: QueryEventStatus,
  errorCode: string | undefined,
): QueryEventInput {
  return {
    source: "maintenance",
    principal: { subject: session.idpSubject ?? "", username: session.username, role: session.role },
    connection: {
      id: connection.id,
      name: connection.name,
      engine: connection.type,
      accessLevel: (connection as Partial<GovernedConnection>).grantLevel ?? null,
    },
    statement: null,
    status,
    started,
    errorCode,
    clientIp: clientAddress(request),
  };
}
