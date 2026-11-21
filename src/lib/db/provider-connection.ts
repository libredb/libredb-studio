import type { DatabaseConnection, SSHTunnelConfig } from "@/lib/types";
import { SSH_TUNNEL_FIELDS } from "@/lib/storage/secret-fields";

/**
 * The tunnel fields a provider receives: the ones `SSH_TUNNEL_FIELDS` classifies `public`, derived once from that map
 * so that a second, hand-kept list cannot drift from the classification storage encryption already reads.
 */
const PUBLIC_TUNNEL_FIELDS: readonly string[] = Object.entries(SSH_TUNNEL_FIELDS)
  .filter(([, fieldClass]) => fieldClass === "public")
  .map(([field]) => field);

/**
 * The connection a provider is built from (FND-2, docs/SECURITY.md control 3.41): the caller's record with its
 * `sshTunnel` reduced to the fields `SSH_TUNNEL_FIELDS` classifies `public`.
 *
 * WHY. Core opens the SSH tunnel itself (`getOrCreateProvider`, `acquireExecutionProfileProvider` and
 * `withOneShotTunnel` in `./factory`), with the tunnel's password, private key and passphrase, and hands the provider
 * the outcome: the local endpoint in `host` and `port` and the far end under `TUNNEL_FAR_END`. A provider therefore
 * needs no tunnel credential, and `createDatabaseProvider` builds every provider from this function's answer, so none
 * holds one, whichever path built it.
 *
 * WHAT STAYS. Every public tunnel field the record holds, each value as the record holds it: several providers read
 * `sshTunnel.enabled` to refuse a tunnel they cannot use or one that was asked for and not opened, Databend frames the
 * route into its sign-in latch key, and the edit-plan seal (`connectionFingerprint`) frames the route from the
 * provider's own config, so the route must be the record's or every tunnelled edit plan is refused. A malformed value
 * passes through unchanged, so each provider's own refusal of it still speaks; core adds no validation here. A key the
 * classification does not name is left out. The symbol-keyed markers `TUNNEL_FAR_END` and `LITERAL_SEED_FILE` are
 * carried by the object spread.
 *
 * WHAT IS RETURNED. A new object when `sshTunnel` is a non-null object that is not an array, and otherwise the record
 * itself, so a connection without a tunnel object is built exactly as it is passed and a malformed `sshTunnel` still
 * meets the provider's own wrong-type refusal. It never throws and never writes to its argument.
 *
 * The provider keeps `sshTunnel` only until core owns the tunnel decisions those providers make from it; then the
 * field leaves the provider's view altogether.
 */
export function providerConnection<T extends DatabaseConnection>(connection: T): T {
  const tunnel: unknown = connection.sshTunnel;
  if (tunnel === null || typeof tunnel !== "object" || Array.isArray(tunnel)) return connection;
  const kept: Record<string, unknown> = {};
  for (const field of PUBLIC_TUNNEL_FIELDS) {
    if (Object.hasOwn(tunnel, field)) kept[field] = Reflect.get(tunnel, field);
  }
  // The one assertion: TypeScript cannot follow the copy of the classified keys above, and the record's values are
  // kept as they are, malformed ones included, so `kept` is exactly as well-formed as the record's own `sshTunnel`.
  return { ...connection, sshTunnel: kept as unknown as SSHTunnelConfig };
}
