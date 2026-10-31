/**
 * The engineering units and EU range of the variables an agent read answers: read from the server through Browse and
 * Read alone, from the node's own EngineeringUnits and EURange properties, and "no units published" where it has none,
 * never a unit guessed from a name.
 */
import { describe, expect, test } from "bun:test";
import { OPCUA_NO_RANGE, OPCUA_NO_UNITS, readUnits } from "@/lib/db/providers/industrial/opcua/agent-units";
import type {
  OpcuaBrowseResult,
  OpcuaDataValue,
  OpcuaNodeId,
  OpcuaReference,
} from "@/lib/db/providers/industrial/opcua/client";

const property = (nodeId: string, browseName: string, referenceTypeId = "ns=0;i=46"): OpcuaReference => ({
  nodeId,
  browseName,
  displayName: browseName,
  nodeClass: "Variable",
  referenceTypeId,
  mayHaveChildren: true,
});

const EU = {
  namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact",
  unitId: 12890,
  displayName: { text: "mV" },
};

function server(
  tree: Readonly<Record<string, readonly OpcuaReference[]>>,
  values: Readonly<Record<string, Partial<OpcuaDataValue>>>,
  status: Readonly<Record<string, string>> = {},
  pages: Readonly<Record<string, readonly OpcuaReference[]>> = {},
) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      browse: async (ids: readonly OpcuaNodeId[]): Promise<readonly OpcuaBrowseResult[]> => {
        calls.push(`browse ${ids.join(",")}`);
        return ids.map((nodeId) => ({
          nodeId,
          references: tree[nodeId] ?? [],
          statusCode: status[nodeId] ?? "Good",
          ...(nodeId in pages ? { continuationPoint: new TextEncoder().encode(nodeId) } : {}),
        }));
      },
      browseNext: async (points: readonly Uint8Array[]): Promise<readonly OpcuaBrowseResult[]> => {
        const nodeId = new TextDecoder().decode(points[0]);
        calls.push(`browseNext ${nodeId}`);
        return [{ nodeId, references: pages[nodeId] ?? [], statusCode: status[`${nodeId}#next`] ?? "Good" }];
      },
      read: async (ids: readonly OpcuaNodeId[]): Promise<readonly OpcuaDataValue[]> => {
        calls.push(`read ${ids.join(",")}`);
        return ids.map((nodeId) => ({ nodeId, value: null, statusCode: "Good", ...values[nodeId] }));
      },
    },
  };
}

describe("readUnits", () => {
  test("an AnalogItemType variable answers its units and range, read through Browse and Read", async () => {
    const fake = server(
      {
        "ns=6;s=Analog": [
          property("ns=6;s=Analog_EURange", "EURange"),
          property("ns=6;s=Analog_EngineeringUnits", "EngineeringUnits"),
          property("ns=6;s=Analog_Definition", "Definition"),
        ],
      },
      {
        "ns=6;s=Analog_EURange": { value: { low: 0, high: 100 }, dataTypeId: "ns=0;i=884" },
        "ns=6;s=Analog_EngineeringUnits": { value: EU, dataTypeId: "ns=0;i=887" },
      },
    );
    const units = await readUnits(fake.client, ["ns=6;s=Analog"], new Set());
    expect(units.get("ns=6;s=Analog")).toEqual({
      units: "mV",
      unitId: 12890,
      unitNamespace: "http://www.opcfoundation.org/UA/units/un/cefact",
      euRange: "0 to 100",
    });
    // One Browse of the variables, then one Read of the two properties, and nothing else.
    expect(fake.calls).toEqual(["browse ns=6;s=Analog", "read ns=6;s=Analog_EURange,ns=6;s=Analog_EngineeringUnits"]);
  });

  test("a variable with neither property answers that none is published, and nothing more is read", async () => {
    const fake = server({ "ns=3;s=SlowUInt1": [] }, {});
    const units = await readUnits(fake.client, ["ns=3;s=SlowUInt1"], new Set());
    expect(units.get("ns=3;s=SlowUInt1")).toEqual({
      units: OPCUA_NO_UNITS,
      unitId: null,
      unitNamespace: null,
      euRange: OPCUA_NO_RANGE,
    });
    expect(fake.calls).toEqual(["browse ns=3;s=SlowUInt1"]);
  });

  test("a child named EngineeringUnits that is not a HasProperty reference is not the node's units", async () => {
    const fake = server(
      { "ns=3;s=X": [property("ns=3;s=X_EU", "EngineeringUnits", "ns=0;i=47")] },
      { "ns=3;s=X_EU": { value: EU, dataTypeId: "ns=0;i=887" } },
    );
    expect((await readUnits(fake.client, ["ns=3;s=X"], new Set())).get("ns=3;s=X")?.units).toBe(OPCUA_NO_UNITS);
  });

  test("a property of the wrong data type, or a value of the wrong shape, is never read as a unit", async () => {
    const fake = server(
      {
        "ns=3;s=A": [property("ns=3;s=A_EU", "EngineeringUnits"), property("ns=3;s=A_R", "EURange")],
        "ns=3;s=B": [property("ns=3;s=B_EU", "EngineeringUnits"), property("ns=3;s=B_R", "EURange")],
      },
      {
        "ns=3;s=A_EU": { value: "degC", dataTypeId: "ns=0;i=12" },
        "ns=3;s=A_R": { value: { low: 0, high: 1 }, dataTypeId: "ns=0;i=12" },
        "ns=3;s=B_EU": { value: { unitId: "x" }, dataTypeId: "ns=0;i=887" },
        "ns=3;s=B_R": { value: { low: "0" }, dataTypeId: "ns=0;i=884" },
      },
    );
    const units = await readUnits(fake.client, ["ns=3;s=A", "ns=3;s=B"], new Set());
    expect(units.get("ns=3;s=A")).toEqual({
      units: "units not readable: the EngineeringUnits property is not an EUInformation",
      unitId: null,
      unitNamespace: null,
      euRange: "range not readable: the EURange property is not a Range",
    });
    expect(units.get("ns=3;s=B")?.units).toBe(
      "units not readable: the EngineeringUnits property is not an EUInformation",
    );
    expect(units.get("ns=3;s=B")?.euRange).toBe("range not readable: the EURange property is not a Range");
  });

  test("a property the server refuses to read says so with its status, never no units", async () => {
    const fake = server(
      { "ns=3;s=A": [property("ns=3;s=A_EU", "EngineeringUnits"), property("ns=3;s=A_R", "EURange")] },
      {
        "ns=3;s=A_EU": { statusCode: "BadUserAccessDenied" },
        "ns=3;s=A_R": { statusCode: "BadNotReadable" },
      },
    );
    const units = await readUnits(fake.client, ["ns=3;s=A"], new Set());
    expect(units.get("ns=3;s=A")?.units).toBe("units not readable: the server answered BadUserAccessDenied");
    expect(units.get("ns=3;s=A")?.euRange).toBe("range not readable: the server answered BadNotReadable");
  });

  test("a property the read left unanswered says so", async () => {
    const fake = server({ "ns=3;s=A": [property("ns=3;s=A_EU", "EngineeringUnits")] }, {});
    fake.client.read = async () => [];
    expect((await readUnits(fake.client, ["ns=3;s=A"], new Set())).get("ns=3;s=A")?.units).toBe(
      "units not readable: the server answered nothing",
    );
  });

  test("a variable whose browse is refused says so for both, never no units", async () => {
    const fake = server({}, {}, { "ns=3;s=Gone": "BadNodeIdUnknown" });
    expect((await readUnits(fake.client, ["ns=3;s=Gone"], new Set())).get("ns=3;s=Gone")).toEqual({
      units: "units not readable: the server answered BadNodeIdUnknown",
      unitId: null,
      unitNamespace: null,
      euRange: "range not readable: the server answered BadNodeIdUnknown",
    });
  });

  test("a browse answered with nothing for a variable says so", async () => {
    const fake = server({}, {});
    fake.client.browse = async () => [];
    expect((await readUnits(fake.client, ["ns=3;s=A"], new Set())).get("ns=3;s=A")?.units).toBe(
      "units not readable: the server answered nothing",
    );
  });

  test("a property on a continued page is found, and a continuation the server refuses says so", async () => {
    const fake = server(
      { "ns=3;s=A": [], "ns=3;s=B": [] },
      { "ns=3;s=A_EU": { value: EU, dataTypeId: "i=887" } },
      { "ns=3;s=B#next": "BadContinuationPointInvalid" },
      { "ns=3;s=A": [property("ns=3;s=A_EU", "EngineeringUnits")], "ns=3;s=B": [] },
    );
    const units = await readUnits(fake.client, ["ns=3;s=A", "ns=3;s=B"], new Set());
    expect(units.get("ns=3;s=A")?.units).toBe("mV");
    expect(units.get("ns=3;s=B")?.units).toBe("units not readable: the server answered BadContinuationPointInvalid");
  });

  test("a continuation answered with nothing says so", async () => {
    const fake = server({ "ns=3;s=A": [] }, {}, {}, { "ns=3;s=A": [] });
    fake.client.browseNext = async () => [];
    expect((await readUnits(fake.client, ["ns=3;s=A"], new Set())).get("ns=3;s=A")?.units).toBe(
      "units not readable: the server answered nothing",
    );
  });

  test("a property node inside the withheld set is never read", async () => {
    const fake = server(
      { "ns=3;s=A": [property("ns=7;i=1", "EngineeringUnits"), property("ns=7;i=2", "EURange")] },
      {},
    );
    const units = await readUnits(fake.client, ["ns=3;s=A"], new Set(["ns=7;i=1", "ns=7;i=2"]));
    expect(units.get("ns=3;s=A")?.units).toBe("units not read: the node that holds them is withheld from agent mode");
    expect(units.get("ns=3;s=A")?.euRange).toBe("range not read: the node that holds it is withheld from agent mode");
    expect(fake.calls).toEqual(["browse ns=3;s=A"]);
  });

  test("an empty display name answers the unit id, never a name of Studio's own", async () => {
    const fake = server(
      {
        "ns=3;s=A": [property("ns=3;s=A_EU", "EngineeringUnits")],
        "ns=3;s=B": [property("ns=3;s=B_EU", "EngineeringUnits")],
      },
      {
        "ns=3;s=A_EU": { value: { unitId: 4408652, displayName: { text: "" } }, dataTypeId: "i=887" },
        "ns=3;s=B_EU": { value: { displayName: null }, dataTypeId: "i=887" },
      },
    );
    const units = await readUnits(fake.client, ["ns=3;s=A", "ns=3;s=B"], new Set());
    expect(units.get("ns=3;s=A")).toMatchObject({
      units: "unitId 4408652 (no display name published)",
      unitId: 4408652,
    });
    expect(units.get("ns=3;s=B")).toMatchObject({
      units: "units published with no display name and no unit id",
      unitId: null,
    });
  });

  test("no variable, no request", async () => {
    const fake = server({}, {});
    expect((await readUnits(fake.client, [], new Set())).size).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  test("variables and properties are chunked by the sizes given", async () => {
    const tree: Record<string, OpcuaReference[]> = {};
    const ids = ["ns=3;s=1", "ns=3;s=2", "ns=3;s=3"];
    for (const id of ids) tree[id] = [property(`${id}_EU`, "EngineeringUnits")];
    const fake = server(tree, {});
    await readUnits(fake.client, ids, new Set(), { browse: 2, read: 2 });
    expect(fake.calls.map((call) => call.split(" ")[0])).toEqual(["browse", "browse", "read", "read"]);
  });
});
