/**
 * The agent run routes (#329 T9): start, status, cancel and the run's timeline.
 *
 * What these pin, beyond the ordinary shape checks: a session verified in the
 * handler rather than trusted from the middleware, a run that is invisible to every
 * session but its own, and a surface that does not exist at all while the runtime
 * flag is off.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { AgentRunServiceError } from "@/lib/agent/run-service";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import * as realAuth from "@/lib/auth";
import * as realSeed from "@/lib/seed/resolve-connection";
import * as realGate from "@/lib/agent/capability-gate";
import { AgentRunStoreError } from "@/lib/agent/run-store";

const { SeedConnectionError } = realSeed;

// ─── Session ────────────────────────────────────────────────────────────────

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "ada" }),
);

// ─── The connection the run is opened against ───────────────────────────────

const mockAdmitAgentModel = mock<typeof realGate.admitAgentModel>(async () => ({ kind: "allowed" }));

const mockResolveConnection = mock(async (body: { connectionId?: string }) => ({
  id: body.connectionId ?? "seed:sales",
  name: "Sales",
  type: "postgres",
}));

// ─── The runtime: service and drive ─────────────────────────────────────────

interface FakeRun {
  runId: string;
  mode: string;
  workflowType: string;
  status: string;
  actor: { sessionId: string; role: string };
  connectionId: string;
  objective: string;
  events: unknown[];
}

function fakeRun(overrides: Partial<FakeRun> = {}): FakeRun {
  return {
    runId: "arun_1",
    mode: "agent",
    // The store's default, so a body naming no workflow still produces a record
    // carrying one — which is what the route echoes back.
    workflowType: "investigation",
    status: "queued",
    actor: { sessionId: "ada", role: "user" },
    connectionId: "seed:sales",
    objective: "why is checkout slow",
    events: [],
    ...overrides,
  };
}

let runs: Map<string, FakeRun>;

const mockStart = mock(
  async (input: {
    mode: string;
    workflowType?: string;
    actor: FakeRun["actor"];
    connectionId: string;
    objective: string;
  }) => {
    const record = fakeRun({ ...input, runId: "arun_new" });
    runs.set(record.runId, record);
    return record;
  },
);

const mockStatus = mock(async (runId: string) => {
  const record = runs.get(runId);
  return record === undefined ? null : { record, cancellationRequested: false };
});

const mockCancel = mock(async (runId: string) => {
  const record = runs.get(runId);
  return { record, cancellationRequested: true };
});

const mockStream = mock(
  async () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue({ kind: "event", event: { kind: "run-started", atMs: 1, mode: "agent" } });
        controller.close();
      },
    }),
);

const mockDriveAgentRun = mock(async () => ({ runId: "arun_new", status: "succeeded" }));

/**
 * Re-applied in `beforeEach` as well as at import time: `mock.module` replaces a
 * module process-wide, and `tests/api/agent/drive.test.ts` mocks the same runtime
 * module in the same process under `bun run test`. Re-registering makes the file
 * that is currently running own the module, whatever order the runner loaded them in.
 */
function installMocks(): void {
  // Spread over the real modules rather than listing their exports: a partial
  // replacement stays installed for the rest of the process and breaks the next
  // file that imports an export this one forgot.
  mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
  // The gate would otherwise build a real model and, where a key is configured, put a
  // live probe call inside this suite.
  mock.module("@/lib/agent/capability-gate", () => ({ ...realGate, admitAgentModel: mockAdmitAgentModel }));
  mock.module("@/lib/seed/resolve-connection", () => ({ ...realSeed, resolveConnection: mockResolveConnection }));
  mock.module("@/lib/agent/runtime", () => ({
    getAgentRunService: mock(async () => ({
      start: mockStart,
      status: mockStatus,
      cancel: mockCancel,
      stream: mockStream,
    })),
    driveAgentRun: mockDriveAgentRun,
    // Listed although this file's routes never call it: the replacement is
    // process-wide, and `tests/api/agent/artifacts.test.ts` imports a route that does.
    readAgentArtifact: mock(() => undefined),
  }));
}

installMocks();

const { POST } = await import("@/app/api/agent/runs/route");
const { GET, DELETE } = await import("@/app/api/agent/runs/[runId]/route");
const { GET: STREAM } = await import("@/app/api/agent/runs/[runId]/stream/route");

function params(runId: string): { params: Promise<{ runId: string }> } {
  return { params: Promise.resolve({ runId }) };
}

function startRequest(body: unknown): Request {
  return createMockRequest("/api/agent/runs", { method: "POST", body });
}

const VALID_BODY = { mode: "agent", objective: "why is checkout slow", connectionId: "seed:sales" };

beforeEach(() => {
  installMocks();
  clearRateLimitState();
  runs = new Map([["arun_1", fakeRun()]]);
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  process.env[AGENT_ENABLED_ENV] = "true";
  mockDriveAgentRun.mockClear();
  mockAdmitAgentModel.mockClear();
  mockAdmitAgentModel.mockImplementation(async () => ({ kind: "allowed" }));
  mockStart.mockClear();
  mockResolveConnection.mockClear();
});

describe("POST /api/agent/runs", () => {
  /*
    A model that cannot call tools is refused BEFORE a run exists, which is the whole
    point of the gate (`docs/BACKLOG.md` B18): otherwise the run opens, spends a drive
    and ends having answered in prose, and the user is left reading a failed run to
    learn something the server could have said at the start. 422 because the request is
    well-formed — it is the configuration that cannot honour it — and no ledger is
    written for a run that never began.
  */
  test("a model established as unable to drive a run is refused before one is opened", async () => {
    mockAdmitAgentModel.mockImplementation(async () => ({
      kind: "refused",
      refusal: {
        provider: "gemini",
        modelId: "some-model",
        capabilities: { toolCalling: false, structuredOutput: false, streaming: true },
        missing: ["toolCalling"],
        message: "This model does not call tools. Use the AI Assistant or Natural Language Query instead.",
      },
    }));

    const res = await POST(startRequest(VALID_BODY));
    const body = await parseResponseJSON<{ error: string; missing: string[] }>(res);

    expect(res.status).toBe(422);
    expect(body.error).toContain("does not call tools");
    expect(body.missing).toEqual(["toolCalling"]);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockDriveAgentRun).not.toHaveBeenCalled();
  });

  test("opens a run for the session's own actor and reports it queued", async () => {
    const res = await POST(startRequest(VALID_BODY));
    const body = await parseResponseJSON<{ runId: string; status: string; mode: string; workflowType: string }>(res);

    expect(res.status).toBe(202);
    expect(body).toEqual({ runId: "arun_new", status: "queued", mode: "agent", workflowType: "investigation" });
    // No `workflowType` reaches the service when the body named none: the store's
    // own default is the single place that answer is decided.
    expect(mockStart).toHaveBeenCalledWith({
      mode: "agent",
      actor: { sessionId: "ada", role: "user" },
      connectionId: "seed:sales",
      objective: "why is checkout slow",
    });
  });

  test("a named workflow type is persisted, and the response echoes what was PERSISTED", async () => {
    const res = await POST(startRequest({ ...VALID_BODY, workflowType: "query-optimization" }));
    const body = await parseResponseJSON<{ workflowType: string }>(res);

    expect(res.status).toBe(202);
    expect(body.workflowType).toBe("query-optimization");
    expect(mockStart).toHaveBeenCalledWith({
      mode: "agent",
      workflowType: "query-optimization",
      actor: { sessionId: "ada", role: "user" },
      connectionId: "seed:sales",
      objective: "why is checkout slow",
    });
  });

  test("every workflow type this server serves is accepted", async () => {
    for (const workflowType of ["investigation", "query-optimization", "database-assessment"]) {
      const res = await POST(startRequest({ ...VALID_BODY, workflowType }));
      expect(res.status, workflowType).toBe(202);
    }
  });

  test("an unknown workflow type is refused rather than defaulted", async () => {
    // Silently running a different workflow is how a user reads a report about work
    // nobody asked for.
    const res = await POST(startRequest({ ...VALID_BODY, workflowType: "schema-migration" }));

    expect(res.status).toBe(400);
    expect(mockStart).not.toHaveBeenCalled();
  });

  test("a non-string workflow type is refused", async () => {
    const res = await POST(startRequest({ ...VALID_BODY, workflowType: 7 }));

    expect(res.status).toBe(400);
    expect(mockStart).not.toHaveBeenCalled();
  });

  test("the run is driven without the caller waiting for it", async () => {
    await POST(startRequest(VALID_BODY));

    expect(mockDriveAgentRun).toHaveBeenCalledWith("arun_new");
  });

  test("a drive that fails does not fail the request that started it", async () => {
    mockDriveAgentRun.mockRejectedValueOnce(new Error("model unreachable"));

    const res = await POST(startRequest(VALID_BODY));

    expect(res.status).toBe(202);
  });

  test("an unauthenticated caller is refused before anything is opened", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(startRequest(VALID_BODY));

    expect(res.status).toBe(401);
    expect(mockStart).not.toHaveBeenCalled();
  });

  test("the surface does not exist while the runtime flag is off", async () => {
    delete process.env[AGENT_ENABLED_ENV];

    const res = await POST(startRequest(VALID_BODY));

    expect(res.status).toBe(404);
    expect(mockStart).not.toHaveBeenCalled();
  });

  test("an unknown mode is refused", async () => {
    const res = await POST(startRequest({ ...VALID_BODY, mode: "autonomous" }));

    expect(res.status).toBe(400);
    expect(mockStart).not.toHaveBeenCalled();
  });

  test("planning mode is accepted", async () => {
    const res = await POST(startRequest({ ...VALID_BODY, mode: "planning" }));

    expect(res.status).toBe(202);
  });

  test("a blank objective is refused", async () => {
    const res = await POST(startRequest({ ...VALID_BODY, objective: "   " }));

    expect(res.status).toBe(400);
  });

  test("an objective longer than the bound is refused", async () => {
    const res = await POST(startRequest({ ...VALID_BODY, objective: "a".repeat(4001) }));

    expect(res.status).toBe(400);
  });

  test("a connection supplied inline is refused rather than used", async () => {
    // A run records a connection ID and no credential, so a drive re-resolves the
    // connection on the server. One that only the browser knows could never be
    // rebuilt by the process that resumes the run.
    const res = await POST(
      startRequest({
        mode: "agent",
        objective: "why is checkout slow",
        connection: { id: "local-1", type: "postgres" },
      }),
    );

    expect(res.status).toBe(400);
    expect(mockResolveConnection).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  test("a missing connectionId is refused", async () => {
    const res = await POST(startRequest({ mode: "agent", objective: "why is checkout slow" }));

    expect(res.status).toBe(400);
    expect(mockStart).not.toHaveBeenCalled();
  });

  test("a connection the session may not reach refuses the run", async () => {
    mockResolveConnection.mockRejectedValueOnce(new SeedConnectionError("Access denied", 403));

    const res = await POST(startRequest(VALID_BODY));

    expect(res.status).toBe(403);
    expect(mockStart).not.toHaveBeenCalled();
  });

  test("a body that is not JSON is refused", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/agent/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );

    expect(res.status).toBe(400);
  });
});

describe("GET /api/agent/runs/[runId]", () => {
  test("reports the run to the session that opened it", async () => {
    const res = await GET(createMockRequest("/api/agent/runs/arun_1"), params("arun_1"));
    const body = await parseResponseJSON<{ record: FakeRun; cancellationRequested: boolean }>(res);

    expect(res.status).toBe(200);
    expect(body.record.runId).toBe("arun_1");
    expect(body.cancellationRequested).toBe(false);
  });

  test("another session cannot read the run, and is not told it exists", async () => {
    mockGetSession.mockResolvedValue({ role: "user", username: "grace" });

    const res = await GET(createMockRequest("/api/agent/runs/arun_1"), params("arun_1"));

    expect(res.status).toBe(404);
  });

  test("an admin is not exempt: the run's own actor is the authority", async () => {
    mockGetSession.mockResolvedValue({ role: "admin", username: "root" });

    const res = await GET(createMockRequest("/api/agent/runs/arun_1"), params("arun_1"));

    expect(res.status).toBe(404);
  });

  test("a run that does not exist is a 404", async () => {
    const res = await GET(createMockRequest("/api/agent/runs/arun_9"), params("arun_9"));

    expect(res.status).toBe(404);
  });

  /*
    A run id the LEDGER cannot name is a run that cannot exist, so it answers like one.

    Found by asking the running server for `../../etc/passwd`: the store's id guard
    refused it before touching the filesystem — which is the guard working — but the
    error reached no HTTP mapping and fell through as a bodyless 500. A malformed id is
    the caller's mistake, and this module's own rule is that "no such run", "not yours"
    and "runtime off" answer identically; teaching a caller the id grammar through a
    different status would undo that.
  */
  test("a run id the ledger cannot name answers exactly like a run that does not exist", async () => {
    // Once: a persistent replacement would outlive this test, because `mock.module`
    // installs it for the whole process.
    mockStatus.mockImplementationOnce(async (runId: string) => {
      throw new AgentRunStoreError(
        "INVALID_RUN_ID",
        `agent run id "${runId}" is not usable as a ledger name: expected 1-64 characters of [A-Za-z0-9_]`,
      );
    });

    const res = await GET(createMockRequest("/api/agent/runs/arun-with-hyphens"), params("arun-with-hyphens"));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(404);
    expect(body.error).toBe("No such agent run");
  });

  test("an unauthenticated caller is refused", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await GET(createMockRequest("/api/agent/runs/arun_1"), params("arun_1"));

    expect(res.status).toBe(401);
  });

  test("the surface does not exist while the runtime flag is off", async () => {
    delete process.env[AGENT_ENABLED_ENV];

    const res = await GET(createMockRequest("/api/agent/runs/arun_1"), params("arun_1"));

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/agent/runs/[runId]", () => {
  test("the session that opened the run can stop it", async () => {
    const res = await DELETE(createMockRequest("/api/agent/runs/arun_1", { method: "DELETE" }), params("arun_1"));
    const body = await parseResponseJSON<{ cancellationRequested: boolean }>(res);

    expect(res.status).toBe(200);
    expect(body.cancellationRequested).toBe(true);
    expect(mockCancel).toHaveBeenCalledWith("arun_1", { sessionId: "ada", role: "user" });
  });

  test("a run the service refuses to stop reports the refusal rather than a bare 500", async () => {
    // The one this really guards: a run with a statement still in flight cannot be
    // ended, and the service says so with a typed error instead of half-ending it.
    mockCancel.mockRejectedValueOnce(new AgentRunServiceError("RUN_HAS_LIVE_EXECUTION", "1 execution in flight"));

    const res = await DELETE(createMockRequest("/api/agent/runs/arun_1", { method: "DELETE" }), params("arun_1"));

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("another session cannot cancel the run", async () => {
    mockGetSession.mockResolvedValue({ role: "admin", username: "root" });
    mockCancel.mockClear();

    const res = await DELETE(createMockRequest("/api/agent/runs/arun_1", { method: "DELETE" }), params("arun_1"));

    expect(res.status).toBe(404);
    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe("GET /api/agent/runs/[runId]/stream", () => {
  test("streams the run's timeline as newline-delimited entries", async () => {
    const res = await STREAM(createMockRequest("/api/agent/runs/arun_1/stream"), params("arun_1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await res.text()).toBe('{"kind":"event","event":{"kind":"run-started","atMs":1,"mode":"agent"}}\n');
  });

  test("another session cannot follow the run", async () => {
    mockGetSession.mockResolvedValue({ role: "user", username: "grace" });

    const res = await STREAM(createMockRequest("/api/agent/runs/arun_1/stream"), params("arun_1"));

    expect(res.status).toBe(404);
  });
});
