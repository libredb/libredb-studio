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
 * Coverage boundary (#609). `process.env.NAME` is the minority shape in this
 * repository, so the extractor also resolves the two static bracket shapes that
 * make up most of the rest, both of which are string literals in the same file
 * as the read:
 *
 *   1. `const X = "NAME"` (exported or not), then `process.env[X]` -- the
 *      per-name aliases in `src/lib/agent/config.ts`;
 *   2. an object field whose value is a bare uppercase string literal, then
 *      `process.env[<identifier>.field]` -- exactly one bare identifier before
 *      the `.field`, as in the rate-limit bucket table's `process.env[spec.maxVar]`
 *      (`src/lib/api/rate-limit.ts`). A deeper receiver -- `process.env[a.b.field]`
 *      or `process.env[arr[0].field]` -- is not matched; nothing in `src/` is in
 *      that shape today.
 *
 * What stays out of scope: a name that reaches `process.env[...]` as a function
 * argument or parameter, because resolving it needs a call graph and a regex
 * that faked one would report a name that is not a name. The only remaining
 * read in that position is `process.env[envVar]` in
 * `src/lib/seed/credential-resolver.ts`, leaving `HOSTNAME` and `MY_DB_PASSWORD`
 * undiscovered. The four direct `LLM_*` reads are covered.
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
  NEXT_PUBLIC_BASE_PATH:
    "Derived from BASE_PATH by next.config.ts and baked into routes/bundles; not an independent operator setting",
  NODE_ENV: "Set by the runtime and by `next build`, never by an operator.",
  NEXT_RUNTIME: "Injected by Next.js to distinguish the edge and Node runtimes.",
  PORT: "Supplied by the platform (Docker, systemd, the chart), not by `.env`.",
  NEXT_PUBLIC_APP_VERSION:
    "Injected by next.config.ts from package.json at build time; setting it by hand would misreport the version.",
  NEXT_PUBLIC_MANAGED_POLL_MS:
    "Inlined at build time, so a runtime value has no effect. Documented in docs/SEED_CONNECTIONS.md.",
  VERCEL_DEPLOYMENT_ID:
    "Injected by the Vercel platform; read only to refuse an implicit hosted workflow backend, never set by an operator.",
};

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

/** An env-var-shaped string literal: a letter, then uppercase, digits or `_`. */
const ENV_NAME = "[A-Z][A-Z0-9_]*";
/** A JavaScript identifier. */
const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/**
 * Environment variable names read under `src/`, deduplicated and sorted. Covers
 * literal `process.env.NAME` plus the two static bracket shapes from #609 (see
 * the header comment); a name reached through a function argument stays out.
 */
const readNames = (): string[] => {
  const names = new Set<string>();
  // `process.env.NAME` and the optional-chained `process.env?.NAME` logger.ts uses.
  const literalPattern = new RegExp(`process[.]env[?]?[.](${IDENT})`, "g");
  // Shape 1: `const X = "NAME"` / `export const X = "NAME"`, then `process.env[X]`.
  const constDeclPattern = new RegExp(`(?:export\\s+)?const\\s+(${IDENT})\\s*=\\s*"(${ENV_NAME})"`, "g");
  const constReadPattern = new RegExp(`process[.]env[?]?\\[(${IDENT})\\]`, "g");
  // Shape 2: `field: "NAME"`, then `process.env[<identifier>.field]` -- one bare
  // identifier before `.field` (the bucket table); a deeper receiver is not matched.
  const fieldDeclPattern = new RegExp(`(${IDENT})\\s*:\\s*"(${ENV_NAME})"`, "g");
  const fieldReadPattern = new RegExp(`process[.]env[?]?\\[${IDENT}[.](${IDENT})\\]`, "g");

  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    const source = readFileSync(file, "utf8");

    for (const match of source.matchAll(literalPattern)) {
      names.add(match[1]);
    }

    // Resolve bracket reads against literals declared in the same file only:
    // an alias defined elsewhere would need a module graph this guard does not have.
    const constByAlias = new Map<string, string>();
    for (const match of source.matchAll(constDeclPattern)) {
      constByAlias.set(match[1], match[2]);
    }
    for (const match of source.matchAll(constReadPattern)) {
      const resolved = constByAlias.get(match[1]);
      if (resolved !== undefined) names.add(resolved);
    }

    const namesByField = new Map<string, Set<string>>();
    for (const match of source.matchAll(fieldDeclPattern)) {
      const bucket = namesByField.get(match[1]) ?? new Set<string>();
      bucket.add(match[2]);
      namesByField.set(match[1], bucket);
    }
    for (const match of source.matchAll(fieldReadPattern)) {
      for (const name of namesByField.get(match[1]) ?? []) names.add(name);
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
  });

  test('shape 1 (#609): a same-file `const X = "NAME"` alias read as `process.env[X]`', () => {
    // The six aliases in src/lib/agent/config.ts. Pinned by name, not by a count:
    // a count says nothing about which alias regressed.
    const names = readNames();
    for (const name of [
      "LIBREDB_AGENT_ENABLED",
      "LIBREDB_AGENT_THREAD_CONTEXT",
      "AGENT_MODEL_TUNING_PATH",
      "AGENT_MODEL_TURN_TIMEOUT_MS",
      "WORKFLOW_LOCAL_DATA_DIR",
      "WORKFLOW_TARGET_WORLD",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("shape 2 (#609): an object-field literal read as `process.env[spec.field]`", () => {
    // The ten RATE_LIMIT_* names in the src/lib/api/rate-limit.ts bucket table,
    // read as process.env[spec.maxVar] / process.env[spec.windowVar].
    const names = readNames();
    for (const scope of ["LOGIN", "LOGIN_ACCOUNT", "AI", "QUERY", "ANON"]) {
      expect(names).toContain(`RATE_LIMIT_${scope}_MAX`);
      expect(names).toContain(`RATE_LIMIT_${scope}_WINDOW_SEC`);
    }
  });

  test("#609 boundary: a name reached through a function argument stays undiscovered", () => {
    // process.env[envVar] in src/lib/seed/credential-resolver.ts needs a call
    // graph. When that stops being true, this test is the reminder to widen the
    // extractor rather than a silent gain.
    const names = new Set(readNames());
    // Control: a negative-only test passes on an empty set, so anchor it to a
    // name the extractor must always find before trusting the absences below.
    expect(names.has("JWT_SECRET")).toBe(true);
    expect(names.has("MY_DB_PASSWORD")).toBe(false);
  });

  test("LLM configuration reads are visible to the documentation guard", () => {
    const names = new Set(readNames());
    for (const name of ["LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL", "LLM_API_URL"]) {
      expect(names.has(name), name).toBe(true);
    }
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
