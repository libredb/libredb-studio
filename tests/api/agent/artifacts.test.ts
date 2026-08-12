/**
 * Reading one artifact a run produced (#329 T11).
 *
 * The rail cites artifacts; this is the only route that hands their ROWS back, and
 * what it pins is where the authority for that comes from:
 *
 *  - The run's own ledger decides whether a correlation id belongs to it. The
 *    artifact store is process-wide and holds every live run's results, so asking it
 *    first would let a caller read another run's rows by naming their own run.
 *  - Results are held in process memory and released when a run ends, so "the run
 *    finished and its rows are gone" is an ordinary answer rather than a failure —
 *    and it is a DIFFERENT answer from "no such artifact", because a user who was
 *    reading a report deserves to know which of the two happened.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import * as realAuth from "@/lib/auth";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "ada" }),
);

const READ_ARTIFACT = {
  correlationId: "corr_9",
  runId: "arun_1",
  operationId: "sql.query.read",
  summary: { rowCount: 2, columnNames: ["id", "total"], elapsedMs: 12 },
};

const RESULT = {
  rows: [
    { id: 1, total: 10 },
    { id: 2, total: 20 },
  ],
  fields: ["id", "total"],
  rowCount: 2,
  executionTime: 12,
};

function fakeRun() {
  return {
    runId: "arun_1",
    mode: "agent",
    status: "running",
    actor: { sessionId: "ada", role: "user" },
    connectionId: "seed:sales",
    objective: "why is checkout slow",
    events: [
      { kind: "run-started", atMs: 1, mode: "agent" },
      { kind: "tool-completed", atMs: 2, stepId: "s1", artifact: READ_ARTIFACT },
    ],
  };
}

let runs: Map<string, ReturnType<typeof fakeRun>>;
/** What the process-wide store currently holds, keyed the way it keys. */
let held: Map<string, { correlationId: string; runId: string; operationId: string; value: unknown }>;

const mockStatus = mock(async (runId: string) => {
  const record = runs.get(runId);
  return record === undefined ? null : { record, cancellationRequested: false };
});

const mockReadAgentArtifact = mock((correlationId: string) => held.get(correlationId));

function installMocks(): void {
  mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
  mock.module("@/lib/agent/runtime", () => ({
    getAgentRunService: mock(async () => ({ status: mockStatus })),
    driveAgentRun: mock(async () => ({ runId: "arun_1", status: "succeeded" })),
    readAgentArtifact: mockReadAgentArtifact,
  }));
}

installMocks();

const { GET } = await import("@/app/api/agent/runs/[runId]/artifacts/[correlationId]/route");

function params(runId: string, correlationId: string) {
  return { params: Promise.resolve({ runId, correlationId }) };
}

function request(runId = "arun_1", correlationId = "corr_9"): Request {
  return createMockRequest(`/api/agent/runs/${runId}/artifacts/${correlationId}`);
}

beforeEach(() => {
  installMocks();
  clearRateLimitState();
  runs = new Map([["arun_1", fakeRun()]]);
  held = new Map([["corr_9", { ...READ_ARTIFACT, value: RESULT }]]);
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  mockReadAgentArtifact.mockClear();
  process.env[AGENT_ENABLED_ENV] = "true";
});

describe("GET /api/agent/runs/[runId]/artifacts/[correlationId]", () => {
  test("hands back the rows the run stored, with the operation that produced them", async () => {
    const res = await GET(request(), params("arun_1", "corr_9"));
    const body = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    // Exactly these four: the rows already describe their own shape, so the ledger's
    // summary is not restated beside them where the two could disagree.
    expect(Object.keys(body).toSorted()).toEqual(["correlationId", "operationId", "result", "runId"]);
    expect(body.runId).toBe("arun_1");
    expect(body.correlationId).toBe("corr_9");
    // The operation id comes from the LEDGER entry, which outlives the process, not
    // from the in-memory copy the rows came from.
    expect(body.operationId).toBe("sql.query.read");
    expect((body.result as typeof RESULT).rows).toEqual(RESULT.rows);
  });

  test("the operation reported is the ledger's, not the in-memory copy's", async () => {
    // The ledger is the record that outlives the process; the store is what this
    // process happens to hold. Where they disagree, the durable one is the answer.
    held.set("corr_9", { ...READ_ARTIFACT, operationId: "sql.explain.estimate", value: RESULT });

    const res = await GET(request(), params("arun_1", "corr_9"));
    const body = await parseResponseJSON<{ operationId: string }>(res);

    expect(body.operationId).toBe("sql.query.read");
  });

  test("an artifact this run's ledger does not name is not read from the store at all", async () => {
    held.set("corr_other", {
      correlationId: "corr_other",
      runId: "arun_2",
      operationId: "sql.query.read",
      value: RESULT,
    });

    const res = await GET(request("arun_1", "corr_other"), params("arun_1", "corr_other"));

    expect(res.status).toBe(404);
    expect(mockReadAgentArtifact).not.toHaveBeenCalled();
  });

  test("an artifact the store no longer holds is reported as released, not as missing", async () => {
    held.clear();

    const res = await GET(request(), params("arun_1", "corr_9"));
    const body = await parseResponseJSON<{ error: string; reason: string }>(res);

    expect(res.status).toBe(410);
    expect(body.reason).toBe("released");
    expect(body.error).toContain("no longer");
  });

  test("a stored entry belonging to another run is refused even when the ledger names it", async () => {
    // Defence in depth: the store is process-wide, and correlation ids come from the
    // audit layer rather than from this route.
    held.set("corr_9", { ...READ_ARTIFACT, runId: "arun_2", value: RESULT });

    const res = await GET(request(), params("arun_1", "corr_9"));

    expect(res.status).toBe(410);
  });

  test("another session cannot read the artifact, and is not told the run exists", async () => {
    mockGetSession.mockResolvedValue({ role: "user", username: "grace" });

    const res = await GET(request(), params("arun_1", "corr_9"));

    expect(res.status).toBe(404);
    expect(mockReadAgentArtifact).not.toHaveBeenCalled();
  });

  test("an admin is not exempt", async () => {
    mockGetSession.mockResolvedValue({ role: "admin", username: "root" });

    const res = await GET(request(), params("arun_1", "corr_9"));

    expect(res.status).toBe(404);
  });

  test("an unauthenticated caller is refused", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await GET(request(), params("arun_1", "corr_9"));

    expect(res.status).toBe(401);
  });

  test("the surface does not exist while the runtime flag is off", async () => {
    delete process.env[AGENT_ENABLED_ENV];

    const res = await GET(request(), params("arun_1", "corr_9"));

    expect(res.status).toBe(404);
    expect(mockReadAgentArtifact).not.toHaveBeenCalled();
  });
});
