import { openSecret, type RefusalReason, sealSecret, type StoredSecret, storedSecretRead } from "./encryption";
import { connectionBinding, connectionBindingProblem, type EnvelopeBinding } from "./envelope-binding";
import { nonTextSecretPaths, walkSecretFields, withoutSecretPaths } from "./secret-fields";
import { ConnectionWriteRefused, type CredentialEnvelopeState } from "./types";
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
 *
 * Three rules hold in every direction, so no value passes a seal or an open unexamined:
 *
 * - A list element that is not an object is not a connection, and is left exactly as it is.
 * - A secret path holding a value that is neither text nor null (`nonTextSecretPaths`) is refused by path: omitted on
 *   read as `not-text`, refused on write, left and named by the re-seal.
 * - A record that holds a v2 value which opens was written whole by this version, which seals every secret of a record
 *   on every write. A version 1 or unsealed value beside it was therefore put there outside Studio, and is refused as
 *   `mixed`: omitted on read, left and named by the re-seal, never sealed for the record.
 */
export {
  CONNECTION_FIELDS,
  type FieldClass,
  SECRET_FIELD_MAPS,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
  withoutSecretFields,
} from "./secret-fields";

/** Why a secret value was not handed back: the store's read rule (`RefusalReason`), or one of the rules above. */
export type OmissionReason = RefusalReason | "mixed" | "not-text" | "unbindable";

/** A secret value a read or a re-seal did not open, named by its connection's id and its field path. */
export interface OmittedSecret {
  id: unknown;
  path: string;
  reason: OmissionReason;
}

/** The connection's id as a report names it: as the store holds it, `null` when absent. */
function idOf(connection: DatabaseConnection): unknown {
  return (connection as { id?: unknown }).id ?? null;
}

/** A list element that can be a connection: an object, and not an array. */
function isConnectionRecord(value: unknown): value is DatabaseConnection {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every text secret of `connection`, opened under its binding, by path. */
function openEach(connection: DatabaseConnection, binding: { field(path: string): EnvelopeBinding }) {
  const reads = new Map<string, StoredSecret>();
  walkSecretFields(connection, (value, path) => {
    reads.set(path, openSecret(value, binding.field(path)));
    return value;
  });
  return { reads, holdsV2: [...reads.values()].some(({ kind }) => kind === "v2") };
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
 *
 * Throws `ConnectionWriteRefused`, naming the list index, for a record with a secret that is not text or a record that has no binding
 * (`connectionBindingProblem`): neither can be sealed for its place.
 */
export function encryptConnections(owner: string, connections: DatabaseConnection[]): DatabaseConnection[] {
  return connections.map((connection, index) => {
    if (!isConnectionRecord(connection)) return connection;
    const nonText = nonTextSecretPaths(connection);
    if (nonText.length > 0) {
      throw new ConnectionWriteRefused(
        `connections[${index}] holds a value that is not text at ${nonText.join(", ")}; a credential is text.`,
      );
    }
    const problem = connectionBindingProblem(connection);
    if (problem !== null) throw new ConnectionWriteRefused(`connections[${index}] cannot be stored: ${problem}`);
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
 * (`storedSecretRead`), under the rules above. A value that does not open is OMITTED and the record kept:
 *
 * - Throwing would empty all twelve collections for a rotated key, taking the user's query history,
 *   saved queries, charts and snapshots down with the passwords.
 * - Dropping the record would be worse. useStorageSync is a write-through cache, so a connection
 *   missing from a read is persisted as a deletion on the next push - destroying ciphertext that a
 *   restored key could still have opened.
 *
 * Omission leaves an empty password box the user can retype, and the next sync seals it again. A record that has no
 * binding (`connectionBindingProblem`) is kept with every secret omitted as `unbindable`.
 */
export function decryptConnections(
  owner: string,
  connections: DatabaseConnection[],
  state: CredentialEnvelopeState,
): ConnectionReadResult {
  const omitted: OmittedSecret[] = [];
  const opened = connections.map((connection) => {
    if (!isConnectionRecord(connection)) return connection;
    const id = idOf(connection);
    const nonText = nonTextSecretPaths(connection);
    for (const path of nonText) omitted.push({ id, path, reason: "not-text" });
    const record = withoutSecretPaths(connection, nonText);
    if (connectionBindingProblem(record) !== null) {
      return walkSecretFields(record, (_value, path) => {
        omitted.push({ id, path, reason: "unbindable" });
        return undefined;
      }).connection;
    }
    const { reads, holdsV2 } = openEach(record, connectionBinding(owner, record));
    return walkSecretFields(record, (_value, path) => {
      const read = reads.get(path)!;
      if (holdsV2 && (read.kind === "v1" || read.kind === "plaintext")) {
        omitted.push({ id, path, reason: "mixed" });
        return undefined;
      }
      const decided = storedSecretRead(read, state);
      if (decided.kind === "opened") return decided.value;
      omitted.push({ id, path, reason: decided.reason });
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
  /** Values left as they are under the rules above: `not-text`, or `mixed` beside a v2 value of their record. */
  refused: OmittedSecret[];
}

/**
 * The operator re-seal of one row (./reseal.ts): each secret of the record as stored, for `owner`,
 * is kept when it is a v2 value that opens for its place, sealed as v2 under that place when it is a
 * version 1 envelope that opens or an unsealed value, and left exactly as it is, and named, when it
 * opens as neither: it is already unreadable, and the backup keeps it for a restored key. A value the rules above
 * refuse is left exactly as it is and named too. Throws for a record that has no binding (`connectionBindingProblem`),
 * which the caller checks first.
 */
export function resealConnections(owner: string, connections: DatabaseConnection[]): ConnectionResealResult {
  const unopened: OmittedSecret[] = [];
  const refused: OmittedSecret[] = [];
  let resealed = 0;
  let kept = 0;
  const rewritten = connections.map((connection) => {
    const id = idOf(connection);
    for (const path of nonTextSecretPaths(connection)) refused.push({ id, path, reason: "not-text" });
    const binding = connectionBinding(owner, connection);
    const { reads, holdsV2 } = openEach(connection, binding);
    return walkSecretFields(connection, (value, path) => {
      const read = reads.get(path)!;
      if (read.kind === "v2") {
        kept += 1;
        return value;
      }
      if (read.kind === "unopenable") {
        unopened.push({ id, path, reason: "unopenable" });
        return value;
      }
      if (holdsV2) {
        refused.push({ id, path, reason: "mixed" });
        return value;
      }
      resealed += 1;
      return sealSecret(read.value, binding.field(path));
    }).connection;
  });
  return { connections: rewritten, resealed, kept, unopened, refused };
}
