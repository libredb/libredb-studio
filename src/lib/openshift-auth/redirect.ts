/**
 * Where a refused openshift sign-in lands: the login page with the reason code, under OPENSHIFT_PUBLIC_URL. Never built
 * from `Host`, `X-Forwarded-Host` or the request URL, which a client controls; when the public URL itself does not
 * read, the path under the base path, so the page still shows the configuration message.
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

export function openShiftLoginPageLocation(code: OpenShiftSignInCode): string {
  const path = `${getBasePath()}/login?error=${code}`;
  try {
    return `${openShiftPublicUrl().origin}${path}`;
  } catch {
    return path;
  }
}
