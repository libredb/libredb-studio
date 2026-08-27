import type { DatabaseType } from "@/lib/types";

/**
 * The engines on which **agent mode** executes statements itself.
 *
 * This mirrors - it does not implement - the factory's gate. A profiled acquisition is
 * refused unless the provider exposes a database-native read-only statement path
 * (`acquisition.requiresReadOnlyStatements && typeof provider.queryReadOnly !== "function"`,
 * `src/lib/db/factory.ts`), which throws `PROFILE_UNSUPPORTED_BY_PROVIDER` and ends the run
 * `engine-unsupported`. `queryReadOnly` exists on exactly three providers today
 * (`providers/sql/postgres.ts`, `providers/sql/sqlite.ts`, `providers/sql/duckdb/`), and that probe stays the real
 * rule: replacing it with this list would let the list go stale against the drivers.
 * `tests/unit/lib/agent/engine-support.test.ts` is what keeps the two equal - it walks EVERY
 * id in the `DatabaseType` union, reads `queryReadOnly` off the real provider class the
 * factory would construct (`mongodb` excepted: its module cannot be imported under Bun, so
 * that one id is checked by source scan), and fails if this array and the drivers diverge in
 * either direction.
 *
 * Two things it deliberately does NOT say, because user-facing copy that compresses them
 * overclaims (docs/AGENT.md, "How the agent is bounded"):
 * - **Plan mode executes nothing, on any engine.** This list has no bearing on it; since #414
 *   a plan run is grounded everywhere and still runs no statement anywhere.
 * - **The `operations` workflow runs on every engine, in both modes**, because it composes no
 *   SQL: its `agent-operations` acquisition sets `requiresReadOnlyStatements: false`.
 *
 * Imports nothing but the type union on purpose. It is read by the unauthenticated login
 * hero, and a provider module here would drag `oracledb`/`mssql` toward that bundle.
 */
export const AGENT_EXECUTION_ENGINES: readonly DatabaseType[] = ["postgres", "sqlite", "duckdb"];

/**
 * Names, joined the way a sentence joins them: `a`, `a and b`, `a, b and c`.
 *
 * It lives here because the list this module publishes is what both callers print - the
 * login hero (`src/components/login/hero-proof.tsx`) and the agent posture popover
 * (`src/lib/agent/posture.ts`) - and each of them had written `join(" and ")`. That was
 * indistinguishable from correct while the array held two engines and became
 * "PostgreSQL and SQLite and DuckDB" on the login page the moment it held three. Shared
 * rather than fixed twice, so the FOURTH engine cannot reopen it.
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
