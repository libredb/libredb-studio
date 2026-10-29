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
 * `providers/timeseries/influxdb/sql-provider.ts`, `providers/sql/search/index.ts`), and that probe
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
 * the driver rolls back. Each provider's own `queryReadOnly` argues its own case.
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
