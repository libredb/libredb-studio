/**
 * Keyring files for tests: Studio's private keys as the file `GOVERNANCE_PRIVATE_KEYS_FILE` names holds them
 * (docs/GOVERNANCE.md#keyring), `{"version":1,"keys":["<unpadded base64url raw 32-byte X25519 private key>", ...]}`.
 *
 * Every key is drawn fresh, so no key text is ever checked in. Each file lands in a directory of its own under the
 * system temp directory, and `removeKeyringFiles()` deletes every one this process wrote.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { x25519PrivateKey, x25519RawPublicKey } from "@/lib/governance/hpke";
import { kidOf } from "@/lib/governance/lsb1";

/** One private key of a keyring, with what a test needs to seal to it and to look for it in output. */
export interface TestKey {
  /** The raw 32-byte X25519 private key. */
  readonly raw: Buffer;
  /** The unpadded base64url text of `raw`, as a keyring file holds it. */
  readonly text: string;
  /** The raw 32-byte public key, which a control plane seals to. */
  readonly publicKey: Buffer;
  /** The key id of the public key. */
  readonly kid: string;
}

/** A private key from `raw`, or a fresh one. Any 32 bytes are an X25519 private key. */
export function testKey(raw: Buffer = randomBytes(32)): TestKey {
  const publicKey = x25519RawPublicKey(x25519PrivateKey(raw));
  return { raw, text: raw.toString("base64url"), publicKey, kid: kidOf(publicKey) };
}

const directories: string[] = [];

/**
 * Writes a keyring file and returns its path. A string is written as it is, so a test can write text that is not
 * JSON; anything else is written as its JSON text.
 */
export function writeKeyringFile(contents: unknown): string {
  const directory = mkdtempSync(path.join(tmpdir(), "libredb-keyring-"));
  directories.push(directory);
  const file = path.join(directory, "keyring.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

/** A keyring file of version 1 that holds `keys`, in this order. */
export function keyringFileOf(...keys: readonly TestKey[]): string {
  return writeKeyringFile({ version: 1, keys: keys.map((key) => key.text) });
}

/** Deletes every keyring file this process wrote, with its directory. */
export function removeKeyringFiles(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}
