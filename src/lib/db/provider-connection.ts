import type { DatabaseConnection, SSHTunnelConfig } from "@/lib/types";
import { SSH_TUNNEL_FIELDS } from "@/lib/storage/secret-fields";
import { DatabaseConfigError } from "./errors";

/**
 * The tunnel fields a provider receives: the ones `SSH_TUNNEL_FIELDS` classifies `public`, derived once from that map
 * so that a second, hand-kept list cannot drift from the classification storage encryption already reads.
 */
const PUBLIC_TUNNEL_FIELDS: readonly string[] = Object.entries(SSH_TUNNEL_FIELDS)
  .filter(([, fieldClass]) => fieldClass === "public")
  .map(([field]) => field);

/**
 * Whether `value` is plain data, as parsed JSON is: its prototype is `Object.prototype` or null, and every own property,
 * string or symbol keyed, is an enumerable data property. A copy of an object (an object spread, or the field-by-field
 * copy of the tunnel below) loses a field defined on the prototype or as not enumerable, and reads an own getter once
 * into a plain value; only for plain data does the copy answer every field exactly as the original does.
 */
function isPlainData(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true;
  });
}

/**
 * Refuse a connection whose `sshTunnel` is present (neither `undefined` nor `null`) when that tunnel, or the record that
 * carries it, is not plain data (`isPlainData`), with a `DatabaseConfigError` that names the field and never its value.
 * A connection without a tunnel passes whatever its shape.
 *
 * WHY. Every path from a tunnelled record to a provider copies it: `providerConnection` copies the record and the
 * tunnel's public fields, and the entry points that open the tunnel (`getOrCreateProvider`,
 * `acquireExecutionProfileProvider` and `withOneShotTunnel` in `./factory`) build from a copy with the tunnel's local
 * endpoint in it. A copy of anything but plain data can answer differently from the record core read (a field defined
 * on the prototype or as not enumerable is lost, so a `readOnly` or an `ssl` would reach the provider as undefined), so
 * such a record is refused rather than built from a different connection with no error.
 *
 * WHERE IT RUNS. In `providerConnection`, so every build checks it, and at each of those three entry points beside
 * `assertReadOnlyHonoured`, ahead of the cache key and of `createSSHTunnel`, because their copy is made before
 * `providerConnection` runs and would hand it plain data.
 */
export function assertTunnelRecordIsPlainData(connection: DatabaseConnection): void {
  const tunnel: unknown = connection.sshTunnel;
  if (tunnel === undefined || tunnel === null) return;
  if (!isPlainData(tunnel)) {
    throw new DatabaseConfigError(
      "The connection's sshTunnel must be a plain object of data fields; no provider was built.",
    );
  }
  if (!isPlainData(connection)) {
    throw new DatabaseConfigError(
      "A connection with an sshTunnel must be a plain object of data fields; no provider was built.",
    );
  }
}

/**
 * The connection a provider is built from (FND-2, docs/SECURITY.md control 3.41): the caller's record with its
 * `sshTunnel` reduced to the fields `SSH_TUNNEL_FIELDS` classifies `public`.
 *
 * WHY. When core opens the SSH tunnel (`getOrCreateProvider`, `acquireExecutionProfileProvider` and
 * `withOneShotTunnel` in `./factory`), it dials with the tunnel's password, private key and passphrase itself, and hands
 * the provider the outcome: the local endpoint in `host` and `port` and the far end under `TUNNEL_FAR_END`. A provider
 * therefore needs no tunnel credential, and `createDatabaseProvider` builds every provider from this function's answer,
 * so none holds one, whichever path built it. A caller that builds a provider without one of those three opens no
 * tunnel: its provider sees the record's own `sshTunnel.enabled` and no `TUNNEL_FAR_END`.
 *
 * WHAT STAYS. Every public tunnel field the record holds, each value as the record holds it: several providers read
 * `sshTunnel.enabled` to refuse a tunnel they cannot use or one that was asked for and not opened, Databend frames the
 * route into its sign-in latch key, and the edit-plan seal (`connectionFingerprint`) frames the route from the
 * provider's own config, so the route must be the record's or every tunnelled edit plan is refused. A malformed value
 * inside the tunnel object passes through unchanged, so a provider's own check of that field still speaks. A key the
 * classification does not name is left out. The symbol-keyed markers `TUNNEL_FAR_END` and `LITERAL_SEED_FILE` are
 * carried by the object spread.
 *
 * WHAT IS REFUSED. With `sshTunnel` absent (`undefined` or `null`) the record itself is returned, so a connection
 * without a tunnel is built exactly as it is passed. Any other `sshTunnel` must be plain data, and so must the record
 * that carries it (`assertTunnelRecordIsPlainData`): a copy loses a field defined on the prototype or as not enumerable
 * and reads an own getter once, so only plain data reaches the provider exactly as core read it. A string, a number, an
 * array, a class instance or a getter is refused with a `DatabaseConfigError` that names the field and never
 * its value. It never writes to its argument.
 *
 * The provider keeps `sshTunnel` only until core owns the tunnel decisions those providers make from it; then the
 * field leaves the provider's view altogether.
 */
export function providerConnection<T extends DatabaseConnection>(connection: T): T {
  const tunnel: unknown = connection.sshTunnel;
  if (tunnel === undefined || tunnel === null) return connection;
  assertTunnelRecordIsPlainData(connection);
  const kept: Record<string, unknown> = {};
  for (const field of PUBLIC_TUNNEL_FIELDS) {
    if (Object.hasOwn(tunnel, field)) kept[field] = Reflect.get(tunnel, field);
  }
  // The one assertion: TypeScript cannot follow the copy of the classified keys above, and the record's values are
  // kept as they are, malformed ones included, so `kept` is exactly as well-formed as the record's own `sshTunnel`.
  return { ...connection, sshTunnel: kept as unknown as SSHTunnelConfig };
}
