/**
 * GET and POST /api/mcp/token (#246): the MCP channel's status for the signed-in user, and a token
 * minted for that user's own role, answered once and stored nowhere. The session is a real signed
 * cookie read through a replaced next/headers, so getSession and verifyJWT run as they do in the app.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";

let cookieStore: Record<string, { value: string } | undefined> = {};
mock.module("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => cookieStore[name] }),
  headers: async () => new Headers(),
}));

const { GET, POST } = await import("@/app/api/mcp/token/route");
const mcpRoute = await import("@/app/api/mcp/route");
const { getSession, signJWT, verifyJWT } = await import("@/lib/auth");
const { getJwtSecret } = await import("@/lib/config/auth-env");
const { encryptState } = await import("@/lib/oidc");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { logger } = await import("@/lib/logger");
const { verifyMcpToken } = await import("@/lib/mcp/token");
const { resetCache } = await import("@/lib/seed");
const fixtures = await import("../../helpers/mcp-fixtures");
const harness = await import("../../helpers/mcp-harness");
const { useMcpChannel } = await import("../../helpers/mcp-token");

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-token-route-"));
const NOT_ISSUED = "MCP tokens cannot be issued on this server";
const AUDIT_FAILED = "The token was not issued because its audit record could not be written.";
const SEED_UNREADABLE =
  "The seed connection file could not be read, so the connections an MCP token reaches are unknown; the server log names the cause";
let restoreChannel: () => void = () => {};

async function signIn(username: string, role: "admin" | "user"): Promise<void> {
  cookieStore = { "auth-token": { value: await signJWT({ username, role }) } };
}

async function signInSecondsAgo(seconds: number): Promise<void> {
  const issuedAt = Math.floor(Date.now() / 1000) - seconds;
  const token = await new SignJWT({ username: "bob", role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 86_400)
    .sign(getJwtSecret());
  cookieStore = { "auth-token": { value: token } };
}

const RECENT_SIGN_IN_REQUIRED =
  "Sign in again to create a token: a token can only be created within 10 minutes of signing in.";

const mintRequest = (headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/mcp/token", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });

beforeAll(() => {
  fixtures.pinMcpTestEnvironment();
  fixtures.createSqliteFile(join(dir, "shop.db"), ["CREATE TABLE users (id INTEGER PRIMARY KEY)"]);
});

beforeEach(() => {
  clearRateLimitState();
  cookieStore = {};
  restoreChannel = useMcpChannel();
  fixtures.writeSeedFile(dir, [
    { id: "everyone", type: "sqlite", database: join(dir, "shop.db") },
    { id: "admins", type: "sqlite", database: join(dir, "shop.db"), roles: ["admin"] },
    { id: "silent", type: "sqlite", database: join(dir, "shop.db"), mcp: null },
  ]);
});

afterEach(async () => {
  restoreChannel();
  delete process.env.RATE_LIMIT_QUERY_MAX;
  await fixtures.resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/mcp/token", () => {
  test("answers 401 without a session", async () => {
    expect((await GET()).status).toBe(401);
  });

  test("answers a ready channel and the opted-in connections the user's role reaches", async () => {
    await signIn("bob", "user");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "ready",
      problems: [],
      url: harness.MCP_TEST_URL,
      tokenTtlDays: 30,
      visibleConnections: 1,
    });
  });

  test("counts the admin-only connection for an admin", async () => {
    await signIn("alice", "admin");
    expect((await (await GET()).json()).visibleConnections).toBe(2);
  });

  test("answers zero for a role no opted-in connection admits, which the screen explains", async () => {
    fixtures.writeSeedFile(dir, [
      { id: "admins", type: "sqlite", database: join(dir, "shop.db"), roles: ["admin"] },
      { id: "silent", type: "sqlite", database: join(dir, "shop.db"), mcp: null },
    ]);
    await signIn("bob", "user");
    expect((await (await GET()).json()).visibleConnections).toBe(0);
  });

  test("names everything enabling it needs when it is off", async () => {
    restoreChannel();
    restoreChannel = useMcpChannel({ enabled: null, url: null, label: null });
    await signIn("alice", "admin");
    expect(await (await GET()).json()).toEqual({
      state: "off",
      problems: [
        "LIBREDB_MCP_ENABLED is off: set it to true, on or 1 to enable MCP",
        "LIBREDB_MCP_URL is not set: set it to the address clients use, such as https://studio.example.com/api/mcp",
        "LIBREDB_MCP_TOKEN_LABEL is not set: set it to any value, and change it to revoke every MCP token at once",
      ],
      url: null,
      tokenTtlDays: 30,
      visibleConnections: 2,
    });
  });

  test("answers null connections, with a problem, when the seed file cannot be read", async () => {
    const file = join(dir, "broken.json");
    writeFileSync(file, "{ not json");
    process.env.SEED_CONFIG_PATH = file;
    resetCache();
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await signIn("alice", "admin");
      const body = await (await GET()).json();
      expect(body.visibleConnections).toBeNull();
      expect(body.problems).toContain(SEED_UNREADABLE);
    } finally {
      errorLog.mockRestore();
    }
  });

  test("is never metered", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "1";
    await signIn("alice", "admin");
    for (let i = 0; i < 3; i += 1) expect((await GET()).status).toBe(200);
    expect((await POST(mintRequest())).status).toBe(200);
  });
});

describe("a token signed with JWT_SECRET that is not a session", () => {
  test("the OIDC state cookie is refused by GET and POST, and reads nothing", async () => {
    cookieStore = {
      "auth-token": { value: await encryptState({ code_verifier: "verifier", state: "state", nonce: "nonce" }) },
    };
    const status = await GET();
    expect(status.status).toBe(401);
    expect(await status.json()).toEqual({ error: "Authentication required" });
    const mint = await POST(mintRequest());
    expect(mint.status).toBe(401);
    expect(await mint.json()).toEqual({ error: "Authentication required" });
  });

  test.each([
    ["an empty user name", { username: "", role: "admin" }],
    ["a role that is neither admin nor user", { username: "bob", role: "owner" }],
  ])("a payload with %s is refused by both", async (_name, payload) => {
    cookieStore = {
      "auth-token": {
        value: await new SignJWT(payload)
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(getJwtSecret()),
      },
    };
    expect((await GET()).status).toBe(401);
    expect((await POST(mintRequest())).status).toBe(401);
  });
});

describe("a URL that carries credentials", () => {
  test("is named by its rule in both answers, and no part of it is repeated", async () => {
    restoreChannel();
    // Built from parts with a password generated at run time, so the file holds no credential for a secret scanner to flag.
    const credentialed = new URL("https://studio.example/api/mcp");
    credentialed.username = "someone";
    credentialed.password = crypto.randomUUID();
    restoreChannel = useMcpChannel({ url: credentialed.href });
    await signIn("alice", "admin");
    for (const response of [await GET(), await POST(mintRequest())]) {
      const text = await response.text();
      expect(JSON.parse(text).problems).toContain("LIBREDB_MCP_URL must not carry a user name or password");
      for (const part of ["someone", credentialed.password, "studio.example"]) expect(text).not.toContain(part);
    }
  });
});

describe("POST /api/mcp/token", () => {
  test("answers guardRoute's 401 without a session", async () => {
    const response = await POST(mintRequest());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  test("mints for the session's user and role, once, with no-store, verifiable only under the MCP key", async () => {
    await signIn("bob", "user");
    const response = await POST(mintRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { token: string; expiresAt: string; url: string };
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "token", "url"]);
    expect(body.url).toBe(harness.MCP_TEST_URL);
    expect(await verifyMcpToken(body.token)).toMatchObject({ sub: "bob", role: "user" });
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(await verifyJWT(body.token)).toBeNull();
    cookieStore = { "auth-token": { value: body.token } };
    expect(await getSession()).toBeNull();
    await signIn("bob", "user");
    expect(await (await GET()).text()).not.toContain(body.token);
  });

  test("an MCP bearer authenticates nothing here", async () => {
    await signIn("alice", "admin");
    const { token } = (await (await POST(mintRequest())).json()) as { token: string };
    cookieStore = {};
    expect((await POST(mintRequest({ authorization: `Bearer ${token}` }))).status).toBe(401);
  });

  test("a user-role token lists only what that role reaches, and an admin's the admin-only connection too", async () => {
    for (const [username, role, ids] of [
      ["bob", "user", ["seed:everyone"]],
      ["alice", "admin", ["seed:everyone", "seed:admins"]],
    ] as const) {
      await signIn(username, role);
      const { token } = (await (await POST(mintRequest())).json()) as { token: string };
      const session = await harness.connectClient(harness.routeServe(mcpRoute), { token });
      try {
        const result = await session.client.callTool({ name: "list_connections", arguments: {} });
        expect(
          (result.structuredContent as { connections: Array<{ id: string }> }).connections.map((entry) => entry.id),
        ).toEqual([...ids]);
      } finally {
        await session.close();
      }
    }
  });

  test.each([
    ["off", { enabled: null }, "LIBREDB_MCP_ENABLED is off"],
    ["without a label", { label: null }, "LIBREDB_MCP_TOKEN_LABEL is not set"],
    ["without a URL", { url: null }, "LIBREDB_MCP_URL is not set"],
    [
      "with a URL that does not end in /api/mcp",
      { url: "https://mcp-host.test/api/mcp/" },
      "LIBREDB_MCP_URL must end in /api/mcp",
    ],
    ["with a lifetime of 0", { ttlDays: "0" }, "LIBREDB_MCP_TOKEN_TTL_DAYS must be a whole number"],
    ["with a lifetime of 366", { ttlDays: "366" }, "LIBREDB_MCP_TOKEN_TTL_DAYS must be a whole number"],
    ["with a lifetime of abc", { ttlDays: "abc" }, "LIBREDB_MCP_TOKEN_TTL_DAYS must be a whole number"],
  ] as const)(
    "answers 409 naming the problem when the channel is %s, and signs nothing",
    async (_name, overrides, problem) => {
      restoreChannel();
      restoreChannel = useMcpChannel(overrides);
      await signIn("alice", "admin");
      const signs = spyOn(SignJWT.prototype, "sign");
      try {
        const response = await POST(mintRequest());
        expect(response.status).toBe(409);
        const body = (await response.json()) as { error: string; problems: string[] };
        expect(body.error).toBe(NOT_ISSUED);
        expect(body.problems.some((text) => text.startsWith(problem))).toBe(true);
        expect(signs).not.toHaveBeenCalled();
      } finally {
        signs.mockRestore();
      }
    },
  );

  test("refuses a session signed more than ten minutes ago and signs nothing, so a rotated label is not re-minted on an old session", async () => {
    await signInSecondsAgo(601);
    const signs = spyOn(SignJWT.prototype, "sign");
    const sink = spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await POST(mintRequest());
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: RECENT_SIGN_IN_REQUIRED });
      expect(signs).not.toHaveBeenCalled();
      const lines = sink.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(lines.filter((line) => line.event === "mcp_operation")).toEqual([]);
    } finally {
      signs.mockRestore();
      sink.mockRestore();
    }
  });

  test("mints on a session signed nine minutes ago", async () => {
    await signInSecondsAgo(540);
    const response = await POST(mintRequest());
    expect(response.status).toBe(200);
    expect(await verifyMcpToken(((await response.json()) as { token: string }).token)).toMatchObject({ sub: "bob" });
  });

  test("refuses a session that carries no issue time", async () => {
    cookieStore = {
      "auth-token": {
        value: await new SignJWT({ username: "bob", role: "admin" })
          .setProtectedHeader({ alg: "HS256" })
          .setExpirationTime("1h")
          .sign(getJwtSecret()),
      },
    };
    const response = await POST(mintRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: RECENT_SIGN_IN_REQUIRED });
  });

  test("spends one slot of the query budget", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "1";
    await signIn("alice", "admin");
    expect((await POST(mintRequest())).status).toBe(200);
    expect((await POST(mintRequest())).status).toBe(429);
  });

  test("writes one mint_token event for the session's user", async () => {
    await signIn("alice", "admin");
    const sink = spyOn(console, "log").mockImplementation(() => {});
    try {
      await POST(mintRequest());
      const lines = sink.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(lines.filter((line) => line.event === "mcp_operation")).toEqual([
        expect.objectContaining({ action: "mint_token", route: "mcp/token", actor: "alice", outcome: "success" }),
      ]);
    } finally {
      sink.mockRestore();
    }
  });

  test("answers 500 and signs nothing when that event cannot be written, so the record comes first", async () => {
    await signIn("alice", "admin");
    const signs = spyOn(SignJWT.prototype, "sign");
    const sink = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const response = await POST(mintRequest());
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: AUDIT_FAILED });
      expect(signs).not.toHaveBeenCalled();
    } finally {
      signs.mockRestore();
      sink.mockRestore();
      errorLog.mockRestore();
    }
  });
});
