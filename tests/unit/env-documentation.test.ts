/**
 * Drift guard: every environment variable `src/` reads is documented (#566).
 *
 * `CLAUDE.md` states that every environment variable is documented in
 * `.env.example` with an example. Nothing enforced it, and `LOG_LEVEL` drifted:
 * `src/lib/logger.ts` read it, the Helm chart wrote it into the ConfigMap from
 * `config.logLevel`, and `docs/HELM_CHART.md` listed it, but the file operators
 * are told to copy never mentioned it.
 *
 * This turns the *next* one into a failing test rather than a discovery.
 *
 * The allowlist is deliberately hostile to growth: each entry carries a reason,
 * and a test asserts the reasons are non-empty, so adding a name here is a
 * visible decision in review rather than a one-word diff. Anything an operator
 * could reasonably want to set belongs in `.env.example`, not here.
 *
 * Coverage boundary (#609). The extractor resolves three same-file shapes:
 *
 * 1. literal `process.env.NAME` / `process.env?.NAME`;
 * 2. `const X = "NAME"` (exported or not), then `process.env[X]`;
 * 3. object fields whose value is a bare uppercase string literal, then
 *    `process.env[<expr>.field]` (the rate-limit bucket table).
 *
 * Helper-argument reads such as `getEnvVar("LLM_PROVIDER")` and
 * `process.env[envVar]` where the name arrives as a parameter stay out of
 * scope: they need a call-graph, and a regex guard that pretended to have one
 * would report a name that is not a name. At the time of #609 that left six
 * names out of reach (HOSTNAME, MY_DB_PASSWORD, and four LLM_*), against
 * sixteen recovered by shapes 2 and 3.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const ENV_EXAMPLE = readFileSync(path.join(ROOT, ".env.example"), "utf8");

/**
 * Names that are read but deliberately absent from `.env.example`, each with
 * the reason it is not operator-facing. Platform- or build-time only.
 */
const ALLOWLIST: Record<string, string> = {
  NODE_ENV: "Set by the runtime and by `next build`, never by an operator.",
  NEXT_RUNTIME: "Injected by Next.js to distinguish the edge and Node runtimes.",
  PORT: "Supplied by the platform (Docker, systemd, the chart), not by `.env`.",
  NEXT_PUBLIC_APP_VERSION:
    "Injected by next.config.ts from package.json at build time; setting it by hand would misreport the version.",
  NEXT_PUBLIC_MANAGED_POLL_MS:
    "Inlined at build time, so a runtime value has no effect. Documented in docs/SEED_CONNECTIONS.md.",
  VERCEL_DEPLOYMENT_ID:
    "Injected by the Vercel platform; read only to refuse an implicit hosted backend, never set by an operator.",
};

/** Env-var-shaped identifiers: starts with a letter, then uppercase / digits / underscore. */
const ENV_NAME = "[A-Z][A-Z0-9_]*";
const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** Every `.ts`/`.tsx` file under `src/`. */
const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

/**
 * Environment variable names read under `src/`, including the two statically
 * resolvable bracket shapes from #609. Deduplicated and sorted.
 */
const readNames = (): string[] => {
  const names = new Set<string>();
  // Literal `process.env.NAME` and optional-chained `process.env?.NAME`.
  const literalPattern = new RegExp(`process[.]env[?]?[.](${IDENT})`, "g");
  // Same-file `const X = "NAME"` / `export const X = "NAME"`.
  const constPattern = new RegExp(`(?:export\\s+)?const\\s+(${IDENT})\\s*=\\s*"(${ENV_NAME})"`, "g");
  // Bracket read of a bare identifier: `process.env[X]` (optional chaining on env allowed).
  const constReadPattern = new RegExp(`process[.]env[?]?\\[(${IDENT})\\]`, "g");
  // Object field whose value is a bare uppercase string literal: `maxVar: "RATE_LIMIT_QUERY_MAX"`.
  const fieldPattern = new RegExp(`(${IDENT})\\s*:\\s*"(${ENV_NAME})"`, "g");
  // Bracket read through a property: `process.env[spec.maxVar]`.
  const fieldReadPattern = new RegExp(`process[.]env[?]?\\[${IDENT}[.](${IDENT})\\]`, "g");

  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    const source = readFileSync(file, "utf8");

    for (const match of source.matchAll(literalPattern)) {
      names.add(match[1]);
    }

    const constNames = new Map<string, string>();
    for (const match of source.matchAll(constPattern)) {
      constNames.set(match[1], match[2]);
    }
    for (const match of source.matchAll(constReadPattern)) {
      const resolved = constNames.get(match[1]);
      if (resolved !== undefined) names.add(resolved);
    }

    const fieldValues = new Map<string, Set<string>>();
    for (const match of source.matchAll(fieldPattern)) {
      const field = match[1];
      const value = match[2];
      let bucket = fieldValues.get(field);
      if (bucket === undefined) {
        bucket = new Set();
        fieldValues.set(field, bucket);
      }
      bucket.add(value);
    }
    for (const match of source.matchAll(fieldReadPattern)) {
      const values = fieldValues.get(match[1]);
      if (values !== undefined) {
        for (const value of values) names.add(value);
      }
    }
  }
  return [...names].sort();
};

/**
 * `.env.example` documents a name when a line assigns it, commented or not.
 * Matching on the whole line rather than a substring is what keeps this honest:
 * a mention inside prose must not count, or the guard goes quietly vacuous.
 */
const isDocumented = (name: string): boolean =>
  ENV_EXAMPLE.split(/\r?\n/).some((line) => {
    const bare = line.trim().replace(/^#+/, "").trim();
    return bare.startsWith(name + "=");
  });

describe("environment variable documentation", () => {
  test("the extractor finds the variables it is meant to check", () => {
    // Without this the two assertions below would pass on an empty list.
    const names = readNames();
    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain("LOG_LEVEL");
    expect(names).toContain("JWT_SECRET");
    // Shape 2 (#609): same-file const alias, then process.env[X].
    expect(names).toContain("LIBREDB_AGENT_ENABLED");
    expect(names).toContain("WORKFLOW_LOCAL_DATA_DIR");
    // Shape 3 (#609): object-field uppercase literal, then process.env[spec.field].
    expect(names).toContain("RATE_LIMIT_QUERY_MAX");
    expect(names).toContain("RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SEC");
  });

  test("every variable read under src/ is documented or allowlisted", () => {
    const undocumented = readNames().filter((name) => !isDocumented(name) && !(name in ALLOWLIST));
    expect(undocumented).toEqual([]);
  });

  test("LOG_LEVEL is documented with its accepted values and both defaults", () => {
    // The variable this guard was written for. Naming the values and the two
    // NODE_ENV-dependent defaults is the part that makes the entry useful
    // rather than merely present.
    expect(isDocumented("LOG_LEVEL")).toBe(true);
    const block = ENV_EXAMPLE.slice(ENV_EXAMPLE.indexOf("─── Logging"), ENV_EXAMPLE.indexOf("# LOG_LEVEL="));
    for (const level of ["debug", "info", "warn", "error"]) {
      expect(block).toContain(level);
    }
    expect(block).toContain("production");
  });

  test("every allowlisted name is still read, and still carries a reason", () => {
    // An allowlist that outlives the code it excuses is how the next variable
    // slips through: the entry stays, the read moves, and nobody notices.
    const names = new Set(readNames());
    for (const [name, reason] of Object.entries(ALLOWLIST)) {
      expect(names.has(name), `${name} is allowlisted but no longer read`).toBe(true);
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
  });

  test("no allowlisted name is also documented", () => {
    // Both would mean the reason is wrong: it is operator-facing after all.
    for (const name of Object.keys(ALLOWLIST)) {
      expect(isDocumented(name), `${name} is documented, so it does not belong on the allowlist`).toBe(false);
    }
  });
});
