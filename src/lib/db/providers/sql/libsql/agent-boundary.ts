/**
 * The agent read-only execution profile's boundary on libSQL, proven at the open of a connection that will send
 * statements.
 *
 * The boundary is the credential's: a token the server marks read-only (`"a": "ro"` in a JWT a self-hosted sqld checks
 * against `SQLD_AUTH_JWT_KEY`, or a token Turso mints with `--read-only`). The marker alone is not the whole grant: sqld
 * also reads a permission claim (`"p"`), and a token carrying `"a": "ro"` with a `"p"` granting `rw` on the namespace
 * writes (measured). sqld classifies every statement before it runs it and refuses a write from a read-only token for
 * the whole request with HTTP 403 ("Authorization forbidden"), on every HTTP statement route, so the refusal does not
 * depend on how the statement is spelled (all measured on sqld 0.24.33): `INSERT ... RETURNING`, a `WITH ... DELETE`,
 * `REINDEX`, `PRAGMA user_version = 5` and a write inside a batch, a sequence or a stored statement all answered 403,
 * and the table read back the same. `PRAGMA query_only`, the
 * lever the SQLite provider uses, is refused by the server for every credential, so the token is the only lever.
 *
 * The open proves it with the server's own answers, and reads the token's claims on top of them:
 *
 * 1. **The connection sends a bearer token** (`assertAgentConnection`). A user name and password go as HTTP Basic,
 *    which sqld grants every statement (`SQLD_HTTP_AUTH`) and has no read-only form for, and a connection with no
 *    token reaches only a server that checks no credential; both are refused before anything is sent.
 * 2. **The server refuses writes sent with that token** (`verifyAgentProfile`). Three write-shaped statements on a name
 *    made fresh for the open, so no table holds it and each changes nothing on any outcome: `DROP TABLE IF EXISTS`, a
 *    `DELETE ... WHERE 0` and an `INSERT ... SELECT ... WHERE 0`. sqld classifies each as a write before it looks for
 *    the table: a read-only token is answered 403 with its authorization refusal for every one, a writable token and a
 *    server with no credential check run the first and answer the other two "no such table" (measured). Only that 403
 *    with that refusal admits a probe, a 403 with any other body included (a proxy's is not the server's), and every
 *    probe must be admitted.
 * 3. **The token declares read-only access** (`assertReadOnlyClaims`). Its JWT claims must carry `"a": "ro"` and no
 *    `"p"` claim, which could widen it; Studio cannot verify the signature, so this checks the token's own statement
 *    against the server's answers above, never instead of them.
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

/** A table name made fresh for one open, so no probe can ever find a table to drop, delete from or insert into. */
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
 * sqld's own refusal of a write from a read-only token, as the transport reports its body: `{"error": "Authorization
 * forbidden: Current session doesn't not have Write permission to namespace <name>"}` (measured on sqld 0.24.33).
 */
const AUTHORIZATION_REFUSAL = /^libSQL request failed: Authorization forbidden: /;

/** The probes, each a write on `table` that changes nothing whether it runs, fails or is refused. */
export function agentProbeStatements(table: string): readonly string[] {
  return [
    `DROP TABLE IF EXISTS "${table}"`,
    `DELETE FROM "${table}" WHERE 0`,
    `INSERT INTO "${table}" SELECT 1 WHERE 0`,
  ];
}

/**
 * Sends each probe with the agent's token and admits the profile only when the server refused every one with its own
 * authorization refusal. A request that got no answer (status 0) and an error that is not the seam's leave as they are,
 * for the connect to report as the connection failure it is.
 */
export async function verifyAgentProfile(execute: AgentProofExecute, table: string = probeTableName()): Promise<void> {
  for (const sql of agentProbeStatements(table)) {
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time: the first answer that is not a refusal ends the open.
    await assertWriteRefused(execute, sql);
  }
}

async function assertWriteRefused(execute: AgentProofExecute, sql: string): Promise<void> {
  try {
    await execute(sql);
  } catch (error) {
    if (!(error instanceof LibSQLTransportError) || error.status === 0) throw error;
    if (error.status === WRITE_FORBIDDEN_STATUS && AUTHORIZATION_REFUSAL.test(error.message)) return;
    throw new ExecutionProfileError(
      `libSQL answered the agent's write probe with status ${error.status} (${error.message}), not the authorization refusal a read-only token is refused a write with, so the agent read-only profile is refused`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  throw new ExecutionProfileError(
    `libSQL ran the write probe ${sql} sent with the agent's token, so the token is not read-only or the server checks no token, and the agent read-only profile is refused`,
    "PROFILE_SERVER_UNENFORCED",
  );
}

/** The claims a JWT carries, or null for a token that is not one this check can read. */
function jwtClaims(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Refuses a token whose claims do not declare read-only access: `"a": "ro"`, with no `"p"` permission claim, which sqld
 * reads on top of `"a"` and can grant writes with. Anything else, a token that is no JWT included, is refused, fail
 * closed.
 */
export function assertReadOnlyClaims(token: string): void {
  const claims = jwtClaims(token);
  const record = typeof claims === "object" && claims !== null ? (claims as { a?: unknown }) : {};
  if (record.a !== "ro") {
    throw new ExecutionProfileError(
      'The libSQL token does not declare read-only access (a JWT whose claims carry "a": "ro"), so the agent read-only profile is refused',
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
  if (Object.hasOwn(record, "p")) {
    throw new ExecutionProfileError(
      'The libSQL token carries a permission claim ("p"), which the server reads on top of "a": "ro" and can grant writes with, so the agent read-only profile is refused',
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
}
