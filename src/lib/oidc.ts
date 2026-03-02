import * as client from 'openid-client';
import { SignJWT, jwtVerify } from 'jose';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OIDCConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  roleClaim: string;
  adminRoles: string[];
}

export interface OIDCState {
  code_verifier: string;
  state: string;
  nonce: string;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export function getOIDCConfig(): OIDCConfig {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;

  if (!issuer || !clientId || !clientSecret) {
    throw new Error(
      'OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET are required when using OIDC authentication'
    );
  }

  return {
    issuer,
    clientId,
    clientSecret,
    scope: process.env.OIDC_SCOPE || 'openid profile email',
    roleClaim: process.env.OIDC_ROLE_CLAIM || '',
    adminRoles: (process.env.OIDC_ADMIN_ROLES || 'admin')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
  };
}

// ─── Discovery (cached) ────────────────────────────────────────────────────

let cachedConfig: client.Configuration | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function discoverProvider(
  oidcConfig?: OIDCConfig
): Promise<client.Configuration> {
  const now = Date.now();
  if (cachedConfig && now < cacheExpiry) {
    return cachedConfig;
  }

  const config = oidcConfig || getOIDCConfig();
  const discovered = await client.discovery(
    new URL(config.issuer),
    config.clientId,
    config.clientSecret,
    client.ClientSecretPost(config.clientSecret)
  );

  cachedConfig = discovered;
  cacheExpiry = now + CACHE_TTL;
  return discovered;
}

/** Reset discovery cache (for testing) */
export function resetDiscoveryCache(): void {
  cachedConfig = null;
  cacheExpiry = 0;
}

// ─── Authorization URL ─────────────────────────────────────────────────────

export async function generateAuthUrl(
  config: client.Configuration,
  redirectUri: string,
  scope: string
): Promise<{ url: URL; state: OIDCState }> {
  const code_verifier = client.randomPKCECodeVerifier();
  const code_challenge = await client.calculatePKCECodeChallenge(code_verifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const parameters: Record<string, string> = {
    redirect_uri: redirectUri,
    scope,
    code_challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    prompt: 'login',
  };

  const url = client.buildAuthorizationUrl(config, parameters);

  return {
    url,
    state: { code_verifier, state, nonce },
  };
}

// ─── Token Exchange ────────────────────────────────────────────────────────

export interface OIDCClaims {
  sub: string;
  email?: string;
  preferred_username?: string;
  [claim: string]: unknown;
}

export async function exchangeCode(
  config: client.Configuration,
  callbackUrl: URL,
  codeVerifier: string,
  expectedState: string,
  expectedNonce: string
): Promise<OIDCClaims | null> {
  const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState,
    expectedNonce,
    idTokenExpected: true,
  });

  const claims = tokens.claims();
  if (!claims) return null;

  return claims as unknown as OIDCClaims;
}

// ─── Role Mapping ──────────────────────────────────────────────────────────

/**
 * Extract role from OIDC claims using configured claim path.
 * Supports dot-notation for nested claims (e.g. "realm_access.roles").
 * Returns 'admin' if any claim value matches OIDC_ADMIN_ROLES, otherwise 'user'.
 */
export function mapOIDCRole(
  claims: Record<string, unknown>,
  roleClaim: string,
  adminRoles: string[]
): 'admin' | 'user' {
  if (!roleClaim) return 'user';

  // Navigate dot-notation path
  const parts = roleClaim.split('.');
  let value: unknown = claims;
  for (const part of parts) {
    if (value == null || typeof value !== 'object') return 'user';
    value = (value as Record<string, unknown>)[part];
  }

  if (value == null) return 'user';

  // Normalize to array of strings
  const values: string[] = Array.isArray(value)
    ? value.map(String)
    : [String(value)];

  // Check if any value matches admin roles
  const isAdmin = values.some((v) =>
    adminRoles.some((ar) => v.toLowerCase() === ar.toLowerCase())
  );

  return isAdmin ? 'admin' : 'user';
}

// ─── State Cookie Encryption ───────────────────────────────────────────────

function getStateSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required for OIDC state encryption');
  }
  return new TextEncoder().encode(secret);
}

export async function encryptState(data: OIDCState): Promise<string> {
  return await new SignJWT({ ...data })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(getStateSecret());
}

export async function decryptState(token: string): Promise<OIDCState> {
  const { payload } = await jwtVerify(token, getStateSecret());
  return {
    code_verifier: payload.code_verifier as string,
    state: payload.state as string,
    nonce: payload.nonce as string,
  };
}

// ─── Public Origin (reverse proxy / PaaS) ──────────────────────────────────

/**
 * Derive the public-facing origin from request headers.
 * On platforms like Render, Railway, Fly.io the app binds to 0.0.0.0:PORT
 * but the actual public URL comes from x-forwarded-host/x-forwarded-proto.
 */
export function getPublicOrigin(request: Request): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto') || 'https';
  const host = forwardedHost || request.headers.get('host');
  if (host) {
    return `${forwardedProto}://${host}`;
  }
  return new URL(request.url).origin;
}

// ─── Logout URL ─────────────────────────────────────────────────────────────

/**
 * Build the OIDC provider's logout URL.
 * Auth0: /v2/logout?client_id=...&returnTo=...
 * Generic: /protocol/openid-connect/logout?post_logout_redirect_uri=...&client_id=...
 */
export function buildLogoutUrl(returnTo: string): string | null {
  try {
    const config = getOIDCConfig();
    const issuerUrl = new URL(config.issuer);

    // Auth0 uses /v2/logout
    if (issuerUrl.hostname.includes('auth0.com')) {
      const logoutUrl = new URL('/v2/logout', config.issuer);
      logoutUrl.searchParams.set('client_id', config.clientId);
      logoutUrl.searchParams.set('returnTo', returnTo);
      return logoutUrl.toString();
    }

    // Generic OIDC (Keycloak, Okta, Azure AD, etc.) — RP-Initiated Logout
    const logoutUrl = new URL('/protocol/openid-connect/logout', config.issuer);
    logoutUrl.searchParams.set('client_id', config.clientId);
    logoutUrl.searchParams.set('post_logout_redirect_uri', returnTo);
    return logoutUrl.toString();
  } catch {
    return null;
  }
}
