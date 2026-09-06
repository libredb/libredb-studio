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
 * Dynamic reads (`process.env[name]`) are out of scope, as #566 says: they
 * cannot be extracted statically, and a guard that pretended otherwise would
 * report a name that is not a name.
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

/** Literal `process.env.NAME` reads across `src/`, deduplicated and sorted. */
const readNames = (): string[] => {
  const names = new Set<string>();
  // Both `process.env.NAME` and the optional-chained `process.env?.NAME` that
  // logger.ts uses. Dynamic `process.env[name]` reads are out of scope: they
  // cannot be resolved statically, and reporting the expression as a variable
  // name would be worse than not reporting it.
  const pattern = /process[.]env[?]?[.]([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      names.add(match[1]);
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
