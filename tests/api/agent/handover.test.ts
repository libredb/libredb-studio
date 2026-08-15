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

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { configureAgentModel, restoreAgentModel } from "../../helpers/agent-model-env";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { AGENT_HANDOVER_BUDGET } from "@/lib/agent/execution-policy";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import * as realAuth from "@/lib/auth";

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
const mockAcquire = mock(
  async (_connection: unknown, _profile: string): Promise<ProfiledProvider> => ({
    queryReadOnly: mockQueryReadOnly,
    query: mockQuery,
  }),
);

function installMocks(): void {
  mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
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
    expect(budget).toEqual(AGENT_HANDOVER_BUDGET);
    expect(budget.maxResultRows).toBe(500);
    // "No time limit", as far as a positive-integer field can express it.
    expect(budget.statementTimeoutMs).toBe(2_147_483_647);
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
