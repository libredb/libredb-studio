import {
  bearerAuthChallengeResponse,
  OAuthError,
  verifyBearerToken,
  type AuthInfo,
  type BearerAuthOptions,
} from "@modelcontextprotocol/server";
import { clientAddress } from "@/lib/api/client-address";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { emitAuditEvent, MAX_AUDIT_FIELD_LENGTH } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { MCP_PATH } from "./config";
import type { McpOriginHostReason } from "./origin-policy";
import { redactError } from "./serializer";
import { MCP_TOKEN_SCOPE, McpTokenError, mcpTokenVerifier } from "./token";

/**
 * The one bearer gate /api/mcp has (#246), called by src/proxy.ts and again by the route, because
 * the proxy is an optimisation and not the authorization boundary.
 *
 * Both call sites pass MCP_BEARER_OPTIONS, so their 401s are byte-identical by construction. The
 * 401 carries WWW-Authenticate and no Location, so an SDK client sees an authentication failure
 * instead of the HTML a redirect to the login screen would hand it. Phase 1 serves no protected
 * resource metadata, so the challenge names none.
 *
 * A denial refuses the caller; a fault is the server's own failure, such as a missing JWT_SECRET,
 * and it writes no permission_denied event, because an operator must not read it as a bad token.
 */

export type McpDenialReason = "mcp_token_invalid" | "mcp_channel_unconfigured";
export type McpRefusalReason = McpDenialReason | McpOriginHostReason;

export const MCP_BEARER_OPTIONS: BearerAuthOptions = { verifier: mcpTokenVerifier, requiredScopes: [MCP_TOKEN_SCOPE] };

export type McpAuthentication =
  | { readonly kind: "authenticated"; readonly authInfo: AuthInfo }
  | { readonly kind: "denied"; readonly response: Response; readonly reason: McpDenialReason }
  | { readonly kind: "fault"; readonly response: Response; readonly error: unknown };

export async function authenticateMcpRequest(request: Request): Promise<McpAuthentication> {
  const [authorization] = (request.headers.get("authorization") ?? "").split(",");
  try {
    return { kind: "authenticated", authInfo: await verifyBearerToken(authorization || undefined, MCP_BEARER_OPTIONS) };
  } catch (error) {
    const response = bearerAuthChallengeResponse(error, MCP_BEARER_OPTIONS);
    if (error instanceof OAuthError) {
      const unconfigured = error.cause instanceof McpTokenError && error.cause.reason === "channel_unconfigured";
      return { kind: "denied", response, reason: unconfigured ? "mcp_channel_unconfigured" : "mcp_token_invalid" };
    }
    logger.error("MCP bearer verification failed for a reason that is not the token's", redactError(error), {
      route: MCP_PATH,
    });
    return { kind: "fault", response, error };
  }
}

/**
 * The permission_denied line of an MCP refusal, in the shape of the proxy's Origin refusal: metered
 * through the anon bucket keyed on the client address, every field bounded, and isolated in its own
 * try/catch, because the refusal is already decided and a broken sink must not turn it into a 500.
 */
export function auditMcpDenial(request: Request, reason: McpRefusalReason): void {
  const address = clientAddress(request);
  const notice = consumeRateLimit("anon", address);
  if (!notice.allowed && !notice.tripped) return;
  try {
    emitAuditEvent({
      type: "permission_denied",
      action: "denied",
      target: `${request.method} ${MCP_PATH}`.slice(0, MAX_AUDIT_FIELD_LENGTH),
      user: "anonymous",
      result: "failure",
      reason,
      ip: address,
    });
  } catch (auditError) {
    logger.error("Failed to record an MCP refusal audit event", auditError, { route: MCP_PATH });
  }
}
