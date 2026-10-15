/**
 * The `lsb1` test vectors a control plane reproduces: `tests/fixtures/governance/lsb1-vectors.json` (spec 8.5).
 *
 * A control plane vendors this file from a Studio release and never edits it. Its sealer reproduces every envelope
 * byte for byte from what the vector records (the recipient's public key, the binding, the plaintext and a fixed
 * ephemeral key), and the negative vectors pin the code Studio answers for each way an envelope can be wrong. So the
 * file has to be exactly what scripts/generate-governance-vectors.ts builds, each envelope has to follow from the
 * inputs its vector records, and Studio's opener has to give every vector's expected result. An `lsb1` vector never
 * changes: a change to one is a new format, `lsb2`.
 *
 * Every private key in the file is a test key, the SHA-256 of a label that says so. The keys, public keys and kids
 * written out below were derived from those labels with sha256sum and openssl rather than with this repository's
 * code, so the file cannot certify itself.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLsb1Vectors, LSB1_VECTORS_FILE, renderLsb1Vectors } from "../../scripts/generate-governance-vectors";
import { CONFORMANCE_FILES, ENVELOPE_CODES, PLAINTEXT_KEYS } from "@/lib/governance/contract";
import { openBase, x25519PrivateKey, x25519RawPublicKey } from "@/lib/governance/hpke";
import { canonicalJson } from "@/lib/governance/jcs";
import { bindingAad, type Keyring, kidOf, openSealedSecret, SealedSecretError } from "@/lib/governance/lsb1";
import { sealSecret } from "../helpers/governance/lsb1-seal";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, "scripts/generate-governance-vectors.ts");
const CHECKED_IN = readFileSync(path.join(ROOT, LSB1_VECTORS_FILE), "utf8");

interface VectorBinding {
  connectionId: string;
  level: "read" | "write";
  engine: string;
  definition: Record<string, unknown>;
}
interface Vector {
  id: string;
  description: string;
  recipientPublicKey: string;
  kid: string;
  binding: VectorBinding;
  definitionJcs: string;
  aadHex: string;
  ephemeralPrivateKey: string;
  plaintext: Record<string, unknown>;
  envelope: string;
  opening: { envelope: string; binding: VectorBinding };
  expected: string;
}
interface VectorFile {
  format: string;
  hpke: { mode: number; kemId: number; kdfId: number; aeadId: number; info: string };
  testKeys: { notice: string; recipient: string; otherRecipient: string; ephemeral: string };
  keyring: { version: number; keys: string[] };
  vectors: Vector[];
}
const FILE = JSON.parse(CHECKED_IN) as VectorFile;
const positives = FILE.vectors.filter((vector) => vector.expected === "ok");
const negatives = FILE.vectors.filter((vector) => vector.expected !== "ok");

/** Derived from the labels with sha256sum and openssl: the keyring's private key, and both recipients' keys. */
const RECIPIENT_PRIVATE = "Y5fH49MAJo1-uw8L5S0Rp1kJB_X2Ts7Pqbs0-z1LQi8";
const RECIPIENT_PUBLIC = "b6-f045B6re3Ue7V8Cr5jO9ApZzyOxGk659gM3tn5wE";
const RECIPIENT_KID = "caea4ffac78f6e7c";
const OTHER_RECIPIENT_PUBLIC = "XrLcFALBce5LaQouZGfCyBsAhbzp_e32BBe8E_sHG2o";
const OTHER_RECIPIENT_KID = "33398f0a81a35c91";

/** Studio's keyring, read from the file's keyring the way a keyring file is read (spec 8.4). */
const keyring: Keyring = new Map(
  FILE.keyring.keys.map((encoded) => {
    const privateKey = x25519PrivateKey(Buffer.from(encoded, "base64url"));
    return [kidOf(x25519RawPublicKey(privateKey)), privateKey];
  }),
);

const sha256Base64url = (text: string): string => createHash("sha256").update(text, "utf8").digest("base64url");

/** Every value inside a definition, nested objects and arrays included. */
const valuesOf = (value: unknown): unknown[] =>
  typeof value === "object" && value !== null ? Object.values(value).flatMap(valuesOf) : [value];

/** The binding fields a vector is opened under other values of, and `envelope` when Studio is given another one. */
function departures(vector: Vector): string[] {
  const fields = (["connectionId", "level", "engine", "definition"] as const).filter(
    (field) => canonicalJson(vector.opening.binding[field]) !== canonicalJson(vector.binding[field]),
  );
  return vector.opening.envelope === vector.envelope ? fields : [...fields, "envelope"];
}

/** Whether `altered` is `envelope` with exactly one bit flipped in its ciphertext, short of the tag. */
function flipsOneCiphertextBit(envelope: string, altered: string): boolean {
  const [prefix, kid, enc, sealed] = envelope.split(".");
  const [alteredPrefix, alteredKid, alteredEnc, alteredSealed] = altered.split(".");
  if (alteredPrefix !== prefix || alteredKid !== kid || alteredEnc !== enc) return false;
  const before = Buffer.from(sealed, "base64url");
  const after = Buffer.from(alteredSealed, "base64url");
  if (after.length !== before.length) return false;
  const flipped = [...before].flatMap((byte, index) =>
    [0, 1, 2, 3, 4, 5, 6, 7].filter((bit) => ((byte ^ after[index]) >> bit) & 1).map(() => index),
  );
  return flipped.length === 1 && flipped[0] < before.length - 16;
}

/** Whether `envelope` has the lsb1 pattern while one of its base64url fields is not the encoding of its bytes. */
function patternWithNonCanonicalField(envelope: string): boolean {
  const match = /^lsb1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22,})$/.exec(envelope);
  return (
    match !== null && match.slice(2).some((field) => Buffer.from(field, "base64url").toString("base64url") !== field)
  );
}

describe("lsb1-vectors.json", () => {
  test("regenerating the vectors reproduces the checked-in file byte for byte", () => {
    // The file the script writes is the conformance file a control plane pins.
    expect(CONFORMANCE_FILES).toContain(LSB1_VECTORS_FILE);
    expect(CHECKED_IN).toBe(renderLsb1Vectors(buildLsb1Vectors()));
  });

  test("every positive vector opens to its plaintext and every negative vector fails with its exact code", () => {
    const outcome = ({ opening }: Vector): Record<string, unknown> => {
      try {
        return { expected: "ok", opened: openSealedSecret(keyring, opening.envelope, opening.binding) };
      } catch (error) {
        if (!(error instanceof SealedSecretError)) throw error;
        return { expected: error.code };
      }
    };
    for (const vector of FILE.vectors) {
      const wanted =
        vector.expected === "ok" ? { expected: "ok", opened: vector.plaintext } : { expected: vector.expected };
      expect({ id: vector.id, ...outcome(vector) }).toEqual({ id: vector.id, ...wanted });
    }
    expect(positives.length).toBeGreaterThanOrEqual(7);
    expect(negatives.length).toBeGreaterThanOrEqual(9);
  });

  test("sealing with each vector's fixed ephemeral key reproduces its envelope", () => {
    for (const vector of FILE.vectors) {
      const sealed = sealSecret(
        Buffer.from(vector.recipientPublicKey, "base64url"),
        vector.binding,
        vector.plaintext,
        Buffer.from(vector.ephemeralPrivateKey, "base64url"),
      );
      expect({ id: vector.id, sealed }).toEqual({ id: vector.id, sealed: vector.envelope });
    }
  });

  test("each vector's kid, definitionJcs and aadHex follow from its recipient key and binding", () => {
    for (const vector of FILE.vectors) {
      const derived = {
        id: vector.id,
        kid: kidOf(Buffer.from(vector.recipientPublicKey, "base64url")),
        envelopeKid: vector.envelope.split(".")[1],
        definitionJcs: canonicalJson(vector.binding.definition),
        aadHex: bindingAad(vector.binding, vector.kid).toString("hex"),
      };
      const { id, kid, definitionJcs, aadHex } = vector;
      expect(derived).toEqual({ id, kid, envelopeKid: kid, definitionJcs, aadHex });
      // The plaintext is sealed as its JSON text, which is also its canonical form, so a sealer written in any
      // language that implements canonical JSON for the binding seals the same bytes.
      expect({ id, plaintext: JSON.stringify(vector.plaintext) }).toEqual({
        id,
        plaintext: canonicalJson(vector.plaintext),
      });
    }
    // The canary's additional authenticated data, written out by hand with the kid openssl derives.
    const [canary] = positives.filter((vector) => vector.binding.connectionId === "canary");
    expect(Buffer.from(canary.aadHex, "hex").toString("utf8")).toBe(
      `{"c":"canary","d":"RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o","e":"canary","k":"${RECIPIENT_KID}","l":"read","s":"lsb1"}`,
    );
  });

  test("the file names the lsb1 suite, and its info string is the one the envelopes are sealed with", () => {
    expect(FILE.format).toBe("lsb1");
    expect(FILE.hpke).toEqual({ mode: 0, kemId: 32, kdfId: 1, aeadId: 2, info: "libredb/bridge/secret/v1" });
    const [canary] = positives.filter((vector) => vector.binding.connectionId === "canary");
    const [, , enc, sealed] = canary.envelope.split(".");
    const opened = openBase({
      recipientPrivateKey: x25519PrivateKey(Buffer.from(RECIPIENT_PRIVATE, "base64url")),
      enc: Buffer.from(enc, "base64url"),
      info: Buffer.from(FILE.hpke.info, "utf8"),
      aad: Buffer.from(canary.aadHex, "hex"),
      ciphertext: Buffer.from(sealed, "base64url"),
    });
    expect(opened.toString("utf8")).toBe('{"user":"libredb-canary"}');
  });

  test("every key is a test key: the SHA-256 of a published label marked test only", () => {
    expect(FILE.testKeys.notice).toMatch(/test keys/i);
    expect(FILE.testKeys.recipient).toBe("libredb lsb1 test vectors, test only: recipient key");
    expect(FILE.testKeys.otherRecipient).toBe("libredb lsb1 test vectors, test only: other recipient key");
    expect(FILE.testKeys.ephemeral).toBe("libredb lsb1 test vectors, test only: ephemeral key of <id>");

    // The keyring has the form of a keyring file and holds the recipient key alone.
    expect(FILE.keyring).toEqual({ version: 1, keys: [RECIPIENT_PRIVATE] });
    expect(sha256Base64url(FILE.testKeys.recipient)).toBe(RECIPIENT_PRIVATE);
    expect([...keyring.keys()]).toEqual([RECIPIENT_KID]);

    // Every vector is sealed to the recipient key, except one sealed to a key the keyring does not hold.
    const recipients = FILE.vectors.map((vector) => `${vector.recipientPublicKey} ${vector.kid} ${vector.expected}`);
    expect(new Set(recipients)).toEqual(
      new Set([
        ...FILE.vectors
          .filter((vector) => vector.expected !== "UNKNOWN_KID")
          .map((vector) => `${RECIPIENT_PUBLIC} ${RECIPIENT_KID} ${vector.expected}`),
        `${OTHER_RECIPIENT_PUBLIC} ${OTHER_RECIPIENT_KID} UNKNOWN_KID`,
      ]),
    );
    const otherPrivate = x25519PrivateKey(Buffer.from(sha256Base64url(FILE.testKeys.otherRecipient), "base64url"));
    expect(x25519RawPublicKey(otherPrivate).toString("base64url")).toBe(OTHER_RECIPIENT_PUBLIC);

    // Each vector has an ephemeral key of its own, derived from its id.
    for (const { id, ephemeralPrivateKey } of FILE.vectors) {
      const label = `libredb lsb1 test vectors, test only: ephemeral key of ${id}`;
      expect({ id, ephemeralPrivateKey }).toEqual({ id, ephemeralPrivateKey: sha256Base64url(label) });
    }
    expect(new Set(FILE.vectors.map((vector) => vector.id)).size).toBe(FILE.vectors.length);
  });

  test("connection ids are lowercase UUIDs as a control plane generates them, except the canary's", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = FILE.vectors.flatMap((vector) => [vector.binding.connectionId, vector.opening.binding.connectionId]);
    expect(ids.filter((id) => !uuid.test(id))).toEqual(["canary", "canary"]);
  });

  test("the positive vectors cover the canary, unicode, a nested ssl object with a PEM caCert, numbers, key order, the write level and every plaintext key", () => {
    const canary: VectorBinding = { connectionId: "canary", level: "read", engine: "canary", definition: {} };
    expect(
      positives
        .filter((vector) => vector.binding.connectionId === "canary")
        .map(({ binding, plaintext, opening }) => ({ binding, plaintext, opening })),
    ).toEqual([
      {
        binding: canary,
        plaintext: { user: "libredb-canary" },
        opening: { envelope: expect.any(String), binding: canary },
      },
    ]);

    // A positive vector is opened as it was sealed: the same envelope, for the same binding up to key order.
    expect(positives.filter((vector) => departures(vector).length > 0).map((vector) => vector.id)).toEqual([]);

    const covered = (predicate: (vector: Vector) => boolean): string[] =>
      positives.filter(predicate).map((vector) => vector.id);
    const outsideTheBmp = /[\u{10000}-\u{10ffff}]/u;
    const pem = /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END CERTIFICATE-----\n$/;

    const cases = {
      // Unicode: a character outside the Basic Multilingual Plane in the definition, and non-ASCII in the plaintext.
      unicode: covered((v) => outsideTheBmp.test(v.definitionJcs) && /[^\x00-\x7f]/.test(JSON.stringify(v.plaintext))),
      nestedSslPem: covered((v) => {
        const ssl = v.binding.definition.ssl as Record<string, unknown> | undefined;
        return typeof ssl === "object" && typeof ssl.caCert === "string" && pem.test(ssl.caCert);
      }),
      // Numbers: an integer and both booleans, bound as JSON numbers and literals.
      numbers: covered((v) => {
        const values = valuesOf(v.binding.definition);
        return values.some(Number.isSafeInteger) && values.includes(true) && values.includes(false);
      }),
      // Key order: sealed with its keys out of canonical order, and opened with the same definition in another order.
      keyOrder: covered(
        (v) =>
          JSON.stringify(v.binding.definition) !== v.definitionJcs &&
          JSON.stringify(v.opening.binding.definition) !== JSON.stringify(v.binding.definition) &&
          canonicalJson(v.opening.binding.definition) === v.definitionJcs,
      ),
      writeLevel: covered((v) => v.binding.level === "write"),
      everyPlaintextKey: covered((v) => Object.keys(v.plaintext).sort().join() === [...PLAINTEXT_KEYS].sort().join()),
    };
    expect(Object.entries(cases).filter(([, ids]) => ids.length === 0)).toEqual([]);
  });

  test("the negative vectors carry every envelope code, with AUTH_FAILED for a changed level, connection id, engine and definition and for a flipped ciphertext bit", () => {
    expect(new Set(negatives.map((vector) => vector.expected))).toEqual(new Set(ENVELOPE_CODES));

    const authFailed = negatives.filter((vector) => vector.expected === "AUTH_FAILED");
    const changes = authFailed.map((vector) => departures(vector).join("+"));
    expect(changes).toEqual(expect.arrayContaining(["level", "connectionId", "engine", "definition", "envelope"]));
    // Each changes one thing, and the altered envelope differs from the sealed one in a single ciphertext bit.
    expect(changes.filter((change) => change.includes("+"))).toEqual([]);
    const altered = authFailed.filter((vector) => departures(vector).includes("envelope"));
    expect(altered.every((vector) => flipsOneCiphertextBit(vector.envelope, vector.opening.envelope))).toBe(true);
    expect(altered.length).toBeGreaterThan(0);

    // One refused for its format matches the envelope pattern, but its base64url is not the canonical encoding.
    const format = negatives.filter((vector) => vector.expected === "FORMAT");
    expect(format.some((vector) => patternWithNonCanonicalField(vector.opening.envelope))).toBe(true);
  });

  test("--check passes on the checked-in file, two --write runs produce identical bytes, and a stale file fails --check", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "governance-vectors-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      expect(run("--check").exitCode).toBe(0);

      const out = path.join(dir, "lsb1-vectors.json");
      expect(run("--write", "--out", out).exitCode).toBe(0);
      const first = readFileSync(out);
      expect(run("--write", "--out", out).exitCode).toBe(0);
      expect(readFileSync(out).equals(first)).toBe(true);
      expect(first.toString("utf8")).toBe(CHECKED_IN);
      expect(run("--check", "--out", out).exitCode).toBe(0);

      writeFileSync(out, CHECKED_IN.replace('"expected": "UNKNOWN_KID"', '"expected": "AUTH_FAILED"'));
      const stale = run("--check", "--out", out);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toContain("lsb2");

      const absent = run("--check", "--out", path.join(dir, "absent.json"));
      expect(absent.exitCode).toBe(1);

      for (const args of [[], ["--check", "--write"], ["--write", "--out"], ["--check", "--verbose"]]) {
        const refused = run(...args);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr.toString()).toContain("Usage:");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
