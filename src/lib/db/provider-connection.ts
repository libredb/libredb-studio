import type { ProviderExecutionContext } from "@/lib/db/types";
import { TUNNEL_ROUTE } from "@/lib/types";
import type { DatabaseConnection, DatabaseType, SSHTunnelConfig, WithTunnelRoute } from "@/lib/types";
import { CONNECTION_STRING_ACCEPTED, SSH_TUNNEL_REFUSAL } from "./compatibility";
import { CONNECTION_FIELDS, REFUSED_CONNECTION_FIELDS, SEED_ONLY_FIELDS } from "./connection-fields";
import { offersSslPanel } from "./connection-form";
import { tunnelRoute } from "./connection-fingerprint";
import { DatabaseConfigError } from "./errors";
import { typeIdRow } from "./type-id";

/**
 * Studio's own fields every provider receives, whatever its engine declares (FND-2 slice 6):
 * - `id`, `name` and `type`: the record's identity, name and engine, which every provider logs and keys on;
 * - `queryTimeout`: the statement timeout, which core reads back from `provider.config` when it reuses a provider;
 * - `readOnly` and `seedId`: the read-only mode and the seed it came from, which the read-only providers read to
 *   refuse a write by name, and which core decides on before the build (`assertReadOnlyHonoured` in ./factory);
 * - `managed`: whether the record is an operator's seed, which the server-identity grant reads
 *   (`./auth/server-identity-gate`).
 * None is a credential. Studio's display and browser facts (`createdAt`, `color`, `environment`, `group`,
 * `skipObjectScan`), the agent credential (`agentUser`, `agentPassword`) and the SSH tunnel are not among them.
 */
export const PROVIDER_CORE_FIELDS = Object.freeze([
  "id",
  "name",
  "type",
  "queryTimeout",
  "readOnly",
  "managed",
  "seedId",
] as const satisfies readonly (keyof DatabaseConnection)[]);

/**
 * The connection fields a provider of `type` receives (FND-2 slice 6, docs/SECURITY.md control 3.41), composed from
 * the contract rows that declare them, each read through `typeIdRow`:
 * 1. `CONNECTION_FIELDS`, the fields its connection dialog draws;
 * 2. the fields of its `SEED_ONLY_FIELDS` row, the fields only its provider reads and only a seed names;
 * 3. `connectionString` where `CONNECTION_STRING_ACCEPTED` answers true, the URI a seed or an embedder may hand it;
 * 4. `ssl` where the dialog offers the TLS panel (`offersSslPanel` in ./connection-form);
 * 5. `host` and `port` where the engine takes an SSH tunnel (`SSH_TUNNEL_REFUSAL` is null), because core writes the
 *    tunnel's local endpoint there;
 * 6. `REFUSED_CONNECTION_FIELDS`, the fields it receives only to refuse them by name;
 * 7. `PROVIDER_CORE_FIELDS`, Studio's own fields every provider receives.
 * Each field once, in that order. The answer is frozen.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no provider.
 */
export function providerFields(type: DatabaseType): readonly (keyof DatabaseConnection)[] {
  const fields: (keyof DatabaseConnection)[] = [
    ...typeIdRow(CONNECTION_FIELDS, type),
    ...(typeIdRow(SEED_ONLY_FIELDS, type)?.fields ?? []),
    ...(typeIdRow(CONNECTION_STRING_ACCEPTED, type) ? (["connectionString"] as const) : []),
    ...(offersSslPanel(type) ? (["ssl"] as const) : []),
    ...(typeIdRow(SSH_TUNNEL_REFUSAL, type) === null ? (["host", "port"] as const) : []),
    ...typeIdRow(REFUSED_CONNECTION_FIELDS, type),
    ...PROVIDER_CORE_FIELDS,
  ];
  return Object.freeze([...new Set(fields)]);
}

/**
 * Whether `value` is plain data, as parsed JSON is: its prototype is `Object.prototype` or null, and every own property,
 * string or symbol keyed, is an enumerable data property. A copy of an object (an object spread or rest) loses a field
 * defined on the prototype or as not enumerable, and reads an own getter once into a plain value; only for plain data
 * does the copy answer every field exactly as the original does.
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
 * WHY. Every path from a tunnelled record to a provider copies it: `providerConnection` copies the record and frames
 * the tunnel's route, and the entry points that open the tunnel (`getOrCreateProvider`,
 * `acquireExecutionProfileProvider` and `withOneShotTunnel` in `./factory`) build from a copy with the tunnel's local
 * endpoint in it. A copy of anything but plain data can answer differently from the record core read (a field defined
 * on the prototype or as not enumerable is lost, so a `readOnly` or an `ssl` would reach the provider as undefined), so
 * such a record is refused rather than built from a different connection with no error.
 *
 * WHERE IT RUNS. In `providerConnection`, so every build checks it, and first in core's decision about the tunnel
 * (`decideTunnel` in `./tunnel-decision`), which those three entry points take ahead of the cache key and of
 * `createSSHTunnel`, because their copy is made before `providerConnection` runs and would hand it plain data.
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
 * Refuse an execution context that is not plain data (`isPlainData`), with a `DatabaseConfigError` that names the
 * context and never a value.
 *
 * WHY. `createDatabaseProvider` hands a provider a copy of the caller's execution context with core's egress decision
 * added (`ProviderBuildContext` in `./types`), while core reads the caller's own object for the owner's pool. A copy of
 * anything but plain data can answer differently from the object core read: a `readOnly` or an
 * `allowExternalFileAccess` defined on the prototype or as not enumerable would reach the provider as undefined, and
 * the provider would take its default with no error. So such a context is refused rather than built from a different
 * one, as `assertTunnelRecordIsPlainData` refuses such a tunnelled record.
 */
export function assertExecutionContextIsPlainData(execution: ProviderExecutionContext): void {
  if (!isPlainData(execution)) {
    throw new DatabaseConfigError(
      "The execution context must be a plain object of data fields; no provider was built.",
    );
  }
}

/**
 * The connection a provider is built from (FND-2, docs/SECURITY.md control 3.41): the caller's record without its
 * `sshTunnel`, and with the tunnel's route under `TUNNEL_ROUTE` in its place.
 *
 * WHY. Core decides every tunnel (`decideTunnel` in `./tunnel-decision`) and opens it (`getOrCreateProvider`,
 * `acquireExecutionProfileProvider` and `withOneShotTunnel` in `./factory`) with the tunnel's own fields, and hands the
 * provider the outcome: the local endpoint in `host` and `port` and the far end under `TUNNEL_FAR_END`. A provider
 * therefore needs nothing of the tunnel's configuration, and `createDatabaseProvider` builds every provider from this
 * function's answer, so none receives `sshTunnel`, its credentials or its readable fields, whichever path built it.
 *
 * WHAT A PROVIDER RECEIVES. Every other field as the record holds it, every own symbol key (`TUNNEL_FAR_END` and
 * `LITERAL_SEED_FILE` among them), and, for a record that carries a tunnel object, on or off, `tunnelRoute` of that
 * tunnel under `TUNNEL_ROUTE`, replacing any value the caller set. The edit-plan seal (`connectionFingerprint`) frames
 * the route from the provider's own config, so it must be the record's or every tunnelled edit plan is refused, and
 * the record side frames an off tunnel's route too; Databend's sign-in latch reads it through `requireTunnelRoute` in
 * `./utils/require-tunnel-route`.
 *
 * PRECONDITION. The tunnel is one core's decision accepted: its only caller, `buildProvider` in `./factory`, runs
 * `assertProviderTunnel` (hence `decideTunnel`) first, which holds `host` and `username` to text on every present
 * tunnel, the values `tunnelRoute` measures. The field checks are not repeated here, which would be a second copy of
 * the decision and an import cycle with `./tunnel-decision`.
 *
 * WHAT IS REFUSED. With `sshTunnel` absent (`undefined` or `null`) the record itself is returned, so a connection
 * without a tunnel is built exactly as it is passed. Any other `sshTunnel` must be plain data, and so must the record
 * that carries it (`assertTunnelRecordIsPlainData`): a copy loses a field defined on the prototype or as not enumerable
 * and reads an own getter once, so only plain data reaches the provider exactly as core read it. A string, a number, an
 * array, a class instance or a getter is refused with a `DatabaseConfigError` that names the field and never
 * its value. It never writes to its argument.
 */
export function providerConnection<T extends DatabaseConnection>(connection: T): T & WithTunnelRoute {
  const tunnel: unknown = connection.sshTunnel;
  if (tunnel === undefined || tunnel === null) return connection;
  assertTunnelRecordIsPlainData(connection);
  // The spread copies every own property, symbol keys included, and the copy's own `sshTunnel` is then removed, so the
  // provider's config has no such key at all. The assertion: the route is framed from the record's own tunnel, which
  // core's decision accepted before this runs.
  const copy: T & WithTunnelRoute = { ...connection, [TUNNEL_ROUTE]: tunnelRoute(tunnel as SSHTunnelConfig) };
  delete copy.sshTunnel;
  return copy;
}
