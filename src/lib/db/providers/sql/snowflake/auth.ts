/**
 * Snowflake sign-in: the pasted private key read into one RSA `KeyObject` and its fingerprint, and the bearer tokens.
 *
 * The key is read once, in a fixed order, and every refusal is a fixed sentence raised before any socket: the size,
 * the PEM armour and its label, the body normalised whitespace-insensitively (seeds and API calls bypass the
 * dialog's textarea), whether the DER is encrypted, decided from the DER and not the label, the encryption parameters
 * of an encrypted PKCS#8 read from the DER by this module's own small ASN.1 reader before anything is derived or
 * decrypted, the decryption, and the key type and modulus. A runtime's
 * error message never reaches a sentence: the outcome is chosen from the input's shape and the error code alone, by
 * the code tables below. No field is ever read as a path, and `jose.importPKCS8` never sees user input.
 *
 * Nothing here keeps the PEM text or the passphrase: the loaded key is exactly the `KeyObject` and its fingerprint.
 *
 * A key pair signs RS256 JWTs of 15 minutes, reused until 10 minutes after their `iat` and renewed on demand by the
 * first request at or after that point, with no timer: an idle connection signs nothing. A PAT is its own bearer.
 */
import * as crypto from "node:crypto";
import { SignJWT } from "jose";
import { SNOWFLAKE_FIELD_SENTENCES } from "./account-host";
import { SnowflakeError } from "./errors";

/** The largest key field read, in UTF-8 bytes; a larger one is refused before any parse. */
export const SNOWFLAKE_KEY_MAX_BYTES = 16_384;
export const SNOWFLAKE_RSA_MIN_BITS = 2_048;
export const SNOWFLAKE_RSA_MAX_BITS = 4_096;
/**
 * The PBES2 cost ceiling: OpenSSL's default is 2,048 iterations and scrypt N 16,384, r 8, p 1. The PBKDF2 count is
 * bounded per PRF, so a key at any PRF's ceiling costs about what 1,000,000 SHA-256 iterations do: on Node an
 * iteration of SHA-1 costs up to about twice one of SHA-256, and one of SHA-384 or SHA-512 four to five times.
 */
export const SNOWFLAKE_MAX_PBKDF2_ITERATIONS = {
  sha1: 500_000,
  sha256: 1_000_000,
  sha384: 200_000,
  sha512: 200_000,
} as const;
export const SNOWFLAKE_MAX_SCRYPT_N = 16_384;
export const SNOWFLAKE_MAX_SCRYPT_R = 8;
export const SNOWFLAKE_MAX_SCRYPT_P = 1;
/** A key-pair JWT's lifetime: `exp` is `iat` plus this. Snowflake accepts at most one hour. */
export const SNOWFLAKE_JWT_LIFETIME_S = 900;
/** How long a JWT is reused after its `iat`; the 300 s left before `exp` is the official clients' margin. */
export const SNOWFLAKE_JWT_RENEW_AFTER_S = 600;

/** The longest access token read, in characters; the trial's tokens are about 210, and a longer one is refused. */
export const SNOWFLAKE_TOKEN_MAX_CHARS = 4_096;

/** The refusals of an access token, each raised by `readAccessToken` before any socket. */
export const SNOWFLAKE_TOKEN_SENTENCES = {
  tooLong:
    "The access token is longer than Studio accepts (4,096 characters); a programmatic access token is far shorter. Paste the token alone. Nothing was sent.",
  badCharacters:
    "The access token holds characters a token cannot have, such as a space, a line break or a non-ASCII letter. Paste the token alone. Nothing was sent.",
  keyPairJwt:
    "This is a key-pair JWT, not a programmatic access token: it signs in as the user its key belongs to and expires within the hour. Choose Key pair for Sign-in and paste the private key instead. Nothing was sent.",
} as const;

/** Each key type's article and name in the not-RSA sentence. */
const KEY_TYPE_NAMES: Readonly<Record<string, string>> = {
  ec: "an EC",
  ed25519: "an Ed25519",
  ed448: "an Ed448",
  dsa: "a DSA",
};

export const SNOWFLAKE_KEY_SENTENCES = {
  keyEmpty: "Paste the private key for key-pair sign-in. Nothing was sent.",
  tooLarge: "The private key is larger than Studio accepts (16 KiB). Nothing was sent.",
  publicKey:
    "This is the public key. Paste the private key; the public key is what you register on the Snowflake user. Nothing was sent.",
  notPem: "The private key is not a PEM key. Paste the key's contents, starting with -----BEGIN. Nothing was sent.",
  manyBlocks:
    "The private key field holds more than one PEM block. Paste the private key's block alone, from -----BEGIN to -----END. Nothing was sent.",
  truncated: "The private key ends before its -----END line. Paste the whole key. Nothing was sent.",
  certificate:
    "This is a certificate, not a private key. Paste the private key whose public key is registered on the Snowflake user. Nothing was sent.",
  otherBlock:
    "This PEM block is not a private key Studio reads. Paste an RSA private key armoured as PRIVATE KEY, ENCRYPTED PRIVATE KEY or RSA PRIVATE KEY. Nothing was sent.",
  kdfCost:
    "This key's encryption is set to cost more work than Studio allows. Re-encrypt it with openssl pkcs8 -topk8 -v2 aes-256-cbc. Nothing was sent.",
  scheme:
    "This key is encrypted with a scheme Studio does not read, such as PBES1 or a PKCS#12 one; Studio reads PBES2 with PBKDF2 or scrypt and AES-CBC. Re-encrypt it with openssl pkcs8 -topk8 -v2 aes-256-cbc. Nothing was sent.",
  needsPassphrase: "This key is encrypted; enter its passphrase. Nothing was sent.",
  wrongPassphrase: "The passphrase does not open this key. Nothing was sent.",
  unreadable: "Studio could not read this private key. Nothing was sent.",
  notRsa: (type: string | undefined) =>
    `Studio signs with RSA keys only; this is ${
      type === undefined ? "an unknown" : (KEY_TYPE_NAMES[type] ?? `a ${type}`)
    } key. Nothing was sent.`,
  short: "Snowflake needs an RSA key of at least 2048 bits. Nothing was sent.",
  long: (bits: number) => `Studio accepts RSA keys up to 4096 bits; this key is ${bits} bits. Nothing was sent.`,
} as const;

/**
 * The codes a missing passphrase throws: Bun's, and Node 24's and 26's (OpenSSL 3 reports the cancelled prompt).
 * `key-runtimes.test.ts` measures the sentence each runtime's code reads as.
 */
const MISSING_PASSPHRASE_CODES: ReadonlySet<string> = new Set([
  "ERR_MISSING_PASSPHRASE",
  "ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED",
]);
/** The codes a wrong passphrase throws on Bun and Node, and OpenSSL's older EVP spelling. */
const WRONG_PASSPHRASE_CODES: ReadonlySet<string> = new Set(["ERR_OSSL_BAD_DECRYPT", "ERR_OSSL_EVP_BAD_DECRYPT"]);
/**
 * A wrong passphrase can decrypt an encrypted key to random bytes, and about one time in 256 their padding holds and
 * the decoder refuses them. OpenSSL 4 reports ERR_OSSL_ASN1_* codes; OpenSSL 3 and Bun's BoringSSL report their decoder
 * codes (measured 2026-10-13: 15 to 22 of 4,000 wrong passphrases on Node 24.14.0 and Bun 1.4.2). These codes mean
 * wrong passphrase only for an encrypted key when one was supplied; elsewhere unreadable.
 */
const GARBLED_DECRYPT_CODE_PREFIX = "ERR_OSSL_ASN1_";
const GARBLED_DECRYPT_CODES: ReadonlySet<string> = new Set(["ERR_OSSL_UNSUPPORTED", "ERR_OSSL_EVP_DECODE_ERROR"]);

export interface SnowflakeKeyFingerprint {
  /** `SHA256:` and the standard base64 of SHA-256 over the DER SPKI, as Snowflake shows RSA_PUBLIC_KEY_FP. */
  readonly text: string;
  /** The first 8 hex characters of the same digest. */
  readonly hex8: string;
  /** The DER SPKI as one base64 line, the value `ALTER USER ... SET RSA_PUBLIC_KEY` takes. */
  readonly publicKeyBody: string;
}

export interface LoadedKey {
  readonly key: crypto.KeyObject;
  readonly fingerprint: SnowflakeKeyFingerprint;
}

function refuse(sentence: string): never {
  throw new SnowflakeError("config", sentence);
}

// --- Armour and normalisation --------------------------------------------------------------------------------------

const PRIVATE_LABELS = new Set(["PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "RSA PRIVATE KEY"]);
const PUBLIC_LABELS = new Set(["PUBLIC KEY", "RSA PUBLIC KEY"]);
/** The other labels a pasted block is known by, each with the sentence that names what it is. */
const OTHER_LABEL_SENTENCES: ReadonlyMap<string, string> = new Map([
  ["EC PRIVATE KEY", SNOWFLAKE_KEY_SENTENCES.notRsa("ec")],
  ["DSA PRIVATE KEY", SNOWFLAKE_KEY_SENTENCES.notRsa("dsa")],
  ["CERTIFICATE", SNOWFLAKE_KEY_SENTENCES.certificate],
  ["TRUSTED CERTIFICATE", SNOWFLAKE_KEY_SENTENCES.certificate],
  ["X509 CERTIFICATE", SNOWFLAKE_KEY_SENTENCES.certificate],
]);
const BEGIN = /-----BEGIN ([A-Z0-9 ]+)-----/g;
const END = /-----END ([A-Z0-9 ]+)-----/g;
const PROC_TYPE = /^Proc-Type:[ \t]*(\S+)\s+/;
const DEK_INFO = /^DEK-Info:[ \t]*(\S+)\s+/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface Armoured {
  readonly label: string;
  readonly pem: string;
  readonly der: Buffer;
  readonly encrypted: boolean;
}

/**
 * The one PEM block of `text`, normalised: headers on their own lines, the body re-wrapped at 64 characters. Only a
 * text with no PEM armour at all is "not a PEM key": a second block, a block of another kind (named by its label), a
 * missing END line and a broken block each have their own sentence.
 */
function readArmour(text: string): Armoured {
  const begins = [...text.matchAll(BEGIN)];
  const ends = [...text.matchAll(END)];
  if (begins.length === 0) refuse(SNOWFLAKE_KEY_SENTENCES.notPem);
  if (begins.length > 1 || ends.length > 1) refuse(SNOWFLAKE_KEY_SENTENCES.manyBlocks);
  const [begin] = begins;
  const label = begin[1];
  if (PUBLIC_LABELS.has(label)) refuse(SNOWFLAKE_KEY_SENTENCES.publicKey);
  if (!PRIVATE_LABELS.has(label)) refuse(OTHER_LABEL_SENTENCES.get(label) ?? SNOWFLAKE_KEY_SENTENCES.otherBlock);
  if (ends.length === 0) refuse(SNOWFLAKE_KEY_SENTENCES.truncated);
  const [end] = ends;
  if (end[1] !== label || end.index < begin.index) refuse(SNOWFLAKE_KEY_SENTENCES.unreadable);

  let inner = `${text.slice(begin.index + begin[0].length, end.index).trim()}\n`;
  const headers: string[] = [];
  let encrypted = label === "ENCRYPTED PRIVATE KEY";
  const procType = PROC_TYPE.exec(inner);
  if (procType !== null) {
    headers.push(`Proc-Type: ${procType[1]}`);
    encrypted = encrypted || procType[1].toUpperCase().endsWith(",ENCRYPTED");
    inner = inner.slice(procType[0].length);
    const dekInfo = DEK_INFO.exec(inner);
    if (dekInfo !== null) {
      headers.push(`DEK-Info: ${dekInfo[1]}`);
      inner = inner.slice(dekInfo[0].length);
    }
  }
  const body = inner.replace(/\s+/g, "");
  if (body === "" || !BASE64.test(body)) refuse(SNOWFLAKE_KEY_SENTENCES.unreadable);

  const lines = body.match(/.{1,64}/g) as string[];
  const head = headers.length > 0 ? `${headers.join("\n")}\n\n` : "";
  const pem = `-----BEGIN ${label}-----\n${head}${lines.join("\n")}\n-----END ${label}-----\n`;
  return { label, pem, der: Buffer.from(body, "base64"), encrypted };
}

// --- The ASN.1 reader -----------------------------------------------------------------------------------------------

/** A DER this reader cannot read; mapped to the unreadable sentence. */
class MalformedDer extends Error {}

const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;

interface Tlv {
  readonly tag: number;
  /** The content's first byte and one past its last. */
  readonly start: number;
  readonly end: number;
}

/**
 * One TLV at `offset`, which must end by `limit`: a one-byte tag (no high tag number), a definite length of at most
 * four bytes. Every read is bounds-checked. The reader walks only the fixed path of EncryptedPrivateKeyInfo, so its
 * nesting is bounded by that structure and never by the input.
 */
function readTlv(der: Buffer, offset: number, limit: number): Tlv {
  if (offset + 2 > limit) throw new MalformedDer();
  const tag = der[offset];
  if ((tag & 0x1f) === 0x1f) throw new MalformedDer();
  const first = der[offset + 1];
  let start = offset + 2;
  let length = first;
  if (first >= 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || start + count > limit) throw new MalformedDer();
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + der[start + index];
    start += count;
  }
  if (start + length > limit) throw new MalformedDer();
  return { tag, start, end: start + length };
}

/** The TLVs inside a constructed TLV, which must hold `tag`, covering its content exactly. */
function children(der: Buffer, parent: Tlv, tag: number): Tlv[] {
  if (parent.tag !== tag) throw new MalformedDer();
  const found: Tlv[] = [];
  for (let offset = parent.start; offset < parent.end; ) {
    const child = readTlv(der, offset, parent.end);
    found.push(child);
    offset = child.end;
  }
  return found;
}

function sequence(der: Buffer, parent: Tlv | undefined, min: number): Tlv[] {
  if (parent === undefined) throw new MalformedDer();
  const found = children(der, parent, TAG_SEQUENCE);
  if (found.length < min) throw new MalformedDer();
  return found;
}

// BigInt(...) calls rather than literals: the build targets below ES2020.
const BIG_0 = BigInt(0);
const BIG_2 = BigInt(2);
const BIG_7 = BigInt(7);
const BIG_40 = BigInt(40);
const BIG_80 = BigInt(80);

function oid(der: Buffer, node: Tlv | undefined): string {
  if (node === undefined || node.tag !== TAG_OID || node.end === node.start) throw new MalformedDer();
  const arcs: bigint[] = [];
  let value = BIG_0;
  for (let index = node.start; index < node.end; index++) {
    value = (value << BIG_7) | BigInt(der[index] & 0x7f);
    if ((der[index] & 0x80) === 0) {
      arcs.push(value);
      value = BIG_0;
    } else if (index === node.end - 1) throw new MalformedDer();
  }
  const [head, ...rest] = arcs;
  const first = head < BIG_80 ? head / BIG_40 : BIG_2;
  return [first, head - first * BIG_40, ...rest].join(".");
}

function integer(der: Buffer, node: Tlv | undefined): bigint {
  if (node === undefined || node.tag !== TAG_INTEGER || node.end === node.start) throw new MalformedDer();
  const value = BigInt(`0x${der.subarray(node.start, node.end).toString("hex")}`);
  const negative = (der[node.start] & 0x80) !== 0;
  return negative ? value - BigInt(`0x1${"00".repeat(node.end - node.start)}`) : value;
}

const PBES2 = "1.2.840.113549.1.5.13";
const PBKDF2 = "1.2.840.113549.1.5.12";
const SCRYPT = "1.3.6.1.4.1.11591.4.11";
/** hmacWithSHA1, SHA256, SHA384, SHA512, each with its iteration ceiling. */
const PBKDF2_PRFS: ReadonlyMap<string, number> = new Map([
  ["1.2.840.113549.2.7", SNOWFLAKE_MAX_PBKDF2_ITERATIONS.sha1],
  ["1.2.840.113549.2.9", SNOWFLAKE_MAX_PBKDF2_ITERATIONS.sha256],
  ["1.2.840.113549.2.10", SNOWFLAKE_MAX_PBKDF2_ITERATIONS.sha384],
  ["1.2.840.113549.2.11", SNOWFLAKE_MAX_PBKDF2_ITERATIONS.sha512],
]);
/** AES-128-CBC, AES-192-CBC, AES-256-CBC. */
const AES_CBC = new Set(["2.16.840.1.101.3.4.1.2", "2.16.840.1.101.3.4.1.22", "2.16.840.1.101.3.4.1.42"]);

/** What the encryption parameters allow: a key to decrypt, a cost over the ceiling, or a scheme Studio does not read. */
type EncryptionVerdict = "allowed" | "cost" | "scheme";

/** The PBKDF2 parameters' verdict: the PRF one of the four or absent (SHA-1), and the count under its ceiling. */
function pbkdf2Verdict(der: Buffer, params: Tlv | undefined): EncryptionVerdict {
  const [salt, iterations, ...rest] = sequence(der, params, 2);
  if (salt.tag !== TAG_OCTET_STRING) return "scheme";
  const optional = rest[0]?.tag === TAG_INTEGER ? rest.slice(1) : rest;
  if (optional.length > 1) return "scheme";
  const ceiling =
    optional.length === 0
      ? SNOWFLAKE_MAX_PBKDF2_ITERATIONS.sha1
      : PBKDF2_PRFS.get(oid(der, sequence(der, optional[0], 1)[0]));
  if (ceiling === undefined) return "scheme";
  return integer(der, iterations) <= BigInt(ceiling) ? "allowed" : "cost";
}

function scryptVerdict(der: Buffer, params: Tlv | undefined): EncryptionVerdict {
  const [salt, n, r, p] = sequence(der, params, 4);
  if (salt.tag !== TAG_OCTET_STRING) return "scheme";
  return integer(der, n) <= BigInt(SNOWFLAKE_MAX_SCRYPT_N) &&
    integer(der, r) <= BigInt(SNOWFLAKE_MAX_SCRYPT_R) &&
    integer(der, p) <= BigInt(SNOWFLAKE_MAX_SCRYPT_P)
    ? "allowed"
    : "cost";
}

/**
 * Whether an EncryptedPrivateKeyInfo is PBES2 with PBKDF2 or scrypt under the ceiling and an AES-CBC cipher. Every
 * other outer algorithm (PBES1 and the PKCS#12 schemes included), KDF, PRF or cipher is a scheme this module does not
 * read, refused before anything is derived, as a cost over the ceiling is. Throws `MalformedDer` for a DER it cannot
 * read.
 */
function encryptionVerdict(der: Buffer): EncryptionVerdict {
  const top = readTlv(der, 0, der.length);
  if (top.end !== der.length) throw new MalformedDer();
  const [algorithm, data] = sequence(der, top, 2);
  if (data.tag !== TAG_OCTET_STRING) throw new MalformedDer();
  const [algorithmId, algorithmParams] = sequence(der, algorithm, 1);
  if (oid(der, algorithmId) !== PBES2) return "scheme";
  const [kdf, cipher] = sequence(der, algorithmParams, 2);
  const [kdfId, kdfParams] = sequence(der, kdf, 1);
  const kdfOid = oid(der, kdfId);
  if (kdfOid !== PBKDF2 && kdfOid !== SCRYPT) return "scheme";
  if (!AES_CBC.has(oid(der, sequence(der, cipher, 1)[0]))) return "scheme";
  return kdfOid === PBKDF2 ? pbkdf2Verdict(der, kdfParams) : scryptVerdict(der, kdfParams);
}

/** Whether the DER is a SEQUENCE whose first child is an INTEGER, as PrivateKeyInfo's and RSAPrivateKey's version is. */
function versionFirst(der: Buffer): boolean {
  const [first] = sequence(der, readTlv(der, 0, der.length), 1);
  return first.tag === TAG_INTEGER;
}

/**
 * The armour with its label decided from the DER: Node's OpenSSL decrypts an EncryptedPrivateKeyInfo armoured as
 * `PRIVATE KEY` too, so such a body is read as `ENCRYPTED PRIVATE KEY` and meets the ceiling. Any other unencrypted
 * body must begin with a version, and an `RSA PRIVATE KEY` body that does not is refused as unreadable.
 */
function asEncryptedWhereTheDerIs(armoured: Armoured): Armoured {
  if (armoured.encrypted) return armoured;
  let plain: boolean;
  try {
    plain = versionFirst(armoured.der);
  } catch {
    refuse(SNOWFLAKE_KEY_SENTENCES.unreadable);
  }
  if (plain) return armoured;
  if (armoured.label !== "PRIVATE KEY") refuse(SNOWFLAKE_KEY_SENTENCES.unreadable);
  const label = "ENCRYPTED PRIVATE KEY";
  return { ...armoured, label, pem: armoured.pem.replace(/(BEGIN|END) PRIVATE KEY/g, `$1 ${label}`), encrypted: true };
}

// --- Intake ---------------------------------------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function fingerprintOf(key: crypto.KeyObject): SnowflakeKeyFingerprint {
  const spki = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
  const digest = crypto.createHash("sha256").update(spki).digest();
  return {
    text: `SHA256:${digest.toString("base64")}`,
    hex8: digest.toString("hex").slice(0, 8),
    publicKeyBody: spki.toString("base64"),
  };
}

/**
 * The pasted private key as one RSA `KeyObject` and its fingerprint, or a `config` refusal with a fixed sentence.
 * An empty passphrase reads as absent.
 */
export function loadPrivateKey(pem: unknown, passphrase: unknown): LoadedKey {
  if (typeof pem !== "string" || pem === "") refuse(SNOWFLAKE_KEY_SENTENCES.keyEmpty);
  if (Buffer.byteLength(pem, "utf8") > SNOWFLAKE_KEY_MAX_BYTES) refuse(SNOWFLAKE_KEY_SENTENCES.tooLarge);

  const armoured = asEncryptedWhereTheDerIs(readArmour(pem));
  if (armoured.label === "ENCRYPTED PRIVATE KEY") {
    let verdict: EncryptionVerdict;
    try {
      verdict = encryptionVerdict(armoured.der);
    } catch {
      refuse(SNOWFLAKE_KEY_SENTENCES.unreadable);
    }
    if (verdict === "scheme") refuse(SNOWFLAKE_KEY_SENTENCES.scheme);
    if (verdict === "cost") refuse(SNOWFLAKE_KEY_SENTENCES.kdfCost);
  }

  const pass = typeof passphrase === "string" && passphrase !== "" ? passphrase : undefined;
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({
      key: armoured.pem,
      format: "pem",
      ...(pass === undefined ? {} : { passphrase: pass }),
    });
  } catch (error) {
    const code = errorCode(error);
    if ((armoured.encrypted && pass === undefined) || (code !== undefined && MISSING_PASSPHRASE_CODES.has(code))) {
      refuse(SNOWFLAKE_KEY_SENTENCES.needsPassphrase);
    }
    if (
      pass !== undefined &&
      code !== undefined &&
      (WRONG_PASSPHRASE_CODES.has(code) ||
        (armoured.encrypted && (code.startsWith(GARBLED_DECRYPT_CODE_PREFIX) || GARBLED_DECRYPT_CODES.has(code))))
    ) {
      refuse(SNOWFLAKE_KEY_SENTENCES.wrongPassphrase);
    }
    refuse(SNOWFLAKE_KEY_SENTENCES.unreadable);
  }

  if (key.asymmetricKeyType !== "rsa") refuse(SNOWFLAKE_KEY_SENTENCES.notRsa(key.asymmetricKeyType));
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < SNOWFLAKE_RSA_MIN_BITS) refuse(SNOWFLAKE_KEY_SENTENCES.short);
  if (bits > SNOWFLAKE_RSA_MAX_BITS) refuse(SNOWFLAKE_KEY_SENTENCES.long(bits));

  return { key, fingerprint: fingerprintOf(key) };
}

// --- Tokens ---------------------------------------------------------------------------------------------------------

export interface SnowflakeTokenSource {
  readonly tokenType: "KEYPAIR_JWT" | "PROGRAMMATIC_ACCESS_TOKEN";
  /**
   * The current bearer; a key pair signs a new one on demand at or after 600 s past the current one's iat, single
   * flight.
   */
  token(): Promise<string>;
}

/** The JWT claim's two parts: the account claim and the login name, both upper-cased. */
export function jwtClaim(accountClaim: string, user: string): { readonly account: string; readonly user: string } {
  return { account: accountClaim.toUpperCase(), user: user.toUpperCase() };
}

/**
 * Key-pair tokens: `iss` is `<ACCOUNT>.<USER>.SHA256:<fingerprint>`, `sub` is `<ACCOUNT>.<USER>`, `iat` is `now()`
 * in whole seconds with no backdating and no forward margin. The current token is reused while it is younger than
 * `SNOWFLAKE_JWT_RENEW_AFTER_S`, and also when the clock went back; concurrent callers share one signing, and a failed
 * signing is not kept, so the next call signs again.
 */
export function keyPairTokenSource(
  key: LoadedKey,
  claim: { readonly account: string; readonly user: string },
  now: () => number,
): SnowflakeTokenSource {
  const subject = `${claim.account}.${claim.user}`;
  const issuer = `${subject}.${key.fingerprint.text}`;
  let current: { readonly token: string; readonly iat: number } | null = null;
  let pending: Promise<string> | null = null;

  const sign = async (iat: number): Promise<string> => {
    const token = await new SignJWT({ iss: issuer, sub: subject, iat, exp: iat + SNOWFLAKE_JWT_LIFETIME_S })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .sign(key.key);
    current = { token, iat };
    return token;
  };

  return {
    tokenType: "KEYPAIR_JWT",
    token() {
      const nowS = Math.floor(now() / 1000);
      if (current !== null && nowS - current.iat < SNOWFLAKE_JWT_RENEW_AFTER_S) return Promise.resolve(current.token);
      if (pending === null) {
        pending = sign(nowS).finally(() => {
          pending = null;
        });
      }
      return pending;
    },
  };
}

/** What only a key-pair JWT's `iss` claim holds: the key fingerprint after `<ACCOUNT>.<USER>`. */
const KEY_PAIR_ISSUER = /\.SHA256:/;

/**
 * Whether the text is a key-pair JWT: three `.`-separated parts whose middle one is base64url JSON with an `iss`
 * holding `.SHA256:`. The signature is not verified and nothing else of a token is read: a PAT's format is
 * Snowflake's, and the trial's PATs are JWTs too, whose `iss` has no fingerprint.
 */
function isKeyPairJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return false;
  }
  const iss = typeof payload === "object" && payload !== null ? (payload as { iss?: unknown }).iss : undefined;
  return typeof iss === "string" && KEY_PAIR_ISSUER.test(iss);
}

/** A copied `Authorization` value's scheme, which a curl example puts before the token. */
const BEARER_PREFIX = /^Bearer(?:\s+|$)/i;
/** What a token can hold: printable ASCII with no space, the characters an HTTP header carries unchanged. */
const TOKEN_CHARACTERS = /^[\x21-\x7e]+$/;

/**
 * The Access token field as the bearer Studio sends, or a `config` refusal before any socket. Surrounding whitespace
 * and line breaks (a seed's file, a paste) and a leading `Bearer ` come off; then a token longer than
 * `SNOWFLAKE_TOKEN_MAX_CHARS` or holding a character a header cannot carry is refused, since Node refuses such a header
 * and Snowflake's gateway answers an oversized one with a bare 431. A key-pair JWT pasted there is refused too, since
 * Snowflake accepts it as a token and it signs in as its own user until its `exp`.
 */
export function readAccessToken(value: string): string {
  const token = value.trim().replace(BEARER_PREFIX, "").trim();
  if (token === "") refuse(SNOWFLAKE_FIELD_SENTENCES.tokenEmpty);
  if (token.length > SNOWFLAKE_TOKEN_MAX_CHARS) refuse(SNOWFLAKE_TOKEN_SENTENCES.tooLong);
  if (!TOKEN_CHARACTERS.test(token)) refuse(SNOWFLAKE_TOKEN_SENTENCES.badCharacters);
  if (isKeyPairJwt(token)) refuse(SNOWFLAKE_TOKEN_SENTENCES.keyPairJwt);
  return token;
}

/** A programmatic access token, sent as its own bearer. */
export function patTokenSource(pat: string): SnowflakeTokenSource {
  return { tokenType: "PROGRAMMATIC_ACCESS_TOKEN", token: () => Promise.resolve(pat) };
}
