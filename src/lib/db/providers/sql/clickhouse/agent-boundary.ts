/**
 * The agent read-only execution profile's boundary on ClickHouse, proven at the open of a connection that will send
 * statements.
 *
 * The engine holds the boundary: every agent request carries `readonly = 1` (`agentRequestSettings` in
 * `agent-read.ts`), and the open proves the server applies it. What `readonly` leaves open is the principal's to
 * hold, so the open proves the principal holds none of it. Measured on 26.7.1.1315, `readonly = 1` does not refuse:
 *
 * - `BACKUP` (it reached the backup engine's own configuration check), `UNDROP TABLE` (it reached the table lookup),
 *   `ALTER DATABASE ... MODIFY SETTING` (it reached the engine's own refusal), and `CREATE`, `ALTER` and `DROP NAMED
 *   COLLECTION`, which ran;
 * - `KILL QUERY`, which reaches another user's statements with the KILL QUERY grant, and the principal's own without
 *   any grant, at any `readonly` value;
 * - `cluster()` and `clusterAllReplicas()`, and `DESCRIBE TABLE` over a table function, which reach another server or
 *   a source under the SOURCES grants;
 * - SELECT on a table whose engine reads an external source (a URL-engine table answered under `readonly = 1`), on a
 *   view whose SQL SECURITY is DEFINER or NONE over such a table (it answered too, the definer's grants standing in
 *   for the caller's), and on a dictionary, which loads from its source under the dictionary's own credential;
 * - SELECT on `system.query_log`, which holds every user's statement text.
 *
 * So the open runs, each under the agent's own request settings, and refuses the profile on any answer it cannot
 * read (fail closed):
 *
 * 1. **The server is a checked ClickHouse release with `readonly = 1` in force.** `version()` must be a release whose
 *    lists below were checked (`CLICKHOUSE_CHECKED_RELEASES`), and `getSetting('readonly')` must answer 1. A release
 *    outside the set is refused until its privilege and engine lists are checked again.
 * 2. **The server refuses a lower `readonly` and a write.** `SELECT 1 SETTINGS readonly = 0` must answer code 164;
 *    a user whose settings profile marks `readonly` changeable runs it (measured), and is refused here. Then a
 *    write-shaped statement that changes nothing on any outcome, `CREATE DATABASE IF NOT EXISTS` on the bound
 *    database, which exists because the connect probe ran in it, must be refused: with 164 under `readonly`, or with
 *    497 for a principal without the grant, which ClickHouse checks first (measured: a least-privilege user answers
 *    497, an unrestricted one 164). A `DROP TABLE IF EXISTS` on an absent table cannot serve: it answers success under
 *    `readonly = 1` (measured), so it proves nothing.
 * 3. **The principal holds only reads.** `SHOW GRANTS FINAL` answers the user's grants merged with every role granted
 *    to it, default or not (measured: a role granted with `SET DEFAULT ROLE NONE` still lists its BACKUP grant). Each
 *    privilege must be a read (`CLICKHOUSE_AGENT_PRIVILEGES`) on one named database or table outside `system` and
 *    `INFORMATION_SCHEMA`, and none may carry the grant option. Any other privilege is refused by name, a source
 *    grant (`CLICKHOUSE_SOURCE_PRIVILEGES`) and a grant `readonly` leaves usable
 *    (`CLICKHOUSE_READONLY_EXEMPT_PRIVILEGES`) said as such.
 * 4. **The principal cannot read the query log.** `SELECT 1 FROM system.query_log LIMIT 0` must be refused with 497,
 *    or answer 60 where the log is switched off.
 * 5. **The principal reads no external source.** Every table `system.tables` shows the principal must use a local
 *    storage engine (`CLICKHOUSE_LOCAL_TABLE_ENGINES`), and a view among them no SQL SECURITY of DEFINER or NONE;
 *    `system.dictionaries` must be unreadable to the principal (497) or empty.
 */
import { ExecutionProfileError } from "@/lib/db/errors";
import { type ClickHouseQueryResult, ClickHouseTransportError } from "./transport";

/** Runs one statement under the agent's request settings and answers it, or throws the seam's error. */
export type AgentProofQuery = (sql: string) => Promise<ClickHouseQueryResult>;

/**
 * The releases, as `version()`'s first two numbers, whose privilege and engine lists below were read from a live
 * server: 26.7.1.1315. A release outside this set is refused at open until its own `system.privileges` and
 * `system.table_engines` are read and the lists updated.
 */
export const CLICKHOUSE_CHECKED_RELEASES: readonly string[] = Object.freeze(["26.7"]);

/** The privileges the agent principal may hold: SELECT, and SHOW with its four parts. */
export const CLICKHOUSE_AGENT_PRIVILEGES: readonly string[] = Object.freeze([
  "SELECT",
  "SHOW",
  "SHOW DATABASES",
  "SHOW TABLES",
  "SHOW COLUMNS",
  "SHOW DICTIONARIES",
]);

/**
 * The privileges that reach an external source, as 26.7's `system.privileges` lists them: the SOURCES group, each of
 * its members, and the READ and WRITE source privileges (`GRANT READ ON URL` lists as `GRANT URL ON *.*`).
 */
export const CLICKHOUSE_SOURCE_PRIVILEGES: readonly string[] = Object.freeze([
  "SOURCES",
  "READ",
  "WRITE",
  "FILE",
  "URL",
  "REMOTE",
  "MONGO",
  "REDIS",
  "MYSQL",
  "POSTGRES",
  "SQLITE",
  "ODBC",
  "JDBC",
  "HDFS",
  "S3",
  "HIVE",
  "AZURE",
  "KAFKA",
  "NATS",
  "RABBITMQ",
  "YTSAURUS",
  "ARROW FLIGHT",
]);

/**
 * The privileges whose statements `readonly = 1` does not refuse on 26.7, measured: BACKUP, UNDROP TABLE, ALTER
 * DATABASE SETTINGS and its group, the named-collection group, and KILL QUERY, which reaches other users' statements.
 * CLUSTER is here too, since `ON CLUSTER` sends a statement to every server of a cluster.
 */
export const CLICKHOUSE_READONLY_EXEMPT_PRIVILEGES: readonly string[] = Object.freeze([
  "BACKUP",
  "UNDROP TABLE",
  "ALTER DATABASE",
  "ALTER DATABASE SETTINGS",
  "NAMED COLLECTION ADMIN",
  "NAMED COLLECTION",
  "CREATE NAMED COLLECTION",
  "ALTER NAMED COLLECTION",
  "DROP NAMED COLLECTION",
  "SHOW NAMED COLLECTIONS",
  "SHOW NAMED COLLECTIONS SECRETS",
  "KILL QUERY",
  "CLUSTER",
]);

/**
 * The table engines that store their rows on this server and read nothing else, of the 81 that 26.7's
 * `system.table_engines` lists: the MergeTree family with its replicated forms, the in-memory and log engines,
 * `Null`, `Set` and `Join`, and the two view engines, whose SQL SECURITY is checked separately.
 */
export const CLICKHOUSE_LOCAL_TABLE_ENGINES: readonly string[] = Object.freeze([
  "MergeTree",
  "ReplacingMergeTree",
  "SummingMergeTree",
  "AggregatingMergeTree",
  "CollapsingMergeTree",
  "VersionedCollapsingMergeTree",
  "GraphiteMergeTree",
  "CoalescingMergeTree",
  "ReplicatedMergeTree",
  "ReplicatedReplacingMergeTree",
  "ReplicatedSummingMergeTree",
  "ReplicatedAggregatingMergeTree",
  "ReplicatedCollapsingMergeTree",
  "ReplicatedVersionedCollapsingMergeTree",
  "ReplicatedGraphiteMergeTree",
  "ReplicatedCoalescingMergeTree",
  "Memory",
  "Log",
  "TinyLog",
  "StripeLog",
  "Null",
  "Set",
  "Join",
  "View",
  "MaterializedView",
]);

/**
 * Every other engine 26.7 lists, refused wherever the principal can read a table of it: each one reads an external
 * source, a file, another server, or another object under an identity or a selection the principal's grants do not
 * name (`Alias`, `Buffer`, `Dictionary`, `Distributed`, `Merge`, `Loop`). An engine in neither list, from a later
 * release, is refused too.
 */
export const CLICKHOUSE_REFUSED_TABLE_ENGINES: readonly string[] = Object.freeze([
  "Alias",
  "ArrowFlight",
  "AzureBlobStorage",
  "AzureQueue",
  "Buffer",
  "COSN",
  "DeltaLake",
  "DeltaLakeAzure",
  "DeltaLakeLocal",
  "DeltaLakeS3",
  "Dictionary",
  "Distributed",
  "EmbeddedRocksDB",
  "Executable",
  "ExecutablePool",
  "File",
  "FileLog",
  "FuzzJSON",
  "FuzzQuery",
  "GCS",
  "GenerateRandom",
  "HDFS",
  "Hive",
  "Hudi",
  "Iceberg",
  "IcebergAzure",
  "IcebergHDFS",
  "IcebergLocal",
  "IcebergS3",
  "JDBC",
  "Kafka",
  "KeeperMap",
  "Loop",
  "MaterializedPostgreSQL",
  "Merge",
  "MongoDB",
  "MySQL",
  "NATS",
  "ODBC",
  "OSS",
  "Paimon",
  "PaimonAzure",
  "PaimonHDFS",
  "PaimonLocal",
  "PaimonS3",
  "PostgreSQL",
  "QueryRunner",
  "RabbitMQ",
  "Redis",
  "Remote",
  "RemoteSecure",
  "S3",
  "S3Queue",
  "SQLite",
  "TimeSeries",
  "URL",
  "WindowView",
  "YTsaurus",
]);

/** The schemas the principal may hold no read of: the server's own. Compared without case. */
const SERVER_SCHEMAS: readonly string[] = Object.freeze(["SYSTEM", "INFORMATION_SCHEMA"]);

const READONLY_CODE = 164;
const ACCESS_DENIED_CODE = 497;
const UNKNOWN_TABLE_CODE = 60;

/** How many offending objects one refusal names, so a refusal stays readable on a server with thousands. */
const OBJECT_REFUSAL_LIMIT = 5;

const IDENTITY_SQL = "SELECT version() AS version, currentUser() AS user, toString(getSetting('readonly')) AS readonly";
const LOWER_READONLY_SQL = "SELECT 1 SETTINGS readonly = 0";
const GRANTS_SQL = "SHOW GRANTS FINAL";
const QUERY_LOG_SQL = "SELECT 1 FROM system.query_log LIMIT 0";
const DICTIONARIES_SQL = "SELECT database, name FROM system.dictionaries LIMIT 1";

function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** A name as an identifier, backquoted with its backslashes and backquotes escaped, as `objects.ts` measured. */
function identifier(name: string): string {
  return `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

/**
 * The visible tables the principal must not read: an engine outside the local list, or a view or materialized view
 * whose SQL SECURITY lets another user's grants stand in for the caller's (a definer, or NONE).
 */
const OBJECTS_SQL =
  "SELECT database, name, engine FROM system.tables " +
  `WHERE engine NOT IN (${CLICKHOUSE_LOCAL_TABLE_ENGINES.map(stringLiteral).join(", ")}) ` +
  "OR (engine IN ('View', 'MaterializedView') AND (definer != '' OR match(create_table_query, 'SQL SECURITY (DEFINER|NONE)'))) " +
  `ORDER BY database, name LIMIT ${OBJECT_REFUSAL_LIMIT}`;

function cell(rows: readonly Record<string, unknown>[], column: string): string | undefined {
  const value = rows[0]?.[column];
  return typeof value === "string" ? value : undefined;
}

/** What the server did with one statement: answered it, or refused it with a code. */
type ProofAnswer =
  | { readonly kind: "answered"; readonly result: ClickHouseQueryResult }
  | { readonly kind: "refused"; readonly code: number };

/** The statement's answer or the server's refusal code. A failure that carries no server code is thrown. */
async function attempt(query: AgentProofQuery, sql: string): Promise<ProofAnswer> {
  try {
    return { kind: "answered", result: await query(sql) };
  } catch (error) {
    if (error instanceof ClickHouseTransportError && error.code !== 0) return { kind: "refused", code: error.code };
    throw error;
  }
}

/** The server's code for a statement it refused, or null when it answered. */
async function refusalCode(query: AgentProofQuery, sql: string): Promise<number | null> {
  const answer = await attempt(query, sql);
  return answer.kind === "refused" ? answer.code : null;
}

function unenforced(message: string): ExecutionProfileError {
  return new ExecutionProfileError(message, "PROFILE_SERVER_UNENFORCED");
}

function tooBroad(message: string): ExecutionProfileError {
  return new ExecutionProfileError(message, "PROFILE_PRIVILEGES_TOO_BROAD");
}

async function verifyServer(query: AgentProofQuery): Promise<string> {
  const { rows } = await query(IDENTITY_SQL);
  const version = cell(rows, "version");
  const user = cell(rows, "user");
  const release = /^(\d+\.\d+)\.\d+\.\d+$/.exec(version ?? "")?.[1];
  if (version === undefined || user === undefined || release === undefined) {
    throw new ExecutionProfileError(
      "The agent read-only profile could not read the ClickHouse server's version and user, so it is refused",
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  if (!CLICKHOUSE_CHECKED_RELEASES.includes(release)) {
    throw new ExecutionProfileError(
      `The agent read-only profile is checked on ClickHouse ${CLICKHOUSE_CHECKED_RELEASES.join(", ")}, and this server is ${version}: its privileges and table engines have not been checked, so it is refused`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  if (cell(rows, "readonly") !== "1") {
    throw unenforced(
      `ClickHouse did not apply readonly = 1 to the agent's request for user "${user}", so the agent read-only profile is refused`,
    );
  }
  return user;
}

async function verifyWritesRefused(query: AgentProofQuery, database: string, user: string): Promise<void> {
  if ((await refusalCode(query, LOWER_READONLY_SQL)) !== READONLY_CODE) {
    throw unenforced(
      `ClickHouse let the agent's request for user "${user}" lower readonly, which a settings profile allows when it marks readonly changeable, so the agent read-only profile is refused`,
    );
  }
  const write = await refusalCode(query, `CREATE DATABASE IF NOT EXISTS ${identifier(database)}`);
  if (write !== READONLY_CODE && write !== ACCESS_DENIED_CODE) {
    throw unenforced(
      `ClickHouse did not refuse a write from the agent's request for user "${user}", so the agent read-only profile is refused`,
    );
  }
}

/** One grant line as the server writes it: the privileges, the target, and whether it carries the grant option. */
interface GrantLine {
  readonly revoke: boolean;
  readonly privileges: readonly string[];
  readonly target: string;
  readonly grantOption: boolean;
}

/**
 * Splits `text` at each top-level occurrence of `separator`, outside parentheses and quotes, or answers null when a
 * quote or a parenthesis does not close.
 */
function splitTopLevel(text: string, separator: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "`" || ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  if (quote !== null || depth !== 0) return null;
  parts.push(text.slice(start));
  return parts;
}

/** A grant line read, or null when it is not a shape this reader knows. */
export function readGrantLine(line: string): GrantLine | null {
  const opening = /^(GRANT|REVOKE) /.exec(line);
  if (opening === null) return null;
  const revoke = opening[1] === "REVOKE";
  const grantOption = !revoke && line.endsWith(" WITH GRANT OPTION");
  const body = line.slice(opening[0].length, grantOption ? -" WITH GRANT OPTION".length : undefined);
  const onSplit = splitTopLevel(body, " ON ");
  if (onSplit === null || onSplit.length !== 2) return null;
  const toSplit = splitTopLevel(onSplit[1], revoke ? " FROM " : " TO ");
  if (toSplit === null || toSplit.length !== 2) return null;
  const privileges = splitTopLevel(onSplit[0], ", ");
  if (privileges === null) return null;
  return {
    revoke,
    privileges: privileges.map((privilege) => privilege.replace(/\([\s\S]*$/, "").trim()),
    target: toSplit[0].trim(),
    grantOption,
  };
}

/** The database a grant target names, unquoted, or null when it names every database or a pattern of them. */
function targetDatabase(target: string): string | null {
  const parts = splitTopLevel(target, ".");
  if (parts === null || parts.length !== 2) return null;
  const database = parts[0].replace(/^`([\s\S]*)`$/, "$1");
  return database.includes("*") ? null : database;
}

function privilegeRefusal(privilege: string, target: string, user: string): ExecutionProfileError {
  const reason = CLICKHOUSE_SOURCE_PRIVILEGES.includes(privilege)
    ? "a source grant, which reaches a server or a file outside this one"
    : CLICKHOUSE_READONLY_EXEMPT_PRIVILEGES.includes(privilege)
      ? "a grant whose statements readonly does not refuse"
      : "not a read";
  return tooBroad(
    `ClickHouse user "${user}" holds ${privilege} ON ${target}, ${reason}; the agent read-only profile takes a user holding only SELECT and SHOW on named databases or tables, so it is refused`,
  );
}

async function verifyGrants(query: AgentProofQuery, user: string): Promise<void> {
  const { rows, fieldNames } = await query(GRANTS_SQL);
  const column = fieldNames?.[0];
  if (column === undefined) throw tooBroad(`ClickHouse answered no grants for user "${user}" the profile can read`);
  for (const row of rows) {
    const text = row[column];
    const grant = typeof text === "string" ? readGrantLine(text) : null;
    if (grant === null) {
      throw tooBroad(
        `ClickHouse answered a grant line for user "${user}" the agent read-only profile cannot read, so it is refused`,
      );
    }
    if (grant.revoke) continue;
    if (grant.grantOption) {
      throw tooBroad(
        `ClickHouse user "${user}" holds a grant WITH GRANT OPTION on ${grant.target}, so the agent read-only profile is refused`,
      );
    }
    for (const privilege of grant.privileges) {
      if (!CLICKHOUSE_AGENT_PRIVILEGES.includes(privilege)) throw privilegeRefusal(privilege, grant.target, user);
    }
    const database = targetDatabase(grant.target);
    if (database === null || SERVER_SCHEMAS.includes(database.toUpperCase())) {
      throw tooBroad(
        `ClickHouse user "${user}" holds ${grant.privileges.join(", ")} ON ${grant.target}, which is not one named database or table outside the server's own schemas, so the agent read-only profile is refused`,
      );
    }
  }
}

async function verifyQueryLogUnreadable(query: AgentProofQuery, user: string): Promise<void> {
  const code = await refusalCode(query, QUERY_LOG_SQL);
  if (code !== ACCESS_DENIED_CODE && code !== UNKNOWN_TABLE_CODE) {
    throw tooBroad(
      `ClickHouse user "${user}" can read system.query_log, which holds every user's statements, so the agent read-only profile is refused`,
    );
  }
}

async function verifyNoExternalObject(query: AgentProofQuery, user: string): Promise<void> {
  const { rows } = await query(OBJECTS_SQL);
  if (rows.length > 0) {
    const named = rows.map((row) => `${String(row.database)}.${String(row.name)} (${String(row.engine)})`).join(", ");
    throw tooBroad(
      `ClickHouse user "${user}" can see ${named}, each reading an external source, another object or another user's grants; the agent read-only profile takes a user who sees local tables and invoker views only, so it is refused`,
    );
  }
  const answer = await attempt(query, DICTIONARIES_SQL);
  if (answer.kind === "refused") {
    if (answer.code === ACCESS_DENIED_CODE) return;
    throw tooBroad(
      `ClickHouse answered code ${answer.code} when the agent read-only profile read the dictionaries user "${user}" can read, so it is refused`,
    );
  }
  const dictionaries = answer.result.rows;
  if (dictionaries.length > 0) {
    throw tooBroad(
      `ClickHouse user "${user}" can read the dictionary ${String(dictionaries[0].database)}.${String(dictionaries[0].name)}, which loads from its source under its own credential, so the agent read-only profile is refused`,
    );
  }
}

/** Every check of the module docblock, in its order; the first that fails throws. */
export async function verifyAgentProfile(query: AgentProofQuery, database: string): Promise<void> {
  const user = await verifyServer(query);
  await verifyWritesRefused(query, database, user);
  await verifyGrants(query, user);
  await verifyQueryLogUnreadable(query, user);
  await verifyNoExternalObject(query, user);
}
