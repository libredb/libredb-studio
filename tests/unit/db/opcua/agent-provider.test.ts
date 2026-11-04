/**
 * The OPC UA provider's agent path: `queryReadOnly` on a handle opened under the agent read-only profile, one session
 * per read through the read services alone, only beneath the connection's read roots, every value with its engineering
 * units, every id outside the roots answered exactly as a missing one with nothing sent for it, budgets refused rather
 * than cut, failures worded by category, and every other reading of an agent-mode handle answering its reason.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import {
  OPCUA_AGENT_FAILURE_SENTENCES,
  OPCUA_AGENT_MAX_REQUESTS,
  OPCUA_AGENT_VALUE_COLUMNS,
} from "@/lib/db/providers/industrial/opcua/agent-read";
import {
  OPCUA_LEAF_NOTE,
  OPCUA_READ_ROOTS_REQUIRED_SENTENCE,
  OPCUA_ROOTS_WARNING,
  outwardNote,
} from "@/lib/db/providers/industrial/opcua/agent-roots";
import { OPCUA_AGENT_READS } from "@/lib/db/providers/industrial/opcua/agent-statement";
import { OPCUA_AGENT_WITHHELD } from "@/lib/db/providers/industrial/opcua/agent-surface";
import { OPCUA_NO_RANGE, OPCUA_NO_UNITS, OPCUA_UNITS_OUTSIDE } from "@/lib/db/providers/industrial/opcua/agent-units";
import type {
  OpcuaDataValue,
  OpcuaHistoryPage,
  OpcuaReadOnlyClient,
  OpcuaReference,
} from "@/lib/db/providers/industrial/opcua/client";
import { OpcuaProvider } from "@/lib/db/providers/industrial/opcua/index";
import { OPCUA_PKI_ROOT_ENV } from "@/lib/db/providers/industrial/opcua/pki";
import { ROW_BUDGET_PREFIX, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const ENV = { [OPCUA_PKI_ROOT_ENV]: "/app/data/opcua-pki" } as const;
const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true };
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 5, maxResultBytes: 1_000_000, statementTimeoutMs: 2_000 };

const PLC = "http://microsoft.com/Opc/OpcPlc/";
const DA = "urn:plant:DataAccess";
/** The server's NamespaceArray: OPC PLC's process namespace at 3, a data access namespace at 6, diagnostics at 7. */
const TABLE = [
  "http://opcfoundation.org/UA/",
  "urn:local",
  "urn:a",
  PLC,
  "urn:b",
  "urn:c",
  DA,
  "http://opcfoundation.org/UA/Diagnostics",
];
const ROOTS = [`nsu=${PLC};s=Telemetry`, `nsu=${DA};s=DataAccess`, "i=2256"];

const connection = (over: Record<string, unknown> = { agentReadRoots: ROOTS }): DatabaseConnection =>
  ({ id: "o", name: "o", type: "opcua", host: "opc.tcp://127.0.0.1:54840/", ...over }) as never;

/** One node of the scripted server: its facts, its value, and its forward references. */
interface Node {
  readonly nodeClass?: string;
  readonly dataType?: string;
  readonly ns?: number;
  readonly name?: string;
  readonly value?: unknown;
  readonly valueStatus?: string;
  readonly browseStatus?: string;
  readonly children?: readonly { readonly target: string; readonly ref?: string; readonly name?: string }[];
}

const EU = {
  namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact",
  unitId: 12890,
  displayName: { text: "mV" },
};

/** The fixture's shape, as measured on OPC PLC 2.15.10, with the nodes beneath and outside its read roots. */
function plant(): Record<string, Node> {
  const nodes: Record<string, Node> = {
    "ns=3;s=Telemetry": {
      name: "Telemetry",
      ns: 3,
      children: [
        { target: "ns=3;s=SlowUInt1" },
        { target: "ns=3;s=HistorianInt32" },
        { target: "ns=3;s=Locked" },
        { target: "ns=0;i=2253", ref: "ns=0;i=35" },
        { target: "ns=7;i=1" },
      ],
    },
    "ns=3;s=SlowUInt1": { nodeClass: "Variable", dataType: "ns=0;i=7", name: "SlowUInt1", ns: 3, value: 7 },
    "ns=3;s=HistorianInt32": { nodeClass: "Variable", dataType: "ns=0;i=6", name: "HistorianInt32", ns: 3, value: 1 },
    "ns=3;s=Locked": { name: "Locked", ns: 3, browseStatus: "BadUserAccessDenied" },
    "ns=6;s=DataAccess": {
      name: "DataAccess",
      ns: 6,
      children: [{ target: "ns=6;s=Analog" }, { target: "ns=6;s=Plain" }, { target: "ns=6;s=Folder" }],
    },
    "ns=6;s=Analog": {
      nodeClass: "Variable",
      dataType: "ns=0;i=6",
      name: "Analog",
      ns: 6,
      value: 42,
      children: [
        { target: "ns=6;s=Analog_EURange", ref: "ns=0;i=46", name: "EURange" },
        { target: "ns=6;s=Analog_EngineeringUnits", ref: "ns=0;i=46", name: "EngineeringUnits" },
      ],
    },
    "ns=6;s=Analog_EURange": {
      nodeClass: "Variable",
      dataType: "ns=0;i=884",
      name: "EURange",
      ns: 0,
      value: { low: 0, high: 100 },
    },
    "ns=6;s=Analog_EngineeringUnits": {
      nodeClass: "Variable",
      dataType: "ns=0;i=887",
      name: "EngineeringUnits",
      ns: 0,
      value: EU,
    },
    "ns=6;s=Plain": {
      nodeClass: "Variable",
      dataType: "ns=0;i=6",
      name: "Plain",
      ns: 6,
      value: 3,
      children: [{ target: "ns=0;i=99", ref: "ns=0;i=46", name: "EngineeringUnits" }],
    },
    "ns=6;s=Folder": { name: "Folder", ns: 6, value: null, valueStatus: "BadAttributeIdInvalid" },
    // On the server and not beneath any root: an outside id, whose missing twin is ns=3;s=Missing.
    "ns=3;s=Recipe": {
      nodeClass: "Variable",
      dataType: "ns=0;i=12",
      name: "Recipe",
      ns: 3,
      value: "not-a-real-recipe",
    },
    "i=12637": { name: "ServerConfiguration", ns: 0 },
    "i=2256": { nodeClass: "Variable", dataType: "ns=0;i=862", name: "ServerStatus", ns: 0, value: { state: 0 } },
    "i=2255": { nodeClass: "Variable", dataType: "ns=0;i=12", name: "NamespaceArray", ns: 0, value: TABLE },
  };
  for (const [id, name] of [
    [2257, "StartTime"],
    [2258, "CurrentTime"],
    [2259, "State"],
    [2260, "BuildInfo"],
    [2261, "ProductName"],
    [2262, "ProductUri"],
    [2263, "ManufacturerName"],
    [2264, "SoftwareVersion"],
    [2265, "BuildNumber"],
    [2266, "BuildDate"],
    [2992, "SecondsTillShutdown"],
    [2993, "ShutdownReason"],
  ] as const)
    nodes[`i=${id}`] = { nodeClass: "Variable", dataType: "ns=0;i=13", name, ns: 0, value: name };
  return nodes;
}

interface Record_ {
  calls: string[];
  opened: number;
  closed: number;
}

const reference = (nodes: Record<string, Node>, child: NonNullable<Node["children"]>[number]): OpcuaReference => {
  const node = nodes[child.target];
  const name = child.name ?? node?.name ?? child.target;
  return {
    nodeId: child.target,
    browseName: name,
    displayName: name,
    nodeClass: node?.nodeClass ?? "Object",
    referenceTypeId: child.ref ?? "ns=0;i=47",
    mayHaveChildren: true,
  };
};

/** A session over a stated address space, recording every service called with its full request. */
function session(
  nodes: Record<string, Node>,
  record: Record_,
  over: Partial<OpcuaReadOnlyClient> & {
    write?: () => never;
    call?: () => never;
    history?: (options: Parameters<OpcuaReadOnlyClient["historyRead"]>[0]) => Promise<OpcuaHistoryPage>;
  } = {},
): OpcuaReadOnlyClient {
  const base: OpcuaReadOnlyClient & Record<string, unknown> = {
    endpoints: async () => {
      record.calls.push("endpoints");
      return [];
    },
    limits: async () => {
      record.calls.push("limits");
      return {};
    },
    browse: async (ids) => {
      record.calls.push(`browse ${ids.join(",")}`);
      return ids.map((nodeId) => {
        const node = nodes[nodeId];
        if (node === undefined) return { nodeId, references: [], statusCode: "BadNodeIdUnknown" };
        if (node.browseStatus !== undefined) return { nodeId, references: [], statusCode: node.browseStatus };
        return {
          nodeId,
          references: (node.children ?? []).map((child) => reference(nodes, child)),
          statusCode: "Good",
        };
      });
    },
    browseNext: async (points) => {
      record.calls.push(`browseNext ${points.length}`);
      return [];
    },
    releaseBrowseContinuationPoints: async (points) => {
      record.calls.push(`releaseBrowse ${points.length}`);
    },
    read: async (ids, list) => {
      record.calls.push(`read${list === "facts" ? ":facts" : ""} ${ids.join(",")}`);
      return ids.map((nodeId): OpcuaDataValue => {
        const node = nodes[nodeId];
        if (node === undefined)
          return { nodeId, value: null, statusCode: "BadNodeIdUnknown", dataTypeStatusCode: "BadNodeIdUnknown" };
        const nodeClass = node.nodeClass ?? "Object";
        if (list === "facts")
          return {
            nodeId,
            value: null,
            nodeClass,
            ...(node.dataType === undefined ? {} : { dataTypeId: node.dataType }),
            dataTypeStatusCode: "Good",
            browseName: { namespaceIndex: node.ns ?? 3, name: node.name ?? nodeId },
            displayName: node.name ?? nodeId,
            statusCode: "Good",
          };
        return {
          nodeId,
          value: node.value ?? null,
          nodeClass,
          ...(node.dataType === undefined ? {} : { dataTypeId: node.dataType }),
          statusCode: node.valueStatus ?? "Good",
        };
      });
    },
    historyRead: async (options) => {
      record.calls.push(`historyRead ${JSON.stringify(options)}`);
      return over.history?.(options) ?? { nodeId: options.nodeId, values: [], statusCode: "Good" };
    },
    historyReadNext: async (options) => {
      record.calls.push(`historyReadNext ${options.nodeId}`);
      return { nodeId: options.nodeId, values: [], statusCode: "Good" };
    },
    releaseHistoryContinuationPoint: async (options) => {
      record.calls.push(`releaseHistory ${options.nodeId}`);
    },
    close: async () => {
      record.closed += 1;
    },
    // The library's own session carries these beside the reads; the agent path must never reach them.
    write: () => {
      throw new Error("write reached");
    },
    call: () => {
      throw new Error("call reached");
    },
    ...over,
  };
  return base;
}

const fresh = (): Record_ => ({ calls: [], opened: 0, closed: 0 });

async function agentHandle(
  nodes = plant(),
  over: Parameters<typeof session>[2] = {},
  execution: ProviderExecutionContext = AGENT,
  config: DatabaseConnection = connection(),
) {
  const record = fresh();
  const provider = new OpcuaProvider(
    config,
    {},
    execution,
    async () => {
      record.opened += 1;
      return session(nodes, record, over);
    },
    ENV,
  );
  await provider.connect();
  record.calls.length = 0;
  return { provider, record, nodes };
}

/** The requests every read starts with: the limits, the namespace table, then the read roots walk. */
async function walkOf(): Promise<string[]> {
  const { provider, record } = await agentHandle();
  await provider.queryReadOnly('{"browse": "i=85"}', BUDGET);
  return [...record.calls];
}

/** The answer and the requests of one read, the id put back to one spelling so two ids' answers compare byte for byte. */
async function answerAndRequests(statement: string, id: string) {
  const { provider, record } = await agentHandle();
  const answer = await provider.queryReadOnly(statement, BUDGET).then(
    (result) => JSON.stringify({ ...result, executionTime: 0 }),
    (error: Error) => `${error.name}: ${error.message}`,
  );
  return { answer: answer.replaceAll(id, "<id>"), requests: record.calls.map((call) => call.replaceAll(id, "<id>")) };
}

describe("an agent-mode handle opens only on a connection that declares read roots", () => {
  test("a statement profile without roots is refused at open, before any session", async () => {
    let opened = 0;
    const provider = new OpcuaProvider(
      connection({}),
      {},
      AGENT,
      async () => {
        opened += 1;
        return session(plant(), fresh());
      },
      ENV,
    );
    const refused = provider.connect();
    await expect(refused).rejects.toBeInstanceOf(ExecutionProfileError);
    await expect(refused).rejects.toMatchObject({
      message: OPCUA_READ_ROOTS_REQUIRED_SENTENCE,
      reasonCode: "READ_ROOTS_REQUIRED",
    });
    expect(opened).toBe(0);
  });

  test("the operations profile, which sends no statement, opens without roots", async () => {
    const { provider, record } = await agentHandle(plant(), {}, OPERATIONS, connection({}));
    expect(provider.isConnected()).toBe(true);
    expect(record.opened).toBe(1);
  });
});

describe("queryReadOnly answers only on a handle opened under the agent read-only profile", () => {
  test("an editor handle refuses it before anything is sent", async () => {
    const record = fresh();
    const provider = new OpcuaProvider(connection(), {}, {}, async () => session(plant(), record), ENV);
    await provider.connect();
    record.calls.length = 0;
    const refused = provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET);
    await expect(refused).rejects.toBeInstanceOf(RefusedBeforeSendError);
    await expect(refused).rejects.toThrow("requires a provider opened under the agent read-only profile");
    expect(record.calls).toEqual([]);
  });

  test("the operations profile refuses it too", async () => {
    const { provider, record } = await agentHandle(plant(), {}, OPERATIONS);
    await expect(provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET)).rejects.toThrow(
      "requires a provider opened under the agent read-only profile",
    );
    expect(record.opened).toBe(1);
  });

  test("a handle that is not open refuses it", async () => {
    const provider = new OpcuaProvider(connection(), {}, AGENT, async () => session(plant(), fresh()), ENV);
    await expect(provider.queryReadOnly('{"read": ["i=2256"]}', BUDGET)).rejects.toBeInstanceOf(DatabaseConfigError);
  });

  test("a budget that is not one, and an estimate, are refused before anything is sent", async () => {
    const { provider, record } = await agentHandle();
    await expect(provider.queryReadOnly('{"read": ["i=2256"]}', { ...BUDGET, maxResultRows: 0 })).rejects.toThrow(
      "maxResultRows must be a positive integer",
    );
    await expect(provider.queryReadOnly('{"read": ["i=2256"]}', BUDGET, "estimate-plan")).rejects.toThrow(
      "OPC UA composes no estimating plan for the agent",
    );
    expect(record.opened).toBe(1);
  });

  test("a request outside the table is refused with the list of reads, and no session is opened", async () => {
    const { provider, record } = await agentHandle();
    const refused = provider.queryReadOnly('{"write": "ns=3;s=SlowUInt1", "value": 1}', BUDGET);
    await expect(refused).rejects.toBeInstanceOf(RefusedBeforeSendError);
    await expect(refused).rejects.toThrow(OPCUA_AGENT_READS);
    expect(record.opened).toBe(1);
    expect(record.calls).toEqual([]);
  });

  test("a value read of more nodes than the row budget is refused before a session is opened", async () => {
    const { provider, record } = await agentHandle();
    const ids = Array.from({ length: BUDGET.maxResultRows + 1 }, (_, at) => `ns=3;s=N${at}`);
    const refused = provider.queryReadOnly(JSON.stringify({ read: ids }), BUDGET);
    await expect(refused).rejects.toBeInstanceOf(RefusedBeforeSendError);
    await expect(refused).rejects.toThrow(`${ROW_BUDGET_PREFIX}: 6 rows > 5 allowed`);
    expect(record.opened).toBe(1);
    const exact = await provider.queryReadOnly(JSON.stringify({ read: ids.slice(0, 5) }), BUDGET);
    expect(exact.rowCount).toBe(5);
  });
});

describe("the read roots walk", () => {
  test("every read reads the namespace table and proves the set before anything the request names is sent", async () => {
    const walk = await walkOf();
    expect(walk.slice(0, 2)).toEqual(["limits", "read i=2255"]);
    expect(walk[2]).toStartWith("read:facts ns=3;s=Telemetry,ns=6;s=DataAccess,i=2256,i=2257");
    expect(walk.filter((call) => call.startsWith("browse")).join(" | ")).toBe(
      "browse ns=3;s=Telemetry,ns=6;s=DataAccess | browse ns=3;s=SlowUInt1,ns=3;s=HistorianInt32,ns=3;s=Locked,ns=6;s=Analog,ns=6;s=Plain,ns=6;s=Folder | browse ns=6;s=Analog_EURange,ns=6;s=Analog_EngineeringUnits",
    );
    // Nothing of the walk is held: the next read walks again.
    const { provider, record } = await agentHandle();
    await provider.queryReadOnly('{"browse": "i=85"}', BUDGET);
    await provider.queryReadOnly('{"browse": "i=85"}', BUDGET);
    expect(record.calls).toEqual([...walk, ...walk]);
  });

  test("a root the server's table does not hold refuses the read whole, naming only the root", async () => {
    const { provider, record } = await agentHandle(
      plant(),
      {},
      AGENT,
      connection({ agentReadRoots: ["nsu=urn:gone;s=X"] }),
    );
    await expect(provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET)).rejects.toThrow(
      "Read root nsu=urn:gone;s=X is not on this server: its namespace URI is not in the server's namespace table. Nothing was answered.",
    );
    expect(record.calls).toEqual(["limits", "read i=2255"]);
    expect(record.closed).toBe(2);
  });

  test("a namespace table the server will not answer refuses the read", async () => {
    const nodes = plant();
    nodes["i=2255"] = { ...nodes["i=2255"], value: "not a list" };
    const { provider } = await agentHandle(nodes);
    await expect(provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.namespaceTable("Good"),
    );
  });
});

describe("a value read", () => {
  test("answers a member with its units, the in-set ids in one Read and their units in one more", async () => {
    const walk = await walkOf();
    const { provider, record } = await agentHandle();
    const result = await provider.queryReadOnly(
      '{"read": ["ns=6;s=Analog", "nsu=http://microsoft.com/Opc/OpcPlc/;s=SlowUInt1"]}',
      BUDGET,
    );
    expect(result.fields).toEqual([...OPCUA_AGENT_VALUE_COLUMNS]);
    expect(result.rows).toEqual([
      expect.objectContaining({
        nodeId: "ns=6;s=Analog",
        value: "42",
        statusCode: "Good",
        units: "mV",
        euRange: "0 to 100",
      }),
      expect.objectContaining({
        nodeId: "ns=3;s=SlowUInt1",
        value: "7",
        units: OPCUA_NO_UNITS,
        euRange: OPCUA_NO_RANGE,
      }),
    ]);
    expect(record.calls.slice(walk.length - 0)).toEqual([
      "read ns=6;s=Analog,ns=3;s=SlowUInt1",
      "read ns=6;s=Analog_EURange,ns=6;s=Analog_EngineeringUnits",
    ]);
    expect(record.closed).toBe(2);
  });

  test("a member whose units property lies outside the roots answers that its units were not read", async () => {
    const { provider } = await agentHandle();
    const result = await provider.queryReadOnly('{"read": ["ns=6;s=Plain"]}', BUDGET);
    expect(result.rows[0]).toMatchObject({ units: OPCUA_UNITS_OUTSIDE, euRange: OPCUA_NO_RANGE });
  });

  test("a units property the walk pruned by its own facts is never read, and its units answer as not read", async () => {
    const nodes = plant();
    nodes["ns=6;s=Guarded"] = {
      nodeClass: "Variable",
      dataType: "ns=0;i=6",
      name: "Guarded",
      ns: 6,
      value: 9,
      children: [{ target: "ns=6;s=Guarded_EU", ref: "ns=0;i=46", name: "EngineeringUnits" }],
    };
    // The property's own facts carry a session diagnostics data type, which the walk prunes.
    nodes["ns=6;s=Guarded_EU"] = {
      nodeClass: "Variable",
      dataType: "ns=0;i=865",
      name: "EngineeringUnits",
      ns: 0,
      value: EU,
    };
    nodes["ns=6;s=DataAccess"] = {
      ...nodes["ns=6;s=DataAccess"],
      children: [...(nodes["ns=6;s=DataAccess"]?.children ?? []), { target: "ns=6;s=Guarded" }],
    };
    const { provider, record } = await agentHandle(nodes);
    const result = await provider.queryReadOnly('{"read": ["ns=6;s=Guarded"]}', BUDGET);
    expect(result.rows[0]).toMatchObject({ value: "9", units: OPCUA_UNITS_OUTSIDE, euRange: OPCUA_NO_RANGE });
    expect(record.calls.filter((call) => call.startsWith("read ")).join(" ")).not.toContain("Guarded_EU");
    expect(record.calls.at(-1)).toBe("read ns=6;s=Guarded");
  });

  test("a member with no value is not looked up for units, and answers none", async () => {
    const walk = await walkOf();
    const { provider, record } = await agentHandle();
    const result = await provider.queryReadOnly('{"read": ["ns=6;s=Folder"]}', BUDGET);
    expect(result.rows[0]).toMatchObject({ statusCode: "BadAttributeIdInvalid", units: null });
    expect(record.calls.slice(walk.length)).toEqual(["read ns=6;s=Folder"]);
  });

  test("an id outside the roots and a missing one answer the same row, with nothing sent for either", async () => {
    const walk = await walkOf();
    for (const outside of ["ns=3;s=Recipe", "i=12637", "ns=7;i=1", "i=2253", "i=85", "ns=99;s=Far"]) {
      const a = await answerAndRequests(`{"read": ["${outside}"]}`, outside);
      const b = await answerAndRequests('{"read": ["ns=3;s=Missing"]}', "ns=3;s=Missing");
      expect([outside, a.answer]).toEqual([outside, b.answer]);
      expect([outside, a.requests]).toEqual([outside, b.requests]);
      expect(a.requests).toEqual(walk);
    }
    const { answer } = await answerAndRequests('{"read": ["ns=3;s=Recipe"]}', "ns=3;s=Recipe");
    expect(answer).toContain('"statusCode":"BadNodeIdUnknown"');
    expect(answer).not.toContain("not-a-real-recipe");
    expect(answer).not.toContain("warnings");
  });

  /** A server whose value Read answers one node differently from what its facts said during the walk. */
  const answering = (nodeId: string, row: Partial<OpcuaDataValue>) => {
    const base = session(plant(), fresh());
    return {
      read: async (ids: readonly string[], list?: "values" | "facts") => {
        const rows = await base.read(ids, list);
        return list === "facts" ? rows : rows.map((value) => (value.nodeId === nodeId ? { nodeId, ...row } : value));
      },
    } as Partial<OpcuaReadOnlyClient>;
  };

  test("an in-set id the server then answers as missing is answered as an outside id is", async () => {
    const missing = await answerAndRequests('{"read": ["ns=3;s=Missing"]}', "ns=3;s=Missing");
    const { provider } = await agentHandle(
      plant(),
      answering("ns=3;s=SlowUInt1", { value: null, statusCode: "BadNodeIdUnknown" }),
    );
    const result = await provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET);
    expect(JSON.stringify({ ...result, executionTime: 0 }).replaceAll("ns=3;s=SlowUInt1", "<id>")).toBe(missing.answer);
  });

  test("the answer-time check answers a value on an Object, a changed class and a withheld data type as outside", async () => {
    const outside = { statusCode: "BadNodeIdUnknown", value: "", shape: "null", units: null };
    const object = await agentHandle(
      plant(),
      answering("ns=6;s=Folder", { value: 5, nodeClass: "Object", statusCode: "Good" }),
    );
    expect((await object.provider.queryReadOnly('{"read": ["ns=6;s=Folder"]}', BUDGET)).rows[0]).toMatchObject(outside);
    const changed = await agentHandle(
      plant(),
      answering("ns=3;s=SlowUInt1", { value: 7, nodeClass: "Object", statusCode: "Good" }),
    );
    expect((await changed.provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET)).rows[0]).toMatchObject(
      outside,
    );
    const typed = await agentHandle(
      plant(),
      answering("ns=3;s=SlowUInt1", { value: 7, nodeClass: "Variable", dataTypeId: "ns=0;i=865", statusCode: "Good" }),
    );
    expect((await typed.provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET)).rows[0]).toMatchObject(
      outside,
    );
    // The walk admitted the Variable on a DataType answered Good; a Read that answers none no longer matches it.
    const untyped = await agentHandle(
      plant(),
      answering("ns=3;s=SlowUInt1", { value: 7, nodeClass: "Variable", statusCode: "Good" }),
    );
    expect((await untyped.provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET)).rows[0]).toMatchObject(
      outside,
    );
  });
});

describe("a history read", () => {
  const page = (count: number, statusCode = "Good"): OpcuaHistoryPage => ({
    nodeId: "ns=3;s=HistorianInt32",
    values: Array.from({ length: count }, (_, at) => ({
      value: at,
      sourceTimestamp: new Date(Date.UTC(2026, 9, 31, 0, 0, at)).toISOString(),
      statusCode: "Good",
    })),
    statusCode,
  });

  test("sends the console's raw history request with the window fixed and the page size set", async () => {
    const walk = await walkOf();
    const { provider, record } = await agentHandle(plant(), {
      history: async () => ({ ...page(3), continuationPoint: new Uint8Array([1]) }),
    });
    const result = await provider.queryReadOnly(
      '{"history": "ns=3;s=HistorianInt32", "start": "2026-10-31T00:00:00Z", "end": "2026-10-31T01:00:00Z", "limit": 3}',
      BUDGET,
    );
    expect(record.calls.slice(walk.length)).toEqual([
      `historyRead ${JSON.stringify({ nodeId: "ns=3;s=HistorianInt32", startTime: "2026-10-31T00:00:00.000Z", endTime: "2026-10-31T01:00:00.000Z", valuesPerPage: 3 })}`,
      "releaseHistory ns=3;s=HistorianInt32",
    ]);
    expect(result.rowCount).toBe(3);
    expect(result.rows[0]).toMatchObject({ nodeId: "ns=3;s=HistorianInt32", value: "0", units: OPCUA_NO_UNITS });
    expect(result.warnings?.[0]?.message).toContain("reached its cap of 3 values");
  });

  /** A node holding `count` values, answering each request from its start time, a page at a time, as asyncua does. */
  const holding =
    (count: number) =>
    async (options: Parameters<OpcuaReadOnlyClient["historyRead"]>[0]): Promise<OpcuaHistoryPage> => {
      const all = page(count).values.filter(
        (entry) => options.startTime === undefined || new Date(entry.sourceTimestamp as string) >= options.startTime,
      );
      return { nodeId: "ns=3;s=HistorianInt32", values: all.slice(0, options.valuesPerPage), statusCode: "Good" };
    };

  test("a window holding exactly the row budget is answered, and one value more is refused", async () => {
    const exact = await agentHandle(plant(), { history: holding(5) });
    expect((await exact.provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32"}', BUDGET)).rowCount).toBe(5);
    const over = await agentHandle(plant(), { history: holding(6) });
    await expect(over.provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32"}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.historyOverRows(6, 5),
    );
    expect(over.record.calls.find((call) => call.startsWith("historyRead"))).toContain('"valuesPerPage":6');
    const limited = await agentHandle(plant(), { history: holding(60) });
    await expect(
      limited.provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32", "limit": 50}', BUDGET),
    ).rejects.toThrow(ROW_BUDGET_PREFIX);
  });

  test("a stated limit equal to the row budget is the request's own: answered at it, and one more is refused", async () => {
    const exact = await agentHandle(plant(), { history: holding(60) });
    const answered = await exact.provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32", "limit": 5}', BUDGET);
    expect(answered.rowCount).toBe(5);
    expect(answered.warnings?.[0]?.message).toContain("reached its cap of 5 values");
    const over = await agentHandle(plant(), { history: holding(60) });
    await expect(
      over.provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32", "limit": 6}', BUDGET),
    ).rejects.toThrow(OPCUA_AGENT_FAILURE_SENTENCES.historyOverRows(6, 5));
  });

  test("with no limit written, a window past the console's own cap is refused, never cut at that cap", async () => {
    const budget = { ...BUDGET, maxResultRows: 10_000, maxResultBytes: 100_000_000 };
    const over = await agentHandle(plant(), { history: holding(10_001) });
    await expect(over.provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32"}', budget)).rejects.toThrow(
      "The history read was not finished, so it is refused rather than answered in part: The read reached its cap of 10,000 values",
    );
  });

  test("a node that keeps no history answers no rows with the server's reason in Studio's words", async () => {
    const { provider } = await agentHandle(plant(), {
      history: async () => ({ ...page(0, "BadHistoryOperationUnsupported") }),
    });
    const result = await provider.queryReadOnly('{"history": "ns=3;s=SlowUInt1"}', BUDGET);
    expect(result.rowCount).toBe(0);
    expect(result.warnings?.[0]?.message).toStartWith(
      "The server answered BadHistoryOperationUnsupported: that node keeps no history",
    );
  });

  test("history the server cut short is refused rather than answered in part", async () => {
    const partial = await agentHandle(plant(), {
      history: async () => ({ ...page(2), continuationPoint: new Uint8Array([1]) }),
      historyReadNext: async (options) => ({ nodeId: options.nodeId, values: [], statusCode: "BadTimeout" }),
    });
    await expect(partial.provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32"}', BUDGET)).rejects.toThrow(
      "The history read was not finished, so it is refused rather than answered in part",
    );
  });

  test("an id outside the roots and a missing one are refused alike, with nothing sent for either", async () => {
    const walk = await walkOf();
    const missing = await answerAndRequests('{"history": "ns=3;s=Missing"}', "ns=3;s=Missing");
    expect(missing.answer).toBe(`OpcuaAgentError: ${OPCUA_AGENT_FAILURE_SENTENCES.status("BadNodeIdUnknown")}`);
    expect(missing.requests).toEqual(walk);
    for (const outside of ["ns=3;s=Recipe", "i=3708", "ns=7;i=1"]) {
      const a = await answerAndRequests(`{"history": "${outside}"}`, outside);
      expect([outside, a.answer, a.requests]).toEqual([outside, missing.answer, missing.requests]);
    }
  });

  test("a member the walk classed as anything but a Variable is refused as missing, with nothing sent for it", async () => {
    const walk = await walkOf();
    const missing = await answerAndRequests('{"history": "ns=3;s=Missing"}', "ns=3;s=Missing");
    const nodes = plant();
    // The facts class it as an Object, so no data type was checked, and the server still keeps history for it.
    nodes["ns=3;s=Who"] = { name: "Who", ns: 3, value: "not-a-real-history-value" };
    nodes["ns=3;s=Telemetry"] = {
      ...nodes["ns=3;s=Telemetry"],
      children: [...(nodes["ns=3;s=Telemetry"]?.children ?? []), { target: "ns=3;s=Who" }],
    };
    for (const member of ["ns=3;s=Who", "ns=3;s=Telemetry", "ns=6;s=Folder"]) {
      const { provider, record } = await agentHandle(nodes, {
        history: async (options) => ({ ...page(3), nodeId: options.nodeId }),
      });
      const answer = await provider.queryReadOnly(`{"history": "${member}"}`, BUDGET).then(
        (result) => JSON.stringify(result),
        (error: Error) => `${error.name}: ${error.message}`,
      );
      expect([member, answer]).toEqual([member, missing.answer]);
      expect(record.calls.some((call) => call.startsWith("historyRead"))).toBe(false);
      expect(record.calls.length).toBe(walk.length);
    }
  });
});

describe("a browse", () => {
  test("of a member answers the references the walk kept, with no Browse sent, and counts those outside", async () => {
    const walk = await walkOf();
    const { provider, record } = await agentHandle();
    const result = await provider.queryReadOnly('{"browse": "ns=3;s=Telemetry"}', BUDGET);
    expect(result.rows).toEqual([
      {
        nodeId: "ns=3;s=SlowUInt1",
        browseName: "SlowUInt1",
        displayName: "SlowUInt1",
        nodeClass: "Variable",
        referenceTypeId: "i=47",
      },
      {
        nodeId: "ns=3;s=HistorianInt32",
        browseName: "HistorianInt32",
        displayName: "HistorianInt32",
        nodeClass: "Variable",
        referenceTypeId: "i=47",
      },
      {
        nodeId: "ns=3;s=Locked",
        browseName: "Locked",
        displayName: "Locked",
        nodeClass: "Object",
        referenceTypeId: "i=47",
      },
    ]);
    expect(result.warnings?.map((w) => w.message)).toEqual([outwardNote(2)]);
    expect(record.calls).toEqual(walk);
  });

  test("of the Objects folder answers the read roots in every spelling of its id, sending nothing more", async () => {
    const walk = await walkOf();
    const answers = new Set<string>();
    for (const spelling of ["i=85", "ns=0;i=85", "nsu=http://opcfoundation.org/UA/;i=85"]) {
      const { provider, record } = await agentHandle();
      const result = await provider.queryReadOnly(`{"browse": "${spelling}"}`, BUDGET);
      answers.add(JSON.stringify({ ...result, executionTime: 0 }));
      expect([spelling, record.calls]).toEqual([spelling, walk]);
    }
    expect(answers.size).toBe(1);
  });

  test("of the Objects folder answers the read roots, with the warning that names them", async () => {
    const { provider } = await agentHandle();
    const result = await provider.queryReadOnly('{"browse": "ns=0;i=85"}', BUDGET);
    expect(result.rows).toEqual([
      {
        nodeId: "ns=3;s=Telemetry",
        browseName: "Telemetry",
        displayName: "Telemetry",
        nodeClass: "Object",
        referenceTypeId: null,
      },
      {
        nodeId: "ns=6;s=DataAccess",
        browseName: "DataAccess",
        displayName: "DataAccess",
        nodeClass: "Object",
        referenceTypeId: null,
      },
      {
        nodeId: "i=2256",
        browseName: "ServerStatus",
        displayName: "ServerStatus",
        nodeClass: "Variable",
        referenceTypeId: null,
      },
    ]);
    expect(result.warnings?.map((w) => w.message)).toEqual([OPCUA_ROOTS_WARNING]);
  });

  test("of a namespace-0 root answers its fixed rows, and of a refused member the leaf note", async () => {
    const { provider } = await agentHandle(plant(), {}, AGENT, connection({ agentReadRoots: ROOTS }));
    const status = await provider.queryReadOnly('{"browse": "i=2256"}', { ...BUDGET, maxResultRows: 20 });
    expect(status.rows.map((row) => row.nodeId)).toEqual(["i=2257", "i=2258", "i=2259", "i=2260", "i=2992", "i=2993"]);
    expect(status.warnings).toBeUndefined();
    const build = await provider.queryReadOnly('{"browse": "i=2260"}', { ...BUDGET, maxResultRows: 20 });
    expect(build.rows).toHaveLength(6);
    const locked = await provider.queryReadOnly('{"browse": "ns=3;s=Locked"}', BUDGET);
    expect(locked.rows).toEqual([]);
    expect(locked.warnings?.map((w) => w.message)).toEqual([OPCUA_LEAF_NOTE]);
  });

  test("of a member holding more kept references than the row budget is refused rather than cut", async () => {
    const { provider } = await agentHandle();
    await expect(
      provider.queryReadOnly('{"browse": "ns=3;s=Telemetry"}', { ...BUDGET, maxResultRows: 2 }),
    ).rejects.toThrow(OPCUA_AGENT_FAILURE_SENTENCES.browseOverRows(3, 2));
  });

  test("an id outside the roots and a missing one are refused alike, with nothing sent for either", async () => {
    const missing = await answerAndRequests('{"browse": "ns=3;s=Missing"}', "ns=3;s=Missing");
    expect(missing.answer).toBe(`OpcuaAgentError: ${OPCUA_AGENT_FAILURE_SENTENCES.status("BadNodeIdUnknown")}`);
    for (const outside of ["ns=3;s=Recipe", "i=2253", "i=12637", "ns=7;i=1"]) {
      const a = await answerAndRequests(`{"browse": "${outside}"}`, outside);
      expect([outside, a.answer, a.requests]).toEqual([outside, missing.answer, missing.requests]);
    }
  });
});

describe("the bounds", () => {
  test("exactly the answer's request bound is sent, the walk counted apart, and the next request is refused", async () => {
    let history = 0;
    // One value a page and a continuation point every time, so only the request bound ends the read.
    const endless = {
      nodeId: "ns=3;s=HistorianInt32",
      values: [{ value: 1, statusCode: "Good" }],
      statusCode: "Good",
      continuationPoint: new Uint8Array([1]),
    };
    const { provider, record } = await agentHandle(plant(), {
      history: async () => {
        history += 1;
        return endless;
      },
      historyReadNext: async () => {
        history += 1;
        return endless;
      },
    });
    await expect(
      provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32"}', { ...BUDGET, maxResultRows: 1_000 }),
    ).rejects.toThrow(OPCUA_AGENT_FAILURE_SENTENCES.requests);
    // The limits and the namespace table are two of the answer's requests; the walk's own are not among them.
    expect(history).toBe(OPCUA_AGENT_MAX_REQUESTS - 2);
    expect(
      record.calls.filter((call) => call.startsWith("browse") || call.startsWith("read:facts")).length,
    ).toBeGreaterThan(0);
  });

  test("a server that never answers is refused at the time budget, in Studio's words, and its session closed", async () => {
    let release: () => void = () => {};
    const { provider, record } = await agentHandle(plant(), {
      limits: () =>
        new Promise((resolve) => {
          release = () => resolve({});
        }),
    });
    const message = await provider.queryReadOnly('{"read": ["i=2256"]}', { ...BUDGET, statementTimeoutMs: 50 }).then(
      () => "answered",
      (error: Error) => error.message,
    );
    expect(message).toBe(OPCUA_AGENT_FAILURE_SENTENCES.time(50));
    expect(message).toStartWith(TIME_BUDGET_PREFIX);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(record.closed).toBe(2);
  });

  test("an answer past the byte budget is refused rather than cut", async () => {
    const { provider } = await agentHandle();
    await expect(
      provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', { ...BUDGET, maxResultBytes: 10 }),
    ).rejects.toThrow("Read-only execution exceeded the byte budget");
  });
});

describe("failures are worded by category, never in the server's or the library's text", () => {
  const SERVER_TEXT = "ns=3;s=SecretRecipe value 1234 at opc.tcp://plc-7.internal:4840";

  test("a status code is worded by the error table, and nothing else of the message is kept", async () => {
    const { provider } = await agentHandle(plant(), {
      limits: async () => {
        throw new QueryError(`A read failed: BadUserAccessDenied ${SERVER_TEXT}`);
      },
    });
    const message = await provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET).then(
      () => "answered",
      (error: Error) => error.message,
    );
    expect(message).toBe(OPCUA_AGENT_FAILURE_SENTENCES.status("BadUserAccessDenied"));
    expect(message).not.toContain("SecretRecipe");
  });

  test("a failure with no code during the read is the transport's", async () => {
    const { provider } = await agentHandle(plant(), {
      limits: async () => {
        throw new Error(SERVER_TEXT);
      },
    });
    await expect(provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.transport,
    );
  });

  test("a session that cannot be opened is the session's, and names no endpoint or path", async () => {
    let calls = 0;
    const provider = new OpcuaProvider(
      connection(),
      {},
      AGENT,
      async () => {
        calls += 1;
        if (calls > 1) throw new DatabaseConfigError(`This connection could not be opened to ${SERVER_TEXT}`);
        return session(plant(), fresh());
      },
      ENV,
    );
    await provider.connect();
    const message = await provider.queryReadOnly('{"read": ["i=2256"]}', BUDGET).then(
      () => "answered",
      (error: Error) => error.message,
    );
    expect(message).toBe(OPCUA_AGENT_FAILURE_SENTENCES.session);
    expect(message).not.toContain("plc-7");
  });
});

describe("the agent path reaches only the read services", () => {
  test("no Write, Call or other service of the session is reached by any read, and GetEndpoints is not", async () => {
    const { provider, record } = await agentHandle(plant(), {
      history: async () => ({ nodeId: "ns=3;s=HistorianInt32", values: [], statusCode: "Good" }),
    });
    await provider.queryReadOnly('{"read": ["ns=6;s=Analog", "i=12637"]}', BUDGET);
    await provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32"}', BUDGET);
    await provider.queryReadOnly('{"browse": "ns=3;s=Telemetry"}', BUDGET);
    const services = new Set(record.calls.map((call) => call.split(" ")[0]));
    expect([...services].sort()).toEqual(["browse", "historyRead", "limits", "read", "read:facts"]);
  });
});

describe("an agent-mode handle", () => {
  test("connect opens one session and closes it at once; nothing is held between reads", async () => {
    const record = fresh();
    const provider = new OpcuaProvider(
      connection(),
      {},
      AGENT,
      async () => {
        record.opened += 1;
        return session(plant(), record);
      },
      ENV,
    );
    expect(provider.isConnected()).toBe(false);
    await provider.connect();
    expect([record.opened, record.closed]).toEqual([1, 1]);
    expect(provider.isConnected()).toBe(true);
    await provider.queryReadOnly('{"read": ["i=2256"]}', BUDGET);
    await provider.queryReadOnly('{"read": ["i=2256"]}', BUDGET);
    expect([record.opened, record.closed]).toEqual([3, 3]);
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });

  test("a close that fails on connect is not a failed connect", async () => {
    const provider = new OpcuaProvider(
      connection(),
      {},
      AGENT,
      async () =>
        session(plant(), fresh(), {
          close: async () => {
            throw new Error("gone");
          },
        }),
      ENV,
    );
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect((await provider.queryReadOnly('{"read": ["i=2256"]}', BUDGET)).rowCount).toBe(1);
  });

  test("a build with no transport refuses connect", async () => {
    const provider = new OpcuaProvider(connection(), {}, AGENT, undefined, ENV);
    await expect(provider.connect()).rejects.toThrow("This build has no OPC UA transport wired in");
  });

  test("the console and the Keys panel are refused, before anything is sent", async () => {
    const { provider, record } = await agentHandle();
    await expect(provider.query('{"read": ["i=2256"]}')).rejects.toThrow(OPCUA_AGENT_WITHHELD.query);
    await expect(provider.query('{"read": ["i=2256"]}')).rejects.toBeInstanceOf(RefusedBeforeSendError);
    await expect(provider.scanKeysPage({ level: true, pattern: "", cursor: "0", count: 10 })).rejects.toThrow(
      OPCUA_AGENT_WITHHELD.keys,
    );
    await expect(provider.readObjectSource(["Server"], "node")).rejects.toThrow(OPCUA_AGENT_WITHHELD.keys);
    expect(record.calls).toEqual([]);
  });

  test("every reading it does not report answers its reason, never a figure Studio filled in", async () => {
    const { provider } = await agentHandle();
    await expect(provider.getHealth()).rejects.toThrow(OPCUA_AGENT_WITHHELD.health);
    await expect(provider.getOverview()).rejects.toThrow(OPCUA_AGENT_WITHHELD.overview);
    await expect(provider.getPerformanceMetrics()).rejects.toThrow(OPCUA_AGENT_WITHHELD.performance);
    await expect(provider.getSlowQueries()).rejects.toThrow(OPCUA_AGENT_WITHHELD.slowQueries);
    await expect(provider.getActiveSessions()).rejects.toThrow(OPCUA_AGENT_WITHHELD.sessions);
    await expect(provider.getTableStats()).rejects.toThrow(OPCUA_AGENT_WITHHELD.tableStats);
    await expect(provider.getIndexStats()).rejects.toThrow(OPCUA_AGENT_WITHHELD.indexStats);
    await expect(provider.getStorageStats()).rejects.toThrow(OPCUA_AGENT_WITHHELD.storage);
    await expect(provider.listObjects()).rejects.toThrow(OPCUA_AGENT_WITHHELD.objects);
    await expect(provider.describeObject()).rejects.toThrow(OPCUA_AGENT_WITHHELD.objects);
    await expect(provider.describeObjects()).rejects.toThrow(OPCUA_AGENT_WITHHELD.objects);
  });

  test("a reading on a handle that is not open says so first", async () => {
    const provider = new OpcuaProvider(connection(), {}, AGENT, async () => session(plant(), fresh()), ENV);
    await expect(provider.getHealth()).rejects.toBeInstanceOf(DatabaseConfigError);
  });
});
