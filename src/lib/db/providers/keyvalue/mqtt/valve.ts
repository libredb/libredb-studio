/**
 * The one-way valve (`docs/providers/mqtt.md` section 3.2): the last thing every byte passes on its way to the
 * broker, and the first
 * thing every byte passes on its way back.
 *
 * WHY IT EXISTS WHEN THE ENCODER ALREADY CANNOT WRITE A PUBLISH. The encoder is our code and the valve is about
 * everything that is not: a library upgrade, a transport that retries a frame, a future edit that adds a helper.
 * The valve reads the bytes themselves, so the guarantee survives all three. It is also the only place an
 * inbound size limit can live, because no MQTT package we measured lets us set one that is applied before the
 * body is buffered.
 *
 * It is not an optimisation and it is not optional. `docs/providers/mqtt.md` section 3.3 records that of twenty
 * six packages none exposes an inbound bound of our own, so this layer is required whichever library is chosen.
 */
import { MQTT_MAX_INBOUND_BYTES, MQTT_TYPE } from "./constants";
import {
  MQTT_PACKET_CONNECT,
  MQTT_PACKET_DISCONNECT,
  MQTT_PACKET_PINGREQ,
  MQTT_PACKET_SUBSCRIBE,
  MQTT_PACKET_UNSUBSCRIBE,
} from "./encoder";
import { QueryError } from "@/lib/db/errors";

/** The only packet types that may leave this process. Anything else is a defect, not a condition to handle. */
const OUTBOUND_ALLOWED: ReadonlySet<number> = new Set([
  MQTT_PACKET_CONNECT,
  MQTT_PACKET_SUBSCRIBE,
  MQTT_PACKET_UNSUBSCRIBE,
  MQTT_PACKET_PINGREQ,
  MQTT_PACKET_DISCONNECT,
]);

/** Bit 2 of the CONNECT flags byte. A Will here would make the broker publish on our behalf. */
const CONNECT_WILL_FLAG = 0x04;

/**
 * A Variable Byte Integer read from a buffer (section 1.5.5), without consuming more than four bytes.
 *
 * `need` means the length is not complete yet and the caller must wait for more bytes. It is not an error:
 * a Remaining Length can legitimately arrive split across two reads.
 */
export function readVariableByteInteger(
  bytes: Uint8Array,
  at: number,
): { readonly value: number; readonly size: number } | "need" | "malformed" {
  let value = 0;
  let multiplier = 1;
  for (let i = 0; i < 4; i += 1) {
    const index = at + i;
    if (index >= bytes.length) return "need";
    const byte = bytes[index] as number;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, size: i + 1 };
    multiplier *= 128;
  }
  return "malformed";
}

/**
 * The outbound half: a packet is written only if its type is one of the five and, for a CONNECT, only if the
 * Will flag is clear.
 *
 * A refusal throws rather than dropping the packet. A dropped CONNECT would leave the caller waiting for a
 * CONNACK that cannot arrive, which is the silent failure this whole design exists to avoid.
 */
export function guardOutboundPacket(bytes: Uint8Array): void {
  if (bytes.length < 2) throw new QueryError("An outbound MQTT packet is shorter than its own header.", MQTT_TYPE);
  const type = ((bytes[0] as number) >> 4) & 0x0f;
  if (!OUTBOUND_ALLOWED.has(type))
    throw new QueryError(
      `This connection is read only: it writes CONNECT, SUBSCRIBE, UNSUBSCRIBE, PINGREQ and DISCONNECT, ` +
        `and a packet of type ${type} was refused before it reached the broker.`,
      MQTT_TYPE,
    );
  if (type !== MQTT_PACKET_CONNECT) return;
  // The connect flags byte sits after the protocol name, the version byte and the Remaining Length.
  const length = readVariableByteInteger(bytes, 1);
  if (length === "need" || length === "malformed")
    throw new QueryError("An outbound CONNECT carries no readable length.", MQTT_TYPE);
  const nameAt = 1 + length.size;
  const nameLength = ((bytes[nameAt] as number) << 8) | (bytes[nameAt + 1] as number);
  const flagsAt = nameAt + 2 + nameLength + 1;
  const flags = bytes[flagsAt];
  if (flags === undefined) throw new QueryError("An outbound CONNECT is shorter than its own flags.", MQTT_TYPE);
  if ((flags & CONNECT_WILL_FLAG) !== 0)
    throw new QueryError(
      "This connection is read only: a CONNECT carrying a Will was refused before it reached the broker. " +
        "A Will would make the broker publish a message on this connection's behalf.",
      MQTT_TYPE,
    );
}

/** What the inbound half decided about the bytes it has so far. */
export type MqttInboundVerdict =
  /** The length is not complete yet; call again when more bytes have arrived. */
  | { readonly kind: "need" }
  /** A whole packet is present, from `start` for `size` bytes. */
  | { readonly kind: "packet"; readonly start: number; readonly size: number; readonly packetType: number }
  /**
   * The packet is larger than the inbound limit. Its bytes are skipped by count and never allocated, and the
   * caller reports the skip: a read that quietly omits an oversized message is the kind of loss this design
   * refuses. The bound is `MQTT_MAX_INBOUND_BYTES`, 8 MiB; anything at or under it is delivered and read.
   */
  | { readonly kind: "skip"; readonly size: number; readonly bytes: number; readonly packetType: number }
  /** The stream is not MQTT any more. The connection is destroyed; nothing after this point is trustworthy. */
  | { readonly kind: "malformed"; readonly reason: string };

/**
 * The inbound half: read the fixed header and the Remaining Length, and decide before the body is buffered.
 *
 * THE DECISION HAPPENS ON THE HEADER, which is what makes the limit real. A library that checks after parsing
 * has already allocated the body: in our measurement a 250 MiB declared length grew the process by 251 MB with
 * no error raised and no packet produced.
 */
export function inspectInboundPacket(bytes: Uint8Array, at: number): MqttInboundVerdict {
  if (at + 1 >= bytes.length) return { kind: "need" };
  const packetType = ((bytes[at] as number) >> 4) & 0x0f;
  const length = readVariableByteInteger(bytes, at + 1);
  if (length === "need") return { kind: "need" };
  if (length === "malformed")
    return { kind: "malformed", reason: "A packet declared a length that is not a Variable Byte Integer." };
  // No ceiling check here, and that is not an oversight: `readVariableByteInteger` reads at most four bytes,
  // whose largest value is exactly `MQTT_MAX_REMAINING_LENGTH`, so a length over it cannot be decoded in the
  // first place - a fifth continuation byte returns "malformed" above. An audit found the check that used to
  // sit here was unreachable. `tests/unit/db/mqtt/valve.test.ts` pins the decoder's ceiling to the constant,
  // so a decoder widened to five bytes fails there rather than passing silently past a bound nobody re-added.
  const header = 1 + length.size;
  const size = header + length.value;
  if (length.value > MQTT_MAX_INBOUND_BYTES) return { kind: "skip", size, bytes: length.value, packetType };
  if (at + size > bytes.length) return { kind: "need" };
  return { kind: "packet", start: at, size, packetType };
}
