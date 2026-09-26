/**
 * How a Prometheus request leaves the process (#1085, sections 3.1, 3.4 and 3.6)
 *
 * Nothing here knows about Prometheus. A request arrives fully built (its URL, headers, body,
 * signal, and the most bytes its answer may hold) and what comes back is the status, the
 * content type and the body. Two paths sit behind one function type:
 *
 * - Plaintext goes through the global `fetch`, looked up when each request is sent, so a test
 *   that replaces `globalThis.fetch` after the provider was built still sees the call.
 * - TLS goes through `node:https`, because `fetch` cannot take a custom CA, a client certificate
 *   or `rejectUnauthorized` without an undici `Agent`, and undici is not a dependency (the
 *   Couchbase transport made the same choice). The URL reaches it through
 *   `url.urlToHttpOptions`, which drops the brackets of an IPv6 literal: handed `[::1]` as a
 *   hostname, `node:https` resolves it as a name and answers ENOTFOUND.
 *
 * Both paths keep the same rules, because every Studio user shares this one process:
 *
 * - No redirect is followed (#1085 S2). A followed 307 or 308 replays the request and its body
 *   wherever `Location` points, and `fetch` keeps `Authorization` on a same-origin hop. Any 3xx
 *   goes to the shared `rejectRedirect` (src/lib/db/http/endpoint.ts), the refusal every HTTP
 *   transport has used since #1086: a `ConnectionError` naming the status and only the Location
 *   origin, because a path or a query can hold a token. Its body is released unread.
 * - The body is counted as it streams and the connection is torn down the moment it passes
 *   `maxBytes` (#1085 S5), so no answer is held whole before its size is known.
 * - Every request carries a signal, and the signal, not whatever the runtime threw, tells a
 *   deadline (`AbortSignal.timeout`) from a cancellation.
 * - A TLS failure stays a failure carrying the runtime's code, and nothing is retried over
 *   plain HTTP (#1085 S8).
 * - A failure message is made of a status, a code, an origin or a number, never of a header
 *   value, a response body or the runtime's own message: `fetch` quotes a header value it
 *   refuses (measured on bun 1.4.2), and these messages reach the log and the client.
 *
 * `tlsMaterialFor` is the Couchbase transport's mapping, written again here because this
 * provider touches no other provider (#1085, section 3.4; docs/BACKLOG.md D37).
 */
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { urlToHttpOptions } from "node:url";
import { rejectRedirect } from "@/lib/db/http/endpoint";
import { guardedNodeOptions, httpTransportFetch } from "@/lib/db/http/egress-policy";
import type { SSLConfig } from "@/lib/types";

/** One request, built whole by the caller. */
export interface OutboundRequest {
  readonly method: "GET" | "POST";
  readonly url: URL;
  /** Sent exactly as given. Nothing is added, so a request with a body names its own content type. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string; // application/x-www-form-urlencoded when present
  readonly signal: AbortSignal;
  /** The most body bytes read; one byte more fails the request as "too_large". */
  readonly maxBytes: number;
}

export interface InboundResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

export type SendRequest = (request: OutboundRequest) => Promise<InboundResponse>;

/** A 3xx is none of these: the shared rejectRedirect refuses it on both paths, as a ConnectionError. */
export type RequestFailureReason = "tls" | "network" | "too_large" | "deadline" | "aborted";

export interface RequestFailureDetail {
  readonly code?: string;
  readonly limitBytes?: number;
}

/** Never carries a header value or a response body in its message. */
export class RequestFailure extends Error {
  constructor(
    readonly reason: RequestFailureReason,
    message: string,
    readonly detail: RequestFailureDetail = {},
  ) {
    super(message);
    this.name = "RequestFailure";
    Object.setPrototypeOf(this, RequestFailure.prototype);
  }
}

/** The TLS options of node:https, under its own names. */
export interface TlsMaterial {
  readonly rejectUnauthorized: boolean;
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
}

/**
 * null for no TLS; otherwise the Couchbase mapping:
 * rejectUnauthorized = ssl.rejectUnauthorized ?? ssl.mode !== "require".
 *
 * `require` encrypts without checking, because a self-hosted server ordinarily presents a
 * self-signed certificate; every other mode verifies, and an explicit flag wins either way.
 * `verify-ca` and `verify-full` come out the same: Node checks the server name whenever it
 * verifies, so the two cannot be told apart here (SSLMode in src/lib/types.ts says the same).
 * An empty field is left out, because a cleared form field is not a certificate.
 */
export function tlsMaterialFor(ssl: SSLConfig | undefined): TlsMaterial | null {
  if (ssl === undefined || ssl.mode === "disable") return null;
  return {
    rejectUnauthorized: ssl.rejectUnauthorized ?? ssl.mode !== "require",
    ...(ssl.caCert ? { ca: ssl.caCert } : {}),
    ...(ssl.clientCert ? { cert: ssl.clientCert } : {}),
    ...(ssl.clientKey ? { key: ssl.clientKey } : {}),
  };
}

/**
 * The names both runtimes give OpenSSL's certificate verification results, X509_V_ERR_* without
 * the prefix. A leaf whose issuer is not trusted is UNABLE_TO_VERIFY_LEAF_SIGNATURE on bun 1.4.2,
 * as on Node.
 */
const CERTIFICATE_VERIFICATION_CODES: ReadonlySet<string> = new Set([
  "CERT_CHAIN_TOO_LONG",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CRL_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "HOSTNAME_MISMATCH",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "PATH_LENGTH_EXCEEDED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/**
 * Handshake, identity and key-material failures: OpenSSL's reasons (ERR_SSL_), Node's TLS layer
 * (ERR_TLS_), OpenSSL 3's decoders (ERR_OSSL_), and BoringSSL on Bun, which answers a CA it cannot
 * read with ERR_BORINGSSL (measured on bun 1.4.2).
 */
const TLS_CODE_PREFIXES: readonly string[] = ["ERR_SSL_", "ERR_TLS_", "ERR_OSSL_", "ERR_BORINGSSL"];

function isTlsCode(code: string): boolean {
  return CERTIFICATE_VERIFICATION_CODES.has(code) || TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/** A non-empty string `code`, on the error itself (Bun, node:https) or on its cause, where Node's fetch puts it. */
function errorCode(error: unknown): string | undefined {
  return ownCode(error) ?? (error instanceof Error ? ownCode(error.cause) : undefined);
}

function ownCode(value: unknown): string | undefined {
  const code = typeof value === "object" && value !== null ? (value as { code?: unknown }).code : undefined;
  return typeof code === "string" && code !== "" ? code : undefined;
}

const NETWORK_FAILURE = "The request failed before a complete response arrived";

/** A deadline when an AbortSignal.timeout() fired, a cancellation for any other reason. */
function abortFailure(signal: AbortSignal): RequestFailure {
  const reason: unknown = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? new RequestFailure("deadline", "The request did not finish within its time limit")
    : new RequestFailure("aborted", "The request was cancelled");
}

/** Whatever a send raised, as a failure whose message holds a code at most. */
function failureFrom(error: unknown, signal: AbortSignal): RequestFailure {
  // Raised on purpose inside a send, and already worded.
  if (error instanceof RequestFailure) return error;
  // Whatever the runtime threw once the signal fired, the signal says which kind of stop it was.
  if (signal.aborted) return abortFailure(signal);
  const code = errorCode(error);
  if (code === undefined) return new RequestFailure("network", NETWORK_FAILURE);
  if (isTlsCode(code)) return new RequestFailure("tls", `The TLS connection failed (${code})`, { code });
  return new RequestFailure("network", `${NETWORK_FAILURE} (${code})`, { code });
}

function tooLarge(limitBytes: number): RequestFailure {
  return new RequestFailure(
    "too_large",
    `The response exceeded the ${limitBytes}-byte limit for one response, so it was not read to the end`,
    { limitBytes },
  );
}

/** The body, counted as it streams and abandoned the moment it passes maxBytes. */
async function readCapped(body: Response["body"], maxBytes: number): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    received += value.byteLength;
    if (received > maxBytes) {
      // Cancelling the stream is what tears the connection down.
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
}

async function sendPlain(request: OutboundRequest): Promise<InboundResponse> {
  let response: Response;
  try {
    response = await httpTransportFetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: request.signal,
    });
  } catch (error) {
    throw failureFrom(error, request.signal);
  }
  // Out of the try above on purpose: the refusal is a ConnectionError, whose own code,
  // CONNECTION_ERROR, failureFrom would read as a network code.
  try {
    rejectRedirect(response, request.url.href);
  } catch (refusal) {
    // Released unread: nothing uses a redirect's body, and nothing bounds how long it runs. A body
    // whose connection already failed rejects the cancel with the runtime's own error; it holds
    // nothing left to release, and the refusal is the answer either way.
    await response.body?.cancel().catch(() => {});
    throw refusal;
  }
  try {
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await readCapped(response.body, request.maxBytes),
    };
  } catch (error) {
    throw failureFrom(error, request.signal);
  }
}

function sendOverTls(tls: TlsMaterial, request: OutboundRequest): Promise<InboundResponse> {
  return new Promise<InboundResponse>((resolve, reject) => {
    const { protocol, hostname, port, path } = urlToHttpOptions(request.url);
    let clientRequest: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;

    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      request.signal.removeEventListener("abort", onAbort);
      return true;
    };
    const fail = (failure: Error): void => {
      if (!settle()) return;
      // Destroying the socket is what stops a server that keeps writing.
      response?.destroy();
      clientRequest?.destroy();
      reject(failure);
    };
    const failWith = (error: unknown): void => fail(failureFrom(error, request.signal));
    const onAbort = (): void => fail(abortFailure(request.signal));

    try {
      clientRequest = httpsRequest(
        {
          protocol,
          hostname,
          port,
          path,
          method: request.method,
          headers: request.headers,
          ...tls,
          ...guardedNodeOptions(hostname),
        },
        (incoming) => {
          response = incoming;
          incoming.on("error", failWith);
          // Set on every response a ClientRequest receives; the type is shared with server-side requests.
          const status = incoming.statusCode ?? 0;
          try {
            // The shared refusal reads a status and a Location header, so the adapter hands it those two.
            const location = incoming.headers.location;
            const headers = new Headers(location === undefined ? {} : { location });
            rejectRedirect({ status, headers }, request.url.href);
          } catch (refusal) {
            // Released unread, as on the fetch path: fail() destroys the response.
            fail(refusal as Error);
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          incoming.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > request.maxBytes) {
              fail(tooLarge(request.maxBytes));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on("end", () => {
            if (!settle()) return;
            const contentType = incoming.headers["content-type"] ?? null;
            resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8") });
          });
        },
      );
      clientRequest.on("error", failWith);
      request.signal.addEventListener("abort", onAbort, { once: true });
      clientRequest.end(request.body);
    } catch (error) {
      // node:https refuses some requests by throwing before anything is sent: a header value
      // with a line feed, an http: URL, TLS material it cannot read.
      failWith(error);
    }
  });
}

/** null: plaintext through the global fetch, read at call time. Non-null: node:https with that material. */
export function createSendRequest(tls: TlsMaterial | null): SendRequest {
  const send: SendRequest = tls === null ? sendPlain : (request) => sendOverTls(tls, request);
  return async (request) => {
    // An already-aborted signal never fires "abort" again, and node:https would send the request regardless.
    if (request.signal.aborted) throw abortFailure(request.signal);
    return send(request);
  };
}
