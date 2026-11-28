/**
 * What agent mode knows about each engine's STATEMENT LANGUAGE, and what each workflow is on each language, as data a
 * browser bundle may hold.
 *
 * Client-safe on purpose, like `engine-support.ts`: besides types it imports only the language packs' and the engines'
 * client facets (`languages/client.ts`, `languages/engines/client.ts`), the leaf `workflow-tool-sets.ts`, the type id
 * check `@/lib/db/type-id.ts`, the shipped type ids of `@/lib/db/compatibility.ts` and Studio's grant reader
 * `@/lib/db/claim-grants.ts` (the grant register's rows and the generated claim requests), which are client-safe
 * themselves, because the rail, the safety strip and the posture read it, and a provider module or `node:crypto` here
 * would reach a browser bundle. What a language DOES (its fingerprint, its advice, its admission) is server code and
 * lives in `languages/server.ts`.
 *
 * Availability is decided over an engine, `AgentEngine`: its id and the grants of its engine record, so no table here
 * is keyed by an engine. On the server the caller hands the connection's engine record (`servedEngineRecord`), a legacy
 * engine's or a provider package's alike; the browser, which holds a legacy connection type and no record until M7,
 * hands `legacyAgentEngine(type)`, the legacy grants the legacy record holds. The statement language an engine speaks
 * is Studio's grant of the claim its declaration requests, `grants.statementLanguage` (docs/providers/CONTRACT.md,
 * clause M-83), read through `grantedAgentStatementLanguage` of `languages/client.ts`; Studio's review of it is the
 * `statementLanguage` member of the engine's row in the grant register, and `tests/unit/lib/agent/agent-manifest.test.ts`
 * holds each legacy row to its provider: an engine has a language exactly when its provider has `queryReadOnly`.
 */
import { type EngineGrants, legacyEngineGrants } from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { assertDatabaseType } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";
import type { AgentGoalVerifierId } from "./goal-verifier";
import {
  AGENT_PACK_REQUIREMENTS,
  DEFAULT_STATEMENT_LANGUAGE,
  grantedAgentStatementLanguage,
  projectClientPacks,
  statementFamilyOf,
} from "./languages/client";
import { enginesSupporting } from "./languages/engines/client";
import type { AgentPackVariantRequirement, AgentVariantRequirementSpec } from "./languages/pack";
import type { AgentOperationId, AgentToolName } from "./tools";
import type { AgentRunMode, AgentRunWorkflowType } from "./types";
import { OPERATIONS_VARIANT } from "./workflow-tool-sets";

/**
 * The statement languages Studio holds as modules, each with a pack under `languages/<id>/`. A later engine reuses one,
 * or declares its language as data (`AgentDeclaredLanguageId`).
 */
export type AgentModuleLanguageId =
  | "sql"
  | "kubectl"
  | "mongo"
  | "libredbkv"
  | "influxql"
  | "weaviateapi"
  | "qdrantapi"
  | "cypher"
  | "milvusrpc"
  | "rediscli"
  | "etcdctl"
  | "oxiacli"
  | "rabbitread"
  | "s3api"
  | "fsquery"
  | "snmpget"
  | "netconfrpc"
  | "modbusread"
  | "promql"
  | "opcuaread"
  | "mtconnectread"
  | "mqttread"
  | "sparkplugread";

declare const declaredLanguage: unique symbol;

/**
 * A statement language an engine declares as data (`statementLanguageData` of its declaration), with no module of its
 * own: its name, branded so a bare string is not one. Only `declaredAgentLanguages` in `languages/declared-client.ts`
 * brands a name, at load, and `isAgentStatementLanguage` in `languages/client.ts` narrows any other string to one.
 */
export type AgentDeclaredLanguageId = string & { readonly [declaredLanguage]: true };

/**
 * The statement languages agent mode can send: the module languages, and the languages the bundled declarations state
 * as data. A record over this type is total over the module languages at compile time; it holds a declared language
 * only where the registry building it adds one, which `languages/client.ts` does for every registry it feeds.
 */
export type AgentStatementLanguageId = AgentModuleLanguageId | AgentDeclaredLanguageId;

/** The name of the model argument a language's statement arrives in: one type for every reader of it. */
export type AgentStatementArgument = "sql" | "statement" | "command";

/**
 * The words a language contributes to the sentences a run reads. The SQL entry is the wording the agent rules have
 * always used, and the D6 golden file holds it there.
 */
export interface AgentLanguageCopy {
  /** What the run investigates, as the first rule names it. */
  readonly subject: string;
  /** What one unit the model sends is called. */
  readonly noun: string;
  /** The name of the model argument that carries it. Persisted event fields keep `sql` whatever this says. */
  readonly argument: AgentStatementArgument;
  /** What the boundary refuses, as the rules name it. */
  readonly writes: string;
  /** What a refused statement never reaches. */
  readonly reached: string;
  /** What a policy refusal is not a defect in. */
  readonly defect: string;
  /** The commands that have row-cap advice of their own; the server registry answers each one. */
  readonly adviceKeys: readonly string[];
}

/** Each language's copy, the entry its client pack (`languages/<id>/client.ts`) holds. */
export const AGENT_LANGUAGE_COPY: Readonly<Record<AgentStatementLanguageId, AgentLanguageCopy>> = projectClientPacks(
  (pack) => pack.copy,
);

/**
 * The operation each language's `inspect_plan` drives, which is the id a run's plan artifacts are recorded under;
 * null for a language with no plan to read (no kubectl variant offers `inspect_plan`). Kept here, client-safe, so
 * every reader that asks whether an artifact is a plan reads one record rather than a set of its own, and a
 * language's plans count wherever plans are counted. `agent-manifest.test.ts` holds each entry to the
 * `inspect_plan` definition the run is offered.
 */
export const AGENT_PLAN_ESTIMATE_OPERATION: Readonly<Record<AgentStatementLanguageId, AgentOperationId | null>> =
  projectClientPacks((pack) => pack.planEstimateOperation);

/** Every language's plan-estimate operation: the question "is this artifact a plan", asked of any language. */
export const PLAN_ESTIMATE_OPERATIONS: ReadonlySet<string> = new Set(
  Object.values(AGENT_PLAN_ESTIMATE_OPERATION).filter((operation): operation is AgentOperationId => operation !== null),
);

/** One member of every requirement a pack names, keyed by requirement in the order the packs declare them. */
function packRequirementProjection<Value>(
  pick: (spec: AgentVariantRequirementSpec) => Value,
): Record<AgentPackVariantRequirement, Value> {
  return Object.fromEntries(
    Object.entries(AGENT_PACK_REQUIREMENTS).map(([requirement, spec]) => [requirement, pick(spec)]),
  ) as Record<AgentPackVariantRequirement, Value>;
}

/**
 * What a workflow variant needs of an engine beyond its language, evaluated over the engine's id, or its grants for
 * `agent-readings`, so a client can answer it with no provider in hand. A requirement only one language's variants
 * name is its pack's own (`AgentPackVariantRequirement`).
 */
export type AgentVariantRequirement = "sql-catalog" | "sql-composers" | "agent-readings" | AgentPackVariantRequirement;

/** The requirements a list of engine ids answers: every one but `agent-readings`, which the engine's grants answer. */
type AgentListedRequirement = Exclude<AgentVariantRequirement, "agent-readings">;

/**
 * The engines each listed requirement holds on. `sql-catalog` and `sql-composers` are read from the engines' client dialects
 * (`enginesSupporting` in `languages/engines/client.ts`), which say client-safe what each server overlay supplies:
 * the engines that compose a catalog read, and those that compose both a catalog read and an estimating plan. A
 * statement workflow names the one it cannot run without, so a dialect with no estimating plan still opens every
 * workflow whose verdict cites none; the assessment verdict's table profile is deliberately not held (`client.ts`).
 * A pack's requirement holds on the engines its pack names (`AGENT_PACK_REQUIREMENTS`). `agent-readings`, which the
 * operations variant names, has no list: it holds on an engine whose own grants hold at least one curated reading
 * (`operationsWorkflowOpens`), so a package engine's reading counts too.
 * `agent-manifest.test.ts` holds both SQL requirements to the composed-SQL entry points in `composed-sql.ts` and each
 * pack requirement to the providers that declare its reading.
 */
export const AGENT_REQUIREMENT_ENGINES: Readonly<Record<AgentListedRequirement, readonly DatabaseType[]>> =
  Object.freeze({
    "sql-catalog": enginesSupporting("catalogRead"),
    "sql-composers": enginesSupporting("catalogRead", "planEstimate"),
    ...packRequirementProjection((spec) => spec.engines),
  } satisfies Record<AgentListedRequirement, readonly DatabaseType[]>);

/**
 * Raised when the manifest is asked about a language it does not hold, or for a variant an agent run cannot do
 * without. Never a database failure: nothing was reached. Exported so the workflow classifier raises the manifest's
 * own class when the workflows it is offered leave nothing to classify into.
 */
export class AgentManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentManifestError";
    Object.setPrototypeOf(this, AgentManifestError.prototype);
  }
}

/**
 * What a plan of a workflow is to produce (section 3 of the plan-mode design).
 *
 * Per workflow rather than one sentence for every workflow, because one sentence is what makes a plan of a query
 * optimization ask for "the statement that answers the question" when the objective already came with one.
 *
 * `operations` plans in prose, and that is a ruling rather than an omission. No reading of that workflow can be
 * REQUIRED to be a statement, because the workflow deliberately runs on engines where none is: asking for a fenced
 * statement would be a rule its own subject matter cannot satisfy on half its engines, which is the #350 failure. So
 * the plan is judged as prose, is exempt from the planning statement rule, and may fence a statement where the engine
 * happens to express the reading as one.
 */
export type AgentPlanDeliverable = { readonly kind: "statement"; readonly noun: string } | { readonly kind: "prose" };

/**
 * One workflow on one statement language: what it is offered, what it is told, and what it is judged by.
 *
 * Tool overrides are keyed by the variant rather than by the language, because a language's tools are not uniform
 * across its workflows: what one kubectl workflow is offered says nothing about what another is.
 */
export interface AgentWorkflowVariant {
  /** The tools an agent-mode run is offered, in the order they are sent. */
  readonly tools: readonly AgentToolName[];
  /**
   * What a narrowed run keeps BESIDES `compose_report`: whatever its own verdict requires.
   *
   * The narrowing exists for `no-report`, and it must not make a run's own bar unreachable: leaving an assessment
   * the report alone would trade `no-report` for `no-table-profile`, a different failure rather than a smaller one.
   * So each variant keeps the instruments its verdict accepts, and a narrowed run can only do the two or three
   * things it is judged on. A workflow whose bar is about the report itself keeps nothing extra.
   */
  readonly narrowedExtras: readonly AgentToolName[];
  /** The line the workflow classifier is told about this workflow. */
  readonly classifierDescription: string;
  /** What the run is FOR. Said in BOTH modes: a plan for an optimization is still about one. */
  readonly objective: string;
  /** What a plan of it hands back; "inherits" reads the SQL variant's. */
  readonly planDeliverable: AgentPlanDeliverable | "inherits";
  /** Whether the auto-execute setting may be offered: only where the workflow presents an answer. */
  readonly canAutoExecute: boolean;
  /** What the engine must hold beyond the language for the variant to be offered. */
  readonly requires: readonly AgentVariantRequirement[];
  /** The goal verifier a run of it is judged by. */
  readonly verifier: AgentGoalVerifierId;
}

/**
 * Every workflow on every language. A language with no entry for a workflow cannot run it in agent mode; a plan of it
 * reads the SQL variant's objective and deliverable instead, because planning is never gated by a language.
 *
 * The SQL record is total over `AgentRunWorkflowType`, in the union's order, which is the order the classifier
 * lists the workflows in. Each language's record is the one its client pack (`languages/<id>/client.ts`) holds.
 */
export const AGENT_WORKFLOW_VARIANTS: Readonly<
  Record<AgentStatementLanguageId, Readonly<Partial<Record<AgentRunWorkflowType, AgentWorkflowVariant>>>>
> = projectClientPacks((pack) => pack.variants);

/**
 * The variant of one workflow on one language, or undefined when the language has none. An absent language reads as
 * `sql`, which is what a run recorded before languages existed was. A language the manifest does not hold is an
 * error rather than an absent variant. A ledger naming one is refused when it is read (`runHeaderRefusal`), so the
 * throw here is a caller's error.
 */
export function agentVariant(
  language: AgentStatementLanguageId | undefined,
  workflow: AgentRunWorkflowType,
): AgentWorkflowVariant | undefined {
  const id = statementFamilyOf(language);
  if (!Object.hasOwn(AGENT_WORKFLOW_VARIANTS, id)) throw new AgentManifestError(`unknown statement language ${id}`);
  // The workflow is read from a ledger too, so it is guarded the same way: a name such as `toString` must be a
  // missing variant, never the inherited method.
  const variants: Partial<Record<AgentRunWorkflowType, AgentWorkflowVariant>> = AGENT_WORKFLOW_VARIANTS[id];
  return Object.hasOwn(variants, workflow) ? variants[workflow] : undefined;
}

/** The variant an agent-mode run cannot do without. Its absence is an explicit error, never a fallback. */
export function requiredVariant(
  language: AgentStatementLanguageId | undefined,
  workflow: AgentRunWorkflowType,
): AgentWorkflowVariant {
  const variant = agentVariant(language, workflow);
  if (variant === undefined) throw new AgentManifestError(`no ${workflow} variant for ${statementFamilyOf(language)}`);
  return variant;
}

/**
 * What a plan of this workflow hands back. A variant that inherits, and a language with no variant at all, read the
 * SQL variant's: planning is never gated by a language, so a plan always has a deliverable to ask for.
 */
export function planDeliverableOf(
  language: AgentStatementLanguageId | undefined,
  workflow: AgentRunWorkflowType,
): AgentPlanDeliverable {
  const own = agentVariant(language, workflow)?.planDeliverable;
  if (own !== undefined && own !== "inherits") return own;
  const inherited = requiredVariant(DEFAULT_STATEMENT_LANGUAGE, workflow).planDeliverable;
  if (inherited === "inherits") throw new AgentManifestError(`the sql ${workflow} variant inherits from nothing`);
  return inherited;
}

/**
 * The objective a plan of this workflow is given. A language with no variant of the workflow reads the SQL
 * variant's, for the reason `planDeliverableOf` does: planning is never gated by a language.
 */
export function planObjectiveOf(
  language: AgentStatementLanguageId | undefined,
  workflow: AgentRunWorkflowType,
): string {
  return (agentVariant(language, workflow) ?? requiredVariant(DEFAULT_STATEMENT_LANGUAGE, workflow)).objective;
}

/**
 * Whether a run of one workflow opens on one engine in one mode, and under what.
 *
 * Read by the start route, which refuses before a run id or a model turn is spent. The rail and the strip read the
 * legacy engine's `statementLanguage` grant directly to say the same thing before Start is pressed, the same grant this
 * reads, so the notice and the refusal cannot disagree about an engine.
 */
export type AgentWorkflowAvailability =
  | {
      readonly open: true;
      /** The language to persist on the run; null where the engine has none (operations and planning only). */
      readonly statementLanguage: AgentStatementLanguageId | null;
      /** The variant the run is opened under; null for a planning run on an engine with no language. */
      readonly variant: AgentWorkflowVariant | null;
    }
  | { readonly open: false; readonly cause: "no-adapter" }
  /**
   * The engine requests a statement language, and Studio's review does not let agent mode send it statements: its
   * engine record grants no agent execution, or grants none of the language it requests.
   */
  | { readonly open: false; readonly cause: "not-reviewed" }
  | { readonly open: false; readonly cause: "no-variant" | "requirement-unmet"; readonly sentence: string };

/**
 * The engine availability is decided over: its id, and the grants of its engine record availability reads, the
 * statement language granted and requested, agent execution and the curated readings. An engine record
 * (`EngineRecord` in `@/lib/db/server-catalog`) is one, a legacy engine's or a provider package's; in the browser,
 * which holds a legacy connection type and no record until M7, `legacyAgentEngine` answers one.
 */
export interface AgentEngine {
  readonly id: string;
  readonly grants: Pick<
    EngineGrants,
    "statementLanguage" | "requestsStatementLanguage" | "agentExecution" | "agentReadings"
  >;
}

/**
 * Legacy engine `type` as availability reads it: its id and the legacy grants its legacy record holds
 * (`legacyEngineGrants`), the very object, so the browser and the server read one grant. A value that is not a type
 * id is refused by name first (FND-1), so no grant answers for it.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no provider.
 */
export function legacyAgentEngine(type: DatabaseType): AgentEngine {
  assertDatabaseType(type);
  return Object.freeze({ id: type, grants: legacyEngineGrants(type) });
}

/**
 * The tables availability is decided from besides the engine's grants. A parameter rather than read inline so the two
 * refusals the manifest cannot produce while every language it holds is total stay tested: a language whose variants
 * are being filled in is exactly where they occur. Every requirement but `agent-readings`, which the engine's own
 * grants answer (`operationsWorkflowOpens`), is read from `requirementEngines` as a list of engine ids.
 */
interface AgentAvailabilityTables {
  readonly variants: Readonly<
    Record<AgentStatementLanguageId, Readonly<Partial<Record<AgentRunWorkflowType, AgentWorkflowVariant>>>>
  >;
  readonly requirementEngines: Readonly<Record<AgentListedRequirement, readonly string[]>>;
}

const MANIFEST_TABLES: AgentAvailabilityTables = Object.freeze({
  variants: AGENT_WORKFLOW_VARIANTS,
  requirementEngines: AGENT_REQUIREMENT_ENGINES,
});

/**
 * Whether the operations workflow opens in agent mode on `engine`: its engine record grants agent mode at least one
 * curated reading, the variant requirement `agent-readings`. Read by the availability arm, the start route's
 * not-reviewed sentence and the posture, so none names the workflow as a way forward where it does not open.
 */
export function operationsWorkflowOpens(engine: Pick<AgentEngine, "grants">): boolean {
  return engine.grants.agentReadings.length > 0;
}

/** Whether `engine` holds `requirement`: its own grants for `agent-readings`, the tables' list for any other. */
function holdsRequirement(
  requirement: AgentVariantRequirement,
  engine: AgentEngine,
  tables: AgentAvailabilityTables,
): boolean {
  if (requirement === "agent-readings") return operationsWorkflowOpens(engine);
  return tables.requirementEngines[requirement].includes(engine.id);
}

/** The refusal of a workflow the engine's language has no variant of, naming only the ways forward that open there. */
function noVariantSentence(operationsOpens: boolean): string {
  return operationsOpens
    ? "Agent mode does not offer this workflow on this engine. The operations workflow runs here, and plan mode drafts here."
    : "Agent mode does not offer this workflow on this engine. Plan mode drafts here.";
}

/**
 * The refusal of a statement-sending run on an engine that requests a statement language Studio's review does not let
 * agent mode send, naming the engine and the ways forward that remain on it: the operations workflow only where it
 * opens, `operationsOpens` (`operationsWorkflowOpens`), as `noVariantSentence` names it.
 */
export function notReviewedSentence(engineLabel: string, operationsOpens: boolean): string {
  const refusal = `Agent mode runs statements only on the engines whose read-only statement path Studio has reviewed, and ${engineLabel} is not one of them, so a run whose workflow sends a statement is not opened on it.`;
  return operationsOpens
    ? `${refusal} The operations workflow runs here, and plan mode drafts here.`
    : `${refusal} Plan mode drafts here.`;
}

/**
 * Each requirement's refusal names what the engine lacks, and the ways forward that remain on every engine it can be
 * shown on. `sql-composers` is shown on engines that may still hold `sql-catalog`, so its sentence claims no missing
 * catalog and names no workflow but operations, the one that opens everywhere.
 */
const REQUIREMENT_SENTENCES: Readonly<Record<AgentVariantRequirement, string>> = Object.freeze({
  "sql-catalog":
    "Agent mode has no verified catalog composition for this engine, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
  "sql-composers":
    "This workflow needs both a catalog read and an estimating plan, and agent mode has no verified composition of both for this engine, so this workflow's tools could only refuse. Workflows that need less still run here, the operations workflow among them, and plan mode drafts here.",
  "agent-readings":
    "Agent mode takes no operational reading on this engine: it offers agent mode none of the session, slow-query, table, index, storage or health readings, so the operations workflow's reading tool could only refuse. Plan mode drafts here.",
  ...packRequirementProjection((spec) => spec.sentence),
} satisfies Record<AgentVariantRequirement, string>);

/** `agentVariant` over the given tables, guarded the same way against a workflow naming an inherited property. */
function variantIn(
  tables: AgentAvailabilityTables,
  language: AgentStatementLanguageId,
  workflow: AgentRunWorkflowType,
): AgentWorkflowVariant | undefined {
  const variants = tables.variants[language];
  return Object.hasOwn(variants, workflow) ? variants[workflow] : undefined;
}

/**
 * The arms in the order they exclude each other. Plan mode first, because it executes nothing it drafts and so no
 * adapter gates it. Then operations, which sends no statement and opens on every engine whose record grants agent mode
 * a curated reading (its `agent-readings` requirement), language or not. Only then does the language matter: an engine
 * granted none answers `no-adapter` where it requests none and `not-reviewed` where it requests one Studio's review did
 * not grant. Then whether the engine record grants agent execution (the grant the provider factory and the core read
 * path read again at run time), then whether the language has the workflow, then whether the engine holds what the
 * variant needs. Agent execution is read after the language, so an engine with neither keeps the `no-adapter` answer.
 * Every legacy engine requests a language exactly where its row grants one and is executed exactly there
 * (tests/unit/db/claim-grants.test.ts), so no legacy engine reaches `not-reviewed`.
 */
export function workflowAvailability(
  mode: AgentRunMode,
  workflow: AgentRunWorkflowType,
  engine: AgentEngine,
  tables: AgentAvailabilityTables = MANIFEST_TABLES,
): AgentWorkflowAvailability {
  const language = grantedAgentStatementLanguage(engine);
  if (mode === "planning") {
    return {
      open: true,
      statementLanguage: language,
      variant: language === null ? null : (variantIn(tables, language, workflow) ?? null),
    };
  }
  if (workflow === "operations") {
    if (!operationsWorkflowOpens(engine)) {
      return { open: false, cause: "requirement-unmet", sentence: REQUIREMENT_SENTENCES["agent-readings"] };
    }
    return { open: true, statementLanguage: language, variant: OPERATIONS_VARIANT };
  }
  if (language === null) {
    return engine.grants.requestsStatementLanguage
      ? { open: false, cause: "not-reviewed" }
      : { open: false, cause: "no-adapter" };
  }
  if (!engine.grants.agentExecution) return { open: false, cause: "not-reviewed" };
  const variant = variantIn(tables, language, workflow);
  if (variant === undefined) {
    return { open: false, cause: "no-variant", sentence: noVariantSentence(operationsWorkflowOpens(engine)) };
  }
  const unmet = variant.requires.find((requirement) => !holdsRequirement(requirement, engine, tables));
  if (unmet !== undefined) return { open: false, cause: "requirement-unmet", sentence: REQUIREMENT_SENTENCES[unmet] };
  return { open: true, statementLanguage: language, variant };
}

/**
 * The workflows `workflowAvailability` opens on `engine` in `mode`, in the SQL record's order, which is the union's and
 * the order the workflow classifier lists them in. Read by the classify route, so an objective is classified only into
 * a workflow Start then opens (F2): in agent mode on an engine with no operations reading, or on one whose language
 * lacks a variant or a requirement, the refused workflows are never offered. Plan mode opens every workflow.
 */
export function openWorkflows(
  mode: AgentRunMode,
  engine: AgentEngine,
  tables: AgentAvailabilityTables = MANIFEST_TABLES,
): readonly AgentRunWorkflowType[] {
  const order = Object.keys(tables.variants[DEFAULT_STATEMENT_LANGUAGE]) as AgentRunWorkflowType[];
  return Object.freeze(order.filter((workflow) => workflowAvailability(mode, workflow, engine, tables).open));
}

/**
 * What a run opened under an availability on an engine persists: the engine's id, `engine`, in every mode, because it
 * is a fact of the run rather than of its tools; the language unless it is sql; the verifier unless it is the SQL one.
 * Absence is what the last two read as. A plan is judged by the planning rule whatever its variant says, so it never
 * persists a verifier.
 */
export function persistedRunFacts(
  mode: AgentRunMode,
  workflow: AgentRunWorkflowType,
  engine: string,
  availability: Extract<AgentWorkflowAvailability, { open: true }>,
): {
  readonly engine: string;
  readonly statementLanguage?: AgentStatementLanguageId;
  readonly verifier?: AgentGoalVerifierId;
} {
  const language = availability.statementLanguage;
  const sqlVerifier = requiredVariant(DEFAULT_STATEMENT_LANGUAGE, workflow).verifier;
  const verifier = mode === "agent" ? availability.variant?.verifier : undefined;
  return {
    engine,
    ...(language === null || language === DEFAULT_STATEMENT_LANGUAGE ? {} : { statementLanguage: language }),
    ...(verifier === undefined || verifier === sqlVerifier ? {} : { verifier }),
  };
}
