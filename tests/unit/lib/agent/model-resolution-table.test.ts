/**
 * What every resolver answers, for every model id, as of the commit before the profiles moved.
 *
 * This file is the identity proof for that move. The nine functions below are the ONLY path from
 * a profile to a run — `grep` for their names across `src/` returns `investigation.ts`,
 * `tools.ts` and `models/index.ts` and nothing else — so a change that leaves all of their
 * answers alone cannot change what any model does.
 *
 * The table is LITERAL, and deliberately so. It was printed once from the tree that still held
 * the ten modules and pasted here; it is never regenerated. A table regenerated from the code it
 * is meant to check would turn a transcription error into a passing test, which is the one
 * failure this file exists to prevent. After a new measurement, it is edited by hand, beside the
 * value that changed.
 *
 * Three of the ids are not models. `some-model-released-tomorrow:70b` is an unmeasured release
 * and must resolve to the defaults; `QWEN3:8B` proves the register is matched case-insensitively;
 * and the bare `qwen3.8` records something the code does NOT do — `qwen3.8:latest` finds its
 * profile and `qwen3.8` does not, though `index.ts` describes itself as tolerating tags. That is
 * a real defect, and pinning it here is how the fix becomes visible when it is measured. It is
 * not fixed in the same change that claims to change nothing.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  modelProfiles,
  ceilingFor,
  offersRefusalExamples,
  planStatementRetriesFor,
  presentReminderLimitFor,
  reportReminderLimitFor,
  retriesEmptyTurn,
  retriesUnreadStop,
  samplingFor,
  suppressesAgentReasoning,
  compareHoldLimitFor,
  verdictHoldLimitFor,
  suppressesPlanReasoning,
  turnTimeoutMsFor,
} from "@/lib/agent/models";
import { BASELINE_NOTICES } from "@/lib/agent/models/notices";
import type { AgentRunWorkflowType } from "@/lib/agent/types";

const WORKFLOWS: readonly AgentRunWorkflowType[] = [
  "investigation",
  "query-optimization",
  "database-assessment",
  "operations",
  "data-analysis",
];

/** The sampling every surface gets unless a profile names that surface. */
const PINNED = { temperature: 0, topP: 1 } as const;

interface ResolvedRow {
  readonly id: string;
  readonly unreportedCallCeiling: number;
  readonly reportReminderLimit: number;
  readonly planStatementRetries: number;
  readonly presentReminderLimit: number;
  readonly retriesEmptyTurn: boolean;
  /** Optional: every row measured before this switch existed resolves it to false. */
  readonly retriesUnreadStop?: boolean;
  /** Optional, and PLAN-only; see the field's own note in `profile.ts`. */
  readonly suppressesPlanReasoning?: boolean;
  /** Optional, and AGENT-only; its sibling above does not imply it. */
  readonly suppressesAgentReasoning?: boolean;
  readonly refusalExamples: boolean;
  /** Optional: two everywhere, because no model has been measured recovering on a third hold. */
  readonly verdictHoldLimit?: number;
  /**
   * Optional: one everywhere but the model that asked for it. The compare-before-report hold was a
   * literal in the loop until `laguna-xs-2.1:latest` optimize was measured against it.
   */
  readonly compareHoldLimit?: number;
  readonly turnTimeoutMs: number | undefined;
  /**
   * The model's OWN sampling, which every surface inherits and which a run with no surface yet
   * takes. Absent means `PINNED`, which is what every row meant before one of them differed:
   * `laguna-xs-2.1:latest` is the first, because at temperature 0 the retry after a notice repeats
   * the turn word for word and every loss in its optimize cell is answered with a notice.
   */
  readonly sampling?: { temperature: number; topP: number };
  /** Only the surfaces that differ from the row's own sampling; every other surface resolves to it. */
  readonly samplingOverrides?: Readonly<Partial<Record<AgentRunWorkflowType, { temperature: number; topP: number }>>>;
}

// Mutable by type only: `test.each` refuses a readonly array, and nothing here writes to it.
const RESOLVED: ResolvedRow[] = [
  {
    id: "gemini-3.5-flash-lite",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: true,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    // The sixteenth entry and the fourth model closed on this branch. The only one carrying
    // suppressAgentReasoning, which was written for it: nothing else reached its illness.
    id: "gemma4:12b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    suppressesPlanReasoning: true,
    suppressesAgentReasoning: true,
    turnTimeoutMs: 150_000,
  },
  {
    // The family's largest, and the slowest model the roster carries: a 378-second optimize cell
    // against a 26-second investigation. Two settings and they were earned separately - the plan
    // switch closed a plan cell losing to `thinking`, and the 150-second ceiling is what optimize
    // could not close without. Deliberately NOT `suppressesAgentReasoning`, which its 12b sibling
    // carries: that one was measured for an illness this size does not have.
    id: "gemma4:31b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    suppressesPlanReasoning: true,
    turnTimeoutMs: 150_000,
  },
  {
    id: "gemma4:26b",
    unreportedCallCeiling: 10,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: true,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    id: "granite4.1:30b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    id: "granite4.1:8b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: true,
    refusalExamples: true,
    turnTimeoutMs: undefined,
  },
  {
    id: "ornith:9b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 1,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    // Six cells on the first attempt with NOT ONE setting spent, which is what the whole table is
    // for: the row is short because the model asked for nothing.
    id: "qwen3.5:27b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    retriesUnreadStop: true,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    id: "qwen3.5:9b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: true,
    refusalExamples: false,
    turnTimeoutMs: 150_000,
  },
  {
    // Three settings, and the third was added a day after the other two: a serving-engine upgrade
    // took its optimize cell from 5/5 to 1/5, and the quiet agent turn took it back at 76 seconds
    // against 311.
    id: "qwen3.6:27b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    suppressesPlanReasoning: true,
    suppressesAgentReasoning: true,
    turnTimeoutMs: 150_000,
  },
  {
    // Its 27b sibling's set, taken whole and then re-measured under: optimize went from 2-4/5 to
    // 5/5 and the runs fell from 200-350 seconds to 13-29.
    id: "qwen3.6:35b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    retriesUnreadStop: true,
    refusalExamples: false,
    suppressesPlanReasoning: true,
    suppressesAgentReasoning: true,
    turnTimeoutMs: 150_000,
  },
  {
    id: "qwen3.8:latest",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    id: "qwen3:14b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 1,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    id: "qwen3:4b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    // The thirteenth model. Its only setting is the clock, and everything else is the compiled
    // default: it was measured needing one thing, and a setting it did not earn is a guess.
    id: "nemotron-3.5-lightning:30b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: 150_000,
  },
  {
    // The first of the three this branch added, and the second model ever closed by the autonomous
    // runner rather than by hand. Five of its six cells locked on the first reading at the compiled
    // defaults; query-optimization read 3/5 there, both losses `model-timeout`, and the clock took
    // the cell. One setting, because one is what it was measured needing.
    id: "nemotron-3-nano:30b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: 150_000,
  },
  {
    // The second of the three this branch added, and the only entry in the table that states
    // nothing but the defaults. It closed all six surfaces on its first reading with no setting
    // carried over, and the entry exists BECAUSE of that rather than in spite of it: an absent
    // entry records no measurement, and a model nobody can see was measured is a model nobody can
    // trust.
    id: "granite4.2:8b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    // The third of the three this branch added, and the only model in the table whose open cell
    // was closed by fixing THIS PRODUCT'S WORDING rather than by a setting. Five surfaces cleared
    // at the compiled defaults untouched. Plan timed out on every run with an empty ledger until
    // `suppressPlanReasoning`, which finished the turns and moved it 0/5 to 1/5; the four losses
    // left were a correct refusal opened `NO STATEMENT AT ALL:`, which is the phrase the planning
    // rule itself put in front of the marker it was teaching. One setting, because the rest was
    // ours.
    id: "qwen3.5:4b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    suppressesPlanReasoning: true,
    // The compiled limit, stated as undefined like every model that was never measured needing
    // its own: this one's plan turns stopped timing out because the thinking stopped, not because
    // they were given longer.
    turnTimeoutMs: undefined,
  },
  {
    // The fourteenth, and the widest set any model carries: three settings for three DIFFERENT
    // failures, each measured on the cell it was added for.
    id: "muse-glimmer:latest",
    unreportedCallCeiling: 12,
    reportReminderLimit: 2,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    suppressesPlanReasoning: true,
    turnTimeoutMs: 150_000,
  },
  {
    id: "nemotron3:33b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    // The one value this model does not share with the defaults, and the reason it has an entry.
    retriesUnreadStop: true,
    refusalExamples: true,
    turnTimeoutMs: undefined,
  },
  {
    id: "qwen3:8b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
    samplingOverrides: { "query-optimization": { temperature: 0.8, topP: 0.9 } },
  },
  // The nineteenth, and Mistral's first entry: the roster before it came from six vendors and
  // none of them was Mistral. All four rows this branch adds are identical because all four
  // locked every surface on the FIRST attempt with no lever spent. Pinning a row of defaults is
  // not redundant — it asserts that a later change to the defaults cannot silently move a model
  // that was measured under the old ones.
  {
    id: "ministral-3:8b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The twentieth. Measured because its 8b sibling had just locked everything, on the one
  // rule with evidence behind it — the larger member of a family that has already won —
  // and it is the only prediction this work has made that then held.
  {
    id: "ministral-3:14b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The twenty-first, and the fastest six-surface sweep on record here: all thirty runs in
  // ten minutes. Its 8b sibling reads 0/5 on investigation and its 32b loses planning, so
  // this is the one size of the family that is supported.
  {
    id: "cogito:14b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The twenty-second, and the oldest model generation on the roster. Three newer Qwen
  // entries each needed a setting written for them; this one arrived on the defaults,
  // which is the counter-example to choosing by generation.
  {
    id: "qwen2.5:14b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The five measured after the run-loop fixes, and the only five rows here that state
  // `planStatementRetries: 1` without a plan cell that lost. They were driven with no entry of
  // their own, so the drive answered its own 1 and every plan run of the thirty had the ask
  // available; three of them spent it. The number records what they ran under. Writing the 0
  // their sweeps call "the default" would remove the ask from a model that passed with it.
  {
    // Twenty-five weeks recorded as unsupported for one cell, and the cell was the server's:
    // planning read 0/5 across five configurations because the notice for `no-statement` was
    // offered only to a model whose profile asked for it, and this one had no profile.
    id: "cogito:32b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 1,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    // The only code-specialised model here. The class was excluded by reasoning about what the
    // surfaces ask for, and this row is the measurement that falsified it.
    id: "qwen2.5-coder:14b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 1,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    // Held at 29/30 for days on the same plan cell and the same loss as `cogito:32b`, and opened
    // by the same change.
    id: "qwen2.5:32b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 1,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    // The fastest model in the table: a six-second median and a 21-second slowest run of thirty.
    // Its optimize cell was the one that would not close while `recommend_change` refused calls
    // without stating what shape one takes.
    id: "qwen2.5:7b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 1,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    // The only one of the five that is not a defaults model, and the slowest supported model here.
    // Both suppressions, because the plan-turn switch alone left its plan cell at 0/5 and the pair
    // closed it — and the four surfaces that had already cleared at the defaults were measured
    // again under the pair rather than inheriting settings no run of theirs had used.
    id: "ornith:35b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 1,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    suppressesPlanReasoning: true,
    suppressesAgentReasoning: true,
    turnTimeoutMs: undefined,
  },
  // Not a model anybody has run: the defaults, which is the honest treatment of one nobody
  // has measured.
  {
    id: "some-model-released-tomorrow:70b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The same weights under a different casing, and it must resolve to the same settings —
  // including the one sampled surface, which is what makes this row worth having.
  {
    id: "QWEN3:8B",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
    samplingOverrides: { "query-optimization": { temperature: 0.8, topP: 0.9 } },
  },
  // Today's behaviour, not the wanted one: the tag is dropped, so this finds no profile.
  {
    id: "qwen3.8",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  /*
    The five this branch adds, and five vendors rather than one: Mistral's reasoning model, two
    from Alibaba, OpenAI's first entry on this roster and Zhipu's first. Four of the five resolve
    to the compiled defaults with `retryUnreadStop` stated; only `glm-4.7-flash` asks for more than
    that, and each of its three settings answers a cell that could not close without it.
  */
  {
    id: "magistral:24b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 2,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    retriesUnreadStop: true,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    id: "qwq:32b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    retriesUnreadStop: true,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    id: "qwen3-coder:30b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    retriesUnreadStop: true,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    id: "gpt-oss:20b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    retriesUnreadStop: true,
    refusalExamples: false,
    suppressesAgentReasoning: true,
    turnTimeoutMs: undefined,
    samplingOverrides: { "query-optimization": { temperature: 0.8, topP: 0.9 } },
  },
  {
    id: "glm-4.7-flash:latest",
    unreportedCallCeiling: 12,
    reportReminderLimit: 2,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    retriesUnreadStop: true,
    refusalExamples: false,
    suppressesPlanReasoning: true,
    turnTimeoutMs: 150_000,
  },
  // The 3b end of granite4.1, whose 8b and 30b already resolve above. On the defaults,
  // like both siblings, so the family needs no per-size setting at any of its three sizes.
  {
    id: "granite4.1:3b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The first phi4-mini on the roster, and the fastest sweep here after granite4.1:3b.
  // On the defaults.
  {
    id: "phi4-mini:3.8b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The 3b end of ministral-3, whose 8b and 14b already resolve above. On the defaults.
  {
    id: "ministral-3:3b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The first qwen3 above 14b. Four Qwen entries needed a setting written for them and
  // this one did not, which is the same counter-example qwen2.5:14b makes about generation.
  {
    id: "qwen3:30b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The 3b end of granite4.2, whose 8b already resolves above. On the defaults, though it
  // took the most attempts of the five before it closed - attempts are not settings.
  {
    id: "granite4.2:3b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The two sizes of ornith-1.5 part company here, and the smaller one is the interesting half.
  // 35b closes six surfaces on the defaults; 9b needs the plan switch for TWO cells, and the
  // measurement that proves it is the one that nearly went in wrong. A first lever document
  // changed `retryUnreadStop` as well and read 5/5, so a single-variable re-run of the same cell
  // was taken: it read 1/5, which is how the credit moved to the setting that earned it.
  {
    id: "ornith-1.5:35b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  {
    id: "ornith-1.5:9b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    suppressesPlanReasoning: true,
    turnTimeoutMs: undefined,
  },
  // `qwen3:32b` on the defaults, beside a sibling that is not: its optimize cell read 4/5 and then
  // 1/5 while two measurement runners raced on one machine, and 5/5 with one. The low readings
  // measured the rig, so no setting is pinned for them.
  {
    id: "qwen3:32b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
  },
  // The plan switch WITHOUT the ceiling, and that pairing is the measurement. Raising
  // `turnTimeoutMs` to the shipped maximum took this cell from 4/5 to 1/5 and moved the losses
  // from 94s to a cluster at 157s: a passing plan run emits in 59-72s whatever the ceiling is, so
  // the turn was being spent, not cut short.
  {
    id: "qwen3.5:35b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    suppressesPlanReasoning: true,
    turnTimeoutMs: undefined,
  },
  // The forty-fifth, and the first row this table has carried with a per-model reminder bound on
  // it. Its optimize cell closed on `compareHoldLimit`, which did not exist until this model was
  // measured against it: the compare-before-report hold was a literal `1` in the loop, so a run
  // holding two plans heard "compare them" once and was never asked again. At one the cell held
  // 4/5 across five rolls; at five it read 5/5.
  {
    id: "laguna-xs-2.1:latest",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: true,
    verdictHoldLimit: 5,
    compareHoldLimit: 5,
    turnTimeoutMs: undefined,
    // Global rather than per-surface: the five locked cells were measured under it too.
    sampling: { temperature: 0.3, topP: 1 },
  },
  // The forty-sixth, and the second row to state its own sampling: every one of its six cells
  // closed at temperature 0.3 on the first attempt, with nothing else moved. It came off the
  // library listing with four other untried names; two of those answered `does not support chat`
  // and this is the one that cleared both the probe and the board.
  {
    id: "qwen3.8:27b",
    unreportedCallCeiling: 12,
    reportReminderLimit: 1,
    planStatementRetries: 0,
    presentReminderLimit: 1,
    retriesEmptyTurn: false,
    refusalExamples: false,
    turnTimeoutMs: undefined,
    sampling: { temperature: 0.3, topP: 1 },
  },
];

describe("every resolver's answer, pinned before the profiles moved", () => {
  test.each(RESOLVED)("$id resolves to the settings it was measured under", (row) => {
    expect(ceilingFor(row.id)).toBe(row.unreportedCallCeiling);
    expect(reportReminderLimitFor(row.id)).toBe(row.reportReminderLimit);
    expect(planStatementRetriesFor(row.id)).toBe(row.planStatementRetries);
    expect(presentReminderLimitFor(row.id)).toBe(row.presentReminderLimit);
    expect(retriesEmptyTurn(row.id)).toBe(row.retriesEmptyTurn);
    expect(retriesUnreadStop(row.id)).toBe(row.retriesUnreadStop ?? false);
    expect(suppressesPlanReasoning(row.id)).toBe(row.suppressesPlanReasoning ?? false);
    expect(suppressesAgentReasoning(row.id)).toBe(row.suppressesAgentReasoning ?? false);
    expect(offersRefusalExamples(row.id)).toBe(row.refusalExamples);
    expect(verdictHoldLimitFor(row.id)).toBe(row.verdictHoldLimit ?? 2);
    expect(compareHoldLimitFor(row.id)).toBe(row.compareHoldLimit ?? 1);
    expect(turnTimeoutMsFor(row.id)).toBe(row.turnTimeoutMs);
  });

  test.each(RESOLVED)("$id samples every surface as measured", (row) => {
    // A row may state the model's OWN sampling, which every surface inherits unless that surface is
    // named. Absent means `PINNED`, which is what every row meant before one of them differed.
    const own = row.sampling ?? PINNED;
    for (const workflow of WORKFLOWS) {
      expect(samplingFor(row.id, workflow)).toEqual(row.samplingOverrides?.[workflow] ?? own);
    }
    // A run with no surface yet — the classifier has not answered — takes the model's own
    // sampling and never a surface's.
    expect(samplingFor(row.id, undefined)).toEqual(own);
  });

  test("the table covers every registered model, so a new one cannot arrive unpinned", () => {
    const pinned = new Set(RESOLVED.map((row) => row.id));
    for (const id of Object.keys(modelProfiles())) expect(pinned.has(id)).toBe(true);
    // The literal stays literal HERE, and not for want of trying to derive it: `RESOLVED` is three
    // rows longer than the roster on purpose - a case variant, a tag-less name and a model released
    // tomorrow, which pin the resolver's fallbacks rather than a shipped profile. Deriving from it
    // would assert 43 against 40 and deriving from the profiles would assert nothing at all. The
    // loop above is what guarantees coverage; this is the second half, that the roster is the size
    // the change intended. `model-roster-docs.test.ts` derives the same count for the docs.
    expect(Object.keys(modelProfiles())).toHaveLength(46);
  });
});

describe("the sentences every run is told", () => {
  /*
    Not per model, and that is the whole finding of this block.

    Every measured model resolves to the same three sentences: the per-model copies that once
    lived in the ten modules are gone, wording is the one thing the document may not carry, and
    `models/notices.ts` is now the only source. So a table row-by-row would assert the same three
    constants ten times over — nothing is lost by asserting them once.

    Digests rather than the paragraphs, because this is an identity check: a test holding three
    copies of the prose would have to be edited whenever the prose is, which would make it agree
    with any change instead of catching one. Editing a sentence in `notices.ts` changes what all
    ten measured models are told, and this is the test that says so out loud.
  */
  const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

  test("are the baseline wording, byte for byte", () => {
    expect(digest(BASELINE_NOTICES.reportReminder)).toBe("3f81f86d6e78daf2");
    expect(digest(BASELINE_NOTICES.planStatement)).toBe("ab274977ed206fb4");
    expect(digest(BASELINE_NOTICES.presentBeforeReport)).toBe("739fb327bf394f6c");
  });
});

describe("what each model records about the runs that earned its settings", () => {
  /*
    `measured` is not a resolver's output, so nothing else here would notice it changing. Five
    of the ten share a digest, and that is not a copy-paste: they scored identically — 6/6
    locked, 30/30 — so the sentence that states it is the same sentence.

    Two digests were edited by hand rather than regenerated, which is what this table is for.
    `granite4.1:8b` and `ornith:9b` recorded pre-override numbers under the words "at these
    settings", so the field whose job is to justify a setting was arguing against it: the 24/30
    and 25/30 are what the DEFAULTS produced, which is why the settings exist, and both models
    lock 6/6 at 30/30 with them.
  */
  const MEASURED_DIGESTS: Readonly<Record<string, string>> = {
    "cogito:14b": "2c2fcded189b2123048e5c789844d3d8e392d7e19951e428695afa852eddd473",
    "cogito:32b": "5564b00061b8615b9d25778ac1d69924e43c24e85dbe7d33c2ea98c99a1c1306",
    "gemini-3.5-flash-lite": "57453d009646b45dcee4bd74c46fcad9fa03ce69790e302fc948f1a60809015a",
    "gemma4:12b": "9a49a9323c21ffe507698ca2ca852cc1b59647a206e73c448afeea7f1a0a674b",
    "gemma4:26b": "d8124e9d5b0929364129274fd4f80dea2640773147fdfd834cf2c68a5a08dd76",
    "gemma4:31b": "430cdba51e7b09167b2fa59971fa033830595458d54c1272f6424341923fda54",
    "granite4.1:30b": "57453d009646b45dcee4bd74c46fcad9fa03ce69790e302fc948f1a60809015a",
    "granite4.1:8b": "a3eea21447a81fbe058e3c18a0f7194c357e5d5f22db9acfe13e6139d9198874",
    "granite4.2:8b": "c9e47190c44d1fda45bf035831dcb17ba21621e98a455259a438710775600ae0",
    "ministral-3:14b": "23ef778193d6d714d7f3bb95523172d1e0f68520f0f9b2d20806b129a84a33c1",
    "ministral-3:8b": "282d7f01c554b5bed006533190e2392330256b67f46ffee8a1462d5b254424ab",
    "muse-glimmer:latest": "32bf1643caa8ed550066a64c4a231585a3ddbd30286646bef45f5531198d06cb",
    "nemotron-3-nano:30b": "20cca3398ec9a7ff927f014a212784f38d6b36e74be49fe2b74fb223a7d56eec",
    "nemotron-3.5-lightning:30b": "9a581f6838f604eaa3bf9fb0e2636635bd878f50d03b135205eac3e2ab7b0678",
    "nemotron3:33b": "c1693800c32d336e610590e909300df682479247a910a291c9913ba278f26a8d",
    "ornith:35b": "7ed7fad29552be880f2eefaaad3aa5258898820a1b617059da9f8055f1ce1d8b",
    "ornith:9b": "4e14e79cb5fd6572748df90786778ce72280c2bae79a27b5f8636d4eac1dbee7",
    "qwen2.5-coder:14b": "d0e6f9ae86ee128fe709c66efcf75d89d8fa7ecaea9cf96692d23f9c514da231",
    "qwen2.5:14b": "51ea773ff735a6f9d7f7f930b97c40ec70b5dc531dea65fa1594935a2471e991",
    "qwen2.5:32b": "71885a95b0d717ca4f6814cfa4575bfa5f3cc20b7086c4de44f79835be3bcb1a",
    "qwen2.5:7b": "09631668500b307a79ca06e1a7de2dfdffc1632f4bd5bb4a460abab6caf09857",
    "qwen3.5:4b": "204b6f6beb8710155508938a2271cbf34013235fa612b40ecebf98ff5dcff061",
    "qwen3.5:27b": "d83ddd506de32534c2b705b05ec2d44bef6ec19199094e86ec77ffbd2b38f59b",
    "qwen3.5:9b": "57453d009646b45dcee4bd74c46fcad9fa03ce69790e302fc948f1a60809015a",
    "qwen3.6:27b": "d0ebde3fdf25b9c56ab7bcad4adc3b54510a413285e51edcb46aec261e661157",
    "qwen3.6:35b": "3b35d7070adca4f15fcc95bd522fd0ca0d5d77e5d4306be8f400da09c6899e25",
    "qwen3.8:latest": "57453d009646b45dcee4bd74c46fcad9fa03ce69790e302fc948f1a60809015a",
    "qwen3:14b": "96e0d729224168eff3eddc16ed1bd588dd28cd133441c85790670ffd3e36dddd",
    "qwen3:4b": "57453d009646b45dcee4bd74c46fcad9fa03ce69790e302fc948f1a60809015a",
    "qwen3:8b": "3dd169b2c0718d77a0db8732d575bb4c863d78ed8343020c103c0f38e9cf016b",
    "magistral:24b": "b76df1e6d916d87e50b2b70169ca95c2774e037143b68251aeab6a3b94e62ded",
    "qwq:32b": "3f85581b7a6ed2d052e4066258021a99e776a00c4eed98a95e4d1cbce948d8cf",
    "qwen3-coder:30b": "bcf4ade23a0dab26370f0da178af8630025620510a4d239d237407f404bfe655",
    "gpt-oss:20b": "289cbda6c810233c189f2cfb7984bc61a86b29009d4edf6c99eeb547194d3034",
    "glm-4.7-flash:latest": "36f84723b7d527a9276900bb97c84653fbe5d1862ecc49efdbd5dd3d5f8b95bb",
    "granite4.1:3b": "e2e79d196bee1ded7cfde8843a6c4bec0827d6008f2f4a5f72e88e8052a249b4",
    "phi4-mini:3.8b": "7ad1bb63606df67d3e3973afd885bef62156eb3f47ebc7c40bb8285901149f9b",
    "ministral-3:3b": "5522600e4e25e5c2eefa34fd215e2ddf9b936ea609119c99cad5cdd5e423a7ac",
    "qwen3:30b": "c322fa51bfdf5dc84e82d10cdee7748154da0960fa8b0ef629f55ee077e4d3ec",
    "granite4.2:3b": "27db8b46210ea045ee05c56b99fe237a46b961faaccd5180bbd1269a2a93f3c8",
    "ornith-1.5:35b": "4ba1ad8f40aab26751bc9d8a65586f7ecbcfa06b70f3486d7f3627051b7c5a78",
    "ornith-1.5:9b": "98cd715892ea02c6625bee605d2f90eb4e3d63fbc6db69e9c8cb760642d2096b",
    "qwen3.5:35b": "b32ca3f5bcb21ab7c084a53144438c95e277535735ee43c5840b5941a4b1a5c7",
    "qwen3:32b": "95abe040e1654ecf1462bd73d48079a6fb152723551bbc8001899facd16d70c0",
    "laguna-xs-2.1:latest": "2fc40492ef6cb14b7eeb4eee05a95eef31feab539e693634adea21b22765b7c7",
    "qwen3.8:27b": "5948f3803fc6daf3d9ae0255f14e09a35099a6149a20611d885ff3365d1f834e",
  };

  test("every model's record survives the move, character for character", () => {
    for (const [id, profile] of Object.entries(modelProfiles())) {
      expect(createHash("sha256").update(profile.measured).digest("hex")).toBe(MEASURED_DIGESTS[id]);
    }
    expect(Object.keys(MEASURED_DIGESTS).sort()).toEqual(Object.keys(modelProfiles()).sort());
  });
});
