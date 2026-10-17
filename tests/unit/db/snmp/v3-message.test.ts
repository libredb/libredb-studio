import { describe, expect, test } from "bun:test";

import {
  BerError,
  readChildren,
  readField,
  writeInteger,
  writeOctetString,
  writeOid,
  writeSequence,
} from "@/lib/db/providers/network/snmp/ber";
import { QueryError } from "@/lib/db/errors";
import { decodeResponse, encodeEmptyGetPdu, encodePdu } from "@/lib/db/providers/network/snmp/message";
import { USM_REPORT_OIDS } from "@/lib/db/providers/network/snmp/errors";
import { PDU_GET } from "@/lib/db/providers/network/snmp/valve";
import {
  AUTH_PARAM_BYTES,
  SALT_BYTES,
  UsmError,
  aesIv,
  authenticate,
  decryptScopedPdu,
  localizedKey,
} from "@/lib/db/providers/network/snmp/usm";
import {
  FLAG_AUTH,
  FLAG_PRIV,
  FLAG_REPORTABLE,
  MAX_MESSAGE_SIZE,
  SECURITY_MODEL_USM,
  VERSION_V3,
  encodeAuthenticatedV3Message,
  encodeDiscovery,
  encodeEncryptedV3Message,
  encodeScopedPdu,
  encodeUsmParameters,
  encodeV3Message,
  flagsFor,
  readDiscovery,
  readAuthenticatedAnswer,
  readUsmParameters,
} from "@/lib/db/providers/network/snmp/v3-message";

import capture from "@/../tests/fixtures/snmp/captures/net-snmp-3.29.2.json";

const DISCOVERY = Uint8Array.from(capture.sent.v3AuthPrivDiscovery);
const AUTH_PRIV = Uint8Array.from(capture.sent.v3AuthPrivSha1Request);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** Wraps bytes the way `msgSecurityParameters` is wrapped, so a malformed block can be posted. */
function encodeOctetStringOf(inner: Uint8Array): Uint8Array {
  return writeOctetString(inner);
}

/** A four-field v3 envelope around a given security block, built field by field on purpose. */
function messageAround(securityParameters: Uint8Array): Uint8Array {
  return writeSequence([
    writeInteger(VERSION_V3),
    writeSequence([
      writeInteger(1),
      writeInteger(MAX_MESSAGE_SIZE),
      writeOctetString(Uint8Array.of(0)),
      writeInteger(SECURITY_MODEL_USM),
    ]),
    securityParameters,
    encodeEmptyGetPdu(1),
  ]);
}

/**
 * Everything the reproduction needs that the capture does not spell out, read back from the
 * datagram itself rather than written down here: a comparison against a captured
 * datagram counts only when every input is the captured one; a number typed in from memory
 * turns a reproduction into a coincidence.
 */
function inputsFromCapture(datagram: Uint8Array) {
  const fields = readChildren(datagram, readField(datagram, 0));
  const global = readChildren(datagram, fields[1]);
  const number = (f: { start: number; end: number }) =>
    [...datagram.slice(f.start, f.end)].reduce((n, b) => n * 256 + b, 0);
  return {
    messageId: number(global[0]),
    maxSize: number(global[1]),
    flags: datagram[global[2].start],
    model: number(global[3]),
    usm: readUsmParameters(datagram),
  };
}

describe("message flags", () => {
  /**
   * Each level and each reportable bit is asserted against its own number. A table that
   * computes the expectation the way `flagsFor` computes it would pass whatever `flagsFor`
   * did: a table built that way restates the implementation instead of checking it.
   */
  test("every level and reportable combination has its own octet", () => {
    expect(flagsFor("noAuthNoPriv", false)).toBe(0x00);
    expect(flagsFor("noAuthNoPriv", true)).toBe(0x04);
    expect(flagsFor("authNoPriv", false)).toBe(0x01);
    expect(flagsFor("authNoPriv", true)).toBe(0x05);
    expect(flagsFor("authPriv", false)).toBe(0x03);
    expect(flagsFor("authPriv", true)).toBe(0x07);
  });

  test("the bits are the ones RFC 3412 section 6.4 names", () => {
    expect(FLAG_AUTH).toBe(0x01);
    expect(FLAG_PRIV).toBe(0x02);
    expect(FLAG_REPORTABLE).toBe(0x04);
  });

  test("privacy never travels without authentication", () => {
    for (const reportable of [false, true]) {
      for (const level of ["noAuthNoPriv", "authNoPriv", "authPriv"] as const) {
        const flags = flagsFor(level, reportable);
        if ((flags & FLAG_PRIV) !== 0) expect(flags & FLAG_AUTH).toBe(FLAG_AUTH);
      }
    }
  });
});

describe("what the agent on the wire chose", () => {
  /**
   * These are not restatements of our constants; they are read out of a datagram a real
   * net-snmp wrote, and they are what pins our constants to something outside this file.
   */
  test("the captured discovery names version 3, USM, and 65507 as its largest message", () => {
    const read = inputsFromCapture(DISCOVERY);
    expect(DISCOVERY[4]).toBe(VERSION_V3);
    expect(read.model).toBe(SECURITY_MODEL_USM);
    expect(read.maxSize).toBe(MAX_MESSAGE_SIZE);
  });

  test("the captured discovery is reportable and nothing else", () => {
    expect(inputsFromCapture(DISCOVERY).flags).toBe(FLAG_REPORTABLE);
  });

  test("the captured authPriv request sets all three bits", () => {
    expect(inputsFromCapture(AUTH_PRIV).flags).toBe(FLAG_AUTH | FLAG_PRIV | FLAG_REPORTABLE);
  });

  test("msgMaxSize needs a leading zero octet, which a minimal unsigned writer would drop", () => {
    const global = readChildren(DISCOVERY, readChildren(DISCOVERY, readField(DISCOVERY, 0))[1]);
    expect(hex(DISCOVERY.slice(global[1].start, global[1].end))).toBe("00ffe3");
  });
});

describe("the discovery leg", () => {
  test("it reproduces the captured discovery datagram byte for byte", () => {
    const read = inputsFromCapture(DISCOVERY);
    const scoped = readChildren(DISCOVERY, readChildren(DISCOVERY, readField(DISCOVERY, 0))[3]);
    const pdu = readChildren(DISCOVERY, scoped[2]);
    const requestId = [...DISCOVERY.slice(pdu[0].start, pdu[0].end)].reduce((n, b) => n * 256 + b, 0);
    expect(hex(encodeDiscovery(read.messageId, requestId))).toBe(hex(DISCOVERY));
  });

  test("it names no engine, no user, and no object", () => {
    const usm = readUsmParameters(encodeDiscovery(1, 1));
    expect(usm.engineId.length).toBe(0);
    expect(usm.userName).toBe("");
    expect(usm.authParameters.length).toBe(0);
    expect(usm.privParameters.length).toBe(0);
    expect(usm.engineBoots).toBe(0);
    expect(usm.engineTime).toBe(0);
  });

  test("its scoped PDU carries an empty varbind list", () => {
    const datagram = encodeDiscovery(1, 1);
    const scoped = readChildren(datagram, readChildren(datagram, readField(datagram, 0))[3]);
    expect(scoped[2].tag).toBe(PDU_GET);
    const pdu = readChildren(datagram, scoped[2]);
    expect(pdu[3].end - pdu[3].start).toBe(0);
  });

  test("discovery is not reachable through the request encoder, which still names an object", () => {
    expect(() => encodePdu(PDU_GET, { requestId: 1, oids: [] })).toThrow(BerError);
    expect(() => encodePdu(PDU_GET, { requestId: 1, oids: [] })).toThrow(QueryError);
  });

  test("the empty Get differs from a one-object Get only in its varbind list", () => {
    const empty = encodeEmptyGetPdu(7);
    const one = encodePdu(PDU_GET, { requestId: 7, oids: [[1, 3, 6, 1, 2, 1, 1, 1, 0]] });
    expect(empty.length).toBeLessThan(one.length);
    expect(hex(empty.slice(2, 7))).toBe(hex(one.slice(2, 7)));
  });
});

describe("the USM parameter block", () => {
  const good = {
    engineId: Uint8Array.of(0x80, 0x00, 0x01),
    engineBoots: 1,
    engineTime: 2,
    userName: "u1",
    authParameters: new Uint8Array(12),
    privParameters: new Uint8Array(8),
  };

  /**
   * The assertions name the class and the deciding input, never the sentence. A test that
   * matched on the wording would pass a refusal that fired for the wrong reason as long as the
   * words survived, and would fail an improvement to the wording that changed nothing.
   */
  test("it refuses a digest field that is neither absent nor the full width", () => {
    for (const width of [1, AUTH_PARAM_BYTES - 1, AUTH_PARAM_BYTES + 1, 20]) {
      expect(() => encodeUsmParameters({ ...good, authParameters: new Uint8Array(width) })).toThrow(UsmError);
    }
    expect(() => encodeUsmParameters({ ...good, authParameters: new Uint8Array(AUTH_PARAM_BYTES) })).not.toThrow();
  });

  test("it refuses a salt that is neither absent nor the full width", () => {
    for (const width of [1, SALT_BYTES - 1, SALT_BYTES + 1, 16]) {
      expect(() => encodeUsmParameters({ ...good, privParameters: new Uint8Array(width) })).toThrow(UsmError);
    }
    expect(() => encodeUsmParameters({ ...good, privParameters: new Uint8Array(SALT_BYTES) })).not.toThrow();
  });

  /**
   * These widths can only be wrong because this provider built them wrong, so the refusal must
   * not arrive wearing the class that means "the wire sent rubbish".
   */
  test("a width this provider got wrong is not reported as a problem with the bytes that arrived", () => {
    expect(() => encodeUsmParameters({ ...good, authParameters: new Uint8Array(11) })).not.toThrow(BerError);
    expect(() => encodeUsmParameters({ ...good, authParameters: new Uint8Array(11) })).toThrow(QueryError);
  });

  test("it allows both fields to be absent, which is what noAuthNoPriv sends", () => {
    const encoded = encodeUsmParameters({
      ...good,
      authParameters: new Uint8Array(0),
      privParameters: new Uint8Array(0),
    });
    const read = readUsmParameters(
      encodeV3Message({
        messageId: 1,
        level: "noAuthNoPriv",
        reportable: true,
        usm: { ...good, authParameters: new Uint8Array(0), privParameters: new Uint8Array(0) },
        msgData: encodeEmptyGetPdu(1),
        encrypted: false,
      }),
    );
    expect(encoded.length).toBeGreaterThan(0);
    expect(read.authParameters.length).toBe(0);
  });

  /**
   * The two widths are read out of a datagram a real net-snmp wrote and compared with
   * the constants the encoder uses, so the numbers are pinned to something outside this
   * repository. Every other test here hands the width in, which proves the check runs and
   * proves nothing at all about whether twelve and eight are the right numbers.
   */
  test("the captured request pins the digest and salt widths to the constants the encoder uses", () => {
    const usm = readUsmParameters(AUTH_PRIV);
    expect(usm.authParameters.length).toBe(AUTH_PARAM_BYTES);
    expect(usm.privParameters.length).toBe(SALT_BYTES);
  });

  test("it reads back out of the captured request with the agent's own values", () => {
    const usm = readUsmParameters(AUTH_PRIV);
    expect(hex(usm.engineId)).toBe("8000b98380f4b9e5c60d371fee600810ee");
    expect(usm.userName).toBe(capture.v3AuthPrivSha1.userName);
    expect(usm.authParameters.length).toBe(12);
    expect(usm.privParameters.length).toBe(8);
    expect(usm.engineBoots).toBe(0);
    expect(usm.engineTime).toBe(10);
  });

  test("boots and time are read as their own numbers, not as a shared default", () => {
    const usm = readUsmParameters(AUTH_PRIV);
    expect(usm.engineBoots).not.toBe(usm.engineTime);
  });

  /**
   * The field count is checked for its own sake, not as a side effect of the indexes below
   * happening to be undefined. A block with five fields is a block from some other security
   * model, and reading our sixth field out of it would be reading whatever follows in memory.
   */
  test("it refuses a parameter block that does not hold exactly six fields", () => {
    const short = encodeOctetStringOf(
      writeSequence([
        writeOctetString(Uint8Array.of(1)),
        writeInteger(0),
        writeInteger(0),
        writeOctetString(new Uint8Array(0)),
        writeOctetString(new Uint8Array(0)),
      ]),
    );
    const long = encodeOctetStringOf(
      writeSequence([
        writeOctetString(Uint8Array.of(1)),
        writeInteger(0),
        writeInteger(0),
        writeOctetString(new Uint8Array(0)),
        writeOctetString(new Uint8Array(0)),
        writeOctetString(new Uint8Array(0)),
        writeInteger(9),
      ]),
    );
    expect(() => readUsmParameters(messageAround(short))).toThrow(BerError);
    expect(() => readUsmParameters(messageAround(long))).toThrow(BerError);
  });

  test("it refuses a message whose security parameters are not an OCTET STRING", () => {
    const broken = Uint8Array.from(AUTH_PRIV);
    broken[25] = 0x30;
    expect(() => readUsmParameters(broken)).toThrow(QueryError);
  });
});

describe("the authPriv request, rebuilt from the capture", () => {
  const read = inputsFromCapture(AUTH_PRIV);
  const engineId = Buffer.from(read.usm.engineId);
  const authKey = localizedKey(capture.v3AuthPrivSha1.authPassphrase, engineId, "sha1");
  const privKey = localizedKey(capture.v3AuthPrivSha1.privPassphrase, engineId, "sha1");
  const iv = aesIv(read.usm.engineBoots, read.usm.engineTime, Buffer.from(read.usm.privParameters));
  const dataField = readChildren(AUTH_PRIV, readField(AUTH_PRIV, 0))[3];
  const ciphertext = AUTH_PRIV.slice(dataField.start, dataField.end);
  const scopedPdu = decryptScopedPdu(Buffer.from(ciphertext), privKey, iv);

  test("the captured ciphertext decrypts to a well-formed scoped PDU", () => {
    const field = readField(new Uint8Array(scopedPdu), 0);
    expect(field.tag).toBe(0x30);
    expect(field.end).toBe(scopedPdu.length);
  });

  test("the whole datagram is reproduced byte for byte from the captured inputs", () => {
    const rebuilt = encodeEncryptedV3Message({
      messageId: read.messageId,
      level: "authPriv",
      reportable: true,
      usm: {
        engineId: read.usm.engineId,
        engineBoots: read.usm.engineBoots,
        engineTime: read.usm.engineTime,
        userName: read.usm.userName,
        privParameters: read.usm.privParameters,
      },
      scopedPdu: new Uint8Array(scopedPdu),
      localizedAuthKey: authKey,
      localizedPrivKey: privKey,
      salt: read.usm.privParameters,
      hash: "sha1",
    });
    expect(hex(rebuilt)).toBe(hex(AUTH_PRIV));
  });

  test("the digest we compute is the one net-snmp put on the wire", () => {
    const rebuilt = encodeEncryptedV3Message({
      messageId: read.messageId,
      level: "authPriv",
      reportable: true,
      usm: {
        engineId: read.usm.engineId,
        engineBoots: read.usm.engineBoots,
        engineTime: read.usm.engineTime,
        userName: read.usm.userName,
        privParameters: read.usm.privParameters,
      },
      scopedPdu: new Uint8Array(scopedPdu),
      localizedAuthKey: authKey,
      localizedPrivKey: privKey,
      salt: read.usm.privParameters,
      hash: "sha1",
    });
    expect(hex(readUsmParameters(rebuilt).authParameters)).toBe(hex(read.usm.authParameters));
    expect(hex(read.usm.authParameters)).toBe("fa3f7ccfcc324702c163d6e9");
  });

  test("a different passphrase produces a different digest, so the key is load-bearing", () => {
    const other = localizedKey("authpass12346", engineId, "sha1");
    const rebuilt = encodeAuthenticatedV3Message({
      messageId: read.messageId,
      level: "authPriv",
      reportable: true,
      usm: {
        engineId: read.usm.engineId,
        engineBoots: read.usm.engineBoots,
        engineTime: read.usm.engineTime,
        userName: read.usm.userName,
        privParameters: read.usm.privParameters,
      },
      msgData: ciphertext,
      encrypted: true,
      localizedAuthKey: other,
      hash: "sha1",
    });
    expect(hex(readUsmParameters(rebuilt).authParameters)).not.toBe(hex(read.usm.authParameters));
  });
});

/**
 * The placeholder RFC 3414 section 6.3.1 prescribes is twelve zero octets, so a test
 * that fills the field with zeros and watches the digest cannot tell "the digest covers this
 * field" apart from "the digest skips this field": both produce the same number. The only way
 * to see the difference is to hash a message whose digest field holds something other than
 * zeros, which is what each case below does.
 */
describe("the digest covers its own field", () => {
  const usm = {
    engineId: Uint8Array.of(0x80, 0x00, 0xb9, 0x83, 0x01),
    engineBoots: 3,
    engineTime: 4567,
    userName: "u1",
    privParameters: new Uint8Array(0),
  };
  const key = localizedKey("authpass12345", Buffer.from(usm.engineId), "sha1");
  const base = {
    messageId: 99,
    level: "authNoPriv" as const,
    reportable: true,
    usm,
    msgData: encodeEmptyGetPdu(5),
    encrypted: false,
  };
  const signed = encodeAuthenticatedV3Message({ ...base, localizedAuthKey: key, hash: "sha1" });
  const digest = readUsmParameters(signed).authParameters;

  test("the shipped digest is not twelve zeros, so the field really was rewritten", () => {
    expect(hex(digest)).not.toBe("000000000000000000000000");
    expect(digest.length).toBe(12);
  });

  test("hashing the same message with a non-zero field gives a different digest", () => {
    const asymmetric = Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08);
    const withJunk = encodeV3Message({ ...base, usm: { ...usm, authParameters: asymmetric } });
    expect(hex(authenticate(Buffer.from(withJunk), key, "sha1"))).not.toBe(hex(digest));
  });

  test("hashing the signed message as it stands gives a different digest, which is why verification zeroes the field first", () => {
    expect(hex(authenticate(Buffer.from(signed), key, "sha1"))).not.toBe(hex(digest));
  });

  test("zeroing the field in the signed message brings the digest back", () => {
    const zeroed = Uint8Array.from(signed);
    const field = readChildren(signed, readField(signed, readChildren(signed, readField(signed, 0))[2].start))[4];
    zeroed.fill(0, field.start, field.end);
    expect(hex(authenticate(Buffer.from(zeroed), key, "sha1"))).toBe(hex(digest));
  });

  test("two messages differing only in their digest field are not the same bytes", () => {
    const asymmetric = Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08);
    const a = encodeV3Message({ ...base, usm: { ...usm, authParameters: new Uint8Array(12) } });
    const b = encodeV3Message({ ...base, usm: { ...usm, authParameters: asymmetric } });
    expect(a.length).toBe(b.length);
    expect(hex(a)).not.toBe(hex(b));
  });

  test("the digest is placed back at the offset it was hashed at, so lengths did not move", () => {
    const placeholder = encodeV3Message({ ...base, usm: { ...usm, authParameters: new Uint8Array(12) } });
    expect(signed.length).toBe(placeholder.length);
  });
});

describe("the scoped PDU", () => {
  test("it carries the context engine ID and name it was given", () => {
    const scoped = encodeScopedPdu({
      contextEngineId: Uint8Array.of(1, 2, 3),
      contextName: "ctxsys",
      pdu: encodeEmptyGetPdu(1),
    });
    const parts = readChildren(scoped, readField(scoped, 0));
    expect(hex(scoped.slice(parts[0].start, parts[0].end))).toBe("010203");
    expect(new TextDecoder().decode(scoped.slice(parts[1].start, parts[1].end))).toBe("ctxsys");
  });

  test("an empty context name and a named one produce different bytes", () => {
    const a = encodeScopedPdu({ contextEngineId: new Uint8Array(0), contextName: "", pdu: encodeEmptyGetPdu(1) });
    const b = encodeScopedPdu({ contextEngineId: new Uint8Array(0), contextName: "ctxsys", pdu: encodeEmptyGetPdu(1) });
    expect(hex(a)).not.toBe(hex(b));
  });

  test("encrypted data is wrapped in an OCTET STRING and plain data is not", () => {
    const usm = {
      engineId: Uint8Array.of(1),
      engineBoots: 0,
      engineTime: 0,
      userName: "u",
      authParameters: new Uint8Array(0),
      privParameters: new Uint8Array(0),
    };
    const payload = encodeScopedPdu({ contextEngineId: new Uint8Array(0), contextName: "", pdu: encodeEmptyGetPdu(1) });
    const plain = encodeV3Message({
      messageId: 1,
      level: "noAuthNoPriv",
      reportable: true,
      usm,
      msgData: payload,
      encrypted: false,
    });
    const wrapped = encodeV3Message({
      messageId: 1,
      level: "noAuthNoPriv",
      reportable: true,
      usm,
      msgData: payload,
      encrypted: true,
    });
    expect(wrapped.length).toBe(plain.length + 2);
    expect(readChildren(wrapped, readField(wrapped, 0))[3].tag).toBe(0x04);
    expect(readChildren(plain, readField(plain, 0))[3].tag).toBe(0x30);
  });
});

/**
 * Reading the discovery answer.
 *
 * WHAT IS MEASURED AND WHAT IS NOT, stated before the tests rather than after. No Report from a
 * real agent was captured, so the Report half of this reader is checked against a Report this
 * file builds. That is our bytes against our expectation, which is exactly the shape of test
 * that let a reader lose data elsewhere in this repository, and it is recorded here as a known
 * limit rather than presented as verification. What IS anchored outside this file: the envelope
 * half runs through the same `readUsmParameters` that reproduces a real net-snmp datagram byte
 * for byte above, and the first test below reads the engine identity out of those real bytes.
 */
describe("the discovery answer", () => {
  const ENGINE = Uint8Array.from(Buffer.from("8000b98380f4b9e5c60d371fee600810ee", "hex"));
  const REPORT_OID = [1, 3, 6, 1, 6, 3, 15, 1, 1, 4, 0];

  /** A Report in the shape RFC 3412 describes. Built here, for want of a captured one. */
  const report = (
    over: {
      engineId?: Uint8Array;
      boots?: number;
      time?: number;
      pduTag?: number;
      varbinds?: number;
      model?: number;
    } = {},
  ) => {
    const binding = writeSequence([writeOid(REPORT_OID), writeInteger(1)]);
    const list = Array.from({ length: over.varbinds ?? 1 }, () => binding);
    const pdu = writeSequence(
      [writeInteger(7), writeInteger(0), writeInteger(0), writeSequence(list)],
      over.pduTag ?? 0xa8,
    );
    return writeSequence([
      writeInteger(VERSION_V3),
      writeSequence([
        writeInteger(7),
        writeInteger(MAX_MESSAGE_SIZE),
        writeOctetString(Uint8Array.of(0)),
        writeInteger(over.model ?? SECURITY_MODEL_USM),
      ]),
      encodeUsmParameters({
        engineId: over.engineId ?? ENGINE,
        engineBoots: over.boots ?? 3,
        engineTime: over.time ?? 4567,
        userName: "",
        authParameters: new Uint8Array(0),
        privParameters: new Uint8Array(0),
      }),
      writeSequence([writeOctetString(over.engineId ?? ENGINE), writeOctetString(new Uint8Array(0)), pdu]),
    ]);
  };

  /**
   * The anchored half. These three numbers come out of a datagram a real net-snmp wrote, down
   * the same path the discovery reader uses, so the envelope parsing is not self-confirming.
   */
  test("the same parameter reader lifts the engine identity out of real net-snmp bytes", () => {
    const usm = readUsmParameters(AUTH_PRIV);
    expect(hex(usm.engineId)).toBe("8000b98380f4b9e5c60d371fee600810ee");
    expect(usm.engineBoots).toBe(0);
    expect(usm.engineTime).toBe(10);
  });

  test("it reads the identity, the two counters and the Report's own OID", () => {
    expect(readDiscovery(report())).toEqual({
      engineId: ENGINE,
      engineBoots: 3,
      engineTime: 4567,
      reportOid: USM_REPORT_OIDS.unknownEngineId,
    });
  });

  test("boots and time are read apart from each other", () => {
    const read = readDiscovery(report({ boots: 11, time: 22 }));
    expect(read.engineBoots).toBe(11);
    expect(read.engineTime).toBe(22);
  });

  /**
   * SN-S8. Every key is localised to this identity, so accepting an empty one would localise
   * every key to nothing and accept whatever answered as the engine.
   */
  test("an answer with no engine identity is refused, not defaulted", () => {
    expect(() => readDiscovery(report({ engineId: new Uint8Array(0) }))).toThrow(BerError);
    expect(() => readDiscovery(report({ engineId: new Uint8Array(0) }))).toThrow(/localised to nothing/);
  });

  /**
   * The field count is checked for its own sake. A scoped PDU with two fields would otherwise
   * have its third read as undefined and the tag comparison below would silently decide the
   * answer was not a Report, which reports the wrong reason for the right refusal.
   */
  test("a scoped PDU that does not hold exactly three fields is refused", () => {
    const envelope = (scoped: Uint8Array) =>
      writeSequence([
        writeInteger(VERSION_V3),
        writeSequence([
          writeInteger(7),
          writeInteger(MAX_MESSAGE_SIZE),
          writeOctetString(Uint8Array.of(0)),
          writeInteger(SECURITY_MODEL_USM),
        ]),
        encodeUsmParameters({
          engineId: ENGINE,
          engineBoots: 3,
          engineTime: 4567,
          userName: "",
          authParameters: new Uint8Array(0),
          privParameters: new Uint8Array(0),
        }),
        scoped,
      ]);
    const pdu = writeSequence(
      [
        writeInteger(7),
        writeInteger(0),
        writeInteger(0),
        writeSequence([writeSequence([writeOid(REPORT_OID), writeInteger(1)])]),
      ],
      0xa8,
    );
    const short = envelope(writeSequence([writeOctetString(ENGINE), pdu]));
    const long = envelope(
      writeSequence([writeOctetString(ENGINE), writeOctetString(new Uint8Array(0)), pdu, writeInteger(1)]),
    );
    expect(() => readDiscovery(short)).toThrow(BerError);
    expect(() => readDiscovery(long)).toThrow(BerError);
  });

  test("an answer that is not a Report is refused", () => {
    expect(() => readDiscovery(report({ pduTag: 0xa2 }))).toThrow(BerError);
  });

  test("a Report naming more or fewer than one counter is refused", () => {
    expect(() => readDiscovery(report({ varbinds: 0 }))).toThrow(BerError);
    expect(() => readDiscovery(report({ varbinds: 2 }))).toThrow(BerError);
  });

  test("a security model this provider does not read is refused by number", () => {
    expect(() => readDiscovery(report({ model: 2 }))).toThrow(/model 2/);
  });

  /**
   * Two refusals, not one. A real v2c datagram carries three fields, so it never reaches the
   * version check: it is turned away on its shape. The version check needs a message with the
   * v3 shape and the wrong number in it, which is the case an agent could actually produce.
   */
  test("a real v2c datagram is turned away on its shape, before any version is read", () => {
    expect(() => readDiscovery(Uint8Array.from(capture.sent.v2cGet))).toThrow(BerError);
  });

  test("a four-field message carrying the wrong version is turned away on the version", () => {
    const wrong = Uint8Array.from(report());
    const versionField = readChildren(wrong, readField(wrong, 0))[0];
    wrong[versionField.start] = 1;
    expect(() => readDiscovery(wrong)).toThrow(BerError);
    expect(() => readDiscovery(report())).not.toThrow();
  });

  /**
   * The reason this reader exists at all, measured rather than asserted. The client drops any
   * datagram `decodeResponse` cannot read, so if the v2c reader merely returned something wrong
   * the discovery answer would be mis-read; because it throws, the answer is dropped in silence
   * and the connection reports that the agent never replied.
   */
  test("the v2c reader cannot read a Report, which is why a dropped datagram looked like silence", () => {
    expect(() => decodeResponse(report())).toThrow();
    expect(() => readDiscovery(report())).not.toThrow();
  });
});

/**
 * Reading an authenticated answer.
 *
 * Unlike the Report above, this half IS anchored. The captured authPriv datagram carries a
 * digest a real net-snmp computed and a payload it really encrypted, and an answer has the same
 * envelope as a request, so the verify-and-decrypt path runs against those bytes rather than
 * against bytes this file produced. What the PDU inside turns out to be (a GetRequest here
 * rather than a Response) does not change what is being tested, which is the security
 * processing in front of it.
 */
describe("an authenticated answer is checked before it is read", () => {
  const usmOf = readUsmParameters(AUTH_PRIV);
  const engineId = Buffer.from(usmOf.engineId);
  const KEYS = {
    localizedAuthKey: localizedKey(capture.v3AuthPrivSha1.authPassphrase, engineId, "sha1"),
    localizedPrivKey: localizedKey(capture.v3AuthPrivSha1.privPassphrase, engineId, "sha1"),
    hash: "sha1" as const,
  };

  test("a real net-snmp datagram verifies and decrypts to a readable PDU", () => {
    const answer = readAuthenticatedAnswer(AUTH_PRIV, KEYS);
    expect(answer.engineBoots).toBe(0);
    expect(answer.engineTime).toBe(10);
    expect(answer.response.varbinds.length).toBeGreaterThan(0);
  });

  test("the key is load-bearing: one wrong passphrase and the digest is refused", () => {
    const wrong = { ...KEYS, localizedAuthKey: localizedKey("authpass12346", engineId, "sha1") };
    expect(() => readAuthenticatedAnswer(AUTH_PRIV, wrong)).toThrow(UsmError);
  });

  test("a single flipped byte anywhere in the message is refused", () => {
    for (const at of [30, 60, 100, AUTH_PRIV.length - 1]) {
      const tampered = Uint8Array.from(AUTH_PRIV);
      tampered[at] ^= 0x01;
      expect(() => readAuthenticatedAnswer(tampered, KEYS)).toThrow(UsmError);
    }
  });

  /**
   * The ordering test, and the reason the function is written the way it is. RFC 3414 section
   * 3.2 authenticates before it decrypts, because everything past the security parameters is
   * attacker-controlled until the digest says otherwise. This datagram's ciphertext is
   * destroyed, so a reader that decrypted first would fail somewhere inside its own BER
   * decoder, over bytes nothing vouched for. The refusal has to be the digest's.
   */
  test("a message with a broken digest is refused before anything decrypts it", () => {
    const tampered = Uint8Array.from(AUTH_PRIV);
    const dataField = readChildren(tampered, readField(tampered, 0))[3];
    tampered.fill(0xff, dataField.start, dataField.end);
    let caught: unknown;
    try {
      readAuthenticatedAnswer(tampered, KEYS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsmError);
    expect(caught).not.toBeInstanceOf(BerError);
  });

  /**
   * Both of these are refused either way, because a digest field of the wrong width
   * cannot match a digest. So "it throws" proves nothing here; what the width check buys is the
   * DIAGNOSIS. A malformed field reported as a digest mismatch tells the operator their key is
   * wrong and sends them to rotate a credential that was never the problem. The assertion is
   * therefore that the two cases are told apart, without pinning either sentence's wording.
   */
  test("a malformed digest field is not diagnosed as a wrong key", () => {
    const malformed = encodeV3Message({
      messageId: 1,
      level: "authNoPriv",
      reportable: true,
      usm: { ...usmOf, authParameters: new Uint8Array(0) },
      msgData: encodeScopedPdu({ contextEngineId: usmOf.engineId, contextName: "", pdu: encodeEmptyGetPdu(1) }),
      encrypted: false,
    });
    const wrongKey = { ...KEYS, localizedAuthKey: localizedKey("authpass12346", engineId, "sha1") };
    const widthError = (() => {
      try {
        readAuthenticatedAnswer(malformed, KEYS);
      } catch (e) {
        return e as Error;
      }
    })();
    const keyError = (() => {
      try {
        readAuthenticatedAnswer(AUTH_PRIV, wrongKey);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(widthError).toBeInstanceOf(UsmError);
    expect(keyError).toBeInstanceOf(UsmError);
    expect(widthError?.message).not.toBe(keyError?.message);
  });

  /**
   * The privacy bit decides whether the payload is decrypted, and the captured datagram has
   * every flag set, so it cannot tell the privacy bit from the authentication bit. This one is
   * built at authNoPriv on purpose: its payload is plaintext, and a reader that keyed the
   * decision off the wrong bit would try to decrypt a scoped PDU that was never encrypted.
   */
  test("an authenticated answer that was not encrypted is read without decrypting it", () => {
    const plain = encodeAuthenticatedV3Message({
      messageId: 42,
      level: "authNoPriv",
      reportable: true,
      usm: {
        engineId: usmOf.engineId,
        engineBoots: 3,
        engineTime: 99,
        userName: "u1",
        privParameters: new Uint8Array(0),
      },
      msgData: encodeScopedPdu({
        contextEngineId: usmOf.engineId,
        contextName: "",
        pdu: encodePdu(PDU_GET, { requestId: 5150, oids: [[1, 3, 6, 1, 2, 1, 1, 1, 0]] }),
      }),
      encrypted: false,
      localizedAuthKey: KEYS.localizedAuthKey,
      hash: "sha1",
    });
    const answer = readAuthenticatedAnswer(plain, { localizedAuthKey: KEYS.localizedAuthKey, hash: "sha1" });
    expect(answer.response.requestId).toBe(5150);
    expect(answer.engineBoots).toBe(3);
    expect(answer.engineTime).toBe(99);
  });

  /**
   * A connection opened at authNoPriv holds no privacy key, so an encrypted answer is not a
   * malformed message: it is an answer this connection was never set up to read, and saying so
   * points at the level rather than at the bytes.
   */
  test("an encrypted answer with no privacy key names the level, not the bytes", () => {
    const noPriv = { localizedAuthKey: KEYS.localizedAuthKey, hash: "sha1" as const };
    let caught: unknown;
    try {
      readAuthenticatedAnswer(AUTH_PRIV, noPriv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsmError);
    expect(caught).not.toBeInstanceOf(BerError);
  });
});
