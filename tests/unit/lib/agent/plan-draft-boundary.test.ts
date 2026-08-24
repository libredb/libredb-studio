import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The boundary that keeps the plan-draft reader reachable from a browser (#396).
 *
 * The rail has to read a plan run's deliverable with the SAME reader the server records
 * it with — a second, fence-blind reading in the browser is what let the two disagree
 * about whether a run refused. The obvious way to arrange that was to import
 * `plan-statement.ts`, which was checked, found to import only zod and pure SQL
 * helpers, and called client-safe.
 *
 * It was not. `zod` v4 probes `new Function("")` at module load to decide whether it may
 * compile validators, and a browser under a strict `script-src` fires
 * `securitypolicyviolation` even though zod catches the throw. Every page rendering an
 * agent run took a CSP violation, and nothing caught it until an end-to-end run in a
 * real browser did — six local gates and twenty CI checks all passed.
 *
 * The lesson is not "do not import server code". It is that a module's DIRECT imports
 * were inspected and the TRANSITIVE cost is what the policy measures. So the boundary is
 * pinned here rather than described in a comment: `plan-draft.ts` may import nothing but
 * types and the fence-tag predicate, and the next dependency added to it fails this test
 * instead of a browser.
 */

const SOURCE = fs.readFileSync(path.join(process.cwd(), "src/lib/agent/plan-draft.ts"), "utf8");

/** Every module specifier the file imports, type-only imports included. */
const specifiers = (source: string): readonly string[] =>
  [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);

/**
 * What the reader is allowed to reach.
 *
 * Deliberately an exact set and not a prefix rule. "Anything under `@/lib/sql`" would
 * have admitted the grammar and span readers, which are pure today and are one commit
 * away from not being — and admitting a module because of where it sits is the same
 * reasoning that admitted the guard.
 */
const ALLOWED: ReadonlySet<string> = new Set([
  "@/lib/sql/fence-tags",
  "@/lib/types",
  /*
    Added when the unfenced reader stopped cutting statements at a blank line and started cutting
    them where the SQL ends, which needs a scanner that knows about strings, comments and
    dollar-quoting.

    Admitted on the ONE ground this file accepts: it imports nothing at all, which the test below
    asserts rather than this comment claiming. That matters more here than "it is pure today",
    because the lesson recorded above is precisely that direct imports were inspected and the
    transitive cost is what the policy measures — and a specifier list for THIS file cannot see a
    dependency the splitter gains later.
  */
  "@/lib/sql/statement-splitter",
]);

describe("the plan-draft reader stays reachable from a browser", () => {
  test("it imports nothing outside the allowed set", () => {
    expect(specifiers(SOURCE).filter((specifier) => !ALLOWED.has(specifier))).toEqual([]);
  });

  test("the splitter it now reaches imports nothing, so admitting it costs nothing transitively", () => {
    /*
      The half the allowlist cannot check. This file reads `plan-draft.ts`'s own specifiers, so a
      dependency added to `statement-splitter.ts` would leave that list unchanged and this
      boundary green while the browser pays for it — which is the exact shape of the zod incident
      the header describes.

      Zero imports is a stronger property than "pure": it cannot acquire a transitive cost without
      this assertion going red first.
    */
    const splitter = fs.readFileSync(path.join(process.cwd(), "src/lib/sql/statement-splitter.ts"), "utf8");

    expect(specifiers(splitter)).toEqual([]);
  });

  test("it does not reach the statement guard, which is where zod enters", () => {
    // Named explicitly as well as excluded by the set above, because this is the
    // specific import that shipped an eval probe to the browser and the one a future
    // reader is most likely to add back for the same good reason.
    //
    // Asserted over the SPECIFIERS and not the file text: this module's own docblock
    // names both the guard and zod, which is the whole point of it, and a text search
    // failed on the explanation rather than on an import.
    const imported = specifiers(SOURCE).join(" ");

    expect(imported).not.toContain("statement-guard");
    expect(imported).not.toContain("zod");
  });

  test("the validation half still holds the guard, so the split moved the reader and not the rule", () => {
    // The other direction of the same boundary: had the guard simply been dropped, this
    // test file would pass while the drafted statement stopped being classified at all.
    const validation = fs.readFileSync(path.join(process.cwd(), "src/lib/agent/plan-statement.ts"), "utf8");

    expect(validation).toContain("@/lib/db/operations/statement-guard");
  });
});
