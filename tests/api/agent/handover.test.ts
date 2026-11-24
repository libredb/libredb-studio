/**
 * Replaying the answer a run handed to the editor (#373 review).
 *
 * The security finding this route exists to answer: the hand-over used to reach the
 * ORDINARY editor route, a plain read-write session whose only protection was a
 * syntactic check. The agent's own read is bounded by the ENGINE — `BEGIN READ ONLY`
 * on PostgreSQL, `PRAGMA query_only` on SQLite — so the same statement text could be
 * harmless where the run proved it and harmful where it was replayed.
 *
 * What this file pins is the whole of the new boundary, and each test is one half of
 * a sentence that would otherwise be a promise:
 *
 *  - The statement is the LEDGER's. The request carries none, so nothing a user types
 *    can reach this profile and there is no "run this read-only" endpoint here.
 *  - The connection is the LEDGER's too, resolved server-side under the run's own
 *    persisted actor.
 *  - The gate's outcome is honoured: only an answer the run recorded as
 *    `auto-executed` is replayed.
 *  - It runs through `queryReadOnly` under `agent-handover`, never `query()`, and
 *    with the budget the checkbox names.
 */

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { configureAgentModel, restoreAgentModel } from "../../helpers/agent-model-env";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { AGENT_HANDOVER_BUDGET, AGENT_HANDOVER_READ_ALLOWANCE } from "@/lib/agent/execution-policy";
import { byteBudgetSentence, rowBudgetSentence, TIME_BUDGET_PREFIX } from "@/lib/db/read-only-budget";
import { MSSQL_CUT_VALUE_PREFIX, MSSQL_SERIALISED_PREFIX } from "@/lib/sql/mssql-read-only-refusals";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import {
  AuthenticationError,
  ByteBudgetRefusal,
  ConnectionError,
  CutValueRefusal,
  ExecutionProfileError,
  QueryError,
  RefusedBeforeSendError,
  RowBudgetRefusal,
  SerialisedResultRefusal,
  TimeBudgetRefusal,
} from "@/lib/db/errors";
import { PROVIDER_TEXT_WITHHELD, withheldErrorMessage } from "@/lib/db/operations/provider-text";
import { secretForms } from "@/lib/db/utils/server-text";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { logger } from "@/lib/logger";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { filterByRoles } from "@/lib/seed/connection-filter";
import { seedRolesOf } from "@/lib/seed/roles";
import type { SeedConnection } from "@/lib/seed/types";
import * as realAuth from "@/lib/auth";
import type { DatabaseType } from "@/lib/types";

const ANSWER_SQL = "SELECT region, SUM(net_total) AS net_total FROM orders GROUP BY region";

const RESULT = {
  rows: [
    { region: "north", net_total: 120 },
    { region: "south", net_total: 90 },
  ],
  fields: ["region", "net_total"],
  rowCount: 2,
  executionTime: 14,
};

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "ada" }),
);

function answerEvent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "answer-composed",
    atMs: 3,
    sql: ANSWER_SQL,
    artifact: {
      correlationId: "corr-answer",
      runId: "arun_1",
      operationId: "sql.query.read",
      summary: { rowCount: 2, columnNames: ["region", "net_total"], elapsedMs: 11 },
    },
    presentation: { kind: "table" },
    handover: "auto-executed",
    ...overrides,
  };
}

function fakeRun(events: unknown[] = [answerEvent()]) {
  return {
    runId: "arun_1",
    mode: "agent",
    workflowType: "data-analysis",
    status: "succeeded",
    autoExecute: true,
    actor: { sessionId: "ada", role: "user" },
    connectionId: "seed:sales",
    objective: "which region sells most",
    events: [{ kind: "run-started", atMs: 1, mode: "agent" }, ...events],
  };
}

let runs: Map<string, ReturnType<typeof fakeRun>>;

/**
 * The real connect budgets, with `connectBudgetFor` answering `budgetOverride` while a case sets one, so the case that
 * needs an open's deadline to pass sets it to a few tens of milliseconds for itself.
 */
const realConnectBudget = await import("@/lib/db/connect-budget");
// Taken before the module is replaced, since a replaced module's namespace answers the replacement.
const realConnectBudgetFor = realConnectBudget.connectBudgetFor;
const realOpenDeadlineSentence = realConnectBudget.openDeadlineSentence;
let budgetOverride: number | undefined;

const mockStatus = mock(async (runId: string) => {
  const record = runs.get(runId);
  return record === undefined ? null : { record, cancellationRequested: false };
});

const SEED_CONNECTION = { id: "seed:sales", name: "Sales", type: "postgres" };

type ProfiledProvider = { queryReadOnly?: typeof mockQueryReadOnly; query: typeof mockQuery };

const mockResolveConnection = mock(
  async (_body: { connectionId?: string }, _session: { role: string; username: string }) => SEED_CONNECTION,
);
const mockQueryReadOnly = mock(async (_sql: string, _budget: ReadOnlyStatementBudget) => RESULT);
const mockQuery = mock(async (_sql: string) => RESULT);
const mockAcquire = mock<
  (
    connection: unknown,
    profile: string,
    options?: unknown,
    requester?: unknown,
    wait?: { readonly signal: AbortSignal },
  ) => Promise<ProfiledProvider>
>(async () => ({
  queryReadOnly: mockQueryReadOnly,
  query: mockQuery,
}));

function installMocks(): void {
  mock.module("@/lib/auth", () => ({
    ...realAuth,
    getSession: mockGetSession,
    readSession: mock(async () => {
      const s = await mockGetSession();
      return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
    }),
  }));
  mock.module("@/lib/agent/runtime", () => ({
    getAgentRunService: mock(async () => ({ status: mockStatus })),
    driveAgentRun: mock(async () => ({ runId: "arun_1", status: "succeeded" })),
    readAgentArtifact: mock(() => undefined),
  }));
  mock.module("@/lib/seed/resolve-connection", () => ({
    resolveConnection: mockResolveConnection,
    SeedConnectionError: class SeedConnectionError extends Error {
      constructor(
        message: string,
        public statusCode: number,
      ) {
        super(message);
        this.name = "SeedConnectionError";
      }
    },
  }));
  mock.module("@/lib/db/factory", () => ({ acquireExecutionProfileProvider: mockAcquire }));
  mock.module("@/lib/db/connect-budget", () => ({
    openDeadlineSentence: realOpenDeadlineSentence,
    connectBudgetFor: (type: DatabaseType) => budgetOverride ?? realConnectBudgetFor(type),
  }));
}

installMocks();

const { POST } = await import("@/app/api/agent/runs/[runId]/handover/route");

function params(runId = "arun_1") {
  return { params: Promise.resolve({ runId }) };
}

function request(runId = "arun_1", body?: unknown): Request {
  return createMockRequest(`/api/agent/runs/${runId}/handover`, { method: "POST", ...(body ? { body } : {}) });
}

beforeEach(() => {
  installMocks();
  budgetOverride = undefined;
  clearRateLimitState();
  runs = new Map([["arun_1", fakeRun()]]);
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  mockResolveConnection.mockClear();
  mockAcquire.mockClear();
  mockQueryReadOnly.mockClear();
  mockQuery.mockClear();
  mockQueryReadOnly.mockResolvedValue(RESULT);
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
});

afterEach(() => {
  restoreAgentModel();
});

/** An acquisition that never opens: only its caller's own wait ends it, as `openOnce` ends a caller's wait. */
function openNeverSettles(reached: () => void) {
  mockAcquire.mockImplementationOnce(async (...args) => {
    const wait = args[4];
    reached();
    return new Promise((_resolve, reject) => {
      wait?.signal.addEventListener("abort", () => reject(wait.signal.reason), { once: true });
    });
  });
}

describe("the hand-over's open", () => {
  test("a hand-over whose client leaves while its provider opens answers 499 not-sent and never reads", async () => {
    const opening = Promise.withResolvers<void>();
    openNeverSettles(opening.resolve);
    const controller = new AbortController();
    const answer = POST(
      new Request("http://localhost:3000/api/agent/runs/arun_1/handover", {
        method: "POST",
        signal: controller.signal,
      }),
      params(),
    );
    await opening.promise;
    controller.abort();

    const res = await answer;
    const body = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(499);
    expect(body).toMatchObject({ code: "QUERY_CANCELLED", kind: "cancelled", outcome: "not-sent" });
    expect(mockAcquire.mock.calls[0]).toHaveLength(5);
    expect(mockAcquire.mock.calls[0]?.[4]?.signal).toBeInstanceOf(AbortSignal);
    expect(mockQueryReadOnly).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("a hand-over whose open outlasts its engine's connect budget answers 504 studio-timeout-refusal not-sent", async () => {
    budgetOverride = 40;
    openNeverSettles(() => {});

    const res = await POST(request(), params());
    const body = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(504);
    expect(body).toMatchObject({
      error: "The connection did not open within 0.1 seconds, so Studio stopped waiting for it and sent nothing.",
      kind: "studio-timeout-refusal",
      outcome: "not-sent",
    });
    expect(mockQueryReadOnly).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent/runs/[runId]/handover", () => {
  test("runs the ledger's statement and hands the rows back", async () => {
    const res = await POST(request(), params());
    const body = await parseResponseJSON<{ runId: string; sql: string; result: typeof RESULT }>(res);

    expect(res.status).toBe(200);
    expect(body.runId).toBe("arun_1");
    // Echoed so the surface that renders the rows can show the text that produced
    // them, rather than its own copy of what it believes the run said.
    expect(body.sql).toBe(ANSWER_SQL);
    expect(body.result.rows).toEqual(RESULT.rows);
  });

  // The editor grid this feeds would otherwise show NULL for a stored NaN, as on `/api/db/query`.
  test("hands back NaN and the infinities as words, not as null", async () => {
    mockQueryReadOnly.mockResolvedValue({
      ...RESULT,
      rows: [{ f: Number.NaN, r: Number.POSITIVE_INFINITY, n: Number.NEGATIVE_INFINITY, z: null }] as never,
    });

    const res = await POST(request(), params());
    const body = await parseResponseJSON<{ result: { rows: unknown[] } }>(res);

    expect(res.status).toBe(200);
    expect(body.result.rows).toEqual([{ f: "NaN", r: "Infinity", n: "-Infinity", z: null }]);
  });

  test("the statement comes from the run, never from the request", async () => {
    // The whole reason this is a run-scoped route rather than a read-only `/query`:
    // a body naming its own SQL is a general "run this without a timeout" endpoint,
    // which is a smaller hole than the old one but still a new one.
    const res = await POST(request("arun_1", { sql: "SELECT pg_sleep(600)" }), params());

    expect(res.status).toBe(200);
    expect(mockQueryReadOnly.mock.calls[0][0]).toBe(ANSWER_SQL);
  });

  test("it executes through the read-only path under the hand-over profile, never query()", async () => {
    await POST(request(), params());

    expect(mockAcquire.mock.calls[0][1]).toBe("agent-handover");
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryReadOnly).toHaveBeenCalledTimes(1);
  });

  test("the budget it runs under is the one the checkbox names", async () => {
    await POST(request(), params());

    const budget = mockQueryReadOnly.mock.calls[0][1];
    // The caps the checkbox names; the replay's own read allowance rides beside them.
    expect({
      statementTimeoutMs: budget.statementTimeoutMs,
      maxResultRows: budget.maxResultRows,
      maxResultBytes: budget.maxResultBytes,
    }).toEqual(AGENT_HANDOVER_BUDGET);
    expect(budget.maxResultRows).toBe(500);
    // "No time limit", as far as a positive-integer field can express it.
    expect(budget.statementTimeoutMs).toBe(2_147_483_647);
  });

  test("each replay carries a read allowance of its own, so an engine that bills its reads can bound it", async () => {
    await POST(request(), params());
    await POST(request(), params());

    const first = mockQueryReadOnly.mock.calls[0][1].readAllowance;
    const second = mockQueryReadOnly.mock.calls[1][1].readAllowance;
    expect(first).toBeInstanceOf(RunReadAllowance);
    expect(first?.limit).toBe(AGENT_HANDOVER_READ_ALLOWANCE);
    expect(first?.remaining()).toBe(AGENT_HANDOVER_READ_ALLOWANCE);
    expect(second).not.toBe(first);
    // The frozen budget itself never carries one, so no two replays can share it.
    expect(AGENT_HANDOVER_BUDGET.readAllowance).toBeUndefined();
  });

  test("the connection is the run's own, resolved under the run's persisted actor", async () => {
    // Not the connection the browser is on: the run read its rows from the one it was
    // opened on, and a request that could name another is a request that could run
    // the approved statement against a database the run never saw.
    await POST(request(), params());

    expect(mockResolveConnection).toHaveBeenCalledWith(
      { connectionId: "seed:sales" },
      { role: "user", username: "ada" },
    );
    expect(mockAcquire.mock.calls[0][0]).toEqual(SEED_CONNECTION);
  });

  test("a run on a server-level connection hands over in the database it read (#1530)", async () => {
    runs.set("arun_1", { ...fakeRun(), catalog: "shop" } as ReturnType<typeof fakeRun>);
    const response = await POST(request(), params());

    expect(mockAcquire.mock.calls[0][0]).toEqual({ ...SEED_CONNECTION, database: "shop" });
    expect((await response.json()).catalog).toBe("shop");
  });

  test("the run's persisted actor decides the file-access posture of the hand-over handle", async () => {
    // As it decides the connection above: SQLite opens only for a trusted requester, on this
    // profile as in the editor, so the route passes the posture the editor would derive for the
    // run's own actor, never a constant and never the replaying browser's.
    await POST(request(), params());
    expect(mockAcquire.mock.calls[0][3]).toEqual({ allowExternalFileAccess: false });

    mockAcquire.mockClear();
    runs.set("arun_1", { ...fakeRun(), actor: { sessionId: "ada", role: "admin" } });
    await POST(request(), params());
    expect(mockAcquire.mock.calls[0][3]).toEqual({ allowExternalFileAccess: true });
  });

  test("an admin's run on a seed offered to admin and user hands over under the posture a user's run gets", async () => {
    // `resolveConnection` hands the route the run actor's own copy of the seed, which names only the roles that actor
    // holds, so an admin's copy of a seed offered to ["admin", "user"] reads ["admin"]. The posture is still the one the
    // operator's roles decide (docs/providers/duckdb.md 3.16), so every actor of that seed hands over on one handle.
    const warehouse = (roles: string[]): SeedConnection => ({
      id: "warehouse",
      name: "Warehouse",
      type: "duckdb",
      database: "/srv/data/warehouse.duckdb",
      roles,
    });
    async function handoverPosture(role: string, roles: string[]): Promise<unknown> {
      const [copy] = filterByRoles([warehouse(roles)], seedRolesOf({ role }));
      if (copy === undefined) throw new Error(`a ${role} run cannot resolve a seed offered to ${roles.join(", ")}`);
      mockResolveConnection.mockResolvedValue(copy);
      runs.set("arun_1", { ...fakeRun(), actor: { sessionId: "ada", role }, connectionId: "seed:warehouse" });
      mockAcquire.mockClear();
      await POST(request(), params());
      return mockAcquire.mock.calls[0]?.[3];
    }

    try {
      expect(await handoverPosture("admin", ["admin", "user"])).toEqual({ allowExternalFileAccess: false });
      expect(await handoverPosture("user", ["admin", "user"])).toEqual({ allowExternalFileAccess: false });
      expect(await handoverPosture("admin", ["admin"])).toEqual({ allowExternalFileAccess: true });
    } finally {
      mockResolveConnection.mockResolvedValue(SEED_CONNECTION);
    }
  });

  test("a run whose gate declined is refused, and told so", async () => {
    runs.set("arun_1", fakeRun([answerEvent({ handover: "applied", handoverWarning: "the plan reads as expensive" })]));

    const res = await POST(request(), params());
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(409);
    expect(body.error).toContain("did not hand this statement over");
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  test("a run that was never opened with auto-execute is refused the same way", async () => {
    runs.set("arun_1", fakeRun([answerEvent({ handover: "none" })]));

    const res = await POST(request(), params());

    expect(res.status).toBe(409);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  test("a Kubernetes run's answer, recorded with no hand-over, is never replayed on the cluster", async () => {
    // Every kubectl variant refuses auto-execute, so its answer is recorded `none`. The route must
    // refuse it on that record alone, before it resolves the cluster or reaches its read path.
    mockResolveConnection.mockResolvedValue({ id: "seed:cluster", name: "Cluster", type: "kubernetes" });
    try {
      runs.set("arun_1", {
        ...fakeRun([
          answerEvent({
            sql: "get pods -n shop",
            handover: "none",
            artifact: {
              correlationId: "corr-answer",
              runId: "arun_1",
              operationId: "kubectl.query.read",
              summary: { rowCount: 2, columnNames: ["NAME", "STATUS"], elapsedMs: 4 },
            },
          }),
        ]),
        autoExecute: false,
        connectionId: "seed:cluster",
      });

      const res = await POST(request(), params());

      expect(res.status).toBe(409);
      expect(mockQueryReadOnly).not.toHaveBeenCalled();
      expect(mockAcquire).not.toHaveBeenCalled();
    } finally {
      mockResolveConnection.mockResolvedValue(SEED_CONNECTION);
    }
  });

  test("a run that composed no answer has nothing to replay", async () => {
    runs.set("arun_1", fakeRun([]));

    const res = await POST(request(), params());

    expect(res.status).toBe(404);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  test("another session cannot replay the statement, and is not told the run exists", async () => {
    mockGetSession.mockResolvedValue({ role: "user", username: "grace" });

    const res = await POST(request(), params());

    expect(res.status).toBe(404);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  test("an admin is not exempt", async () => {
    mockGetSession.mockResolvedValue({ role: "admin", username: "root" });

    const res = await POST(request(), params());

    expect(res.status).toBe(404);
  });

  test("an unauthenticated caller is refused", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(request(), params());

    expect(res.status).toBe(401);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  test("the surface does not exist once the operator switches the agent off", async () => {
    process.env[AGENT_ENABLED_ENV] = "false";

    const res = await POST(request(), params());

    expect(res.status).toBe(404);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  test("a provider with no read-only statement path is a server fault, not a fallback", async () => {
    // The failure this must never answer by calling `query()`: an acquirer that
    // handed back a writable provider would put the statement on exactly the path
    // this route exists to leave.
    mockAcquire.mockResolvedValueOnce({ query: mockQuery });

    const res = await POST(request(), params());

    expect(res.status).toBe(500);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("refuses to replay on an engine the review record does not list, naming it, and never calls queryReadOnly", async () => {
    // Whatever acquirer hands the provider over: the refusal is core's, keyed on the resolved connection's type, in
    // the read path every replay passes, not the factory's alone.
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:sales", name: "Sales", type: "snowflake" });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const res = await POST(request(), params());
      const body = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(500);
      expect(body.error).toBe(
        'Provider type "snowflake" is not on the review record of engines that run agent and MCP statements (AGENT_EXECUTION_ENGINES), so no statement is sent on it, whatever its provider implements',
      );
      expect(mockQueryReadOnly).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  test("refuses a replay whose provider answers more rows than the hand-over budget, and returns none of them", async () => {
    // The provider's own code refuses past the budget it is handed; this fake does not, so what refuses here is the
    // route holding the answer to the budget itself.
    const rows = Array.from({ length: DEFAULT_QUERY_LIMIT + 1 }, (_, index) => ({ region: `region-${index}` }));
    mockQueryReadOnly.mockResolvedValueOnce({ ...RESULT, rows, rowCount: rows.length } as never);

    const res = await POST(request(), params());
    const body = await parseResponseJSON<{
      error: string;
      code: string;
      kind: string;
      outcome: string;
      result?: unknown;
    }>(res);

    expect(res.status).toBe(400);
    expect(body.code).toBe("QUERY_ERROR");
    expect(body.error).toBe(rowBudgetSentence(DEFAULT_QUERY_LIMIT + 1, DEFAULT_QUERY_LIMIT));
    expect(body.kind).toBe("studio-row-budget-refusal");
    expect(body.outcome).toBe("unknown");
    expect(body.result).toBeUndefined();
  });

  test("a statement the engine refuses is reported as the error it is", async () => {
    // The case the whole finding is about: a read-only transaction rejecting a write
    // that a syntactic check could not see. It must reach the user as an error, not
    // as an empty result.
    mockQueryReadOnly.mockRejectedValueOnce(
      new Error("cannot execute INSERT in a read-only transaction (SQLSTATE 25006)"),
    );

    const res = await POST(request(), params());
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(body.error).toContain("read-only transaction");
  });
});

describe("a provider's own budget refusal", () => {
  type RefusalBody = { error: string; code: string; kind: string; outcome: string; result?: unknown };

  const REFUSALS = [
    [
      "row budget refusal",
      "row-budget-refusal",
      (s: string) => new RowBudgetRefusal(s, "postgres", ANSWER_SQL),
      rowBudgetSentence(501, 500),
    ],
    [
      "byte budget refusal",
      "byte-budget-refusal",
      (s: string) => new ByteBudgetRefusal(s, "postgres", ANSWER_SQL),
      byteBudgetSentence(9001, 9000),
    ],
    [
      "time budget refusal",
      "time-budget-refusal",
      (s: string) => new TimeBudgetRefusal(s, "postgres", ANSWER_SQL),
      `${TIME_BUDGET_PREFIX} of 50 ms`,
    ],
    [
      "cut value refusal",
      "cut-value-refusal",
      (s: string) => new CutValueRefusal(s, "mssql", ANSWER_SQL),
      `${MSSQL_CUT_VALUE_PREFIX}: column 1`,
    ],
    [
      "serialised result refusal",
      "serialised-result-refusal",
      (s: string) => new SerialisedResultRefusal(s, "mssql", ANSWER_SQL),
      `${MSSQL_SERIALISED_PREFIX}: FOR JSON`,
    ],
  ] as const;

  test.each(REFUSALS.map(([label, kind, make, sentence]) => [label, kind, make, sentence] as const))(
    "a provider's %s answers 400 QUERY_ERROR with its sentence and kind %s",
    async (_label, kind, make, sentence) => {
      mockQueryReadOnly.mockRejectedValueOnce(make(sentence));

      const res = await POST(request(), params());
      const body = await parseResponseJSON<RefusalBody>(res);

      expect(res.status).toBe(400);
      expect(body.code).toBe("QUERY_ERROR");
      expect(body.error).toBe(sentence);
      expect(body.kind).toBe(kind);
      expect(body.outcome).toBe("unknown");
      expect(body.result).toBeUndefined();
    },
  );

  test("a provider's row budget refusal made before sending answers refused-before-send and not-sent", async () => {
    const sentence = rowBudgetSentence(1000, 500);
    mockQueryReadOnly.mockRejectedValueOnce(new RefusedBeforeSendError(sentence, "kafka", ANSWER_SQL));

    const res = await POST(request(), params());
    const body = await parseResponseJSON<RefusalBody>(res);

    expect(res.status).toBe(400);
    expect(body.code).toBe("QUERY_ERROR");
    expect(body.error).toBe(sentence);
    expect(body.kind).toBe("refused-before-send");
    expect(body.outcome).toBe("not-sent");
  });
});

describe("a replay whose provider's text carries the connection's credential", () => {
  const password = `${crypto.randomUUID()}/${crypto.randomUUID().slice(0, 8)}`;
  const forms = secretForms([password]);
  const failures: [string, (text: string) => unknown, "acquire" | "statement"][] = [
    ["a QueryError's message", (text) => new QueryError(text, "postgres"), "statement"],
    ["a QueryError's detail", (text) => new QueryError("failed", "postgres", undefined, undefined, text), "statement"],
    ["a ConnectionError", (text) => new ConnectionError(text, "postgres"), "acquire"],
    [
      "a provider's ExecutionProfileError",
      (text) => new ExecutionProfileError(text, "PROFILE_PRIVILEGES_TOO_BROAD"),
      "acquire",
    ],
    ["a RefusedBeforeSendError", (text) => new RefusedBeforeSendError(text, "postgres"), "statement"],
    [
      "an AuthenticationError's fixStatement",
      (text) => new AuthenticationError("denied", "postgres", { fixStatement: text }),
      "acquire",
    ],
    ["a string the provider rejects with", (text) => text, "statement"],
    ["a string the acquisition rejects with", (text) => text, "acquire"],
  ];

  type AnswerBody = { error: string; code?: string; kind?: string; outcome?: string; retryable?: boolean };

  /** The status and the closed fields of an answer: what a client branches on, never its text. */
  function closedFields(status: number, body: AnswerBody) {
    return { status, code: body.code, kind: body.kind, outcome: body.outcome, retryable: body.retryable };
  }

  test.each(failures.flatMap(([label, make, phase]) => forms.map((form) => [label, form, make, phase] as const)))(
    "%s holding %s keeps the status, code, kind and outcome its error answers, and neither the body nor the log holds it",
    async (_label, form, make, phase) => {
      mockResolveConnection.mockResolvedValue({ ...SEED_CONNECTION, password } as never);
      const clean = make("could not run as the reader");
      const failure = make(`could not run as ${form}`);
      const reject = (value: unknown) =>
        phase === "acquire" ? mockAcquire.mockRejectedValueOnce(value) : mockQueryReadOnly.mockRejectedValueOnce(value);
      const logged = [spyOn(logger, "error"), spyOn(logger, "warn"), spyOn(logger, "info")].map((spy) =>
        spy.mockImplementation(() => {}),
      );
      try {
        reject(clean);
        const cleanRes = await POST(request(), params());
        const cleanBody = await parseResponseJSON<AnswerBody>(cleanRes);
        for (const spy of logged) spy.mockClear();
        reject(failure);
        const res = await POST(request(), params());
        const body = await parseResponseJSON<AnswerBody>(res);

        expect(closedFields(res.status, body)).toEqual(closedFields(cleanRes.status, cleanBody));
        expect(body.error).toBe(
          withheldErrorMessage(failure instanceof Error ? failure.name : `thrown ${typeof failure}`),
        );
        const calls = JSON.stringify(
          logged.flatMap((spy) => spy.mock.calls),
          (_key, value: unknown) => (value instanceof Error ? { message: value.message, stack: value.stack } : value),
        );
        for (const each of forms) {
          expect(JSON.stringify(body)).not.toContain(each);
          expect(calls).not.toContain(each);
        }
      } finally {
        for (const spy of logged) spy.mockRestore();
        mockResolveConnection.mockResolvedValue(SEED_CONNECTION);
      }
    },
  );

  test("a provider's row budget refusal holding the credential keeps its kind", async () => {
    mockResolveConnection.mockResolvedValue({ ...SEED_CONNECTION, password } as never);
    mockQueryReadOnly.mockRejectedValueOnce(new RowBudgetRefusal(`too many rows for ${password}`, "postgres"));
    const quiet = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = await POST(request(), params());
      const body = await parseResponseJSON<AnswerBody>(res);

      expect(res.status).toBe(400);
      expect(body.code).toBe("QUERY_ERROR");
      expect(body.kind).toBe("row-budget-refusal");
      expect(body.error).toBe(withheldErrorMessage("QueryError"));
      expect(JSON.stringify(body)).not.toContain(password);
    } finally {
      quiet.mockRestore();
      mockResolveConnection.mockResolvedValue(SEED_CONNECTION);
    }
  });

  test("a failure with a SQLSTATE answers it beside its kind", async () => {
    mockResolveConnection.mockResolvedValue({ ...SEED_CONNECTION, password } as never);
    const failure = new QueryError('relation "orders" does not exist', "postgres");
    failure.sqlstate = "42P01";
    mockQueryReadOnly.mockRejectedValueOnce(failure);
    const quiet = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = await POST(request(), params());
      const body = await parseResponseJSON<AnswerBody & { sqlState?: string }>(res);

      expect(res.status).toBe(400);
      expect(body.kind).toBe("query");
      expect(body.sqlState).toBe("42P01");
    } finally {
      quiet.mockRestore();
      mockResolveConnection.mockResolvedValue(SEED_CONNECTION);
    }
  });

  test("under an agent credential, an echo of the connection's own password is kept as written, since the hand-over's provider never receives it", async () => {
    mockResolveConnection.mockResolvedValue({
      ...SEED_CONNECTION,
      password,
      agentUser: "agent_reader",
      agentPassword: crypto.randomUUID(),
    } as never);
    const message = `could not run as ${password}`;
    mockQueryReadOnly.mockRejectedValueOnce(new QueryError(message, "postgres"));
    try {
      const res = await POST(request(), params());
      const body = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(body.error).toContain(message);
    } finally {
      mockResolveConnection.mockResolvedValue(SEED_CONNECTION);
    }
  });

  test("a connection that no longer resolves is answered before any provider is built", async () => {
    mockResolveConnection.mockRejectedValueOnce(new Error("the connection is gone"));
    const res = await POST(request(), params());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  test("a success's warnings are withheld in the body", async () => {
    mockResolveConnection.mockResolvedValue({ ...SEED_CONNECTION, password } as never);
    mockQueryReadOnly.mockResolvedValueOnce({ ...RESULT, warnings: [{ message: `notice ${password}` }] } as never);
    try {
      const res = await POST(request(), params());
      const body = await parseResponseJSON<{ result: { warnings?: unknown } }>(res);

      expect(res.status).toBe(200);
      expect(body.result.warnings).toEqual([{ message: PROVIDER_TEXT_WITHHELD }]);
      for (const each of forms) expect(JSON.stringify(body)).not.toContain(each);
    } finally {
      mockResolveConnection.mockResolvedValue(SEED_CONNECTION);
    }
  });
});
