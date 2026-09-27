/**
 * The MCP endpoint's identity boundary (#246).
 *
 * Every /api/mcp request presents a scoped bearer token, and the Studio session cookie opens
 * nothing on this path: a refusal is a 401 with WWW-Authenticate and no redirect, and it is
 * audited on the stdout channel, metered through the anon bucket. Driven through the real
 * proxy() here; the route's own half of the boundary is below it. Every request carries an
 * explicit Host and HOSTNAME is fixed, as csrf-origin.test.ts builds requests.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import * as route from "@/app/api/mcp/route";
import { AGENT_DRIVE_HEADER, AGENT_DRIVE_PATH, mintAgentDriveToken } from "@/lib/agent/drive-token";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { signJWT } from "@/lib/auth";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { logger } from "@/lib/logger";
import { MCP_ENABLED_ENV, MCP_ENABLED_INVALID_MESSAGE } from "@/lib/mcp/config";
import { config, proxy } from "@/proxy";
import { withBasePathEnv } from "../helpers/base-path";
import {
  countMethod,
  createSqliteFile,
  pinMcpTestEnvironment,
  resetMcpTestState,
  writeSeedFile,
} from "../helpers/mcp-fixtures";
import { legacyPost, readJsonRpc, routeServe } from "../helpers/mcp-harness";
import { mintTestToken, useMcpChannel } from "../helpers/mcp-token";
import { mcpRequest, permissionDeniedLines } from "./helpers/mcp-requests";

pinMcpTestEnvironment();

let restoreChannel: () => void = () => {};

beforeEach(() => {
  clearRateLimitState();
  restoreChannel = useMcpChannel();
});

afterEach(() => {
  restoreChannel();
  clearRateLimitState();
});

/** A session JWT the session key signed an hour past its exp, as tests/api/proxy.test.ts builds one. */
async function expiredSession(): Promise<string> {
  return new SignJWT({ username: "alice", role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("-1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

const expectChallenge = async (response: Response, description: string) => {
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toStartWith('Bearer error="invalid_token"');
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.json()).toEqual({ error: "invalid_token", error_description: description });
};

describe("through proxy(), a request to /api/mcp", () => {
  test("without Authorization gets 401, the challenge, a JSON body and no Location", async () => {
    await expectChallenge(await proxy(mcpRequest("POST")), "Missing Authorization header");
  });

  test("with a valid session cookie and no bearer gets 401, not the session", async () => {
    const cookie = await signJWT({ username: "alice", role: "admin" });
    await expectChallenge(
      await proxy(mcpRequest("POST", { cookie: `auth-token=${cookie}` })),
      "Missing Authorization header",
    );
  });

  test("with a valid session cookie and an invalid bearer gets 401", async () => {
    const cookie = await signJWT({ username: "alice", role: "admin" });
    const response = await proxy(
      mcpRequest("POST", { cookie: `auth-token=${cookie}`, authorization: "Bearer forged-token-written-in-words" }),
    );
    await expectChallenge(response, "The MCP token is invalid, expired or revoked");
  });

  test("with a forged or an expired cookie and no bearer gets 401", async () => {
    for (const cookie of ["forged-cookie-written-in-words", await expiredSession()]) {
      await expectChallenge(
        await proxy(mcpRequest("POST", { cookie: `auth-token=${cookie}` })),
        "Missing Authorization header",
      );
    }
  });

  test("with a session JWT sent as the bearer gets 401", async () => {
    const session = await signJWT({ username: "alice", role: "admin" });
    await expectChallenge(
      await proxy(mcpRequest("POST", { authorization: `Bearer ${session}` })),
      "The MCP token is invalid, expired or revoked",
    );
  });

  test("with a drive token sent as the bearer gets 401", async () => {
    const drive = await mintAgentDriveToken("arun_0123456789abcdef");
    expect((await proxy(mcpRequest("POST", { authorization: `Bearer ${drive}` }))).status).toBe(401);
  });

  test("ignores a token in the query string", async () => {
    expect((await proxy(mcpRequest("POST", {}, `/api/mcp?access_token=${await mintTestToken()}`))).status).toBe(401);
  });

  test("with a valid bearer passes to the route", async () => {
    const response = await proxy(mcpRequest("POST", { authorization: `Bearer ${await mintTestToken()}` }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("from a foreign Origin as a POST gets checkOrigin's 403 before the bearer is read", async () => {
    const response = await proxy(mcpRequest("POST", { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("ORIGIN_MISMATCH");
  });

  test("under a nested basePath gets the same answers", async () => {
    await withBasePathEnv("/tools/libredb", async () => {
      const build = (headers: Record<string, string>) =>
        new NextRequest("http://localhost:3000/tools/libredb/api/mcp", {
          nextConfig: { basePath: "/tools/libredb" },
          method: "POST",
          headers: { host: "localhost:3000", "content-type": "application/json", ...headers },
          body: "{}",
        });
      const bare = build({});
      expect(bare.nextUrl.pathname).toBe("/api/mcp");
      expect((await proxy(bare)).status).toBe(401);
      const admitted = await proxy(build({ authorization: `Bearer ${await mintTestToken()}` }));
      expect(admitted.headers.get("x-middleware-next")).toBe("1");
    });
  });
});

describe("through proxy(), the rest of the application", () => {
  test("still redirects /api/db/query without a cookie to /login", async () => {
    const response = await proxy(
      new NextRequest("http://localhost:3000/api/db/query", { headers: { host: "localhost:3000" } }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  test("does not open the drive path for an MCP token", async () => {
    const request = new NextRequest(`http://localhost:3000${AGENT_DRIVE_PATH}`, {
      headers: { host: "localhost:3000" },
    });
    request.headers.set(AGENT_DRIVE_HEADER, await mintTestToken());
    expect((await proxy(request)).status).toBe(307);
  });

  test("refuses a cross-origin POST to the minting endpoint with checkOrigin's 403", async () => {
    const cookie = await signJWT({ username: "alice", role: "admin" });
    const request = new NextRequest("http://localhost:3000/api/mcp/token", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "https://evil.example",
        cookie: `auth-token=${cookie}`,
        "content-type": "application/json",
      },
    });
    const response = await proxy(request);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("ORIGIN_MISMATCH");
  });
});

describe("through proxy(), a refusal on /api/mcp is audited", () => {
  test("a forged bearer writes one line: anonymous, mcp_token_invalid, POST /api/mcp", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await proxy(mcpRequest("POST", { authorization: "Bearer forged-token-written-in-words" }));
      expect(permissionDeniedLines(spy)).toEqual([
        expect.objectContaining({ actor: "anonymous", reason: "mcp_token_invalid", route: "POST /api/mcp" }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a missing header writes the same reason, and a channel without a label writes mcp_channel_unconfigured", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await proxy(mcpRequest("POST"));
      restoreChannel();
      restoreChannel = useMcpChannel({ label: null });
      await proxy(mcpRequest("POST", { authorization: "Bearer any-bearer-written-in-words" }));
      expect(permissionDeniedLines(spy).map((line) => line.reason)).toEqual([
        "mcp_token_invalid",
        "mcp_channel_unconfigured",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a minted token while LIBREDB_MCP_URL is unset writes mcp_channel_unconfigured", async () => {
    const token = await mintTestToken();
    restoreChannel();
    restoreChannel = useMcpChannel({ url: null });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await proxy(mcpRequest("POST", { authorization: `Bearer ${token}` }))).status).toBe(401);
      expect(permissionDeniedLines(spy).map((line) => line.reason)).toEqual(["mcp_channel_unconfigured"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("the lines are bounded to RATE_LIMIT_ANON_MAX plus one per window, the 401s are not", async () => {
    process.env.RATE_LIMIT_ANON_MAX = "2";
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 10; i += 1) expect((await proxy(mcpRequest("POST"))).status).toBe(401);
      expect(permissionDeniedLines(spy)).toHaveLength(3);
    } finally {
      spy.mockRestore();
      delete process.env.RATE_LIMIT_ANON_MAX;
    }
  });

  test("a valid cookie and no bearer writes one line", async () => {
    const cookie = await signJWT({ username: "alice", role: "admin" });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await proxy(mcpRequest("POST", { cookie: `auth-token=${cookie}` }));
      expect(permissionDeniedLines(spy)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a throwing sink leaves the 401 unchanged", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await expectChallenge(await proxy(mcpRequest("POST")), "Missing Authorization header");
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
    }
  });

  test("a verifier fault answers 500 server_error, logs once and writes no line", async () => {
    const env = process.env as Record<string, string | undefined>;
    const secret = env.JWT_SECRET;
    const mode = env.NODE_ENV;
    delete env.JWT_SECRET;
    env.NODE_ENV = "production";
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const response = await proxy(mcpRequest("POST", { authorization: "Bearer any-bearer-written-in-words" }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "server_error", error_description: "Internal Server Error" });
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(permissionDeniedLines(spy)).toEqual([]);
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
      env.JWT_SECRET = secret;
      env.NODE_ENV = mode;
    }
  });
});

const ROOT = resolve(import.meta.dir, "../..");

/** A legacy run_read_query call as a NextRequest, so proxy() and the route can both take it. */
function runQueryRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    legacyPost(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_read_query", arguments: { connection_id: "seed:shop", sql: "SELECT id FROM users" } },
      },
      { headers },
    ),
  );
}

describe("at the route, called directly so the proxy is bypassed", () => {
  test("a missing or a forged bearer gets a 401 byte-identical to the proxy's", async () => {
    const cases: Record<string, string>[] = [{}, { authorization: "Bearer forged-token-written-in-words" }];
    for (const headers of cases) {
      const viaProxy = await proxy(mcpRequest("POST", headers));
      const viaRoute = await route.POST(mcpRequest("POST", headers));
      expect(viaRoute.status).toBe(401);
      expect(await viaRoute.text()).toBe(await viaProxy.text());
      expect(viaRoute.headers.get("www-authenticate")).toBe(viaProxy.headers.get("www-authenticate"));
    }
  });

  test("its bearer refusals write the same permission_denied lines as the proxy's", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await route.POST(mcpRequest("POST", { authorization: "Bearer forged-token-written-in-words" }));
      restoreChannel();
      restoreChannel = useMcpChannel({ label: null });
      await route.GET(mcpRequest("GET", { authorization: "Bearer any-bearer-written-in-words" }));
      expect(permissionDeniedLines(spy).map((line) => [line.actor, line.reason, line.route])).toEqual([
        ["anonymous", "mcp_token_invalid", "POST /api/mcp"],
        ["anonymous", "mcp_channel_unconfigured", "GET /api/mcp"],
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a verifier fault answers 500 server_error, logs once and writes no line", async () => {
    const env = process.env as Record<string, string | undefined>;
    const secret = env.JWT_SECRET;
    const mode = env.NODE_ENV;
    delete env.JWT_SECRET;
    env.NODE_ENV = "production";
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const response = await route.POST(mcpRequest("POST", { authorization: "Bearer any-bearer-written-in-words" }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "server_error", error_description: "Internal Server Error" });
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(permissionDeniedLines(spy)).toEqual([]);
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
      env.JWT_SECRET = secret;
      env.NODE_ENV = mode;
    }
  });

  test("imports and calls neither session reader, so no cookie is read on this path", () => {
    const source = readFileSync(join(ROOT, "src/app/api/mcp/route.ts"), "utf8");
    for (const name of ["guardRoute", "getSession"]) {
      expect(source).not.toMatch(new RegExp(`import[^;]*\\b${name}\\b`));
      expect(source).not.toMatch(new RegExp(`\\b${name}\\s*\\(`));
    }
    // The control: the scan reads the route it names.
    expect(source).toContain("authenticateMcpRequest(");
  });
});

describe("a DELETE with a valid bearer and a JSON content type", () => {
  test("passes proxy(), which alone never answers 405, and the route then answers the SDK's 405 with Allow: POST", async () => {
    const headers = { authorization: `Bearer ${await mintTestToken()}` };
    const viaProxy = await proxy(mcpRequest("DELETE", headers));
    expect(viaProxy.headers.get("x-middleware-next")).toBe("1");
    const viaRoute = await route.DELETE(mcpRequest("DELETE", headers));
    expect(viaRoute.status).toBe(405);
    expect(viaRoute.headers.get("allow")).toBe("POST");
    expect(await viaRoute.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });
});

describe("at the route, the kill switch is read after identity", () => {
  const methods = ["POST", "GET", "DELETE"] as const;

  async function call(method: (typeof methods)[number], token: string): Promise<Response> {
    return routeServe(route)(mcpRequest(method, { authorization: `Bearer ${token}` }));
  }

  test("unset answers a valid token's POST, GET and DELETE with 404 and a plain error object", async () => {
    restoreChannel();
    restoreChannel = useMcpChannel({ enabled: null });
    const token = await mintTestToken();
    for (const method of methods) {
      const response = await call(method, token);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "MCP is not enabled on this server" });
    }
  });

  test.each(["true", "on", "1", " TRUE ", "On"])("%p serves: the SDK answers the GET", async (value) => {
    restoreChannel();
    restoreChannel = useMcpChannel({ enabled: value });
    expect((await call("GET", await mintTestToken())).status).toBe(405);
  });

  test.each(["false", "off", "0", "", "   "])("%p answers 404", async (value) => {
    restoreChannel();
    restoreChannel = useMcpChannel({ enabled: value });
    expect((await call("GET", await mintTestToken())).status).toBe(404);
  });

  test("yes answers every method with 500 naming the variable, never the value, logged once", async () => {
    restoreChannel();
    restoreChannel = useMcpChannel({ enabled: "yes" });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const token = await mintTestToken();
      for (const method of methods) {
        const response = await call(method, token);
        expect(response.status).toBe(500);
        const body = await response.text();
        expect(JSON.parse(body)).toEqual({ error: MCP_ENABLED_INVALID_MESSAGE });
        expect(body).not.toContain("yes");
      }
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });

  test("a request without a token gets 401 whatever the switch says", async () => {
    // The switch alone changes between iterations; afterEach restores it with the channel.
    for (const enabled of [null, "off", "maybe", "true"]) {
      if (enabled === null) delete process.env[MCP_ENABLED_ENV];
      else process.env[MCP_ENABLED_ENV] = enabled;
      expect((await route.POST(mcpRequest("POST"))).status).toBe(401);
    }
  });

  test("a change between two calls changes the answer", async () => {
    const token = await mintTestToken();
    restoreChannel();
    restoreChannel = useMcpChannel({ enabled: "true" });
    expect((await call("GET", token)).status).toBe(405);
    restoreChannel();
    restoreChannel = useMcpChannel({ enabled: "off" });
    expect((await call("GET", token)).status).toBe(404);
  });
});

describe("no identity, no work", () => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-auth-"));

  beforeEach(() => {
    createSqliteFile(join(dir, "shop.db"), ["CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)"]);
    writeSeedFile(dir, [{ id: "shop", type: "sqlite", database: join(dir, "shop.db") }]);
  });

  afterEach(async () => {
    await resetMcpTestState();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    ["on", "true"],
    ["off", "off"],
  ])("with MCP %s, no refused identity constructs a provider through proxy() or the route", async (_state, enabled) => {
    restoreChannel();
    restoreChannel = useMcpChannel({ enabled });
    const cookie = await signJWT({ username: "alice", role: "admin" });
    const connects = countMethod(SQLiteProvider.prototype, "connect");
    try {
      const refused: Record<string, string>[] = [
        {},
        { authorization: "Bearer forged-token-written-in-words" },
        { cookie: `auth-token=${cookie}` },
      ];
      for (const headers of refused) {
        expect((await proxy(runQueryRequest(headers))).status).toBe(401);
        expect((await route.POST(runQueryRequest(headers))).status).toBe(401);
      }
      expect(connects.calls).toBe(0);
    } finally {
      connects.restore();
    }
  });

  test("the control: with MCP on, a valid token constructs one, so the count above can fail", async () => {
    const connects = countMethod(SQLiteProvider.prototype, "connect");
    try {
      await readJsonRpc(await route.POST(runQueryRequest({ authorization: `Bearer ${await mintTestToken()}` })));
      expect(connects.calls).toBe(1);
    } finally {
      connects.restore();
    }
  });
});

describe("phase 1 serves no protected resource metadata", () => {
  test("no route exists under src/app/.well-known/, and the matcher leaves both metadata paths to Next.js's 404", () => {
    expect(existsSync(join(ROOT, "src/app/.well-known"))).toBe(false);
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    expect(matcher.test("/.well-known/oauth-protected-resource")).toBe(false);
    expect(matcher.test("/.well-known/oauth-protected-resource/api/mcp")).toBe(false);
    // The control: the same matcher routes the endpoint itself.
    expect(matcher.test("/api/mcp")).toBe(true);
  });

  test("the 401 challenge names no resource metadata document", async () => {
    const challenge = (await proxy(mcpRequest("POST"))).headers.get("www-authenticate");
    expect(challenge).toContain('scope="mcp:read"');
    expect(challenge).not.toContain("resource_metadata");
  });
});
