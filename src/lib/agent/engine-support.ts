/**
 * Names, joined the way a sentence joins them: `a`, `a and b`, `a, b and c`.
 *
 * It lives here because the review record it joins, `GRANTED_AGENT_EXECUTION_ENGINES` in `src/lib/db/claim-grants.ts`, is
 * printed in three places: the login hero
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
