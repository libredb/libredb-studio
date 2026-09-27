import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import type { Role } from "@/lib/auth";
import { getJwtSecret } from "@/lib/config/auth-env";
import { McpConfigError, readMcpTokenLabel, readMcpTokenTtlDays, readMcpUrl } from "./config";

/**
 * The credential an MCP client presents on /api/mcp (#246), verified by src/proxy.ts and again by
 * the route, in the shape of src/lib/agent/drive-token.ts:
 *
 *  - Not a session, by construction rather than by inspection. The signing key is DERIVED from
 *    JWT_SECRET under "libredb.mcp.token:" plus the configured label, so a session token does not
 *    verify here and an MCP token does not verify as a session. The fixed prefix frames the label,
 *    so no configured value can reproduce the session key or the drive key.
 *  - Revoked only by rotating LIBREDB_MCP_TOKEN_LABEL, which changes the key under every token at
 *    once. Nothing about a token is stored, so there is no per-token revocation and no list.
 *  - Bound to one deployment: aud is the canonical LIBREDB_MCP_URL, read from configuration and
 *    never from a request's Host, so two deployments sharing a JWT_SECRET refuse each other's.
 *  - It carries the owner's role at minting time. What that role may reach is decided again on
 *    every call, over the seed file, so a claimed role is never sufficient on its own.
 *
 * Every token fault is one answer to the caller, as the drive token answers; the closed reason
 * goes to the audit line through the OAuthError's cause.
 */

export const MCP_TOKEN_SCOPE = "mcp:read";
export const MCP_TOKEN_TYPE = "libredb-mcp+jwt";
export const MCP_TOKEN_INVALID_MESSAGE = "The MCP token is invalid, expired or revoked";

const KEY_LABEL_PREFIX = "libredb.mcp.token:";
const DAY_SECONDS = 86_400;
const REQUIRED_CLAIMS = ["sub", "role", "scope", "jti", "iat", "exp", "aud"];

export interface McpTokenOwner {
  readonly username: string;
  readonly role: Role;
}

export interface MintedMcpToken {
  readonly token: string;
  readonly expiresAt: Date;
  readonly url: string;
}

export interface McpTokenClaims {
  readonly sub: string;
  readonly role: Role;
  readonly scope: typeof MCP_TOKEN_SCOPE;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly aud: string;
}

export type McpTokenFailure = "invalid" | "channel_unconfigured";

export class McpTokenError extends Error {
  constructor(readonly reason: McpTokenFailure) {
    super(reason === "invalid" ? MCP_TOKEN_INVALID_MESSAGE : "The MCP token channel is not configured on this server");
    this.name = "McpTokenError";
  }
}

/**
 * HMAC(JWT_SECRET, prefix + label), through Web Crypto so it runs in the proxy and in a route.
 * Derived per call, as the drive key is: a cache would outlive a rotated secret or label.
 */
async function mcpSigningKey(label: string): Promise<Uint8Array> {
  const raw = getJwtSecret().slice().buffer as ArrayBuffer;
  const base = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(KEY_LABEL_PREFIX + label)));
}

export async function mintMcpToken(owner: McpTokenOwner, clock: () => number = Date.now): Promise<MintedMcpToken> {
  const label = readMcpTokenLabel();
  const url = readMcpUrl();
  const ttl = readMcpTokenTtlDays();
  if (!label.ok || !url.ok || !ttl.ok) {
    throw new McpConfigError([label, url, ttl].flatMap((setting) => (setting.ok ? [] : [setting.problem])));
  }
  const issuedAt = Math.floor(clock() / 1000);
  const expiresAt = issuedAt + ttl.value * DAY_SECONDS;
  const token = await new SignJWT({ role: owner.role, scope: MCP_TOKEN_SCOPE })
    .setProtectedHeader({ alg: "HS256", typ: MCP_TOKEN_TYPE })
    .setSubject(owner.username)
    .setJti(crypto.randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setAudience(url.value)
    .sign(await mcpSigningKey(label.value));
  return { token, expiresAt: new Date(expiresAt * 1000), url: url.value };
}

export async function verifyMcpToken(token: string): Promise<McpTokenClaims> {
  const label = readMcpTokenLabel();
  if (!label.ok) throw new McpTokenError("channel_unconfigured");
  // Outside the try on purpose: a missing JWT_SECRET is the server's fault, not the token's.
  const key = await mcpSigningKey(label.value);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      typ: MCP_TOKEN_TYPE,
      requiredClaims: REQUIRED_CLAIMS,
    }));
  } catch {
    throw new McpTokenError("invalid");
  }
  const { sub, role, scope, jti, iat, exp, aud } = payload;
  if (
    typeof sub !== "string" ||
    sub === "" ||
    (role !== "admin" && role !== "user") ||
    scope !== MCP_TOKEN_SCOPE ||
    typeof jti !== "string" ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    typeof aud !== "string"
  ) {
    throw new McpTokenError("invalid");
  }
  const url = readMcpUrl();
  if (!url.ok) throw new McpTokenError("channel_unconfigured");
  if (aud !== url.value) throw new McpTokenError("invalid");
  return { sub, role, scope: MCP_TOKEN_SCOPE, jti, iat, exp, aud };
}

export const mcpTokenVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims: McpTokenClaims;
    try {
      claims = await verifyMcpToken(token);
    } catch (error) {
      if (error instanceof McpTokenError) {
        // The cause is attached after construction: OAuthError's third parameter is errorUri,
        // which would add error_uri to the body and break the byte-identical 401s.
        throw Object.assign(new OAuthError(OAuthErrorCode.InvalidToken, MCP_TOKEN_INVALID_MESSAGE), { cause: error });
      }
      throw error;
    }
    return {
      token,
      clientId: claims.jti,
      scopes: [MCP_TOKEN_SCOPE],
      expiresAt: claims.exp,
      resource: new URL(claims.aud),
      extra: { username: claims.sub, role: claims.role },
    };
  },
};
