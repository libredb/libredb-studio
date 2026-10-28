/**
 * The agent read-only execution profile's boundary on libSQL, proven at the open of a connection that will send
 * statements.
 *
 * The boundary is the credential's: a token the server marks read-only (`"a": "ro"` in a JWT a self-hosted sqld checks
 * against `SQLD_AUTH_JWT_KEY`, or a token Turso mints with `--read-only`). sqld classifies every statement before it
 * runs it and refuses a write from such a token for the whole request with HTTP 403 ("Authorization forbidden"), on
 * every HTTP statement route, so the refusal does not depend on how the statement is spelled (all measured on
 * sqld 0.24.33): `INSERT ... RETURNING`, a `WITH ... DELETE`, `REINDEX`, `PRAGMA user_version = 5` and a write inside a
 * batch, a sequence or a stored statement all answered 403, and the table read back the same. `PRAGMA query_only`, the
 * lever the SQLite provider uses, is refused by the server for every credential, so the token is the only lever.
 *
 * The open proves it with the server's own answer rather than by reading the token, whose claims Studio cannot verify:
 *
 * 1. **The connection sends a bearer token** (`assertAgentConnection`). A user name and password go as HTTP Basic,
 *    which sqld grants every statement (`SQLD_HTTP_AUTH`) and has no read-only form for, and a connection with no
 *    token reaches only a server that checks no credential; both are refused before anything is sent.
 * 2. **The server refuses a write sent with that token** (`verifyAgentProfile`). `DROP TABLE IF EXISTS` on a name made
 *    fresh for the open changes nothing on any outcome, since no table holds the name, and sqld classifies it as a
 *    write: a read-only token is answered 403, a writable token and a server with no credential check run it
 *    (measured). Only a 403 admits the profile; any other answer refuses it, fail closed.
 */
import { randomUUID } from "node:crypto";
import { ExecutionProfileError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/db/types";
import { type LibSQLStatementResult, LibSQLTransportError } from "./transport";

/** Runs one statement with the agent's token and answers it, or throws the seam's error. */
export type AgentProofExecute = (sql: string) => Promise<LibSQLStatementResult>;

/**
 * The status sqld answers a request carrying a write with when the token is read-only, for the whole request. The
 * provider's statement path reads it too, as the boundary refusing a statement rather than a credential that failed.
 */
export const WRITE_FORBIDDEN_STATUS = 403;

/** A table name made fresh for one open, so the probe's `DROP TABLE IF EXISTS` can never find a table to drop. */
export function probeTableName(): string {
  return `libredb_agent_probe_${randomUUID().replaceAll("-", "")}`;
}

/**
 * Refuses a connection whose credential cannot be a read-only token: a user name, which the transport sends as HTTP
 * Basic, or no token at all. An empty user is no user, as the transport reads it.
 */
export function assertAgentConnection(connection: DatabaseConnection): void {
  if (connection.user) {
    throw new ExecutionProfileError(
      "A libSQL connection that signs in with a user name and password (HTTP Basic) has no read-only form, so the agent read-only profile is refused: use a read-only token instead",
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
  if (!connection.password) {
    throw new ExecutionProfileError(
      "A libSQL connection with no token reaches only a server that checks no credential, so the agent read-only profile is refused: use a read-only token",
      "PROFILE_SERVER_UNENFORCED",
    );
  }
}

/**
 * Sends the write probe with the agent's token and admits the profile only on the 403 a read-only token is refused a
 * write with. A request that got no answer (status 0) and an error that is not the seam's leave as they are, for the
 * connect to report as the connection failure it is.
 */
export async function verifyAgentProfile(execute: AgentProofExecute, table: string = probeTableName()): Promise<void> {
  try {
    await execute(`DROP TABLE IF EXISTS "${table}"`);
  } catch (error) {
    if (!(error instanceof LibSQLTransportError) || error.status === 0) throw error;
    if (error.status === WRITE_FORBIDDEN_STATUS) return;
    throw new ExecutionProfileError(
      `libSQL answered the agent's write probe with status ${error.status} (${error.message}), not the 403 a read-only token is refused a write with, so the agent read-only profile is refused`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  throw new ExecutionProfileError(
    "libSQL ran a write sent with the agent's token, so the token is not read-only or the server checks no token, and the agent read-only profile is refused",
    "PROFILE_SERVER_UNENFORCED",
  );
}
