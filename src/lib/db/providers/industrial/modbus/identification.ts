/**
 * Read Device Identification (function code 43, MEI type 14; MB 6.21). The protocol's only
 * self-description, and the only read a device answers without a register map.
 *
 * ONE RESPONSE IS PARSED HERE AND THE WALK IS NOT. A device may answer in several transactions:
 * the pymodbus device server answered extended identification in three (MEASURED, issue §4.10),
 * and following that chain needs a connection, which this module deliberately does not have.
 * What it owns is the shape of one answer and the decision of what an object's bytes MEAN.
 *
 * AN OBJECT'S VALUE IS DATA, NEVER MARKUP (MB-S13). The private objects 0x80 to 0xFF carry
 * whatever a vendor chose, so a value is text only when its bytes really are printable UTF-8, and
 * hex otherwise. Guessing text for bytes that are not text is how a device's own bytes end up
 * rendered as something else.
 */
import { MAX_IDENTIFICATION_OBJECT_BYTES } from "./constants";

export class ModbusIdentificationError extends Error {}

export interface IdentificationObject {
  readonly id: number;
  /** The object's bytes, exactly as the device sent them. */
  readonly bytes: Buffer;
}

export interface IdentificationResponse {
  readonly conformityLevel: number;
  /** True when the device says the answer is not complete and names where to continue. */
  readonly moreFollows: boolean;
  readonly nextObjectId: number;
  readonly objects: readonly IdentificationObject[];
}

/** The names MB 6.21 gives the objects every device may carry. Beyond these, a vendor's own. */
export const IDENTIFICATION_OBJECT_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0x00: "VendorName",
  0x01: "ProductCode",
  0x02: "MajorMinorRevision",
  0x03: "VendorUrl",
  0x04: "ProductName",
  0x05: "ModelName",
  0x06: "UserApplicationName",
});

/** The byte that means "the answer continues at the next object id" (MB 6.21). */
const MORE_FOLLOWS = 0xff;
const HEADER_BYTES = 6;

/**
 * Parses one 43/14 response body: the PDU after the function code.
 *
 * Every length the device declares is checked against the bytes that actually arrived. A declared
 * object length longer than the frame is the one shape that would otherwise read a neighbouring
 * object's bytes as this object's value, and a reader cannot tell that from data.
 */
export function parseIdentificationResponse(body: Buffer): IdentificationResponse {
  if (body.length < HEADER_BYTES)
    throw new ModbusIdentificationError(
      `An identification answer carries at least ${HEADER_BYTES} bytes before its objects, and this one carries ${body.length}.`,
    );
  const moreFollowsByte = body[3] as number;
  if (moreFollowsByte !== 0x00 && moreFollowsByte !== MORE_FOLLOWS)
    throw new ModbusIdentificationError(
      `The More Follows byte is 0x00 or 0xFF (MB 6.21), and the device sent 0x${moreFollowsByte.toString(16)}.`,
    );
  const declared = body[5] as number;
  const objects: IdentificationObject[] = [];
  let at = HEADER_BYTES;
  for (let seen = 0; seen < declared; seen += 1) {
    if (at + 2 > body.length)
      throw new ModbusIdentificationError(
        `The device declared ${declared} objects and the frame ends inside object ${seen + 1}.`,
      );
    const id = body[at] as number;
    const length = body[at + 1] as number;
    if (length > MAX_IDENTIFICATION_OBJECT_BYTES)
      throw new ModbusIdentificationError(
        `Object 0x${id.toString(16)} declares ${length} bytes, and only ${MAX_IDENTIFICATION_OBJECT_BYTES} are left for one object once this answer's own header is counted against what a Modbus frame carries.`,
      );
    if (at + 2 + length > body.length)
      throw new ModbusIdentificationError(
        `Object 0x${id.toString(16)} declares ${length} bytes and only ${body.length - at - 2} arrived.`,
      );
    objects.push({ id, bytes: Buffer.from(body.subarray(at + 2, at + 2 + length)) });
    at += 2 + length;
  }
  return {
    conformityLevel: body[2] as number,
    moreFollows: moreFollowsByte === MORE_FOLLOWS,
    nextObjectId: body[4] as number,
    objects,
  };
}

/** What to call an object: MB 6.21's name where it has one, and its own number where it does not. */
export function nameOfObject(id: number): string {
  return IDENTIFICATION_OBJECT_NAMES[id] ?? `0x${id.toString(16).padStart(2, "0")}`;
}

/**
 * An object's value as a reader can use it: the text it is, or hex when it is not text.
 *
 * "Is text" is decided by RE-ENCODING, not by looking for odd bytes: Buffer's UTF-8 decoder
 * replaces anything it cannot read with U+FFFD rather than failing, so bytes that are not UTF-8
 * come back as a string either way, and the only reliable question is whether encoding that
 * string again gives the same bytes back.
 */
export function valueOfObject(bytes: Buffer): string {
  if (bytes.length === 0) return "";
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").equals(bytes) && !/[\u0000-\u0008\u000e-\u001f\u007f]/.test(text)) return text;
  return bytes.toString("hex");
}
