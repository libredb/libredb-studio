/**
 * The role a fresh openshift sign-in gets: the seam the user's own Kubernetes review (a later change) fills in.
 *
 * Every session is `user` until then, the fail-closed state: no role ever comes from groups, a claim, a header or a
 * cookie field. `null` refuses the sign-in with `openshift_no_access`; nothing answers it yet, and the callback handles
 * it.
 */

import type { Role } from "@/lib/auth";
import type { OpenShiftIdentity } from "@/lib/openshift-auth/identity";

export const openShiftSignInRole: (identity: OpenShiftIdentity, accessToken: string) => Promise<Role | null> =
  async () => "user";
