/**
 * The bridge over the real library, measured against the library's OWN objects (#1677 O-S1).
 *
 * NO SERVER HERE, AND NO MOCK OF THE LIBRARY EITHER. Every answer this file feeds the bridge is a
 * real `DataValue`, `BrowseResult`, `ReferenceDescription` or `HistoryReadResult`, built with the
 * library's constructors, because the shaping code's whole job is to read those shapes correctly: a
 * hand-written stand-in would agree with whatever the shaping code happened to do.
 *
 * What is pinned here is what a reader sees: nine attributes become one row, a status code becomes
 * a name, a timestamp becomes ISO 8601, a continuation point survives as bytes, and a node class
 * decides whether a row is browsed as a folder.
 */
import { describe, expect, test } from "bun:test";
import {
  BrowseResult,
  DataValue,
  ExpandedNodeId,
  HistoryData,
  HistoryReadResult,
  LocalizedText,
  NodeClass,
  NodeId,
  QualifiedName,
  ReferenceDescription,
  StatusCodes,
  Variant,
  DataType,
} from "node-opcua-client";
import { OPCUA_LIBRARY_BRIDGE } from "@/lib/db/providers/industrial/opcua/library";
import { OPCUA_READ_ATTRIBUTES, OPCUA_WALK_ATTRIBUTES } from "@/lib/db/providers/industrial/opcua/constants";

const SOURCE = new Date("2026-10-12T06:00:00.000Z");
const SERVER = new Date("2026-10-12T06:00:00.250Z");

/** One node's ten answers, in the order `OPCUA_READ_ATTRIBUTES` fixes. */
function nineAnswers(over: Partial<Record<string, DataValue>> = {}): DataValue[] {
  const value = new DataValue({
    value: new Variant({ dataType: DataType.UInt32, value: 42 }),
    statusCode: StatusCodes.Good,
    sourceTimestamp: SOURCE,
    serverTimestamp: SERVER,
  });
  const answers: Record<string, DataValue> = {
    value,
    nodeClass: new DataValue({
      value: new Variant({
        dataType: DataType.Int32,
        value: NodeClass.Variable,
      }),
    }),
    dataType: new DataValue({
      value: new Variant({
        dataType: DataType.NodeId,
        value: new NodeId(1, 7),
      }),
    }),
    valueRank: new DataValue({
      value: new Variant({ dataType: DataType.Int32, value: -1 }),
    }),
    arrayDimensions: new DataValue({
      value: new Variant({ dataType: DataType.Null, value: null }),
    }),
    accessLevel: new DataValue({
      value: new Variant({ dataType: DataType.Byte, value: 5 }),
    }),
    userAccessLevel: new DataValue({
      value: new Variant({ dataType: DataType.Byte, value: 1 }),
    }),
    historizing: new DataValue({
      value: new Variant({ dataType: DataType.Boolean, value: true }),
    }),
    description: new DataValue({
      value: new Variant({
        dataType: DataType.LocalizedText,
        value: new LocalizedText({ text: "a slow counter" }),
      }),
    }),
    displayName: new DataValue({
      value: new Variant({
        dataType: DataType.LocalizedText,
        value: new LocalizedText({ text: "SlowUInt1" }),
      }),
    }),
    ...over,
  };
  return [
    answers.value!,
    answers.nodeClass!,
    answers.dataType!,
    answers.valueRank!,
    answers.arrayDimensions!,
    answers.accessLevel!,
    answers.userAccessLevel!,
    answers.historizing!,
    answers.description!,
    answers.displayName!,
  ];
}

describe("shapeRead: nine attributes back to one row", () => {
  test("the control: the request asks for nine attributes per node, in this order", () => {
    expect(OPCUA_READ_ATTRIBUTES.length).toBe(10);
    // Value, NodeClass, DataType, ValueRank, ArrayDimensions, AccessLevel, UserAccessLevel,
    // Historizing, Description, DisplayName. Historizing is 20; 24 is RolePermissions.
    expect([...OPCUA_READ_ATTRIBUTES]).toEqual([13, 2, 14, 15, 16, 17, 18, 20, 5, 4]);
  });

  test("one node's ten answers become one row, with the attributes beside the value", () => {
    const [row] = OPCUA_LIBRARY_BRIDGE.shapeRead(nineAnswers(), ["ns=3;s=SlowUInt1"]);
    expect(row).toBeDefined();
    expect(row?.nodeId).toBe("ns=3;s=SlowUInt1");
    expect(row?.value).toBe(42);
    expect(row?.statusCode).toBe("Good");
    expect(row?.sourceTimestamp).toBe("2026-10-12T06:00:00.000Z");
    expect(row?.serverTimestamp).toBe("2026-10-12T06:00:00.250Z");
    expect(row?.valueRank).toBe(-1);
    expect(row?.accessLevel).toBe(5);
    expect(row?.userAccessLevel).toBe(1);
    expect(row?.historizing).toBe(true);
    expect(row?.description).toBe("a slow counter");
    expect(row?.displayName).toBe("SlowUInt1");
    // The server's own word for the node, so a Method is never printed as a Variable.
    expect(row?.nodeClass).toBe("Variable");
    expect(row?.dataTypeId).toContain("7");
  });

  /** Two nodes are two slices of nine, in the order the request named them, never the server's. */
  test("two nodes answer two rows in request order", () => {
    const answers = [
      ...nineAnswers(),
      ...nineAnswers({
        value: new DataValue({
          value: new Variant({ dataType: DataType.Int32, value: -7 }),
          statusCode: StatusCodes.Good,
        }),
      }),
    ];
    const rows = OPCUA_LIBRARY_BRIDGE.shapeRead(answers, ["ns=3;s=A", "ns=3;s=B"]);
    expect(rows.map((row) => row.nodeId)).toEqual(["ns=3;s=A", "ns=3;s=B"]);
    expect(rows[1]?.value).toBe(-7);
  });

  /**
   * A BAD STATUS IS A ROW. Measured: Milo answers `BadNotReadable` for `CurrentSessionCount` even to
   * an authenticated session, and dropping that row would say the node does not exist.
   */
  test("a node whose value is Bad keeps its row and its code", () => {
    const answers = nineAnswers({
      value: new DataValue({
        statusCode: StatusCodes.BadNotReadable,
        value: new Variant({ dataType: DataType.Null, value: null }),
      }),
    });
    const [row] = OPCUA_LIBRARY_BRIDGE.shapeRead(answers, ["i=2277"]);
    expect(row?.statusCode).toBe("BadNotReadable");
    expect(row?.value).toBeNull();
  });

  /** A node the server answered nothing at all for is reported as such, not as empty. */
  test("a missing answer reads BadNoAnswer", () => {
    const [row] = OPCUA_LIBRARY_BRIDGE.shapeRead([], ["ns=3;s=Gone"]);
    expect(row?.statusCode).toBe("BadNoAnswer");
  });

  test("an array's dimensions travel as numbers", () => {
    const answers = nineAnswers({
      arrayDimensions: new DataValue({
        value: new Variant({ dataType: DataType.UInt32, value: [100, 100] }),
      }),
    });
    const [row] = OPCUA_LIBRARY_BRIDGE.shapeRead(answers, ["ns=3;s=Matrix"]);
    expect(row?.arrayDimensions).toEqual([100, 100]);
  });
});

describe("shapeFacts: the four facts the read roots walk reads, back to one row", () => {
  test("the control: the walk asks for NodeClass, DataType, BrowseName and DisplayName, in this order", () => {
    expect([...OPCUA_WALK_ATTRIBUTES]).toEqual([2, 14, 3, 4]);
  });

  test("one node's four answers become one row, the BrowseName qualified with its namespace index", () => {
    const answers = [
      new DataValue({ value: new Variant({ dataType: DataType.Int32, value: NodeClass.Variable }) }),
      new DataValue({
        value: new Variant({ dataType: DataType.NodeId, value: new NodeId(NodeId.NodeIdType.NUMERIC, 12, 0) }),
      }),
      new DataValue({
        value: new Variant({
          dataType: DataType.QualifiedName,
          value: new QualifiedName({ namespaceIndex: 2, name: "LockingUser" }),
        }),
      }),
      new DataValue({
        value: new Variant({ dataType: DataType.LocalizedText, value: new LocalizedText({ text: "Locking user" }) }),
      }),
    ];
    const [row] = OPCUA_LIBRARY_BRIDGE.shapeFacts(answers, ["ns=2;i=6164"]);
    expect(row).toEqual({
      nodeId: "ns=2;i=6164",
      value: null,
      nodeClass: "Variable",
      dataTypeId: "ns=0;i=12",
      dataTypeStatusCode: "Good",
      browseName: { namespaceIndex: 2, name: "LockingUser" },
      displayName: "Locking user",
      statusCode: "Good",
    });
  });

  test("a refused NodeClass is the row's status, and a refused DataType is its own, with no value for either", () => {
    const refused = new DataValue({ statusCode: StatusCodes.BadUserAccessDenied });
    const [row] = OPCUA_LIBRARY_BRIDGE.shapeFacts([refused, refused, refused, refused], ["ns=3;s=A"]);
    expect(row).toEqual({
      nodeId: "ns=3;s=A",
      value: null,
      dataTypeStatusCode: "BadUserAccessDenied",
      statusCode: "BadUserAccessDenied",
    });
  });
});

describe("shapeBrowse: references, and the folder flag nothing publishes", () => {
  function reference(name: string, nodeClass: NodeClass): ReferenceDescription {
    return new ReferenceDescription({
      nodeId: new ExpandedNodeId(NodeId.NodeIdType.STRING, name, 3),
      browseName: new QualifiedName({ namespaceIndex: 3, name }),
      displayName: new LocalizedText({ text: name }),
      nodeClass,
      referenceTypeId: new NodeId(NodeId.NodeIdType.NUMERIC, 47, 0),
      isForward: true,
    });
  }

  test("every class but Method is browsed, because a Variable holds its properties", () => {
    const answer = new BrowseResult({
      statusCode: StatusCodes.Good,
      references: [
        reference("Folder", NodeClass.Object),
        reference("SlowUInt1", NodeClass.Variable),
        reference("ResetToServerDefaults", NodeClass.Method),
      ],
    });
    const [shaped] = OPCUA_LIBRARY_BRIDGE.shapeBrowse([answer], ["i=85"]);
    expect(shaped?.nodeId).toBe("i=85");
    expect(shaped?.statusCode).toBe("Good");
    expect(shaped?.references.map((row) => [row.browseName, row.nodeClass, row.mayHaveChildren])).toEqual([
      ["Folder", "Object", true],
      ["SlowUInt1", "Variable", true],
      // A method is listed and never browsed: descending into methods is what put the issue's own
      // node count 352 above the figure it quotes.
      ["ResetToServerDefaults", "Method", false],
    ]);
  });

  test("each reference keeps its type definition, and a reference the server gave none has none", () => {
    const typed = reference("ClientSession1", NodeClass.Object);
    typed.typeDefinition = new ExpandedNodeId(NodeId.NodeIdType.NUMERIC, 2029, 0);
    const answer = new BrowseResult({
      statusCode: StatusCodes.Good,
      references: [typed, reference("SlowUInt1", NodeClass.Variable)],
    });
    const [shaped] = OPCUA_LIBRARY_BRIDGE.shapeBrowse([answer], ["i=85"]);
    // The null node id a ReferenceDescription carries by default is no type, never `ns=0;i=0`.
    expect(shaped?.references.map((row) => row.typeDefinition)).toEqual(["ns=0;i=2029", undefined]);
  });

  test("a continuation point survives as bytes, so the same request can consume it", () => {
    const answer = new BrowseResult({
      statusCode: StatusCodes.Good,
      references: [],
      continuationPoint: Buffer.from([1, 2, 3]),
    });
    const [shaped] = OPCUA_LIBRARY_BRIDGE.shapeBrowse([answer], ["i=85"]);
    expect(shaped?.continuationPoint).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("no continuation point means the field is absent, not an empty array", () => {
    const answer = new BrowseResult({
      statusCode: StatusCodes.Good,
      references: [],
    });
    const [shaped] = OPCUA_LIBRARY_BRIDGE.shapeBrowse([answer], ["i=85"]);
    expect(shaped?.continuationPoint).toBeUndefined();
  });
});

describe("shapeHistory: one page of raw values", () => {
  test("values, timestamps and the continuation point", () => {
    const answer = new HistoryReadResult({
      statusCode: StatusCodes.Good,
      continuationPoint: Buffer.from([9]),
      historyData: new HistoryData({
        dataValues: [
          new DataValue({
            value: new Variant({ dataType: DataType.Int32, value: 1 }),
            statusCode: StatusCodes.Good,
            sourceTimestamp: SOURCE,
          }),
          new DataValue({
            value: new Variant({ dataType: DataType.Int32, value: 2 }),
            statusCode: StatusCodes.UncertainInitialValue,
            sourceTimestamp: SERVER,
          }),
        ],
      }),
    });
    const page = OPCUA_LIBRARY_BRIDGE.shapeHistory([answer], "ns=3;s=HistorianInt32");
    expect(page.nodeId).toBe("ns=3;s=HistorianInt32");
    expect(page.values.map((entry) => [entry.value, entry.statusCode])).toEqual([
      [1, "Good"],
      [2, "UncertainInitialValue"],
    ]);
    expect(page.values[0]?.sourceTimestamp).toBe("2026-10-12T06:00:00.000Z");
    expect(page.continuationPoint).toEqual(new Uint8Array([9]));
  });

  test("an empty page is an empty page, not a throw", () => {
    const page = OPCUA_LIBRARY_BRIDGE.shapeHistory([], "ns=3;s=HistorianInt32");
    expect(page.values).toEqual([]);
    expect(page.statusCode).toBe("BadNoAnswer");
  });
});

describe("readLimits: a limit counts only when it is Good and a number", () => {
  /** The five nodes, read in one request, exactly as the bridge sends them. */
  function sessionAnswering(answers: readonly DataValue[]): never {
    return { read: async () => answers } as never;
  }

  test("five numbers come back as five limits", async () => {
    const value = (n: number) =>
      new DataValue({
        value: new Variant({ dataType: DataType.UInt32, value: n }),
        statusCode: StatusCodes.Good,
      });
    const limits = await OPCUA_LIBRARY_BRIDGE.readLimits(
      sessionAnswering([value(2_500), value(2_500), value(1_000), value(10), value(100)]),
    );
    expect(limits).toEqual({
      maxNodesPerRead: 2_500,
      maxNodesPerBrowse: 2_500,
      maxNodesPerHistoryReadData: 1_000,
      maxBrowseContinuationPoints: 10,
      maxHistoryContinuationPoints: 100,
    });
  });

  /**
   * THE THREE WAYS A SERVER SAYS NOTHING, each measured: open62541 publishes eight limits reading 0,
   * asyncua publishes twelve of which six read Good with an EMPTY Variant, and a node a server does
   * not hold answers Bad. All three mean "no limit stated" here; `statedLimit` then drops the zero.
   */
  test("a Bad status, an empty Variant and a non-number are each reported as absent", async () => {
    const bad = new DataValue({ statusCode: StatusCodes.BadNodeIdUnknown });
    const empty = new DataValue({
      value: new Variant({ dataType: DataType.Null, value: null }),
      statusCode: StatusCodes.Good,
    });
    const text = new DataValue({
      value: new Variant({ dataType: DataType.String, value: "lots" }),
      statusCode: StatusCodes.Good,
    });
    const zero = new DataValue({
      value: new Variant({ dataType: DataType.UInt32, value: 0 }),
      statusCode: StatusCodes.Good,
    });
    const limits = await OPCUA_LIBRARY_BRIDGE.readLimits(sessionAnswering([bad, empty, text, zero, bad]));
    expect(limits.maxNodesPerRead).toBeUndefined();
    expect(limits.maxNodesPerBrowse).toBeUndefined();
    expect(limits.maxNodesPerHistoryReadData).toBeUndefined();
    // Zero IS answered here, and `statedLimit` is what reads it as no limit; this is the raw read.
    expect(limits.maxBrowseContinuationPoints).toBe(0);
    expect(limits.maxHistoryContinuationPoints).toBeUndefined();
  });

  /**
   * A BAD STATUS WITH A NUMBER IN IT IS STILL NOTHING, and this is the case the test above cannot
   * reach: its `bad` fixture carries no value, so the `typeof === "number"` half of the gate
   * already rejects it and the STATUS half never runs. Found as a surviving mutation - dropping the
   * status check passed all 341 tests - and the cost is real: a `BadNodeIdUnknown` answer that
   * happens to carry a 7 becomes a `maxNodesPerRead` of 7, which chunks every read to one node.
   */
  test("a Bad status is refused even when the answer carries a number", async () => {
    const badWithNumber = new DataValue({
      value: new Variant({ dataType: DataType.UInt32, value: 7 }),
      statusCode: StatusCodes.BadNodeIdUnknown,
    });
    const limits = await OPCUA_LIBRARY_BRIDGE.readLimits(
      sessionAnswering([badWithNumber, badWithNumber, badWithNumber, badWithNumber, badWithNumber]),
    );
    expect(limits).toEqual({});
  });
});
