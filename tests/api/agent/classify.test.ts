/**
 * `POST /api/agent/classify` — the endpoint the rail calls between the Start press
 * and the run opening
 * (`docs/superpowers/specs/2026-08-16-agent-workflow-inference-design.md`).
 *
 * What these pin, beyond the shape checks: the session is verified before the
 * runtime flag is read, so an unauthenticated caller cannot use this route to learn
 * whether an agent surface exists here; and the route never turns a classifier
 * outcome into an error, because the classifier's whole contract is that it always
 * answers.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { configureAgentModel, restoreAgentModel } from "../../helpers/agent-model-env";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { AGENT_MAX_OBJECTIVE_LENGTH } from "@/lib/agent/execution-policy";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import * as realAuth from "@/lib/auth";
import * as realClassifier from "@/lib/agent/workflow-classifier";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "ada" }),
);

const mockClassify = mock<typeof realClassifier.classifyAgentWorkflow>(async () => ({
  workflowType: "query-optimization",
  outcome: "classified",
}));

/**
 * Re-applied in `beforeEach` as well as at import time: `mock.module` replaces a
 * module process-wide, so the file currently running has to own the module whatever
 * order the runner loaded the agent suites in.
 */
function installMocks(): void {
  mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
  mock.module("@/lib/agent/workflow-classifier", () => ({
    ...realClassifier,
    classifyAgentWorkflow: mockClassify,
  }));
}

installMocks();

const { POST } = await import("@/app/api/agent/classify/route");

function classifyRequest(body: unknown): Request {
  return createMockRequest("/api/agent/classify", { method: "POST", body });
}

beforeEach(() => {
  installMocks();
  clearRateLimitState();
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
  mockClassify.mockClear();
  mockClassify.mockImplementation(async () => ({ workflowType: "query-optimization", outcome: "classified" }));
});

afterEach(() => {
  restoreAgentModel();
});

describe("POST /api/agent/classify", () => {
  test("an unauthenticated caller is refused before anything is classified", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(classifyRequest({ objective: "why is checkout slow" }));

    expect(res.status).toBe(401);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  /*
    The order matters and is the reason this test exists beside the one above: the
    401 is decided before the runtime flag is read, so the 404 is only ever visible
    to a caller who already has a session. An unauthenticated probe of this route
    learns nothing about whether the operator enabled an agent.
  */
  test("the surface does not exist once the operator switches the agent off", async () => {
    process.env[AGENT_ENABLED_ENV] = "false";

    const res = await POST(classifyRequest({ objective: "why is checkout slow" }));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(404);
    expect(body.error).toBe("The agent runtime is not enabled on this server");
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("a body that is not JSON is refused", async () => {
    const res = await POST(
      new Request("http://localhost/api/agent/classify", { method: "POST", body: "not json at all" }),
    );
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe("Request body must be JSON");
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("a missing objective is refused", async () => {
    const res = await POST(classifyRequest({}));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe("objective must be a non-empty string");
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("an objective of nothing but whitespace is refused", async () => {
    const res = await POST(classifyRequest({ objective: "   \n  " }));

    expect(res.status).toBe(400);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("an objective past the run route's own bound is refused", async () => {
    const res = await POST(classifyRequest({ objective: "x".repeat(AGENT_MAX_OBJECTIVE_LENGTH + 1) }));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe(`objective must be at most ${AGENT_MAX_OBJECTIVE_LENGTH} characters`);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("a classified objective answers with the workflow the classifier named", async () => {
    const res = await POST(classifyRequest({ objective: "this update takes 40 seconds, why" }));
    const body = await parseResponseJSON<{ workflowType: string; outcome: string }>(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({ workflowType: "query-optimization", outcome: "classified" });
    expect(mockClassify).toHaveBeenCalledWith("this update takes 40 seconds, why");
  });

  /*
    The fallback is a 200, not an error. The classifier resolves rather than rejects
    for exactly this reason: the rail is about to open a run that works either way,
    and `outcome` is what lets it say "opened as Ask, could not classify" instead of
    presenting the default as a verdict.
  */
  test("an unclassified objective is a successful answer carrying the fallback", async () => {
    mockClassify.mockImplementation(async () => ({ workflowType: "investigation", outcome: "unclassified" }));

    const res = await POST(classifyRequest({ objective: "hello" }));
    const body = await parseResponseJSON<{ workflowType: string; outcome: string }>(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({ workflowType: "investigation", outcome: "unclassified" });
  });

  /*
    The classifier's contract says it never throws, so nothing here should ever reach
    the catch — but the route keeps one anyway, because a contract is a promise about
    a module and not a property of this handler. A 500 that says nothing about the
    server's internals is the repository-wide answer.
  */
  test("an unexpected failure is reported through the shared error response", async () => {
    mockClassify.mockImplementation(async () => {
      throw new Error("classifier exploded");
    });

    const res = await POST(classifyRequest({ objective: "why is checkout slow" }));

    expect(res.status).toBe(500);
  });
});
