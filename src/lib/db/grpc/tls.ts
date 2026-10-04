/**
 * The SSL / TLS panel read once for every gRPC provider (the gRPC mapping docs/BACKLOG.md D37 counts once), the TLS
 * identity of one dialled host, the dial target and the endpoint host rule: what a provider hands the channel
 * credentials of credentials.ts and the server-name override of channel.ts. No socket opens here: every refusal is the
 * caller's DatabaseConfigError, worded with the caller's words, and none repeats the value it refuses. Nothing here
 * knows about an engine, and no provider is imported; server-only.
 */
import { createPrivateKey, type KeyObject, X509Certificate } from "node:crypto";
import { isIP, isIPv6 } from "node:net";
import type { DatabaseConfigError } from "@/lib/db/errors";
import { validateHost } from "@/lib/db/http/endpoint";
import type { SSLConfig, SSLMode } from "@/lib/types";

/** The panel's TLS material, before an identity is chosen. `disable`, an absent and a null panel are no TLS. */
export interface GrpcTlsMaterial {
  readonly mode: "require" | "verify-system" | "verify-ca" | "verify-full";
  /** PEM as configured; absent means the runtime's roots. */
  readonly ca?: string;
  readonly clientCertificate?: { readonly cert: string; readonly key: string };
  /** False only for `require`, or an explicit `rejectUnauthorized: false`. */
  readonly verify: boolean;
}

/** The material with the identity of one dialled host. */
export interface GrpcTlsOptions extends GrpcTlsMaterial {
  /** The TLS identity: the tunnel's far end when one carries the connection, else the host, bare (no IPv6 brackets). */
  readonly identity: string;
  readonly identityIsIp: boolean;
  /** Always set as `grpc.ssl_target_name_override`: the identity, or the caller's IP server name for an IP identity. */
  readonly serverNameOverride: string;
}

/** What a provider hands the shared reader so that its sentences and errors stay its own. */
export interface GrpcConfigWords {
  /** The engine name a sentence carries, as the provider writes it in prose (the CA sentence names the engine's server certificate). */
  readonly engine: string;
  /** The provider's DatabaseConfigError for a sentence, so the error carries the provider's DatabaseType. */
  readonly refuse: (message: string) => DatabaseConfigError;
  /** The provider's wrong-type error for a field and what it must be. */
  readonly wrongType: (field: string, expected: string) => DatabaseConfigError;
  /** A provider's own client-certificate preflight, run after the certificate parses and before the key match. */
  readonly clientCertificateRefusal?: (x509: X509Certificate, now: number) => string | undefined;
}

/**
 * One row per SSLMode member: a record, so a mode added to SSLMode fails the typecheck here until this table answers
 * for it. `null` is a plaintext channel; a row names the TLS mode and whether it verifies the chain and the name when
 * `rejectUnauthorized` does not decide. The chain is checked against the pasted CA when one is configured, and against
 * the runtime's roots otherwise.
 */
const TLS_MODES: Readonly<
  Record<SSLMode, { readonly mode: GrpcTlsMaterial["mode"]; readonly verify: boolean } | null>
> = Object.freeze({
  disable: null,
  require: { mode: "require", verify: false },
  "verify-system": { mode: "verify-system", verify: true },
  "verify-ca": { mode: "verify-ca", verify: true },
  "verify-full": { mode: "verify-full", verify: true },
});

/** A PEM BEGIN marker with anything before it on its line, where no PEM reader opens a block (checkCa). */
const PEM_BEGIN_INSIDE_A_LINE = /[^\n]-----BEGIN/;
/** OpenSSL's trust form of a certificate, which Node reads with its trust settings and Bun reads nothing from (checkCa). */
const PEM_TRUSTED_CERTIFICATE = /-----BEGIN TRUSTED CERTIFICATE-----/;
/**
 * One certificate block under a label both runtimes read, as whole lines: its BEGIN line through the
 * first line that starts with an END marker, or through the end of the text when no line does (checkCa).
 */
const PEM_CERTIFICATE_BLOCK = /-----BEGIN (?:X509 )?CERTIFICATE-----[\s\S]*?(?:\n-----END [^\n]*|$)/g;

/** The two encrypted PEM key forms: PKCS#8's own label, and the header of a legacy encrypted key. */
const ENCRYPTED_PEM_KEY = /-----BEGIN ENCRYPTED PRIVATE KEY-----|^Proc-Type: 4,ENCRYPTED/m;

/** For the two ways a whole endpoint reaches Host: a URL, or `host:port`. */
const HOST_TAKES_NAME_ONLY = "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS.";
const CLIENT_PAIR =
  "The Client Certificate and the Client Private Key under SSL / TLS go together: add the missing one, or clear both.";
const CLIENT_CERTIFICATE_NOT_PEM =
  "The Client Certificate under SSL / TLS is not a PEM certificate: paste the certificate issued for this client there, and its key under Client Private Key.";
const CA_BEGIN_INSIDE_A_LINE =
  "The CA Certificate under SSL / TLS has a -----BEGIN marker that does not start its line: put each -----BEGIN marker at the start of a line there, with nothing before it, not even a space or a byte order mark.";
const CA_TRUSTED_FORM =
  "The CA Certificate under SSL / TLS holds a TRUSTED CERTIFICATE block, OpenSSL's form with trust settings, which not every runtime reads: paste the certificate in its plain PEM form there, as openssl x509 -in <file> prints it.";
const CLIENT_KEY_NOT_PEM =
  "The Client Private Key under SSL / TLS is not a PEM private key: paste the private key of the Client Certificate there.";
const CLIENT_KEY_ENCRYPTED =
  "The Client Private Key under SSL / TLS is encrypted, and SSL / TLS has no passphrase field: paste the key unencrypted there.";
const CLIENT_KEY_MISMATCH =
  "The Client Private Key under SSL / TLS is not the key of the Client Certificate: paste the private key issued with that certificate there.";

/** The one sentence that names the engine: whose server certificate the CA issued. */
function caNotPem(engine: string): string {
  return `The CA Certificate under SSL / TLS is not one or more PEM certificates: paste the certificate of the CA that issued ${engine}'s server certificate there.`;
}

/**
 * The SSL / TLS panel, checked whole before any of it is read, in this order:
 * the panel object; the mode (absent reads as `verify-full`); `caCert`, `clientCert`, `clientKey` as text;
 * `rejectUnauthorized` as a boolean; `disable` is undefined; the client pair together; the CA; the client pair.
 */
export function readGrpcTlsPanel(ssl: unknown, words: GrpcConfigWords): GrpcTlsMaterial | undefined {
  // The whole panel is checked, whatever its mode, before any of it is read.
  const panel = optionalObject<keyof SSLConfig>(ssl, "ssl", words);
  if (panel === undefined) return undefined;
  // A panel with no mode verifies: a seed file's panel may omit the mode (src/lib/seed/types.ts), and so does the API.
  const mode = panel.mode ?? "verify-full";
  if (typeof mode !== "string" || !Object.hasOwn(TLS_MODES, mode)) {
    throw words.wrongType("ssl.mode", "disable, require, verify-system, verify-ca or verify-full");
  }
  const ca = optionalText(panel.caCert, "ssl.caCert", words);
  const cert = optionalText(panel.clientCert, "ssl.clientCert", words);
  const key = optionalText(panel.clientKey, "ssl.clientKey", words);
  const rejectUnauthorized = optionalBoolean(panel.rejectUnauthorized, "ssl.rejectUnauthorized", words);
  const row = TLS_MODES[mode as SSLMode];
  if (row === null) return undefined;
  if ((cert === undefined) !== (key === undefined)) throw words.refuse(CLIENT_PAIR);
  // In the order the panel draws them, and in every TLS mode, since grpc-js reads all three whatever it verifies.
  if (ca !== undefined) checkCa(ca, words);
  if (cert !== undefined && key !== undefined) checkClientPair(cert, key, words);
  return {
    mode: row.mode,
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined || key === undefined ? {} : { clientCertificate: { cert, key } }),
    verify: rejectUnauthorized ?? row.verify,
  };
}

/** The material with `identity` as its TLS identity; an IP identity is overridden with `ipServerName` (D132). */
export function grpcTlsIdentity(material: GrpcTlsMaterial, identity: string, ipServerName: string): GrpcTlsOptions {
  const identityIsIp = isIP(identity) !== 0;
  return {
    mode: material.mode,
    ...(material.ca === undefined ? {} : { ca: material.ca }),
    ...(material.clientCertificate === undefined ? {} : { clientCertificate: material.clientCertificate }),
    verify: material.verify,
    identity,
    identityIsIp,
    serverNameOverride: identityIsIp ? ipServerName : identity,
  };
}

/** `dns:<host>:<port>`, a bare IPv6 host bracketed; grpc-js reads the text before the first colon as a resolver name. */
export function grpcTarget(host: string, port: number): string {
  return `dns:${isIPv6(host) ? `[${host}]` : host}:${port}`;
}

/**
 * A validated host, bare: a host holding a colon that is not an IPv6 literal's is a pasted endpoint, `host:port` or a
 * URL, and refused with the Host sentence; every other refusal is `validateHost`'s, re-raised through `words.refuse`
 * with its message unchanged. Node's `isIPv6` also admits a zone (`::1%lo`), which validateHost then refuses in its
 * own words.
 */
export function grpcEndpointHost(host: unknown, words: GrpcConfigWords): string {
  if (typeof host === "string" && host.includes(":") && !isIPv6(unbracketed(host))) {
    throw words.refuse(HOST_TAKES_NAME_ONLY);
  }
  // validateHost answers in lower case, an IPv6 literal in brackets, and refuses with an error that names no provider.
  let validated: string;
  try {
    validated = validateHost(host);
  } catch (error) {
    throw words.refuse((error as Error).message);
  }
  return unbracketed(validated);
}

/** A host without the brackets an IPv6 literal is written in; any other host unchanged. */
function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * The TLS material grpc-js's `createSsl` would otherwise meet unchecked, refused in words before any
 * channel is built. Measured under Bun 1.4.2 and Node 24.14.0: `createSsl` throws the runtime's own
 * code for a key that is not PEM (ERR_OSSL_PEM_NO_START_LINE under Bun, ERR_OSSL_UNSUPPORTED under
 * Node) and for a key that is another certificate's (ERR_OSSL_X509_KEY_VALUES_MISMATCH), and Bun for a
 * CA that holds no certificate ("Invalid CA", ERR_BORINGSSL) and for a key of another type than the
 * certificate's (ERR_OSSL_X509_KEY_TYPE_MISMATCH); Node reads no certificate from such a CA, so every
 * chain fails, and drops a key of another type, so the handshake goes on without the certificate.
 *
 * A CA is read as both runtimes' PEM readers read it, line by line, a line being what a LF ends: a
 * block opens only at a line that starts with its BEGIN marker, and every other line is skipped, so a
 * bundle's comment lines are kept. A BEGIN marker with anything before it on its line is refused in
 * its own words, since the runtimes skip its certificate, or Bun throws "Invalid CA" when two
 * certificates are joined with no line break; Node alone skips a leading byte order mark, which is
 * refused as well, so one rule holds under both. Each block under the two labels both runtimes read,
 * CERTIFICATE and the older X509 CERTIFICATE, is read whole with X509Certificate, from its BEGIN line
 * through its END line, so a block that does not read, text after its END marker included, is refused,
 * as is a field with no block. A TRUSTED CERTIFICATE block, OpenSSL's trust form, is refused in its
 * own words, because Node reads it with its trust settings and Bun reads no certificate from it.
 */
function checkCa(pem: string, words: GrpcConfigWords): void {
  if (PEM_BEGIN_INSIDE_A_LINE.test(pem)) throw words.refuse(CA_BEGIN_INSIDE_A_LINE);
  if (PEM_TRUSTED_CERTIFICATE.test(pem)) throw words.refuse(CA_TRUSTED_FORM);
  const notPem = caNotPem(words.engine);
  const blocks = pem.match(PEM_CERTIFICATE_BLOCK) ?? [];
  if (blocks.length === 0) throw words.refuse(notPem);
  for (const block of blocks) certificate(block, notPem, words);
}

/**
 * The client certificate, the caller's own preflight of it when it has one, its key, and that the key is the
 * certificate's own. Every private key form the runtimes read is taken (PKCS#8, PKCS#1 RSA and SEC1 EC); an
 * encrypted key is refused in its own words, because the panel has no passphrase field and neither runtime can use
 * the key without one.
 */
function checkClientPair(cert: string, key: string, words: GrpcConfigWords): void {
  const x509 = certificate(cert, CLIENT_CERTIFICATE_NOT_PEM, words);
  const refusal = words.clientCertificateRefusal?.(x509, Date.now());
  if (refusal !== undefined) throw words.refuse(refusal);
  if (!x509.checkPrivateKey(privateKey(key, words))) throw words.refuse(CLIENT_KEY_MISMATCH);
}

function certificate(pem: string, refusal: string, words: GrpcConfigWords): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch {
    throw words.refuse(refusal);
  }
}

function privateKey(pem: string, words: GrpcConfigWords): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch {
    // The runtimes disagree on the code (ERR_MISSING_PASSPHRASE under Bun, an OpenSSL one under Node), so the PEM decides.
    throw words.refuse(ENCRYPTED_PEM_KEY.test(pem) ? CLIENT_KEY_ENCRYPTED : CLIENT_KEY_NOT_PEM);
  }
}

/** A field that holds an object when it is present, never an array; null reads as absent. */
function optionalObject<Key extends string>(
  value: unknown,
  field: string,
  words: GrpcConfigWords,
): Partial<Record<Key, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw words.wrongType(field, "an object");
  return value as Partial<Record<Key, unknown>>;
}

/** A field that holds a string when it is present; null and the empty string read as absent. */
function optionalText(value: unknown, field: string, words: GrpcConfigWords): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw words.wrongType(field, "a string");
  return value;
}

/** A field that holds a boolean when it is present; null reads as absent. */
function optionalBoolean(value: unknown, field: string, words: GrpcConfigWords): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw words.wrongType(field, "true or false");
  return value;
}
