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
  retryUnreadStop: z.boolean(),
  suppressPlanReasoning: z.boolean(),
  refusalExamples: z.boolean(),
  /** Absent means the product's own limit, which the environment can still move. */
  turnTimeoutMs: z.int().min(1_000).max(179_999).optional(),
  /**
   * Absent means the product's own conversation budget.
   *
   * It lives here rather than in an environment variable because the value that is
   * right depends on the MODEL's context window: what a hosted 200k-window model can
   * carry is not what a small local one can, and this product runs both. NOTHING
   * measured ships for it — no entry in `measured-profiles.json` names it, because
   * nobody has measured one — so the compiled default drives every model until an
   * operator measures their own, which is exactly what this document is for.
   *
   * Bounded on both sides: below 200 the spine could not name one step, and above
   * 32 000 the header this is persisted on stops being a header.
   */
  threadContextMaxChars: z.int().min(200).max(32_000).optional(),
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
  settings: modelSettingsSchema,
  ...entryShape,
});

const measuredAgainstSchema = z.strictObject({
  turnTimeoutMs: z.int().positive(),
  protocol: z.string().min(1),
  defaults: z.strictObject({
    sampling: samplingSchema,
    unreportedCallCeiling: z.int().positive(),
    reportReminderLimit: countSchema,
    planStatementRetries: countSchema,
    presentReminderLimit: countSchema,
    retryEmptyTurn: z.boolean(),
    retryUnreadStop: z.boolean(),
    suppressPlanReasoning: z.boolean(),
    refusalExamples: z.boolean(),
  }),
});

const documentSchema = z.strictObject({
  schemaVersion: z.literal(TUNING_SCHEMA_VERSION),
  measuredAgainst: measuredAgainstSchema,
  models: z.array(modelSchema),
});

/*
  The same document, held to what a document from OUTSIDE Studio can reasonably promise.

  Two relaxations, and both answer the same question: what happens to a mounted document when
  Studio changes? Completeness and `strictObject` together mean that adding an eighth setting
  refuses every document in the field WHOLE, so every model in it reverts to the defaults on an
  upgrade that changed nothing about their measurements. "A model can be added without a Studio
  release" and "Studio can gain a setting without breaking documents in the field" are the same
  requirement from either end, and the strict schema only satisfies the first.

  So: `settings` states what was measured and nothing more, and an unknown key is COLLECTED rather
  than fatal. Collected, not swallowed — a misspelled `retryEmtpyTurn` doing nothing quietly is the
  exact failure the strict schema exists to prevent, so it is reported through `ignoredKeys` and out
  to `GET /api/agent/config`. What does not relax: every bound, `measured`, the id-uniqueness rule,
  and the refusal of wording. A tolerant schema is not an unchecked one.

  `looseObject` at the entry and settings level only. The document level stays strict because its
  three keys are the shape itself rather than a list that grows.
*/
const operatorSettingsSchema = z.looseObject(settingsShape).partial();

const operatorModelSchema = z.looseObject({
  id: z.string().min(1),
  measured: z.string().min(1),
  settings: operatorSettingsSchema,
  /*
    Named so that a LOOSE schema still refuses it.

    `strictObject` refused wording as a side effect of refusing everything it did not declare.
    Tolerating unknown keys takes that away, and wording is the one key that must not become a
    tolerated unknown: it is prompt text pushed verbatim into a model's messages, so a document
    that could carry it would let whoever wrote it decide what Studio says mid-run. Declaring it
    as never keeps the refusal explicit rather than incidental.
  */
  notices: z.never().optional(),
  /*
    Keyed by STRING rather than by the settings this Studio knows, and that is the difference
    between a tolerance and a tolerance that defeats itself.

    A document written for a newer Studio carries a new setting AND the paragraph arguing for it —
    that pairing is the discipline, not an accident. With enum keys the loose settings schema
    accepts the setting and the rationale beside it then refuses the whole document, so the exact
    shape this schema exists to survive would be the one shape it rejects.
  */
  rationale: z.partialRecord(z.string(), z.array(z.string().min(1)).min(1)).default({}),
});

/*
  The recorded basis, held as loosely as the settings it describes.

  Leaving this strict would have defeated the relaxation above from one block up: a document written
  against a NEWER Studio records THAT Studio's defaults, so it carries a key this one has never
  heard of and every model in it would go back to the defaults for a reason that has nothing to do
  with any measurement. Partial for the same reason read the other way — a Studio that adds a
  default must not refuse every document written before it existed.

  A default the document does not record is one it says nothing about, so `differsFromDefaults`
  skips it rather than treating absence as a deviation. Reporting one would invent an override the
  writer never made.
*/
const operatorMeasuredAgainstSchema = z.looseObject({
  turnTimeoutMs: z.int().positive(),
  protocol: z.string().min(1),
  defaults: z.looseObject(measuredAgainstSchema.shape.defaults.shape).partial(),
});

const operatorDocumentSchema = z.strictObject({
  schemaVersion: z.literal(TUNING_SCHEMA_VERSION),
  /*
    OPTIONAL here and required on Studio's own document, and the asymmetry is the whole point.

    `activeTuning` keeps the bundled basis and drops this one, so requiring it made an operator
    write a block nothing reads — and write it correctly, since a blank `protocol` or a missing
    `turnTimeoutMs` refused the document whole and put every model in it back on the defaults. A
    refusal path with nothing behind it is worse than an absent field.

    Studio's own document still records its basis and still must: that is what
    `undocumentedOverrides` is measured against, and what keeps ten measurements meaningful after
    a compiled default moves. The discipline belongs to the document this repository writes.
  */
  measuredAgainst: operatorMeasuredAgainstSchema.optional(),
  models: z.array(operatorModelSchema),
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
  /**
   * The basis the document was written against, for the test that keeps it honest.
   *
   * Absent for an operator document that did not record one — which it need not, since nothing
   * reads it. Always present on Studio's own, where the schema requires it.
   */
  readonly measuredAgainst: RecordedBasis | undefined;
  /**
   * `"<model id>: <setting>"` for every value that differs from the recorded defaults and argues
   * for itself nowhere. Empty for the document this repository ships, and a test says so.
   *
   * Reported rather than refused: the settings still resolve, because a missing paragraph is a
   * fault in the writing and not in the measurement, and a run is not the place to find out.
   */
  readonly undocumentedOverrides: readonly string[];
  /**
   * `"<model id>: <key>"` for every key an entry stated that this Studio does not implement.
   *
   * Always empty for the bundled document, which is `strictObject` and would have been refused.
   * It exists for a document from outside, where an unknown key must neither refuse the whole file
   * nor vanish: the first breaks every mounted document the day Studio gains a setting, and the
   * second lets a misspelled `retryEmtpyTurn` do nothing quietly, which is what the strict schema
   * was for. So it is reported, and `GET /api/agent/config` carries it to the operator.
   */
  readonly ignoredKeys: readonly string[];
}

/** Every setting a model may state, so the justification rule can walk them by name. */
const SETTING_NAMES = Object.keys(settingsShape) as (keyof typeof settingsShape)[];

/** Everything an entry itself may say, for spotting a key misspelled outside `settings`. */
const ENTRY_KEYS = new Set(["id", "measured", "settings", "rationale"]);

type StatedSettings = Partial<z.infer<typeof modelSettingsSchema>>;
type RecordedDefaults = TuningDocument["measuredAgainst"]["defaults"];

/**
 * What a document says it was measured against.
 *
 * `defaults` is PARTIAL, and the type has to say so: Studio's own document records every one, but
 * an operator's may record only the defaults its Studio knew about. A strict type here would make
 * the absence checks in `differsFromDefaults` read as dead code to whoever removes them next.
 */
export interface RecordedBasis {
  readonly turnTimeoutMs: number;
  readonly protocol: string;
  readonly defaults: Partial<RecordedDefaults>;
}

/**
 * One entry's settings as a profile: what it stated, and nothing it did not.
 *
 * Built by walking `SETTING_NAMES` rather than naming ten fields, so a setting added to
 * `settingsShape` is carried through without a second edit here — the class of omission that would
 * otherwise parse fine and silently never resolve. For a COMPLETE entry the result is exactly what
 * the ten fields produced, which the pinned resolution table holds it to.
 */
function profileFor(measured: string, settings: StatedSettings): AgentModelProfile {
  const stated: Record<string, unknown> = {};
  for (const name of SETTING_NAMES) {
    const value = settings[name];
    if (value !== undefined) stated[name] = value;
  }
  return { measured, ...stated } as AgentModelProfile;
}

/** The settings this entry states that differ from the defaults the document records. */
function differsFromDefaults(settings: StatedSettings, defaults: Partial<RecordedDefaults>): string[] {
  const changed: string[] = [];
  for (const name of SETTING_NAMES) {
    const stated = settings[name];
    // Absent is not an override: it resolves to the compiled default, which needs no argument.
    if (stated === undefined) continue;
    // These have no recorded default: stating any of them at all is a decision, so each argues.
    if (name === "turnTimeoutMs" || name === "perWorkflow" || name === "threadContextMaxChars") {
      changed.push(name);
      continue;
    }
    if (name === "sampling") {
      // A default the document does not record says nothing about the setting beside it, so the
      // setting cannot be a deviation from it. Only an operator document can be sparse here.
      if (defaults.sampling === undefined) continue;
      const { temperature, topP } = stated as AgentSampling;
      if (temperature !== defaults.sampling.temperature || topP !== defaults.sampling.topP) changed.push(name);
      continue;
    }
    if (defaults[name] === undefined) continue;
    if (stated !== defaults[name]) changed.push(name);
  }
  return changed;
}

/** The shape both schemas produce, once their differing strictness has done its work. */
interface ReadDocument {
  readonly measuredAgainst: RecordedBasis | undefined;
  readonly models: readonly {
    readonly id: string;
    readonly measured: string;
    readonly settings: Record<string, unknown>;
    readonly rationale: Record<string, unknown>;
  }[];
}

/** Turns a validated document into the register, applying the rules that do not depend on origin. */
function assemble(doc: ReadDocument, origin: string): ModelTuning {
  const models: Record<string, AgentModelProfile> = {};
  /** Collected rather than thrown on; see rule 2 in this file's header. */
  const unjustified: string[] = [];
  const ignored: string[] = [];

  for (const entry of doc.models) {
    const key = entry.id.toLowerCase();
    // Rejected rather than last-wins: two spellings of one id is a document nobody can read,
    // and silently collapsing them would apply settings the other entry argues against.
    if (models[key] !== undefined) throw new ModelTuningError(origin, `models: ${entry.id} appears twice`);

    const settings = entry.settings as StatedSettings;
    models[key] = profileFor(entry.measured, settings);
    unjustified.push(
      // No recorded basis means nothing to compare against, so nothing is called an override.
      ...differsFromDefaults(settings, doc.measuredAgainst?.defaults ?? {})
        .filter((name) => entry.rationale[name] === undefined)
        .map((name) => `${entry.id}: ${name}`),
    );
    for (const stated of Object.keys(entry.settings)) {
      if (!SETTING_NAMES.includes(stated as keyof typeof settingsShape)) ignored.push(`${entry.id}: ${stated}`);
    }
    for (const stated of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(stated)) ignored.push(`${entry.id}: ${stated}`);
    }
  }

  return {
    models,
    measuredAgainst: doc.measuredAgainst,
    undocumentedOverrides: unjustified,
    ignoredKeys: ignored,
  };
}

function refuse(origin: string, error: z.ZodError): never {
  const first = error.issues[0];
  const where = first === undefined ? "unknown" : first.path.join(".");
  throw new ModelTuningError(origin, `${where}: ${first?.message ?? "invalid"}`);
}

/**
 * Reads Studio's own document, or throws.
 *
 * Pure: no filesystem, no environment, no caching. That is what lets the failures be tested
 * directly with bad literals rather than by shipping a corrupt file.
 */
export function parseTuning(document: unknown, origin: string): ModelTuning {
  const parsed = documentSchema.safeParse(document);
  if (!parsed.success) refuse(origin, parsed.error);
  return assemble(parsed.data as ReadDocument, origin);
}

/**
 * Reads a document that arrived from outside Studio, or throws.
 *
 * Same assembly, looser contract — see the note above `operatorSettingsSchema` for which rules
 * relax and why, and which do not. Its own function rather than a boolean on `parseTuning`, so a
 * call site cannot pick the tolerant rules for Studio's own document by passing the wrong flag.
 */
export function parseOperatorTuning(document: unknown, origin: string): ModelTuning {
  const parsed = operatorDocumentSchema.safeParse(document);
  if (!parsed.success) refuse(origin, parsed.error);
  return assemble(parsed.data as ReadDocument, origin);
}
