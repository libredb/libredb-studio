/**
 * The one way valve: the last thing every outbound byte passes before `socket.write`.
 *
 * WHY IT EXISTS WHEN `pdu.ts` ALREADY CANNOT BUILD A WRITE. The builders are our code. The valve is
 * about everything that is not: a transport that retries a frame, a later edit that adds a helper,
 * a caller that hands bytes straight to the socket. It reads the bytes themselves, so the
 * read only guarantee survives all three.
 *
 * It checks byte 7, the function code after the 7 byte MBAP header (TCP 3.1.3), and under function
 * code 43 it also checks byte 8, the MEI type. Anything else throws as a defect, not as a condition
 * to handle: there is no device state in which this provider should be sending another function
 * code, so a frame that reaches here is a bug and must stop here rather than reach a plant floor
 * device.
 *
 * MEASURED, by the issue author of #1723: three fixture servers took function code 06 from a client
 * that presented nothing, and over mbaps a certificate carrying the role "ReadOnly" wrote as well.
 * The device enforces nothing, so this file is the enforcement.
 */
import {
  FC_ENCAPSULATED_INTERFACE,
  FC_READ_COILS,
  FC_READ_DISCRETE_INPUTS,
  FC_READ_HOLDING_REGISTERS,
  FC_READ_INPUT_REGISTERS,
  MBAP_HEADER_BYTES,
  MBAP_LENGTH_MAX,
  MBAP_LENGTH_MIN,
  MEI_READ_DEVICE_IDENTIFICATION,
  PROTOCOL_ID,
} from "./constants";

export class ModbusValveDefect extends Error {}

/** The four function codes that may leave this process without a second byte being consulted. */
const OUTBOUND_ALLOWED: ReadonlySet<number> = new Set([
  FC_READ_COILS,
  FC_READ_DISCRETE_INPUTS,
  FC_READ_HOLDING_REGISTERS,
  FC_READ_INPUT_REGISTERS,
]);

/**
 * Throws unless `adu` is one of the five shapes. Returns nothing: a valve that returned a boolean
 * would let a caller ignore it.
 */
export function assertOutboundAllowed(adu: Buffer): void {
  if (adu.length < MBAP_HEADER_BYTES + 1)
    throw new ModbusValveDefect(
      `Outbound frame is ${adu.length} bytes, shorter than an MBAP header and a function code.`,
    );

  const protocolId = adu.readUInt16BE(2);
  if (protocolId !== PROTOCOL_ID)
    throw new ModbusValveDefect(`Outbound protocol id is ${protocolId}, and Modbus TCP defines only 0.`);

  const length = adu.readUInt16BE(4);
  if (length < MBAP_LENGTH_MIN || length > MBAP_LENGTH_MAX)
    throw new ModbusValveDefect(
      `Outbound MBAP length is ${length}, outside the ${MBAP_LENGTH_MIN} to ${MBAP_LENGTH_MAX} a Modbus TCP ADU allows.`,
    );
  if (length !== adu.length - MBAP_HEADER_BYTES + 1)
    throw new ModbusValveDefect(
      `Outbound MBAP length is ${length} but the frame carries ${adu.length - MBAP_HEADER_BYTES + 1} bytes after the transaction and protocol fields.`,
    );

  const functionCode = adu[MBAP_HEADER_BYTES];
  if (OUTBOUND_ALLOWED.has(functionCode)) return;

  if (functionCode === FC_ENCAPSULATED_INTERFACE) {
    const mei = adu[MBAP_HEADER_BYTES + 1];
    if (mei === MEI_READ_DEVICE_IDENTIFICATION) return;
    throw new ModbusValveDefect(
      `Outbound function code 43 carries MEI type 0x${(mei ?? 0).toString(16).padStart(2, "0")}, and this provider sends only MEI type 14.`,
    );
  }

  throw new ModbusValveDefect(
    `Outbound function code 0x${functionCode.toString(16).padStart(2, "0")} is not one of the five shapes this provider can send.`,
  );
}
