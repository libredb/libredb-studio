/**
 * When the workflows run, and what a pull request pays for.
 *
 * Every rule here fails silently when it breaks: a branch push that builds an image
 * nobody pulls is still green, and so is a pull request run that a newer push should
 * have cancelled. So the triggers are read back out of the workflow files and held
 * here.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

const WORKFLOWS = path.join(import.meta.dir, "../../.github/workflows");

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
}

interface Job {
  readonly name?: string;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly uses?: string;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly concurrency?: { readonly group?: string; readonly "cancel-in-progress"?: string | boolean };
  readonly jobs: Readonly<Record<string, Job>>;
}

function workflow(file: string): Workflow {
  return parse(readFileSync(path.join(WORKFLOWS, file), "utf8")) as Workflow;
}

function text(file: string): string {
  return readFileSync(path.join(WORKFLOWS, file), "utf8");
}

describe("image builds", () => {
  const docker = workflow("docker-build-push.yml");

  test("docker-build-push.yml builds on push to main, a release or a dispatch, never on a branch push", () => {
    // feat/** and fix/** pushes used to build and publish a `dev` tag that only this
    // workflow's own Channel E2E pulled: a multi-architecture image build per pushed
    // commit that no user installs.
    expect(Object.keys(docker.on).sort()).toEqual(["push", "release", "workflow_dispatch"]);
    expect((docker.on.push as { branches: string[] }).branches).toEqual(["main"]);
  });

  test("no image tag is published for a branch other than main", () => {
    const source = text("docker-build-push.yml");
    expect(source).not.toContain("type=raw,value=dev");
    expect(source).not.toContain("github.ref != 'refs/heads/main'");
  });

  test("every image build is a two-architecture manifest", () => {
    const build = docker.jobs["build-and-push"]?.steps?.find((step) => step.id === "build");
    expect(build?.with?.platforms).toBe("${{ env.PLATFORMS }}");
    expect(docker.env?.PLATFORMS).toBe("linux/amd64,linux/arm64");
    // With every build two-architecture, the emulator is needed on every build too.
    const qemu = docker.jobs["build-and-push"]?.steps?.find((step) =>
      step.uses?.startsWith("docker/setup-qemu-action@"),
    );
    expect(qemu).toBeDefined();
    expect(qemu?.if).toBeUndefined();
  });
});

/** The literal text of a concurrency group before its first expression. */
function groupPrefix(group: string): string {
  const at = group.indexOf("${{");
  return at === -1 ? group : group.slice(0, at);
}

/** Evaluates the body of a `${{ ... }}` expression the way sonarcloud-workflow.test.ts does. */
function evaluate(expression: string, context: Record<string, unknown>): unknown {
  const body = expression.match(/^\$\{\{([\s\S]*)\}\}$/)?.[1];
  if (body === undefined) throw new Error(`not a single expression: ${expression}`);
  return runInNewContext(body, context, { timeout: 100 });
}

describe("superseded runs", () => {
  const SUPERSEDED = [
    ["ci.yml", "ci-"],
    ["codeql.yml", "codeql-"],
    ["integration-check.yml", "integration-check-"],
  ] as const;

  test("ci.yml, codeql.yml and integration-check.yml key their concurrency by workflow, ref and event", () => {
    // The event is in the key so a scheduled CodeQL run and a push run on main
    // never cancel or queue behind each other, as security-scan.yml explains.
    for (const [file, prefix] of SUPERSEDED) {
      const group = workflow(file).concurrency?.group ?? "";
      expect(group).toBe(`${prefix}\${{ github.ref }}-\${{ github.event_name }}`);
    }
  });

  test("a new push cancels a pull request's running run, and on main only the pending one", () => {
    // On main a started run finishes: the heavy jobs run only there, and merges land
    // faster than one main run takes, so cancelling in progress would starve them.
    // GitHub keeps one running and one pending run per group either way.
    for (const [file] of SUPERSEDED) {
      const cancel = workflow(file).concurrency?.["cancel-in-progress"];
      expect(cancel).toBe("${{ github.event_name == 'pull_request' }}");
      for (const [event, expected] of [
        ["pull_request", true],
        ["push", false],
        ["schedule", false],
        ["workflow_dispatch", false],
      ] as const) {
        expect(evaluate(String(cancel), { github: { event_name: event } })).toBe(expected);
      }
    }
  });

  test("no two workflows share a concurrency prefix", () => {
    const prefixes = readdirSync(WORKFLOWS)
      .filter((file) => file.endsWith(".yml"))
      .flatMap((file) => {
        const group = workflow(file).concurrency?.group;
        return group === undefined ? [] : [groupPrefix(group)];
      });
    expect(prefixes).toContain("security-scan-");
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe("what a pull request runs", () => {
  const ci = workflow("ci.yml");
  const security = workflow("security-scan.yml");

  /** The five checks main's branch protection requires, by job name, and the file each lives in. */
  const REQUIRED = [
    ["ci.yml", "Lint, Typecheck and Build"],
    ["ci.yml", "Unit & Integration Tests"],
    ["ci.yml", "Engine Smoke - Build Payload"],
    ["ci.yml", "Out-of-tree Provider Acceptance"],
    ["security-scan.yml", "Secret Scan"],
  ] as const;

  /**
   * The ci.yml jobs a pull request does not run. Each one runs on push to main and by
   * dispatch. A new job lands in this list or in PULL_REQUEST below, never in neither.
   */
  const MAIN_ONLY = [
    "test-cross-platform",
    "vscode-extension",
    "e2e",
    "functional-smoke",
    "engine-smoke",
    "shutdown-signal-live",
    "host-core-live",
    "channel-e2e",
    "sonarcloud",
  ];
  const PULL_REQUEST = ["lint-and-build", "test", "engine-payload", "out-of-tree-acceptance", "helm-lint"];

  /** The `if` a job behind a required check may carry; every other one carries none. */
  const ALLOWED_IF: Readonly<Record<string, string>> = {};

  function needsOf(job: Job): string[] {
    if (job.needs === undefined) return [];
    return typeof job.needs === "string" ? [job.needs] : [...job.needs];
  }

  /** The job ids behind the required ci.yml checks: each required job and every job it needs, transitively. */
  function requiredClosure(): string[] {
    const ids = new Set<string>();
    const pending = Object.entries(ci.jobs)
      .filter(([, job]) => REQUIRED.some(([file, name]) => file === "ci.yml" && name === job.name))
      .map(([id]) => id);
    while (pending.length > 0) {
      const id = pending.pop() as string;
      if (ids.has(id)) continue;
      ids.add(id);
      pending.push(...needsOf(ci.jobs[id] as Job));
    }
    return [...ids].sort();
  }

  test("the five required checks keep their names", () => {
    // Branch protection binds the check by the job's name, not its id: a renamed job
    // leaves every pull request waiting for a check that can no longer report.
    for (const [file, name] of REQUIRED) {
      const jobs = Object.values(workflow(file).jobs).filter((job) => job.name === name);
      expect(jobs.length).toBe(1);
    }
  });

  test("every required check, and every job it needs, runs on a pull request", () => {
    // A job skipped by its condition reports "skipped", which branch protection takes
    // as success, so a required check gated off pull requests would pass unexamined.
    const closure = requiredClosure();
    expect(closure.length).toBeGreaterThanOrEqual(4);
    for (const id of closure) {
      expect({ id, if: ci.jobs[id]?.if }).toEqual({ id, if: ALLOWED_IF[id] });
    }
    const secretScan = Object.values(security.jobs).find((job) => job.name === "Secret Scan");
    expect(secretScan?.if ?? "").not.toContain("pull_request");
    expect(Object.keys(ci.on)).toContain("pull_request");
    expect(Object.keys(security.on)).toContain("pull_request");
  });

  test("every other ci.yml job runs on main only, and a new job must be classified", () => {
    const ids = Object.keys(ci.jobs);
    const gated = ids.filter((id) => (ci.jobs[id]?.if ?? "").includes("github.event_name != 'pull_request'"));
    expect(gated.sort()).toEqual([...MAIN_ONLY].sort());
    expect(ids.filter((id) => !gated.includes(id)).sort()).toEqual([...PULL_REQUEST].sort());
    expect([...MAIN_ONLY, ...PULL_REQUEST].sort()).toEqual([...ids].sort());
  });

  test("ci.yml runs on pull requests, on push to main and by dispatch", () => {
    // The dispatch is how a branch runs the main-only jobs before it merges:
    // `gh workflow run ci.yml --ref <branch>`.
    expect(Object.keys(ci.on)).toEqual(expect.arrayContaining(["pull_request", "push", "workflow_dispatch"]));
    expect((ci.on.push as { branches: string[] }).branches).toContain("main");
  });
});

describe("the main-only cross-platform legs", () => {
  const ci = workflow("ci.yml");

  test("the main-only cross-platform legs carry their measured budgets", () => {
    // 600 s a file: twice the slowest file measured on windows-latest. 60 s a test: the
    // measured Windows value, given on macOS too. 45 minutes a job: the slowest leg
    // measured, plus one file allowed its whole budget.
    const job = ci.jobs["test-cross-platform"] as Job & { "timeout-minutes"?: number };
    const suite = job.steps?.find((step) => step.name === "Run the test suite");
    expect(suite?.run).toBe("bun run test --file-timeout=600 --test-timeout=60");
    expect(job["timeout-minutes"]).toBe(45);
  });

  test("the Linux suite passes neither budget, so a slow test still shows there", () => {
    for (const [id, job] of Object.entries(ci.jobs)) {
      if (id === "test-cross-platform") continue;
      for (const step of job.steps ?? []) {
        expect({ id, run: step.run ?? "" }).not.toEqual({ id, run: expect.stringContaining("--test-timeout") });
        expect({ id, run: step.run ?? "" }).not.toEqual({ id, run: expect.stringContaining("--file-timeout") });
      }
    }
  });
});
