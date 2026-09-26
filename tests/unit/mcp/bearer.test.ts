/**
 * The one bearer gate /api/mcp has (#246), shared by src/proxy.ts and the route: the SDK's own
 * header parsing and challenge, the MCP token verifier behind it, the reason a denial is audited
 * under, and a server fault told apart from a bad token.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { bearerAuthChallengeResponse, verifyBearerToken, type AuthInfo } from "@modelcontextprotocol/server";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";
import { MCP_BEARER_OPTIONS, type McpDenialReason, auditMcpDenial, authenticateMcpRequest } from "@/lib/mcp/bearer";
import { MCP_TOKEN_INVALID_MESSAGE } from "@/lib/mcp/token";
import { MCP_TEST_URL } from "../../helpers/mcp-harness";
import { mintTestToken, useMcpChannel } from "../../helpers/mcp-token";

let restore: () => void = () => {};

beforeEach(() => {
  restore = useMcpChannel();
  clearRateLimitState();
});

afterEach(() => {
  restore();
  clearRateLimitState();
});

const CHALLENGE = (description: string) =>
  `Bearer error="invalid_token", error_description="${description}", scope="mcp:read"`;

function withAuthorization(value?: string): Request {
  return new Request(MCP_TEST_URL, {
    method: "POST",
    headers: { host: "localhost:3000", ...(value === undefined ? {} : { authorization: value }) },
  });
}

async function expectDenied(request: Request, reason: McpDenialReason, description: string): Promise<void> {
  const answer = await authenticateMcpRequest(request);
  expect(answer.kind).toBe("denied");
  if (answer.kind !== "denied") return;
  expect(answer.reason).toBe(reason);
  expect(answer.response.status).toBe(401);
  expect(answer.response.headers.get("www-authenticate")).toBe(CHALLENGE(description));
  expect(await answer.response.json()).toEqual({ error: "invalid_token", error_description: description });
}

describe("authenticateMcpRequest", () => {
  test("admits a minted token with the owner's identity", async () => {
    const answer = await authenticateMcpRequest(
      withAuthorization(`Bearer ${await mintTestToken({ username: "bob", role: "user" })}`),
    );
    expect(answer.kind).toBe("authenticated");
    if (answer.kind !== "authenticated") return;
    expect(answer.authInfo.extra).toEqual({ username: "bob", role: "user" });
    expect(answer.authInfo.scopes).toEqual(["mcp:read"]);
    expect(answer.authInfo.resource).toEqual(new URL(MCP_TEST_URL));
  });

  test("reads only the first comma segment of Authorization, as the SDK's own gate does", async () => {
    const answer = await authenticateMcpRequest(withAuthorization(`Bearer ${await mintTestToken()}, Bearer junk`));
    expect(answer.kind).toBe("authenticated");
  });

  test("denies a missing header as mcp_token_invalid with the SDK's words", async () => {
    await expectDenied(withAuthorization(), "mcp_token_invalid", "Missing Authorization header");
  });

  test("denies another scheme as mcp_token_invalid with the SDK's words", async () => {
    await expectDenied(
      withAuthorization("Basic YWxpY2U6c2VjcmV0"),
      "mcp_token_invalid",
      "Invalid Authorization header format, expected 'Bearer TOKEN'",
    );
  });

  test("denies a forged token with the one sentence every token fault gets", async () => {
    await expectDenied(
      withAuthorization("Bearer forged-token-written-in-words"),
      "mcp_token_invalid",
      MCP_TOKEN_INVALID_MESSAGE,
    );
  });

  test("denies any bearer while the label is unset as mcp_channel_unconfigured, with the same body", async () => {
    const token = await mintTestToken();
    restore();
    restore = useMcpChannel({ label: null });
    await expectDenied(withAuthorization(`Bearer ${token}`), "mcp_channel_unconfigured", MCP_TOKEN_INVALID_MESSAGE);
  });

  test("denies a minted token while the URL is unset as mcp_channel_unconfigured", async () => {
    const token = await mintTestToken();
    restore();
    restore = useMcpChannel({ url: null });
    await expectDenied(withAuthorization(`Bearer ${token}`), "mcp_channel_unconfigured", MCP_TOKEN_INVALID_MESSAGE);
  });

  test("answers two identical requests with byte-identical 401s", async () => {
    const [first, second] = await Promise.all([
      authenticateMcpRequest(withAuthorization("Bearer forged-token-written-in-words")),
      authenticateMcpRequest(withAuthorization("Bearer forged-token-written-in-words")),
    ]);
    if (first.kind !== "denied" || second.kind !== "denied") throw new Error("both requests should have been denied");
    expect(await first.response.text()).toBe(await second.response.text());
    expect(first.response.headers.get("www-authenticate")).toBe(second.response.headers.get("www-authenticate"));
  });

  test("never names a resource metadata document in phase 1", async () => {
    const answer = await authenticateMcpRequest(withAuthorization());
    if (answer.kind !== "denied") throw new Error("expected a denial");
    expect(answer.response.headers.get("www-authenticate")).not.toContain("resource_metadata");
  });

  test("reports a server fault as a 500 server_error, logged once, and not as a denial", async () => {
    const token = await mintTestToken();
    const env = process.env as Record<string, string | undefined>;
    const secret = env.JWT_SECRET;
    const mode = env.NODE_ENV;
    delete env.JWT_SECRET;
    env.NODE_ENV = "production";
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const answer = await authenticateMcpRequest(withAuthorization(`Bearer ${token}`));
      expect(answer.kind).toBe("fault");
      if (answer.kind !== "fault") throw new Error("expected a server fault");
      expect(answer.response.status).toBe(500);
      expect(await answer.response.json()).toEqual({
        error: "server_error",
        error_description: "Internal Server Error",
      });
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
      env.JWT_SECRET = secret;
      env.NODE_ENV = mode;
    }
  });
});

describe("the SDK rules the gate relies on, driven with its own options", () => {
  const stub = (info: Partial<AuthInfo>) => ({
    ...MCP_BEARER_OPTIONS,
    verifier: {
      verifyAccessToken: async (token: string): Promise<AuthInfo> => ({
        token,
        clientId: "stub",
        scopes: ["mcp:read"],
        ...info,
      }),
    },
  });

  test("a verifier result without expiresAt is refused with 401", async () => {
    const error = await verifyBearerToken("Bearer x", stub({})).catch((caught: unknown) => caught);
    const response = bearerAuthChallengeResponse(error, MCP_BEARER_OPTIONS);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error_description: string }).error_description).toBe(
      "Token has no expiration time",
    );
  });

  test("insufficient_scope, unreachable with a real token, is a 403 with the challenge", async () => {
    const error = await verifyBearerToken(
      "Bearer x",
      stub({ scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 60 }),
    ).catch((caught: unknown) => caught);
    const response = bearerAuthChallengeResponse(error, MCP_BEARER_OPTIONS);
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });
});

describe("auditMcpDenial", () => {
  const lines = (spy: ReturnType<typeof spyOn<Console, "log">>) =>
    spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

  test("writes one permission_denied line for the anonymous caller, with the reason and the route", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      auditMcpDenial(withAuthorization(), "mcp_token_invalid");
      expect(lines(spy)).toEqual([
        expect.objectContaining({
          event: "permission_denied",
          actor: "anonymous",
          reason: "mcp_token_invalid",
          route: "POST /api/mcp",
        }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("is metered through the anon bucket: RATE_LIMIT_ANON_MAX lines plus the trip", () => {
    process.env.RATE_LIMIT_ANON_MAX = "2";
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 10; i += 1) auditMcpDenial(withAuthorization(), "mcp_host_not_allowed");
      expect(lines(spy)).toHaveLength(3);
    } finally {
      spy.mockRestore();
      delete process.env.RATE_LIMIT_ANON_MAX;
    }
  });

  test("never throws when the sink does, because the refusal is already decided", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(() => auditMcpDenial(withAuthorization(), "origin_mismatch")).not.toThrow();
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
    }
  });
});
