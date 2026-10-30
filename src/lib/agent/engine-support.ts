import type { DatabaseType } from "@/lib/types";

/**
 * The engines on which **agent mode** executes statements itself.
 *
 * This mirrors - it does not implement - the factory's gate. A profiled acquisition is
 * refused unless the provider exposes a read-only statement path
 * (`acquisition.requiresReadOnlyStatements && typeof provider.queryReadOnly !== "function"`,
 * `src/lib/db/factory.ts`), which throws `PROFILE_UNSUPPORTED_BY_PROVIDER` and ends the run
 * `engine-unsupported`. `queryReadOnly` exists on the providers this list names, each under a
 * boundary it declares (`providers/sql/postgres.ts`, `providers/sql/sqlite.ts`,
 * `providers/sql/duckdb/`, `providers/sql/mssql.ts`, `providers/sql/mysql.ts`,
 * `providers/platform/kubernetes/`, `providers/document/mongodb/index.ts`,
 * `providers/sql/clickhouse/index.ts`, `providers/sql/libsql/index.ts`,
 * `providers/timeseries/influxdb/sql-provider.ts`, `providers/sql/search/index.ts`,
 * `providers/sql/db2/index.ts`), and that probe
 * stays the real rule: replacing it with this list would let the list go stale against the
 * drivers.
 *
 * They do not draw the boundary the same way, and the list deliberately says nothing about that.
 * PostgreSQL, SQLite, DuckDB, SQL Server and MySQL bound a statement with the engine's own
 * read-only mechanism. PostgreSQL refuses the write inside `BEGIN READ ONLY`, SQLite and DuckDB
 * open the file read-only, and SQL Server, which has no read-only transaction of any kind,
 * verifies at open that the session's principal cannot write, then admits one statement at a
 * time by asking the optimizer to compile it without running it. MySQL and MariaDB are the
 * two-layer shape: a least-privilege principal, because DDL ends a read-only transaction through
 * its implicit commit, and `START TRANSACTION READ ONLY` for the writes the grants alone would
 * not stop. Kubernetes has no read-only session at all: Studio's request allowlist on the final
 * method and path of every request, plus the identity's RBAC, is the boundary. MongoDB has none
 * either: the connection's user is the boundary, proven, when a connection that sends statements
 * opens, by the server's own account of its privileges and by a write the server must refuse,
 * with the provider's command reader in front of the engine and `maxTimeMS` plus Studio's kill of
 * a read's session as its deadline. ClickHouse refuses writes for the request itself, under
 * `readonly = 1`, and its user is proven at open to hold nothing that setting leaves usable.
 * libSQL's boundary is the token: one the server refuses every write for, proven at open by
 * writes that change nothing and that the server must refuse, and by the token's own read-only
 * claim. InfluxDB 3's boundary is the engine's: the 3.12 Core planner refuses every write and DDL
 * statement on the one route that carries statement text, whatever the token, and the open
 * checks the server is that line. Elasticsearch's boundary is the engine's too: the grammar of
 * its SQL endpoint, the one route that carries statement text, holds no write or DDL statement,
 * and every one sent raw there is refused, and the open checks the server is the measured 9.1 line. OpenSearch's is
 * the engine's as well, from the same module: its SQL plugin refuses every write and DDL statement sent raw, and since
 * a cluster setting can turn its DELETE on, the open proves that DELETE off (the setting reads off, and a DELETE on a
 * fresh name is refused) and checks the server is the measured 3.8 line. Oracle's is the user's: one set READ ONLY,
 * which the server refuses every write for, proven before every statement to reach no code, sequence, package,
 * directory, system privilege or database link that runs outside it, with every statement in a read-only transaction
 * the driver rolls back. Db2's is the user's too: one holding CONNECT and SELECT, proven before every statement to hold
 * nothing else that writes and to reach no code, view, sequence or control that runs with another's authority, with
 * every statement a fullselect in a unit of work rolled back on a connection of its own. Cassandra's is the role's: one
 * holding only SELECT on the connection's keyspace, which the server refuses every write, DDL and GRANT statement as
 * Unauthorized, proven before every statement to be no superuser, to hold no other permission, and to reach no column
 * masked with a user-defined function, on an Apache Cassandra 5.0 server whose own refusal of a DROP proves it
 * enforces grants, each statement on a session of its own. Couchbase's is the user's: one whose only role is
 * query_select on named scopes of the connection's bucket (a role on every scope also reaches its _system scope, so
 * it is refused). The query service refuses such a user every write, DDL, GRANT, function call, CURL() and sequence
 * statement, and the user is proven before every statement through GET /whoami, a group's roles included, on a
 * server whose own refusal of a DELETE proves it enforces the role, with only one SELECT sent, since such a user may
 * still run UPDATE STATISTICS and EXECUTE. Druid's is the engine's: under the native engine its SQL endpoint refuses
 * every INSERT, REPLACE, UPDATE, DELETE, MERGE and DDL statement and every read of EXTERN, whoever asks, which the open
 * and every statement prove with an INSERT the server must refuse, and the request context naming the engine is
 * written by Studio, with only one SELECT sent, since a SET before a statement would select another engine. LibreDB's is
 * the handle's: an embedded file with no principal, which each statement opens on a handle of its own through Studio's
 * read-only file adapter, with no writer lock, so it opens beside the editor's writer, and with no call that can write
 * the file, the engine's one write path refusing before any write; Studio's reader admits get, prefix and range only.
 * InfluxDB's (InfluxQL, 1.x and 2.x) is the principal's: a 1.x user refused SHOW USERS as needing the admin privilege,
 * or a 2.x token that lists no system bucket, refused a no-op DELETE on every database it lists, proven before every
 * statement, so an admin, a server with authentication off and a principal that can write anywhere, where SELECT ...
 * INTO would land, are refused; InfluxDB 3 is refused on this path. Studio's reader admits one SELECT, SHOW of the
 * catalog or EXPLAIN of a SELECT, with no comment. Weaviate's is the provider's closed table of read requests, which
 * can name no write, with a key the server proves a viewer before every request, so a connection with no key, an
 * admin key, a role that writes and a server with RBAC off are refused; Studio's reader admits the meta, schema,
 * shard, tenant, alias and node reads and a bare aggregate count, a COLD tenant is refused rather than woken, and every
 * answer carries names, counts and flags only. Qdrant's is the provider's closed table of read routes, which can name no
 * write, with a key proved read-only before every request by its JWT claims, when it has them, granting access r
 * alone, and by the server refusing an empty alias update and an empty point delete on every collection the key lists,
 * so a connection with no key, the API key, a JWT that writes any collection or alias and a server with no key
 * configured are refused; Studio's reader admits the version, collection, alias, count and cluster reads, so no query
 * reaches the inference address, and every answer carries names, counts and flags only. Neo4j's is the user's, on
 * Enterprise Edition only: before every statement the server must name Enterprise at a version whose built-in routines
 * are pinned, every granted privilege of every role must be a read, LOAD must be revoked or denied, and every
 * procedure and function the user can execute must be a built-in, so an administrator, a user that writes or loads, a
 * server with an extension the user can run and Community Edition, which has no roles, are refused. Studio's reader
 * admits one statement of the editor's read policy with no comment, and the server's EXPLAIN classification and a READ
 * session stand behind it. Each provider's own `queryReadOnly` argues its own case.
 * `tests/unit/lib/agent/engine-support.test.ts` is what keeps the two equal - it walks EVERY
 * id in the `DatabaseType` union, reads `queryReadOnly` off the real provider class the
 * factory would construct, and fails if this array and the drivers diverge in either direction.
 *
 * Two things it deliberately does NOT say, because user-facing copy that compresses them
 * overclaims (docs/AGENT.md, the "Agent mode requires" paragraph that opens it):
 * - **Plan mode executes nothing, on any engine.** This list has no bearing on it; since #414
 *   a plan run is grounded everywhere and still runs no statement anywhere.
 * - **The `operations` workflow runs on every engine, in both modes**, because it composes no
 *   SQL: its `agent-operations` acquisition sets `requiresReadOnlyStatements: false`.
 *
 * Imports nothing but the type union on purpose. It is read by the unauthenticated login
 * hero, and a provider module here would drag `oracledb`/`mssql` toward that bundle.
 */
export const AGENT_EXECUTION_ENGINES: readonly DatabaseType[] = [
  "postgres",
  "sqlite",
  "duckdb",
  "mssql",
  "mysql",
  "kubernetes",
  "mongodb",
  "clickhouse",
  "libsql",
  "influxdb3",
  "elasticsearch",
  "opensearch",
  "oracle",
  "db2",
  "cassandra",
  "couchbase",
  "druid",
  "libredb",
  "influxdb",
  "weaviate",
  "qdrant",
  "neo4j",
];

/**
 * Names, joined the way a sentence joins them: `a`, `a and b`, `a, b and c`.
 *
 * It lives here because the list this module publishes is printed in three places: the login hero
 * (`src/components/login/hero-proof.tsx`), the agent posture popover (`src/lib/agent/posture.ts`)
 * and the MCP `run_read_query` description (`src/lib/mcp/tools/statement-arms.ts`), which
 * `docs/MCP.md` repeats under `tests/unit/mcp-documentation.test.ts`. The first two had each
 * written `join(" and ")`, which was indistinguishable from correct while the array held two
 * engines and became "PostgreSQL and SQLite and DuckDB" on the login page the moment it held three.
 * Shared rather than fixed twice, so the FOURTH engine could not reopen it, and the
 * fifth did not (MySQL, #1612).
 *
 * Hand-rolled rather than `Intl.ListFormat`, deliberately: the formatter's output depends
 * on the ICU locale data the runtime was built with (`en-US` inserts an Oxford comma,
 * `en-GB` does not), and these strings are asserted in tests and read by users of an
 * English-only interface. A join nobody can localise is the one that renders the same on
 * a server, in a browser and in CI.
 */
export function namedList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
