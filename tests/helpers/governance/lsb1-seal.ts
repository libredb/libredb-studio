/**
 * The test sealer for `lsb1` envelopes (docs/GOVERNANCE.md#sealed-credentials-lsb1): the control plane's half, which
 * Studio's own code never carries.
 *
 * Studio opens envelopes and never seals one, so the sealing side lives only here. It runs Encap of
 * DHKEM(X25519, HKDF-SHA256) and a single-shot AES-256-GCM seal at sequence 0 on the key schedule of
 * src/lib/governance/hpke.ts, with the additional authenticated data of src/lib/governance/lsb1.ts, so an envelope
 * it makes is the one a control plane implementing docs/GOVERNANCE.md#sealed-credentials-lsb1 makes for the same
 * inputs.
 *
 * Without `ephemeralPrivateKey` every seal draws a fresh ephemeral key, as a control plane does. With one, the
 * envelope is deterministic, which is what lets a vector record it byte for byte.
 */
import { createCipheriv, diffieHellman, generateKeyPairSync } from "node:crypto";
import {
  extractAndExpand,
  keySchedule,
  x25519PrivateKey,
  x25519PublicKey,
  x25519RawPublicKey,
} from "@/lib/governance/hpke";
import { bindingAad, kidOf, type SecretBinding } from "@/lib/governance/lsb1";

/**
 * The HPKE `info` of every `lsb1` envelope, spelled out here rather than imported, so that a change to Studio's own
 * value breaks every round trip instead of moving both sides together.
 */
const SECRET_INFO = Buffer.from("libredb/bridge/secret/v1", "utf8");

/** The length of the AES-256-GCM tag that ends the sealed part of an envelope. */
const TAG_BYTES = 16;

/**
 * Seals `secret` to the raw 32-byte X25519 public key `publicKey` for `binding` and returns the envelope.
 *
 * An object is sealed as its `JSON.stringify` text, and bytes are sealed as they are, so a test can also seal a
 * plaintext Studio must refuse. `ephemeralPrivateKey` is a raw 32-byte X25519 private key.
 */
export function sealSecret(
  publicKey: Uint8Array,
  binding: SecretBinding,
  secret: Readonly<Record<string, unknown>> | Uint8Array,
  ephemeralPrivateKey?: Uint8Array,
): string {
  const ephemeral =
    ephemeralPrivateKey === undefined
      ? generateKeyPairSync("x25519").privateKey
      : x25519PrivateKey(ephemeralPrivateKey);
  const enc = x25519RawPublicKey(ephemeral);
  const dh = diffieHellman({ privateKey: ephemeral, publicKey: x25519PublicKey(publicKey) });
  const { key, baseNonce } = keySchedule(extractAndExpand(dh, Buffer.concat([enc, publicKey])), SECRET_INFO);
  const kid = kidOf(publicKey);
  const cipher = createCipheriv("aes-256-gcm", key, baseNonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(bindingAad(binding, kid));
  const plaintext = secret instanceof Uint8Array ? secret : Buffer.from(JSON.stringify(secret), "utf8");
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return `lsb1.${kid}.${enc.toString("base64url")}.${sealed.toString("base64url")}`;
}
