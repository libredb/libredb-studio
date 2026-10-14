import { describe, expect, test } from "bun:test";
import { AGENT_LANGUAGE_COPY, AGENT_REQUIREMENT_ENGINES, AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { composesCatalogFor, composesEstimatingExplainFor } from "@/lib/agent/composed-sql";
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
