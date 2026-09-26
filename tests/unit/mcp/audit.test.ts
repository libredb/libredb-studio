/**
 * The mcp_operation events (#246): a decision before any provider is reached, an outcome after
 * it, and one event for minting a token, each written through emitAuditEvent to the ring buffer
 * and the authoritative stdout line. The emitters let a sink failure through on purpose: the
 * caller is the one that fails closed.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getServerAuditBuffer } from "@/lib/audit";
import {
  MCP_AUDIT_FAILURE_TEXT,
  MCP_DECISION_TARGET,
  MCP_EXECUTION_TARGET,
  MCP_TOKEN_TARGET,
  newMcpCorrelationId,
  recordMcpDecision,
  recordMcpMint,
  recordMcpOutcome,
} from "@/lib/mcp/audit";

let logSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  getServerAuditBuffer().clear();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  getServerAuditBuffer().clear();
});

const lines = (): Record<string, unknown>[] =>
  logSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

const call = { action: "run_read_query" as const, user: "alice", correlationId: "a-correlation-id-written-in-words" };

describe("the decision event", () => {
  test("of an allowed call is an mcp_operation success at mcp/decision, with the resolved seed id", () => {
    recordMcpDecision({ ...call, connectionName: "shop" });
    const [line] = lines();
    expect(line).toMatchObject({
      event: "mcp_operation",
      action: "run_read_query",
      outcome: "success",
      actor: "alice",
      route: MCP_DECISION_TARGET,
      connection: "shop",
      correlation_id: call.correlationId,
    });
    expect(line).not.toHaveProperty("reason");
    expect(getServerAuditBuffer().getAll()).toHaveLength(1);
  });

  test("of a refused call carries its reason, and no connection before resolution", () => {
    recordMcpDecision(call, "mcp_connection_not_visible");
    const [line] = lines();
    expect(line).toMatchObject({
      outcome: "failure",
      reason: "mcp_connection_not_visible",
      route: MCP_DECISION_TARGET,
    });
    expect(line).not.toHaveProperty("connection");
  });

  test("lets a sink failure through, so the caller can refuse to run", () => {
    logSpy.mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    expect(() => recordMcpDecision(call)).toThrow("audit sink unavailable");
  });
});

describe("the outcome event", () => {
  test("is written at mcp/execution with its duration", () => {
    recordMcpOutcome({ ...call, connectionName: "shop" }, 42);
    expect(lines()[0]).toMatchObject({
      route: MCP_EXECUTION_TARGET,
      outcome: "success",
      duration_ms: 42,
      connection: "shop",
    });
  });

  test("of a failure carries its reason", () => {
    recordMcpOutcome(call, 7, "mcp_timeout");
    expect(lines()[0]).toMatchObject({
      route: MCP_EXECUTION_TARGET,
      outcome: "failure",
      reason: "mcp_timeout",
      duration_ms: 7,
    });
  });
});

describe("the mint event", () => {
  test("is mint_token at mcp/token for the session user, with no correlation id", () => {
    recordMcpMint("bob");
    const [line] = lines();
    expect(line).toMatchObject({
      event: "mcp_operation",
      action: "mint_token",
      route: MCP_TOKEN_TARGET,
      actor: "bob",
      outcome: "success",
    });
    expect(line).not.toHaveProperty("correlation_id");
  });
});

test("correlation ids are fresh UUIDs", () => {
  const ids = new Set(Array.from({ length: 5 }, () => newMcpCorrelationId()));
  expect(ids.size).toBe(5);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the text of a call that could not be recorded is fixed", () => {
  expect(MCP_AUDIT_FAILURE_TEXT).toBe("The call was not run because its audit record could not be written.");
});
