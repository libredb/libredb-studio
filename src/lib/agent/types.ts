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
import type { LLMProviderType } from "@/lib/llm/types";

import type { PolicyDenyCode } from "@/lib/db/operations/policy";
import type { AgentStatementViolation } from "@/lib/db/operations/statement-guard";
import type { AgentChartSpec, DatabaseType, TableSchema } from "@/lib/types";
import type { AgentContextCharge, AgentContextRowBudget, AgentContextUnavailableCode } from "./context-snapshot";
import type { AgentGoalShortfall, AgentGoalVerifierId } from "./goal-verifier";
import type { AgentToolName } from "./tools";
import type { AgentInventoryNoun } from "./inventory-noun";
import type { PlanStatementIdentifiers } from "./plan-statement";
import type { AgentPlanSummary } from "./plan-summary";
import type { AgentTableProfile } from "./table-profile";

/**
 * Where the settings that drove a run came from — for THIS model, not for the server.
 *
 * A named type rather than an inline union because two places need the same shape: the ledger
 * event that records it, and `model-tuning`'s projection from its own status onto it. Spelled
 * twice, the two would drift, and the drift would be invisible — both sides would still compile.
 *
 * `operator` means the operator's document supplied THIS model's entry. A document that was applied
 * but says nothing about the model a run used did not drive that run, and reads `bundled`.
 *
 * NO PATH, and that is a boundary rather than an omission. This event is part of the run record,
 * and `GET /api/agent/runs/[runId]` serves that record — with its events — to the run's OWNER, who
 * is an ordinary user: `agent-run-access.ts` matches on `actor.sessionId` and asks for no role. An
 * absolute server path here would be topology handed to every user who starts a run, and hiding it
 * in the rail would not help, because the API is where it would leak. The digest identifies WHICH
 * version drove the run without saying where the file lives, and which file that is belongs to
 * `GET /api/agent/config`, which is admin-only and says so.
 */
export type AgentRunTuningProvenance =
  | { readonly origin: "bundled" }
  | { readonly origin: "operator"; readonly digest: string }
  | { readonly origin: "operator-ignored" };

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
 * WHERE a run's workflow came from: the server classified the objective into it, or
 * a person picked it.
 *
 * Not a second way to say what the workflow IS — nothing downstream branches on this,
 * and `selectAgentTools` never sees it. It exists because the surface owes the user a
 * different sentence in each case. A workflow the user chose needs no explanation; a
 * workflow inferred from their objective needs both the claim ("opened as Optimize")
 * and the way out of it ("change"), and that affordance has to survive a page reload,
 * which is only possible if the provenance is on the run rather than in the rail's
 * memory of the request it sent.
 */
export type AgentRunWorkflowSource = "inferred" | "chosen";

/**
 * Where a workflow came from when nothing said, and — like `DEFAULT_AGENT_WORKFLOW_TYPE`
 * — a READING of history rather than a fallback.
 *
 * A header written before this field folds to `"chosen"` because there was no
 * classifier then: the client sent an explicit `workflowType` on every open request,
 * so those runs genuinely did carry a workflow somebody picked. Folding them to
 * `"inferred"` would offer their readers a "change" affordance against a
 * classification that never ran, and would credit a decision to a model that made
 * none.
 */
export const DEFAULT_AGENT_WORKFLOW_SOURCE: AgentRunWorkflowSource = "chosen";

/**
 * What the READING of the objective produced, as against where the workflow came from.
 *
 * `workflowSource` says who decided; this says how that decision went. They are two
 * facts because a classifier that fell back still produced an inferred workflow: the
 * run genuinely was not asked for by anyone, and it genuinely was not read out of the
 * objective either. Collapsing them would leave the surface stating one of those as
 * the other, which is precisely what it may not do — the fallback must be said as a
 * fallback and never presented as a verdict.
 *
 *  - `"classified"` — a classifier read the objective and named this workflow.
 *  - `"unclassified"` — a classifier was asked and reached its documented fallback: a
 *    model failure, a timeout, an empty reply, or a reply naming no workflow this
 *    build serves (`workflow-classifier.ts`).
 *  - `"unrecorded"` — no classifier outcome is recorded for this run. That is the
 *    truth for every run somebody CHOSE the workflow of, since nothing classified
 *    anything, and it is also the only honest answer for a header written before this
 *    field existed.
 *
 * Nothing downstream branches on it; like `workflowSource` it exists so the surface can
 * say a true sentence about a run it did not itself open.
 */
export type AgentRunWorkflowReading = "classified" | "unclassified" | "unrecorded";

/**
 * What a header that carries no reading means — and the reason it is `"unrecorded"`
 * rather than either of the other two, which is the whole point of there being three.
 *
 * Both alternatives are claims the record cannot support. `"classified"` would present
 * a fallback as a verdict on every run written by a writer that had a classifier and
 * did not record its outcome — the exact defect this field was added to end, since a
 * rail that reloads reads the record and nothing else. `"unclassified"` is the mirror
 * error and is worse where it is visible: it asserts that a reading FAILED, and it can
 * contradict the very workflow beside it, saying "your objective could not be
 * classified, so the run investigates" over a run whose header says `operations`.
 *
 * So the absent case is folded to the one answer that is true of it: nothing here
 * records how the workflow was read. A surface owes such a run a third sentence rather
 * than one of the two it has, and `AgentRail` writes one.
 *
 * Note what this does NOT cost. A ledger written before the classifier existed folds
 * its SOURCE to `"chosen"` (`DEFAULT_AGENT_WORKFLOW_SOURCE`), and a chosen run is owed
 * no sentence at all — so on those runs this default is never read, and its whole
 * reach is the generation of headers that carried a source without a reading.
 */
export const DEFAULT_AGENT_WORKFLOW_READING: AgentRunWorkflowReading = "unrecorded";

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

/**
 * Which workflows SEND A STATEMENT the engine has to run under a read-only path — and
 * therefore which ones can be offered at all on an engine whose provider implements no
 * such path.
 *
 * A property of the workflow, stated here beside `AGENT_WORKFLOW_PRESENTS_ANSWER`
 * rather than a list inside the route that refuses, and for the same reason: the set is
 * then explicit, total over the union, and pinned to the tool sets by a test instead of
 * being a claim a reader has to re-derive from `WORKFLOW_TOOLS`. A new workflow stops
 * this file compiling until somebody decides whether it drafts SQL, which is the
 * question that decides where it may run.
 *
 * `operations` is the false one, and it is the whole reason this record exists rather
 * than a blanket rule about agent mode. Its tools are the curated provider readings
 * every engine implements, served under `AGENT_OPERATIONS_PROFILE`, whose acquisition
 * does not require `queryReadOnly` (`PROFILE_ACQUISITION` in `src/lib/db/factory.ts`).
 * A refusal that ignored this axis would withhold from MySQL, Oracle, SQL Server,
 * MongoDB, Redis and the rest a workflow that runs on them today (#411).
 *
 * It says nothing about PLAN mode, which drafts on every engine and executes nothing it
 * drafts: a caller reading this record has to have established the mode first, exactly
 * as `selectAgentTools` does.
 *
 * The binding to the tool set is not left to prose. `tools.test.ts` asserts, over every
 * workflow, that `selectAgentTools` offers a tool whose operation carries a STATEMENT
 * exactly when this record says true — so a workflow that gains such a tool without the
 * flag (it would open on an engine that then refuses its first statement) or the flag
 * without the tools (it would be withheld from an engine it runs on) fails the build
 * rather than shipping the mismatch.
 */
export const AGENT_WORKFLOW_SENDS_STATEMENTS: Readonly<Record<AgentRunWorkflowType, boolean>> = Object.freeze({
  investigation: true,
  "query-optimization": true,
  "database-assessment": true,
  operations: false,
  "data-analysis": true,
} satisfies Record<AgentRunWorkflowType, boolean>);

/** A run that has stopped, and why. Terminal states are never re-entered. */
export type AgentRunTerminalStatus = "succeeded" | "failed" | "cancelled";

/**
 * How a run asks its model for a tool call.
 *
 * `native` is the OpenAI tool-call format the SDK speaks. `prompted` is the fallback for
 * a model that cannot speak it: the tools are described in prose and the reply is read
 * back for one action (`prompted-tools.ts`). Both end at the same schema and the same
 * audited pipeline — the protocol decides how the model is ASKED, never what it may do.
 */
export type AgentToolProtocol = "native" | "prompted";

export type AgentRunStatus = "queued" | "running" | AgentRunTerminalStatus;

/**
 * The terminal statuses as a set, EXHAUSTIVE by construction.
 *
 * `satisfies Record<AgentRunTerminalStatus, true>` is the whole point: adding a member
 * to that union stops this file compiling until it is named here. A hand-written
 * `Set<string>` keeps compiling and silently answers "not terminal" for the new one,
 * and on the follow-up path that is a legitimate conversation refused with a message
 * that names nothing — the caller is told only that the run may not be continued.
 *
 * `LIVE_STATUSES` in the rail is deliberately NOT derived from this: `queued | running`
 * is drift-safe on its own, since a new terminal status correctly reads as not live.
 * This one is the direction that needed pinning.
 */
const TERMINAL_STATUS_MEMBERS = {
  succeeded: true,
  failed: true,
  cancelled: true,
} satisfies Record<AgentRunTerminalStatus, true>;

export const AGENT_TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set(
  Object.keys(TERMINAL_STATUS_MEMBERS) as AgentRunTerminalStatus[],
);

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
   * NARROWER for the `operations` workflow (#325), and narrower is all it is. That
   * workflow's own reads go through the curated provider methods every engine
   * implements, under `AGENT_OPERATIONS_PROFILE`, so it never asks for a read-only
   * STATEMENT path; and since #411 it takes a server-side catalog capture before its
   * first turn, which does acquire a profile. WHICH profile depends on the reading, and
   * that is what keeps this reason out of an operations run (#414): the composed catalog
   * read takes `agent-read-only` and is composed only for the two dialects that HAVE a
   * read-only profile, while every other dialect asks its provider to describe its own
   * schema under `agent-operations`, whose gate does not require `queryReadOnly`. An
   * acquisition IS attempted on all nine — the sentence here used to say none was, which
   * was true only until the second reading existed. What survives is the conclusion: the
   * profile whose acquisition would be refused is never the profile that capture asks for
   * on an engine that would refuse it.
   *
   * ONLY the engine's own refusal, since B47: the other cause of the same error type
   * is `agent-credential-unusable` below.
   */
  | "engine-unsupported"
  /**
   * The connection's agent credential could not be applied, so the profile was
   * refused before any provider existed — on ANY engine, including the two the agent
   * executes on.
   *
   * Split out of `engine-unsupported` (B47) because `resolveAgentCredential` raises the
   * same `ExecutionProfileError` for a credential that is half-configured, sealed under
   * a key that no longer decrypts, or set alongside a connection string. Told the engine
   * sentence, an operator who had rotated the secret key read something false about
   * their PostgreSQL and nothing about the one field they could fix. The error's reason
   * codes (`AGENT_CREDENTIAL_UNRESOLVABLE`, `AGENT_CREDENTIAL_WITH_CONNECTION_STRING`)
   * already carried the distinction; this is where it becomes visible.
   */
  | "agent-credential-unusable"
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
  /**
   * WHICH of the two readings produced this inventory (#414).
   *
   * `"composed-catalog"` is a statement per catalog kind, written by the server for
   * the dialect and audited line by line; `"provider-inventory"` is the engine's own
   * schema inspection — one audited call, on the engines for which no catalog
   * statement is composed. What a reader does with it is say how the inventory was
   * obtained without claiming the wrong one, which the packing preface has to.
   *
   * Optional, and absent reads as `"composed-catalog"`: every snapshot written before
   * this field existed came from that path, so a ledger recorded then stays readable
   * and stays right. A required field would have made those ledgers say nothing where
   * they can honestly say the one thing that was true.
   *
   * It is deliberately NOT in the fingerprint. The fingerprint is the INVENTORY's
   * identity, and two runs that read the same tables two ways are looking at the same
   * schema — folding the route into it would make a resumed run refuse its own
   * recorded capture over a fact about how it was taken.
   */
  readonly readVia?: "composed-catalog" | "provider-inventory";
}

/**
 * Why a curated reading that sends no statement was refused. Both are decided INSIDE
 * the call, after the pipeline allowed it and the provider was acquired, which is
 * exactly why they are refusals rather than "the run decided not to ask": a statement
 * of the run's budget was charged and the execution was audited, so a settlement that
 * said nothing happened would contradict the ledger.
 *
 * The grounding schema read (#414) adds no third code. A provider that cannot describe
 * itself is not a state that exists — `getSchema()` is required on `DatabaseProvider`
 * — and the reachable failure, a `getSchema()` that rejects, is a database error the
 * reading path already reports as one.
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
 *
 * `elapsedMs` is on exactly the two variants that COST the run database time, and the
 * split is the accounting's and not a style choice (#512). Both are decided inside the
 * invoke callback, so `tracker.beginExecution` has run and `endExecution` charges the
 * span against `maxTotalRunMs` on the failure path exactly as it does on the success
 * one; a policy denial and an approval requirement return before `beginExecution` and
 * are charged nothing at all, so a duration on either would be a spend nobody made.
 * It was absent, and the consequence was concrete: the rail folds its database-time
 * meter out of this ledger, so a run whose statement failed reported LESS than the
 * tracker had already charged it — and under-reporting a spend a bound has taken is
 * the direction that misleads, since it reads as room the run does not have.
 *
 * It sits beside the engine's `message` under a different rule, and the difference is
 * the point. A duration is a MEASUREMENT this server took with its own clock, so it is
 * recorded as data and read as data; the message is text the engine wrote, so it stays
 * untrusted input that any prompt re-entering it has to label and quote.
 *
 * Optional, and the absence is a reading rather than a hedge: every refusal recorded
 * before this field existed carries none, and a fold that read one as `0` would state
 * that a failed statement cost the database no time — which is exactly what #477
 * forbids. A reader therefore counts such an entry as unmeasured and says so, instead
 * of folding a fabricated zero into a total it then presents as measured.
 */
export type AgentToolRefusal =
  | { readonly class: "policy-denied"; readonly reasonCode: PolicyDenyCode }
  | { readonly class: "approval-required"; readonly operationId: string }
  | {
      readonly class: "database-error";
      readonly statementFingerprint: string;
      readonly message: string;
      readonly elapsedMs?: number;
    }
  | { readonly class: "reading-refused"; readonly reasonCode: AgentReadingDenyCode; readonly elapsedMs?: number };

interface AgentRunEventBase {
  /** Epoch milliseconds. A number, not a Date: a Date does not round-trip. */
  readonly atMs: number;
}

/**
 * Every sentence the drive says to a run, named — and the ONE place a new one has to
 * state itself (B51).
 *
 * Each notice is one-shot or count-bounded per DRIVE, and the flags that bound them are
 * `let`s inside `runInvestigation` — which is also what RESUMES a run a dead process left
 * running. So "once" meant once per drive, and a resumed drive could say again what the
 * previous drive already said. The flags are now SEEDED from the deliveries the ledger
 * already holds (`guidanceDelivered`), which is why every notice needs an id here: a
 * delivery nothing records cannot bound anything.
 *
 * Two kinds of entry carry these ids, and which one a notice lands on follows from HOW it
 * is delivered rather than from a second decision:
 *
 *  - a notice delivered as a `user` message, on a turn where nothing was refused, is a
 *    `guidance-issued` entry — the drive said something and the model acts on it next
 *    turn;
 *  - a notice delivered as a TOOL RESULT, instead of running the call, is the `notice`
 *    field of the `call-held` entry that already records the hold. A second entry for one
 *    delivery would be the only place in this ledger where one thing writes twice, and the
 *    rail would render both.
 *
 * The rail's own reading of these ids is `GUIDANCE_HEADLINE`; the wording lives in
 * `models/notices.ts` and in `investigation.ts` for the two that name artifact ids.
 */
export type AgentGuidanceNotice =
  /**
   * A prose turn after a tool this run holds was called. Delivered as a `user` message,
   * and the turn is taken again. Bounded by the model's own `reportReminderLimit`.
   */
  | "report-reminder"
  /**
   * A plan run whose prose named neither statement nor refusal. Delivered as a `user`
   * message; bounded by the model's own `planStatementRetries`.
   */
  | "plan-statement"
  /**
   * A run within the turn or time reserve of a ceiling. Delivered as a `user` message
   * riding the turn about to be taken; once per run.
   */
  | "report-reserve"
  /**
   * A run that stopped having read nothing, on a set holding both reading tools.
   * Delivered as a `user` message; once per run, and only where the model's profile
   * says the retry earned its turn.
   */
  | "unread-stop"
  /**
   * A `compose_report` on an answering workflow with a presentable read and no
   * presentation. Delivered as a TOOL RESULT instead of running the call, so it rides
   * the `call-held` entry; bounded by the model's own `presentReminderLimit`.
   */
  | "present-before-report"
  /**
   * A `compose_report` resting on no citation, or on nothing but empty readings.
   * Delivered as a TOOL RESULT instead of running the call; once per run.
   */
  | "cite-what-you-read"
  /**
   * A `compose_report` from a run holding the two plans a comparison would use.
   * Delivered as a TOOL RESULT instead of running the call; once per run.
   */
  | "compare-before-report";

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
      /**
       * What drove this stretch of the run: the model, and where its settings came from.
       *
       * Written because a finished run said neither. The record carries no model id and no event
       * did either, so "these settings were measured" — the product's whole claim about a model —
       * was not checkable from the run that used them. Once a tuning document can arrive from an
       * operator's disk, neither was "which settings", and `GET /api/agent/config` answers only
       * for the server at the moment somebody asks rather than for a run read afterwards.
       *
       * Per DRIVE rather than per run: a resume can pick up a different model, so a resumed run
       * carries one of these per stretch and each says what that stretch ran on. A reader takes
       * the last, or notices they disagree, which is the fact worth noticing.
       */
      readonly kind: "driver-resolved";
      readonly modelId: string;
      readonly provider: LLMProviderType;
      /**
       * `bundled` is written rather than left out: a ledger silent about provenance and one that
       * says "the shipped measurements" are different claims, and only the second is checkable.
       *
       * `operator-ignored` is its own case because the fail-open policy rests on the distinction.
       * A run driven by the shipped settings because nobody configured a document, and one driven
       * by them because the operator's could not be read, behave identically and mean opposite
       * things — the second is a misconfiguration nobody has noticed yet.
       *
       * Per MODEL: see `AgentRunTuningProvenance` for why a document that was applied can still
       * read `bundled` here, and for why no path is carried.
       */
      readonly tuning: AgentRunTuningProvenance;
    })
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
      /**
       * What this engine called the rows of that inventory when they were READ
       * (#414). Two plain strings, so the entry stays as inert as everything else
       * here.
       *
       * On the ledger rather than re-derived by whatever renders the run later,
       * because the two candidates are not the same fact. A surface that asks the
       * connection for its labels answers with what the connection is called NOW —
       * and the connection can be edited, retyped or deleted between a run and the
       * reading of its history, while `useProviderMetadata` answers `null` for the
       * whole of an in-flight fetch and for every failed one, which would render the
       * default noun and then change it under the reader. The prompt this same
       * capture produced already carries the word (`packContextForTask`), so
       * recording it is what keeps the sentence the model was given and the sentence
       * the user reads one decision instead of two that can disagree.
       *
       * Optional, and the absence is a reading rather than a hedge: every ledger
       * written before #414 was rendered as "tables" whatever the engine, so folding
       * one to `TABLE_INVENTORY_NOUN` shows exactly what it always showed instead of
       * claiming a vocabulary nobody recorded.
       */
      readonly noun?: AgentInventoryNoun;
      /**
       * What the reading COST this run, measured off the tracker around the capture
       * (B13).
       *
       * The capture's catalog reads are charged against exactly the ceilings the rail
       * shows and go through `executeAuditedOperation` rather than the run loop's
       * `runStep`, which is the only writer of `tool-completed` — so a run that had
       * spent three statements before its first model turn folded to a meter reading
       * zero. This is what the fold adds instead of itemising reads it never saw.
       *
       * The tracker's own delta and not a count of the catalog kinds this dialect has:
       * a denied read charges nothing while an acquisition failure charges a statement
       * for a call that never ran, so a derived figure would state the reads the server
       * INTENDED rather than the ones the run paid for.
       *
       * Optional, and the absence is the honest reading rather than a hedge: a ledger
       * written before this field records a capture whose spend nobody measured, and a
       * `{ statements: 0, elapsedMs: 0 }` there would state that the reading was free
       * (#477). A reader folds an entry without one exactly as it always folded it.
       */
      readonly charged?: AgentContextCharge;
    })
  | (AgentRunEventBase & {
      /**
       * An inventory this run did not read, because the PROCESS already held one for
       * its connection, and how old that reading was when this run took it (B56).
       *
       * `heldSnapshotForConnection` is consulted before any capture and has no expiry:
       * newest reading wins, eviction is by use, nothing re-reads. Measured 2026-08-22,
       * twice in one session — MongoDB's schema inference was changed, the schema tree
       * showed the new dotted paths immediately, and two plan runs afterwards still
       * grouped by the old field. Their ledgers carried NO context event at all, so the
       * record could not distinguish "held, hours old" from "captured just now", and the
       * only diagnosis available was restarting the process.
       *
       * Its own kind rather than a `context-captured`, for the reason
       * `context-unavailable` is one: every reader that asks `kind === "context-captured"`
       * treats the entry as this run's own reading — `reusableSnapshot` re-derives a
       * snapshot from it and would hand a later drive an inventory this run never read,
       * and the timeline would say "Schema captured" of a capture that did not happen.
       *
       * `ageMs` is what the entry exists for. The fingerprint says WHICH reading, and a
       * user who has just added a collection needs to know it was taken before they did.
       * It is the age at the moment of REUSE and not a timestamp difference a reader has
       * to compute: the reading's own `capturedAtMs` belongs to whichever run captured it,
       * and that run may not be in this ledger at all.
       *
       * No snapshot on the entry, deliberately. The inventory is not this run's reading,
       * and recording it here would make `reusableSnapshot` reachable from a reuse — which
       * is the reading that ages, so a resumed drive would keep re-deriving it for as long
       * as the run lived.
       */
      readonly kind: "context-reused";
      readonly fingerprint: string;
      readonly tableCount: number;
      /** How old the reading was when this run took it, in milliseconds. */
      readonly ageMs: number;
      /**
       * What this engine calls the rows of that inventory, from the same source the
       * capture entry takes it from (#414) and optional for the same reason.
       */
      readonly noun?: AgentInventoryNoun;
    })
  | (AgentRunEventBase & {
      /**
       * A capture that was REFUSED, and why (B54).
       *
       * Its own kind rather than a `context-captured` carrying an absence, for two
       * reasons that point the same way. A refused capture read nothing, so it has no
       * fingerprint and no table count, and the absence rule this repository already
       * enforces (#477) says a refusal must be representable AS a refusal rather than
       * as a zero or a fabricated measurement — `tableCount: 0` here would state that
       * this database has no tables. And every reader that asks
       * `kind === "context-captured"` — `reusableSnapshot`, the grounding check in
       * `tools.ts`, the timeline — treats the entry as PROOF that an inventory exists,
       * so a variant of it carrying a refusal would make all three claim grounding a
       * run never had. `call-declined` beside `call-held` is the same decision one
       * layer down: what did NOT happen gets its own entry.
       *
       * Written because the ledger is supposed to be the authority on what a run did
       * (`docs/llms/setup.md`) and, for exactly the case an operator has to diagnose, it
       * was not: the refusal branch pushed a sentence into the prompt and returned, so a
       * plan run whose capture was refused left four events and nothing between the
       * second and the third. The measured cost is B52 — 536 rows against a 200-row
       * budget on a live AlloyDB Omni — where the reason code, the numbers and the
       * catalog read were all computed, handed to the model, and then dropped. And a
       * missing event is worse here than missing telemetry: it reads as work that was
       * not needed rather than knowledge that was lost.
       *
       * `detail` is the capture's OWN sentence — the same one the model was given — so
       * the ledger and the prompt cannot disagree about why this run had no inventory.
       * It is needed rather than redundant: `CATALOG_READ_REFUSED` covers four causes
       * (a denied read, an over-budget one, an unreachable host, a refused execution
       * profile) and this is what tells them apart. On the composed path it arrives
       * fenced, because part of it is text the engine wrote, exactly as `tool-refused`
       * carries an engine's message.
       *
       * NOT recorded: the statements the capture composed, and no noun. The first
       * belongs to the audit stream — what those reads COST is a different question and
       * `charged` answers it; the second describes rows, and there are none to describe.
       */
      readonly kind: "context-unavailable";
      readonly reasonCode: AgentContextUnavailableCode;
      readonly detail: string;
      /** Present only when the row budget is what refused it. */
      readonly rowBudget?: AgentContextRowBudget;
      /**
       * What the refused reading cost this run, measured off the tracker (B13).
       *
       * A refusal is not a free capture: the pipeline admitted the call, charged the
       * statement and only then answered, and on the row-budget case the engine had
       * already produced the rows. Same reading as the captured entry's, same reason for
       * being optional there.
       */
      readonly charged?: AgentContextCharge;
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
       * A call the server held back, and what it asked for instead.
       *
       * The drive can refuse to RUN a `compose_report` and answer the model with a notice —
       * cite a reading you took, compare the two plans you hold, profile a table before you
       * report. Every one of those decisions was invisible: a held call performs no effect,
       * so it settles no step and wrote nothing at all. A reader of the ledger saw a run
       * that reported once, when what happened was that it tried, was turned back, and
       * tried again.
       *
       * That is a gap in the thing this ledger exists to be. It also cost real time: a
       * notice measured as having no effect on `qwen3.5:9b` and `qwen3:8b` could not be
       * told apart from a notice that never fired, because neither leaves a trace.
       *
       * `shortfall` is the verifier's own name for what was missing where the notice came
       * from the verdict preview, and absent for the purpose-written ones, which answer
       * conditions the verifier has no vocabulary for.
       */
      readonly kind: "call-held";
      readonly tool: AgentToolName;
      readonly reason: string;
      readonly shortfall?: AgentGoalShortfall;
      /**
       * WHICH sentence the hold answered with, from the one vocabulary every delivery is
       * named in (`AgentGuidanceNotice`, B51).
       *
       * `reason` is the prose the model was sent and names artifact ids in two of the
       * three cases, so it cannot be matched against: a resumed drive reading it back to
       * decide whether a notice had already been delivered would be pattern-matching a
       * paragraph. This is the id that reading uses.
       *
       * Absent on the verdict-preview holds, which speak for a `shortfall` rather than for
       * a notice, and on every entry written before the field existed — where the absence
       * says "this delivery was not recorded under a name", not "no notice was sent".
       */
      readonly notice?: AgentGuidanceNotice;
    })
  | (AgentRunEventBase & {
      /**
       * A ledger-only tool that DECLINED the call, and the code it declined under.
       *
       * The sibling of `call-held`, written for the same reason and against the same gap:
       * `present_answer`, `compose_report`, `compare_plans`, `recommend_change` and
       * `profile_table` perform no effect, so a refusal from one of them settles no step and
       * used to write nothing at all. A database tool that declines writes `tool-refused`; a
       * ledger tool that declines wrote silence.
       *
       * Measured cost of that silence, twice in one evening. One evaluated model loses
       * data-analysis on `no-answer`, and its ledger holds no hold and no answer — because
       * `present_answer` was called and refused, which sets `answerAttempted` and disables
       * the hold that would have asked again, invisibly. Five different refusals produce that
       * same trace, each implying a different fix, and the ledger could not say which.
       *
       * The CODE only, never the model's arguments and never the prose sent back: the codes
       * are this server's own vocabulary, so an entry cannot carry a model's text into the
       * record under the server's name. `stepId` is absent because no step exists — that is
       * what makes these tools ledger-only.
       */
      readonly kind: "call-declined";
      readonly tool: AgentToolName;
      readonly reasonCode: string;
      /**
       * Which FIELDS failed, when the refusal was about the shape of the call.
       *
       * The code alone turned out not to be diagnosable. `INVALID_TOOL_INPUT` is the largest
       * refusal family on record — a hundred and fifty across every model measured — and
       * One model produced eight of them in one run, holding the same tool, without
       * the record saying which part of the object was wrong even once.
       *
       * Still the server's own vocabulary and nothing else: these are the schema's field
       * paths and the types it expected, written by the validator. The model's arguments stay
       * out, as the code-only rule above intends — what is added is what THIS server said no
       * about, not what it was sent.
       */
      readonly detail?: string;
    })
  | (AgentRunEventBase & {
      /**
       * What the model said on the turn it stopped, when it called nothing and reported nothing.
       *
       * The largest unexplained group in this whole effort. Of 277 runs that scored
       * `no-report`, 190 ended `model-stopped` — not out of time, not out of turns, not refused
       * — and 122 of those had USED their tools first. The work was done and unfiled, and what
       * the model said as it stopped was nowhere: `closing-statement` is only written when the
       * drive concludes with prose it keeps, and these runs are exactly the ones whose prose the
       * verdict then discards.
       *
       * So a reader could not tell apart the three things this shape can be, each needing a
       * different fix: a model that wrote its report as prose and thought it had filed it, a
       * model that said it was finished, and a model that asked a question and waited for an
       * answer that was never coming.
       *
       * Bounded, because a stopping turn can carry a whole essay and this is a diagnostic and
       * not a transcript. Written at the moment of stopping rather than derived afterwards: the
       * turn's messages do not survive the drive.
       */
      readonly kind: "model-stopped-saying";
      readonly text: string;
    })
  | (AgentRunEventBase & {
      /**
       * A sentence the drive told the run, on a turn it did not refuse anything.
       *
       * The last invisible thing in the loop. `call-held` covers the notices attached to a
       * REFUSED call, and every other one — the report reminder, the plan-statement ask, the
       * reserve warning — was pushed into the conversation and left no trace, so a ledger could
       * not distinguish a run that ignored a reminder from a run that never got one.
       *
       * It cost a diagnosis to lack. One model was held on one plan, did exactly what
       * the hold asked (an index recommendation citing that plan), then stopped without
       * reporting — and whether the drive had told it to report was unanswerable from the
       * record, which is the difference between a model that declines and a mechanism that
       * never fired.
       *
       * `notice` names WHICH sentence rather than carrying it. The wording lives in
       * `models/notices.ts` — one baseline every model is told, since the per-model copies went
       * with the settings that became data — and a ledger repeating a paragraph in full would age
       * badly and read as this server's own prose.
       */
      readonly kind: "guidance-issued";
      readonly notice: AgentGuidanceNotice;
      /**
       * What the run had DONE when the sentence arrived (B51).
       *
       * The question `docs/llms/` exists to answer is "did this model do that by itself?",
       * and after #416 and #417 a ledger could say a notice was delivered without saying
       * where in the run it landed — a reminder on the second turn and one on the last are
       * different facts about a model. Both figures are the drive's own counters at the
       * moment of delivery.
       *
       * Optional, because a ledger written before they were recorded holds neither, and a
       * zero would say the notice arrived before the run did anything.
       */
      readonly atTurn?: number;
      /** Tool calls this run had made when it arrived. */
      readonly toolCalls?: number;
    })
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
       * without running it (the plan-mode SQL-generator design of 2026-08-15, item 5).
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
       *    inventory" from "there was no inventory to check against" and, since #414,
       *    from "no reader here can find a name in this engine's language", because an
       *    empty unknown list is a claim. Even the checked form is not permission to
       *    run: an inventory records what EXISTS, not what the user's role may select
       *    from.
       */
      readonly kind: "plan-statement-drafted";
      /** The statement as the model wrote it, verbatim, fence removed. */
      readonly sql: string;
      /** The engine it was written for — the connection this drive was given. */
      readonly dialect: DatabaseType;
      readonly readOnly: boolean;
      /**
       * Whether the guard could read this draft's language at all (#414).
       *
       * OPTIONAL on the event and required on `PlanStatementValidation`, which is not
       * an inconsistency: the validation is written now and always carries it, while
       * the event is also read back out of `.workflow-data` ledgers recorded before
       * #414. An absent value reads as `true` there, and truthfully — plan mode was
       * grounded on PostgreSQL and SQLite alone, so every draft those runs recorded
       * was SQL and every one of them was examined. Widening `readOnly` or renaming
       * anything here was the alternative, and it breaks those ledgers: the store's
       * `parseEntry` establishes only that a line is JSON, is an object and carries a
       * known event kind, then trusts the contract — so a field that changed meaning
       * would be re-read under its new one with no tripwire between.
       */
      readonly guardApplicable?: boolean;
      /** The guard's own reason, present exactly when `readOnly` is false AND the guard applied. */
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
       * Whether the run met the goal its workflow was opened for (ratified 2026-08-13
       * in #347).
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
 * One step of the conversation a run belongs to, as the SURFACE needs it.
 *
 * The objective is capped for carrying. A thread of twenty steps would otherwise
 * put twenty full objectives on every header after it, and the full text is one
 * `GET /api/agent/runs/{runId}` away on the run that owns it.
 */
export interface AgentThreadStep {
  readonly runId: string;
  readonly objective: string;
}

/**
 * What a run is told about the conversation it belongs to.
 *
 * Two consumers, two fields. `steps` serves the RAIL, which renders the
 * conversation from the header with no additional request. `text` serves the
 * MODEL, and holds inert content only: the instruction lines and the fence are
 * added when the prompt is built, so improving that wording never requires
 * rewriting a stored ledger, and the server's own voice never enters one.
 *
 * `text` is derived once, at open, rather than re-derived at drive time. A resumed
 * drive must reason from byte-identical context to the first drive, and a
 * predecessor's ledger going unreadable in between must not silently shrink what
 * the run was told — the same instinct the held context snapshot follows by
 * having no TTL.
 *
 * `declined` is set only when continuing a conversation was ASKED for and did not
 * happen. It is persisted rather than answered once, so a reload still shows the
 * notice rather than leaving the user to wonder.
 *
 * Inert by construction, like every other contract here: strings and ids. The
 * state guard therefore admits it exactly as it admits the objective.
 */
export interface AgentThreadContext {
  readonly threadId: string;
  /** Prior steps, oldest first. Empty for a thread's first run. */
  readonly steps: readonly AgentThreadStep[];
  readonly text: string;
  /**
   * How many steps have fallen off the FRONT of this conversation, across its whole
   * length rather than at this link.
   *
   * Cumulative because each header carries at most `AGENT_THREAD_MAX_STEPS`, so the
   * per-derivation figure is 1 forever once the cap is reached: a thirty-step
   * conversation would keep reporting that one step was dropped. Absent means none.
   */
  readonly droppedSteps?: number;
  /**
   * Why continuing did not happen, in codes a surface can say something specific about.
   *
   * `"disabled"` is the operator's switch (`LIBREDB_AGENT_THREAD_CONTEXT`), `"error"` an
   * unreadable ledger, and `"repointed"` a predecessor established against another
   * database than this connection now addresses.
   *
   * `"repointed"` is split out and the rest are not, and the line between them is NOT a
   * remedy. It was written as one — the decline was said to persist until the connection
   * is pointed back — and that was false: the route writes the CURRENT identity onto the
   * run this question opens (`route.ts`, the `connectionIdentity` field of its `start`
   * call), and an ordinary follow-up continues THAT run (`AgentRail.tsx`,
   * `continueTarget`), so the next question matches and carries. The decline is exactly
   * one question long, and pointing the connection back afterwards does not restore the
   * old conversation either — it declines once more, in the other direction.
   *
   * What earns the split is that this is the only code here that does not report a
   * failure. It is reached only after every check in `route.ts` has PASSED: the
   * predecessor exists, is this session's, is on this connection, has ended, and its
   * ledger read. The server then refuses the carry on purpose, because the earlier steps'
   * claims are about a database this run is not reading — carrying them would have been
   * WRONG, not merely impossible. Two consequences a shared sentence cannot deliver: the
   * user must not go hunting for a fault that does not exist, and they must learn that
   * their own saved connection has moved, which nothing else tells them. That last is
   * mechanical, not a guess: no client module computes `connectionIdentity` at all, and
   * the rail's own connection sentence (`AgentRail.tsx`, `connectionDropped`) compares
   * the connection's ID, which re-pointing a saved record does not change. This code is
   * the only channel the operator has for learning it moved.
   *
   * The five left under `"unavailable"` are failures and are alike as failures — the
   * predecessor does not exist, is not this session's, is on another connection, has not
   * ended, or is named by an id the ledger refuses. Two are the caller's own bug (no such
   * run, malformed id), one is transient and resolves by itself (not ended yet), one is
   * session-scoped and cannot be fixed from this session at all (another session's run),
   * and the last is a case the rail never reaches, because it withholds `previousRunId`
   * itself when the editor has moved and owns a specific sentence for it (`AgentRail.tsx`,
   * `connectionDropped`). Splitting them would also start telling a caller guessing ids
   * which of its guesses were wrong, which is the leak `"repointed"` does not have
   * (#512).
   */
  readonly declined?: "unavailable" | "disabled" | "error" | "repointed";
}

/**
 * The thread as a LEDGER HEADER carries it.
 *
 * `threadId` is absent when the run starts a conversation of its own, and the fold
 * supplies the run's own id — the same rule that lets a header with no thread at all
 * fold to a thread of one. It matters for a DECLINED continuation: naming that thread
 * after the run it was refused would make a later follow-up inherit a root that was
 * never part of the conversation.
 */
export type AgentThreadHeader = Omit<AgentThreadContext, "threadId"> & { readonly threadId?: string };

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
   * Whether the workflow above was inferred from the objective or picked by a person.
   *
   * On the record for the reason `mode` and `workflowType` are — a reader that
   * rehydrates after a reload must see what the run was opened with — though the
   * consequence is narrower: nothing the run DOES depends on it, only what the
   * surface says about it.
   *
   * Required here and optional on the ledger header, the same compatibility story the
   * two fields above have. A header written before the field folds to `"chosen"`;
   * `DEFAULT_AGENT_WORKFLOW_SOURCE` carries the reasoning.
   */
  readonly workflowSource: AgentRunWorkflowSource;
  /**
   * How the reading that produced that workflow went, when one was made.
   *
   * On the record for the reason `workflowSource` is, and it is the same reason twice:
   * the sentence the surface owes has to survive a reload, and a rail that rehydrates
   * from the ledger holds no memory of the classify request it never made. Without it
   * the provenance was durable and its OUTCOME was not, so a reloaded rail read a
   * fallback back to the user as a verdict.
   *
   * Required here and optional on the ledger header, the same compatibility story the
   * three fields above have. A header written before the field folds to
   * `"unrecorded"`; `DEFAULT_AGENT_WORKFLOW_READING` carries the reasoning.
   */
  readonly workflowReading: AgentRunWorkflowReading;
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
  /**
   * How this run asks its model for a tool call.
   *
   * Decided once, by the capability gate on the start path, and carried here for the
   * reason `autoExecute` is: a resumed drive must ask the same way the drive that died
   * asked, and a model's answer to "can you call tools" is not something a later turn
   * should re-decide mid-run.
   *
   * Optional, and absent folds to `native` — what was true of every run written before
   * the prose path existed, and of every model that can call a tool.
   */
  readonly toolProtocol?: AgentToolProtocol;
  /**
   * The conversation this run belongs to.
   *
   * Required HERE and optional on the ledger header, which is the whole
   * compatibility story in one sentence: the fold always produces a thread. A run
   * whose thread was not recorded is a thread of ONE, named after itself — which
   * is what was true of it, since no run belonged to a conversation then, and it
   * is equally true of a run that starts a conversation today.
   *
   * It is on the record for the reason every other header field is: a resumed
   * drive must be told the same thing the drive that died was told, so the context
   * has to live in the ledger rather than in a request body only the opener saw.
   */
  readonly thread: AgentThreadContext;
  readonly status: AgentRunStatus;
  readonly actor: AgentRunActor;
  /** The single connection this run may reach; the server builds the scope from it. */
  readonly connectionId: string;
  /**
   * WHICH DATABASE that connection addressed when this run opened, as
   * `connectionIdentity` fingerprints it: engine, host, port, database, service,
   * instance, role and the SSH tunnel it is reached through, and deliberately not the
   * password.
   *
   * The id above names the RECORD; this names the database behind it, and the two
   * are not the same fact. A saved connection edited to address another server keeps
   * its id, so a conversation checked only on the id carried one database's
   * established claims into a run reading another — nothing refused, nothing wrong to
   * look at, and a report about production resting on staging (#509).
   *
   * Optional because a header written before this field records nothing about the
   * database it read, and a mismatch must not be invented out of that silence: absent
   * is carried, a recorded identity that DISAGREES is what declines. Excluding the
   * password is the point of reusing that function rather than hashing the record —
   * rotating a credential does not change which database this is, and must not cost a
   * user the conversation they were having.
   */
  readonly connectionIdentity?: string;
  /** The user's own question, in their words. */
  readonly objective: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** The run's ledger, in order. The only history there is. */
  readonly events: readonly AgentRunEvent[];
}
