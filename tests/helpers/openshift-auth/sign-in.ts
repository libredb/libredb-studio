/**
 * Drives openshift sign-in through the real routes against the fake cluster: the login route sets the state cookie in
 * the jar, the person approves on the cluster (FakeCluster.authorize), and the callback receives the code and state.
 */
import type { FakeCluster } from "./fake-cluster";

type Handler = (request: Request) => Promise<Response>;

export const STUDIO = "http://localhost:3000";
export const CALLBACK_PATH = "/api/auth/openshift/callback";

/** Runs the login route and the person's approval; the state cookie stays in the jar for the callback. */
export async function approvedSignIn(
  loginGet: Handler,
  cluster: FakeCluster,
  query = "",
): Promise<{ authorizeUrl: URL; params: URLSearchParams }> {
  const res = await loginGet(new Request(`${STUDIO}/api/auth/openshift/login${query}`));
  const authorizeUrl = new URL(res.headers.get("location") ?? "");
  return { authorizeUrl, params: cluster.authorize(authorizeUrl) };
}

/** The callback request a browser sends with `params`. */
export function callbackRequest(params: URLSearchParams | string, path = CALLBACK_PATH): Request {
  return new Request(`${STUDIO}${path}?${params.toString()}`);
}
