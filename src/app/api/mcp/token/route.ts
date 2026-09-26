import { NextResponse } from "next/server";
import { guardRoute } from "@/lib/api/require-session";
import { getSession, type UserPayload } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { recordMcpMint } from "@/lib/mcp/audit";
import { mcpChannelStatus } from "@/lib/mcp/config";
import { MCP_CONNECTIONS_UNREADABLE, McpConnectionContext } from "@/lib/mcp/context";
import { mintMcpToken } from "@/lib/mcp/token";

export const dynamic = "force-dynamic";

/**
 * /api/mcp/token (#246): where a signed-in user learns whether MCP is ready and mints a token of
 * their own. It is on the ordinary session path, so an MCP bearer authenticates nothing here and a
 * token can never mint a token.
 *
 * GET reads the status with getSession and is charged nothing, because a screen that must ask
 * whether a feature is ready before it renders cannot spend the budget of the work. POST goes
 * through guardRoute, takes no body field (the owner is always the session's user, with the
 * session's role), refuses with the configuration's problems when the channel is not ready,
 * refuses a session signed in more than ten minutes ago, records the mint before it signs, and answers the token once, marked no-store. Nothing about a
 * token is stored.
 */

const NOT_ISSUED = "MCP tokens cannot be issued on this server";
const AUDIT_FAILED = "The token was not issued because its audit record could not be written.";
const SEED_UNREADABLE =
  "The seed connection file could not be read, so the connections an MCP token reaches are unknown; the server log names the cause";
const NO_STORE = { "Cache-Control": "no-store" };
const UNAUTHENTICATED = { error: "Authentication required" };
const MINT_SESSION_MAX_AGE_SECONDS = 600;
const RECENT_SIGN_IN_REQUIRED =
  "Sign in again to create a token: a token can only be created within 10 minutes of signing in.";

/**
 * A session cannot be revoked on the server and lives 24 hours, so rotating
 * LIBREDB_MCP_TOKEN_LABEL would not offboard a person who still holds one: they could mint again
 * under the new label. Minting therefore needs a sign-in from the last ten minutes, which an
 * account that can no longer sign in cannot produce. A payload with no issue time is refused.
 */
function signedInRecently(session: UserPayload): boolean {
  const issuedAt = (session as { iat?: unknown }).iat;
  return typeof issuedAt === "number" && Date.now() / 1000 - issuedAt <= MINT_SESSION_MAX_AGE_SECONDS;
}

/**
 * verifyJWT accepts any payload signed with JWT_SECRET, and the OIDC state cookie an anonymous
 * caller receives is one, with no user name and no role. This route answers and mints only for a
 * payload that has the session's shape, so such a token reads nothing and reaches no guard that
 * assumes a user name.
 */
function hasSessionShape(session: UserPayload | null): session is UserPayload {
  return (
    session !== null &&
    typeof session.username === "string" &&
    session.username.length > 0 &&
    (session.role === "admin" || session.role === "user")
  );
}

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!hasSessionShape(session)) return NextResponse.json(UNAUTHENTICATED, { status: 401 });
  const status = mcpChannelStatus();
  const visible = await new McpConnectionContext({
    username: session.username,
    role: session.role,
  }).visibleConnections();
  const readable = visible !== MCP_CONNECTIONS_UNREADABLE;
  return NextResponse.json(
    {
      state: status.state,
      problems: readable ? [...status.problems] : [...status.problems, SEED_UNREADABLE],
      url: status.url,
      tokenTtlDays: status.tokenTtlDays,
      visibleConnections: readable ? visible.length : null,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (session !== null && !hasSessionShape(session)) return NextResponse.json(UNAUTHENTICATED, { status: 401 });
  const guard = await guardRoute({ route: "POST /api/mcp/token", bucket: "query", request });
  if ("response" in guard) return guard.response;
  const status = mcpChannelStatus();
  if (status.state !== "ready") {
    return NextResponse.json({ error: NOT_ISSUED, problems: [...status.problems] }, { status: 409, headers: NO_STORE });
  }
  if (!signedInRecently(guard.session)) {
    return NextResponse.json({ error: RECENT_SIGN_IN_REQUIRED }, { status: 403, headers: NO_STORE });
  }
  try {
    recordMcpMint(guard.session.username);
  } catch (auditError) {
    logger.error("An MCP token mint could not be recorded, so no token was issued", auditError, {
      route: "POST /api/mcp/token",
    });
    return NextResponse.json({ error: AUDIT_FAILED }, { status: 500, headers: NO_STORE });
  }
  const minted = await mintMcpToken({ username: guard.session.username, role: guard.session.role });
  return NextResponse.json(
    { token: minted.token, expiresAt: minted.expiresAt.toISOString(), url: minted.url },
    { headers: NO_STORE },
  );
}
