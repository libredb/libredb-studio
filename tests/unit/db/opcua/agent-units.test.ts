/**
 * The engineering units and EU range of the variables an agent read answers: the properties the read roots walk kept
 * for each, read through one Read and no Browse, "no units published" where it has none, and "not read" where the
 * property lies outside the read roots, never a unit guessed from a name.
 */
import { describe, expect, test } from "bun:test";
import type { OpcuaUnitPlaces } from "@/lib/db/providers/industrial/opcua/agent-roots";
import {
  OPCUA_NO_RANGE,
  OPCUA_NO_UNITS,
  OPCUA_RANGE_OUTSIDE,
  OPCUA_UNITS_OUTSIDE,
  readUnits,
} from "@/lib/db/providers/industrial/opcua/agent-units";
import type { OpcuaDataValue, OpcuaNodeId } from "@/lib/db/providers/industrial/opcua/client";

const EU = {
  namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact",
  unitId: 12890,
  displayName: { text: "mV" },
};

function server(values: Readonly<Record<string, Partial<OpcuaDataValue>>>) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      read: async (ids: readonly OpcuaNodeId[]): Promise<readonly OpcuaDataValue[]> => {
        calls.push(`read ${ids.join(",")}`);
        return ids.map((nodeId) => ({ nodeId, value: null, statusCode: "Good", ...values[nodeId] }));
      },
    },
  };
}

const places = (entries: Record<string, OpcuaUnitPlaces>) => ({ units: new Map(Object.entries(entries)) });

describe("readUnits", () => {
  test("an AnalogItemType variable answers its units and range in one Read, with no Browse", async () => {
    const fake = server({
      "ns=6;s=Analog_EURange": { value: { low: 0, high: 100 }, dataTypeId: "ns=0;i=884" },
      "ns=6;s=Analog_EngineeringUnits": { value: EU, dataTypeId: "ns=0;i=887" },
    });
    const set = places({
      "ns=6;s=Analog": { units: "ns=6;s=Analog_EngineeringUnits", range: "ns=6;s=Analog_EURange" },
    });
    const units = await readUnits(fake.client, ["ns=6;s=Analog"], set);
    expect(units.get("ns=6;s=Analog")).toEqual({
      units: "mV",
      unitId: 12890,
      unitNamespace: "http://www.opcfoundation.org/UA/units/un/cefact",
      euRange: "0 to 100",
    });
    expect(fake.calls).toEqual(["read ns=6;s=Analog_EURange,ns=6;s=Analog_EngineeringUnits"]);
  });

  test("a variable with neither property answers that none is published, and nothing is read", async () => {
    const fake = server({});
    expect((await readUnits(fake.client, ["ns=3;s=SlowUInt1"], places({}))).get("ns=3;s=SlowUInt1")).toEqual({
      units: OPCUA_NO_UNITS,
      unitId: null,
      unitNamespace: null,
      euRange: OPCUA_NO_RANGE,
    });
    expect(fake.calls).toEqual([]);
  });

  test("a property outside the read roots is answered as not read, and nothing is sent for it", async () => {
    const fake = server({});
    const units = await readUnits(
      fake.client,
      ["ns=3;s=A"],
      places({ "ns=3;s=A": { units: "outside", range: "outside" } }),
    );
    expect(units.get("ns=3;s=A")).toEqual({
      units: OPCUA_UNITS_OUTSIDE,
      unitId: null,
      unitNamespace: null,
      euRange: OPCUA_RANGE_OUTSIDE,
    });
    expect(OPCUA_UNITS_OUTSIDE).toBe(
      "units not read: the property that holds them is outside this connection's read roots",
    );
    expect(fake.calls).toEqual([]);
  });

  test("a property of the wrong data type, or a value of the wrong shape, is never read as a unit", async () => {
    const fake = server({
      "ns=3;s=A_EU": { value: "degC", dataTypeId: "ns=0;i=12" },
      "ns=3;s=A_R": { value: { low: 0, high: 1 }, dataTypeId: "ns=0;i=12" },
      "ns=3;s=B_EU": { value: { unitId: "x" }, dataTypeId: "ns=0;i=887" },
      "ns=3;s=B_R": { value: { low: "0" }, dataTypeId: "ns=0;i=884" },
      "ns=3;s=C_EU": { value: EU, dataTypeId: "ns=2;i=887" },
    });
    const set = places({
      "ns=3;s=A": { units: "ns=3;s=A_EU", range: "ns=3;s=A_R" },
      "ns=3;s=B": { units: "ns=3;s=B_EU", range: "ns=3;s=B_R" },
      "ns=3;s=C": { units: "ns=3;s=C_EU" },
    });
    const units = await readUnits(fake.client, ["ns=3;s=A", "ns=3;s=B", "ns=3;s=C"], set);
    for (const id of ["ns=3;s=A", "ns=3;s=B", "ns=3;s=C"])
      expect(units.get(id)?.units).toBe("units not readable: the EngineeringUnits property is not an EUInformation");
    expect(units.get("ns=3;s=A")?.euRange).toBe("range not readable: the EURange property is not a Range");
    expect(units.get("ns=3;s=B")?.euRange).toBe("range not readable: the EURange property is not a Range");
  });

  test("a property the server refuses to read, or leaves unanswered, says so, never no units", async () => {
    const fake = server({
      "ns=3;s=A_EU": { statusCode: "BadUserAccessDenied" },
      "ns=3;s=A_R": { statusCode: "BadNotReadable" },
    });
    const set = places({ "ns=3;s=A": { units: "ns=3;s=A_EU", range: "ns=3;s=A_R" } });
    const units = await readUnits(fake.client, ["ns=3;s=A"], set);
    expect(units.get("ns=3;s=A")?.units).toBe("units not readable: the server answered BadUserAccessDenied");
    expect(units.get("ns=3;s=A")?.euRange).toBe("range not readable: the server answered BadNotReadable");
    fake.client.read = async () => [];
    const silent = await readUnits(fake.client, ["ns=3;s=A"], set);
    expect(silent.get("ns=3;s=A")?.units).toBe("units not readable: the server answered nothing");
    expect(silent.get("ns=3;s=A")?.euRange).toBe("range not readable: the server answered nothing");
  });

  test("an empty display name answers the unit id, never a name of Studio's own", async () => {
    const fake = server({
      "ns=3;s=A_EU": { value: { unitId: 4408652, displayName: { text: "" } }, dataTypeId: "i=887" },
      "ns=3;s=B_EU": { value: { displayName: null }, dataTypeId: "i=887" },
    });
    const set = places({ "ns=3;s=A": { units: "ns=3;s=A_EU" }, "ns=3;s=B": { units: "ns=3;s=B_EU" } });
    const units = await readUnits(fake.client, ["ns=3;s=A", "ns=3;s=B"], set);
    expect(units.get("ns=3;s=A")).toMatchObject({
      units: "unitId 4408652 (no display name published)",
      unitId: 4408652,
    });
    expect(units.get("ns=3;s=B")).toMatchObject({
      units: "units published with no display name and no unit id",
      unitId: null,
    });
  });

  test("properties are read once each and chunked by the size given", async () => {
    const fake = server({});
    const set = places({
      "ns=3;s=1": { units: "ns=3;s=1_EU" },
      "ns=3;s=2": { units: "ns=3;s=2_EU" },
      "ns=3;s=3": { units: "ns=3;s=1_EU" },
    });
    await readUnits(fake.client, ["ns=3;s=1", "ns=3;s=2", "ns=3;s=3"], set, 1);
    expect(fake.calls).toEqual(["read ns=3;s=1_EU", "read ns=3;s=2_EU"]);
  });
});
