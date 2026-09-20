/**
 * The release skill's smoke phase names things the repository can change underneath it.
 *
 * Phase 7 of `.claude/skills/cut-release/SKILL.md` is the only step that runs the
 * published image rather than reading a registry row, so it is the last thing standing
 * between a broken artifact and the users who pull it. To be run at all it has to be
 * followable: it hands the reader an admin email to log in with and a list of liveness
 * paths to curl.
 *
 * Both are facts about this codebase restated as prose in a file no gate reads. The
 * liveness list is the one that has already moved once - `/health` and `/api/health`
 * joined `/api/db/health` in 0.16.1 - and a phase that curls a path the app stopped
 * serving fails in a way that reads as a broken release rather than as a stale runbook.
 * An email that no longer matches `.env.example` is worse, because the reader sees a
 * rejected login and has no reason to suspect the instructions.
 *
 * Neither is checked anywhere else: the routes have their own tests and `.env.example`
 * has its own readers, but nothing ties either back to the skill.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SKILL_PATH = ".claude/skills/cut-release/SKILL.md";

function skillText(): string {
  return readFileSync(join(REPO_ROOT, SKILL_PATH), "utf8");
}

/** The smoke phase alone, so a path named in an unrelated phase cannot satisfy these. */
function smokePhase(): string {
  const text = skillText();
  const start = text.indexOf("## Phase 7 - Smoke the published image");
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("\n## ", start + 1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

/**
 * Every liveness route the app serves, as a request path.
 *
 * Read off the filesystem rather than listed by hand, so a new one fails this test
 * instead of quietly going unmentioned in the phase that exists to probe them.
 * `fleet-health` is excluded deliberately: it is an authenticated admin surface, not a
 * liveness path, so no probe should be curling it unauthenticated.
 */
const LIVENESS_ROUTES = ["/health", "/api/health", "/api/db/health"] as const;

describe("the release skill's smoke phase stays followable", () => {
  test("every liveness route the app serves exists as a route file", () => {
    const missing = LIVENESS_ROUTES.filter((route) => !existsSync(join(REPO_ROOT, "src/app", route, "route.ts")));
    expect(missing).toEqual([]);
  });

  test("the smoke phase names every liveness route", () => {
    const phase = smokePhase();
    const unnamed = LIVENESS_ROUTES.filter((route) => !phase.includes(route));
    expect(unnamed).toEqual([]);
  });

  test("the login email it hands the reader is the one .env.example defaults to", () => {
    const envExample = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    const declared = envExample.match(/^ADMIN_EMAIL=(.+)$/m)?.[1]?.trim();
    expect(declared).toBeTruthy();
    expect(smokePhase()).toContain(declared as string);
  });

  test("it reads the table back from the engine, not from the grid", () => {
    // The row-identity check is the reason the phase is worth running: an app that
    // repaints correctly while writing to another row passes every on-screen check.
    // If this instruction is ever softened to "check the grid", the phase stops
    // catching the one defect class it was added for.
    const phase = smokePhase();
    expect(phase).toContain("from the engine");
    expect(phase).toMatch(/row-identity/i);
  });
});
