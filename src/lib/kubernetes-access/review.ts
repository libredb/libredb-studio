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
 * other outcome is `failed`, which every caller treats as a deny: a setting, token or CA that cannot be used, a
 * connection or TLS failure, the two-second deadline, a status that is not 2xx (a redirect is never followed), and a
 * body that is not JSON, too large, of another kind or for another user. A failure names its reason and, for a status,
 * the status, and never the token, the groups or the object.
 */
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { isTlsFailureCode } from "@/lib/db/http/node-transport";
import { accessReviewApiUrl, accessReviewCaPath, accessReviewTokenPath } from "./config";

/** The person a review asks about: the identity provider subject and the groups its ID token named. */
export interface ReviewSubject {
  readonly user: string;
  readonly groups: readonly string[];
}

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
  | "malformed";

export type ReviewOutcome =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied" }
  | { readonly kind: "failed"; readonly reason: ReviewFailureReason; readonly status?: number };

/** How long one review may take, connection included. */
const REVIEW_TIMEOUT_MS = 2000;
/** A review's answer is a few hundred bytes; anything this large is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const REVIEW_PATH = "/apis/authorization.k8s.io/v1/subjectaccessreviews";

const ALLOWED: ReviewOutcome = Object.freeze({ kind: "allowed" });
const DENIED: ReviewOutcome = Object.freeze({ kind: "denied" });

function failed(reason: ReviewFailureReason, status?: number): ReviewOutcome {
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
interface RawAnswer {
  readonly status: number;
  readonly text: string;
}

/** Why a request failed on the way: the deadline, TLS, or the network. */
function transportFailure(error: unknown, signal: AbortSignal): ReviewOutcome {
  if (signal.aborted) return failed("timeout");
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return failed(typeof code === "string" && isTlsFailureCode(code) ? "tls" : "network");
}

/** POSTs the review body and collects the answer, up to the size cap and the deadline. */
function post(url: URL, token: string, ca: string, body: string, timeoutMs: number): Promise<RawAnswer | ReviewOutcome> {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: RawAnswer | ReviewOutcome) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const outgoing = request(
        {
          method: "POST",
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port === "" ? 443 : Number(url.port),
          // A URL with no path still has the pathname "/", which the review path must not follow.
          path: `${url.pathname.replace(/\/+$/, "")}${REVIEW_PATH}`,
          ca,
          signal,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
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

/** The decision a raw answer carries, for the review that asked about `user`. */
function judge(answer: RawAnswer, user: string): ReviewOutcome {
  if (answer.status < 200 || answer.status > 299) return failed("status", answer.status);
  let document: unknown;
  try {
    document = JSON.parse(answer.text);
  } catch {
    return failed("malformed");
  }
  if (!isRecord(document) || document.kind !== "SubjectAccessReview") return failed("malformed");
  const { spec, status } = document;
  if (!isRecord(spec) || spec.user !== user) return failed("malformed");
  if (!isRecord(status) || typeof status.allowed !== "boolean") return failed("malformed");
  return status.allowed && status.denied !== true ? ALLOWED : DENIED;
}

/**
 * Asks the Kubernetes API whether `subject` may do what `attributes` name. Never throws: every failure is an outcome.
 * `timeoutMs` is a test seam; production keeps the two-second deadline.
 */
export async function requestAccessReview(
  subject: ReviewSubject,
  attributes: ResourceAttributes,
  options: { readonly timeoutMs?: number } = {},
): Promise<ReviewOutcome> {
  if (subject.user === "") return failed("config");
  let url: URL;
  try {
    url = accessReviewApiUrl();
  } catch {
    return failed("config");
  }
  const token = (await readText(accessReviewTokenPath()))?.trim();
  if (!token) return failed("token");
  const ca = await readText(accessReviewCaPath());
  if (ca === null) return failed("ca");

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
  const answer = await post(url, token, ca, body, options.timeoutMs ?? REVIEW_TIMEOUT_MS);
  return "kind" in answer ? answer : judge(answer, subject.user);
}
