/**
 * The OPC UA provider's agent path: `queryReadOnly` on a handle opened under the agent read-only profile, one session
 * per read through the read services alone, every value with its engineering units, the withheld nodes answered or
 * refused with their reasons, budgets refused rather than cut, failures worded by category, and every other reading of
 * an agent-mode handle answering its reason.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import {
  OPCUA_AGENT_FAILURE_SENTENCES,
  OPCUA_AGENT_MAX_REQUESTS,
  OPCUA_AGENT_VALUE_COLUMNS,
  OPCUA_WITHHELD_STATUS,
} from "@/lib/db/providers/industrial/opcua/agent-read";
import { OPCUA_AGENT_READS } from "@/lib/db/providers/industrial/opcua/agent-statement";
import { OPCUA_AGENT_WITHHELD } from "@/lib/db/providers/industrial/opcua/agent-surface";
import { OPCUA_NO_RANGE, OPCUA_NO_UNITS } from "@/lib/db/providers/industrial/opcua/agent-units";
import {
  OPCUA_NAMESPACE0_OUTSIDE,
  OPCUA_WITHHELD_NODES,
  withheldReason,
} from "@/lib/db/providers/industrial/opcua/agent-withheld";
import type {
  OpcuaBrowseResult,
  OpcuaDataValue,
  OpcuaHistoryPage,
  OpcuaNodeId,
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

const connection = (): DatabaseConnection =>
  ({ id: "o", name: "o", type: "opcua", host: "opc.tcp://127.0.0.1:54840/" }) as never;

const node = (
  nodeId: string,
  browseName: string,
  nodeClass = "Variable",
  referenceTypeId = "ns=0;i=47",
): OpcuaReference => ({
  nodeId,
  browseName,
  displayName: browseName,
  nodeClass,
  referenceTypeId,
  mayHaveChildren: nodeClass !== "Method",
});

const EU = {
  namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact",
  unitId: 12890,
  displayName: { text: "mV" },
};

/** The fixture's shape, as measured on OPC PLC 2.15.10: a withheld subtree with a per-session node, an analog variable. */
function plant() {
  const tree: Record<string, OpcuaReference[]> = {
    "i=12637": [
      node("ns=0;i=14053", "CertificateGroups", "Object"),
      node("ns=0;i=25709", "ResetToServerDefaults", "Method"),
    ],
    "i=14053": [],
    "i=15606": [],
    "i=3706": [node("ns=7;i=1324504778", "ClientSession1", "Object")],
    "ns=7;i=1324504778": [node("ns=7;i=1324504823", "SessionSecurityDiagnostics")],
    "ns=7;i=1324504823": [],
    "i=2253": [
      node("ns=0;i=2256", "ServerStatus"),
      node("ns=0;i=12637", "ServerConfiguration", "Object"),
      node("ns=0;i=11492", "GetMonitoredItems", "Method"),
    ],
    "i=2274": [node("ns=0;i=3706", "SessionsDiagnosticsSummary", "Object"), node("ns=0;i=2294", "EnabledFlag")],
    "ns=6;s=Analog": [
      node("ns=6;s=Analog_EURange", "EURange", "Variable", "ns=0;i=46"),
      node("ns=6;s=Analog_EngineeringUnits", "EngineeringUnits", "Variable", "ns=0;i=46"),
    ],
    "ns=3;s=SlowUInt1": [],
    "ns=3;s=HistorianInt32": [],
  };
  const values: Record<string, Partial<OpcuaDataValue>> = {
    "ns=6;s=Analog": { value: 42, nodeClass: "Variable", sourceTimestamp: "2026-10-31T20:00:00.000Z" },
    "ns=3;s=SlowUInt1": { value: 7, nodeClass: "Variable" },
    "ns=3;s=Folder": { value: null, nodeClass: "Object", statusCode: "BadAttributeIdInvalid" },
    "ns=6;s=Analog_EURange": { value: { low: 0, high: 100 }, dataTypeId: "ns=0;i=884" },
    "ns=6;s=Analog_EngineeringUnits": { value: EU, dataTypeId: "ns=0;i=887" },
  };
  return { tree, values };
}

interface Record_ {
  calls: string[];
  opened: number;
  closed: number;
}

/** A session over a stated address space, recording every service called with its full request. */
function session(
  space: ReturnType<typeof plant>,
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
      return ids.map((nodeId) => ({
        nodeId,
        references: space.tree[nodeId] ?? [],
        statusCode: nodeId in space.tree ? "Good" : "BadNodeIdUnknown",
      }));
    },
    browseNext: async (points) => {
      record.calls.push(`browseNext ${points.length}`);
      return [];
    },
    releaseBrowseContinuationPoints: async (points) => {
      record.calls.push(`releaseBrowse ${points.length}`);
    },
    read: async (ids) => {
      record.calls.push(`read ${ids.join(",")}`);
      return ids.map((nodeId) => ({ nodeId, value: null, statusCode: "Good", ...space.values[nodeId] }));
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
  space = plant(),
  over: Parameters<typeof session>[2] = {},
  execution: ProviderExecutionContext = AGENT,
) {
  const record = fresh();
  const provider = new OpcuaProvider(
    connection(),
    {},
    execution,
    async () => {
      record.opened += 1;
      return session(space, record, over);
    },
    ENV,
  );
  await provider.connect();
  record.calls.length = 0;
  return { provider, record, space };
}

/** What the read services were asked, after the withheld walk the read starts with. */
const WALK = [
  "limits",
  `browse ${OPCUA_WITHHELD_NODES.map((entry) => entry.nodeId).join(",")}`,
  "browse i=14053,ns=7;i=1324504778",
  "browse ns=7;i=1324504823",
];

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

  test("the operations profile, which sends no statement, refuses it too", async () => {
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
    await expect(provider.queryReadOnly('{"browse": "i=12637"}', BUDGET)).rejects.toThrow(
      withheldReason(OPCUA_WITHHELD_NODES[0]),
    );
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
    // Exactly the budget is read.
    const exact = await provider.queryReadOnly(JSON.stringify({ read: ids.slice(0, 5) }), BUDGET);
    expect(exact.rowCount).toBe(5);
  });
});

describe("a value read", () => {
  test("sends the withheld walk, one Read of the nodes, and the units lookup, on one session closed after", async () => {
    const { provider, record } = await agentHandle();
    const result = await provider.queryReadOnly('{"read": ["ns=6;s=Analog", "ns=3;s=SlowUInt1"]}', BUDGET);
    expect(record.calls).toEqual([
      ...WALK,
      "read ns=6;s=Analog,ns=3;s=SlowUInt1",
      "browse ns=6;s=Analog,ns=3;s=SlowUInt1",
      "read ns=6;s=Analog_EURange,ns=6;s=Analog_EngineeringUnits",
    ]);
    expect(record.opened).toBe(2);
    expect(record.closed).toBe(2);
    expect(result.fields).toEqual([...OPCUA_AGENT_VALUE_COLUMNS]);
    expect(result.rows).toEqual([
      {
        nodeId: "ns=6;s=Analog",
        value: "42",
        shape: "number",
        statusCode: "Good",
        sourceTimestamp: "2026-10-31T20:00:00.000Z",
        serverTimestamp: null,
        units: "mV",
        unitId: 12890,
        unitNamespace: "http://www.opcfoundation.org/UA/units/un/cefact",
        euRange: "0 to 100",
      },
      {
        nodeId: "ns=3;s=SlowUInt1",
        value: "7",
        shape: "number",
        statusCode: "Good",
        sourceTimestamp: null,
        serverTimestamp: null,
        units: OPCUA_NO_UNITS,
        unitId: null,
        unitNamespace: null,
        euRange: OPCUA_NO_RANGE,
      },
    ]);
    expect(result.warnings).toBeUndefined();
  });

  test("a value whose node class the server did not answer is still looked up for units, never answered without", async () => {
    const space = plant();
    space.values["ns=3;s=Unclassed"] = { value: 5 };
    space.tree["ns=3;s=Unclassed"] = [];
    const { provider, record } = await agentHandle(space);
    const result = await provider.queryReadOnly('{"read": ["ns=3;s=Unclassed"]}', BUDGET);
    expect(record.calls.slice(WALK.length)).toEqual(["read ns=3;s=Unclassed", "browse ns=3;s=Unclassed"]);
    expect(result.rows[0]).toMatchObject({ value: "5", units: OPCUA_NO_UNITS, euRange: OPCUA_NO_RANGE });
  });

  test("a units property the read may not read is never read, and its unit is answered as not read", async () => {
    const space = plant();
    space.values["ns=3;s=Odd"] = { value: 1, nodeClass: "Variable" };
    space.tree["ns=3;s=Odd"] = [
      node("ns=0;i=16192", "EngineeringUnits", "Variable", "ns=0;i=46"),
      node("ns=7;i=1324504823", "EURange", "Variable", "ns=0;i=46"),
    ];
    const { provider, record } = await agentHandle(space);
    const result = await provider.queryReadOnly('{"read": ["ns=3;s=Odd"]}', BUDGET);
    expect(record.calls.slice(WALK.length)).toEqual(["read ns=3;s=Odd", "browse ns=3;s=Odd"]);
    expect(result.rows[0]).toMatchObject({
      units: "units not read: the node that holds them is not read in agent mode",
      euRange: "range not read: the node that holds it is not read in agent mode",
    });
  });

  test("a node with no value is not looked up for units, and answers none", async () => {
    const { provider, record } = await agentHandle();
    const result = await provider.queryReadOnly('{"read": ["ns=3;s=Folder"]}', BUDGET);
    expect(record.calls).toEqual([...WALK, "read ns=3;s=Folder"]);
    expect(result.rows[0]).toMatchObject({ statusCode: "BadAttributeIdInvalid", units: null, euRange: null });
  });

  test("a withheld root and a per-session node are answered withheld with their reasons, and never sent", async () => {
    const { provider, record } = await agentHandle();
    const result = await provider.queryReadOnly(
      '{"read": ["ns=0;i=12637", "ns=7;i=1324504823", "ns=3;s=SlowUInt1", "i=12637"]}',
      BUDGET,
    );
    expect(record.calls.filter((call) => call.startsWith("read "))).toEqual(["read ns=3;s=SlowUInt1"]);
    expect(result.rows.map((row) => [row.nodeId, row.statusCode, row.value])).toEqual([
      ["i=12637", OPCUA_WITHHELD_STATUS, null],
      ["ns=7;i=1324504823", OPCUA_WITHHELD_STATUS, null],
      ["ns=3;s=SlowUInt1", "Good", "7"],
      ["i=12637", OPCUA_WITHHELD_STATUS, null],
    ]);
    expect(result.warnings?.map((warning) => warning.message)).toEqual([
      withheldReason(OPCUA_WITHHELD_NODES[0]),
      withheldReason(OPCUA_WITHHELD_NODES[2]),
    ]);
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
    const { provider, record } = await agentHandle(plant(), {
      history: async () => ({ ...page(3), continuationPoint: new Uint8Array([1]) }),
    });
    const result = await provider.queryReadOnly(
      '{"history": "ns=3;s=HistorianInt32", "start": "2026-10-31T00:00:00Z", "end": "2026-10-31T01:00:00Z", "limit": 3}',
      BUDGET,
    );
    expect(record.calls.slice(WALK.length)).toEqual([
      `historyRead ${JSON.stringify({ nodeId: "ns=3;s=HistorianInt32", startTime: "2026-10-31T00:00:00.000Z", endTime: "2026-10-31T01:00:00.000Z", valuesPerPage: 3 })}`,
      "releaseHistory ns=3;s=HistorianInt32",
      "browse ns=3;s=HistorianInt32",
    ]);
    expect(result.rowCount).toBe(3);
    expect(result.rows[0]).toMatchObject({ nodeId: "ns=3;s=HistorianInt32", value: "0", units: OPCUA_NO_UNITS });
    // The request's own limit was reached: answered, with the console's sentence saying the node holds more.
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
    // The read asked for one value past the budget, never the whole window.
    expect(over.record.calls.find((call) => call.startsWith("historyRead"))).toContain('"valuesPerPage":6');
    // A limit past the budget is no request to cut: one value past the budget is read, and refused.
    const limited = await agentHandle(plant(), { history: holding(60) });
    await expect(
      limited.provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32", "limit": 50}', BUDGET),
    ).rejects.toThrow(ROW_BUDGET_PREFIX);
  });

  test("with no limit written, a window past the console's own cap is refused, never cut at that cap", async () => {
    // A budget as large as the console's cap of 10,000 values: the console stops the read at its cap first.
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

  test("a history read of a per-session node is refused with its reason, and nothing of it is read", async () => {
    const { provider, record } = await agentHandle();
    await expect(provider.queryReadOnly('{"history": "ns=7;i=1324504823"}', BUDGET)).rejects.toThrow(
      withheldReason(OPCUA_WITHHELD_NODES[2]),
    );
    expect(record.calls).toEqual(WALK);
  });
});

describe("a browse", () => {
  test("answers one row per child, stepping over the withheld ones with their reasons", async () => {
    const { provider, record } = await agentHandle();
    const result = await provider.queryReadOnly('{"browse": "ns=0;i=2253"}', BUDGET);
    expect(record.calls.slice(WALK.length)).toEqual(["browse i=2253"]);
    expect(result.rows).toEqual([
      {
        nodeId: "i=2256",
        browseName: "ServerStatus",
        displayName: "ServerStatus",
        nodeClass: "Variable",
        referenceTypeId: "i=47",
      },
    ]);
    // ServerConfiguration is a withheld root, and the GetMonitoredItems method a namespace-0 node outside the list.
    expect(result.warnings?.map((warning) => warning.message)).toEqual([
      withheldReason(OPCUA_WITHHELD_NODES[0]),
      withheldReason(OPCUA_NAMESPACE0_OUTSIDE),
    ]);
  });

  test("a browse of a per-session node is refused with its reason before it is browsed", async () => {
    const { provider, record } = await agentHandle();
    await expect(provider.queryReadOnly('{"browse": "ns=7;i=1324504778"}', BUDGET)).rejects.toThrow(
      withheldReason(OPCUA_WITHHELD_NODES[2]),
    );
    expect(record.calls).toEqual(WALK);
  });

  test("a level holding more children than the row budget is refused, its continuation point released", async () => {
    const space = plant();
    space.tree["ns=3;s=Wide"] = Array.from({ length: 6 }, (_, at) => node(`ns=3;s=W${at}`, `W${at}`));
    const exact = await agentHandle(plant());
    exact.space.tree["ns=3;s=Wide"] = space.tree["ns=3;s=Wide"].slice(0, 5);
    expect((await exact.provider.queryReadOnly('{"browse": "ns=3;s=Wide"}', BUDGET)).rowCount).toBe(5);
    const over = await agentHandle(space);
    await expect(over.provider.queryReadOnly('{"browse": "ns=3;s=Wide"}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.browseOverRows(6, 5),
    );
    // Paged: the first page passes the budget, so the point is released and the next page never asked.
    const paged = await agentHandle(plant(), {
      browse: async (ids) =>
        ids.map((nodeId) =>
          nodeId === "ns=3;s=Paged"
            ? {
                nodeId,
                references: space.tree["ns=3;s=Wide"],
                statusCode: "Good",
                continuationPoint: new Uint8Array([1]),
              }
            : {
                nodeId,
                references: plant().tree[nodeId] ?? [],
                statusCode: nodeId in plant().tree ? "Good" : "BadNodeIdUnknown",
              },
        ),
    });
    await expect(paged.provider.queryReadOnly('{"browse": "ns=3;s=Paged"}', BUDGET)).rejects.toThrow(ROW_BUDGET_PREFIX);
    expect(paged.record.calls.at(-1)).toBe("releaseBrowse 1");
  });

  test("a continued page is read to the end of the level", async () => {
    let first = true;
    const { provider, record } = await agentHandle(plant(), {
      browse: async (ids) =>
        ids.map((nodeId) => ({
          nodeId,
          references: nodeId === "ns=3;s=Paged" ? [node("ns=3;s=A", "A")] : (plant().tree[nodeId] ?? []),
          statusCode: nodeId === "ns=3;s=Paged" || nodeId in plant().tree ? "Good" : "BadNodeIdUnknown",
          ...(nodeId === "ns=3;s=Paged" ? { continuationPoint: new Uint8Array([1]) } : {}),
        })),
      browseNext: async () => {
        const answer = first
          ? [
              {
                nodeId: "",
                references: [node("ns=3;s=B", "B")],
                statusCode: "Good",
                continuationPoint: new Uint8Array([2]),
              },
            ]
          : [{ nodeId: "", references: [node("ns=3;s=C", "C")], statusCode: "Good" }];
        first = false;
        return answer;
      },
    });
    const result = await provider.queryReadOnly('{"browse": "ns=3;s=Paged"}', BUDGET);
    expect(result.rows.map((row) => row.nodeId)).toEqual(["ns=3;s=A", "ns=3;s=B", "ns=3;s=C"]);
    expect(record.calls.filter((call) => call.startsWith("releaseBrowse"))).toEqual([]);
  });

  test("a browse the server refuses is worded by its status, never by its text", async () => {
    const { provider } = await agentHandle();
    await expect(provider.queryReadOnly('{"browse": "ns=3;s=Nowhere"}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.status("BadNodeIdUnknown"),
    );
  });
});

describe("node ids are compared as one key", () => {
  /** The fixture's namespace table, as OPC PLC 2.15.10 answers i=2255, shortened. */
  const TABLE = ["http://opcfoundation.org/UA/", "urn:OpcPlc:host", "http://microsoft.com/Opc/OpcPlc/", "urn:plant"];

  const withTable = (statusCode = "Good", value: unknown = TABLE) => {
    const space = plant();
    space.values["i=2255"] = { value, statusCode };
    space.values["ns=3;s=Pump"] = { value: 3, nodeClass: "Variable" };
    space.tree["ns=3;s=Pump"] = [];
    return space;
  };

  test("an nsu= id is put in its index through the server's NamespaceArray, read on the read's session", async () => {
    const { provider, record } = await agentHandle(withTable());
    const result = await provider.queryReadOnly('{"read": ["nsu=urn:plant;s=Pump"]}', BUDGET);
    expect(record.calls).toEqual(["limits", "read i=2255", ...WALK.slice(1), "read ns=3;s=Pump", "browse ns=3;s=Pump"]);
    expect(result.rows[0]).toMatchObject({ nodeId: "ns=3;s=Pump", value: "3", units: OPCUA_NO_UNITS });
  });

  test("the table is read again on the next read: nothing of it is held", async () => {
    const { provider, record } = await agentHandle(withTable());
    await provider.queryReadOnly('{"read": ["nsu=urn:plant;s=Pump"]}', BUDGET);
    await provider.queryReadOnly('{"browse": "nsu=urn:plant;s=Pump"}', BUDGET);
    expect(record.calls.filter((call) => call === "read i=2255")).toHaveLength(2);
  });

  test("a URI the table does not hold, or a table the server will not answer, refuses the read", async () => {
    const unknown = await agentHandle(withTable());
    await expect(unknown.provider.queryReadOnly('{"read": ["nsu=urn:elsewhere;s=Pump"]}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.unknownNamespace,
    );
    expect(unknown.record.calls).toEqual(["limits", "read i=2255"]);
    // A table the server answers Bad is not read, whatever value comes with it.
    const refused = await agentHandle(withTable("BadUserAccessDenied"));
    await expect(refused.provider.queryReadOnly('{"browse": "nsu=urn:plant;s=Pump"}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.namespaceTable("BadUserAccessDenied"),
    );
    const malformed = await agentHandle(withTable("Good", ["urn:a", 7]));
    await expect(malformed.provider.queryReadOnly('{"history": "nsu=urn:plant;s=Pump"}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.namespaceTable("Good"),
    );
    const silent = await agentHandle(withTable(), { read: async () => [] });
    await expect(silent.provider.queryReadOnly('{"read": ["nsu=urn:plant;s=Pump"]}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.namespaceTable("nothing"),
    );
  });

  test("a withheld root written with namespace 0's URI is refused before anything is sent", async () => {
    const { provider, record } = await agentHandle();
    await expect(
      provider.queryReadOnly('{"browse": "nsu=http://opcfoundation.org/UA/;i=3706"}', BUDGET),
    ).rejects.toThrow(withheldReason(OPCUA_WITHHELD_NODES[2]));
    expect(record.calls).toEqual([]);
  });

  test("a withheld node reached through its namespace URI is withheld after the table resolves it", async () => {
    const space = withTable("Good", ["http://opcfoundation.org/UA/", "a", "b", "c", "d", "e", "f", "urn:diagnostics"]);
    const { provider, record } = await agentHandle(space);
    const result = await provider.queryReadOnly('{"read": ["nsu=urn:diagnostics;i=1324504823"]}', BUDGET);
    expect(result.rows[0]).toMatchObject({ nodeId: "ns=7;i=1324504823", statusCode: OPCUA_WITHHELD_STATUS });
    expect(record.calls.filter((call) => call.startsWith("read "))).toEqual(["read i=2255"]);
    await expect(provider.queryReadOnly('{"history": "nsu=urn:diagnostics;i=1324504778"}', BUDGET)).rejects.toThrow(
      withheldReason(OPCUA_WITHHELD_NODES[2]),
    );
  });

  test("a per-session node with an opaque id is withheld in every base64 spelling of it", async () => {
    const space = plant();
    space.tree["i=3706"] = [node("ns=7;b=AQ==", "ClientSession2", "Object")];
    space.tree["ns=7;b=AQ=="] = [];
    const { provider, record } = await agentHandle(space);
    const result = await provider.queryReadOnly('{"read": ["ns=7;b=AQ", "ns=7;b=AR==", "ns=7;b=AR"]}', BUDGET);
    expect(result.rows.map((row) => [row.nodeId, row.statusCode])).toEqual([
      ["ns=7;b=AQ==", OPCUA_WITHHELD_STATUS],
      ["ns=7;b=AQ==", OPCUA_WITHHELD_STATUS],
      ["ns=7;b=AQ==", OPCUA_WITHHELD_STATUS],
    ]);
    expect(record.calls.filter((call) => call.startsWith("read "))).toEqual([]);
    await expect(provider.queryReadOnly('{"browse": "ns=7;b=AR"}', BUDGET)).rejects.toThrow(
      withheldReason(OPCUA_WITHHELD_NODES[2]),
    );
  });

  test("an opaque id that does not decode is refused before anything is sent", async () => {
    const { provider, record } = await agentHandle();
    await expect(provider.queryReadOnly('{"read": ["ns=7;b=A=Q="]}', BUDGET)).rejects.toThrow(
      "its identifier does not decode",
    );
    expect(record.calls).toEqual([]);
  });

  test("a child the server answers with no key refuses the browse", async () => {
    const space = plant();
    space.tree["ns=3;s=Remote"] = [node("ns=0;i=5;namespaceUri:urn:x;serverIndex:2", "Elsewhere", "Object")];
    const { provider } = await agentHandle(space);
    await expect(provider.queryReadOnly('{"browse": "ns=3;s=Remote"}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.unkeyed,
    );
  });
});

describe("namespace 0 outside agent mode's list", () => {
  test("a value read answers it withheld with its reason and never sends it; a listed node is read", async () => {
    const { provider, record } = await agentHandle();
    const result = await provider.queryReadOnly('{"read": ["i=12642", "ns=0;i=16192", "i=2256"]}', BUDGET);
    expect(result.rows.map((row) => [row.nodeId, row.statusCode])).toEqual([
      ["i=12642", OPCUA_WITHHELD_STATUS],
      ["i=16192", OPCUA_WITHHELD_STATUS],
      ["i=2256", "Good"],
    ]);
    expect(result.warnings?.map((warning) => warning.message)).toEqual([withheldReason(OPCUA_NAMESPACE0_OUTSIDE)]);
    expect(record.calls.filter((call) => call.startsWith("read "))).toEqual(["read i=2256"]);
  });

  test("a history read or a browse of one is refused before anything is sent", async () => {
    const { provider, record } = await agentHandle();
    for (const request of ['{"history": "i=12642"}', '{"browse": "i=15644"}', '{"browse": "ns=0;i=14053"}'])
      await expect(provider.queryReadOnly(request, BUDGET)).rejects.toThrow(withheldReason(OPCUA_NAMESPACE0_OUTSIDE));
    expect(record.calls).toEqual([]);
  });
});

describe("a walk the server leaves unfinished for this identity", () => {
  /**
   * OPC PLC 2.15.10's answer to an anonymous session: the session diagnostics array is not browsed, and here a
   * per-session node beneath it would still answer its Read. An inverse browse answers each node's parents.
   */
  function deniedPlant(parents: Record<string, readonly OpcuaReference[]>) {
    const space = plant();
    space.values["ns=7;i=99"] = { value: "urn:client-app", nodeClass: "Variable" };
    space.tree["ns=3;s=Plant"] = [node("ns=3;s=SlowUInt1", "SlowUInt1"), node("ns=7;i=99", "Session", "Variable")];
    const inverse: string[] = [];
    const browse = async (
      ids: readonly OpcuaNodeId[],
      direction?: "forward" | "inverse",
    ): Promise<readonly OpcuaBrowseResult[]> => {
      if (direction === "inverse") {
        inverse.push(ids.join(","));
        return ids.map((nodeId) => ({ nodeId, references: parents[nodeId] ?? [], statusCode: "Good" }));
      }
      return ids.map((nodeId) => ({
        nodeId,
        references: space.tree[nodeId] ?? [],
        statusCode: nodeId === "i=3707" ? "BadUserAccessDenied" : nodeId in space.tree ? "Good" : "BadNodeIdUnknown",
      }));
    };
    return { space, inverse, browse };
  }

  const PARENTS = {
    "ns=7;i=99": [node("ns=0;i=3707", "SessionDiagnosticsArray"), node("ns=3;s=Plant", "Plant", "Object")],
    "ns=3;s=SlowUInt1": [node("ns=3;s=Plant", "Plant", "Object")],
    "ns=3;s=Plant": [node("ns=0;i=85", "Objects", "Object")],
  };

  test("a node beneath the unbrowsed node is answered withheld, though its Read would succeed, and is never sent", async () => {
    const fake = deniedPlant(PARENTS);
    const { provider, record } = await agentHandle(fake.space, { browse: fake.browse });
    const result = await provider.queryReadOnly('{"read": ["ns=7;i=99", "ns=3;s=SlowUInt1"]}', BUDGET);
    expect(result.rows.map((row) => [row.nodeId, row.statusCode, row.value])).toEqual([
      ["ns=7;i=99", OPCUA_WITHHELD_STATUS, null],
      ["ns=3;s=SlowUInt1", "Good", "7"],
    ]);
    expect(result.warnings?.map((warning) => warning.message)).toEqual([withheldReason(OPCUA_WITHHELD_NODES[3])]);
    expect(record.calls.filter((call) => call.startsWith("read "))).toEqual(["read ns=3;s=SlowUInt1"]);
    expect(fake.inverse).toEqual(["ns=7;i=99,ns=3;s=SlowUInt1", "ns=3;s=Plant"]);
  });

  test("a history read or a browse of one is refused with its reason", async () => {
    const fake = deniedPlant(PARENTS);
    const { provider, record } = await agentHandle(fake.space, { browse: fake.browse });
    await expect(provider.queryReadOnly('{"history": "ns=7;i=99"}', BUDGET)).rejects.toThrow(
      withheldReason(OPCUA_WITHHELD_NODES[3]),
    );
    await expect(provider.queryReadOnly('{"browse": "ns=7;i=99"}', BUDGET)).rejects.toThrow(
      withheldReason(OPCUA_WITHHELD_NODES[3]),
    );
    expect(record.calls.filter((call) => call.startsWith("historyRead"))).toEqual([]);
  });

  test("a browse steps over a child beneath it, the browsed node ending every other line", async () => {
    const fake = deniedPlant(PARENTS);
    const { provider } = await agentHandle(fake.space, { browse: fake.browse });
    const result = await provider.queryReadOnly('{"browse": "ns=3;s=Plant"}', BUDGET);
    expect(result.rows.map((row) => row.nodeId)).toEqual(["ns=3;s=SlowUInt1"]);
    expect(result.warnings?.map((warning) => warning.message)).toEqual([withheldReason(OPCUA_WITHHELD_NODES[3])]);
    // The browsed node, then its children; SlowUInt1's only parent is the browsed node, so nothing more is climbed.
    expect(fake.inverse).toEqual(["ns=3;s=Plant", "ns=3;s=SlowUInt1,ns=7;i=99"]);
  });

  test("a node whose parents cannot be read is refused rather than answered unchecked", async () => {
    const fake = deniedPlant({});
    const { provider } = await agentHandle(fake.space, { browse: fake.browse });
    await expect(provider.queryReadOnly('{"read": ["ns=3;s=SlowUInt1"]}', BUDGET)).rejects.toThrow(
      "a node answered no parent",
    );
  });
});

describe("the bounds", () => {
  test("a read past the request bound is refused whole, the units lookup counted", async () => {
    // Every Browse answers one more page, so the walk alone would never end.
    const { provider } = await agentHandle(plant(), {
      browse: async (ids) =>
        ids.map((nodeId) => ({ nodeId, references: [], statusCode: "Good", continuationPoint: new Uint8Array([1]) })),
      browseNext: async () => [
        { nodeId: "", references: [], statusCode: "Good", continuationPoint: new Uint8Array([1]) },
      ],
    });
    await expect(provider.queryReadOnly('{"read": ["i=2256"]}', BUDGET)).rejects.toThrow(
      OPCUA_AGENT_FAILURE_SENTENCES.requests,
    );
  });

  test("exactly the request bound is sent, and the next request is refused", async () => {
    let sent = 0;
    const { provider } = await agentHandle(plant(), {
      browse: async (ids) => {
        sent += 1;
        return ids.map((nodeId) => ({
          nodeId,
          references: [],
          statusCode: "Good",
          continuationPoint: new Uint8Array([1]),
        }));
      },
      browseNext: async () => {
        sent += 1;
        return [{ nodeId: "", references: [], statusCode: "Good", continuationPoint: new Uint8Array([1]) }];
      },
    });
    await expect(provider.queryReadOnly('{"read": ["i=2256"]}', BUDGET)).rejects.toThrow("request bound");
    // The limits read is the first request; every other one is a Browse.
    expect(sent).toBe(OPCUA_AGENT_MAX_REQUESTS - 1);
  });

  test("a server that never answers is refused at the time budget, in Studio's words, and its session closed", async () => {
    let release: () => void = () => {};
    const { provider, record } = await agentHandle(plant(), {
      read: () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    });
    const pending = provider.queryReadOnly('{"read": ["i=2256"]}', { ...BUDGET, statementTimeoutMs: 50 }).then(
      () => "answered",
      (error: Error) => error.message,
    );
    const message = await pending;
    expect(message).toBe(OPCUA_AGENT_FAILURE_SENTENCES.time(50));
    expect(message).toStartWith(TIME_BUDGET_PREFIX);
    release();
    // The read meets its deadline at its next request, and its session is closed then.
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
      read: async () => {
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
      read: async () => {
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

  test("the withheld walk the server refuses refuses the read, in Studio's words", async () => {
    const space = plant();
    const { provider } = await agentHandle(space, {
      browse: async (ids) => ids.map((nodeId) => ({ nodeId, references: [], statusCode: "BadEncodingLimitsExceeded" })),
    });
    await expect(provider.queryReadOnly('{"read": ["i=2256"]}', BUDGET)).rejects.toThrow(
      "the server answered BadEncodingLimitsExceeded to a browse of them",
    );
  });
});

describe("the agent path reaches only the read services", () => {
  test("no Write, Call or other service of the session is reached by any read, and GetEndpoints is not", async () => {
    const { provider, record } = await agentHandle(plant(), {
      history: async () => ({ nodeId: "ns=3;s=HistorianInt32", values: [], statusCode: "Good" }),
    });
    await provider.queryReadOnly('{"read": ["ns=6;s=Analog", "i=12637"]}', BUDGET);
    await provider.queryReadOnly('{"history": "ns=3;s=HistorianInt32"}', BUDGET);
    await provider.queryReadOnly('{"browse": "i=2253"}', BUDGET);
    const services = new Set(record.calls.map((call) => call.split(" ")[0]));
    expect([...services].sort()).toEqual(["browse", "historyRead", "limits", "read"]);
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
    // A read whose session close fails still answers.
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
