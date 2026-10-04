/**
 * A software WebAuthn authenticator built from the wire format, so tests drive the real
 * `@simplewebauthn/server` verification with responses they can bend one field at a time.
 *
 * It runs under bun and under Playwright's Node runner, so it uses only Web Crypto, `node:crypto`
 * and `@simplewebauthn/server/helpers`: no `bun:test`, no `Bun.*`.
 */
import { webcrypto } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

// Typed as the DOM's SubtleCrypto so keys and buffers match the types the library helpers use.
const subtle = webcrypto.subtle as unknown as SubtleCrypto;

type Bytes = Uint8Array<ArrayBuffer>;

/** Every attestation format the library can verify with a certificate chain, which is what can make it fetch a CRL. */
export const CHAINED_ATTESTATION_FORMATS = [
  "packed-x5c",
  "fido-u2f",
  "tpm",
  "android-key",
  "android-safetynet",
  "apple",
] as const;

export type AttestationFormat = "none" | "packed-self" | (typeof CHAINED_ATTESTATION_FORMATS)[number];

export interface AttestationOverrides {
  origin?: string;
  rpId?: string;
  type?: string;
  crossOrigin?: boolean;
  topOrigin?: string;
  userVerified?: boolean;
  userPresent?: boolean;
  backupEligible?: boolean;
  backupState?: boolean;
  /**
   * The attestation statement to send. The chained formats past `packed-x5c` carry the shape of their statement
   * with an `x5c` chain (default one arbitrary DER blob) but no valid signature: they exist to show that Studio
   * refuses the format before the library would verify the chain.
   */
  format?: AttestationFormat;
  credentialIdBytes?: number;
  transports?: string[];
  /** `id` and `rawId` sent instead of the attested credential ID, which stays `credentialIdBytes` long. */
  responseId?: string;
  /** The DER certificates of a chained format, leaf first; default one arbitrary DER blob. */
  x5c?: Uint8Array[];
}

export interface AssertionOverrides {
  origin?: string;
  rpId?: string;
  type?: string;
  crossOrigin?: boolean;
  topOrigin?: string;
  userVerified?: boolean;
  userPresent?: boolean;
  backupEligible?: boolean;
  backupState?: boolean;
  signCount?: number;
  userHandle?: string | null;
  badSignature?: boolean;
  challenge?: string;
}

interface FlagInput {
  userPresent?: boolean;
  userVerified?: boolean;
  backupEligible?: boolean;
  backupState?: boolean;
}

const DEFAULT_CREDENTIAL_ID_BYTES = 32;

function randomBytes(length: number): Bytes {
  const bytes = new Uint8Array(length);
  webcrypto.getRandomValues(bytes);
  return bytes;
}

function concat(parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.digest("SHA-256", data));
}

function flagsByte(input: FlagInput, attested: boolean): number {
  let flags = 0;
  if (input.userPresent ?? true) flags |= 0x01;
  if (input.userVerified ?? true) flags |= 0x04;
  if (input.backupEligible ?? false) flags |= 0x08;
  if (input.backupState ?? false) flags |= 0x10;
  if (attested) flags |= 0x40;
  return flags;
}

function uint32(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

/** Web Crypto signs ECDSA as raw `r || s`; WebAuthn carries the DER SEQUENCE of two INTEGERs. */
function rawSignatureToDer(raw: Bytes): Bytes {
  const integer = (half: Bytes): Bytes => {
    let start = 0;
    while (start < half.length - 1 && half[start] === 0) start++;
    const trimmed = half.slice(start);
    const body = trimmed[0] & 0x80 ? concat([new Uint8Array([0]), trimmed]) : trimmed;
    return concat([new Uint8Array([0x02, body.length]), body]);
  };
  const r = integer(raw.slice(0, raw.length / 2));
  const s = integer(raw.slice(raw.length / 2));
  return concat([new Uint8Array([0x30, r.length + s.length]), r, s]);
}

function encodeClientData(input: {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
  topOrigin?: string;
}): string {
  const clientData: Record<string, unknown> = {
    type: input.type,
    challenge: input.challenge,
    origin: input.origin,
    crossOrigin: input.crossOrigin ?? false,
  };
  if (input.topOrigin !== undefined) clientData.topOrigin = input.topOrigin;
  return isoBase64URL.fromUTF8String(JSON.stringify(clientData));
}

export class SoftAuthenticator {
  private attestedId: string;
  userHandle: string | null = null;
  signCount: number;

  private constructor(
    private readonly origin: string,
    private readonly privateKey: CryptoKey,
    private readonly x: Bytes,
    private readonly y: Bytes,
    private readonly counterless: boolean,
    credentialId: string,
    signCount: number,
  ) {
    this.attestedId = credentialId;
    this.signCount = signCount;
  }

  static async create(input: { origin: string; counterless?: boolean }): Promise<SoftAuthenticator> {
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await subtle.exportKey("jwk", pair.publicKey);
    return new SoftAuthenticator(
      input.origin,
      pair.privateKey,
      isoBase64URL.toBuffer(jwk.x as string),
      isoBase64URL.toBuffer(jwk.y as string),
      input.counterless ?? false,
      isoBase64URL.fromBuffer(randomBytes(DEFAULT_CREDENTIAL_ID_BYTES)),
      0,
    );
  }

  /** The attested credential ID, base64url. */
  get credentialId(): string {
    return this.attestedId;
  }

  private coseKey(): Bytes {
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, this.x],
        [-3, this.y],
      ]),
    );
  }

  private async sign(data: Bytes): Promise<Bytes> {
    const raw = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.privateKey, data));
    return rawSignatureToDer(raw);
  }

  async register(
    options: PublicKeyCredentialCreationOptionsJSON,
    overrides: AttestationOverrides = {},
  ): Promise<RegistrationResponseJSON> {
    if (overrides.credentialIdBytes !== undefined) {
      this.attestedId = isoBase64URL.fromBuffer(randomBytes(overrides.credentialIdBytes));
    }
    this.userHandle = options.user.id;
    const rpId = overrides.rpId ?? options.rp.id ?? new URL(this.origin).hostname;
    const credentialIdBytes = isoBase64URL.toBuffer(this.attestedId);
    const idLength = new Uint8Array(2);
    new DataView(idLength.buffer).setUint16(0, credentialIdBytes.length, false);
    const authData = concat([
      await sha256(new TextEncoder().encode(rpId)),
      new Uint8Array([flagsByte(overrides, true)]),
      uint32(this.signCount),
      new Uint8Array(16),
      idLength,
      credentialIdBytes,
      this.coseKey(),
    ]);
    const clientDataJSON = encodeClientData({
      type: overrides.type ?? "webauthn.create",
      challenge: options.challenge,
      origin: overrides.origin ?? this.origin,
      crossOrigin: overrides.crossOrigin,
      topOrigin: overrides.topOrigin,
    });
    const signatureBase = concat([authData, await sha256(isoBase64URL.toBuffer(clientDataJSON))]);
    const format = overrides.format ?? "none";
    const attStmt = new Map<string, number | string | Uint8Array | Uint8Array[]>();
    let fmt = format as string;
    if (format === "packed-self" || format === "packed-x5c") {
      fmt = "packed";
      attStmt.set("alg", -7);
      attStmt.set("sig", await this.sign(signatureBase));
      // The credential key signs, and no chain leaf certifies it, so an x5c signature is bogus by construction.
      if (format === "packed-x5c") attStmt.set("x5c", overrides.x5c ?? [randomBytes(64)]);
    } else if (format === "android-safetynet") {
      // SafetyNet carries its chain inside a JWS, so the statement is a version and the JWS bytes.
      attStmt.set("ver", "1");
      attStmt.set("response", randomBytes(64));
    } else if (format !== "none") {
      if (format !== "fido-u2f") attStmt.set("alg", -7);
      attStmt.set("sig", randomBytes(64));
      attStmt.set("x5c", overrides.x5c ?? [randomBytes(64)]);
    }
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, number | string | Uint8Array | Uint8Array[]>>([
        ["fmt", fmt],
        ["attStmt", attStmt],
        ["authData", authData],
      ]),
    );
    const id = overrides.responseId ?? this.attestedId;
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON,
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: overrides.transports ?? ["internal"],
        publicKeyAlgorithm: -7,
      },
    };
  }

  async assert(
    options: PublicKeyCredentialRequestOptionsJSON,
    overrides: AssertionOverrides = {},
  ): Promise<AuthenticationResponseJSON> {
    if (overrides.signCount !== undefined) this.signCount = overrides.signCount;
    else if (!this.counterless) this.signCount += 1;
    const rpId = overrides.rpId ?? options.rpId ?? new URL(this.origin).hostname;
    const authData = concat([
      await sha256(new TextEncoder().encode(rpId)),
      new Uint8Array([flagsByte(overrides, false)]),
      uint32(this.signCount),
    ]);
    const clientDataJSON = encodeClientData({
      type: overrides.type ?? "webauthn.get",
      challenge: overrides.challenge ?? options.challenge,
      origin: overrides.origin ?? this.origin,
      crossOrigin: overrides.crossOrigin,
      topOrigin: overrides.topOrigin,
    });
    const signature = await this.sign(concat([authData, await sha256(isoBase64URL.toBuffer(clientDataJSON))]));
    if (overrides.badSignature) signature[signature.length - 1] ^= 0x01;
    const userHandle = overrides.userHandle === undefined ? this.userHandle : overrides.userHandle;
    return {
      id: this.attestedId,
      rawId: this.attestedId,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON,
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(signature),
        ...(userHandle === null ? {} : { userHandle }),
      },
    };
  }
}
