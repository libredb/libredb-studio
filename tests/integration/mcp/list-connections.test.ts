/**
 * list_connections (#246), through the production handler and the official client in both eras:
 * the opted-in connections without credentials or file paths, paged under the 32 KiB result cap,
 * in one compact JSON block with no untrusted-content notice, and one audit event per call.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerAuditBuffer } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { MCP_RESULT_CAP_BYTES, MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { LIST_CONNECTIONS_DESCRIPTION } from "@/lib/mcp/tools/list-connections";
import { resetCache } from "@/lib/seed";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile, type SeedEntry } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo, type Negotiation } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-list-"));
const serve = handlerServe(testAuthInfo());

afterEach(async () => {
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Listed {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>;
}

async function list(args: Record<string, unknown> = {}, negotiation: Negotiation = "legacy"): Promise<Listed> {
  const session = await connectClient(serve, { negotiation });
  try {
    return (await session.client.callTool({ name: "list_connections", arguments: args })) as Listed;
  } finally {
    await session.close();
  }
}

/** What the handler returned, measured as byte_size is: the era's own additions left out. */
const handlerBytes = (result: Listed) =>
  new TextEncoder().encode(JSON.stringify({ content: result.content, structuredContent: result.structuredContent }))
    .byteLength;

const SHOP: SeedEntry = {
  id: "shop",
  type: "sqlite",
  database: "/srv/libredb/data/shop.db",
  environment: "production",
};
const ANALYTICS: SeedEntry = {
  id: "analytics",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  database: "analytics",
};

describe("the answer", () => {
  test.each(["legacy", "pinned"] as const)(
    "is the connections structured, in one compact JSON block and no notice (%s)",
    async (negotiation) => {
      writeSeedFile(dir, [SHOP, ANALYTICS]);
      const result = await list({}, negotiation);
      expect(result.isError ?? false).toBe(false);
      expect(result.structuredContent).toEqual({
        connections: [
          { id: "seed:shop", name: "shop", engine: "sqlite", database: "shop.db", environment: "production" },
          { id: "seed:analytics", name: "analytics", engine: "postgres", database: "analytics" },
        ],
        total_connections: 2,
        has_more: false,
        next_offset: null,
      });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
      expect(JSON.stringify(result)).not.toContain(MCP_UNTRUSTED_NOTICE);
    },
  );

  test("carries no read_only, host, port, user, password, connection string or file path", async () => {
    writeSeedFile(dir, [SHOP, { ...ANALYTICS, environment: "production" }]);
    const text = JSON.stringify(await list());
    for (const hidden of ["read_only", "db.internal", "5432", "/srv/libredb", "password", "connectionString"]) {
      expect(text).not.toContain(hidden);
    }
  });

  test("names a file-based database by its file name alone, a Windows path included", async () => {
    writeSeedFile(dir, [
      { id: "warehouse", type: "duckdb", database: "C:\\data\\warehouse.duckdb" },
      { id: "notes", type: "libredb", database: "/var/lib/studio/notes.libredb" },
    ]);
    const databases = (await list()).structuredContent?.connections.map(
      (connection: { database: string }) => connection.database,
    );
    expect(databases).toEqual(["warehouse.duckdb", "notes.libredb"]);
  });

  test("with no seed file at all is the empty list", async () => {
    process.env.SEED_CONFIG_PATH = join(dir, "absent-seed-connections.yaml");
    resetCache();
    expect((await list()).structuredContent).toEqual({
      connections: [],
      total_connections: 0,
      has_more: false,
      next_offset: null,
    });
  });

  test("is filtered by environment before it is counted", async () => {
    writeSeedFile(dir, [SHOP, ANALYTICS]);
    const result = await list({ environment: "production" });
    expect(result.structuredContent?.connections.map((connection: { id: string }) => connection.id)).toEqual([
      "seed:shop",
    ]);
    expect(result.structuredContent?.total_connections).toBe(1);
  });
});

describe("paging under the 32 KiB cap", () => {
  const MANY: SeedEntry[] = Array.from({ length: 300 }, (_, index) => ({
    id: `conn-${index}`,
    type: "postgres",
    host: "db.internal",
    database: `database_${index}`,
    name: `${"connection name written out at length ".repeat(3)}${index}`,
  }));

  test("lists every connection exactly once across pages, each page within the cap", async () => {
    writeSeedFile(dir, MANY);
    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const result = await list({ offset });
      pages += 1;
      expect(handlerBytes(result)).toBeLessThanOrEqual(MCP_RESULT_CAP_BYTES);
      seen.push(...result.structuredContent?.connections.map((connection: { id: string }) => connection.id));
      if (!result.structuredContent?.has_more) break;
      expect(result.structuredContent.next_offset).toBe(offset + result.structuredContent.connections.length);
      offset = result.structuredContent.next_offset;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(MANY.map((entry) => `seed:${entry.id}`));
  });

  test("an entry that alone does not fit ends the page before it, and is then refused by name and recorded as too large", async () => {
    writeSeedFile(dir, [
      ANALYTICS,
      { id: "huge", type: "postgres", host: "db.internal", database: "d".repeat(40_000) },
    ]);
    const first = await list();
    expect(first.structuredContent).toMatchObject({ has_more: true, next_offset: 1 });
    const refused = await list({ offset: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    expect(refused.content).toEqual([
      {
        type: "text",
        text: "The connection seed:huge cannot be listed within the 32 KiB result limit on its own. Ask the operator to shorten that seed entry.",
      },
    ]);
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "mcp_operation");
    expect(events.map((event) => [event.action, event.result, event.reason])).toEqual([
      ["list_connections", "success", undefined],
      ["list_connections", "failure", "mcp_result_too_large"],
    ]);
  });
});

describe("the audit record", () => {
  test("is one mcp_operation event for the token's user, with no connection", async () => {
    writeSeedFile(dir, [SHOP]);
    await list();
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "mcp_operation");
    expect(events).toEqual([
      expect.objectContaining({ action: "list_connections", target: "mcp/decision", user: "alice", result: "success" }),
    ]);
    expect(events[0].connectionName).toBeUndefined();
  });

  test("that cannot be written withholds the list behind the fixed error", async () => {
    writeSeedFile(dir, [SHOP]);
    const sink = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const result = await list();
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "The call was not run because its audit record could not be written." },
      ]);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      sink.mockRestore();
      errorLog.mockRestore();
    }
  });
});

describe("the registration", () => {
  test.each(["legacy", "pinned"] as const)(
    "gives the tool its title, description, annotations and output schema (%s)",
    async (negotiation) => {
      writeSeedFile(dir, [SHOP]);
      const session = await connectClient(serve, { negotiation });
      try {
        const tool = (await session.client.listTools()).tools.find(
          (candidate) => candidate.name === "list_connections",
        );
        expect(tool?.title).toBe("List connections");
        expect(tool?.description).toBe(LIST_CONNECTIONS_DESCRIPTION);
        expect(tool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
        expect(tool?.outputSchema?.type).toBe("object");
        expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["environment", "offset"]);
      } finally {
        await session.close();
      }
    },
  );
});
