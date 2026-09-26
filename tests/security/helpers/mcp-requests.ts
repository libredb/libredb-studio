/**
 * Requests and audit-line readers the MCP security suites share (#246).
 *
 * Every request carries an explicit Host unless a test removes it, as csrf-origin.test.ts builds
 * its requests: a constructed request carries none, and the loopback Host check must not depend
 * on the machine running the tests. They are NextRequests so that proxy() can read nextUrl; the
 * route handlers take them as the plain Requests they also are.
 */
import { NextRequest } from "next/server";

/** A request to /api/mcp from localhost with a JSON body on POST; headers are added or replaced. */
export function mcpRequest(method: string, headers: Record<string, string> = {}, path = "/api/mcp"): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: new Headers({ host: "localhost:3000", "content-type": "application/json", ...headers }),
    ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } : {}),
  });
}

/** A request to /api/mcp carrying exactly the given headers, Host included or not. */
export function originHostRequest(method: string, headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3000/api/mcp", {
    method,
    headers: new Headers(headers),
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}

/** The permission_denied lines written to stdout, ignoring any line that is not JSON. */
export function permissionDeniedLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => {
      try {
        return JSON.parse(String(call[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line !== null && line.event === "permission_denied");
}
