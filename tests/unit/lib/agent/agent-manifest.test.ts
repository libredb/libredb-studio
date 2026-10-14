import { describe, expect, test } from "bun:test";
import {
  AGENT_LANGUAGE_COPY,
  AGENT_REQUIREMENT_ENGINES,
  AGENT_STATEMENT_LANGUAGE,
  AGENT_WORKFLOW_VARIANTS,
  type AgentStatementLanguageId,
  agentVariant,
  planDeliverableOf,
  planObjectiveOf,
  requiredVariant,
} from "@/lib/agent/agent-manifest";
import { composesCatalogFor, composesEstimatingExplainFor } from "@/lib/agent/composed-sql";
import { AGENT_WORKFLOW_GOALS } from "@/lib/agent/goal-verifier";
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
    });
  });

  test("kubectl names its own argument and its own boundary", () => {
    expect(AGENT_LANGUAGE_COPY.kubectl.argument).toBe("statement");
    expect(AGENT_LANGUAGE_COPY.kubectl.adviceKeys).toEqual(["get", "top", "logs", "events"]);
  });
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

  // Each kubectl variant task removes its own workflow from this list.
  test.each(["investigation", "query-optimization", "database-assessment", "data-analysis"] as const)(
    "a missing kubectl %s variant is an explicit error",
    (workflow) => {
      expect(agentVariant("kubectl", workflow)).toBeUndefined();
      expect(() => requiredVariant("kubectl", workflow)).toThrow(`no ${workflow} variant for kubectl`);
    },
  );

  test("operations is one variant for every language", () => {
    expect(AGENT_WORKFLOW_VARIANTS.kubectl.operations).toBe(AGENT_WORKFLOW_VARIANTS.sql.operations);
  });

  test("an inherited plan deliverable is the SQL one", () => {
    expect(planDeliverableOf(undefined, "query-optimization")).toEqual({
      kind: "statement",
      noun: "the rewritten statement",
    });
  });

  test("a language with no variant plans with the SQL deliverable", () => {
    expect(planDeliverableOf("kubectl", "investigation")).toEqual(planDeliverableOf("sql", "investigation"));
  });

  test("a language with no variant plans with the SQL objective, and one with a variant plans with its own", () => {
    expect(planObjectiveOf("kubectl", "investigation")).toBe(requiredVariant("sql", "investigation").objective);
    expect(planObjectiveOf("kubectl", "operations")).toBe(requiredVariant("kubectl", "operations").objective);
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
