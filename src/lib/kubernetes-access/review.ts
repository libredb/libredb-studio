/**
 * One SubjectAccessReview: whether the Kubernetes API allows `user`, in `groups`, to do one thing to one object.
 *
 * Studio asks as itself, with the pod's ServiceAccount token, which may create SubjectAccessReviews and nothing else;
 * the review names the person, so the answer is the one Kubernetes RBAC gives that person, as Rancher's own requests on
 * a downstream cluster impersonate the Rancher user id with the user's group principals. The token and the CA are read
 * again for every review, so a rotated projected token is used at once and nothing about them is kept in memory.
 *
 * The answer is a trust boundary: an allowed review opens a database's credentials to a person. So it is `allowed` only
 * for a 2xx `SubjectAccessReview` that echoes the asked user and says `allowed: true` without `denied: true`, and every
 * other outcome is `failed`, which every caller treats as a deny: a setting, token or CA that cannot be used (a CA
 * file without a PEM certificate included, so no runtime falls back to its public roots), a
 * connection or TLS failure, the two-second deadline, a status that is not 2xx (a redirect is never followed), and a
 * body that is not JSON, too large, of another kind or for another user. A failure names its reason and, for a status,
 * the status, and never the token, the groups or the object. Before its first review in a process it asks whether the
 * cluster serves config.openshift.io/v1 (platform-check.ts), and on such a cluster every review fails with `platform`:
 * there a SubjectAccessReview cannot assert the cluster's user name for an OIDC subject.
 *
 * openshift sign-in has a second backend, the self review: a SelfSubjectAccessReview sent with the signed-in user's own
 * scoped token, so the answer is that user's own RBAC and the review names nothing of Studio's choosing about the
 * person, no user, groups or scopes. It goes only through openShiftApiCall (src/lib/openshift-auth/http.ts), so the API
 * URL, the CA file as the only trust, the two-second deadline, no environment proxy and no redirect are that one
 * implementation. A token that is not visible ASCII fails before any call, so no CR or LF can reach a header. It is
 * `allowed` only for a 2xx SelfSubjectAccessReview that echoes the five asked attributes (the API server omits an
 * empty one, which reads as "") and says `allowed: true` without `denied: true`; a 401 is `expired`, because the API
 * server no longer takes the token, and a 403 `forbidden`, a token without the user:check-access scope.
 */
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { isTlsFailureCode } from "@/lib/db/http/node-transport";
import { OpenShiftConfigError } from "@/lib/openshift-auth/config";
import { type OpenShiftCallResult, openShiftApiCall } from "@/lib/openshift-auth/http";
import { accessReviewApiUrl, accessReviewCaPath, accessReviewTokenPath } from "./config";
import { clusterPlatform } from "./platform-check";

/** The person a review asks about: the identity provider subject and the groups its ID token named. */
export interface ReviewSubject {
  readonly user: string;
  readonly groups: readonly string[];
}

/** The self review's subject: the session handle, which keys the decision cache only, and the user's own token. */
export interface SelfReviewSubject {
  readonly sessionHandle: string;
  readonly token: string;
}

export type AnyReviewSubject = ReviewSubject | SelfReviewSubject;

export const isSelfSubject = (subject: AnyReviewSubject): subject is SelfReviewSubject => "token" in subject;

/** The one thing a review asks about, as a SubjectAccessReview's `resourceAttributes`; `group` is "" for core. */
export interface ResourceAttributes {
  readonly verb: string;
  readonly group: string;
  readonly resource: string;
  readonly namespace: string;
  readonly name: string;
}

export type ReviewFailureReason =
  | "config"
  | "token"
  | "ca"
  | "timeout"
  | "tls"
  | "network"
  | "status"
  | "too-large"
  | "malformed"
  | "forbidden"
  | "platform";

export type ReviewOutcome =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied" }
  /** Self review only: the API server answered 401, so the user's token is dead. */
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly reason: ReviewFailureReason; readonly status?: number };

export type FailedReview = Extract<ReviewOutcome, { kind: "failed" }>;

/** How long one review may take, connection included. */
const REVIEW_TIMEOUT_MS = 2000;
/**
 * An answer echoes the review it decides, groups included. The groups store keeps at most 64 KiB of group names per
 * person, and the API server's JSON can write one byte as six (`\u0026` for `&`), so an answer to any review Studio
 * sends fits in this cap with room to spare, and anything larger is not one.
 */
const MAX_RESPONSE_BYTES = 512 * 1024;
const REVIEW_PATH = "/apis/authorization.k8s.io/v1/subjectaccessreviews";
const SELF_REVIEW_PATH = "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews";
/** A self review echoes no groups, so its answer is a few hundred bytes. */
const MAX_SELF_RESPONSE_BYTES = 64 * 1024;
/** A bearer token is visible ASCII and nothing else. */
const BEARER_TOKEN = /^[\x21-\x7e]+$/;
/** The resource attributes an answer must echo, in the order a review sends them. */
const ATTRIBUTE_FIELDS = ["verb", "group", "resource", "namespace", "name"] as const;
/** What a PEM CA bundle holds at least once. */
const CERTIFICATE_BLOCK = "-----BEGIN CERTIFICATE-----";

const ALLOWED: ReviewOutcome = Object.freeze({ kind: "allowed" });
const DENIED: ReviewOutcome = Object.freeze({ kind: "denied" });
const EXPIRED: ReviewOutcome = Object.freeze({ kind: "expired" });

function failed(reason: ReviewFailureReason, status?: number): FailedReview {
  return status === undefined ? { kind: "failed", reason } : { kind: "failed", reason, status };
}

/** A file's text, or null when it cannot be read. */
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the network gave back, before it is judged. */
export interface RawAnswer {
  readonly status: number;
  readonly text: string;
}

/** Why a request failed on the way: the deadline, TLS, or the network. */
function transportFailure(error: unknown, signal: AbortSignal): FailedReview {
  if (signal.aborted) return failed("timeout");
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return failed(typeof code === "string" && isTlsFailureCode(code) ? "tls" : "network");
}

/** One request of the ServiceAccount backend: a review, or the platform check. */
export interface ServiceAccountCall {
  readonly url: URL;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly token: string;
  readonly ca: string;
  readonly body?: string;
  readonly timeoutMs: number;
}

/**
 * Sends one request of the ServiceAccount backend under the API URL's path, with the pod's token and the CA file as
 * the only trust, and collects the answer, up to the size cap and the deadline. A redirect is an answer, never
 * followed. Never throws: a failure on the way is a failed outcome.
 */
export function serviceAccountCall(call: ServiceAccountCall): Promise<RawAnswer | FailedReview> {
  const { url, token, ca, body } = call;
  const signal = AbortSignal.timeout(call.timeoutMs);
  const headers: Record<string, string | number> = { accept: "application/json", authorization: `Bearer ${token}` };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: RawAnswer | FailedReview) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const outgoing = request(
        {
          method: call.method,
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port === "" ? 443 : Number(url.port),
          // A URL with no path still has the pathname "/", which the request path must not follow; every other
          // trailing slash is gone already (accessReviewApiUrl).
          path: `${url.pathname === "/" ? "" : url.pathname}${call.path}`,
          ca,
          signal,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              settle(failed("too-large"));
              outgoing.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            settle({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
          );
          response.on("error", (error) => settle(transportFailure(error, signal)));
        },
      );
      outgoing.on("error", (error) => settle(transportFailure(error, signal)));
      outgoing.end(body);
    } catch (error) {
      settle(transportFailure(error, signal));
    }
  });
}

/**
 * The decision a 2xx answer's body carries: a review of `kind` whose `spec` answers the review asked, judged by
 * `specMatches`, with a boolean `allowed`.
 */
function judge(text: string, kind: string, specMatches: (spec: Record<string, unknown>) => boolean): ReviewOutcome {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return failed("malformed");
  }
  if (!isRecord(document) || document.kind !== kind) return failed("malformed");
  const { spec, status } = document;
  if (!isRecord(spec) || !specMatches(spec)) return failed("malformed");
  if (!isRecord(status) || typeof status.allowed !== "boolean") return failed("malformed");
  return status.allowed && status.denied !== true ? ALLOWED : DENIED;
}

/** Whether an answer's `spec` echoes the asked attributes; the API server omits an empty field, which reads as "". */
function echoes(spec: Record<string, unknown>, asked: ResourceAttributes): boolean {
  const echoed = spec.resourceAttributes;
  return isRecord(echoed) && ATTRIBUTE_FIELDS.every((field) => (echoed[field] ?? "") === asked[field]);
}

/** The decision of a self review's answer: 401 expired, 403 forbidden, another status failed, else the body's. */
function judgeSelf(result: Extract<OpenShiftCallResult, { kind: "answer" }>, asked: ResourceAttributes): ReviewOutcome {
  if (result.status === 401) return EXPIRED;
  if (result.status === 403) return failed("forbidden");
  if (result.status < 200 || result.status > 299) return failed("status", result.status);
  return judge(result.body, "SelfSubjectAccessReview", (spec) => echoes(spec, asked));
}

/** One SelfSubjectAccessReview with the user's own token, through openShiftApiCall only. Never throws. */
async function requestSelfReview(
  subject: SelfReviewSubject,
  attributes: ResourceAttributes,
  timeoutMs: number | undefined,
): Promise<ReviewOutcome> {
  if (!BEARER_TOKEN.test(subject.token)) return failed("token");
  const { verb, group, resource, namespace, name } = attributes;
  let result: OpenShiftCallResult;
  try {
    result = await openShiftApiCall({
      method: "POST",
      path: SELF_REVIEW_PATH,
      bearer: subject.token,
      json: {
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: { resourceAttributes: { verb, group, resource, namespace, name } },
      },
      maxBytes: MAX_SELF_RESPONSE_BYTES,
      timeoutMs,
    });
  } catch (error) {
    // OPENSHIFT_API_URL refused; the transport throws nothing else, and anything else is a failure on the way.
    return failed(error instanceof OpenShiftConfigError ? "config" : "network");
  }
  return result.kind === "failed" ? failed(result.reason) : judgeSelf(result, attributes);
}

/**
 * Asks the Kubernetes API whether `subject` may do what `attributes` name: a self review with the user's own token for
 * a self subject, else a SubjectAccessReview as Studio's ServiceAccount. Never throws: every failure is an outcome.
 * `timeoutMs` is a test seam; production keeps the two-second deadline.
 */
export async function requestAccessReview(
  subject: AnyReviewSubject,
  attributes: ResourceAttributes,
  options: { readonly timeoutMs?: number } = {},
): Promise<ReviewOutcome> {
  if (isSelfSubject(subject)) return requestSelfReview(subject, attributes, options.timeoutMs);
  if (subject.user === "") return failed("config");
  let url: URL;
  try {
    url = accessReviewApiUrl();
  } catch {
    return failed("config");
  }
  const token = (await readText(accessReviewTokenPath()))?.trim();
  if (!token) return failed("token");
  // A `ca` without a certificate must never reach node:https: depending on the runtime an empty one is ignored, and
  // the public roots would then vouch for the API server. So it fails here, before any connection.
  const ca = await readText(accessReviewCaPath());
  if (!ca?.includes(CERTIFICATE_BLOCK)) return failed("ca");

  const body = JSON.stringify({
    apiVersion: "authorization.k8s.io/v1",
    kind: "SubjectAccessReview",
    spec: {
      user: subject.user,
      groups: [...subject.groups],
      resourceAttributes: {
        verb: attributes.verb,
        group: attributes.group,
        resource: attributes.resource,
        namespace: attributes.namespace,
        name: attributes.name,
      },
    },
  });
  const timeoutMs = options.timeoutMs ?? REVIEW_TIMEOUT_MS;
  const platform = await clusterPlatform(url, token, ca, timeoutMs);
  if (platform === "openshift") return failed("platform");
  if (platform !== "kubernetes") return platform;
  const answer = await serviceAccountCall({ url, method: "POST", path: REVIEW_PATH, token, ca, body, timeoutMs });
  if ("kind" in answer) return answer;
  if (answer.status < 200 || answer.status > 299) return failed("status", answer.status);
  return judge(answer.text, "SubjectAccessReview", (spec) => spec.user === subject.user);
}
