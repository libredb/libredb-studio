/**
 * Whether the cluster the ServiceAccount review asks is OpenShift: its API server serves config.openshift.io/v1.
 *
 * There a SubjectAccessReview made as Studio's ServiceAccount cannot assert the cluster's user name for an OIDC
 * subject, so the ServiceAccount backend (review.ts) refuses every review on such a cluster with `platform`, and
 * openshift sign-in, whose self review asks with the user's own token, is the way to run the review there.
 *
 * Asked before the first ServiceAccount review of a process, with that review's URL, pod token and CA through the same
 * transport, one request at a time: every review that needs the verdict while it is asked waits for that one answer.
 * 200 is OpenShift and is kept for the process lifetime. 404 is not, and stands for five minutes, after which the next
 * review asks again, so one 404 from an API server that did not serve the group yet cannot let ServiceAccount reviews
 * run on OpenShift for the rest of the process. Both are kept on `globalThis`, since each Next.js route bundle has its
 * own module copy. Every other outcome (a 403 included, the deadline, a TLS or network failure) is returned to every
 * review that waited for it as the failure it is and kept nowhere, so those reviews are denied and the next one asks
 * again. Vanilla Kubernetes and Rancher answer 404 to an authenticated identity, so nothing changes there.
 */
import { type FailedReview, serviceAccountCall } from "./review";

/** Labels of their own, never a connection type id, so no reader takes them for an engine branch. */
export type PlatformVerdict = "openshift-cluster" | "plain-kubernetes";

type PlatformAnswer = PlatformVerdict | FailedReview;

const STATE_KEY = Symbol.for("libredb-studio.kubernetes-access-platform");
const PLATFORM_PATH = "/apis/config.openshift.io/v1";
/** The deadline when none is given, as the review's. */
const PLATFORM_TIMEOUT_MS = 2000;
/** How long a plain-kubernetes verdict stands before the next review asks again. */
const PLAIN_KUBERNETES_RECHECK_MS = 5 * 60 * 1000;

/** What the process knows: the last verdict, when a plain-kubernetes one is asked again, and the check in flight. */
interface PlatformState {
  verdict?: PlatformVerdict;
  recheckAt: number;
  inFlight?: Promise<PlatformAnswer>;
}

type StateHolder = { [STATE_KEY]?: PlatformState };

function platformState(): PlatformState {
  const holder = globalThis as StateHolder;
  holder[STATE_KEY] ??= { recheckAt: 0 };
  return holder[STATE_KEY];
}

/** One GET of the group: 200 is openshift-cluster, 404 plain-kubernetes, and anything else the failure it is. */
async function askPlatform(url: URL, token: string, ca: string, timeoutMs: number): Promise<PlatformAnswer> {
  const answer = await serviceAccountCall({ url, method: "GET", path: PLATFORM_PATH, token, ca, timeoutMs });
  if ("kind" in answer) return answer;
  if (answer.status === 200) return "openshift-cluster";
  if (answer.status === 404) return "plain-kubernetes";
  return { kind: "failed", reason: "status", status: answer.status };
}

/** Whether the API server at `url` serves config.openshift.io/v1, asked with the ServiceAccount token. */
export function clusterPlatform(
  url: URL,
  token: string,
  ca: string,
  timeoutMs = PLATFORM_TIMEOUT_MS,
): Promise<PlatformAnswer> {
  const known = platformState();
  if (known.verdict === "openshift-cluster") return Promise.resolve(known.verdict);
  if (known.verdict === "plain-kubernetes" && Date.now() < known.recheckAt) return Promise.resolve(known.verdict);
  known.inFlight ??= askPlatform(url, token, ca, timeoutMs).then((answer) => {
    known.inFlight = undefined;
    if (typeof answer === "string") {
      known.verdict = answer;
      known.recheckAt = Date.now() + PLAIN_KUBERNETES_RECHECK_MS;
    }
    return answer;
  });
  return known.inFlight;
}

/** Test seam: forgets the verdict and any check in flight, as a restart does. */
export function resetPlatformCheck(): void {
  delete (globalThis as StateHolder)[STATE_KEY];
}
