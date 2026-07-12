/**
 * Unit tests for the maintainer-loop lifecycle scripts:
 *
 * - scripts under loop/scripts/: new-milestone.sh (archive rotation + state
 *   reset - the guard against PROGRESS.md/TRIAGE.md growing without bound and
 *   re-introducing context rot) and pipeline.sh (unattended
 *   triage -> planning -> build sequencing with its stage contracts).
 *
 * Both are exercised as real subprocesses against throwaway fixture roots,
 * per the packaging-test convention. The pipeline fixture stubs the agent
 * command (loop.sh's generic-agent path) so no real model runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const NEW_MILESTONE = join(REPO_ROOT, "loop/scripts/new-milestone.sh");
const LOOP_SH = join(REPO_ROOT, "loop/scripts/loop.sh");
const PIPELINE_SH = join(REPO_ROOT, "loop/scripts/pipeline.sh");

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function run(cmd: string[], cwd?: string) {
  return Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
}

// --- new-milestone.sh --------------------------------------------------------

function makeMilestoneFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "loop-milestone-"));
  fixtureRoots.push(root);
  write(
    root,
    "loop/PROGRESS.md",
    [
      "# Progress Log (lab notebook)",
      "",
      "## Entry anatomy (follow this shape)",
      "",
      "- rules about entries",
      "",
      "## Log",
      "",
      "### 2026-07-11 — old entry A (DONE)",
      "",
      "- did a thing",
      "",
      "### 2026-07-12 — old entry B (DONE)",
      "",
      "- did another thing",
      "",
    ].join("\n"),
  );
  write(
    root,
    "loop/TRIAGE.md",
    [
      "# Triage register",
      "",
      "## Spec format",
      "",
      "(the format)",
      "",
      "## Queue",
      "",
      "### #45 — an old consumed spec (QUEUED 2026-07-12)",
      "",
      "- Acceptance bar: something",
      "",
      "## Not for the loop",
      "",
      "- #100 — tracking issue, human splits it",
      "- #108 — epic, human-owned",
      "",
    ].join("\n"),
  );
  write(root, "loop/ACCEPTANCE.md", "# Acceptance Criteria — Maintainer Sweep 2\n\n- [x] everything\n");
  write(root, "loop/IMPLEMENTATION_PLAN.md", "# Implementation Plan — Maintainer Sweep 2\n\n- [x] all tasks\n");
  write(
    root,
    "loop/config/loop.env",
    [
      'LOOP_PROMPT_FILE="loop/PROMPT.md"',
      'LOOP_COMPLETION_SENTINEL="LIBREDB-STUDIO-SWEEP-2-DONE"',
      "LOOP_MAX_ITERATIONS=20",
      "",
    ].join("\n"),
  );
  write(root, ".loop/COMPLETE", "");
  return root;
}

describe("loop/scripts/new-milestone.sh", () => {
  test("archives the previous milestone and resets the working set", () => {
    const root = makeMilestoneFixture();
    const result = run(["bash", NEW_MILESTONE, "sweep-3", root]);
    expect(result.exitCode).toBe(0);

    // Previous milestone name derived from the sentinel; whole set archived.
    expect(read(root, "loop/archive/sweep-2/PROGRESS.md")).toContain("old entry B");
    expect(read(root, "loop/archive/sweep-2/TRIAGE.md")).toContain("old consumed spec");
    expect(read(root, "loop/archive/sweep-2/ACCEPTANCE.md")).toContain("Maintainer Sweep 2");
    expect(read(root, "loop/archive/sweep-2/IMPLEMENTATION_PLAN.md")).toContain("all tasks");

    // PROGRESS keeps the template, drops the old entries, points at the archive.
    const progress = read(root, "loop/PROGRESS.md");
    expect(progress).toContain("Entry anatomy");
    expect(progress).not.toContain("old entry A");
    expect(progress).toContain("loop/archive/");
    expect(progress).toContain("Milestone sweep-3 opened");

    // TRIAGE queue emptied; the anti-re-triage memory is preserved verbatim.
    const triage = read(root, "loop/TRIAGE.md");
    expect(triage).toContain("## Spec format");
    expect(triage).not.toContain("old consumed spec");
    expect(triage).toContain("- #100 — tracking issue, human splits it");
    expect(triage).toContain("- #108 — epic, human-owned");

    // Stubs direct planning mode; env rotated to triage with the new sentinel.
    expect(read(root, "loop/ACCEPTANCE.md")).toContain("STUB");
    expect(read(root, "loop/IMPLEMENTATION_PLAN.md")).toContain("STUB");
    const env = read(root, "loop/config/loop.env");
    expect(env).toContain('LOOP_COMPLETION_SENTINEL="LIBREDB-STUDIO-SWEEP-3-DONE"');
    expect(env).toContain('LOOP_PROMPT_FILE="loop/PROMPT-TRIAGE.md"');

    // Stale completion marker is gone.
    expect(existsSync(join(root, ".loop/COMPLETE"))).toBe(false);
  });

  test("rejects a non-kebab-case milestone name", () => {
    const root = makeMilestoneFixture();
    const result = run(["bash", NEW_MILESTONE, "Sweep_3", root]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("kebab-case");
  });

  test("refuses to reopen the current milestone name", () => {
    const root = makeMilestoneFixture();
    const result = run(["bash", NEW_MILESTONE, "sweep-2", root]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("already the current one");
  });

  test("refuses to overwrite an existing archive", () => {
    const root = makeMilestoneFixture();
    mkdirSync(join(root, "loop/archive/sweep-2"), { recursive: true });
    const result = run(["bash", NEW_MILESTONE, "sweep-3", root]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("refusing to overwrite");
  });
});

// --- pipeline.sh --------------------------------------------------------------

/**
 * Pipeline fixture: a tiny git repo with the REAL loop.sh + pipeline.sh, mode
 * prompts whose text identifies the stage, and a stub agent that emulates the
 * per-mode contract (triage/build create the completion marker, planning does
 * not - unless the planning-completes.flag violation fixture is planted).
 */
function makePipelineFixture({ planningViolation = false } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "loop-pipeline-"));
  fixtureRoots.push(root);

  write(root, "loop/scripts/loop.sh", readFileSync(LOOP_SH, "utf8"));
  write(root, "loop/scripts/pipeline.sh", readFileSync(PIPELINE_SH, "utf8"));
  write(root, "loop/PROMPT-TRIAGE.md", "TRIAGE MODE prompt\n");
  write(root, "loop/PROMPT-PLANNING.md", "PLANNING MODE prompt\n");
  write(root, "loop/PROMPT.md", "BUILD MODE prompt\n");
  write(
    root,
    "stub-agent.sh",
    [
      "#!/usr/bin/env bash",
      "set -eu",
      "mkdir -p .loop",
      'printf "%s\\n" "$1" >> .loop/stub.log',
      'case "$1" in',
      "  *TRIAGE*) touch .loop/COMPLETE ;;",
      "  *PLANNING*) if [ -f planning-completes.flag ]; then touch .loop/COMPLETE; fi ;;",
      "  *BUILD*) touch .loop/COMPLETE ;;",
      "esac",
      "",
    ].join("\n"),
  );
  write(
    root,
    "loop/config/loop.env",
    [
      'LOOP_PROMPT_FILE="loop/PROMPT.md"',
      'LOOP_COMPLETION_SENTINEL="FIXTURE-DONE"',
      `LOOP_AGENT_CMD="${join(root, "stub-agent.sh")}"`,
      'LOOP_AGENT_ARGS=""',
      'LOOP_DISALLOWED_TOOLS=""',
      "LOOP_MAX_TRANSIENT=1",
      "",
    ].join("\n"),
  );
  write(root, ".gitignore", ".loop/\n");
  if (planningViolation) {
    write(root, "planning-completes.flag", "");
  }
  chmodSync(join(root, "stub-agent.sh"), 0o755);
  chmodSync(join(root, "loop/scripts/loop.sh"), 0o755);
  chmodSync(join(root, "loop/scripts/pipeline.sh"), 0o755);

  for (const cmd of [
    ["git", "init", "--quiet", "--initial-branch=main"],
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"],
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "fixture"],
    ["git", "checkout", "--quiet", "-b", "loop/fixture-run"],
  ]) {
    const r = run(cmd, root);
    if (r.exitCode !== 0) throw new Error(`fixture git setup failed: ${cmd.join(" ")}: ${r.stderr.toString()}`);
  }
  return root;
}

describe("loop/scripts/pipeline.sh", () => {
  test("runs triage, planning and build in order and exits 0", () => {
    const root = makePipelineFixture();
    const result = run(["bash", join(root, "loop/scripts/pipeline.sh"), "3", "3"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("pipeline COMPLETE");

    const stages = read(root, ".loop/stub.log").trim().split("\n");
    expect(stages[0]).toContain("TRIAGE");
    expect(stages[1]).toContain("PLANNING");
    expect(stages[stages.length - 1]).toContain("BUILD");
  });

  test("aborts when planning creates the completion marker (contract violation)", () => {
    const root = makePipelineFixture({ planningViolation: true });
    const result = run(["bash", join(root, "loop/scripts/pipeline.sh"), "3", "3"], root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("planning must never complete");
    // Build never ran.
    expect(read(root, ".loop/stub.log")).not.toContain("BUILD");
  });

  test("refuses a dirty working tree", () => {
    const root = makePipelineFixture();
    write(root, "uncommitted.txt", "dirty");
    const result = run(["bash", join(root, "loop/scripts/pipeline.sh")], root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not clean");
  });

  test("refuses to run on main", () => {
    const root = makePipelineFixture();
    run(["git", "checkout", "--quiet", "main"], root);
    const result = run(["bash", join(root, "loop/scripts/pipeline.sh")], root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("dedicated loop branch");
  });
});
