/**
 * The contract `measured-profiles.json` is held to, and the only place that reads one.
 *
 * The document is data, and data that arrives unchecked is worse than code. TypeScript will not
 * help here: an imported JSON object assigned to a typed constant gets no excess-property check,
 * so a misspelled `retryEmtpyTurn` would compile clean and silently do nothing — where today the
 * same typo is a compile error. `strictObject` buys that back, and it runs on the BUNDLED
 * document rather than only on some future external one, because the bundled one is the one
 * every install runs.
 *
 * Three rules are worth naming, because each enforces something no mechanism enforces today:
 *
 * 1. COMPLETENESS. Every setting that has a compiled default must be stated on every model
 *    entry. The modules this replaces wrote `sampling: DEFAULT_SAMPLING` — a LIVE reference — so
 *    each file's own promise, that moving a default could not reach its measurement, was false.
 *    A literal number keeps the promise, and resolves identically.
 *
 * 2. JUSTIFICATION, ENFORCED BY A TEST AND NOT BY THE LOADER. A setting that differs from the
 *    defaults the document RECORDS must carry a non-empty `rationale` under that setting's own
 *    name — but a document that breaks that rule still loads. `undocumentedOverrides` below is
 *    exported for the test that fails on it, deliberately rather than thrown from `parseTuning`:
 *    an empty paragraph is a documentation fault, and this repository already decided what to do
 *    with a bad value on the runtime path. `agentModelTurnTimeoutMs` in `../config.ts` says it
 *    outright — "a mistyped variable must not end every turn instantly" — and taking the agent
 *    down because prose is missing is the same mistake with a worse blast radius once the
 *    document can arrive from somewhere else.
 *
 *    Compared against the document's recorded defaults and never against the compiled ones. The
 *    other way round, moving a compiled default would turn ten honest entries into
 *    "undocumented overrides" at once. That the recorded and compiled defaults still agree is
 *    its own assertion, in its own test, where the failure is a question for a person.
 *
 * 3. ALL OR NOTHING. A document that fails anywhere is refused entirely. Partial acceptance
 *    would leave a run driven by a configuration that is half one source and half another, which
 *    is a combination nobody has ever measured.
 */
import { z } from "zod";
import type { AgentRunWorkflowType } from "../types";
import type { AgentModelProfile, AgentSampling } from "../models/profile";

/** Bumped only when the shape changes; an older Studio refuses a newer document rather than guess. */
export const TUNING_SCHEMA_VERSION = 1;

const WORKFLOWS = [
  "investigation",
  "query-optimization",
  "database-assessment",
  "operations",
  "data-analysis",
] as const satisfies readonly AgentRunWorkflowType[];

const samplingSchema = z.strictObject({
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
});

/*
  No wording here, and that is a decision rather than an omission.

  The three sentences the drive says to a run stay in `../models/notices.ts`, in TypeScript. Two
  reasons, and the second is the load-bearing one. `BASELINE_NOTICES.planStatement` interpolates
  `PLAN_NO_STATEMENT_MARKER`, so a literal copy in data would silently drift from the marker the
  verifier actually looks for. And this document is shaped to be supplied from outside Studio one
  day: `notices` is prompt text pushed verbatim into the model's messages, so a document that
  could carry it would let whoever writes it change what Studio says mid-run. Numbers and
  switches travel; wording does not.
*/

/**
 * Bounds, not preferences.
 *
 * Every number a document may carry is bounded, because the difference between "an operator
 * configures this" and "a remote file steers this loop" is whether the values are checked. The
 * turn limit stops below half the shortest run deadline (`operations`, 360 000 ms): a per-model
 * limit bypasses the clamp the environment variable gets, and a turn longer than the run is a
 * setting that cannot do anything but waste the run.
 */
const countSchema = z.int().min(0).max(5);

const settingsShape = {
  sampling: samplingSchema,
  unreportedCallCeiling: z.int().min(1).max(100),
  reportReminderLimit: countSchema,
  planStatementRetries: countSchema,
  presentReminderLimit: countSchema,
  retryEmptyTurn: z.boolean(),
  refusalExamples: z.boolean(),
  /** Absent means the product's own limit, which the environment can still move. */
  turnTimeoutMs: z.int().min(1_000).max(179_999).optional(),
  /** One surface at a time; `partialRecord` because naming one must not require naming five. */
  perWorkflow: z.partialRecord(z.enum(WORKFLOWS), samplingSchema).optional(),
} as const;

const modelSettingsSchema = z.strictObject(settingsShape);

const rationaleSchema = z.partialRecord(
  z.enum(Object.keys(settingsShape) as [string, ...string[]]),
  z.array(z.string().min(1)).min(1),
);

const entryShape = {
  /** Prose that argues for a setting, under that setting's own name. */
  rationale: rationaleSchema.default({}),
} as const;

const modelSchema = z.strictObject({
  id: z.string().min(1),
  /** The runs that earned these settings, in the words of whoever measured them. */
  measured: z.string().min(1),
  /** The file header this entry replaces: what the model is like, beyond any one setting. */
  summary: z.array(z.string().min(1)),
  settings: modelSettingsSchema,
  ...entryShape,
});

const documentSchema = z.strictObject({
  schemaVersion: z.literal(TUNING_SCHEMA_VERSION),
  measuredAgainst: z.strictObject({
    turnTimeoutMs: z.int().positive(),
    protocol: z.string().min(1),
    defaults: z.strictObject({
      sampling: samplingSchema,
      unreportedCallCeiling: z.int().positive(),
      reportReminderLimit: countSchema,
      planStatementRetries: countSchema,
      presentReminderLimit: countSchema,
      retryEmptyTurn: z.boolean(),
      refusalExamples: z.boolean(),
    }),
  }),
  models: z.array(modelSchema),
});

type TuningDocument = z.infer<typeof documentSchema>;

/** Raised for every rejection, so a caller can tell a bad document from a bug in reading it. */
export class ModelTuningError extends Error {
  constructor(origin: string, detail: string) {
    super(`model tuning document (${origin}) rejected: ${detail}`);
    this.name = "ModelTuningError";
  }
}

export interface ModelTuning {
  /** Every model, keyed by LOWER-CASED id: the same weights answer to more than one spelling. */
  readonly models: Readonly<Record<string, AgentModelProfile>>;
  /** The defaults the document was written against, for the test that keeps them honest. */
  readonly measuredAgainst: TuningDocument["measuredAgainst"];
  /**
   * `"<model id>: <setting>"` for every value that differs from the recorded defaults and argues
   * for itself nowhere. Empty for the document this repository ships, and a test says so.
   *
   * Reported rather than refused: the settings still resolve, because a missing paragraph is a
   * fault in the writing and not in the measurement, and a run is not the place to find out.
   */
  readonly undocumentedOverrides: readonly string[];
}

/** Every setting a model may state, so the justification rule can walk them by name. */
const SETTING_NAMES = Object.keys(settingsShape) as (keyof typeof settingsShape)[];

function differsFromDefaults(
  settings: z.infer<typeof modelSettingsSchema>,
  defaults: TuningDocument["measuredAgainst"]["defaults"],
): string[] {
  const changed: string[] = [];
  for (const name of SETTING_NAMES) {
    // These two have no default: stating either at all is a decision, so both always argue.
    if (name === "turnTimeoutMs" || name === "perWorkflow") {
      if (settings[name] !== undefined) changed.push(name);
      continue;
    }
    if (name === "sampling") {
      const { temperature, topP } = settings.sampling;
      if (temperature !== defaults.sampling.temperature || topP !== defaults.sampling.topP) changed.push(name);
      continue;
    }
    if (settings[name] !== defaults[name]) changed.push(name);
  }
  return changed;
}

/**
 * Reads a document, or throws.
 *
 * Pure: no filesystem, no environment, no caching. That is what lets the failures be tested
 * directly with bad literals rather than by shipping a corrupt file, and it is the seam a later
 * externally-supplied document arrives through — `origin` is already the label such an error
 * would need to name its source.
 */
export function parseTuning(document: unknown, origin: string): ModelTuning {
  const parsed = documentSchema.safeParse(document);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? "unknown" : first.path.join(".");
    throw new ModelTuningError(origin, `${where}: ${first?.message ?? "invalid"}`);
  }
  const doc = parsed.data;

  const models: Record<string, AgentModelProfile> = {};
  /** Collected rather than thrown on; see rule 2 in this file's header. */
  const unjustified: string[] = [];
  for (const entry of doc.models) {
    const key = entry.id.toLowerCase();
    // Rejected rather than last-wins: two spellings of one id is a document nobody can read,
    // and silently collapsing them would apply settings the other entry argues against.
    if (models[key] !== undefined) throw new ModelTuningError(origin, `models: ${entry.id} appears twice`);

    models[key] = {
      measured: entry.measured,
      sampling: entry.settings.sampling as AgentSampling,
      unreportedCallCeiling: entry.settings.unreportedCallCeiling,
      reportReminderLimit: entry.settings.reportReminderLimit,
      planStatementRetries: entry.settings.planStatementRetries,
      presentReminderLimit: entry.settings.presentReminderLimit,
      retryEmptyTurn: entry.settings.retryEmptyTurn,
      refusalExamples: entry.settings.refusalExamples,
      ...(entry.settings.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: entry.settings.turnTimeoutMs }),
      ...(entry.settings.perWorkflow === undefined ? {} : { perWorkflow: entry.settings.perWorkflow }),
    };
    unjustified.push(
      ...differsFromDefaults(entry.settings, doc.measuredAgainst.defaults)
        .filter((name) => entry.rationale[name] === undefined)
        .map((name) => `${entry.id}: ${name}`),
    );
  }

  return { models, measuredAgainst: doc.measuredAgainst, undocumentedOverrides: unjustified };
}
