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
  /*
    Added when the unfenced cut started reading the CONNECTION'S dialect instead of the
    compatibility default. Where a statement ends is exactly what this record decides, and its
    answers differ on shipped engines — `//` is a line comment in CQL and ClickHouse and an
    operator name or a syntax error everywhere else — so a draft whose comment carried a `;` was
    cut at that `;` and the run recorded half its statement.

    Admitted on the same ground as the splitter, and the ground is already MEASURED here rather
    than argued: the closure test below walks `./statement-splitter` and finds `./grammar` in it
    with `@/lib/types` as its only reach, then asserts that reach is type-only. So this specifier
    adds nothing to the browser bundle that the previous entry had not already brought — the
    module was one hop away and is now zero.
  */
  "@/lib/sql/grammar",
]);

describe("the plan-draft reader stays reachable from a browser", () => {
  test("it imports nothing outside the allowed set", () => {
    expect(specifiers(SOURCE).filter((specifier) => !ALLOWED.has(specifier))).toEqual([]);
  });

  test("everything the splitter reaches is a pure SQL reader, so admitting it costs nothing transitively", () => {
    /*
      The half the allowlist cannot check. This file reads `plan-draft.ts`'s own specifiers, so a
      dependency added to `statement-splitter.ts` would leave that list unchanged and this
      boundary green while the browser pays for it — which is the exact shape of the zod incident
      the header describes.

      This used to assert ZERO imports, which was the stronger property. S1 spent it deliberately:
      the splitter was walking spans itself, disagreeing with every other reader about which `;` is
      code, and one shape yielded a runnable bare `DROP` fragment — so it now reads through
      `spans.ts` under a `grammar.ts` record. Zero is therefore replaced by the CLOSURE, computed
      here rather than named at one level: every module reachable from the splitter must be one of
      these two readers, whose own only reach is a TYPE-ONLY import of the shared type module. That
      is checked below, so a value import appearing anywhere in the closure fails this test rather
      than a browser.
    */
    const read = (specifier: string) =>
      fs.readFileSync(path.join(process.cwd(), "src/lib/sql", `${specifier.replace("./", "")}.ts`), "utf8");

    const closure = new Set<string>();
    const pending = ["./statement-splitter"];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      for (const specifier of specifiers(read(current))) {
        if (closure.has(specifier)) continue;
        closure.add(specifier);
        if (specifier.startsWith("./")) pending.push(specifier);
      }
    }

    expect([...closure].sort()).toEqual(["./grammar", "./spans", "@/lib/types"]);
    // The one non-relative member, and it is erased at build time: a VALUE import of the shared
    // type module would pull the whole type barrel into the browser bundle.
    expect(read("./grammar")).toContain('import type { DatabaseType } from "@/lib/types"');
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
