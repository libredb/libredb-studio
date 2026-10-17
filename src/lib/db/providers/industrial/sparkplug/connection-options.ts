/**
 * The TLS material the broker is dialled with, read from the connection's SSL / TLS panel.
 *
 * IT IS A MODULE OF ITS OWN BECAUSE THE PANEL IS NOT THIS PROVIDER'S TO INTERPRET. Every provider
 * that reads the panel reads it through `nodeTlsMaterial` (`mtconnect`, `rabbitmq`, `s3`,
 * `kubernetes` and the rest), so the refusals a malformed panel earns are one set of sentences, and
 * `nodeTlsConnectOptions` turns the result into what `tls.connect` takes. Spreading that by hand is
 * what drops `checkServerIdentity`, which is a verification hole rather than a missing nicety:
 * without it a certificate is checked against the address dialled instead of the server the user
 * named. The two are not alike and the helper says so: `checkServerIdentity` is set ALWAYS, and
 * `servername` only where the identity is a name rather than an IP literal (`isIP(identity) === 0`),
 * because SNI carries a host name and an IP identity is checked against the certificate's IP SAN.
 *
 * WHAT WAS MEASURED BEFORE THIS EXISTED. The dialog offered the panel (`offersSslPanel` is opt-out
 * and this engine's entry does not opt out), the session already carried a real `tlsConnect`
 * branch, and nothing in `src/` ever set it: a connection to a TLS-only broker on 8883 failed with
 * the plain socket's own sentence, *"Could not open a connection ... check the address, the port"*,
 * where the address and the port were both right and TLS was the thing that never happened. The
 * same sentence came back with a CA that signed the broker and with one that signed nothing, which
 * is the measurement that says the panel was not read rather than read and rejected.
 *
 * `identity` is the host the certificate is checked against: the SSH tunnel's far end when a tunnel
 * carries the connection, so the check names the broker the user asked for and not the local
 * forward the socket dials.
 */
import { type NodeTlsMaterial, nodeTlsMaterial } from "@/lib/db/http/node-transport";
import { type DatabaseConnection, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";

/**
 * The panel as `tls.connect` takes it, or null for a plain socket: an absent panel, or the mode
 * `disable`. A malformed panel is refused by name here, before any socket exists.
 */
export function sparkplugTlsMaterial(
  config: DatabaseConnection & WithTunnelFarEnd,
  dialledHost: string,
): NodeTlsMaterial | null {
  return nodeTlsMaterial(config.ssl, config[TUNNEL_FAR_END]?.host ?? dialledHost);
}
