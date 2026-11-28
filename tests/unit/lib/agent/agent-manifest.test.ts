import { describe, expect, test } from "bun:test";
import { parseGrantRegister } from "@libredb/grant-register";
import {
  AGENT_LANGUAGE_COPY,
  AGENT_PLAN_ESTIMATE_OPERATION,
  AGENT_REQUIREMENT_ENGINES,
  AGENT_WORKFLOW_VARIANTS,
  type AgentDeclaredLanguageId,
  type AgentStatementArgument,
  type AgentWorkflowAvailability,
  type AgentStatementLanguageId,
  agentVariant,
  legacyAgentEngine,
  noStatementSessionSentence,
  notReviewedSentence,
  openWorkflows,
  operationsWorkflowOpens,
  persistedRunFacts,
  PLAN_ESTIMATE_OPERATIONS,
  planDeliverableOf,
  planObjectiveOf,
  requiredVariant,
  workflowAvailability,
} from "@/lib/agent/agent-manifest";
import { servedAvailabilityTables, servedClientPacks } from "@/lib/agent/languages/server";
import { BUNDLED_CLIENT_PACKS } from "@/lib/agent/languages/client";
import { composesCatalogFor, composesEstimatingExplainFor } from "@/lib/agent/composed-sql";
import { AGENT_WORKFLOW_GOALS } from "@/lib/agent/goal-verifier";
import { agentToolDefinition } from "@/lib/agent/tools";
import { AGENT_WORKFLOW_PRESENTS_ANSWER, type AgentRunWorkflowType } from "@/lib/agent/types";
import { OPERATIONS_VARIANT } from "@/lib/agent/workflow-tool-sets";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { UnknownProviderError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import {
  forgetServerCatalog,
  installServerCatalog,
  serverCatalogInstalled,
  servedEngineRecord,
} from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import { typeIdRefusal } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";
import { AGENT_PACKAGE_LANGUAGE, agentPackageLanguageCatalog } from "../../../helpers/agent-package-catalog";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";
import { admittedFor, admittedManifest, packageRow, withLoosestClaims } from "../../../helpers/package-catalog";
import { shippedDeclaredLanguage } from "../../../helpers/shipped-declared-language";
import {
  legacyRegisterEngines,
  legacyRegisterTable,
  legacyStatementLanguageTable,
} from "../../../helpers/legacy-register";

/** The engines whose legacy row of the grant register grants agent execution, in catalog order. */
const AGENT_EXECUTION = legacyRegisterEngines("agentExecution");

const statementLanguage = legacyStatementLanguageTable();

/**
 * The manifest against what each provider declares, as `engine-support.test.ts` holds `GRANTED_AGENT_EXECUTION_ENGINES` to
 * the drivers: the record is the list, so it must answer exactly where a provider has a read-only statement path.
 */
describe("the statement language review rows", () => {
  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s has a language exactly when its provider has queryReadOnly",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const hasPath = typeof (provider as { queryReadOnly?: unknown }).queryReadOnly === "function";
      expect(statementLanguage[type] !== null).toBe(hasPath);
    },
  );

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s: an sql language is a provider that declares queryLanguage sql",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      if (statementLanguage[type] === "sql") expect(provider.getCapabilities().queryLanguage).toBe("sql");
    },
  );

  // The start route reads the language and then the review record, so the two agree on every shipped engine and the
  // record's own refusal there is reached only by an engine a later build drops from it.
  test("an engine has a language exactly when the review record lists it", () => {
    const withLanguage = SHIPPED_DATABASE_TYPES.filter((type) => statementLanguage[type] !== null);
    expect([...withLanguage].sort()).toEqual([...AGENT_EXECUTION].sort());
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
      "trino",
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
    expect<Readonly<Record<string, unknown>>>(AGENT_PLAN_ESTIMATE_OPERATION).toEqual({
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
      kafkaread: null,
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
    ["operations", ["agent-readings"]],
    ["data-analysis", ["sql-catalog"]],
  ] as const)("%s requires exactly %p", (workflow, requires) => {
    expect(AGENT_WORKFLOW_VARIANTS.sql[workflow]?.requires).toEqual(requires);
  });

  test("an absent language reads as sql", () => {
    expect(agentVariant(undefined, "investigation", BUNDLED_CLIENT_PACKS)).toBe(
      AGENT_WORKFLOW_VARIANTS.sql.investigation,
    );
  });

  test("an unknown language is a named error, not an absent variant", () => {
    const read = () => agentVariant("cobol" as AgentStatementLanguageId, "investigation", BUNDLED_CLIENT_PACKS);
    expect(read).toThrow("unknown statement language cobol");
    try {
      read();
    } catch (error) {
      expect((error as Error).name).toBe("AgentManifestError");
    }
  });

  test.each([...WORKFLOWS])("kubectl has a %s variant", (workflow) => {
    expect(agentVariant("kubectl", workflow, BUNDLED_CLIENT_PACKS)).toBeDefined();
  });

  test("operations is one variant for every language", () => {
    expect(AGENT_WORKFLOW_VARIANTS.kubectl.operations).toBe(AGENT_WORKFLOW_VARIANTS.sql.operations);
  });

  test("an inherited plan deliverable is the SQL one", () => {
    expect(planDeliverableOf(undefined, "query-optimization", BUNDLED_CLIENT_PACKS)).toEqual({
      kind: "statement",
      noun: "the rewritten statement",
    });
  });

  test("an absent language plans with the SQL objective, and a language with a variant plans with its own", () => {
    expect(planObjectiveOf(undefined, "database-assessment", BUNDLED_CLIENT_PACKS)).toBe(
      requiredVariant("sql", "database-assessment", BUNDLED_CLIENT_PACKS).objective,
    );
    expect(planObjectiveOf("kubectl", "operations", BUNDLED_CLIENT_PACKS)).toBe(
      requiredVariant("kubectl", "operations", BUNDLED_CLIENT_PACKS).objective,
    );
    expect(planObjectiveOf("kubectl", "investigation", BUNDLED_CLIENT_PACKS)).toBe(
      "Your objective is a question about this Kubernetes cluster. Answer it from what you establish.",
    );
  });

  test("the kubectl investigation reads the cluster with run_read_query and inherits the SQL plan deliverable", () => {
    expect(requiredVariant("kubectl", "investigation", BUNDLED_CLIENT_PACKS)).toEqual({
      tools: ["run_read_query", "compose_report"],
      narrowedExtras: [],
      classifierDescription: "a question about the cluster that is answered from what the run establishes",
      objective: "Your objective is a question about this Kubernetes cluster. Answer it from what you establish.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: [],
      verifier: "agent-investigation.1",
    });
    expect(Object.isFrozen(requiredVariant("kubectl", "investigation", BUNDLED_CLIENT_PACKS).tools)).toBe(true);
    expect(planDeliverableOf("kubectl", "investigation", BUNDLED_CLIENT_PACKS)).toEqual(
      planDeliverableOf("sql", "investigation", BUNDLED_CLIENT_PACKS),
    );
  });

  test("the kubectl query optimization is resource efficiency, judged on usage and never auto-executed", () => {
    expect(requiredVariant("kubectl", "query-optimization", BUNDLED_CLIENT_PACKS)).toEqual({
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
    expect(Object.isFrozen(requiredVariant("kubectl", "query-optimization", BUNDLED_CLIENT_PACKS).tools)).toBe(true);
    expect(planDeliverableOf("kubectl", "query-optimization", BUNDLED_CLIENT_PACKS)).toEqual({
      kind: "statement",
      noun: "the kubectl read that measures usage against requests",
    });
    expect(planObjectiveOf("kubectl", "query-optimization", BUNDLED_CLIENT_PACKS)).toBe(
      requiredVariant("kubectl", "query-optimization", BUNDLED_CLIENT_PACKS).objective,
    );
  });

  test("the kubectl assessment is cluster health, judged on a workload profile and never auto-executed", () => {
    expect(requiredVariant("kubectl", "database-assessment", BUNDLED_CLIENT_PACKS)).toEqual({
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
    expect(Object.isFrozen(requiredVariant("kubectl", "database-assessment", BUNDLED_CLIENT_PACKS).tools)).toBe(true);
    expect(planDeliverableOf("kubectl", "database-assessment", BUNDLED_CLIENT_PACKS)).toEqual({
      kind: "statement",
      noun: "the kubectl read that establishes each workload's state",
    });
    expect(planObjectiveOf("kubectl", "database-assessment", BUNDLED_CLIENT_PACKS)).toBe(
      requiredVariant("kubectl", "database-assessment", BUNDLED_CLIENT_PACKS).objective,
    );
  });

  test("the kubectl data analysis presents a read and never auto-executes it", () => {
    expect(requiredVariant("kubectl", "data-analysis", BUNDLED_CLIENT_PACKS)).toEqual({
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
    expect(Object.isFrozen(requiredVariant("kubectl", "data-analysis", BUNDLED_CLIENT_PACKS).tools)).toBe(true);
    expect(planDeliverableOf("kubectl", "data-analysis", BUNDLED_CLIENT_PACKS)).toEqual(
      planDeliverableOf("sql", "data-analysis", BUNDLED_CLIENT_PACKS),
    );
  });

  test("a workflow naming an inherited property is a missing variant, not a function", () => {
    const workflow = "toString" as AgentRunWorkflowType;
    expect(agentVariant("sql", workflow, BUNDLED_CLIENT_PACKS)).toBeUndefined();
    let caught: unknown;
    try {
      requiredVariant(undefined, workflow, BUNDLED_CLIENT_PACKS);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error | undefined)?.name).toBe("AgentManifestError");
    expect((caught as Error).message).toBe("no toString variant for sql");
  });

  test("operations plans in prose", () => {
    expect(planDeliverableOf("kubectl", "operations", BUNDLED_CLIENT_PACKS)).toEqual({ kind: "prose" });
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
    expect(requiredVariant("mongo", workflow as AgentRunWorkflowType, BUNDLED_CLIENT_PACKS).canAutoExecute).toBe(false);
  });

  test("every statement workflow is offered the read-class four whole, inspect_plan included", () => {
    expect(requiredVariant("mongo", "investigation", BUNDLED_CLIENT_PACKS).tools).toEqual([
      "inspect_schema",
      "run_read_query",
      "inspect_plan",
      "compose_report",
    ]);
    expect(requiredVariant("mongo", "database-assessment", BUNDLED_CLIENT_PACKS).tools).toEqual([
      "inspect_schema",
      "run_read_query",
      "inspect_plan",
      "compose_report",
      "profile_table",
    ]);
    expect(requiredVariant("mongo", "data-analysis", BUNDLED_CLIENT_PACKS).tools).toEqual([
      "inspect_schema",
      "run_read_query",
      "inspect_plan",
      "compose_report",
      "profile_table",
      "present_answer",
    ]);
    // The optimization keeps its own list: the read-class four and the index card, and no compare_plans.
    expect(requiredVariant("mongo", "query-optimization", BUNDLED_CLIENT_PACKS).tools).toEqual([
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

  // The workflow classifier is offered exactly these (F2), so a run is never classified into one Start refuses.
  test.each([...SHIPPED_DATABASE_TYPES])("openWorkflows lists exactly the workflows %s opens, in each mode", (type) => {
    for (const mode of ["agent", "planning"] as const) {
      const expected = WORKFLOWS.filter(
        (workflow) => workflowAvailability(mode, workflow, legacyAgentEngine(type)).open,
      );
      const listed = openWorkflows(mode, legacyAgentEngine(type));
      expect([...listed]).toEqual(expected);
      expect(Object.isFrozen(listed)).toBe(true);
    }
  });

  test("agent mode opens no operations workflow on MQTT, Sparkplug B, OPC UA and MTConnect, and plan mode opens all five there", () => {
    for (const type of ["mqtt", "sparkplug", "opcua", "mtconnect"] as const) {
      expect(openWorkflows("agent", legacyAgentEngine(type))).not.toContain("operations");
      expect([...openWorkflows("planning", legacyAgentEngine(type))]).toEqual([...WORKFLOWS]);
    }
  });

  test("every engine opens at least one workflow in agent mode", () => {
    const none = SHIPPED_DATABASE_TYPES.filter((type) => openWorkflows("agent", legacyAgentEngine(type)).length === 0);
    expect(none).toEqual([]);
  });

  test("every legacy engine's availability engine offers a read-only statement session exactly as its record does", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      expect(legacyAgentEngine(type).offers.readOnlyStatements, type).toBe(
        servedEngineRecord(type).offers.readOnlyStatements,
      );
    }
  });

  test("a browser type that is not a type id is refused by name before its open workflows are read", () => {
    expect(() => openWorkflows("agent", legacyAgentEngine("acmefoo" as DatabaseType))).toThrow(UnknownProviderError);
  });

  // A browser connection whose type names no provider (FND-1) reaches no grant read: an unknown name, an inherited key,
  // a missing type and one that is not text are each refused by the legacy engine's reader with the reason
  // `typeIdRefusal` gives them, before any availability is decided. The server reads an engine record instead, which
  // the server catalog refuses the same way (`servedEngineRecord`).
  test("legacyAgentEngine refuses a type that is not a type id by name, before any workflow's availability is read", () => {
    for (const type of ["acmefoo", undefined, "constructor", 5] as unknown[]) {
      const refusal = typeIdRefusal(type);
      for (const mode of ["agent", "planning"] as const) {
        for (const workflow of [...statementWorkflows, "operations"] as const) {
          let thrown: unknown;
          try {
            workflowAvailability(mode, workflow, legacyAgentEngine(type as DatabaseType));
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(UnknownProviderError);
          expect((thrown as UnknownProviderError).reason).toBe(refusal?.reason as UnknownProviderError["reason"]);
          expect((thrown as UnknownProviderError).message).toBe(refusal?.sentence as string);
        }
      }
    }
  });

  test.each(["postgres", "mssql", "duckdb"] as const)("%s opens every workflow in both modes", (type) => {
    for (const workflow of [...statementWorkflows, "operations"] as const) {
      expect(workflowAvailability("agent", workflow, legacyAgentEngine(type)).open).toBe(true);
      expect(workflowAvailability("planning", workflow, legacyAgentEngine(type)).open).toBe(true);
    }
  });

  test.each(["spark"] as const)(
    "%s opens operations and planning, and refuses a statement workflow in agent mode",
    (type) => {
      expect(workflowAvailability("agent", "operations", legacyAgentEngine(type)).open).toBe(true);
      for (const workflow of statementWorkflows) {
        expect(workflowAvailability("planning", workflow, legacyAgentEngine(type)).open).toBe(true);
        expect(workflowAvailability("agent", workflow, legacyAgentEngine(type))).toEqual({
          open: false,
          cause: "no-adapter",
        });
      }
    },
  );

  test("kubernetes speaks kubectl: every workflow opens in both modes", () => {
    expect(statementLanguage.kubernetes).toBe("kubectl");
    expect(workflowAvailability("agent", "operations", legacyAgentEngine("kubernetes")).open).toBe(true);
    for (const workflow of statementWorkflows) {
      expect(workflowAvailability("planning", workflow, legacyAgentEngine("kubernetes")).open).toBe(true);
      expect(workflowAvailability("agent", workflow, legacyAgentEngine("kubernetes")).open).toBe(true);
    }
  });

  test("a kubernetes investigation opens in agent mode under the kubectl variant", () => {
    const open = workflowAvailability("agent", "investigation", legacyAgentEngine("kubernetes"));
    expect(open).toEqual({
      open: true,
      statementLanguage: "kubectl",
      variant: requiredVariant("kubectl", "investigation", BUNDLED_CLIENT_PACKS),
    });
    if (!open.open) throw new Error("refused");
    // Its verifier is the SQL investigation's, so only the language is written to the header.
    expect(persistedRunFacts("agent", "investigation", "kubernetes", open)).toEqual({
      engine: "kubernetes",
      statementLanguage: "kubectl",
    });
  });

  test("a kubernetes resource-efficiency run opens in agent mode and persists its language and its own verifier", () => {
    const open = workflowAvailability("agent", "query-optimization", legacyAgentEngine("kubernetes"));
    expect(open).toEqual({
      open: true,
      statementLanguage: "kubectl",
      variant: requiredVariant("kubectl", "query-optimization", BUNDLED_CLIENT_PACKS),
    });
    if (!open.open) throw new Error("refused");
    expect(persistedRunFacts("agent", "query-optimization", "kubernetes", open)).toEqual({
      engine: "kubernetes",
      statementLanguage: "kubectl",
      verifier: "agent-query-optimization-kubectl.1",
    });
    // A plan is judged by the planning rule, so it persists the language and never the verifier.
    const plan = workflowAvailability("planning", "query-optimization", legacyAgentEngine("kubernetes"));
    if (!plan.open) throw new Error("refused");
    expect(persistedRunFacts("planning", "query-optimization", "kubernetes", plan)).toEqual({
      engine: "kubernetes",
      statementLanguage: "kubectl",
    });
  });

  test("a kubernetes cluster-health run opens in agent mode and persists its language and its own verifier", () => {
    const open = workflowAvailability("agent", "database-assessment", legacyAgentEngine("kubernetes"));
    expect(open).toEqual({
      open: true,
      statementLanguage: "kubectl",
      variant: requiredVariant("kubectl", "database-assessment", BUNDLED_CLIENT_PACKS),
    });
    if (!open.open) throw new Error("refused");
    expect(persistedRunFacts("agent", "database-assessment", "kubernetes", open)).toEqual({
      engine: "kubernetes",
      statementLanguage: "kubectl",
      verifier: "agent-database-assessment-kubectl.1",
    });
  });

  test("an SQL run opens under its SQL variant and its language", () => {
    expect(workflowAvailability("agent", "data-analysis", legacyAgentEngine("postgres"))).toEqual({
      open: true,
      statementLanguage: "sql",
      variant: requiredVariant("sql", "data-analysis", BUNDLED_CLIENT_PACKS),
    });
  });

  test("operations on an engine with no language opens under the one operations variant", () => {
    expect(workflowAvailability("agent", "operations", legacyAgentEngine("spark"))).toEqual({
      open: true,
      statementLanguage: null,
      variant: requiredVariant("sql", "operations", BUNDLED_CLIENT_PACKS),
    });
  });

  test("a plan on an engine with no language opens under no variant", () => {
    expect(workflowAvailability("planning", "investigation", legacyAgentEngine("spark"))).toEqual({
      open: true,
      statementLanguage: null,
      variant: null,
    });
  });

  test("a MongoDB run opens under its own language and variants (issue #1614)", () => {
    expect(workflowAvailability("agent", "data-analysis", legacyAgentEngine("mongodb"))).toEqual({
      open: true,
      statementLanguage: "mongo",
      variant: requiredVariant("mongo", "data-analysis", BUNDLED_CLIENT_PACKS),
    });
    expect(workflowAvailability("agent", "operations", legacyAgentEngine("mongodb"))).toEqual({
      open: true,
      statementLanguage: "mongo",
      variant: requiredVariant("mongo", "operations", BUNDLED_CLIENT_PACKS),
    });
    expect(workflowAvailability("planning", "investigation", legacyAgentEngine("mongodb"))).toEqual({
      open: true,
      statementLanguage: "mongo",
      variant: requiredVariant("mongo", "investigation", BUNDLED_CLIENT_PACKS),
    });
    // Every statement-sending workflow has a mongo variant: none of them may be the SQL
    // variant wearing a different name, and this is where that would show first.
    for (const workflow of ["investigation", "query-optimization", "database-assessment"] as const) {
      const open = workflowAvailability("agent", workflow, legacyAgentEngine("mongodb"));
      if (!open.open) throw new Error(`refused ${workflow}`);
      expect(open.statementLanguage).toBe("mongo");
    }
  });

  /*
    The two refusals the manifest cannot produce today: every SQL variant is total and every SQL engine holds its one
    requirement. So they are driven through tables naming a language whose variants are partial, which is what a
    language is while its variants are being filled in, and what the manifest may hold again for the next language.
  */
  const sqlInvestigation = requiredVariant("sql", "investigation", BUNDLED_CLIENT_PACKS);
  const partialLanguage = {
    packs: {
      ...BUNDLED_CLIENT_PACKS,
      kubectl: {
        ...BUNDLED_CLIENT_PACKS.kubectl,
        variants: {
          operations: requiredVariant("kubectl", "operations", BUNDLED_CLIENT_PACKS),
          investigation: { ...sqlInvestigation, requires: ["cluster-usage-reading"] },
        },
      },
    },
    // Held empty here whatever the live mirror says, so the refusal is driven by the table and not by the census.
    requirementEngines: { ...AGENT_REQUIREMENT_ENGINES, "cluster-usage-reading": [] },
  } as const;

  const AGENT_READINGS_SENTENCE =
    "Agent mode takes no operational reading on this engine: it offers agent mode none of the session, slow-query, table, index, storage or health readings, so the operations workflow's reading tool could only refuse. Plan mode drafts here.";
  const WITHOUT_READINGS = ["mqtt", "sparkplug", "opcua", "mtconnect"] as const;

  test.each(WITHOUT_READINGS)(
    "operations does not open in agent mode on %s, which offers agent mode no reading",
    (type) => {
      expect(workflowAvailability("agent", "operations", legacyAgentEngine(type))).toEqual({
        open: false,
        cause: "requirement-unmet",
        sentence: AGENT_READINGS_SENTENCE,
      });
      expect(workflowAvailability("planning", "operations", legacyAgentEngine(type)).open).toBe(true);
    },
  );

  test.each(["spark", "kubernetes", "kafka"] as const)(
    "operations still opens in agent mode on %s, which offers a reading",
    (type) => {
      expect(workflowAvailability("agent", "operations", legacyAgentEngine(type))).toMatchObject({
        open: true,
        variant: { requires: ["agent-readings"] },
      });
    },
  );

  test("the operations arm refuses an engine whose grants hold no agent reading", () => {
    const spark = legacyAgentEngine("spark");
    const unread = { id: spark.id, grants: { ...spark.grants, agentReadings: [] }, offers: spark.offers };
    expect(workflowAvailability("agent", "operations", unread)).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence: AGENT_READINGS_SENTENCE,
    });
    expect(workflowAvailability("planning", "operations", unread).open).toBe(true);
    expect(workflowAvailability("agent", "operations", spark).open).toBe(true);
  });

  test("a workflow with no variant on an engine without a reading names only plan mode as the way forward", () => {
    expect(workflowAvailability("agent", "query-optimization", legacyAgentEngine("mqtt"))).toEqual({
      open: false,
      cause: "no-variant",
      sentence: "Agent mode does not offer this workflow on this engine. Plan mode drafts here.",
    });
  });

  test("no availability refusal on an engine without a reading says the operations workflow runs there", () => {
    const reviewed = legacyRegisterTable("agentReadings");
    const withoutReadings = SHIPPED_DATABASE_TYPES.filter((type) => reviewed[type].length === 0);
    expect([...withoutReadings].sort()).toEqual([...WITHOUT_READINGS].sort());
    const claims: string[] = [];
    for (const type of withoutReadings) {
      for (const mode of ["agent", "planning"] as const) {
        for (const workflow of Object.keys(AGENT_WORKFLOW_PRESENTS_ANSWER) as AgentRunWorkflowType[]) {
          const availability = workflowAvailability(mode, workflow, legacyAgentEngine(type));
          if (availability.open) continue;
          // `not-reviewed` and `no-statement-session` are answered with sentences that name the operations workflow as a
          // way forward where it opens.
          if (
            availability.cause === "not-reviewed" ||
            availability.cause === "no-adapter" ||
            availability.cause === "no-statement-session"
          ) {
            claims.push(`${type} ${mode} ${workflow}: ${availability.cause}`);
          } else if (
            /operations workflow/.test(availability.sentence) &&
            availability.sentence !== AGENT_READINGS_SENTENCE
          ) {
            claims.push(`${type} ${mode} ${workflow}: ${availability.sentence}`);
          }
        }
      }
    }
    expect(claims).toEqual([]);
  });

  test("a workflow the language has no variant of is refused with the no-variant sentence", () => {
    expect(
      workflowAvailability("agent", "query-optimization", legacyAgentEngine("kubernetes"), partialLanguage),
    ).toEqual({
      open: false,
      cause: "no-variant",
      sentence:
        "Agent mode does not offer this workflow on this engine. The operations workflow runs here, and plan mode drafts here.",
    });
  });

  test("a variant whose requirement the engine does not hold is refused with that requirement's sentence", () => {
    expect(workflowAvailability("agent", "investigation", legacyAgentEngine("kubernetes"), partialLanguage)).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence:
        "This engine serves no usage reading, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
    });
  });

  test("a variant that requires a curated reading holds it on the engine's own grants", () => {
    const readingInvestigation = {
      ...partialLanguage,
      packs: {
        ...partialLanguage.packs,
        kubectl: {
          ...partialLanguage.packs.kubectl,
          variants: {
            ...partialLanguage.packs.kubectl.variants,
            investigation: { ...sqlInvestigation, requires: ["agent-readings"] },
          },
        },
      },
    } as const;
    const kubernetes = legacyAgentEngine("kubernetes");
    const unread = {
      id: kubernetes.id,
      grants: { ...kubernetes.grants, agentReadings: [] },
      offers: kubernetes.offers,
    };
    expect(workflowAvailability("agent", "investigation", kubernetes, readingInvestigation)).toEqual({
      open: true,
      statementLanguage: "kubectl",
      variant: readingInvestigation.packs.kubectl.variants.investigation,
    });
    expect(workflowAvailability("agent", "investigation", unread, readingInvestigation)).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence: AGENT_READINGS_SENTENCE,
    });
  });

  test("the same variant opens once the engine holds the requirement, and plan mode is never refused", () => {
    const held = {
      ...partialLanguage,
      requirementEngines: { ...AGENT_REQUIREMENT_ENGINES, "cluster-usage-reading": ["kubernetes"] },
    } as const;
    expect(workflowAvailability("agent", "investigation", legacyAgentEngine("kubernetes"), held)).toEqual({
      open: true,
      statementLanguage: "kubectl",
      variant: partialLanguage.packs.kubectl.variants.investigation,
    });
    expect(
      workflowAvailability("planning", "query-optimization", legacyAgentEngine("kubernetes"), partialLanguage),
    ).toEqual({
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
    packs: BUNDLED_CLIENT_PACKS,
    requirementEngines: { ...AGENT_REQUIREMENT_ENGINES, "sql-catalog": ["duckdb"], "sql-composers": [] },
  } as const;

  test.each(["investigation", "database-assessment", "data-analysis"] as const)(
    "%s opens on an engine that composes a catalog read and no estimating plan",
    (workflow) => {
      expect(workflowAvailability("agent", workflow, legacyAgentEngine("duckdb"), catalogOnly)).toEqual({
        open: true,
        statementLanguage: "sql",
        variant: requiredVariant("sql", workflow, BUNDLED_CLIENT_PACKS),
      });
    },
  );

  test("query-optimization stays refused there, with the sentence that says it needs an estimating plan", () => {
    expect(workflowAvailability("agent", "query-optimization", legacyAgentEngine("duckdb"), catalogOnly)).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence:
        "This workflow needs both a catalog read and an estimating plan, and agent mode has no verified composition of both for this engine, so this workflow's tools could only refuse. Workflows that need less still run here, the operations workflow among them, and plan mode drafts here.",
    });
  });

  test("on a shipped engine with a catalog read and no estimating plan, the refusal claims no missing catalog", () => {
    const refused = workflowAvailability("agent", "query-optimization", legacyAgentEngine("elasticsearch"));
    expect(refused).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence:
        "This workflow needs both a catalog read and an estimating plan, and agent mode has no verified composition of both for this engine, so this workflow's tools could only refuse. Workflows that need less still run here, the operations workflow among them, and plan mode drafts here.",
    });
    expect(workflowAvailability("agent", "investigation", legacyAgentEngine("elasticsearch"))).toMatchObject({
      open: true,
    });
  });

  test("a statement workflow on an engine that composes no catalog read names what it lacks", () => {
    const neither = { ...catalogOnly, requirementEngines: { ...catalogOnly.requirementEngines, "sql-catalog": [] } };
    expect(workflowAvailability("agent", "investigation", legacyAgentEngine("duckdb"), neither)).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence:
        "Agent mode has no verified catalog composition for this engine, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
    });
  });

  /*
    An engine whose language would open a statement workflow but whose grants hold no agent execution: driven through
    PostgreSQL's legacy grants with agent execution taken away, since no shipped engine has a language and no review.
  */
  const postgres = legacyAgentEngine("postgres");
  const unreviewedPostgres = {
    id: postgres.id,
    grants: { ...postgres.grants, agentExecution: false },
    offers: postgres.offers,
  };

  test("a statement workflow in agent mode on an engine the review record does not list is refused as not reviewed, though its language would open it", () => {
    for (const workflow of statementWorkflows) {
      expect(workflowAvailability("agent", workflow, unreviewedPostgres)).toEqual({
        open: false,
        cause: "not-reviewed",
      });
    }
  });

  test("plan mode and the operations workflow still open on such an engine", () => {
    expect(workflowAvailability("agent", "operations", unreviewedPostgres).open).toBe(true);
    for (const workflow of [...statementWorkflows, "operations"] as const) {
      expect(workflowAvailability("planning", workflow, unreviewedPostgres).open).toBe(true);
    }
  });

  test("notReviewedSentence names the engine and the ways forward that remain", () => {
    expect(notReviewedSentence("PostgreSQL", true)).toBe(
      "Agent mode runs statements only on the engines whose read-only statement path Studio has reviewed, and PostgreSQL is not one of them, so a run whose workflow sends a statement is not opened on it. The operations workflow runs here, and plan mode drafts here.",
    );
  });

  test("an SQL run persists only its engine, since sql and the SQL verifier are what absence reads as", () => {
    const open = workflowAvailability("agent", "query-optimization", legacyAgentEngine("postgres"));
    if (!open.open) throw new Error("refused");
    expect(persistedRunFacts("agent", "query-optimization", "postgres", open)).toEqual({ engine: "postgres" });
  });

  test("a run on an engine with no language persists only its engine", () => {
    for (const mode of ["agent", "planning"] as const) {
      const open = workflowAvailability(mode, "operations", legacyAgentEngine("spark"));
      if (!open.open) throw new Error("refused");
      expect(persistedRunFacts(mode, "operations", "spark", open), mode).toEqual({ engine: "spark" });
    }
  });

  test.each(["agent", "planning"] as const)("persistedRunFacts records the engine in %s mode", (mode) => {
    const open = workflowAvailability(mode, "operations", legacyAgentEngine("kafka"));
    if (!open.open) throw new Error("refused");
    expect(persistedRunFacts(mode, "operations", "kafka", open)).toEqual({
      engine: "kafka",
      statementLanguage: shippedDeclaredLanguage("kafkaread"),
    });
  });

  test("another language persists itself, and an agent run its own verifier where it is not the SQL one", () => {
    const variant = { ...sqlInvestigation, verifier: "agent-database-assessment.1" } as const;
    const open = { open: true, statementLanguage: "kubectl", variant } as const;
    expect(persistedRunFacts("agent", "investigation", "kubernetes", open)).toEqual({
      engine: "kubernetes",
      statementLanguage: "kubectl",
      verifier: "agent-database-assessment.1",
    });
    // A plan is judged by the planning rule whatever the variant says, so no verifier is written for it.
    expect(persistedRunFacts("planning", "investigation", "kubernetes", open)).toEqual({
      engine: "kubernetes",
      statementLanguage: "kubectl",
    });
    // The SQL verifier is what an absent field reads as, so it is not written either.
    expect(persistedRunFacts("agent", "investigation", "kubernetes", { ...open, variant: sqlInvestigation })).toEqual({
      engine: "kubernetes",
      statementLanguage: "kubectl",
    });
  });
});

describe("workflow availability on a package engine's record", () => {
  /**
   * The records of four admitted package engines: two with no register row, one requesting a statement language and
   * one requesting none, one whose row grants one reading and no language, and one whose row grants a language and no
   * agent execution.
   */
  function packageRecords() {
    const requesting = admittedFor("acme-requesting", admittedManifest("acmerequesting", withLoosestClaims));
    const silent = admittedFor("acme-silent", admittedManifest("acmesilent"));
    const reading = admittedFor("acme-reading", admittedManifest("acmereading", withLoosestClaims));
    const language = admittedFor("acme-language", admittedManifest("acmelanguage", withLoosestClaims));
    const register = parseGrantRegister(
      [
        packageRow(reading, "acmereading", { agentReadings: Object.freeze(["sessions"] as const) }),
        packageRow(language, "acmelanguage", { statementLanguage: "sql", agentExecution: false }),
      ],
      LEGACY_ENGINE_IDS,
    );
    const { engines } = composeServerCatalog([requesting, silent, reading, language], [], register);
    const record = (id: string) => {
      const engine = engines.get(id);
      if (engine === undefined) throw new Error(`the catalog holds no record of ${id}`);
      return engine;
    };
    return {
      requesting: record("acmerequesting"),
      silent: record("acmesilent"),
      reading: record("acmereading"),
      language: record("acmelanguage"),
    };
  }

  const AGENT_READINGS_REFUSAL: AgentWorkflowAvailability = {
    open: false,
    cause: "requirement-unmet",
    sentence:
      "Agent mode takes no operational reading on this engine: it offers agent mode none of the session, slow-query, table, index, storage or health readings, so the operations workflow's reading tool could only refuse. Plan mode drafts here.",
  };

  test("a package record's availability reads its grants: a language it requests and no row grants is not reviewed, one it requests none of has no adapter, and the operations workflow opens only on a granted reading", () => {
    const { requesting, silent, reading, language } = packageRecords();
    const statementWorkflows = ["investigation", "query-optimization", "database-assessment", "data-analysis"] as const;

    // Plan mode opens every workflow on every engine, under no variant where no language is granted.
    for (const engine of [requesting, silent, reading]) {
      for (const workflow of WORKFLOWS) {
        expect(workflowAvailability("planning", workflow, engine)).toEqual({
          open: true,
          statementLanguage: null,
          variant: null,
        });
      }
    }
    expect(workflowAvailability("planning", "investigation", language)).toEqual({
      open: true,
      statementLanguage: "sql",
      variant: requiredVariant("sql", "investigation", BUNDLED_CLIENT_PACKS),
    });

    for (const workflow of statementWorkflows) {
      expect(workflowAvailability("agent", workflow, requesting)).toEqual({ open: false, cause: "not-reviewed" });
      expect(workflowAvailability("agent", workflow, silent)).toEqual({ open: false, cause: "no-adapter" });
      expect(workflowAvailability("agent", workflow, reading)).toEqual({ open: false, cause: "not-reviewed" });
      expect(workflowAvailability("agent", workflow, language)).toEqual({ open: false, cause: "not-reviewed" });
    }
    for (const engine of [requesting, silent]) {
      expect(workflowAvailability("agent", "operations", engine)).toEqual(AGENT_READINGS_REFUSAL);
      expect(openWorkflows("agent", engine)).toEqual([]);
      expect(operationsWorkflowOpens(engine)).toBe(false);
    }
    expect(workflowAvailability("agent", "operations", reading)).toEqual({
      open: true,
      statementLanguage: null,
      variant: OPERATIONS_VARIANT,
    });
    expect(openWorkflows("agent", reading)).toEqual(["operations"]);
    expect(operationsWorkflowOpens(reading)).toBe(true);
    expect([...openWorkflows("planning", silent)]).toEqual([...WORKFLOWS]);
  });

  test("a package record granted agent execution opens no statement workflow in agent mode where its package takes no read-only execute, and its declared language's investigation where it does", () => {
    const executing = admittedFor("acme-executing", admittedManifest("acmeexecuting", withLoosestClaims));
    const unread = admittedFor("acme-executing-unread", admittedManifest("acmeexecutingunread", withLoosestClaims));
    // Granted sql and agent execution, its package honouring readOnly.
    const sqlRead = admittedFor(
      "acme-executing-read",
      admittedManifest("acmeexecutingread", withLoosestClaims, ["readOnly"]),
    );
    const register = parseGrantRegister(
      [
        packageRow(executing, "acmeexecuting", {
          statementLanguage: "sql",
          agentExecution: true,
          agentReadings: Object.freeze(["health"] as const),
        }),
        packageRow(unread, "acmeexecutingunread", { statementLanguage: "sql", agentExecution: true }),
        packageRow(sqlRead, "acmeexecutingread", {
          statementLanguage: "sql",
          agentExecution: true,
          readRootsRequired: false,
        }),
      ],
      LEGACY_ENGINE_IDS,
    );
    const { engines } = composeServerCatalog([executing, unread, sqlRead], [], register);
    const reading = engines.get("acmeexecuting");
    const silent = engines.get("acmeexecutingunread");
    if (reading === undefined || silent === undefined) throw new Error("the catalog holds no record of the packages");
    const statementWorkflows = ["investigation", "query-optimization", "database-assessment", "data-analysis"] as const;
    for (const engine of [reading, silent]) {
      // Vacuity: the row grants the language and agent execution, and the record offers no read-only statement session.
      expect(engine.grants).toMatchObject({ statementLanguage: "sql", agentExecution: true });
      expect(engine.offers.readOnlyStatements).toBe(false);
      for (const workflow of WORKFLOWS) {
        expect(workflowAvailability("planning", workflow, engine)).toEqual({
          open: true,
          statementLanguage: "sql",
          variant: requiredVariant("sql", workflow, BUNDLED_CLIENT_PACKS),
        });
      }
      for (const workflow of statementWorkflows) {
        expect(workflowAvailability("agent", workflow, engine)).toEqual({ open: false, cause: "no-statement-session" });
      }
    }
    expect(workflowAvailability("agent", "operations", reading)).toEqual({
      open: true,
      statementLanguage: "sql",
      variant: OPERATIONS_VARIANT,
    });
    expect(openWorkflows("agent", reading)).toEqual(["operations"]);
    expect(workflowAvailability("agent", "operations", silent)).toEqual(AGENT_READINGS_REFUSAL);
    expect(openWorkflows("agent", silent)).toEqual([]);

    // A package granted sql that takes a read-only execute meets the SQL variants' requirements, which hold on legacy
    // engines alone: every statement workflow is refused by the requirement it lacks.
    const read = engines.get("acmeexecutingread");
    if (read === undefined) throw new Error("the catalog holds no record of the package");
    expect(read.offers.readOnlyStatements).toBe(true);
    const unmet = new Set([
      "Agent mode has no verified catalog composition for this engine, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
      "This workflow needs both a catalog read and an estimating plan, and agent mode has no verified composition of both for this engine, so this workflow's tools could only refuse. Workflows that need less still run here, the operations workflow among them, and plan mode drafts here.",
    ]);
    for (const workflow of statementWorkflows) {
      const answer = workflowAvailability("agent", workflow, read);
      expect([workflow, answer.open, "cause" in answer && answer.cause]).toEqual([
        workflow,
        false,
        "requirement-unmet",
      ]);
      expect(unmet.has("sentence" in answer ? answer.sentence : ""), workflow).toBe(true);
    }

    // A package granted its own declared language: its investigation opens where its package takes a read-only
    // execute, under the declared variant of the language the installed catalog composes, and no other statement
    // workflow, which its language has no variant of; where its package takes none, none opens.
    expect(serverCatalogInstalled()).toBe(false);
    for (const honours of [["readOnly"], []]) {
      installServerCatalog(agentPackageLanguageCatalog({ honours }));
      try {
        const spoken = servedEngineRecord(AGENT_PACKAGE_LANGUAGE);
        const tables = servedAvailabilityTables();
        expect(spoken.offers.readOnlyStatements).toBe(honours.length > 0);
        if (honours.length === 0) {
          for (const workflow of statementWorkflows) {
            expect(workflowAvailability("agent", workflow, spoken, tables)).toEqual({
              open: false,
              cause: "no-statement-session",
            });
          }
          continue;
        }
        const acmeread = "acmeread" as AgentDeclaredLanguageId;
        expect(workflowAvailability("agent", "investigation", spoken, tables)).toEqual({
          open: true,
          statementLanguage: acmeread,
          variant: servedClientPacks()[acmeread].variants.investigation ?? null,
        });
        for (const workflow of ["query-optimization", "database-assessment", "data-analysis"] as const) {
          expect(workflowAvailability("agent", workflow, spoken, tables)).toMatchObject({
            open: false,
            cause: "no-variant",
          });
        }
      } finally {
        forgetServerCatalog();
      }
    }
  });

  test("the no-statement-session refusal names the engine and the operations workflow only where it opens", () => {
    const refusal =
      "Agent mode sends statements only through a read-only statement session, and the provider package of Acme takes no read-only execute, so Studio opens none on it.";
    expect(noStatementSessionSentence("Acme", true)).toBe(
      `${refusal} So a run whose workflow sends a statement is not opened on it. The operations workflow runs here, and plan mode drafts here.`,
    );
    expect(noStatementSessionSentence("Acme", false)).toBe(
      `${refusal} So a run whose workflow sends a statement is not opened on it. Plan mode drafts here.`,
    );
  });

  test("the not-reviewed refusal names the operations workflow only where it opens", () => {
    const { requesting, reading } = packageRecords();

    expect(notReviewedSentence("Acme", operationsWorkflowOpens(reading))).toBe(
      "Agent mode runs statements only on the engines whose read-only statement path Studio has reviewed, and Acme is not one of them, so a run whose workflow sends a statement is not opened on it. The operations workflow runs here, and plan mode drafts here.",
    );
    expect(notReviewedSentence("Acme", operationsWorkflowOpens(requesting))).toBe(
      "Agent mode runs statements only on the engines whose read-only statement path Studio has reviewed, and Acme is not one of them, so a run whose workflow sends a statement is not opened on it. Plan mode drafts here.",
    );
  });
});
