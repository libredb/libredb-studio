/**
 * The one-way valve, against datagrams the real client produced (SN-S1).
 *
 * The buffers below were captured on 13 October 2026 from `net-snmp` 3.29.2 talking to that
 * library's own in-process agent on loopback, under Bun 1.4.2, by supplying a `dgramModule`
 * that recorded what was handed to the socket. They are replayed here rather than regenerated,
 * because the client is not a dependency of this package yet and because a captured message is
 * a fixed fact: a test that builds its own message tests the builder as well as the valve.
 *
 * The negative cases matter more than the positive ones. Two of them are real write paths, a
 * SetRequest and an SNMPv1 Get, produced by asking the client to send them; the valve has to
 * refuse both. The malformed cases include one, a valid v2c Get wrapped in a SET OF rather than
 * a SEQUENCE, that exists because a mutation run showed the outer tag check was not bound: every
 * other malformed input was being refused by a later check, so the suite stayed green when the
 * outer check was deleted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  inspectOutbound,
  ValveRefusal,
  PDU_GET,
  PDU_GET_NEXT,
  PDU_GET_BULK,
} from "@/lib/db/providers/network/snmp/valve";
import { readChildren, readField } from "@/lib/db/providers/network/snmp/ber";

/**
 * Captured from net-snmp 3.29.2 on 13 October 2026; the file carries its own provenance, and it
 * lives under `tests/fixtures/` rather than beside this test because that is where the house
 * keeps captured wire data and because `tests/unit/db/` holds test files only.
 */
const CAPTURED: Record<string, number[]> = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../fixtures/snmp/captures/net-snmp-3.29.2.json"), "utf8"),
).sent;

const bytes = (octets: number[]): Uint8Array => new Uint8Array(octets);

describe("a message whose version field is not one this process writes", () => {
  test("a first field that is not an INTEGER is refused as no version", () => {
    // SEQUENCE { OCTET STRING 01, OCTET STRING "", GetRequest {} }
    const run = () => inspectOutbound(bytes([0x30, 0x07, 0x04, 0x01, 0x01, 0x04, 0x00, 0xa0, 0x00]));
    expect(run).toThrow(ValveRefusal);
    expect(run).toThrow("refused an outgoing message whose first field is not the version");
  });

  test("a version two octets wide is refused rather than read from its first octet", () => {
    // INTEGER 0x0001 is version 1 (v2c) written wide; read by its first octet it would be v1.
    const wide = bytes([0x30, 0x08, 0x02, 0x02, 0x00, 0x01, 0x04, 0x00, 0xa0, 0x00]);
    expect(() => inspectOutbound(wide)).toThrow("refused an outgoing message with a wide version field");
  });

  test("an SNMPv3 msgData that is neither an encrypted PDU nor a scoped PDU is refused by its tag", () => {
    // SEQUENCE { INTEGER 3, SEQUENCE {}, OCTET STRING "", INTEGER 0 }
    const v3 = bytes([0x30, 0x0a, 0x02, 0x01, 0x03, 0x30, 0x00, 0x04, 0x00, 0x02, 0x01, 0x00]);
    expect(() => inspectOutbound(v3)).toThrow("refused an SNMPv3 message whose msgData tag is 0x2");
  });
});

describe("the valve reads the PDU type where the datagram carries it", () => {
  test("a v2c Get is allowed and named", () => {
    expect(inspectOutbound(bytes(CAPTURED.v2cGet))).toEqual({ kind: "allowed", pduType: PDU_GET });
  });
  test("a v2c GetNext is allowed and named", () => {
    expect(inspectOutbound(bytes(CAPTURED.v2cGetNext))).toEqual({ kind: "allowed", pduType: PDU_GET_NEXT });
  });
  test("a v2c GetBulk is allowed and named", () => {
    expect(inspectOutbound(bytes(CAPTURED.v2cGetBulk))).toEqual({ kind: "allowed", pduType: PDU_GET_BULK });
  });
  test("a v3 authNoPriv discovery is readable", () => {
    expect(inspectOutbound(bytes(CAPTURED.v3AuthNoPrivDiscovery))).toEqual({ kind: "allowed", pduType: PDU_GET });
  });
  test("a v3 authNoPriv authenticated request is readable", () => {
    expect(inspectOutbound(bytes(CAPTURED.v3AuthNoPrivRequest))).toEqual({ kind: "allowed", pduType: PDU_GET });
  });
  test("a v3 authPriv DISCOVERY is readable, because discovery is sent at noAuthNoPriv", () => {
    expect(inspectOutbound(bytes(CAPTURED.v3AuthPrivDiscovery))).toEqual({ kind: "allowed", pduType: PDU_GET });
  });
});

describe("the valve says so when the datagram does not carry the type", () => {
  test("a v3 authPriv authenticated request is opaque, not guessed at", () => {
    const verdict = inspectOutbound(bytes(CAPTURED.v3AuthPrivRequest));
    expect(verdict.kind).toBe("opaque");
  });
});

describe("the valve refuses what it can read and does not like", () => {
  test("a real SetRequest the client produced", () => {
    expect(() => inspectOutbound(bytes(CAPTURED.v2cSet))).toThrow(ValveRefusal);
  });
  test("a real SNMPv1 Get the client produced", () => {
    expect(() => inspectOutbound(bytes(CAPTURED.v1Get))).toThrow(ValveRefusal);
  });
});

describe("the valve refuses what it cannot parse", () => {
  const malformed: ReadonlyArray<readonly [string, Uint8Array]> = [
    ["an empty datagram", new Uint8Array(0)],
    ["an outer field that is not a SEQUENCE", new Uint8Array([0x04, 0x02, 0x01, 0x02])],
    ["a length that runs past the buffer", new Uint8Array([0x30, 0x7f, 0x02, 0x01, 0x01])],
    ["an indefinite length", new Uint8Array([0x30, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00])],
    // Only the outer tag check catches this one: the content is a valid v2c Get.
    [
      "a valid Get wrapped in a SET OF",
      new Uint8Array([0x31, 0x0e, 0x02, 0x01, 0x01, 0x04, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63, 0xa0, 0x01, 0x00]),
    ],
  ];
  for (const [what, datagram] of malformed) {
    test(what, () => {
      expect(() => inspectOutbound(datagram)).toThrow(ValveRefusal);
    });
  }
});

/**
 * A v1 datagram is refused, and so is a datagram carrying any
 * version this provider does not speak, so "it throws" cannot tell the two apart. Measured:
 * moving `VERSION_V1` off zero left the captured v1 datagram still refused, just by the
 * catch-all at the end of the dispatch, and nothing turned red.
 *
 * That difference is not cosmetic. A v1 message on this socket means something in here built one,
 * which is a defect in this provider; a version of 7 means something built nonsense. They send a
 * reader to two different places, so they may not arrive as one sentence.
 */
describe("version zero is refused as v1 and not as an unknown version", () => {
  /** The captured v1 request with its version octet replaced, so only that byte differs. */
  const withVersion = (value: number) => {
    const datagram = bytes(CAPTURED.v1Get);
    const fields = readChildren(datagram, readField(datagram, 0));
    const copy = Uint8Array.from(datagram);
    copy[fields[0].start] = value;
    return copy;
  };

  const refusalFor = (datagram: Uint8Array) => {
    try {
      inspectOutbound(datagram);
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected a refusal");
  };

  test("both are refused, which is why the sentences have to differ", () => {
    expect(() => inspectOutbound(withVersion(0))).toThrow(ValveRefusal);
    expect(() => inspectOutbound(withVersion(7))).toThrow(ValveRefusal);
  });

  test("the v1 refusal names v1 and the unknown one names the number it saw", () => {
    expect(refusalFor(withVersion(0)).message).toContain("SNMPv1");
    expect(refusalFor(withVersion(7)).message).toContain("version 7");
    expect(refusalFor(withVersion(0)).message).not.toBe(refusalFor(withVersion(7)).message);
  });

  test("the version this provider does speak is not refused at all", () => {
    expect(() => inspectOutbound(bytes(CAPTURED.v2cGet))).not.toThrow();
  });
});

/**
 * THE REFUSAL SENTENCES THAT HAD NO CASE.
 *
 * The valve names what it refused, and the name is what a reader sees. Until these cases existed
 * only the SetRequest arm had ever been read; the other three were written and never run, which
 * is the state where a wrong name costs nothing to keep.
 *
 * The datagrams are the captured SetRequest with one byte changed, the PDU tag itself, because
 * that is the only byte the valve reads to decide. Building a whole Inform by hand would be
 * writing a message no agent sent to test a branch that only looks at one octet.
 */
describe("the PDU types the valve names when it refuses them", () => {
  const withPduTag = (tag: number): Uint8Array => {
    const octets = [...CAPTURED.v2cSet];
    const at = octets.lastIndexOf(0xa3);
    expect(at, "the captured SetRequest should carry a 0xa3 PDU tag").toBeGreaterThan(0);
    octets[at] = tag;
    return new Uint8Array(octets);
  };

  test("an InformRequest is refused by its own name", () => {
    expect(() => inspectOutbound(withPduTag(0xa6))).toThrow(/an InformRequest/);
  });

  test("a Trap is refused by its own name", () => {
    expect(() => inspectOutbound(withPduTag(0xa7))).toThrow(/a Trap/);
  });

  test("a Response is refused by its own name", () => {
    // A Response is what an agent sends, so one leaving this socket means something built an
    // answer rather than a question. It is refused with the same sentence shape as the rest.
    expect(() => inspectOutbound(withPduTag(0xa2))).toThrow(/a Response/);
  });

  test("a PDU type with no name of its own is refused by its number", () => {
    expect(() => inspectOutbound(withPduTag(0xa9))).toThrow(/PDU type 0xa9/);
  });
});

describe("the datagrams the valve cannot read at all", () => {
  test("bytes that are not a BER message are refused as unparseable", () => {
    // Not "refused a Set" and not "allowed": a message this process cannot read is one it cannot
    // vouch for, and the sentence says which of the two it is.
    expect(() => inspectOutbound(bytes([0xff, 0xff, 0xff]))).toThrow(ValveRefusal);
    expect(() => inspectOutbound(bytes([0xff, 0xff, 0xff]))).toThrow(/cannot parse/);
  });

  test("a SEQUENCE whose children run past its own length is refused the same way", () => {
    // The outer tag reads, the children do not. Both arms of that pair end in the same refusal,
    // and until now only the first had a case.
    expect(() => inspectOutbound(bytes([0x30, 0x04, 0x02, 0x7f, 0x02, 0x01]))).toThrow(/cannot parse/);
  });
});

describe("a v3 message whose scoped PDU cannot be read", () => {
  test("is refused as an unparseable scoped PDU, not as a refused PDU type", () => {
    /*
     * The outer message reads, the msgData tag is a SEQUENCE, and the children inside it do not
     * parse. That is a different sentence from "refused a SetRequest": the valve has not seen a
     * PDU type at all, and saying which of the two happened is what tells a reader whether the
     * message was refused or merely unreadable.
     *
     * The datagram is the captured authNoPriv request with ONE byte changed - the length of the
     * first field inside msgData, set to a value that runs past the message. Measured here
     * rather than hand-built, because a scoped PDU written from scratch would not be one this
     * client ever produces.
     */
    const octets = Uint8Array.from(CAPTURED.v3AuthNoPrivRequest);
    const msgData = readChildren(octets, readField(octets, 0))[3];
    const corrupted = Uint8Array.from(octets);
    corrupted[msgData.start + 1] = 0x7f;
    expect(() => inspectOutbound(corrupted)).toThrow(ValveRefusal);
    expect(() => inspectOutbound(corrupted)).toThrow(/scoped PDU this process cannot parse/);
  });
});
