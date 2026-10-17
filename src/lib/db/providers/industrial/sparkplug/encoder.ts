/**
 * The only MQTT packets this provider can produce, and there is no function here that writes a
 * PUBLISH.
 *
 * THIS MODULE IS HALF OF THE READ-ONLY GUARANTEE. The other half is the decoder's import path: the
 * subpath `mqtt-packet/parser.js` carries the packet READER and nothing else, while the package
 * root re-exports `generate` and `writeToStream` and would put a packet writer one call away. So
 * the guarantee is not a policy anyone has to remember; it is the absence of code, checked from
 * two sides by `tests/unit/db/sparkplug/encoder.test.ts`.
 *
 * Five packet types are encoded, and the list is the whole of what a bounded read needs:
 * CONNECT, SUBSCRIBE, UNSUBSCRIBE, PINGREQ and DISCONNECT. A will is never set on the CONNECT,
 * because a will IS a publish: specification 5.4 registers an edge node's death certificate as its
 * MQTT will, and a reader that registered one would publish a death on a broker when its own
 * socket dropped.
 *
 * Written here rather than reused from the shipped MQTT provider, by a coordination decision after
 * this session measured why reuse does not fit: that provider's read returns a map keyed by TOPIC,
 * one row per topic, and a Sparkplug read depends on the ORDER of successive messages on the same
 * topic. Fifty data messages on one topic would become one row, and the sequence gap, the rebirth
 * ordering and a death that arrives after the next birth would all be gone. The cost of writing it
 * here instead is stated plainly in the specification: two directories carry a similar dial, and
 * that duplication is the evidence for extracting a shared transport later.
 *
 * Pure. Takes values, returns bytes. No socket, no I/O.
 */
import { MQTT_PROTOCOL_LEVEL, MQTT_PROTOCOL_NAME } from "./constants";

/** The packet types this module can produce. There is no sixth, and no PUBLISH. */
export const PACKET = Object.freeze({
  CONNECT: 0x10,
  SUBSCRIBE: 0x82,
  UNSUBSCRIBE: 0xa2,
  PINGREQ: 0xc0,
  DISCONNECT: 0xe0,
} as const);

/** A base-128 varint, which MQTT calls a Variable Byte Integer (MQTT 5.0 1.5.5). */
export function varint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 268_435_455) {
    throw new RangeError(`a variable byte integer holds 0 to 268,435,455, not ${value}`);
  }
  const out: number[] = [];
  let left = value;
  do {
    let digit = left % 128;
    left = Math.floor(left / 128);
    if (left > 0) digit |= 0x80;
    out.push(digit);
  } while (left > 0);
  return Uint8Array.from(out);
}

/** A UTF-8 string with its two-byte length (MQTT 5.0 1.5.4). */
export function mqttString(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (body.length > 65_535) {
    throw new RangeError(`an MQTT string holds at most 65,535 bytes, not ${body.length}`);
  }
  const out = new Uint8Array(body.length + 2);
  out[0] = (body.length >> 8) & 0xff;
  out[1] = body.length & 0xff;
  out.set(body, 2);
  return out;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A packet: its first byte, then its remaining length, then its body. */
function packet(firstByte: number, body: Uint8Array): Uint8Array {
  return join([Uint8Array.of(firstByte), varint(body.length), body]);
}

export interface ConnectOptions {
  readonly clientId: string;
  readonly keepAliveSeconds: number;
  readonly user?: string;
  readonly password?: string;
}

/**
 * A CONNECT with Clean Start set and a Session Expiry Interval of zero, and NO will.
 *
 * Specification 5.4 requires every client in a Sparkplug system to start clean: in MQTT 5.0 terms
 * the Clean Start flag is set and the session expiry is zero. Both are here rather than left to a
 * caller, because a caller that forgot would take over a session identifier that an edge node may
 * be using.
 *
 * THE WILL FLAG IS NOT A PARAMETER. There is no argument that could set it, so no later edit can
 * set one by passing a value: a death certificate is registered as a will (5.4), and registering
 * one would publish a death on this reader's behalf.
 */
export function encodeConnect(options: ConnectOptions): Uint8Array {
  // Bit 1 is Clean Start. Bit 2 is Will Flag and stays 0. Bits 6 and 7 are the credential flags.
  let flags = 0x02;
  if (options.user !== undefined) flags |= 0x80;
  if (options.password !== undefined) flags |= 0x40;

  // One property: Session Expiry Interval (0x11) of zero, four bytes big-endian.
  const properties = Uint8Array.of(0x11, 0x00, 0x00, 0x00, 0x00);

  const parts: Uint8Array[] = [
    mqttString(MQTT_PROTOCOL_NAME),
    Uint8Array.of(MQTT_PROTOCOL_LEVEL),
    Uint8Array.of(flags),
    Uint8Array.of((options.keepAliveSeconds >> 8) & 0xff, options.keepAliveSeconds & 0xff),
    varint(properties.length),
    properties,
    mqttString(options.clientId),
  ];
  if (options.user !== undefined) parts.push(mqttString(options.user));
  if (options.password !== undefined) parts.push(mqttString(options.password));
  return packet(PACKET.CONNECT, join(parts));
}

/**
 * A SUBSCRIBE carrying one or more filters, every one at QoS 0.
 *
 * SEVERAL FILTERS IN ONE PACKET IS THE REASON THIS EXISTS. A Sparkplug read needs two or three
 * filters that do not overlap, because MQTT 5.0 4.7.2 keeps a wildcard filter from matching a
 * topic beginning with `$`, so the stored certificates need a filter of their own. Sending them in
 * one SUBSCRIBE rather than several keeps the read to one round trip and makes the no-overlap
 * property checkable in one place.
 *
 * QoS 0 is not an option a caller can raise: specification 4.2.1 publishes births at QoS 0 and a
 * subscription at a higher QoS would ask the broker to store messages for this reader, which is
 * the opposite of taking nothing away.
 */
export function encodeSubscribe(packetId: number, filters: readonly string[]): Uint8Array {
  if (filters.length === 0) throw new RangeError("a SUBSCRIBE carries at least one filter");
  const parts: Uint8Array[] = [
    Uint8Array.of((packetId >> 8) & 0xff, packetId & 0xff),
    // No properties.
    varint(0),
  ];
  for (const filter of filters) {
    parts.push(mqttString(filter));
    // Options byte: QoS 0, no No Local, no Retain As Published, Retain Handling 0 (send retained).
    parts.push(Uint8Array.of(0x00));
  }
  return packet(PACKET.SUBSCRIBE, join(parts));
}

/** An UNSUBSCRIBE for the same filters, so a read leaves nothing behind. */
export function encodeUnsubscribe(packetId: number, filters: readonly string[]): Uint8Array {
  if (filters.length === 0) throw new RangeError("an UNSUBSCRIBE carries at least one filter");
  const parts: Uint8Array[] = [Uint8Array.of((packetId >> 8) & 0xff, packetId & 0xff), varint(0)];
  for (const filter of filters) parts.push(mqttString(filter));
  return packet(PACKET.UNSUBSCRIBE, join(parts));
}

/** PINGREQ, which is two bytes and carries nothing. */
export function encodePingReq(): Uint8Array {
  return Uint8Array.of(PACKET.PINGREQ, 0x00);
}

/** DISCONNECT with reason code 0, Normal Disconnection, and no properties. */
export function encodeDisconnect(): Uint8Array {
  return packet(PACKET.DISCONNECT, Uint8Array.of(0x00));
}
