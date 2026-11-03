/**
 * run_snmp_read: MCP's SNMP arm, run by the statement core over the real SNMP provider the factory builds, through the
 * real route, seed file and handler, with an SNMPv2c agent over a real UDP socket in place of a device.
 *
 * The request is the agent's own, read and admitted by the agent's own SNMP reader: a read answers the device's values
 * behind the untrusted-content notice, with the reason of every withheld subtree it stepped over or answered withheld
 * as its notes, and never a withheld value or instance, a running process's command line, a command the agent runs or
 * the community; a set, a walk inside a withheld subtree and every form outside the four commands are refused before
 * anything is acquired; and inspect_schema lists the bundled catalog's tables and scalar groups without the ones inside
 * a withheld subtree.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_LANGUAGE_COPY } from "@/lib/agent/agent-manifest";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import { SnmpProvider } from "@/lib/db/providers/network/snmp";
import { SNMP_WITHHELD_SUBTREES, withheldReason } from "@/lib/db/providers/network/snmp/agent-statement";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { type FakeAgent, integer, startFakeAgent, text, ticks } from "../../helpers/snmp-fake-agent";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-snmp-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("snmpget");
const RUN_SNMP_READ_ARM = mcpStatementArm("run_snmp_read");
/** Obviously not a real credential; no answer, error or note may carry it. */
const COMMUNITY = "not-a-real-community";
const ENCODED = (value: string) => [...new TextEncoder().encode(value)].join(".");
const at = (module: string) => SNMP_WITHHELD_SUBTREES.find((entry) => entry.module === module)!;

/**
 * What the agent holds: the system group, an interface, a running process whose parameters carry a planted secret, the
 * per-process figures beside it, an extend directive's command and output, and the agent's own community row.
 */
const TREE = new Map([
  ["1.3.6.1.2.1.1.1.0", text("a test agent")],
  ["1.3.6.1.2.1.1.3.0", ticks(9)],
  ["1.3.6.1.2.1.1.5.0", text("router-one")],
  ["1.3.6.1.2.1.2.2.1.2.1", text("lo")],
  ["1.3.6.1.2.1.25.1.1.0", ticks(5)],
  ["1.3.6.1.2.1.25.4.2.1.2.6", text("backup-job")],
  ["1.3.6.1.2.1.25.4.2.1.5.6", text("--password=marker-cmdline")],
  ["1.3.6.1.2.1.25.5.1.1.1.6", integer(3)],
  [`1.3.6.1.4.1.8072.1.3.2.3.1.1.${ENCODED("probe")}`, text("marker-extend-output")],
  ["1.3.6.1.4.1.8072.1.5.1.0", integer(1)],
  [`1.3.6.1.6.3.18.1.1.1.2.${ENCODED(COMMUNITY)}`, text(COMMUNITY)],
]);
const WITHHELD = ["marker", "backup-job", COMMUNITY, ENCODED(COMMUNITY), ENCODED("probe")];

let agent: FakeAgent;

beforeAll(async () => {
  agent = await startFakeAgent(TREE);
});

const SNMP_SEED = () => ({ id: "router", type: "snmp", host: "127.0.0.1", port: agent.port, password: COMMUNITY });

beforeEach(() => {
  agent.requests.length = 0;
  writeSeedFile(dir, [SNMP_SEED(), { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
});

afterEach(async () => {
  mock.restore();
  await resetMcpTestState();
});

afterAll(() => {
  agent.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Answered {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>;
}

async function call(name: string, args: Record<string, unknown>): Promise<Answered> {
  const session = await connectClient(serve, { negotiation: "legacy" });
  try {
    return (await session.client.callTool({ name, arguments: args })) as Answered;
  } finally {
    await session.close();
  }
}

const snmp = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_snmp_read", { connection_id: "seed:router", statement, ...extra });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

/** Every identifier the agent was asked for, after the connect probe. */
const asked = () => agent.requests.flatMap((request) => request.oids);

const expectNoWithheld = (answer: Answered) => {
  const text = JSON.stringify(answer);
  for (const word of WITHHELD) expect(text).not.toContain(word);
};

describe("the tool", () => {
  test("is listed read-only, with the statement schema, no offset or database, and the shared least timeout", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      const tool = tools.find((candidate) => candidate.name === "run_snmp_read");
      expect(tool?.description).toBe(RUN_SNMP_READ_ARM.description);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
        "connection_id",
        "statement",
        "max_rows",
        "timeout_ms",
      ]);
      expect(tool?.inputSchema.properties?.timeout_ms).toMatchObject({ minimum: 500, maximum: 30000, default: 10000 });
      expect(RUN_SNMP_READ_ARM.engines).toBe("SNMP");
    } finally {
      await session.close();
    }
  });

  test("list_connections names it as the SNMP connection's read tool, with no community", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:router", "run_snmp_read"],
      ["seed:shop", "run_read_query"],
    ]);
    expectNoWithheld(result);
  });

  test("inspect_schema lists the bundled catalog's tables and scalar groups, none inside a withheld subtree, asking nothing past the connect probe", async () => {
    const result = await call("inspect_schema", { connection_id: "seed:router", include_columns: false });
    expect(result.isError ?? false).toBe(false);
    const tables = (result.structuredContent?.tables ?? []) as Array<{ name: string; kind: string }>;
    const names = tables.map((table) => table.name);
    expect(new Set(tables.map((table) => table.kind))).toEqual(new Set(["table", "scalars"]));
    expect(names).toContain("ifTable");
    expect(names).toContain("hrSWRunPerfTable");
    expect(names).not.toContain("hrSWRunTable");
    expect(names).not.toContain("hrSWRun");
    // The connect probe alone: the catalog is the bundled modules', so listing it asks the agent nothing.
    expect(agent.requests).toHaveLength(1);
    expectNoWithheld(result);
  });
});

describe("a read", () => {
  test("a get answers the device's values behind the notice, with no notes where nothing was withheld", async () => {
    const result = await snmp("get sysDescr.0 sysName.0");
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:router",
      rows: [
        { object: "1.3.6.1.2.1.1.1.0", value: "a test agent", type: "text" },
        { object: "1.3.6.1.2.1.1.5.0", value: "router-one", type: "text" },
      ],
      row_count: 2,
      truncated: false,
      hint: null,
    });
    expect(result.structuredContent).not.toHaveProperty("notes");
    expectNoWithheld(result);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_snmp_read", "mcp/decision", "success"],
      ["run_snmp_read", "mcp/execution", "success"],
    ]);
  });

  test("a walk of the host group steps over the running processes, answers what lies beside them, and says why in its notes", async () => {
    const result = await snmp("walk host");
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.rows).toEqual([
      { object: "1.3.6.1.2.1.25.1.1.0", value: "5", type: "number" },
      { object: "1.3.6.1.2.1.25.5.1.1.1.6", value: "3", type: "number" },
    ]);
    expect(result.structuredContent?.notes).toEqual([withheldReason(at("HOST-RESOURCES-MIB::hrSWRun"))]);
    expect(asked().every((oid) => !oid.startsWith("1.3.6.1.2.1.25.4."))).toBe(true);
    expectNoWithheld(result);
  });

  test("a walk of the enterprise subtree steps over the extend directives' commands and output", async () => {
    const result = await snmp("walk 1.3.6.1.4.1.8072.1");
    expect(result.structuredContent?.rows).toEqual([
      { object: "1.3.6.1.4.1.8072.1.5.1.0", value: "1", type: "number" },
    ]);
    expect(result.structuredContent?.notes).toEqual([
      withheldReason(at("NET-SNMP-EXTEND-MIB::nsExtendObjects")),
      withheldReason(at("NET-SNMP-VACM-MIB")),
    ]);
    expectNoWithheld(result);
  });

  test("a get of a running process's parameters answers it withheld and never asks the agent for it", async () => {
    const result = await snmp("get hrSWRunParameters.6 sysName.0");
    expect(result.structuredContent?.rows).toEqual([
      { object: "1.3.6.1.2.1.25.4", value: null, type: "withheld" },
      { object: "1.3.6.1.2.1.1.5.0", value: "router-one", type: "text" },
    ]);
    expect(result.structuredContent?.notes).toEqual([withheldReason(at("HOST-RESOURCES-MIB::hrSWRun"))]);
    expect(asked()).not.toContain("1.3.6.1.2.1.25.4.2.1.5.6");
    expectNoWithheld(result);
  });

  test("a next that lands inside the community module answers it withheld, never the instance the agent sent back", async () => {
    const result = await snmp("next 1.3.6.1.6.3.17");
    expect(result.structuredContent?.rows).toEqual([{ object: "1.3.6.1.6.3.18", value: null, type: "withheld" }]);
    expectNoWithheld(result);
  });
});

describe("a refusal", () => {
  test.each([
    ["a set", "set sysName.0 s x"],
    ["a walk inside the community module", "walk 1.3.6.1.6.3.18"],
    ["a table of the running processes", "table hrSWRunTable"],
    ["a walk of the extend directives", "walk 1.3.6.1.4.1.8072.1.3"],
    ["a walk of the exec directives", "walk 1.3.6.1.4.1.2021.8"],
    ["a walk of a Cisco configuration copy", "walk 1.3.6.1.4.1.9.9.96"],
    ["a trap", "trap 1.3.6.1.6.3.1.1.5.1"],
    ["Net-SNMP's tool syntax", "snmpget -v2c -c public 127.0.0.1 sysDescr.0"],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, statement) => {
    const acquire = spyOn(McpConnectionContext.prototype, "acquire");
    const result = await snmp(statement);
    const refusal = server.admit?.(statement);
    expect(refusal).not.toBeNull();
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The ${AGENT_LANGUAGE_COPY.snmpget.noun} was refused before it reached the agent (${refusal?.code}). ${refusal?.message}`,
        },
      ],
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(agent.requests).toEqual([]);
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_snmp_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test.each(["database", "offset"])(
    "an argument the tool does not name (%s) is refused, not dropped, before anything is acquired",
    async (key) => {
      const result = await snmp("get sysDescr.0", { [key]: key === "offset" ? 1 : "elsewhere" });
      expect(result.isError).toBe(true);
      const text = result.content.map((block) => block.text).join("\n");
      expect(text).toContain("Input validation error");
      expect(text).toContain(key);
      expect(agent.requests).toEqual([]);
    },
  );

  test("a provider not opened under the agent read-only profile refuses the read, and asks the agent nothing for it", async () => {
    spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(async (connection: ManagedConnection) => {
      const provider = new SnmpProvider(connection as DatabaseConnection, {}, {});
      await provider.connect();
      return provider;
    });
    const result = await snmp("get sysDescr.0");
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    // The editor handle's own connect probe, and no request for the read.
    expect(agent.requests).toHaveLength(1);
  });

  test("an agent that never answers is the timeout answer at timeout_ms, naming no community", async () => {
    const silent = await startFakeAgent(TREE, { silentOn: (request) => request > 1 });
    writeSeedFile(dir, [{ ...SNMP_SEED(), port: silent.port }]);
    try {
      const started = Date.now();
      const result = await snmp("get sysDescr.0", { timeout_ms: 500 });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.isError).toBe(true);
      expectNoWithheld(result);
    } finally {
      silent.close();
    }
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_snmp_read", { connection_id: "seed:shop", statement: "get sysDescr.0" });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_snmp_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on SNMP.",
        },
      ],
    });
  });
});

describe("the words a cut result would take", () => {
  test("say to narrow the walk, since an SNMP read is never paged", () => {
    expect(RUN_SNMP_READ_ARM.moreRows("walk mib-2", "snmp", { maxRows: 1, shown: 1, cut: "max_rows" })).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice("walk mib-2", "1")} To read past the 1 row returned, raise max_rows (at most 500), or walk a narrower subtree, since an SNMP read is never paged.`,
    );
    expect(RUN_SNMP_READ_ARM.moreRows("walk mib-2", "snmp", { maxRows: 1, shown: 0, cut: "result_bytes" })).toBe(
      "More rows exist than the 32 KiB result limit holds, and 0 of them fitted; this tool does not page with offset. Walk one column, or name the instances with get, to fit more rows, and to read past the 0 rows returned, walk a narrower subtree, since an SNMP read is never paged.",
    );
  });
});
