/**
 * What this provider refuses before it dials, and how a server's identity is settled (#1677 O-S2,
 * O-S3, O-S7, O-S8).
 *
 * EVERY RULE HERE EXISTS BECAUSE THE LIBRARY'S DEFAULT IS THE OPPOSITE. Measured on
 * `node-opcua-client` 2.187.3, and re-read in the 2.187.16 source (`getDefaultCertificateManager`):
 * the shared default certificate manager is built with
 * `automaticallyAcceptUnknownCertificate: true`, a SignAndEncrypt connect to a server nobody had
 * ever seen SUCCEEDED, and that server's certificate was written into `PKI/trusted/certs`. The
 * server was then recreated with a new certificate and the next connect trusted that one too, with
 * no prompt and no error. Part 4 6.1.3 says the opposite in as many words: "Applications shall
 * never communicate with another application that they do not trust", and "Applications shall rely
 * on lists of Certificates provided by the Administrator to determine trust."
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { isLoopbackHost } from "@/lib/db/http/endpoint";
import { OPCUA_POLICY_NONE, OPCUA_SCHEME, OPCUA_TYPE } from "./constants";
import type { OpcuaEndpoint } from "./client";

/** The three security modes a connection may ask for. */
export type OpcuaSecurityMode = "None" | "Sign" | "SignAndEncrypt";

/** How the reader proves who they are. */
export type OpcuaIdentityKind = "anonymous" | "username";

/**
 * The endpoint a connection names, parsed from what the reader typed and never from what the server
 * advertises.
 *
 * O-S7 IS A MEASUREMENT, NOT A PRECAUTION. OPC PLC advertises `opc.tcp://<container id>:50000/`,
 * a name that resolves nowhere outside the container, and Milo advertises the client's own host
 * with the server's INTERNAL port. A client that reconnected to an advertised URL would be
 * redirected by the server; measured, this provider's dial makes zero DNS lookups of the
 * advertised host and opens one TCP connection, to the typed one, with a decoy listener never
 * touched.
 */
export function readEndpointUrl(raw: string): {
  host: string;
  port: number;
  path: string;
} {
  const text = raw.trim();
  if (text === "") throw new DatabaseConfigError("An OPC UA connection needs an endpoint URL.", OPCUA_TYPE);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new DatabaseConfigError(
      `An endpoint URL reads ${OPCUA_SCHEME}//host:port/path, and this one could not be read at all.`,
      OPCUA_TYPE,
    );
  }
  if (url.protocol !== OPCUA_SCHEME)
    throw new DatabaseConfigError(
      `This provider speaks ${OPCUA_SCHEME}// only. There is no WebSocket or HTTPS transport in this version.`,
      OPCUA_TYPE,
    );
  if (url.username !== "" || url.password !== "")
    throw new DatabaseConfigError(
      "An endpoint URL carries no credential. Put the username and password in their own fields, where they are not written into a saved connection's address.",
      OPCUA_TYPE,
    );
  const host = url.hostname;
  if (host === "") throw new DatabaseConfigError("An endpoint URL needs a host.", OPCUA_TYPE);
  const port = url.port === "" ? 4840 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new DatabaseConfigError("An endpoint URL needs a port between 1 and 65,535.", OPCUA_TYPE);
  return { host, port, path: url.pathname };
}

/**
 * Whether a credential may cross this connection, and the refusal when it may not (O-S3).
 *
 * NONE AUTHENTICATES NOBODY, and measured it is worse than that: with a strict certificate manager
 * a None connect still succeeds, and `checkCertificate` is never called at all, so a certificate
 * pin cannot be enforced on a None channel even in principle. This rule therefore carries the whole
 * weight rather than being a second line of defence.
 *
 * The password itself IS encrypted on a None channel where the server's UserName token declares its
 * own policy: captured on the wire against OPC PLC, 2,428 bytes written, the plaintext absent, the
 * token's `encryptionAlgorithm` `rsa-oaep` and the encrypted password 256 bytes. But stock asyncua
 * declares the UserName token's policy as None, and then nothing encrypts it. So the rule reads the
 * EFFECTIVE policy, which is the token's own or the endpoint's where the token's is null
 * (Part 4 7.41), and refuses only an effective None.
 */
export function effectiveTokenPolicy(endpoint: OpcuaEndpoint, kind: OpcuaIdentityKind): string | null {
  if (kind === "anonymous") return null;
  const token = endpoint.userIdentityTokens.find((candidate) => candidate.tokenType === "UserName");
  if (token === undefined) return null;
  return token.securityPolicyUri ?? endpoint.securityPolicyUri;
}

/**
 * The refusal for a credential that would cross the network unprotected, or undefined.
 *
 * Exempt where the credential does not leave the machine or is carried by a tunnel, which is the
 * rule `docs/providers/qdrant.md` 4.6 states and every provider with a secret follows.
 */
export function plaintextIdentityRefusal(options: {
  readonly host: string;
  readonly tunnelled: boolean;
  readonly mode: OpcuaSecurityMode;
  readonly kind: OpcuaIdentityKind;
  readonly effectivePolicy: string | null;
}): string | undefined {
  if (options.kind === "anonymous") return undefined;
  if (options.tunnelled || isLoopbackHost(options.host)) return undefined;
  const channelProtects = options.mode === "SignAndEncrypt";
  const tokenProtects = options.effectivePolicy !== null && options.effectivePolicy !== OPCUA_POLICY_NONE;
  if (channelProtects || tokenProtects) return undefined;
  return (
    "This connection would send its password to a host that is not this machine with nothing encrypting it: " +
    "the security mode is None and the server's UserName token declares no policy of its own either. " +
    "Choose Sign and Encrypt under security, or connect through an SSH tunnel."
  );
}

/**
 * Whether the server presenting `thumbprint` is the one this connection pinned (O-S2).
 *
 * THE HOOK IS REAL AND IT IS THE RIGHT ONE. Measured: `certificateManager.checkCertificate` is
 * called exactly once and BEFORE CreateSession, so a wrong pin refuses with zero
 * CreateSessionRequest on the wire even when the certificate is otherwise trusted. The thumbprint
 * is SHA-256 over the DER as 64 lowercase hex, which is `openssl x509 -fingerprint -sha256` without the
 * colons, and it is readable before any session from `getEndpoints()[i].serverCertificate`.
 *
 * The comparison is case-insensitive on the hex and ignores colons and spaces, because an operator
 * pasting a thumbprint pastes whatever their tool printed.
 */
export function normaliseThumbprint(raw: string): string {
  return raw.trim().toLowerCase().replaceAll(":", "").replaceAll(" ", "");
}

export function pinRefusal(pinned: string | undefined, presented: string | undefined): string | undefined {
  if (pinned === undefined) return undefined;
  const want = normaliseThumbprint(pinned);
  if (!/^[0-9a-f]{64}$/.test(want))
    return "The pinned server certificate is not a SHA-256 thumbprint: it reads as 64 hexadecimal characters, which is what openssl x509 -fingerprint -sha256 prints without the colons.";
  if (presented === undefined)
    return `This connection pins the server certificate ${want}, and the server presented none. A None security mode presents a certificate but authenticates nobody with it, so a pin cannot be checked there.`;
  const got = normaliseThumbprint(presented);
  if (got !== want)
    return `This connection pins the server certificate ${want}, and the server presented ${got}. Nothing was sent to it. If the server's certificate was replaced on purpose, pin the new thumbprint.`;
  return undefined;
}
