/**
 * The OAuth 2.0 authorization code flow with PKCE S256 and state, through openid-client: the authorize URL and the
 * code exchange. It holds no OpenShift fact of its own; the client id, the callback URL and the scope come from
 * config.ts and the metadata from metadata.ts.
 *
 * The exchange reads the client secret file at that moment (a projected token rotates), builds a Configuration for that
 * exchange only, sends the token request through `openShiftTokenFetch` (issuer origin only, no proxy), and passes
 * openid-client the public callback URL as the current URL, because it sends that URL, stripped of its query, as the
 * `redirect_uri`, and the request URL inside the pod is not the public one. No ID token is expected. The answer is
 * checked again here: a printable access token of at most 4096 characters, an expiry of 0 or more (0 counts as none),
 * and the granted scope exactly the pin; a refresh token or ID token is never copied. A failure is reduced to its
 * class: the error object is dropped, never logged, because openid-client and oauth4webapi errors can carry the
 * parsed response.
 */

import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  ClientSecretPost,
  Configuration,
  customFetch,
  randomPKCECodeVerifier,
  randomState,
} from "openid-client";
import {
  OPENSHIFT_SCOPE,
  openShiftCallbackUrl,
  openShiftClientId,
  openShiftTokenFilePath,
} from "@/lib/openshift-auth/config";
import { readTokenFile } from "@/lib/openshift-auth/files";
import { OpenShiftCallError, openShiftTokenFetch } from "@/lib/openshift-auth/http";
import type { OpenShiftServerMetadata } from "@/lib/openshift-auth/metadata";
import type { OpenShiftState } from "@/lib/openshift-auth/state";

export type ExchangeOutcome =
  | { kind: "token"; accessToken: string; expiresIn: number | null }
  | { kind: "scope"; granted: "narrower" | "wider" | "other" }
  | { kind: "failed"; reason: "config" | "ca" | "unreachable" | "rejected" | "malformed" };

const ACCESS_TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const PINNED_SCOPES = OPENSHIFT_SCOPE.split(" ");

/** The authorize URL and the state the callback needs; openid-client adds `client_id` and `response_type=code`. */
export async function openShiftAuthorizationUrl(
  metadata: OpenShiftServerMetadata,
  returnTo: string | null,
): Promise<{ url: URL; state: OpenShiftState }> {
  const codeVerifier = randomPKCECodeVerifier();
  const state = randomState();
  const url = buildAuthorizationUrl(new Configuration(metadata, openShiftClientId()), {
    redirect_uri: openShiftCallbackUrl(),
    scope: OPENSHIFT_SCOPE,
    code_challenge: await calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
  });
  return { url, state: { code_verifier: codeVerifier, state, ...(returnTo === null ? {} : { return_to: returnTo }) } };
}

/**
 * True for no scope (RFC 6749 section 5.1: the requested one) or a string of exactly the two pinned scopes, each once,
 * split on single spaces in any order; an empty token from a doubled space is refused.
 */
export function grantedScopeAccepted(scope: unknown): boolean {
  if (scope === undefined) return true;
  if (typeof scope !== "string") return false;
  const tokens = scope.split(" ");
  return tokens.length === PINNED_SCOPES.length && PINNED_SCOPES.every((pinned) => tokens.includes(pinned));
}

/**
 * How a refused granted scope differs from the pin: a strict subset (the empty scope included), a strict superset, or
 * neither; a scope with an empty or a repeated token is neither.
 */
function grantedClass(scope: string): "narrower" | "wider" | "other" {
  const tokens = scope === "" ? [] : scope.split(" ");
  const granted = new Set(tokens);
  if (tokens.includes("") || granted.size < tokens.length) return "other";
  if (tokens.every((token) => PINNED_SCOPES.includes(token))) return "narrower";
  return PINNED_SCOPES.every((pinned) => granted.has(pinned)) ? "wider" : "other";
}

function failed(reason: "config" | "ca" | "unreachable" | "rejected" | "malformed"): ExchangeOutcome {
  return { kind: "failed", reason };
}

/** The status an openid-client error carries, on itself (an error body) or on its cause (an unexpected response). */
function statusOf(error: unknown): number | undefined {
  for (const candidate of [error, (error as { cause?: unknown }).cause]) {
    const status = (candidate as { status?: unknown } | undefined)?.status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/**
 * A failed exchange reduced to its class: a CA file the call trusts that cannot be read is ca, transport, 3xx or 5xx
 * unreachable, 4xx rejected, anything else malformed.
 */
function failureOf(error: unknown): ExchangeOutcome {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof OpenShiftCallError) return failed(cause.reason === "ca" ? "ca" : "unreachable");
  const status = statusOf(error);
  if (status === undefined || (status >= 200 && status <= 299)) return failed("malformed");
  return failed(status >= 400 && status <= 499 ? "rejected" : "unreachable");
}

/** Exchanges the callback's code for the user's access token. Never throws for a cluster answer: every one is an outcome. */
export async function exchangeOpenShiftCode(
  metadata: OpenShiftServerMetadata,
  callbackParams: URLSearchParams,
  state: OpenShiftState,
): Promise<ExchangeOutcome> {
  let secret: string | null;
  try {
    secret = readTokenFile(openShiftTokenFilePath());
  } catch {
    return failed("config");
  }
  if (secret === null) return failed("config");
  const config = new Configuration(
    metadata,
    openShiftClientId(),
    { token_endpoint_auth_method: "client_secret_post" },
    ClientSecretPost(secret),
  );
  config[customFetch] = openShiftTokenFetch(new URL(metadata.issuer).origin);
  const currentUrl = new URL(openShiftCallbackUrl());
  for (const [name, value] of callbackParams) currentUrl.searchParams.append(name, value);
  let answer: Awaited<ReturnType<typeof authorizationCodeGrant>>;
  try {
    answer = await authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: state.code_verifier,
      expectedState: state.state,
    });
  } catch (error) {
    return failureOf(error);
  }
  if (!ACCESS_TOKEN_PATTERN.test(answer.access_token)) return failed("malformed");
  if (!grantedScopeAccepted(answer.scope)) return { kind: "scope", granted: grantedClass(answer.scope as string) };
  // openid-client has refused an expiry that is not a number of 0 or more; 0 counts as no expiry of its own.
  const expiresIn = answer.expires_in === undefined ? null : Math.floor(answer.expires_in) || null;
  return { kind: "token", accessToken: answer.access_token, expiresIn };
}
