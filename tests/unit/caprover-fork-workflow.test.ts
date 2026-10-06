/**
 * Unit tests for .github/workflows/caprover-fork.yml, its dispatch from
 * docker-build-push.yml, and scripts/stage-caprover-catalog.sh.
 *
 * Why a test for YAML: the workflow holds a personal access token that can push
 * to libredb/one-click-apps, and what matters is in its wiring. It must never
 * open the pull request (the catalog's maintainer keeps version bumps manual,
 * caprover/one-click-apps#1334, so a member opens it after testing), it must
 * run the catalog's own npm tooling only in the job that holds no secret, it
 * must do what update.fork in distribution/channels.yaml allows and no more,
 * and it must never push over a branch someone changed by hand.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describeIfPosixShell, posixShell } from "../helpers/posix-tools";

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, { inputs?: Record<string, { type?: string; options?: string[]; default?: string }> }>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const ROOT = join(import.meta.dir, "../..");
const WORKFLOWS = join(ROOT, ".github/workflows");
const raw = readFileSync(join(WORKFLOWS, "caprover-fork.yml"), "utf8");
const workflow = parseYaml(raw) as Workflow;
const validate = workflow.jobs.validate;
const push = workflow.jobs.push;
const steps = (job: Job) => job.steps ?? [];
const stepRunning = (job: Job, pattern: RegExp) => steps(job).find((s) => pattern.test(s.run ?? ""));

describe("the CapRover catalog fork workflow", () => {
  test("is started by dispatch only, and a run by hand is the manual push", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const trigger = workflow.on.workflow_dispatch.inputs?.trigger;
    expect(trigger?.type).toBe("choice");
    expect(trigger?.options).toEqual(["manual", "release"]);
    expect(trigger?.default).toBe("manual");
  });

  test("gives GITHUB_TOKEN read access only and stages one tag at a time", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency?.group).toContain("github.ref");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(workflow.env).toEqual({ UPSTREAM: "caprover/one-click-apps", FORK: "libredb/one-click-apps" });
  });

  test("never opens a pull request", () => {
    expect(raw).not.toMatch(/gh pr create|create-pull-request|\/pulls/);
  });

  test("interpolates no expression into a shell script", () => {
    for (const step of [...steps(validate), ...steps(push)]) {
      expect(step.run ?? "").not.toContain("${{");
    }
  });

  test("stages a release tag only, whose package.json and templates carry that version", () => {
    const version = steps(validate).find((s) => s.id === "version");
    expect(version?.env?.REF).toBe("${{ github.ref }}");
    expect(version?.run).toContain("refs/tags/*");
    expect(version?.run).toContain("[0-9]+\\.[0-9]+\\.[0-9]+");
    const pins = stepRunning(validate, /sync-chart-version\.mjs --check/);
    expect(pins?.run).toContain("require('./package.json').version");
  });

  test("reads update.fork and decides whether this run may write", () => {
    const settings = steps(validate).find((s) => s.id === "settings");
    expect(settings?.run).toContain("node scripts/distribution-check.mjs --fork-outputs caprover-official");
    expect(settings?.env?.TRIGGER).toBe("${{ inputs.trigger }}");
    expect(settings?.env?.TOKEN_PRESENT).toBe("${{ secrets.CAPROVER_CATALOG_TOKEN != '' }}");
    // A release run writes only when push is auto; a run by hand is the push.
    expect(settings?.run).toMatch(/"\$TRIGGER" = "release" \] && \[ "\$PUSH" != "auto"/);
    expect(settings?.run).toContain('"$LIVE" != "true"');
    expect(validate.outputs?.write).toBe("${{ steps.settings.outputs.write }}");
    expect(validate.outputs?.mode).toBe("${{ steps.settings.outputs.mode }}");
  });

  // The catalog's own npm checks would run another repository's scripts and
  // dependencies on the release tag's ref, and code running in a job can write
  // that ref's Actions cache, which a later release run on the tag restores.
  test("runs no third-party code: neither npm nor a Node.js setup of its own", () => {
    for (const step of [...steps(validate), ...steps(push)]) {
      expect(step.run ?? "").not.toMatch(/\bnpm\b|\bnpx\b/);
      expect(step.uses ?? "").not.toContain("setup-node");
    }
  });

  test("runs the template tests, which encode the catalog validator's rules", () => {
    const tests = stepRunning(validate, /caprover-template\.test\.ts/);
    expect(tests?.run).toBe("bun tests/run-tests.ts --jobs=1 tests/unit/caprover-template.test.ts");
  });

  test("names the token only in a presence check in the job that stages", () => {
    expect(JSON.stringify(validate)).not.toContain("secrets.CAPROVER_CATALOG_TOKEN }}");
  });

  test("records the catalog commit it validated, and the push job stages on that commit", () => {
    expect(validate.outputs?.catalog_sha).toBe("${{ steps.stage.outputs.catalog_sha }}");
    const catalog = steps(push).find((s) => s.with?.path === "catalog");
    expect(catalog?.with?.ref).toBe("${{ needs.validate.outputs.catalog_sha }}");
  });

  test("pushes only after validation, when the run may write and the catalog would change", () => {
    expect(push.needs).toBe("validate");
    expect(push.if).toBe("needs.validate.outputs.write == 'true' && needs.validate.outputs.changed == 'true'");
  });

  test("runs no npm, bun or node where the token is, and only pinned checkouts", () => {
    for (const step of steps(push)) {
      expect(step.run ?? "").not.toMatch(/\b(npm|npx|bun|node)\b/);
      if (step.uses) {
        expect(step.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
        expect(step.with?.["persist-credentials"]).toBe(false);
      }
    }
  });

  test("hands the token only to the steps that call GitHub with it", () => {
    expect(push.env).toBeUndefined();
    const holders = steps(push).filter((s) => JSON.stringify(s).includes("CAPROVER_CATALOG_TOKEN"));
    expect(holders.length).toBeGreaterThan(0);
    for (const step of holders) {
      expect(step.env?.GH_TOKEN).toBe("${{ secrets.CAPROVER_CATALOG_TOKEN }}");
    }
  });

  test("creates a missing fork only when mode is create_or_update, and checks the fork's parent", () => {
    const ensure = stepRunning(push, /\/forks/);
    expect(ensure?.env?.MODE).toBe("${{ needs.validate.outputs.mode }}");
    expect(ensure?.run).toContain('"$MODE" != "create_or_update"');
    expect(ensure?.run).toContain("HTTP 404");
    expect(ensure?.run).toContain(".parent.full_name");
  });

  // GitHub answers the fork request at once and copies the git data after.
  test("waits for a new fork's default branch, not only the repository", () => {
    const ensure = stepRunning(push, /\/forks/);
    expect(ensure?.run).toContain('gh api "repos/${FORK}/branches/${BASE}"');
  });

  // merge-upstream merges rather than fast-forwards a fork that carries commits
  // upstream lacks, so the comparison has to come first.
  test("compares before it syncs, and only ever fast-forwards the fork", () => {
    const run = stepRunning(push, /merge-upstream/)?.run ?? "";
    const compare = run.indexOf('gh api "repos/${UPSTREAM}/compare/');
    const merge = run.indexOf('gh api -X POST "repos/${FORK}/merge-upstream"');
    expect(compare).toBeGreaterThan(-1);
    expect(merge).toBeGreaterThan(compare);
    expect(run).toContain("--jq .merge_type");
    expect(run).toContain("fast-forward|none)");
  });

  test("names the run and who started it in the staged commit", () => {
    const commit = stepRunning(push, /commit --quiet/);
    expect(commit?.env?.TRIGGER).toBe("${{ inputs.trigger }}");
    expect(commit?.run).toContain("actions/runs/${GITHUB_RUN_ID}");
    expect(commit?.run).toContain("${GITHUB_ACTOR}");
  });

  test("stages through one script in both jobs", () => {
    expect(stepRunning(validate, /bash scripts\/stage-caprover-catalog\.sh \. catalog/)).toBeDefined();
    expect(stepRunning(push, /bash studio\/scripts\/stage-caprover-catalog\.sh studio catalog/)).toBeDefined();
  });

  test("stages the tag it runs on in the push job too", () => {
    const studio = steps(push).find((s) => s.with?.path === "studio");
    expect(studio?.with?.ref).toBeUndefined();
    expect(studio?.with?.repository).toBeUndefined();
  });

  test("never pushes over a branch whose templates differ, and never force-pushes", () => {
    const pushing = stepRunning(push, /git -C catalog push/);
    expect(pushing?.run).toContain("ls-remote --heads");
    // Compared on the files this commit stages only: the existing branch may
    // sit on an older catalog commit where every other app differs.
    expect(pushing?.run).toContain("diff-tree --no-commit-id --name-only -r HEAD");
    expect(pushing?.run).toContain('diff --quiet FETCH_HEAD HEAD -- "${OURS[@]}"');
    expect(pushing?.run).not.toMatch(/--force|\s-f\s|\s\+HEAD/);
  });

  test("commits only what the staging script wrote, and stops when it fails", () => {
    const commit = stepRunning(push, /commit --quiet/);
    expect(commit?.run).toContain("STAGED_LIST=$(bash studio/scripts/stage-caprover-catalog.sh studio catalog)");
    expect(commit?.run).not.toContain("< <(");
    expect(commit?.run).toContain('add -- "${STAGED[@]}"');
  });

  test("leaves the member a test link and a prefilled pull request link", () => {
    const summary = stepRunning(push, /GITHUB_STEP_SUMMARY/);
    expect(summary?.run).toContain("compare/");
    expect(summary?.run).toContain("expand=1");
    expect(summary?.run).toContain(">> TEMPLATE <<");
  });
});

describe("the dispatch from docker-build-push.yml", () => {
  const docker = parseYaml(readFileSync(join(WORKFLOWS, "docker-build-push.yml"), "utf8")) as Workflow;
  const dispatch = docker.jobs["dispatch-caprover-fork"];

  // A release run moves the latest tags; a backfill of an old version does not,
  // and a prerelease tag carries a suffix the catalog must never default to. A
  // single-variant recovery stages too, unlike the Helm dispatch: the leg it
  // rebuilt was the last image missing, and an identical branch is left alone.
  test("runs after the images and their channel E2E, for a stable release only", () => {
    expect(dispatch.needs).toEqual(["build-and-push", "channel-e2e"]);
    expect(dispatch.if?.replace(/\s+/g, " ")).toBe(
      "!contains(github.ref, '-') && (github.event_name == 'release' || " +
        "(github.event_name == 'workflow_dispatch' && inputs.publish_latest == true))",
    );
    expect(dispatch.permissions).toEqual({ actions: "write" });
  });

  test("dispatches the workflow on the release tag as a release run", () => {
    const [step] = steps(dispatch);
    expect(step.env?.REF).toBe("${{ github.ref }}");
    expect(step.run).toContain('gh workflow run caprover-fork.yml --ref "$REF" -f trigger=release');
  });
});

const STAGE_SCRIPT = join(ROOT, "scripts/stage-caprover-catalog.sh");
const SHELL = posixShell("bash");
const NAMES = ["libredb-studio", "libredb-studio-autoconnect"];

describeIfPosixShell("bash", "scripts/stage-caprover-catalog.sh", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeTrees(): { studio: string; catalog: string } {
    const root = mkdtempSync(join(tmpdir(), "caprover-stage-"));
    roots.push(root);
    const studio = join(root, "studio");
    const catalog = join(root, "catalog");
    mkdirSync(join(studio, "deploy/caprover"), { recursive: true });
    mkdirSync(join(catalog, "public/v4/apps"), { recursive: true });
    mkdirSync(join(catalog, "public/v4/logos"), { recursive: true });
    for (const name of NAMES) {
      writeFileSync(join(studio, "deploy/caprover", `${name}.yml`), `captainVersion: 4\n# ${name}\n`);
      writeFileSync(join(studio, "deploy/caprover", `${name}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
      writeFileSync(join(catalog, "public/v4/apps", `${name}.yml`), "stale\n");
    }
    return { studio, catalog };
  }

  function stage(...args: string[]) {
    return Bun.spawnSync([SHELL!, STAGE_SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  }

  test("copies both templates and both logos byte for byte and names what it wrote", () => {
    const { studio, catalog } = makeTrees();
    const result = stage(studio, catalog);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      "public/v4/apps/libredb-studio.yml",
      "public/v4/logos/libredb-studio.png",
      "public/v4/apps/libredb-studio-autoconnect.yml",
      "public/v4/logos/libredb-studio-autoconnect.png",
    ]);
    for (const name of NAMES) {
      expect(readFileSync(join(catalog, "public/v4/apps", `${name}.yml`))).toEqual(
        readFileSync(join(studio, "deploy/caprover", `${name}.yml`)),
      );
      expect(readFileSync(join(catalog, "public/v4/logos", `${name}.png`))).toEqual(
        readFileSync(join(studio, "deploy/caprover", `${name}.png`)),
      );
    }
  });

  test("fails when a source file is missing", () => {
    const { studio, catalog } = makeTrees();
    rmSync(join(studio, "deploy/caprover/libredb-studio-autoconnect.png"));
    expect(stage(studio, catalog).exitCode).not.toBe(0);
  });

  test("fails without both checkouts", () => {
    const result = stage("only-one");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("usage");
  });
});
