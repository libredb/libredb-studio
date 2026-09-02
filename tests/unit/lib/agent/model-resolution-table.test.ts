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
  readonly turnTimeoutMs: number | undefined;
  /** Only the surfaces that differ from `PINNED`; every other surface resolves to it. */
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
    expect(turnTimeoutMsFor(row.id)).toBe(row.turnTimeoutMs);
  });

  test.each(RESOLVED)("$id samples every surface as measured", (row) => {
    for (const workflow of WORKFLOWS) {
      expect(samplingFor(row.id, workflow)).toEqual(row.samplingOverrides?.[workflow] ?? PINNED);
    }
    // A run with no surface yet — the classifier has not answered — takes the model's own
    // sampling and never a surface's.
    expect(samplingFor(row.id, undefined)).toEqual(PINNED);
  });

  test("the table covers every registered model, so a new one cannot arrive unpinned", () => {
    const pinned = new Set(RESOLVED.map((row) => row.id));
    for (const id of Object.keys(modelProfiles())) expect(pinned.has(id)).toBe(true);
    expect(Object.keys(modelProfiles())).toHaveLength(22);
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
    "gemini-3.5-flash-lite": "57453d009646b45dcee4bd74c46fcad9fa03ce69790e302fc948f1a60809015a",
    "gemma4:26b": "d8124e9d5b0929364129274fd4f80dea2640773147fdfd834cf2c68a5a08dd76",
    "granite4.1:30b": "57453d009646b45dcee4bd74c46fcad9fa03ce69790e302fc948f1a60809015a",
    "granite4.1:8b": "a3eea21447a81fbe058e3c18a0f7194c357e5d5f22db9acfe13e6139d9198874",
    "ornith:9b": "4e14e79cb5fd6572748df90786778ce72280c2bae79a27b5f8636d4eac1dbee7",
    "qwen3.5:9b": "57453d009646b45dcee4bd74c46fcad9fa03ce69790e302fc948f1a60809015a",
    "qwen3.8:latest": "57453d009646b45dcee4bd74c46fcad9fa03ce69790e302fc948f1a60809015a",
    "qwen3:14b": "b1a344db5ee6b5f78780925657fee571eae510a7b8507bcb8badabaf01718aa3",
    "qwen3:4b": "57453d009646b45dcee4bd74c46fcad9fa03ce69790e302fc948f1a60809015a",
    "qwen3:8b": "3dd169b2c0718d77a0db8732d575bb4c863d78ed8343020c103c0f38e9cf016b",
    // The eleventh model, whose record is new rather than moved; see its entry for the runs.
    "nemotron3:33b": "c1693800c32d336e610590e909300df682479247a910a291c9913ba278f26a8d",
    // The thirteenth. Its record is the only one that states a COST as well as a result: the plan
    // turn's median doubled when the limit rose, and that sentence is load-bearing.
    "nemotron-3.5-lightning:30b": "9a581f6838f604eaa3bf9fb0e2636635bd878f50d03b135205eac3e2ab7b0678",
    // The fourteenth. Its record says its cells were read in ONE pass under the settings it
    // ships with, which is the claim three settings on one model has to earn.
    "muse-glimmer:latest": "32bf1643caa8ed550066a64c4a231585a3ddbd30286646bef45f5531198d06cb",
    // The fifteenth. Its record states the outlier as well as the result: assess read 4/5 once
    // and 5/5 on a second read of the same cell at the same setting.
    "qwen3.6:27b": "d0ebde3fdf25b9c56ab7bcad4adc3b54510a413285e51edcb46aec261e661157",
    // The fourth closed here, and the one the new switch was written for. Its record states the
    // refuted hypothesis too: the tool count does not separate its passing runs from its loss.
    "gemma4:12b": "9a49a9323c21ffe507698ca2ca852cc1b59647a206e73c448afeea7f1a0a674b",
    "nemotron-3-nano:30b": "20cca3398ec9a7ff927f014a212784f38d6b36e74be49fe2b74fb223a7d56eec",
    "qwen3.5:4b": "204b6f6beb8710155508938a2271cbf34013235fa612b40ecebf98ff5dcff061",
    "granite4.2:8b": "c9e47190c44d1fda45bf035831dcb17ba21621e98a455259a438710775600ae0",
    // The four this branch adds, and the only group whose records are identical in shape: every
    // one locked all six surfaces on its FIRST attempt with no lever spent, so every one states
    // the compiled defaults and nothing else. That is a measurement rather than an omission —
    // and it is how every 30/30 model on this roster arrived, which is why the four are here
    // and the models that absorbed a hundred lever attempts between them are not.
    "ministral-3:8b": "282d7f01c554b5bed006533190e2392330256b67f46ffee8a1462d5b254424ab",
    "ministral-3:14b": "23ef778193d6d714d7f3bb95523172d1e0f68520f0f9b2d20806b129a84a33c1",
    "cogito:14b": "2c2fcded189b2123048e5c789844d3d8e392d7e19951e428695afa852eddd473",
    "qwen2.5:14b": "51ea773ff735a6f9d7f7f930b97c40ec70b5dc531dea65fa1594935a2471e991",
  };

  test("every model's record survives the move, character for character", () => {
    for (const [id, profile] of Object.entries(modelProfiles())) {
      expect(createHash("sha256").update(profile.measured).digest("hex")).toBe(MEASURED_DIGESTS[id]);
    }
    expect(Object.keys(MEASURED_DIGESTS).sort()).toEqual(Object.keys(modelProfiles()).sort());
  });
});
