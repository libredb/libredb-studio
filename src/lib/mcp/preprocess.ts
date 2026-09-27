import {
  type AuthInfo,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  isJsonContentType,
  isLegacyRequest,
  readRequestBody,
} from "@modelcontextprotocol/server";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { consumeRateLimit, RateLimitError } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { newMcpCorrelationId, recordMcpDecision } from "./audit";
import { mcpCaller } from "./context";
import { isMcpToolName, MCP_TOOL_INPUT_SCHEMAS, type McpToolName } from "./tools";

/**
 * What the route does with an authenticated POST before the SDK handler sees it (#246), in a fixed
 * order, each step answering before the next can run.
 *
 * Step 0 spends one slot of the query bucket, keyed on the user the token was minted for, which is
 * the key guardRoute uses for that user's session (src/lib/api/require-session.ts), so a session
 * and an MCP token of one person share one budget. It runs before the body is read, so a refused
 * POST costs no read at all. A metering step inside a tool could not answer 429: the SDK turns a
 * thrown error into an in-band tool result.
 *
 * Steps 1 to 4 read the body under the SDK's own bound, because the SDK applies no bound to a body
 * it is handed as parsedBody, and answer in the SDK's own words where the SDK has words for it.
 * Steps 5 to 7 answer what the protocol requires and the SDK does not enforce: a standard header
 * outside visible ASCII, a legacy request after initialize without MCP-Protocol-Version (this
 * server serves no revision before 2025-06-18), and the one method it does not implement. Step 8
 * refuses nothing: it runs the SDK's own input validation on the same schema object and keeps the
 * verdict, because the SDK refuses bad arguments before any handler could audit them.
 */

const MCP_POST_ROUTE = "POST /api/mcp";

export type McpPreprocessOutcome =
  | { readonly kind: "refused"; readonly response: Response }
  | { readonly kind: "dispatch"; readonly parsedBody: unknown; readonly invalidArgumentsTool: McpToolName | null };

type JsonRpcId = string | number | null;

const UNSUPPORTED_MEDIA_TYPE = "Unsupported Media Type: Content-Type must be application/json";
const PAYLOAD_TOO_LARGE = `Payload Too Large: Request body must not exceed ${DEFAULT_MAX_REQUEST_BODY_SIZE} bytes`;
const UNREADABLE_BODY = "Parse error: the request body could not be read";
const INVALID_JSON = "Parse error: Invalid JSON";
const BATCH_REFUSED = "Bad Request: JSON-RPC batches are not supported by this endpoint";
const VERSION_REQUIRED =
  "Header mismatch: MCP-Protocol-Version is required on every request after initialize; this server does not serve protocol version 2025-03-26";
const METHOD_NOT_FOUND = "Method not found";
const BASE64_ADVICE = "; send it Base64-encoded as =?base64?...?=";

/** Visible ASCII, space and tab: what an HTTP field value may carry as it is. */
const FIELD_VALUE = /^[\t\x20-\x7e]*$/;

function jsonRpcError(status: number, code: number, message: string, id: JsonRpcId = null): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id }, { status });
}

function refused(response: Response): McpPreprocessOutcome {
  return { kind: "refused", response };
}

function outsideAscii(header: string): string {
  return `Header mismatch: the ${header} header holds a character outside visible ASCII, space and tab`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBase64Sentinel(value: string): boolean {
  return value.startsWith("=?base64?") && value.endsWith("?=");
}

function meter(request: Request, username: string): Response | null {
  const decision = consumeRateLimit("query", username);
  if (decision.allowed) return null;
  if (decision.tripped) {
    // Isolated, as guardRoute isolates it: the 429 below is already decided.
    try {
      emitAuditEvent({
        type: "rate_limit_exceeded",
        action: "throttled",
        target: MCP_POST_ROUTE,
        user: username,
        result: "failure",
        reason: "rate_limited",
        ip: clientAddress(request),
        bucket: "query",
      });
    } catch (auditError) {
      logger.error("Failed to record rate_limit_exceeded audit event", auditError, { route: MCP_POST_ROUTE });
    }
  }
  return createErrorResponse(new RateLimitError(decision.retryAfterSeconds), { route: MCP_POST_ROUTE });
}

/** Step 3: the parsed body, or undefined for an empty body or one that is not JSON. */
function parseBody(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Answered as the parse error by the caller; the text is the client's own and is not logged.
    return undefined;
  }
}

/** Step 5: the first standard header, in the rule's order, that no HTTP field may carry as it is. */
function headerRefusal(request: Request, id: JsonRpcId): Response | null {
  const version = request.headers.get("mcp-protocol-version");
  if (version !== null && !FIELD_VALUE.test(version)) {
    return jsonRpcError(400, -32020, outsideAscii("MCP-Protocol-Version"), id);
  }
  const method = request.headers.get("mcp-method");
  if (method !== null && !FIELD_VALUE.test(method)) return jsonRpcError(400, -32020, outsideAscii("Mcp-Method"), id);
  const name = request.headers.get("mcp-name");
  if (name !== null && !isBase64Sentinel(name) && !FIELD_VALUE.test(name)) {
    return jsonRpcError(400, -32020, `${outsideAscii("Mcp-Name")}${BASE64_ADVICE}`, id);
  }
  return null;
}

/**
 * Step 8: the SDK's own validation of `arguments ?? {}`, on the same schema object, verdict only.
 * Arguments that are present but not a plain object never reach it: the SDK's tools/call request
 * schema refuses them first, so there is no tool validation error to record.
 */
async function invalidArgumentsTool(body: Record<string, unknown>): Promise<McpToolName | null> {
  if (body.method !== "tools/call" || !isPlainObject(body.params)) return null;
  const { name, arguments: args } = body.params;
  if (!isMcpToolName(name)) return null;
  if (args !== undefined && !isPlainObject(args)) return null;
  const verdict = await MCP_TOOL_INPUT_SCHEMAS[name]["~standard"].validate(args ?? {});
  return verdict.issues !== undefined && verdict.issues.length > 0 ? name : null;
}

/** Steps 0 to 8, in that order. Reads the request body. */
export async function preprocessMcpPost(request: Request, authInfo: AuthInfo): Promise<McpPreprocessOutcome> {
  const throttled = meter(request, mcpCaller(authInfo).username);
  if (throttled !== null) return refused(throttled);

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return refused(jsonRpcError(415, -32000, UNSUPPORTED_MEDIA_TYPE));
  }

  let text: string;
  try {
    const read = await readRequestBody(request, DEFAULT_MAX_REQUEST_BODY_SIZE);
    if (read.tooLarge) return refused(jsonRpcError(413, -32000, PAYLOAD_TOO_LARGE));
    text = read.text;
  } catch {
    // The client's stream failed, which is the client's side: answered, as the SDK answers it.
    return refused(jsonRpcError(400, -32700, UNREADABLE_BODY));
  }

  const body = parseBody(text);
  if (body === undefined) return refused(jsonRpcError(400, -32700, INVALID_JSON));

  if (Array.isArray(body)) return refused(jsonRpcError(400, -32600, BATCH_REFUSED));
  // JSON that is not an object is no JSON-RPC message of any era, and the SDK answers it itself.
  if (!isPlainObject(body)) return { kind: "dispatch", parsedBody: body, invalidArgumentsTool: null };

  const id: JsonRpcId = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  if (!(await isLegacyRequest(request, body))) {
    const refusal = headerRefusal(request, id);
    if (refusal !== null) return refused(refusal);
  } else if (request.headers.get("mcp-protocol-version") === null && body.method !== "initialize") {
    return refused(jsonRpcError(400, -32020, VERSION_REQUIRED, id));
  }

  if (body.method === "subscriptions/listen" && "id" in body) {
    return refused(jsonRpcError(404, -32601, METHOD_NOT_FOUND, id));
  }

  return { kind: "dispatch", parsedBody: body, invalidArgumentsTool: await invalidArgumentsTool(body) };
}

/**
 * The decision event of an argument refusal the SDK made before any handler ran, written after the
 * SDK answered. Its own try/catch: nothing ran, and the SDK's answer goes back unchanged.
 */
export function recordInvalidArguments(tool: McpToolName, authInfo: AuthInfo): void {
  try {
    recordMcpDecision(
      { action: tool, user: mcpCaller(authInfo).username, correlationId: newMcpCorrelationId() },
      "mcp_invalid_arguments",
    );
  } catch (auditError) {
    logger.error("Failed to record an MCP argument refusal", auditError, { route: MCP_POST_ROUTE });
  }
}
