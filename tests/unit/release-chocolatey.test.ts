/**
 * Unit tests for the Chocolatey publish job's failure containment (issue #114).
 *
 * Why a test for YAML: the community repository answers `403` to a push for
 * reasons that are entirely about ITS queue and not about this repository -
 * documented causes include "package has a version in moderation and no
 * approved versions" and "package has too many existing versions in
 * moderation". Every new version is human-reviewed before approval (only
 * trusted packages skip that), and the moderation team's own figure for the
 * wait is "a few days to a few weeks". So a release cadence faster than the
 * queue drains WILL eventually hit that 403 - and an unguarded failure there
 * turns a release that published perfectly into a red run, which is exactly
 * the failure mode `update.ci_enabled` was invented to prevent and which the
 * 0.9.60 and 0.9.61 runs already demonstrated once.
 *
 * The split matters as much as the tolerance: `choco pack` failing is OUR bug
 * (a broken template, a missing file) and must stay loud, while `choco push`
 * failing is the queue's state and must not. One `docker run` doing both would
 * force a single verdict on two different kinds of failure.
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
  "continue-on-error"?: boolean;
  with?: Record<string, string | boolean>;
}
interface Job {
  name?: string;
  needs?: string[];
  steps?: Step[];
  "continue-on-error"?: boolean;
}

const workflow = parseYaml(
  fs.readFileSync(path.join(__dirname, "../../.github/workflows/release-artifacts.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const chocolatey = workflow.jobs.chocolatey;
const steps = chocolatey?.steps ?? [];
const pack = steps.find((s) => s.run?.includes("choco pack"));
const push = steps.find((s) => s.run?.includes("choco push"));
const report = steps.find((s) => s.run?.includes("PackageStatus"));

describe("the Chocolatey publish job", () => {
  test("exists and separates packing from pushing", () => {
    expect(chocolatey).toBeDefined();
    expect(pack).toBeDefined();
    expect(push).toBeDefined();
    // Two different steps, not one run doing both.
    expect(pack).not.toBe(push);
    expect(pack?.run).not.toContain("choco push");
    expect(push?.run).not.toContain("choco pack");
  });

  test("fails the run when packing fails, because a broken package is our bug", () => {
    expect(pack?.["continue-on-error"]).toBeUndefined();
    // Job-level tolerance would swallow the pack failure just as effectively.
    expect(chocolatey?.["continue-on-error"]).toBeUndefined();
  });

  test("tolerates a push failure, because a 403 is the moderation queue's state", () => {
    expect(push?.["continue-on-error"]).toBe(true);
    // The outcome has to be addressable for the report step to read it.
    expect(push?.id).toBeTruthy();
  });

  test("both container invocations pin the official image by digest", () => {
    const runs = [pack?.run ?? "", push?.run ?? ""];
    for (const run of runs) {
      expect(run).toContain("docker run");
      expect(run).toContain("chocolatey/choco");
      expect(run).toMatch(/@sha256:[0-9a-f]{64}/);
    }
  });

  test("reports what the community feed says about the pushed version", () => {
    expect(report).toBeDefined();
    // The exact-version entity is the only public read that can answer for a
    // version the feed does not list yet: `Packages()` returns approved
    // versions only (measured: $filter=IsApproved eq false yields nothing).
    expect(report?.run).toContain("community.chocolatey.org/api/v2/Packages(Id=");
    expect(report?.run).toContain("$GITHUB_STEP_SUMMARY");
  });

  test("the report runs even when the push failed, and never fails the run itself", () => {
    expect(report?.["continue-on-error"]).toBe(true);
    // `if` must not be conditioned on the push having succeeded - a failed push
    // is precisely when the summary line is worth reading.
    expect(report?.if ?? "").not.toContain("steps.push.outcome == 'success'");
    expect(report?.if ?? "").toContain("always()");
  });

  test("the report surfaces a failed push as a warning annotation", () => {
    expect(report?.run).toContain("::warning::");
    // The outcome may reach the script through `env` rather than inline
    // interpolation - what matters is that the step reads it at all.
    expect(JSON.stringify(report)).toContain("steps.push.outcome");
  });
});
