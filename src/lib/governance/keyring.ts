/**
 * Studio's keyring under governance (docs/GOVERNANCE.md#keyring): the X25519 private keys that open the `lsb1`
 * envelopes a control plane seals each connection's credentials into.
 *
 * The keys live in a file, never in the environment: `GOVERNANCE_PRIVATE_KEYS_FILE` names it, and it holds
 * `{"version":1,"keys":["<unpadded base64url raw 32-byte X25519 private key>", ...]}`, mounted so that only the user
 * Studio runs as can read it. A keyring holds 1 to 16 keys, because the heartbeat reports the id of every key it holds
 * and the contract's `keyring_kids` column takes at most 16, so a larger keyring would make every heartbeat fail. Each
 * key is held under the kid of its public key, and two keys with one kid are refused.
 *
 * The boot preflight (`preflight.ts`) loads the keyring and refuses to start when it does not load, so a server never
 * runs with a keyring it cannot use. No message and no log line carries key material: refusals name the file, a key's
 * position, its length or its kid, and the log names the kids it loaded.
 */
import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { logger } from "@/lib/logger";
import { x25519PrivateKey, x25519RawPublicKey } from "./hpke";
import { type Keyring, kidOf } from "./lsb1";

/** The keyring file format this Studio reads. */
const KEYRING_VERSION = 1;

/** The most keys a keyring holds: the CHECK on the heartbeat's `keyring_kids` column, which the tests pin it to. */
export const KEYRING_MAX_KEYS = 16;

/** Nsk of DHKEM(X25519, HKDF-SHA256): a raw private key is 32 bytes. */
const PRIVATE_KEY_BYTES = 32;

/** How a keyring file is written, for a message that has to say so. */
const KEYRING_FORMAT = '{"version":1,"keys":["<unpadded base64url private key>", ...]}';

// One template literal per message, never a concatenation across lines: bun's line coverage under-counts the
// continuation lines of a message built that way (src/lib/governance/config.ts).
const KEYS_FILE_MISSING_MESSAGE =
  "GOVERNANCE_PRIVATE_KEYS_FILE is not set: governance mode opens each connection's sealed credentials with the private keys in this file, such as /etc/libredb/governance/keyring.json";

/**
 * Why a keyring file did not load. The message names `GOVERNANCE_PRIVATE_KEYS_FILE`, the file and the reason, and never
 * any key material: a reason names a key by its position, its length or its kid.
 */
export class KeyringError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`GOVERNANCE_PRIVATE_KEYS_FILE ${JSON.stringify(file)} ${reason}`);
    this.name = "KeyringError";
  }
}

/** The text of the keyring file, refused with the error code alone when it cannot be read. */
function readKeyringText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "an unknown error";
    throw new KeyringError(
      file,
      `cannot be read (${code}): mount the keyring file there, readable by the user Studio runs as`,
    );
  }
}

/** The parsed keyring file. JSON.parse's own message quotes the text around a fault, so it is never passed on. */
function parseKeyringText(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new KeyringError(file, `is not valid JSON: write it as ${KEYRING_FORMAT}`);
  }
}

/** The key texts of a keyring file of version 1, checked for their number only. */
function keyTexts(file: string, parsed: unknown): readonly unknown[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KeyringError(file, `is not a JSON object: write it as ${KEYRING_FORMAT}`);
  }
  const { version, keys } = parsed as { version?: unknown; keys?: unknown };
  if (typeof version === "number" && version !== KEYRING_VERSION) {
    throw new KeyringError(
      file,
      `is keyring version ${version}, and this Studio reads version ${KEYRING_VERSION} only`,
    );
  }
  if (version !== KEYRING_VERSION) throw new KeyringError(file, `has no "version": 1: write it as ${KEYRING_FORMAT}`);
  if (!Array.isArray(keys)) throw new KeyringError(file, `has no "keys" list: write it as ${KEYRING_FORMAT}`);
  if (keys.length === 0) {
    throw new KeyringError(file, "holds no keys: governance mode needs a private key to open sealed credentials");
  }
  if (keys.length > KEYRING_MAX_KEYS) {
    throw new KeyringError(
      file,
      `holds ${keys.length} keys, more than the limit of ${KEYRING_MAX_KEYS}: the heartbeat reports every key id, and its keyring_kids column takes at most ${KEYRING_MAX_KEYS}`,
    );
  }
  return keys;
}

/** The raw private key the key text at `position` (1-based) spells: exactly 32 bytes, in canonical base64url. */
function rawPrivateKey(file: string, text: unknown, position: number): Buffer {
  const raw = typeof text === "string" ? Buffer.from(text, "base64url") : null;
  if (raw === null || raw.toString("base64url") !== text) {
    throw new KeyringError(file, `holds key ${position}, which is not unpadded base64url text`);
  }
  if (raw.length !== PRIVATE_KEY_BYTES) {
    throw new KeyringError(
      file,
      `holds key ${position} of ${raw.length} bytes, not ${PRIVATE_KEY_BYTES}: each key is a raw X25519 private key`,
    );
  }
  return raw;
}

/**
 * Reads the keyring file at `file` and returns its private keys, each under the kid of its public key, in the order
 * the file lists them.
 *
 * It throws a KeyringError when the file cannot be read, is not JSON, is not a JSON object of version 1 with a list of
 * keys, holds no key or more than 16, holds a key that is not the unpadded base64url of 32 bytes, or holds two keys
 * with the same kid, which two texts of one private key have. On success it logs the kids it loaded and nothing else.
 */
export function loadKeyring(file: string): Keyring {
  const texts = keyTexts(file, parseKeyringText(file, readKeyringText(file)));
  const keyring = new Map<string, KeyObject>();
  const positions = new Map<string, number>();
  for (const [index, text] of texts.entries()) {
    const position = index + 1;
    const privateKey = x25519PrivateKey(rawPrivateKey(file, text, position));
    const kid = kidOf(x25519RawPublicKey(privateKey));
    const earlier = positions.get(kid);
    if (earlier !== undefined) {
      throw new KeyringError(
        file,
        `holds keys ${earlier} and ${position} with the same key id ${kid}: list each private key once`,
      );
    }
    positions.set(kid, position);
    keyring.set(kid, privateKey);
  }
  logger.info("Governance keyring loaded", { route: "governance/keyring", kids: [...keyring.keys()] });
  return keyring;
}

/**
 * Where the loaded keyring lives. Next.js bundles instrumentation, which loads it at boot, apart from each route
 * handler, so a module-level variable would hold one keyring per bundle; a global under a registered symbol holds one
 * per process (src/lib/seed/sqlite-sample.ts does the same).
 */
const KEYRING_KEY = Symbol.for("libredb-studio.governance-keyring");

type KeyringHolder = { [KEYRING_KEY]?: Keyring };

/**
 * The keyring of this process: the file `GOVERNANCE_PRIVATE_KEYS_FILE` names, loaded on the first call and kept for the
 * life of the process, so a running server uses exactly the keyring its boot preflight checked, and a changed keyring
 * takes effect when Studio restarts.
 *
 * Throws an Error that names the variable when it is unset, and the KeyringError of `loadKeyring` when the file does
 * not load; a keyring that did not load is never kept.
 */
export function governanceKeyring(): Keyring {
  const holder = globalThis as KeyringHolder;
  const loaded = holder[KEYRING_KEY];
  if (loaded !== undefined) return loaded;
  const file = process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
  if (file === undefined || file === "") throw new Error(KEYS_FILE_MISSING_MESSAGE);
  const keyring = loadKeyring(file);
  holder[KEYRING_KEY] = keyring;
  return keyring;
}

/** Test seam: forgets the loaded keyring, so the next call of `governanceKeyring()` reads the file as a new process. */
export function resetGovernanceKeyring(): void {
  delete (globalThis as KeyringHolder)[KEYRING_KEY];
}
