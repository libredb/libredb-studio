import type { AuthInfo } from "@modelcontextprotocol/server";
import { NextResponse } from "next/server";
import { ACCOUNT_STORE_UNAVAILABLE_BODY } from "@/lib/api/account-store-error";
import { getAppVersion } from "@/lib/app-version";
import { runtimeSetting } from "@/lib/governance/settings";
import { logger } from "@/lib/logger";
import { mcpTokenOwnerAllowed } from "@/lib/mcp/account-check";
import { auditMcpDenial, authenticateMcpRequest, mcpRevokedTokenResponse } from "@/lib/mcp/bearer";
import {
  isMcpHeldByGovernance,
  MCP_ENABLED_INVALID_MESSAGE,
  MCP_PATH,
  type McpSwitchReading,
  readMcpSwitch,
} from "@/lib/mcp/config";
import { mcpOriginHostRefusal } from "@/lib/mcp/origin-policy";
import { preprocessMcpPost, recordInvalidArguments } from "@/lib/mcp/preprocess";
import { mcpHandler } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

/**
 * /api/mcp (#246): an MCP client of the user's own, authenticated by a scoped bearer token.
 *
 * Every method first runs the checks src/proxy.ts already ran, because the proxy is an
 * optimisation and not the authorization boundary: Origin and Host, then the bearer. No cookie is
 * read on this path, so a Studio session opens nothing here. The kill switch is read after
 * identity, so an unauthenticated caller learns nothing about it, and the version check follows
 * it. A POST is then metered and pre-processed before the SDK handler sees it.
 */

const MCP_DISABLED_BODY = { error: "MCP is not enabled on this server" };
const VERSION_UNAVAILABLE_MESSAGE = "server version unavailable: NEXT_PUBLIC_APP_VERSION is not set";

/** Each unrecognized switch value is logged once per process, not once per request. */
const reportedSwitchValues = new Set<string>();

/**
 * The switch as this request reads it. A valid runtime `mcp.enabled` from the control plane wins over
 * LIBREDB_MCP_ENABLED (docs/GOVERNANCE.md#runtime-settings), and the other MCP variables stay prerequisites. It is
 * applied here rather than in readMcpSwitch() because the proxy imports src/lib/mcp/config.ts and must never load the
 * settings store. Only governance sets a runtime value, and the governance hold answers first, so in this version the
 * value has no effect.
 */
function readMcpSwitchForRequest(): McpSwitchReading {
  const runtime = isMcpHeldByGovernance() ? undefined : runtimeSetting("mcp.enabled");
  if (runtime === undefined) return readMcpSwitch();
  return { state: runtime ? "on" : "off" };
}

type Admission = { readonly authInfo: AuthInfo } | { readonly response: Response };

async function admit(request: Request): Promise<Admission> {
  const refusal = mcpOriginHostRefusal(request);
  if (refusal !== null) {
    auditMcpDenial(request, refusal.reason);
    return { response: refusal.response };
  }
  const authentication = await authenticateMcpRequest(request);
  if (authentication.kind === "denied") auditMcpDenial(request, authentication.reason);
  if (authentication.kind !== "authenticated") return { response: authentication.response };
  const ownerAdmission = await mcpTokenOwnerAllowed(authentication.authInfo);
  if (ownerAdmission === "store_unavailable") {
    return { response: NextResponse.json(ACCOUNT_STORE_UNAVAILABLE_BODY, { status: 503 }) };
  }
  if (!ownerAdmission) {
    auditMcpDenial(request, "mcp_token_invalid");
    return { response: mcpRevokedTokenResponse() };
  }
  const reading = readMcpSwitchForRequest();
  if (reading.state === "off") return { response: NextResponse.json(MCP_DISABLED_BODY, { status: 404 }) };
  if (reading.state === "invalid") {
    if (!reportedSwitchValues.has(reading.raw)) {
      reportedSwitchValues.add(reading.raw);
      logger.error(MCP_ENABLED_INVALID_MESSAGE, undefined, { route: MCP_PATH });
    }
    return { response: NextResponse.json({ error: MCP_ENABLED_INVALID_MESSAGE }, { status: 500 }) };
  }
  if (getAppVersion() === null) {
    logger.error(VERSION_UNAVAILABLE_MESSAGE, undefined, { route: MCP_PATH });
    return { response: NextResponse.json({ error: VERSION_UNAVAILABLE_MESSAGE }, { status: 500 }) };
  }
  return { authInfo: authentication.authInfo };
}

export async function POST(request: Request): Promise<Response> {
  const admission = await admit(request);
  if ("response" in admission) return admission.response;
  const outcome = await preprocessMcpPost(request, admission.authInfo);
  if (outcome.kind === "refused") return outcome.response;
  const response = await mcpHandler.fetch(request, { authInfo: admission.authInfo, parsedBody: outcome.parsedBody });
  // HTTP 200 means the SDK accepted the call and answered its own input validation error; any other
  // status is an earlier SDK gate's refusal, and no call was made to record.
  if (outcome.invalidArgumentsTool !== null && response.status === 200) {
    recordInvalidArguments(outcome.invalidArgumentsTool, admission.authInfo);
  }
  return response;
}

/**
 * GET and DELETE are answered by the SDK's stateless legacy leg with 405 before any server is
 * built, and are never metered. RFC 9110 section 15.5.6 makes Allow a MUST on every 405, so it is
 * added and nothing else in the SDK's answer changes. Both are exported because Next.js would
 * otherwise answer an unexported method with a 405 of its own and no JSON-RPC body.
 */
async function answerWithoutBody(request: Request): Promise<Response> {
  const admission = await admit(request);
  if ("response" in admission) return admission.response;
  const response = await mcpHandler.fetch(request, { authInfo: admission.authInfo });
  const headers = new Headers(response.headers);
  headers.set("Allow", "POST");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function GET(request: Request): Promise<Response> {
  return answerWithoutBody(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return answerWithoutBody(request);
}
