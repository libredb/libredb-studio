import { TUNNEL_FAR_END, type SSHTunnelConfig, type WithTunnelFarEnd } from "@/lib/types";
import { DatabaseConfigError } from "./errors";
import { assertTunnelRecordIsPlainData } from "./provider-connection";
import { type EngineConnection, type EngineRecord, legacyProviderType } from "./server-catalog";

/**
 * What core does with a connection's SSH tunnel: `open: false` when the connection carries no tunnel object or one
 * that is off, `open: true` when its tunnel is on and core must open it before any provider is built, with what the
 * dial takes: the tunnel, and the connection's `host` and `port` it forwards to.
 */
export type TunnelDecision =
  | { readonly open: false }
  | { readonly open: true; readonly tunnel: SSHTunnelConfig; readonly host: string; readonly port: number };

const NO_TUNNEL: TunnelDecision = Object.freeze({ open: false });

/** The refusal of a tunnel that is on for a connection with no Host and Port for it to forward to. */
const UNOPENABLE =
  "This connection's SSH tunnel is on, but the connection names no Host and Port for the tunnel to forward to, so no tunnel was opened and nothing was sent. Fill in Host and Port, or turn the tunnel off.";

/** The refusal of a build from a connection whose tunnel is on and was not opened by core. */
const NOT_OPENED =
  "This connection's SSH tunnel is on and no tunnel was opened for it, so no provider was built and nothing was sent: build the provider inside withOneShotTunnel, or get it from getOrCreateProvider, which open the tunnel first.";

/** The refusal of a build handed a far end for a connection whose tunnel is not on. */
const FAR_END_WITHOUT_TUNNEL =
  "A tunnel's far end was handed over for a connection whose SSH tunnel is not on, so no provider was built.";

const HIGHEST_PORT = 65535;

/** The refusal of one tunnel field, naming the field and what it must be, and never its value. */
function fieldRefusal(engine: EngineRecord, field: string, expected: string): DatabaseConfigError {
  return new DatabaseConfigError(
    `The connection's sshTunnel.${field} must be ${expected}; nothing was sent.`,
    legacyProviderType(engine),
  );
}

/**
 * Decide a connection's SSH tunnel (FND-2 slice 5, docs/SECURITY.md control 3.46): the one place Studio decides
 * whether a tunnel is absent, refused or to be opened, so no provider decides any of it.
 *
 * WHERE IT RUNS. In `getOrCreateProvider`, `acquireExecutionProfileProvider` and `withOneShotTunnel` (`./factory`),
 * ahead of the cache key and of `createSSHTunnel`, each of which then dials exactly when this answers `open: true`,
 * with the tunnel, host and port it answers; and in the one ordered open check (`assertOpenable` in `./open-check`),
 * for a record that offers a tunnel, which `createDatabaseProvider` and `readProviderDeclarations` run before any
 * provider is built.
 *
 * IN THIS ORDER, each refusal a `DatabaseConfigError` that names the field or the engine and never a value:
 *
 * 1. The tunnel, when present, and the record carrying it must be plain data (`assertTunnelRecordIsPlainData`), since
 *    every path to a provider copies them.
 * 2. `enabled` must be `true`, `false`, `null` or absent, the last two read as off: a tunnel is opened for `true` only,
 *    never for another value JavaScript reads as true.
 * 3. `host` and `username` must be text on every present tunnel, since the route (`tunnelRoute` in
 *    `./connection-fingerprint`) frames both into the cache key and the edit-plan seal. On a tunnel that is on, `host`
 *    must be the bastion's non-empty name or address, `port` absent (the bastion's 22, as `src/lib/ssh/tunnel.ts` dials
 *    it) or a whole number from 1 to 65535, and `authMethod` `password` or `privateKey`. Nothing else is checked: a
 *    secret's or a host key fingerprint's shape is the dial's to judge.
 * 4. A tunnel that is on, on an engine whose record's `grants.sshTunnel`, Studio's grant of its tunnel claim (for a
 *    legacy engine its `GRANTED_SSH_TUNNEL_REFUSAL` row in `./claim-grants`), names a reason, is refused with that
 *    sentence.
 * 5. A tunnel that is on, for a connection that names no `host` or no `port` (a connection-string record, for one),
 *    is refused: there is nothing to forward to, so no tunnel can be opened, and a provider built anyway would reach
 *    its server past the tunnel the connection asked for.
 *
 * A tunnel that is off is never refused for its engine or for a missing host and port, and its fields other than the
 * two the route frames are not read. Whether a tunnel was in fact opened is not decided here: the factory reads that
 * from `TUNNEL_FAR_END`, which only core sets after `createSSHTunnel` answered. It never writes to its argument. Each
 * refusal names the engine by `legacyProviderType(engine)` (./server-catalog), the type of a legacy engine's record.
 */
export function decideTunnel(connection: EngineConnection, engine: EngineRecord): TunnelDecision {
  assertTunnelRecordIsPlainData(connection);
  const tunnel: unknown = connection.sshTunnel;
  if (tunnel === undefined || tunnel === null) return NO_TUNNEL;
  const field = (name: string): unknown => Reflect.get(tunnel as object, name);

  const enabled = field("enabled");
  if (enabled !== true && enabled !== false && enabled !== undefined && enabled !== null) {
    throw fieldRefusal(engine, "enabled", "true or false");
  }
  const on = enabled === true;
  const host = field("host");
  if (typeof host !== "string") throw fieldRefusal(engine, "host", "text");
  if (on && host === "") throw fieldRefusal(engine, "host", "the bastion's host name or address");
  if (on) {
    const port = field("port");
    if (port !== undefined && !(Number.isInteger(port) && (port as number) >= 1 && (port as number) <= HIGHEST_PORT)) {
      throw fieldRefusal(engine, "port", "a whole number from 1 to 65535");
    }
  }
  if (typeof field("username") !== "string") throw fieldRefusal(engine, "username", "text");
  if (!on) return NO_TUNNEL;
  const authMethod = field("authMethod");
  if (authMethod !== "password" && authMethod !== "privateKey") {
    throw fieldRefusal(engine, "authMethod", "password or privateKey");
  }

  const refusal = engine.grants.sshTunnel;
  if (refusal !== null) throw new DatabaseConfigError(refusal, legacyProviderType(engine));
  if (!connection.host || !connection.port) throw new DatabaseConfigError(UNOPENABLE, legacyProviderType(engine));
  return { open: true, tunnel: tunnel as SSHTunnelConfig, host: connection.host, port: connection.port };
}

/**
 * Refuse to build a provider from `connection` unless its tunnel, as `decideTunnel` decides it, matches what core did
 * with it (FND-2 slice 5): run by the open check (`assertOpenable` in `./open-check`), which `createDatabaseProvider`
 * and `readProviderDeclarations` in `./factory` run before any provider is built.
 *
 * `TUNNEL_FAR_END` is the one sign that core opened the connection's tunnel: only `tunnelledConnection` in `./factory`
 * sets it, after `createSSHTunnel` answered, and a stored or parsed record can never carry a symbol key. So:
 *
 * - a tunnel that is on with no far end was not opened, and `host` and `port` are the database's own. When
 *   `requireOpened` is true, as for a check to connect (`createDatabaseProvider`, the only function that hands out a
 *   provider that can be connected), it is refused, so no provider anywhere can reach its server past the tunnel the
 *   connection asked for. A check to read declarations (`readProviderDeclarations`) passes false: it builds the
 *   provider to read its declarations and never hands it out.
 * - a far end on a connection whose tunnel is not on is refused on every build: core never hands one over, so a
 *   provider built from it would seal an address its record does not name.
 *
 * Every refusal of `decideTunnel` comes first, so a malformed tunnel, an engine that takes none and a tunnel with
 * nothing to forward to are refused here too, by the same sentences.
 */
export function assertProviderTunnel(
  connection: EngineConnection & WithTunnelFarEnd,
  engine: EngineRecord,
  requireOpened: boolean,
): void {
  const decision = decideTunnel(connection, engine);
  const opened = connection[TUNNEL_FAR_END] !== undefined;
  if (!decision.open && opened) throw new DatabaseConfigError(FAR_END_WITHOUT_TUNNEL, legacyProviderType(engine));
  if (decision.open && !opened && requireOpened) {
    throw new DatabaseConfigError(NOT_OPENED, legacyProviderType(engine));
  }
}
