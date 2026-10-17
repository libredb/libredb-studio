/**
 * The one-way valve (SN-S1): the last thing every datagram passes on its way to the agent.
 *
 * WHY IT EXISTS WHEN THE CLIENT IS ALREADY BEHIND A SEAM. `net-snmp` 3.29.2 is one CommonJS
 * module that also holds an agent, a notification sender and receiver, a proxy forwarder and
 * an AgentX subagent, so no import leaves the write paths out. The seam in `client.ts` and its
 * guard test are the first layer; this is the second, and it reads the bytes themselves, so it
 * survives a library upgrade, a transport that resends a frame, and a future helper.
 *
 * WHAT IT CANNOT DO, MEASURED. At SNMPv3 authPriv, the level the connection form opens on, the
 * scoped PDU is encrypted before it reaches the socket: measured against `net-snmp` 3.29.2 on
 * 13 October 2026, the outgoing message's msgData field is an encryptedPDU (tag 0x04) and the
 * PDU type is not in the datagram at all. Encryption happens in the library's message builder
 * (`index.js:1685`) and the socket it is given is created later (`index.js:2132`), so there is
 * no point between the two a caller reaches without patching the library. The valve therefore
 * returns "opaque" for that case rather than guessing, and the seam carries the guarantee
 * there. It still covers v2c, authNoPriv, and the discovery leg of an authPriv session, which
 * is sent at noAuthNoPriv (RFC 3414 section 4) and so is readable.
 *
 * It is not an optimisation and it is not optional. Three of the four points at which a
 * request leaves are checkable, and the valve checks them.
 */
import { QueryError } from "@/lib/db/errors";
import { BerError, readChildren, readField } from "./ber";

/** PDU tags, from RFC 3416 section 3. The values are the library's `PduType` as well. */
export const PDU_GET = 0xa0;
export const PDU_GET_NEXT = 0xa1;
const PDU_RESPONSE = 0xa2;
export const PDU_SET = 0xa3;
export const PDU_GET_BULK = 0xa5;
/** RFC 3416 section 3: the only answer a v3 discovery request draws. Read by `v3-message.ts`. */
export const PDU_REPORT = 0xa8;
const PDU_INFORM = 0xa6;
const PDU_TRAP_V2 = 0xa7;

/**
 * The only PDU types that may leave this process, which are exactly RFC 3411 section 2.8's
 * Read Class. Anything else is a defect in our own code, not a condition to handle.
 */
const OUTBOUND_ALLOWED: ReadonlySet<number> = new Set([PDU_GET, PDU_GET_NEXT, PDU_GET_BULK]);

/** SNMP version numbers on the wire (RFC 3416 section 3, RFC 3412 section 6.1). */
const VERSION_V1 = 0;
const VERSION_V2C = 1;
const VERSION_V3 = 3;

export type ValveVerdict =
  /** The PDU type was read and is in the Read Class. */
  | { readonly kind: "allowed"; readonly pduType: number }
  /** The message is an authPriv v3 request, so the type is not readable here. */
  | { readonly kind: "opaque"; readonly reason: string };

export class ValveRefusal extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "ValveRefusal";
    Object.setPrototypeOf(this, ValveRefusal.prototype);
  }
}

/**
 * Reads the outgoing datagram and either names its PDU type or says why it cannot.
 *
 * Refuses rather than returns for anything it can read and does not like: a write PDU, a
 * notification, SNMPv1 (which this provider does not speak at all), and any message it cannot
 * parse. An unparsable outgoing message is our own defect, and sending it would mean sending
 * bytes nothing in this process understands.
 */
export function inspectOutbound(datagram: Uint8Array): ValveVerdict {
  let message;
  try {
    message = readField(datagram, 0);
    if (message.tag !== 0x30) throw new BerError(`outer tag 0x${message.tag.toString(16)} is not a SEQUENCE`);
  } catch (error) {
    throw new ValveRefusal(`refused an outgoing message this process cannot parse: ${(error as Error).message}`);
  }

  let fields;
  try {
    fields = readChildren(datagram, message);
  } catch (error) {
    throw new ValveRefusal(`refused an outgoing message this process cannot parse: ${(error as Error).message}`);
  }
  if (fields.length < 3) throw new ValveRefusal("refused an outgoing message with fewer than three fields");

  const versionField = fields[0];
  if (versionField.tag !== 0x02)
    throw new ValveRefusal("refused an outgoing message whose first field is not the version");
  if (versionField.end - versionField.start !== 1)
    throw new ValveRefusal("refused an outgoing message with a wide version field");
  const version = datagram[versionField.start];

  if (version === VERSION_V1) {
    // Not a fallback and not a downgrade: this provider has no v1 path, so a v1 message on
    // the socket means something built one that nothing here should be able to build.
    throw new ValveRefusal("refused an SNMPv1 message: this provider does not speak v1");
  }

  if (version === VERSION_V2C) {
    // SEQUENCE { version, community OCTET STRING, PDU }
    const pdu = fields[2];
    return verdictFor(pdu.tag);
  }

  if (version === VERSION_V3) {
    // SEQUENCE { version, msgGlobalData SEQUENCE, msgSecurityParameters OCTET STRING, msgData }
    if (fields.length < 4) throw new ValveRefusal("refused an SNMPv3 message with fewer than four fields");
    const msgData = fields[3];
    if (msgData.tag === 0x04) {
      // An encryptedPDU. Measured: this is what every authPriv request looks like here.
      return { kind: "opaque", reason: "authPriv: the scoped PDU is encrypted before it reaches the socket" };
    }
    if (msgData.tag !== 0x30)
      throw new ValveRefusal(`refused an SNMPv3 message whose msgData tag is 0x${msgData.tag.toString(16)}`);
    // ScopedPDU ::= SEQUENCE { contextEngineID, contextName, data }
    let scoped;
    try {
      scoped = readChildren(datagram, msgData);
    } catch (error) {
      throw new ValveRefusal(`refused an SNMPv3 scoped PDU this process cannot parse: ${(error as Error).message}`);
    }
    if (scoped.length !== 3) throw new ValveRefusal("refused a scoped PDU that does not hold three fields");
    return verdictFor(scoped[2].tag);
  }

  throw new ValveRefusal(`refused an outgoing message with version ${version}`);
}

function verdictFor(pduType: number): ValveVerdict {
  if (OUTBOUND_ALLOWED.has(pduType)) return { kind: "allowed", pduType };
  const named =
    pduType === PDU_SET
      ? "a SetRequest"
      : pduType === PDU_INFORM
        ? "an InformRequest"
        : pduType === PDU_TRAP_V2
          ? "a Trap"
          : pduType === PDU_RESPONSE
            ? "a Response"
            : `PDU type 0x${pduType.toString(16)}`;
  throw new ValveRefusal(`refused to send ${named}: this provider sends only Get, GetNext and GetBulk`);
}
