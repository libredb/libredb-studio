/**
 * Studio's keyring (docs/GOVERNANCE.md#keyring): the private keys that open sealed credentials, read from the file
 * `GOVERNANCE_PRIVATE_KEYS_FILE` names.
 *
 * The file is `{"version":1,"keys":[...]}` with 1 to 16 unpadded base64url keys of 32 bytes, one per key id. Anything
 * else stops the boot. Neither a refusal nor the log of a keyring that loads carries key material: they name key ids,
 * positions and lengths, never a key's text.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { CONTRACT_OBJECTS } from "@/lib/governance/contract";
import { x25519RawPublicKey } from "@/lib/governance/hpke";
import {
  governanceKeyring,
  KEYRING_MAX_KEYS,
  KeyringError,
  loadKeyring,
  resetGovernanceKeyring,
} from "@/lib/governance/keyring";
import { kidOf } from "@/lib/governance/lsb1";
import { keyringFileOf, removeKeyringFiles, testKey, writeKeyringFile } from "../../../helpers/governance/keyring-file";

/** Everything a call wrote to the console, and what it returned or threw. */
interface Captured<T> {
  readonly result?: T;
  readonly error?: unknown;
  readonly output: string;
}

const CONSOLE_METHODS = ["debug", "info", "log", "warn", "error"] as const;

/** Runs `run` with every console method stubbed, so a test can read the lines it would have printed. */
function captured<T>(run: () => T): Captured<T> {
  const spies = CONSOLE_METHODS.map((method) => spyOn(console, method).mockImplementation(() => {}));
  try {
    try {
      return { result: run(), output: spies.flatMap((spy) => spy.mock.calls.flat()).join("\n") };
    } catch (error) {
      return { error, output: spies.flatMap((spy) => spy.mock.calls.flat()).join("\n") };
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** The KeyringError `loadKeyring(file)` throws, or a failure when the keyring loads. */
function refusalOf(file: string): KeyringError {
  const { error } = captured(() => loadKeyring(file));
  if (!(error instanceof KeyringError)) throw new Error(`expected a KeyringError, got ${String(error)}`);
  return error;
}

/** Every spelling of a key's material a message must not carry: its text, its bytes as hex and as standard base64. */
const materialOf = (raw: Buffer): string[] => [raw.toString("base64url"), raw.toString("hex"), raw.toString("base64")];

let savedFile: string | undefined;

beforeEach(() => {
  savedFile = process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
  delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
  resetGovernanceKeyring();
});

afterEach(() => {
  if (savedFile === undefined) delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
  else process.env.GOVERNANCE_PRIVATE_KEYS_FILE = savedFile;
  resetGovernanceKeyring();
});

afterAll(() => {
  removeKeyringFiles();
});

describe("loadKeyring", () => {
  test("a duplicate kid, a 31-byte key or an empty key list is refused and the error names no key material", () => {
    const first = testKey();
    const second = testKey();
    // Another text of the same private key: X25519 clears the low three bits of the first byte before it multiplies,
    // so this key has the same public key and the same kid as `first`.
    const twin = testKey(Buffer.from(first.raw.map((byte, index) => (index === 0 ? byte ^ 0x01 : byte))));
    expect(twin.text).not.toBe(first.text);
    expect(twin.kid).toBe(first.kid);
    const short = randomBytes(31);

    const cases: readonly { readonly keys: readonly string[]; readonly reason: string }[] = [
      { keys: [first.text, second.text, first.text], reason: `holds keys 1 and 3 with the same key id ${first.kid}` },
      { keys: [second.text, first.text, twin.text], reason: `holds keys 2 and 3 with the same key id ${first.kid}` },
      { keys: [first.text, short.toString("base64url")], reason: "holds key 2 of 31 bytes, not 32" },
      { keys: [], reason: "holds no keys" },
    ];
    const material = [first, second, twin].flatMap((key) => materialOf(key.raw)).concat(materialOf(short));
    for (const { keys, reason } of cases) {
      const file = writeKeyringFile({ version: 1, keys });
      const error = refusalOf(file);
      expect(error.message, reason).toStartWith(`GOVERNANCE_PRIVATE_KEYS_FILE ${JSON.stringify(file)} ${reason}`);
      expect(error.reason, reason).toStartWith(reason);
      for (const text of material) expect(error.message, reason).not.toContain(text);
    }
  });

  test("a keyring with 17 keys is refused naming the limit of 16", () => {
    const keys = Array.from({ length: 17 }, () => testKey());
    const error = refusalOf(keyringFileOf(...keys));
    expect(error.reason).toStartWith("holds 17 keys, more than the limit of 16");
    expect(error.reason).toContain("keyring_kids");
    for (const key of keys) for (const text of materialOf(key.raw)) expect(error.message).not.toContain(text);

    // Sixteen is the limit, not past it.
    expect(captured(() => loadKeyring(keyringFileOf(...keys.slice(0, 16)))).result?.size).toBe(16);
  });

  test("each private key loads under the kid of its public key, and the log names the kids and no key text", () => {
    const keys = [testKey(), testKey()];
    const { result: keyring, output } = captured(() => loadKeyring(keyringFileOf(...keys)));
    if (keyring === undefined) throw new Error("the keyring did not load");

    expect([...keyring.keys()]).toEqual(keys.map((key) => key.kid));
    for (const [kid, privateKey] of keyring) expect(kidOf(x25519RawPublicKey(privateKey))).toBe(kid);

    expect(output).toContain("Governance keyring loaded");
    for (const key of keys) {
      expect(output).toContain(key.kid);
      for (const text of materialOf(key.raw)) expect(output).not.toContain(text);
    }
  });

  test("a file that cannot be read is refused with its error code", () => {
    const missing = path.join(path.dirname(keyringFileOf(testKey())), "absent.json");
    expect(refusalOf(missing).reason).toStartWith("cannot be read (ENOENT)");
    // A directory is EISDIR on Linux; the cross-platform job's runners may name it with another code.
    expect(refusalOf(path.dirname(missing)).reason).toMatch(/^cannot be read \(E[A-Z]+\)/);
  });

  test("text that is not JSON is refused without quoting any of it", () => {
    const key = testKey();
    // A keyring that lost its closing brace: JSON.parse's own message would quote the text around the fault.
    const error = refusalOf(writeKeyringFile(`{"version":1,"keys":["${key.text}"]`));
    expect(error.reason).toStartWith("is not valid JSON");
    for (const text of materialOf(key.raw)) expect(error.message).not.toContain(text);
  });

  test("anything but a JSON object of version 1 with a list of keys is refused", () => {
    const key = testKey();
    const cases: readonly { readonly contents: unknown; readonly reason: string }[] = [
      { contents: "[]", reason: "is not a JSON object" },
      { contents: "null", reason: "is not a JSON object" },
      { contents: JSON.stringify(key.text), reason: "is not a JSON object" },
      { contents: { keys: [key.text] }, reason: 'has no "version": 1' },
      { contents: { version: "1", keys: [key.text] }, reason: 'has no "version": 1' },
      { contents: { version: 2, keys: [key.text] }, reason: "is keyring version 2, and this Studio reads version 1" },
      { contents: { version: 1 }, reason: 'has no "keys" list' },
      { contents: { version: 1, keys: key.text }, reason: 'has no "keys" list' },
    ];
    for (const { contents, reason } of cases) {
      const error = refusalOf(writeKeyringFile(contents));
      expect(error.reason, JSON.stringify(contents)).toStartWith(reason);
      for (const text of materialOf(key.raw)) expect(error.message).not.toContain(text);
    }
  });

  test("a key that is not the unpadded base64url of 32 bytes is refused by its position", () => {
    // A first byte of 0xf8 makes the text start with "-", which the standard base64 alphabet spells "+".
    const key = testKey(Buffer.concat([Buffer.of(0xf8), randomBytes(31)]));
    expect(key.text).toStartWith("-");
    const notBase64url = "holds key 2, which is not unpadded base64url text";
    const cases: readonly { readonly entry: unknown; readonly reason: string }[] = [
      { entry: 42, reason: notBase64url },
      { entry: null, reason: notBase64url },
      { entry: `${key.text}=`, reason: notBase64url },
      { entry: ` ${key.text}`, reason: notBase64url },
      { entry: `+${key.text.slice(1)}`, reason: notBase64url },
      { entry: "", reason: "holds key 2 of 0 bytes, not 32" },
      { entry: randomBytes(33).toString("base64url"), reason: "holds key 2 of 33 bytes, not 32" },
    ];
    const other = testKey();
    for (const { entry, reason } of cases) {
      const error = refusalOf(writeKeyringFile({ version: 1, keys: [other.text, entry] }));
      expect(error.reason, String(entry)).toStartWith(reason);
      for (const text of [...materialOf(key.raw), ...materialOf(other.raw)]) {
        expect(error.message, String(entry)).not.toContain(text);
      }
    }
  });

  test("KEYRING_MAX_KEYS is the CHECK on the heartbeat's keyring_kids column, which reports every kid", () => {
    const table = CONTRACT_OBJECTS.find((object) => object.name === "studio_instance");
    if (table === undefined || table.kind === "function") throw new Error("no studio_instance table in the contract");
    const check = table.columns.find((column) => column.name === "keyring_kids")?.check;
    expect(check).toEqual({ kind: "cardinality", max: KEYRING_MAX_KEYS });
    expect(KEYRING_MAX_KEYS).toBe(16);
  });
});

describe("governanceKeyring", () => {
  test("an unset or empty GOVERNANCE_PRIVATE_KEYS_FILE is refused naming the variable", () => {
    for (const value of [undefined, ""]) {
      if (value === undefined) delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
      else process.env.GOVERNANCE_PRIVATE_KEYS_FILE = value;
      expect(() => governanceKeyring()).toThrow("GOVERNANCE_PRIVATE_KEYS_FILE is not set");
    }
  });

  test("a keyring that does not load is refused with the reason loadKeyring gives, and nothing is kept", () => {
    const keys = Array.from({ length: 17 }, () => testKey());
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(...keys);
    const { error } = captured(() => governanceKeyring());
    expect(error).toBeInstanceOf(KeyringError);
    expect((error as Error).message).toStartWith(
      `GOVERNANCE_PRIVATE_KEYS_FILE ${JSON.stringify(process.env.GOVERNANCE_PRIVATE_KEYS_FILE)} holds 17 keys`,
    );

    // A refused keyring is never kept, so the next call reads the file the variable names then.
    const good = testKey();
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(good);
    expect([...(captured(() => governanceKeyring()).result?.keys() ?? [])]).toEqual([good.kid]);
  });

  test("the keyring loads once per process and is shared through globalThis, until a reset", () => {
    const first = testKey();
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(first);
    const { result: loaded, output } = captured(() => governanceKeyring());
    if (loaded === undefined) throw new Error("the keyring did not load");
    expect([...loaded.keys()]).toEqual([first.kid]);
    expect(output).toContain(first.kid);

    // Instrumentation and each route handler are bundled apart, so the one keyring lives on globalThis.
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("libredb-studio.governance-keyring")]).toBe(loaded);

    // Read once: neither another file nor a removed variable changes the keyring of a running process, and a second
    // call logs nothing.
    const second = testKey();
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(second);
    const again = captured(() => governanceKeyring());
    expect(again.result).toBe(loaded);
    expect(again.output).toBe("");
    delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
    expect(governanceKeyring()).toBe(loaded);

    // The test seam forgets it, and the next call reads the file the variable names then.
    resetGovernanceKeyring();
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(second);
    expect([...(captured(() => governanceKeyring()).result?.keys() ?? [])]).toEqual([second.kid]);
  });
});
