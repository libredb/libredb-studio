/**
 * `lsb1` sealed secrets (docs/GOVERNANCE.md#sealed-credentials-lsb1): how Studio opens a credential that a control
 * plane sealed to its public key.
 *
 * An envelope is `lsb1.<kid>.<base64url(enc)>.<base64url(ciphertext || tag)>`. Studio opens it with HPKE (./hpke.ts)
 * under the private key of the kid it names, the `info` string `libredb/bridge/secret/v1`, and additional
 * authenticated data that binds it to one connection id, level, engine, key id and canonical definition
 * (docs/GOVERNANCE.md#sealed-credentials-lsb1). Moved to another row, or opened under a changed definition, it fails
 * with AUTH_FAILED, so a database writer cannot point a stored credential at another host or downgrade its TLS.
 *
 * Studio opens and never seals: nothing here encrypts, and the only sealer is the test one in
 * tests/helpers/governance/lsb1-seal.ts. Every failure to open is a SealedSecretError that carries its code alone.
 */
import { createHash, type KeyObject } from "node:crypto";
import { PLAINTEXT_KEYS, PLAINTEXT_MAX_BYTES } from "./contract";
import { openBase, SealedSecretError } from "./hpke";
import { assertDefinitionValues, canonicalJson } from "./jcs";

export { SealedSecretError };

/** The envelope format: the envelope's prefix, and the `s` of its additional authenticated data. */
const FORMAT_ID = "lsb1";
/** The HPKE `info` of every `lsb1` envelope. */
const SECRET_INFO = Buffer.from("libredb/bridge/secret/v1", "utf8");
/**
 * The envelope form of docs/GOVERNANCE.md#sealed-credentials-lsb1: a 16-digit kid, the 32 bytes of enc in 43
 * characters, and at least the 16 bytes of the tag.
 */
const ENVELOPE_PATTERN = /^lsb1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22,})$/;
const PUBLIC_KEY_BYTES = 32;
const KID_BYTES = 8;

/** The row an envelope is sealed for (docs/GOVERNANCE.md#sealed-credentials-lsb1). */
export interface SecretBinding {
  readonly connectionId: string;
  readonly level: "read" | "write";
  readonly engine: string;
  /** The connection's non-secret definition, in any key order. */
  readonly definition: Readonly<Record<string, unknown>>;
}

/** Studio's private keys, each under the kid of its public key. */
export type Keyring = ReadonlyMap<string, KeyObject>;

type PlaintextKey = (typeof PLAINTEXT_KEYS)[number];

/**
 * An opened credential set: some of the plaintext keys of docs/GOVERNANCE.md#sealed-credentials-lsb1, each with a
 * string value.
 */
export type OpenedSecret = Readonly<Partial<Record<PlaintextKey, string>>>;

const PLAINTEXT_KEY_SET: ReadonlySet<string> = new Set(PLAINTEXT_KEYS);
/** Strict UTF-8: a malformed sequence throws instead of becoming U+FFFD, and a byte order mark stays in the text. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The kid of an X25519 public key: the lowercase hex of the first 8 bytes of the SHA-256 of its raw 32 bytes. */
export function kidOf(publicKey: Uint8Array): string {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new RangeError(`An X25519 public key is ${PUBLIC_KEY_BYTES} bytes, not ${publicKey.length}`);
  }
  return createHash("sha256").update(publicKey).digest().subarray(0, KID_BYTES).toString("hex");
}

/**
 * The additional authenticated data of an envelope sealed with `kid` for `binding`
 * (docs/GOVERNANCE.md#sealed-credentials-lsb1): the UTF-8 of the JCS object `{c, d, e, k, l, s}`, whose `d` is the
 * base64url SHA-256 of the UTF-8 of the canonical definition. A definition outside the values that section admits
 * throws the CanonicalJsonError of `assertDefinitionValues`.
 */
export function bindingAad(binding: SecretBinding, kid: string): Buffer {
  assertDefinitionValues(binding.definition);
  const digest = createHash("sha256").update(canonicalJson(binding.definition), "utf8").digest("base64url");
  const aad = { c: binding.connectionId, d: digest, e: binding.engine, k: kid, l: binding.level, s: FORMAT_ID };
  return Buffer.from(canonicalJson(aad), "utf8");
}

/** The bytes of a base64url field, refused as FORMAT unless the text is their one canonical, unpadded encoding. */
function canonicalBase64url(text: string): Buffer {
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) throw new SealedSecretError("FORMAT");
  return bytes;
}

/**
 * The credential set of docs/GOVERNANCE.md#sealed-credentials-lsb1 in an opened plaintext, refused as PLAINTEXT_INVALID
 * unless it is exactly that.
 */
function parsePlaintext(plaintext: Buffer): OpenedSecret {
  if (plaintext.length > PLAINTEXT_MAX_BYTES) throw new SealedSecretError("PLAINTEXT_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(plaintext));
  } catch {
    throw new SealedSecretError("PLAINTEXT_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SealedSecretError("PLAINTEXT_INVALID");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!PLAINTEXT_KEY_SET.has(key) || typeof value !== "string") throw new SealedSecretError("PLAINTEXT_INVALID");
  }
  return parsed as OpenedSecret;
}

/**
 * Opens `envelope` with the key of its kid in `keyring` for `binding`, and returns the credential set it carries.
 *
 * It fails with a SealedSecretError: FORMAT when the envelope does not have the `lsb1` form, UNKNOWN_KID when the
 * keyring has no key with its kid, LOW_ORDER_POINT when its enc gives no Diffie-Hellman result, AUTH_FAILED when it
 * was sealed to another key or for another binding or was altered, and PLAINTEXT_INVALID when it does not carry a JSON
 * object of at most 65536 bytes whose keys are plaintext keys of docs/GOVERNANCE.md#sealed-credentials-lsb1 and whose
 * values are strings. The binding's definition is admitted before its envelopes are opened
 * (docs/GOVERNANCE.md#row-admission-and-skip-codes), so one outside the values
 * docs/GOVERNANCE.md#sealed-credentials-lsb1 admits is a fault of the caller and throws the CanonicalJsonError of
 * `bindingAad` instead.
 */
export function openSealedSecret(keyring: Keyring, envelope: string, binding: SecretBinding): OpenedSecret {
  const match = ENVELOPE_PATTERN.exec(envelope);
  if (match === null) throw new SealedSecretError("FORMAT");
  const [, kid, encText, ciphertextText] = match;
  const enc = canonicalBase64url(encText);
  const ciphertext = canonicalBase64url(ciphertextText);
  const recipientPrivateKey = keyring.get(kid);
  if (recipientPrivateKey === undefined) throw new SealedSecretError("UNKNOWN_KID");
  const aad = bindingAad(binding, kid);
  return parsePlaintext(openBase({ recipientPrivateKey, enc, info: SECRET_INFO, aad, ciphertext }));
}
