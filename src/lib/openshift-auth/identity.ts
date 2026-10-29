/**
 * Who signed in: `GET /apis/user.openshift.io/v1/users/~` with the user's own access token as the bearer and no other
 * credential (OpenShift facts, beside config.ts).
 *
 * Fail closed: the session is keyed by the user's uid, so an answer without a usable uid (the virtual `kube:admin`)
 * signs nobody in, and neither does a name outside the bounds or a `system:` name. A 404 means the cluster signs in
 * through an external OIDC provider, where users/~ is not served. Groups and identities are never read: no role comes
 * from them, and nothing in this mode needs them.
 */

import { type OpenShiftCallFailureReason, openShiftApiCall } from "@/lib/openshift-auth/http";

export interface OpenShiftIdentity {
  readonly name: string;
  readonly uid: string;
}

export type IdentityReading =
  | { kind: "ok"; identity: OpenShiftIdentity }
  | { kind: "external-oidc" }
  | { kind: "unreachable"; reason: OpenShiftCallFailureReason | "status"; status?: number }
  | { kind: "no-uid"; name: string | null }
  | { kind: "failed"; status?: number };

const USER_PATH = "/apis/user.openshift.io/v1/users/~";
const USER_MAX_BYTES = 512 * 1024;
const MAX_NAME_BYTES = 512;
const MAX_UID_BYTES = 128;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** A non-empty string of at most `maxBytes` UTF-8 bytes with no control character, or null. */
function boundedText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value === "" || CONTROL_CHARACTER.test(value)) return null;
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : null;
}

export async function readOpenShiftIdentity(accessToken: string): Promise<IdentityReading> {
  const result = await openShiftApiCall({
    method: "GET",
    path: USER_PATH,
    bearer: accessToken,
    maxBytes: USER_MAX_BYTES,
  });
  if (result.kind === "failed") return { kind: "unreachable", reason: result.reason };
  const { status } = result;
  if (status === 404) return { kind: "external-oidc" };
  if (status >= 500) return { kind: "unreachable", reason: "status", status };
  if (status < 200 || status > 299) return { kind: "failed", status };
  let user: { kind?: unknown; metadata?: { name?: unknown; uid?: unknown } } | null;
  try {
    user = JSON.parse(result.body);
  } catch {
    return { kind: "failed", status };
  }
  if (typeof user !== "object" || user === null || user.kind !== "User") return { kind: "failed", status };
  const nameText = boundedText(user.metadata?.name, MAX_NAME_BYTES);
  const name = nameText?.startsWith("system:") ? null : nameText;
  const uid = boundedText(user.metadata?.uid, MAX_UID_BYTES);
  if (name === null || uid === null) return { kind: "no-uid", name };
  return { kind: "ok", identity: { name, uid } };
}
