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

  test("never runs a container by tag", () => {
    // An inline `docker run some/image:tag` would bypass the env pinning above.
    for (const step of allSteps) {
      const run = step.run ?? "";
      expect({ name: step.name, taggedRun: /docker run[^\n]*\s[a-z0-9./-]+:[a-z0-9.-]+\s/.test(run) }).toEqual({
        name: step.name,
        taggedRun: false,
      });
    }
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

  test("scans only the pull request's own commits, and skips merge commits", () => {
    const resolver = steps.find((s) => s.id === "range");
    expect(resolver?.run).toContain("--no-merges");
    expect(resolver?.run).toContain("pull_request");
    expect(resolver?.run).toContain("--all");
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
