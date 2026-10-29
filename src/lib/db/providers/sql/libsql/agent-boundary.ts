/**
 * The agent read-only execution profile's boundary on libSQL, proven at the open of a connection that will send
 * statements.
 *
 * The boundary is the credential's: a token the server marks read-only (`"a": "ro"` in a JWT a self-hosted sqld checks
 * against `SQLD_AUTH_JWT_KEY`, or a token Turso Cloud mints with `--read-only`). The marker alone is not the whole grant:
 * sqld also reads a permission claim (`"p"`), and a token carrying `"a": "ro"` with a `"p"` granting `rw` on the
 * namespace writes (measured). sqld classifies every statement before it runs it and refuses a write from a read-only
 * token for the whole request with HTTP 403 ("Authorization forbidden"), on every HTTP statement route, so the refusal
 * does not depend on how the statement is spelled (all measured on sqld 0.24.33): `INSERT ... RETURNING`, a
 * `WITH ... DELETE`, `REINDEX`, `PRAGMA user_version = 5` and a write inside a batch, a sequence or a stored statement
 * all answered 403, and the table read back the same. Turso Cloud refuses the same write in-band instead: the request
 * answers 200 and the statement's step carries the error, code `BLOCKED` (measured). `PRAGMA query_only`, the lever the
 * SQLite provider uses, is refused by the server for every credential, so the token is the only lever.
 *
 * The open proves it before it admits the profile, every step fail closed:
 *
 * 1. **The connection sends a bearer token** (`assertAgentConnection`). A user name and password go as HTTP Basic,
 *    which sqld grants every statement (`SQLD_HTTP_AUTH`) and has no read-only form for, and a connection with no
 *    token reaches only a server that checks no credential; both are refused before anything is sent.
 * 2. **The token declares read-only access and nothing more** (`assertReadOnlyClaims`). Its JWT claims must carry
 *    `"a": "ro"`, and every other claim must be a standard one or an id the two servers mint, since a claim the server
 *    reads beside the marker (sqld's `"p"`) can grant writes. A token that fails this is one that can write, and is
 *    refused before anything is sent with it. Studio cannot verify the signature, so this reads the token's own
 *    statement, which the server's answers below must bear out; it is never instead of them.
 * 3. **The server refuses writes sent with that token** (`verifyAgentProfile`). Three write-shaped statements on a name
 *    made fresh for the open, so no table holds it and each changes nothing on any outcome: `DROP TABLE IF EXISTS`, a
 *    `DELETE ... WHERE 0` and an `INSERT ... SELECT ... WHERE 0`. Each server classifies each as a write before it looks
 *    for the table: a read-only token is refused every one, and a writable token or a server with no credential check
 *    runs the first and answers the other two "no such table" (measured). Only one server's own read-only refusal, in
 *    its full measured wording, admits a probe, and the same one must answer every probe. A 403 with any other body (a
 *    proxy's is not the server's) and Turso's refusal of a write-blocked database, which a token that can write is
 *    answered with, refuse the profile. A probe that runs was sent with a token that declares read-only access, so the
 *    server does not hold tokens to their claims: it checks none, or admits one it did not sign.
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
 * Each server's own refusal of a write from a read-only token, as the transport reports it, in its full measured
 * wording. sqld answers 403 with `{"error": "Authorization forbidden: Current session doesn't not have Write permission
 * to namespace <name>"}` (measured on sqld 0.24.33). Turso Cloud answers 200 with the step's error, code `BLOCKED`
 * (measured); the same code with "(writes are blocked, do you need to upgrade your plan?)" in place of the session's
 * permission is Turso's answer to a token that can write on a database whose writes are blocked, and never admits.
 */
const READ_ONLY_REFUSALS: readonly {
  readonly server: string;
  readonly admits: (error: LibSQLTransportError) => boolean;
}[] = [
  {
    server: "sqld",
    admits: (error) =>
      error.status === WRITE_FORBIDDEN_STATUS &&
      /^libSQL request failed: Authorization forbidden: Current session doesn't not have Write permission to namespace \S+$/.test(
        error.message,
      ),
  },
  {
    server: "Turso Cloud",
    admits: (error) =>
      error.status === 200 &&
      error.code === "BLOCKED" &&
      error.message ===
        "Operation was blocked: SQL write operations are forbidden (current session doesn't have write permission)",
  },
];

/** The probes, each a write on `table` that changes nothing whether it runs, fails or is refused. */
export function agentProbeStatements(table: string): readonly string[] {
  return [
    `DROP TABLE IF EXISTS "${table}"`,
    `DELETE FROM "${table}" WHERE 0`,
    `INSERT INTO "${table}" SELECT 1 WHERE 0`,
  ];
}

/**
 * Sends each probe with the agent's token and admits the profile only when one server refused every one with its own
 * read-only refusal. Called once `assertReadOnlyClaims` admitted the token, so a probe that runs says the server does
 * not hold the token to its claims. A request that got no answer (status 0) and an error that is not the seam's leave
 * as they are, for the connect to report as the connection failure it is.
 */
export async function verifyAgentProfile(execute: AgentProofExecute, table: string = probeTableName()): Promise<void> {
  let refusedBy: string | undefined;
  for (const sql of agentProbeStatements(table)) {
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time: the first answer that is not a refusal ends the open.
    refusedBy = await writeRefusedBy(execute, sql, refusedBy);
  }
}

/** The server whose read-only refusal answered `sql`, which must be `expected` once a probe named one. */
async function writeRefusedBy(execute: AgentProofExecute, sql: string, expected: string | undefined): Promise<string> {
  try {
    await execute(sql);
  } catch (error) {
    if (!(error instanceof LibSQLTransportError) || error.status === 0) throw error;
    const refusal = READ_ONLY_REFUSALS.find((candidate) => candidate.admits(error));
    if (refusal !== undefined && (expected === undefined || refusal.server === expected)) return refusal.server;
    throw new ExecutionProfileError(
      `libSQL answered the agent's write probe with status ${error.status} (${error.message}), not the refusal a read-only token is refused a write with, so the agent read-only profile is refused`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  throw new ExecutionProfileError(
    `libSQL ran the write probe ${sql} sent with a token whose claims declare read-only access, so the server does not hold the token to them (it checks no token, or admits one it did not sign), and the agent read-only profile is refused`,
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
 * The claims a read-only token may carry beside `"a": "ro"`: the standard JWT claims and the ids the two servers mint
 * (a Turso Cloud read-only token carries `a`, `exp`, `iat`, `id`, `kid` and `rid`, measured). Any other claim may be
 * one the server reads to grant writes, as sqld reads `"p"`, so it refuses the token.
 */
const ALLOWED_BESIDE_READ_ONLY: ReadonlySet<string> = new Set([
  "exp",
  "iat",
  "nbf",
  "id",
  "kid",
  "rid",
  "iss",
  "sub",
  "aud",
  "jti",
]);

/**
 * Refuses a token that can write: one whose claims do not carry `"a": "ro"`, or carry any claim outside
 * `ALLOWED_BESIDE_READ_ONLY` beside it. Anything else, a token that is no JWT included, is refused, fail closed.
 */
export function assertReadOnlyClaims(token: string): void {
  const claims = jwtClaims(token);
  const record: Record<string, unknown> =
    typeof claims === "object" && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : {};
  if (record.a !== "ro") {
    throw new ExecutionProfileError(
      'The libSQL token is not a read-only token (a JWT whose claims carry "a": "ro"), so it can write, and the agent read-only profile is refused: use a read-only token',
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
  const others = Object.keys(record)
    .filter((claim) => claim !== "a" && !ALLOWED_BESIDE_READ_ONLY.has(claim))
    .sort((left, right) => left.localeCompare(right));
  if (others.length > 0) {
    throw new ExecutionProfileError(
      `The libSQL token carries claims beyond the read-only marker and the standard ones (${others.map((claim) => JSON.stringify(claim)).join(", ")}), which the server may read to grant writes, so it can write, and the agent read-only profile is refused: use a read-only token that carries no other claim`,
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
}
