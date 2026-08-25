/**
 * The accuracy gate for outward-facing marketplace copy.
 *
 * These four files are submissions to somebody else's catalog: Railway, DigitalOcean,
 * SUSE PCSC and Azure Partner Center. Nobody in this repo reviews them again once they
 * are mailed, so the only thing standing between a corrected claim and its return is a
 * test. A previous revision replaced a false natural-language-to-SQL claim with two new
 * ones - "AI query explanation on any connection" (true on 7 of the 14 engines) and
 * "never executes what it recommends" (the consented hand-over runs exactly the
 * recommended statement) - which is why the gate is phrase-level rather than a review
 * note in the file itself: a file that audits itself against a false line is worse than
 * one that does not.
 *
 * The explain-capable set is DERIVED from the providers, never listed here. The UI hides
 * the Explain tab unless the provider declares `explainFormat`
 * (`src/components/studio/BottomPanel.tsx`), so the set of files declaring it IS the set
 * of engines the copy may name - and an engine that gains or loses a plan format moves
 * this test's expectation on its own, the way `src/lib/agent/posture.ts` derives every
 * engine name it prints.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DB_UI_CONFIG, getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";

const REPO_ROOT = join(import.meta.dir, "../..");
const PROVIDER_ROOT = join(REPO_ROOT, "src/lib/db/providers");

const LISTINGS = {
  railway: "deploy/railway/TEMPLATE_OVERVIEW.md",
  digitalocean: "deploy/digitalocean/assets/description-long.md",
  rancher: "deploy/rancher/CATALOG_LISTING.md",
  azure: "deploy/azure/listing/listing-fields.md",
} as const;

/**
 * The part of a file that is actually submitted, with the editorial matter around it cut
 * away. Only `CATALOG_LISTING.md` has any: its accuracy-gate blockquote and its
 * outstanding-corrections table exist to NAME the wrong claims, so a phrase ban applied
 * to the whole file would forbid the note that forbids the phrase. The gate itself is
 * checked separately, by what it must SAY.
 */
function submittedCopy(path: string): string {
  const content = readFileSync(join(REPO_ROOT, path), "utf8");
  if (path !== LISTINGS.rancher) return content;
  const from = content.indexOf("## Short description");
  const to = content.indexOf("## Outstanding corrections");
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return content.slice(from, to);
}

/** Every `.ts` file under the provider tree, at any depth. */
function providerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return providerFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * The canonical type-id a provider file implements, from its own path: `postgres.ts` is
 * `postgres`, `druid/index.ts` is `druid`. The repo's 1:1 rule between a type-id and
 * `providers/<family>/<type-id>.ts` is what makes the path readable as an id.
 */
function typeIdOf(file: string): string {
  const name = basename(file, ".ts");
  return name === "index" ? basename(dirname(file)) : name;
}

/**
 * The engines whose provider declares a plan format. The match is anchored to the start
 * of the line so the several comment lines that discuss a MISSING `explainFormat` (the
 * search provider explains at length why it declares none) are not read as declarations.
 */
const explainCapable: DatabaseType[] = providerFiles(PROVIDER_ROOT)
  .filter((file) => /^\s*explainFormat:\s*"/m.test(readFileSync(file, "utf8")))
  .map(typeIdOf)
  .filter((id): id is DatabaseType => id in DB_UI_CONFIG)
  .sort();

/**
 * The engines a listing may NOT name in an explain sentence. `libredb` is excluded from
 * both sides: it is the embedded engine, not one of the fourteen a listing counts, and
 * its label is a substring of the product name in every one of these files.
 */
const explainIncapable = (Object.keys(DB_UI_CONFIG) as DatabaseType[])
  .filter((type) => type !== "libredb" && !explainCapable.includes(type))
  .sort();

/**
 * The sentences (or list items) of a markdown file that make an explanation claim.
 *
 * `plain[\s-]English` and not `plain English`: the Rancher key-features bullet writes it
 * attributively — "plain-English query explanation" — and a space-only match left that
 * bullet, which is submitted copy naming engines, outside the gate entirely.
 */
function explainClaims(content: string): string[] {
  return content
    .replace(/\n(?![\n\-*|>])/g, " ")
    .split(/(?<=\.)\s+|\n/)
    .filter((sentence) => /plain[\s-]English|plain language/i.test(sentence));
}

describe("the explanation claim names only engines that return a plan", () => {
  test("the derived capable set is non-trivial and excludes the plan-less engines", () => {
    // A regex that matched nothing would make every assertion below vacuous.
    expect(explainCapable.length).toBeGreaterThan(0);
    expect(explainCapable.length).toBeLessThan(explainIncapable.length + explainCapable.length);
    for (const type of ["oracle", "mssql", "mongodb", "redis", "cassandra", "elasticsearch", "opensearch"]) {
      expect(explainCapable).not.toContain(type as DatabaseType);
    }
  });

  for (const [name, path] of Object.entries(LISTINGS)) {
    test(`${name} scopes its explanation claim to those engines`, () => {
      const content = submittedCopy(path);

      // "on any connection" / "everywhere" / "on any of the engines above" are the three
      // forms the false claim took. None of them can be true while the tab is gated.
      expect(content).not.toMatch(/explanation everywhere|on any connection|on any of the engines above/i);

      for (const claim of explainClaims(content)) {
        for (const type of explainCapable) {
          expect(claim).toContain(getDBConfig(type).label);
        }
        for (const type of explainIncapable) {
          expect(claim).not.toContain(getDBConfig(type).label);
        }
      }
    });
  }
});

describe("no listing claims the agent never runs what it recommends", () => {
  for (const [name, path] of Object.entries(LISTINGS)) {
    test(`${name} keeps the drafts/recommends distinction`, () => {
      // `handover/route.ts` runs `answer.sql` - the recommended statement itself - once
      // the user consents. `posture.ts` states the true form: plan mode "executes
      // nothing it DRAFTS", and the hand-over is "reads only, and one statement in your
      // editor". "never writes" / "read-only" stay accurate and are enough.
      expect(submittedCopy(path)).not.toMatch(/\bwhat it recommends\b|\bnothing it recommends\b/i);
    });
  }
});

describe("the Druid write claim matches the provider documentation", () => {
  test("no listing says Druid has no INSERT", () => {
    // Flattened: the sentence is hard-wrapped in the file, so matching the raw text would
    // assert on where a line broke and a reflow would read as a lost claim.
    const rancher = submittedCopy(LISTINGS.rancher).replace(/\s+/g, " ");
    // `INSERT` and `REPLACE` do exist on Druid through the MSQ task engine
    // (docs/providers/druid.md §5.5). The precise form is the one the README and the
    // provider doc both carry.
    expect(rancher).not.toMatch(/no\s+`?INSERT`?,\s*`?UPDATE`?\s+or\s+`?CREATE TABLE`?/i);
    expect(rancher).toMatch(/no `UPDATE`, no `DELETE` and no `CREATE TABLE`/);
  });
});

describe("the Rancher file's own accuracy gate audits against the corrected claims", () => {
  /**
   * The editorial blockquote, which is the half of the file that is NOT submitted, with its
   * `> ` prefixes and hard wraps flattened: every sentence it must carry is longer than the
   * column it is wrapped at, so matching the raw text would assert on where a line broke.
   */
  const rancher = readFileSync(join(REPO_ROOT, LISTINGS.rancher), "utf8");
  const gate = rancher.slice(0, rancher.indexOf("## Listing facts")).replace(/^> ?/gm, "").replace(/\s+/g, " ");

  test("it names the mechanism that scopes the explanation claim", () => {
    // A gate that repeats a corrected claim is worse than no gate: it certifies the
    // defect. So it has to point at the thing that decides, not at a remembered answer.
    expect(gate).toContain("explainFormat");
    expect(gate).toContain("BottomPanel.tsx");
  });

  test("it records why 'executes nothing it recommends' is an overclaim", () => {
    expect(gate).toContain("handover/route.ts");
    expect(gate).toContain("posture.ts");
    expect(gate).toMatch(/drafts/);
  });

  test("it carries the true Druid sentence rather than the blanket one", () => {
    expect(gate).toContain("no `UPDATE`, no `DELETE` and no `CREATE TABLE`");
    expect(gate).toContain("MSQ task engine");
  });
});
