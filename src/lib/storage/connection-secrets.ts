import { encryptSecret, readSecret } from "./encryption";
import { walkSecretFields } from "./secret-fields";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Encryption at rest for a connection's credentials.
 *
 * Which fields are credentials, and the one walk that visits them, live in ./secret-fields.ts,
 * which imports no runtime code so a bundle that only splits and joins a connection (the VS Code
 * extension host) does not pull `./encryption` in. This module seals and opens through that same
 * walk, so the encrypt and decrypt paths and the split can never disagree about which fields they
 * cover. The classification names are re-exported here for the importers that already reach them
 * through this module.
 */
export {
  CONNECTION_FIELDS,
  type FieldClass,
  SECRET_FIELD_MAPS,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
  withoutSecretFields,
} from "./secret-fields";

/**
 * Seals everything except a value already PROVEN to open under the current key; leaves that one
 * alone so a re-save is not a re-encryption.
 *
 * Deliberately not `kind === "plaintext" ? encryptSecret(value) : value`: that would also pass an
 * `undecryptable` value through unchanged, and `undecryptable` is not "already sealed" - it is
 * "unopenable", which a real password shaped like an envelope claim (a user's actual password is
 * `v2:hunter2`, or a corrupted three-segment value) satisfies just as well as genuine ciphertext
 * does. This path is fed from `localStorage` through `useStorageSync`, which holds plaintext by
 * design, so a value reaching here is overwhelmingly a real credential, not corruption in transit;
 * encrypting it is the safe default. `decrypted` is the only outcome that proves the value already
 * opens under this key, so it is the only one left untouched.
 */
function sealIfPlaintext(value: string): string {
  return readSecret(value).kind === "decrypted" ? value : encryptSecret(value);
}

/** Opens a sealed value, passes a legacy plaintext through, and returns undefined for a dead one. */
function openOrDrop(value: string): string | undefined {
  const result = readSecret(value);
  return result.kind === "undecryptable" ? undefined : result.value;
}

/**
 * Every write goes through this. Never returns a connection with a plaintext credential in it: a
 * secret field is left alone only when it is already a v1 envelope that opens under the current
 * key (`readSecret` returns `decrypted`) - plaintext and anything merely shaped like an envelope
 * are both sealed.
 */
export function encryptConnections(connections: DatabaseConnection[]): DatabaseConnection[] {
  return connections.map((connection) => walkSecretFields(connection, sealIfPlaintext).connection);
}

export interface ConnectionReadResult {
  connections: DatabaseConnection[];
  /** How many secret fields could not be opened. The caller reports it once, not per field. */
  undecryptable: number;
}

/**
 * Every read goes through this. An unreadable field is OMITTED and the record kept:
 *
 * - Throwing would empty all twelve collections for a rotated key, taking the user's query history,
 *   saved queries, charts and snapshots down with the passwords.
 * - Dropping the record would be worse. useStorageSync is a write-through cache, so a connection
 *   missing from a read is persisted as a deletion on the next push - destroying ciphertext that a
 *   restored key could still have opened.
 *
 * Omission leaves an empty password box the user can retype, and the next sync re-seals it under
 * the current key.
 */
export function decryptConnections(connections: DatabaseConnection[]): ConnectionReadResult {
  let undecryptable = 0;
  const opened = connections.map((connection) => {
    const result = walkSecretFields(connection, openOrDrop);
    undecryptable += result.dropped;
    return result.connection;
  });
  return { connections: opened, undecryptable };
}
