import type { DatabaseType } from "@/lib/types";

/**
 * The engines on which **agent mode** executes statements itself.
 *
 * This mirrors - it does not implement - the factory's gate. A profiled acquisition is
 * refused unless the provider exposes a database-native read-only statement path
 * (`acquisition.requiresReadOnlyStatements && typeof provider.queryReadOnly !== "function"`,
 * `src/lib/db/factory.ts`), which throws `PROFILE_UNSUPPORTED_BY_PROVIDER` and ends the run
 * `engine-unsupported`. `queryReadOnly` exists on exactly two providers today
 * (`providers/sql/postgres.ts`, `providers/sql/sqlite.ts`), and that probe stays the real
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
export const AGENT_EXECUTION_ENGINES: readonly DatabaseType[] = ["postgres", "sqlite"];
