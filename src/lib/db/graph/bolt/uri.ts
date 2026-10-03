/**
 * A saved connection's host, port and TLS panel as one Bolt endpoint (Neo4j provider
 * spec 3.3, revisions SR12 and SR13).
 *
 * The driver takes a URI and reads its scheme for both routing and trust, so the URI is
 * the whole security decision: it is built here from validated parts and never taken
 * from the user as text. Only the direct `bolt` family is produced; the routing `neo4j`
 * schemes would dial whatever addresses the server's routing table names (E7).
 *
 * The host and port go through the shared validators of `src/lib/db/http/endpoint.ts`,
 * userinfo is refused before them with its own message, and the built URI is parsed back
 * and must name the same host and port, so no character of the host can rewrite the URI
 * around it.
 *
 * The TLS panel maps the way the Kafka provider's does (`rejectUnauthorized` decides
 * `require`), written again here because no provider may import another:
 *
 * | panel                                         | scheme      | trust                          |
 * | --------------------------------------------- | ----------- | ------------------------------ |
 * | absent, or `disable`                          | `bolt`      | none                           |
 * | `require`                                     | `bolt+ssc`  | any certificate                |
 * | `require` with `rejectUnauthorized: true`     | `bolt+s`    | system CAs                     |
 * | `verify-system`, or a panel with no mode      | `bolt+s`    | system CAs                     |
 * | `verify-ca` or `verify-full` with `caCert`    | `bolt+s`    | that CA (hostname verified too)|
 * | `verify-ca` or `verify-full` without `caCert` | `bolt+s`    | system CAs                     |
 *
 * A client certificate is refused in every mode: the driver could send one, but this
 * version neither stores it safely for the driver nor tests it. A verifying mode through
 * an SSH tunnel is refused too, since the certificate would be checked against the
 * tunnel's loopback address rather than the server's name.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { validateHost, validatePort } from "@/lib/db/http/endpoint";
import type { DatabaseConnection, SSLConfig, SSLMode, WithTunnelFarEnd } from "@/lib/types";
import { TUNNEL_FAR_END } from "@/lib/types";

export interface BoltEndpoint {
  readonly uri: string;
  /** PEM text of the CA the driver trusts instead of the system store; only with `bolt+s`. */
  readonly trustedCertificatePem?: string;
}

type BoltScheme = "bolt" | "bolt+s" | "bolt+ssc";

const UNADDRESSABLE = "Invalid host: the Bolt URI would not address the configured host and port";

/** Every mode `SSLMode` names: a record, so a mode added there fails the typecheck here until it is mapped. */
const TLS_MODES: Readonly<Record<SSLMode, true>> = Object.freeze({
  disable: true,
  require: true,
  "verify-system": true,
  "verify-ca": true,
  "verify-full": true,
});

/** host/port/ssl panel to a bolt-family URI; throws DatabaseConfigError for anything it cannot address safely. */
export function boltEndpointOf(
  connection: Pick<DatabaseConnection, "host" | "port" | "ssl"> & Partial<WithTunnelFarEnd>,
  defaultPort: number,
): BoltEndpoint {
  if (typeof connection.host === "string" && connection.host.includes("@")) {
    throw new DatabaseConfigError(
      "Invalid host: a user name or password belongs in the connection's user and password fields, not in the host",
    );
  }
  // validateHost brackets an IPv6 literal; a URL then writes it in its shortest form, and
  // reading that form back is what the URI is compared against.
  const host = new URL(`http://${validateHost(connection.host)}`).hostname;
  const port = validatePort(connection.port ?? defaultPort);
  const { scheme, trustedCertificatePem } = tlsOf(connection.ssl);

  if (connection[TUNNEL_FAR_END] !== undefined && scheme === "bolt+s") {
    throw new DatabaseConfigError(
      "Certificate verification through an SSH tunnel is not supported for Neo4j in this version: the certificate would be checked against the tunnel's local address. Use TLS mode require with verification off, or connect without the tunnel",
    );
  }

  const uri = `${scheme}://${host}:${port}`;
  // Unreachable for a host the validators passed; kept so that a change to them cannot
  // let a host rewrite the URI unnoticed (SR12).
  const parsed = new URL(uri);
  const addressed = parsed.hostname === host && Number(parsed.port) === port && parsed.username === "";
  if (!addressed) throw new DatabaseConfigError(UNADDRESSABLE);
  return trustedCertificatePem === undefined ? { uri } : { uri, trustedCertificatePem };
}

function tlsOf(ssl: unknown): { scheme: BoltScheme; trustedCertificatePem?: string } {
  if (ssl === undefined || ssl === null) return { scheme: "bolt" };
  if (typeof ssl !== "object" || Array.isArray(ssl)) throw wrongType("ssl", "an object");

  // The whole panel is checked, whatever its mode, before any of it is read.
  const panel = ssl as Partial<Record<keyof SSLConfig, unknown>>;
  const mode = panel.mode;
  if (mode !== undefined && mode !== null && !(typeof mode === "string" && Object.hasOwn(TLS_MODES, mode))) {
    throw wrongType("ssl.mode", "disable, require, verify-system, verify-ca or verify-full");
  }
  const caCert = optionalString(panel.caCert, "ssl.caCert");
  const clientCert = optionalString(panel.clientCert, "ssl.clientCert");
  const clientKey = optionalString(panel.clientKey, "ssl.clientKey");
  const rejectUnauthorized = optionalBoolean(panel.rejectUnauthorized, "ssl.rejectUnauthorized");
  if (clientCert || clientKey) {
    throw new DatabaseConfigError(
      "TLS client certificates are not supported for Neo4j in this version: remove the client certificate and key from the connection's TLS settings",
    );
  }

  if (mode === "disable") return { scheme: "bolt" };
  if (mode === "require") return { scheme: rejectUnauthorized === true ? "bolt+s" : "bolt+ssc" };
  if ((mode === "verify-ca" || mode === "verify-full") && caCert) {
    return { scheme: "bolt+s", trustedCertificatePem: caCert };
  }
  // verify-system, a verifying mode without a CA, or a panel with no mode (a seed file's
  // panel may omit it): the system store, never a weaker trust.
  return { scheme: "bolt+s" };
}

/** A field that holds a string when it is present; null reads as absent. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw wrongType(field, "a string");
  return value;
}

/** A field that holds a boolean when it is present; null reads as absent. */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw wrongType(field, "true or false");
  return value;
}

/** Names the field and what it must be, never the value it holds, which can be a key. */
function wrongType(field: string, expected: string): DatabaseConfigError {
  return new DatabaseConfigError(`The connection's ${field} must be ${expected}; nothing was sent`);
}
