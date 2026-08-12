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
import type { TableSchema } from "@/lib/types";
import type { AgentPlanSummary } from "./plan-summary";

/**
 * Which surface a run drives. Planning is toolless: it must perform zero database
 * operations, which is why it is NOT one of the policy layer's execution modes and
 * never reaches the pipeline.
 *
 * Stated as the obligation it is, not as something already enforced — the tool
 * layer that has to select an empty set for this mode does not exist at this
 * commit. It is the requirement that layer will be tested against.
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
export type AgentRunWorkflowType = "investigation" | "query-optimization" | "database-assessment";

/**
 * What a run is for when nothing said.
 *
 * Also what a ledger written before the field folds to, and that is a READING rather
 * than a fallback: an investigation is the only thing this runtime could do when
 * those ledgers were written, so answering anything else would be inventing a fact
 * about a run nobody can go back and ask.
 */
export const DEFAULT_AGENT_WORKFLOW_TYPE: AgentRunWorkflowType = "investigation";

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
 * Why a tool call produced no result. The three variants are distinct in TYPE,
 * not merely in a string field, so the run loop cannot hand a policy denial to
 * the model as if the statement were malformed.
 *
 * `message` exists only on the database-error variant. It is the engine's own
 * text — untrusted input, exactly like public issue text — and any prompt it
 * re-enters has to label and quote it. `statementFingerprint` is what a resumed
 * run reads to know it has already failed on that exact statement.
 */
export type AgentToolRefusal =
  | { readonly class: "policy-denied"; readonly reasonCode: PolicyDenyCode }
  | { readonly class: "approval-required"; readonly operationId: string }
  | { readonly class: "database-error"; readonly statementFingerprint: string; readonly message: string };

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
