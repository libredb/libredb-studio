/**
 * SNMPv3 messages: the envelope, the scoped PDU, and the discovery exchange that has to happen
 * before either can be authenticated.
 *
 * WHY DISCOVERY IS PART OF THIS FILE RATHER THAN AN OPTIONAL EXTRA. A v3 request cannot be
 * authenticated until the agent's engine identity is known, because the key every request is
 * signed with is localised to that identity. So the first thing a v3 connection does is ask an
 * unauthenticated question whose only purpose is to be refused in a way that carries the
 * answer. Treating that as a special case bolted on afterwards is how the engine identity ends
 * up being taken from whatever replied, which is exactly what SN-S8 forbids.
 *
 * THE DIGEST COVERS ITS OWN FIELD. RFC 3414 section 6.3.2 hashes the whole message with
 * `msgAuthenticationParameters` present and filled with zeros, and then writes the result into
 * that same field. The message is therefore built twice: once with a zeroed placeholder to be
 * hashed, and once with the digest written in. Doing it in one pass, by hashing everything
 * except that field, produces a digest over different bytes and an agent that never answers.
 */
import { readChildren, readField, TAG_OCTET_STRING, writeInteger, writeOctetString, writeSequence } from "./ber";
import { BerError } from "./ber";
import { decodePdu, encodeEmptyGetPdu, readOid, type Response } from "./message";
import { PDU_REPORT } from "./valve";
import {
  AUTH_PARAM_BYTES,
  SALT_BYTES,
  UsmError,
  type AuthHash,
  aesIv,
  authenticate,
  decryptScopedPdu,
  digestMatches,
  encryptScopedPdu,
} from "./usm";

/** RFC 3412 section 6.1: the version on the wire for SNMPv3. */
export const VERSION_V3 = 3;
/** RFC 3411 section 4: the User-based Security Model's number. */
export const SECURITY_MODEL_USM = 3;
/**
 * RFC 3412 section 6.3. The largest message this side will accept; it is ours to choose and it
 * bounds what an agent will send back, which is the first of the two limits a walk meets.
 */
export const MAX_MESSAGE_SIZE = 65507;

/** RFC 3412 section 6.4, one octet: reportable, privacy, authentication. */
export const FLAG_AUTH = 0x01;
export const FLAG_PRIV = 0x02;
export const FLAG_REPORTABLE = 0x04;

export type SecurityLevel = "noAuthNoPriv" | "authNoPriv" | "authPriv";

export function flagsFor(level: SecurityLevel, reportable: boolean): number {
  const base = level === "authPriv" ? FLAG_AUTH | FLAG_PRIV : level === "authNoPriv" ? FLAG_AUTH : 0;
  return reportable ? base | FLAG_REPORTABLE : base;
}

export interface ScopedPduInput {
  readonly contextEngineId: Uint8Array;
  readonly contextName: string;
  /** The PDU, already encoded by `message.ts`'s writer. */
  readonly pdu: Uint8Array;
}

export function encodeScopedPdu(input: ScopedPduInput): Uint8Array {
  return writeSequence([
    writeOctetString(input.contextEngineId),
    writeOctetString(new TextEncoder().encode(input.contextName)),
    input.pdu,
  ]);
}

export interface UsmParameters {
  readonly engineId: Uint8Array;
  readonly engineBoots: number;
  readonly engineTime: number;
  readonly userName: string;
  /** Twelve octets, or twelve zeros while the digest is being computed. */
  readonly authParameters: Uint8Array;
  /** Eight octets at authPriv, empty otherwise. */
  readonly privParameters: Uint8Array;
}

/**
 * The two refusals below are `UsmError` and not `BerError`, and the difference is deliberate.
 *
 * Nothing an agent sends can reach them: they fire only on values this provider itself assembled,
 * so if one ever fires it is our defect and not the device's. `BerError` reads as a problem with
 * bytes that arrived, and dressing our own mistake in that costume sends the reader to the agent
 * to look for a fault that is in here. The reader in this file keeps `BerError`, because what it
 * refuses really did come off the wire. That is the whole line: the writer's refusals are ours,
 * the reader's refusals are the network's.
 */
export function encodeUsmParameters(usm: UsmParameters): Uint8Array {
  if (usm.authParameters.length !== 0 && usm.authParameters.length !== AUTH_PARAM_BYTES) {
    throw new UsmError(
      `this provider tried to build msgAuthenticationParameters out of ${usm.authParameters.length} octets, and the field is ${AUTH_PARAM_BYTES} or absent`,
      "builtWrongWidth",
    );
  }
  if (usm.privParameters.length !== 0 && usm.privParameters.length !== SALT_BYTES) {
    throw new UsmError(
      `this provider tried to build msgPrivacyParameters out of ${usm.privParameters.length} octets, and the field is ${SALT_BYTES} or absent`,
      "builtWrongWidth",
    );
  }
  return writeOctetString(
    writeSequence([
      writeOctetString(usm.engineId),
      writeInteger(usm.engineBoots),
      writeInteger(usm.engineTime),
      writeOctetString(new TextEncoder().encode(usm.userName)),
      writeOctetString(usm.authParameters),
      writeOctetString(usm.privParameters),
    ]),
  );
}

export interface V3MessageInput {
  readonly messageId: number;
  readonly level: SecurityLevel;
  readonly reportable: boolean;
  readonly usm: UsmParameters;
  /** Already encrypted at authPriv, plain otherwise. */
  readonly msgData: Uint8Array;
  /** True when `msgData` is ciphertext, which changes how it is wrapped. */
  readonly encrypted: boolean;
}

export function encodeV3Message(input: V3MessageInput): Uint8Array {
  const globalData = writeSequence([
    writeInteger(input.messageId),
    writeInteger(MAX_MESSAGE_SIZE),
    writeOctetString(Uint8Array.of(flagsFor(input.level, input.reportable))),
    writeInteger(SECURITY_MODEL_USM),
  ]);
  const data = input.encrypted ? writeOctetString(input.msgData) : input.msgData;
  return writeSequence([writeInteger(VERSION_V3), globalData, encodeUsmParameters(input.usm), data]);
}

export interface AuthenticatedInput extends Omit<V3MessageInput, "usm"> {
  readonly usm: Omit<UsmParameters, "authParameters">;
  readonly localizedAuthKey: Buffer;
  readonly hash: AuthHash;
}

/**
 * Builds a message and signs it, in the two passes the RFC's own wording requires.
 *
 * The placeholder is written first so that the bytes being hashed are the bytes being sent, and
 * the digest is then placed into the field it already covered. The second pass rewrites the
 * whole message rather than patching the first, because patching assumes the digest's position
 * does not move, and that assumption is one length change away from being wrong.
 */
export function encodeAuthenticatedV3Message(input: AuthenticatedInput): Uint8Array {
  const placeholder = new Uint8Array(AUTH_PARAM_BYTES);
  const withPlaceholder = encodeV3Message({ ...input, usm: { ...input.usm, authParameters: placeholder } });
  const digest = authenticate(Buffer.from(withPlaceholder), input.localizedAuthKey, input.hash);
  return encodeV3Message({ ...input, usm: { ...input.usm, authParameters: new Uint8Array(digest) } });
}

export interface EncryptedInput extends Omit<AuthenticatedInput, "msgData" | "encrypted"> {
  readonly scopedPdu: Uint8Array;
  readonly localizedPrivKey: Buffer;
  readonly salt: Uint8Array;
}

/** Encrypts the scoped PDU, then signs the message that carries it, in that order. */
export function encodeEncryptedV3Message(input: EncryptedInput): Uint8Array {
  const iv = aesIv(input.usm.engineBoots, input.usm.engineTime, Buffer.from(input.salt));
  const ciphertext = encryptScopedPdu(Buffer.from(input.scopedPdu), input.localizedPrivKey, iv);
  return encodeAuthenticatedV3Message({
    ...input,
    usm: { ...input.usm, privParameters: input.salt },
    msgData: new Uint8Array(ciphertext),
    encrypted: true,
  });
}

/**
 * The discovery request: unauthenticated, naming no engine and no user, asking nothing.
 *
 * Its varbind list is empty on purpose. Discovery is not a read that happens to fail; it is a
 * message whose only job is to draw a Report that carries the agent's engine identity, and
 * asking for an object would mean asking an agent that cannot yet authenticate the asker.
 */
export function encodeDiscovery(messageId: number, requestId: number): Uint8Array {
  return encodeV3Message({
    messageId,
    level: "noAuthNoPriv",
    reportable: true,
    usm: {
      engineId: new Uint8Array(0),
      engineBoots: 0,
      engineTime: 0,
      userName: "",
      authParameters: new Uint8Array(0),
      privParameters: new Uint8Array(0),
    },
    msgData: encodeScopedPdu({
      contextEngineId: new Uint8Array(0),
      contextName: "",
      pdu: encodeEmptyGetPdu(requestId),
    }),
    encrypted: false,
  });
}

/** Reads the USM parameters out of any v3 message, which is all discovery's answer is for. */
export function readUsmParameters(datagram: Uint8Array): UsmParameters {
  const fields = readChildren(datagram, readField(datagram, 0));
  if (fields.length < 4) throw new BerError("an SNMPv3 message holds four fields");
  const securityField = fields[2];
  if (securityField.tag !== TAG_OCTET_STRING) throw new BerError("msgSecurityParameters is an OCTET STRING");
  const inner = readChildren(datagram, readField(datagram, securityField.start));
  if (inner.length !== 6) throw new BerError("USM parameters hold six fields");
  const slice = (i: number) => datagram.slice(inner[i].start, inner[i].end);
  const number = (i: number) => [...slice(i)].reduce((n, b) => n * 256 + b, 0);
  return {
    engineId: slice(0),
    engineBoots: number(1),
    engineTime: number(2),
    userName: new TextDecoder().decode(slice(3)),
    authParameters: slice(4),
    privParameters: slice(5),
  };
}

export interface DiscoveredEngine {
  readonly engineId: Uint8Array;
  readonly engineBoots: number;
  readonly engineTime: number;
  /** The usmStats OID the Report carried, as a dotted string. */
  readonly reportOid: string;
}

/**
 * Reads the engine identity out of the Report a discovery request draws.
 *
 * WHY THIS CANNOT GO THROUGH `decodeResponse`. That reader is built for the v2c shape, where
 * the PDU sits directly behind the community string. A v3 Report sits behind the global data,
 * the security parameters and a scoped PDU, so the v2c reader does not merely return the wrong
 * answer: it throws, and the client's message handler drops a datagram it cannot read. The
 * discovery answer would therefore arrive, be discarded in silence, and the connection would
 * end at its own deadline reporting that the agent never replied. Tested below.
 *
 * WHY AN EMPTY ENGINE ID IS REFUSED. SN-S8. The engine identity is what every key is localised
 * to, so taking it from whatever answered is the whole of the attack this check exists for. An
 * empty field is not an identity, and accepting it would localise every key to nothing.
 */
export function readDiscovery(datagram: Uint8Array): DiscoveredEngine {
  const fields = readChildren(datagram, readField(datagram, 0));
  if (fields.length < 4) throw new BerError("an SNMPv3 message holds four fields");
  const version = [...datagram.slice(fields[0].start, fields[0].end)].reduce((n, b) => n * 256 + b, 0);
  if (version !== VERSION_V3)
    throw new BerError(`a discovery answer is version ${VERSION_V3}, this one says ${version}`);
  const global = readChildren(datagram, fields[1]);
  const model = [...datagram.slice(global[3].start, global[3].end)].reduce((n, b) => n * 256 + b, 0);
  if (model !== SECURITY_MODEL_USM) {
    throw new BerError(
      `security model ${model} is not the User-based Security Model, and this provider reads no other`,
    );
  }
  const usm = readUsmParameters(datagram);
  if (usm.engineId.length === 0) {
    throw new BerError("the answer carried no engine identity, and a key cannot be localised to nothing");
  }
  const scoped = readChildren(datagram, fields[3]);
  if (scoped.length !== 3) throw new BerError("a scoped PDU holds three fields");
  if (scoped[2].tag !== PDU_REPORT) {
    throw new BerError(`a discovery request draws a Report, and this answer carried 0x${scoped[2].tag.toString(16)}`);
  }
  const pdu = readChildren(datagram, scoped[2]);
  const varbinds = readChildren(datagram, pdu[3]);
  if (varbinds.length !== 1) throw new BerError(`a Report names one counter, this one named ${varbinds.length}`);
  const binding = readChildren(datagram, varbinds[0]);
  return {
    engineId: usm.engineId,
    engineBoots: usm.engineBoots,
    engineTime: usm.engineTime,
    reportOid: readOid(datagram.slice(binding[0].start, binding[0].end)).join("."),
  };
}

export interface V3Keys {
  readonly localizedAuthKey: Buffer;
  readonly localizedPrivKey?: Buffer;
  readonly hash: AuthHash;
}

export interface V3Answer {
  readonly response: Response;
  /** The PDU type, so a caller can tell a Response from a Report without re-parsing. */
  readonly pduTag: number;
  /** The engine's own counters as this answer carried them, which the next request must echo. */
  readonly engineBoots: number;
  readonly engineTime: number;
}

/**
 * Reads an authenticated answer: checks the digest, decrypts if it was encrypted, and reads the
 * PDU inside.
 *
 * THE DIGEST IS CHECKED BEFORE THE CONTENT IS READ, and the order is the point. Everything past
 * the security parameters is attacker-controlled until the digest says otherwise, so decrypting
 * first would run our own decoder over bytes nothing has vouched for. RFC 3414 section 3.2 puts
 * authentication ahead of privacy processing for this reason.
 *
 * The digest is verified the way it was made: the field is zeroed in a copy and the message is
 * hashed again. A verifier that hashed everything except that field would compute a digest over
 * different bytes than the sender did and reject every genuine message.
 */
export function readAuthenticatedAnswer(datagram: Uint8Array, keys: V3Keys): V3Answer {
  const fields = readChildren(datagram, readField(datagram, 0));
  if (fields.length < 4) throw new BerError("an SNMPv3 message holds four fields");
  const usm = readUsmParameters(datagram);
  if (usm.authParameters.length !== AUTH_PARAM_BYTES) {
    throw new UsmError(
      `an authenticated answer carries a ${AUTH_PARAM_BYTES} octet digest, this one carried ${usm.authParameters.length}`,
      "digestWidth",
    );
  }
  const security = readChildren(datagram, readField(datagram, fields[2].start));
  const zeroed = Uint8Array.from(datagram);
  zeroed.fill(0, security[4].start, security[4].end);
  const expected = authenticate(Buffer.from(zeroed), keys.localizedAuthKey, keys.hash);
  if (!digestMatches(expected, Buffer.from(usm.authParameters))) {
    throw new UsmError(
      "the answer's digest does not match, so it was not written by the engine this connection authenticated to",
      "digestMismatch",
    );
  }

  const flags = datagram[readChildren(datagram, fields[1])[2].start];
  let pduHolder = datagram;
  let pduField;
  if ((flags & FLAG_PRIV) !== 0) {
    if (keys.localizedPrivKey === undefined) {
      throw new UsmError(
        "the answer is encrypted and this connection holds no privacy key, which means it was opened at a level that cannot read it",
        "noPrivacyKey",
      );
    }
    const iv = aesIv(usm.engineBoots, usm.engineTime, Buffer.from(usm.privParameters));
    const plain = decryptScopedPdu(
      Buffer.from(datagram.slice(fields[3].start, fields[3].end)),
      keys.localizedPrivKey,
      iv,
    );
    pduHolder = new Uint8Array(plain);
    const scoped = readChildren(pduHolder, readField(pduHolder, 0));
    if (scoped.length !== 3) throw new BerError("a scoped PDU holds three fields");
    pduField = scoped[2];
  } else {
    const scoped = readChildren(datagram, fields[3]);
    if (scoped.length !== 3) throw new BerError("a scoped PDU holds three fields");
    pduField = scoped[2];
  }
  return {
    response: decodePdu(pduHolder, pduField),
    pduTag: pduField.tag,
    engineBoots: usm.engineBoots,
    engineTime: usm.engineTime,
  };
}
