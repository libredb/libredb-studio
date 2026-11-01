import { describe, expect, test } from "bun:test";
import {
  AGENT_LANGUAGE_COPY,
  AGENT_PLAN_ESTIMATE_OPERATION,
  AGENT_REQUIREMENT_ENGINES,
  AGENT_STATEMENT_LANGUAGE,
  AGENT_WORKFLOW_VARIANTS,
  type AgentStatementArgument,
  type AgentStatementLanguageId,
  agentVariant,
  PLAN_ESTIMATE_OPERATIONS,
  persistedRunFacts,
  planDeliverableOf,
  planObjectiveOf,
  requiredVariant,
  workflowAvailability,
} from "@/lib/agent/agent-manifest";
import { composesCatalogFor, composesEstimatingExplainFor } from "@/lib/agent/composed-sql";
import { AGENT_WORKFLOW_GOALS } from "@/lib/agent/goal-verifier";
import { agentToolDefinition } from "@/lib/agent/tools";
import { AGENT_WORKFLOW_PRESENTS_ANSWER, type AgentRunWorkflowType } from "@/lib/agent/types";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";

/**
 * The manifest against what each provider declares, as `engine-support.test.ts` holds `AGENT_EXECUTION_ENGINES` to
 * the drivers: the record is the list, so it must answer exactly where a provider has a read-only statement path.
 */
describe("AGENT_STATEMENT_LANGUAGE", () => {
  test("answers for every shipped type-id and nothing else", () => {
    expect(Object.keys(AGENT_STATEMENT_LANGUAGE).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s has a language exactly when its provider has queryReadOnly",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const hasPath = typeof (provider as { queryReadOnly?: unknown }).queryReadOnly === "function";
      expect(AGENT_STATEMENT_LANGUAGE[type] !== null).toBe(hasPath);
    },
  );

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s: an sql language is a provider that declares queryLanguage sql",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      if (AGENT_STATEMENT_LANGUAGE[type] === "sql") expect(provider.getCapabilities().queryLanguage).toBe("sql");
    },
  );

  test("is frozen", () => {
    expect(Object.isFrozen(AGENT_STATEMENT_LANGUAGE)).toBe(true);
  });
});

describe("the requirement mirrors", () => {
  test("sql-composers names exactly the engines the composer registries serve", () => {
    const measured = SHIPPED_DATABASE_TYPES.filter(
      (type) => composesCatalogFor(type) && composesEstimatingExplainFor(type),
    );
    expect([...AGENT_REQUIREMENT_ENGINES["sql-composers"]].sort()).toEqual([...measured].sort());
  });

  test("sql-composers is frozen, in this order", () => {
    expect(AGENT_REQUIREMENT_ENGINES["sql-composers"]).toEqual([
      "postgres",
      "sqlite",
      "duckdb",
      "mssql",
      "mysql",
      "clickhouse",
      "libsql",
      "influxdb3",
    ]);
    expect(Object.isFrozen(AGENT_REQUIREMENT_ENGINES["sql-composers"])).toBe(true);
  });

  test("sql-catalog names exactly the engines whose catalog read composes", () => {
    const measured = SHIPPED_DATABASE_TYPES.filter((type) => composesCatalogFor(type));
    expect([...AGENT_REQUIREMENT_ENGINES["sql-catalog"]].sort()).toEqual([...measured].sort());
  });

  test("sql-catalog is frozen, in this order, and holds every engine sql-composers does", () => {
    expect(AGENT_REQUIREMENT_ENGINES["sql-catalog"]).toEqual([
      "postgres",
      "sqlite",
      "duckdb",
      "mssql",
      "mysql",
      "clickhouse",
      "libsql",
      "influxdb3",
      "elasticsearch",
      "opensearch",
      "oracle",
      "db2",
      "cassandra",
      "couchbase",
      "druid",
    ]);
    expect(Object.isFrozen(AGENT_REQUIREMENT_ENGINES["sql-catalog"])).toBe(true);
    for (const type of AGENT_REQUIREMENT_ENGINES["sql-composers"]) {
      expect(AGENT_REQUIREMENT_ENGINES["sql-catalog"]).toContain(type);
    }
  });

  test.each([
    ["cluster-usage-reading", "usage"],
    ["cluster-workload-reading", "workloads"],
  ] as const)("%s names exactly the engines declaring agentReadings %s", async (requirement, reading) => {
    const declaring: DatabaseType[] = [];
    for (const type of SHIPPED_DATABASE_TYPES) {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const readings = (provider.getCapabilities() as { agentReadings?: readonly string[] }).agentReadings ?? [];
      if (readings.includes(reading)) declaring.push(type);
    }
    expect([...AGENT_REQUIREMENT_ENGINES[requirement]].sort()).toEqual(declaring.sort());
  });
});

describe("AGENT_LANGUAGE_COPY", () => {
  test("the SQL copy is the words the agent rules have always used", () => {
    expect(AGENT_LANGUAGE_COPY.sql).toMatchObject({
      noun: "statement",
      argument: "sql",
      writes: "writes and DDL",
      reached: "the database",
      defect: "your SQL",
      subject: "a database",
    });
  });

  test("kubectl names its own argument and its own boundary", () => {
    expect(AGENT_LANGUAGE_COPY.kubectl.argument).toBe("statement");
    expect(AGENT_LANGUAGE_COPY.kubectl.subject).toBe("a Kubernetes cluster");
    expect(AGENT_LANGUAGE_COPY.kubectl.adviceKeys).toEqual(["get", "top", "logs", "events"]);
  });

  test("AgentStatementArgument is exactly the arguments the languages name", () => {
    // `satisfies` fails to compile when the union gains or loses a member this record does not name.
    const everyArgument = { sql: true, statement: true, command: true } satisfies Record<AgentStatementArgument, true>;
    const named = new Set<string>(Object.values(AGENT_LANGUAGE_COPY).map((copy) => copy.argument));
    expect([...named].sort()).toEqual(Object.keys(everyArgument).sort());
  });
});

describe("the plan-estimate operation of each language", () => {
  test("names each language's plan operation, and null where a language has no plan", () => {
    expect(AGENT_PLAN_ESTIMATE_OPERATION).toEqual({
      sql: "sql.explain.estimate",
      kubectl: null,
      mongo: "mongo.plan.estimate",
      libredbkv: null,
      influxql: null,
      weaviateapi: null,
      qdrantapi: null,
      cypher: null,
      milvusrpc: null,
      rediscli: null,
      etcdctl: null,
      oxiacli: null,
      rabbitread: null,
      kafkaread: null,
      s3api: null,
      fsquery: null,
      snmpget: null,
      netconfrpc: null,
      modbusread: null,
      promql: null,
      opcuaread: null,
      mtconnectread: null,
      mqttread: null,
      sparkplugread: null,
    });
    expect(Object.isFrozen(AGENT_PLAN_ESTIMATE_OPERATION)).toBe(true);
  });

  test("PLAN_ESTIMATE_OPERATIONS is the record's non-null values", () => {
    expect([...PLAN_ESTIMATE_OPERATIONS].sort()).toEqual(["mongo.plan.estimate", "sql.explain.estimate"]);
  });

  // The mirror the record is held to: what inspect_plan actually drives on each language, read off the definitions
  // the run is offered. A language with no plan operation offers inspect_plan on no workflow.
  test.each(Object.keys(AGENT_WORKFLOW_VARIANTS) as AgentStatementLanguageId[])(
    "%s: every variant offering inspect_plan drives the language's plan-estimate operation",
    (language) => {
      const offering = Object.entries(AGENT_WORKFLOW_VARIANTS[language])
        .filter(([, variant]) => variant.tools.includes("inspect_plan"))
        .map(([workflow]) => workflow as AgentRunWorkflowType);
      const operation = AGENT_PLAN_ESTIMATE_OPERATION[language];
      if (operation === null) {
        expect(offering).toEqual([]);
        return;
      }
      expect(offering.length).toBeGreaterThan(0);
      for (const workflow of offering) {
        expect(agentToolDefinition(language, workflow, "inspect_plan").operationId, workflow).toBe(operation);
      }
    },
  );
});

const WORKFLOWS = [
  "investigation",
  "query-optimization",
  "database-assessment",
  "operations",
  "data-analysis",
] as const;

describe("the SQL variants", () => {
  test.each([...WORKFLOWS])("%s exists, and its verifier is the workflow's goal", (workflow) => {
    expect(AGENT_WORKFLOW_VARIANTS.sql[workflow]?.verifier).toBe(AGENT_WORKFLOW_GOALS[workflow].verifier);
  });

  test.each([...WORKFLOWS])("%s may auto-execute exactly where it presents an answer", (workflow) => {
    expect(AGENT_WORKFLOW_VARIANTS.sql[workflow]?.canAutoExecute).toBe(AGENT_WORKFLOW_PRESENTS_ANSWER[workflow]);
  });

  /*
    What each statement workflow needs of the dialect, measured from its verdict rather than from its offer. Only the
    optimization verdict cites an estimating plan (a plan comparison, or an index recommendation resting on a plan), so
    only that workflow is held to an engine that estimates one. The other three are offered `inspect_plan` and
    `profile_table` too, and each of those refuses on its own with `UNSUPPORTED_DIALECT` where the dialect has no
    composition, so neither holds the workflow out. The assessment verdict needs a table profile as well, and that
    need is deliberately not held, so assessment stays open on the engines with no profile composition.
  */
  test.each([
    ["investigation", ["sql-catalog"]],
    ["query-optimization", ["sql-composers"]],
    ["database-assessment", ["sql-catalog"]],
    ["operations", []],
    ["data-analysis", ["sql-catalog"]],
  ] as const)("%s requires exactly %p", (workflow, requires) => {
    expect(AGENT_WORKFLOW_VARIANTS.sql[workflow]?.requires).toEqual(requires);
  });

  test("an absent language reads as sql", () => {
    expect(agentVariant(undefined, "investigation")).toBe(AGENT_WORKFLOW_VARIANTS.sql.investigation);
  });

  test("an unknown language is a named error, not an absent variant", () => {
    const read = () => agentVariant("cobol" as AgentStatementLanguageId, "investigation");
    expect(read).toThrow("unknown statement language cobol");
    try {
      read();
    } catch (error) {
      expect((error as Error).name).toBe("AgentManifestError");
    }
  });

  test.each([...WORKFLOWS])("kubectl has a %s variant", (workflow) => {
    expect(agentVariant("kubectl", workflow)).toBeDefined();
  });

  test("operations is one variant for every language", () => {
    expect(AGENT_WORKFLOW_VARIANTS.kubectl.operations).toBe(AGENT_WORKFLOW_VARIANTS.sql.operations);
  });

  test("an inherited plan deliverable is the SQL one", () => {
    expect(planDeliverableOf(undefined, "query-optimization")).toEqual({
      kind: "statement",
      noun: "the rewritten statement",
    });
  });

  test("an absent language plans with the SQL objective, and a language with a variant plans with its own", () => {
    expect(planObjectiveOf(undefined, "database-assessment")).toBe(
      requiredVariant("sql", "database-assessment").objective,
    );
    expect(planObjectiveOf("kubectl", "operations")).toBe(requiredVariant("kubectl", "operations").objective);
    expect(planObjectiveOf("kubectl", "investigation")).toBe(
      "Your objective is a question about this Kubernetes cluster. Answer it from what you establish.",
    );
  });

  test("the kubectl investigation reads the cluster with run_read_query and inherits the SQL plan deliverable", () => {
    expect(requiredVariant("kubectl", "investigation")).toEqual({
      tools: ["run_read_query", "compose_report"],
      narrowedExtras: [],
      classifierDescription: "a question about the cluster that is answered from what the run establishes",
      objective: "Your objective is a question about this Kubernetes cluster. Answer it from what you establish.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: [],
      verifier: "agent-investigation.1",
    });
    expect(Object.isFrozen(requiredVariant("kubectl", "investigation").tools)).toBe(true);
    expect(planDeliverableOf("kubectl", "investigation")).toEqual(planDeliverableOf("sql", "investigation"));
  });

  test("the kubectl query optimization is resource efficiency, judged on usage and never auto-executed", () => {
    expect(requiredVariant("kubectl", "query-optimization")).toEqual({
      tools: ["run_read_query", "inspect_usage", "recommend_change", "compose_report"],
      narrowedExtras: ["inspect_usage", "recommend_change"],
      classifierDescription:
        "which workloads are over- or under-provisioned: the CPU and memory their containers use against their requests and limits",
      objective:
        "Your objective is resource efficiency: which containers use far less, or far more, CPU and memory than they request, and what requests and limits would fit what they use.",
      planDeliverable: { kind: "statement", noun: "the kubectl read that measures usage against requests" },
      canAutoExecute: false,
      requires: ["cluster-usage-reading"],
      verifier: "agent-query-optimization-kubectl.1",
    });
    expect(Object.isFrozen(requiredVariant("kubectl", "query-optimization").tools)).toBe(true);
    expect(planDeliverableOf("kubectl", "query-optimization")).toEqual({
      kind: "statement",
      noun: "the kubectl read that measures usage against requests",
    });
    expect(planObjectiveOf("kubectl", "query-optimization")).toBe(
      requiredVariant("kubectl", "query-optimization").objective,
    );
  });

  test("the kubectl assessment is cluster health, judged on a workload profile and never auto-executed", () => {
    expect(requiredVariant("kubectl", "database-assessment")).toEqual({
      tools: ["run_read_query", "profile_workloads", "compose_report"],
      narrowedExtras: ["profile_workloads"],
      classifierDescription:
        "the health of a namespace's workloads: replicas not ready, restarts, missing requests, limits or probes, warning events",
      objective:
        "Your objective is the health of this cluster's workloads in a namespace: what is not ready, what restarts, what runs without requests, limits or probes, and what the Warning events say.",
      planDeliverable: { kind: "statement", noun: "the kubectl read that establishes each workload's state" },
      canAutoExecute: false,
      requires: ["cluster-workload-reading"],
      verifier: "agent-database-assessment-kubectl.1",
    });
    expect(Object.isFrozen(requiredVariant("kubectl", "database-assessment").tools)).toBe(true);
    expect(planDeliverableOf("kubectl", "database-assessment")).toEqual({
      kind: "statement",
      noun: "the kubectl read that establishes each workload's state",
    });
    expect(planObjectiveOf("kubectl", "database-assessment")).toBe(
      requiredVariant("kubectl", "database-assessment").objective,
    );
  });

  test("the kubectl data analysis presents a read and never auto-executes it", () => {
    expect(requiredVariant("kubectl", "data-analysis")).toEqual({
      tools: ["run_read_query", "present_answer", "compose_report"],
      narrowedExtras: ["present_answer"],
      classifierDescription: "a question about the cluster whose answer is a result the user wants to see",
      objective:
        "Your objective is a question about this cluster's objects. Establish the answer from what you read and produce something to show for it.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: [],
      verifier: "agent-data-analysis.1",
    });
    expect(Object.isFrozen(requiredVariant("kubectl", "data-analysis").tools)).toBe(true);
    expect(planDeliverableOf("kubectl", "data-analysis")).toEqual(planDeliverableOf("sql", "data-analysis"));
  });

  test("a workflow naming an inherited property is a missing variant, not a function", () => {
    const workflow = "toString" as AgentRunWorkflowType;
    expect(agentVariant("sql", workflow)).toBeUndefined();
    let caught: unknown;
    try {
      requiredVariant(undefined, workflow);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error | undefined)?.name).toBe("AgentManifestError");
    expect((caught as Error).message).toBe("no toString variant for sql");
  });

  test("operations plans in prose", () => {
    expect(planDeliverableOf("kubectl", "operations")).toEqual({ kind: "prose" });
  });

  test("the variants are frozen", () => {
    expect(Object.isFrozen(AGENT_WORKFLOW_VARIANTS)).toBe(true);
    expect(Object.isFrozen(AGENT_WORKFLOW_VARIANTS.sql)).toBe(true);
    for (const workflow of WORKFLOWS) {
      expect(Object.isFrozen(AGENT_WORKFLOW_VARIANTS.sql[workflow]?.tools), workflow).toBe(true);
    }
  });
});

describe("the MongoDB variants (issue #1614)", () => {
  /*
    The auto-execute gate weighs the answer's plan by a reading of the engine's explain format, and no reading of a
    MongoDB plan exists, so a ticked MongoDB run could only ever be declined. The setting is not offered instead, as on
    a cluster: the route refuses it and the rail shows no consent step.
  */
  test.each(Object.keys(AGENT_WORKFLOW_VARIANTS.mongo))("the %s variant never auto-executes", (workflow) => {
    expect(requiredVariant("mongo", workflow as AgentRunWorkflowType).canAutoExecute).toBe(false);
  });

  test("every statement workflow is offered the read-class four whole, inspect_plan included", () => {
    expect(requiredVariant("mongo", "investigation").tools).toEqual([
      "inspect_schema",
      "run_read_query",
      "inspect_plan",
      "compose_report",
    ]);
    expect(requiredVariant("mongo", "database-assessment").tools).toEqual([
      "inspect_schema",
      "run_read_query",
      "inspect_plan",
      "compose_report",
      "profile_table",
    ]);
    expect(requiredVariant("mongo", "data-analysis").tools).toEqual([
      "inspect_schema",
      "run_read_query",
      "inspect_plan",
      "compose_report",
      "profile_table",
      "present_answer",
    ]);
    // The optimization keeps its own list: the read-class four and the index card, and no compare_plans.
    expect(requiredVariant("mongo", "query-optimization").tools).toEqual([
      "inspect_schema",
      "run_read_query",
      "inspect_plan",
      "recommend_change",
      "compose_report",
    ]);
  });

  test("the operations variant is the one every language shares", () => {
    expect(AGENT_WORKFLOW_VARIANTS.mongo.operations).toBe(AGENT_WORKFLOW_VARIANTS.sql.operations);
  });
});

describe("workflowAvailability", () => {
  const statementWorkflows = ["investigation", "query-optimization", "database-assessment", "data-analysis"] as const;

  test.each(["postgres", "mssql", "duckdb"] as const)("%s opens every workflow in both modes", (type) => {
    for (const workflow of [...statementWorkflows, "operations"] as const) {
      expect(workflowAvailability("agent", workflow, type).open).toBe(true);
      expect(workflowAvailability("planning", workflow, type).open).toBe(true);
    }
  });

  test.each(["spark"] as const)(
    "%s opens operations and planning, and refuses a statement workflow in agent mode",
    (type) => {
      expect(workflowAvailability("agent", "operations", type).open).toBe(true);
      for (const workflow of statementWorkflows) {
        expect(workflowAvailability("planning", workflow, type).open).toBe(true);
        expect(workflowAvailability("agent", workflow, type)).toEqual({ open: false, cause: "no-adapter" });
      }
    },
  );

  test("kubernetes speaks kubectl: every workflow opens in both modes", () => {
    expect(AGENT_STATEMENT_LANGUAGE.kubernetes).toBe("kubectl");
    expect(workflowAvailability("agent", "operations", "kubernetes").open).toBe(true);
    for (const workflow of statementWorkflows) {
      expect(workflowAvailability("planning", workflow, "kubernetes").open).toBe(true);
      expect(workflowAvailability("agent", workflow, "kubernetes").open).toBe(true);
    }
  });

  test("a kubernetes investigation opens in agent mode under the kubectl variant", () => {
    const open = workflowAvailability("agent", "investigation", "kubernetes");
    expect(open).toEqual({
      open: true,
      statementLanguage: "kubectl",
      variant: requiredVariant("kubectl", "investigation"),
    });
    if (!open.open) throw new Error("refused");
    // Its verifier is the SQL investigation's, so only the language is written to the header.
    expect(persistedRunFacts("agent", "investigation", open)).toEqual({ statementLanguage: "kubectl" });
  });

  test("a kubernetes resource-efficiency run opens in agent mode and persists its language and its own verifier", () => {
    const open = workflowAvailability("agent", "query-optimization", "kubernetes");
    expect(open).toEqual({
      open: true,
      statementLanguage: "kubectl",
      variant: requiredVariant("kubectl", "query-optimization"),
    });
    if (!open.open) throw new Error("refused");
    expect(persistedRunFacts("agent", "query-optimization", open)).toEqual({
      statementLanguage: "kubectl",
      verifier: "agent-query-optimization-kubectl.1",
    });
    // A plan is judged by the planning rule, so it persists the language and never the verifier.
    const plan = workflowAvailability("planning", "query-optimization", "kubernetes");
    if (!plan.open) throw new Error("refused");
    expect(persistedRunFacts("planning", "query-optimization", plan)).toEqual({ statementLanguage: "kubectl" });
  });

  test("a kubernetes cluster-health run opens in agent mode and persists its language and its own verifier", () => {
    const open = workflowAvailability("agent", "database-assessment", "kubernetes");
    expect(open).toEqual({
      open: true,
      statementLanguage: "kubectl",
      variant: requiredVariant("kubectl", "database-assessment"),
    });
    if (!open.open) throw new Error("refused");
    expect(persistedRunFacts("agent", "database-assessment", open)).toEqual({
      statementLanguage: "kubectl",
      verifier: "agent-database-assessment-kubectl.1",
    });
  });

  test("an SQL run opens under its SQL variant and its language", () => {
    expect(workflowAvailability("agent", "data-analysis", "postgres")).toEqual({
      open: true,
      statementLanguage: "sql",
      variant: requiredVariant("sql", "data-analysis"),
    });
  });

  test("operations on an engine with no language opens under the one operations variant", () => {
    expect(workflowAvailability("agent", "operations", "spark")).toEqual({
      open: true,
      statementLanguage: null,
      variant: requiredVariant("sql", "operations"),
    });
  });

  test("a plan on an engine with no language opens under no variant", () => {
    expect(workflowAvailability("planning", "investigation", "spark")).toEqual({
      open: true,
      statementLanguage: null,
      variant: null,
    });
  });

  test("a MongoDB run opens under its own language and variants (issue #1614)", () => {
    expect(workflowAvailability("agent", "data-analysis", "mongodb")).toEqual({
      open: true,
      statementLanguage: "mongo",
      variant: requiredVariant("mongo", "data-analysis"),
    });
    expect(workflowAvailability("agent", "operations", "mongodb")).toEqual({
      open: true,
      statementLanguage: "mongo",
      variant: requiredVariant("mongo", "operations"),
    });
    expect(workflowAvailability("planning", "investigation", "mongodb")).toEqual({
      open: true,
      statementLanguage: "mongo",
      variant: requiredVariant("mongo", "investigation"),
    });
    // Every statement-sending workflow has a mongo variant: none of them may be the SQL
    // variant wearing a different name, and this is where that would show first.
    for (const workflow of ["investigation", "query-optimization", "database-assessment"] as const) {
      const open = workflowAvailability("agent", workflow, "mongodb");
      if (!open.open) throw new Error(`refused ${workflow}`);
      expect(open.statementLanguage).toBe("mongo");
    }
  });

  /*
    The two refusals the manifest cannot produce today: every SQL variant is total and every SQL engine holds its one
    requirement. So they are driven through tables naming a language whose variants are partial, which is what a
    language is while its variants are being filled in, and what the manifest may hold again for the next language.
  */
  const sqlInvestigation = requiredVariant("sql", "investigation");
  const partialLanguage = {
    languages: { ...AGENT_STATEMENT_LANGUAGE, kubernetes: "kubectl" },
    variants: {
      ...AGENT_WORKFLOW_VARIANTS,
      kubectl: {
        operations: requiredVariant("kubectl", "operations"),
        investigation: { ...sqlInvestigation, requires: ["cluster-usage-reading"] },
      },
    },
    // Held empty here whatever the live mirror says, so the refusal is driven by the table and not by the census.
    requirementEngines: { ...AGENT_REQUIREMENT_ENGINES, "cluster-usage-reading": [] },
  } as const;

  test("a workflow the language has no variant of is refused with the no-variant sentence", () => {
    expect(workflowAvailability("agent", "query-optimization", "kubernetes", partialLanguage)).toEqual({
      open: false,
      cause: "no-variant",
      sentence:
        "Agent mode does not offer this workflow on this engine. The operations workflow runs here, and plan mode drafts here.",
    });
  });

  test("a variant whose requirement the engine does not hold is refused with that requirement's sentence", () => {
    expect(workflowAvailability("agent", "investigation", "kubernetes", partialLanguage)).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence:
        "This engine serves no usage reading, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
    });
  });

  test("the same variant opens once the engine holds the requirement, and plan mode is never refused", () => {
    const held = {
      ...partialLanguage,
      requirementEngines: { ...AGENT_REQUIREMENT_ENGINES, "cluster-usage-reading": ["kubernetes"] },
    } as const;
    expect(workflowAvailability("agent", "investigation", "kubernetes", held)).toEqual({
      open: true,
      statementLanguage: "kubectl",
      variant: partialLanguage.variants.kubectl.investigation,
    });
    expect(workflowAvailability("planning", "query-optimization", "kubernetes", partialLanguage)).toEqual({
      open: true,
      statementLanguage: "kubectl",
      variant: null,
    });
  });

  /*
    An engine whose dialect composes a catalog read and no estimating plan: driven through tables that hold DuckDB in
    `sql-catalog` and out of `sql-composers`, so the case holds whichever shipped engines are in it.
  */
  const catalogOnly = {
    languages: AGENT_STATEMENT_LANGUAGE,
    variants: AGENT_WORKFLOW_VARIANTS,
    requirementEngines: { ...AGENT_REQUIREMENT_ENGINES, "sql-catalog": ["duckdb"], "sql-composers": [] },
  } as const;

  test.each(["investigation", "database-assessment", "data-analysis"] as const)(
    "%s opens on an engine that composes a catalog read and no estimating plan",
    (workflow) => {
      expect(workflowAvailability("agent", workflow, "duckdb", catalogOnly)).toEqual({
        open: true,
        statementLanguage: "sql",
        variant: requiredVariant("sql", workflow),
      });
    },
  );

  test("query-optimization stays refused there, with the sentence that says it needs an estimating plan", () => {
    expect(workflowAvailability("agent", "query-optimization", "duckdb", catalogOnly)).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence:
        "This workflow needs both a catalog read and an estimating plan, and agent mode has no verified composition of both for this engine, so this workflow's tools could only refuse. Workflows that need less still run here, the operations workflow among them, and plan mode drafts here.",
    });
  });

  test("on a shipped engine with a catalog read and no estimating plan, the refusal claims no missing catalog", () => {
    const refused = workflowAvailability("agent", "query-optimization", "elasticsearch");
    expect(refused).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence:
        "This workflow needs both a catalog read and an estimating plan, and agent mode has no verified composition of both for this engine, so this workflow's tools could only refuse. Workflows that need less still run here, the operations workflow among them, and plan mode drafts here.",
    });
    expect(workflowAvailability("agent", "investigation", "elasticsearch")).toMatchObject({ open: true });
  });

  test("a statement workflow on an engine that composes no catalog read names what it lacks", () => {
    const neither = { ...catalogOnly, requirementEngines: { ...catalogOnly.requirementEngines, "sql-catalog": [] } };
    expect(workflowAvailability("agent", "investigation", "duckdb", neither)).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence:
        "Agent mode has no verified catalog composition for this engine, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
    });
  });

  test("an SQL run persists nothing, so its ledger header is the bytes it always was", () => {
    const open = workflowAvailability("agent", "query-optimization", "postgres");
    if (!open.open) throw new Error("refused");
    expect(persistedRunFacts("agent", "query-optimization", open)).toEqual({});
  });

  test("a run on an engine with no language persists nothing either", () => {
    for (const mode of ["agent", "planning"] as const) {
      const open = workflowAvailability(mode, "operations", "spark");
      if (!open.open) throw new Error("refused");
      expect(persistedRunFacts(mode, "operations", open), mode).toEqual({});
    }
  });

  test("another language persists itself, and an agent run its own verifier where it is not the SQL one", () => {
    const variant = { ...sqlInvestigation, verifier: "agent-database-assessment.1" } as const;
    const open = { open: true, statementLanguage: "kubectl", variant } as const;
    expect(persistedRunFacts("agent", "investigation", open)).toEqual({
      statementLanguage: "kubectl",
      verifier: "agent-database-assessment.1",
    });
    // A plan is judged by the planning rule whatever the variant says, so no verifier is written for it.
    expect(persistedRunFacts("planning", "investigation", open)).toEqual({ statementLanguage: "kubectl" });
    // The SQL verifier is what an absent field reads as, so it is not written either.
    expect(persistedRunFacts("agent", "investigation", { ...open, variant: sqlInvestigation })).toEqual({
      statementLanguage: "kubectl",
    });
  });
});
