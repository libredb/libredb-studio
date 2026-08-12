/**
 * Drift guards for the agent runtime's cross-cutting documentation (#329 T13).
 *
 * The agent runtime is the first feature in this repository whose behaviour is
 * spread across a dozen modules, six API route paths, a rail, a durable backend and a
 * chart constraint, and none of that is derivable from any single file. `docs/AGENT.md`
 * is where it is written down. These tests keep three kinds of claim honest, because
 * prose is the one part of the repository nothing else checks:
 *
 *  1. **The document is reachable.** A behaviour document nobody links is a document
 *     nobody reads, so `docs/ARCHITECTURE.md` must link it and the link must resolve.
 *  2. **The configuration surface is complete.** Every environment variable the agent
 *     modules read is documented in BOTH `.env.example` and `docs/AGENT.md`, and the
 *     companion assertion is what keeps that check honest: across every agent-owned file
 *     (the runtime, the routes, the rail, its hooks, the run-access helper) only
 *     `config.ts` touches `process.env`, so a fourth variable read from one of them
 *     cannot slip past undocumented.
 *  3. **The deferral record is complete in both directions.** Every M2 backlog entry is
 *     cited by the behaviour document, and every id the document cites exists. A
 *     milestone that defers work and then documents nothing, or documents an entry that
 *     was later deleted, fails here rather than misleading a reader.
 *
 * The chart block covers the one deployment constraint the runtime imposes (the
 * zero-config durable backend takes file locks, so it is single-instance) plus the
 * verbatim operator copy of the chart, which is the mistake a chart edit made outside
 * `bun run chart:bump` actually produces — CI catches it, and the maintainer loop
 * cannot push, so this is the only local guard.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { operatorCopyViolations } from "../../scripts/sync-chart-version.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const AGENT_DOC_PATH = "docs/AGENT.md";
const AGENT_DOC = read(AGENT_DOC_PATH);
const ARCHITECTURE = read("docs/ARCHITECTURE.md");
const ENV_EXAMPLE = read(".env.example");
const BACKLOG = read("docs/BACKLOG.md");
const AGENT_CONFIG = read("src/lib/agent/config.ts");
const CHART_VALUES = read("charts/libredb-studio/values.yaml");
const CHART_README = read("charts/libredb-studio/README.md");

describe("docs/AGENT.md is reachable from the architecture document", () => {
  test("docs/ARCHITECTURE.md links to it and the link resolves to a real file", () => {
    const links = [...ARCHITECTURE.matchAll(/\]\(([^)]*AGENT\.md)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      // Links in docs/ARCHITECTURE.md are relative to docs/.
      expect(existsSync(path.join(ROOT, "docs", link))).toBe(true);
    }
  });
});

describe("the agent's environment surface is documented where an operator looks", () => {
  /**
   * `src/lib/agent/config.ts` declares each variable it reads as a `*_ENV` constant, so
   * the names can be extracted rather than restated here — a fourth variable added to
   * that file is then covered by this test without editing it.
   */
  const envNames = [...AGENT_CONFIG.matchAll(/\b\w+_ENV\b\s*=\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]);

  test("the extraction found the module's variables (a vacuous pass would hide everything below)", () => {
    expect(envNames.length).toBeGreaterThanOrEqual(3);
    expect(envNames).toContain("LIBREDB_AGENT_ENABLED");
    expect(envNames).toContain("WORKFLOW_TARGET_WORLD");
  });

  test.each(envNames)("%s is documented in .env.example", (name) => {
    expect(ENV_EXAMPLE).toContain(name);
  });

  test.each(envNames)("%s is documented in docs/AGENT.md", (name) => {
    expect(AGENT_DOC).toContain(name);
  });

  test("no other agent module reads process.env, so the documented set is the whole set", () => {
    // One Glob per root: Bun.Glob does not brace-expand whole alternative patterns
    // (verified — a single "{a/**,b/**}" pattern matches nothing), and a silently
    // empty scan would make this assertion pass for the wrong reason.
    const roots = [
      "src/lib/agent/**/*.ts",
      "src/app/api/agent/**/*.ts",
      "src/components/agent/**/*.{ts,tsx}",
      "src/hooks/use-agent-*.ts",
      "src/lib/api/agent-run-access.ts",
    ];
    const files = roots.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync(ROOT)]);
    expect(files.length).toBeGreaterThan(20);

    const readers = files.filter((file) => read(file).includes("process.env"));
    expect(readers).toEqual(["src/lib/agent/config.ts"]);
  });
});

describe("the milestone's deferral record is complete in both directions", () => {
  const m2Section = BACKLOG.split(/^## Agent M2 deferrals/m)[1] ?? "";
  const backlogIds = [...m2Section.matchAll(/^### (B\d+)\./gm)].map((m) => m[1]);
  const citedIds = [...new Set([...AGENT_DOC.matchAll(/\bB(\d+)\b/g)].map((m) => `B${m[1]}`))];

  test("the M2 backlog section was located and has entries", () => {
    expect(backlogIds.length).toBeGreaterThan(0);
  });

  test.each(backlogIds)("%s is cited by docs/AGENT.md", (id) => {
    expect(citedIds).toContain(id);
  });

  test.each(citedIds)("%s cited by docs/AGENT.md exists as a backlog entry", (id) => {
    expect(backlogIds).toContain(id);
  });

  test("the SQLite caveat is stated as behaviour, not implied", () => {
    // docs/BACKLOG.md A1: a SQLite statement timeout is post-execution. A budget meter or a
    // deadline that let a reader assume preemption would be the dishonest half of this feature.
    expect(AGENT_DOC).toMatch(/sqlite[^.]*\b(not preempt|no preemption|post-execution)\b/i);
  });
});

describe("the chart says the zero-config durable backend is single-instance", () => {
  test("the replicaCount comment names the variable that lifts the constraint", () => {
    const comment =
      CHART_VALUES.split(/^replicaCount:/m)[0]
        .split(/\n\s*\n/)
        .at(-1) ?? "";
    expect(comment).toContain("WORKFLOW_TARGET_WORLD");
  });

  test("the chart README states the constraint and how to opt out of it", () => {
    // Bounded on BOTH sides: the README says "replicaCount > 1" in other sections
    // (sqlite storage, rate limiting), so a section that ran to end-of-file would let
    // the replica assertion pass on somebody else's paragraph.
    const section = CHART_README.split(/^## Agent Runtime/m)[1]?.split(/^## /m)[0] ?? "";
    expect(section).toContain("LIBREDB_AGENT_ENABLED");
    expect(section).toContain("WORKFLOW_TARGET_WORLD");
    expect(section).toContain("@workflow/world-postgres");
    expect(section).toMatch(/single-instance/i);
    expect(section).toMatch(/replicaCount[^.]*\b1\b/);
    // The recipe has to work under the chart's own readOnlyRootFilesystem default:
    // the local backend writes to WORKFLOW_LOCAL_DATA_DIR, which must be steered
    // into the one writable volume or no run can start.
    expect(section).toMatch(/WORKFLOW_LOCAL_DATA_DIR[\s\S]*\/app\/data/);
  });

  test("the operator's verbatim chart copy still matches the source chart", () => {
    expect(operatorCopyViolations(ROOT)).toEqual([]);
  });
});
