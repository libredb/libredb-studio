import { describe, expect, test } from "bun:test";
import {
  MODEL_PROFILES,
  ceilingFor,
  noticesFor,
  presentReminderLimitFor,
  retriesEmptyTurn,
  turnTimeoutMsFor,
  planStatementRetriesFor,
  reportReminderLimitFor,
  samplingFor,
} from "@/lib/agent/models";
import { BASELINE_NOTICES } from "@/lib/agent/models/notices";
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

  test("the unreported-call ceiling moves only where a ledger showed it firing", () => {
    /*
      `gemma4:26b` overrides it, on the second attempt and for a different reason than the
      first. The first was a guess: 9, read off a single losing run that had profiled eleven
      tables. Five fresh runs at 9 came back 3 of 5 and said why it could not have helped —
      every one made EIGHT calls, so neither 12 nor 9 ever fired — and it was deleted.

      What was missing was a ledger entry that did not exist yet. With the stopping turn
      recorded, the losing run reads plainly: nine tables profiled, two queries, then an EMPTY
      completion at eleven calls — no tool call and no text, one under the general ceiling, with
      nothing left to spend a twelfth on. Ten catches that and clears the eight-call runs, and
      the gap between the two numbers is the reason ten rather than eleven.
    */
    expect(ceilingFor("gemma4:26b")).toBe(10);
    expect(ceilingFor("qwen3:8b")).toBe(12);
    expect(ceilingFor("some-model-released-tomorrow:70b")).toBe(12);
  });

  test("one report reminder, until a measurement earns a second", () => {
    /*
      `gemma4:26b` was given two, on the reading that its losing assessments stop with the
      evidence gathered and most of the run budget unspent. Measured: 2 of 5, against 4 of 5 at
      the defaults. The reminder does reach the model — its calls rose from 8 to 11 — and it
      spends the turn on more profiling rather than on the report, which cost two of the five
      runs their deadline. Deleted, and the numbers kept in the profile.

      The knob stays wired. It is the second override measured and removed on this one cell,
      and the point of keeping both records is that the next attempt starts from what the
      ledgers actually say rather than from the same guess.
    */
    expect(reportReminderLimitFor("gemma4:26b")).toBe(1);
    expect(reportReminderLimitFor("qwen3:8b")).toBe(1);
    expect(reportReminderLimitFor("some-model-released-tomorrow:70b")).toBe(1);
  });

  test("a plan that names no statement is retried only where a measurement asked for it", () => {
    /*
      `qwen3:14b` locks five surfaces and loses `plan` 4 of 5 on one shortfall, `no-statement`.
      Its losing run is not a bad plan — it lists all eight tables, their columns, both join
      tables and which key each relation travels on, and it marks the two column-less views as
      views. What it never writes is a runnable statement or the explicit `NO STATEMENT:`
      refusal, and plan mode's bar is one of those two.

      Planning has no notice for that today: the run produces its prose and the drive concludes.
      One extra turn is offered here, and only to the model measured needing it — a planning run
      costs 15 seconds, so the turn is cheap, but spending it on 24 models that already clear
      the bar is the trade this repository has twice lost a cell to.
    */
    expect(planStatementRetriesFor("qwen3:14b")).toBe(1);
    expect(planStatementRetriesFor("qwen3:8b")).toBe(0);
    expect(planStatementRetriesFor("some-model-released-tomorrow:70b")).toBe(0);
  });

  test("a model whose turn does not fit the shipped limit is given its own", () => {
    /*
      `qwen3.5:9b` clears five surfaces and loses Plan, and the loss is not a plan the verdict
      rejected — the run ends `model-timeout` having produced nothing. Its plan turns are
      bimodal: 26 seconds when they land, 92 to 94 when they do not, against a shipped limit of
      90. Measured 1/5 on this build and 1/5 on the build from before `main` was merged, so it
      is neither a regression nor the laptop; the cell's earlier 5/5 was taken when the limit
      was 150.

      The limit stays 90 for everyone else. Raising the product's default to fit one model
      would spend every other model's user's patience on it, and this is the narrower thing the
      profile directory exists for: the model that needs more time asks for it by name.
    */
    expect(turnTimeoutMsFor("qwen3.5:9b")).toBe(150_000);
    expect(turnTimeoutMsFor("qwen3:8b")).toBeUndefined();
    expect(turnTimeoutMsFor("some-model-released-tomorrow:70b")).toBeUndefined();
  });

  test("the model measured answering nothing at all, and nobody else", () => {
    /*
      `gemma4:26b` lost database-assessment fifteen measured times before this was read
      correctly. It was taken for a model declining to file, and the two fixes for that were
      measured and deleted — a second reminder 4/5 to 2/5, a lower ceiling to 3/5.

      Its losing runs carry no stopping text at all, and both entries that would hold it are
      written whenever a turn has any. The model returns an EMPTY completion, which the loop
      reads as a model that chose to stop. Asking again costs one turn, so only the model whose
      ledger showed the empty turn arriving with the work already done gets it.
    */
    expect(retriesEmptyTurn("gemma4:26b")).toBe(true);
    expect(retriesEmptyTurn("qwen3:8b")).toBe(false);
    expect(retriesEmptyTurn("some-model-released-tomorrow:70b")).toBe(false);
  });

  test("the answer is asked for once, and no measurement has earned a second", () => {
    /*
      One model was given two during evaluation, on the reading that it reports straight through
      the first telling. Then its ledger was read properly: there was no hold in it at all. The
      hold never fired, so a second could not have helped.

      Why it did not fire was the finding, and it was a blind spot rather than a bug in the
      limit: a REFUSED `present_answer` wrote no ledger event but still set a flag saying the
      answer had been attempted, so a call the tool declined disabled the hold for the rest of
      the run and left no trace of having done so. That refusal is recorded now.
    */
    expect(presentReminderLimitFor("qwen3:8b")).toBe(1);
    expect(presentReminderLimitFor("gemma4:26b")).toBe(1);
    expect(presentReminderLimitFor("some-model-released-tomorrow:70b")).toBe(1);
  });

  test("every model carries its own copy of every sentence, and they start identical", () => {
    /*
      The isolation this directory is FOR, applied to wording as well as to numbers.

      A sentence is read by a model and acted on by that model, so a wording that recovers one
      run can be the wording another gives up on — a measured value, not a constant. Twice a
      shared value was changed here, won several cells and lost others, and the only move left
      was to revert and hand back the wins. With the sentence in the model's own file, the
      models it helped keep it and the models it hurt keep what they had.

      The equality is asserted, not asserted-about: the copies were spread from the baseline at
      the moment sharing stopped, so on day one every model is sent exactly the bytes it was
      sent before, and 97 locked cells stay locked without being re-measured. This test is what
      makes that a fact rather than a claim — and it is expected to go red the first time a
      measurement moves one model's wording, which is the point.
    */
    for (const [name, profile] of Object.entries(MODEL_PROFILES)) {
      expect(profile.notices, `${name} shares its wording instead of owning it`).toBeDefined();
      expect(noticesFor(name), `${name} is sent something other than what it was measured with`).toEqual(
        BASELINE_NOTICES,
      );
    }
  });

  test("a model nobody has measured is given the baseline wording", () => {
    // The one place the baseline is still read at run time, and the honest treatment of a
    // model with no file: it is sent what everything else was measured with.
    expect(noticesFor("some-model-released-tomorrow:70b")).toEqual(BASELINE_NOTICES);
  });

  test("every profile states what measured it", () => {
    // The guard against a pile of invented constants: an override with no measurement behind
    // it is indistinguishable from a guess, and this file is where guesses would accumulate.
    for (const [name, profile] of Object.entries(MODEL_PROFILES)) {
      expect(profile.measured.length, `${name} has no measurement recorded`).toBeGreaterThan(20);
    }
  });
});
