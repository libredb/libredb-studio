/**
 * A declared trailing limit clause is anchored as a whole, at its start and at the statement's end, in a bounded Node
 * child (src/lib/db/utils/query-limiter.ts, `clausePattern`; docs/providers/CONTRACT.md, clause S-6).
 *
 * The schema admits a clause whose source holds a top-level alternative, `\s+A\s*$|\s+B\s*$`, so the limiter cannot
 * anchor only the first alternative behind a character that is not whitespace: every later alternative would then be
 * tried from every position of a whitespace run, in time quadratic in the run's length, and an earlier alternative that
 * does not end in `\s*$` would match in the middle of a statement and strip the text after it. Each child plants such a
 * clause on trino, whose shipped grammar declares none, as a declaration states it: through a stub of the generated SQL
 * text the SQL grammar is composed from, the shipped record with trino's clauses replaced. Without the whole-pattern
 * anchor the first case reads a million spaces for minutes, so the spawn timeout kills the child within seconds and the
 * case fails by its exit, and the second answers a statement with ` = 1` dropped. The child holds a referenced
 * interval, so it cannot exit early (tests/helpers/bounded-node-child.ts).
 *
 * Each case answers whether `applyQueryLimit` gave the statement as written with the bound appended after it, the
 * answer a statement gets where no declared clause matches it, and the answer's tail.
 * tests/unit/db/query-limiter.test.ts and tests/unit/db/bounded-limiter.test.ts hold every shipped clause's answers, in
 * the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { applyQueryLimit } from "@/lib/db/utils/query-limiter";
import { type BoundedChild, boundedChild } from "../../helpers/bounded-node-child";

interface ChildDeps {
  readonly applyQueryLimit: typeof applyQueryLimit;
}

interface ClauseReport {
  readonly limited: boolean;
  readonly appended: boolean;
  readonly tail: string;
}

const SOURCE = path.join(import.meta.dir, "..", "..", "..", "src");

/**
 * A stub of the generated SQL text: the shipped record with `source` as trino's one trailing limit clause, flags `i`.
 */
function plantedTrino(source: string): string {
  const shipped = path.join(SOURCE, "lib", "db", "engine-catalog", "sql-text.generated.ts");
  const clause = JSON.stringify({ source, flags: "i" });
  return [
    `import { BUNDLED_SQL_TEXT as SHIPPED } from ${JSON.stringify(shipped)};`,
    "export const BUNDLED_SQL_TEXT = {",
    "  ...SHIPPED,",
    `  trino: { ...SHIPPED.trino, grammar: { ...SHIPPED.trino.grammar, trailingLimitClauses: [${clause}] } },`,
    "};",
    "",
  ].join("\n");
}

/** A child whose trino row declares the one clause `source`, answering the limit of the statement its case names. */
function childPlanting(label: string, source: string): BoundedChild {
  return boundedChild({
    label,
    imports: [{ from: path.join(SOURCE, "lib", "db", "utils", "query-limiter.ts"), names: ["applyQueryLimit"] }],
    runCase: (deps: ChildDeps, name: string): ClauseReport => {
      const text =
        name === "long-whitespace" ? `SELECT 1${" ".repeat(1_000_000)}C` : "SELECT * FROM t WHERE x NOWAIT = 1";
      const limited = deps.applyQueryLimit(text, 10, 0, {}, "trino");
      return {
        limited: limited.wasLimited,
        appended: limited.sql === `${text} LIMIT 10`,
        tail: limited.sql.slice(-30),
      };
    },
    heapLimitMiB: 256,
    timeoutMs: 10_000,
    stubs: [{ specifier: "@/lib/db/engine-catalog/sql-text.generated", source: plantedTrino(source) }],
  });
}

const alternatives = childPlanting("limiter-clause-alternatives", String.raw`\s+A\s*$|\s+B\s*$`);
const midStatement = childPlanting("limiter-clause-mid-statement", String.raw`\s+NOWAIT|\s+SKIP\s+LOCKED\s*$`);

beforeAll(async () => {
  await alternatives.build();
  await midStatement.build();
});

afterAll(() => {
  alternatives.remove();
  midStatement.remove();
});

describe("a declared trailing limit clause in a bounded child", () => {
  test("a clause with a top-level alternative is anchored at its start, so a long whitespace run is read in linear time", async () => {
    expect(await alternatives.run<ClauseReport>("long-whitespace")).toEqual({
      limited: true,
      appended: true,
      tail: `${" ".repeat(20)}C LIMIT 10`,
    });
  }, 20_000);

  test("a clause with a top-level alternative is anchored at the statement's end, so an alternative that does not end it strips nothing", async () => {
    expect(await midStatement.run<ClauseReport>("mid-statement")).toEqual({
      limited: true,
      appended: true,
      tail: "SELECT * FROM t WHERE x NOWAIT = 1 LIMIT 10".slice(-30),
    });
  }, 20_000);
});
