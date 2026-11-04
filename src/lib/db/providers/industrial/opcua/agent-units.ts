/**
 * The engineering units and EU range of each variable an agent read answers, read from the server and never guessed.
 *
 * A value without its unit is a figure an agent cannot qualify, so every value the agent path answers carries its node's
 * own `EngineeringUnits` (an EUInformation: the display name, the unit id and the namespace that defines the id) and
 * `EURange` (a Range: low and high), the two properties Part 8 gives an AnalogItemType variable. Which properties a
 * variable has is the read roots walk's to say (`proveReadSet` in `agent-roots.ts`): it kept the `HasProperty` (i=46)
 * references named `EngineeringUnits` or `EURange` whose targets are members, so no Browse is sent here, and one Read
 * of those members is, taken only when the server answers `Good` with the standard data type (EUInformation i=887,
 * Range i=884) and the shape it defines. Measured on OPC PLC 2.15.10, `ns=6;s=DataAccess_AnalogType_Int32` answers
 * `mV`, unit id 12890 in the UNECE namespace, range 0 to 100, and `ns=3;s=SlowUInt1` publishes neither.
 *
 * WHAT IS ANSWERED WHEN THERE IS NO UNIT: `no units published` and `no range published` when the variable has no such
 * property, a sentence saying the property lies outside the read roots when the walk did not keep it (nothing is sent
 * for it), and a sentence naming the server's status when the read could not take it, so a refused property is never
 * reported as an absent one. The display name is the server's own text, answered inside the result like any other
 * value; a name is never derived from a unit id or a node's own name.
 *
 * The Read here is a request of the agent read like any other: the provider's client counts it against the read's
 * request bound and time budget (`agent-read.ts`), and a read whose unit lookup would pass either is refused whole,
 * never answered without its units.
 */
import { OPCUA_OUTSIDE_PROPERTY, type OpcuaReadSet } from "./agent-roots";
import type { OpcuaDataValue, OpcuaNodeId, OpcuaReadOnlyClient } from "./client";
import { canonicalNodeId } from "./agent-withheld";
import { chunked, readChunkSize } from "./limits";

export const OPCUA_NO_UNITS = "no units published";
export const OPCUA_NO_RANGE = "no range published";

/** What the agent answers beside one variable's value. */
export interface OpcuaUnits {
  readonly units: string;
  readonly unitId: number | null;
  readonly unitNamespace: string | null;
  readonly euRange: string;
}

export const OPCUA_UNITS_OUTSIDE =
  "units not read: the property that holds them is outside this connection's read roots";
export const OPCUA_RANGE_OUTSIDE = "range not read: the property that holds it is outside this connection's read roots";

const EU_INFORMATION = "i=887";
const RANGE = "i=884";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/** The EngineeringUnits property's answer, as the three fields it carries. */
function unitsFrom(answer: OpcuaDataValue | undefined): Pick<OpcuaUnits, "units" | "unitId" | "unitNamespace"> {
  const none = { unitId: null, unitNamespace: null };
  if (answer === undefined) return { units: "units not readable: the server answered nothing", ...none };
  if (answer.statusCode !== "Good")
    return { units: `units not readable: the server answered ${answer.statusCode}`, ...none };
  const value = answer.value;
  const typed = answer.dataTypeId !== undefined && canonicalNodeId(answer.dataTypeId) === EU_INFORMATION;
  const unitId = isRecord(value) ? value.unitId : undefined;
  const name = isRecord(value) && isRecord(value.displayName) ? value.displayName.text : undefined;
  if (
    !typed ||
    !isRecord(value) ||
    (unitId !== undefined && unitId !== null && typeof unitId !== "number") ||
    (name !== undefined && name !== null && typeof name !== "string")
  )
    return { units: "units not readable: the EngineeringUnits property is not an EUInformation", ...none };
  const id = typeof unitId === "number" ? unitId : null;
  const namespace = typeof value.namespaceUri === "string" && value.namespaceUri !== "" ? value.namespaceUri : null;
  const text = typeof name === "string" && name !== "" ? name : undefined;
  return {
    units:
      text ??
      (id === null
        ? "units published with no display name and no unit id"
        : `unitId ${id} (no display name published)`),
    unitId: id,
    unitNamespace: namespace,
  };
}

/** The EURange property's answer, as low to high. */
function rangeFrom(answer: OpcuaDataValue | undefined): string {
  if (answer === undefined) return "range not readable: the server answered nothing";
  if (answer.statusCode !== "Good") return `range not readable: the server answered ${answer.statusCode}`;
  const value = answer.value;
  const typed = answer.dataTypeId !== undefined && canonicalNodeId(answer.dataTypeId) === RANGE;
  if (!typed || !isRecord(value) || typeof value.low !== "number" || typeof value.high !== "number")
    return "range not readable: the EURange property is not a Range";
  return `${value.low} to ${value.high}`;
}

/**
 * The units and range of each variable, by its node id as given, from the properties the read set kept for it. Only
 * member properties are read, in one Read chunked by `chunk`; a property the walk saw outside the roots is answered as
 * not read and never sent.
 */
export async function readUnits(
  client: Pick<OpcuaReadOnlyClient, "read">,
  variables: readonly OpcuaNodeId[],
  set: Pick<OpcuaReadSet, "units">,
  chunk: number = readChunkSize({}),
): Promise<ReadonlyMap<OpcuaNodeId, OpcuaUnits>> {
  const isMember = (id: string | undefined): id is OpcuaNodeId => id !== undefined && id !== OPCUA_OUTSIDE_PROPERTY;
  const toRead = [
    ...new Set(
      variables.flatMap((nodeId) => {
        const place = set.units.get(nodeId);
        return [place?.range, place?.units].filter(isMember);
      }),
    ),
  ];
  const values = new Map<OpcuaNodeId, OpcuaDataValue>();
  for (const batch of chunked(toRead, chunk)) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time keeps a read inside the server's operation limit.
    const answers = await client.read(batch);
    for (const [at, nodeId] of batch.entries()) {
      const answer = answers[at];
      if (answer !== undefined) values.set(nodeId, answer);
    }
  }
  const answered = new Map<OpcuaNodeId, OpcuaUnits>();
  for (const nodeId of variables) {
    const place = set.units.get(nodeId);
    const units =
      place?.units === undefined
        ? { units: OPCUA_NO_UNITS, unitId: null, unitNamespace: null }
        : place.units === OPCUA_OUTSIDE_PROPERTY
          ? { units: OPCUA_UNITS_OUTSIDE, unitId: null, unitNamespace: null }
          : unitsFrom(values.get(place.units));
    const euRange =
      place?.range === undefined
        ? OPCUA_NO_RANGE
        : place.range === OPCUA_OUTSIDE_PROPERTY
          ? OPCUA_RANGE_OUTSIDE
          : rangeFrom(values.get(place.range));
    answered.set(nodeId, { ...units, euRange });
  }
  return answered;
}
