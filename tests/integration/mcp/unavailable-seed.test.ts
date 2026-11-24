/**
 * A seed entry whose type names no provider this Studio has (FND-1), opted in to MCP: it keeps its opt-in and is
 * listed by `list_connections` with its type as written, no read tool and the refusal's sentence in `unavailable`;
 * every tool that names it answers that sentence before anything is acquired; and a token whose only connection it is
 * lists the metadata tools and no statement tool. The seed file's other entries are served as before.
 *
 * Measured on 2026-11-20 before the change: one such entry failed the whole seed file, so every tool answered that the
 * configuration could not be read, and tools/list answered JSON-RPC -32603.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerAuditBuffer } from "@/lib/audit";
import { unknownTypeSentence } from "@/lib/db/type-id";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_READ_ONLY_ANNOTATIONS } from "@/lib/mcp/output";
import { servingStatementArms } from "@/lib/mcp/tools/statement-arms";
import { createSqliteFile, pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";
import { listedMcpToolNames, registeredMcpToolNames } from "../../helpers/mcp-tool-names";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-unavailable-seed-"));
const admin = handlerServe(testAuthInfo({ username: "alice", role: "admin" }));
const SENTENCE = unknownTypeSentence("acmefoo");

beforeAll(() => {
  createSqliteFile(join(dir, "shop.db"), ["CREATE TABLE users (id INTEGER PRIMARY KEY)"]);
});

afterEach(async () => {
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedAcmeAndShop(): void {
  writeSeedFile(dir, [
    { id: "acme", name: "Acme Store", type: "acmefoo", host: "acme.internal", password: "CANARY-7f3a" },
    { id: "shop", name: "Shop", type: "sqlite", database: join(dir, "shop.db") },
  ]);
}

/** A statement as text, and one as a command document: every statement tool's input schema admits one of them. */
const STATEMENTS: readonly unknown[] = ["SELECT 1", { ping: 1 }];

/** Arguments naming seed:acme that `tool`'s input schema admits. */
function acmeArguments(tool: string): Record<string, unknown> {
  const arm = servingStatementArms().find((serving) => serving.tool === tool);
  if (arm === undefined) return { connection_id: "seed:acme" };
  for (const statement of STATEMENTS) {
    const args = { connection_id: "seed:acme", [arm.argument]: statement };
    if (arm.inputSchema.safeParse(args).success) return args;
  }
  throw new Error(`no statement in STATEMENTS is admitted by ${tool}'s input schema`);
}

async function callTool(name: string, args: Record<string, unknown>) {
  const session = await connectClient(admin);
  try {
    return (await session.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    };
  } finally {
    await session.close();
  }
}

describe("a seed whose type names no provider, opted in to MCP", () => {
  test("list_connections lists it with its type as written, no read tool and the refusal, beside the file's other seed", async () => {
    seedAcmeAndShop();

    const result = await callTool("list_connections", {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.connections).toEqual([
      { id: "seed:shop", name: "Shop", engine: "sqlite", database: "shop.db", read_tool: "run_read_query" },
      { id: "seed:acme", name: "Acme Store", engine: "acmefoo", read_tool: null, unavailable: SENTENCE },
    ]);
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  test("inspect_schema and every statement tool answer the refusal's sentence and acquire nothing", async () => {
    seedAcmeAndShop();
    const acquire = spyOn(McpConnectionContext.prototype, "acquire");
    try {
      const tools = registeredMcpToolNames().filter((tool) => tool !== "list_connections");
      expect(tools).toContain("inspect_schema");
      expect(tools).toContain("run_read_query");
      for (const tool of tools) {
        // oxlint-disable-next-line no-await-in-loop -- one tool at a time, so a failure names its tool.
        const result = await callTool(tool, acmeArguments(tool));
        expect({ tool, isError: result.isError, content: result.content }).toEqual({
          tool,
          isError: true,
          content: [{ type: "text", text: SENTENCE }],
        });
      }
      expect(acquire).not.toHaveBeenCalled();
      const events = getServerAuditBuffer()
        .getAll()
        .filter((event) => event.type === "mcp_operation");
      expect(events.map((event) => [event.action, event.reason])).toEqual(
        tools.map((tool) => [tool, "mcp_execution_failed"]),
      );
    } finally {
      acquire.mockRestore();
    }
  });

  test("a token whose only connection it is lists the metadata tools alone, inspect_schema with the read-only hints", async () => {
    writeSeedFile(dir, [{ id: "acme", name: "Acme Store", type: "acmefoo" }]);
    const session = await connectClient(admin);
    try {
      const { tools } = await session.client.listTools();
      // The tools a token that reaches no engine lists: the metadata tools, and no statement tool.
      expect(tools.map((tool) => tool.name)).toEqual(listedMcpToolNames(new Set()));
      expect(tools.find((tool) => tool.name === "inspect_schema")?.annotations).toEqual({
        ...MCP_READ_ONLY_ANNOTATIONS,
      });
    } finally {
      await session.close();
    }
  });
});
