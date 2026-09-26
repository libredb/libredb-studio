/**
 * The scoped MCP token (#246), in the shape of src/lib/agent/drive-token.ts: a key derived from
 * JWT_SECRET under its own configured label, so a session never verifies as one and one never
 * verifies as a session; the owner's role, a lifetime and the canonical URL inside; and one closed
 * failure reason, which the audit line carries and the caller never sees.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { decodeJwt, decodeProtectedHeader, SignJWT, UnsecuredJWT } from "jose";
import { MCP_TEST_URL } from "../../helpers/mcp-harness";
import { TEST_CHANNEL_LABEL, mintTestToken, useMcpChannel } from "../../helpers/mcp-token";

let cookieStore: Record<string, { value: string } | undefined> = {};
mock.module("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => cookieStore[name] }),
  headers: async () => new Headers(),
}));

const { getSession, signJWT, verifyJWT } = await import("@/lib/auth");
const { AuthConfigError } = await import("@/lib/auth-errors");
const { mintAgentDriveToken, verifyAgentDriveToken } = await import("@/lib/agent/drive-token");
const { McpConfigError } = await import("@/lib/mcp/config");
const {
  MCP_TOKEN_INVALID_MESSAGE,
  MCP_TOKEN_SCOPE,
  MCP_TOKEN_TYPE,
  McpTokenError,
  mcpTokenVerifier,
  mintMcpToken,
  verifyMcpToken,
} = await import("@/lib/mcp/token");

const alice = { username: "alice", role: "admin" } as const;
const TTL_INVALID = "LIBREDB_MCP_TOKEN_TTL_DAYS must be a whole number of days from 1 to 365";
let restore: () => void = () => {};

beforeEach(() => {
  restore = useMcpChannel();
  cookieStore = {};
});

afterEach(() => {
  restore();
});

/** The key the design defines, derived here independently of the module under test. */
async function deriveKey(label: string): Promise<Uint8Array> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const base = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(`libredb.mcp.token:${label}`)));
}

interface Forged {
  readonly typ?: string | null;
  readonly role?: string;
  readonly scope?: string;
  readonly sub?: string;
  readonly jti?: string | null;
  readonly alg?: "HS256" | "HS512";
}

async function forge(change: Forged = {}): Promise<string> {
  const alg = change.alg ?? "HS256";
  const typ = change.typ === undefined ? MCP_TOKEN_TYPE : change.typ;
  let jwt = new SignJWT({ role: change.role ?? "admin", scope: change.scope ?? MCP_TOKEN_SCOPE })
    .setProtectedHeader(typ === null ? { alg } : { alg, typ })
    .setSubject(change.sub ?? "alice")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setAudience(MCP_TEST_URL);
  const jti = change.jti === undefined ? crypto.randomUUID() : change.jti;
  if (jti !== null) jwt = jwt.setJti(jti);
  return jwt.sign(await deriveKey(TEST_CHANNEL_LABEL));
}

async function expectRefused(token: string, reason: "invalid" | "channel_unconfigured" = "invalid"): Promise<void> {
  const error = await verifyMcpToken(token).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(McpTokenError);
  expect((error as InstanceType<typeof McpTokenError>).reason).toBe(reason);
}

describe("minting", () => {
  test("signs HS256 with the MCP type and every claim the design names", async () => {
    const before = Math.floor(Date.now() / 1000);
    const minted = await mintMcpToken(alice);

    expect(decodeProtectedHeader(minted.token)).toEqual({ alg: "HS256", typ: MCP_TOKEN_TYPE });
    const claims = decodeJwt(minted.token);
    expect(claims).toMatchObject({ sub: "alice", role: "admin", scope: "mcp:read", aud: MCP_TEST_URL });
    expect(claims.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.exp).toBe((claims.iat as number) + 30 * 86_400);
    expect(minted.expiresAt.getTime()).toBe((claims.exp as number) * 1000);
    expect(minted.url).toBe(MCP_TEST_URL);
  });

  test("takes its lifetime from LIBREDB_MCP_TOKEN_TTL_DAYS and its clock from the caller", async () => {
    restore();
    restore = useMcpChannel({ ttlDays: "7" });
    const issued = Date.UTC(2026, 8, 26, 12, 0, 0);
    const claims = decodeJwt((await mintMcpToken(alice, () => issued)).token);
    expect(claims.iat).toBe(issued / 1000);
    expect(claims.exp).toBe(issued / 1000 + 7 * 86_400);
  });

  test("gives every token its own jti", async () => {
    const [first, second] = await Promise.all([mintTestToken(), mintTestToken()]);
    expect(decodeJwt(first).jti).not.toBe(decodeJwt(second).jti);
  });

  test.each([
    [{ label: null }, "LIBREDB_MCP_TOKEN_LABEL is not set"],
    [{ url: null }, "LIBREDB_MCP_URL is not set"],
    [{ url: "https://mcp-host.test/api/mcp/" }, "LIBREDB_MCP_URL must end in /api/mcp, with no trailing slash"],
    [{ ttlDays: "0" }, TTL_INVALID],
    [{ ttlDays: "366" }, TTL_INVALID],
    [{ ttlDays: "abc" }, TTL_INVALID],
  ])("refuses with McpConfigError naming the variable when the channel is %p", async (overrides, problem) => {
    restore();
    restore = useMcpChannel(overrides);
    const error = await mintMcpToken(alice).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpConfigError);
    expect((error as Error).message).toContain(problem);
  });
});

describe("verification", () => {
  test("round-trips the claims of a minted token", async () => {
    expect(await verifyMcpToken(await mintTestToken({ username: "bob", role: "user" }))).toMatchObject({
      sub: "bob",
      role: "user",
      scope: "mcp:read",
      aud: MCP_TEST_URL,
    });
  });

  test("accepts a token signed with HMAC-SHA256(JWT_SECRET, 'libredb.mcp.token:' + label)", async () => {
    expect((await verifyMcpToken(await forge())).sub).toBe("alice");
  });

  test("refuses a session JWT, and a session verifier refuses an MCP token as a cookie too", async () => {
    await expectRefused(await signJWT({ username: "alice", role: "admin" }));
    const token = await mintTestToken();
    expect(await verifyJWT(token)).toBeNull();
    cookieStore["auth-token"] = { value: token };
    expect(await getSession()).toBeNull();
    // The control: the same cookie store hands getSession a real session.
    cookieStore["auth-token"] = { value: await signJWT({ username: "alice", role: "admin" }) };
    expect(await getSession()).toMatchObject({ username: "alice", role: "admin" });
  });

  test("refuses a drive token, and a drive verifier refuses an MCP token", async () => {
    await expectRefused(await mintAgentDriveToken("arun_0123456789abcdef"));
    expect(await verifyAgentDriveToken(await mintTestToken())).toBeNull();
  });

  test("refuses a token past its exp", async () => {
    await expectRefused(await mintTestToken(alice, () => Date.now() - 31 * 86_400_000));
  });

  test.each(["not-a-token", "a.b.c", ""])("refuses %p as invalid, never as a server fault", async (token) => {
    await expectRefused(token);
  });

  test("refuses an unsecured alg none token", async () => {
    const token = new UnsecuredJWT({ role: "admin", scope: MCP_TOKEN_SCOPE })
      .setSubject("alice")
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("1h")
      .setAudience(MCP_TEST_URL)
      .encode();
    await expectRefused(token);
  });

  test.each([
    ["another algorithm", { alg: "HS512" }],
    ["no typ", { typ: null }],
    ["another typ", { typ: "JWT" }],
    ["another role", { role: "owner" }],
    ["another scope", { scope: "mcp:write" }],
    ["an empty subject", { sub: "" }],
    ["no jti", { jti: null }],
  ] as const)("refuses a token signed with the right key but %s", async (_name, change) => {
    await expectRefused(await forge(change));
  });

  test("refuses a token minted for another deployment's URL", async () => {
    const token = await mintTestToken();
    restore();
    restore = useMcpChannel({ url: "https://another-studio.test/api/mcp" });
    await expectRefused(token);
  });

  test("refuses every earlier token once the label rotates", async () => {
    const token = await mintTestToken();
    restore();
    restore = useMcpChannel({ label: "rotated-label" });
    await expectRefused(token);
  });

  test("answers channel_unconfigured to any bearer while the label is unset", async () => {
    const token = await mintTestToken();
    restore();
    restore = useMcpChannel({ label: null });
    await expectRefused(token, "channel_unconfigured");
    await expectRefused("not-a-token", "channel_unconfigured");
  });

  test("answers channel_unconfigured to a token that verifies while the URL is unset or invalid", async () => {
    const token = await mintTestToken();
    restore();
    restore = useMcpChannel({ url: null });
    await expectRefused(token, "channel_unconfigured");
    restore();
    // Built from parts with a password generated at run time, so the file holds no credential for a secret scanner to flag.
    const credentialed = new URL("https://mcp-host.test/api/mcp");
    credentialed.username = "someone";
    credentialed.password = crypto.randomUUID();
    restore = useMcpChannel({ url: credentialed.href });
    await expectRefused(token, "channel_unconfigured");
  });
});

describe("the SDK token verifier", () => {
  test("maps a verified token to AuthInfo", async () => {
    const token = await mintTestToken({ username: "bob", role: "user" });
    const claims = decodeJwt(token);
    expect(await mcpTokenVerifier.verifyAccessToken(token)).toEqual({
      token,
      clientId: claims.jti as string,
      scopes: ["mcp:read"],
      expiresAt: claims.exp,
      resource: new URL(MCP_TEST_URL),
      extra: { username: "bob", role: "user" },
    });
  });

  test("answers every token fault with one invalid_token error that carries the reason as its cause", async () => {
    const error = await mcpTokenVerifier.verifyAccessToken("not-a-token").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthError);
    const oauth = error as InstanceType<typeof OAuthError>;
    expect(oauth.code).toBe(OAuthErrorCode.InvalidToken);
    expect(oauth.message).toBe(MCP_TOKEN_INVALID_MESSAGE);
    expect(oauth.errorUri).toBeUndefined();
    expect(oauth.toResponseObject()).toEqual({ error: "invalid_token", error_description: MCP_TOKEN_INVALID_MESSAGE });
    expect((oauth.cause as InstanceType<typeof McpTokenError>).reason).toBe("invalid");
  });

  test("lets a server fault through unchanged: no JWT_SECRET under NODE_ENV=production", async () => {
    const token = await mintTestToken();
    const env = process.env as Record<string, string | undefined>;
    const secret = env.JWT_SECRET;
    const mode = env.NODE_ENV;
    delete env.JWT_SECRET;
    env.NODE_ENV = "production";
    try {
      const error = await mcpTokenVerifier.verifyAccessToken(token).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthConfigError);
      expect(error).not.toBeInstanceOf(OAuthError);
    } finally {
      env.JWT_SECRET = secret;
      env.NODE_ENV = mode;
    }
  });
});
