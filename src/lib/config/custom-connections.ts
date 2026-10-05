import { logger } from "@/lib/logger";

/**
 * Whether a signed-in session may open a database connection it supplies itself
 * (`ALLOW_CUSTOM_CONNECTIONS`), rather than only the connections the operator seeded.
 *
 * WHY A SWITCH. Studio connects from wherever it runs, so a connection a user types in reaches
 * every host that network reaches. On a laptop that is the user's own business. In a container
 * that shares an overlay network with other services, a platform's or a cluster namespace's, it
 * is a pivot: any account that can sign in can open a connection to the platform's own database
 * or its control plane by service name. An operator who seeds every database the users need
 * switches custom connections off and closes that path on the server.
 *
 * Read on every call, never cached, so a test or a supervisor that changes the environment is
 * answered at once. Spellings follow the product's other flags: unset or empty is the default
 * (on); "false", "0", "off" and "no", trimmed and in any letter case, switch it off; "true", "1",
 * "on" and "yes" keep it on. One pair of matching surrounding quotes, single or double, is
 * stripped first, because an env file can keep them. Anything else FAILS CLOSED: it switches
 * custom connections off and logs an error once per process naming the accepted values, so an
 * operator who meant to switch them off never leaves them open by a typo or a stray quote.
 *
 * The rule is enforced in `resolveConnection` (`src/lib/seed/resolve-connection.ts`), the one
 * place an inline connection becomes a provider's input; `GET /api/connections/policy` reports it
 * to the editor so the editor stops offering what the server would refuse.
 */

/** The sentence every refusal carries, on every route that builds a provider. */
export const CUSTOM_CONNECTIONS_DISABLED_MESSAGE = "Custom connections are disabled on this server";

const DISABLED_VALUES = new Set(["false", "0", "off", "no"]);
const ENABLED_VALUES = new Set(["true", "1", "on", "yes"]);

// resolveConnection runs on every request that carries an inline connection, so an unrecognised
// value must log at most once per process rather than once per request.
let unrecognizedValueLogged = false;

/** Test seam: clears the log-once latch so each case observes a fresh process. */
export function resetCustomConnectionsWarning(): void {
  unrecognizedValueLogged = false;
}

// One template literal, never a concatenation across lines: bun's line coverage under-counts
// the continuation lines of a message built that way.
const unrecognizedValueMessage = (raw: string): string =>
  `Unrecognized ALLOW_CUSTOM_CONNECTIONS value "${raw}"; custom connections are switched off. Accepted values: "false", "0", "off" or "no" to switch them off, "true", "1", "on" or "yes" to keep them on`;

/** Trims, then strips one pair of matching surrounding quotes, as an env file may keep them. */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return (quoted ? quoted[2] : trimmed).trim().toLowerCase();
}

export function customConnectionsAllowed(): boolean {
  const raw = process.env.ALLOW_CUSTOM_CONNECTIONS ?? "";
  const normalized = unquote(raw);
  if (normalized === "" || ENABLED_VALUES.has(normalized)) return true;
  if (DISABLED_VALUES.has(normalized)) return false;
  if (!unrecognizedValueLogged) {
    unrecognizedValueLogged = true;
    logger.error(unrecognizedValueMessage(raw), undefined, { route: "custom-connections" });
  }
  return false;
}
