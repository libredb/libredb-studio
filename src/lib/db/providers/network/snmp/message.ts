/**
 * SNMPv2c messages, built and read by this provider rather than by a library.
 *
 * WHY THERE IS NO CLIENT LIBRARY HERE. The house doctrine says a protocol worth supporting is
 * worth supporting without a dependency (`docs/ADDING_A_PROVIDER.md:21`), and the precedent is
 * S3's request signing, which is Studio's own `node:crypto` code rather than an SDK. The second
 * reason is specific to SNMP: every client library on npm carries an agent, a trap sender and a
 * notification receiver in the same module, so depending on one means spending the rest of the
 * provider's life keeping write paths out of reach. Building three PDU types is less work than
 * guarding against the thirty that come free with a dependency.
 *
 * This file covers SNMPv2c only. SNMPv3's User-based Security Model needs key localisation, a
 * message digest and AES, and it lands separately rather than half-written here; until it does,
 * `connection-options.ts` already refuses a v2c connection that reaches past this machine
 * without consent, which is the rule that makes a v2c-only build defensible rather than lax.
 */
import {
  type BerField,
  BerError,
  readChildren,
  readField,
  TAG_INTEGER,
  TAG_OCTET_STRING,
  writeInteger,
  writeNull,
  writeOctetString,
  writeOid,
  writeSequence,
} from "./ber";
import { PDU_GET, PDU_GET_BULK, PDU_GET_NEXT } from "./valve";

/** SNMPv2c on the wire is version 1 (RFC 3416 section 3). Not a typo, and worth stating once. */
export const VERSION_V2C = 1;

export interface RequestFields {
  readonly community: string;
  readonly requestId: number;
  /** For GetBulk these are non-repeaters and max-repetitions; zero for the other two. */
  readonly nonRepeaters?: number;
  readonly maxRepetitions?: number;
  readonly oids: readonly (readonly number[])[];
}

/**
 * Builds one request datagram.
 *
 * A varbind's value is always NULL on the way out: a request names what it wants and never
 * carries a value, which is also why a provider that cannot write is a provider that never
 * fills this field.
 */
export function encodeRequest(pduTag: number, fields: RequestFields): Uint8Array {
  if (pduTag !== PDU_GET && pduTag !== PDU_GET_NEXT && pduTag !== PDU_GET_BULK) {
    throw new BerError(`0x${pduTag.toString(16)} is not a PDU type this provider builds`);
  }
  return writeSequence([
    writeInteger(VERSION_V2C),
    writeOctetString(new TextEncoder().encode(fields.community)),
    encodePdu(pduTag, fields),
  ]);
}

/**
 * Builds the PDU alone, without the version and community around it.
 *
 * v3 needs this because its PDU travels inside a scoped PDU inside an envelope, and because at
 * authPriv it is encrypted before anything is wrapped around it at all.
 */
export function encodePdu(pduTag: number, fields: Omit<RequestFields, "community">): Uint8Array {
  if (fields.oids.length === 0) throw new BerError("a request names at least one object");
  const varbinds = fields.oids.map((oid) => writeSequence([writeOid(oid), writeNull()]));
  return writeSequence(
    [
      writeInteger(fields.requestId),
      writeInteger(fields.nonRepeaters ?? 0),
      writeInteger(fields.maxRepetitions ?? 0),
      writeSequence(varbinds),
    ],
    pduTag,
  );
}

/**
 * The one Get that names nothing, used only by v3 discovery.
 *
 * It is a separate function rather than a flag on `encodePdu` so that the refusal above stays
 * absolute for every request a reader can reach. A Get with no varbinds is not a degenerate
 * read; it is a different message with a different job, and naming it separately keeps a
 * caller from arriving at one by passing an empty array it did not mean to pass.
 */
export function encodeEmptyGetPdu(requestId: number): Uint8Array {
  return writeSequence([writeInteger(requestId), writeInteger(0), writeInteger(0), writeSequence([])], PDU_GET);
}

export interface ResponseVarbind {
  readonly oid: readonly number[];
  readonly tag: number;
  readonly value: Uint8Array;
}

export interface Response {
  readonly requestId: number;
  readonly errorStatus: number;
  readonly errorIndex: number;
  readonly varbinds: readonly ResponseVarbind[];
}

/** Reads one sub-identifier run back out of an encoded OID. */
/** Shared with the v3 reader rather than copied: one decoder, one set of edge cases. */
export function readOid(bytes: Uint8Array): readonly number[] {
  if (bytes.length === 0) throw new BerError("an encoded object identifier cannot be empty");
  const out: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  let started = false;
  for (const octet of bytes.slice(1)) {
    value = value * 128 + (octet & 0x7f);
    started = true;
    if ((octet & 0x80) === 0) {
      out.push(value);
      value = 0;
      started = false;
    }
  }
  if (started) throw new BerError("an encoded object identifier ended inside a sub-identifier");
  return out;
}

function readInteger(bytes: Uint8Array): number {
  if (bytes.length === 0) throw new BerError("an integer cannot be empty");
  let value = (bytes[0] & 0x80) !== 0 ? -1 : 0;
  for (const octet of bytes) value = value * 256 + octet;
  return value;
}

/**
 * Reads one response datagram.
 *
 * Refuses anything it cannot read rather than returning a partial answer: a response this
 * process does not understand is not a smaller answer, it is an unknown one, and the two are
 * treated differently everywhere else in this provider.
 */
export function decodeResponse(datagram: Uint8Array): Response {
  const message = readField(datagram, 0);
  const [versionField, , pduField] = readChildren(datagram, message);
  if (versionField === undefined || pduField === undefined)
    throw new BerError("a message holds a version, a community and a PDU");
  if (versionField.tag !== TAG_INTEGER) throw new BerError("a message starts with its version");
  const version = readInteger(datagram.subarray(versionField.start, versionField.end));
  if (version !== VERSION_V2C) throw new BerError(`this build reads SNMPv2c, and this message says version ${version}`);

  return decodePdu(datagram, pduField);
}

/**
 * Reads a response PDU wherever it sits.
 *
 * v2c has it directly behind the community string and v3 has it inside a scoped PDU that may
 * have arrived encrypted, so the two versions differ in how they REACH this field and not at
 * all in how they read it. One reader, so a fix to varbind handling cannot reach one version
 * and miss the other.
 */
export function decodePdu(buf: Uint8Array, pduField: BerField): Response {
  const pduParts = readChildren(buf, pduField);
  if (pduParts.length !== 4) throw new BerError("a response PDU holds four fields");
  const [idField, statusField, indexField, listField] = pduParts;
  const varbinds = readChildren(buf, listField, 256).map((entry) => {
    const [oidField, valueField] = readChildren(buf, entry);
    if (oidField === undefined || valueField === undefined) throw new BerError("a varbind holds a name and a value");
    return {
      oid: readOid(buf.subarray(oidField.start, oidField.end)),
      tag: valueField.tag,
      value: buf.slice(valueField.start, valueField.end),
    };
  });
  return {
    requestId: readInteger(buf.subarray(idField.start, idField.end)),
    errorStatus: readInteger(buf.subarray(statusField.start, statusField.end)),
    errorIndex: readInteger(buf.subarray(indexField.start, indexField.end)),
    varbinds,
  };
}

/** The community out of a message, read without decoding the rest. Used by the valve's tests. */
export function communityOf(datagram: Uint8Array): string {
  const [, communityField] = readChildren(datagram, readField(datagram, 0));
  if (communityField === undefined || communityField.tag !== TAG_OCTET_STRING) {
    throw new BerError("this message carries no community");
  }
  return new TextDecoder().decode(datagram.subarray(communityField.start, communityField.end));
}
