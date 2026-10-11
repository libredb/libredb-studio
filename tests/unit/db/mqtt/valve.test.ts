/**
 * The MQTT provider's one-way valve (`docs/providers/mqtt.md` section 3.2), the read-only guarantee in bytes.
 *
 * THE TESTS ARE STRUCTURAL, NOT BEHAVIOURAL. A behavioural test would check that the provider happens not to
 * publish today; these check that a PUBLISH cannot reach the socket even when one is handed to the valve
 * directly, which is the claim the provider's documentation makes.
 *
 * The planted packets are hand-encoded here rather than produced by our encoder, because our encoder cannot
 * produce them: that is the point of it, and a test that could only use our encoder would certify nothing
 * about a library, a transport retry or a later edit.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { MQTT_MAX_INBOUND_BYTES, MQTT_MAX_REMAINING_LENGTH } from "@/lib/db/providers/keyvalue/mqtt/constants";
import {
  encodeConnect,
  encodeDisconnect,
  encodePingReq,
  encodeSubscribe,
  encodeUnsubscribe,
  encodeVariableByteInteger,
} from "@/lib/db/providers/keyvalue/mqtt/encoder";
import {
  guardOutboundPacket,
  inspectInboundPacket,
  readVariableByteInteger,
} from "@/lib/db/providers/keyvalue/mqtt/valve";

/** A packet of a given type with a body the valve never reads, built without our encoder. */
function plantedPacket(type: number, body: readonly number[] = []): Uint8Array {
  const length = encodeVariableByteInteger(body.length);
  return Uint8Array.from([(type << 4) | 0, ...length, ...body]);
}

describe("the outbound half refuses everything but the five packets", () => {
  test("the five this provider writes all pass", () => {
    const five = [
      encodeConnect({ clientId: "libredb-test", keepAliveSeconds: 60 }),
      encodeSubscribe(1, ["#"]),
      encodeUnsubscribe(1, ["#"]),
      encodePingReq(),
      encodeDisconnect(),
    ];
    // A zero-length population would certify nothing, so the count is asserted before the loop.
    expect(five).toHaveLength(5);
    for (const packet of five) expect(() => guardOutboundPacket(packet)).not.toThrow();
  });

  /**
   * PUBLISH is packet type 3. This is the packet the whole provider exists to be unable to send, so it is
   * named on its own rather than only inside the sweep below.
   */
  test("a PUBLISH is refused, and the refusal names the connection as read only", () => {
    const publish = plantedPacket(3, [0x00, 0x01, 0x61, 0x62]);
    expect(() => guardOutboundPacket(publish)).toThrow(QueryError);
    expect(() => guardOutboundPacket(publish)).toThrow(/read only/);
    expect(() => guardOutboundPacket(publish)).toThrow(/type 3/);
  });

  test("every packet type outside the five is refused", () => {
    const allowed = new Set([1, 8, 10, 12, 14]);
    const refused: number[] = [];
    for (let type = 1; type <= 15; type += 1) {
      if (allowed.has(type)) continue;
      expect(() => guardOutboundPacket(plantedPacket(type))).toThrow(QueryError);
      refused.push(type);
    }
    // PUBACK, PUBREC, PUBREL, PUBCOMP, SUBACK, UNSUBACK, PINGRESP, AUTH and the rest: ten of them.
    expect(refused).toEqual([2, 3, 4, 5, 6, 7, 9, 11, 13, 15]);
  });

  /**
   * A Will is a message the broker publishes on this connection's behalf after a bad disconnect, so it is a
   * write with a delay on it. Our `encodeConnect` has no parameter for one; the valve is what catches a CONNECT
   * that acquired one anywhere else.
   */
  test("a CONNECT carrying a Will is refused", () => {
    const clean = encodeConnect({ clientId: "libredb-test", keepAliveSeconds: 60 });
    expect(() => guardOutboundPacket(clean)).not.toThrow();

    // The connect flags byte sits after the Remaining Length, the protocol name and the version byte.
    const withWill = Uint8Array.from(clean);
    const flagsAt = 1 + 1 + 2 + 4 + 1; // one type byte, one length byte, the 2+4 byte name, the version byte
    expect(withWill[flagsAt]).toBe(0x02); // Clean Start only, before the Will is planted
    withWill[flagsAt] = (withWill[flagsAt] as number) | 0x04;

    expect(() => guardOutboundPacket(withWill)).toThrow(QueryError);
    expect(() => guardOutboundPacket(withWill)).toThrow(/Will/);
  });

  test("our encoder exports no function that writes a PUBLISH", async () => {
    const encoder = await import("@/lib/db/providers/keyvalue/mqtt/encoder");
    const writers = Object.keys(encoder).filter((name) => name.startsWith("encode"));
    expect(writers.sort()).toEqual([
      "encodeConnect",
      "encodeDisconnect",
      "encodePingReq",
      "encodeString",
      "encodeSubscribe",
      "encodeUnsubscribe",
      "encodeVariableByteInteger",
    ]);
    expect(writers.some((name) => /publish/i.test(name))).toBe(false);
  });
});

describe("the inbound half decides on the header, before the body is buffered", () => {
  test("a whole packet is reported with its own size", () => {
    const packet = plantedPacket(13); // PINGRESP, two bytes
    const verdict = inspectInboundPacket(packet, 0);
    expect(verdict).toEqual({ kind: "packet", start: 0, size: 2, packetType: 13 });
  });

  test("a packet whose body has not arrived asks for more rather than guessing", () => {
    const header = Uint8Array.from([0x30, 0x0a, 0x00]); // PUBLISH declaring ten bytes, three present
    expect(inspectInboundPacket(header, 0)).toEqual({ kind: "need" });
  });

  /**
   * The limit is applied to the DECLARED length, which is the only form in which the decision can be made
   * before memory is committed. A library that checks after parsing has already allocated the body: in our
   * measurement a 250 MiB declared length grew the process by 251 MB with no error and no packet produced.
   */
  test("a packet over the inbound limit is skipped by count, and its size is reported", () => {
    const oversize = MQTT_MAX_INBOUND_BYTES + 1;
    const header = Uint8Array.from([0x30, ...encodeVariableByteInteger(oversize)]);
    const verdict = inspectInboundPacket(header, 0);
    expect(verdict.kind).toBe("skip");
    if (verdict.kind !== "skip") throw new Error("the limit did not skip an oversized packet");
    expect(verdict.bytes).toBe(oversize);
    expect(verdict.size).toBe(header.length + oversize);
    // The verdict is reached from five bytes of header, so nothing the size of the body was ever held.
    expect(header.length).toBeLessThan(8);
  });

  /**
   * THE BOUNDARY ITSELF, which nothing asserted: the limit is a maximum, so a packet of exactly that many
   * bytes is DELIVERED. Reading the comparison as `>=` instead of `>` skipped it, and the whole suite stayed
   * green because every other test sat a comfortable distance from the edge. The cost of that off-by-one is
   * a message thrown away and reported as lost when it was within the limit all along.
   */
  test("a packet of exactly the inbound limit is delivered, because the limit is a maximum", () => {
    const header = Uint8Array.from([0x30, ...encodeVariableByteInteger(MQTT_MAX_INBOUND_BYTES)]);
    // Only the header is present, so the verdict is "need more bytes" rather than "skip": the point is that
    // it is NOT a skip, which is what the `>=` reading would have made it.
    expect(inspectInboundPacket(header, 0)).toEqual({ kind: "need" });

    // One byte over, with the same shape, is a skip. The pair is what pins the edge rather than the region.
    const over = Uint8Array.from([0x30, ...encodeVariableByteInteger(MQTT_MAX_INBOUND_BYTES + 1)]);
    expect(inspectInboundPacket(over, 0).kind).toBe("skip");
  });

  test("a length no MQTT packet can carry is malformed rather than skipped", () => {
    // Five continuation bytes: a Variable Byte Integer is four at most.
    const broken = Uint8Array.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    const verdict = inspectInboundPacket(broken, 0);
    expect(verdict.kind).toBe("malformed");
  });
});

describe("the Variable Byte Integer, both ways", () => {
  test("every boundary of the standard's own table round trips", () => {
    // Table 1-1, section 1.5.5: the last value of each byte count.
    const boundaries = [0, 127, 128, 16_383, 16_384, 2_097_151, 2_097_152, 268_435_455];
    const sizes: number[] = [];
    for (const value of boundaries) {
      const encoded = encodeVariableByteInteger(value);
      const decoded = readVariableByteInteger(encoded, 0);
      expect(decoded).toEqual({ value, size: encoded.length });
      sizes.push(encoded.length);
    }
    expect(sizes).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  test("a value above the largest Remaining Length is refused rather than truncated", () => {
    expect(() => encodeVariableByteInteger(268_435_456)).toThrow();
  });

  test("an incomplete integer asks for more bytes", () => {
    expect(readVariableByteInteger(Uint8Array.from([0x80]), 0)).toBe("need");
  });

  /**
   * THE DECODER'S OWN CEILING, pinned to the constant, because `inspectInboundPacket` no longer checks it.
   *
   * It used to, and an audit showed the check was unreachable: four bytes of seven bits each cannot express
   * more than `MQTT_MAX_REMAINING_LENGTH`, so the branch was dead. Deleting a dead branch is only safe while
   * the reason it was dead still holds, which is what these two assert. A decoder widened to five bytes
   * fails here, where the deleted bound would have been needed.
   */
  test("four bytes of continuation express exactly the protocol's maximum and no more", () => {
    const largest = readVariableByteInteger(Uint8Array.from([0xff, 0xff, 0xff, 0x7f]), 0);
    expect(largest).toEqual({ value: MQTT_MAX_REMAINING_LENGTH, size: 4 });
  });

  test("a fifth continuation byte is malformed rather than a larger number", () => {
    expect(readVariableByteInteger(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x7f]), 0)).toBe("malformed");
  });
});
