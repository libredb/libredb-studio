import { describe, expect, mock, test } from "bun:test";
import * as manifest from "@/lib/agent/agent-manifest";
import { AGENT_EXECUTION_ENGINES, namedList } from "@/lib/agent/engine-support";
import { AGENT_HANDOVER_BUDGET, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { engineServerDialect } from "@/lib/agent/languages/engines/server";
import { agentPosture, autoExecuteTerms } from "@/lib/agent/posture";
import type { AgentRunWorkflowType } from "@/lib/agent/types";
import { getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";

/**
 * The rail's one-axis reading of what the selected mode does to the database.
 *
 * Every claim in this module is a claim the server already enforces somewhere else, so the
 * tests below check two different things and it matters which is which:
 *
 *  - the exact reviewed wording, because the strings were approved as written; and
 *  - that every engine name and every number in that wording is DERIVED - from
 *    `AGENT_EXECUTION_ENGINES`, from the engines' `catalogCapture` and from the policy rows - so a change
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
 * The dialects whose grounding capture is a COMPOSED CATALOG READ: the engines whose server
 * `catalogCapture` is supplied, in `AGENT_STATEMENT_LANGUAGE` order.
 *
 * The server dialect is server tier, so a posture module that imported it would stop being
 * client-safe - which is the rule `engine-support.ts` records in its own header. So the
 * production module reads the client dialects, and this reads the real server one to keep
 * them honest: an engine that gains a `catalogCapture` fails this file until the copy names it.
 */
function catalogPlanDialects(): string[] {
  return (Object.keys(manifest.AGENT_STATEMENT_LANGUAGE) as DatabaseType[]).filter(
    (type) => engineServerDialect(type).catalogCapture !== "unsupported",
  );
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

  test("the engines named as capturing by a catalog read are PostgreSQL and SQLite, written out", () => {
    // The literal beside the derived one above: the mirror and its source could move together.
    const posture = agentPosture({ mode: "planning", engine: null, engineLabel: "", handover: false });

    expect(posture.body).toContain("On PostgreSQL and SQLite that capture is itself a catalog read");
  });

  test("an engine agent mode cannot execute on gets the identical plan posture", () => {
    const onMongo = agentPosture({
      mode: "planning",
      engine: "trino",
      engineLabel: getDBConfig("trino").label,
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
    expect(posture.body).toBe(autoExecuteTerms("investigation", "sql"));
  });
});

describe("the posture on MongoDB", () => {
  const posture = agentPosture({
    mode: "agent",
    engine: "mongodb",
    engineLabel: getDBConfig("mongodb").label,
    handover: false,
  });
  const rows = STATEMENT_BUDGETS.maxResultRows;
  const seconds = STATEMENT_BUDGETS.statementTimeoutMs / 1000;

  // Who holds each bound, in this engine's own terms: the server's deadline with Studio's kill behind it, the server's
  // row bound, a principal the server must report and test before a command-sending run's first model turn (the
  // operations workflow sends none and is not verified), and the fence. There is no read-only session to name.
  test("states the reviewed wording, with the figures read from the policy row", () => {
    expect(posture.tone).toBe("reads");
    expect(posture.headline).toBe("Reads only");
    expect(posture.qualifier).toBe(`${rows} rows and ${seconds} s per command, enforced by the server`);
    expect(posture.title).toBe("Agent mode reads, under a boundary the server enforces");
    expect(posture.body).toBe(
      `Agent mode runs commands it wrote itself, bounded to ${rows} rows and ${seconds} seconds each: maxTimeMS is the server's own deadline, and Studio ends a command the server does not. On the server, find and aggregate stop one row past the budget. Before the first model turn of a run that sends commands, the server must report that this connection's user holds only read privileges on this database and must refuse a write from it: a user that can write, a server without authentication, or a server that is not MongoDB ends that run there. The fence refuses writes, write stages, server-side JavaScript and diagnostic stages before the engine is reached. Nothing reaches your editor.`,
    );
  });

  test("a hand-over tick widens nothing, because no hand-over is offered on this engine", () => {
    const ticked = agentPosture({ mode: "agent", engine: "mongodb", engineLabel: "MongoDB", handover: true });

    expect(ticked).toEqual(posture);
  });

  test("autoExecuteTerms on mongo says no hand-over runs there, in the kubectl sentence's shape", () => {
    expect(autoExecuteTerms("data-analysis", "mongo")).toBe(
      "A MongoDB answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
    );
  });

  test("no MongoDB sentence promises what the engine does not do", () => {
    const ticked = agentPosture({ mode: "agent", engine: "mongodb", engineLabel: "MongoDB", handover: true });
    const sentences = [
      ...Object.values(posture),
      ...Object.values(ticked),
      ...WORKFLOW_TYPES.map((workflowType) => autoExecuteTerms(workflowType, "mongo")),
    ];
    for (const sentence of sentences) {
      for (const overclaim of [
        "proven read-only at open",
        "no time limit",
        "run it there",
        "read-only session",
        "before they cross the wire",
      ]) {
        expect(sentence, sentence).not.toContain(overclaim);
      }
    }
  });
});

describe("agentPosture in agent mode, where it cannot execute", () => {
  test("an unsupported engine is blocked, and the copy names what still runs", () => {
    const posture = agentPosture({
      mode: "agent",
      engine: "trino",
      engineLabel: getDBConfig("trino").label,
      handover: false,
    });

    expect(posture.tone).toBe("blocked");
    expect(posture.headline).toBe("Cannot execute on Trino");
    expect(posture.qualifier).toBe("plan mode drafts here, and the operations workflow still runs");
    expect(posture.title).toBe("Agent mode has no read-only statement path on Trino");
    expect(posture.body).toBe(
      `Agent mode executes only where the provider implements a read-only statement path under a boundary it declares: ${EXECUTION_ENGINE_NAMES}. On Trino a run whose workflow sends a statement is refused when it is started, before a run is opened. The operations workflow still runs here, because it sends no statement at all: it calls the curated reporting methods every provider implements. Plan mode drafts on every engine.`,
    );
  });

  test("the hand-over tick cannot unblock an unsupported engine", () => {
    const posture = agentPosture({
      mode: "agent",
      engine: "spark",
      engineLabel: getDBConfig("spark").label,
      handover: true,
    });

    expect(posture.tone).toBe("blocked");
    expect(posture.headline).toBe("Cannot execute on Apache Spark");
    expect(posture.body).toContain(
      "On Apache Spark a run whose workflow sends a statement is refused when it is started",
    );
  });

  test("no resolved connection claims nothing about an engine it has not seen", () => {
    const posture = agentPosture({ mode: "agent", engine: null, engineLabel: "", handover: false });

    expect(posture.tone).toBe("blocked");
    expect(posture.headline).toBe("Cannot execute yet");
    expect(posture.qualifier).toBe("no connection is resolved, so no engine has been established");
    expect(posture.title).toBe("Agent mode has no connection to execute on");
    expect(posture.body).toBe(
      `Agent mode executes only where the provider implements a read-only statement path under a boundary it declares: ${EXECUTION_ENGINE_NAMES}. No connection is resolved here, so this panel cannot say which engine you are on, or whether it is one of those: until one is resolved, agent mode executes nothing. The operations workflow sends no statement at all, so it runs wherever a connection does, and plan mode drafts on every engine.`,
    );
  });

  test("the unresolved reading never states an engine label, not even an empty one", () => {
    const posture = agentPosture({ mode: "agent", engine: null, engineLabel: "Postgres-shaped guess", handover: true });

    expect(posture.headline).toBe("Cannot execute yet");
    expect(posture.body).not.toContain("Postgres-shaped guess");
  });
});

describe("the posture on Kubernetes", () => {
  const posture = agentPosture({ mode: "agent", engine: "kubernetes", engineLabel: "Kubernetes", handover: false });
  const rows = STATEMENT_BUDGETS.maxResultRows;
  const seconds = STATEMENT_BUDGETS.statementTimeoutMs / 1000;

  test("says Studio's request allowlist and RBAC bound it, never that the engine or the database does", () => {
    expect(posture.tone).toBe("reads");
    expect(posture.body).toContain("request allowlist");
    expect(posture.body).toContain("RBAC");
    expect(posture.body).not.toMatch(/database-enforced|database-native|refused by the engine|the database enforces/);
  });

  test("names both identities the agent may run as, and recommends a view token", () => {
    expect(posture.body).toContain("agent token");
    expect(posture.body).toContain("view");
  });

  test("states the reviewed wording, with the figures read from the policy row", () => {
    expect(posture.headline).toBe("Reads only");
    expect(posture.qualifier).toBe(
      `${rows} rows and ${seconds} s per statement, enforced by Studio's request allowlist`,
    );
    expect(posture.title).toBe("Agent mode reads, under a boundary Studio enforces");
    expect(posture.body).toBe(
      `Agent mode runs kubectl reads it wrote itself, bounded to ${rows} rows and ${seconds} seconds each. Studio's request allowlist admits reads only, checked on the final request before it is sent, and the identity's RBAC decides what is visible: the agent runs on the connection's agent token when one is set, and on the connection's own token otherwise, so give it a token bound to view. Values Studio masks, such as env values, annotation values, ConfigMap data and Secret names and values, never reach the model. Nothing reaches your editor.`,
    );
  });

  test("a hand-over tick widens nothing, because no hand-over is offered on this engine", () => {
    const ticked = agentPosture({ mode: "agent", engine: "kubernetes", engineLabel: "Kubernetes", handover: true });

    expect(ticked).toEqual(posture);
  });

  test("the SQL posture is unchanged", () => {
    const sql = agentPosture({ mode: "agent", engine: "postgres", engineLabel: "PostgreSQL", handover: false });
    expect(sql.body).toContain("in a read-only session the database enforces");
  });

  test("the engine-less arms no longer call every listed engine database-native", () => {
    const unsupported = agentPosture({ mode: "agent", engine: "trino", engineLabel: "Trino", handover: false });
    expect(unsupported.body).not.toContain("database-native");
    expect(unsupported.body).toContain("Kubernetes");
    const unresolved = agentPosture({ mode: "agent", engine: null, engineLabel: "", handover: false });
    expect(unresolved.body).not.toContain("database-native");
    expect(unresolved.body).toContain("Kubernetes");
  });

  test("autoExecuteTerms on kubectl says no hand-over runs there", () => {
    expect(autoExecuteTerms("data-analysis", "kubectl")).toContain("never run in your editor");
    expect(autoExecuteTerms("data-analysis", "kubectl")).toBe(
      "A kubectl answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
    );
  });
});

describe("the posture on Oxia", () => {
  const posture = agentPosture({ mode: "agent", engine: "oxia", engineLabel: "Oxia", handover: false });
  const rows = STATEMENT_BUDGETS.maxResultRows;

  test("claims the count of every key in the namespace, never a count over a range a command names", () => {
    // A count over a named range or prefix is refused before the network, so the rail may not offer it.
    expect(posture.body).not.toMatch(/keys in a range a command names|a range holding more than/);
    expect(posture.body).toContain("the count of every key in the namespace, never their names");
    expect(posture.body).toContain(`a namespace holding more than ${rows} keys is refused rather than counted in part`);
  });
});

describe("the posture on RabbitMQ", () => {
  const posture = agentPosture({ mode: "agent", engine: "rabbitmq", engineLabel: "RabbitMQ", handover: false });

  test("names exactly what the agent reads: each message's offset and body size, never a value", () => {
    expect(posture.qualifier).toBe(
      `metadata only, ${STATEMENT_BUDGETS.maxResultRows} rows and ${STATEMENT_BUDGETS.statementTimeoutMs / 1000} s per read, over a client that cannot take a message`,
    );
    expect(posture.body).toContain(
      "answers each message's offset and body size, never its body, headers, properties or routing key",
    );
    expect(posture.body).toContain("refuses a classic or quorum queue before any frame");
    expect(posture.body).not.toMatch(/payload|headers are shown|message cells/);
  });
});

describe("the posture on Apache Kafka", () => {
  const posture = agentPosture({ mode: "agent", engine: "kafka", engineLabel: "Apache Kafka", handover: false });

  test("names exactly what the agent reads: names, counts and offsets, never a record or a broker address", () => {
    expect(posture.qualifier).toBe(
      `metadata only, ${STATEMENT_BUDGETS.maxResultRows} rows and ${STATEMENT_BUDGETS.statementTimeoutMs / 1000} s per read, over a client that holds only Metadata and ListOffsets`,
    );
    expect(posture.body).toContain(
      "never a record's key, value, headers or timestamp, a broker's host and port, a config, a log directory or a consumer group",
    );
    expect(posture.body).toContain("An offset span is reported as a span, never as a message count.");
    expect(posture.body).toContain("sent with topic auto-creation off");
    expect(posture.body).not.toMatch(/message cells|values are shown|reads records/);
  });
});

describe("the posture on S3-compatible object storage", () => {
  const posture = agentPosture({
    mode: "agent",
    engine: "s3",
    engineLabel: "S3-compatible object storage",
    handover: false,
  });

  test("names exactly what the agent reads: bucket metadata, totals and named objects, never a key or a value", () => {
    expect(posture.qualifier).toBe(
      `metadata only, ${STATEMENT_BUDGETS.maxResultRows} rows and ${STATEMENT_BUDGETS.statementTimeoutMs / 1000} s per read, over a client that holds only GET and HEAD reads of bucket metadata`,
    );
    expect(posture.body).toContain(
      "never an object key it was not given, a body, user metadata, a tag, an ETag, a version id, an owner, an ACL, a policy or the endpoint",
    );
    expect(posture.body).toContain("A bucket is counted whole and never by prefix");
    expect(posture.body).not.toMatch(/lists keys|previews|object contents are shown/);
  });
});

describe("autoExecuteTerms", () => {
  // No default: a caller that names no language would be shown SQL's terms on whatever engine it is on, SQL's
  // read-only session included, on an engine that has none.
  test("takes the language it states, with no default", () => {
    // @ts-expect-error: the language is required, so this call does not compile
    expect(() => autoExecuteTerms("data-analysis")).toThrow();
  });

  test("names the run's own bounds and the editor's, for every workflow", () => {
    for (const workflowType of WORKFLOW_TYPES) {
      const budgets = AGENT_WORKFLOW_BUDGETS[workflowType].policy.budgets;
      const terms = autoExecuteTerms(workflowType, "sql");

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
      expect(autoExecuteTerms(workflowType, "sql")).toBe(
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
        engine: "trino",
        engineLabel: getDBConfig("trino").label,
        handover: false,
      });

      expect(blocked.body).toContain("boundary it declares: PostgreSQL, SQLite and MySQL.");
      expect(withThree({ mode: "agent", engine: "mysql", engineLabel: "MySQL", handover: false }).tone).toBe("reads");
    } finally {
      mock.module("@/lib/agent/engine-support", () => ({ AGENT_EXECUTION_ENGINES: real, namedList }));
    }
  });

  test("whether an engine executes is the manifest's answer: an engine with a statement language reads", async () => {
    // Captured as a plain object before the substitution: the namespace itself follows the replacement.
    const real = { ...manifest };
    try {
      mock.module("@/lib/agent/agent-manifest", () => ({
        ...real,
        AGENT_STATEMENT_LANGUAGE: { ...real.AGENT_STATEMENT_LANGUAGE, mongodb: "sql", postgres: null },
      }));
      const { agentPosture: fromManifest } = await import("@/lib/agent/posture");

      expect(fromManifest({ mode: "agent", engine: "mongodb", engineLabel: "MongoDB", handover: false }).tone).toBe(
        "reads",
      );
      expect(
        fromManifest({ mode: "agent", engine: "postgres", engineLabel: "PostgreSQL", handover: false }).headline,
      ).toBe("Cannot execute on PostgreSQL");
      // No connection is still no engine, whatever the manifest holds: it reads as unresolved, not as SQL.
      expect(fromManifest({ mode: "agent", engine: null, engineLabel: "", handover: false }).headline).toBe(
        "Cannot execute yet",
      );
    } finally {
      mock.module("@/lib/agent/agent-manifest", () => real);
    }
  });

  test("the list is read per call, so nothing in the copy is frozen at module load", () => {
    expect(agentPosture({ mode: "agent", engine: "trino", engineLabel: "Trino", handover: false }).body).toContain(
      `boundary it declares: ${EXECUTION_ENGINE_NAMES}.`,
    );
  });
});

describe("a connection whose last run was refused for the connection itself", () => {
  const refusal =
    "The credential this run would execute as, a database user or a token, holds privileges the read-only boundary cannot contain.";

  test("is blocked in agent mode, in the refusal's own words, and says what still runs", () => {
    const posture = agentPosture({
      mode: "agent",
      engine: "mongodb",
      engineLabel: getDBConfig("mongodb").label,
      handover: false,
      refusedHere: refusal,
    });
    expect(posture.tone).toBe("blocked");
    expect(posture.headline).toBe("Refused on this connection");
    expect(posture.qualifier).toContain("plan mode drafts here");
    expect(posture.title).toContain("MongoDB");
    expect(posture.body).toStartWith(refusal);
  });

  test("leaves plan mode, an unsupported engine and a connection with no refusal as they were", () => {
    const base = { engine: "mongodb" as const, engineLabel: "MongoDB", handover: false };
    expect(agentPosture({ ...base, mode: "planning", refusedHere: refusal }).tone).toBe("safe");
    expect(agentPosture({ ...base, mode: "agent", refusedHere: null }).headline).toBe("Reads only");
    expect(
      agentPosture({
        mode: "agent",
        engine: "trino",
        engineLabel: "Trino",
        handover: false,
        refusedHere: refusal,
      }).headline,
    ).toContain("Trino");
  });
});
