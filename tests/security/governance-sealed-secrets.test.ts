/**
 * Threat: a writer of the governance source's database, or of a backup restored into it, moves a stored credential to
 * a row of its choosing: another host, a TLS mode that sends it in clear, another engine, the write level, or another
 * connection. Studio would then hand the credential to a server the writer controls, or use it where no grant allows.
 *
 * Every credential arrives as an `lsb1` envelope sealed to Studio's public key, with additional authenticated data
 * that binds it to its connection id, level, engine, key id and canonical definition (spec 8.2). Studio opens it only
 * with the keyring file `GOVERNANCE_PRIVATE_KEYS_FILE` names, through the cache of `openGovernedSecret`, which is the
 * path a governed connection takes. The assertions are about that path: an envelope opened once under its own row and
 * then moved still fails, so a cache hit can never stand in for the binding check.
 *
 * Neither a refused keyring nor a refused envelope may put key material or a credential into a message or a log line.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { governanceKeyring, resetGovernanceKeyring } from "@/lib/governance/keyring";
import { SealedSecretError, type SecretBinding } from "@/lib/governance/lsb1";
import { openGovernedSecret } from "@/lib/governance/secrets";
import { keyringFileOf, removeKeyringFiles, type TestKey, testKey } from "../helpers/governance/keyring-file";
import { sealSecret } from "../helpers/governance/lsb1-seal";

const ROOT = path.resolve(import.meta.dir, "../..");

const READ: SecretBinding = {
  connectionId: "8d2f4b6a-1c3e-4a5b-9d7f-0e2c4a6b8d1f",
  level: "read",
  engine: "postgres",
  definition: {
    host: "orders.db.example.internal",
    port: 5432,
    database: "orders",
    ssl: { mode: "verify-full", rejectUnauthorized: true },
  },
};
const WRITE: SecretBinding = { ...READ, level: "write" };

/** Recognisable on sight as test values; no message or log line may carry one. */
const READ_CREDENTIAL = { user: "orders_reader", password: "example-only-read-password-in-a-test" };
const WRITE_CREDENTIAL = { user: "orders_writer", password: "example-only-write-password-in-a-test" };

const CONSOLE_METHODS = ["debug", "info", "log", "warn", "error"] as const;

let key: TestKey;
let spies: ReturnType<typeof spyOn>[] = [];
let savedFile: string | undefined;

/** Every line written to the console since the test began. */
const consoleOutput = (): string => spies.flatMap((spy) => spy.mock.calls.flat()).join("\n");

beforeEach(() => {
  savedFile = process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
  spies = CONSOLE_METHODS.map((method) => spyOn(console, method).mockImplementation(() => {}));
  key = testKey();
  resetGovernanceKeyring();
  process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(testKey(), key);
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  if (savedFile === undefined) delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
  else process.env.GOVERNANCE_PRIVATE_KEYS_FILE = savedFile;
  resetGovernanceKeyring();
});

afterAll(() => {
  removeKeyringFiles();
});

/** The SealedSecretError `run` throws. */
function refusal(run: () => unknown): SealedSecretError {
  try {
    run();
  } catch (error) {
    if (error instanceof SealedSecretError) return error;
    throw error;
  }
  throw new Error("expected the envelope to be refused");
}

describe("sealed credentials under governance", () => {
  test("an envelope moved to another host, engine, level or connection fails with AUTH_FAILED", () => {
    const readEnvelope = sealSecret(key.publicKey, READ, READ_CREDENTIAL);
    const writeEnvelope = sealSecret(key.publicKey, WRITE, WRITE_CREDENTIAL);
    // Each opens under its own row first, so every refusal below is checked against a warm cache.
    expect(openGovernedSecret(readEnvelope, READ)).toEqual(READ_CREDENTIAL);
    expect(openGovernedSecret(writeEnvelope, WRITE)).toEqual(WRITE_CREDENTIAL);

    const moves: readonly { readonly what: string; readonly envelope: string; readonly to: SecretBinding }[] = [
      {
        what: "another host",
        envelope: readEnvelope,
        to: { ...READ, definition: { ...READ.definition, host: "attacker.example" } },
      },
      { what: "another port", envelope: readEnvelope, to: { ...READ, definition: { ...READ.definition, port: 6432 } } },
      {
        what: "TLS off",
        envelope: readEnvelope,
        to: { ...READ, definition: { ...READ.definition, ssl: { mode: "disable" } } },
      },
      {
        what: "an unchecked certificate",
        envelope: readEnvelope,
        to: { ...READ, definition: { ...READ.definition, ssl: { mode: "require", rejectUnauthorized: false } } },
      },
      { what: "another engine", envelope: readEnvelope, to: { ...READ, engine: "mysql" } },
      { what: "the write level", envelope: readEnvelope, to: WRITE },
      { what: "the read level", envelope: writeEnvelope, to: READ },
      {
        what: "another connection",
        envelope: readEnvelope,
        to: { ...READ, connectionId: "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f" },
      },
      {
        what: "another connection's write slot",
        envelope: writeEnvelope,
        to: { ...WRITE, connectionId: "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f" },
      },
    ];
    for (const { what, envelope, to } of moves) {
      expect({ what, code: refusal(() => openGovernedSecret(envelope, to)).code }).toEqual({
        what,
        code: "AUTH_FAILED",
      });
    }

    // The rows they were sealed for still open them.
    expect(openGovernedSecret(readEnvelope, READ)).toEqual(READ_CREDENTIAL);
    expect(openGovernedSecret(writeEnvelope, WRITE)).toEqual(WRITE_CREDENTIAL);
  });

  test("no refusal and no log line carries key material or a credential", () => {
    const envelope = sealSecret(key.publicKey, READ, READ_CREDENTIAL);
    const errors: Error[] = [];
    const record = (run: () => unknown): void => {
      try {
        run();
      } catch (error) {
        errors.push(error as Error);
      }
    };

    // A refused keyring: two copies of the same key.
    resetGovernanceKeyring();
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(key, key);
    record(() => governanceKeyring());

    // A keyring that loads, and envelopes it refuses: moved, altered, or sealed to another key.
    resetGovernanceKeyring();
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(key);
    expect(openGovernedSecret(envelope, READ)).toEqual(READ_CREDENTIAL);
    const [, kid, enc, sealed] = envelope.split(".");
    const altered = Buffer.from(sealed, "base64url");
    altered[0] ^= 0x80;
    record(() => openGovernedSecret(envelope, WRITE));
    record(() => openGovernedSecret(`lsb1.${kid}.${enc}.${altered.toString("base64url")}`, READ));
    record(() => openGovernedSecret(sealSecret(testKey().publicKey, READ, READ_CREDENTIAL), READ));
    expect(errors.map((error) => error.name)).toEqual([
      "KeyringError",
      "SealedSecretError",
      "SealedSecretError",
      "SealedSecretError",
    ]);

    const said = [...errors.flatMap((error) => [String(error), error.stack ?? ""]), consoleOutput()].join("\n");
    expect(said).toContain(key.kid);
    for (const secret of [
      key.text,
      key.raw.toString("hex"),
      key.raw.toString("base64"),
      READ_CREDENTIAL.password,
      READ_CREDENTIAL.user,
    ]) {
      expect(said).not.toContain(secret);
    }
  });

  test("the modules that open credentials can open them and have no way to seal one", () => {
    for (const file of ["keyring.ts", "secrets.ts", "lsb1.ts", "hpke.ts"]) {
      const source = readFileSync(path.join(ROOT, "src/lib/governance", file), "utf8");
      expect({ file, seals: /createCipheriv|generateKeyPair|\.encrypt\(|\bseal[A-Z(]/.test(source) }).toEqual({
        file,
        seals: false,
      });
    }
  });
});
