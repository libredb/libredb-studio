/**
 * The agent run routes (#329 T9): start, status, cancel and the run's timeline.
 *
 * What these pin, beyond the ordinary shape checks: a session verified in the
 * handler rather than trusted from the middleware, a run that is invisible to every
 * session but its own, and a surface that does not exist at all while the runtime
 * flag is off.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { configureAgentModel, restoreAgentModel } from "../../helpers/agent-model-env";
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

const mockAdmitAgentModel = mock<typeof realGate.admitAgentModel>(async () => ({
  kind: "allowed",
  protocol: "native",
}));

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
  workflowSource: string;
  workflowReading: string;
  autoExecute: boolean;
  status: string;
  actor: { sessionId: string; role: string };
  connectionId: string;
  connectionIdentity?: string;
  objective: string;
  events: unknown[];
  thread: { threadId: string; steps: { runId: string; objective: string }[]; text: string; declined?: string };
}

function fakeRun(overrides: Partial<FakeRun> = {}): FakeRun {
  return {
    runId: "arun_1",
    mode: "agent",
    // The store's default, so a body naming no workflow still produces a record
    // carrying one — which is what the route echoes back.
    workflowType: "investigation",
    // The store's default too: a header written by a body that named no source
    // describes a workflow its caller sent explicitly.
    workflowSource: "chosen",
    // The store's default too: a header that carries no classifier outcome records
    // none, which is neither a reading that succeeded nor one that failed.
    workflowReading: "unrecorded",
    // The store's default too: absent means off, so a body that asked for nothing
    // opens a run that hands nothing anywhere.
    autoExecute: false,
    status: "queued",
    actor: { sessionId: "ada", role: "user" },
    connectionId: "seed:sales",
    objective: "why is checkout slow",
    events: [],
    // What the FOLD gives every run, so a fixture cannot be a shape the store
    // never produces: a run whose thread was not recorded is a thread of one
    // named after itself.
    thread: { threadId: overrides.runId ?? "arun_1", steps: [], text: "" },
    ...overrides,
  };
}

let runs: Map<string, FakeRun>;

const mockStart = mock(
  async (input: {
    mode: string;
    workflowType?: string;
    workflowSource?: string;
    workflowReading?: string;
    autoExecute?: boolean;
    actor: FakeRun["actor"];
    connectionId: string;
    connectionIdentity?: string;
    objective: string;
    thread?: { threadId: string; steps: { runId: string; objective: string }[]; text: string; declined?: string };
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
  // A configured model is what makes the surface exist since #331 T5; the flag
  // is only the off-switch, so it is deleted here and set to a negative value by
  // the two tests that assert the surface is absent.
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
  mockDriveAgentRun.mockClear();
  mockAdmitAgentModel.mockClear();
  mockAdmitAgentModel.mockImplementation(async () => ({ kind: "allowed", protocol: "native" }));
  mockStart.mockClear();
  mockResolveConnection.mockClear();
});

afterEach(() => {
  restoreAgentModel();
});

describe("POST /api/agent/runs", () => {
  /*
    A run may CONTINUE a conversation, and the context is derived SERVER-SIDE from the
    predecessor's own ledger. The request only names the run; the route resolves it,
    checks it is the caller's, on this connection and ended, and persists what it
    derived on the new run's record.
  */
  test("a run that continues a conversation carries its steps and the derived text", async () => {
    runs.set(
      "arun_1",
      fakeRun({
        status: "succeeded",
        events: [
          {
            kind: "report-composed",
            atMs: 1,
            claims: [{ claim: "A fact", evidence: [{ source: "artifact", correlationId: "corr_1" }] }],
          },
        ],
      }),
    );

    const res = await POST(startRequest({ ...VALID_BODY, previousRunId: "arun_1" }));

    expect(res.status).toBe(202);
    expect(mockStart.mock.calls.at(-1)?.[0]).toMatchObject({
      thread: { threadId: "arun_1", steps: [{ runId: "arun_1", objective: "why is checkout slow" }] },
    });
    expect(mockStart.mock.calls.at(-1)?.[0].thread?.text).toContain("Claim 1: A fact");
  });

  /*
    B68. A conversation was single-connection by INDUCTION: every link checked the
    connection ID at its own open, which is an identity check on the RECORD. Editing a
    saved connection to address another server keeps that id, so the follow-up below
    used to be handed the earlier step's claims about the OLD database while reading the
    NEW one — nothing refused, nothing wrong to look at, and a report about one database
    resting on another. What the route writes now is which DATABASE the run read, and
    what it checks is that.
  */
  test("a follow-up on a re-pointed connection declines rather than carrying the conversation", async () => {
    const original = mockResolveConnection.getMockImplementation();
    try {
      // Run one, against the database the connection addressed then. Its identity is
      // taken from what the route itself wrote, not restated here.
      await POST(startRequest(VALID_BODY));
      const establishedIdentity = mockStart.mock.calls.at(-1)?.[0].connectionIdentity;
      expect(establishedIdentity).toEqual(expect.any(String));
      runs.set(
        "arun_1",
        fakeRun({
          status: "succeeded",
          connectionIdentity: establishedIdentity,
          events: [
            {
              kind: "report-composed",
              atMs: 1,
              claims: [{ claim: "A fact", evidence: [{ source: "artifact", correlationId: "corr_1" }] }],
            },
          ],
        }),
      );

      // The user edits the connection to address staging. Same record, same id.
      mockResolveConnection.mockImplementation(async (body: { connectionId?: string }) => ({
        id: body.connectionId ?? "seed:sales",
        name: "Sales",
        type: "postgres",
        database: "staging",
      }));

      const res = await POST(startRequest({ ...VALID_BODY, previousRunId: "arun_1" }));

      expect(res.status).toBe(202);
      const thread = mockStart.mock.calls.at(-1)?.[0].thread;
      expect(thread).toMatchObject({ steps: [], text: "", declined: "unavailable" });
      // Nothing of the earlier step survives: not its objective, and not its claim.
      expect(thread?.steps).toEqual([]);
      expect(thread?.text).toBe("");
      // And the new run records the database it is actually reading, so the conversation
      // it starts is checkable in its turn.
      expect(mockStart.mock.calls.at(-1)?.[0].connectionIdentity).not.toBe(establishedIdentity);
    } finally {
      // Restored by hand: `mock.module` is re-applied per test with the SAME mock
      // object, so an implementation left here would outlive this test.
      if (original !== undefined) mockResolveConnection.mockImplementation(original);
    }
  });

  test("an unchanged connection still carries the conversation, so the check above ends no ordinary follow-up", async () => {
    await POST(startRequest(VALID_BODY));
    const establishedIdentity = mockStart.mock.calls.at(-1)?.[0].connectionIdentity;
    runs.set("arun_1", fakeRun({ status: "succeeded", connectionIdentity: establishedIdentity }));

    const res = await POST(startRequest({ ...VALID_BODY, previousRunId: "arun_1" }));

    expect(res.status).toBe(202);
    expect(mockStart.mock.calls.at(-1)?.[0].thread).toMatchObject({
      threadId: "arun_1",
      steps: [{ runId: "arun_1", objective: "why is checkout slow" }],
    });
  });

  test("a run that starts its own conversation writes no thread, so its ledger is the bytes it always was", async () => {
    const res = await POST(startRequest(VALID_BODY));

    expect(res.status).toBe(202);
    expect(mockStart.mock.calls.at(-1)?.[0].thread).toBeUndefined();
  });

  /*
    Every RUNTIME condition below degrades rather than refusing, and that is the rule
    this block exists to pin: `previousRunId` is attached by the rail on its own — the
    user never typed it — so a conversation that cannot be reached must not take down
    the question they DID type. The run opens, carries no conversation, and says so.

    Nothing is leaked that refusing did not leak: the same reasons collapsed into one
    refusal before and collapse into one `declined` now.
  */
  test.each([
    ["naming no run", () => "arun_missing"],
    [
      "naming another session's run",
      () => {
        runs.set("arun_other", fakeRun({ actor: { sessionId: "grace", role: "user" }, status: "succeeded" }));
        return "arun_other";
      },
    ],
    [
      "naming a run on another connection",
      () => {
        runs.set("arun_elsewhere", fakeRun({ connectionId: "seed:analytics", status: "succeeded" }));
        return "arun_elsewhere";
      },
    ],
    [
      "naming a run that has not ended",
      () => {
        runs.set("arun_running", fakeRun({ status: "running" }));
        return "arun_running";
      },
    ],
  ])(
    "a previousRunId %s opens the run anyway and records that the conversation was not reached",
    async (_case, arrange) => {
      const previousRunId = arrange();

      const res = await POST(startRequest({ ...VALID_BODY, previousRunId }));

      expect(res.status).toBe(202);
      expect(mockStart.mock.calls.at(-1)?.[0].thread).toMatchObject({ steps: [], text: "", declined: "unavailable" });
      // No thread id is written: a refused continuation starts a conversation of its
      // OWN, and the fold names it after the run being opened. Naming it after the run
      // it was refused would hand a follow-up of THIS run a root that was never in the
      // conversation, and the derivation would carry that root forward.
      expect(mockStart.mock.calls.at(-1)?.[0].thread?.threadId).toBeUndefined();
    },
  );

  test("a previousRunId that is not a non-empty string is still refused: that is a client bug", async () => {
    const res = await POST(startRequest({ ...VALID_BODY, previousRunId: "" }));

    expect(res.status).toBe(400);
  });

  test("a previousRunId the ledger cannot name opens the run anyway", async () => {
    // The store refuses an id outside AGENT_RUN_ID_PATTERN before touching anything.
    // It joins the same `unavailable`, because a caller guessing ids must not be able
    // to tell "malformed" apart from "not yours" — and it does not stop the run.
    mockStatus.mockImplementationOnce(async () => {
      throw new AgentRunStoreError("INVALID_RUN_ID", 'agent run id "arun-1" is not usable as a ledger name');
    });

    const res = await POST(startRequest({ ...VALID_BODY, previousRunId: "arun-1" }));

    expect(res.status).toBe(202);
    expect(mockStart.mock.calls.at(-1)?.[0].thread).toMatchObject({ declined: "unavailable" });
  });

  test("an unreadable ledger is recorded as an error rather than as a refusal, and still opens the run", async () => {
    // Not something the caller can fix by naming another run, and it says nothing about
    // the id they sent — so it is recorded apart. Recorded rather than logged, because a
    // fail-open decision has to carry its reason as data.
    mockStatus.mockImplementationOnce(async () => {
      throw new Error("ledger unavailable");
    });

    const res = await POST(startRequest({ ...VALID_BODY, previousRunId: "arun_1" }));

    expect(res.status).toBe(202);
    expect(mockStart.mock.calls.at(-1)?.[0].thread).toMatchObject({ declined: "error" });
  });

  test("with the operator switch off, previousRunId is ignored and the run says so", async () => {
    const before = mockStatus.mock.calls.length;
    process.env.LIBREDB_AGENT_THREAD_CONTEXT = "false";
    runs.set("arun_1", fakeRun({ status: "succeeded" }));

    try {
      const res = await POST(startRequest({ ...VALID_BODY, previousRunId: "arun_1" }));

      expect(res.status).toBe(202);
      expect(mockStart.mock.calls.at(-1)?.[0].thread).toMatchObject({ steps: [], text: "", declined: "disabled" });
      // Measured as a DELTA rather than as "never called": these mocks accumulate
      // across the file, so `not.toHaveBeenCalled()` would be a claim about the
      // whole suite. Nothing was looked up here — the switch decides before the
      // ledger is touched.
      expect(mockStatus.mock.calls.length).toBe(before);
    } finally {
      delete process.env.LIBREDB_AGENT_THREAD_CONTEXT;
    }
  });

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
        disproved: ["toolCalling"],
        message: "This model does not call tools. Configure a different model and start the run again.",
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

  /*
    What the probe WATCHED fail travels too, because `missing` alone cannot answer the
    question the rail asks of it. An endpoint that refused the tool request establishes
    nothing about streaming; one that answered a streamed request with a buffered body
    establishes that it does not stream, and a toolless run over the same endpoint would
    produce silence. Both arrive here as `missing: [… "streaming"]`, so the browser
    would have to guess which — and a browser that guesses wrong offers a mode that
    cannot answer (#331 T4 review).
  */
  test("the refusal carries what was DISPROVED, not only what was unestablished", async () => {
    mockAdmitAgentModel.mockImplementation(async () => ({
      kind: "refused",
      refusal: {
        provider: "ollama",
        modelId: "gemma3:270m",
        capabilities: { toolCalling: false, structuredOutput: false, streaming: false },
        missing: ["toolCalling", "structuredOutput", "streaming"],
        disproved: ["streaming"],
        message: "This endpoint ignored stream:true.",
      },
    }));

    const body = await parseResponseJSON<{ missing: string[]; disproved: string[] }>(
      await POST(startRequest(VALID_BODY)),
    );

    expect(body.missing).toEqual(["toolCalling", "structuredOutput", "streaming"]);
    expect(body.disproved).toEqual(["streaming"]);
  });

  test("opens a run for the session's own actor and reports it queued", async () => {
    const res = await POST(startRequest(VALID_BODY));
    const body = await parseResponseJSON<{
      runId: string;
      status: string;
      mode: string;
      workflowType: string;
      workflowSource: string;
      workflowReading: string;
      autoExecute: boolean;
      thread: { threadId: string; steps: unknown[]; text: string };
    }>(res);

    expect(res.status).toBe(202);
    expect(body).toEqual({
      runId: "arun_new",
      status: "queued",
      mode: "agent",
      workflowType: "investigation",
      workflowSource: "chosen",
      workflowReading: "unrecorded",
      autoExecute: false,
      // Echoed from the RECORD, so a run that started its own conversation reports
      // the thread of one the fold gave it rather than nothing at all.
      thread: { threadId: "arun_new", steps: [], text: "" },
    });
    // No `workflowType` reaches the service when the body named none: the store's
    // own default is the single place that answer is decided.
    expect(mockStart).toHaveBeenCalledWith({
      mode: "agent",
      actor: { sessionId: "ada", role: "user" },
      connectionId: "seed:sales",
      // The database behind that record, fingerprinted by the route (B68). Asserted as a
      // presence here and by value in the re-pointing test below.
      connectionIdentity: expect.any(String),
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
      // The database behind that record, fingerprinted by the route (B68). Asserted as a
      // presence here and by value in the re-pointing test below.
      connectionIdentity: expect.any(String),
      objective: "why is checkout slow",
    });
  });

  test("every workflow type this server serves is accepted", async () => {
    for (const workflowType of [
      "investigation",
      "query-optimization",
      "database-assessment",
      "operations",
      "data-analysis",
    ]) {
      const res = await POST(startRequest({ ...VALID_BODY, workflowType }));
      expect(res.status, workflowType).toBe(202);
    }
  });

  test("auto-execute is persisted when asked for, and the response echoes what was PERSISTED", async () => {
    const res = await POST(startRequest({ ...VALID_BODY, workflowType: "data-analysis", autoExecute: true }));
    const body = await parseResponseJSON<{ autoExecute: boolean }>(res);

    expect(res.status).toBe(202);
    expect(body.autoExecute).toBe(true);
    expect(mockStart).toHaveBeenCalledWith({
      mode: "agent",
      workflowType: "data-analysis",
      autoExecute: true,
      actor: { sessionId: "ada", role: "user" },
      connectionId: "seed:sales",
      // The database behind that record, fingerprinted by the route (B68). Asserted as a
      // presence here and by value in the re-pointing test below.
      connectionIdentity: expect.any(String),
      objective: "why is checkout slow",
    });
  });

  test("auto-execute is refused on every workflow that cannot present an answer", async () => {
    // The hand-over IS `present_answer`'s, and that tool is offered to `data-analysis`
    // alone. Accepting the field elsewhere would persist a run record claiming a
    // hand-over nothing could perform and would have the system prompt tell the model
    // to inspect the plan of a presentation it has no tool to make — the #350/#356
    // shape. Refused rather than normalised to `false`, because a silent downgrade is
    // how a user comes to believe a feature ran.
    for (const workflowType of ["investigation", "query-optimization", "database-assessment", "operations"]) {
      const res = await POST(startRequest({ ...VALID_BODY, workflowType, autoExecute: true }));
      expect(res.status, workflowType).toBe(400);
      const body = await parseResponseJSON<{ error: string }>(res);
      expect(body.error, workflowType).toContain("data-analysis");
    }
    // Absent workflow means an investigation, which is one of the four above — so the
    // default must be refused too rather than slipping past the named cases.
    expect((await POST(startRequest({ ...VALID_BODY, autoExecute: true }))).status).toBe(400);
  });

  test("auto-execute is refused in planning mode, which is offered no tools at all", async () => {
    const res = await POST(
      startRequest({ ...VALID_BODY, mode: "planning", workflowType: "data-analysis", autoExecute: true }),
    );

    expect(res.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(res)).error).toContain("agent mode");
  });

  test("auto-execute false is accepted anywhere, because it asks for nothing", async () => {
    // Only `true` claims a hand-over. An explicit `false` is a client saying the
    // setting is off, which every workflow can honour.
    for (const workflowType of ["investigation", "operations", "data-analysis"]) {
      const res = await POST(startRequest({ ...VALID_BODY, workflowType, autoExecute: false }));
      expect(res.status, workflowType).toBe(202);
    }
  });

  test("a body that names no auto-execute reaches the service without the field at all", async () => {
    // The store's own default is the single place the answer is decided, exactly as
    // for `workflowType`: two defaults are two things to keep equal.
    await POST(startRequest(VALID_BODY));

    expect(mockStart).toHaveBeenCalledWith({
      mode: "agent",
      actor: { sessionId: "ada", role: "user" },
      connectionId: "seed:sales",
      // The database behind that record, fingerprinted by the route (B68). Asserted as a
      // presence here and by value in the re-pointing test below.
      connectionIdentity: expect.any(String),
      objective: "why is checkout slow",
    });
  });

  test.each([["yes"], [1], [null], [{}]])("an auto-execute of %p is refused rather than defaulted", async (value) => {
    // Not coerced: a caller whose serialiser turned a tick into "yes" has asked for
    // something this route will not guess at, and guessing WRONG here gives away the
    // editor's time limit on a statement nobody agreed to.
    const res = await POST(startRequest({ ...VALID_BODY, autoExecute: value }));

    expect(res.status).toBe(400);
    expect(mockStart).not.toHaveBeenCalled();
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

  test("a body that names no workflow source reaches the service without the field at all", async () => {
    // Same reason as `workflowType` and `autoExecute`: the store's default is the one
    // place "nobody said" becomes an answer, and a request written before the field
    // existed must still reach the store as exactly that request.
    const res = await POST(startRequest(VALID_BODY));
    const body = await parseResponseJSON<{ workflowSource: string }>(res);

    expect(body.workflowSource).toBe("chosen");
    expect(mockStart).toHaveBeenCalledWith({
      mode: "agent",
      actor: { sessionId: "ada", role: "user" },
      connectionId: "seed:sales",
      // The database behind that record, fingerprinted by the route (B68). Asserted as a
      // presence here and by value in the re-pointing test below.
      connectionIdentity: expect.any(String),
      objective: "why is checkout slow",
    });
  });

  test("an inferred workflow source is persisted, and the response echoes what was PERSISTED", async () => {
    const res = await POST(startRequest({ ...VALID_BODY, workflowSource: "inferred" }));
    const body = await parseResponseJSON<{ workflowSource: string }>(res);

    expect(res.status).toBe(202);
    expect(body.workflowSource).toBe("inferred");
    expect(mockStart).toHaveBeenCalledWith({
      mode: "agent",
      workflowSource: "inferred",
      actor: { sessionId: "ada", role: "user" },
      connectionId: "seed:sales",
      // The database behind that record, fingerprinted by the route (B68). Asserted as a
      // presence here and by value in the re-pointing test below.
      connectionIdentity: expect.any(String),
      objective: "why is checkout slow",
    });
  });

  test("both workflow sources this server records are accepted", async () => {
    for (const workflowSource of ["inferred", "chosen"]) {
      const res = await POST(startRequest({ ...VALID_BODY, workflowSource }));
      expect(res.status, workflowSource).toBe(202);
    }
  });

  test.each([["guessed"], [7], [null], [{}]])(
    "a workflow source of %p is refused rather than defaulted",
    async (value) => {
      // The field is the record of how the run's workflow was decided, and the rail
      // reads it back to decide whether to offer "change". A value this server does
      // not record, quietly folded to `"chosen"`, would have the surface tell the user
      // they picked a workflow they never saw.
      const res = await POST(startRequest({ ...VALID_BODY, workflowSource: value }));

      expect(res.status).toBe(400);
      expect(mockStart).not.toHaveBeenCalled();
    },
  );

  test("a body that names no workflow reading reaches the service without the field at all", async () => {
    // The third field to follow this rule, and for the third time the same reason: the
    // store's default is the one place "nobody said" becomes an answer.
    const res = await POST(startRequest(VALID_BODY));
    const body = await parseResponseJSON<{ workflowReading: string }>(res);

    expect(body.workflowReading).toBe("unrecorded");
    expect(mockStart).toHaveBeenCalledWith({
      mode: "agent",
      actor: { sessionId: "ada", role: "user" },
      connectionId: "seed:sales",
      // The database behind that record, fingerprinted by the route (B68). Asserted as a
      // presence here and by value in the re-pointing test below.
      connectionIdentity: expect.any(String),
      objective: "why is checkout slow",
    });
  });

  test("a failed reading is persisted as one, and the response echoes what was PERSISTED", async () => {
    const res = await POST(
      startRequest({ ...VALID_BODY, workflowSource: "inferred", workflowReading: "unclassified" }),
    );
    const body = await parseResponseJSON<{ workflowReading: string }>(res);

    expect(res.status).toBe(202);
    // The point of persisting it: a rail that reloads reads THIS back, and a fallback
    // read back as a verdict is the one thing the "opened as" sentence may not do.
    expect(body.workflowReading).toBe("unclassified");
    expect(mockStart).toHaveBeenCalledWith({
      mode: "agent",
      workflowSource: "inferred",
      workflowReading: "unclassified",
      actor: { sessionId: "ada", role: "user" },
      connectionId: "seed:sales",
      // The database behind that record, fingerprinted by the route (B68). Asserted as a
      // presence here and by value in the re-pointing test below.
      connectionIdentity: expect.any(String),
      objective: "why is checkout slow",
    });
  });

  test("all three workflow readings this server records are accepted", async () => {
    for (const workflowReading of ["classified", "unclassified", "unrecorded"]) {
      const res = await POST(startRequest({ ...VALID_BODY, workflowReading }));
      expect(res.status, workflowReading).toBe(202);
    }
  });

  test.each([["read"], [7], [null], [{}]])(
    "a workflow reading of %p is refused rather than defaulted",
    async (value) => {
      // Same rule as the source above: this field decides which of three sentences the
      // surface says about the run, so an unrecognised value folded into one of them
      // would have the UI report an outcome nobody recorded.
      const res = await POST(startRequest({ ...VALID_BODY, workflowReading: value }));

      expect(res.status).toBe(400);
      expect(mockStart).not.toHaveBeenCalled();
    },
  );

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

  test("the surface does not exist once the operator switches the agent off", async () => {
    process.env[AGENT_ENABLED_ENV] = "false";

    const res = await POST(startRequest(VALID_BODY));

    expect(res.status).toBe(404);
    expect(mockStart).not.toHaveBeenCalled();
  });

  test("the surface does not exist when no model is configured at all", async () => {
    // The other half of the derived answer (#331 T5). A server with the AI
    // configuration removed has no agent to route to, and says so the same way.
    for (const key of ["LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL", "LLM_API_URL"]) delete process.env[key];

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

  test("the surface does not exist once the operator switches the agent off", async () => {
    process.env[AGENT_ENABLED_ENV] = "false";

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
