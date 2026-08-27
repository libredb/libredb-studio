import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_EXECUTION_ENGINES, namedList } from "@/lib/agent/engine-support";
import { AGENT_HANDOVER_BUDGET, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { agentPosture, autoExecuteTerms } from "@/lib/agent/posture";
import type { AgentRunWorkflowType } from "@/lib/agent/types";
import { getDBConfig } from "@/lib/db-ui-config";

/**
 * The rail's one-axis reading of what the selected mode does to the database.
 *
 * Every claim in this module is a claim the server already enforces somewhere else, so the
 * tests below check two different things and it matters which is which:
 *
 *  - the exact reviewed wording, because the strings were approved as written; and
 *  - that every engine name and every number in that wording is DERIVED - from
 *    `AGENT_EXECUTION_ENGINES`, from `CATALOG_PLANS` and from the policy rows - so a change
 *    on the enforcing side cannot leave a stale claim behind. The last describe block is
 *    that guard: it substitutes a third engine and fails if the copy does not follow.
 */

/**
 * The same join the copy uses, and it is `namedList` rather than a local `join(" and ")`:
 * a local copy would have gone on asserting "PostgreSQL and SQLite and DuckDB" - the
 * sentence a three-engine list produced before the shared helper existed.
 */
const labelsOf = (types: readonly string[]): string =>
  namedList(types.map((type) => getDBConfig(type as Parameters<typeof getDBConfig>[0]).label));

const EXECUTION_ENGINE_NAMES = labelsOf(AGENT_EXECUTION_ENGINES);
const WORKFLOW_TYPES = Object.keys(AGENT_WORKFLOW_BUDGETS) as AgentRunWorkflowType[];
const STATEMENT_BUDGETS = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;

/**
 * The dialects whose grounding capture is a COMPOSED CATALOG READ, read out of
 * `context-snapshot.ts` as source text rather than imported.
 *
 * `CATALOG_PLANS` is module-private, and its module imports `node:crypto` and the tool
 * layer, so a posture module that imported it would stop being client-safe - which is the
 * rule `engine-support.ts` records in its own header. So the production module mirrors the
 * set, and this reads the real one to keep the mirror honest: a dialect added to
 * `CATALOG_PLANS` fails this file until the posture copy names it.
 */
function catalogPlanDialects(): string[] {
  const source = fs.readFileSync(path.join(process.cwd(), "src/lib/agent/context-snapshot.ts"), "utf8");
  const block = /const CATALOG_PLANS: Partial<Record<DatabaseType, CatalogPlan>> = \{\n([\s\S]*?)\n\};/.exec(source);
  expect(block).not.toBeNull();
  const body = block?.[1] ?? "";
  return [...body.matchAll(/^ {2}([a-z]+): \{/gm)].map((entry) => entry[1] as string);
}

describe("agentPosture in plan mode", () => {
  test("reads the same on every engine, and says what its one reach is", () => {
    const posture = agentPosture({
      mode: "planning",
      engine: "postgres",
      engineLabel: getDBConfig("postgres").label,
      handover: false,
    });

    expect(posture.tone).toBe("safe");
    expect(posture.headline).toBe("Executes nothing it drafts");
    expect(posture.qualifier).toBe("one schema read grounds it, nothing else reaches the database");
    expect(posture.title).toBe("Plan mode drafts, and never runs what it drafted");
    expect(posture.body).toBe(
      `Plan mode never executes the statement it wrote, on any engine — production included. Its one reach is the schema capture that grounds it: metadata only, no data rows, and it is where the inventory in Run details came from. On ${labelsOf(catalogPlanDialects())} that capture is itself a catalog read; on every other engine it asks the provider to describe its own schema.`,
    );
  });

  test("an engine agent mode cannot execute on gets the identical plan posture", () => {
    const onMongo = agentPosture({
      mode: "planning",
      engine: "mongodb",
      engineLabel: getDBConfig("mongodb").label,
      handover: false,
    });
    const onPostgres = agentPosture({
      mode: "planning",
      engine: "postgres",
      engineLabel: getDBConfig("postgres").label,
      handover: false,
    });

    expect(onMongo).toEqual(onPostgres);
  });

  test("the hand-over tick cannot widen plan mode", () => {
    const ticked = agentPosture({
      mode: "planning",
      engine: "postgres",
      engineLabel: getDBConfig("postgres").label,
      handover: true,
    });

    expect(ticked.tone).toBe("safe");
    expect(ticked.headline).toBe("Executes nothing it drafts");
  });

  test("no resolved connection still reads as plan mode, which is engine-independent", () => {
    const unresolved = agentPosture({ mode: "planning", engine: null, engineLabel: "", handover: false });

    expect(unresolved.tone).toBe("safe");
    expect(unresolved).toEqual(
      agentPosture({
        mode: "planning",
        engine: "sqlite",
        engineLabel: getDBConfig("sqlite").label,
        handover: false,
      }),
    );
  });
});

describe("agentPosture in agent mode, on an engine it can execute on", () => {
  test("without the hand-over it names the bounds the engine enforces", () => {
    const posture = agentPosture({
      mode: "agent",
      engine: "postgres",
      engineLabel: getDBConfig("postgres").label,
      handover: false,
    });
    const rows = STATEMENT_BUDGETS.maxResultRows;
    const seconds = STATEMENT_BUDGETS.statementTimeoutMs / 1000;

    expect(posture.tone).toBe("reads");
    expect(posture.headline).toBe("Reads only");
    expect(posture.qualifier).toBe(`${rows} rows and ${seconds} s per statement, enforced by the engine`);
    expect(posture.title).toBe("Agent mode reads, under a boundary the engine enforces");
    expect(posture.body).toBe(
      `Agent mode runs statements it wrote itself, in a read-only session the database enforces, bounded to ${rows} rows and ${seconds} seconds each. Writes and DDL are refused by the engine rather than by reading the statement. Nothing reaches your editor unless you tick the hand-over when the run opens.`,
    );
  });

  test("every executable engine reads the same, on the same tone", () => {
    for (const engine of AGENT_EXECUTION_ENGINES) {
      const posture = agentPosture({
        mode: "agent",
        engine,
        engineLabel: getDBConfig(engine).label,
        handover: false,
      });
      expect(posture.tone).toBe("reads");
      expect(posture.headline).toBe("Reads only");
    }
  });

  test("with the hand-over it is widened, and its body is the consent's own terms", () => {
    const posture = agentPosture({
      mode: "agent",
      engine: "sqlite",
      engineLabel: getDBConfig("sqlite").label,
      handover: true,
    });

    expect(posture.tone).toBe("widened");
    expect(posture.headline).toBe("Reads only, and one statement in your editor");
    expect(posture.qualifier).toBe(
      `${AGENT_HANDOVER_BUDGET.maxResultRows} rows, no time limit, same read-only session`,
    );
    expect(posture.title).toBe("Reads only, and one statement lands in your editor");
    expect(posture.body).toBe(autoExecuteTerms("investigation"));
  });
});

describe("agentPosture in agent mode, where it cannot execute", () => {
  test("an unsupported engine is blocked, and the copy names what still runs", () => {
    const posture = agentPosture({
      mode: "agent",
      engine: "mongodb",
      engineLabel: getDBConfig("mongodb").label,
      handover: false,
    });

    expect(posture.tone).toBe("blocked");
    expect(posture.headline).toBe("Cannot execute on MongoDB");
    expect(posture.qualifier).toBe("plan mode drafts here, and the operations workflow still runs");
    expect(posture.title).toBe("Agent mode has no read-only statement path on MongoDB");
    expect(posture.body).toBe(
      `Agent mode executes only where the provider implements a database-native read-only statement path — ${EXECUTION_ENGINE_NAMES}. On MongoDB a run whose workflow sends a statement is refused when it is started, before a run is opened. The operations workflow still runs here, because it sends no statement at all: it calls the curated reporting methods every provider implements. Plan mode drafts on every engine.`,
    );
  });

  test("the hand-over tick cannot unblock an unsupported engine", () => {
    const posture = agentPosture({
      mode: "agent",
      engine: "oracle",
      engineLabel: getDBConfig("oracle").label,
      handover: true,
    });

    expect(posture.tone).toBe("blocked");
    expect(posture.headline).toBe("Cannot execute on Oracle");
    expect(posture.body).toContain("On Oracle a run whose workflow sends a statement is refused when it is started");
  });

  test("no resolved connection claims nothing about an engine it has not seen", () => {
    const posture = agentPosture({ mode: "agent", engine: null, engineLabel: "", handover: false });

    expect(posture.tone).toBe("blocked");
    expect(posture.headline).toBe("Cannot execute yet");
    expect(posture.qualifier).toBe("no connection is resolved, so no engine has been established");
    expect(posture.title).toBe("Agent mode has no connection to execute on");
    expect(posture.body).toBe(
      `Agent mode executes only where the provider implements a database-native read-only statement path — ${EXECUTION_ENGINE_NAMES}. No connection is resolved here, so this panel cannot say which engine you are on, or whether it is one of those: until one is resolved, agent mode executes nothing. The operations workflow sends no statement at all, so it runs wherever a connection does, and plan mode drafts on every engine.`,
    );
  });

  test("the unresolved reading never states an engine label, not even an empty one", () => {
    const posture = agentPosture({ mode: "agent", engine: null, engineLabel: "Postgres-shaped guess", handover: true });

    expect(posture.headline).toBe("Cannot execute yet");
    expect(posture.body).not.toContain("Postgres-shaped guess");
  });
});

describe("autoExecuteTerms", () => {
  test("names the run's own bounds and the editor's, for every workflow", () => {
    for (const workflowType of WORKFLOW_TYPES) {
      const budgets = AGENT_WORKFLOW_BUDGETS[workflowType].policy.budgets;
      const terms = autoExecuteTerms(workflowType);

      expect(terms).toContain(
        `bounded to ${budgets.maxResultRows} rows and ${budgets.statementTimeoutMs / 1000} seconds`,
      );
      expect(terms).toContain(
        `at the editor's ${AGENT_HANDOVER_BUDGET.maxResultRows}-row limit and with no time limit`,
      );
      expect(terms).toContain(
        "It is the same database-enforced read-only session either way, so writes and DDL are refused by the engine rather than by reading the statement.",
      );
    }
  });

  /**
   * The widened posture carries no workflow, so it can only state one pair of figures.
   * That is honest exactly while every row states the same pair - `workflowBudget()` writes
   * `statementTimeoutMs` and `maxResultRows` once and varies only the per-run ceilings. If a
   * row ever varies them this fails, and the fix is to give the posture a workflow rather
   * than to edit a digit.
   */
  test("every workflow row agrees on the per-statement bounds the posture states", () => {
    for (const workflowType of WORKFLOW_TYPES) {
      const budgets = AGENT_WORKFLOW_BUDGETS[workflowType].policy.budgets;
      expect(budgets.maxResultRows).toBe(STATEMENT_BUDGETS.maxResultRows);
      expect(budgets.statementTimeoutMs).toBe(STATEMENT_BUDGETS.statementTimeoutMs);
      expect(autoExecuteTerms(workflowType)).toBe(
        agentPosture({
          mode: "agent",
          engine: "postgres",
          engineLabel: getDBConfig("postgres").label,
          handover: true,
        }).body,
      );
    }
  });
});

/**
 * Kept last in the file on purpose: `mock.module` is process-wide, so this substitution
 * would otherwise be read by every test after it. It is restored at the end regardless.
 */
describe("the engine names follow the enforcing list", () => {
  test("an engine added to AGENT_EXECUTION_ENGINES changes the copy with no copy edit", async () => {
    const real = [...AGENT_EXECUTION_ENGINES];
    try {
      // `namedList` is re-exported by the substitute rather than dropped: the module under
      // test imports it from here too, and a factory naming only the array would swap the
      // list for a third engine and take the join with it.
      mock.module("@/lib/agent/engine-support", () => ({
        AGENT_EXECUTION_ENGINES: ["postgres", "sqlite", "mysql"],
        namedList,
      }));
      const { agentPosture: withThree } = await import("@/lib/agent/posture");
      const blocked = withThree({
        mode: "agent",
        engine: "mongodb",
        engineLabel: getDBConfig("mongodb").label,
        handover: false,
      });

      expect(blocked.body).toContain("path — PostgreSQL, SQLite and MySQL.");
      expect(withThree({ mode: "agent", engine: "mysql", engineLabel: "MySQL", handover: false }).tone).toBe("reads");
    } finally {
      mock.module("@/lib/agent/engine-support", () => ({ AGENT_EXECUTION_ENGINES: real, namedList }));
    }
  });

  test("the list is read per call, so nothing in the copy is frozen at module load", () => {
    expect(agentPosture({ mode: "agent", engine: "mongodb", engineLabel: "MongoDB", handover: false }).body).toContain(
      `path — ${EXECUTION_ENGINE_NAMES}.`,
    );
  });
});
