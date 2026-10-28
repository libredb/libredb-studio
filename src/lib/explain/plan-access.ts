/**
 * The structural plan reading the agent weighs, and the pieces every format's reader shares (#330 T3).
 *
 * Each `ExplainStrategy` that has been verified against its engine's grammar carries an `agentReading`
 * (`./types.ts`), and the agent core reads a plan only through it (`summarisePlan` in
 * `src/lib/agent/plan-summary.ts`), so the core names no format and no engine. A format whose strategy
 * carries no reading is `unknown` there, never read by a neighbour's rule.
 */

/** How the engine gets to the rows. Deliberately coarse — this is a comparison, not a plan viewer. */
export type AgentPlanAccess =
  /** At least one relation is read end to end, and none by an index. */
  | "full-scan"
  /** Every relation the plan names is reached through an index. */
  | "index"
  /** Both appear: an index on one side, a full read on another. */
  | "mixed"
  /** The plan says nothing this reading can interpret, or the dialect is unverified. */
  | "unknown";

export interface AgentPlanSummary {
  readonly access: AgentPlanAccess;
  /** The whole plan's estimate, when the engine reports one. Absent, never zero. */
  readonly estimatedRows?: number;
  readonly estimatedCost?: number;
  /**
   * At least one step of the plan said something this reading does not interpret, so
   * `access` describes the steps that WERE read and not the whole plan (#373 review).
   *
   * Set only by a reading that claims to read every step (the uncosted ones, `costed: false`),
   * and read by the auto-execute gate alone. It is a companion to `access` rather than a value
   * of it because the two answer different questions: `full-scan` beside this flag still means
   * a table is read end to end, and folding the flag into `unknown` would throw away the part
   * the reading did establish.
   *
   * Absent when every step was read, the way the estimates are absent when the engine
   * reports none: an explicit `false` on a plan nobody flagged would read as a
   * measurement of completeness, and this is only ever a measurement of incompleteness.
   *
   * NOT read by `compare_plans` or by `describeAccess` (`src/components/agent/timeline.ts`),
   * and that is deliberate. A comparison is about how two statements differ in the
   * access they were read to have; whether one of them also sorted is not a difference
   * this reading claims to have measured, so a comparison says exactly what it said
   * before this field existed.
   */
  readonly uninterpretedStep?: boolean;
}

/** What one node contributed: whether it scanned, whether it used an index, and whether it was read at all. */
export interface AccessTally {
  scanned: boolean;
  indexed: boolean;
  /** A step that matched neither rule. Tallied only where a reading claims to read every step. */
  uninterpreted: boolean;
}

export function accessOf(tally: AccessTally): AgentPlanAccess {
  if (tally.scanned && tally.indexed) return "mixed";
  if (tally.indexed) return "index";
  return tally.scanned ? "full-scan" : "unknown";
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A number the engine reported, or nothing. `Number.isFinite` excludes NaN and Infinity alike. */
export function reportedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
