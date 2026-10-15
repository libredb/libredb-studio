/**
 * One unit a route runs under the query event record (docs/GOVERNANCE.md#query-events): the admission gate before it,
 * and one event after.
 *
 * `runRecorded()` asks `admitQueryExecution()` before the unit runs, so with `queryLog.onSinkFailure` at `refuse` a
 * sink that cannot record turns the request away before anything reaches the database, and records that refusal as
 * one `refused` event. Otherwise it runs the unit and records one event with the status it ended in: `success`,
 * `cancelled` for a cancelled statement, else `error`, with the error's code. The unit's own answer or error reaches
 * the caller unchanged.
 *
 * Outside governance the gate never refuses and `recordQueryEvent()` does nothing, so a route answers exactly as it
 * did before it ran its unit through here.
 */
import type { UserPayload } from "@/lib/auth";
import { isQueryCancelledError } from "@/lib/db/errors";
import type { GovernedConnection } from "@/lib/governance/visible";
import type { DatabaseConnection } from "@/lib/types";
import { admitQueryExecution } from "./admission";
import { queryEventStart } from "./build";
import { recordQueryEvent } from "./sink";
import type { QueryEventInput, QueryEventSource, QueryEventStatus, StatementType } from "./types";

/** What a route says about the unit it runs, besides the unit itself. */
export interface RecordedUnit {
  readonly source: QueryEventSource;
  /** The session the request was authorised as. */
  readonly session: Readonly<Pick<UserPayload, "role" | "username" | "idpSubject">>;
  /** The connection as the route resolved it: under governance a governed record, which carries its grant level. */
  readonly connection: DatabaseConnection;
  /** The text the event records, which the capture mode reads like any statement. */
  readonly statement: string;
  readonly statementType: StatementType;
}

/** The `code` an error carries, such as an API code or a driver's code, when it is text. */
function codeOf(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Runs `run` behind the admission gate and records one event of `unit` for it, with the row count `rowCount` reads
 * of a successful result when given. Throws what the gate or the unit threw, after recording it.
 */
export async function runRecorded<T>(
  unit: RecordedUnit,
  run: () => Promise<T>,
  rowCount?: (result: T) => number,
): Promise<T> {
  const started = queryEventStart();
  const { session, connection } = unit;
  const record = (status: QueryEventStatus, outcome: Partial<QueryEventInput>): void => {
    recordQueryEvent({
      source: unit.source,
      // Every governed session carries the identity provider subject, since only an OIDC session holds a grant; an
      // empty one is refused by the builder, which logs it, rather than recorded under a subject nobody holds.
      principal: { subject: session.idpSubject ?? "", username: session.username, role: session.role },
      connection: {
        id: connection.id,
        name: connection.name,
        engine: connection.type,
        accessLevel: (connection as Partial<GovernedConnection>).grantLevel ?? null,
      },
      statement: unit.statement,
      statementType: unit.statementType,
      status,
      started,
      ...outcome,
    });
  };

  try {
    admitQueryExecution();
  } catch (error) {
    record("refused", { errorCode: codeOf(error) });
    throw error;
  }

  let result: T;
  try {
    result = await run();
  } catch (error) {
    record(isQueryCancelledError(error) ? "cancelled" : "error", {
      errorCode: codeOf(error),
      errorMessage: messageOf(error),
    });
    throw error;
  }
  record("success", rowCount === undefined ? {} : { rowCount: rowCount(result) });
  return result;
}
