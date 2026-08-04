/**
 * Unit tests for the maintainer-loop lifecycle scripts:
 *
 * - scripts under loop/scripts/: new-milestone.sh (seed/reset of the LIVE working
 *   state under .loop/ from the tracked loop/*.template sources — the guard
 *   against PROGRESS.md/TRIAGE.md growing without bound and re-introducing context
 *   rot, and against loop bookkeeping leaking into a tracked feature PR) and
 *   pipeline.sh (unattended triage -> planning -> build sequencing with its stage
 *   contracts).
 *
 * Both are exercised as real subprocesses against throwaway fixture roots, per the
 * packaging-test convention. The tracked scaffold lives in loop/ (templates,
 * prompts, scripts); the live working set lives in the gitignored .loop/. The
 * pipeline fixture stubs the agent command (loop.sh's generic-agent path) so no
 * real model runs.
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
  // Fixtures must be hermetic. LOOP_ENV_FILE is a real input to loop.sh/pipeline.sh,
  // so an inherited one (a shell that ran a stage by hand) would point a fixture at
  // the LIVE loop config instead of its stub agent.
  const env = { ...process.env };
  delete env.LOOP_ENV_FILE;
  return Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
}

// --- new-milestone.sh --------------------------------------------------------

// The tracked templates (loop/*.template) — the single source of truth a fresh
// milestone is seeded from. Kept minimal but structurally faithful to the real
// files (section markers, {{MILESTONE}}/{{SENTINEL}} placeholders).
function writeTemplates(root: string): void {
  write(
    root,
    "loop/PROGRESS.md.template",
    [
      "# Progress Log (lab notebook)",
      "",
      "## Entry anatomy (follow this shape)",
      "",
      "- rules about entries",
      "",
      "---",
      "",
      "## Log",
      "",
      "> Earlier milestones are archived under `.loop/archive/` (one directory per milestone).",
      "",
    ].join("\n"),
  );
  write(
    root,
    "loop/TRIAGE.md.template",
    [
      "# Triage register",
      "",
      "## Spec format",
      "",
      "(the format)",
      "",
      "## Queue",
      "",
      "(empty — populated by triage mode.)",
      "",
      "## Not for the loop",
      "",
      "Issues triaged as benign but not loop work. One line each.",
      "",
    ].join("\n"),
  );
  write(
    root,
    "loop/ACCEPTANCE.md.template",
    [
      "# Acceptance Criteria — Milestone {{MILESTONE}}",
      "",
      "> STUB: planning mode rewrites this. Sentinel `{{SENTINEL}}`; `.loop/COMPLETE` is authoritative.",
      "",
    ].join("\n"),
  );
  write(
    root,
    "loop/IMPLEMENTATION_PLAN.md.template",
    ["# Implementation Plan — Milestone {{MILESTONE}}", "", "> STUB: planning mode rewrites this.", ""].join("\n"),
  );
  write(root, "loop/HANDOFF.md.template", ["# Handoff", "", "No milestone is open (fresh scaffold).", ""].join("\n"));
  write(
    root,
    "loop/config/loop.env.example",
    [
      'LOOP_PROMPT_FILE="loop/PROMPT.md"',
      'LOOP_COMPLETION_SENTINEL="LIBREDB-STUDIO-MILESTONE-DONE"',
      "LOOP_MAX_ITERATIONS=20",
      "",
    ].join("\n"),
  );
}

// A repo mid-milestone: templates in loop/ PLUS a filled live working set in
// .loop/ (as it looks after a run, before the next milestone opens).
function makeMilestoneFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "loop-milestone-"));
  fixtureRoots.push(root);
  writeTemplates(root);
  write(
    root,
    ".loop/PROGRESS.md",
    [
      "# Progress Log (lab notebook)",
      "",
      "## Entry anatomy (follow this shape)",
      "",
      "- rules about entries",
      "",
      "---",
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
    ".loop/TRIAGE.md",
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
  write(root, ".loop/ACCEPTANCE.md", "# Acceptance Criteria — Maintainer Sweep 2\n\n- [x] everything\n");
  write(root, ".loop/IMPLEMENTATION_PLAN.md", "# Implementation Plan — Maintainer Sweep 2\n\n- [x] all tasks\n");
  write(root, ".loop/HANDOFF.md", "# Handoff\n\nSweep 2 complete.\n");
  write(
    root,
    ".loop/config/loop.env",
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

// A repo with the tracked scaffold only and no .loop/ yet (a fresh clone).
function makeFreshFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "loop-fresh-"));
  fixtureRoots.push(root);
  writeTemplates(root);
  return root;
}

describe("loop/scripts/new-milestone.sh", () => {
  test("archives the previous milestone and resets the working set into .loop/", () => {
    const root = makeMilestoneFixture();
    const result = run(["bash", NEW_MILESTONE, "sweep-3", root]);
    expect(result.exitCode).toBe(0);

    // Previous milestone name derived from the sentinel; whole set archived under .loop/.
    expect(read(root, ".loop/archive/sweep-2/PROGRESS.md")).toContain("old entry B");
    expect(read(root, ".loop/archive/sweep-2/TRIAGE.md")).toContain("old consumed spec");
    expect(read(root, ".loop/archive/sweep-2/ACCEPTANCE.md")).toContain("Maintainer Sweep 2");
    expect(read(root, ".loop/archive/sweep-2/IMPLEMENTATION_PLAN.md")).toContain("all tasks");

    // PROGRESS reseeded from the template, drops the old entries, points at the archive.
    const progress = read(root, ".loop/PROGRESS.md");
    expect(progress).toContain("Entry anatomy");
    expect(progress).not.toContain("old entry A");
    expect(progress).toContain(".loop/archive/");
    expect(progress).toContain("Milestone sweep-3 opened");

    // TRIAGE queue emptied (template top); the anti-re-triage memory is preserved verbatim.
    const triage = read(root, ".loop/TRIAGE.md");
    expect(triage).toContain("## Spec format");
    expect(triage).not.toContain("old consumed spec");
    expect(triage).toContain("- #100 — tracking issue, human splits it");
    expect(triage).toContain("- #108 — epic, human-owned");

    // Stubs direct planning mode; placeholders substituted; env rotated to triage with new sentinel.
    const acceptance = read(root, ".loop/ACCEPTANCE.md");
    expect(acceptance).toContain("STUB");
    expect(acceptance).toContain("Milestone sweep-3");
    expect(acceptance).toContain("LIBREDB-STUDIO-SWEEP-3-DONE");
    expect(read(root, ".loop/IMPLEMENTATION_PLAN.md")).toContain("STUB");
    const env = read(root, ".loop/config/loop.env");
    expect(env).toContain('LOOP_COMPLETION_SENTINEL="LIBREDB-STUDIO-SWEEP-3-DONE"');
    expect(env).toContain('LOOP_PROMPT_FILE="loop/PROMPT-TRIAGE.md"');

    // Stale completion marker is gone; the tracked loop/ scaffold is untouched.
    expect(existsSync(join(root, ".loop/COMPLETE"))).toBe(false);
    expect(read(root, "loop/PROGRESS.md.template")).toContain("Entry anatomy");
  });

  test("seeds .loop/ from the templates on a fresh repo (no prior state, no archive)", () => {
    const root = makeFreshFixture();
    const result = run(["bash", NEW_MILESTONE, "sweep-1", root]);
    expect(result.exitCode).toBe(0);

    // Live working set created from templates.
    const progress = read(root, ".loop/PROGRESS.md");
    expect(progress).toContain("Entry anatomy");
    expect(progress).toContain("Milestone sweep-1 opened");
    expect(progress).toContain("fresh");
    expect(read(root, ".loop/TRIAGE.md")).toContain("## Spec format");
    expect(read(root, ".loop/ACCEPTANCE.md")).toContain("Milestone sweep-1");
    expect(read(root, ".loop/HANDOFF.md")).toContain("Handoff");
    const env = read(root, ".loop/config/loop.env");
    expect(env).toContain('LOOP_COMPLETION_SENTINEL="LIBREDB-STUDIO-SWEEP-1-DONE"');
    expect(env).toContain('LOOP_PROMPT_FILE="loop/PROMPT-TRIAGE.md"');

    // Nothing to archive on a fresh seed.
    expect(existsSync(join(root, ".loop/archive"))).toBe(false);
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
    mkdirSync(join(root, ".loop/archive/sweep-2"), { recursive: true });
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
 * not - unless the planning-completes.flag violation fixture is planted). The
 * live loop.env lives under the gitignored .loop/, matching production.
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
      // Records what the AGENT process sees, which is what everything the agent
      // spawns (this repo's own gate included) inherits.
      'printf "%s\\n" "${LOOP_ENV_FILE:-unset}" >> .loop/stub-env.log',
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
    ".loop/config/loop.env",
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

  test("never leaks the runner's env-file pointer into the agent process", () => {
    // pipeline.sh hands each stage its own env file via LOOP_ENV_FILE. That pointer
    // must stop at loop.sh: the agent inherits loop.sh's environment, and this
    // repo's gate shells out to these same scripts against throwaway fixtures. A
    // leaked pointer sends those fixtures at the live config and starts a REAL
    // agent - observed as a fixture case hanging for minutes inside the loop's own
    // gate, with a stray iteration running in the fixture repo.
    const root = makePipelineFixture();
    const result = run(["bash", join(root, "loop/scripts/pipeline.sh"), "3", "3"], root);
    expect(result.exitCode).toBe(0);

    const seen = read(root, ".loop/stub-env.log").trim().split("\n");
    expect(seen.length).toBeGreaterThanOrEqual(3); // one line per stage invocation
    expect([...new Set(seen)]).toEqual(["unset"]);
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
