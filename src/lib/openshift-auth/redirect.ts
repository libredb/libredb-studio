/**
 * Where openshift sign-in redirects: a refused sign-in to the login page with the reason code, and a signed-out visit
 * of the login page to the OpenShift login route, both under OPENSHIFT_PUBLIC_URL. Never built from `Host`,
 * `X-Forwarded-Host` or the request URL, which a client controls. When the public URL itself does not read, the
 * proxy does not redirect and the login page renders; a route handler sends the login page's path under the base path,
 * so the page still shows the configuration message.
 */

import { getBasePath } from "@/lib/config/base-path";
import { openShiftPublicUrl } from "@/lib/openshift-auth/config";

/** The reason codes of openshift sign-in: the login page's `?error=` and the audit `login_failure` reason. */
export type OpenShiftSignInCode =
  | "openshift_config"
  | "openshift_unreachable"
  | "openshift_external_oidc"
  | "openshift_state_missing"
  | "openshift_state_invalid"
  | "openshift_denied"
  | "openshift_scope"
  | "openshift_no_uid"
  | "openshift_no_access"
  | "openshift_failed"
  | "openshift_session_lost";

/**
 * `path`, already under the base path, at OPENSHIFT_PUBLIC_URL's origin; null when it does not read, never a relative
 * path, because the proxy's Location is parsed with no base and a relative one fails the request.
 */
export function openShiftPublicLocation(path: string): string | null {
  try {
    return `${openShiftPublicUrl().origin}${path}`;
  } catch {
    return null;
  }
}

/** A route handler's answer: the path alone when the public URL does not read, so the page shows the code's message. */
export function openShiftLoginPageLocation(code: OpenShiftSignInCode): string {
  const path = `${getBasePath()}/login?error=${code}`;
  return openShiftPublicLocation(path) ?? path;
}
