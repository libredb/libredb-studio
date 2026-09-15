/**
 * `GET /api/agent/runs` — the run history list route (#830).
 *
 * Pinned here rather than folded into `runs.test.ts` because that file mocks
 * `@/lib/agent/runtime` for the start/status/cancel surface, and this route
 * reaches a different method on the same service. Per-file isolation
 * (`tests/run-core.sh`) makes that separation structural instead of a comment
 * two suites have to remember.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { configureAgentModel, restoreAgentModel } from "../../helpers/agent-model-env";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { AgentHistoryCursor, AgentHistoryPage } from "@/lib/agent/history";
import type { AgentConversationSummary } from "@/lib/agent/types";
import * as realAuth from "@/lib/auth";
import * as realRuntime from "@/lib/agent/runtime";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "ada" }),
);

const mockListConversations = mock(
  async (
    _sessionId: string,
    _options?: { readonly limit?: number; readonly cursor?: AgentHistoryCursor },
  ): Promise<AgentHistoryPage> => ({ conversations: [], nextCursor: null }),
);

function installMocks(): void {
  mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
  // Spread over the real runtime rather than listing its exports: the route
  // statically imports `driveAgentRun` too, and a partial replacement would
  // leave that named export missing for every later file in the same process.
  mock.module("@/lib/agent/runtime", () => ({
    ...realRuntime,
    getAgentRunService: mock(async () => ({ listConversations: mockListConversations })),
  }));
}

installMocks();

const { GET } = await import("@/app/api/agent/runs/route");

const conversation = (threadId: string, updatedAtMs: number): AgentConversationSummary => ({
  threadId,
  steps: [
    {
      runId: `arun_${threadId}`,
      objective: "Why is checkout slow?",
      workflowType: "investigation",
      mode: "agent",
      status: "succeeded",
      answered: true,
      connectionId: "seed:sales",
      createdAtMs: updatedAtMs - 1_000,
      updatedAtMs,
    },
  ],
});

beforeEach(() => {
  installMocks();
  clearRateLimitState();
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
  mockListConversations.mockClear();
  mockListConversations.mockResolvedValue({ conversations: [], nextCursor: null });
});

afterEach(() => {
  restoreAgentModel();
});

describe("GET /api/agent/runs", () => {
  test("lists the session's conversations and the cursor", async () => {
    mockListConversations.mockResolvedValue({
      conversations: [conversation("t_1", 2_000)],
      nextCursor: "2000.t_1",
    });

    const res = await GET(createMockRequest("/api/agent/runs"));
    const body = await parseResponseJSON<{ conversations: unknown[]; nextCursor: string }>(res);

    expect(res.status).toBe(200);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]).toMatchObject({ threadId: "t_1" });
    expect(body.nextCursor).toBe("2000.t_1");
  });

  test("scopes the call to the verified session's username", async () => {
    mockGetSession.mockResolvedValue({ role: "user", username: "grace" });

    await GET(createMockRequest("/api/agent/runs"));

    expect(mockListConversations.mock.calls[0]?.[0]).toBe("grace");
  });

  test("passes a valid cursor through and clamps the limit", async () => {
    await GET(createMockRequest("/api/agent/runs?limit=10&cursor=2000.t_1"));

    expect(mockListConversations.mock.calls[0]?.[1]).toEqual({
      limit: 10,
      cursor: { updatedAtMs: 2000, threadId: "t_1" },
    });
  });

  test("clamps a huge limit to the page maximum", async () => {
    await GET(createMockRequest("/api/agent/runs?limit=100000"));

    expect(mockListConversations.mock.calls[0]?.[1]?.limit).toBe(100);
  });

  test.each(["?limit=0", "?limit=-3", "?limit=abc", "?limit=1.5"])("refuses the malformed limit %j", async (query) => {
    const res = await GET(createMockRequest(`/api/agent/runs${query}`));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe("limit must be a positive integer");
    expect(mockListConversations.mock.calls).toHaveLength(0);
  });

  test("refuses a cursor this build cannot read", async () => {
    const res = await GET(createMockRequest("/api/agent/runs?cursor=not-a-cursor"));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe("cursor is not a valid history cursor");
    expect(mockListConversations.mock.calls).toHaveLength(0);
  });

  test("returns 401 without a session", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await GET(createMockRequest("/api/agent/runs"));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(body.error).toBe("Authentication required");
  });

  test("returns 404 while the agent runtime is off", async () => {
    process.env[AGENT_ENABLED_ENV] = "false";

    const res = await GET(createMockRequest("/api/agent/runs"));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(404);
    expect(body.error).toBe("The agent runtime is not enabled on this server");
  });

  test("maps a service failure through the shared error mapper", async () => {
    mockListConversations.mockRejectedValue(new Error("backend down"));

    const res = await GET(createMockRequest("/api/agent/runs"));

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("a session can never name another user's history (P0#1)", async () => {
    // The route derives the scope from the VERIFIED session and has no request
    // parameter through which a caller could supply an identity, so the only
    // username the service can be asked for is the one the session is.
    mockGetSession.mockResolvedValue({ role: "user", username: "grace" });
    mockListConversations.mockResolvedValue({ conversations: [conversation("t_grace", 2_000)], nextCursor: null });

    const res = await GET(createMockRequest("/api/agent/runs"));
    const body = await parseResponseJSON<{ conversations: { threadId: string }[] }>(res);

    expect(mockListConversations.mock.calls[0]?.[0]).toBe("grace");
    expect(body.conversations[0]?.threadId).toBe("t_grace");
  });

  test.each<[string, number]>([
    ["?limit=020", 20],
    ["?limit=0000000000000000000000007", 7],
    ["?limit=999999999999999999", 100], // clamped, not trusted
  ])("accepts the decimal spelling %j and resolves it to %j (P1#14)", async (query, expected) => {
    mockListConversations.mockResolvedValue({ conversations: [], nextCursor: null });

    await GET(createMockRequest(`/api/agent/runs${query}`));

    expect(mockListConversations.mock.calls[0]?.[1]?.limit).toBe(expected);
  });

  test.each(["?limit=1e10", "?limit=", "?limit=%20", "?limit=NaN", "?limit=Infinity"])(
    "refuses the non-decimal limit %j (P1#14)",
    async (query) => {
      const res = await GET(createMockRequest(`/api/agent/runs${query}`));
      const body = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(400);
      expect(body.error).toBe("limit must be a positive integer");
      expect(mockListConversations.mock.calls).toHaveLength(0);
    },
  );
});
