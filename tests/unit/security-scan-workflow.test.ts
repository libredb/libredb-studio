/**
 * Unit tests for security-scan.yml's invariants.
 *
 * Why a test for YAML: every failure mode here is silent. A scanner pinned to
 * `:latest` still runs, it just stops being the scanner that was reviewed. A
 * `continue-on-error` on the secret scan still shows a green check. A SARIF
 * upload without the fork guard fails only on a fork's pull request, which the
 * maintainer never sees on their own branches. None of these breaks a run; each
 * removes a guarantee.
 *
 * The same asymmetry as tests/unit/release-provenance.test.ts, applied to the
 * scanning side.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

interface Step {
  name?: string;
  run?: string;
  if?: string;
  id?: string;
  uses?: string;
  with?: Record<string, string | boolean | number>;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}
interface Job {
  name?: string;
  "runs-on"?: string;
  if?: string;
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
}

const file = path.join(__dirname, "../../.github/workflows/security-scan.yml");
const workflow = parseYaml(fs.readFileSync(file, "utf8")) as Workflow;
const allSteps = Object.values(workflow.jobs).flatMap((j) => j.steps ?? []);

const DIGEST = /@sha256:[0-9a-f]{64}$/;

/**
 * Splits a step's `run` script into the individual `docker run ...`
 * invocations it contains, joining each one's backslash-continued lines back
 * into a single block. The old single-line regex this replaces matched only
 * the physical `docker run --rm \` line; every image reference in this
 * workflow sits on a continuation line, so it never saw one.
 */
function dockerRunBlocks(run: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of run.split("\n")) {
    const trimmed = line.trim();
    if (current === null) {
      if (!trimmed.startsWith("docker run")) continue;
      current = [];
    }
    current.push(line);
    if (!trimmed.endsWith("\\")) {
      blocks.push(current.join("\n"));
      current = null;
    }
  }
  return blocks;
}

/**
 * Finds the token docker actually reads as the image to run: the first
 * whitespace-separated word on the first line, after `docker run --rm \`,
 * that is not itself a flag (every `-e`/`-v`/`-w` flag and its value share one
 * line in this workflow's style, so skipping flag-prefixed lines skips
 * exactly the flags). Presence of a pinned-image variable ANYWHERE in the
 * block is not enough: a decoy reference in an unrelated `-e` flag would make
 * a hardcoded tag in the real argument position look pinned under a
 * presence-only check.
 */
function imageArgument(block: string): string | undefined {
  const lines = block.split("\n").map((l) => l.trim());
  for (const line of lines.slice(1)) {
    if (line.startsWith("-")) continue;
    if (line.length === 0) continue;
    return line.split(/\s+/)[0];
  }
  return undefined;
}

const PINNED_IMAGE_ARG = /^"?\$(TRIVY_IMAGE|GITLEAKS_IMAGE)"?$/;

describe("security-scan.yml wiring", () => {
  test("runs on pull requests, on main, on a schedule and on demand", () => {
    // The four together are the control: pull requests get the deterministic
    // scan, main and the cron get the gate, dispatch is how a maintainer
    // re-checks after taking a fix.
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "schedule", "workflow_dispatch"]);
  });

  test("keys concurrency by ref", () => {
    // A shared group lets the daily cron and a pull request run cancel each
    // other, leaving a cancelled check on the pull request - the exact failure
    // distribution-check.yml records in its own comment.
    expect(workflow.concurrency?.group).toContain("github.ref");
  });

  test("keys concurrency by event too, so a push to main cannot cancel the daily cron", () => {
    // `push` to main and the daily `schedule` share github.ref
    // (refs/heads/main). Without the event in the group, a push cancels that
    // day's only image scan mid-run - image-scan excludes `push` entirely - and
    // a cancelled run sends no failed-run email, the only notification path
    // docs/BACKLOG.md's Phase 2 deferrals name.
    expect(workflow.concurrency?.group).toContain("github.event_name");
  });

  test("defaults to read-only permissions", () => {
    expect(workflow.permissions?.contents).toBe("read");
  });

  test("pins every scanner image by digest", () => {
    const images = Object.entries(workflow.env ?? {}).filter(([k]) => k.endsWith("_IMAGE"));
    expect(images.length).toBeGreaterThan(0);
    for (const [key, value] of images) {
      expect({ key, pinned: DIGEST.test(value) }).toEqual({ key, pinned: true });
    }
  });

  test("every docker run invocation runs the pinned image variable itself, not merely a block that mentions it", () => {
    // Asserted positionally, not by presence anywhere in the WHOLE multi-line
    // invocation: a block that hardcodes the tag as its real argument while
    // carrying an unrelated, unused reference to $TRIVY_IMAGE or
    // $GITLEAKS_IMAGE elsewhere - a decoy `-e` flag, a comment - would still
    // read as "pinned" under a presence-only check. `imageArgument` finds the
    // token docker actually reads as the image: the first non-flag word after
    // `docker run --rm \`.
    let checked = 0;
    for (const step of allSteps) {
      for (const block of dockerRunBlocks(step.run ?? "")) {
        checked += 1;
        const arg = imageArgument(block);
        const pinned = arg !== undefined && PINNED_IMAGE_ARG.test(arg);
        expect({ name: step.name, invocation: block.split("\n")[0].trim(), imageArgument: arg, pinned }).toEqual({
          name: step.name,
          invocation: block.split("\n")[0].trim(),
          imageArgument: arg,
          pinned: true,
        });
      }
    }
    // A helper that silently found nothing to check would make every
    // iteration above vacuous.
    expect(checked).toBeGreaterThan(0);
  });

  test("any step conditioned on another step's own outcome begins with an explicit status function", () => {
    // A bare `steps.x.outcome == 'y'` (or `.conclusion == 'y'`) has no status
    // function, so GitHub Actions implicitly prepends `success() &&` - which
    // is false whenever the referenced step failed, since a failed step makes
    // the job's running status failed too. The exact shape of the regression
    // this guards: `if: steps.gate.outcome == 'failure'` collapses to
    // `success() && steps.gate.outcome == 'failure'`, which can never be true.
    const STATUS_FN = /^(failure|success|always|cancelled)\(\)/;
    const STEP_OUTCOME = /steps\.[A-Za-z0-9_-]+\.(outcome|conclusion)/;
    let checked = 0;
    for (const step of allSteps) {
      if (!step.if || !STEP_OUTCOME.test(step.if)) continue;
      checked += 1;
      expect({ name: step.name, if: step.if, startsWithStatusFn: STATUS_FN.test(step.if) }).toEqual({
        name: step.name,
        if: step.if,
        startsWithStatusFn: true,
      });
    }
    // A step referencing another step's outcome is exactly the shape this
    // guards; zero of them found would make the loop vacuous.
    expect(checked).toBeGreaterThan(0);
  });

  test("pins every action to a full commit SHA", () => {
    for (const step of allSteps) {
      if (!step.uses) continue;
      if (step.uses.startsWith("./")) continue; // the local bun-install composite
      expect({ uses: step.uses, pinned: /@[0-9a-f]{40}$/.test(step.uses) }).toEqual({
        uses: step.uses,
        pinned: true,
      });
    }
  });
});

describe("secret-scan is the one scan allowed to fail a check", () => {
  const job = workflow.jobs["secret-scan"];
  const steps = job?.steps ?? [];
  const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  const scan = steps.find((s) => s.run?.includes("gitleaks") || s.run?.includes("GITLEAKS_IMAGE"));

  test("exists and is named for a human reading the checks list", () => {
    expect(job).toBeDefined();
    expect(job.name).toBe("Secret Scan");
  });

  test("checks out enough history to scan a range", () => {
    // The default single-commit checkout makes `git log base..head` empty, and
    // an empty range scans nothing and passes.
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  test("scans only the pull request's own commits, diffing merges against their first parent", () => {
    // Plain `git log` already shows no diff for a merge commit, so a bare
    // range never re-floods with the other side's unrelated history; but it
    // also means a secret introduced only while resolving a merge conflict
    // reaches neither parent's diff and would go unscanned. Verified
    // 2026-08-09: `--diff-merges=first-parent` is what surfaces that
    // resolution while a linear (no-merge) range scans identically to a bare
    // range.
    const resolver = steps.find((s) => s.id === "range");
    expect(resolver?.run).toContain("--diff-merges=first-parent");
    expect(resolver?.run).toContain("pull_request");
    expect(resolver?.run).toContain("--all");
  });

  test("resolves the pull-request range with git rev-list --count under set -e, so an unresolvable range fails loudly", () => {
    // gitleaks itself logs an unresolvable range ("fatal: Invalid revision
    // range") at ERROR and still exits 0 - measured on the pinned digest, and
    // reproduced by `.git` being a file rather than a directory, the worktree
    // case. `git rev-list --count` resolving the SAME range under the SAME
    // `set -e` fails this step before gitleaks ever runs.
    const resolver = steps.find((s) => s.id === "range");
    expect(resolver?.run).toContain("set -euo pipefail");
    expect(resolver?.run).toContain("git rev-list --count");
    expect(resolver?.run).toContain("commit_count");
  });

  test("derives commit_count from the SAME range string log_opts uses, not a second construction", () => {
    // Two independent constructions of "$BASE_SHA..$HEAD_SHA" - one for
    // log_opts, one for commit_count - can diverge: a sabotage that reverses
    // the direction in log_opts alone would leave commit_count correct and
    // non-zero, satisfying the assertion below, while gitleaks scans the
    // reversed - typically empty - direction and reports clean. Asserting a
    // single `range=` assignment feeding both outputs is what makes that
    // impossible rather than merely absent today.
    const resolver = steps.find((s) => s.id === "range");
    const run = resolver?.run ?? "";
    expect(run).toMatch(/range="--diff-merges=first-parent \$BASE_SHA\.\.\$HEAD_SHA"/);
    expect(run).toContain('echo "log_opts=$range"');
    expect(run).toContain("git rev-list --count $range");
  });

  test("asserts the scanned commit count is non-zero, and only on a pull request", () => {
    // Resolving is not enough: an empty-but-valid range also passes gitleaks
    // silently. Not asserted outside pull_request - `--all` has no single
    // count worth asserting, and main/the cron/dispatch are not the
    // racing-synchronize case this exists for.
    const assertion = steps.find((s) => s.name === "Assert the scan covered commits");
    expect(assertion).toBeDefined();
    expect(assertion?.if).toBe("github.event_name == 'pull_request'");
    expect(assertion?.run).toContain("COMMIT_COUNT");
    expect(assertion?.run).toMatch(/-eq 0/);
    expect(assertion?.run).toContain("exit 1");
  });

  test("refuses to run --all against a shallow checkout", () => {
    // A shallow `--all` does not fail the way an unresolvable pull-request
    // range does - it scans however many commits the shallow boundary left
    // reachable and reports "no leaks found" over that truncated slice,
    // indistinguishable from a real clean scan of the full history. Verified
    // live 2026-08-09: `git rev-parse --is-shallow-repository` prints
    // "true" for a `--depth 1` clone and "false" for a full one.
    const resolver = steps.find((s) => s.id === "range");
    const run = resolver?.run ?? "";
    expect(run).toContain("git rev-parse --is-shallow-repository");
    expect(run).toMatch(/is-shallow-repository\)"\s*=\s*"true"/);
    expect(run).toContain("exit 1");
  });

  test("the commit-count assertion runs after the scan, not before it", () => {
    const names = steps.map((s) => s.name);
    expect(names.indexOf("Assert the scan covered commits")).toBeGreaterThan(
      names.indexOf("Scan for committed secrets"),
    );
  });

  test("passes the repository's allowlist rather than gitleaks' bare defaults", () => {
    expect(scan?.run).toContain(".gitleaks.toml");
  });

  test("redacts the matched value out of the log", () => {
    // The log is public on a public repository. A finding that prints the secret
    // widens the incident it is reporting.
    expect(scan?.run).toContain("--redact");
  });

  test("no step in this job is advisory", () => {
    for (const step of steps) {
      expect({ name: step.name, advisory: step["continue-on-error"] === true }).toEqual({
        name: step.name,
        advisory: false,
      });
    }
  });

  test("the job itself is not conditional", () => {
    // A job-level `if` here would be a way to make the one blocking scan skip.
    expect(job.if).toBeUndefined();
  });
});

describe("dependency-scan reports on pull requests and gates elsewhere", () => {
  const job = workflow.jobs["dependency-scan"];
  const steps = job?.steps ?? [];
  const install = steps.find((s) => s.uses === "./.github/actions/bun-install");
  const report = steps.find((s) => s.run?.includes("--output /out/deps.json"));
  const sarif = steps.find((s) => s.uses?.startsWith("github/codeql-action/upload-sarif@"));
  const audit = steps.find((s) => s.run?.includes("bun audit"));
  const gate = steps.find((s) => s.name === "Gate: critical, fixable, unsuppressed");
  const explainer = steps.find((s) => s.name === "Explain a failed gate");

  test("exists and is named for a human reading the checks list", () => {
    expect(job).toBeDefined();
    expect(job.name).toBe("Dependency Scan");
  });

  test("installs dependencies through the composite action, never a bare bun install", () => {
    // A bare `bun install` has no retry; one failed tarball download broke three
    // runs in a day, one of them a release publish.
    expect(install).toBeDefined();
    for (const step of steps) {
      expect({ name: step.name, bare: /(^|\s)bun install(\s|$)/.test(step.run ?? "") }).toEqual({
        name: step.name,
        bare: false,
      });
    }
  });

  test("the reporting scan never narrows severity - the summary shows everything", () => {
    expect(report).toBeDefined();
    expect(report?.run).not.toContain("--severity");
    expect(report?.run).toContain("--ignorefile /repo/.trivyignore.yaml");
  });

  test("the reporting scan cannot fail the job", () => {
    // No --exit-code anywhere in the reporting path: an advisory published
    // overnight must not turn a contributor's unrelated pull request red.
    expect(report?.run).not.toContain("--exit-code");
  });

  test("the gate is the narrow, actionable set", () => {
    expect(gate).toBeDefined();
    expect(gate?.run).toContain("--severity CRITICAL");
    expect(gate?.run).toContain("--ignore-unfixed");
    expect(gate?.run).toContain("--exit-code 1");
    expect(gate?.run).toContain("--ignorefile /repo/.trivyignore.yaml");
  });

  test("the gate is a second scan, not a convert of the report", () => {
    // Verified 2026-08-09: `trivy convert` does NOT honour --ignore-unfixed. A
    // gate built on convert would fail on findings with no available fix, which
    // is the exact permanent-red this threshold exists to avoid.
    expect(gate?.run).toContain(" fs ");
    expect(gate?.run).not.toContain("convert");
  });

  test("the gate never runs on a pull request", () => {
    expect(gate?.if).toBe("github.event_name != 'pull_request'");
  });

  test("the gate step is identifiable, so the failure explainer can target its own outcome", () => {
    expect(gate?.id).toBe("gate");
  });

  test("the failure explainer fires only when the gate step itself failed", () => {
    // A bare if: failure() fires for ANY earlier failure in the job - a Trivy
    // DB download timeout, a bun install flake - and tells whoever hit it that
    // a CRITICAL advisory is present and sends them to edit
    // .trivyignore.yaml. That lands on the audience least able to diagnose it.
    //
    // `failure() &&` is required, not optional: `steps.gate.outcome ==
    // 'failure'` alone has no status function, so GitHub Actions implicitly
    // prepends `success() &&` - which is already false once the gate step has
    // failed, so the bare form can never fire at all, on the one path where
    // firing is the point.
    expect(explainer).toBeDefined();
    expect(explainer?.if).toBe("failure() && steps.gate.outcome == 'failure'");
  });

  test("no step in this job is advisory either", () => {
    // secret-scan has this guard; dependency-scan's own gate step - the one
    // scanner in this job permitted to fail anything - did not.
    for (const step of steps) {
      expect({ name: step.name, advisory: step["continue-on-error"] === true }).toEqual({
        name: step.name,
        advisory: false,
      });
    }
  });

  test("bun audit reports and cannot fail the job", () => {
    expect(audit).toBeDefined();
    expect(audit?.run).toContain("|| true");
  });

  test("the SARIF upload is guarded against fork pull requests", () => {
    // A fork's GITHUB_TOKEN is read-only, so security-events: write is not
    // granted and the upload would fail for every external contributor. Same
    // guard shape as ci.yml's SonarCloud job.
    expect(sarif).toBeDefined();
    expect(sarif?.if).toContain("head.repo.full_name == github.repository");
    expect(job.permissions?.["security-events"]).toBe("write");
  });

  test("the SARIF upload names a category, so it does not collide with CodeQL", () => {
    expect(sarif?.with?.category).toBe("trivy-dependencies");
  });
});

describe("image-scan reports and never gates", () => {
  const job = workflow.jobs["image-scan"];
  const steps = job?.steps ?? [];
  const resolve = steps.find((s) => s.id === "image");
  const scan = steps.find((s) => s.run?.includes("--output /out/image.json"));
  const sbom = steps.find((s) => s.run?.includes("--output /out/image.cdx.json"));
  const sarif = steps.find((s) => s.uses?.startsWith("github/codeql-action/upload-sarif@"));

  test("exists and is named for a human reading the checks list", () => {
    expect(job).toBeDefined();
    expect(job.name).toBe("Image Scan");
  });

  test("never runs on a pull request - there is no image for a pull request", () => {
    // docker-build-push.yml publishes from main, feature branches and releases.
    // A pull request has no image of its own, and scanning :latest from a pull
    // request would report the released image against unrelated code.
    expect(job.if).toContain("github.event_name != 'pull_request'");
  });

  test("scans the image users actually run", () => {
    expect(resolve?.run).toContain("ghcr.io/libredb/libredb-studio:latest");
  });

  test("resolves :latest to one digest and reuses it for both the vuln scan and the SBOM", () => {
    // The vuln scan and the SBOM are two separate `docker run` invocations
    // minutes apart. Each independently resolving `:latest` would let a
    // release that retags `:latest` mid-run make them describe two different
    // images with no shared identity - the class of bug a digest-pinned
    // reference exists everywhere else in this workflow to rule out.
    expect(resolve?.run).toContain("imagetools inspect");
    expect(resolve?.run).toContain("image_ref=ghcr.io/libredb/libredb-studio@$digest");
    expect(scan?.env?.IMAGE_REF).toBe("${{ steps.image.outputs.image_ref }}");
    expect(sbom?.env?.IMAGE_REF).toBe("${{ steps.image.outputs.image_ref }}");
    expect(scan?.run).toContain('"$IMAGE_REF"');
    expect(sbom?.run).toContain('"$IMAGE_REF"');
  });

  test("cannot fail: no exit code anywhere in this job", () => {
    // Measured 2026-08-09: the runtime base carries 4 critical and 18 high
    // Debian CVEs, and 167 of 168 findings have no fixed package. Any
    // --exit-code here is a permanent red, which ends with the workflow being
    // disabled rather than the CVEs being fixed.
    for (const step of steps) {
      expect({ name: step.name, gates: (step.run ?? "").includes("--exit-code") }).toEqual({
        name: step.name,
        gates: false,
      });
    }
  });

  test("uploads under its own category so it does not overwrite the dependency results", () => {
    expect(sarif?.with?.category).toBe("trivy-image");
  });

  test("can read the image from GHCR", () => {
    expect(job.permissions?.packages).toBe("read");
  });
});
