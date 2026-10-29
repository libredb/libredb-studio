/**
 * The only network code of openshift sign-in, and the client OS2's self reviews reuse.
 *
 * Two trust sets. Every call to the API server (`openShiftApiCall`: the OAuth metadata, users/~ and the self reviews)
 * trusts the certificates of OPENSHIFT_API_CA_FILE and nothing else: those calls carry the user's token or answer the
 * role, and a corporate or public certificate for a cluster-internal name, met through a captured DNS name, must neither
 * receive the token nor forge an answer. Only the token call to the OAuth route (`openShiftTokenFetch`) also trusts
 * Node's bundled roots and the NODE_EXTRA_CA_CERTS file, because the route's certificate may chain to either. Both sets
 * are read on every call and a file that cannot be read or holds no certificate stops the call before it connects.
 *
 * Every request is a fresh `node:https` request with `agent: false`, so no global agent and no proxy configuration
 * (HTTPS_PROXY with NODE_USE_ENV_PROXY=1) ever sees the code, the client secret or the token; no redirect is followed;
 * the answer is capped; the deadline is an AbortSignal. The HTTPS call itself is module-private, so every outside call
 * goes through the two entry points. Nothing here logs, and no failure carries a header, a body or an error object.
 */

import https from "node:https";
import { rootCertificates } from "node:tls";
import type { CustomFetch } from "openid-client";
import { isTlsFailureCode } from "@/lib/db/http/node-transport";
import { openShiftApiCaFilePath, openShiftApiUrl } from "@/lib/openshift-auth/config";
import { readCertificateFile } from "@/lib/openshift-auth/files";

export const OPENSHIFT_API_TIMEOUT_MS = 2000;
export const OPENSHIFT_TOKEN_TIMEOUT_MS = 5000;
/** The token answer is a few hundred bytes. */
const TOKEN_MAX_BYTES = 16 * 1024;

export type OpenShiftCallFailureReason = "ca" | "timeout" | "tls" | "network" | "too-large";

export type OpenShiftCallResult =
  | { readonly kind: "answer"; readonly status: number; readonly contentType: string | null; readonly body: string }
  | { readonly kind: "failed"; readonly reason: OpenShiftCallFailureReason };

/** What `openShiftTokenFetch` throws, so openid-client rejects; it carries the failure class and nothing else. */
export class OpenShiftCallError extends Error {
  constructor(readonly reason: OpenShiftCallFailureReason) {
    super(`The OpenShift OAuth server call failed: ${reason}`);
    this.name = "OpenShiftCallError";
  }
}

const TOKEN_ORIGIN_MESSAGE = "The token request must go to the OAuth issuer's origin";
const TOKEN_BODY_MESSAGE = "The token request body must be a form";

interface HttpsCall {
  readonly url: URL;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly trust: readonly string[];
}

/** The certificates of OPENSHIFT_API_CA_FILE and nothing else, or null when it cannot be read or holds none. */
export async function openShiftApiTrust(): Promise<readonly string[] | null> {
  return readCertificateFile(openShiftApiCaFilePath());
}

/**
 * Node's bundled roots, the certificates of the NODE_EXTRA_CA_CERTS file when it is set, and those of
 * OPENSHIFT_API_CA_FILE; null when either file cannot be read or holds no certificate, so no call runs on a partial
 * set. NODE_EXTRA_CA_CERTS is read, never written.
 */
export async function openShiftTokenTrust(): Promise<readonly string[] | null> {
  const cluster = readCertificateFile(openShiftApiCaFilePath());
  const extraFile = process.env.NODE_EXTRA_CA_CERTS?.trim();
  const extra = extraFile ? readCertificateFile(extraFile) : [];
  if (cluster === null || extra === null) return null;
  return [...rootCertificates, ...extra, ...cluster];
}

function failed(reason: OpenShiftCallFailureReason): OpenShiftCallResult {
  return { kind: "failed", reason };
}

/** A transport error reduced to its class; the error object itself is dropped. */
function failureOf(error: unknown, signal: AbortSignal): OpenShiftCallResult {
  if (signal.aborted) return failed("timeout");
  const code = (error as { code?: unknown } | null)?.code;
  return failed(typeof code === "string" && isTlsFailureCode(code) ? "tls" : "network");
}

/** One HTTPS request on a fresh connection with the given trust set. Never throws: every failure is a result. */
function openShiftHttpsCall(call: HttpsCall): Promise<OpenShiftCallResult> {
  const signal = AbortSignal.timeout(call.timeoutMs);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: OpenShiftCallResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const headers: Record<string, string | number> = { ...call.headers };
      if (call.body !== undefined) headers["content-length"] = Buffer.byteLength(call.body);
      const outgoing = https.request(
        {
          method: call.method,
          hostname: call.url.hostname.replace(/^\[|\]$/g, ""),
          port: call.url.port === "" ? 443 : Number(call.url.port),
          path: `${call.url.pathname}${call.url.search}`,
          headers,
          ca: [...call.trust],
          agent: false,
          signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > call.maxBytes) {
              settle(failed("too-large"));
              outgoing.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            settle({
              kind: "answer",
              status: response.statusCode ?? 0,
              contentType: response.headers["content-type"] ?? null,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", (error) => settle(failureOf(error, signal)));
        },
      );
      outgoing.on("error", (error) => settle(failureOf(error, signal)));
      outgoing.end(call.body);
    } catch (error) {
      settle(failureOf(error, signal));
    }
  });
}

/**
 * A call to the API server: `path` resolved under OPENSHIFT_API_URL (its own path prefix kept), `bearer` sent only when
 * given, a JSON body when `json` is given, trusting OPENSHIFT_API_CA_FILE only, with the deadline `timeoutMs` (2 s when
 * absent; the seam lets a test check a deadline without waiting). Throws OpenShiftConfigError on an invalid
 * OPENSHIFT_API_URL; every other failure is a result.
 */
export async function openShiftApiCall(request: {
  method: "GET" | "POST";
  path: string;
  bearer?: string;
  json?: unknown;
  maxBytes: number;
  timeoutMs?: number;
}): Promise<OpenShiftCallResult> {
  const base = openShiftApiUrl();
  const url = new URL(base.href);
  url.pathname = `${base.pathname === "/" ? "" : base.pathname}${request.path}`;
  const trust = await openShiftApiTrust();
  if (trust === null) return failed("ca");
  const headers: Record<string, string> = { accept: "application/json" };
  if (request.bearer !== undefined) headers.authorization = `Bearer ${request.bearer}`;
  const body = request.json === undefined ? undefined : JSON.stringify(request.json);
  if (body !== undefined) headers["content-type"] = "application/json";
  return openShiftHttpsCall({
    url,
    method: request.method,
    headers,
    body,
    maxBytes: request.maxBytes,
    timeoutMs: request.timeoutMs ?? OPENSHIFT_API_TIMEOUT_MS,
    trust,
  });
}

/**
 * The `customFetch` of the token call's openid-client Configuration: refuses any URL outside `issuerOrigin`, then sends
 * through the module's HTTPS call with the token trust set, the 5-second deadline and a 16 KiB cap, and answers a
 * Response built from the answer; throws OpenShiftCallError on a failure, so openid-client rejects.
 */
export function openShiftTokenFetch(issuerOrigin: string): CustomFetch {
  return async (resource, options) => {
    const url = new URL(resource);
    if (url.origin !== issuerOrigin) throw new Error(TOKEN_ORIGIN_MESSAGE);
    const body = options.body instanceof URLSearchParams ? options.body.toString() : options.body;
    if (typeof body !== "string") throw new Error(TOKEN_BODY_MESSAGE);
    const trust = await openShiftTokenTrust();
    if (trust === null) throw new OpenShiftCallError("ca");
    const result = await openShiftHttpsCall({
      url,
      method: options.method as "GET" | "POST",
      headers: options.headers,
      body,
      maxBytes: TOKEN_MAX_BYTES,
      timeoutMs: OPENSHIFT_TOKEN_TIMEOUT_MS,
      trust,
    });
    if (result.kind === "failed") throw new OpenShiftCallError(result.reason);
    const headers = result.contentType === null ? undefined : { "content-type": result.contentType };
    return new Response(result.body, { status: result.status, headers });
  };
}
