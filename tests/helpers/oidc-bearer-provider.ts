/**
 * A stub identity provider for the OIDC bearer channel (src/lib/oidc-bearer.ts): a fetch that serves a discovery
 * document and a key set made here, the environment that turns the channel on, and Keycloak-shaped access tokens.
 */
import { spyOn } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWSHeaderParameters, type JWTPayload } from "jose";

export const BEARER_ISSUER = "https://idp.example.test/realms/libredb";
export const BEARER_JWKS_URI = `${BEARER_ISSUER}/protocol/openid-connect/certs`;
export const BEARER_AUDIENCE = "libredb-studio-api";
export const WEB_CLIENT = "libredb-studio-web";
export const NATIVE_CLIENT = "libredb-mobile";
export const BEARER_SUBJECT = "f3b0c7d2-0000-4000-8000-000000000001";

export const BEARER_ENV_KEYS = [
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_ROLE_CLAIM",
  "OIDC_ADMIN_ROLES",
  "OIDC_USER_ROLES",
  "OIDC_BEARER_AUDIENCE",
  "OIDC_BEARER_CLIENT_IDS",
] as const;

export const signer = await generateKeyPair("RS256");
export const rotated = await generateKeyPair("RS256");
export const stranger = await generateKeyPair("RS256");
export const signerJwk = { ...(await exportJWK(signer.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
export const rotatedJwk = { ...(await exportJWK(rotated.publicKey)), kid: "k2", alg: "RS256", use: "sig" };

/** What the stubbed provider serves: its keys, and whether it answers at all. */
export const provider = { keys: [signerJwk] as object[], down: false, discoveryCalls: 0, jwksCalls: 0 };

/** Stubs the global fetch for the provider's two URLs; every other URL answers 404. Restore it in afterAll. */
export function stubIdentityProvider() {
  return spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (provider.down) throw new TypeError("fetch failed");
    if (url === `${BEARER_ISSUER}/.well-known/openid-configuration`) {
      provider.discoveryCalls += 1;
      return Response.json({ issuer: BEARER_ISSUER, jwks_uri: BEARER_JWKS_URI });
    }
    if (url === BEARER_JWKS_URI) {
      provider.jwksCalls += 1;
      return Response.json({ keys: provider.keys });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch);
}

const savedEnv: Record<string, string | undefined> = {};

/** Turns the channel on under OIDC, with Keycloak's realm roles, and resets the provider. Undo with restoreBearerEnv. */
export function useBearerEnv(): void {
  for (const key of BEARER_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
  process.env.OIDC_ISSUER = BEARER_ISSUER;
  process.env.OIDC_CLIENT_ID = WEB_CLIENT;
  process.env.OIDC_CLIENT_SECRET = "web-client-secret";
  process.env.OIDC_ROLE_CLAIM = "realm_access.roles";
  process.env.OIDC_ADMIN_ROLES = "admin";
  delete process.env.OIDC_USER_ROLES;
  process.env.OIDC_BEARER_AUDIENCE = BEARER_AUDIENCE;
  delete process.env.OIDC_BEARER_CLIENT_IDS;
  provider.keys = [signerJwk];
  provider.down = false;
  provider.discoveryCalls = 0;
  provider.jwksCalls = 0;
}

export function restoreBearerEnv(): void {
  for (const key of BEARER_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A Keycloak-shaped access token for the native client, with `overrides` merged over its claims. */
export function bearerClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: BEARER_ISSUER,
    aud: [BEARER_AUDIENCE, "account"],
    sub: BEARER_SUBJECT,
    azp: NATIVE_CLIENT,
    typ: "Bearer",
    email: "ada@example.test",
    preferred_username: "ada",
    realm_access: { roles: ["user"] },
    iat: nowSeconds() - 5,
    exp: nowSeconds() + 300,
    ...overrides,
  };
}

export async function signBearer(
  payload: JWTPayload = bearerClaims(),
  header: Partial<JWSHeaderParameters> = {},
  key: CryptoKey = signer.privateKey,
): Promise<string> {
  return await new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "k1", typ: "JWT", ...header }).sign(key);
}
