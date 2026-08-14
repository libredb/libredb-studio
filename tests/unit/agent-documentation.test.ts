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
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const AGENT_DOC_PATH = "docs/AGENT.md";
const AGENT_DOC = read(AGENT_DOC_PATH);
const ARCHITECTURE = read("docs/ARCHITECTURE.md");
const ENV_EXAMPLE = read(".env.example");
const BACKLOG = read("docs/BACKLOG.md");
const AGENT_CONFIG = read("src/lib/agent/config.ts");
const CHART_VALUES = read("charts/libredb-studio/values.yaml");
/** The ledger directory the chart writes; the same path the image will also set. */
const CHART_LEDGER_PATH = "/app/data/workflow";
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

describe("the two companion pages exist and are reachable", () => {
  /**
   * `docs/AGENT.md` is the behaviour document, and #331 T6 split two audiences out of
   * it: the user guide and the data-flow page. A page nobody links is a page nobody
   * reads — the same reason the architecture link above is asserted — and the data-flow
   * page in particular is what `docs/SECURITY.md` now points at for egress, so it
   * cannot quietly stop existing.
   */
  const COMPANIONS = ["docs/AGENT_GUIDE.md", "docs/AGENT_DATA_FLOW.md"];

  test.each(COMPANIONS)("%s exists", (page) => {
    expect(existsSync(path.join(ROOT, page))).toBe(true);
  });

  test.each(COMPANIONS)("%s is linked from docs/AGENT.md", (page) => {
    expect(AGENT_DOC).toContain(`(./${path.basename(page)})`);
  });

  test("README.md links the user guide, which is where a reader starts", () => {
    expect(read("README.md")).toContain("docs/AGENT_GUIDE.md");
  });
});

/**
 * The egress table states ranges over the frozen decision table, and a range is the
 * kind of figure that goes stale silently (#373 review): `maxModelTurns` still said
 * "20-48" after `data-analysis` landed at 60, so the page that answers "how much can
 * leave" understated a ceiling by a fifth of a run.
 *
 * Derived from `AGENT_WORKFLOW_BUDGETS` rather than listed here, so the row that fails
 * is the row a workflow moved — the same shape as the route scan above.
 */
describe("docs/AGENT_DATA_FLOW.md states the frozen ceilings as they are", () => {
  const DATA_FLOW = read("docs/AGENT_DATA_FLOW.md");
  const rows = Object.values(AGENT_WORKFLOW_BUDGETS);

  const range = (values: readonly number[]): string => `${Math.min(...values)}-${Math.max(...values)}`;

  test.each([
    ["maxModelTurns", range(rows.map((row) => row.maxModelTurns))],
    ["maxStatementsPerRun", range(rows.map((row) => row.policy.budgets.maxStatementsPerRun))],
  ])("the %s row states %s, by workflow", (bound, expected) => {
    // The bound's own row, not the document: two rows could otherwise cover for each
    // other while both were wrong.
    const row = DATA_FLOW.split("\n").find((line) => line.includes(`\`${bound}\``));
    expect(row).toBeDefined();
    expect(row).toContain(`${expected}, by workflow`);
  });
});

describe("the agent's HTTP surface is documented where a reader looks for a route", () => {
  /**
   * B19's own "done" text asked for this: nothing compared `docs/API_DOCS.md` against
   * `src/app/api/`, so a route family could be absent from the API reference and every
   * gate stayed green. The paths are DERIVED from the route tree rather than listed
   * here, so a seventh agent path added tomorrow fails this test instead of being
   * silently undocumented.
   *
   * Dynamic segments are compared in the reference's own notation (`{runId}`), which is
   * what the rest of that document already uses for a path parameter.
   */
  const API_DOCS = read("docs/API_DOCS.md");

  const routePaths = [...new Bun.Glob("src/app/api/agent/**/route.ts").scanSync(ROOT)]
    .map((file) =>
      file
        .replace(/^src\/app/, "")
        .replace(/\/route\.ts$/, "")
        .replace(/\[(\w+)\]/g, "{$1}"),
    )
    .sort();

  test("the scan found the agent route tree (an empty scan would pass everything below)", () => {
    expect(routePaths).toContain("/api/agent/config");
    expect(routePaths).toContain("/api/agent/drive");
    expect(routePaths.length).toBeGreaterThanOrEqual(6);
  });

  test.each(routePaths)("%s appears in docs/API_DOCS.md", (routePath) => {
    expect(API_DOCS).toContain(routePath);
  });

  test("the family is reachable from the table of contents", () => {
    expect(API_DOCS).toContain("#agent-api");
  });
});

describe("the removal's coverage map cites a measurement that exists (#331 T7)", () => {
  /**
   * `docs/AGENT.md` claims the removed NL2SQL and Autopilot panels' happy paths are
   * measured as agent runs, and names the file that does it. A claim about a test file
   * is worth exactly what the file's existence is worth: if the evals are renamed or
   * deleted, the section stops being evidence and starts being a story about one.
   */
  const SECTION = "## What the removed AI panels did that a run does not";
  const COVERAGE_EVAL = "tests/evals/legacy-surface-coverage.test.ts";

  test("the section exists and names the eval that measures it", () => {
    expect(AGENT_DOC).toContain(SECTION);
    // Bounded at the next heading, so a mention somewhere else in the document
    // cannot stand in for this section carrying its own evidence.
    const section = AGENT_DOC.split(SECTION)[1]?.split(/^## /m)[0] ?? "";
    expect(section).toContain(COVERAGE_EVAL);
  });

  test("the eval file it names is in the repository", () => {
    expect(existsSync(path.join(ROOT, COVERAGE_EVAL))).toBe(true);
  });

  test("the two largest losses are IN the list, not only elsewhere in the document", () => {
    // Review found the section flattering: it listed six losses and omitted the two
    // biggest ones, both in our favour. The agent is standalone-only, so for an
    // embedded user every "what a run does instead" cell is false; and a toolless
    // model, which drove both panels, is refused outright. Both facts were stated in
    // other sections, which made the record incomplete rather than concealed — and a
    // section whose purpose is to say what a user lost has to carry them itself.
    const section = AGENT_DOC.split(SECTION)[1]?.split(/^## /m)[0] ?? "";

    expect(section).toContain("tests/unit/agent-package-boundary.test.ts");
    expect(section).toContain("src/lib/agent/capability-gate.ts");
  });
});

describe("the container image carries the ledger default a plain `docker run` cannot pass", () => {
  /**
   * The ratified T5 proposal says a plain `docker run` must carry the same ledger
   * default `docker-compose.yml` sets. Compose can express it in a file the operator
   * already edits; a bare `docker run -p 3000:3000 ghcr.io/...` cannot, and with no
   * default in the image the SDK resolves `.workflow-data` against the working
   * directory — `/app`, the container's writable layer, which survives a restart and
   * is discarded on the next recreate or image upgrade. The image is the only place
   * that reaches every one of those runs, so the default lives there.
   */
  const DOCKERFILE = read("Dockerfile");
  const COMPOSE = read("docker-compose.yml");
  const LEDGER_PATH = "/app/data/workflow";

  test("the runtime stage sets WORKFLOW_LOCAL_DATA_DIR inside the data volume", () => {
    const runner = DOCKERFILE.split(/^FROM .* AS runner$/m)[1] ?? "";
    expect(runner).toContain(`ENV WORKFLOW_LOCAL_DATA_DIR=${LEDGER_PATH}`);
  });

  test("the image default is the path compose and the operator documentation already name", () => {
    // Three files stating three paths would put the ledger somewhere no volume is
    // mounted for two of them.
    expect(COMPOSE).toContain(`WORKFLOW_LOCAL_DATA_DIR=\${WORKFLOW_LOCAL_DATA_DIR:-${LEDGER_PATH}}`);
    expect(ENV_EXAMPLE).toContain(`WORKFLOW_LOCAL_DATA_DIR=${LEDGER_PATH}`);
    expect(AGENT_DOC).toContain(LEDGER_PATH);
  });

  test("the default sits under the directory the entrypoint makes writable for the app user", () => {
    // The runtime stage never issues `USER`: the container starts as root, the
    // entrypoint chowns the data directory and drops to `nextjs` with gosu. A ledger
    // default outside that directory would be unwritable under a mounted volume.
    const entrypoint = read("docker-entrypoint.sh");
    expect(entrypoint).toContain("/app/data");
    expect(LEDGER_PATH.startsWith("/app/data/")).toBe(true);
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
    // The README must name the path the chart actually writes, so a reader who
    // overrides it knows what they are replacing.
    expect(section).toContain(`WORKFLOW_LOCAL_DATA_DIR=${CHART_LEDGER_PATH}`);
  });

  /**
   * This assertion used to be `/WORKFLOW_LOCAL_DATA_DIR[\s\S]*\/app\/data/` on the
   * README, guarding an `extraEnv` recipe. It survived the recipe's deletion — the
   * two tokens still appeared in prose that said there was NO such variable to
   * remember — and so it passed while a default install was broken. A documentation
   * regex cannot check a deployment; the deployment can. What actually has to hold
   * is that the packaged chart steers the ledger into the one writable volume,
   * because `securityContext.readOnlyRootFilesystem: true` leaves the SDK's
   * cwd-relative default (`.workflow-data` under `WORKDIR /app`) unwritable and no
   * run can start. The image carries its own copy only from an app version later
   * than the `appVersion` this chart deploys, so the chart is what makes a default
   * install work today.
   */
  test("the chart itself writes the ledger into the writable volume", () => {
    const deployment = read("charts/libredb-studio/templates/deployment.yaml");
    expect(deployment).toMatch(new RegExp(`- name: WORKFLOW_LOCAL_DATA_DIR\\s*\\n\\s*value: ${CHART_LEDGER_PATH}\\b`));
    // The volume that path lives in is mounted unconditionally, not only under
    // persistence: an emptyDir still makes the agent work, it only makes it forget.
    expect(deployment).toMatch(/mountPath: \/app\/data\b/);
  });

  test("the operator's verbatim chart copy still matches the source chart", () => {
    expect(operatorCopyViolations(ROOT)).toEqual([]);
  });
});
