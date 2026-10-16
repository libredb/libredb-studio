/**
 * What agent mode knows about each engine's STATEMENT LANGUAGE, and what each workflow is on each language, as data a
 * browser bundle may hold.
 *
 * Client-safe on purpose, like `engine-support.ts`: it imports types and nothing else, because the rail, the safety
 * strip and the posture read it, and a provider module or `node:crypto` here would reach a browser bundle. What a
 * language DOES (its fingerprint, its advice, its admission) is server code and lives in `statement-languages.ts`.
 *
 * `AGENT_STATEMENT_LANGUAGE` is the list of engines agent mode reads statements on, keyed by type-id so no dialect
 * comparison is written anywhere. `tests/unit/lib/agent/agent-manifest.test.ts` holds it to every provider: an engine
 * has a language exactly when its provider has `queryReadOnly`.
 */
import type { DatabaseType } from "@/lib/types";
import type { AgentGoalVerifierId } from "./goal-verifier";
import type { AgentToolName } from "./tools";
import type { AgentRunMode, AgentRunWorkflowType } from "./types";

/** The statement languages agent mode can send. A later engine reuses one or registers a new id here. */
export type AgentStatementLanguageId = "sql" | "kubectl";

export const AGENT_STATEMENT_LANGUAGE: Readonly<Record<DatabaseType, AgentStatementLanguageId | null>> = Object.freeze({
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
  mongodb: null,
  couchbase: null,
  redis: null,
  prometheus: null,
  kafka: null,
  etcd: null,
  neo4j: null,
  milvus: null,
  qdrant: null,
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
  libredb: null,
} satisfies Record<DatabaseType, AgentStatementLanguageId | null>);

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
  readonly argument: "sql" | "statement";
  /** What the boundary refuses, as the rules name it. */
  readonly writes: string;
  /** What a refused statement never reaches. */
  readonly reached: string;
  /** What a policy refusal is not a defect in. */
  readonly defect: string;
  /** The commands that have row-cap advice of their own; the server registry answers each one. */
  readonly adviceKeys: readonly string[];
}

export const AGENT_LANGUAGE_COPY: Readonly<Record<AgentStatementLanguageId, AgentLanguageCopy>> = Object.freeze({
  sql: Object.freeze({
    subject: "a database",
    noun: "statement",
    argument: "sql",
    writes: "writes and DDL",
    reached: "the database",
    defect: "your SQL",
    adviceKeys: Object.freeze([]),
  }),
  kubectl: Object.freeze({
    subject: "a Kubernetes cluster",
    noun: "statement",
    argument: "statement",
    writes: "writes, exec, port-forward, proxy and watches",
    reached: "the cluster",
    defect: "your kubectl statement",
    adviceKeys: Object.freeze(["get", "top", "logs", "events"]),
  }),
} satisfies Record<AgentStatementLanguageId, AgentLanguageCopy>);

/**
 * What a workflow variant needs of an engine beyond its language, evaluated over the engine TYPE so a client can
 * answer it with no provider in hand.
 */
export type AgentVariantRequirement = "sql-composers" | "cluster-usage-reading" | "cluster-workload-reading";

/**
 * The engines each requirement holds on. Mirrored rather than computed, for the reason `posture.ts` mirrors
 * `CATALOG_PLANS`: the registries it mirrors reach server code. `agent-manifest.test.ts` holds `sql-composers` to the
 * composer registries in `composed-sql.ts` and each cluster reading to the providers declaring `agentReadings`.
 */
export const AGENT_REQUIREMENT_ENGINES: Readonly<Record<AgentVariantRequirement, readonly DatabaseType[]>> =
  Object.freeze({
    "sql-composers": Object.freeze<DatabaseType[]>(["postgres", "sqlite", "duckdb", "mssql", "mysql"]),
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

/** The read-class four every SQL statement workflow starts from. */
const READ_CLASS_TOOLS: readonly AgentToolName[] = [
  "inspect_schema",
  "run_read_query",
  "inspect_plan",
  "compose_report",
];

/**
 * The operations workflow, one variant for every language because it sends no statement at all.
 *
 * Its tools are the ONLY set not built on the read-class four. All three of the read-class tools it leaves out,
 * `inspect_schema`, `run_read_query` and `inspect_plan`, reach the database through `provider.queryReadOnly`, which
 * only the engines `AGENT_EXECUTION_ENGINES` (`engine-support.ts`) names implement. Offering any of them here would
 * reintroduce, tool by tool, the exact engine restriction this workflow exists to escape: the run would open on an
 * engine with no read-only statement path, be offered a tool, call it, and be answered by an acquisition that
 * refuses the engine. `inspect_schema` was checked rather than assumed: it composes a statement and runs it through
 * `provider.queryReadOnly`, so it is left out.
 *
 * `recommend_change` is here and `compare_plans` is not: a comparison names two `inspect_plan` artifacts this run
 * cannot produce, so offering it would be offering a tool that can only ever refuse.
 */
const OPERATIONS_VARIANT: AgentWorkflowVariant = Object.freeze({
  tools: Object.freeze<AgentToolName[]>(["inspect_operations", "recommend_change", "compose_report"]),
  narrowedExtras: Object.freeze<AgentToolName[]>([]),
  classifierDescription: "how the database is RUNNING right now: connections, waits, blocking, space and index usage",
  objective:
    "Your objective is how this database is RUNNING right now: what is connected to it, what it is spending its time on, what is blocked, and where its space and its indexes are going.",
  planDeliverable: Object.freeze({ kind: "prose" }),
  canAutoExecute: false,
  requires: Object.freeze<AgentVariantRequirement[]>([]),
  verifier: "agent-operations.2",
});

/**
 * Every workflow on every language. A language with no entry for a workflow cannot run it in agent mode; a plan of it
 * reads the SQL variant's objective and deliverable instead, because planning is never gated by a language.
 *
 * The SQL record is total over `AgentRunWorkflowType`, in the union's order, which is the order the classifier
 * lists the workflows in.
 */
export const AGENT_WORKFLOW_VARIANTS: Readonly<
  Record<AgentStatementLanguageId, Readonly<Partial<Record<AgentRunWorkflowType, AgentWorkflowVariant>>>>
> = Object.freeze({
  sql: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze([...READ_CLASS_TOOLS]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription: "a question about the database that is answered from what the run establishes",
      objective: "Your objective is a question about this database. Answer it from what you establish.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the statement that answers the question" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["sql-composers"]),
      verifier: "agent-investigation.1",
    }),
    /**
     * The optimization template's own two tools on top of the read-class four, offered to this workflow alone, which
     * is what makes the axis load-bearing: an investigation that calls `compare_plans` is told there is no such
     * tool, because for that run there is not.
     */
    "query-optimization": Object.freeze({
      tools: Object.freeze<AgentToolName[]>([...READ_CLASS_TOOLS, "compare_plans", "recommend_change"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["compare_plans", "recommend_change"]),
      classifierDescription: "a specific statement that is too slow, and how the engine reaches its rows",
      objective:
        "Your objective is a statement that is too slow. What matters is HOW the engine reaches its rows, and what change would make it reach them differently.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the rewritten statement" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["sql-composers"]),
      verifier: "agent-query-optimization.3",
    }),
    /** The assessment template's own tool, on top of the read-class four. */
    "database-assessment": Object.freeze({
      tools: Object.freeze<AgentToolName[]>([...READ_CLASS_TOOLS, "profile_table"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["profile_table"]),
      classifierDescription: "the state of the data itself: where it is incomplete, inconsistent or surprising",
      objective:
        "Your objective is the state of this database itself: where its data is incomplete, inconsistent or surprising.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the statement that measures the quality concern" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["sql-composers"]),
      verifier: "agent-database-assessment.1",
    }),
    operations: OPERATIONS_VARIANT,
    /**
     * The analysis template's two tools on top of the read-class four.
     *
     * `present_answer` is the one this workflow's verdict requires, and it is offered HERE and nowhere else for
     * exactly that reason: a tool a run's bar never asks for is a tool that can only distract it. A narrowed run
     * keeps it because the verdict scores the answer separately from the report.
     *
     * `profile_table` is borrowed from the assessment template at basic depth. The schema carries no row counts, so
     * a 400 M-row fact table and a 12-row lookup table are indistinguishable in the inventory, and a `shipped_at`
     * that is 80% null beside a fully populated `placed_at` says which date column the business actually fills.
     * Basic depth answers both, costs one statement per table, and reads no value out of any column, which is what
     * makes pointing it at a table of personal data acceptable at all.
     */
    "data-analysis": Object.freeze({
      tools: Object.freeze<AgentToolName[]>([...READ_CLASS_TOOLS, "profile_table", "present_answer"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["present_answer"]),
      classifierDescription: "a question about the data whose answer is a result the user wants to see",
      objective:
        "Your objective is a question about the data in this database. Establish the answer from the data and produce something to show for it.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the statement that produces the answer" }),
      canAutoExecute: true,
      requires: Object.freeze<AgentVariantRequirement[]>(["sql-composers"]),
      verifier: "agent-data-analysis.1",
    }),
  } satisfies Record<AgentRunWorkflowType, AgentWorkflowVariant>),
  kubectl: Object.freeze({
    /**
     * Reads alone: there is no catalog composer and no plan on a cluster, so `inspect_schema` and `inspect_plan`
     * could only refuse. What the run establishes, it establishes with `run_read_query`, and it is judged by the
     * same bar as an SQL investigation, so the verifier is the SQL one and a plan of it asks for what that one does.
     */
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription: "a question about the cluster that is answered from what the run establishes",
      objective: "Your objective is a question about this Kubernetes cluster. Answer it from what you establish.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-investigation.1",
    }),
    /**
     * Resource efficiency: the cluster's optimization is not a slow statement but a container sized for what it does
     * not use, so the run reads usage against requests and limits and may recommend new ones.
     *
     * `inspect_usage` and `recommend_change` are kept on a narrowed run because the verdict accepts either a resources
     * recommendation citing a usage reading or a report citing one, and both need the reading first. It requires the
     * usage reading of the engine, without which every tool the verdict asks for could only refuse.
     */
    "query-optimization": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "inspect_usage", "recommend_change", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["inspect_usage", "recommend_change"]),
      classifierDescription:
        "which workloads are over- or under-provisioned: the CPU and memory their containers use against their requests and limits",
      objective:
        "Your objective is resource efficiency: which containers use far less, or far more, CPU and memory than they request, and what requests and limits would fit what they use.",
      planDeliverable: Object.freeze({
        kind: "statement",
        noun: "the kubectl read that measures usage against requests",
      }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["cluster-usage-reading"]),
      verifier: "agent-query-optimization-kubectl.1",
    }),
    /**
     * Cluster health: the cluster's assessment is not the state of its data but the state of its workloads, so the
     * run profiles a namespace and grades what it finds.
     *
     * `profile_workloads` is kept on a narrowed run because the verdict asks for a profile, and nothing else the run
     * can do establishes one. It requires the workload reading of the engine, without which that tool could only
     * refuse.
     */
    "database-assessment": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "profile_workloads", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["profile_workloads"]),
      classifierDescription:
        "the health of a namespace's workloads: replicas not ready, restarts, missing requests, limits or probes, warning events",
      objective:
        "Your objective is the health of this cluster's workloads in a namespace: what is not ready, what restarts, what runs without requests, limits or probes, and what the Warning events say.",
      planDeliverable: Object.freeze({
        kind: "statement",
        noun: "the kubectl read that establishes each workload's state",
      }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["cluster-workload-reading"]),
      verifier: "agent-database-assessment-kubectl.1",
    }),
    operations: OPERATIONS_VARIANT,
    /**
     * A read presented as the answer, the SQL analysis without its profile: a cluster has no table to count.
     *
     * It is judged by the SQL analysis verdict, so `present_answer` is kept on a narrowed run for the same reason. It
     * never auto-executes: the hand-over replays the answer's statement in the user's editor, and a kubectl answer is
     * never run on the editor's terms.
     */
    "data-analysis": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "present_answer", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["present_answer"]),
      classifierDescription: "a question about the cluster whose answer is a result the user wants to see",
      objective:
        "Your objective is a question about this cluster's objects. Establish the answer from what you read and produce something to show for it.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-data-analysis.1",
    }),
  }),
} satisfies Record<AgentStatementLanguageId, Partial<Record<AgentRunWorkflowType, AgentWorkflowVariant>>>);

/**
 * The variant of one workflow on one language, or undefined when the language has none. An absent language reads as
 * `sql`, which is what a run recorded before languages existed was. A language the manifest does not hold is an
 * error rather than an absent variant: it can only be a ledger or a caller this file has never heard of.
 */
export function agentVariant(
  language: AgentStatementLanguageId | undefined,
  workflow: AgentRunWorkflowType,
): AgentWorkflowVariant | undefined {
  const id = language ?? "sql";
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
  if (variant === undefined) throw new AgentManifestError(`no ${workflow} variant for ${language ?? "sql"}`);
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
  const inherited = requiredVariant("sql", workflow).planDeliverable;
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
  return (agentVariant(language, workflow) ?? requiredVariant("sql", workflow)).objective;
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
  const sqlVerifier = requiredVariant("sql", workflow).verifier;
  const verifier = mode === "agent" ? availability.variant?.verifier : undefined;
  return {
    ...(language === null || language === "sql" ? {} : { statementLanguage: language }),
    ...(verifier === undefined || verifier === sqlVerifier ? {} : { verifier }),
  };
}
