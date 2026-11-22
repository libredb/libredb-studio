/**
 * What a connection is, read from the dialog's fields and refused before anything is dialled
 * (#1677 section 4).
 *
 * EVERY REFUSAL IS A SENTENCE A READER CAN ACT ON, and each one is here rather than in the session,
 * because a refusal before a socket exists costs nothing and a refusal after it has already told
 * the server who is asking.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  TUNNEL_FAR_END,
  type DatabaseConnection,
  type SSHTunnelConfig,
  type TunnelFarEnd,
  type WithTunnelFarEnd,
} from "@/lib/types";
import { OPCUA_SCHEME, OPCUA_TYPE } from "./constants";
import { clientIdentitySource } from "./pki";
import { normaliseThumbprint, readEndpointUrl, type OpcuaIdentityKind, type OpcuaSecurityMode } from "./security";

/** What the session is built from, with nothing left to be decided later. */
export interface OpcuaConnectionOptions {
  /**
   * The endpoint dialled: the one the reader typed, or the tunnel's local end carrying its path.
   *
   * A TUNNEL REWRITES THE ADDRESS BEFORE A PROVIDER SEES IT. `tunnelledConnection`
   * (`src/lib/db/factory.ts`) replaces `host` with `127.0.0.1` and `port` with the local one, and
   * carries the real pair under `TUNNEL_FAR_END`. For this engine `host` IS the whole endpoint URL,
   * so the rewrite leaves a bare address where a URL was: measured, a tunnelled connection was
   * refused with "An endpoint URL reads opc.tcp://host:port/path, and this one could not be read at
   * all". The URL is rebuilt here instead, keeping the path the reader typed and dialling the local
   * end - which is what every other provider whose address is a URL does with the same symbol.
   */
  readonly endpointUrl: string;
  readonly host: string;
  readonly port: number;
  readonly mode: OpcuaSecurityMode;
  /** The policy URI, or undefined to take whatever the chosen mode's endpoint offers. */
  readonly policyUri?: string;
  readonly identity: OpcuaIdentityKind;
  readonly user?: string;
  readonly password?: string;
  /** The pinned server certificate's SHA-256 thumbprint, 64 lowercase hex (O-S2). */
  readonly pinnedThumbprint?: string;
  /**
   * Where the client's own key pair and trust store live (O-S4): the root Studio's provider factory decided
   * (`opcuaPkiRoot` in `src/lib/db/provider-files.ts`) and handed the provider. Absent on a provider built without the
   * factory, whose session is refused by name (`openReadOnlySession`).
   */
  readonly pkiRoot?: string;
  readonly clientCertificatePath?: string;
  readonly clientPrivateKeyPath?: string;
  readonly tunnelled: boolean;
}

/** The options a session is opened with: a connection's, with the PKI root it needs. */
export type OpcuaSessionOptions = OpcuaConnectionOptions & { readonly pkiRoot: string };

const MODES: ReadonlySet<string> = new Set(["None", "Sign", "SignAndEncrypt"]);

/**
 * The security mode a connection asks for.
 *
 * Studio's own SSL modes do not map onto OPC UA's, so the field is OPC UA's own name rather than a
 * translation: `require` and `verify-full` have no meaning to a server that offers None, Sign and
 * SignAndEncrypt with a policy each. A mode this does not know is a mistake rather than a default,
 * because defaulting would silently weaken a connection the reader meant to secure.
 */
function readMode(raw: unknown): OpcuaSecurityMode {
  const mode = typeof raw === "string" ? raw.trim() : "";
  if (mode === "") return "SignAndEncrypt";
  if (!MODES.has(mode))
    throw new DatabaseConfigError(
      `An OPC UA security mode is None, Sign or SignAndEncrypt, and this one reads ${mode}. ` +
        "There is no default for an unknown mode: a connection meant to be encrypted must not fall back to None.",
      OPCUA_TYPE,
    );
  return mode as OpcuaSecurityMode;
}

/**
 * A connection, or the refusal.
 *
 * `pkiRoot` is the root the provider was built with, which Studio's provider factory decided; it is carried into the
 * options as it is, so nothing here reads the process's environment or resolves a path.
 */
export function readConnection(
  config: DatabaseConnection & { readonly [key: string]: unknown },
  pkiRoot: string | undefined,
): OpcuaConnectionOptions {
  // The endpoint is the whole address: host and port are read FROM it rather than beside it, so
  // there is one place a reader can be wrong and one place to correct.
  const typed = typeof config.host === "string" && config.host.trim() !== "" ? config.host.trim() : "";
  const tunnel = config.sshTunnel as SSHTunnelConfig | undefined;
  const tunnelled = tunnel?.enabled === true;
  const farEnd = (config as WithTunnelFarEnd)[TUNNEL_FAR_END];
  /**
   * The URL a tunnelled connection dials, and the refusal when the tunnel is not open yet.
   *
   * The far end holds the address the READER typed, because the rewrite already happened; the URL's
   * own path and scheme are kept, and only the authority moves to the local end. A tunnel declared
   * and not opened is a refusal rather than a silent dial of `127.0.0.1`, which is the rule S3's
   * connection reader states and every tunnelled provider follows.
   */
  const endpointUrl = tunnelled ? tunnelledEndpointUrl(config, farEnd) : typed;
  const endpoint = readEndpointUrl(endpointUrl);

  /**
   * THE FIELD THE DIALOG WRITES, which is `securityMode` and not `sslMode`.
   *
   * Studio's own SSL modes - disable, require, verify-ca, verify-full - are a different vocabulary,
   * and reading them here is how a reader who picked **None** got a SignAndEncrypt dial and a
   * refusal that blamed the server: measured, the dialog's choice never reached this function. The
   * SSL panel's own `ssl.mode` is not read either, for the same reason: `require` is not a word an
   * OPC UA server knows, and reading it refused every connection with a vocabulary the OPC UA panel
   * never offered.
   */
  const mode = readMode(config.securityMode);

  const user = typeof config.user === "string" && config.user.trim() !== "" ? config.user.trim() : undefined;
  const password = typeof config.password === "string" && config.password !== "" ? config.password : undefined;
  const identity: OpcuaIdentityKind = user === undefined ? "anonymous" : "username";
  if (user === undefined && password !== undefined)
    throw new DatabaseConfigError(
      "A password with no username names no identity. Clear the password for an anonymous session, or type the username it belongs to.",
      OPCUA_TYPE,
    );

  const pinnedRaw =
    typeof config.serverCertificateThumbprint === "string" ? config.serverCertificateThumbprint.trim() : "";
  const pinnedThumbprint = pinnedRaw === "" ? undefined : normaliseThumbprint(pinnedRaw);
  if (pinnedThumbprint !== undefined && !/^[0-9a-f]{64}$/.test(pinnedThumbprint))
    throw new DatabaseConfigError(
      "A pinned server certificate is a SHA-256 thumbprint: 64 hexadecimal characters, which is what " +
        "openssl x509 -fingerprint -sha256 prints without the colons. Colons and spaces are ignored.",
      OPCUA_TYPE,
    );

  /*
   * A PIN ON A `None` CHANNEL IS REFUSED, because this provider already measured that it cannot be
   * enforced there and then enforced it anyway. `security.ts` records the measurement: with a
   * strict certificate manager a None connect succeeds and `checkCertificate` is never called, so
   * the trust list is never consulted - and the thumbprint the pin is compared against came from an
   * unsigned, unauthenticated GetEndpoints reply, which any host answering on that address can
   * write. The check therefore catches an honest certificate rotation and nothing an attacker does.
   *
   * Measured before this refusal: `None` + the right pin opened a session, `None` + a wrong pin was
   * refused by name - which teaches an operator that the pin is protecting them - while the dialog's
   * own hint and `docs/providers/opcua.md` both say a certificate cannot be pinned on a None
   * channel. Three surfaces, two of them wrong. The pair is refused here, before any socket, and
   * the sentence names the two ways out.
   */
  if (pinnedThumbprint !== undefined && mode === "None") {
    throw new DatabaseConfigError(
      "A pinned server certificate cannot be enforced on a None channel: nothing signs or encrypts " +
        "the exchange, so the thumbprint this connection would check against is read from a reply " +
        "anybody on the address can write, and the server's certificate is never checked against the " +
        "trust list at all. Choose Sign or Sign and Encrypt to make the pin mean something, or clear " +
        "the pin to connect unprotected on purpose.",
      OPCUA_TYPE,
    );
  }

  const certificatePath = typeof config.clientCertificatePath === "string" ? config.clientCertificatePath : undefined;
  const privateKeyPath = typeof config.clientPrivateKeyPath === "string" ? config.clientPrivateKeyPath : undefined;
  // Refuses one without the other, which cannot open a secured channel.
  clientIdentitySource({
    ...(certificatePath === undefined ? {} : { certificatePath }),
    ...(privateKeyPath === undefined ? {} : { privateKeyPath }),
  });

  return {
    endpointUrl,
    host: endpoint.host,
    port: endpoint.port,
    mode,
    ...(typeof config.securityPolicyUri === "string" && config.securityPolicyUri.trim() !== ""
      ? { policyUri: config.securityPolicyUri.trim() }
      : {}),
    identity,
    ...(user === undefined ? {} : { user }),
    ...(password === undefined ? {} : { password }),
    ...(pinnedThumbprint === undefined ? {} : { pinnedThumbprint }),
    ...(pkiRoot === undefined ? {} : { pkiRoot }),
    ...(certificatePath === undefined ? {} : { clientCertificatePath: certificatePath }),
    ...(privateKeyPath === undefined ? {} : { clientPrivateKeyPath: privateKeyPath }),
    tunnelled,
  };
}

/**
 * The endpoint URL to dial through an open tunnel: the reader's own URL at the local end.
 *
 * WHICH SIDE HOLDS WHAT, because getting it backwards is how this was wrong twice.
 * `tunnelledConnection` (`src/lib/db/factory.ts`) hands a provider:
 *
 *   `host` = the forward's LOCAL host, `port` = its LOCAL port - the address to dial;
 *   `TUNNEL_FAR_END` = the address the forward was opened FOR, which is the connection's own
 *   `host` and `port` as the reader typed them - and for this engine that `host` is the whole
 *   endpoint URL (`createSSHTunnel(id, sshTunnel, connection.host, connection.port)`).
 *
 * So the URL is parsed from the FAR END, which is where the reader's text now lives, and dialled at
 * the local pair. Parsing the rewritten `host` instead reads a bare `127.0.0.1` as a URL and
 * refuses every tunnelled connection, which is exactly what the first attempt at this did.
 *
 * The far end is required: a tunnel the dialog declared and the factory has not opened would
 * otherwise dial the local port of nothing.
 */
function tunnelledEndpointUrl(
  config: DatabaseConnection & { readonly [key: string]: unknown },
  farEnd: TunnelFarEnd | undefined,
): string {
  if (farEnd === undefined) {
    throw new DatabaseConfigError(
      "This connection goes through an SSH tunnel that is not open yet, so there is no local address to " +
        "dial. Open the tunnel, or clear it to connect to the endpoint directly.",
      OPCUA_TYPE,
    );
  }
  // The reader's own URL, validated as theirs: a mistyped scheme is heard as that rather than as a
  // sentence about the tunnel. The path is theirs too - OPC PLC answers on `/`, a Milo demo on `/milo`.
  const endpoint = readEndpointUrl(farEnd.host);
  const localHost = typeof config.host === "string" && config.host.trim() !== "" ? config.host.trim() : "127.0.0.1";
  const localPort = typeof config.port === "number" ? config.port : endpoint.port;
  return `${OPCUA_SCHEME}//${localHost}:${localPort}${endpoint.path}`;
}
