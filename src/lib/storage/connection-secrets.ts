import { encryptSecret, readSecret } from "./encryption";
import type { DatabaseConnection, SSHTunnelConfig, SSLConfig } from "@/lib/types";

/**
 * The single answer to "which stored fields are credentials".
 *
 * Why these are `Record<keyof T, FieldClass>` maps and not a list of secret field names: lazy
 * migration only re-writes what it reads, so a credential-bearing field nobody remembered to add
 * to a list stays in the clear forever in every existing deployment. A list fails silently. These
 * maps fail at `bun run typecheck` - add a field to DatabaseConnection, SSLConfig or
 * SSHTunnelConfig and the object literal below stops satisfying its type until the new field is
 * classified. A field has to opt OUT of scrutiny, deliberately; there is no opt-in step to forget.
 *
 * `nested` marks a container whose own map carries the classification, so "I did not think about
 * it" and "it is a container" are different answers rather than the same silence.
 */
export type FieldClass = "secret" | "public" | "nested";

export const CONNECTION_FIELDS: Record<keyof DatabaseConnection, FieldClass> = {
  id: "public",
  name: "public",
  type: "public",
  host: "public",
  port: "public",
  user: "public",
  password: "secret",
  database: "public",
  // Carries scheme://user:pass@host. The same shape src/lib/audit.ts redacts out of log lines.
  connectionString: "secret",
  createdAt: "public",
  color: "public",
  environment: "public",
  group: "public",
  ssl: "nested",
  sshTunnel: "nested",
  serviceName: "public",
  instanceName: "public",
  // A data-centre NAME (`datacenter1`), which the server publishes itself in
  // `system.local.data_center` and prints in the driver's own error message when it
  // is wrong. Nothing about it is a credential.
  localDataCenter: "public",
  // A DATABASE NAME (`admin`), not a credential. The password that authenticates
  // against it is the secret, and it is classified above.
  authSource: "public",
  managed: "public",
  seedId: "public",
  agentUser: "public",
  agentPassword: "secret",
};

export const SSL_FIELDS: Record<keyof SSLConfig, FieldClass> = {
  mode: "public",
  // Certificates are public by construction; encrypting them costs diagnosability and buys nothing.
  caCert: "public",
  clientCert: "public",
  clientKey: "secret",
  rejectUnauthorized: "public",
};

export const SSH_TUNNEL_FIELDS: Record<keyof SSHTunnelConfig, FieldClass> = {
  enabled: "public",
  host: "public",
  port: "public",
  username: "public",
  authMethod: "public",
  password: "secret",
  privateKey: "secret",
  // Encrypting the private key and leaving the passphrase that unlocks it readable protects nothing.
  passphrase: "secret",
};

/**
 * Every classification map in this module, in one place, so a consumer that needs "which fields
 * does this product classify as credentials" imports one name instead of restating three.
 * (src/lib/agent/state-guard.ts derives its credential-key set from it.)
 *
 * Note what this is NOT: unlike the maps above, it carries no compile-time guarantee. The maps
 * fail `bun run typecheck` when a field goes unclassified; nothing makes a FOURTH map appear in
 * this array. Adding one is a manual step, and the direction that loses coverage silently is
 * ADDING a map without registering it - the storage layer would encrypt the new field while a
 * consumer deriving from this array never learns it exists. So the check that covers this lives in
 * tests/unit/lib/agent/state-guard.test.ts and is reflective, not a pinned list of names: it walks
 * this module's own exports and fails when one of them is a classification map this array omits.
 *
 * That check sees EXPORTED maps only. A fourth map kept module-private and wired straight into
 * `walkConnection` is invisible to it, and would be sealed here while a consumer persisted it in
 * the clear. Export any new classification map (all three above are) and the check covers it;
 * recorded in docs/BACKLOG.md so the gap is tracked rather than only described.
 *
 * Deliberately NOT consumed by this module's own encrypt/decrypt walk. The three maps are not
 * interchangeable there - each applies at a different level of a connection (root, `ssl`,
 * `sshTunnel`), which a flat array cannot express - so making `walkConnection` iterate it would
 * mean encoding those locations too, i.e. redesigning the walk rather than deduplicating a list.
 */
export const SECRET_FIELD_MAPS: readonly Record<string, FieldClass>[] = [
  CONNECTION_FIELDS,
  SSL_FIELDS,
  SSH_TUNNEL_FIELDS,
];

/** Derived, never written out twice: a second hand-maintained list is a second thing that drifts. */
function secretsOf(map: Record<string, FieldClass>): string[] {
  return Object.keys(map).filter((key) => map[key] === "secret");
}

const CONNECTION_SECRET_KEYS = secretsOf(CONNECTION_FIELDS);
const SSL_SECRET_KEYS = secretsOf(SSL_FIELDS);
const SSH_TUNNEL_SECRET_KEYS = secretsOf(SSH_TUNNEL_FIELDS);

/**
 * Applies `transform` to each named field of `target` in place. A transform returning `undefined`
 * DELETES the field rather than storing undefined, and is counted. Returns the number deleted.
 *
 * An empty string is skipped: there is nothing to protect, and enveloping it would turn "no
 * password set" into a value the UI renders as a filled-in field.
 */
function mapSecretFields(
  target: Record<string, unknown>,
  keys: string[],
  transform: (value: string) => string | undefined,
): number {
  let dropped = 0;
  for (const key of keys) {
    const value = target[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const next = transform(value);
    if (next === undefined) {
      delete target[key];
      dropped += 1;
    } else {
      target[key] = next;
    }
  }
  return dropped;
}

/**
 * Walks one connection's three field groups. Both directions share this so the encrypt and decrypt
 * paths can never disagree about WHICH fields they cover - the classic way a round trip loses a
 * field is two walkers with two opinions.
 */
function walkConnection(
  connection: DatabaseConnection,
  transform: (value: string) => string | undefined,
): { connection: DatabaseConnection; dropped: number } {
  const copy: Record<string, unknown> = { ...connection };
  let dropped = mapSecretFields(copy, CONNECTION_SECRET_KEYS, transform);

  if (copy.ssl) {
    const ssl = { ...(copy.ssl as Record<string, unknown>) };
    dropped += mapSecretFields(ssl, SSL_SECRET_KEYS, transform);
    copy.ssl = ssl;
  }
  if (copy.sshTunnel) {
    const tunnel = { ...(copy.sshTunnel as Record<string, unknown>) };
    dropped += mapSecretFields(tunnel, SSH_TUNNEL_SECRET_KEYS, transform);
    copy.sshTunnel = tunnel;
  }

  return { connection: copy as unknown as DatabaseConnection, dropped };
}

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
  return connections.map((connection) => walkConnection(connection, sealIfPlaintext).connection);
}

export interface ConnectionReadResult {
  connections: DatabaseConnection[];
  /** How many secret fields could not be opened. The caller reports it once, not per field. */
  undecryptable: number;
}

/**
 * Every read goes through this. An unreadable field is OMITTED and the record kept:
 *
 * - Throwing would empty all ten collections for a rotated key, taking the user's query history,
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
    const result = walkConnection(connection, openOrDrop);
    undecryptable += result.dropped;
    return result.connection;
  });
  return { connections: opened, undecryptable };
}
