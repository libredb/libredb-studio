/**
 * Whether the cluster the ServiceAccount review asks is OpenShift: its API server serves config.openshift.io/v1.
 *
 * There a SubjectAccessReview made as Studio's ServiceAccount cannot assert the cluster's user name for an OIDC
 * subject, so the ServiceAccount backend (review.ts) refuses every review on such a cluster with `platform`, and
 * openshift sign-in, whose self review asks with the user's own token, is the way to run the review there.
 *
 * Asked once per process, before the first ServiceAccount review, with that review's URL, pod token and CA through the
 * same transport. 200 is OpenShift and 404 is not; both are kept on `globalThis` for the process lifetime, since each
 * Next.js route bundle has its own module copy. Every other outcome (a 403 included, the deadline, a TLS or network
 * failure) is returned as the failure it is and kept nowhere, so the review it precedes is denied and the next one
 * asks again. Vanilla Kubernetes and Rancher answer 404 to an authenticated identity, so nothing changes there.
 */
import { type FailedReview, serviceAccountCall } from "./review";

export type PlatformVerdict = "openshift" | "kubernetes";

const VERDICT_KEY = Symbol.for("libredb-studio.kubernetes-access-platform");
const PLATFORM_PATH = "/apis/config.openshift.io/v1";
/** The deadline when none is given, as the review's. */
const PLATFORM_TIMEOUT_MS = 2000;

type VerdictHolder = { [VERDICT_KEY]?: PlatformVerdict };

/** Whether the API server at `url` serves config.openshift.io/v1, asked once per process with the ServiceAccount token. */
export async function clusterPlatform(
  url: URL,
  token: string,
  ca: string,
  timeoutMs = PLATFORM_TIMEOUT_MS,
): Promise<PlatformVerdict | FailedReview> {
  const holder = globalThis as VerdictHolder;
  const known = holder[VERDICT_KEY];
  if (known !== undefined) return known;
  const answer = await serviceAccountCall({ url, method: "GET", path: PLATFORM_PATH, token, ca, timeoutMs });
  if ("kind" in answer) return answer;
  if (answer.status !== 200 && answer.status !== 404) {
    return { kind: "failed", reason: "status", status: answer.status };
  }
  const verdict: PlatformVerdict = answer.status === 200 ? "openshift" : "kubernetes";
  holder[VERDICT_KEY] = verdict;
  return verdict;
}

/** Test seam: forgets the verdict, as a restart does. */
export function resetPlatformCheck(): void {
  delete (globalThis as VerdictHolder)[VERDICT_KEY];
}
