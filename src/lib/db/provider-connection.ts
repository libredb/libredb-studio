import type { ProviderExecutionContext } from "@/lib/db/types";
import { LITERAL_SEED_FILE, TUNNEL_FAR_END, TUNNEL_ROUTE } from "@/lib/types";
import type {
  DatabaseConnection,
  DatabaseType,
  SSHTunnelConfig,
  WithLiteralSeedFile,
  WithTunnelFarEnd,
  WithTunnelRoute,
} from "@/lib/types";
import { GRANTED_SSH_TUNNEL_REFUSAL } from "./claim-grants";
import { CONNECTION_STRING_ACCEPTED } from "./compatibility";
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
 * the contract rows that declare them, each read through `typeIdRow`. The first four are projections of the engine's
 * declaration (docs/providers/CONTRACT.md, clauses M-71 and M-72), the fifth is Studio's grant of the engine's tunnel
 * claim (clause M-83), and the sixth is Studio's:
 * 1. `CONNECTION_FIELDS`, the fields its connection dialog draws, its `connection.fields`;
 * 2. the fields of its `SEED_ONLY_FIELDS` row, the fields only its provider reads and only a seed names, its
 *    `connection.seedOnly`;
 * 3. `connectionString` where `CONNECTION_STRING_ACCEPTED` answers true, the URI a seed or an embedder may hand it, its
 *    `connection.connectionString.accepted`;
 * 4. `ssl` where the dialog offers the TLS panel (`offersSslPanel` in ./connection-form), its `connection.tls`;
 * 5. `host` and `port` where the engine takes an SSH tunnel (`GRANTED_SSH_TUNNEL_REFUSAL` is null), because core
 *    writes the tunnel's local endpoint there; an engine whose tunnel the grant refuses has no tunnel, so nothing it
 *    receives is a tunnel's endpoint;
 * 6. `PROVIDER_CORE_FIELDS`, Studio's own fields every provider receives.
 * Each field once, in that order. The answer is frozen. A field its engine refuses by name (`REFUSED_CONNECTION_FIELDS`)
 * is in none of those rows, so no provider receives one: core refuses a connection to be built to connect that sets one
 * (`refusedFieldRefusal`), and drops it otherwise.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no provider.
 */
export function providerFields(type: DatabaseType): readonly (keyof DatabaseConnection)[] {
  const fields: (keyof DatabaseConnection)[] = [
    ...typeIdRow(CONNECTION_FIELDS, type),
    ...(typeIdRow(SEED_ONLY_FIELDS, type)?.fields ?? []),
    ...(typeIdRow(CONNECTION_STRING_ACCEPTED, type) ? (["connectionString"] as const) : []),
    ...(offersSslPanel(type) ? (["ssl"] as const) : []),
    ...(typeIdRow(GRANTED_SSH_TUNNEL_REFUSAL, type) === null ? (["host", "port"] as const) : []),
    ...PROVIDER_CORE_FIELDS,
  ];
  return Object.freeze([...new Set(fields)]);
}

/**
 * The sentence a connection is refused with for setting a field its engine refuses by name (FND-2 slice 6c,
 * docs/SECURITY.md control 3.41): of the engine's `REFUSED_CONNECTION_FIELDS` row, read through `typeIdRow` so it names
 * no type id, the sentence of the first field in row order that the connection sets, or undefined when it sets none.
 * A field is set when the record holds it as its own property with a value other than `undefined`, `null` and `""`,
 * whatever its type: the engine takes the field in no form, so any value in it is a mistake the operator should see by
 * name. The sentence names the field and never its value. Pure: it reads its argument and writes nothing.
 *
 * @throws {UnknownProviderError} When the record's type names no provider (`typeIdRow`).
 */
export function refusedFieldRefusal(connection: DatabaseConnection): string | undefined {
  const row: Readonly<Record<string, string>> = typeIdRow(REFUSED_CONNECTION_FIELDS, connection.type);
  for (const [field, sentence] of Object.entries(row)) {
    if (!Object.hasOwn(connection, field)) continue;
    const value: unknown = Reflect.get(connection, field);
    if (value !== undefined && value !== null && value !== "") return sentence;
  }
  return undefined;
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
 * Refuse a connection that is not plain data (`isPlainData`), with a `DatabaseConfigError` that names the rule and never
 * a value. A record with a present `sshTunnel` is held to `assertTunnelRecordIsPlainData` first, so its refusal names the
 * tunnel.
 *
 * WHY. Core reads the record before any copy of it is made (`assertReadOnlyHonoured`, `decideTunnel`, the cache key),
 * and every path to a provider copies it (`providerConnection`, and the tunnel's local endpoint or the agent credential
 * written over a copy in `./factory`). A copy of anything but plain data can answer differently from the record core
 * read: a `readOnly` inherited from a prototype would read true for core and reach the provider as undefined.
 *
 * WHERE IT RUNS. In `providerConnection`, so every build checks it, and in the entry points that copy the record or look
 * it up in a cache before the build (`getOrCreateProvider`, `acquireExecutionProfileProvider` and `withOneShotTunnel`
 * in `./factory`), beside `assertReadOnlyHonoured`: ahead of the cache key, so a cached provider is never handed to such
 * a record, and ahead of the copy, which would hand `providerConnection` plain data.
 */
export function assertConnectionIsPlainData(connection: DatabaseConnection): void {
  const tunnel: unknown = connection.sshTunnel;
  if (tunnel !== undefined && tunnel !== null) assertTunnelRecordIsPlainData(connection);
  if (!isPlainData(connection)) {
    throw new DatabaseConfigError("A connection must be a plain object of data fields; no provider was built.");
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
 * The symbol keys a caller's record keeps on its way to the provider: core's markers that core's own entry points set
 * before the build, `TUNNEL_FAR_END` (the tunnel's far end, set where core opens the tunnel) and `LITERAL_SEED_FILE`
 * (a seed-file row read in literal mode, set by the operator's seed loader). Both are made with `Symbol()`, so no
 * caller outside the source can name them. Every other symbol key is dropped: `TUNNEL_ROUTE` is set by
 * `providerConnection` itself, and `ADMITTED_FILE` and `ADMITTED_HOST_PATHS` by the factory's later steps
 * (`admittedFileConnection` and `admittedHostPathConnection` in ./provider-files), so a caller's value of any of them
 * never survives.
 */
const CALLER_MARKERS: readonly symbol[] = Object.freeze([TUNNEL_FAR_END, LITERAL_SEED_FILE]);

/** The connection a provider is built from: the received fields, core's markers, and the route under its marker. */
export type ProviderConnection = DatabaseConnection & WithTunnelFarEnd & WithLiteralSeedFile & WithTunnelRoute;

/**
 * The connection a provider is built from (FND-2, docs/SECURITY.md control 3.41): a new object holding only the
 * fields the record's engine declares and core's markers.
 *
 * WHAT A PROVIDER RECEIVES. For each field `providerFields(connection.type)` names, the record's own property when the
 * record has one, as the record holds it (an object such as `ssl` by identity); a field the record leaves absent stays
 * absent. Of the record's symbol keys, `TUNNEL_FAR_END` and `LITERAL_SEED_FILE` (`CALLER_MARKERS`). And, for a record
 * that carries a tunnel object, on or off, `tunnelRoute` of that tunnel under `TUNNEL_ROUTE`. So no provider receives a
 * field its engine does not declare: not `sshTunnel` or the tunnel's credentials, not the agent credential
 * (`agentUser`, `agentPassword`, which an execution-profile provider receives as its own `user` and `password`), not
 * Studio's display fields, not another engine's field, and no symbol key of the caller's own.
 *
 * WHY. Core decides every tunnel (`decideTunnel` in `./tunnel-decision`) and opens it (`getOrCreateProvider`,
 * `acquireExecutionProfileProvider` and `withOneShotTunnel` in `./factory`) with the tunnel's own fields, and hands the
 * provider the outcome: the local endpoint in `host` and `port` and the far end under `TUNNEL_FAR_END`. The edit-plan
 * seal (`connectionFingerprint`) frames the route from the provider's own config, so it must be the record's, and the
 * routes frame the seal on this function's answer for the record they resolved, so both sides digest the same fields.
 * Databend's sign-in latch reads the route through `requireTunnelRoute` in `./utils/require-tunnel-route`. A field the
 * engine does not declare is dropped and never refused here: stored records carry fields their engine does not take.
 * A field its engine refuses by name is dropped here too; `buildProvider` in `./factory` refuses it first, for a
 * provider built to connect (`refusedFieldRefusal`).
 *
 * PRECONDITION. The tunnel is one core's decision accepted: its caller, `buildProvider` in `./factory`, runs
 * `assertProviderTunnel` (hence `decideTunnel`) first, which holds `host` and `username` to text on every present
 * tunnel, the values `tunnelRoute` measures. The field checks are not repeated here, which would be a second copy of
 * the decision and an import cycle with `./tunnel-decision`. The edit routes call it after `handleObjectRequest` built
 * their provider through `getOrCreateProvider`.
 *
 * WHAT IS REFUSED. A record that is not plain data (`isPlainData`), with or without a tunnel: core reads the record
 * before the copy is made (`assertReadOnlyHonoured`, `decideTunnel`, the cache key), and a copy of anything but plain
 * data can answer differently, so a `readOnly` inherited from a prototype would read true for core and reach the
 * provider as undefined (`assertConnectionIsPlainData`, which the entry points in `./factory` also run ahead of their
 * cache key). A tunnel that is not plain data (`assertTunnelRecordIsPlainData`). Each with a
 * `DatabaseConfigError` that names the rule and never a value. It never writes to its argument.
 *
 * @throws {UnknownProviderError} When the record's type names no provider (`providerFields`).
 */
export function providerConnection(connection: DatabaseConnection): ProviderConnection {
  assertConnectionIsPlainData(connection);
  const tunnel: unknown = connection.sshTunnel;
  const copy: Record<string | symbol, unknown> = {};
  for (const field of providerFields(connection.type)) {
    if (Object.hasOwn(connection, field)) copy[field] = connection[field];
  }
  for (const marker of CALLER_MARKERS) {
    if (Object.hasOwn(connection, marker)) copy[marker] = Reflect.get(connection, marker);
  }
  // The assertion: the route is framed from the record's own tunnel, which core's decision accepted before this runs.
  if (tunnel !== undefined && tunnel !== null) copy[TUNNEL_ROUTE] = tunnelRoute(tunnel as SSHTunnelConfig);
  // The copy holds, under each field name `providerFields` gave, the record's own value of that field, and core's markers
  // under their own keys, so it is a `ProviderConnection`; the compiler cannot follow a copy keyed by a list.
  return copy as unknown as ProviderConnection;
}
