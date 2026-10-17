import { describe, expect, test } from "bun:test";

import {
  BerError,
  readChildren,
  readField,
  writeInteger,
  writeLength,
  writeOctetString,
  writeOid,
  writeSequence,
} from "@/lib/db/providers/network/snmp/ber";
import { decodeResponse, encodeRequest } from "@/lib/db/providers/network/snmp/message";
import { PDU_GET } from "@/lib/db/providers/network/snmp/valve";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * BER is the one place in this provider where the same bytes mean two different things depending
 * on where they sit. `msgSecurityParameters` IS a BER structure inside an OCTET STRING, and this
 * provider opens it on purpose. An agent's string value is also just bytes inside an OCTET
 * STRING, and opening THAT would be reading a user's data as structure. The difference is not in
 * the bytes; it is in which field the reader is looking at.
 *
 * So a test that uses "hello" as a string value proves nothing about the distinction: it could
 * not be mistaken for a structure. These use a value whose bytes are a perfectly good TLV.
 */
describe("a value that looks like a structure stays a value", () => {
  /** `30 03 02 01 05`: a valid SEQUENCE holding INTEGER 5, used here as a string's content. */
  const LOOKS_LIKE_TLV = Uint8Array.of(0x30, 0x03, 0x02, 0x01, 0x05);

  test("the bytes really are a valid structure, so the test is testing something", () => {
    const field = readField(LOOKS_LIKE_TLV, 0);
    expect(field.tag).toBe(0x30);
    expect(readChildren(LOOKS_LIKE_TLV, field)).toHaveLength(1);
  });

  test("a varbind value carrying them is handed back as bytes, not opened", () => {
    const datagram = writeSequence([
      writeInteger(1),
      writeOctetString(new TextEncoder().encode("public")),
      writeSequence(
        [
          writeInteger(7),
          writeInteger(0),
          writeInteger(0),
          writeSequence([writeSequence([writeOid([1, 3, 6, 1, 2, 1, 1, 1, 0]), writeOctetString(LOOKS_LIKE_TLV)])]),
        ],
        0xa2,
      ),
    ]);
    const response = decodeResponse(datagram);
    expect(response.varbinds).toHaveLength(1);
    expect(hex(response.varbinds[0].value)).toBe(hex(LOOKS_LIKE_TLV));
  });

  test("a community whose bytes are a structure is read as that string, not descended into", () => {
    const weird = String.fromCharCode(...LOOKS_LIKE_TLV);
    const request = encodeRequest(PDU_GET, { community: weird, requestId: 1, oids: [[1, 3, 6, 1]] });
    const parts = readChildren(request, readField(request, 0));
    expect(hex(request.slice(parts[1].start, parts[1].end))).toBe(hex(LOOKS_LIKE_TLV));
  });
});

/**
 * Lengths. One byte up to 127, then a count byte and that many octets, and this provider reads at
 * most four of them. Every case here is at a boundary rather than near one.
 */
describe("the length field at each of its boundaries", () => {
  const roundTrip = (size: number) => {
    const body = new Uint8Array(size).fill(0x41);
    const encoded = writeOctetString(body);
    const field = readField(encoded, 0);
    return { encoded, read: encoded.slice(field.start, field.end) };
  };

  test("127 bytes is still a single length octet and 128 is not", () => {
    expect(roundTrip(127).encoded[1]).toBe(127);
    expect(roundTrip(128).encoded[1]).toBe(0x81);
    expect(roundTrip(128).encoded[2]).toBe(128);
  });

  test("255 fits one extra octet and 256 needs two", () => {
    expect(roundTrip(255).encoded[1]).toBe(0x81);
    expect(roundTrip(256).encoded[1]).toBe(0x82);
    expect(roundTrip(256).encoded.slice(2, 4)).toEqual(Uint8Array.of(0x01, 0x00));
  });

  test("each of those sizes survives the round trip whole", () => {
    for (const size of [0, 1, 127, 128, 255, 256, 65535, 65536]) {
      expect(roundTrip(size).read.length).toBe(size);
    }
  });

  test("a length of more than four octets is refused rather than read", () => {
    const absurd = Uint8Array.of(0x04, 0x85, 1, 1, 1, 1, 1, 0, 0);
    expect(() => readField(absurd, 0)).toThrow(BerError);
  });

  test("the indefinite form is refused by name, because SNMP never uses it", () => {
    expect(() => readField(Uint8Array.of(0x30, 0x80, 0x00, 0x00), 0)).toThrow(BerError);
  });
});

/**
 * A declared length that does not match the body, in both directions. These are the two shapes a
 * truncated or padded datagram arrives in, and they are different failures: one runs off the end
 * of the buffer, the other leaves bytes nobody claims.
 */
describe("a declared length that disagrees with the body", () => {
  const good = writeSequence([writeInteger(1), writeInteger(2)]);

  test("the sound message this is built from parses, so the failures below are the change", () => {
    expect(readChildren(good, readField(good, 0))).toHaveLength(2);
  });

  test("a length longer than the bytes present is refused, not read off the end", () => {
    const tooLong = Uint8Array.from(good);
    tooLong[1] = tooLong[1] + 4;
    expect(() => readField(tooLong, 0)).toThrow(BerError);
  });

  test("a child claiming more than its parent holds is refused", () => {
    const overrun = Uint8Array.from(good);
    overrun[3] = 9;
    expect(() => readChildren(overrun, readField(overrun, 0))).toThrow(BerError);
  });

  test("a length shorter than the bytes present leaves a trailing field, which is read as one", () => {
    // Shortening the OUTER length hides the second INTEGER. The reader must not silently treat
    // the hidden bytes as part of anything: the parent simply ends early and reports one child.
    const tooShort = Uint8Array.from(good);
    tooShort[1] = 3;
    expect(readChildren(tooShort, readField(tooShort, 0))).toHaveLength(1);
  });

  test("a truncated datagram fails rather than returning a short answer", () => {
    const full = encodeRequest(PDU_GET, { community: "public", requestId: 1, oids: [[1, 3, 6, 1]] });
    for (const cut of [1, 5, full.length - 1]) {
      expect(() => decodeResponse(full.slice(0, cut))).toThrow();
    }
  });
});

/**
 * The two refusals in the length writer that no call site can reach.
 *
 * Every caller passes a buffer's `length`, so neither can fire in this provider as it stands.
 * Measured: with only the round-trip tests above, removing either refusal left the whole suite
 * green. They are reached here directly, because a guard nothing can bind is a comment that
 * looks like code.
 */
describe("the length writer's own rules", () => {
  test("a negative length is refused rather than encoded as something", () => {
    expect(() => writeLength(-1)).toThrow(BerError);
    expect(() => writeLength(0)).not.toThrow();
  });

  test("a length needing a fifth octet is refused, at the value itself", () => {
    expect(() => writeLength(0xffffffff)).not.toThrow();
    expect(() => writeLength(0x100000000)).toThrow(BerError);
  });

  test("the four octet ceiling is the same one the reader enforces", () => {
    expect(writeLength(0xffffffff)[0]).toBe(0x84);
    expect(writeLength(0xffffffff)).toHaveLength(5);
  });
});
