/**
 * What agent mode knows about each engine's STATEMENT LANGUAGE, and what each workflow is on each language, as data a
 * browser bundle may hold.
 *
 * Client-safe on purpose, like `engine-support.ts`: besides types it imports only the language packs' and the engines'
 * client facets (`languages/client.ts`, `languages/engines/client.ts`) and the leaf `workflow-tool-sets.ts`, which are
 * client-safe themselves, because the rail, the safety strip and the posture read it, and a provider module or
 * `node:crypto` here would reach a browser bundle. What a language DOES (its fingerprint, its advice, its admission) is
 * server code and lives in `languages/server.ts`.
 *
 * `AGENT_STATEMENT_LANGUAGE` is the list of engines agent mode reads statements on, keyed by type-id so no dialect
 * comparison is written anywhere. `tests/unit/lib/agent/agent-manifest.test.ts` holds it to every provider: an engine
 * has a language exactly when its provider has `queryReadOnly`.
 */
import type { DatabaseType } from "@/lib/types";
import type { AgentGoalVerifierId } from "./goal-verifier";
import { DEFAULT_STATEMENT_LANGUAGE, projectClientPacks, statementFamilyOf } from "./languages/client";
import { enginesSupporting } from "./languages/engines/client";
import type { AgentOperationId, AgentToolName } from "./tools";
import type { AgentRunMode, AgentRunWorkflowType } from "./types";
import { OPERATIONS_VARIANT } from "./workflow-tool-sets";

/** The statement languages agent mode can send. A later engine reuses one or registers a new id here. */
export type AgentStatementLanguageId = "sql" | "kubectl" | "mongo";

/** Literal-typed, so `AgentEngineFamily` in `languages/pack.ts` reads each engine's language by type. */
export const AGENT_STATEMENT_LANGUAGE = Object.freeze({
  postgres: "sql",
  bigquery: null,
  snowflake: null,
  spark: null,
  mysql: "sql",
  sqlite: "sql",
  libsql: null,
  duckdb: "sql",
  oracle: null,
  db2: null,
  mssql: "sql",
  clickhouse: null,
  druid: null,
  trino: null,
  cassandra: null,
  elasticsearch: null,
  opensearch: null,
  mongodb: "mongo",
  couchbase: null,
  redis: null,
  prometheus: null,
  kafka: null,
  etcd: null,
  neo4j: null,
  milvus: null,
  qdrant: null,
  weaviate: null,
  influxdb: null,
  influxdb3: null,
  oxia: null,
  databend: null,
  s3: null,
  kubernetes: "kubectl",
  mqtt: null,
  firestore: null,
  rabbitmq: null,
  opcua: null,
  mtconnect: null,
  modbus: null,
  netconf: null,
  snmp: null,
  sparkplug: null,
  libredb: null,
} as const satisfies Record<DatabaseType, AgentStatementLanguageId | null>);

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

/**
 * What a workflow variant needs of an engine beyond its language, evaluated over the engine TYPE so a client can
 * answer it with no provider in hand.
 */
export type AgentVariantRequirement = "sql-composers" | "cluster-usage-reading" | "cluster-workload-reading";

/**
 * The engines each requirement holds on. `sql-composers` is read from the engines' client dialects
 * (`enginesSupporting` in `languages/engines/client.ts`), which say client-safe what each server overlay supplies:
 * the engines that compose both a catalog read and an estimating plan. The cluster readings are mirrored, because the
 * providers declaring `agentReadings` reach server code. `agent-manifest.test.ts` holds `sql-composers` to the
 * composed-SQL entry points in `composed-sql.ts` and each cluster reading to those providers.
 */
export const AGENT_REQUIREMENT_ENGINES: Readonly<Record<AgentVariantRequirement, readonly DatabaseType[]>> =
  Object.freeze({
    "sql-composers": enginesSupporting("catalogRead", "planEstimate"),
    "cluster-usage-reading": Object.freeze<DatabaseType[]>(["kubernetes"]),
    "cluster-workload-reading": Object.freeze<DatabaseType[]>(["kubernetes"]),
  } satisfies Record<AgentVariantRequirement, readonly DatabaseType[]>);

/**
 * Raised when the manifest is asked about a language it does not hold, or for a variant an agent run cannot do
 * without. Never a database failure: nothing was reached.
 */
class AgentManifestError extends Error {
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
 * error rather than an absent variant: it can only be a ledger or a caller this file has never heard of.
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
 * Read by the start route, which refuses before a run id or a model turn is spent, and by the rail and the strip,
 * which say the same thing before Start is pressed. One function rather than three readings of the tables, so the
 * notice and the refusal cannot disagree about an engine.
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
  | { readonly open: false; readonly cause: "no-variant" | "requirement-unmet"; readonly sentence: string };

/**
 * The tables availability is decided from. A parameter rather than read inline so the two refusals the manifest
 * cannot produce while every language it holds is total stay tested: a language whose variants are being filled in
 * is exactly where they occur.
 */
interface AgentAvailabilityTables {
  readonly languages: Readonly<Record<DatabaseType, AgentStatementLanguageId | null>>;
  readonly variants: Readonly<
    Record<AgentStatementLanguageId, Readonly<Partial<Record<AgentRunWorkflowType, AgentWorkflowVariant>>>>
  >;
  readonly requirementEngines: Readonly<Record<AgentVariantRequirement, readonly DatabaseType[]>>;
}

const MANIFEST_TABLES: AgentAvailabilityTables = Object.freeze({
  languages: AGENT_STATEMENT_LANGUAGE,
  variants: AGENT_WORKFLOW_VARIANTS,
  requirementEngines: AGENT_REQUIREMENT_ENGINES,
});

const NO_VARIANT_SENTENCE =
  "Agent mode does not offer this workflow on this engine. The operations workflow runs here, and plan mode drafts here.";

/** Each requirement's refusal names what the engine lacks, and both ways forward that remain. */
const REQUIREMENT_SENTENCES: Readonly<Record<AgentVariantRequirement, string>> = Object.freeze({
  "sql-composers":
    "Agent mode has no verified catalog or plan composition for this engine, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
  "cluster-usage-reading":
    "This engine serves no usage reading, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
  "cluster-workload-reading":
    "This engine serves no workload profile, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
});

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
 * adapter gates it. Then operations, which sends no statement and opens on every engine, language or not. Only then
 * does the language matter, then whether it has the workflow, then whether the engine holds what the variant needs.
 */
export function workflowAvailability(
  mode: AgentRunMode,
  workflow: AgentRunWorkflowType,
  type: DatabaseType,
  tables: AgentAvailabilityTables = MANIFEST_TABLES,
): AgentWorkflowAvailability {
  const language = tables.languages[type];
  if (mode === "planning") {
    return {
      open: true,
      statementLanguage: language,
      variant: language === null ? null : (variantIn(tables, language, workflow) ?? null),
    };
  }
  if (workflow === "operations") return { open: true, statementLanguage: language, variant: OPERATIONS_VARIANT };
  if (language === null) return { open: false, cause: "no-adapter" };
  const variant = variantIn(tables, language, workflow);
  if (variant === undefined) return { open: false, cause: "no-variant", sentence: NO_VARIANT_SENTENCE };
  const unmet = variant.requires.find((requirement) => !tables.requirementEngines[requirement].includes(type));
  if (unmet !== undefined) return { open: false, cause: "requirement-unmet", sentence: REQUIREMENT_SENTENCES[unmet] };
  return { open: true, statementLanguage: language, variant };
}

/**
 * What a run opened under an availability persists: the language unless it is sql, the verifier unless it is the SQL
 * one. Absence is what both fields read as, so an SQL run writes the header bytes it always wrote. A plan is judged by
 * the planning rule whatever its variant says, so it never persists a verifier.
 */
export function persistedRunFacts(
  mode: AgentRunMode,
  workflow: AgentRunWorkflowType,
  availability: Extract<AgentWorkflowAvailability, { open: true }>,
): { readonly statementLanguage?: AgentStatementLanguageId; readonly verifier?: AgentGoalVerifierId } {
  const language = availability.statementLanguage;
  const sqlVerifier = requiredVariant(DEFAULT_STATEMENT_LANGUAGE, workflow).verifier;
  const verifier = mode === "agent" ? availability.variant?.verifier : undefined;
  return {
    ...(language === null || language === DEFAULT_STATEMENT_LANGUAGE ? {} : { statementLanguage: language }),
    ...(verifier === undefined || verifier === sqlVerifier ? {} : { verifier }),
  };
}
