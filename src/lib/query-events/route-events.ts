/**
 * The query events of the routes that run statements (docs/GOVERNANCE.md#query-events): what a route knows about a
 * request and a unit, turned into the `QueryEventInput` that `recordQueryEvent()` records under governance and ignores
 * without it.
 *
 * A route makes one `QueryEventRequest` per request, then records each unit that ran with `recordExecutedUnit()`, or
 * the request Studio turned away before anything ran with `recordRefusedRequest()`. Every function here only reads
 * what the route already holds and never throws, so recording cannot change an answer.
 */
import { clientAddress } from "@/lib/api/client-address";
import type { Role } from "@/lib/auth";
import { isDatabaseError, isQueryCancelledError } from "@/lib/db/errors";
import type { GovernedConnection } from "@/lib/governance/visible";
import type { DatabaseConnection } from "@/lib/types";
import { contractConnectionId } from "./build";
import { recordQueryEvent } from "./sink";
import type { QueryEventConnection, QueryEventPrincipal, QueryEventSource, QueryEventStart } from "./types";

/** What every event of one request shares: the surface, who asked and from where. */
export interface QueryEventRequest {
  readonly source: QueryEventSource;
  readonly principal: QueryEventPrincipal;
  readonly clientIp: string;
}

/** The events of one request on `source` by `session`. */
export function queryEventRequest(
  source: QueryEventSource,
  session: { readonly role: Role; readonly username: string; readonly idpSubject?: string },
  request: { readonly headers: Headers },
): QueryEventRequest {
  return {
    source,
    // Under governance every session that reaches a route carries its subject (src/lib/local-accounts.ts), and the
    // builder refuses an empty one, so a session without it is logged as a defect rather than recorded unnamed.
    principal: { subject: session.idpSubject ?? "", username: session.username, role: session.role },
    clientIp: clientAddress(request),
  };
}

/**
 * The id a request names its connection by, the way `resolveConnection()` reads it: `connectionId`, else the `seed:`
 * id an inline record claims.
 */
export function requestedConnectionId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { connectionId, connection } = body as { connectionId?: unknown; connection?: { id?: unknown } };
  if (typeof connectionId === "string") return connectionId;
  const claimed = typeof connection === "object" && connection !== null ? connection.id : undefined;
  return typeof claimed === "string" ? claimed : undefined;
}

/** A resolved connection as its events name it: a governed record carries the level of its credential. */
function resolvedConnection(connection: DatabaseConnection): QueryEventConnection {
  const { grantLevel } = connection as Partial<Pick<GovernedConnection, "grantLevel">>;
  return { id: connection.id, name: connection.name, engine: connection.type, accessLevel: grantLevel ?? null };
}

/** The SQLSTATE the driver reported, else the code the error carries, such as an API code. */
function errorCode(error: unknown): string | undefined {
  if (isDatabaseError(error) && error.sqlstate !== undefined) return error.sqlstate;
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** A count the builder accepts, a whole number from 0, or none: a driver reports -1 or nothing when it has none. */
function rowCount(count: number | undefined): number | undefined {
  return count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/** One unit that ran: the connection it ran on, the text the user submitted for it and how it ended. */
export interface ExecutedUnit {
  readonly connection: DatabaseConnection;
  /** The text the user submitted, never the statement Studio built around it. */
  readonly statement: string | null;
  readonly started: QueryEventStart;
  /** Its rows when it succeeded, or what it threw when it failed or was cancelled. */
  readonly ended: { readonly rowCount: number | undefined } | { readonly error: unknown };
  readonly explain?: "estimate" | "analyze";
  readonly unitIndex?: number;
  readonly correlationId?: string;
}

/** Records one unit that ran: `success` with its rows, `cancelled` for a cancel, and `error` for any other failure. */
export function recordExecutedUnit(request: QueryEventRequest, unit: ExecutedUnit): void {
  const { ended } = unit;
  const outcome =
    "error" in ended
      ? {
          status: isQueryCancelledError(ended.error) ? ("cancelled" as const) : ("error" as const),
          errorCode: errorCode(ended.error),
          errorMessage: ended.error instanceof Error ? ended.error.message : String(ended.error),
        }
      : { status: "success" as const, rowCount: rowCount(ended.rowCount) };
  recordQueryEvent({
    source: request.source,
    principal: request.principal,
    clientIp: request.clientIp,
    connection: resolvedConnection(unit.connection),
    statement: unit.statement,
    started: unit.started,
    explain: unit.explain,
    unitIndex: unit.unitIndex,
    correlationId: unit.correlationId,
    ...outcome,
  });
}

/** One request Studio turned away before anything ran. */
export interface RefusedRequest {
  /** The id the request named, for a request refused before its connection resolved. */
  readonly requestedId: string | undefined;
  /** The resolved connection, for a request the admission gate refused. */
  readonly connection: DatabaseConnection | undefined;
  readonly statement: string | null;
  readonly started: QueryEventStart;
  /** The refusal, whose code the event records. */
  readonly error: unknown;
}

/**
 * Records one `refused` event: with the resolved connection's engine and level when the admission gate refused, and
 * with neither when the connection did not resolve. A request that names no well-formed `seed:` id leaves no row,
 * because no row can be made without the connection it names.
 */
export function recordRefusedRequest(request: QueryEventRequest, refused: RefusedRequest): void {
  let connection: QueryEventConnection;
  if (refused.connection !== undefined) {
    connection = resolvedConnection(refused.connection);
  } else {
    const id = refused.requestedId;
    if (id === undefined || contractConnectionId(id) === null) return;
    connection = { id, name: null, engine: null, accessLevel: null };
  }
  recordQueryEvent({
    source: request.source,
    principal: request.principal,
    clientIp: request.clientIp,
    connection,
    statement: refused.statement,
    started: refused.started,
    status: "refused",
    errorCode: errorCode(refused.error),
  });
}
