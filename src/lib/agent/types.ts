/**
 * Durable domain contracts for one agent run (#329, epic #325).
 *
 * These are the PRODUCT's types, not the runtime's: a run, the semantic events
 * it emits, the schema snapshot it reasons over, and the two kinds of pointer
 * that let a report cite something without carrying it. The workflow SDK's
 * message, tool-call and stream shapes are deliberately NOT re-modeled here —
 * they are the transport, they change with the pinned version, and a durable
 * record that embedded them would have to migrate every time it moved.
 *
 * Everything in this file is inert by construction: identifiers, enumerated
 * strings, numbers, plain records and arrays of the same. No `Date`, no `Map`,
 * no provider handle, no result set. That is what makes a run resumable — the
 * whole record is JSON, so the state a restarted process reads back is exactly
 * the state the previous one wrote (`state-guard.ts` enforces the same rule at
 * runtime for the open-ended fields, and the contract fixtures in
 * `tests/unit/lib/agent/types.test.ts` assert the round trip).
 *
 * Three shapes carry a decision rather than just data:
 *
 *  - `AgentToolRefusal` is a closed union whose POLICY variant declares no field
 *    a consumer can READ engine text from: `refusal.message` does not compile
 *    unless the code has already narrowed to the database-error variant. That is
 *    the structural half of "a policy denial is never fed back to the model as if
 *    it were bad SQL", and the deny code comes from `PolicyDenyCode` itself, so
 *    the two vocabularies cannot drift. The bound is on reads, not on the runtime
 *    object: excess-property checking only fires on a fresh literal, so a widened
 *    object assigned through a variable still carries its extra field at runtime.
 *    Anything that serializes a refusal into a prompt must therefore project the
 *    fields it wants rather than spreading the whole value.
 *  - `AgentReportClaim.evidence` is a non-empty tuple type, so a claim with
 *    nothing backing it is inexpressible rather than merely discouraged.
 *  - `AgentRunActor` records a session and a role, and no execution mode. The
 *    policy layer owns its own mode vocabulary (`policy.ts`) and the server
 *    supplies it when a tool call reaches the pipeline; a persisted run may
 *    never be the thing that names its own privilege.
 *
 * A run's event log is the record's only history: artifacts and evidence are
 * reachable THROUGH the events that produced them rather than duplicated into
 * parallel lists, because two lists of the same facts are two things a resumed
 * run could disagree with itself about.
 */

import type { Role } from "@/lib/auth";
import type { PolicyDenyCode } from "@/lib/db/operations/policy";
import type { AgentStatementViolation } from "@/lib/db/operations/statement-guard";
import type { AgentChartSpec, DatabaseType, TableSchema } from "@/lib/types";
import type { AgentGoalShortfall, AgentGoalVerifierId } from "./goal-verifier";
import type { PlanStatementIdentifiers } from "./plan-statement";
import type { AgentPlanSummary } from "./plan-summary";
import type { AgentTableProfile } from "./table-profile";

/**
 * Which surface a run drives. Planning is TOOLLESS — the model is handed no tool at
 * all — which is why it is not one of the policy layer's execution modes and why no
 * statement of the model's ever reaches the pipeline.
 *
 * It used to say "zero database operations", and the grounding design of 2026-08-15
 * made that false rather than merely imprecise: the SERVER now reads this connection's
 * catalog and its estimated statistics before the first turn, because a plan mode
 * that had seen no schema produced the plan it would have produced for any database
 * in the world. What the mode still promises, unchanged, is the narrower and more
 * useful claim — it runs no statement of the user's, writes nothing, and hands every
 * statement it drafts to the user to run themselves.
 */
export type AgentRunMode = "planning" | "agent";

/**
 * WHAT a run is for, which is a different axis from HOW it executes (#325, #330 T2).
 *
 * The epic pins three independent axes — `executionMode`, `workflowType`,
 * `connectionScope` — and they are deliberately never merged into one `mode` field.
 * Merging them was the obvious economy and it is the wrong one: a planning run of a
 * query optimization and an agent run of one differ in what they may DO, not in what
 * they are FOR, and a single field would have to enumerate the product of the two.
 *
 * Like `mode`, this is decided when the run opens and read from the run's own record
 * thereafter. `selectAgentTools` and `verifyRunGoal` are both functions of it, so a
 * later request cannot widen a run after it opens — not because a filter rejects one,
 * but because there is no parameter through which a workflow could arrive twice.
 */
export type AgentRunWorkflowType =
  | "investigation"
  | "query-optimization"
  | "database-assessment"
  | "operations"
  | "data-analysis";

/**
 * What a run is for when nothing said.
 *
 * Also what a ledger written before the field folds to, and that is a READING rather
 * than a fallback: an investigation is the only thing this runtime could do when
 * those ledgers were written, so answering anything else would be inventing a fact
 * about a run nobody can go back and ask.
 */
export const DEFAULT_AGENT_WORKFLOW_TYPE: AgentRunWorkflowType = "investigation";

/**
 * Which workflows can hand a user an answer — and therefore which ones auto-execute
 * is a meaningful setting for.
 *
 * ONE fact, read by four layers that would otherwise each decide for themselves: the
 * rail decides whether to offer the checkbox, `POST /api/agent/runs` decides whether
 * to accept the field, `investigation.ts` decides whether to state
 * `AUTO_EXECUTE_RULE` to the model, and `tools.ts` decides whether to offer
 * `present_answer` at all. It lives HERE rather than in `tools.ts` because the rail
 * is a client component and `tools.ts` is the server's database seam; a total record
 * of booleans is the part both sides can hold.
 *
 * The binding to the tool set is not left to prose. `tools.test.ts` asserts, over
 * every workflow, that `selectAgentTools` offers `present_answer` exactly when this
 * record says true — so a workflow that gains the tool without gaining the flag, or
 * the reverse, fails rather than shipping the mismatch.
 *
 * The mismatch is worth naming because it shipped once: the checkbox rendered for
 * every workflow while `present_answer` was offered to one, so ticking it on an
 * Investigate run promised the user a hand-over that could not happen and told the
 * model to `inspect_plan` before a presentation it had no tool to make. That is the
 * #350/#356 shape — a rule stated to a model whose tool set cannot satisfy it — and
 * a total record is what stops it recurring silently.
 */
export const AGENT_WORKFLOW_PRESENTS_ANSWER: Readonly<Record<AgentRunWorkflowType, boolean>> = Object.freeze({
  investigation: false,
  "query-optimization": false,
  "database-assessment": false,
  operations: false,
  "data-analysis": true,
} satisfies Record<AgentRunWorkflowType, boolean>);

/** A run that has stopped, and why. Terminal states are never re-entered. */
export type AgentRunTerminalStatus = "succeeded" | "failed" | "cancelled";

export type AgentRunStatus = "queued" | "running" | AgentRunTerminalStatus;

/**
 * Why a drive could not carry a run, in terms a user can act on.
 *
 * A closed union rather than the error's own message, and that is the point: the
 * text of a failure is written by a model provider, a driver or a connection
 * resolver, and none of them promise to keep a credential, a host name or an
 * internal path out of it. What reaches the rail is one of these labels, chosen
 * from the error's TYPE; the message stays in the server log where the operator
 * who can act on it already looks.
 *
 * `internal` is the honest default. A reason is added here only when a user could
 * do something different knowing it — collapsing an unrecognised failure into a
 * specific label would be a claim the classifier cannot support.
 */
export type AgentRunFailureReason =
  /** No usable model: unconfigured, or the provider could not be reached. */
  | "model-unavailable"
  /**
   * The provider is there and answering, and is refusing on volume. The only model
   * failure that fixes itself, and the one worth telling apart from the rest: a
   * misconfiguration needs an operator, a quota needs a minute.
   */
  | "model-rate-limited"
  /** The provider rejected the credentials. An operator fixes this; retrying does not. */
  | "model-unauthorized"
  /**
   * The connection's engine has no database-native read-only execution profile, so
   * this run could never have been permitted on it. A property of the connection the
   * user chose, not a fault of the server — which is why it is not `internal`.
   *
   * WORKFLOW-CONDITIONAL since the `operations` workflow (#325): that workflow reads
   * only the curated provider methods every engine implements, under its own
   * execution profile, so it never asks for a read-only STATEMENT path and can never
   * end this way. Every other workflow still can, and does, on the same connection.
   */
  | "engine-unsupported"
  /** The run's persisted connection no longer resolves on the server. */
  | "connection-unresolvable"
  /** Anything else. Deliberately unspecific; the log carries the detail. */
  | "internal";

/**
 * How the loop ended — a different question from `AgentRunFailureReason`, which says
 * why a drive died before or outside the loop.
 *
 * This is the run's own account of itself, and it is what makes the difference between
 * "succeeded" and "answered" legible. A run that stops because the model composed a
 * cited report and a run that stops because the model simply had nothing more to say
 * are both `succeeded`; only this says which. Recording it is what lets a reader — the
 * rail, or a later verifier — tell a finished investigation from an abandoned one.
 */
export type AgentRunStopReason =
  /** The model called `compose_report`; the run answered with citations. */
  | "report-composed"
  /** The model stopped calling tools. A planning run's normal end; an agent run's silence. */
  | "model-stopped"
  /** A cancellation was requested and observed between turns. */
  | "cancelled"
  /** The wall-clock budget ran out. */
  | "deadline-exceeded"
  /** One model call did not return within its own ceiling. Retrying is reasonable. */
  | "model-timeout"
  /** The model-turn ceiling was reached with work still in flight. */
  | "turn-limit";

/**
 * Who started the run, persisted at start and the sole authority for authorizing
 * every later tool call — never the callback that woke the run up, never the
 * request body.
 */
export interface AgentRunActor {
  readonly sessionId: string;
  readonly role: Role;
}

/** Shape of a result, never the result: what a summary may say about rows. */
export interface AgentResultSummary {
  readonly rowCount: number;
  readonly columnNames: readonly string[];
  readonly elapsedMs: number;
}

/**
 * A pointer to a result the run produced. The rows themselves stay in the
 * run-scoped artifact store (`src/lib/db/operations/artifacts.ts`, process
 * memory, released with the run); `correlationId` is the same audit join key the
 * execution layer minted, so a reference is also how an operator finds the audit
 * line for the statement that produced it.
 */
export interface AgentArtifactReference {
  readonly correlationId: string;
  readonly runId: string;
  /** Registry-resolved operation id, never a caller-supplied string. */
  readonly operationId: string;
  readonly summary: AgentResultSummary;
}

/**
 * What backs one claim in a report. Two sources and no third: something the run
 * actually ran, or the schema it captured. A claim that can cite neither is a
 * claim the run invented.
 */
export type AgentEvidenceReference =
  | { readonly source: "artifact"; readonly correlationId: string; readonly locator?: string }
  | { readonly source: "context-snapshot"; readonly fingerprint: string; readonly locator?: string };

/**
 * One side of a before/after plan comparison (#330 T3).
 *
 * `summary` is derived on the SERVER from the artifact the run actually produced,
 * never supplied by the model: a comparison the model describes about its own work
 * is a claim, and this has to be a fact. It carries no engine text for the reason
 * `plan-summary.ts` states — a plan names tables and indexes, and those names are
 * untrusted input. What names the objects is `sql`, which the model wrote and
 * therefore already knows.
 */
export interface AgentPlanSide {
  /** The `sql.explain.estimate` artifact this side was read from. */
  readonly correlationId: string;
  /** The statement that was explained. */
  readonly sql: string;
  readonly summary: AgentPlanSummary;
}

export interface AgentReportClaim {
  readonly claim: string;
  /** Non-empty by type: at least one reference, or the claim cannot be built. */
  readonly evidence: readonly [AgentEvidenceReference, ...AgentEvidenceReference[]];
}

/**
 * How one result is to be DRAWN — declared in `src/lib/types.ts`, and re-exported
 * here under the name the run's own contract uses.
 *
 * It is declared OUTSIDE the agent tree for a mechanical reason: the component that
 * draws it (`DataCharts`) ships in the published package, and no agent module may be
 * reachable from that package's declarations (`tests/unit/agent-package-boundary.test.ts`).
 * One declaration two trees can name beats two declarations that can disagree.
 */
export type { AgentChartSpec } from "@/lib/types";

/**
 * The schema inventory a run reasons over, plus the fingerprint that decides
 * whether a refresh has to read anything at all.
 *
 * `tables` reuses the shipped `TableSchema` shape rather than introducing a
 * second schema vocabulary: the providers already produce it, the UI already
 * renders it, and it is serializable as it stands.
 */
export interface AgentContextSnapshot {
  readonly connectionId: string;
  /** Stable across two identical inventories; changes when the inventory does. */
  readonly fingerprint: string;
  readonly capturedAtMs: number;
  readonly tables: readonly TableSchema[];
}

/**
 * Why a curated operational reading was refused. Both are decided INSIDE the call,
 * after the pipeline allowed it and the provider was acquired, which is exactly why
 * they are refusals rather than "the run decided not to ask": a statement of the run's
 * budget was charged and the execution was audited, so a settlement that said nothing
 * happened would contradict the ledger.
 */
export type AgentReadingDenyCode = "KIND_UNSUPPORTED_BY_PROVIDER" | "READING_OVER_BUDGET";

/**
 * Why a tool call produced no result. The four variants are distinct in TYPE,
 * not merely in a string field, so the run loop cannot hand a policy denial to
 * the model as if the statement were malformed.
 *
 * `message` exists only on the database-error variant. It is the engine's own
 * text — untrusted input, exactly like public issue text — and any prompt it
 * re-enters has to label and quote it. `statementFingerprint` is what a resumed
 * run reads to know it has already failed on that exact statement.
 *
 * `reading-refused` carries no message at all: nothing an engine wrote is in it. It
 * is the server's own decision about a curated reading it will not deliver, and its
 * reason code is a closed union rather than prose for the same reason the policy
 * variant's is.
 */
export type AgentToolRefusal =
  | { readonly class: "policy-denied"; readonly reasonCode: PolicyDenyCode }
  | { readonly class: "approval-required"; readonly operationId: string }
  | { readonly class: "database-error"; readonly statementFingerprint: string; readonly message: string }
  | { readonly class: "reading-refused"; readonly reasonCode: AgentReadingDenyCode };

interface AgentRunEventBase {
  /** Epoch milliseconds. A number, not a Date: a Date does not round-trip. */
  readonly atMs: number;
}

/**
 * The semantic events one run emits, in the vocabulary a user reads in the rail
 * and a resumed run replays. Deliberately coarse: one entry per thing that
 * HAPPENED, not per token or per SDK stream chunk.
 *
 * `stepId` ties a draft, its invocation and its outcome together. It is what
 * makes replay idempotent — a resumed run that finds a settled step re-derives
 * its result instead of performing the call again.
 *
 * Consumers name a single variant with `Extract<AgentRunEvent, { kind: "..." }>`,
 * the way `execution.ts` names one policy decision.
 */
export type AgentRunEvent =
  | (AgentRunEventBase & { readonly kind: "run-started"; readonly mode: AgentRunMode })
  | (AgentRunEventBase & {
      readonly kind: "context-captured";
      readonly fingerprint: string;
      readonly tableCount: number;
      /**
       * The inventory itself, so a resumed run can reason over the schema its
       * earlier claims were made about WITHOUT reading a catalog again (#329 T8).
       *
       * Optional, and that is a reading rather than a hedge: an entry without one
       * records only that a capture happened, which is what a hand-written fixture
       * and any ledger written before this field carry, and a drive that finds none
       * re-reads. `fingerprint` and `tableCount` stay as they are rather than
       * becoming derived accessors — they are the entry's own summary, and a reader
       * that disagrees with the inventory it sits next to is how the two lists T2
       * warns about drift. The reuse path therefore RE-DERIVES both from `snapshot`
       * and refuses the entry if either disagrees, so the duplication is a checked
       * invariant instead of a second source of truth.
       */
      readonly snapshot?: AgentContextSnapshot;
    })
  | (AgentRunEventBase & {
      readonly kind: "statement-drafted";
      readonly stepId: string;
      readonly sql: string;
      readonly rationale: string;
    })
  | (AgentRunEventBase & {
      readonly kind: "tool-invoked";
      readonly stepId: string;
      readonly tool: string;
      /** Present only for a tool that reaches the canonical operation layer. */
      readonly operationId?: string;
    })
  | (AgentRunEventBase & {
      readonly kind: "tool-completed";
      readonly stepId: string;
      readonly artifact: AgentArtifactReference;
    })
  | (AgentRunEventBase & { readonly kind: "tool-refused"; readonly stepId: string; readonly refusal: AgentToolRefusal })
  | (AgentRunEventBase & { readonly kind: "report-composed"; readonly claims: readonly AgentReportClaim[] })
  | (AgentRunEventBase & {
      /**
       * The model's closing prose, recorded because it is otherwise lost.
       *
       * Deliberately NOT a report: it carries no citations and claims none, which is
       * exactly why it has its own kind rather than a lenient `report-composed`. A
       * planning run's whole output is one of these — that mode has no tools, so it
       * can never produce evidence and could never have composed a report. An agent
       * run's is an aside, and when it is the only thing a run left behind, that is
       * itself worth seeing.
       *
       * Written only when the prose is non-empty: an empty entry would record that
       * the model spoke when it did not.
       */
      readonly kind: "closing-statement";
      readonly text: string;
    })
  | (AgentRunEventBase & {
      /**
       * The one statement a PLAN run drafted, and what could be checked about it
       * without running it (the plan-mode SQL-generator design of 2026-08-15, item 5;
       * `docs/BACKLOG.md` B44).
       *
       * Not `statement-drafted`, and the difference is not cosmetic. That entry
       * belongs to a STEP: an agent run drafts through a tool, so its statement
       * arrives with a `stepId` that ties it to the invocation and the outcome that
       * followed, and a resumed run replays it. A plan run is toolless — its whole
       * output is prose — so its statement has no step, was never invoked, and never
       * will be by this runtime. Recording it under a kind that promises a step would
       * make every reader of the ledger look for an invocation that cannot exist.
       *
       * It exists at all because the ledger is the only thing that outlives the drive.
       * Until this kind, plan mode's deliverable was read out of a markdown fence in
       * the BROWSER (#389): it worked when the model fenced its SQL, offered nothing
       * when it did not, and left the verdict with nothing to tell a statement and a
       * four-paragraph lecture apart.
       *
       * Everything here is what the SERVER established, never what the model said
       * about its own work — the same rule `plan-comparison` and `answer-composed`
       * follow. And two of the fields are deliberately narrow claims:
       *
       *  - `readOnly` is the shared statement guard's verdict, nothing more. A `false`
       *    is a MARK and not a block — the owner ruled that the user is the one who
       *    runs the statement — and a `true` is not a safety claim: that guard's own
       *    docblock says it means only that that layer found nothing.
       *  - `identifiers` distinguishes "checked, and these names are not in the
       *    inventory" from "there was no inventory to check against", because an empty
       *    unknown list is a claim. Even the checked form is not permission to run: an
       *    inventory records what EXISTS, not what the user's role may select from.
       */
      readonly kind: "plan-statement-drafted";
      /** The statement as the model wrote it, verbatim, fence removed. */
      readonly sql: string;
      /** The engine it was written for — the connection this drive was given. */
      readonly dialect: DatabaseType;
      readonly readOnly: boolean;
      /** The guard's own reason, present exactly when `readOnly` is false. */
      readonly guardViolation?: AgentStatementViolation;
      readonly identifiers: PlanStatementIdentifiers;
    })
  | (AgentRunEventBase & {
      /**
       * Two estimated plans of the same question, and what changed between them.
       *
       * The query-optimization template's own artifact, and the thing its goal
       * verifier requires: a run that recommends a rewrite without having compared
       * the plans has recommended it on the strength of its own opinion.
       *
       * Both sides cite an artifact THIS run produced under `sql.explain.estimate`,
       * checked against the ledger the way a report's citations are, so a comparison
       * of two plans the run never asked for is inexpressible.
       */
      readonly kind: "plan-comparison";
      readonly before: AgentPlanSide;
      readonly after: AgentPlanSide;
    })
  | (AgentRunEventBase & {
      /**
       * A change the run proposes and DOES NOT make.
       *
       * `statement` is DDL or SQL that is never executed by anything in this
       * runtime — no tool maps onto a write, and this event reaches no database at
       * all. It exists so the rail can offer it to the user, who owns the decision;
       * "apply to editor" hands them the statement, and nothing else happens.
       *
       * `evidence` is non-empty by type for the same reason a claim's is: a
       * recommendation nothing backs is a recommendation the run invented.
       */
      readonly kind: "recommendation";
      readonly change: "index" | "rewrite";
      readonly statement: string;
      readonly rationale: string;
      readonly evidence: readonly [AgentEvidenceReference, ...AgentEvidenceReference[]];
    })
  | (AgentRunEventBase & {
      /**
       * One table profiled, as COUNTS and the findings derived from them.
       *
       * The database-assessment template's own artifact. Nothing here is a value
       * read out of a column — `table-profile.ts` states why, and it is the reason
       * profiling a table of personal data is acceptable at all: the run records
       * how many, never which.
       *
       * The findings are the SERVER's, derived from the numbers by predicates with
       * stated thresholds. A model may interpret them; it cannot invent one.
       */
      readonly kind: "table-profiled";
      /**
       * The read that produced the counts, so a report can CITE the profile.
       *
       * Present because its absence was a defect: profiling does not settle a step,
       * so it writes no `tool-completed`, and a claim about a profile was therefore
       * uncitable — which made the assessment template's own goal verifier, which
       * requires both a profile and a cited report, impossible to satisfy. Found by
       * the scenario suite before any model met it.
       */
      readonly artifact: AgentArtifactReference;
      readonly profile: AgentTableProfile;
    })
  | (AgentRunEventBase & {
      /**
       * This artifact IS the answer, and this is how it should be shown.
       *
       * The READ is already on the ledger — `tool-invoked` before it, `tool-completed`
       * after — but the DECISION is not: "this result is the answer, and it should be
       * drawn as a bar chart of region against net_total" is a fact about the run that
       * no other event can express.
       *
       * `artifact` is required, not optional. An answer that names no artifact is a
       * claim, and a claim belongs in the report with its citations attached.
       *
       * And a chart is never a substitute for a claim. The presentation SHOWS an
       * artifact, the artifact is the evidence, and the claim is the answer; a run
       * that drew a picture and reported nothing has drawn a picture.
       */
      readonly kind: "answer-composed";
      /**
       * The statement the answer rests on — what "Apply to editor" hands over.
       *
       * Read from this run's own ledger, never supplied by the model: a statement the
       * model described about its own work could name a read that produced something
       * else, which is the mislabelling `plan-comparison` also refuses to allow.
       */
      readonly sql: string;
      /** The artifact this answer IS. Verified against this run's own ledger. */
      readonly artifact: AgentArtifactReference;
      /**
       * How to render it. A table is a first-class outcome, not a fallback: a single
       * scalar, a one-row result and a result with no numeric column are all answers,
       * and a chart of any of them would render an empty state.
       */
      readonly presentation: { readonly kind: "table" } | { readonly kind: "chart"; readonly spec: AgentChartSpec };
      /**
       * Whether the run also sent the statement to the editor, and how far.
       *
       * The OUTCOME of the setting, not the setting: a run opened with auto-execute
       * whose gate declined records `applied`, so a reader can see both that the
       * setting was on and that the gate said no — which is exactly what someone
       * asking "why didn't it run" needs. `none` is a run that was never opened with
       * it at all.
       *
       * `auto-executed` records that the run HANDED THE STATEMENT OVER. What the
       * editor then did with it is the editor's own business, against a route this
       * runtime does not own, and it produces no ledger event because it cannot.
       */
      readonly handover: "none" | "applied" | "auto-executed";
      /**
       * Why the gate declined, in the run's own words. Present exactly when
       * `handover` is `applied`: a refusal that says nothing is indistinguishable
       * from the feature being broken.
       */
      readonly handoverWarning?: string;
    })
  | (AgentRunEventBase & {
      readonly kind: "run-finished";
      readonly status: AgentRunTerminalStatus;
      /**
       * Why, for a run that failed before it could do its own work.
       *
       * Optional because most endings do not need one: a run that succeeded, one a
       * user cancelled, and one the loop ended on its own terms are all fully
       * described by `status`. It is set when a drive died before or outside the
       * loop — the case that used to leave a run sitting at `queued` with the
       * reason visible only in the server log.
       */
      readonly reason?: AgentRunFailureReason;
      /**
       * Whether the run met the goal its workflow was opened for (`docs/BACKLOG.md`
       * B24, ratified 2026-08-13).
       *
       * A field beside the status rather than a fourth status word, and the reason is
       * an observation rather than a preference: the two axes are genuinely
       * independent. A run can end `succeeded` having answered nothing (the model
       * stopped), `failed` having answered nothing (the turn ceiling), or `failed`
       * with no verdict meaningful at all (the drive died before the loop, so the run
       * never got to try). One word cannot carry both how a run ended and whether it
       * answered — both of the first two were observed on live runs on 2026-08-13.
       *
       * Optional, like `reason` and `stopReason` before it, and for the same reason:
       * a ledger written before this field folds unchanged, and its ABSENCE means
       * exactly what is true of it — no verifier ran. That absence is written on
       * purpose for the third shape above: a run still `queued` at its ending never
       * entered the loop, and calling it "did not answer" would judge a run that was
       * never given the chance to. Adding a fourth status instead
       * would have split `succeeded` by ledger generation, with nothing in an older
       * record to say which meaning applied.
       *
       * `unmet` is omitted when the run answered, so the two halves cannot disagree.
       */
      readonly goalVerdict?: {
        readonly outcome: "answered" | "unanswered";
        readonly verifier: AgentGoalVerifierId;
        readonly unmet?: readonly AgentGoalShortfall[];
      };
      /**
       * How the loop itself ended, when the loop is what ended it. Absent on a run
       * the drive failed out of — those carry `reason` instead, and the two are
       * mutually exclusive by construction rather than by convention.
       */
      readonly stopReason?: AgentRunStopReason;
    });

/**
 * One run, whole. Everything a restarted process needs to continue, and nothing
 * a restarted process could not read: no client, no credential, no result set.
 */
export interface AgentRunRecord {
  readonly runId: string;
  readonly mode: AgentRunMode;
  /**
   * Required HERE and optional on the ledger header, which is the whole
   * compatibility story in one sentence: the fold always produces a workflow type,
   * and an older header simply does not carry one. Every reader therefore has a
   * value, and no reader has to know which generation of writer produced its run.
   */
  readonly workflowType: AgentRunWorkflowType;
  /**
   * Whether this run may hand its answer's statement to the editor to be RUN there,
   * subject to the gate in `auto-execute.ts`.
   *
   * On the RECORD, beside `mode` and `workflowType`, for the two reasons those are:
   * a resumed drive must behave the same as the drive that died, and no later
   * request may widen a run after it has opened. The route is the only place it is
   * decided, and there is no route that changes it.
   *
   * Required here and optional on the ledger header, the same compatibility story
   * `workflowType` has: a header written before the field existed folds to `false`,
   * which is what was true of every run written then.
   */
  readonly autoExecute: boolean;
  readonly status: AgentRunStatus;
  readonly actor: AgentRunActor;
  /** The single connection this run may reach; the server builds the scope from it. */
  readonly connectionId: string;
  /** The user's own question, in their words. */
  readonly objective: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** The run's ledger, in order. The only history there is. */
  readonly events: readonly AgentRunEvent[];
}
