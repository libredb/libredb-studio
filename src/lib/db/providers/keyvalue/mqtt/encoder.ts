/**
 * The only MQTT packets this provider can write (`docs/providers/mqtt.md` section 3.1).
 *
 * THE READ-ONLY GUARANTEE OF THIS PROVIDER IS THIS MODULE'S SHAPE, not a flag checked at run time. Five packets
 * are encodable here: CONNECT, SUBSCRIBE, UNSUBSCRIBE, PINGREQ and DISCONNECT. There is no function that writes
 * a PUBLISH, and CONNECT has no parameter for a Will, so neither can be produced by a caller, a configuration
 * mistake or a later edit that forgets the rule. A reviewer checks the guarantee by reading the exports.
 *
 * The valve of `valve.ts` repeats the check on the bytes themselves, because a library we did not write could
 * still put a PUBLISH on the socket; this module is why no code of ours can.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { MQTT_MAX_REMAINING_LENGTH, MQTT_PROTOCOL_NAME, MQTT_PROTOCOL_VERSION, MQTT_TYPE } from "./constants";

/** The packet types this module writes, by their four-bit identifier (section 2.1.2). */
export const MQTT_PACKET_CONNECT = 1;
export const MQTT_PACKET_SUBSCRIBE = 8;
export const MQTT_PACKET_UNSUBSCRIBE = 10;
export const MQTT_PACKET_PINGREQ = 12;
export const MQTT_PACKET_DISCONNECT = 14;

/** A Variable Byte Integer (section 1.5.5). Four bytes at most, so 268,435,455 is the largest value. */
export function encodeVariableByteInteger(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > MQTT_MAX_REMAINING_LENGTH)
    throw new DatabaseConfigError(
      `A length of ${value} cannot be written as an MQTT Variable Byte Integer.`,
      MQTT_TYPE,
    );
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte = byte | 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return Uint8Array.from(bytes);
}

/** A UTF-8 Encoded String (section 1.5.4): a two byte length, then the bytes. */
export function encodeString(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (body.length > 0xffff) throw new DatabaseConfigError("An MQTT string holds at most 65,535 bytes.", MQTT_TYPE);
  const out = new Uint8Array(2 + body.length);
  out[0] = (body.length >> 8) & 0xff;
  out[1] = body.length & 0xff;
  out.set(body, 2);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A packet: the first byte, then the Remaining Length, then the rest. */
function packet(type: number, flags: number, rest: Uint8Array): Uint8Array {
  return concat([Uint8Array.from([(type << 4) | flags]), encodeVariableByteInteger(rest.length), rest]);
}

/** A property block: its own Variable Byte Integer length, then the properties. An empty block is one zero byte. */
function properties(body: Uint8Array): Uint8Array {
  return concat([encodeVariableByteInteger(body.length), body]);
}

export interface MqttConnectOptions {
  readonly clientId: string;
  readonly keepAliveSeconds: number;
  /**
   * Clean Start is always true and the Session Expiry Interval always zero, so the broker keeps nothing for us
   * after we leave. A read-only tool that left a session behind would make the broker queue messages for a
   * client that is not coming back, which is one of the ways a broker silently drops a device's messages.
   */
  readonly user?: string;
  readonly password?: string;
}

/**
 * CONNECT (section 3.1).
 *
 * THERE IS NO WILL PARAMETER. A Will is a message the broker publishes on our behalf when we disconnect
 * badly, so a read-only tool must never register one; the way to be sure is to have no way to ask for one.
 * The Will flag is therefore written as zero from a constant, not from an argument.
 */
export function encodeConnect(options: MqttConnectOptions): Uint8Array {
  const hasUser = options.user !== undefined && options.user !== "";
  const hasPassword = options.password !== undefined && options.password !== "";
  // Bit 1 Clean Start, bit 6 Password, bit 7 User Name. Bit 2 (Will) and bits 3-5 (Will QoS, Will Retain)
  // stay zero: this provider has no Will to declare.
  const flags = 0x02 | (hasPassword ? 0x40 : 0) | (hasUser ? 0x80 : 0);
  const keepAlive = Uint8Array.from([(options.keepAliveSeconds >> 8) & 0xff, options.keepAliveSeconds & 0xff]);
  // Property 0x11 is the Session Expiry Interval, four bytes, zero: nothing survives this connection.
  const connectProperties = properties(Uint8Array.from([0x11, 0, 0, 0, 0]));
  const payload = [encodeString(options.clientId)];
  if (hasUser) payload.push(encodeString(options.user as string));
  if (hasPassword) payload.push(encodeString(options.password as string));
  return packet(
    MQTT_PACKET_CONNECT,
    0,
    concat([
      encodeString(MQTT_PROTOCOL_NAME),
      Uint8Array.from([MQTT_PROTOCOL_VERSION, flags]),
      keepAlive,
      connectProperties,
      ...payload,
    ]),
  );
}

/**
 * SUBSCRIBE (section 3.8). The fixed header's flags are 0b0010, which the standard requires.
 *
 * The subscription options byte (section 3.8.3.1) is fixed here rather than taken from the caller.
 *
 * MAXIMUM QOS IS 0, AND THAT IS A REQUIREMENT RATHER THAN A PREFERENCE. At QoS 1 the receiver MUST answer
 * each message with a PUBACK, and at QoS 2 with PUBREC and PUBCOMP (section 4.3); this provider cannot write
 * any of those packets, so a higher QoS would stall the read instead of failing visibly.
 *
 * No Local is set and Retain As Published is clear. Retain Handling is 0, so the broker sends the retained set
 * at subscribe time, which is the only way a topic nobody is publishing to becomes visible at all.
 */
export function encodeSubscribe(packetId: number, filters: readonly string[]): Uint8Array {
  if (filters.length === 0) throw new DatabaseConfigError("A SUBSCRIBE names at least one topic filter.", MQTT_TYPE);
  const options = 0x04; // QoS 0, No Local set, Retain As Published clear, Retain Handling 0.
  const payload = filters.map((filter) => concat([encodeString(filter), Uint8Array.from([options])]));
  return packet(
    MQTT_PACKET_SUBSCRIBE,
    0x02,
    concat([Uint8Array.from([(packetId >> 8) & 0xff, packetId & 0xff]), properties(new Uint8Array(0)), ...payload]),
  );
}

/** UNSUBSCRIBE (section 3.10). The fixed header's flags are 0b0010, which the standard requires. */
export function encodeUnsubscribe(packetId: number, filters: readonly string[]): Uint8Array {
  if (filters.length === 0) throw new DatabaseConfigError("An UNSUBSCRIBE names at least one topic filter.", MQTT_TYPE);
  return packet(
    MQTT_PACKET_UNSUBSCRIBE,
    0x02,
    concat([
      Uint8Array.from([(packetId >> 8) & 0xff, packetId & 0xff]),
      properties(new Uint8Array(0)),
      ...filters.map((filter) => encodeString(filter)),
    ]),
  );
}

/** PINGREQ (section 3.12). Two bytes, and the only packet with no variable header at all. */
export function encodePingReq(): Uint8Array {
  return packet(MQTT_PACKET_PINGREQ, 0, new Uint8Array(0));
}

/** DISCONNECT (section 3.14) with reason code 0x00, Normal disconnection. */
export function encodeDisconnect(): Uint8Array {
  return packet(MQTT_PACKET_DISCONNECT, 0, Uint8Array.from([0x00]));
}
