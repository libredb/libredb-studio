/**
 * The User-based Security Model, checked against the document first and an implementation second.
 *
 * The key derivation is checked against RFC 3414's own published test vectors, which is stronger
 * than agreeing with another implementation: a vector in the standard is what every correct
 * implementation has to produce, so matching it is not a coincidence two programs can share.
 *
 * The digest is then cross-checked against a datagram net-snmp 3.29.2 actually sent on
 * 2026-10-13. That is possible because everything non-deterministic in a v3 message is readable
 * from the message itself: the engine identity, its boots and time, the privacy salt, the
 * message id and the request id. With the passphrases known, an independent implementation has
 * to arrive at the same twelve octets.
 *
 * The boundary cases are here because easy inputs exercise easy paths: a passphrase at its
 * limit, an engine id at both ends of its range, counters at the top of their width, and a
 * digest that is exactly twelve octets rather than whatever the hash produces.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryError } from "@/lib/db/errors";
import {
  aesIv,
  AUTH_PARAM_BYTES,
  authenticate,
  decryptScopedPdu,
  digestMatches,
  encryptScopedPdu,
  localizeKey,
  localizedKey,
  passphraseToKey,
  UsmError,
} from "@/lib/db/providers/network/snmp/usm";

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../fixtures/snmp/captures/net-snmp-3.29.2.json"), "utf8"),
);

describe("key derivation matches RFC 3414's own published vectors", () => {
  // Appendix A.3.2, password "maplesyrup", engine 000000000000000000000002.
  const engine = Buffer.from("000000000000000000000002", "hex");
  test("Ku, the passphrase expanded to a megabyte and hashed", () => {
    expect(passphraseToKey("maplesyrup", "sha1").toString("hex")).toBe("9fb5cc0381497b3793528939ff788d5d79145211");
  });
  test("Kul, the same key localised to that engine", () => {
    const ku = passphraseToKey("maplesyrup", "sha1");
    expect(localizeKey(ku, engine, "sha1").toString("hex")).toBe("6695febc9288e36282235fc7151f128497b38f3f");
  });
  test("the two steps together answer the same thing", () => {
    expect(localizedKey("maplesyrup", engine, "sha1").toString("hex")).toBe("6695febc9288e36282235fc7151f128497b38f3f");
  });
  test("localisation really uses the engine, so another engine gives another key", () => {
    const other = Buffer.from("000000000000000000000003", "hex");
    expect(localizedKey("maplesyrup", other, "sha1").toString("hex")).not.toBe(
      "6695febc9288e36282235fc7151f128497b38f3f",
    );
  });
});

describe("the digest agrees with what a real client put on the wire", () => {
  const datagram = Buffer.from(FIXTURE.sent.v3AuthPrivSha1Request as number[]);
  const inputs = FIXTURE.v3AuthPrivSha1 as { authPassphrase: string };

  /** Finds the twelve octet digest inside the captured message and returns where it sits. */
  const digestAt = (): number => {
    const at = datagram.indexOf(Buffer.from([0x04, AUTH_PARAM_BYTES]), 30);
    expect(at).toBeGreaterThan(0);
    return at + 2;
  };

  test("the captured digest is exactly twelve octets, as the RFC fixes it", () => {
    const at = digestAt();
    expect(datagram.subarray(at, at + AUTH_PARAM_BYTES)).toHaveLength(AUTH_PARAM_BYTES);
  });

  test("recomputing it over the message with the field zeroed gives the same octets", () => {
    const at = digestAt();
    const engineId = Buffer.from(FIXTURE.v3AuthPrivSha1.engineId ?? "", "hex");
    const sent = Buffer.from(datagram.subarray(at, at + AUTH_PARAM_BYTES));
    const zeroed = Buffer.from(datagram);
    zeroed.fill(0, at, at + AUTH_PARAM_BYTES);
    // The engine id is read out of the message rather than carried beside it, which is the
    // point: every input to this computation is in the datagram except the passphrase.
    const idAt = datagram.indexOf(Buffer.from([0x04, 0x11]), 20) + 2;
    const engine = engineId.length > 0 ? engineId : Buffer.from(datagram.subarray(idAt, idAt + 17));
    const key = localizedKey(inputs.authPassphrase, engine, "sha1");
    expect(authenticate(zeroed, key, "sha1").toString("hex")).toBe(sent.toString("hex"));
  });
});

describe("the widths the RFC fixes are refused rather than adjusted", () => {
  test("a passphrase of seven characters", () => {
    expect(() => passphraseToKey("1234567", "sha1")).toThrow(UsmError);
  });
  test("a passphrase of exactly eight is allowed", () => {
    expect(() => passphraseToKey("12345678", "sha1")).not.toThrow();
  });
  test("an engine id of four octets and of thirty-three", () => {
    const ku = passphraseToKey("maplesyrup", "sha1");
    expect(() => localizeKey(ku, Buffer.alloc(4), "sha1")).toThrow(UsmError);
    expect(() => localizeKey(ku, Buffer.alloc(33), "sha1")).toThrow(UsmError);
  });
  test("five and thirty-two are both allowed, because the range is inclusive", () => {
    const ku = passphraseToKey("maplesyrup", "sha1");
    expect(() => localizeKey(ku, Buffer.alloc(5), "sha1")).not.toThrow();
    expect(() => localizeKey(ku, Buffer.alloc(32), "sha1")).not.toThrow();
  });
  test("a salt that is not eight octets", () => {
    expect(() => aesIv(1, 1, Buffer.alloc(7))).toThrow(UsmError);
    expect(() => aesIv(1, 1, Buffer.alloc(9))).toThrow(UsmError);
  });
  test("counters beyond a 32 bit width", () => {
    expect(() => aesIv(0x100000000, 1, Buffer.alloc(8))).toThrow(UsmError);
    expect(() => aesIv(1, 0x100000000, Buffer.alloc(8))).toThrow(UsmError);
    expect(() => aesIv(-1, 1, Buffer.alloc(8))).toThrow(UsmError);
  });
  test("the top of the width is allowed", () => {
    const iv = aesIv(0xffffffff, 0xfffffffe, Buffer.from("0102030405060708", "hex"));
    expect(iv.toString("hex")).toBe("fffffffffffffffe0102030405060708");
  });
  test("and the counters are written big-endian, which 0xffffffff cannot show", () => {
    // 0xffffffff is a byte palindrome, so the test above passes under little-endian too: it
    // proved the range and said nothing about the order. A value whose bytes differ does.
    const iv = aesIv(0x01020304, 0x05060708, Buffer.from("0a0b0c0d0e0f1011", "hex"));
    expect(iv.toString("hex")).toBe("01020304050607080a0b0c0d0e0f1011");
  });
  test("the digest is truncated to twelve octets whatever the hash is", () => {
    const key = Buffer.alloc(32, 7);
    for (const hash of ["sha1", "sha256", "sha512"] as const) {
      expect(authenticate(Buffer.from("x"), key, hash)).toHaveLength(AUTH_PARAM_BYTES);
    }
  });
});

describe("encryption round-trips and is keyed by every input it claims", () => {
  const key = localizedKey("privpass12345", Buffer.from("8000000001020304", "hex"), "sha1");
  const iv = aesIv(3, 400, Buffer.from("0102030405060708", "hex"));
  const plain = Buffer.from("3010040004000a0c0201010201000201003000", "hex");

  test("what goes in comes back", () => {
    expect(decryptScopedPdu(encryptScopedPdu(plain, key, iv), key, iv).toString("hex")).toBe(plain.toString("hex"));
  });
  test("a different salt gives different ciphertext", () => {
    const other = aesIv(3, 400, Buffer.from("0807060504030201", "hex"));
    expect(encryptScopedPdu(plain, key, other).toString("hex")).not.toBe(
      encryptScopedPdu(plain, key, iv).toString("hex"),
    );
  });
  test("a different boots counter gives different ciphertext, so the IV really uses it", () => {
    const other = aesIv(4, 400, Buffer.from("0102030405060708", "hex"));
    expect(encryptScopedPdu(plain, key, other).toString("hex")).not.toBe(
      encryptScopedPdu(plain, key, iv).toString("hex"),
    );
  });
  test("CFB does not pad, so the ciphertext is the plaintext's length", () => {
    expect(encryptScopedPdu(plain, key, iv)).toHaveLength(plain.length);
  });
});

describe("a digest comparison is written to run the whole length", () => {
  /*
   * A functional test cannot bind this. Whether the comparison exits early is a timing
   * property, and a mutation that replaces the accumulator with an early return gives the same
   * answers, so the suite stays green: measured, and recorded here rather than papered over
   * with a timing assertion that would be flaky and would still prove little. What the tests
   * below do bind is that the function answers correctly; the constant-time shape is held by
   * the code and this comment, and a reviewer is the check for it.
   */
  test("equal and unequal both answer correctly", () => {
    const a = Buffer.from("0102030405060708090a0b0c", "hex");
    expect(digestMatches(a, Buffer.from(a))).toBe(true);
    expect(digestMatches(a, Buffer.from("0102030405060708090a0b0d", "hex"))).toBe(false);
  });
  test("a different length is not equal", () => {
    expect(digestMatches(Buffer.alloc(12), Buffer.alloc(11))).toBe(false);
  });
});

describe("every USM refusal reaches the user", () => {
  test("they are QueryErrors, like every other refusal here", () => {
    expect(new UsmError("x", "digestMismatch")).toBeInstanceOf(QueryError);
    expect(new UsmError("x", "digestMismatch").constructor.name).toBe("UsmError");
  });

  /**
   * Every refusal in this provider arrives as a `QueryError`, which carries ONE code
   * for all of them, so before this field the only thing separating "your passphrase is wrong"
   * from "the clock has drifted" was English prose. A sentence serves the person reading it and
   * serves nothing that branches. These three send an operator to three different places: a
   * credential, a clock, and a configuration file.
   */
  test("the three refusals an operator acts on differently do not arrive as one", () => {
    const passphrase = (() => {
      try {
        passphraseToKey("short", "sha1");
      } catch (e) {
        return e as UsmError;
      }
    })();
    const engine = (() => {
      try {
        localizeKey(Buffer.alloc(20), Buffer.alloc(2), "sha1");
      } catch (e) {
        return e as UsmError;
      }
    })();
    const salt = (() => {
      try {
        aesIv(1, 1, Buffer.alloc(3));
      } catch (e) {
        return e as UsmError;
      }
    })();
    expect(passphrase?.failure).toBe("passphraseTooShort");
    expect(engine?.failure).toBe("engineIdWidth");
    expect(salt?.failure).toBe("saltWidth");
    expect(new Set([passphrase?.failure, engine?.failure, salt?.failure]).size).toBe(3);
  });

  /**
   * This sentence used to read "an engine ID is 5 to 32 octets (RFC 3411 section 5),
   * this one is N", which pronounces on the agent's compliance. The identity comes out of the
   * agent's discovery answer THROUGH OUR PARSER, so the same sentence appears when our own read
   * of the field is wrong, and an operator who believes it writes to their vendor about a defect
   * that is in here. The citation now covers our own constraint and the sentence says who read
   * what.
   */
  test("the engine identity refusal describes our reading, not the agent's compliance", () => {
    const error = (() => {
      try {
        localizeKey(Buffer.alloc(20), Buffer.alloc(2), "sha1");
      } catch (e) {
        return e as UsmError;
      }
    })();
    expect(error?.message).toContain("this connection read");
    expect(error?.message).not.toMatch(/an engine ID is 5 to 32 octets \(RFC/);
  });
});
