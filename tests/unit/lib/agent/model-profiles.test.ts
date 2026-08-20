import { describe, expect, test } from "bun:test";
import { MODEL_PROFILES, ceilingFor, samplingFor } from "@/lib/agent/models";
import type { AgentRunWorkflowType } from "@/lib/agent/types";

/**
 * Per-model settings, and the reason they exist.
 *
 * For days this repository looked for one setting that suits 25 local models, and every
 * time one landed it won some cells and cost others. The clearest case is sampling. The
 * loop set no temperature at all, so every run inherited Ollama's 0.8; pinning it to 0 won
 * five cells outright — and cost `qwen3:8b` its `query-optimization` cell, which went 3/5 to
 * 0/5. Both measurements are real. At 0.8 that model opened with `inspect_plan` on 3 of 5
 * runs and won all three; at 0 it opened with `inspect_schema` on 10 of 10 and lost every
 * one, because determinism pinned it to the losing branch instead of letting it wander into
 * the winning one.
 *
 * One global number cannot hold both facts. A per-model profile can.
 *
 * The rule these tests pin is what keeps this from becoming a pile of invented constants:
 * the DEFAULT is the whole policy, and a profile may only contradict it where a measurement
 * required it. Every override carries the numbers that bought it, in the profile file.
 */

const WORKFLOWS: readonly AgentRunWorkflowType[] = [
  "investigation",
  "query-optimization",
  "database-assessment",
  "operations",
  "data-analysis",
];

describe("sampling is decided per model, defaulting to deterministic", () => {
  test("a model nobody has measured gets the default, on every workflow", () => {
    for (const workflow of WORKFLOWS) {
      expect(samplingFor("some-model-released-tomorrow:70b", workflow)).toEqual({ temperature: 0, topP: 1 });
    }
  });

  test("the default is deterministic, because the bar is five consecutive passes", () => {
    // A cell locks only at 5/5, so the bar is a variance test as much as a capability one,
    // and choosing a tool is a structural task with nothing for a sample to explore. This is
    // the setting that won five cells.
    expect(samplingFor("gemma4:26b", "database-assessment")).toEqual({ temperature: 0, topP: 1 });
  });

  test("qwen3:8b is sampled on query-optimization, and nowhere else", async () => {
    /*
      The measured exception, and the only one. Determinism pins this model to a losing
      opening on this surface; on its other five surfaces it locks 5/5 deterministically, so
      the override is scoped to the one cell that needs it rather than to the model.
    */
    expect(samplingFor("qwen3:8b", "query-optimization").temperature).toBeGreaterThan(0);
    expect(samplingFor("qwen3:8b", "database-assessment")).toEqual({ temperature: 0, topP: 1 });
    expect(samplingFor("qwen3:8b", "investigation")).toEqual({ temperature: 0, topP: 1 });
  });

  test("a tag suffix does not hide a profile", () => {
    // Ollama names carry a tag and the same weights answer to more than one of them
    // (`qwen3.8` and `qwen3.8:latest`). A profile keyed on the exact string would silently
    // stop applying the day a tag changed.
    expect(samplingFor("qwen3:8b", "query-optimization")).toEqual(samplingFor("QWEN3:8B", "query-optimization"));
  });

  test("a model that reads past its budget gets its own ceiling", () => {
    /*
      `gemma4:26b`, database-assessment, 4 of 5. Its two ledgers side by side:

        passed:  profiled 4 tables, then reported
        lost:    profiled 11 — employee, department, dept_emp, dept_manager, salary, title,
                 several of them twice — then ended `model-stopped` with no report

      The general ceiling that exists for exactly this is 12 unreported calls, at which point
      the run is narrowed to what would finish it. The losing run stopped at 11: one call
      under, so the mechanism written for it never fired.

      Moving the global ceiling to 11 would change every model's run to fix one cell, which is
      the trade this repository has already paid for twice. The ceiling belongs in this
      model's own file, where it costs nobody else a byte.
    */
    expect(ceilingFor("gemma4:26b")).toBeLessThan(11);
    expect(ceilingFor("qwen3:8b")).toBe(12);
    expect(ceilingFor("some-model-released-tomorrow:70b")).toBe(12);
  });

  test("every profile states what measured it", () => {
    // The guard against a pile of invented constants: an override with no measurement behind
    // it is indistinguishable from a guess, and this file is where guesses would accumulate.
    for (const [name, profile] of Object.entries(MODEL_PROFILES)) {
      expect(profile.measured.length, `${name} has no measurement recorded`).toBeGreaterThan(20);
    }
  });
});
