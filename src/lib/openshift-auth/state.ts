/**
 * The `openshift-state` cookie: the PKCE verifier, the state value and the return path of one sign-in, between the
 * login route and the callback. HS256 under a key derived for this purpose only (never the session key, never the
 * OIDC state key), its own header `typ`, five minutes; no nonce, because this flow has no ID token. The cookie path is
 * the narrowest that reaches the callback, `<basePath>/api/auth/openshift`.
 */

import { jwtVerify, SignJWT } from "jose";
import { derivedSigningKey } from "@/lib/config/auth-env";
import { withBasePath } from "@/lib/config/base-path";

export const OPENSHIFT_STATE_COOKIE = "openshift-state";

export interface OpenShiftState {
  code_verifier: string;
  state: string;
  return_to?: string;
}

const STATE_KEY_LABEL = "libredb.openshift.state.v1";
const STATE_TOKEN_TYPE = "libredb-openshift-state+jwt";
const STATE_SECRET_MISSING_MESSAGE = "JWT_SECRET is required for the OpenShift sign-in state";
const STATE_SHAPE_MESSAGE = "The OpenShift sign-in state has no verifier or state value";

/** No development fallback: the state is never signed with a key derived from a well-known secret. */
function stateSigningKey(): Promise<Uint8Array> {
  return derivedSigningKey(STATE_KEY_LABEL, { allowDevFallback: false, missingMessage: STATE_SECRET_MISSING_MESSAGE });
}

export async function encryptOpenShiftState(data: OpenShiftState): Promise<string> {
  return await new SignJWT({ ...data })
    .setProtectedHeader({ alg: "HS256", typ: STATE_TOKEN_TYPE })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(await stateSigningKey());
}

export async function decryptOpenShiftState(token: string): Promise<OpenShiftState> {
  const { payload } = await jwtVerify(token, await stateSigningKey(), { algorithms: ["HS256"], typ: STATE_TOKEN_TYPE });
  if (typeof payload.code_verifier !== "string" || typeof payload.state !== "string") {
    throw new Error(STATE_SHAPE_MESSAGE);
  }
  return {
    code_verifier: payload.code_verifier,
    state: payload.state,
    ...(typeof payload.return_to === "string" ? { return_to: payload.return_to } : {}),
  };
}

/** The path the cookie is set and deleted with. */
export function openShiftStateCookiePath(): string {
  return withBasePath("/api/auth/openshift");
}
