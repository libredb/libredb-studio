/**
 * The engineering units and EU range of each variable an agent read answers, read from the server and never guessed.
 *
 * A value without its unit is a figure an agent cannot qualify, so every value the agent path answers carries its node's
 * own `EngineeringUnits` (an EUInformation: the display name, the unit id and the namespace that defines the id) and
 * `EURange` (a Range: low and high), the two properties Part 8 gives an AnalogItemType variable. They are read through
 * the same two read services as everything else on the agent path: one Browse of the variables, keeping the
 * `HasProperty` (i=46) references whose browse name is `EngineeringUnits` or `EURange`, then one Read of those
 * properties, taken only when the server answers `Good` with the standard data type (EUInformation i=887, Range i=884)
 * and the shape it defines. Measured on OPC PLC 2.15.10, `ns=6;s=DataAccess_AnalogType_Int32` answers `mV`, unit id
 * 12890 in the UNECE namespace, range 0 to 100, and `ns=3;s=SlowUInt1` publishes neither.
 *
 * WHAT IS ANSWERED WHEN THERE IS NO UNIT: `no units published` and `no range published` when the variable has no such
 * property, and a sentence naming the server's status when it has one the read could not take, so a refused property
 * is never reported as an absent one. The display name is the server's own text, answered inside the result like any
 * other value; a name is never derived from a unit id or a node's own name.
 *
 * Each Browse and Read here is a request of the agent read like any other: the provider's client counts them against
 * the read's request bound and time budget (`agent-read.ts`), and a read whose unit lookup would pass either is
 * refused whole, never answered without its units.
 */
import type { OpcuaDataValue, OpcuaNodeId, OpcuaReadOnlyClient, OpcuaReference } from "./client";
import { canonicalNodeId } from "./agent-withheld";
import { browseChunkSize, chunked, readChunkSize } from "./limits";

export const OPCUA_NO_UNITS = "no units published";
export const OPCUA_NO_RANGE = "no range published";

/** What the agent answers beside one variable's value. */
export interface OpcuaUnits {
  readonly units: string;
  readonly unitId: number | null;
  readonly unitNamespace: string | null;
  readonly euRange: string;
}

const UNITS_WITHHELD = "units not read: the node that holds them is withheld from agent mode";
const RANGE_WITHHELD = "range not read: the node that holds it is withheld from agent mode";

const HAS_PROPERTY = "i=46";
const EU_INFORMATION = "i=887";
const RANGE = "i=884";

const unreadable = (status: string): OpcuaUnits => ({
  units: `units not readable: the server answered ${status}`,
  unitId: null,
  unitNamespace: null,
  euRange: `range not readable: the server answered ${status}`,
});

/** The two property nodes one variable's browse answered, by what each holds. */
interface Properties {
  engineeringUnits?: OpcuaNodeId;
  euRange?: OpcuaNodeId;
}

function propertiesOf(references: readonly OpcuaReference[]): Properties {
  const found: Properties = {};
  for (const reference of references) {
    if (canonicalNodeId(reference.referenceTypeId) !== HAS_PROPERTY) continue;
    if (reference.browseName === "EngineeringUnits") found.engineeringUnits ??= reference.nodeId;
    if (reference.browseName === "EURange") found.euRange ??= reference.nodeId;
  }
  return found;
}

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
 * The units and range of each variable, by its node id as given.
 *
 * `withheld` holds the read's withheld set: a property node inside it is never read. `chunks` overrides the request
 * sizes for a test; the provider passes the server's own limits through `browseChunkSize` and `readChunkSize`.
 */
export async function readUnits(
  client: Pick<OpcuaReadOnlyClient, "browse" | "browseNext" | "read">,
  variables: readonly OpcuaNodeId[],
  withheld: { has(nodeId: OpcuaNodeId): boolean },
  chunks: { readonly browse: number; readonly read: number } = {
    browse: browseChunkSize({}),
    read: readChunkSize({}),
  },
): Promise<ReadonlyMap<OpcuaNodeId, OpcuaUnits>> {
  const answered = new Map<OpcuaNodeId, OpcuaUnits>();
  const found = new Map<OpcuaNodeId, Properties>();
  for (const batch of chunked(variables, chunks.browse)) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time keeps the load on the server fixed.
    const answers = await client.browse(batch);
    for (const [at, nodeId] of batch.entries()) {
      const answer = answers[at];
      if (answer === undefined) {
        answered.set(nodeId, unreadable("nothing"));
        continue;
      }
      if (!answer.statusCode.startsWith("Good") && !answer.statusCode.startsWith("Uncertain")) {
        answered.set(nodeId, unreadable(answer.statusCode));
        continue;
      }
      const references = [...answer.references];
      let point = answer.continuationPoint;
      let refused: string | undefined;
      while (point !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- a continuation point is consumed by the request that received it.
        const [next] = await client.browseNext([point]);
        if (next === undefined) {
          refused = "nothing";
          break;
        }
        if (!next.statusCode.startsWith("Good") && !next.statusCode.startsWith("Uncertain")) {
          refused = next.statusCode;
          break;
        }
        references.push(...next.references);
        point = next.continuationPoint;
      }
      if (refused !== undefined) answered.set(nodeId, unreadable(refused));
      else found.set(nodeId, propertiesOf(references));
    }
  }

  const isWithheld = (id: OpcuaNodeId | undefined): boolean =>
    id !== undefined && withheld.has(canonicalNodeId(id) ?? id);
  const toRead = [...found.values()]
    .flatMap((properties) => [properties.euRange, properties.engineeringUnits])
    .filter((id): id is OpcuaNodeId => id !== undefined && !isWithheld(id));
  const values = new Map<OpcuaNodeId, OpcuaDataValue>();
  for (const batch of chunked(toRead, chunks.read)) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time keeps a read inside the server's operation limit.
    const answers = await client.read(batch);
    for (const [at, nodeId] of batch.entries()) {
      const answer = answers[at];
      if (answer !== undefined) values.set(nodeId, answer);
    }
  }

  for (const [nodeId, properties] of found) {
    const units =
      properties.engineeringUnits === undefined
        ? { units: OPCUA_NO_UNITS, unitId: null, unitNamespace: null }
        : isWithheld(properties.engineeringUnits)
          ? { units: UNITS_WITHHELD, unitId: null, unitNamespace: null }
          : unitsFrom(values.get(properties.engineeringUnits));
    const euRange =
      properties.euRange === undefined
        ? OPCUA_NO_RANGE
        : isWithheld(properties.euRange)
          ? RANGE_WITHHELD
          : rangeFrom(values.get(properties.euRange));
    answered.set(nodeId, { ...units, euRange });
  }
  return answered;
}
