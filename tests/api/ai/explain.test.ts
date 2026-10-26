import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createMockRequest, readStreamResponse, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { API_CODES } from "@/lib/governance/contract";
import { validateSettings } from "@/lib/governance/settings";
import { recordGovernanceSnapshot, resetGovernanceState } from "@/lib/governance/state";
import { grantedSnapshot } from "../../helpers/governance/granted-snapshot";

// ─── Mock helpers ───────────────────────────────────────────────────────────

function createMockStream(text = "mock response") {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

class MockLLMError extends Error {
  statusCode?: number;
  constructor(msg: string, _provider?: string, code?: number) {
    super(msg);
    this.name = "LLMError";
    this.statusCode = code;
  }
}
class MockLLMConfigError extends MockLLMError {
  constructor(msg: string) {
    super(msg);
    this.name = "LLMConfigError";
  }
}
class MockLLMAuthError extends MockLLMError {
  constructor(msg: string) {
    super(msg, undefined, 401);
    this.name = "LLMAuthError";
  }
}
class MockLLMRateLimitError extends MockLLMError {
  constructor(msg: string) {
    super(msg, undefined, 429);
    this.name = "LLMRateLimitError";
  }
}
class MockLLMSafetyError extends MockLLMError {
  constructor(msg: string) {
    super(msg, undefined, 400);
    this.name = "LLMSafetyError";
  }
}
class MockLLMStreamError extends MockLLMError {
  constructor(msg: string) {
    super(msg);
    this.name = "LLMStreamError";
  }
}

// ─── Mock @/lib/llm BEFORE importing the route ─────────────────────────────

const mockStream = mock(async () => createMockStream());
const mockProvider = { stream: mockStream };
const mockCreateLLMProvider = mock(async () => mockProvider);

mock.module("@/lib/llm", () => ({
  createLLMProvider: mockCreateLLMProvider,
  LLMError: MockLLMError,
  LLMConfigError: MockLLMConfigError,
  LLMAuthError: MockLLMAuthError,
  LLMRateLimitError: MockLLMRateLimitError,
  LLMSafetyError: MockLLMSafetyError,
}));

mock.module("@/lib/llm/types", () => ({
  LLMError: MockLLMError,
  LLMConfigError: MockLLMConfigError,
  LLMAuthError: MockLLMAuthError,
  LLMRateLimitError: MockLLMRateLimitError,
  LLMSafetyError: MockLLMSafetyError,
  LLMStreamError: MockLLMStreamError,
  /*
    Same whole-module mock requirement: `errors.ts` imports `isContextLengthError`
    and route handlers import `MAX_SCHEMA_CONTEXT_CHARS`.
  */
  isContextLengthError: (error: unknown): boolean =>
    (error instanceof MockLLMStreamError || error instanceof Error) &&
    error.message.includes("exceeds the available context size"),
  MAX_SCHEMA_CONTEXT_CHARS: 30_000,
}));

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  readSession: mock(async () => {
    const s = await mockGetSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  }),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────

const { POST } = await import("@/app/api/ai/explain/route");

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/ai/explain", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockCreateLLMProvider.mockClear();
    mockStream.mockClear();
    mockCreateLLMProvider.mockImplementation(async () => mockProvider);
    mockStream.mockImplementation(async () => createMockStream());
  });

  test("returns streaming response with query and explainPlan", async () => {
    const req = createMockRequest("/api/ai/explain", {
      method: "POST",
      body: {
        query: "SELECT * FROM users WHERE id = 1",
        explainPlan: { "Node Type": "Seq Scan", "Relation Name": "users" },
        databaseType: "postgres",
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");

    const text = await readStreamResponse(res);
    expect(text).toBe("mock response");
    expect(mockCreateLLMProvider).toHaveBeenCalledTimes(1);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  test("returns 400 when query is missing", async () => {
    const req = createMockRequest("/api/ai/explain", {
      method: "POST",
      body: { explainPlan: {}, databaseType: "postgres" },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain("required");
  });

  test("returns streaming response with schemaContext", async () => {
    const req = createMockRequest("/api/ai/explain", {
      method: "POST",
      body: {
        query: "SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id",
        schemaContext: "users(id, name), orders(id, user_id, total)",
        databaseType: "postgres",
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const text = await readStreamResponse(res);
    expect(text).toBe("mock response");

    const callArgs = (mockStream.mock.calls as unknown[][])[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(callArgs.messages[0].content).toContain("users(id, name)");
  });

  test("returns 503 on LLMConfigError", async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMConfigError("LLM not configured");
    });

    const req = createMockRequest("/api/ai/explain", {
      method: "POST",
      body: { query: "SELECT 1" },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(503);
  });

  test("returns 401 on LLMAuthError", async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMAuthError("Invalid API key");
    });

    const req = createMockRequest("/api/ai/explain", {
      method: "POST",
      body: { query: "SELECT 1" },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  test("returns 429 on LLMRateLimitError", async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMRateLimitError("Rate limit");
    });

    const req = createMockRequest("/api/ai/explain", {
      method: "POST",
      body: { query: "SELECT 1" },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(429);
  });

  test("returns 400 on LLMSafetyError", async () => {
    mockStream.mockImplementation(async () => {
      throw new MockLLMSafetyError("Blocked");
    });

    const req = createMockRequest("/api/ai/explain", {
      method: "POST",
      body: { query: "SELECT 1" },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  test("returns custom status code on LLMError with statusCode", async () => {
    mockStream.mockImplementation(async () => {
      throw new MockLLMError("Service unavailable", undefined, 503);
    });

    const req = createMockRequest("/api/ai/explain", {
      method: "POST",
      body: { query: "SELECT 1" },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(503);
  });
});

/**
 * Under governance the control plane's `ai.enabled` decides whether the AI bucket answers at all
 * (docs/GOVERNANCE.md#runtime-settings). `false` refuses before any provider is built; `true` adds nothing the
 * environment did not configure, so a server without an LLM keeps answering as it does today.
 */
describe("POST /api/ai/explain under governance", () => {
  let savedSource: string | undefined;

  const governWith = (aiEnabled: boolean) => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    recordGovernanceSnapshot({
      ...grantedSnapshot([], []),
      settings: validateSettings([{ key: "ai.enabled", value: aiEnabled, updated_at: new Date() }], 1),
    });
  };

  beforeEach(() => {
    savedSource = process.env.GOVERNANCE_SOURCE;
    clearRateLimitState();
    mockCreateLLMProvider.mockClear();
    mockStream.mockClear();
    mockCreateLLMProvider.mockImplementation(async () => mockProvider);
    mockStream.mockImplementation(async () => createMockStream());
  });

  afterEach(() => {
    resetGovernanceState();
    if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = savedSource;
  });

  test("governance: ai.enabled=false answers 403 AI_DISABLED", async () => {
    governWith(false);

    const res = await POST(
      createMockRequest("/api/ai/explain", { method: "POST", body: { query: "SELECT 1" } }) as never,
    );

    expect(res.status).toBe(403);
    expect(await parseResponseJSON<Record<string, unknown>>(res)).toEqual({
      error: "AI assistance is switched off on this server",
      code: "AI_DISABLED",
      statusCode: 403,
    });
    // The status and the code are the ones governance contract v1 publishes for this refusal
    // (docs/GOVERNANCE.md#api-codes).
    const published: readonly { code: string; httpStatus: number }[] = API_CODES;
    expect(published).toContainEqual({ code: "AI_DISABLED", httpStatus: res.status });
    expect(mockCreateLLMProvider).not.toHaveBeenCalled();
  });

  test("governance: ai.enabled=false still answers 401 to a caller without a session", async () => {
    governWith(false);
    mockGetSession.mockImplementationOnce(async () => null);

    const res = await POST(
      createMockRequest("/api/ai/explain", { method: "POST", body: { query: "SELECT 1" } }) as never,
    );

    expect(res.status).toBe(401);
  });

  test("governance: ai.enabled=true without a configured LLM keeps today's answer", async () => {
    governWith(true);
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMConfigError("LLM not configured");
    });

    const res = await POST(
      createMockRequest("/api/ai/explain", { method: "POST", body: { query: "SELECT 1" } }) as never,
    );

    expect(res.status).toBe(503);
  });

  test("governance: ai.enabled=true with a configured LLM answers as without governance", async () => {
    governWith(true);

    const res = await POST(
      createMockRequest("/api/ai/explain", { method: "POST", body: { query: "SELECT 1" } }) as never,
    );

    expect(res.status).toBe(200);
    expect(await readStreamResponse(res)).toBe("mock response");
  });
});
