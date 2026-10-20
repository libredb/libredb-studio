import type { DatabaseConnection, SSHTunnelConfig, SSLConfig } from "@/lib/types";

/**
 * Which stored fields of a connection are credentials, and the one walk that visits them.
 *
 * Split out of connection-secrets.ts so that a reader that must split a connection into its
 * public fields and its secrets, and join them back, can do it without `./encryption`: the VS
 * Code extension host keeps the public fields in a setting and each secret in VS Code's secret
 * storage, and importing connection-secrets.ts would put `node:crypto` and
 * `@/lib/config/auth-env` in its bundle. connection-secrets.ts walks through this module, so the
 * server's encryption and the extension's split can never disagree about which fields they cover.
 *
 * This module's imports stay type-only and it re-exports nothing, so it pulls no runtime code into
 * whatever bundles it; tests/unit/lib/storage/secret-fields.test.ts holds both.
 */

/**
 * A connection whose `createdAt` may be the ISO string a stored settings entry holds rather than a
 * `Date`: every function here is generic over this, so a caller passes either shape under `strict`.
 */
export type SecretFieldRecord = Omit<DatabaseConnection, "createdAt"> & { createdAt: Date | string };

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
  // A SASL MECHANISM NAME (`SCRAM-SHA-512`), which a broker's own configuration lists in the
  // clear. It says how the password is checked; the password is the secret, classified above.
  saslMechanism: "public",
  schema: "public",
  queryTimeout: "public",
  // A display preference: whether this browser reads the catalog when the connection
  // opens. It grants nothing and unlocks nothing.
  skipObjectScan: "public",
  // Whether the provider refuses writes on this connection (#1089). A mode, not a credential: it
  // grants nothing, and the browser reads it to draw the Read-only marker.
  readOnly: "public",
  // Db2's acceptance of a cleartext password (#786). A choice about the transport, not a credential.
  allowInsecureAuth: "public",
  // Addresses, as `host` is. The token they receive is the secret, classified above.
  dataServers: "public",
  // The warehouse: a compute name, from Databend Cloud's DSN or a Snowflake account. It picks where a statement
  // runs and grants nothing; the password, token or key sent with it is the secret, classified above.
  warehouse: "public",
  location: "public",
  // Snowflake's sign-in method, `keypair` or `pat`: it says which credential is sent, not the credential itself.
  authMethod: "public",
  // A PEM key's contents, the key-pair credential itself.
  privateKey: "secret",
  // What decrypts that key: a secret for the reason the key is.
  privateKeyPassphrase: "secret",
  // Snowflake's role, a name Snowflake itself prints in its errors and its query history. It decides what the
  // statements may do once signed in and grants nothing on its own; the key or token that signs in is the secret.
  role: "public",
  // The S3 signing region: a region name such as us-east-1, which the server publishes in its own errors. It decides
  // how a request is signed and grants nothing; the secret access key that signs is classified above.
  region: "public",
  // Kubernetes: a server path prefix (also RabbitMQ's Path prefix), a list of namespace names and a certificate host
  // name. Each says where requests go or what the tree shows; the credential that authenticates them is classified
  // above or under ssl.
  apiPath: "public",
  namespaces: "public",
  tlsServerName: "public",
  // An AMQP port: an address, as `port` is. It grants nothing.
  amqpPort: "public",
  securityMode: "public",
  // A thumbprint is the PUBLIC fingerprint of a public certificate: it identifies a server, it does not
  // authenticate anyone, and hiding it would stop an operator reading back what they pinned.
  serverCertificateThumbprint: "public",
  // Public key material, exactly as the tunnel's own fingerprint is: it names a key, it is not one,
  // and a reader has to be able to see it to compare it with what the device prints.
  hostKeyFingerprint: "public",
  // A policy URI is published by the server, and the other two are PATHS and not keys: the private
  // key stays in the file the path names and never enters a connection record, which is the reason
  // this provider takes a path at all.
  securityPolicyUri: "public",
  clientCertificatePath: "public",
  clientPrivateKeyPath: "public",
  managed: "public",
  seedId: "public",
  agentUser: "public",
  agentPassword: "secret",
  // Not `user`'s twin. `user` is a name an operator chose and can re-type; this is one
  // generated, opaque half of a credential pair, so leaving it readable narrows what a
  // leak has to guess from two values to one. See the field's own doc in types.ts.
  apiKeyId: "secret",
  apiKeySecret: "secret",
  // Addresses on a device the user wrote down, not a credential: Modbus TCP defines no authentication at
  // all, so there is nothing here to leak. Storing it `secret` would also mask it in the dialog, and a
  // document nobody can read is a document nobody can correct.
  registerMap: "public",
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
  // A fingerprint of the bastion's PUBLIC host key - the same string `ssh-keygen -lf` prints and
  // `ssh-keyscan` hands out to anyone who asks. It authenticates the server TO us; it grants no
  // access and unlocks nothing, so there is nothing to seal. Sealing it would also cost the one
  // thing it exists for: the user has to be able to READ it to compare it against their own
  // known_hosts when a mismatch is reported.
  hostKeyFingerprint: "public",
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
 * the exports of src/lib/storage/connection-secrets.ts, which re-exports this module's maps, and
 * fails when one of them is a classification map this array omits. So a new map is exported here,
 * registered in this array AND re-exported from connection-secrets.ts; the leaf's own test
 * (tests/unit/lib/storage/secret-fields.test.ts) fails when the re-export is missing.
 *
 * That check sees EXPORTED maps only. A fourth map kept module-private and wired straight into
 * `walkSecretFields` is invisible to it, and would be sealed here while a consumer persisted it in
 * the clear. Export any new classification map (all three above are) and the check covers it;
 * recorded in docs/BACKLOG.md so the gap is tracked rather than only described.
 *
 * Deliberately NOT consumed by this module's own walk. The three maps are not
 * interchangeable there - each applies at a different level of a connection (root, `ssl`,
 * `sshTunnel`), which a flat array cannot express - so making `walkSecretFields` iterate it would
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
 * Applies `transform` to each named field of `target` in place, passing the field's path (`prefix`
 * plus its name). A transform returning `undefined` DELETES the field rather than storing
 * undefined, and is counted. Returns the number deleted.
 *
 * An empty string is skipped: there is nothing to protect, and enveloping it would turn "no
 * password set" into a value the UI renders as a filled-in field.
 */
function mapSecretFields(
  target: Record<string, unknown>,
  keys: string[],
  prefix: string,
  transform: (value: string, path: string) => string | undefined,
): number {
  let dropped = 0;
  for (const key of keys) {
    const value = target[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const next = transform(value, `${prefix}${key}`);
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
 *
 * `path` is what a secret is stored under outside a connection: the field name at the root,
 * `ssl.<field>` or `sshTunnel.<field>` below it.
 */
export function walkSecretFields<T extends SecretFieldRecord>(
  connection: T,
  transform: (value: string, path: string) => string | undefined,
): { connection: T; dropped: number } {
  const copy: Record<string, unknown> = { ...connection };
  let dropped = mapSecretFields(copy, CONNECTION_SECRET_KEYS, "", transform);

  if (copy.ssl) {
    const ssl = { ...(copy.ssl as Record<string, unknown>) };
    dropped += mapSecretFields(ssl, SSL_SECRET_KEYS, "ssl.", transform);
    copy.ssl = ssl;
  }
  if (copy.sshTunnel) {
    const tunnel = { ...(copy.sshTunnel as Record<string, unknown>) };
    dropped += mapSecretFields(tunnel, SSH_TUNNEL_SECRET_KEYS, "sshTunnel.", transform);
    copy.sshTunnel = tunnel;
  }

  return { connection: copy as unknown as T, dropped };
}

/**
 * A copy with every secret field removed, for a reader that may use a connection but must not
 * hold its credentials: the browser, for a managed seed it opens by id
 * (GET /api/connections/managed). The same maps and walker as encryption, so a field classified
 * secret tomorrow is withheld here without a second list to remember. An empty value stays, as it
 * does in the walker: there is nothing in it to withhold.
 */
export function withoutSecretFields<T extends SecretFieldRecord>(connection: T): T {
  return walkSecretFields(connection, () => undefined).connection;
}

/**
 * Every non-empty secret of a connection, keyed by its path (`password`, `ssl.clientKey`,
 * `sshTunnel.passphrase`, ...). The same walk as encryption, so a field classified secret tomorrow
 * is collected here without a second list to remember. The input is not changed.
 */
export function secretFieldValues<T extends SecretFieldRecord>(connection: T): Record<string, string> {
  const values: Record<string, string> = {};
  walkSecretFields(connection, (value, path) => {
    values[path] = value;
    return value;
  });
  return values;
}

/** Every path `walkSecretFields` can visit, and so the only paths `withSecretFieldValues` writes. */
const SECRET_PATHS = new Map<string, { container?: "ssl" | "sshTunnel"; key: string }>([
  ...CONNECTION_SECRET_KEYS.map((key) => [key, { key }] as const),
  ...SSL_SECRET_KEYS.map((key) => [`ssl.${key}`, { container: "ssl", key }] as const),
  ...SSH_TUNNEL_SECRET_KEYS.map((key) => [`sshTunnel.${key}`, { container: "sshTunnel", key }] as const),
]);

/**
 * A copy of `connection` with each value of `values` written at its path, the inverse of
 * `secretFieldValues`. Every path is checked before any is written, and the call throws on a path
 * the classification does not call secret (a public field, a container, `__proto__`) or on one
 * whose container the connection does not have: writing anything else would let a stored secret
 * overwrite a field nobody stored as one. The thrown message names the path, never the value.
 * The input is not changed; the record and each container written to are copies.
 */
export function withSecretFieldValues<T extends SecretFieldRecord>(
  connection: T,
  values: Readonly<Record<string, string>>,
): T {
  const writes = Object.keys(values).map((path) => {
    const target = SECRET_PATHS.get(path);
    if (!target) throw new Error(`"${path}" is not a secret field of a connection.`);
    if (target.container && !connection[target.container]) {
      throw new Error(
        `"${path}" belongs in the connection's ${target.container} object, which this connection does not have.`,
      );
    }
    return { container: target.container, key: target.key, value: values[path] };
  });

  const copy: Record<string, unknown> = { ...connection };
  if (copy.ssl) copy.ssl = { ...(copy.ssl as Record<string, unknown>) };
  if (copy.sshTunnel) copy.sshTunnel = { ...(copy.sshTunnel as Record<string, unknown>) };
  for (const { container, key, value } of writes) {
    const target = container ? (copy[container] as Record<string, unknown>) : copy;
    target[key] = value;
  }
  return copy as unknown as T;
}
