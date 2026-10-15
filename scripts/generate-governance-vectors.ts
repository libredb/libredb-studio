#!/usr/bin/env bun
/**
 * Writes tests/fixtures/governance/lsb1-vectors.json, the test vectors of `lsb1` sealed credentials
 * (docs/GOVERNANCE.md#sealed-credentials-lsb1), with the test sealer in tests/helpers/governance/lsb1-seal.ts.
 *
 * A control plane vendors this file from a Studio release, pinned by its SHA-256, and tests its sealer against it:
 * from each vector's recipient public key, binding, plaintext and fixed ephemeral key it must seal the vector's
 * envelope byte for byte, and its canonical JSON and additional authenticated data must give the vector's
 * definitionJcs and aadHex. The negative vectors pin the code Studio answers for each way an envelope can be wrong:
 * Studio is given `opening.envelope` for `opening.binding`, which a negative vector changes in exactly one respect.
 *
 * Nothing here is random. Every private key is the SHA-256 of a published label that marks it as a test key, so the
 * file is the same on every run and every machine, and no key in it protects anything. The file is committed and never
 * edited by hand, and a published `lsb1` vector never changes: a change to one is a new format, `lsb2`.
 * tests/unit/governance-lsb1-vectors.test.ts regenerates the file in memory and fails on any byte of difference.
 *
 * Run: bun scripts/generate-governance-vectors.ts --write | --check [--out <file>]
 * --write writes the vectors, --check exits 1 when the file differs from what this script builds (an absent file
 * included), and --out names another file for either, resolved against the working directory.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type EnvelopeCode, x25519PrivateKey, x25519RawPublicKey } from "../src/lib/governance/hpke";
import { canonicalJson } from "../src/lib/governance/jcs";
import { bindingAad, kidOf, type SecretBinding } from "../src/lib/governance/lsb1";
import { sealSecret } from "../tests/helpers/governance/lsb1-seal";

/** The vectors' path in the repository, which is also where a control plane finds them in a release. */
export const LSB1_VECTORS_FILE = "tests/fixtures/governance/lsb1-vectors.json";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WRITE_COMMAND = "bun scripts/generate-governance-vectors.ts --write";
const USAGE = "Usage: bun scripts/generate-governance-vectors.ts --write | --check [--out <file>]";

/**
 * The labels of the test keys. Each private key is the SHA-256 of the UTF-8 of its label, `<id>` standing for the
 * vector's id, so anyone can derive it: that is the point, since a key in this file is published and protects nothing.
 */
const TEST_KEY_LABELS = {
  recipient: "libredb lsb1 test vectors, test only: recipient key",
  otherRecipient: "libredb lsb1 test vectors, test only: other recipient key",
  ephemeral: "libredb lsb1 test vectors, test only: ephemeral key of <id>",
} as const;

/** The raw X25519 private key of a label: the SHA-256 of its UTF-8. */
function testKey(label: string): Buffer {
  return createHash("sha256").update(label, "utf8").digest();
}

/** The key the keyring holds, and the key of a recipient whose kid the keyring does not have. */
const RECIPIENT_PRIVATE_KEY = testKey(TEST_KEY_LABELS.recipient);
const RECIPIENT_PUBLIC_KEY = x25519RawPublicKey(x25519PrivateKey(RECIPIENT_PRIVATE_KEY));
const OTHER_RECIPIENT_PUBLIC_KEY = x25519RawPublicKey(x25519PrivateKey(testKey(TEST_KEY_LABELS.otherRecipient)));

/**
 * A self-signed certificate made for these vectors alone, whose private key was discarded: a realistic `ssl.caCert`,
 * with a line break after each line, the last one included, as `openssl x509` writes it.
 */
const TEST_CA_CERT = [
  "-----BEGIN CERTIFICATE-----",
  "MIIB6TCCAY+gAwIBAgIULztdOyUdoQdOBbH3vKcqg/5DaVgwCgYIKoZIzj0EAwIw",
  "SjEdMBsGA1UECgwUTGlicmVEQiB0ZXN0IHZlY3RvcnMxKTAnBgNVBAMMIGxzYjEg",
  "dGVzdCB2ZWN0b3JzIENBICh0ZXN0IG9ubHkpMB4XDTI2MTAxNTAwMTk0N1oXDTM2",
  "MTAxMjAwMTk0N1owSjEdMBsGA1UECgwUTGlicmVEQiB0ZXN0IHZlY3RvcnMxKTAn",
  "BgNVBAMMIGxzYjEgdGVzdCB2ZWN0b3JzIENBICh0ZXN0IG9ubHkpMFkwEwYHKoZI",
  "zj0CAQYIKoZIzj0DAQcDQgAEs/CeL2Lzkvg32HxlTIbgSQBuloYcXfora5NKPiXq",
  "fKmWz9E599GLCtkCQE7TuNRdKsqbR0X99fSqzJ5eQ9v7CKNTMFEwHQYDVR0OBBYE",
  "FIeqDkD11lGyzQtvaqZTYO7dl3FIMB8GA1UdIwQYMBaAFIeqDkD11lGyzQtvaqZT",
  "YO7dl3FIMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgLB0FGQ1k",
  "OEw5FegGXM3DQkl+pdZWkGKnEA90c1gfal0CIQCMDI3GogqDhoo1lmUxYbO9LKS4",
  "YhuM4httlmLce3QwNg==",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

/** How one vector is made: sealed for `binding`, then given to Studio as `alter` and `openFor` say. */
interface VectorSpec {
  readonly id: string;
  readonly description: string;
  readonly binding: SecretBinding;
  /** Sealed as its JSON text, whose keys are listed in canonical order so that the text is also canonical JSON. */
  readonly plaintext: Readonly<Record<string, unknown>>;
  /** Sealed to the recipient whose kid the keyring does not hold, rather than to the keyring's key. */
  readonly sealedToOtherRecipient?: true;
  /** The envelope Studio is given, made from the sealed one; the sealed one itself when absent. */
  readonly alter?: (envelope: string) => string;
  /** The binding Studio opens the envelope for; the one it was sealed for when absent. */
  readonly openFor?: SecretBinding;
  /** `ok` when Studio opens the envelope to `plaintext`, otherwise the code it fails with. */
  readonly expected: "ok" | EnvelopeCode;
}

/** The four fields of an envelope the sealer made: its prefix, kid, enc and sealed part. */
function fieldsOf(envelope: string): string[] {
  const fields = envelope.split(".");
  if (fields.length !== 4) throw new Error(`A sealed envelope has 4 fields, not ${fields.length}`);
  return fields;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The envelope with the last character of its enc moved one place along the base64url alphabet. The 32 bytes of enc
 * leave that character four bits of data and two padding bits, which the canonical encoding keeps zero, so one place
 * along sets a padding bit: the text still decodes to the same bytes but is no longer their encoding.
 */
function nonCanonicalEnc(envelope: string): string {
  const [prefix, kid, enc, sealed] = fieldsOf(envelope);
  const nudged = BASE64URL_ALPHABET[BASE64URL_ALPHABET.indexOf(enc.slice(-1)) + 1];
  return [prefix, kid, enc.slice(0, -1) + nudged, sealed].join(".");
}

/** The envelope with both base64url fields written in padded standard base64 instead. */
function paddedStandardBase64(envelope: string): string {
  const [prefix, kid, enc, sealed] = fieldsOf(envelope);
  const standard = (field: string): string => Buffer.from(field, "base64url").toString("base64");
  return [prefix, kid, standard(enc), standard(sealed)].join(".");
}

/** The envelope with the lowest bit of its first ciphertext byte flipped. */
function flipFirstCiphertextBit(envelope: string): string {
  const [prefix, kid, enc, sealed] = fieldsOf(envelope);
  const bytes = Buffer.from(sealed, "base64url");
  bytes[0] ^= 0x01;
  return [prefix, kid, enc, bytes.toString("base64url")].join(".");
}

/** A change that gives the envelope the enc `hex` in place of its own. */
function withEnc(hex: string): (envelope: string) => string {
  return (envelope) => {
    const [prefix, kid, , sealed] = fieldsOf(envelope);
    return [prefix, kid, Buffer.from(hex, "hex").toString("base64url"), sealed].join(".");
  };
}

/** The read credential every negative vector seals, so that each one departs from a good envelope in one respect. */
const APP_READ: SecretBinding = {
  connectionId: "2334697a-496a-4e5d-900e-fb2794e06be8",
  level: "read",
  engine: "postgres",
  definition: {
    host: "pg.example.internal",
    port: 5432,
    database: "app",
    ssl: { mode: "verify-full", rejectUnauthorized: true },
  },
};
const APP_READER = { password: "app reader password", user: "app_reader" };

const VECTORS: readonly VectorSpec[] = [
  {
    id: "canary",
    description:
      'The seal canary a control plane publishes for each key id it seals to: {"user":"libredb-canary"} sealed for connection canary, level read, engine canary and definition {}.',
    binding: { connectionId: "canary", level: "read", engine: "canary", definition: {} },
    plaintext: { user: "libredb-canary" },
    expected: "ok",
  },
  {
    id: "unicode",
    description:
      "Text beyond ASCII in the definition and in the credential, written as UTF-8 and never escaped: Turkish letters, CJK ideographs, and U+20BB7, which UTF-16 writes as a surrogate pair.",
    binding: {
      connectionId: "ebf0da7a-f742-408a-ab86-0508104b7167",
      level: "read",
      engine: "postgres",
      definition: { host: "pg.example.internal", port: 5432, database: "müşteri_kayıtları", schema: "𠮷野家_販売" },
    },
    plaintext: { password: "şifre ğüşıöç 𠮷", user: "gülşen" },
    expected: "ok",
  },
  {
    id: "json-escapes",
    description:
      "Characters canonical JSON escapes, and characters it writes as they are: the quote, the backslash and the controls U+0009, U+0001 and U+001F are escaped, while the solidus, <, > and & are not, as ECMAScript's JSON.stringify writes them.",
    binding: {
      connectionId: "28bb75dd-c647-4d94-8270-e716a6cd152d",
      level: "read",
      engine: "mysql",
      definition: {
        host: "mysql.example.internal",
        port: 3306,
        database: 'r&d <eu> "reports"/2026\\q4',
        schema: "tab\tcontrol\u0001\u001f",
      },
    },
    plaintext: { password: 'quote " and backslash \\ and solidus /', user: "report_reader" },
    expected: "ok",
  },
  {
    id: "nested-ssl-pem",
    description:
      "A nested ssl object whose caCert is a PEM certificate of several lines: the keys of the nested object are sorted too, and each line break is escaped as \\n.",
    binding: {
      connectionId: "5fadf643-4004-4574-ab1c-32eac23aff82",
      level: "read",
      engine: "postgres",
      definition: {
        host: "pg.example.internal",
        port: 5432,
        database: "orders",
        ssl: { mode: "verify-full", rejectUnauthorized: true, caCert: TEST_CA_CERT },
      },
    },
    plaintext: { password: "orders reader password", user: "orders_reader" },
    expected: "ok",
  },
  {
    id: "numbers",
    description:
      'An integer and booleans, bound as a JSON number and JSON literals: the port 65535 is not the string "65535", and true and false are not strings either.',
    binding: {
      connectionId: "02575005-ae8f-4d75-a30b-9c2d817c3ab9",
      level: "read",
      engine: "mssql",
      definition: {
        host: "mssql.example.internal",
        port: 65535,
        instanceName: "REPORTING",
        skipObjectScan: false,
        ssl: { mode: "require", rejectUnauthorized: true },
      },
    },
    plaintext: { password: "report reader password", user: "report_reader" },
    expected: "ok",
  },
  {
    id: "key-order",
    description:
      "One definition sealed with its keys, and those of its nested ssl object, in one order and opened with them in another: canonical JSON sorts the keys of every object, so the envelope opens.",
    binding: {
      connectionId: "bbb2d3b5-3b8b-483a-a585-aa09140f6a5f",
      level: "read",
      engine: "oracle",
      definition: {
        ssl: { rejectUnauthorized: true, mode: "verify-ca" },
        serviceName: "ORCLPDB1",
        port: 1521,
        host: "oracle.example.internal",
      },
    },
    openFor: {
      connectionId: "bbb2d3b5-3b8b-483a-a585-aa09140f6a5f",
      level: "read",
      engine: "oracle",
      definition: {
        host: "oracle.example.internal",
        port: 1521,
        serviceName: "ORCLPDB1",
        ssl: { mode: "verify-ca", rejectUnauthorized: true },
      },
    },
    plaintext: { password: "erp reader password", user: "erp_reader" },
    expected: "ok",
  },
  {
    id: "write-level",
    description:
      "A connection's write credential, sealed for the level write, so it opens only as the write credential.",
    binding: {
      connectionId: "a3244521-3e72-416f-9fed-23b24abb70ac",
      level: "write",
      engine: "mongodb",
      definition: { host: "mongo.example.internal", port: 27017, database: "app", authSource: "admin" },
    },
    plaintext: { password: "app writer password", user: "app_writer" },
    expected: "ok",
  },
  {
    id: "every-plaintext-key",
    description:
      "A credential set with all nine plaintext keys, each a string; Studio maps sslClientKey and sslClientCert into ssl.clientKey and ssl.clientCert.",
    binding: {
      connectionId: "65a8c535-6856-404d-9138-3937da34f049",
      level: "read",
      engine: "postgres",
      definition: { host: "pg.example.internal", port: 5432, database: "app", ssl: { mode: "verify-full" } },
    },
    plaintext: {
      apiKeyId: "test-only api key id",
      apiKeySecret: "test-only api key secret",
      connectionString: "postgresql://app_reader@pg.example.internal:5432/app?sslmode=verify-full",
      password: "test-only password",
      privateKey: "test-only ssh private key",
      privateKeyPassphrase: "test-only passphrase",
      sslClientCert: "test-only client certificate",
      sslClientKey: "test-only client key",
      user: "app_reader",
    },
    expected: "ok",
  },
  {
    id: "format-non-canonical-base64url",
    description:
      "The last character of enc moved one place along the base64url alphabet: it decodes to the same 32 bytes, but with a padding bit set it is not their canonical encoding, so the envelope fails with FORMAT.",
    binding: APP_READ,
    plaintext: APP_READER,
    alter: nonCanonicalEnc,
    expected: "FORMAT",
  },
  {
    id: "format-padded-base64",
    description:
      "The envelope with its enc and sealed part written in padded standard base64 instead of base64url fails with FORMAT.",
    binding: APP_READ,
    plaintext: APP_READER,
    alter: paddedStandardBase64,
    expected: "FORMAT",
  },
  {
    id: "unknown-kid",
    description: "An envelope sealed to a public key whose kid is not in the keyring fails with UNKNOWN_KID.",
    binding: APP_READ,
    plaintext: APP_READER,
    sealedToOtherRecipient: true,
    expected: "UNKNOWN_KID",
  },
  {
    id: "auth-failed-level",
    description: "The read credential opened as the connection's write credential fails with AUTH_FAILED.",
    binding: APP_READ,
    plaintext: APP_READER,
    openFor: { ...APP_READ, level: "write" },
    expected: "AUTH_FAILED",
  },
  {
    id: "auth-failed-connection-id",
    description: "The envelope moved to another connection fails with AUTH_FAILED.",
    binding: APP_READ,
    plaintext: APP_READER,
    openFor: { ...APP_READ, connectionId: "f3c3a2bd-9c4c-403d-9651-9d45a2f81621" },
    expected: "AUTH_FAILED",
  },
  {
    id: "auth-failed-engine",
    description: "The envelope opened for another engine fails with AUTH_FAILED.",
    binding: APP_READ,
    plaintext: APP_READER,
    openFor: { ...APP_READ, engine: "mysql" },
    expected: "AUTH_FAILED",
  },
  {
    id: "auth-failed-definition-host",
    description:
      "The envelope opened after its definition's host changed fails with AUTH_FAILED, so a database writer cannot point a credential at another server.",
    binding: APP_READ,
    plaintext: APP_READER,
    openFor: { ...APP_READ, definition: { ...APP_READ.definition, host: "elsewhere.example.internal" } },
    expected: "AUTH_FAILED",
  },
  {
    id: "auth-failed-definition-tls-downgrade",
    description:
      "The envelope opened after its definition's ssl.mode was lowered from verify-full to disable fails with AUTH_FAILED, so a database writer cannot downgrade a connection's TLS.",
    binding: APP_READ,
    plaintext: APP_READER,
    openFor: {
      ...APP_READ,
      definition: { ...APP_READ.definition, ssl: { mode: "disable", rejectUnauthorized: true } },
    },
    expected: "AUTH_FAILED",
  },
  {
    id: "auth-failed-flipped-ciphertext-bit",
    description: "The envelope with the lowest bit of its first ciphertext byte flipped fails with AUTH_FAILED.",
    binding: APP_READ,
    plaintext: APP_READER,
    alter: flipFirstCiphertextBit,
    expected: "AUTH_FAILED",
  },
  {
    id: "low-order-point-zero",
    description:
      "An enc of 32 zero bytes, the X25519 point of order 2, gives the all-zero Diffie-Hellman result and fails with LOW_ORDER_POINT.",
    binding: APP_READ,
    plaintext: APP_READER,
    alter: withEnc("0000000000000000000000000000000000000000000000000000000000000000"),
    expected: "LOW_ORDER_POINT",
  },
  {
    id: "low-order-point-order-eight",
    description:
      "An enc that is an X25519 point of order 8 gives the all-zero Diffie-Hellman result and fails with LOW_ORDER_POINT.",
    binding: APP_READ,
    plaintext: APP_READER,
    alter: withEnc("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
    expected: "LOW_ORDER_POINT",
  },
  {
    id: "plaintext-unknown-key",
    description:
      "A credential set with a key outside the nine plaintext keys, here host, fails with PLAINTEXT_INVALID.",
    binding: APP_READ,
    plaintext: { host: "pg.example.internal", password: "app reader password", user: "app_reader" },
    expected: "PLAINTEXT_INVALID",
  },
  {
    id: "plaintext-non-string-value",
    description: "A credential set whose password is a JSON number instead of a string fails with PLAINTEXT_INVALID.",
    binding: APP_READ,
    plaintext: { password: 12345678, user: "app_reader" },
    expected: "PLAINTEXT_INVALID",
  },
];

/** One vector as the file records it: how it was sealed, what Studio is given, and what Studio answers. */
function vectorEntry(spec: VectorSpec) {
  const publicKey = spec.sealedToOtherRecipient === true ? OTHER_RECIPIENT_PUBLIC_KEY : RECIPIENT_PUBLIC_KEY;
  const kid = kidOf(publicKey);
  const ephemeralPrivateKey = testKey(TEST_KEY_LABELS.ephemeral.replace("<id>", spec.id));
  const envelope = sealSecret(publicKey, spec.binding, spec.plaintext, ephemeralPrivateKey);
  return {
    id: spec.id,
    description: spec.description,
    recipientPublicKey: publicKey.toString("base64url"),
    kid,
    binding: spec.binding,
    definitionJcs: canonicalJson(spec.binding.definition),
    aadHex: bindingAad(spec.binding, kid).toString("hex"),
    ephemeralPrivateKey: ephemeralPrivateKey.toString("base64url"),
    plaintext: spec.plaintext,
    envelope,
    opening: {
      envelope: spec.alter === undefined ? envelope : spec.alter(envelope),
      binding: spec.openFor ?? spec.binding,
    },
    expected: spec.expected,
  };
}

/** The `lsb1` test vectors, built from the fixed test keys through the test sealer. */
export function buildLsb1Vectors() {
  return {
    $comment:
      "Test vectors for lsb1 sealed credentials, described in docs/GOVERNANCE.md and generated by scripts/generate-governance-vectors.ts. Do not edit: a published lsb1 vector never changes, and a change to one is a new format, lsb2.",
    format: "lsb1",
    hpke: { mode: 0x00, kemId: 0x0020, kdfId: 0x0001, aeadId: 0x0002, info: "libredb/bridge/secret/v1" },
    testKeys: {
      notice:
        "Test keys, not secrets: every private key in this file is the SHA-256 of the UTF-8 of one of these published labels, <id> standing for a vector's id. Anyone can derive them, so they protect nothing: never seal or open a real credential with them.",
      ...TEST_KEY_LABELS,
    },
    keyring: { version: 1, keys: [RECIPIENT_PRIVATE_KEY.toString("base64url")] },
    vectors: VECTORS.map(vectorEntry),
  };
}

/** The file's bytes: two-space JSON and a final newline. */
export function renderLsb1Vectors(vectors: ReturnType<typeof buildLsb1Vectors>): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}

/** The file contents, or null when there is no file: absent and stale fail the check alike. */
function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The command line, exactly `--write` or `--check`, optionally followed by `--out <file>`; null for anything else,
 * which the command refuses with its usage line, so a mistyped flag never rewrites the committed vectors.
 */
function parseArguments(argv: readonly string[]): { mode: "--write" | "--check"; out: string | undefined } | null {
  const [mode, flag, file, ...rest] = argv;
  if (mode !== "--write" && mode !== "--check") return null;
  if (flag === undefined) return { mode, out: undefined };
  if (flag !== "--out" || file === undefined || file.startsWith("--") || rest.length > 0) return null;
  return { mode, out: file };
}

function main(argv: readonly string[]): number {
  const parsed = parseArguments(argv);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  const { mode, out } = parsed;

  const target = out === undefined ? path.join(REPO_ROOT, LSB1_VECTORS_FILE) : path.resolve(out);
  const next = renderLsb1Vectors(buildLsb1Vectors());
  if (mode === "--check") {
    if (readOrNull(target) !== next) {
      console.error(
        `${target} is not the vectors this script builds. A published lsb1 vector never changes, and a change to one is a new format, lsb2, so restore the file or undo the change that moved it. After adding a new vector, run: ${WRITE_COMMAND}`,
      );
      return 1;
    }
    console.log(`${target} is up to date`);
    return 0;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, next);
  console.log(`Wrote ${target}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
