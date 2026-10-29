import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import {
  JOSEAlgNotAllowed,
  JOSENotSupported,
  JWKSMultipleMatchingKeys,
  JWKSNoMatchingKey,
  JWSInvalid,
  JWSSignatureVerificationFailed,
  JWTClaimValidationFailed,
  JWTExpired,
  JWTInvalid,
} from "jose/errors";
import type { UserPayload } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { authProvider } from "@/lib/config/auth-provider";
import { getOIDCConfig, mapOIDCRole } from "@/lib/oidc";
import { comparableIssuer, oidcUsername } from "@/lib/oidc-identity";

/**
 * The identity provider's access token as a session, for a native client that signs in to the provider itself
 * (Authorization Code with PKCE, a public client) and sends `Authorization: Bearer <token>` (docs/OIDC.md, "Bearer
 * access tokens for native clients").
 *
 * Opt-in: the channel exists only while OIDC_BEARER_AUDIENCE is set, under NEXT_PUBLIC_AUTH_PROVIDER=oidc. Unset, every
 * request answers `absent` and the `Authorization` header is ignored as it always was.
 *
 * A leaf module: src/proxy.ts calls it, and the proxy must not reach the governance state, the storage factory or `pg`
 * (tests/unit/governance-proxy-boundary.test.ts). getSession() (src/lib/auth.ts) calls it and then applies
 * storedAccountAllows(), which the proxy cannot. The proxy and the routes are separate module graphs, so each keeps its
 * own key cache.
 */

/** Why a bearer was refused. A refusal is the token's fault; a fault is the server's or the provider's. */
export type BearerDenialReason = "bearer_token_invalid" | "bearer_no_role" | "bearer_no_identity";

/**
 * A session an access token stands for. Its `iat` is the access token's own, not a moment Studio signed anything, so
 * a governance revocation is compared against it. `channel` is never signed: no cookie session carries it.
 */
export type BearerSession = UserPayload & {
  readonly idpSubject: string;
  readonly idpIssuer: string;
  readonly iat: number;
  readonly exp: number;
  readonly channel: "bearer";
};

export type BearerAuthentication =
  | { readonly kind: "absent" }
  | { readonly kind: "authenticated"; readonly session: BearerSession }
  | { readonly kind: "denied"; readonly reason: BearerDenialReason }
  | { readonly kind: "fault"; readonly error: unknown };

const BEARER_NEEDS_OIDC_MESSAGE =
  "OIDC_BEARER_AUDIENCE is set, but bearer access tokens need NEXT_PUBLIC_AUTH_PROVIDER=oidc";
const BEARER_AUDIENCE_IS_CLIENT_MESSAGE =
  "OIDC_BEARER_AUDIENCE must not equal OIDC_CLIENT_ID: every ID token Studio's web sign-in receives names that audience";
const DISCOVERY_FAILED_MESSAGE = "The identity provider's discovery document could not be read: HTTP ";
const DISCOVERY_NO_JWKS_MESSAGE = "The identity provider's discovery document names no usable jwks_uri";

/** Asymmetric signatures only: `none` and every HS* algorithm are refused before any key is fetched. */
const ACCEPTED_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

/** The `typ` headers of an access token: none, plain JWT, or RFC 9068's at+jwt. Compared in lower case. */
const ACCEPTED_TYPES = new Set(["jwt", "at+jwt", "application/at+jwt"]);

/** Claims only an ID token carries. A token holding one is not an access token, whatever its audience. */
const ID_TOKEN_CLAIMS = ["nonce", "at_hash", "c_hash"];

const CLOCK_TOLERANCE_SECONDS = 30;
const PROVIDER_TIMEOUT_MS = 5_000;
/** After a successful key fetch, an unknown kid waits this long before the key set is fetched again. */
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_MAX_AGE_MS = 10 * 60_000;

/** What jose throws for the token itself. Anything else, a timeout, a network or a key set error, is a fault. */
const TOKEN_ERRORS = [
  JOSEAlgNotAllowed,
  JOSENotSupported,
  JWKSMultipleMatchingKeys,
  JWKSNoMatchingKey,
  JWSInvalid,
  JWSSignatureVerificationFailed,
  JWTClaimValidationFailed,
  JWTExpired,
  JWTInvalid,
];

type KeySet = ReturnType<typeof createRemoteJWKSet>;

/** The key set of each issuer, from its discovery document. A failed discovery is not kept, so the next request retries. */
const keySets = new Map<string, Promise<KeySet>>();

/** Test seam: forgets every discovered key set. */
export function resetBearerKeys(): void {
  keySets.clear();
}

/** The token of an `Authorization: Bearer` header, or null for any other scheme, an empty token or no header. */
export function bearerTokenFrom(authorization: string | null): string | null {
  const match = /^bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return match === null ? null : match[1];
}

/**
 * OIDC_BEARER_AUDIENCE, or null while the channel is off. Read on every request, like getOIDCConfig(), because the
 * boot preflight does not run when Studio is embedded.
 */
export function readBearerAudience(): string | null {
  const audience = process.env.OIDC_BEARER_AUDIENCE?.trim();
  if (!audience) return null;
  if (authProvider() !== "oidc") throw new AuthConfigError(BEARER_NEEDS_OIDC_MESSAGE);
  if (audience === process.env.OIDC_CLIENT_ID?.trim()) throw new AuthConfigError(BEARER_AUDIENCE_IS_CLIENT_MESSAGE);
  return audience;
}

/** OIDC_BEARER_CLIENT_IDS as a list; empty when unset. */
function allowedClients(): string[] {
  return (process.env.OIDC_BEARER_CLIENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** A plain fetch of the discovery document, not discoverProvider(), which needs the web client's secret. */
async function discoverKeySet(issuer: string): Promise<KeySet> {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(DISCOVERY_FAILED_MESSAGE + response.status);
  const document = (await response.json()) as { jwks_uri?: unknown };
  const jwksUri = typeof document.jwks_uri === "string" ? URL.parse(document.jwks_uri) : null;
  if (jwksUri === null) throw new Error(DISCOVERY_NO_JWKS_MESSAGE);
  return createRemoteJWKSet(jwksUri, {
    timeoutDuration: PROVIDER_TIMEOUT_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    cacheMaxAge: JWKS_MAX_AGE_MS,
  });
}

function keySetFor(issuer: string): Promise<KeySet> {
  let keySet = keySets.get(issuer);
  if (keySet === undefined) {
    keySet = discoverKeySet(issuer);
    keySets.set(issuer, keySet);
    keySet.catch(() => keySets.delete(issuer));
  }
  return keySet;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The checks jwtVerify does not make. Null when the token passes them. */
function accessTokenRefusal(
  payload: JWTPayload,
  issuer: string,
  clientId: string,
  clients: string[],
): BearerDenialReason | null {
  const tokenIssuer = typeof payload.iss === "string" ? comparableIssuer(payload.iss) : null;
  if (tokenIssuer === null || tokenIssuer !== comparableIssuer(issuer)) return "bearer_token_invalid";
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (audiences.includes(clientId)) return "bearer_token_invalid";
  if (ID_TOKEN_CLAIMS.some((claim) => claim in payload) || payload.typ === "ID") return "bearer_token_invalid";
  const client = nonEmptyString(payload.azp) ?? nonEmptyString(payload.client_id);
  if (clients.length > 0 && (client === null || !clients.includes(client))) return "bearer_token_invalid";
  return null;
}

async function verify(token: string, audience: string): Promise<BearerAuthentication> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { kind: "denied", reason: "bearer_token_invalid" };
  }
  if (!ACCEPTED_ALGORITHMS.includes(header.alg ?? "")) return { kind: "denied", reason: "bearer_token_invalid" };
  if (header.typ !== undefined && !ACCEPTED_TYPES.has(header.typ.toLowerCase())) {
    return { kind: "denied", reason: "bearer_token_invalid" };
  }

  const config = getOIDCConfig();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, await keySetFor(config.issuer), {
      algorithms: ACCEPTED_ALGORITHMS,
      audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["iat", "exp"],
    }));
  } catch (error) {
    if (TOKEN_ERRORS.some((kind) => error instanceof kind)) return { kind: "denied", reason: "bearer_token_invalid" };
    throw error;
  }

  const refusal = accessTokenRefusal(payload, config.issuer, config.clientId, allowedClients());
  if (refusal !== null) return { kind: "denied", reason: refusal };

  // The callback's identity, without its last fallback to `sub`: `username` keys the user's server storage, rate limit
  // and audit lines, so a token that names the person differently would open a second, empty workspace.
  const subject = nonEmptyString(payload.sub);
  const username = oidcUsername(payload);
  if (subject === null || username === null) return { kind: "denied", reason: "bearer_no_identity" };

  const role = mapOIDCRole(payload, config.roleClaim, config.adminRoles, config.userRoles);
  if (role === null) return { kind: "denied", reason: "bearer_no_role" };

  return {
    kind: "authenticated",
    session: {
      role,
      username,
      idpSubject: subject,
      idpIssuer: payload.iss as string,
      iat: payload.iat as number,
      exp: payload.exp as number,
      channel: "bearer",
    },
  };
}

/**
 * The session an `Authorization` header stands for. `absent` leaves the request to the cookie: no Bearer header, or
 * the channel is off. A configuration error or a provider that cannot be reached is a `fault`, never a refusal, so a
 * client does not throw away a good token while the provider is down.
 */
export async function authenticateBearer(authorization: string | null): Promise<BearerAuthentication> {
  const token = bearerTokenFrom(authorization);
  if (token === null) return { kind: "absent" };
  try {
    const audience = readBearerAudience();
    if (audience === null) return { kind: "absent" };
    return await verify(token, audience);
  } catch (error) {
    return { kind: "fault", error };
  }
}
