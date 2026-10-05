import { appFetch } from "@/lib/config/base-path";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";

/**
 * What the server lets a session do with connections of its own, as `GET /api/connections/policy`
 * answers it from `ALLOW_CUSTOM_CONNECTIONS` (docs/SEED_CONNECTIONS.md, "Custom Connections").
 *
 * THE BROWSER'S COPY DECIDES WHAT THE EDITOR OFFERS AND NOTHING ELSE. The server refuses a
 * connection the caller supplied in `resolveConnection` (`src/lib/seed/resolve-connection.ts`)
 * whatever the editor drew, so an editor that read this wrong can show a control that fails with
 * 403, and can never open a connection the server would refuse.
 */
export interface ConnectionPolicy {
  readonly customConnections: boolean;
}

/** Today's behaviour, and what a policy that could not be read leaves in place. */
export const CUSTOM_CONNECTIONS_ALLOWED: ConnectionPolicy = { customConnections: true };

const CUSTOM_CONNECTIONS_REFUSED: ConnectionPolicy = { customConnections: false };

/** One sentence for both ways a read fails, so the console names one cause however it failed. */
const POLICY_UNREAD =
  "The connection policy could not be read; custom connections stay offered and the server still decides";

/**
 * Whether the server would open this connection under the policy.
 *
 * An id in the `seed:` namespace is the operator's. `resolveConnection` resolves it from the seed
 * file whether it arrives as `connectionId` (a managed seed) or as the id of an inline record (an
 * unmanaged seed's editable copy, which keeps `seed:<id>`), so the switch never touches it. Every
 * other id is a connection the user created or duplicated, which the server refuses while custom
 * connections are off.
 */
export function connectionAllowed(connection: DatabaseConnection, policy: ConnectionPolicy): boolean {
  return policy.customConnections || connection.id.startsWith("seed:");
}

/** The connections the editor lists: the same array when nothing is refused, so a memo keyed on it holds. */
export function connectionsUnderPolicy(
  connections: DatabaseConnection[],
  policy: ConnectionPolicy,
): DatabaseConnection[] {
  if (policy.customConnections) return connections;
  return connections.filter((connection) => connectionAllowed(connection, policy));
}

/**
 * The full saved order after a drag in a list that shows only some of the connections.
 *
 * `previous` is the full order before the drag, hidden connections included, and
 * `reorderedVisible` is the order the list handed back, which names only the connections it
 * shows. Every id of `previous` the list does not show keeps its index; the shown ids fill, in
 * their new sequence, the indices the shown ids held, and any left over because `previous` did not
 * name them all follow at the end. So [a, b, c, d] with a and c hidden and [b, d] reordered to
 * [d, b] gives [a, d, c, b]: a connection the policy hides is where it was when custom
 * connections are allowed again, however the seeds around it were reordered meanwhile.
 */
export function mergeVisibleOrder(previous: string[], reorderedVisible: string[]): string[] {
  const shown = new Set(reorderedVisible);
  let next = 0;
  const merged = previous.map((id) => (shown.has(id) ? reorderedVisible[next++] : id));
  return [...merged, ...reorderedVisible.slice(next)];
}

/**
 * Reads the policy. Only an explicit `customConnections: false` withholds anything.
 *
 * A read that fails, or answers another shape, keeps the editor as it was before the switch
 * existed, and every failure but a missing route says so in the console. That is not a security
 * fallback: the server enforces the switch on every route that builds a provider, so the cost of
 * reading it wrong is a control that answers 403, while hiding a user's connections on a transient
 * failure would look like data loss.
 */
export async function readConnectionPolicy(): Promise<ConnectionPolicy> {
  try {
    const res = await appFetch("/api/connections/policy");
    // A shell with no such route, which is what an embedding host is, has no policy to report:
    // answered silently, the way `useConnectionManager` reads a 404 from the managed list.
    if (res.status === 404) return CUSTOM_CONNECTIONS_ALLOWED;
    if (!res.ok) {
      logger.warn(POLICY_UNREAD, { route: "connection-policy", status: res.status });
      return CUSTOM_CONNECTIONS_ALLOWED;
    }
    const body = (await res.json()) as { customConnections?: unknown };
    return body.customConnections === false ? CUSTOM_CONNECTIONS_REFUSED : CUSTOM_CONNECTIONS_ALLOWED;
  } catch (error) {
    logger.warn(POLICY_UNREAD, {
      route: "connection-policy",
      error: error instanceof Error ? error.message : String(error),
    });
    return CUSTOM_CONNECTIONS_ALLOWED;
  }
}
