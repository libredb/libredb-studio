/**
 * The model sweep's own tooling, which is what the measured figures are produced with.
 *
 * Two defects fixed together, and they share a shape: the tool reported something other than
 * what happened, and nothing was watching.
 *
 * The sweep piped Playwright through `sed` to prefix each line with the model's name, so `$?`
 * was sed's — and sed always succeeds. A model could fail its entire UI sweep while the script
 * printed `done` and exited 0. Anything reading that status was told a sweep passed that had not.
 *
 * And the config kept video on `retain-on-failure` under a comment saying videos are kept for
 * every test because somebody watches the sweep afterwards. `retain-on-failure` deletes exactly
 * the videos of the runs that passed, which is most of an hour-long sweep.
 *
 * Grep-shaped rather than executed, like the other script tests here: driving ten models through
 * a browser is not a unit test. So the assertions are aimed at the properties that actually
 * break — the ADJACENCY of the status read, and the CONDITION on the video setting — rather than
 * at the presence of a word.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

describe("the sweep script reports the status it was given", () => {
  const SCRIPT = read("scripts/agent-model-e2e.sh");
  const lines = SCRIPT.split("\n");

  test("the pipeline's status is read before anything can clobber it", () => {
    /*
      The property, not the word. `PIPESTATUS` holds the LAST pipeline's statuses and any command
      in between replaces it, so a line inserted after the pipeline — an echo, a sleep, a cleanup
      — would leave this reading whatever that line did. Adjacency is the whole guarantee, and it
      is the kind an editor breaks without noticing.
    */
    const piped = lines.findIndex((line) => line.includes("npx playwright test e2e/agent-models.spec.ts"));
    expect(piped).toBeGreaterThan(-1);

    const after = lines
      .slice(piped + 1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    // The pipeline continues onto the `sed` line, so the status read is the first real statement
    // after it.
    expect(after[0]).toContain("sed ");
    expect(after[1]).toBe("STATUS=${PIPESTATUS[0]}");
  });

  test("a model that failed makes the script exit non-zero, and names which one", () => {
    // Collected across the loop rather than exited on: an hour of measurement is worth
    // finishing. But it must still be a failure at the end, or the collection is decoration.
    expect(SCRIPT).toContain('FAILED="$FAILED $MODEL"');
    expect(SCRIPT).toMatch(/if \[ -n "\$FAILED" \]; then[\s\S]*?exit 1/);
  });
});

describe("the sweep keeps the video its own comment promises", () => {
  const CONFIG = read("playwright.config.ts");

  test("video is retained for every test during a sweep, and only during one", () => {
    // Both halves matter. `on` everywhere would have CI keep a video of every passing test in
    // every job; `retain-on-failure` everywhere deletes the ones the sweep exists to produce.
    expect(CONFIG).toContain('video: process.env.AGENT_MODEL_E2E ? "on" : "retain-on-failure"');
  });

  test("the variable it keys on is the one the sweep actually sets", () => {
    // A condition on a variable nobody sets is a setting that never turns on, which would look
    // exactly like the fix and behave exactly like the defect.
    expect(read("scripts/agent-model-e2e.sh")).toContain("AGENT_MODEL_E2E=1");
  });
});
