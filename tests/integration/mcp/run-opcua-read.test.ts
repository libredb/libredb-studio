/**
 * run_opcua_read: MCP's OPC UA arm, run by the statement core over the real OPC UA provider the factory builds, through
 * the real route, seed file and handler, with `node-opcua-server` started here on a port the system picks in place of
 * a plant server.
 *
 * The request is the agent's own, read and admitted by the agent's own OPC UA reader, and it reads only beneath the read
 * roots the seed declares: a value read of a member answers its value with its engineering units behind the
 * untrusted-content notice, a browse of a member lists the references the walk kept and counts the ones that lead
 * outside, and every node outside the roots, a pruned session object and credential beneath them included, answers
 * exactly as a missing id does, never with its value; a seed whose roots are missing is refused with
 * READ_ROOTS_REQUIRED; a write, a call and every key outside the three reads are refused before anything is acquired;
 * and inspect_schema refuses an OPC UA connection by name.
 */
// oxlint-disable no-await-in-loop -- one call at a time: each opens and closes its own session on the server.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "@/lib/db/providers/industrial/opcua/hostname-guard";
import { OPCUACertificateManager } from "node-opcua-certificate-manager";
import { DataType, Variant } from "node-opcua-client";
import { OPCUAServer } from "node-opcua-server";
import { AGENT_LANGUAGE_COPY } from "@/lib/agent/agent-manifest";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import { OPCUA_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/industrial/opcua/agent-read";
import { OPCUA_ROOTS_WARNING, outwardNote } from "@/lib/db/providers/industrial/opcua/agent-roots";
import { OpcuaProvider } from "@/lib/db/providers/industrial/opcua/index";
import { openLibrarySession } from "@/lib/db/providers/industrial/opcua/library";
import { OPCUA_PKI_ROOT_ENV } from "@/lib/db/providers/industrial/opcua/pki";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-opcua-"));
const serve = handlerServe(testAuthInfo());
const reader = languageServer("opcuaread");
const RUN_OPCUA_READ_ARM = mcpStatementArm("run_opcua_read");
/** Every planted value starts with this word; no answer, error or note may carry it. */
const PLANTED = "planted";
const PKI_BEFORE = process.env[OPCUA_PKI_ROOT_ENV];

let server: OPCUAServer;
let endpoint = "";
let root = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
  process.env[OPCUA_PKI_ROOT_ENV] = join(dir, "client-pki");
  server = new OPCUAServer({
    port: 0,
    resourcePath: "/libredb-mcp",
    serverCertificateManager: new OPCUACertificateManager({
      rootFolder: join(dir, "server-pki"),
      automaticallyAcceptUnknownCertificate: true,
    }),
    buildInfo: { productName: "libredb-mcp-server", buildNumber: "1", buildDate: new Date(0) },
  });
  await server.initialize();
  const space = server.engine.addressSpace;
  if (space === null || space === undefined) throw new Error("the server started with no address space");
  const namespace = space.getOwnNamespace();
  const plant = namespace.addFolder("ObjectsFolder", { browseName: "Plant" });
  ids.plant = plant.nodeId.toString();
  // The root as an operator writes it: the identifier of the plant folder, its namespace by URI.
  root = `nsu=${namespace.namespaceUri};${ids.plant.slice(ids.plant.indexOf(";") + 1)}`;
  const office = namespace.addFolder("ObjectsFolder", { browseName: "Office" });
  ids.outside = namespace
    .addVariable({
      componentOf: office,
      browseName: "Recipe",
      dataType: "String",
      minimumSamplingInterval: 1000,
      value: new Variant({ dataType: DataType.String, value: `${PLANTED}-recipe` }),
    })
    .nodeId.toString();
  const temperature = namespace.addAnalogDataItem({
    componentOf: plant,
    browseName: "Temperature",
    dataType: "Double",
    engineeringUnitsRange: { low: -40, high: 120 },
    engineeringUnits: {
      namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact",
      unitId: 4408652,
      displayName: { text: "°C" },
    } as never,
    value: new Variant({ dataType: DataType.Double, value: 21.5 }),
  });
  ids.temperature = temperature.nodeId.toString();
  ids.speed = namespace
    .addVariable({
      componentOf: plant,
      browseName: "Speed",
      dataType: "Double",
      minimumSamplingInterval: 1000,
      value: new Variant({ dataType: DataType.Double, value: 12.5 }),
    })
    .nodeId.toString();
  ids.password = namespace
    .addVariable({
      componentOf: plant,
      browseName: "ServicePassword",
      dataType: "String",
      minimumSamplingInterval: 1000,
      value: new Variant({ dataType: DataType.String, value: `${PLANTED}-password` }),
    })
    .nodeId.toString();
  const sessionType = space.findObjectType("SessionDiagnosticsObjectType");
  if (sessionType === null) throw new Error("the server has no SessionDiagnosticsObjectType");
  const client = namespace.addObject({ organizedBy: plant, browseName: "Client7", typeDefinition: sessionType });
  ids.client = client.nodeId.toString();
  ids.clientName = namespace
    .addVariable({
      componentOf: client,
      browseName: "Name",
      dataType: "String",
      minimumSamplingInterval: 1000,
      value: new Variant({ dataType: DataType.String, value: `${PLANTED}-client` }),
    })
    .nodeId.toString();
  await server.start();
  endpoint = `opc.tcp://127.0.0.1:${server.endpoints[0]?.port}/libredb-mcp`;
});

const OPCUA_SEED = () => ({ id: "plant", type: "opcua", host: endpoint, securityMode: "None", agentReadRoots: [root] });

beforeEach(() => {
  writeSeedFile(dir, [OPCUA_SEED(), { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
});

afterEach(async () => {
  mock.restore();
  await resetMcpTestState();
});

afterAll(async () => {
  await server?.shutdown();
  if (PKI_BEFORE === undefined) delete process.env[OPCUA_PKI_ROOT_ENV];
  else process.env[OPCUA_PKI_ROOT_ENV] = PKI_BEFORE;
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

const opcua = (statement: unknown, extra: Record<string, unknown> = {}) =>
  call("run_opcua_read", {
    connection_id: "seed:plant",
    statement: typeof statement === "string" ? statement : JSON.stringify(statement),
    ...extra,
  });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

const expectNothingPlanted = (answer: Answered) => expect(JSON.stringify(answer)).not.toContain(PLANTED);

describe("the tool", () => {
  test("is listed read-only, with the statement schema, no offset or database, and the shared least timeout", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tool = (await session.client.listTools()).tools.find((candidate) => candidate.name === "run_opcua_read");
      expect(tool?.description).toBe(RUN_OPCUA_READ_ARM.description);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
        "connection_id",
        "statement",
        "max_rows",
        "timeout_ms",
      ]);
      expect(tool?.inputSchema.properties?.timeout_ms).toMatchObject({ minimum: 500, maximum: 30000, default: 10000 });
      expect(RUN_OPCUA_READ_ARM.engines).toBe("OPC UA");
    } finally {
      await session.close();
    }
  });

  test("list_connections names it as the OPC UA connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:plant", "run_opcua_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });

  test("inspect_schema refuses an OPC UA connection by name, pointing at run_opcua_read", async () => {
    const acquire = spyOn(McpConnectionContext.prototype, "acquire");
    const result = await call("inspect_schema", { connection_id: "seed:plant" });
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain("run_opcua_read");
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe("a read", () => {
  test("a value read answers a member with its engineering units behind the notice, with no notes", async () => {
    const result = await opcua({ read: [ids.temperature, ids.speed] });
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:plant",
      rows: [
        { nodeId: ids.temperature, value: "21.5", statusCode: "Good", units: "°C", euRange: "-40 to 120" },
        { nodeId: ids.speed, value: "12.5", statusCode: "Good", units: "no units published" },
      ],
      row_count: 2,
      truncated: false,
    });
    expect(result.structuredContent).not.toHaveProperty("notes");
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_opcua_read", "mcp/decision", "success"],
      ["run_opcua_read", "mcp/execution", "success"],
    ]);
  });

  test("an id outside the roots, a pruned one beneath them and a missing one answer alike, never with a value", async () => {
    const result = await opcua({
      read: [ids.speed, ids.outside, ids.password, ids.client, ids.clientName, "i=12637", "ns=1;s=Missing"],
    });
    expect(result.isError ?? false).toBe(false);
    const rows = (result.structuredContent?.rows ?? []) as Array<Record<string, unknown>>;
    expect(rows.map((row) => [row.nodeId, row.statusCode, row.value])).toEqual([
      [ids.speed, "Good", "12.5"],
      [ids.outside, "BadNodeIdUnknown", ""],
      [ids.password, "BadNodeIdUnknown", ""],
      [ids.client, "BadNodeIdUnknown", ""],
      [ids.clientName, "BadNodeIdUnknown", ""],
      ["i=12637", "BadNodeIdUnknown", ""],
      ["ns=1;s=Missing", "BadNodeIdUnknown", ""],
    ]);
    expect(result.structuredContent).not.toHaveProperty("notes");
    expectNothingPlanted(result);
  });

  test("a browse of the Objects folder lists the roots, and of a member its kept references and an outward count", async () => {
    const roots = await opcua({ browse: "i=85" });
    expect(roots.isError ?? false).toBe(false);
    expect(
      ((roots.structuredContent?.rows ?? []) as Array<Record<string, unknown>>).map((row) => row.browseName),
    ).toEqual(["Plant"]);
    expect(roots.structuredContent?.notes).toEqual([OPCUA_ROOTS_WARNING]);
    const result = await opcua({ browse: ids.plant });
    expect(result.isError ?? false).toBe(false);
    const names = ((result.structuredContent?.rows ?? []) as Array<Record<string, unknown>>).map(
      (row) => row.browseName,
    );
    expect(names.sort()).toEqual(["Speed", "Temperature"]);
    expect(result.structuredContent?.notes).toEqual([outwardNote(2)]);
    expectNothingPlanted(result);
  });

  test("a browse or a history read outside the roots is refused as of a missing id", async () => {
    for (const statement of [
      { browse: "i=3706" },
      { browse: ids.client },
      { history: ids.password },
      { history: ids.outside },
    ]) {
      const result = await opcua(statement);
      expect(result.isError).toBe(true);
      const text = result.content.map((block) => block.text).join("\n");
      expect(text).toContain(OPCUA_AGENT_FAILURE_SENTENCES.status("BadNodeIdUnknown"));
      expectNothingPlanted(result);
    }
  });

  test("a connection whose seed declares no roots is refused at open in Studio's words, and nothing is read", async () => {
    const listed: ManagedConnection = {
      id: "seed:plant",
      name: "plant",
      type: "opcua",
      host: endpoint,
      createdAt: new Date(),
      managed: true,
      roles: ["*"],
      seedId: "plant",
      mcp: true,
    } as ManagedConnection;
    spyOn(McpConnectionContext.prototype, "visibleConnections").mockImplementation(async () => [listed]);
    const result = await opcua({ read: [ids.speed] });
    expect(result.isError).toBe(true);
    const text = result.content.map((block) => block.text).join("\n");
    expect(text).toContain(
      'Connection "seed:plant" is read by MCP only beneath read roots its seed entry declares, and it declares none: an operator sets agentReadRoots on this seed.',
    );
    expect(text).not.toContain("12.5");
  });
});

describe("a refusal", () => {
  test.each([
    ["a write", { write: "ns=1;s=Speed", value: 1 }],
    ["a call", { call: "i=11492" }],
    ["an index range", { read: ["ns=1;s=Speed"], indexRange: "0:1" }],
    ["an unknown key", { subscribe: "ns=1;s=Speed" }],
    ["text that is no request", "read ns=1;s=Speed"],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, statement) => {
    const text = typeof statement === "string" ? statement : JSON.stringify(statement);
    const acquire = spyOn(McpConnectionContext.prototype, "acquire");
    const result = await opcua(text);
    const refusal = reader.admit?.(text);
    expect(refusal).not.toBeNull();
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The ${AGENT_LANGUAGE_COPY.opcuaread.noun} was refused before it reached the server (${refusal?.code}). ${refusal?.message}`,
        },
      ],
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_opcua_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test.each(["database", "offset"])(
    "an argument the tool does not name (%s) is refused, not dropped, before anything is acquired",
    async (key) => {
      const acquire = spyOn(McpConnectionContext.prototype, "acquire");
      const result = await opcua({ read: [ids.speed] }, { [key]: key === "offset" ? 1 : "elsewhere" });
      expect(result.isError).toBe(true);
      const text = result.content.map((block) => block.text).join("\n");
      expect(text).toContain("Input validation error");
      expect(text).toContain(key);
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  test("a provider not opened under the agent read-only profile refuses the read", async () => {
    spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(async (connection: ManagedConnection) => {
      const provider = new OpcuaProvider(connection as DatabaseConnection, {}, {}, async (read) =>
        openLibrarySession(read),
      );
      return provider;
    });
    const result = await opcua({ read: [ids.speed] });
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_opcua_read", {
      connection_id: "seed:shop",
      statement: JSON.stringify({ read: ["i=2256"] }),
    });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_opcua_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on OPC UA.",
        },
      ],
    });
  });
});

describe("the words a cut result would take", () => {
  test("say to name fewer nodes, narrow the window or browse further down, since an OPC UA read is never paged", () => {
    const statement = '{"browse": "i=85"}';
    expect(RUN_OPCUA_READ_ARM.moreRows(statement, "opcua", { maxRows: 1, shown: 1, cut: "max_rows" })).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${reader.rowCapAdvice(statement, "1")} To read past the 1 row returned, raise max_rows (at most 500), or name fewer nodes, give a history read a narrower window or a limit, or browse a node further down, since an OPC UA read is never paged.`,
    );
    expect(RUN_OPCUA_READ_ARM.moreRows(statement, "opcua", { maxRows: 1, shown: 0, cut: "result_bytes" })).toBe(
      "More rows exist than the 32 KiB result limit holds, and 0 of them fitted; this tool does not page with offset. Name fewer nodes, or browse a node further down, to fit more rows, and to read past the 0 rows returned, name fewer nodes, give a history read a narrower window or a limit, or browse a node further down, since an OPC UA read is never paged.",
    );
  });
});
