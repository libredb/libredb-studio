/**
 * The five request shapes this provider can build, and nothing else.
 *
 * WHY THE BUILDERS TAKE NO FUNCTION CODE. MB-S1's claim is that the provider never builds a write.
 * A builder that accepted a function code from its caller would move that claim out of this file and
 * into every caller, where it cannot be tested once. So there are five named functions and no
 * generic one, and the valve of `valve.ts` re-reads the bytes afterwards for everything that is not
 * our code: a transport retry, a later edit, a helper added in a hurry.
 *
 * MB 6.17 is the reason the allow list is of function codes and never of names: Read/Write Multiple
 * registers "performs a combination of one read operation and one write operation in a single MODBUS
 * transaction. The write operation is performed before the read", and its name begins with Read.
 */
import {
  FC_ENCAPSULATED_INTERFACE,
  FC_READ_COILS,
  FC_READ_DISCRETE_INPUTS,
  FC_READ_HOLDING_REGISTERS,
  FC_READ_INPUT_REGISTERS,
  MAX_BITS_PER_READ,
  MAX_REGISTERS_PER_READ,
  MBAP_HEADER_BYTES,
  MEI_READ_DEVICE_IDENTIFICATION,
  PROTOCOL_ID,
  TABLE_SIZE,
  UNIT_ID_MAX,
  UNIT_ID_MIN,
} from "./constants";
import type { Expectation } from "./framing";

export type BitTable = "coil" | "discrete_input";
export type RegisterTable = "holding_register" | "input_register";
export type Table = BitTable | RegisterTable;

/**
 * KURAL: the type is on the LITERAL, not on the binding.
 *
 * Written as `const X: Record<Table, number> = Object.freeze({...})` it holds ONE direction: a
 * missing member is an error and an EXTRA key is not, because the annotation is a binding and
 * `Object.freeze`'s return is not a fresh literal the checker can refuse. MEASURED on this very
 * record: a key named `fazla_anahtar` typechecked clean, while removing `coil` failed. With
 * `satisfies` inside the call, both directions fail.
 */
export const FUNCTION_CODE_OF_TABLE = Object.freeze({
  coil: FC_READ_COILS,
  discrete_input: FC_READ_DISCRETE_INPUTS,
  holding_register: FC_READ_HOLDING_REGISTERS,
  input_register: FC_READ_INPUT_REGISTERS,
} satisfies Readonly<Record<Table, number>>);

export const IDENTIFICATION_CODES = Object.freeze({
  basic: 0x01,
  regular: 0x02,
  extended: 0x03,
} satisfies Readonly<Record<"basic" | "regular" | "extended", number>>);

export class ModbusRequestError extends Error {}

const isBitTable = (table: Table): table is BitTable => table === "coil" || table === "discrete_input";

/**
 * Checks a read before a byte exists (MB-S2). Every refusal here happens before the transport
 * factory is called, which is what makes the check testable without a socket.
 */
export function checkRead(unitId: number, table: Table, address: number, quantity: number): void {
  if (!Number.isInteger(unitId) || unitId < UNIT_ID_MIN || unitId > UNIT_ID_MAX)
    throw new ModbusRequestError(
      `Unit id must be a whole number from ${UNIT_ID_MIN} to ${UNIT_ID_MAX}. Unit 0 is a broadcast, which carries writes only and is never answered.`,
    );
  if (!Number.isInteger(address) || address < 0 || address >= TABLE_SIZE)
    throw new ModbusRequestError(`Address must be a whole number from 0 to ${TABLE_SIZE - 1}.`);
  const max = isBitTable(table) ? MAX_BITS_PER_READ : MAX_REGISTERS_PER_READ;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > max)
    throw new ModbusRequestError(
      `Quantity must be a whole number from 1 to ${max} for ${isBitTable(table) ? "bits" : "registers"}.`,
    );
  if (address + quantity > TABLE_SIZE)
    throw new ModbusRequestError(
      `Address ${address} plus quantity ${quantity} passes the end of the table, which holds ${TABLE_SIZE} items.`,
    );
}

function mbap(transactionId: number, unitId: number, pdu: Buffer): Buffer {
  const head = Buffer.alloc(MBAP_HEADER_BYTES);
  head.writeUInt16BE(transactionId, 0);
  head.writeUInt16BE(PROTOCOL_ID, 2);
  head.writeUInt16BE(pdu.length + 1, 4);
  head[6] = unitId;
  return Buffer.concat([head, pdu]);
}

/** FC 01, 02, 03 or 04, chosen by the table and never by the caller. */
export function buildRead(
  transactionId: number,
  unitId: number,
  table: Table,
  address: number,
  quantity: number,
): Buffer {
  checkRead(unitId, table, address, quantity);
  const pdu = Buffer.alloc(5);
  pdu[0] = FUNCTION_CODE_OF_TABLE[table];
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(quantity, 3);
  return mbap(transactionId, unitId, pdu);
}

/**
 * What to expect back, read from the request that is going out.
 *
 * DERIVED rather than passed alongside: an expectation carried separately can disagree with the
 * bytes actually sent, and then a wrong answer matches. These are the same bytes, so they cannot.
 */
export function expectationOf(adu: Buffer): Expectation {
  const functionCode = adu[MBAP_HEADER_BYTES] ?? 0;
  const base = {
    transactionId: adu.readUInt16BE(0),
    unitId: adu[6] ?? 0,
    functionCode,
  };
  // Only the four reads carry a quantity; 43/14 answers a length of the device's own choosing.
  if (functionCode === FC_READ_COILS || functionCode === FC_READ_DISCRETE_INPUTS)
    return { ...base, quantity: adu.readUInt16BE(MBAP_HEADER_BYTES + 3), isBits: true };
  if (functionCode === FC_READ_HOLDING_REGISTERS || functionCode === FC_READ_INPUT_REGISTERS)
    return { ...base, quantity: adu.readUInt16BE(MBAP_HEADER_BYTES + 3), isBits: false };
  return base;
}

/** FC 43 with MEI type 14. The only other request this provider can produce. */
export function buildIdentification(
  transactionId: number,
  unitId: number,
  code: keyof typeof IDENTIFICATION_CODES,
  objectId = 0x00,
): Buffer {
  if (!Number.isInteger(unitId) || unitId < UNIT_ID_MIN || unitId > UNIT_ID_MAX)
    throw new ModbusRequestError(`Unit id must be a whole number from ${UNIT_ID_MIN} to ${UNIT_ID_MAX}.`);
  if (!(code in IDENTIFICATION_CODES)) throw new ModbusRequestError(`Unknown identification code.`);
  if (!Number.isInteger(objectId) || objectId < 0 || objectId > 0xff)
    throw new ModbusRequestError(`Object id must be a byte.`);
  const pdu = Buffer.from([
    FC_ENCAPSULATED_INTERFACE,
    MEI_READ_DEVICE_IDENTIFICATION,
    IDENTIFICATION_CODES[code],
    objectId,
  ]);
  return mbap(transactionId, unitId, pdu);
}

/** Exception codes the text defines (MB 7). Anything else is a frame we do not trust. */
export const EXCEPTION_SENTENCES: Readonly<Record<number, string>> = Object.freeze({
  0x01: "The device refused the function. On an mbaps connection this can also mean it refused the certificate's role.",
  0x02: "The device has no such address. A wrong address or a wrong unit id are both likely causes.",
  0x03: "The device refused the quantity.",
  0x04: "The device failed while reading. Some devices also answer this for a unit id they do not have.",
  0x05: "The device accepted the request and needs more time.",
  0x06: "The device is busy with another transaction.",
  0x08: "The device reported a parity error in its own memory.",
  0x0a: "A gateway found no path to the unit.",
  0x0b: "A gateway got no answer from the unit.",
});
