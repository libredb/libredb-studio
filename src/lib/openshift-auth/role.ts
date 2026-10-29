/**
 * The role a fresh openshift sign-in gets: a fresh self review, made with the new access token alone, of `update` on
 * Studio's Deployment or its LibreDBStudio resource (src/lib/kubernetes-access/gate.ts, `selfReviewSignInRole`).
 *
 * Admin comes only from that review, never from groups, a claim, a header or a cookie field, so the identity is not
 * needed. `null` refuses the sign-in with `openshift_no_access`: the optional sign-in review
 * (KUBERNETES_ACCESS_REVIEW_SIGN_IN) does not allow it, or cannot be read. The callback handles it.
 */

import type { Role } from "@/lib/auth";
import { selfReviewSignInRole } from "@/lib/kubernetes-access/gate";
import type { OpenShiftIdentity } from "@/lib/openshift-auth/identity";

export const openShiftSignInRole: (identity: OpenShiftIdentity, accessToken: string) => Promise<Role | null> = (
  _identity,
  accessToken,
) => selfReviewSignInRole(accessToken);
