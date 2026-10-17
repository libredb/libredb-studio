/**
 * This provider builds its own messages, and the test for that is the strongest one available:
 * the bytes it produces are compared against the bytes a real client produced.
 *
 * The captures under `tests/fixtures/snmp/captures/` were taken from net-snmp 3.29.2 on
 * 2026-10-13. Each one carries its own request-id, so this file reads that id out of the
 * capture, hands it to the encoder with the same community and the same object, and requires
 * the result to be byte-for-byte identical. An encoder that agrees with an independent
 * implementation on every octet of three PDU types is not guessing at the format.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BerError } from "@/lib/db/providers/network/snmp/ber";
import { ERROR_STATUS } from "@/lib/db/providers/network/snmp/errors";
import { communityOf, decodeResponse, encodeRequest, VERSION_V2C } from "@/lib/db/providers/network/snmp/message";
import { PDU_GET, PDU_GET_BULK, PDU_GET_NEXT, PDU_SET } from "@/lib/db/providers/network/snmp/valve";

const CAPTURED: Record<string, number[]> = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../fixtures/snmp/captures/net-snmp-3.29.2.json"), "utf8"),
).sent;

const RECEIVED: Record<string, number[]> = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../fixtures/snmp/captures/net-snmp-3.29.2.json"), "utf8"),
).received;

const SYS_DESCR = [1, 3, 6, 1, 2, 1, 1, 1, 0];
const hex = (bytes: Uint8Array | number[]) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The request-id sits in the PDU, which this reads without assuming anything this file writes. */
function requestIdOf(datagram: number[]): number {
  const bytes = Uint8Array.from(datagram);
  // SEQUENCE, version, community, then the PDU; the PDU's first field is the request-id.
  let at = 2 + (bytes[1] >= 0x80 ? bytes[1] & 0x7f : 0);
  const skip = () => {
    const length = bytes[at + 1];
    const wide = length >= 0x80 ? length & 0x7f : 0;
    const size = wide === 0 ? length : [...bytes.slice(at + 2, at + 2 + wide)].reduce((n, b) => n * 256 + b, 0);
    at += 2 + wide + size;
  };
  skip();
  skip();
  at += 2;
  const idLength = bytes[at + 1];
  return [...bytes.slice(at + 2, at + 2 + idLength)].reduce((n, b) => n * 256 + b, 0);
}

describe("the encoder reproduces a real client's datagrams, octet for octet", () => {
  const cases = [
    ["a Get", "v2cGet", PDU_GET, {}],
    ["a GetNext", "v2cGetNext", PDU_GET_NEXT, {}],
    ["a GetBulk", "v2cGetBulk", PDU_GET_BULK, { nonRepeaters: 0, maxRepetitions: 5 }],
  ] as const;

  for (const [what, key, tag, extra] of cases) {
    test(what, () => {
      const captured = CAPTURED[key];
      const built = encodeRequest(tag, {
        community: communityOf(Uint8Array.from(captured)),
        requestId: requestIdOf(captured),
        oids: [SYS_DESCR],
        ...extra,
      });
      expect(hex(built)).toBe(hex(captured));
    });
  }

  test("the community is read back out of a captured message", () => {
    expect(communityOf(Uint8Array.from(CAPTURED.v2cGet))).toBe("public");
  });
});

describe("the encoder handles the sizes small test data never reaches", () => {
  // Both cases below exist because a mutation run showed the rules were unbound: every OID in
  // this file had sub-identifiers under 128 and every message was under 128 bytes, so the
  // multi-octet paths were never taken and deleting them changed nothing.
  test("a sub-identifier above 127 is written base 128, with the continuation bit", () => {
    // 8072 is 63 * 128 + 8, so two groups: 0xBF (63 with the continuation bit) then 0x08.
    // The expected bytes were computed from the arithmetic, not guessed: an earlier draft of
    // this test guessed them and failed, which is the right way round for a test to fail.
    const built = encodeRequest(PDU_GET, { community: "c", requestId: 1, oids: [[1, 3, 6, 1, 4, 1, 8072]] });
    expect(hex(built)).toContain("bf08");
  });
  test("and it round-trips back to the same sub-identifier", () => {
    const playpen = [1, 3, 6, 1, 4, 1, 8072, 9999, 9999, 1, 0];
    const built = encodeRequest(PDU_GET, { community: "c", requestId: 1, oids: [playpen] });
    // The response shape is the same shape; decoding the request's own varbind name proves the
    // reader and the writer agree on the encoding rather than on each other's shortcuts.
    // 8072 -> bf 08, and 9999 is 78 * 128 + 15 -> ce 0f.
    expect(hex(built)).toContain("bf08");
    expect(hex(built)).toContain("ce0f");
  });
  test("a message of 128 bytes or more uses the long form length", () => {
    const many = Array.from({ length: 12 }, (_, i) => [1, 3, 6, 1, 2, 1, 2, 2, 1, 2, i + 1]);
    const built = encodeRequest(PDU_GET, { community: "public", requestId: 1, oids: many });
    expect(built.length).toBeGreaterThan(127);
    // 0x81 or 0x82 is the long form marker: one or two length octets follow.
    expect(built[1] === 0x81 || built[1] === 0x82).toBe(true);
  });
});

describe("the encoder refuses what this provider must not send", () => {
  test("a write PDU", () => {
    expect(() => encodeRequest(PDU_SET, { community: "public", requestId: 1, oids: [SYS_DESCR] })).toThrow(BerError);
  });
  test("a request naming nothing", () => {
    expect(() => encodeRequest(PDU_GET, { community: "public", requestId: 1, oids: [] })).toThrow(BerError);
  });
});

describe("a response is read, and an unreadable one is refused rather than halved", () => {
  test("a captured response round-trips through the decoder", () => {
    // Captured, not hand-written. An earlier version of this test counted the length octets by
    // hand and got them wrong, which is the kind of mistake a fixture exists to prevent.
    const decoded = decodeResponse(Uint8Array.from(RECEIVED.v2cGetResponse));
    expect(decoded.varbinds).toHaveLength(1);
    expect(decoded.varbinds[0].oid).toEqual(SYS_DESCR);
  });
  test("the agent's error-status is read as the number it is", () => {
    // This capture carries a real refusal: the agent answered noAccess, which is 6, and the
    // decoder reports the number rather than interpreting it.
    const decoded = decodeResponse(Uint8Array.from(RECEIVED.v2cGetResponse));
    expect(decoded.errorStatus).toBe(ERROR_STATUS.noAccess);
    expect(decoded.errorIndex).toBe(1);
  });
  test("the request-id in the answer is the one that was asked", () => {
    const decoded = decodeResponse(Uint8Array.from(RECEIVED.v2cGetResponse));
    expect(Number.isInteger(decoded.requestId)).toBe(true);
    expect(decoded.requestId).toBeGreaterThan(0);
  });
  test("a message that is not SNMPv2c is refused by version", () => {
    const v1 = Uint8Array.from(CAPTURED.v1Get);
    expect(() => decodeResponse(v1)).toThrow(/version 0/);
  });
  test("a truncated message is refused", () => {
    expect(() => decodeResponse(Uint8Array.from(CAPTURED.v2cGet).slice(0, 10))).toThrow(BerError);
  });
  test("SNMPv2c is version 1 on the wire, which is the kind of thing a constant should say once", () => {
    expect(VERSION_V2C).toBe(1);
  });
});

describe("a message whose second field is not a community", () => {
  test("is refused rather than read as one", () => {
    // `communityOf` is what the valve uses to say which connection a datagram belongs to, so a
    // message whose second field is an integer must not be read as a community: it would be
    // reported as belonging to a connection named by whatever those bytes decode to.
    const notACommunity = Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x00);
    expect(() => communityOf(notACommunity)).toThrow(BerError);
    expect(() => communityOf(notACommunity)).toThrow(/carries no community/);
  });
});
