import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionBudget, ExecutionUsage } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import {
  type ExecutionActor,
  type ExecutionPolicy,
  type PolicyDenyCode,
  type PolicyEvaluationParams,
  createTargetScope,
  evaluateOperation,
  executeWithPolicy,
} from "@/lib/db/operations/policy";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import type { ProviderCapabilities, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Threat: an agent (or anything that reaches the agent path) submits SQL crafted
 * to write, to change schema, to touch a second database, to load code, or to
 * run the executing form of EXPLAIN — using obfuscation to get past whatever
 * inspects the text.
 *
 * Every case is asserted on BOTH layers, because they fail differently:
 *
 * (a) the policy pipeline denies it at the input stage with a reason code and
 *     the provider is never invoked. This layer is DEFENSE IN DEPTH — it reads
 *     SQL, so it can be wrong.
 * (b) the same statement is driven STRAIGHT AT the read-only profile, as if (a)
 *     had been bypassed entirely, and the database itself refuses it. This is
 *     the load-bearing assertion (#328): a case that only asserts (a) is not a
 *     security test.
 *
 * The (b) side runs against a real SQLite file (bun:sqlite, in-process, no
 * mocks). PostgreSQL's engine-level half lives in
 * tests/integration/db/postgres-provider.test.ts, where the pg driver mock is,
 * and SQLite's provider-specific plumbing (ATTACH containment, adapter contract)
 * in tests/integration/db/sqlite-provider.test.ts, per the provider triad rule.
 *
 * The fixtures are chosen so that nothing here can pass by keyword matching:
 * the legitimate control statements mention write keywords inside literals,
 * identifiers and comments, and the hostile ones hide the write behind
 * comments, CTEs, function calls and statement terminators.
 */

/**
 * One scratch directory for the whole file, created at import time so the
 * hostile corpus below can name paths INSIDE it: a statement that writes
 * elsewhere then leaves evidence where this suite can see it.
 */
const SCRATCH = mkdtempSync(join(tmpdir(), "libredb-agent-security-"));
const TARGET_DB = join(SCRATCH, "target.db");
/** Paths the corpus tries to create. Nothing may ever exist at them. */
const ATTACK_PATHS = [join(SCRATCH, "attached.db"), join(SCRATCH, "copied.txt"), join(SCRATCH, "extension.so")];

// ─── Layer (a): the policy pipeline ─────────────────────────────────────────

const budgets: ExecutionBudget = {
  maxConcurrentExecutions: 2,
  maxStatementsPerRun: 50,
  maxTotalRunMs: 60_000,
  statementTimeoutMs: 5_000,
  maxResultRows: 1_000,
  maxResultBytes: 1_048_576,
};

const policy: ExecutionPolicy = {
  version: "agent-m1.security",
  maxRiskClass: 1,
  allowedRoles: ["admin", "user"],
  allowedModes: ["agent"],
  budgets,
};

const actor: ExecutionActor = { sessionId: "session-security", role: "user", mode: "agent" };

const capabilities: ProviderCapabilities = {
  queryLanguage: "sql",
  supportsExplain: true,
  explainFormat: "sqlite-queryplan",
  supportsExternalQueryLimiting: true,
  supportsCreateTable: true,
  supportsInlineRowEdit: true,
  supportsMaintenance: true,
  maintenanceOperations: [],
  supportsConnectionString: false,
  defaultPort: null,
  schemaRefreshPattern: "manual",
};

const idleUsage: ExecutionUsage = { activeExecutions: 0, executedStatements: 0, totalElapsedMs: 0 };

function pipelineParams(operationId: string, sql: string): PolicyEvaluationParams {
  return {
    registry: createCanonicalOperationRegistry(),
    policy,
    actor,
    scope: createTargetScope("conn-security"),
    request: { operationId, target: {}, input: { sql } },
    capabilities,
    usage: idleUsage,
  };
}

/** Denies with `expected` AND proves the provider callback was never reached. */
async function expectPipelineDeny(operationId: string, sql: string, expected: PolicyDenyCode): Promise<void> {
  const decision = evaluateOperation(pipelineParams(operationId, sql));
  expect(decision.kind).toBe("deny");
  if (decision.kind === "deny") expect(decision.reasonCode).toBe(expected);

  let invocations = 0;
  const outcome = await executeWithPolicy(pipelineParams(operationId, sql), async () => {
    invocations++;
    return "executed";
  });
  expect(invocations).toBe(0);
  expect(outcome.decision.kind).toBe("deny");
}

// ─── The attack corpus, shared by both layers ───────────────────────────────

/**
 * How SQLite's own enforcement answers a statement that reached the profile
 * with classification bypassed:
 *
 * - `rejected` — the engine refuses it outright;
 * - `first-statement-only` — `prepare()` compiles one statement, so the tail
 *   never runs (silent truncation is not a pass on its own, which is why the
 *   same input is denied at the input stage above).
 */
type EngineOutcome = "rejected" | "first-statement-only";

interface Attack {
  readonly label: string;
  readonly sql: string;
  readonly deny: PolicyDenyCode;
  /** Absent when the construct is PostgreSQL-only (asserted in the pg suite). */
  readonly sqlite?: EngineOutcome;
}

const ATTACKS: readonly Attack[] = [
  {
    label: "a write hidden behind a block comment",
    sql: "/* SELECT */ INSERT INTO t (id, v) VALUES (2, 'obfuscated')",
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "rejected",
  },
  {
    label: "a write hidden behind a line comment and newlines",
    sql: "\n\t-- SELECT id FROM t\n   UPDATE t SET v = 'obfuscated'\n",
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "rejected",
  },
  {
    label: "a data-modifying CTE",
    sql: "WITH src AS (SELECT 2 AS id) INSERT INTO t (id, v) SELECT id, 'cte' FROM src",
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "rejected",
  },
  {
    label: "a nested CTE whose inner element writes",
    sql: "WITH outer_cte AS (WITH inner_cte AS (SELECT 2 AS id) SELECT id FROM inner_cte) DELETE FROM t WHERE id IN (SELECT id FROM outer_cte)",
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "rejected",
  },
  {
    label: "multi-statement input smuggling a write after a legitimate read",
    sql: "SELECT id FROM t; INSERT INTO t (id, v) VALUES (2, 'tail')",
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "first-statement-only",
  },
  {
    label: "a mutating pragma",
    sql: "PRAGMA user_version = 42",
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "rejected",
  },
  {
    // A journal-mode CHANGE, not a restatement: setting the mode a database is
    // already in is a no-op the engine answers with the current value, so a test
    // that used the current mode would prove nothing. The seeded database is in
    // WAL (the shared editor path sets it at open), hence DELETE here.
    label: "a journal-mode change",
    sql: "PRAGMA journal_mode = DELETE",
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "rejected",
  },
  {
    label: "attaching a second database that does not exist yet",
    sql: `ATTACH DATABASE '${ATTACK_PATHS[0]}' AS stolen`,
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "rejected",
  },
  {
    label: "detaching the target database",
    sql: "DETACH DATABASE main",
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "rejected",
  },
  {
    label: "loading an extension through a function call",
    sql: `SELECT load_extension('${ATTACK_PATHS[2]}')`,
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "rejected",
  },
  {
    label: "a temp table used as writable scratch space",
    sql: "CREATE TEMP TABLE scratch (id INTEGER)",
    deny: "INPUT_VALIDATION_FAILED",
    sqlite: "rejected",
  },
  {
    label: "a server-side file write (PostgreSQL COPY)",
    sql: `COPY (SELECT v FROM t) TO '${ATTACK_PATHS[1]}'`,
    deny: "INPUT_VALIDATION_FAILED",
  },
  {
    label: "a server-side program execution (PostgreSQL COPY TO PROGRAM)",
    sql: "COPY (SELECT v FROM t) TO PROGRAM 'sh -c id'",
    deny: "INPUT_VALIDATION_FAILED",
  },
  {
    label: "an attempt to leave the read-only transaction",
    sql: "SET TRANSACTION READ WRITE",
    deny: "INPUT_VALIDATION_FAILED",
  },
];

/** Reads that MENTION write keywords where the statement does not execute them. */
const LEGITIMATE_READS: readonly string[] = [
  "SELECT id, v FROM t ORDER BY id",
  "SELECT 'insert into t values (1)' AS note, id FROM t",
  "SELECT id FROM t -- delete from t\n",
  "WITH recent AS (SELECT id, v FROM t) SELECT * FROM recent",
];

describe("agent statement boundary — layer (a): the policy pipeline denies before the provider is reached", () => {
  test.each(ATTACKS.map((attack) => [attack.label, attack] as const))("denies %s", async (_label, attack) => {
    await expectPipelineDeny("sql.query.read", attack.sql, attack.deny);
  });

  test.each([...LEGITIMATE_READS])("allows the legitimate read %#, which merely mentions write keywords", (sql) => {
    const decision = evaluateOperation(pipelineParams("sql.query.read", sql));
    expect(decision.kind).toBe("allow");
  });
});

describe("agent statement boundary — plan execution cannot be reached by aliasing or obfuscation", () => {
  test.each([
    ["SQL.EXPLAIN.ANALYZE", "AMBIGUOUS_OPERATION"],
    [" sql.explain.analyze ", "AMBIGUOUS_OPERATION"],
    ["sql.explain.analyse", "UNKNOWN_OPERATION"],
    ["sql_explain_analyze", "UNKNOWN_OPERATION"],
  ] as const)("denies the aliased operation id %s", async (operationId, expected) => {
    await expectPipelineDeny(operationId, "SELECT 1", expected);
  });

  test.each([
    "EXPLAIN ANALYZE SELECT id FROM t",
    "EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM t",
    "EXPLAIN /* plan */ ANALYZE SELECT id FROM t",
    // PostgreSQL accepts ANALYSE as a full synonym and it executes the
    // statement, so a single-spelling check would launder plan execution
    // through this risk-class-0, approval-free descriptor.
    "EXPLAIN ANALYSE SELECT id FROM t",
    "EXPLAIN (ANALYSE, BUFFERS) SELECT id FROM t",
  ])("denies plan EXECUTION requested through the plan-inspection descriptor: %s", async (sql) => {
    await expectPipelineDeny("sql.explain.estimate", sql, "INPUT_VALIDATION_FAILED");
  });

  test("the plan-execution descriptor itself can only ever reach require-approval", () => {
    const decision = evaluateOperation(pipelineParams("sql.explain.analyze", "EXPLAIN ANALYZE SELECT id FROM t"));
    expect(decision.kind).toBe("require-approval");
    if (decision.kind === "require-approval") expect(decision.reasonCode).toBe("APPROVAL_REQUIRED");
  });

  test("a write carried by an approved plan execution is still denied at the input stage", async () => {
    await expectPipelineDeny(
      "sql.explain.analyze",
      "EXPLAIN ANALYZE WITH w AS (INSERT INTO t (id, v) VALUES (2, 'x') RETURNING id) SELECT * FROM w",
      "INPUT_VALIDATION_FAILED",
    );
  });
});

// ─── Layer (b): the database itself, with classification bypassed ────────────

const AGENT_BUDGET: ReadOnlyStatementBudget = {
  statementTimeoutMs: 5_000,
  maxResultRows: 100,
  maxResultBytes: 1_000_000,
};

describe("agent statement boundary — layer (b): SQLite refuses the same statements with the pipeline bypassed", () => {
  let profile: SQLiteProvider;

  function config(database: string): DatabaseConnection {
    return { id: "conn-security", name: "Security SQLite", type: "sqlite", database, createdAt: new Date() };
  }

  async function tableState(): Promise<Record<string, unknown>[]> {
    const reader = new SQLiteProvider(config(TARGET_DB));
    await reader.connect();
    try {
      return (await reader.query("SELECT id, v FROM t ORDER BY id")).rows;
    } finally {
      await reader.disconnect();
    }
  }

  beforeAll(async () => {
    const seed = new SQLiteProvider(config(TARGET_DB));
    await seed.connect();
    await seed.query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await seed.query("INSERT INTO t (id, v) VALUES (1, 'seeded')");
    await seed.disconnect();

    profile = new SQLiteProvider(config(TARGET_DB), {}, { readOnly: true });
    await profile.connect();
  });

  afterAll(async () => {
    if (profile?.isConnected()) await profile.disconnect();
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  const sqliteAttacks = ATTACKS.filter((attack) => attack.sqlite !== undefined);

  test.each(sqliteAttacks.map((attack) => [attack.label, attack] as const))(
    "the engine — not a parser — refuses %s",
    async (_label, attack) => {
      const before = await tableState();

      if (attack.sqlite === "rejected") {
        await expect(profile.queryReadOnly(attack.sql, AGENT_BUDGET)).rejects.toThrow();
      } else {
        // Only the leading statement is compiled; the smuggled tail never runs.
        const result = await profile.queryReadOnly(attack.sql, AGENT_BUDGET);
        expect(result.rows).toEqual([{ id: 1 }]);
      }

      expect(await tableState()).toEqual(before);
    },
  );

  test("a pragma function cannot turn query_only off for a later statement", async () => {
    // The setter form is refused by this build, and the profile re-asserts the
    // pragma before every statement regardless — so neither the disable nor a
    // write behind it can survive into the next call.
    await expect(profile.queryReadOnly("SELECT * FROM pragma_query_only(0)", AGENT_BUDGET)).rejects.toThrow();

    expect((await profile.queryReadOnly("PRAGMA query_only", AGENT_BUDGET)).rows).toEqual([{ query_only: 1 }]);
    await expect(profile.queryReadOnly("INSERT INTO t (id, v) VALUES (3, 'after')", AGENT_BUDGET)).rejects.toThrow();
  });

  test("legitimate reads still work through the profile after the whole hostile corpus", async () => {
    for (const sql of LEGITIMATE_READS) {
      const result = await profile.queryReadOnly(sql, AGENT_BUDGET);
      expect(result.rows.length).toBeGreaterThan(0);
    }
  });

  test("nothing was written anywhere else in the scratch directory", async () => {
    // The T4 lesson generalized: a read-only open protects the file it opened,
    // not the filesystem. The corpus above names paths inside this directory for
    // the statements that write ELSEWHERE (ATTACH of a new database, extension
    // load, both COPY forms), so their evidence would land here.
    for (const attacked of ATTACK_PATHS) {
      expect(existsSync(attacked)).toBe(false);
    }
    // Only the target database and its own journal sidecars may exist. Sizes are
    // not asserted: a writable reader legitimately churns the WAL files.
    const unexpected = readdirSync(SCRATCH).filter((name) => !name.startsWith("target.db"));
    expect(unexpected).toEqual([]);
    expect(await tableState()).toEqual([{ id: 1, v: "seeded" }]);
  });
});
