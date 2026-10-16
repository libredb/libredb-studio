/**
 * Parsing and checking the register map, the document everything else in this provider reads.
 *
 * WHY THE ADDRESS IS ZERO BASED AND THERE IS NO PARSER FOR MANUAL REFERENCE NUMBERS. The primary
 * source was read: Modicon Modbus Protocol Reference Guide, PI-MBUS-300 Rev. J, June 1996. Printed
 * page 18 says "Holding register 40001 is addressed as register 0000 in the data address field of
 * the message. The function code field already specifies a 'holding register' operation. Therefore
 * the '4XXXX' reference is implicit." Printed pages 58 and 62 add that "The lowest Extended Register
 * is addressed as register 'zero' (600000). The lowest Holding Register is addressed as register
 * 'one' (40001)."
 *
 * So the five digit form is 1 based and the six digit form PI-MBUS-300 defines, `6XXXXX`, is 0 based
 * and means an Extended Memory register, a different table. The form tools use, `400001`, does not
 * appear in PI-MBUS-300 at all; it was searched for. A parser that read `400001` as a six digit
 * holding register would therefore collide with the meaning the primary source gives the six digit
 * form, and both readings produce a valid address, so the collision would be silent. The map takes
 * the PDU address, which is what goes on the wire, and v1 offers no parser.
 */
import { REGISTERS_OF_TYPE, type ByteOrder, type WordOrder } from "./values";
import {
  MAX_REGISTER_MAP_BYTES,
  TABLE_SIZE,
  UNIT_ID_MAX,
  UNIT_ID_MIN,
  UNIT_ID_SERIAL_RESERVED_FROM,
} from "./constants";
import type { Table } from "./pdu";

export class ModbusMapError extends Error {}

const TABLES: ReadonlySet<string> = new Set(["coil", "discrete_input", "holding_register", "input_register"]);
const BIT_TABLES: ReadonlySet<string> = new Set(["coil", "discrete_input"]);
const SCALAR_TYPES = new Set(Object.keys(REGISTERS_OF_TYPE));

export interface MapPoint {
  readonly name: string;
  readonly unitId: number;
  readonly table: Table;
  /** The PDU address, counted from zero, exactly what goes on the wire. */
  readonly address: number;
  readonly type: string;
  readonly registers?: number;
  readonly wordOrder?: WordOrder;
  readonly byteOrder?: ByteOrder;
  readonly scale?: number;
  readonly offset?: number;
  readonly unit?: string;
}

export interface ParsedMap {
  readonly points: readonly MapPoint[];
  /** Said out loud rather than inferred, because a missing map and an empty map behave the same. */
  readonly isEmpty: boolean;
  readonly warnings: readonly string[];
}

const ORDERS: ReadonlySet<string> = new Set(["high_first", "low_first"]);

function checkPoint(raw: unknown, index: number, warnings: string[]): MapPoint {
  const where = `point ${index + 1}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ModbusMapError(`${where} is not an object.`);
  const p = raw as Record<string, unknown>;

  const known = new Set([
    "name",
    "unitId",
    "table",
    "address",
    "type",
    "registers",
    "wordOrder",
    "byteOrder",
    "scale",
    "offset",
    "unit",
    "bits",
    "encoding",
  ]);
  for (const key of Object.keys(p))
    if (!known.has(key)) throw new ModbusMapError(`${where} carries an unknown key "${key}".`);

  const name = p.name;
  if (typeof name !== "string" || name.trim().length === 0) throw new ModbusMapError(`${where} has no name.`);

  const unitId = p.unitId;
  if (!Number.isInteger(unitId) || (unitId as number) < UNIT_ID_MIN || (unitId as number) > UNIT_ID_MAX)
    throw new ModbusMapError(
      `${where} ("${name}") must name a unit id from ${UNIT_ID_MIN} to ${UNIT_ID_MAX}. Unit 0 is a broadcast, which carries writes only and is never answered.`,
    );
  if ((unitId as number) >= UNIT_ID_SERIAL_RESERVED_FROM)
    warnings.push(
      `Point "${name}" names unit ${unitId as number}, which a serial line reserves. A gateway may refuse it.`,
    );

  const table = p.table;
  if (typeof table !== "string" || !TABLES.has(table))
    throw new ModbusMapError(`${where} ("${name}") must name one of the four tables.`);

  const address = p.address;
  if (!Number.isInteger(address) || (address as number) < 0 || (address as number) >= TABLE_SIZE)
    throw new ModbusMapError(
      `${where} ("${name}") must give a PDU address from 0 to ${TABLE_SIZE - 1}, counted from zero. A number copied from a device manual is usually counted from one.`,
    );

  const type = p.type;
  if (typeof type !== "string") throw new ModbusMapError(`${where} ("${name}") has no type.`);

  if (BIT_TABLES.has(table)) {
    if (type !== "bool")
      throw new ModbusMapError(
        `${where} ("${name}") reads a ${table}, which carries one bit, so its type must be "bool".`,
      );
    return { name, unitId: unitId as number, table: table as Table, address: address as number, type };
  }

  if (type === "bool")
    throw new ModbusMapError(`${where} ("${name}") reads a register table, so its type cannot be "bool".`);
  if (!SCALAR_TYPES.has(type) && type !== "string" && type !== "bits" && type !== "raw")
    throw new ModbusMapError(`${where} ("${name}") has an unknown type "${type}".`);

  const width = REGISTERS_OF_TYPE[type];
  const registers = p.registers;
  if (width === undefined) {
    if (!Number.isInteger(registers) || (registers as number) < 1)
      throw new ModbusMapError(
        `${where} ("${name}") has type "${type}", which does not fix a width, so it must give a register count.`,
      );
  } else if (registers !== undefined && registers !== width) {
    throw new ModbusMapError(
      `${where} ("${name}") has type "${type}", which is ${width} register(s), and gives ${registers as number}.`,
    );
  }

  const span = width ?? (registers as number);
  if ((address as number) + span > TABLE_SIZE)
    throw new ModbusMapError(`${where} ("${name}") reaches past the end of the table.`);

  if (span > 1) {
    if (typeof p.wordOrder !== "string" || !ORDERS.has(p.wordOrder))
      throw new ModbusMapError(
        `${where} ("${name}") spans ${span} registers, so it must state its word order. There is no default: a wrong order reads as a plausible number with no error.`,
      );
    if (typeof p.byteOrder !== "string" || !ORDERS.has(p.byteOrder))
      throw new ModbusMapError(`${where} ("${name}") spans ${span} registers, so it must state its byte order.`);
  }

  if (p.scale !== undefined && typeof p.scale !== "number")
    throw new ModbusMapError(`${where} ("${name}") has a scale that is not a number.`);
  if (p.offset !== undefined && typeof p.offset !== "number")
    throw new ModbusMapError(`${where} ("${name}") has an offset that is not a number.`);

  return {
    name,
    unitId: unitId as number,
    table: table as Table,
    address: address as number,
    type,
    registers: registers as number | undefined,
    wordOrder: p.wordOrder as WordOrder | undefined,
    byteOrder: p.byteOrder as ByteOrder | undefined,
    scale: p.scale as number | undefined,
    offset: p.offset as number | undefined,
    unit: typeof p.unit === "string" ? p.unit : undefined,
  };
}

/**
 * Parses a map. An absent, blank or empty document is NOT an error: it is a connection whose map has
 * not been filled in yet, and section 7 of the specification requires that to list nothing rather
 * than to fail.
 */
export function parseRegisterMap(document: string | undefined | null): ParsedMap {
  if (document === undefined || document === null || document.trim().length === 0)
    return { points: [], isEmpty: true, warnings: [] };

  // The bound comes BEFORE the parse, for the reason the frame reader applies its own bound at the
  // header: a rule that runs after the work is done has not bounded the work. `JSON.parse` of a
  // multi-megabyte document builds the whole tree first, and this document arrives from a form.
  const bytes = Buffer.byteLength(document, "utf8");
  if (bytes > MAX_REGISTER_MAP_BYTES)
    throw new ModbusMapError(
      `The register map is ${bytes} bytes and the most one connection carries is ${MAX_REGISTER_MAP_BYTES}. It travels with every read and is stored with the connection, so a larger document is refused rather than truncated.`,
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch (error) {
    throw new ModbusMapError(`The register map is not valid JSON: ${(error as Error).message}`);
  }

  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { points?: unknown }).points)
      ? (parsed as { points: unknown[] }).points
      : undefined;
  if (list === undefined)
    throw new ModbusMapError(`The register map must be a list of points, or an object with a "points" list.`);
  if (list.length === 0) return { points: [], isEmpty: true, warnings: [] };

  const warnings: string[] = [];
  const points = list.map((raw, index) => checkPoint(raw, index, warnings));

  const seen = new Set<string>();
  for (const point of points) {
    if (seen.has(point.name)) throw new ModbusMapError(`Two points are named "${point.name}".`);
    seen.add(point.name);
  }
  return { points, isEmpty: false, warnings };
}
