/**
 * Which handler serves a POST (#2252, part 3): a plain tools/list goes to the per-token list handler, and every other
 * body, a batch or a malformed one included, to the full handler, which registers every tool this build serves.
 */
import { describe, expect, test } from "bun:test";
import { mcpHandler, mcpHandlerFor, mcpListHandler } from "@/lib/mcp/server";

describe("mcpHandlerFor", () => {
  test("picks the list handler for a plain object whose method is tools/list", () => {
    expect(mcpHandlerFor({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(mcpListHandler);
    expect(mcpHandlerFor({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: {} } })).toBe(mcpListHandler);
  });

  test.each([
    ["a tools/call", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_connections" } }],
    ["initialize", { jsonrpc: "2.0", id: 1, method: "initialize" }],
    ["server/discover", { jsonrpc: "2.0", id: 1, method: "server/discover" }],
    ["ping", { jsonrpc: "2.0", id: 1, method: "ping" }],
    ["notifications/initialized", { jsonrpc: "2.0", method: "notifications/initialized" }],
    ["an array holding a tools/list", [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]],
    ["null", null],
    ["undefined", undefined],
    ["the string tools/list", "tools/list"],
    ["a number", 42],
    ["another spelling of the method", { method: "TOOLS/LIST" }],
    ["a method that is not a string", { method: ["tools/list"] }],
  ])("picks the full handler for %s", (_name, body) => {
    expect(mcpHandlerFor(body)).toBe(mcpHandler);
  });

  test("the list handler is a handler of its own", () => {
    expect(mcpListHandler).not.toBe(mcpHandler);
  });
});
