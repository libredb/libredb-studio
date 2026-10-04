/**
 * The in-process MCP client harness (#246).
 *
 * The official SDK client, driven against this server with no socket, as the SDK's testing guide
 * does it: the transport's fetch hands each Request to the server directly. Every request built
 * here carries a Host header taken from its URL, because a constructed Request carries none and
 * the route's loopback Host check must not depend on the machine running the tests. The route
 * dispatcher sends each method to its own handler, so the legacy client's GET after initialize
 * reaches GET, as it would over the network.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthInfo, ClientCapabilities } from "@modelcontextprotocol/server";

export const MCP_TEST_URL = "http://localhost:3000/api/mcp";
export const MODERN_REVISION = "2026-07-28";
const LEGACY_REVISION = "2025-11-25";
const TEST_CLIENT = { name: "libredb-test-client", version: "1.0.0" };

export type ServeRequest = (request: Request) => Promise<Response>;

export interface InProcessFetch {
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  readonly requests: readonly Request[];
  settled(): Promise<void>;
}

export function inProcessFetch(serve: ServeRequest): InProcessFetch {
  const pending = new Set<Promise<void>>();
  const requests: Request[] = [];
  return {
    requests,
    async fetch(url, init) {
      const target = new URL(String(url));
      const headers = new Headers(init?.headers);
      headers.set("host", target.host);
      const request = new Request(target, { ...init, headers });
      requests.push(request);
      const served = serve(request);
      const tracked = served.then(
        () => undefined,
        () => undefined,
      );
      pending.add(tracked);
      void tracked.then(() => pending.delete(tracked));
      const signal = init?.signal ?? undefined;
      if (signal === undefined) return served;
      if (signal.aborted) throw signal.reason;
      // Real fetch rejects the moment its signal aborts; the server keeps its own copy running.
      return new Promise<Response>((resolveResponse, rejectResponse) => {
        const onAbort = () => rejectResponse(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        served.then(
          (response) => {
            signal.removeEventListener("abort", onAbort);
            resolveResponse(response);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            rejectResponse(error);
          },
        );
      });
    },
    async settled() {
      await Promise.all([...pending]);
    },
  };
}

/** The production handler with the given identity; null passes none. */
export function handlerServe(authInfo: AuthInfo | null = testAuthInfo()): ServeRequest {
  return async (request) => {
    const { mcpHandler } = await import("@/lib/mcp/server");
    return mcpHandler.fetch(request, authInfo === null ? undefined : { authInfo });
  };
}

export interface RouteMethods {
  POST(request: Request): Promise<Response>;
  GET(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
}

export function routeServe(route: RouteMethods): ServeRequest {
  return (request) => {
    const method = request.method.toUpperCase();
    if (method === "POST") return route.POST(request);
    if (method === "DELETE") return route.DELETE(request);
    return route.GET(request);
  };
}

export type Negotiation = "legacy" | "auto" | "pinned";

export interface ConnectOptions {
  readonly negotiation?: Negotiation;
  readonly token?: string;
  readonly supportedProtocolVersions?: string[];
  readonly capabilities?: ClientCapabilities;
}

export interface TestClient {
  readonly client: Client;
  readonly http: InProcessFetch;
  close(): Promise<void>;
}

export async function connectClient(serve: ServeRequest, options: ConnectOptions = {}): Promise<TestClient> {
  const http = inProcessFetch(serve);
  const transport = new StreamableHTTPClientTransport(new URL(MCP_TEST_URL), {
    fetch: http.fetch,
    ...(options.token === undefined ? {} : { requestInit: { headers: { Authorization: `Bearer ${options.token}` } } }),
  });
  const negotiation = options.negotiation ?? "legacy";
  const client = new Client(TEST_CLIENT, {
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.supportedProtocolVersions === undefined
      ? {}
      : { supportedProtocolVersions: options.supportedProtocolVersions }),
    ...(negotiation === "legacy"
      ? {}
      : { versionNegotiation: { mode: negotiation === "auto" ? ("auto" as const) : { pin: MODERN_REVISION } } }),
  });
  await client.connect(transport);
  return {
    client,
    http,
    // The server's pending answers settle first, then the client closes, so no answer is cut off.
    close: async () => {
      await http.settled();
      await client.close();
    },
  };
}

export function testAuthInfo(
  identity: { username: string; role: "admin" | "user" } = { username: "alice", role: "admin" },
): AuthInfo {
  return {
    token: "handler-level-test-identity",
    clientId: `test:${identity.username}`,
    scopes: ["mcp:read"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { username: identity.username, role: identity.role },
  };
}

export interface PostOptions {
  readonly token?: string;
  readonly headers?: Record<string, string | null>;
  readonly signal?: AbortSignal;
}

export function mcpPostHeaders(options: PostOptions = {}): Headers {
  const headers = new Headers({
    host: new URL(MCP_TEST_URL).host,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

function post(body: unknown, headers: Headers, signal: AbortSignal | undefined): Request {
  return new Request(MCP_TEST_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** A 2025-era POST: MCP-Protocol-Version 2025-11-25 unless version says otherwise, null for none. */
export function legacyPost(body: unknown, options: PostOptions & { readonly version?: string | null } = {}): Request {
  const version = options.version === undefined ? LEGACY_REVISION : options.version;
  const headers = mcpPostHeaders({
    ...options,
    headers: { ...(version === null ? {} : { "mcp-protocol-version": version }), ...options.headers },
  });
  return post(body, headers, options.signal);
}

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN_REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": TEST_CLIENT,
};

function modernHeaders(method: string, name: string | undefined, options: PostOptions): Headers {
  return mcpPostHeaders({
    ...options,
    headers: {
      "mcp-protocol-version": MODERN_REVISION,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
      ...options.headers,
    },
  });
}

/** A 2026-07-28 request with the envelope and the standard headers; id 1 unless given. */
export function modernPost(
  method: string,
  params: Record<string, unknown>,
  options: PostOptions & { readonly id?: string | number | null; readonly name?: string } = {},
): Request {
  const id = options.id === undefined ? 1 : options.id;
  const body = { jsonrpc: "2.0", id, method, params: { ...params, _meta: ENVELOPE } };
  return post(body, modernHeaders(method, options.name, options), options.signal);
}

export function modernNotification(
  method: string,
  params: Record<string, unknown>,
  options: PostOptions = {},
): Request {
  const body = { jsonrpc: "2.0", method, params: { ...params, _meta: ENVELOPE } };
  return post(body, modernHeaders(method, undefined, options), options.signal);
}

export interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method?: string;
  readonly result?: Record<string, any>;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export async function readSseMessages(response: Response): Promise<JsonRpcMessage[]> {
  const text = await response.text();
  const messages: JsonRpcMessage[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data !== "") messages.push(JSON.parse(data) as JsonRpcMessage);
  }
  return messages;
}

export async function readJsonRpc(response: Response): Promise<JsonRpcMessage> {
  if ((response.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    const replies = (await readSseMessages(response)).filter((message) => message.id !== undefined);
    const last = replies.at(-1);
    if (last === undefined) throw new Error("the event stream carried no JSON-RPC reply");
    return last;
  }
  return (await response.json()) as JsonRpcMessage;
}
