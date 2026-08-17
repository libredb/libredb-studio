/**
 * The agent's tool layer over the M1 operation pipeline (#329, epic #325).
 *
 * This is the only place in the agent runtime that reaches a database, and it does
 * so through exactly one path: `executeAuditedOperation` (`src/lib/db/operations/`)
 * against a provider acquired under the agent read-only execution profile. There is
 * no second path, no direct `provider.query()`, and no provider method reached
 * outside a registered operation — a reach that skipped this module would be a
 * defect by the milestone's own constraint, not a shortcut.
 *
 * Four properties are load-bearing, and each is asserted rather than asserted-in-prose:
 *
 * 1. **Tool selection is a server-side function of the run's persisted mode and
 *    workflow type.** `selectAgentTools` reads nothing else. Planning yields an EMPTY set whatever
 *    the run is for, and
 *    a client-supplied tool list has no way in — not because it is filtered, but
 *    because there is no parameter for it. The same rule is enforced a second time
 *    at the execution seam, and since the plan-mode grounding design of 2026-08-15
 *    the seam states it precisely: outside agent mode a call is refused
 *    (`MODE_HAS_NO_TOOLS`, before the ledger, the deadline or an acquisition) UNLESS
 *    it is marked `grounding`, which is the server establishing a plan run's context
 *    before the model's first turn. Nothing a model sends can carry that flag — a
 *    planning run is still handed an empty tool set, so no dispatch of a model's tool
 *    call reaches the seam at all — and the two exported grounding entry points
 *    (`readCatalogForGrounding`, `readStatementForGrounding`) are called by
 *    `establishContext` with SERVER-composed statements. The property that survives
 *    unchanged is the one that matters: no model, in any mode, executes anything the
 *    selector did not offer it. What is NOT claimed is that the seam is a boundary
 *    against the server's own callers: `readStatementForGrounding` takes arbitrary
 *    SQL, and what keeps it read-only is the same statement guard, policy, profile
 *    and audit trail every other call meets, not the mode check.
 * 2. **A policy denial is a different KIND of outcome than a database error.** The
 *    two travel as distinct variants of `AgentToolRefusal` (T2 pinned that union so
 *    a denial has no readable `message` field at all), and the text handed to the
 *    model says a boundary decided this, never that the statement was ill-formed.
 *    Feeding a denial back as if it were bad SQL is what turns a refusal into a
 *    repair loop against the security layer.
 * 3. **The repair loop is bounded and never repeats a failed statement.** Every
 *    call passes the run's `AgentRepairLedger` first, keyed on a canonical
 *    fingerprint. A denial records the statement as unrepeatable but does NOT
 *    consume a repair attempt: nothing ran, and there is nothing to repair.
 * 4. **Database content is untrusted input.** Every result and every engine message
 *    that crosses into a prompt goes through `fenceUntrustedContent` first. Nothing
 *    in this module hands a model text that a row could have written.
 *
 * The run's wall-clock deadline (`deadline.ts`) is consulted here too, because this
 * is the layer that knows a call is about to be made: `admit` refuses a call that
 * no longer fits and clamps the statement timeout down to what is left of the run.
 * The clamp is applied by handing the pipeline a policy whose `statementTimeoutMs`
 * is the granted value, so the timeout the execution profile receives is the
 * pipeline's own `effectiveBudget` — there is no second budget to keep in step.
 *
 * The provider acquirer is INJECTED rather than imported. Two reasons, both real:
 * the spy-provider invariant above needs a seam, and a static import of
 * `@/lib/db/factory` would make this module's behaviour depend on whether some
 * other test file has replaced that module process-wide (`mock.module` is global —
 * five suites already stub the factory). Only the `ExecutionProfile` TYPE is
 * imported, so the profile literal still cannot drift from the factory's vocabulary.
 */

import { z } from "zod";
import { type AuditReason, emitAuditEvent } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import { ConnectionError, DatabaseConfigError, DatabaseError, PoolExhaustedError, QueryError } from "@/lib/db/errors";
import type { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import type { ExecutionBudget, ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import {
  type AgentCuratedReadInput,
  type CuratedOperationKind,
  agentCuratedReadInput,
} from "@/lib/db/operations/descriptors";
import { actorLabel, executeAuditedOperation } from "@/lib/db/operations/execution";
import { inspectAgentStatement } from "@/lib/db/operations/statement-guard";
import type { ExecutionActor, ExecutionPolicy, PolicyDenyCode, TargetScope } from "@/lib/db/operations/policy";
import type { OperationRegistry } from "@/lib/db/operations/registry";
import type { DatabaseProvider, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import { hasOptimizerHint } from "@/lib/sql/optimizer-hints";
import type { ColumnSchema, DatabaseConnection, QueryResult, TableSchema } from "@/lib/types";
import {
  type AgentCatalogKind,
  AgentComposedSqlError,
  composeCatalogRead,
  composeEstimatingExplain,
} from "./composed-sql";
import type { AgentDeadlineDenyCode, AgentRunDeadline } from "./deadline";
import {
  AGENT_EXECUTION_PROFILE,
  AGENT_MINIMUM_CALL_MS,
  AGENT_OPERATIONS_PROFILE,
  AGENT_WORKFLOW_BUDGETS,
} from "./execution-policy";
import type { AgentRepairDenyCode, AgentRepairLedger } from "./repair-ledger";
import { fingerprintStatement } from "./repair-ledger";
import { evaluateAutoExecute } from "./auto-execute";
import { summarisePlan } from "./plan-summary";
import {
  MAX_PROFILE_COLUMNS,
  type AgentProfileDepth,
  type AgentProfileFinding,
  type AgentTableProfile,
  composeTableProfile,
  findUnindexedForeignKeys,
  readTableProfile,
} from "./table-profile";
import type {
  AgentArtifactReference,
  AgentChartSpec,
  AgentContextSnapshot,
  AgentEvidenceReference,
  AgentPlanSide,
  AgentReadingDenyCode,
  AgentReportClaim,
  AgentRunActor,
  AgentRunEvent,
  AgentRunMode,
  AgentRunRecord,
  AgentRunWorkflowType,
  AgentToolRefusal,
} from "./types";
import { fenceUntrustedContent } from "./untrusted-content";

/** The tools an agent-mode run may be offered. Nothing else is a tool. */
export type AgentToolName =
  | "inspect_schema"
  | "run_read_query"
  | "inspect_plan"
  | "compose_report"
  /** Database assessment only: bounded per-table profiling, counts only. */
  | "profile_table"
  /** Query optimization only: two estimated plans of the same question. */
  | "compare_plans"
  /** Query optimization only: a change the user may apply. Never executed here. */
  | "recommend_change"
  /** Operations only: one curated reading of what the engine says about itself. */
  | "inspect_operations"
  /**
   * Which result IS the answer, and how it should be shown. Reaches no database.
   *
   * Offered by no workflow yet: the record below is the one place a tool set is
   * decided, and this slice decides that nothing may call it until the workflow that
   * asks for an answer exists.
   */
  | "present_answer";

/**
 * The canonical operations a tool may drive. `sql.explain.analyze` is a member so
 * the approval gate is reachable — and therefore testable — from this layer, NOT
 * because a tool maps onto it: no entry in `AGENT_TOOL_DEFINITIONS` names it, and
 * its descriptor is default-denied, so the pipeline can only ever answer
 * require-approval for it.
 */
export type AgentOperationId =
  | "sql.query.read"
  | "sql.explain.estimate"
  | "sql.explain.analyze"
  /** Bounded per-table profiling; #330 T3 reopened the three-descriptor decision. */
  | "sql.table.profile"
  /**
   * A curated operational reading. The one operation on this list that carries no
   * statement — see `dbOperationsReadDescriptor` for why it needs its own id.
   */
  | "db.operations.read"
  /**
   * The provider's own schema inspection, driven by the SERVER's grounding read and
   * by no tool — see `dbSchemaReadDescriptor` for why it needs its own id. It is on
   * this list because the audited path types every operation it runs through it, not
   * because a model can ask for it.
   */
  | "db.schema.read";

export interface AgentToolDefinition {
  readonly name: AgentToolName;
  readonly description: string;
  /** The contract a caller enforces on the model's arguments before invoking the tool. */
  readonly inputSchema: z.ZodType<unknown>;
  /** The canonical operation this tool drives; absent for the tool that reaches no database. */
  readonly operationId?: AgentOperationId;
}

export type AgentProviderAcquirer = (
  connection: DatabaseConnection,
  profile: ExecutionProfile,
) => Promise<DatabaseProvider>;

/**
 * Everything one run's tool call needs. Note what is NOT here: no execution
 * policy (this layer reads the frozen constant, so no caller can widen it) and no
 * tool list (the mode decides).
 */
export interface AgentToolContext {
  readonly runId: string;
  /** The run's PERSISTED mode. The only thing that decides which tools exist. */
  readonly mode: AgentRunMode;
  /**
   * The run's PERSISTED workflow. It decides which tools exist and, through
   * `AGENT_WORKFLOW_BUDGETS`, what this run may spend.
   *
   * Here rather than read from a module-level constant because the ceilings differ
   * per workflow: a layer that enforced one constant while the meter stated another
   * would be stating a number the server does not enforce. Like `mode`, it can only
   * have come from the run record — there is no parameter through which a request
   * body could contribute one.
   */
  readonly workflowType: AgentRunWorkflowType;
  /** The persisted actor — the sole authority for authorizing this call. */
  readonly actor: AgentRunActor;
  readonly connection: DatabaseConnection;
  readonly capabilities: ProviderCapabilities;
  /**
   * The provider's own vocabulary, read the same way and at the same moment as its
   * capabilities (#414).
   *
   * Here for one job: what this engine CALLS the rows of a schema inventory. Every
   * block a run is shown said "table" on every engine until a live drive found what
   * that costs on a keyspace — see `inventory-noun.ts`. The alternative was branching
   * on `connection.type` in the prompt layer, which `CLAUDE.md` forbids and which
   * would have had to be extended by hand for every engine added since.
   *
   * The whole `ProviderLabels` rather than the two fields the prompts use, because
   * the resource is what the provider hands over and narrowing it here would make the
   * next sentence that needs `rowName` a second plumbing job.
   */
  readonly labels: ProviderLabels;
  readonly registry: OperationRegistry;
  readonly scope: TargetScope;
  readonly tracker: ExecutionBudgetTracker;
  readonly artifacts: ExecutionArtifactStore<QueryResult>;
  readonly deadline: AgentRunDeadline;
  readonly repairs: AgentRepairLedger;
  readonly acquireProvider: AgentProviderAcquirer;
  /** Injected for the audited-execution elapsed measurement, as in `execution.ts`. */
  readonly clock?: () => number;
}

/**
 * Why a tool produced no result and no refusal. These are the run loop's own
 * outcomes — nothing was attempted at the database and no policy was consulted — so
 * they are deliberately not `AgentToolRefusal` variants (T2 pinned that union
 * closed, and widening it from here would blur "the boundary said no" with "the run
 * decided not to ask").
 */
export type AgentToolUnavailableCode =
  | "MODE_HAS_NO_TOOLS"
  | "INVALID_TOOL_INPUT"
  | "UNVERIFIABLE_EVIDENCE"
  /** A cited plan is not an estimating plan THIS run produced. */
  | "UNVERIFIABLE_PLAN"
  /** The named table is not in the inventory this run captured. */
  | "TABLE_NOT_INVENTORIED"
  /** The profile ran, and its aggregate row could not be read back. */
  | "PROFILE_UNREADABLE"
  /** The requested column offset is past the end of the table. */
  | "NO_COLUMNS_AT_OFFSET"
  /** One plan cited as both sides: a before and an after have to be two plans. */
  | "IDENTICAL_PLANS"
  /** The statement does not match the card it is offered under. */
  | "RECOMMENDATION_SHAPE_MISMATCH"
  /** The plan was this run's, and its rows are no longer held to be read. */
  | "PLAN_RESULT_RELEASED"
  /** This run has already recorded an answer, and a run answers once. */
  | "ANSWER_ALREADY_RECORDED"
  /** The answer names an artifact this run never produced. */
  | "ANSWER_ARTIFACT_UNKNOWN"
  /** The answer's result is this run's, and it is not a reading of the DATA. */
  | "ANSWER_NOT_A_DATA_READ"
  /** The answer's result exists, and no statement this run drafted produced it. */
  | "ANSWER_STATEMENT_UNKNOWN"
  /** The answer's result was this run's, and its rows are no longer held to be checked. */
  | "ANSWER_RESULT_RELEASED"
  /** A chart names a column the result does not have. */
  | "CHART_COLUMN_NOT_IN_RESULT"
  /** A chart's value column does not hold numbers in the rows that were delivered. */
  | "CHART_COLUMN_NOT_NUMERIC"
  /** A chart of fewer than two rows: the component renders an empty state. */
  | "CHART_TOO_FEW_ROWS"
  /** The chart type does not fit the columns named. */
  | "CHART_SHAPE_MISMATCH"
  | AgentDeadlineDenyCode
  | AgentRepairDenyCode;

export type AgentToolOutcome =
  | { readonly kind: "completed"; readonly artifact: AgentArtifactReference; readonly modelText: string }
  | { readonly kind: "refused"; readonly refusal: AgentToolRefusal; readonly modelText: string }
  | { readonly kind: "unavailable"; readonly reasonCode: AgentToolUnavailableCode; readonly modelText: string };

export type AgentTableProfileOutcome =
  | {
      readonly kind: "profiled";
      readonly artifact: AgentArtifactReference;
      readonly profile: AgentTableProfile;
      readonly modelText: string;
    }
  | { readonly kind: "refused"; readonly refusal: AgentToolRefusal; readonly modelText: string }
  | { readonly kind: "unavailable"; readonly reasonCode: AgentToolUnavailableCode; readonly modelText: string };

export type AgentPlanComparisonOutcome =
  | {
      readonly kind: "compared";
      readonly before: AgentPlanSide;
      readonly after: AgentPlanSide;
      readonly modelText: string;
    }
  | { readonly kind: "unavailable"; readonly reasonCode: AgentToolUnavailableCode; readonly modelText: string };

/** Everything a `recommendation` event carries except when it happened. */
export type AgentRecommendation = Omit<Extract<AgentRunEvent, { kind: "recommendation" }>, "kind" | "atMs">;

export type AgentRecommendationOutcome =
  | { readonly kind: "recommended"; readonly recommendation: AgentRecommendation; readonly modelText: string }
  | { readonly kind: "unavailable"; readonly reasonCode: AgentToolUnavailableCode; readonly modelText: string };

/** Everything an `answer-composed` event carries except when it happened. */
export type AgentComposedAnswer = Omit<Extract<AgentRunEvent, { kind: "answer-composed" }>, "kind" | "atMs">;

/** How an answer is to be shown, as the event records it and the description shows it. */
type AgentAnswerPresentation = AgentComposedAnswer["presentation"];

export type AgentAnswerOutcome =
  | { readonly kind: "answered"; readonly answer: AgentComposedAnswer; readonly modelText: string }
  | { readonly kind: "unavailable"; readonly reasonCode: AgentToolUnavailableCode; readonly modelText: string };

export type AgentReportOutcome =
  | { readonly kind: "composed"; readonly claims: readonly AgentReportClaim[]; readonly modelText: string }
  | { readonly kind: "unavailable"; readonly reasonCode: AgentToolUnavailableCode; readonly modelText: string };

export interface AgentOperationRequest {
  readonly operationId: AgentOperationId;
  /** The statement as it will be evaluated — composed by the server for two of the tools. */
  readonly sql: string;
  /** Prose naming what the result is, for the untrusted-content header. */
  readonly label?: string;
  /** Declared target dimensions, so a scope allowlist can bound them. */
  readonly target?: { readonly catalog?: string; readonly schema?: string };
  /**
   * Marks this call as the SERVER's own grounding read rather than a tool the model
   * asked for — the one thing that may reach a database outside agent mode.
   *
   * The mode gate below exists to enforce "a planning run's MODEL cannot invoke a
   * tool", and it enforced that by refusing every call any planning run made. Since
   * the plan-mode grounding design of 2026-08-15 a planning run establishes its
   * context server-side before its first turn, exactly as an agent run does, so the
   * gate has to distinguish the two things it was conflating. It is spelled as a flag
   * on the REQUEST rather than on the context because a context is what the tool
   * dispatch already holds: a marker there would travel to every call the dispatch
   * makes, while this one can only be set by a caller composing a specific statement.
   *
   * Nothing else about the call is relaxed. The statement is still server-composed,
   * still read-only, still audited, still bounded by the run's budget and deadline,
   * and still refused by the same policy — and the model is still handed no tools.
   */
  readonly grounding?: boolean;
}

// ============================================================================
// Tool definitions and server-side selection
// ============================================================================

const catalogSelectorSchema = z.strictObject({
  /**
   * Which inventory to read. Absent means the column inventory, which is what a
   * bare catalog inspection has always meant — so a model that never sends this
   * field gets exactly the behaviour it got before the field existed.
   */
  kind: z.enum(["columns", "relations", "indexes"]).optional(),
  schema: z.string().optional(),
  table: z.string().optional(),
});

/**
 * The same selector, plus the one kind the model is not offered.
 *
 * `statistics` is composed only while the SERVER establishes a run's context, and it
 * is deliberately absent from the model-facing schema above: a kind the tool
 * description does not explain is a kind a model would call blind. Both schemas parse
 * the same shape otherwise, so the grounding path gets the same argument validation
 * rather than a private, unvalidated one.
 */
const groundingSelectorSchema = catalogSelectorSchema.extend({
  kind: z.enum(["columns", "relations", "indexes", "statistics"]).optional(),
});

const readStatementSchema = z.strictObject({
  sql: z.string().min(1),
  /**
   * Why the model wrote this statement. Accepted here and NOT recorded at this
   * commit: the `statement-drafted` event that carries it (`types.ts`) is emitted by
   * the run service, which does not exist yet. It is in the declared contract so the
   * model is asked for it from the first run rather than having the tool's shape
   * change under it later. Deliberately no `min(1)`: refusing an otherwise valid read
   * because its rationale came back blank would be a disproportionate refusal.
   */
  rationale: z.string().optional(),
});

const planStatementSchema = z.strictObject({ sql: z.string().min(1) });

const evidenceSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("artifact"),
    correlationId: z.string().min(1),
    locator: z.string().min(1).optional(),
  }),
  z.strictObject({
    source: z.literal("context-snapshot"),
    fingerprint: z.string().min(1),
    locator: z.string().min(1).optional(),
  }),
]);

/**
 * ONE citation, rendered as the object the schema above accepts (#350).
 *
 * A function rather than a pair of string constants, because the same two calls
 * produce both things that have to agree: the EXAMPLE a description shows, with a
 * placeholder where the id goes, and the CONCRETE citation a completed step hands
 * over with the id filled in. A model that copies what it was shown is producing
 * what the parser was going to accept, because the same code wrote both.
 *
 * `satisfies AgentEvidenceReference` is what ties them to the durable contract, and
 * `tests/unit/lib/agent/tools.test.ts` closes the loop from the other side: it lifts
 * every literal object out of each description and parses it through that tool's own
 * `inputSchema`, so a description offering a shape the schema refuses fails there
 * rather than in a run.
 *
 * Why it exists at all: the evidence contract is a two-arm discriminated union, and
 * two live runs (#350) inferred it wrong from the serialized JSON schema alone — the
 * ledger records the model asking itself whether an evidence item is "an array of
 * table row objects or strings?" and spending a database round trip on the question.
 * Nothing it was TOLD named `source`, `correlationId` or `fingerprint`.
 */
const citeArtifact = (correlationId: string): string =>
  JSON.stringify({ source: "artifact", correlationId } satisfies AgentEvidenceReference);

export const citeSnapshot = (fingerprint: string): string =>
  JSON.stringify({ source: "context-snapshot", fingerprint } satisfies AgentEvidenceReference);

/**
 * The evidence contract in one sentence, said identically wherever it is said.
 *
 * Exported because `investigation.ts` states it too — in the run's opening rules —
 * and two wordings of the same contract would be two things to keep equal, with the
 * one that drifted being the one a model followed into a refusal.
 */
export const AGENT_EVIDENCE_CONTRACT = [
  `Each evidence item is ONE object: ${citeArtifact("<the artifact id a completed step reported>")} for a result this run read,`,
  `or ${citeSnapshot("<the fingerprint of the schema snapshot this run captured>")} for that inventory.`,
  'Add "locator" only to point at a part of it.',
].join(" ");

const reportSchema = z.strictObject({
  claims: z.array(z.strictObject({ claim: z.string().min(1), evidence: z.array(evidenceSchema).min(1) })).min(1),
});

/**
 * A plan comparison names two artifacts and NOTHING else.
 *
 * Deliberately no statement text: the ledger already records which statement each
 * plan inspection explained, so the server joins them itself. A model-supplied
 * label would let a comparison attribute a plan to a statement that never produced
 * it — the exact mislabelling a before/after claim rests on not doing.
 */
/**
 * A profile names a TABLE, never columns and never SQL. The columns come from the
 * run's own captured inventory, so a profile cannot be aimed at something the run
 * never established exists — the same rule `compare_plans` follows about plans.
 */
const profileSelectorSchema = z.strictObject({
  schema: z.string().optional(),
  table: z.string().min(1),
  depth: z.enum(["basic", "distribution", "pattern"]).optional(),
  /** Where in the table's column list to start. The server bounds how many follow. */
  fromColumn: z.number().int().min(0).optional(),
});

const planComparisonSchema = z.strictObject({
  before: z.string().min(1),
  after: z.string().min(1),
});

/**
 * The chart types a spec may ask for, as a total record over the durable union.
 *
 * A record rather than a bare list, for the reason `EVENT_KINDS` is one: the compiler
 * is the exhaustiveness check. A type added to `AgentChartSpec` and not offered here
 * would be a type the ledger can hold and the model is never told about.
 */
const CHART_TYPES: Readonly<Record<AgentChartSpec["type"], true>> = Object.freeze({
  bar: true,
  line: true,
  area: true,
  pie: true,
  scatter: true,
  "stacked-bar": true,
});

const CHART_TYPE_NAMES = Object.keys(CHART_TYPES) as [AgentChartSpec["type"], ...AgentChartSpec["type"][]];

const chartSpecSchema = z.strictObject({
  type: z.enum(CHART_TYPE_NAMES),
  x: z.string().min(1),
  y: z.array(z.string().min(1)).min(1),
  caption: z.string().min(1),
});

/**
 * An answer names ONE artifact and how to show it, and nothing else.
 *
 * Deliberately no statement text, for the reason `compare_plans` takes none: the
 * ledger already records which statement produced which result, so the server joins
 * them itself. A model-supplied statement would let an answer hand the user a
 * statement that produced something other than the result on screen.
 */
const presentAnswerSchema = z.strictObject({
  artifact: z.string().min(1),
  presentation: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("table") }),
    z.strictObject({ kind: z.literal("chart"), spec: chartSpecSchema }),
  ]),
});

/**
 * A presentation a model sent as a STRING of JSON, read back once before validation.
 *
 * Measured 2026-08-16: `qwen3.8` called `present_answer` three times with a correct artifact id
 * and a correct chart spec — right type, right x, right y, columns spelled as the result spells
 * them — and every call was refused as `INVALID_TOOL_INPUT`, because it had serialized the nested
 * object rather than nesting it:
 *
 *     {"artifact": "67fb…", "presentation": "{\"kind\": \"chart\", \"spec\": {…}}"}
 *
 * The run then reported without an answer and was scored `no-answer`, so what a reader saw was a
 * model that would not present — while its own closing prose said the presentation "is being
 * persistently rejected despite conforming to the declared shape". It was.
 *
 * Read ONCE and never recursively: this accepts a serialization the model chose, it does not
 * invent a second encoding. The value still goes through the same schema, so a string holding the
 * wrong shape is refused exactly as the object would have been — nothing is admitted here that
 * would not have been admitted written properly.
 *
 * At the CALL BOUNDARY rather than inside the schema, and that placement is the whole of what
 * makes it safe. Wrapping the field in `z.preprocess` instead would produce a `ZodPipe`, and the
 * SDK derives the model's copy of the contract from this same object with
 * `toJSONSchema(schema, { target: 'draft-7', io: 'input' })`
 * (node_modules/@ai-sdk/provider-utils/src/schema.ts:251, reached from `declaredTools()` in
 * src/lib/agent/investigation.ts) — where a `ZodPipe` is not counted as a required key. Measured
 * over every entry of `AGENT_TOOL_DEFINITIONS` with that wrapper in place, `present_answer` was
 * the ONLY tool whose two contracts disagreed: runtime `[artifact, presentation]` against
 * advertised `[artifact]`, while all eight others matched exactly. So a model that OBEYED the
 * advertised contract would send `artifact` alone and be refused — and because this tool is
 * ledger-only, its refusal records no event and the run is scored `no-answer` with nothing saying
 * why: the same invisible failure this fix exists to remove, re-created for correct models instead
 * of sloppy ones. Reading here leaves the advertised schema byte-identical to what it always was.
 *
 * That placement puts a dependency between this read and the run loop, and it is worth naming
 * because it is invisible from here. The SDK validates the model's arguments against this same
 * strict schema BEFORE any of this runs, and a serialized presentation fails it: measured against
 * `ai@7.0.59`, `doParseToolCall` throws, the SDK catches it, re-parses the raw JSON without a
 * schema and enqueues the tool-call part anyway with `invalid: true`. So this function is reached
 * only because `takeTurn` dispatches every tool-call part without consulting that flag
 * (src/lib/agent/investigation.ts:1042). Hardening that line to `!part.invalid` would drop the call
 * before it arrives here and silently undo this fix — and it is a plausible edit rather than an
 * imagined one, because `capability-probe.ts:279` already treats the flag as meaningful
 * (`part.invalid !== true`). `tests/isolated/agent-investigation.test.ts` drives the whole path
 * through the real SDK so that edit fails a test rather than a run.
 */
function readSerializedPresentation(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const { presentation } = input as { presentation?: unknown };
  if (typeof presentation !== "string") return input;
  try {
    return { ...input, presentation: JSON.parse(presentation) };
  } catch {
    // Left as the string it was: the schema refuses it, and reporting a parse failure here would
    // replace the contract's own wording with this function's.
    return input;
  }
}

/** ONE presentation, rendered as the object `presentAnswerSchema` accepts for its `presentation`. */
const showAs = (presentation: AgentAnswerPresentation): string => JSON.stringify(presentation);

/**
 * The presentation contract in one place, said identically wherever it is said.
 *
 * The `AGENT_EVIDENCE_CONTRACT` pattern, and it exists for the same reason: the
 * EXAMPLE the description shows and the object the parser accepts are produced by the
 * same call, so the two cannot disagree. `tests/unit/lib/agent/tools.test.ts` closes
 * the loop from the other side — it lifts every literal object out of the description
 * and parses it through this tool's own `inputSchema`.
 *
 * Exported, and it was module-private until the `data-analysis` workflow arrived:
 * that workflow's opening rules state the contract too, and the whole point of one
 * string is that the description and the rules cannot tell a model two different
 * bars for one tool. It is stated in a second file by importing this, never by
 * copying it.
 */
export const AGENT_ANSWER_CONTRACT = [
  `"presentation" is ONE object: ${showAs({ kind: "table" })} for a table,`,
  `or ${showAs({
    kind: "chart",
    spec: {
      type: "bar",
      x: "<a column of that result>",
      y: ["<a numeric column of that result>"],
      caption: "<what the chart shows, in your own words>",
    },
  })} for a chart.`,
  `"type" is one of: ${CHART_TYPE_NAMES.join(", ")}. For several series, name several y columns: there is no separate series field.`,
  "Every column a chart names must be a column of THAT result, spelled as the result spells it, and every y column must hold numbers.",
  "A chart needs at least two rows; a pie takes exactly one y; a scatter needs a numeric x as well.",
  "Present a table when the result is a single number, has one row, or has no numeric column: that is a complete answer, not a lesser one.",
  "When the objective asks for a chart and the result can carry one, chart it: the user named the shape of the answer they wanted.",
].join(" ");

const recommendationSchema = z.strictObject({
  change: z.enum(["index", "rewrite"]),
  statement: z.string().min(1),
  rationale: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
});

export const AGENT_TOOL_DEFINITIONS: Readonly<Record<AgentToolName, AgentToolDefinition>> = Object.freeze({
  inspect_schema: {
    name: "inspect_schema",
    description:
      "Read the database's own catalog, optionally narrowed to one schema or table. Pass kind to choose the inventory: columns (the default: tables and their columns), relations (foreign keys) or indexes. The statement is composed by the server; you supply only the selector. On a large database pass a schema or table selector: the result is subject to the same row budget as any read and is refused, not truncated, if it overflows.",
    inputSchema: catalogSelectorSchema,
    operationId: "sql.query.read",
  },
  run_read_query: {
    name: "run_read_query",
    description:
      "Run one bounded read-only SQL statement. Writes, DDL and multi-statement text are refused before the database is reached.",
    inputSchema: readStatementSchema,
    operationId: "sql.query.read",
  },
  inspect_plan: {
    name: "inspect_plan",
    description:
      "Ask the engine for the ESTIMATED plan of one read-only statement. The plan is described, never executed, so no timings are produced.",
    inputSchema: planStatementSchema,
    operationId: "sql.explain.estimate",
  },
  profile_table: {
    name: "profile_table",
    description:
      "Profile one table the run has already inventoried. The server chooses the columns from the captured schema and composes the aggregates; you supply only the table and how deep to go. Depth basic counts rows and missing values, distribution adds distinct counts, pattern adds a shape test for personal data. Only COUNTS are returned — no value is ever read out of a column.",
    inputSchema: profileSelectorSchema,
    operationId: "sql.table.profile",
  },
  compare_plans: {
    name: "compare_plans",
    description:
      "Record a before/after comparison of two ESTIMATED plans this run already inspected. Pass the artifact ids of two inspect_plan results; the server reads both plans itself and states how each reaches its rows. Nothing is executed, and no timings exist — the executing form of EXPLAIN is refused by policy.",
    inputSchema: planComparisonSchema,
  },
  recommend_change: {
    name: "recommend_change",
    description: `Propose one index or one rewrite for the user to apply themselves. The statement is never executed by this run; it is offered to the user's editor. Every recommendation must cite evidence this run produced. ${AGENT_EVIDENCE_CONTRACT}`,
    inputSchema: recommendationSchema,
  },
  inspect_operations: {
    name: "inspect_operations",
    description:
      "Read what the engine says about ITSELF, right now. Pass kind to choose the reading: sessions (who is connected, what each is running, how long it has been running and whether it is blocked), slow-queries (the statements this engine reports as costly), table-stats (row counts and sizes, and dead rows where the engine tracks them), index-stats (size and how many scans each index has served, so an unused one is visible), storage (space and its growth) or health (one row of connection, size and cache figures). No SQL is involved: you name the reading and the server calls the engine's own reporting interface, so these are the readings that work on every engine. limit bounds EVERY kind, and schema narrows the table and index ones; the server applies both itself, so they hold whatever the engine does with them. EVERY READING IS A MOMENT, not a history: it says what is true as it is taken, and calling it twice does not make a trend.",
    inputSchema: agentCuratedReadInput,
    operationId: "db.operations.read",
  },
  present_answer: {
    name: "present_answer",
    description: `Record that one result you have already read IS the answer, and how it should be shown. Only a result of a run_read_query you drafted can be the answer: a plan describes a statement without running it and a profile returns counts about a table, so neither may be presented — both may still be cited as evidence. Pass the artifact id that read reported; the statement behind it comes from this run's own ledger, so you do not supply it. The columns a chart names are checked against that result's real columns and refused if they do not match. Your report must then cite this same artifact in at least one claim: the presentation shows the result and the claims say what it means, so a report resting on other evidence entirely leaves the run scored as not having answered. ${AGENT_ANSWER_CONTRACT}`,
    inputSchema: presentAnswerSchema,
  },
  compose_report: {
    name: "compose_report",
    description: `Compose the run's findings and finish. Every claim must cite at least one artifact this run read or the schema snapshot it captured; an uncited claim is refused. ${AGENT_EVIDENCE_CONTRACT}`,
    inputSchema: reportSchema,
  },
} satisfies Record<AgentToolName, AgentToolDefinition>);

const AGENT_MODE_TOOLS: readonly AgentToolDefinition[] = Object.freeze([
  AGENT_TOOL_DEFINITIONS.inspect_schema,
  AGENT_TOOL_DEFINITIONS.run_read_query,
  AGENT_TOOL_DEFINITIONS.inspect_plan,
  AGENT_TOOL_DEFINITIONS.compose_report,
]);

/** Planning is toolless. Not "filtered to nothing" — there is nothing to filter. */
const NO_TOOLS: readonly AgentToolDefinition[] = Object.freeze([]);

/**
 * Workflow type → the tools that workflow may use (#330 T2).
 *
 * A total record, so a workflow type added to the contract stops this file compiling
 * until somebody decides what it may do. All three name the same set today, and that
 * is the honest state rather than a placeholder: M3's two templates are about what
 * the model is ASKED to produce and how the run is JUDGED, and the tools that would
 * distinguish them — bounded per-table profiling, a monitor snapshot — arrive with
 * the templates themselves (#330 T3). What exists now is the seam, in the one place
 * a tool set may be decided, so widening one workflow later cannot become a second
 * decision about where that decision lives.
 */
/**
 * The optimization template's own two, on top of the read-class four.
 *
 * Offered to ONE workflow rather than added to `AGENT_MODE_TOOLS`, which is what
 * makes the axis load-bearing: an investigation that calls `compare_plans` is told
 * there is no such tool, because for that run there is not.
 */
const QUERY_OPTIMIZATION_TOOLS: readonly AgentToolDefinition[] = Object.freeze([
  ...AGENT_MODE_TOOLS,
  AGENT_TOOL_DEFINITIONS.compare_plans,
  AGENT_TOOL_DEFINITIONS.recommend_change,
]);

/** The assessment template's own tool, on top of the read-class four. */
const DATABASE_ASSESSMENT_TOOLS: readonly AgentToolDefinition[] = Object.freeze([
  ...AGENT_MODE_TOOLS,
  AGENT_TOOL_DEFINITIONS.profile_table,
]);

/**
 * The operations template's tools, and the ONLY set that is not built on the
 * read-class four.
 *
 * Deliberately not `[...AGENT_MODE_TOOLS, inspect_operations]`, which is what every
 * other template does. All three of the read-class tools this leaves out —
 * `inspect_schema`, `run_read_query`, `inspect_plan` — reach the database through
 * `provider.queryReadOnly`, which only PostgreSQL and SQLite implement. Offering any
 * of them here would reintroduce, tool by tool, the exact engine restriction this
 * workflow exists to escape: the run would open on MySQL, be offered a tool, call it,
 * and be answered by an acquisition that refuses the engine.
 *
 * `inspect_schema` was checked rather than assumed, per the spec's condition:
 * `inspectSchemaTool` composes a statement and hands it to `executeAgentOperation`,
 * whose invoke callback is `runStatement`, which calls `provider.queryReadOnly`. It
 * depends on it, so it is left out.
 *
 * `recommend_change` is here and `compare_plans` is not: a comparison names two
 * `inspect_plan` artifacts this run cannot produce, so offering it would be offering
 * a tool that can only ever refuse.
 */
const OPERATIONS_TOOLS: readonly AgentToolDefinition[] = Object.freeze([
  AGENT_TOOL_DEFINITIONS.inspect_operations,
  AGENT_TOOL_DEFINITIONS.recommend_change,
  AGENT_TOOL_DEFINITIONS.compose_report,
]);

/**
 * The analysis template's two tools, on top of the read-class four.
 *
 * `present_answer` is the one this workflow's verdict requires, and it is offered
 * HERE and nowhere else for exactly that reason: a tool a run's bar never asks for is
 * a tool that can only distract it.
 *
 * `profile_table` is borrowed from the assessment template rather than duplicated,
 * and it is borrowed at the design's cheapest recommendation (§5.4). The schema
 * carries no row counts, so a 400 M-row fact table and a 12-row lookup table are
 * indistinguishable in the inventory, and a `shipped_at` that is 80% null and a
 * `placed_at` that is fully populated say which date column the business actually
 * fills. Basic depth answers both, costs one statement per table, and reads no value
 * out of any column — which is what makes pointing it at a table of personal data
 * acceptable at all.
 */
const DATA_ANALYSIS_TOOLS: readonly AgentToolDefinition[] = Object.freeze([
  ...AGENT_MODE_TOOLS,
  AGENT_TOOL_DEFINITIONS.profile_table,
  AGENT_TOOL_DEFINITIONS.present_answer,
]);

const WORKFLOW_TOOLS: Readonly<Record<AgentRunWorkflowType, readonly AgentToolDefinition[]>> = Object.freeze({
  investigation: AGENT_MODE_TOOLS,
  "query-optimization": QUERY_OPTIMIZATION_TOOLS,
  "database-assessment": DATABASE_ASSESSMENT_TOOLS,
  operations: OPERATIONS_TOOLS,
  "data-analysis": DATA_ANALYSIS_TOOLS,
} satisfies Record<AgentRunWorkflowType, readonly AgentToolDefinition[]>);

/**
 * The tools this run may use, decided from its persisted mode and workflow type and
 * nothing else.
 *
 * The parameter is the run record (narrowed to the two fields that matter) rather
 * than bare strings, so the values can only have come from persisted state. There is
 * no parameter through which a request body could contribute a tool, which is what
 * "a client-supplied tool list is ignored, not merged" means here.
 *
 * Mode is checked FIRST and the workflow cannot override it: planning is toolless by
 * contract whatever it is for, so a workflow type is never a way to give a planning
 * run a tool.
 */
export function selectAgentTools(run: Pick<AgentRunRecord, "mode" | "workflowType">): readonly AgentToolDefinition[] {
  return run.mode === "agent" ? WORKFLOW_TOOLS[run.workflowType] : NO_TOOLS;
}

// ============================================================================
// Model-facing text
// ============================================================================

const UNAVAILABLE_TEXT: Readonly<Record<AgentToolUnavailableCode, string>> = Object.freeze({
  // "Produce a plan in prose" until 2026-08-15, when the plan-mode design made the
  // deliverable ONE runnable statement (or an explicit `NO STATEMENT:` refusal) for
  // every workflow but `operations`. This sentence is said to a model that has just
  // reached for a tool, which is exactly the moment it must not be handed a second,
  // looser contract than the one its rules state: two wordings of one contract is how
  // #350 happened. So it says what is true here — nothing can be called — and leaves
  // what to produce to the rules that already say it.
  MODE_HAS_NO_TOOLS:
    "This run is in planning mode, which has no tools at all: no database call is possible from here. Answer with what your instructions asked you to produce.",
  // Said by every tool, including the two that reach no database and compose no SQL,
  // so it may not promise a statement (#350). `recommend_change` and `compose_report`
  // shared a sentence written for the SQL-composing tools, and a model that got an
  // evidence object wrong was answered with a sentence about statements.
  INVALID_TOOL_INPUT:
    "The arguments did not match the shape this tool declares, so nothing was done. Correct them and call the tool again.",
  UNVERIFIABLE_EVIDENCE: `At least one evidence reference does not match anything this run produced. Cite an artifact this run actually read, or the schema snapshot it captured. ${AGENT_EVIDENCE_CONTRACT}`,
  UNVERIFIABLE_PLAN:
    "At least one of those references is not an estimated plan this run produced. Inspect the plan of each statement first, then compare the two artifacts those inspections returned.",
  TABLE_NOT_INVENTORIED:
    "That table is not in the schema inventory this run captured. Call inspect_schema for it first, then profile it by the name the inventory uses.",
  NO_COLUMNS_AT_OFFSET:
    "That column offset is past the end of the table, so there is nothing there to profile. Start from an earlier column, or profile a different table.",
  PROFILE_UNREADABLE:
    "The profile ran but its result could not be read as counts. Try a shallower depth, or profile a different table.",
  IDENTICAL_PLANS:
    "Both sides of that comparison name the same plan, so there is no before and no after. Inspect the plan of your rewrite as well, then compare the two.",
  RECOMMENDATION_SHAPE_MISMATCH:
    "That statement is not the kind of change the card claims. An index recommendation must be one CREATE INDEX statement; a rewrite must be one bounded read.",
  PLAN_RESULT_RELEASED:
    "That plan was this run's, but its rows are no longer held and cannot be read again. Inspect the plan once more if the comparison still matters.",
  // The answer refusals each restate the half of the contract they enforce, and each
  // one names the way out. A description is read by a model that is not yet confused;
  // these are read by one that demonstrably is, and a table is almost always a correct
  // answer it can give instead.
  //
  // This first one is the exception to that shape: nothing about the arguments was
  // wrong, so there is no contract half to restate and no second attempt to invite.
  // The only thing left for the run to do is say what the answer MEANS.
  ANSWER_ALREADY_RECORDED:
    "This run has already recorded its answer, and a run answers once: nothing was changed and no second answer was composed. If that answer was the wrong one, say so in your claims. Now call compose_report — the presentation shows the result, the claims are the answer.",
  ANSWER_ARTIFACT_UNKNOWN:
    "That is not the id of a result this run read, so there is nothing to present. Pass the artifact id a completed read reported in this run, or read the data first.",
  ANSWER_NOT_A_DATA_READ:
    "That result is this run's, and it is not a reading of the data, so it cannot be the answer: a plan DESCRIBES a statement without running it, and a profile returns counts the server composed about a table. Present the result of a run_read_query you drafted — run the read first if you have not. A plan or a profile can still be cited as evidence in your report.",
  ANSWER_STATEMENT_UNKNOWN:
    "That result was not produced by a statement you wrote, so there is no statement to put behind the answer. Answer with a read you drafted yourself.",
  ANSWER_RESULT_RELEASED:
    "That result was this run's, but its rows are no longer held, so a chart's columns cannot be checked against them. Read it again, or present the answer as a table.",
  CHART_COLUMN_NOT_IN_RESULT:
    "A chart may only name columns of the result it presents, and at least one of these is not one. The result's own column names follow: spell them exactly as they are spelled there, or present the answer as a table.",
  CHART_COLUMN_NOT_NUMERIC:
    "Every y column of a chart has to hold numbers in the rows that were delivered, and at least one of these does not. Chart a column that holds numbers, or present the answer as a table — a table is a complete answer.",
  CHART_TOO_FEW_ROWS:
    "A chart needs at least two rows and this result has fewer, so a chart of it would render an empty state. Present the answer as a table: one row is a complete answer, not a lesser one.",
  CHART_SHAPE_MISMATCH:
    "That chart type does not fit the columns named: a pie takes exactly one y column, and a scatter needs a numeric x as well as a numeric y. Choose a type that fits the columns, or present the answer as a table.",
  RUN_DEADLINE_EXCEEDED:
    "The run has spent its whole time budget. Stop calling tools and finish with what has already been established.",
  INSUFFICIENT_TIME_REMAINING:
    "Too little time is left in the run for a call of this size. Ask for something cheaper, or finish now.",
  STATEMENT_ALREADY_FAILED:
    "This exact statement has already failed in this run. Draft a different statement rather than sending the same one again.",
  REPAIR_BUDGET_EXHAUSTED:
    "This run has used all of its repair attempts. Stop drafting statements and report what has been established.",
});

/**
 * What a denial tells the model it may try next. Three answers, because the codes
 * genuinely differ in whether ANYTHING the model can change would help:
 *
 * - `absolute` — the run is not permitted to do this at all (privilege, risk class,
 *   budget, a malformed server context). No statement the model writes changes it,
 *   and saying otherwise invites a repair loop against the security layer.
 * - `shape` — the statement fell outside the bounded-read CONTRACT. Not a syntax
 *   error (the SQL may be perfectly valid), and a differently shaped read genuinely
 *   can be admitted: the guard refuses `SELECT copy FROM ads` because `copy` reads
 *   as a side-effect word and admits `SELECT "copy" FROM ads`, which
 *   `statement-guard.ts` records as the escape hatch. Telling the model not to
 *   bother is how a legitimate column becomes unreachable for the whole run.
 * - `target` — the DECLARED target is outside the run's scope. The statement's
 *   wording is irrelevant, but a tool that takes a target selector (today
 *   `inspect_schema`) can be asked for an in-scope one instead.
 *
 * A total `Record` rather than a comparison against a string: a new
 * `PolicyDenyCode` must not silently inherit whichever branch happened to be the
 * default. This is the same compiler-mirror pattern `DENY_REASONS` uses in
 * `execution.ts` and `DEADLINE_REASONS` uses below.
 *
 * The advice is keyed on the DENY CODE and not on the tool, which is a real
 * imprecision worth naming: for `inspect_schema` and `inspect_plan` the statement is
 * server-composed, so an `INPUT_VALIDATION_FAILED` there would be a server defect
 * rather than something the model shaped, and `shape`'s "a differently shaped read
 * may still be admitted" is advice it cannot act on. Left as-is on purpose. No
 * reachable case exists — every composed statement in `composed-sql.ts` is guard-clean
 * for both dialects and pinned by a test, and `inspect_plan`'s only model-supplied
 * part is the inner statement, which genuinely IS a shape the model chose. A per-tool
 * override would therefore be an uncoverable branch under the 100% line gate, which is
 * a worse trade than a sentence that is imprecise only in a state that cannot occur.
 */
type DenialAdvice = "absolute" | "shape" | "target";

const DENIAL_ADVICE: Record<PolicyDenyCode, DenialAdvice> = {
  UNKNOWN_OPERATION: "absolute",
  AMBIGUOUS_OPERATION: "absolute",
  MALFORMED_POLICY_CONTEXT: "absolute",
  INVALID_ACTOR: "absolute",
  TARGET_OUT_OF_SCOPE: "target",
  INPUT_VALIDATION_FAILED: "shape",
  CAPABILITY_UNSUPPORTED: "absolute",
  ROLE_FORBIDDEN: "absolute",
  MODE_FORBIDDEN: "absolute",
  RISK_EXCEEDS_POLICY: "absolute",
  CONCURRENCY_BUDGET_EXCEEDED: "absolute",
  STATEMENT_BUDGET_EXCEEDED: "absolute",
  TOTAL_RUN_BUDGET_EXCEEDED: "absolute",
};

const DENIAL_ADVICE_TEXT: Record<DenialAdvice, string> = {
  absolute:
    "This is a decision about what this run is permitted to do at all, not a remark about how the statement is written, so rewording it will not change the answer.",
  shape:
    "The statement's shape falls outside what a bounded read-only inspection may be, which is a decision about the contract rather than about valid SQL; a differently shaped read may still be admitted.",
  target:
    "The target this call declared falls outside the scope this run may reach, which is not about how the statement is written; where a tool takes a target selector, an in-scope one may still be admitted.",
};

/**
 * The text a policy denial produces. It names the reason code, says a boundary
 * decided this, and never describes the statement as ill-formed.
 *
 * The version is the one that DECIDED — the run's own workflow policy — rather than a
 * module-level constant, so what the model is told and what an operator can trace the
 * denial back to are the same string.
 */
function denialText(reasonCode: PolicyDenyCode, policyVersion: string): string {
  return [
    `The database operation layer refused this call: ${reasonCode} (policy ${policyVersion}).`,
    DENIAL_ADVICE_TEXT[DENIAL_ADVICE[reasonCode]],
    "Choose a different approach that stays inside a bounded read-only inspection.",
  ].join(" ");
}

/**
 * What a refused curated reading tells the model, and both sentences are advice it
 * can actually act on.
 *
 * `READING_OVER_BUDGET`'s advice is only worth giving because `limit` is applied by
 * the projection for EVERY kind rather than only by the two provider methods that
 * take one — see `runCuratedRead`. Advice a tool cannot honour is worse than none:
 * the model would spend its statement budget re-asking for a reading it can never be
 * given.
 */
const READING_REFUSAL_TEXT: Record<AgentReadingDenyCode, string> = {
  KIND_UNSUPPORTED_BY_PROVIDER:
    "This database serves no reading of that kind, so nothing was read. Ask for a different kind, or report what the other readings established — including that this one is unavailable here.",
  READING_OVER_BUDGET:
    "That reading came back larger than this run may carry, so none of it was kept: a partial reading would be a misleading one. Ask again with a smaller limit; it bounds every kind of reading, not only the ones the engine limits itself.",
};

function approvalText(operationId: string): string {
  return [
    `The operation ${operationId} is default-denied and needs a human approval this run does not carry, so nothing was executed.`,
    "Use the estimating plan inspection instead; it describes a plan without running the statement.",
  ].join(" ");
}

function unavailable(
  reasonCode: AgentToolUnavailableCode,
  detail?: string,
): AgentToolOutcome & { kind: "unavailable" } {
  const base = UNAVAILABLE_TEXT[reasonCode];
  return { kind: "unavailable", reasonCode, modelText: detail === undefined ? base : `${base} (${detail})` };
}

/**
 * The bad-input refusal the two evidence-bearing tools give, with the contract in it.
 *
 * `INVALID_TOOL_INPUT` is shared by every tool, and a selector this layer could not
 * read has nothing to do with citing — so the contract is added HERE, at the two call
 * sites where the arguments that failed to parse carried evidence, rather than to the
 * shared sentence.
 *
 * Why a refusal restates something the description already said (#350): a description
 * is read by a model that is not yet confused, and a refusal is read by one that
 * demonstrably is. It got the shape wrong, and this reply is the next thing it reads.
 * `UNVERIFIABLE_EVIDENCE` carries the contract in `UNAVAILABLE_TEXT` itself, because
 * only these same two tools can produce it.
 */
function invalidEvidenceInput(): AgentToolOutcome & { kind: "unavailable" } {
  return {
    kind: "unavailable",
    reasonCode: "INVALID_TOOL_INPUT",
    modelText: `${UNAVAILABLE_TEXT.INVALID_TOOL_INPUT} ${AGENT_EVIDENCE_CONTRACT}`,
  };
}

/**
 * Renders result rows for a prompt.
 *
 * `bigint` is replaced rather than left to `JSON.stringify`, which throws on one:
 * `node:sqlite` returns a BigInt for an INTEGER outside the safe range, and mysql2
 * can too, so this is a live shape rather than a defensive guess.
 */
function renderRows(rows: readonly Record<string, unknown>[]): string {
  return rows
    .map((row) => JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value)))
    .join("\n");
}

// ============================================================================
// The audited execution seam
// ============================================================================

/**
 * Deadline refusals mapped to their audit reasons, typed as a total record so a new
 * deny code cannot reach production without a reason an operator can filter on —
 * the same mirror `DENY_REASONS` builds for policy denials. A run that stops on its
 * own deadline would otherwise leave nothing in the trail at all, because the
 * refusal happens before `executeAuditedOperation` is reached.
 *
 * DELIBERATE ASYMMETRY: the ledger refusals (`STATEMENT_ALREADY_FAILED`,
 * `REPAIR_BUDGET_EXHAUSTED`) and the two input refusals are NOT audited, and the
 * deadline ones are. The line is whether the reason is visible anywhere else. A
 * deadline refusal can end a run with no other trace, because the preceding calls
 * may all have succeeded. Every ledger refusal is preceded by the audited failure
 * that put the fingerprint in the ledger or spent the budget, so the trail already
 * records the cause and an extra line would only restate it. `MODE_HAS_NO_TOOLS`
 * and `INVALID_TOOL_INPUT` never reached a database or a policy at all. Revisit
 * this if the run service turns out to need the run's whole refusal history from
 * the audit stream rather than from the run record, which holds it either way.
 */
const DEADLINE_REASONS: Record<AgentDeadlineDenyCode, AuditReason> = {
  RUN_DEADLINE_EXCEEDED: "agent_run_deadline_exceeded",
  INSUFFICIENT_TIME_REMAINING: "agent_insufficient_time_remaining",
};

const DEADLINE_TARGET = "agent/operations/deadline";
const UNRESOLVED_OPERATION = "unresolved";

function auditDeadlineRefusal(
  context: AgentToolContext,
  actor: ExecutionActor,
  operationId: AgentOperationId,
  reasonCode: AgentDeadlineDenyCode,
): void {
  // The registry-resolved id, never the caller's string: the audited action stays a
  // closed vocabulary even though this entry point is typed.
  const resolution = context.registry.resolve(operationId);
  emitAuditEvent({
    type: "agent_operation",
    action: resolution.kind === "resolved" ? resolution.descriptor.id : UNRESOLVED_OPERATION,
    target: DEADLINE_TARGET,
    user: actorLabel(actor),
    result: "failure",
    reason: DEADLINE_REASONS[reasonCode],
  });
}

/**
 * Failures of the environment the statement RAN IN. No statement the model writes
 * fixes one, so each propagates instead of being spent as a repair attempt and
 * hidden from the caller.
 *
 * Note which classes are deliberately NOT here, because both look like they belong
 * and both would re-break the repair loop:
 *
 * - **`AuthenticationError`** covers two unrelated events. `mapDatabaseError` answers
 *   it for anything matching `password`/`authentication`/`access denied`/
 *   `permission denied` (`errors.ts:270-277`), which folds a wrong agent credential
 *   together with `permission denied for table secrets`. The second is routine on the
 *   least-privilege `agentUser` this programme recommends — per-table `SELECT` grants
 *   are what bound an agent's reads — so it is the model's first probe of an ungranted
 *   object, and reading a different table is exactly the repair that helps. They are
 *   indistinguishable by class but not by PHASE, which is what `runStatement` splits
 *   on: a credential failure happens while connecting, a grant failure while running.
 * - **`QueryCancelledError`** is what a PostgreSQL statement timeout arrives as, and
 *   this layer is what CAUSES it: the clamped budget becomes `SET LOCAL
 *   statement_timeout` (`postgres.ts:892`), the engine says `canceling statement due
 *   to statement timeout`, and `mapDatabaseError` matches `canceling statement`
 *   BEFORE its timeout branch (`errors.ts:280-293`) — so the timeout never arrives as
 *   `TimeoutError` on this engine at all. Narrowing the read is the repair that helps.
 *   The message that would distinguish an operator cancel is discarded by the mapper
 *   (`docs/BACKLOG.md` B4), so this cannot be split on text.
 *   FOR T7: a run cancellation must therefore be enforced by the run loop's own
 *   persisted state between tool calls, NOT by expecting a driver cancel to propagate
 *   out of this layer — after this commit it does not.
 *
 * HONEST LIMIT: this split is only as sharp as `mapDatabaseError`'s classification,
 * which is SUBSTRING matching on the engine's message, and it is imprecise in BOTH
 * directions. Verified: `no such table: pooled_items` matches `pool` and arrives as
 * `PoolExhaustedError`, so a plainly repairable missing relation propagates and ends
 * the run; `Connection terminated unexpectedly` matches nothing, falls through to the
 * base class, and is offered to the model as a statement it could rewrite (bounded at
 * three attempts). Neither is a boundary failure — nothing runs that should not — and
 * neither is fixable here: the misreading happens before this layer sees the error.
 * Same root cause as `docs/BACKLOG.md` B4, which is where a real fix belongs.
 *
 * FOR T7, second: an error that PROPAGATES from this layer carries the driver's own
 * text unfenced, because it is an exception handed to server code rather than prompt
 * text. Anything that later renders one toward a model owes it `fenceUntrustedContent`,
 * which is otherwise applied to every engine message this module emits.
 */
const ENVIRONMENT_FAILURES = [ConnectionError, PoolExhaustedError, DatabaseConfigError] as const;

/**
 * A failure the STATEMENT caused, which a rewrite may fix.
 *
 * Only ever consulted for a QUERY-phase failure; see `runStatement` for why the
 * acquisition phase needs no predicate at all.
 *
 * Classified BY EXCLUSION rather than by naming the repairable classes, and that is
 * the load-bearing part. `mapDatabaseError` is what every profiled provider routes a
 * driver error through, and its fall-through is the BASE `DatabaseError`
 * (`errors.ts:332`) — so an enumeration of `QueryError | TimeoutError` missed the most
 * canonical repairable failure of all: `no such table: ordrs` on SQLite, and
 * PostgreSQL's `operator does not exist`, `invalid input syntax for type …`,
 * `function … does not exist` and `division by zero`. Each of those escaped this
 * layer as a raw throw instead of becoming a repairable refusal, which killed the
 * repair loop for exactly the errors it exists to serve.
 *
 * Exclusion also fails in the right direction as `mapDatabaseError` grows: a new
 * message pattern that lands on the base class is treated as the model's problem and
 * offered a repair, rather than crashing the run. A new ENVIRONMENT class has to be
 * added to the list above; the reflective test that walks the error module's exports
 * forces that decision to be recorded, though it cannot judge whether the recorded
 * answer is right — it says so itself.
 *
 * `ExecutionProfileError` needs no entry: it does not extend `DatabaseError` at all
 * (`errors.ts:177`), so it is outside this predicate by construction — and it is
 * raised during acquisition, which propagates everything anyway.
 */
function isStatementFailure(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError && !ENVIRONMENT_FAILURES.some((kind) => error instanceof kind);
}

/**
 * Acquires the provider and runs the one statement the pipeline allowed.
 *
 * The acquisition sits INSIDE this callback deliberately: `executeAuditedOperation`
 * only invokes it on a plain allow, so a denial, an approval requirement, a deadline
 * refusal and a ledger refusal all leave the connection pool untouched. The cost is
 * that an acquisition failure is accounted as one executed statement and audited as
 * `agent_execution_failed` even though nothing ran — a statement out of
 * `maxStatementsPerRun` spent on a misconfiguration. That is the right trade and
 * should not be "fixed" by acquiring earlier: acquiring before the decision would
 * open a pool for every denied call, which is exactly what the spy-provider
 * invariant exists to forbid.
 */
async function runStatement(
  context: AgentToolContext,
  validatedInput: unknown,
  budget: ExecutionBudget,
  phase: { statementSent: boolean },
): Promise<QueryResult> {
  const provider = await context.acquireProvider(context.connection, AGENT_EXECUTION_PROFILE);
  if (typeof provider.queryReadOnly !== "function") {
    // Not a refusal: `acquireExecutionProfileProvider` already refuses such a
    // provider, so reaching here means the injected acquirer is not the profile
    // seam. That is a server fault and must be loud, never a model-visible outcome.
    //
    // Only the MISSING method is caught this loudly. The sibling fault — a provider
    // that has `queryReadOnly` but was not opened under the profile — is detected
    // inside the provider (`postgres.ts`, `sqlite.ts` both throw when the read-only
    // execution context is absent), which lands at the query phase and therefore
    // becomes a repairable database error that costs an attempt. Unreachable through
    // `acquireExecutionProfileProvider`, which sets that context for the profile it
    // was asked for, so it is a note rather than a second guard.
    throw new Error("agent tool layer: the acquired provider exposes no read-only execution path");
  }
  const { sql } = validatedInput as { readonly sql: string };
  // Set immediately before the statement leaves, and never reset. This flag is the
  // whole phase discriminator: anything that threw while we were still connecting
  // cannot be a statement the model could repair, whatever class it carries, so the
  // caller propagates it without consulting `isStatementFailure` at all. That is what
  // separates a wrong agent credential from `permission denied for table secrets`
  // without inspecting message text.
  phase.statementSent = true;
  return provider.queryReadOnly(sql, {
    statementTimeoutMs: budget.statementTimeoutMs,
    maxResultRows: budget.maxResultRows,
    maxResultBytes: budget.maxResultBytes,
  });
}

/**
 * Runs one canonical operation for this run, with every gate in front of it.
 *
 * Order matters and is the cheapest-and-most-certain first: the mode (no state to
 * read), the repair ledger (in-memory), the run deadline (a clock reading), then the
 * policy pipeline. Nothing acquires a provider until the pipeline has allowed the
 * call, so a refusal at any of these stages leaves the database untouched.
 */
export async function executeAgentOperation(
  context: AgentToolContext,
  request: AgentOperationRequest,
): Promise<AgentToolOutcome> {
  return runAuditedAgentCall(context, {
    operationId: request.operationId,
    // The statement IS the identity of a SQL call: two calls sending the same text
    // are the same call however the model worded its way to them.
    fingerprintSource: request.sql,
    input: { sql: request.sql },
    ...(request.label === undefined ? {} : { label: request.label }),
    ...(request.target === undefined ? {} : { target: request.target }),
    ...(request.grounding === undefined ? {} : { grounding: request.grounding }),
    invoke: (validatedInput, budget, phase) => runStatement(context, validatedInput, budget, phase),
  });
}

/**
 * What one audited agent call needs, whatever KIND of call it is.
 *
 * The two paths differ in three things and nothing else: what identifies the call to
 * the repair ledger, what `input` the pipeline validates against the descriptor, and
 * what the invoke callback does. Everything that makes the call safe — the mode
 * check, the ledger, the deadline admission and its audited refusal, the budget
 * clamp, the audited execution, the artifact — is written once here, because a
 * second copy of a gate order is a second thing that can be got wrong quietly.
 */
interface AuditedAgentCall {
  readonly operationId: AgentOperationId;
  /** Canonical text this call is identified by in the repair ledger. */
  readonly fingerprintSource: string;
  /** The input the DESCRIPTOR validates. `{sql}` for a statement, the selector for a curated read. */
  readonly input: unknown;
  readonly label?: string;
  readonly target?: { readonly catalog?: string; readonly schema?: string };
  /** The server's own grounding read. See `AgentOperationRequest.grounding`. */
  readonly grounding?: boolean;
  readonly invoke: (
    validatedInput: unknown,
    budget: ExecutionBudget,
    phase: { statementSent: boolean },
  ) => Promise<QueryResult>;
}

/**
 * A curated reading the run decided not to keep, raised from inside the invoke
 * callback because that is the only place the answer is known.
 *
 * A sentinel rather than a return value: `executeAuditedOperation` owns the callback's
 * result type, and there is no seam for a second outcome. Caught by the one catch
 * below and turned into the typed `reading-refused` refusal — the call was made and
 * the audit records an execution, so the step settles like every other reach that
 * happened.
 */
class AgentCuratedReadError extends Error {
  constructor(readonly reasonCode: AgentReadingDenyCode) {
    super(reasonCode);
    this.name = "AgentCuratedReadError";
  }
}

async function runAuditedAgentCall(context: AgentToolContext, call: AuditedAgentCall): Promise<AgentToolOutcome> {
  // Outside agent mode only a grounding read passes, and the flag is set by nothing
  // the model can reach: `selectAgentTools` still hands a planning run an empty tool
  // set, so no dispatch of a model's tool call ever arrives here with it.
  if (context.mode !== "agent" && call.grounding !== true) return unavailable("MODE_HAS_NO_TOOLS");

  const fingerprint = fingerprintStatement(call.fingerprintSource);
  const repairAdmission = context.repairs.admit(fingerprint);
  if (!repairAdmission.admitted) return unavailable(repairAdmission.reasonCode);

  const actor: ExecutionActor = { sessionId: context.actor.sessionId, role: context.actor.role, mode: "agent" };

  // The ceilings this run is bounded by, chosen by its OWN persisted workflow. Read
  // once here so that the deadline admission, the clamp and the denial text a model
  // reads can never come from three different rows.
  const workflowPolicy = AGENT_WORKFLOW_BUDGETS[context.workflowType].policy;

  const admission = context.deadline.admit({
    statementTimeoutMs: workflowPolicy.budgets.statementTimeoutMs,
    minimumMs: AGENT_MINIMUM_CALL_MS,
  });
  if (!admission.admitted) {
    auditDeadlineRefusal(context, actor, call.operationId, admission.reasonCode);
    return unavailable(admission.reasonCode);
  }

  // The clamp: the pipeline's own `effectiveBudget` becomes the clamped one, so the
  // execution profile cannot be handed a timeout larger than the run has left.
  const policy: ExecutionPolicy = {
    ...workflowPolicy,
    budgets: { ...workflowPolicy.budgets, statementTimeoutMs: admission.statementTimeoutMs },
  };

  // Which phase the invoke callback reached, read only on the failure path. A plain
  // mutable holder rather than a return value: the callback's result is the pipeline's
  // to shape, and on a throw there is no result to carry this in.
  const phase = { statementSent: false };

  let outcome: Awaited<ReturnType<typeof executeAuditedOperation<QueryResult>>>;
  try {
    outcome = await executeAuditedOperation<QueryResult>(
      {
        registry: context.registry,
        policy,
        actor,
        scope: context.scope,
        request: {
          operationId: call.operationId,
          target: { connectionId: context.scope.connectionId, ...call.target },
          input: call.input,
        },
        capabilities: context.capabilities,
      },
      {
        runId: context.runId,
        tracker: context.tracker,
        artifacts: context.artifacts,
        clock: context.clock,
      },
      ({ validatedInput, budget }) => call.invoke(validatedInput, budget, phase),
    );
  } catch (error) {
    // A curated reading the run chose not to keep. First, because it is a decision
    // this layer made about a call that DID happen — not an environment failure and
    // not a statement the model could repair.
    //
    // It settles the step as a REFUSAL rather than leaving it unattempted, and that is
    // the whole reason it is not an `unavailable` code: by the time it is raised the
    // pipeline has allowed the call, `beginExecution` has run, one statement of the
    // run's budget is spent and an `agent_operation` execution event is on the audit
    // stream — and for `READING_OVER_BUDGET` the provider method has actually run and
    // returned rows. A ledger that recorded that as "nothing was attempted" would tell
    // a resumed run, in the server's own voice, something the audit trail contradicts.
    //
    // The failure is recorded so the identical reading is not asked for twice, and it
    // costs no repair attempt: no rewording of the request would change the answer.
    if (error instanceof AgentCuratedReadError) {
      context.repairs.recordFailure(fingerprint, "reading-refused");
      return {
        kind: "refused",
        refusal: { class: "reading-refused", reasonCode: error.reasonCode },
        // The server's own words: nothing an engine wrote is in this sentence, so it
        // is not fenced.
        modelText: READING_REFUSAL_TEXT[error.reasonCode],
      };
    }
    // The phase gate comes FIRST and is unconditional. A failure raised before the
    // statement was sent — a wrong credential, an unreachable host, a refused
    // execution profile, or anything the pipeline itself threw — is the environment's,
    // so it propagates whatever class it carries and costs no repair attempt.
    if (!phase.statementSent || !isStatementFailure(error)) throw error;
    context.repairs.recordFailure(fingerprint, "database-error");
    return {
      kind: "refused",
      refusal: { class: "database-error", statementFingerprint: fingerprint, message: error.message },
      // The engine's own words: untrusted, so fenced. The fingerprint stands in for
      // a correlation id, which a failed execution never produced.
      modelText: fenceUntrustedContent(error.message, {
        label: "database error",
        operationId: call.operationId,
        reference: fingerprint,
      }),
    };
  }

  if (outcome.kind === "denied") {
    const { decision } = outcome;
    if (decision.kind === "deny") {
      context.repairs.recordFailure(fingerprint, "policy-denied");
      return {
        kind: "refused",
        refusal: { class: "policy-denied", reasonCode: decision.reasonCode },
        modelText: denialText(decision.reasonCode, policy.version),
      };
    }
    context.repairs.recordFailure(fingerprint, "approval-required");
    return {
      kind: "refused",
      refusal: { class: "approval-required", operationId: decision.operationId },
      modelText: approvalText(decision.operationId),
    };
  }

  const { result } = outcome;
  // NOTE for whatever renders a run: `summary.columnNames` is engine-supplied text
  // and is NOT fenced — it is a durable record field, not prompt text. Anything that
  // later puts an artifact summary INTO a prompt owes it the same fence the rows get.
  const artifact: AgentArtifactReference = {
    correlationId: outcome.correlationId,
    runId: context.runId,
    operationId: outcome.decision.operationId,
    summary: {
      rowCount: result.rowCount,
      // Copied: the durable reference must not alias a provider's own array.
      columnNames: [...result.fields],
      elapsedMs: result.executionTime,
    },
  };
  return {
    kind: "completed",
    artifact,
    // The handover sentence comes FIRST, in the server's own voice, before the
    // fence (#350). This is the moment the id changes hands, and it is where the
    // model needs the form: the live runs that failed were HOLDING the correlation
    // id and still never produced the object, so naming an id is demonstrably not
    // the same as saying how to cite it. The id is a server-minted UUID, so nothing
    // untrusted is spliced into this sentence.
    modelText: `${handoverText(artifact.correlationId)}\n${fenceUntrustedContent(renderRows(result.rows), {
      label: `${call.label ?? "result"}, ${result.rowCount} row(s)`,
      operationId: artifact.operationId,
      reference: artifact.correlationId,
    })}`,
  };
}

/** What a completed reach says about the artifact it just produced. */
export const handoverText = (correlationId: string): string =>
  `Stored as artifact ${correlationId}. To use it in a claim, cite it as ${citeArtifact(correlationId)}.`;

// ============================================================================
// The four tools
// ============================================================================

/** Trimmed, but a blank stays blank so the composer refuses it rather than ignoring it. */
function normalizeSelector(input: {
  readonly kind?: AgentCatalogKind;
  readonly schema?: string;
  readonly table?: string;
}) {
  return {
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.schema === undefined ? {} : { schema: input.schema.trim() }),
    ...(input.table === undefined ? {} : { table: input.table.trim() }),
  };
}

/** What each inventory is called in the untrusted-content header the model reads. */
const CATALOG_LABELS: Readonly<Record<AgentCatalogKind, string>> = Object.freeze({
  columns: "schema inventory",
  relations: "foreign-key inventory",
  indexes: "index inventory",
  // The word "estimated" is part of the label rather than of the surrounding prose
  // because this header is what the model reads the rows under: every number below
  // it is the engine's own estimate, which may be stale or absent entirely.
  // `catalogSelectorSchema` does not offer this kind to the model — the statistics
  // read is composed server-side while a run establishes its context — so the label
  // is here to keep the record total, not because a tool call can reach it today.
  statistics: "estimated statistics inventory",
});

/**
 * The schema name to DECLARE as the policy target, given what the composer accepted.
 *
 * Only SQLite needs the fold: `main` is its whole schema set and the composer matches
 * it case-insensitively, so the canonical spelling is the one a scope allowlist can be
 * written against. PostgreSQL is left exactly as supplied — `information_schema`
 * compares `table_schema` case-sensitively, so folding it would declare a target that
 * is not the one the composed statement reads.
 */
function normalizeDeclaredSchema(context: AgentToolContext, schema: string): string {
  return context.connection.type === "sqlite" ? schema.toLowerCase() : schema;
}

/**
 * Parses a tool's arguments against the schema the tool DECLARES, so the declaration
 * is load-bearing rather than advisory.
 *
 * A caller is expected to have validated already — an SDK enforces the declared
 * schema before invoking a tool — but "expected to" is not a guarantee, and these
 * arguments originate from a model. Without this, a non-string selector reached
 * `.trim()` and left the tool as a raw `TypeError` instead of a typed outcome. The
 * failure returns the same `INVALID_TOOL_INPUT` as a composition refusal: from the
 * model's side both mean "these arguments cannot become a statement".
 */
function parseToolInput<T>(schema: z.ZodType<T>, input: unknown): { ok: true; value: T } | { ok: false } {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/**
 * Turns a composition refusal into a tool outcome.
 *
 * Only the closed reason CODE reaches the model, never the composer's message: that
 * message interpolates the selector the model supplied, and echoing model text back
 * inside a server-authored sentence is the habit that makes provenance unreadable.
 */
function composedSqlOutcome(error: unknown): AgentToolOutcome {
  if (error instanceof AgentComposedSqlError) return unavailable("INVALID_TOOL_INPUT", error.reasonCode);
  throw error;
}

/**
 * The catalog inspection. Per planning decision P1 this IS the canonical bounded
 * read — the server composes the statement, so no fourth operation descriptor is
 * needed and the reach is audited exactly like every other one.
 *
 * The two engines answer differently, and the difference is real rather than
 * cosmetic: PostgreSQL returns a structured column inventory from
 * `information_schema`, while SQLite returns each object's own DDL text from
 * `sqlite_master`, because the guard refuses the `pragma_*` table-valued functions
 * that would give SQLite a structured column list (see `composed-sql.ts`).
 */
export async function inspectSchemaTool(
  context: AgentToolContext,
  input: { readonly kind?: AgentCatalogKind; readonly schema?: string; readonly table?: string },
): Promise<AgentToolOutcome> {
  return readCatalog(context, catalogSelectorSchema, input, false);
}

/**
 * The same catalog read, taken by the SERVER while it establishes a run's context.
 *
 * Two things separate it from the tool above and nothing else does: it accepts the
 * `statistics` kind the model is not offered, and it is marked as a grounding read so
 * the mode gate admits it in planning mode — where the model still has no tools and
 * still sends nothing. Everything that makes the call safe is the same code path.
 *
 * A named function rather than a flag threaded through `inspectSchemaTool`, because
 * the model's tool dispatch calls that one by name: an option there could be set by a
 * future caller wiring the dispatch through, and this cannot be reached from it at
 * all.
 */
export async function readCatalogForGrounding(
  context: AgentToolContext,
  input: { readonly kind?: AgentCatalogKind; readonly schema?: string; readonly table?: string },
): Promise<AgentToolOutcome> {
  return readCatalog(context, groundingSelectorSchema, input, true);
}

/**
 * The provider schema read overran the time this call was granted.
 *
 * A sentinel rather than a refusal code, for the same reason `AgentCuratedReadError`
 * is one: `executeAuditedOperation` owns the invoke callback's result type and there
 * is no seam for a second outcome. It is raised INSIDE the callback, propagates
 * through the audited pipeline untouched — it is not a `DatabaseError`, so the phase
 * gate rethrows it rather than offering the model a repair — and is caught by the one
 * function below.
 */
class AgentSchemaReadTimeout extends Error {
  constructor(readonly grantedMs: number) {
    super(`the provider schema read did not answer within ${grantedMs}ms`);
    this.name = "AgentSchemaReadTimeout";
  }
}

/**
 * What the server's provider schema read produced. `tables` is the inventory itself.
 *
 * No artifact reference travels with it, and that is not an oversight: the artifact is
 * still produced, still lands in the run's store and still reaches the audit stream, so
 * the call is as citable as any other. What the CALLER does with the reading is build a
 * snapshot from the structure, and it has no use for a handle to a projection of it.
 */
export type AgentProviderSchemaRead =
  | { readonly kind: "completed"; readonly tables: readonly TableSchema[] }
  | { readonly kind: "timed-out"; readonly grantedMs: number }
  | { readonly kind: "unavailable"; readonly modelText: string };

/**
 * The ENGINE'S OWN schema inspection, taken by the server while it grounds a run
 * (#414) — the same reading the sidebar performs when it lists your tables.
 *
 * The sibling of `readCatalogForGrounding`, for the engines that one cannot serve.
 * A catalog read is a statement the server composes per dialect, and it is composed
 * for two of the eleven; everywhere else a run had no inventory at all and was told
 * so. This is the other reading the product already knows how to take, brought inside
 * the same pipeline rather than called beside it: `runAuditedAgentCall` applies the
 * mode check, the repair ledger, the deadline admission, the budget clamp, the
 * audited execution and the artifact exactly as it does for every statement, so there
 * is still no second, unaudited path to an engine — which is the objection
 * `context-snapshot.ts`'s own docblock opens with.
 *
 * **It acquires `AGENT_OPERATIONS_PROFILE`, and that is not interchangeable with the
 * read-only one.** `agent-read-only` sets `requiresReadOnlyStatements: true`, and
 * `factory.ts` refuses acquisition outright for a provider with no `queryReadOnly` —
 * which is every engine this function exists to reach. Acquired under that profile
 * this call would throw `PROFILE_UNSUPPORTED_BY_PROVIDER` before it ever reached a
 * provider, on all nine. The operations profile is the honest one here for the same
 * reason `runCuratedRead` takes it: no statement is sent that an engine has to plan,
 * so there is no statement for a read-only transaction to bound.
 *
 * **It returns the `TableSchema[]` itself.** The artifact carries a model-facing
 * PROJECTION — one row per table: its name, how many columns, how many indexes — so
 * the call is citable and showable like any other reach, but the inventory does not
 * round-trip through it. The catalog path deliberately does the opposite, reading its
 * rows back out of the artifact store, and the difference is not inconsistency: there
 * the rows ARE the reading, so a released artifact must yield no snapshot rather than
 * a reconstruction from model-facing text. Here the provider handed back a structure,
 * there is no text to reconstruct from, and a round trip through the store would only
 * introduce a way to lose it.
 */
export async function readProviderSchemaForGrounding(context: AgentToolContext): Promise<AgentProviderSchemaRead> {
  let tables: readonly TableSchema[] = [];

  let outcome: AgentToolOutcome;
  try {
    outcome = await runAuditedAgentCall(context, {
      operationId: "db.schema.read",
      // The connection IS the identity of this call: it takes no input, so two
      // requests for it on one run are the same request and the repair ledger should
      // say so rather than admitting the second as a fresh attempt.
      fingerprintSource: `schema:${context.connection.id}`,
      input: {},
      label: "provider schema inventory",
      grounding: true,
      invoke: async (_validatedInput, budget, phase) => {
        // No "can this provider describe itself" check, deliberately: `getSchema()` is
        // a REQUIRED member of `DatabaseProvider`, so every provider `acquireProvider`
        // can return has one, and a guard for its absence would be a refusal code, a
        // sentence and a headline for a state that cannot occur. What CAN happen is a
        // `getSchema()` that rejects, and that is the case handled below.
        const provider = await context.acquireProvider(context.connection, AGENT_OPERATIONS_PROFILE);
        const startedAtMs = context.clock?.() ?? Date.now();
        // Set immediately before the call leaves, for the same reason the statement
        // path sets it: anything that threw while we were still connecting is not
        // something the model could have written differently.
        phase.statementSent = true;

        // HONEST LIMIT, stated because the alternative reading of this race is
        // wrong: `getSchema()` takes no budget on any provider, so what this bounds
        // is THE RUN and not the database. The driver call is not cancelled — it goes
        // on reading until the engine or the driver ends it — and this run simply
        // stops waiting for it. The clamp that reaches an engine on the statement
        // path (PostgreSQL's `SET LOCAL statement_timeout`) has no counterpart here.
        // Without the race there is no bound at all, which is the only worse answer.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const overran = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new AgentSchemaReadTimeout(budget.statementTimeoutMs)),
            budget.statementTimeoutMs,
          );
        });
        try {
          tables = await Promise.race([provider.getSchema(), overran]);
        } catch (error) {
          if (error instanceof AgentSchemaReadTimeout) throw error;
          // Same wrap as the curated path, for the same measured reason: these
          // provider methods do not map their driver's errors uniformly, so a raw
          // `MongoServerError` can reach this seam and would otherwise propagate out
          // of the tool layer and kill the run on the engines this exists to reach.
          throw asReadingFailure(error, context.connection.type);
        } finally {
          clearTimeout(timer);
        }

        const rows = tables.map((table) => ({
          table: table.name,
          columns: table.columns.length,
          indexes: table.indexes.length,
        }));
        return {
          rows,
          fields: ["table", "columns", "indexes"],
          rowCount: rows.length,
          executionTime: (context.clock?.() ?? Date.now()) - startedAtMs,
        };
      },
    });
  } catch (error) {
    if (error instanceof AgentSchemaReadTimeout) return { kind: "timed-out", grantedMs: error.grantedMs };
    throw error;
  }

  if (outcome.kind !== "completed") return { kind: "unavailable", modelText: outcome.modelText };
  return { kind: "completed", tables };
}

/**
 * One server-composed statement, taken as part of a run's grounding.
 *
 * The narrow companion to `readCatalogForGrounding`, for the one composed statement
 * that is not a catalog KIND: SQLite's `sqlite_stat1` availability probe, which has
 * to be its own statement because SQLite resolves table names at prepare time (see
 * `composeStatisticsAvailabilityProbe`). The caller composes it — this layer neither
 * accepts nor builds SQL from anything a model wrote — and the statement guard,
 * the policy pipeline and the audit stream are the same ones every other call meets.
 */
export async function readStatementForGrounding(
  context: AgentToolContext,
  request: { readonly sql: string; readonly label: string },
): Promise<AgentToolOutcome> {
  return executeAgentOperation(context, {
    operationId: "sql.query.read",
    sql: request.sql,
    label: request.label,
    grounding: true,
  });
}

async function readCatalog(
  context: AgentToolContext,
  selectorSchema: z.ZodType<{ kind?: AgentCatalogKind; schema?: string; table?: string }>,
  input: { readonly kind?: AgentCatalogKind; readonly schema?: string; readonly table?: string },
  grounding: boolean,
): Promise<AgentToolOutcome> {
  const parsed = parseToolInput(selectorSchema, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT");
  const selector = normalizeSelector(parsed.value);
  let sql: string;
  try {
    sql = composeCatalogRead(context.connection.type, selector);
  } catch (error) {
    return composedSqlOutcome(error);
  }
  return executeAgentOperation(context, {
    operationId: "sql.query.read",
    sql,
    grounding,
    label: CATALOG_LABELS[selector.kind ?? "columns"],
    // Declared, so a scope carrying a schema allowlist bounds which schema may be
    // inspected. A raw read cannot declare its schema, which is why an allowlist
    // denies one — `docs/BACKLOG.md` B3 records that consequence and the two ways to
    // resolve it; it is not worked around here.
    // The CATALOG dimension is never declared by any tool in this layer, so a scope
    // built with a catalog allowlist denies every call here: `withinAllowlist`
    // refuses an undeclared dimension. That fails closed, which is the right
    // direction, but a caller wanting catalog scoping needs this layer to grow a
    // selector for it rather than expecting these calls to pass.
    //
    // The NORMALIZED name is declared, not the model's spelling: the composer
    // accepts SQLite's `main` case-insensitively while `withinAllowlist` compares
    // case-sensitively, so declaring a raw `MAIN` would compose fine and then be
    // denied against a `["main"]` allowlist.
    ...(selector.schema === undefined ? {} : { target: { schema: normalizeDeclaredSchema(context, selector.schema) } }),
  });
}

/** One bounded read the model drafted. The statement guard is what bounds it. */
export async function runReadQueryTool(
  context: AgentToolContext,
  input: { readonly sql: string; readonly rationale?: string },
): Promise<AgentToolOutcome> {
  const parsed = parseToolInput(readStatementSchema, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT");
  return executeAgentOperation(context, { operationId: "sql.query.read", sql: parsed.value.sql, label: "read result" });
}

// ============================================================================
// The curated operational read
// ============================================================================

/** A date the engine reported, as text a prompt can carry. Absent stays absent. */
const instant = (value: Date | undefined): string | null => (value === undefined ? null : value.toISOString());

/**
 * One curated reading: the provider method that answers it, the columns it projects
 * to, and the name it is fenced under.
 *
 * The columns are DECLARED rather than derived from the first row, and that is what
 * makes the artifact a `QueryResult` a reader can trust: a reading that came back
 * empty still says what it would have contained, so `fields` is never a function of
 * whether the engine happened to have anything to report.
 *
 * `method` is named separately from `read` so a provider that does not actually carry
 * the method can be refused before it is called. Every provider DECLARES all six on
 * the interface, so this is the defensive case rather than the common one — but a
 * `TypeError` out of this layer would end a run, and the workflow's whole promise is
 * that an engine which cannot answer says so.
 *
 * `schemaColumn` is what makes the `schema` selector mean the same thing on every
 * engine. The provider methods are asked to narrow where their signature allows it,
 * but four of them take no options at all (`oracle.getTableStats`,
 * `mssql.getTableStats`, `mssql.getIndexStats`, `mongodb.getTableStats`), so a
 * narrowing that lived only in the arguments would be silently dropped on those
 * engines and the run would report another schema's tables as the one it asked for.
 * The reading therefore names the projected column its schema lives in, and the
 * caller applies the filter itself.
 */
interface CuratedReading {
  readonly label: string;
  readonly method: keyof DatabaseProvider;
  readonly fields: readonly string[];
  /** The projected column `input.schema` narrows on, or absent when the reading has no schema dimension. */
  readonly schemaColumn?: string;
  readonly read: (
    provider: DatabaseProvider,
    input: AgentCuratedReadInput,
    limit: number,
  ) => Promise<Record<string, unknown>[]>;
}

const CURATED_READINGS: Readonly<Record<CuratedOperationKind, CuratedReading>> = Object.freeze({
  sessions: {
    label: "active sessions",
    method: "getActiveSessions",
    fields: [
      "pid",
      "user",
      "database",
      "applicationName",
      "clientAddr",
      "state",
      "query",
      "duration",
      "durationMs",
      "waitEventType",
      "waitEvent",
      "blocked",
    ],
    read: async (provider, _input, limit) =>
      (await provider.getActiveSessions({ limit })).map((session) => ({
        pid: session.pid,
        user: session.user,
        database: session.database,
        applicationName: session.applicationName ?? null,
        clientAddr: session.clientAddr ?? null,
        state: session.state,
        query: session.query,
        duration: session.duration,
        durationMs: session.durationMs,
        waitEventType: session.waitEventType ?? null,
        waitEvent: session.waitEvent ?? null,
        blocked: session.blocked ?? false,
      })),
  },
  "slow-queries": {
    label: "slow queries",
    method: "getSlowQueries",
    fields: ["queryId", "query", "calls", "totalTime", "avgTime", "minTime", "maxTime", "rows"],
    read: async (provider, _input, limit) =>
      (await provider.getSlowQueries({ limit })).map((entry) => ({
        queryId: entry.queryId ?? null,
        query: entry.query,
        calls: entry.calls,
        totalTime: entry.totalTime,
        avgTime: entry.avgTime,
        minTime: entry.minTime ?? null,
        maxTime: entry.maxTime ?? null,
        rows: entry.rows,
      })),
  },
  "table-stats": {
    label: "table statistics",
    method: "getTableStats",
    schemaColumn: "schemaName",
    fields: [
      "schemaName",
      "tableName",
      "rowCount",
      "deadRowCount",
      "tableSize",
      "tableSizeBytes",
      "indexSizeBytes",
      "totalSizeBytes",
      "lastVacuum",
      "lastAnalyze",
      "bloatRatio",
    ],
    read: async (provider, input) =>
      (await provider.getTableStats(input.schema === undefined ? {} : { schema: input.schema })).map((table) => ({
        schemaName: table.schemaName,
        tableName: table.tableName,
        rowCount: table.rowCount,
        deadRowCount: table.deadRowCount ?? null,
        tableSize: table.tableSize,
        tableSizeBytes: table.tableSizeBytes,
        indexSizeBytes: table.indexSizeBytes ?? null,
        totalSizeBytes: table.totalSizeBytes,
        lastVacuum: instant(table.lastVacuum),
        lastAnalyze: instant(table.lastAnalyze),
        bloatRatio: table.bloatRatio ?? null,
      })),
  },
  "index-stats": {
    label: "index statistics",
    method: "getIndexStats",
    schemaColumn: "schemaName",
    fields: [
      "schemaName",
      "tableName",
      "indexName",
      "indexType",
      "columns",
      "isUnique",
      "isPrimary",
      "indexSizeBytes",
      "scans",
      "usageRatio",
    ],
    read: async (provider, input) =>
      (await provider.getIndexStats(input.schema === undefined ? {} : { schema: input.schema })).map((index) => ({
        schemaName: index.schemaName,
        tableName: index.tableName,
        indexName: index.indexName,
        indexType: index.indexType ?? null,
        columns: index.columns.join(", "),
        isUnique: index.isUnique,
        isPrimary: index.isPrimary,
        indexSizeBytes: index.indexSizeBytes,
        scans: index.scans,
        usageRatio: index.usageRatio ?? null,
      })),
  },
  storage: {
    label: "storage",
    method: "getStorageStats",
    fields: ["name", "location", "size", "sizeBytes", "usagePercent", "walSizeBytes"],
    read: async (provider) =>
      (await provider.getStorageStats()).map((store) => ({
        name: store.name,
        location: store.location ?? null,
        size: store.size,
        sizeBytes: store.sizeBytes,
        usagePercent: store.usagePercent ?? null,
        walSizeBytes: store.walSizeBytes ?? null,
      })),
  },
  health: {
    label: "health",
    method: "getHealth",
    // The scalar figures only. `HealthInfo` also nests its own slow-query and session
    // lists, and those are the two readings that have their own kind — projecting them
    // here as well would give one fact two shapes and two ways to be cited.
    fields: ["activeConnections", "databaseSize", "cacheHitRatio", "slowQueryCount", "activeSessionCount"],
    read: async (provider) => {
      const health = await provider.getHealth();
      return [
        {
          activeConnections: health.activeConnections,
          databaseSize: health.databaseSize,
          cacheHitRatio: health.cacheHitRatio,
          slowQueryCount: health.slowQueries.length,
          activeSessionCount: health.activeSessions.length,
        },
      ];
    },
  },
} satisfies Record<CuratedOperationKind, CuratedReading>);

/**
 * Calls the one curated method the reading names and projects what it returns.
 *
 * HONEST LIMIT, and it is a real weakening of this run's bounds rather than an
 * oversight: `budget.statementTimeoutMs` cannot be enforced here. On the SQL path it
 * becomes PostgreSQL's `SET LOCAL statement_timeout`, because a statement is what is
 * being sent; `getSlowQueries(options?: {limit?})` and its five siblings take no
 * budget at all, so the deadline's clamp is ADVISORY on this path. What still binds
 * is everything else: the run deadline decides whether the call is admitted, the
 * statement budget counts it, and the row and byte caps are applied below by this
 * projection instead of by the engine. A reading that is still too LARGE once it has
 * been narrowed is REFUSED rather than truncated, which is the same promise the read
 * path makes — a delivered result is a complete one.
 *
 * `limit` and `schema` are applied HERE, to the projected rows, and not merely passed
 * to the provider. That is not defensive duplication: only `getActiveSessions` and
 * `getSlowQueries` take a limit at all, and four of the curated methods take no
 * options whatsoever, so a selector honoured only in the arguments would be a promise
 * the tool description makes and half the engines silently break. Narrowing before
 * bounding, because a limit applied to the wrong schema's rows answers a question
 * nobody asked.
 */
async function runCuratedRead(
  context: AgentToolContext,
  validatedInput: unknown,
  budget: ExecutionBudget,
  phase: { statementSent: boolean },
): Promise<QueryResult> {
  const input = validatedInput as AgentCuratedReadInput;
  const reading = CURATED_READINGS[input.kind];
  const provider = await context.acquireProvider(context.connection, AGENT_OPERATIONS_PROFILE);
  if (typeof provider[reading.method] !== "function") {
    throw new AgentCuratedReadError("KIND_UNSUPPORTED_BY_PROVIDER");
  }

  const limit = Math.min(input.limit ?? budget.maxResultRows, budget.maxResultRows);
  const startedAtMs = context.clock?.() ?? Date.now();
  // Set immediately before the call leaves, for the same reason the statement path
  // sets it: anything that threw while we were still connecting is not the model's.
  phase.statementSent = true;

  let read: Record<string, unknown>[];
  try {
    read = await reading.read(provider, input, limit);
  } catch (error) {
    throw asReadingFailure(error, context.connection.type);
  }

  const narrowed =
    reading.schemaColumn === undefined || input.schema === undefined
      ? read
      : read.filter((row) => row[reading.schemaColumn as string] === input.schema);
  const rows = narrowed.slice(0, limit);

  if (JSON.stringify(rows).length > budget.maxResultBytes) {
    throw new AgentCuratedReadError("READING_OVER_BUDGET");
  }

  return {
    rows,
    fields: [...reading.fields],
    rowCount: rows.length,
    executionTime: (context.clock?.() ?? Date.now()) - startedAtMs,
  };
}

/**
 * A curated method's failure, in a class this layer's routing understands.
 *
 * The SQL path can rely on providers mapping their driver's errors: `queryReadOnly`
 * is implemented on two providers and both wrap what the driver throws. The curated
 * methods do NOT map uniformly — `mongodb.getTableStats` and `getIndexStats` call
 * `listCollections().toArray()` outside any try/catch, and several providers'
 * `ensureConnected` does the same — so a `MongoServerError` or a driver's own
 * `TypeError` can reach this seam raw. Without this, `isStatementFailure` would
 * answer false, the error would propagate out of the tool layer, and the run would be
 * classified `internal` and DIE, on exactly the engines this workflow exists to
 * reach.
 *
 * A `DatabaseError` is passed through untouched, whichever kind it is: the routing
 * above already separates an environment failure (connection, pool, config) from a
 * statement failure, and re-wrapping would destroy that distinction. Everything else
 * becomes a `QueryError` carrying the thrown value's own text, which then travels the
 * ordinary repairable path — fenced, on the ledger, and leaving the model free to ask
 * for a different kind.
 */
function asReadingFailure(error: unknown, provider: DatabaseConnection["type"]): unknown {
  if (error instanceof DatabaseError) return error;
  return new QueryError(error instanceof Error ? error.message : String(error), provider);
}

/**
 * The operational reading: what the engine says about itself, right now.
 *
 * The one agent tool that sends no statement, which is exactly why it runs where the
 * others cannot. It reaches the database through the same audited pipeline as every
 * other tool — same registry, same policy, same budget tracker, same artifact store —
 * so its result is citable, showable and counted like any other, and an operator sees
 * it in the audit stream under its own operation id.
 */
export async function inspectOperationsTool(context: AgentToolContext, input: unknown): Promise<AgentToolOutcome> {
  const parsed = parseToolInput(agentCuratedReadInput, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT");
  const selector = parsed.value;
  return runAuditedAgentCall(context, {
    operationId: "db.operations.read",
    // The reading, not a statement — canonical so that two identical requests are one
    // call to the repair ledger however the model ordered its arguments.
    fingerprintSource: `operations:${selector.kind}:${selector.limit ?? ""}:${selector.schema ?? ""}`,
    input: selector,
    label: CURATED_READINGS[selector.kind].label,
    invoke: (validatedInput, budget, phase) => runCuratedRead(context, validatedInput, budget, phase),
    ...(selector.schema === undefined ? {} : { target: { schema: selector.schema } }),
  });
}

/**
 * The ESTIMATING plan inspection, and only that one. The executing variant is a
 * separate, approval-gated descriptor and no tool reaches it.
 */
export async function inspectPlanTool(
  context: AgentToolContext,
  input: { readonly sql: string },
): Promise<AgentToolOutcome> {
  const parsed = parseToolInput(planStatementSchema, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT");
  let sql: string;
  try {
    sql = composeEstimatingExplain(context.connection.type, parsed.value.sql);
  } catch (error) {
    return composedSqlOutcome(error);
  }
  return executeAgentOperation(context, { operationId: "sql.explain.estimate", sql, label: "query plan" });
}

/**
 * Composes the run's report. Reaches no database at all.
 *
 * Its job is to REFUSE, not to format: every evidence reference is checked against
 * the run's own event log, so a claim citing an artifact the run never read — or a
 * schema snapshot it never captured — cannot be composed. A report is only worth
 * anything if its citations are the run's, and the model is the one thing here that
 * can invent a correlation id.
 */
/**
 * A run's own estimating plans, joined to the statements that produced them.
 *
 * Both halves come from the ledger: `tool-completed` says which artifact a step
 * produced and under which operation, and `statement-drafted` says what that step
 * asked. Nothing here is supplied by the model, which is the point — a comparison
 * whose sides the model labelled could attribute a plan to a statement that never
 * produced it, and the whole before/after claim rests on that not happening.
 */
function estimatedPlansOf(events: readonly AgentRunEvent[]): ReadonlyMap<string, { stepId: string; sql: string }> {
  const sqlByStep = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "statement-drafted") sqlByStep.set(event.stepId, event.sql);
  }
  const plans = new Map<string, { stepId: string; sql: string }>();
  for (const event of events) {
    if (event.kind !== "tool-completed" || event.artifact.operationId !== "sql.explain.estimate") continue;
    const sql = sqlByStep.get(event.stepId);
    if (sql !== undefined) plans.set(event.artifact.correlationId, { stepId: event.stepId, sql });
  }
  return plans;
}

/**
 * Reads one side of a comparison: the run's own plan, summarised by the server.
 *
 * Two refusals and they mean different things. A correlation id that is not an
 * estimating plan of this run is `UNVERIFIABLE_PLAN` — the model cited something
 * else. One that IS this run's but whose rows are gone is `PLAN_RESULT_RELEASED`:
 * the citation was honest and the evidence has simply expired, which is a different
 * thing to tell a model, and telling it the first would send it looking for a
 * mistake it did not make.
 */
function readPlanSide(
  context: AgentToolContext,
  plans: ReadonlyMap<string, { stepId: string; sql: string }>,
  correlationId: string,
): AgentPlanSide | AgentToolUnavailableCode {
  const plan = plans.get(correlationId);
  if (plan === undefined) return "UNVERIFIABLE_PLAN";
  const stored = context.artifacts.get(correlationId, (context.clock ?? Date.now)());
  if (stored === undefined) return "PLAN_RESULT_RELEASED";
  return {
    correlationId,
    sql: plan.sql,
    summary: summarisePlan(context.capabilities.explainFormat, stored.value.rows),
  };
}

/**
 * The findings, in the server's own words.
 *
 * A column NAME is untrusted database content, so it is fenced rather than spliced
 * into a sentence the model would read as the server speaking. The finding codes
 * and the counts are this repository's own.
 */
function describeFindings(findings: readonly AgentProfileFinding[]): string {
  if (findings.length === 0) return "Nothing crossed a finding threshold.";
  return fenceUntrustedContent(
    findings.map((finding) => `${finding.column}: ${finding.code} — ${finding.detail}`).join("\n"),
    { label: `${findings.length} profile finding(s)`, operationId: "sql.table.profile", reference: "server-derived" },
  );
}

/**
 * The table the run already inventoried, found by the name the model gave.
 *
 * Matched against the snapshot's own naming, which differs by engine: PostgreSQL
 * qualifies as `schema.table`, SQLite does not. A model that names either form of
 * a table it has seen is answered; one that names a table the run never captured
 * is refused rather than sent to the database on a guess.
 */
/**
 * A table the run inventoried, and the schema/table pair the RESOLUTION produced.
 *
 * The pair matters as much as the entry. An earlier version composed from the
 * model's own spelling, so an unqualified `orders` that resolved to `sales.orders`
 * composed `FROM "orders"` — leaving PostgreSQL's `search_path` to decide which
 * relation was actually read while the ledger said `sales.orders` had been
 * profiled. Found by review on #345; the profile now targets what it resolved.
 */
interface ResolvedProfileTarget {
  readonly entry: TableSchema;
  readonly schema?: string;
  readonly table: string;
}

function inventoriedTable(
  snapshot: AgentContextSnapshot,
  schema: string | undefined,
  table: string,
): ResolvedProfileTarget | null {
  if (schema !== undefined) {
    // A schema was named, so it is part of the answer. Matching a BARE inventory
    // entry here would accept `{schema: "other", table: "orders"}` against SQLite's
    // unqualified `orders` and then target `other.orders` — a table the run never
    // inventoried. Found by review on #345.
    const entry = snapshot.tables.find((candidate) => candidate.name === `${schema}.${table}`);
    return entry === undefined ? null : { entry, schema, table };
  }

  const bare = snapshot.tables.find((candidate) => candidate.name === table);
  if (bare !== undefined) return { entry: bare, table };

  // An unqualified name against a qualified inventory. PostgreSQL's capture names
  // tables `schema.table` and SQLite's does not, so a model that has read either
  // inventory may reasonably name a table without its schema. Resolved only when
  // exactly ONE table ends that way: two schemas holding the same table name is
  // precisely when a guess would profile the wrong one.
  const suffix = `.${table}`;
  const matches = snapshot.tables.filter((candidate) => candidate.name.endsWith(suffix));
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only === undefined) return null;
  // Derived by removing the suffix rather than by splitting on a dot: exact, and it
  // cannot misread a name that carries one.
  return { entry: only, schema: only.name.slice(0, only.name.length - suffix.length), table };
}

/**
 * The most recent inventory this run captured, read off its own ledger.
 *
 * The LAST one, because a run may capture more than once and the newest is the one
 * its later statements were drafted against.
 */
function capturedSnapshot(events: readonly AgentRunEvent[]): AgentContextSnapshot | null {
  let snapshot: AgentContextSnapshot | null = null;
  for (const event of events) {
    if (event.kind === "context-captured" && event.snapshot !== undefined) snapshot = event.snapshot;
  }
  return snapshot;
}

/**
 * Bounded per-table profiling.
 *
 * The one tool here whose statement is composed from the RUN'S OWN inventory rather
 * than from the model's arguments: the model names a table and a depth, and the
 * server decides which columns that means and what to count. Everything the profile
 * records is a count — `table-profile.ts` says why, and it is what makes profiling a
 * table of personal data acceptable at all.
 */
/**
 * Everything the run loop needs to give a profile a durable step identity, decided
 * before anything is executed.
 *
 * Split out of the tool because the step id has to be derived from the RESOLVED
 * target rather than from the model's spelling — two different requests naming the
 * same table are the same profile, and must settle as one step.
 */
export interface AgentProfilePlan {
  readonly sql: string;
  readonly target: ResolvedProfileTarget;
  readonly depth: AgentProfileDepth;
  readonly columns: readonly ColumnSchema[];
  /** Where in the table's column list this batch starts. */
  readonly from: number;
  /** Columns beyond this batch, so nothing silently claims to have covered them. */
  readonly remaining: number;
}

export type AgentProfilePlanOutcome =
  | { readonly kind: "planned"; readonly plan: AgentProfilePlan }
  | { readonly kind: "unavailable"; readonly reasonCode: AgentToolUnavailableCode; readonly modelText: string };

/** Resolves and composes, and reaches nothing. */
export function planTableProfile(
  context: AgentToolContext,
  run: Pick<AgentRunRecord, "runId" | "events">,
  input: unknown,
): AgentProfilePlanOutcome {
  if (context.mode !== "agent") return unavailable("MODE_HAS_NO_TOOLS");
  if (run.runId !== context.runId) {
    throw new Error("agent tool layer: the profile's run record does not belong to this run");
  }

  const parsed = parseToolInput(profileSelectorSchema, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT");

  const snapshot = capturedSnapshot(run.events);
  const target = snapshot === null ? null : inventoriedTable(snapshot, parsed.value.schema, parsed.value.table);
  if (target === null) return unavailable("TABLE_NOT_INVENTORIED");

  const depth = parsed.value.depth ?? "basic";
  const from = parsed.value.fromColumn ?? 0;
  if (from >= target.entry.columns.length) return unavailable("NO_COLUMNS_AT_OFFSET");
  // Bounded because the composed statement grows with the column count. A wider
  // table is profiled in more than one call, and `fromColumn` is how the model asks
  // for the next batch — without it, columns past the first bound could never be
  // assessed while the run still counted as having profiled the table.
  const columns = target.entry.columns.slice(from, from + MAX_PROFILE_COLUMNS);

  try {
    // Composed from what was RESOLVED, never from what was asked for.
    return {
      kind: "planned",
      plan: {
        sql: composeTableProfile(context.connection.type, { ...target, depth }, columns),
        target,
        depth,
        columns,
        from,
        remaining: Math.max(0, target.entry.columns.length - (from + columns.length)),
      },
    };
  } catch (error) {
    return composedSqlOutcome(error) as AgentProfilePlanOutcome;
  }
}

export async function profileTableTool(
  context: AgentToolContext,
  plan: AgentProfilePlan,
): Promise<AgentTableProfileOutcome> {
  const { target, depth, columns } = plan;
  const outcome = await executeAgentOperation(context, {
    operationId: "sql.table.profile",
    sql: plan.sql,
    label: `profile of ${target.entry.name}`,
    ...(target.schema === undefined ? {} : { target: { schema: target.schema } }),
  });
  if (outcome.kind !== "completed") return outcome;
  const table = target.entry;

  const stored = context.artifacts.get(outcome.artifact.correlationId, (context.clock ?? Date.now)());
  const profile = stored === undefined ? null : readTableProfile(table.name, depth, columns, stored.value.rows);
  if (profile === null) return unavailable("PROFILE_UNREADABLE");

  // The inventory-derived finding rides along, so one profile is one complete
  // statement about the table rather than two half-statements.
  const findings = [...profile.findings, ...findUnindexedForeignKeys(table)];
  return {
    kind: "profiled",
    artifact: outcome.artifact,
    profile: { ...profile, findings },
    // The correlation id is named because a report has to be able to CITE this:
    // without it the assessment template could profile a table and then be unable
    // to compose a cited claim about it, which its own goal verifier requires.
    // Found by the scenario suite before any model saw it.
    // The table's own name is DATABASE CONTENT, so it is fenced rather than spliced
    // into a sentence the model reads as the server speaking. Found by review on
    // #345: an identifier is exactly as untrusted as a row value.
    modelText: [
      `Profiled a table: ${profile.rowCount} row(s), columns ${plan.from + 1}-${plan.from + columns.length} at ${depth} depth, ${findings.length} finding(s). ${handoverText(outcome.artifact.correlationId)}`,
      plan.remaining === 0
        ? "Every column of that table is covered."
        : `${plan.remaining} further column(s) are NOT covered by this profile; call profile_table again with fromColumn=${plan.from + columns.length} to reach them.`,
      "Only counts were read; no value was returned from any column.",
      fenceUntrustedContent(`table: ${table.name}`, {
        label: "profiled table name",
        operationId: "sql.table.profile",
        reference: outcome.artifact.correlationId,
      }),
      describeFindings(findings),
    ].join(" "),
  };
}

/**
 * The before/after comparison. Reaches no database: both plans were already read,
 * and this is the server stating what it sees in them.
 */
export function comparePlansTool(
  context: AgentToolContext,
  run: Pick<AgentRunRecord, "runId" | "events">,
  input: unknown,
): AgentPlanComparisonOutcome {
  if (context.mode !== "agent") return unavailable("MODE_HAS_NO_TOOLS");
  if (run.runId !== context.runId) {
    throw new Error("agent tool layer: the comparison's run record does not belong to this run");
  }

  const parsed = parseToolInput(planComparisonSchema, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT");
  // One plan cited as both sides is not a before and an after. Without this, a
  // comparison of a plan with itself records a valid `plan-comparison` and the goal
  // verifier marks the run answered on a single inspected plan — which defeats the
  // requirement the artifact exists to carry. Found by review on #344.
  if (parsed.value.before === parsed.value.after) return unavailable("IDENTICAL_PLANS");

  const plans = estimatedPlansOf(run.events);
  const before = readPlanSide(context, plans, parsed.value.before);
  if (typeof before === "string") return unavailable(before);
  const after = readPlanSide(context, plans, parsed.value.after);
  if (typeof after === "string") return unavailable(after);

  return {
    kind: "compared",
    before,
    after,
    // The server's own reading, in the server's own words. The plans themselves are
    // not echoed: they carry table and index names, which are untrusted input.
    modelText: `Plans compared: the first reaches its rows by ${before.summary.access}, the second by ${after.summary.access}. Both are estimates — nothing was executed.`,
  };
}

/**
 * A change the run proposes and does not make.
 *
 * Its evidence is checked against the run's own ledger exactly as a report claim's
 * is, and for the same reason: a recommendation nothing backs is one the model
 * invented. The statement itself is never executed by anything here — this tool
 * reaches no database, and no tool in this layer maps onto a write.
 */
export function recommendChangeTool(
  context: AgentToolContext,
  run: Pick<AgentRunRecord, "runId" | "events">,
  input: unknown,
): AgentRecommendationOutcome {
  if (context.mode !== "agent") return unavailable("MODE_HAS_NO_TOOLS");
  if (run.runId !== context.runId) {
    throw new Error("agent tool layer: the recommendation's run record does not belong to this run");
  }

  const parsed = parseToolInput(recommendationSchema, input);
  if (!parsed.ok) return invalidEvidenceInput();
  if (!matchesCard(parsed.value.change, parsed.value.statement)) {
    return unavailable("RECOMMENDATION_SHAPE_MISMATCH");
  }
  if (!parsed.value.evidence.every((reference) => verifiedAgainst(run.events, reference))) {
    return unavailable("UNVERIFIABLE_EVIDENCE");
  }

  return {
    kind: "recommended",
    recommendation: {
      change: parsed.value.change,
      statement: parsed.value.statement,
      rationale: parsed.value.rationale,
      // Carried by the schema's `.min(1)`, which the type system cannot see; an
      // unreachable emptiness guard would be a line no test could cover.
      evidence: parsed.value.evidence as [AgentEvidenceReference, ...AgentEvidenceReference[]],
    },
    modelText: `Recommendation recorded: one ${parsed.value.change}, offered to the user and not executed. It is theirs to apply.`,
  };
}

const CREATE_INDEX_STATEMENT = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i;

/**
 * Does the statement match the card it is offered under? Found by review on #344.
 *
 * The headline the rail renders — "Index recommended" — is the APP's own words, and
 * it has to be true. Without this, a model could file a `DROP TABLE` under an index
 * card, and the rail would assert the app's claim over it and offer the statement to
 * the user's editor. Nothing here executes anything, so this is not a security
 * boundary; it is the app refusing to say something it cannot support.
 *
 * The structural checks are the SHARED guard's rather than a second parser: one
 * determinate statement, no second statement after a terminator. `NON_READ_STATEMENT`
 * is the only violation an index card may carry, because a `CREATE INDEX` is by
 * definition not a read.
 */
function matchesCard(change: "index" | "rewrite", statement: string): boolean {
  const violation = inspectAgentStatement(statement);
  if (change === "rewrite") return violation === null;
  return (violation === null || violation === "NON_READ_STATEMENT") && CREATE_INDEX_STATEMENT.test(statement);
}

/**
 * The artifact this run produced under that id, or null.
 *
 * Both events that carry an artifact this run produced. A profile settles no step, so
 * it writes no `tool-completed`; omitting it here made a profile uncitable and its own
 * workflow's bar unreachable.
 *
 * The reference-checking rule lives HERE rather than being written twice, because
 * `present_answer` needs the artifact itself — its column names are what a chart spec
 * is checked against — while a citation only needs to know it exists. Two loops would
 * be two things to keep equal, and the one that drifted would be the one letting an
 * unproduced id through.
 */
function producedArtifact(events: readonly AgentRunEvent[], correlationId: string): AgentArtifactReference | null {
  for (const event of events) {
    const artifact = event.kind === "tool-completed" || event.kind === "table-profiled" ? event.artifact : null;
    if (artifact !== null && artifact.correlationId === correlationId) return artifact;
  }
  return null;
}

/**
 * The one operation whose result may be an ANSWER (#373 review).
 *
 * `producedArtifact` above asks "did this run produce that?", which is the right
 * question for a CITATION and the wrong one for an answer. A claim may rest on a plan
 * the run read — that is what `recommend_change` is built on — so narrowing that path
 * would make an honest report uncomposable. An answer is a different act: it nominates
 * one result as WHAT THE QUESTION ASKED FOR, hands its statement to the rail, and is
 * what `agent-data-analysis.1` counts. Without this, a run could present a
 * `sql.explain.estimate` artifact — the engine's DESCRIPTION of a statement, with no
 * data read, no rows and no measured duration — and satisfy the workflow's verdict
 * without ever having read the data it was opened to analyse.
 *
 * **A profile is excluded too, and that is a decision rather than a side effect.** A
 * profile IS a real reading of data, so the question is honest. Three things settle it:
 * it returns COUNTS the server composed from the run's own inventory rather than rows
 * the model asked for, so what would be shown is not an answer to the user's question
 * but an aggregate about a table; its statement is the server's, so there is nothing of
 * the model's to hand to an editor, which is why it could never have been presented
 * anyway (`statementBehind` returns null for it, and today that is the refusal it
 * gets); and its single aggregate row fails `CHART_TOO_FEW_ROWS` on every chart. So
 * admitting it would only change which refusal it is given — and the refusal it is
 * given now is the true one, which is the whole point of moving this check ahead of
 * the statement.
 *
 * The check goes BEFORE `statementBehind`, because a plan step DOES carry a drafted
 * statement: a check placed after it would have accepted the plan outright.
 *
 * One consequence, recorded rather than left to be discovered: the auto-execute gate's
 * first condition — "this run executed that exact statement" — can no longer FAIL from
 * this layer, because the only artifact presentable is a read whose own drafted
 * statement is by construction among `executedStatements`. Presenting a plan was the
 * one way to reach it. The condition stays in `auto-execute.ts` anyway: it is pure and
 * enumerated over every combination there, and a gate guarding an unbounded execution
 * path must not depend on which artifacts some other layer happens to admit.
 */
const ANSWER_OPERATION: AgentOperationId = "sql.query.read";

/** Does this reference name something the run actually produced? */
function verifiedAgainst(events: readonly AgentRunEvent[], reference: AgentEvidenceReference): boolean {
  if (reference.source === "artifact") return producedArtifact(events, reference.correlationId) !== null;
  return events.some((event) => event.kind === "context-captured" && event.fingerprint === reference.fingerprint);
}

/**
 * The statement behind one result, read from the ledger — never from the model.
 *
 * `tool-completed` says which step produced the artifact and `statement-drafted` says
 * what that step asked, which is the same join `compare_plans` makes. A result with no
 * drafted statement is a server-composed read (a catalog inspection, a profile): real
 * evidence, and nothing an answer could hand to an editor, so it is refused rather
 * than answered with someone else's SQL.
 */
function statementBehind(events: readonly AgentRunEvent[], correlationId: string): string | null {
  let stepId: string | null = null;
  for (const event of events) {
    if (event.kind === "tool-completed" && event.artifact.correlationId === correlationId) stepId = event.stepId;
  }
  if (stepId === null) return null;
  for (const event of events) {
    if (event.kind === "statement-drafted" && event.stepId === stepId) return event.sql;
  }
  return null;
}

/**
 * Is this column numeric in the rows that were actually delivered?
 *
 * The rule is `DataCharts.analyzeField`'s, to the letter: more than 80% of the
 * non-null values parse as numbers (`src/components/DataCharts.tsx`). That component
 * is what will draw the chart, so a stricter rule here would refuse specs that render
 * correctly and a looser one would admit the flat line of zeros `Number(value) || 0`
 * draws over a column of text. It is restated rather than imported because the
 * component is a client module that pulls a charting library into whatever imports it.
 */
function isNumericColumn(rows: readonly Record<string, unknown>[], column: string): boolean {
  const values = rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined);
  const numeric = values.filter(
    (value) => typeof value === "number" || (typeof value === "string" && !Number.isNaN(Number(value))),
  ).length;
  return numeric > values.length * 0.8;
}

/** The column-name refusal, listing the real names — engine text, so fenced. */
function chartColumnRefusal(artifact: AgentArtifactReference): AgentAnswerOutcome & { kind: "unavailable" } {
  const names = artifact.summary.columnNames;
  return {
    kind: "unavailable",
    reasonCode: "CHART_COLUMN_NOT_IN_RESULT",
    modelText: `${UNAVAILABLE_TEXT.CHART_COLUMN_NOT_IN_RESULT}\n${fenceUntrustedContent(names.join("\n"), {
      label: `the ${names.length} column name(s) of result ${artifact.correlationId}`,
      operationId: artifact.operationId,
      reference: artifact.correlationId,
    })}`,
  };
}

/**
 * The `verifiedAgainst` posture, one level down: a spec is refused unless every
 * column it names is a column the artifact actually has, and every value column holds
 * numbers in the rows that were delivered.
 *
 * The numeric half needs the ROWS, so it can only run while the run is live: the
 * artifact store is process memory released when the run ends, and `answer-composed`
 * is written during the run, which is why the rows are there to read. One instant
 * later they are not — and then the honest answer is `ANSWER_RESULT_RELEASED`, never
 * a spec that passed because there was nothing left to check it against.
 */
function refuseChartSpec(
  context: AgentToolContext,
  artifact: AgentArtifactReference,
  spec: AgentChartSpec,
): (AgentAnswerOutcome & { kind: "unavailable" }) | null {
  const columns = new Set(artifact.summary.columnNames);
  const named = [spec.x, ...spec.y];
  if (named.some((column) => !columns.has(column))) return chartColumnRefusal(artifact);
  if (artifact.summary.rowCount < 2) return unavailable("CHART_TOO_FEW_ROWS");
  if (spec.type === "pie" && spec.y.length !== 1) return unavailable("CHART_SHAPE_MISMATCH");

  const stored = context.artifacts.get(artifact.correlationId, (context.clock ?? Date.now)());
  if (stored === undefined) return unavailable("ANSWER_RESULT_RELEASED");
  if (!spec.y.every((column) => isNumericColumn(stored.value.rows, column))) {
    return unavailable("CHART_COLUMN_NOT_NUMERIC");
  }
  if (spec.type === "scatter" && !isNumericColumn(stored.value.rows, spec.x))
    return unavailable("CHART_SHAPE_MISMATCH");
  return null;
}

/**
 * The statements this run EXECUTED on its own bounded path, verbatim.
 *
 * Read-class results only, which is the whole of condition 1's content here: an
 * `inspect_plan` step carries a drafted statement too, and that statement was
 * described rather than run. Handing one over as though the run had measured it
 * would be auto-executing a statement whose row count, size and duration nobody has
 * ever seen — the exact case the condition exists for.
 *
 * A profile's statement is composed by the server from the run's own inventory and
 * is not the model's text, so it is not offered here either.
 */
function executedStatements(events: readonly AgentRunEvent[]): readonly string[] {
  const sqlByStep = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "statement-drafted") sqlByStep.set(event.stepId, event.sql);
  }
  const executed: string[] = [];
  for (const event of events) {
    if (event.kind !== "tool-completed" || event.artifact.operationId !== "sql.query.read") continue;
    const sql = sqlByStep.get(event.stepId);
    if (sql !== undefined) executed.push(sql);
  }
  return executed;
}

/**
 * The estimating plan this run holds for that exact statement, or nothing.
 *
 * The join is the ledger's, never the model's, exactly as `compare_plans` makes it:
 * `statement-drafted` says what a step asked and `tool-completed` says what it
 * produced. A plan of some other statement says nothing about this one.
 *
 * Where the run holds no plan — it never inspected one, or the store has released
 * its rows — the answer is nothing, and the gate reads nothing as risky. The run
 * can obtain one at the cost of one statement out of its budget by calling
 * `inspect_plan` before it answers, which is what the workflow's rules tell it to do
 * when the setting is on; a plan obtained HERE would be a statement executed with no
 * `tool-invoked` and no `tool-completed` behind it, and the ledger invariant is that
 * everything a run did is in its ledger.
 */
function heldPlanFor(context: AgentToolContext, events: readonly AgentRunEvent[], sql: string): AgentPlanSide | null {
  const plans = estimatedPlansOf(events);
  /*
    The one comment that is not trivia (#373 review).

    A statement carrying an optimizer directive takes no part in this join, on either
    side. Under `pg_hint_plan` a `+`-marked comment block is not a note about the
    statement, it is an instruction to the planner: the cheap indexed plan taken for
    the unhinted text says nothing about a statement whose hint forces a sequential
    scan, and the canonical form below normalises the difference away. So the gate
    would have passed condition 2 with a plan that is not the plan of the statement
    the editor will run — which is the whole of what condition 2 promises.

    Fixed HERE and deliberately not in `fingerprintStatement`. That function is the
    repair ledger's canonical identity and is consulted before EVERY statement, where
    treating a comment as trivia is not a bug but a bound: a model that re-sent a
    statement the ledger had already refused, with a comment added, would otherwise
    fingerprint differently and be admitted again. Making a directive significant
    there would widen "the same statement" for repair accounting in the one direction
    that layer exists to close. The join is the only place the distinction matters,
    so the distinction lives at the join.

    Refused rather than joined on the hint text. Joining would assert that the plan
    the run holds IS the hinted plan, and `inspect_plan` obtains that plan by sending
    the statement under an `EXPLAIN` prefix — whether `pg_hint_plan` still reads a
    hint from behind one is a property of an extension this repository does not ship,
    does not test against and cannot verify. The cost of refusing is that a hinted
    answer is placed in the editor unrun with the gate's own warning, which is what
    every other unweighable statement already gets.
  */
  if (hasOptimizerHint(sql)) return null;
  // Joined on the canonical form, not on the exact characters. The two statements
  // being compared were drafted INDEPENDENTLY — one as `run_read_query`'s argument
  // and one as `inspect_plan`'s — so a model that formats its aggregate over four
  // lines and then re-emits it on one has written the same statement twice and typed
  // it differently. Exact equality missed those, and the gate then resolved to
  // `plan-risky`: fail-closed and safe, but it made the feature inert far more often
  // than §2.4.0 implies, and a user reads a working gate as a broken one.
  //
  // `fingerprintStatement` is the repair ledger's own canonical form rather than a
  // second normalisation invented here, which matters in both directions: whitespace,
  // comments, unquoted case and a trailing terminator normalise away, while literals
  // and quoted names keep their exact spelling — so this cannot join a plan of
  // `WHERE id = 1` to an answer of `WHERE id = 2`.
  const wanted = fingerprintStatement(sql);
  for (const [correlationId, plan] of plans) {
    if (hasOptimizerHint(plan.sql)) continue;
    if (fingerprintStatement(plan.sql) !== wanted) continue;
    const side = readPlanSide(context, plans, correlationId);
    if (typeof side !== "string") return side;
  }
  return null;
}

/** What the model is told about where its statement went. Total, so a new outcome cannot go unsaid. */
const HANDOVER_MODEL_TEXT: Readonly<Record<AgentComposedAnswer["handover"], string>> = Object.freeze({
  none: "Nothing was executed and nothing was sent to the editor.",
  applied: "The statement was placed in the user's editor and NOT run there.",
  "auto-executed": "The statement was placed in the user's editor and handed over to be run there.",
});

/**
 * Whether this answer's statement is also handed to the editor to be RUN.
 *
 * The setting comes from the RUN RECORD, decided by the request that opened the run
 * and unwidenable afterwards; the three conditions come from `auto-execute.ts`,
 * which is pure and enumerable. All this does is gather what that gate weighs: the
 * statements the run executed, the plan it holds for this one, and the elapsed time
 * the ledger recorded for this very result.
 */
function decideHandover(
  context: AgentToolContext,
  run: Pick<AgentRunRecord, "events" | "autoExecute">,
  sql: string,
  artifact: AgentArtifactReference,
): Pick<AgentComposedAnswer, "handover" | "handoverWarning"> {
  if (!run.autoExecute) return { handover: "none" };
  const plan = heldPlanFor(context, run.events, sql);
  const decision = evaluateAutoExecute({
    sql,
    executedStatements: executedStatements(run.events),
    elapsedMs: artifact.summary.elapsedMs,
    ...(plan === null ? {} : { plan: { format: context.capabilities.explainFormat, summary: plan.summary } }),
  });
  return decision.handover === "auto-executed"
    ? { handover: "auto-executed" }
    : { handover: "applied", handoverWarning: decision.warning };
}

/**
 * Which result IS the answer, and how it should be shown.
 *
 * Reaches no database: the read already happened and is on the ledger. What this adds
 * is the DECISION, which nothing else can express — and it is checked twice over,
 * because both halves have a way of being confidently wrong. The artifact is checked
 * against this run's own ledger the way a citation is, so an answer cannot name a
 * result the run never produced; the chart spec is checked against that artifact's
 * real columns, because `DataCharts` does not fail on a column of text, it draws a
 * flat line of zeros with this application's frame around it.
 *
 * A table needs no chart validation and is accepted for a single scalar, a one-row
 * result or a result with no numeric column at all. That is a first-class outcome,
 * and the refusals say so rather than leaving the model to infer it.
 */
export function presentAnswerTool(
  context: AgentToolContext,
  run: Pick<AgentRunRecord, "runId" | "events" | "autoExecute">,
  input: unknown,
): AgentAnswerOutcome {
  if (context.mode !== "agent") return unavailable("MODE_HAS_NO_TOOLS");
  // A throw, for the reason `composeReportTool` throws: the model cannot cause this
  // and cannot fix it, so a model-visible refusal would loop while the wiring bug
  // stayed invisible.
  if (run.runId !== context.runId) {
    throw new Error("agent tool layer: the answer's run record does not belong to this run");
  }

  /*
    ONE answer per run, decided from the run's own ledger (#373 review).

    The tool is non-terminal — only `compose_report` ends the loop — so nothing stopped
    a model calling it twice, and the second call was as successful as the first: two
    `answer-composed` entries, two statements the rail delivered to the editor, and on
    an auto-execute run BOTH of them run there without a timeout, under a checkbox that
    promised the final answer. The verdict reads the same ledger and is satisfied by
    one entry, so the second was never buying anything either.

    Refused BEFORE the arguments are parsed, and that order is the point: an
    `INVALID_TOOL_INPUT` would invite the model to correct its arguments and call
    again, which is the loop this refusal exists to end. Nothing about the arguments is
    wrong here — the run is.

    It costs no repair attempt, because this tool reaches neither the repair ledger nor
    a database: `runAuditedAgentCall` is where an attempt is spent, and no path from
    here enters it. The run loop settles this as an ordinary `answered` outcome, the
    same way it settles every other refusal a ledger-only tool gives.

    The consequence across a resumed drive is deliberate rather than incidental: the
    entry is durable, so a run resumed after answering is told it has answered rather
    than being allowed to answer again for a second hand-over.
  */
  if (run.events.some((event) => event.kind === "answer-composed")) {
    return unavailable("ANSWER_ALREADY_RECORDED");
  }

  const parsed = parseToolInput(presentAnswerSchema, readSerializedPresentation(input));
  if (!parsed.ok) {
    return {
      kind: "unavailable",
      reasonCode: "INVALID_TOOL_INPUT",
      modelText: `${UNAVAILABLE_TEXT.INVALID_TOOL_INPUT} ${AGENT_ANSWER_CONTRACT}`,
    };
  }

  const artifact = producedArtifact(run.events, parsed.value.artifact);
  if (artifact === null) return unavailable("ANSWER_ARTIFACT_UNKNOWN");
  if (artifact.operationId !== ANSWER_OPERATION) return unavailable("ANSWER_NOT_A_DATA_READ");
  const sql = statementBehind(run.events, artifact.correlationId);
  if (sql === null) return unavailable("ANSWER_STATEMENT_UNKNOWN");

  const shown = parsed.value.presentation;
  let presentation: AgentAnswerPresentation = { kind: "table" };
  if (shown.kind === "chart") {
    const spec: AgentChartSpec = {
      type: shown.spec.type,
      x: shown.spec.x,
      // The tuple cast is carried by the schema's `.min(1)`, which the type system
      // cannot see; an unreachable emptiness guard would be a line no test can cover.
      y: shown.spec.y as [string, ...string[]],
      caption: shown.spec.caption,
    };
    const refusal = refuseChartSpec(context, artifact, spec);
    if (refusal !== null) return refusal;
    presentation = { kind: "chart", spec };
  }

  const handover = decideHandover(context, run, sql, artifact);
  return {
    kind: "answered",
    answer: { sql, artifact, presentation, ...handover },
    // The caption is the model's prose and the columns are the engine's text, so
    // neither is echoed here. What the model is told is what happens next: the chart
    // shows the result, and the claims are what say what it means — and, when the
    // gate declined, why, so the report it writes next is not written beside a
    // statement the user can see was not run.
    //
    // It also names the id to cite, which is the verdict's third arm said at the one
    // moment it is free to satisfy (#350). The model is holding that id; being told to
    // cite it "somewhere" and being handed the characters are different instructions,
    // and the second is the one a confused model can act on.
    modelText: `Answer recorded against result ${artifact.correlationId}, shown as a ${presentation.kind}. ${HANDOVER_MODEL_TEXT[handover.handover]}${handover.handoverWarning === undefined ? "" : ` ${handover.handoverWarning}`} Now call compose_report: the presentation shows the result, the claims are the answer. At least one claim must cite ${artifact.correlationId}.`,
  };
}

export function composeReportTool(
  context: AgentToolContext,
  run: Pick<AgentRunRecord, "runId" | "events">,
  input: unknown,
): AgentReportOutcome {
  if (context.mode !== "agent") return unavailable("MODE_HAS_NO_TOOLS");

  // The event log has to be THIS run's. Without this the type would promise a check
  // it does not perform: a caller handed another run's record would happily verify
  // that run's correlation ids and compose a report citing evidence this run never
  // produced.
  //
  // A THROW rather than a refusal, for the same reason the acquirer check in
  // `runStatement` throws: the model cannot cause this and cannot fix it, so the only
  // thing a model-visible `UNVERIFIABLE_EVIDENCE` would achieve is an endless loop of
  // correctly-cited reports being rejected while the wiring bug stays invisible.
  if (run.runId !== context.runId) {
    throw new Error("agent tool layer: the report's run record does not belong to this run");
  }

  const parsed = parseToolInput(reportSchema, input);
  if (!parsed.ok) return invalidEvidenceInput();

  const claims: AgentReportClaim[] = [];
  for (const claim of parsed.value.claims) {
    // One implementation of "does this citation name something the run produced",
    // shared with `recommend_change`: two would be two things to keep equal, and the
    // one that drifted would be the one letting an uncited claim through.
    if (!claim.evidence.every((reference) => verifiedAgainst(run.events, reference))) {
      return unavailable("UNVERIFIABLE_EVIDENCE");
    }
    claims.push({
      claim: claim.claim,
      // The tuple cast is carried by the schema's `.min(1)`, which the type system
      // cannot see. An unreachable emptiness guard here would be a line no test
      // could cover, so the guarantee stays where it is enforced.
      evidence: claim.evidence as [AgentEvidenceReference, ...AgentEvidenceReference[]],
    });
  }

  return {
    kind: "composed",
    claims,
    // The claims themselves are the model's own prose and are NOT echoed: they go
    // into the run record, where a reader sees them with their citations attached.
    modelText: `Report composed: ${claims.length} claim(s), each carrying at least one evidence reference this run produced.`,
  };
}
