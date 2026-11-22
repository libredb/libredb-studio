/**
 * The SSH tunnel's route a provider frames: the one Studio's provider factory handed it (FND-2 slice 5b).
 *
 * Core decides and opens every tunnel, and builds every provider from `providerConnection` in
 * `src/lib/db/provider-connection.ts`, which takes `sshTunnel` out of the provider's copy and sets the tunnel's route
 * under `TUNNEL_ROUTE` in its place. A provider that tells two bastions apart (Databend's sign-in latch key) reads the
 * route here and never frames one from `sshTunnel` itself, so the route it keys on is the one the edit-plan seal and
 * the tunnel pool frame.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { type DatabaseConnection, type DatabaseType, TUNNEL_ROUTE, type WithTunnelRoute } from "@/lib/types";

/** The refusal of a tunnelled connection that carries no route: its provider was built without Studio's factory. */
export const TUNNEL_ROUTE_MISSING =
  "This connection carries a tunnel's far end and no tunnel route, so its provider was not built by Studio's provider factory: build it with createDatabaseProvider inside withOneShotTunnel, or get it from getOrCreateProvider";

/**
 * The route core set under `TUNNEL_ROUTE`, or a `DatabaseConfigError` naming `type` when there is none. A provider
 * calls it only for a connection that carries a tunnel's far end, the mark of a tunnel core opened.
 */
export function requireTunnelRoute(connection: DatabaseConnection & WithTunnelRoute, type: DatabaseType): string {
  const route = connection[TUNNEL_ROUTE];
  if (route === undefined) throw new DatabaseConfigError(TUNNEL_ROUTE_MISSING, type);
  return route;
}
