import { describe, expect, test } from "bun:test";
import {
  modelProfiles,
  ceilingFor,
  presentReminderLimitFor,
  retriesEmptyTurn,
  turnTimeoutMsFor,
  planStatementRetriesFor,
  reportReminderLimitFor,
  samplingFor,
  threadContextMaxCharsFor,
  verdictHoldLimitFor,
} from "@/lib/agent/models";
import { AGENT_THREAD_CONTEXT_MAX_CHARS } from "@/lib/agent/execution-policy";
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

  test("a model id is matched case-insensitively, and its TAG is not stripped", () => {
    /*
      Two facts, and the second is the one the old name got wrong. This used to be called "a tag
      suffix does not hide a profile" and its comment described tag tolerance, while the assertion
      compared two CASINGS of the same tagged id. The register lower-cases and does nothing else,
      so a name promising tag handling covered none of it and made the eventual fix look shipped.

      The second assertion pins the gap rather than papering over it: a bare `qwen3.8` does not
      find `qwen3.8:latest`, so somebody running an untagged pull is driven with the defaults. It
      is recorded here, in the place a reader looks, instead of only in the register's docblock —
      and it is a pin rather than a wish, so implementing tag matching turns this red and asks for
      the measurement that should come with it.
    */
    expect(samplingFor("qwen3:8b", "query-optimization")).toEqual(samplingFor("QWEN3:8B", "query-optimization"));
    // Asserted on the REGISTER rather than on a resolved value: the first version of this line
    // compared two `samplingFor` answers, which are equal for this model because its entry states
    // no per-surface sampling — a pass that says nothing about tags. Presence in the register is
    // the fact.
    expect(modelProfiles()["qwen3.8:latest"]).toBeDefined();
    expect(modelProfiles()["qwen3.8"]).toBeUndefined();
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

  test("no shipped profile sizes the conversation, because nobody has measured one", () => {
    /*
      The one setting in this directory that carries NO measurement, and the assertion
      is about that rather than about a number. It exists so an operator who has
      measured their own model can size the conversation it is handed — the value
      depends on the context window, and this product runs a hosted 200k model and a
      small local one under the same code — and shipping a value nobody measured would
      make this document claim something it does not have.

      Every model therefore resolves to the compiled budget, including the ten that ARE
      measured for everything else.
    */
    for (const modelId of Object.keys(modelProfiles())) {
      expect(threadContextMaxCharsFor(modelId)).toBe(AGENT_THREAD_CONTEXT_MAX_CHARS);
    }
    expect(threadContextMaxCharsFor("some-model-released-tomorrow:70b")).toBe(AGENT_THREAD_CONTEXT_MAX_CHARS);
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

  test("how many times a losing report may be held is a per-model number, and two for everyone", () => {
    /*
      The third reminder bound, and the last of the three to become per-model. Its two
      siblings — `reportReminderLimit` and `presentReminderLimit` — have been per-model since
      they were written; this one was a module constant, so a model measured needing a third
      ask had nowhere to record it.

      Two remains the default and the reasoning for it is unchanged: at three, a run that will
      not comply pays three wasted turns before the same verdict it was always going to get.
      That argument is about the DEFAULT. It says nothing about a model whose ledgers show the
      third ask landing, and until now there was no way to tell those two cases apart.

      Every shipped model resolves to two, because none has been measured needing otherwise.
    */
    for (const modelId of Object.keys(modelProfiles())) {
      expect(verdictHoldLimitFor(modelId)).toBe(2);
    }
    expect(verdictHoldLimitFor("some-model-released-tomorrow:70b")).toBe(2);
  });

  test("every profile states what measured it", () => {
    // The guard against a pile of invented constants: an override with no measurement behind
    // it is indistinguishable from a guess, and this file is where guesses would accumulate.
    for (const [name, profile] of Object.entries(modelProfiles())) {
      expect(profile.measured.length, `${name} has no measurement recorded`).toBeGreaterThan(20);
    }
  });
});
