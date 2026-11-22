import { openSecret, readStoredSecret, type RefusalReason, sealSecret } from "./encryption";
import { connectionBinding } from "./envelope-binding";
import { walkSecretFields } from "./secret-fields";
import type { CredentialEnvelopeState } from "./types";
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
 *
 * Every value is sealed for its place (./envelope-binding.ts): the row's owner, the connection's id,
 * the field path and the connection's identity fields. So every function here takes the owner, the
 * `user_id` of the user_storage row the list is written to or was read from.
 */
export {
  CONNECTION_FIELDS,
  type FieldClass,
  SECRET_FIELD_MAPS,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
  withoutSecretFields,
} from "./secret-fields";

/** A secret value a read or a re-seal did not open, named by its connection's id and its field path. */
export interface OmittedSecret {
  id: unknown;
  path: string;
  reason: RefusalReason;
}

/** The connection's id as a report names it: as the store holds it, `null` when absent. */
function idOf(connection: DatabaseConnection): unknown {
  return (connection as { id?: unknown }).id ?? null;
}

/**
 * Every write goes through this, and seals each secret under the binding of the record as written,
 * for `owner`. A value is left as it is only when it is a v2 envelope that opens under that binding,
 * so a re-save is not a re-encryption; everything else is sealed as text: plaintext, a v1 envelope,
 * a v2 envelope sealed for another place, and anything merely shaped like an envelope (a real
 * password `v2:hunter2`, or a corrupted three-segment value). This path is fed from `localStorage`
 * through `useStorageSync`, which holds plaintext by design, so a value reaching here is
 * overwhelmingly a real credential, and the write path never opens a version 1 value. Never returns
 * a connection with a plaintext credential in it.
 */
export function encryptConnections(owner: string, connections: DatabaseConnection[]): DatabaseConnection[] {
  return connections.map((connection) => {
    const binding = connectionBinding(owner, connection);
    return walkSecretFields(connection, (value, path) => {
      const here = binding.field(path);
      return openSecret(value, here).kind === "v2" ? value : sealSecret(value, here);
    }).connection;
  });
}

export interface ConnectionReadResult {
  connections: DatabaseConnection[];
  /** Every secret that was not handed back, by connection and path. The caller reports them once, not per field. */
  omitted: OmittedSecret[];
}

/**
 * Every read goes through this, for the row of `owner` and the store's envelope `state`
 * (`readStoredSecret`). A value that does not open is OMITTED and the record kept:
 *
 * - Throwing would empty all twelve collections for a rotated key, taking the user's query history,
 *   saved queries, charts and snapshots down with the passwords.
 * - Dropping the record would be worse. useStorageSync is a write-through cache, so a connection
 *   missing from a read is persisted as a deletion on the next push - destroying ciphertext that a
 *   restored key could still have opened.
 *
 * Omission leaves an empty password box the user can retype, and the next sync seals it again.
 */
export function decryptConnections(
  owner: string,
  connections: DatabaseConnection[],
  state: CredentialEnvelopeState,
): ConnectionReadResult {
  const omitted: OmittedSecret[] = [];
  const opened = connections.map((connection) => {
    const binding = connectionBinding(owner, connection);
    return walkSecretFields(connection, (value, path) => {
      const read = readStoredSecret(value, binding.field(path), state);
      if (read.kind === "opened") return read.value;
      omitted.push({ id: idOf(connection), path, reason: read.reason });
      return undefined;
    }).connection;
  });
  return { connections: opened, omitted };
}

export interface ConnectionResealResult {
  connections: DatabaseConnection[];
  /** Values sealed as v2: version 1 envelopes and unsealed values. */
  resealed: number;
  /** v2 values that already open for their place, left as they are. */
  kept: number;
  /** Values that open nowhere here, left as they are. */
  unopened: OmittedSecret[];
}

/**
 * The operator re-seal of one row (./reseal.ts): each secret of the record as stored, for `owner`,
 * is kept when it is a v2 value that opens for its place, sealed as v2 under that place when it is a
 * version 1 envelope that opens or an unsealed value, and left exactly as it is, and named, when it
 * opens as neither: it is already unreadable, and the backup keeps it for a restored key.
 */
export function resealConnections(owner: string, connections: DatabaseConnection[]): ConnectionResealResult {
  const unopened: OmittedSecret[] = [];
  let resealed = 0;
  let kept = 0;
  const rewritten = connections.map((connection) => {
    const binding = connectionBinding(owner, connection);
    return walkSecretFields(connection, (value, path) => {
      const here = binding.field(path);
      const read = openSecret(value, here);
      if (read.kind === "v2") {
        kept += 1;
        return value;
      }
      if (read.kind === "unopenable") {
        unopened.push({ id: idOf(connection), path, reason: "unopenable" });
        return value;
      }
      resealed += 1;
      return sealSecret(read.value, here);
    }).connection;
  });
  return { connections: rewritten, resealed, kept, unopened };
}
