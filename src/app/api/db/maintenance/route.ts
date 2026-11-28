import { NextResponse } from "next/server";
import { type MaintenanceOperation, readProviderDeclarations } from "@/lib/db";
import { emitAuditEvent } from "@/lib/audit";
import { createErrorResponse } from "@/lib/api/errors";
import { type ProviderTextScrub, providerTextScrub, scrubMaintenanceResult } from "@/lib/db/operations/provider-text";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import { maintenanceControl, type MaintenancePlacement } from "@/lib/db/types";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { auditRoleDenial, guardRoute, adminRequiredResponse } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { editorProvider, metadataProvider } from "@/lib/api/editor-provider";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { packageAnswers } from "@/lib/api/package-errors";
import { type MaintenanceRunOutcome, providerMaintenance } from "@/lib/api/provider-maintenance";
import { providerMaintenanceTarget } from "@/lib/api/session-target";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import { QueryCancelledError } from "@/lib/db/errors";
import { assertMaintenanceAccepted, assertMaintenanceOffered } from "@/lib/db/engine-facets/maintenance";
import { clientAddress } from "@/lib/api/client-address";
import { ApiErrorCode } from "@/lib/api/error-codes";
import type { UserPayload } from "@/lib/auth";
import type { GovernedConnection } from "@/lib/governance/visible";
import { admitQueryExecution } from "@/lib/query-events/admission";
import { queryEventStart } from "@/lib/query-events/build";
import { recordQueryEvent } from "@/lib/query-events/sink";
import type { QueryEventInput, QueryEventStatus } from "@/lib/query-events/types";
import type { DatabaseConnection } from "@/lib/types";
import { logger } from "@/lib/logger";

/**
 * Runs one maintenance operation, for an admin. The request is checked in this order, and nothing is run or recorded
 * for a request refused on the way: the guard and the admin check; a JSON object body; the connection; `type`
 * present and text; `container` and `target` text or absent; the operation listed in the `maintenance` of the
 * engine's `ENGINE_FACETS` row, before any provider is built (`400 FACET_NOT_OFFERED`); then, on the connected
 * provider, the operation the server accepts (the same code) and the placement its spec declares.
 *
 * The run goes through the host core (docs/providers/CONTRACT.md, clause C-70): after those checks the route reads the
 * provider's declarations, as the query route reads them, and runs the operation through `providerMaintenance` on the
 * session's maintenance, the declaration narrowed by what the connected provider accepts, until the statement timeout
 * plus ten seconds and until the request leaves. A run the host refused before the call, or failed before it by an
 * error the host raised, reached no provider and writes no audit row; a run Studio stopped waiting for is audited as
 * an unknown outcome, since the engine may still complete it, and answers 499 or 504 with outcome unknown.
 *
 * A kill runs on the connection's metadata session (clause C-66), in the request's catalog, opened under the same
 * editor posture and checks, so it never waits behind the editor's statements; every other operation runs on the
 * editor's provider.
 */
export async function POST(request: Request) {
  // Session, rate limit and denial audit share the same door as every other provider-reaching
  // route, on the "query" bucket: an admin session is still one identity, and a stolen or
  // careless one hammering maintenance operations is the exact threat this guard exists to stop.
  // Authentication now yields 401 (was folded into a blanket 403 before); role is checked
  // separately below so "no session" and "wrong role" stay distinguishable, matching every
  // other guarded route's contract.
  const guard = await guardRoute({ route: "POST /api/db/maintenance", bucket: "query", request });
  if ("response" in guard) return guard.response;

  if (guard.session.role !== "admin") {
    auditRoleDenial({ route: "POST /api/db/maintenance", user: guard.session.username, request });
    return adminRequiredResponse();
  }

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
  try {
    // A body that is not JSON, or JSON that is not an object (`null`, an array, a number), is the caller's mistake and
    // answers 400 in a fixed sentence, rather than reaching the destructuring below as a raw runtime error.
    const body = await request.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const { type, target, container } = body;

    const connection = await resolveConnection(body, guard.session);
    scrub = providerTextScrub(connection, "any");

    if (!type) {
      return NextResponse.json({ error: "Maintenance type is required" }, { status: 400 });
    }

    // A `type` that is not text names no operation, and the refusal below quotes the operation, so it is answered here
    // in a fixed sentence that repeats nothing of the value.
    if (typeof type !== "string") {
      return NextResponse.json({ error: `"type" must be a string naming a maintenance operation` }, { status: 400 });
    }

    // `container` is the row's `schemaName`: a string naming the container the target lives in,
    // or absent for a request that names none. A non-string one is a malformed request, and it
    // is answered HERE rather than allowed through to a provider, where the first use - an
    // `identifier.replace` - threw a TypeError and the client read a 500 for a request this
    // route could have refused by reading the field's type (#1091 review). Nothing is opened
    // and nothing is run for it.
    if (container !== undefined && typeof container !== "string") {
      return NextResponse.json(
        { error: `"container" must be a string naming the target's container` },
        { status: 400 },
      );
    }

    // `target` is the same kind of field: a string naming the object the operation runs against,
    // or absent for the whole-database form. A non-string one reached the provider, where a number
    // failed as `identifier.replace is not a function` and the client read a 500 quoting provider
    // source, and the audit row below recorded the serialized value. It is refused here, before
    // any provider opens and before any audit row.
    if (target !== undefined && typeof target !== "string") {
      return NextResponse.json(
        { error: `"target" must be a string naming the object to run against` },
        { status: 400 },
      );
    }

    // An EMPTY string reads as the absence of a container, the same way an empty `target` reads
    // as the whole-database form below. Nothing here may hand a provider a value that its own
    // falsy test would have refused anyway, because the audit row below records what arrived.
    const requestedContainer: string | undefined = container || undefined;
    // The same reading for `target`: an empty one is the whole-database form, so no provider is sent empty text.
    const requestedTarget: string | undefined = target || undefined;

    // The engine facets row (FND-4), read before any provider is built: an operation the engine does not offer is
    // refused 400 FACET_NOT_OFFERED by name, and no provider, SSH tunnel or connection is opened for it.
    assertMaintenanceOffered(servedEngineRecord(connection.type), type);

    // A kill runs on the connection's metadata session (docs/providers/CONTRACT.md, clause C-66), so it never waits for
    // a connection the editor's statements hold; every other operation runs on the editor's provider.
    const catalog = requestCatalog(body);
    const provider =
      type === "kill"
        ? await metadataProvider(guard.session, connection, catalog)
        : await editorProvider(guard.session, connection, catalog);
    const capabilities = provider.getCapabilities();

    // The connected server may accept fewer operations than its engine's row (PostgreSQL and MySQL narrow at
    // connect), so the provider's own declaration is read again, and a refusal answers the same code.
    assertMaintenanceAccepted(servedEngineRecord(connection.type), type, capabilities);

    // `maintenanceOperations` above says only that the operation EXISTS here. What KIND of
    // target it takes is a separate declaration - `maintenanceOperationSpecs` - and until
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
    // same reading the audit row below already uses (`target || "all"`), so `target: ""` is a
    // whole-database request, not an unnamed object.
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
    // the `FACET_NOT_OFFERED` refusal above unreachable for exactly the four providers
    // whose vacuum wording names something else.
    const placement: MaintenancePlacement = target ? "perEntity" : "global";
    const perEntityControl = maintenanceControl(capabilities, type as MaintenanceOperation, "perEntity");
    const globalControl = maintenanceControl(capabilities, type as MaintenanceOperation, "global");
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

    // The provider's maintenance as declared before it connects, read as the query route reads it, under the session's
    // editor posture: the session's maintenance is this declaration narrowed by what the connected provider accepts.
    const { capabilities: declared } = await readProviderDeclarations(
      connection,
      editorExecutionContext(guard.session, connection),
    );
    const maintenance = providerMaintenance(
      providerMaintenanceTarget(provider, declared),
      packageAnswers(servedEngineRecord(connection.type), scrub, "POST /api/db/maintenance"),
      request.signal,
    );

    // The engine principal this connection acts as, for a provider that can name one (spec 3.11): a user name, never
    // any part of a secret, so it is recorded beside the Studio user on every row below.
    const engineUser = provider.engineUser?.();

    // The fields every row of this run shares, built once so the completed row and the thrown row
    // cannot disagree about which operation was run against what.
    const auditFields = {
      type: type === "kill" ? "kill_session" : "maintenance",
      action: type.toUpperCase(),
      target: target || "all",
      // The container the request named, omitted when it named none. `app.orders` and
      // `public.orders` recorded identically while this row carried only `target`, and an
      // operator reconstructing what was done to a database could not tell the two apart
      // (#1091 review). Optional on the EVENT the way `reason` and `bucket` are, so a
      // whole-database row does not grow a field claiming a container it never had.
      container: requestedContainer,
      connectionName: connection.name || connection.database || "unknown",
      user: guard.session.username || "admin",
      // Omitted, not undefined, for a provider that names no engine principal, so its rows keep their shape.
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
      outcome = await maintenance.run(type as MaintenanceOperation, requestedTarget, requestedContainer);
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
        logger.error("Failed to record maintenance audit event", auditError, { route: "POST /api/db/maintenance" });
      }
      // The driver's error, typed (#1387). A provider hands the engine's refusal on as the driver
      // raised it, and the outer catch read every untyped error as Studio's own failure: an engine
      // that refuses the statement (CockroachDB's `VACUUM` syntax error, TiDB's `CHECK TABLE`)
      // answered 500 INTERNAL_ERROR. Mapped here, a refusal the driver codes as the statement's
      // own fault answers 400 with the engine's sentence, and anything else keeps a 5xx.
      throw mapDatabaseError(error, connection.type);
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
        logger.error("Failed to record maintenance audit event", auditError, { route: "POST /api/db/maintenance" });
      }
      throw outcome.error;
    }
    const result = outcome.result;
    const duration = Date.now() - startTime;
    // The engine's verdict, read as the audit row below reads it.
    recordMaintenanceEvent(result.success === false ? "error" : "success");

    // Isolated in its own try/catch: runMaintenance() above has already succeeded and its result
    // is already decided by the time this runs, so a broken audit sink must never turn a
    // completed maintenance operation into a 500 that invites the client to retry it - the outer
    // catch below is for failures of the operation itself, not for failures to record it.
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
      logger.error("Failed to record maintenance audit event", auditError, { route: "POST /api/db/maintenance" });
    }

    // The message is the provider's sentence, answered through the connection's scrub; the verdict above reads
    // `success`, which the scrub keeps.
    return NextResponse.json(scrubMaintenanceResult(scrub, result));
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/maintenance", scrub });
  }
}

/**
 * The query event of one maintenance action: an administrator's action on the connection this request resolved. Under
 * governance the connection is a governed record, which carries the level of its credential, and the session carries
 * the identity provider subject its grant names.
 */
function maintenanceEvent(
  session: UserPayload,
  connection: DatabaseConnection,
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
