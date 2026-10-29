/**
 * The agent read-only execution profile's boundary on Apache Cassandra: the check of the connection's role, run at
 * the open of a connection that will send statements and again before every agent statement, on the statement's own
 * session.
 *
 * CQL has no read-only session or transaction, so the boundary is the role, and the server must be shown to enforce
 * it. Measured on Apache Cassandra 5.0.9 with PasswordAuthenticator and CassandraAuthorizer
 * (`tests/fixtures/cassandra/5.0.9/agent-boundary/`): a role holding only SELECT on one keyspace is refused every
 * INSERT, UPDATE, DELETE, conditional write, BATCH, TRUNCATE, CREATE, ALTER, DROP, index, view, function, type,
 * keyspace and GRANT statement as Unauthorized (code 8448), a user-defined function or aggregate it holds no EXECUTE
 * on included (capture 02). Five checks, each on the server's own answers, in the order `verifyCassandraAgentProfile`
 * sends them:
 *
 * 1. **The server is Apache Cassandra 5.0.** `system.local.release_version` must read `5.0.<n>`, and
 *    `system.versions`, ScyllaDB's own table, must be absent (refused as an unknown table). ScyllaDB 2026.2.4 answers
 *    `3.0.8` and one `system.versions` row (capture 09), and its enforcement is not measured, so it is refused.
 * 2. **The role is no superuser, and holds no superuser role.** `LIST ROLES OF '<role>'` lists the role and every role
 *    granted to it, at any depth (capture 03); a row reading `super` true is refused. Never a bare `LIST ROLES`, which
 *    lists other roles to a role holding DESCRIBE on them.
 * 3. **The role holds only SELECT on the bound keyspace or its tables.** `LIST ALL PERMISSIONS OF '<role>'` lists the
 *    role's permissions and those of every role granted to it (capture 03). Every row must be SELECT on
 *    `<keyspace K>` or `<table K.T>`, where K is the connection's keyspace as the server spells it; any other
 *    permission or resource is refused, MODIFY on a second keyspace, SELECT on `<all keyspaces>`, EXECUTE on a
 *    function and the reads UNMASK and DESCRIBE included. A role holding no SELECT there is refused as too narrow.
 *    AllowAllAuthorizer refuses the listing itself (capture 07), and a server with no authenticator refuses it to an
 *    anonymous session (capture 08); both are refused as servers that do not enforce grants.
 * 4. **No column of the bound keyspace is masked with a user-defined function.** A SELECT of a column masked with a
 *    function runs that function on the server, a user-defined Java function included, for a role holding no EXECUTE
 *    on it (capture 02). Whether a mask is built in is the server's own catalog fact, the mask's
 *    `system_schema.column_masks.function_keyspace`, which reads `system` for the masking functions Cassandra ships;
 *    any other keyspace is refused. Every system table is named with its keyspace, which no user keyspace can shadow.
 * 5. **The server enforces the role's grants.** The role is asked to `DROP TABLE IF EXISTS` a table whose name carries
 *    a fresh random suffix, in the bound keyspace; the role holds no DROP, so an enforcing server answers Unauthorized,
 *    and a server that enforces nothing drops nothing, since no such table exists (captures 02 and 07).
 *
 * Every finding of checks 2 to 4 is collected and named in one refusal. A failure to reach the server leaves as it
 * came, and a check the server refuses to answer is a refusal of the profile, so no failure admits a role.
 *
 * A check read the server answers in more than one page is refused, never read in part: the listings and the mask
 * read are ordinary reads the driver pages, and a finding on a later page would otherwise go unseen.
 *
 * One write no grant stops is a role changing its own password (`ALTER ROLE <role> WITH PASSWORD`, capture 02), so the
 * agent path sends nothing but one SELECT (`cassandraAgentStatementRefusal`), refused before any session is opened.
 * The other is named in `docs/providers/cassandra.md` as a residual: after a REVOKE the server keeps enforcing the
 * revoked permission from its permission cache for up to `permissions_validity`, while the listing this check reads
 * shows the revoke at once (capture 05). A fresh role, rather than a revoke, is the remedy.
 */
import { ExecutionProfileError } from "../../../errors";
import { hasLoneCarriageReturnInLineComment, readSqlSpan } from "@/lib/sql/spans";
import { CASSANDRA_SQL_GRAMMAR } from "./sql-grammar";
import { type CassandraQueryResult, CassandraTransportError, type CassandraFaultCategory } from "./transport";

/** Runs one check statement as the agent role, on the statement's own session. */
export type CassandraAgentReader = (cql: string) => Promise<CassandraQueryResult>;

/** The release the server reports, which check 1 holds to a Cassandra 5.0 release. */
export const CASSANDRA_AGENT_RELEASE_CQL = "SELECT release_version FROM system.local";

/** ScyllaDB's own table: answered there, refused as an unknown table on Apache Cassandra (check 1). */
export const CASSANDRA_AGENT_SCYLLA_CQL = "SELECT key FROM system.versions";

/** The releases the boundary was measured on: Apache Cassandra 5.0. */
const MEASURED_RELEASE = /^5\.0\.\d+$/;

/** The keyspace that holds the functions Cassandra ships, the masking functions among them. */
const BUILT_IN_FUNCTION_KEYSPACE = "system";

/** The one permission the profile admits. */
const ADMITTED_PERMISSION = "SELECT";

/** The faults that are the server's answer to a statement, as against a failure to reach it or to wait for it. */
const SERVER_ANSWERS: ReadonlySet<CassandraFaultCategory> = new Set(["permission", "invalid", "syntax", "engine"]);

/** A string literal as CQL reads one: single-quoted, a quote inside doubled. */
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** A quoted name as CQL reads one: double-quoted, case kept, a double quote inside doubled. */
const quotedName = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** The statements checks 2 to 5 send for `role` on `keyspace`, the probe's table named with `nonce`. */
export function cassandraAgentStatements(role: string, keyspace: string, nonce: string) {
  return Object.freeze({
    roles: `LIST ROLES OF ${literal(role)}`,
    permissions: `LIST ALL PERMISSIONS OF ${literal(role)}`,
    masks: `SELECT keyspace_name, table_name, column_name, function_keyspace, function_name FROM system_schema.column_masks WHERE keyspace_name = ${literal(keyspace)}`,
    probe: `DROP TABLE IF EXISTS ${quotedName(keyspace)}.libredb_agent_probe_${nonce}`,
  });
}

/** What the check is told about the connection: the role it signs in as, its keyspace, and the probe's suffix. */
export interface CassandraAgentTarget {
  readonly role: string;
  readonly keyspace: string;
  readonly nonce: string;
}

/** Whether `error` is the server's own answer to a statement, rather than a failure to reach or wait for it. */
function isServerAnswer(error: unknown): error is CassandraTransportError {
  return error instanceof CassandraTransportError && SERVER_ANSWERS.has(error.category);
}

/** Check 1: the server is positively the Apache Cassandra 5.0 the boundary was measured on. */
async function assertMeasuredServer(read: CassandraAgentReader): Promise<void> {
  const release: unknown = (await read(CASSANDRA_AGENT_RELEASE_CQL)).rows[0]?.release_version ?? null;
  if (typeof release !== "string" || !MEASURED_RELEASE.test(release)) {
    throw new ExecutionProfileError(
      `The agent read-only execution profile is proven on Apache Cassandra 5.0 only; this server reports release_version ${JSON.stringify(release)}, so its enforcement is unmeasured and the connection is refused.`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  try {
    await read(CASSANDRA_AGENT_SCYLLA_CQL);
  } catch (error) {
    if (isServerAnswer(error) && error.category === "invalid") return;
    if (isServerAnswer(error)) {
      throw new ExecutionProfileError(
        `The agent read-only execution profile is proven on Apache Cassandra 5.0 only; this server answered system.versions with "${error.message}", so the check could not tell it from ScyllaDB, and the connection is refused.`,
        "PROFILE_UNSUPPORTED_TARGET",
      );
    }
    throw error;
  }
  throw new ExecutionProfileError(
    "The agent read-only execution profile is proven on Apache Cassandra 5.0 only; this server answers system.versions, which ScyllaDB keeps and Apache Cassandra does not, so its enforcement is unmeasured and the connection is refused.",
    "PROFILE_UNSUPPORTED_TARGET",
  );
}

/** The rows of a check read, refused when the server says more pages follow: a finding past the first must not hide. */
function wholeRows(result: CassandraQueryResult, role: string, what: string): readonly Record<string, unknown>[] {
  if (result.pageState !== null) {
    throw new ExecutionProfileError(
      `The agent read-only execution profile could not read the Cassandra role ${role}'s whole ${what} in one page, so a finding past it would go unseen, and the connection is refused.`,
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
  return result.rows;
}

/** One of the role's own listings, a server's refusal of it read as a server that does not enforce grants. */
async function readListing(
  read: CassandraAgentReader,
  cql: string,
  role: string,
  what: "roles" | "permissions",
): Promise<readonly Record<string, unknown>[]> {
  let result: CassandraQueryResult;
  try {
    result = await read(cql);
  } catch (error) {
    if (!isServerAnswer(error)) throw error;
    throw new ExecutionProfileError(
      `The agent read-only execution profile needs a server that enforces its roles' grants (PasswordAuthenticator and CassandraAuthorizer); this server refused to list the role ${role}'s own ${what} to it, which such a server answers, so its enforcement is unproven and the connection is refused.`,
      "PROFILE_SERVER_UNENFORCED",
    );
  }
  return wholeRows(result, role, `${what} listing`);
}

function unreadable(role: string): ExecutionProfileError {
  return new ExecutionProfileError(
    `The agent read-only execution profile could not read the Cassandra role ${role}'s own roles and permissions in the shape the server answers them, so its reach is unproven and the connection is refused.`,
    "PROFILE_PRIVILEGES_TOO_BROAD",
  );
}

/** The roles granted to the role, itself among them, that are superusers. Fail-closed on a row it cannot read. */
function superuserRoles(rows: readonly Record<string, unknown>[], role: string): string[] {
  const readable = rows.every((row) => typeof row.role === "string" && typeof row.super === "boolean");
  if (!readable || !rows.some((row) => row.role === role)) throw unreadable(role);
  return rows.filter((row) => row.super === true).map((row) => row.role as string);
}

/** Whether `resource` is the bound keyspace or one of its tables, as the permission listing spells them. */
function isBoundResource(resource: string, keyspace: string): boolean {
  if (resource === `<keyspace ${keyspace}>`) return true;
  const table = `<table ${keyspace}.`;
  // A keyspace or table name holds only letters, digits and underscores, so the rest is one table name.
  return resource.startsWith(table) && resource.endsWith(">") && /^\w+$/.test(resource.slice(table.length, -1));
}

/** Every permission row that is not SELECT on the bound keyspace or its tables, and whether any SELECT there is held. */
function permissionFindings(
  rows: readonly Record<string, unknown>[],
  role: string,
  keyspace: string,
): { findings: string[]; readsKeyspace: boolean } {
  const readable = rows.every(
    (row) => typeof row.role === "string" && typeof row.resource === "string" && typeof row.permission === "string",
  );
  if (!readable) throw unreadable(role);
  const findings: string[] = [];
  let readsKeyspace = false;
  for (const row of rows) {
    const resource = row.resource as string;
    if (row.permission === ADMITTED_PERMISSION && isBoundResource(resource, keyspace)) {
      readsKeyspace = true;
      continue;
    }
    findings.push(`it holds ${row.permission as string} on ${resource} (granted to ${row.role as string})`);
  }
  return { findings, readsKeyspace };
}

/** Every column of the bound keyspace masked with a function outside the system keyspace. */
function maskFindings(rows: readonly Record<string, unknown>[]): string[] {
  return rows
    .filter((row) => row.function_keyspace !== BUILT_IN_FUNCTION_KEYSPACE)
    .map(
      (row) =>
        `the column ${String(row.keyspace_name)}.${String(row.table_name)}.${String(row.column_name)} is masked with the user-defined function ${String(row.function_keyspace)}.${String(row.function_name)}, which a SELECT of it runs on the server without EXECUTE`,
    );
}

/** Check 5: a DROP the role holds no grant for is refused as Unauthorized, and drops nothing on any outcome. */
async function probeServerEnforcesGrants(read: CassandraAgentReader, probe: string, target: CassandraAgentTarget) {
  try {
    await read(probe);
  } catch (error) {
    if (!isServerAnswer(error)) throw error;
    if (error.category === "permission") return;
    throw new ExecutionProfileError(
      `The agent read-only execution profile needs a server that refuses the role ${target.role} a DROP it holds no grant for, as Unauthorized; this server answered ${error.message} instead, so its enforcement is unproven and the connection is refused.`,
      "PROFILE_SERVER_UNENFORCED",
    );
  }
  throw new ExecutionProfileError(
    `The agent read-only execution profile needs a server that enforces its roles' grants, and this one does not: it accepted a DROP TABLE IF EXISTS the role ${target.role} holds no DROP for (the table does not exist, so nothing changed). Turn on CassandraAuthorizer, and connect as a role holding only SELECT on the keyspace ${target.keyspace}.`,
    "PROFILE_SERVER_UNENFORCED",
  );
}

/**
 * Proves the role before a statement, sending each check through `read` in the order the module's docblock gives and
 * refusing the profile when any finds anything. No verdict is kept: every call reads the server as it is then.
 */
export async function verifyCassandraAgentProfile(
  read: CassandraAgentReader,
  target: CassandraAgentTarget,
): Promise<void> {
  const { role, keyspace, nonce } = target;
  if (role === "") {
    throw new ExecutionProfileError(
      "The agent read-only execution profile needs the connection to sign in as a role holding only SELECT on its keyspace; this connection names no role, so no read-only boundary can be proven. Set the agent user and password to such a role.",
      "PROFILE_PRIVILEGES_TOO_NARROW",
    );
  }
  if (keyspace === "") {
    throw new ExecutionProfileError(
      "The agent read-only execution profile reads one keyspace, the connection's own, and this connection names none, so the role's reach cannot be bounded. Set the keyspace on the connection.",
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  await assertMeasuredServer(read);
  const statements = cassandraAgentStatements(role, keyspace, nonce);
  const superusers = superuserRoles(await readListing(read, statements.roles, role, "roles"), role);
  const permissions = permissionFindings(
    await readListing(read, statements.permissions, role, "permissions"),
    role,
    keyspace,
  );
  const masks = maskFindings(wholeRows(await read(statements.masks), role, `column masks of the keyspace ${keyspace}`));

  const scope = `the keyspace ${keyspace} or on its tables`;
  const findings = [
    ...(superusers.length === 0 ? [] : [`it is a superuser (${superusers.join(", ")}), whom no grant restricts`]),
    ...(permissions.findings.length === 0
      ? []
      : [`${permissions.findings.join("; ")}, and the profile admits only SELECT on ${scope}`]),
    ...masks,
  ];
  if (findings.length > 0) {
    const remedy = `Connect as a role that is no superuser, holds no superuser role, and holds only SELECT on ${scope}${
      masks.length === 0 ? "" : ", and mask its columns with the system keyspace's functions only"
    }.`;
    throw new ExecutionProfileError(
      `The agent read-only execution profile refuses the Cassandra role ${role}: ${findings.join("; ")}. ${remedy}`,
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
  if (!permissions.readsKeyspace) {
    throw new ExecutionProfileError(
      `The agent read-only execution profile needs a role holding SELECT on ${scope}, and the role ${role} holds none, so it cannot read it. Grant it SELECT ON KEYSPACE ${keyspace}.`,
      "PROFILE_PRIVILEGES_TOO_NARROW",
    );
  }
  await probeServerEnforcesGrants(read, statements.probe, target);
}

/** What every fence refusal starts with. */
const FENCE = "The agent read-only execution profile sends one CQL statement, a SELECT, and nothing else";

/** The statement's first keyword, read from its first code character, case aside and not a longer word. */
const SELECT_KEYWORD = /^select(?![\w$])/i;

/**
 * The fence in front of every agent statement: `null` when `cql` is one statement whose first keyword is SELECT, else
 * the reason it is refused, before any session is opened. A Cassandra role can always change its own password, which
 * no grant stops (capture 02), so a role check alone cannot keep the agent from writing; only a SELECT is sent.
 *
 * The text is walked with the shared span reader under CQL's own grammar, so `--`, `//` and block comments and
 * whitespace are skipped, and string literals, quoted names and `$$` strings are opaque. The first code character
 * must open the keyword SELECT; a code semicolon ends the statement, and only comments and whitespace may follow it.
 * A subscript's brackets are read as code, a literal inside them still opaque, so a semicolon there ends the
 * statement too. Text that ends inside a comment, string or quoted name, and a tagged dollar run, which CQL does not
 * have, cannot be bounded and are refused.
 *
 * A lone carriage return inside a `--` or `//` comment with more text after it is refused before the walk. The server
 * ends the comment there (capture 14), and so does the grammar the walk reads, but a reader that runs the comment on
 * to the line feed reads a different statement: `-- x<CR>ALTER ROLE ... = '<LF>SELECT ... = ' -- '<LF>` is a SELECT to
 * it, and the server ran it as the role's password change. Such text is refused whichever reading is the walk's.
 */
export function cassandraAgentStatementRefusal(cql: string): string | null {
  const grammar = CASSANDRA_SQL_GRAMMAR.grammar;
  if (hasLoneCarriageReturnInLineComment(cql, grammar)) {
    return `${FENCE}; this text holds a carriage return inside a -- or // comment with more text after it, and the server ends the comment at that carriage return, so the server could read a statement other than the one checked here, and it was not sent. End a comment with a line feed.`;
  }
  let opened = false;
  let ended = false;
  for (let at = 0; at < cql.length; ) {
    const span = readSqlSpan(cql, at, grammar);
    if (span !== null && span.kind !== "subscript") {
      if (!span.terminated) {
        return `${FENCE}; this text ends inside a comment, a string or a quoted name, so where it ends cannot be read, and it was not sent.`;
      }
      const trivia = span.kind === "whitespace" || span.kind === "line-comment" || span.kind === "block-comment";
      if (!trivia) {
        if (!opened) return notSelect();
        if (ended) return goesOn();
        if (span.kind === "dollar-string" && !cql.startsWith("$$", at)) {
          return `${FENCE}; this text holds a tagged dollar-quoted run ($tag$ ... $tag$), which CQL does not have, so where its strings end cannot be read, and it was not sent.`;
        }
      }
      at = span.end;
      continue;
    }
    if (ended) return goesOn();
    if (!opened) {
      if (!SELECT_KEYWORD.test(cql.slice(at, at + 7))) return notSelect();
      opened = true;
    }
    if (cql[at] === ";") ended = true;
    at++;
  }
  return opened ? null : `${FENCE}; this text holds no statement, so nothing was sent.`;
}

function notSelect(): string {
  return `${FENCE}; this statement does not begin with SELECT, so it was not sent. A Cassandra role can always change its own password, which no grant stops, so only a SELECT reaches the server.`;
}

function goesOn(): string {
  return `${FENCE}; this text goes on after its first statement's semicolon, so it was not sent. Send one SELECT at a time.`;
}
