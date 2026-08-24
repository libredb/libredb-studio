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
  samplingFor,
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
  readonly refusalExamples: boolean;
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
    expect(offersRefusalExamples(row.id)).toBe(row.refusalExamples);
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
    expect(Object.keys(modelProfiles())).toHaveLength(10);
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
  };

  test("every model's record survives the move, character for character", () => {
    for (const [id, profile] of Object.entries(modelProfiles())) {
      expect(createHash("sha256").update(profile.measured).digest("hex")).toBe(MEASURED_DIGESTS[id]);
    }
    expect(Object.keys(MEASURED_DIGESTS).sort()).toEqual(Object.keys(modelProfiles()).sort());
  });
});
