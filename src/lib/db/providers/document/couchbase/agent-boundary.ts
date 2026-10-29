/**
 * The agent read-only execution profile's boundary on Couchbase: the check of the connection's user, run at the open
 * of a connection that will send statements and again before every agent statement, and the fence every agent
 * statement passes before it is sent.
 *
 * The query service has no read-only session, and its `readonly` request flag is no boundary: measured on Couchbase
 * Server 8.0.2 Enterprise (`tests/fixtures/couchbase/8.0.2/agent-boundary/`, capture 04), it refuses INSERT, UPDATE,
 * DELETE, CREATE INDEX, BEGIN WORK, EXECUTE FUNCTION and the EXECUTE of a prepared DELETE with code 1000, but runs
 * UPDATE STATISTICS. So the boundary is the user: one whose only role is `query_select` on the connection's bucket.
 * Such a user is refused every INSERT, UPSERT, UPDATE, DELETE, MERGE, index, scope, collection, sequence and GRANT
 * statement with code 13014, a call of any user-defined function (inline or JavaScript, scoped or global) and CURL()
 * included, and every `system:` keyspace that holds other users' requests, prepared statements or roles (capture 02).
 * Two checks, each on the server's own answers, in the order `verifyCouchbaseAgentProfile` sends them:
 *
 * 1. **The user's only role is query_select on the bound bucket.** `GET /whoami` answers the user's roles, those it
 *    holds through a group included (capture 01). Every role must be `query_select` whose `bucket_name` is the
 *    connection's bucket exactly, on any of its scopes and collections; any other role is refused by name, whether it
 *    writes (query_update, query_insert, query_delete, data_writer, bucket_admin, admin), runs code (the query_execute_*
 *    function roles), reaches beyond the bucket (query_select on `*` or on a second bucket, query_external_access) or
 *    reads other users' work (query_system_catalog). A role this check has never seen is refused with the rest, so a
 *    new role is refused until it is measured. Community Edition offers only admin, ro_admin and bucket_full_access,
 *    and refuses to grant query_select at all (capture 06), so every Community Edition user is refused here by its
 *    roles, never by the edition's name. A user holding no role is refused as too narrow.
 * 2. **The server enforces the role.** The user is asked to DELETE one key with a fresh random suffix from the
 *    bucket's `_default` collection, with the `readonly` flag off so the refusal is the role's; a server that enforces
 *    roles answers 13014 for the missing query_delete (capture 02), and one that does not deletes nothing, since no such
 *    key exists. Any other answer refuses the profile, a bucket whose `_default` collection was dropped included.
 *
 * A failure to reach the server leaves as it came, and an answer the check cannot read refuses the profile, so no
 * failure admits a user.
 *
 * A user holding only query_select may still run UPDATE STATISTICS, which writes the optimizer's statistics, open a
 * transaction (BEGIN WORK), PREPARE a statement, and EXECUTE a statement another user prepared, which runs under that
 * statement's own privilege list (captures 02 and 04). So the agent path sends nothing but one statement whose first
 * keyword is SELECT or WITH (`couchbaseAgentStatementRefusal`), refused before anything is sent: a WITH leads only a
 * SELECT, since `WITH ... INSERT`, `DELETE`, `UPSERT`, `MERGE`, `UPDATE` and `EXECUTE FUNCTION` are syntax errors
 * (captures 02 and 05).
 */
import { ExecutionProfileError } from "../../../errors";
import { hasLoneCarriageReturnInLineComment, readSqlSpan } from "@/lib/sql/spans";
import { COUCHBASE_SQL_GRAMMAR } from "./sql-grammar";
import { CouchbaseError, type CouchbaseQueryResult } from "./transport";

/** The two requests the check sends as the agent user, each on its own request. */
export interface CouchbaseAgentReader {
  /** The parsed answer of `GET /whoami` on the management port. */
  whoami(): Promise<unknown>;
  /** Sends the probe statement on the query service; a refusal arrives as a thrown CouchbaseError. */
  probe(statement: string): Promise<CouchbaseQueryResult>;
}

/** What the check is told about the connection: the user it signs in as, its bucket, and the probe key's suffix. */
export interface CouchbaseAgentTarget {
  readonly user: string;
  readonly bucket: string;
  readonly nonce: string;
}

/** The one role the profile admits. */
const ADMITTED_ROLE = "query_select";

/** The query service's code for a statement the user's roles do not allow (capture 02). */
const MISSING_ROLE_CODE = 13014;

/** The statement check 2 sends: a DELETE of one freshly named key, which no one holds, in the default collection. */
export function couchbaseAgentProbeStatement(nonce: string): string {
  return `DELETE FROM \`_default\` USE KEYS "libredb-agent-probe-${nonce}"`;
}

interface WhoamiRole {
  readonly role: string;
  readonly bucket_name?: string;
  readonly scope_name?: string;
  readonly collection_name?: string;
}

const PARAMETERS = ["bucket_name", "scope_name", "collection_name"] as const;

/** A role entry this check can read: a role name, and each parameter it carries a string. */
function isRoleEntry(value: unknown): value is WhoamiRole {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.role !== "string") return false;
  if (!PARAMETERS.every((key) => entry[key] === undefined || typeof entry[key] === "string")) return false;
  // query_select always carries all three parameters (capture 01); one without them has a reach this cannot read.
  if (entry.role === ADMITTED_ROLE) return PARAMETERS.every((key) => typeof entry[key] === "string");
  return true;
}

/** A role as Couchbase spells one in its REST API: `name`, or `name[bucket:scope:collection]` up to its last parameter. */
function spelled(entry: WhoamiRole): string {
  const parameters = PARAMETERS.map((key) => entry[key]).filter((value) => value !== undefined);
  return parameters.length === 0 ? entry.role : `${entry.role}[${parameters.join(":")}]`;
}

/** The roles GET /whoami answers for `user`, refused unless every entry and the identity can be read. */
function readRoles(answer: unknown, user: string): readonly WhoamiRole[] {
  const record = typeof answer === "object" && answer !== null && !Array.isArray(answer) ? answer : null;
  const roles = record === null ? null : (record as Record<string, unknown>).roles;
  const id = record === null ? null : (record as Record<string, unknown>).id;
  if (!Array.isArray(roles) || id !== user || !roles.every(isRoleEntry)) {
    throw new ExecutionProfileError(
      `The agent read-only execution profile could not read the roles of the Couchbase user ${user} from GET /whoami in the shape the server answers them, so its reach is unproven and the connection is refused.`,
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
  return roles;
}

/** Check 1: every role is query_select on the bound bucket, and there is one. */
function assertSelectOnly(roles: readonly WhoamiRole[], target: CouchbaseAgentTarget): void {
  const findings = roles
    .filter((entry) => entry.role !== ADMITTED_ROLE || entry.bucket_name !== target.bucket)
    .map(spelled);
  if (findings.length > 0) {
    throw new ExecutionProfileError(
      `The agent read-only execution profile needs a Couchbase user holding only query_select on the bucket ${target.bucket}; the user ${target.user} also holds ${findings.join(", ")}, which reach past reading that bucket, so the connection is refused. Give the agent a user whose only role is query_select[${target.bucket}].`,
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
  if (roles.length === 0) {
    throw new ExecutionProfileError(
      `The agent read-only execution profile needs a Couchbase user holding query_select on the bucket ${target.bucket}, and the user ${target.user} holds none, so it cannot read it. Give it the role query_select[${target.bucket}].`,
      "PROFILE_PRIVILEGES_TOO_NARROW",
    );
  }
}

/** Check 2: the server refuses the user a DELETE for the role it lacks. */
async function probeServerEnforcesRoles(reader: CouchbaseAgentReader, target: CouchbaseAgentTarget): Promise<void> {
  const enforcement = `The agent read-only execution profile needs a server that enforces its users' roles; this server`;
  try {
    await reader.probe(couchbaseAgentProbeStatement(target.nonce));
  } catch (error) {
    // A failure to reach the server is not its answer: it leaves as it came.
    if (!(error instanceof CouchbaseError) || (error.retriable && error.code === 0)) throw error;
    if (error.code === MISSING_ROLE_CODE) return;
    throw new ExecutionProfileError(
      `${enforcement} answered a DELETE in the bucket ${target.bucket} for the user ${target.user} with "${error.message}" (code ${error.code}) rather than refusing it for a missing role, so its enforcement is unproven and the connection is refused. The check deletes one freshly named key in the bucket's _default collection, which must exist.`,
      "PROFILE_SERVER_UNENFORCED",
    );
  }
  throw new ExecutionProfileError(
    `${enforcement} ran a DELETE in the bucket ${target.bucket} for the user ${target.user}, whose only role is query_select, so its enforcement is unproven and the connection is refused.`,
    "PROFILE_SERVER_UNENFORCED",
  );
}

/**
 * The check of the agent user, run on every agent statement before it is sent and keeping no verdict between calls,
 * so a role added after one call refuses the next and a role taken away admits it. Resolves only for a user whose
 * only role is query_select on `target.bucket`, on a server that refuses that user a DELETE.
 */
export async function verifyCouchbaseAgentProfile(
  reader: CouchbaseAgentReader,
  target: CouchbaseAgentTarget,
): Promise<void> {
  assertSelectOnly(readRoles(await reader.whoami(), target.user), target);
  await probeServerEnforcesRoles(reader, target);
}

/** What every fence refusal starts with. */
const FENCE =
  "The agent read-only execution profile sends one SQL++ statement, a SELECT (a WITH before it is fine), and nothing else";

/** The statement's first keyword, read from its first code character, case aside and not a longer word. */
const FIRST_KEYWORD = /^(?:select|with)(?![\w$])/i;

/**
 * The fence in front of every agent statement: `null` when `sql` is one statement whose first keyword is SELECT or
 * WITH, else the reason it is refused, before anything is sent. A user holding only query_select may still run UPDATE
 * STATISTICS, BEGIN WORK, PREPARE and the EXECUTE of another user's prepared statement (captures 02 and 04), so the
 * role check alone cannot keep the agent from them; only a SELECT is sent.
 *
 * The text is walked with the shared span reader under SQL++'s own grammar (`sql-grammar.ts`), so `--` and block
 * comments and whitespace are skipped, and string literals and backtick-quoted names are opaque. The first code
 * character must open SELECT or WITH; a code semicolon ends the statement, and only comments and whitespace may follow
 * it, since the server runs `SELECT 1 AS a;;` (capture 05). A subscript's brackets are read as code, a literal inside
 * them still opaque, so a semicolon there ends the statement too. Text that ends inside a comment, string or quoted
 * name cannot be bounded and is refused, and so is a `$$` or `$tag$` run, which SQL++ does not have.
 *
 * A lone carriage return inside a `--` comment with more text after it is refused before the walk. The server ends
 * the comment there (capture 05: `SELECT 1 AS a -- x<CR>, 2 AS b` answers both columns), and so does the grammar the
 * walk reads, but a reader that runs the comment on to the line feed reads a different statement, so such text is
 * refused whichever reading is the walk's. U+2028, U+0085 and a form feed end no comment there.
 */
export function couchbaseAgentStatementRefusal(sql: string): string | null {
  const grammar = COUCHBASE_SQL_GRAMMAR.grammar;
  if (hasLoneCarriageReturnInLineComment(sql, grammar)) {
    return `${FENCE}; this text holds a carriage return inside a -- comment with more text after it, and the server ends the comment at that carriage return, so a reader that does not could read another statement, and it was not sent. End a comment with a line feed.`;
  }
  let opened = false;
  let ended = false;
  for (let at = 0; at < sql.length; ) {
    const span = readSqlSpan(sql, at, grammar);
    if (span !== null && span.kind !== "subscript") {
      if (!span.terminated) {
        return `${FENCE}; this text ends inside a comment, a string or a quoted name, so where it ends cannot be read, and it was not sent.`;
      }
      const trivia = span.kind === "whitespace" || span.kind === "line-comment" || span.kind === "block-comment";
      if (!trivia) {
        if (!opened) return notSelect();
        if (ended) return goesOn();
        if (span.kind === "dollar-string") {
          return `${FENCE}; this text holds a dollar-quoted run ($$ ... $$), which SQL++ does not have, so where its strings end cannot be read, and it was not sent.`;
        }
      }
      at = span.end;
      continue;
    }
    if (ended) return goesOn();
    if (!opened) {
      if (!FIRST_KEYWORD.test(sql.slice(at, at + 7))) return notSelect();
      opened = true;
    }
    if (sql[at] === ";") ended = true;
    at++;
  }
  return opened ? null : `${FENCE}; this text holds no statement, so nothing was sent.`;
}

function notSelect(): string {
  return `${FENCE}; this statement does not begin with SELECT or WITH, so it was not sent. A user holding only query_select may still run UPDATE STATISTICS, BEGIN WORK, PREPARE and EXECUTE, so only a SELECT reaches the server.`;
}

function goesOn(): string {
  return `${FENCE}; this text goes on after its first statement's semicolon, so it was not sent. Send one SELECT at a time.`;
}
