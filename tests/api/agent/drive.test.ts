/**
 * The durable transport's drive callback (#329 T9).
 *
 * This is the one path a caller reaches without a user session, so what it refuses
 * matters more than what it does. It authenticates with its own single-purpose
 * credential; a user session is not one, and the run it drives is named by the
 * credential rather than by the request body.
 *
 * `installMocks` is re-applied in `beforeEach` rather than only at import time, and
 * that is not belt-and-braces: `mock.module` replaces a module process-wide, and
 * `tests/api/agent/runs.test.ts` mocks the same runtime module in the same process
 * under `bun run test`. Re-registering makes the file that is currently running own
 * the module, whatever order the runner loaded them in.
 */

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { SignJWT } from "jose";
import { configureAgentModel, restoreAgentModel } from "../../helpers/agent-model-env";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { AGENT_DRIVE_HEADER, mintAgentDriveToken } from "@/lib/agent/drive-token";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { AgentRunServiceError } from "@/lib/agent/run-service";
import { clearRateLimitState } from "@/lib/api/rate-limit";

const mockDriveAgentRun = mock(async (runId: string) => ({
  runId,
  status: "succeeded",
  stopReason: "report-composed",
  turns: 3,
  text: "done",
}));

function installMocks(): void {
  mock.module("@/lib/agent/runtime", () => ({
    driveAgentRun: mockDriveAgentRun,
    getAgentRunService: mock(async () => ({})),
    // Unused here, and listed anyway: `mock.module` replaces the module for the whole
    // process, so an export this file forgets is an export the NEXT file's route
    // cannot import (`tests/api/agent/artifacts.test.ts` reaches for exactly this one).
    readAgentArtifact: mock(() => undefined),
  }));
}

installMocks();

const { POST } = await import("@/app/api/agent/drive/route");

const RUN_ID = "arun_0123456789abcdef";

function driveRequest(options: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers[AGENT_DRIVE_HEADER] = options.token;
  return createMockRequest("/api/agent/drive", { method: "POST", headers, body: options.body ?? {} });
}

beforeEach(() => {
  installMocks();
  clearRateLimitState();
  mockDriveAgentRun.mockClear();
  // A configured model is what makes the surface exist since #331 T5; the flag is
  // only the off-switch, so the absence test below sets it to a negative value.
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
});

afterEach(() => {
  restoreAgentModel();
});

describe("POST /api/agent/drive", () => {
  test("a valid credential drives the run it names", async () => {
    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));
    const body = await parseResponseJSON<{ runId: string; status: string }>(res);

    expect(res.status).toBe(200);
    expect(body.runId).toBe(RUN_ID);
    expect(body.status).toBe("succeeded");
    expect(mockDriveAgentRun).toHaveBeenCalledWith(RUN_ID);
  });

  test("the run driven is the credential's, never the body's", async () => {
    await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID), body: { runId: "arun_someoneelse" } }));

    expect(mockDriveAgentRun).toHaveBeenCalledWith(RUN_ID);
  });

  test("no credential drives nothing", async () => {
    const res = await POST(driveRequest());

    expect(res.status).toBe(401);
    expect(mockDriveAgentRun).not.toHaveBeenCalled();
  });

  test("a token signed with the session secret is not a drive credential", async () => {
    // It carries a well-formed `runId` as well as session claims, so the only thing
    // that can refuse it is the key separation — a probe missing the runId would
    // still be rejected on shape if the two keys were ever collapsed into one.
    const session = await new SignJWT({ runId: RUN_ID, role: "admin", username: "root" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET as string));

    const res = await POST(driveRequest({ token: session }));

    expect(res.status).toBe(401);
    expect(mockDriveAgentRun).not.toHaveBeenCalled();
  });

  test("a broken audit sink still refuses the caller", async () => {
    // The emit is isolated in its own try/catch: the 401 is already decided, and a
    // failing audit sink must not turn a refusal into an unrelated 500.
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const res = await POST(driveRequest());

      expect(res.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  test("an expired credential drives nothing", async () => {
    const stale = await mintAgentDriveToken(RUN_ID, () => Date.now() - 120_000);

    const res = await POST(driveRequest({ token: stale }));

    expect(res.status).toBe(401);
    expect(mockDriveAgentRun).not.toHaveBeenCalled();
  });

  test("the callback does not exist once the operator switches the agent off", async () => {
    process.env[AGENT_ENABLED_ENV] = "false";

    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));

    expect(res.status).toBe(404);
    expect(mockDriveAgentRun).not.toHaveBeenCalled();
  });

  test("a run that does not exist is a 404", async () => {
    mockDriveAgentRun.mockRejectedValueOnce(new AgentRunServiceError("RUN_NOT_FOUND", "gone"));

    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));

    expect(res.status).toBe(404);
  });

  test("a run that has already ended is a conflict, not a failure", async () => {
    mockDriveAgentRun.mockRejectedValueOnce(new AgentRunServiceError("RUN_NOT_RESUMABLE", "already succeeded"));

    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));

    expect(res.status).toBe(409);
  });

  test("a drive that fails for any other reason reports a failure", async () => {
    mockDriveAgentRun.mockRejectedValueOnce(new Error("model unreachable"));

    const res = await POST(driveRequest({ token: await mintAgentDriveToken(RUN_ID) }));

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("deliveries for one run are rate limited like every other model-reaching route", async () => {
    const token = await mintAgentDriveToken(RUN_ID);
    let last = 0;
    for (let attempt = 0; attempt < 21; attempt++) {
      last = (await POST(driveRequest({ token }))).status;
    }

    expect(last).toBe(429);
  });
});
