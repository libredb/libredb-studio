/**
 * The editor text is one JSON read request (issue §3), in three shapes: named points of the map,
 * one range by address, or the device's identification objects. Every shape is settled HERE,
 * before any socket exists, because a request that cannot be built is not a failed read: it is
 * text the caller should hear about while they are still looking at it.
 *
 * The schema is strict, as Kafka's is: a key this parser does not know is refused rather than
 * ignored, because ignoring it runs a DIFFERENT read from the one that was written, and the
 * caller reads the answer as the answer to their question.
 *
 * WHY THE LIMITS ARE NOT HERE. The address, quantity and unit bounds live in `checkRead`
 * (`pdu.ts`) and this parser calls it. Writing them again would put the protocol's numbers in two
 * places, and the second copy is the one that goes stale: a mutation that widens
 * `MAX_REGISTERS_PER_READ` would be caught in one file and pass in the other, which reads as a
 * bound that holds while it does not.
 *
 * WHY A NAME IS CHECKED AGAINST THE MAP. Modbus has no discovery, so a name means nothing except
 * what the user's own map says it means (§4). A name absent from the map cannot be read at all,
 * and the useful moment to say so is now, with the name in hand, rather than after a read that
 * returns an empty row for it.
 */
import { REGISTERS_OF_TYPE, type ByteOrder, type WordOrder } from "./values";
import { checkRead, ModbusRequestError, type Table } from "./pdu";

const TABLES: ReadonlySet<string> = new Set<Table>(["coil", "discrete_input", "holding_register", "input_register"]);
const BIT_TABLES: ReadonlySet<string> = new Set<Table>(["coil", "discrete_input"]);
const LEVELS: ReadonlySet<string> = new Set(["basic", "regular", "extended"]);
const ORDERS: ReadonlySet<string> = new Set<WordOrder>(["high_first", "low_first"]);

const POINTS_KEYS: ReadonlySet<string> = new Set(["read"]);
const RANGE_KEYS: ReadonlySet<string> = new Set([
  "unit",
  "table",
  "address",
  "count",
  "type",
  "wordOrder",
  "byteOrder",
]);
const IDENTIFY_KEYS: ReadonlySet<string> = new Set(["identify"]);

export type ReadRequest =
  | { readonly kind: "points"; readonly names: readonly string[] }
  | {
      readonly kind: "range";
      readonly unitId: number;
      readonly table: Table;
      readonly address: number;
      readonly count: number;
      readonly type?: string;
      readonly wordOrder?: WordOrder;
      readonly byteOrder?: ByteOrder;
    }
  | { readonly kind: "identify"; readonly level: "basic" | "regular" | "extended" };

function refuse(message: string): never {
  throw new ModbusRequestError(message);
}

/** The three shapes are told apart by which discriminator is present, never by guessing. */
function shapeOf(body: Record<string, unknown>): "points" | "range" | "identify" {
  const present = [
    Object.hasOwn(body, "read") ? "points" : undefined,
    Object.hasOwn(body, "identify") ? "identify" : undefined,
    ["unit", "table", "address", "count"].some((key) => Object.hasOwn(body, key)) ? "range" : undefined,
  ].filter((shape): shape is "points" | "range" | "identify" => shape !== undefined);
  if (present.length === 0)
    refuse(
      'A read request carries "read" for named points of the map, "unit" with "table", "address" and "count" for one range, or "identify" for the device identification objects.',
    );
  if (present.length > 1)
    refuse(
      `A read request carries one shape, and this one carries ${present.length}: ${present.join(", ")}. Send them as separate reads.`,
    );
  return present[0] as "points" | "range" | "identify";
}

function onlyKnownKeys(body: Record<string, unknown>, known: ReadonlySet<string>, shape: string): void {
  for (const key of Object.keys(body))
    if (!known.has(key))
      refuse(`A ${shape} read carries no key "${key}". It accepts ${[...known].sort().join(", ")}.`);
}

function wholeNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    refuse(`"${key}" must be a whole number, and it is ${describe(value)}.`);
  return value;
}

/** What the caller wrote, named as they would recognise it. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return `the text ${JSON.stringify(value)}`;
  if (typeof value === "number") return `the number ${value}`;
  return typeof value;
}

function parsePoints(body: Record<string, unknown>, knownNames: ReadonlySet<string>): ReadRequest {
  onlyKnownKeys(body, POINTS_KEYS, "named point");
  const names = body.read;
  if (!Array.isArray(names)) refuse(`"read" must be a list of point names, and it is ${describe(names)}.`);
  if (names.length === 0) refuse('"read" carries no point name, so there is nothing to read.');
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string") refuse(`A point name must be text, and this one is ${describe(name)}.`);
    if (name.length === 0) refuse("A point name cannot be empty.");
    if (seen.has(name)) refuse(`"${name}" is named twice, and reading it twice returns the same row twice.`);
    seen.add(name);
    if (knownNames.size === 0)
      refuse(
        `This connection carries no register map, so "${name}" names nothing. Modbus has no discovery: a name means what the map says it means.`,
      );
    if (!knownNames.has(name)) refuse(`The register map has no point named "${name}".`);
  }
  return { kind: "points", names: names as readonly string[] };
}

function parseRange(body: Record<string, unknown>): ReadRequest {
  onlyKnownKeys(body, RANGE_KEYS, "range");
  for (const key of ["unit", "table", "address", "count"])
    if (!Object.hasOwn(body, key)) refuse(`A range read needs "${key}".`);
  const table = body.table;
  if (typeof table !== "string" || !TABLES.has(table))
    refuse(`"table" must be one of ${[...TABLES].sort().join(", ")}, and it is ${describe(table)}.`);
  const unitId = wholeNumber(body.unit, "unit");
  const address = wholeNumber(body.address, "address");
  const count = wholeNumber(body.count, "count");
  // The protocol's bounds are checked in one place, and this is the call to it.
  checkRead(unitId, table as Table, address, count);

  const bits = BIT_TABLES.has(table);
  const type = Object.hasOwn(body, "type") ? body.type : undefined;
  if (type !== undefined) {
    if (bits) refuse(`A ${table} carries bits, not registers, so there is no "type" to decode it as.`);
    if (typeof type !== "string") refuse(`"type" must be text, and it is ${describe(type)}.`);
    const span = REGISTERS_OF_TYPE[type];
    if (span === undefined)
      refuse(`"${type}" is not a type this provider decodes. It decodes ${Object.keys(REGISTERS_OF_TYPE).sort().join(", ")}.`);
    if (count % span !== 0)
      refuse(
        `A ${type} occupies ${span} registers and a count of ${count} does not divide by ${span}, so the last value would be cut short and dropped without a word.`,
      );
  }
  const orders: { wordOrder?: WordOrder; byteOrder?: ByteOrder } = {};
  for (const key of ["wordOrder", "byteOrder"] as const) {
    if (!Object.hasOwn(body, key)) continue;
    // An order with nothing to order is not a harmless extra: it says the caller expected a
    // decode that this request never asked for.
    if (type === undefined) refuse(`"${key}" orders the words of a decoded value, so it needs a "type".`);
    const order = body[key];
    if (typeof order !== "string" || !ORDERS.has(order))
      refuse(`"${key}" must be ${[...ORDERS].join(" or ")}, and it is ${describe(order)}.`);
    orders[key] = order as WordOrder & ByteOrder;
  }
  return {
    kind: "range",
    unitId,
    table: table as Table,
    address,
    count,
    ...(type === undefined ? {} : { type: type as string }),
    ...orders,
  };
}

function parseIdentify(body: Record<string, unknown>): ReadRequest {
  onlyKnownKeys(body, IDENTIFY_KEYS, "identification");
  const level = body.identify;
  if (typeof level !== "string" || !LEVELS.has(level))
    refuse(`"identify" must be ${[...LEVELS].join(", ")}, and it is ${describe(level)}.`);
  return { kind: "identify", level: level as "basic" | "regular" | "extended" };
}

/**
 * Parses one read request. `knownNames` is the set of point names the connection's register map
 * declares; it is empty when the connection carries no map, and a named read is refused then
 * rather than returning rows for names that cannot exist.
 */
export function parseReadRequest(text: string, knownNames: ReadonlySet<string>): ReadRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    refuse(`The read request is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    refuse(`A read request is a JSON object, and this is ${describe(parsed)}.`);
  const body = parsed as Record<string, unknown>;
  switch (shapeOf(body)) {
    case "points":
      return parsePoints(body, knownNames);
    case "range":
      return parseRange(body);
    case "identify":
      return parseIdentify(body);
  }
}
