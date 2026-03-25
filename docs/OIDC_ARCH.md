# OIDC Architecture

> Developer reference for the OIDC authentication subsystem in LibreDB Studio.
> For user-facing setup instructions, see [OIDC_SETUP.md](./OIDC_SETUP.md).

---

## Table of Contents

- [Design Philosophy](#design-philosophy)
- [Module Map](#module-map)
- [Authentication Flows](#authentication-flows)
- [Module Deep Dive](#module-deep-dive)
- [State Management](#state-management)
- [Security Model](#security-model)
- [Role Mapping Engine](#role-mapping-engine)
- [Provider Logout Strategy](#provider-logout-strategy)
- [Error Handling](#error-handling)
- [Testing Architecture](#testing-architecture)
- [Extension Points](#extension-points)
- [Decision Log](#decision-log)

---

## Design Philosophy

The OIDC subsystem follows three core principles:

1. **Local JWT Session After OIDC** — After OIDC authentication, a standard `auth-token` JWT cookie is created (identical to local login). This means the proxy, `useAuth` hook, RBAC, and all protected routes are completely unaware of OIDC. Zero coupling.

2. **Vendor-Agnostic** — No provider-specific SDK (no `@auth0/nextjs-auth0`, no Keycloak adapter). Uses `openid-client` v6 which implements the OIDC spec generically. Provider differences are handled only in two places: role claim path and logout URL format.

3. **Single Switch** — `NEXT_PUBLIC_AUTH_PROVIDER=local|oidc` is the only toggle. The login page conditionally renders, the logout route conditionally returns a redirect URL, and everything else stays the same.

---

## Module Map

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Client)                         │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐    ┌────────────────────┐  │
│  │  login/page  │   │  use-auth.ts │    │  proxy.ts          │  │
│  │  (LoginForm) │   │  (hook)      │    │  (middleware)      │  │
│  └──────┬───────┘   └──────┬───────┘    └────────┬───────────┘  │
│         │                  │                     │              │
└─────────┼──────────────────┼─────────────────────┼──────────────┘
          │                  │                     │
          ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Next.js API Routes                          │
│                                                                 │
│  ┌──────────────────┐  ┌───────────────────┐   ┌─────────────┐  │
│  │ /api/auth/oidc/  │  │ /api/auth/oidc/   │   │ /api/auth/  │  │
│  │ login/route.ts   │  │ callback/route.ts │   │ logout/     │  │
│  │ (GET → redirect) │  │ (GET → exchange)  │   │ route.ts    │  │
│  └────────┬─────────┘  └────────┬──────────┘   └──────┬──────┘  │
│           │                     │                     │         │
│           └─────────┬───────────┘                     │         │
│                     ▼                                 ▼         │
│           ┌─────────────────┐              ┌──────────────────┐ │
│           │  src/lib/oidc.ts│              │  src/lib/auth.ts │ │
│           │  (OIDC module)  │──────────────│  (JWT sessions)  │ │
│           └────────┬────────┘              └──────────────────┘ │
│                    │                                            │
└────────────────────┼────────────────────────────────────────────┘
                     │
                     ▼
            ┌─────────────────┐
            │  OIDC Provider  │
            │  (Auth0, etc.)  │
            └─────────────────┘
```

### File Responsibilities

| File | Lines | Responsibility |
|------|-------|----------------|
| `src/lib/oidc.ts` | ~230 | Pure OIDC logic: config, discovery, PKCE, token exchange, role mapping, state crypto, logout URL |
| `src/lib/auth.ts` | ~72 | JWT session: `signJWT`, `verifyJWT`, `login`, `logout`, `getSession` — shared by both auth modes |
| `src/app/api/auth/oidc/login/route.ts` | ~43 | Login initiation: generate auth URL, set state cookie, redirect |
| `src/app/api/auth/oidc/callback/route.ts` | ~80 | Callback handler: validate state, exchange code, map role, create session |
| `src/app/api/auth/logout/route.ts` | ~21 | Logout: clear JWT cookie, optionally return OIDC provider logout URL |
| `src/app/login/page.tsx` | ~200 | Login UI: conditional SSO button vs email/password form |
| `src/hooks/use-auth.ts` | ~52 | Client hook: user state, `handleLogout` with OIDC redirect support |
| `src/proxy.ts` | ~92 | Middleware: JWT verification, RBAC, route protection (auth-mode agnostic) |

---

## Authentication Flows

### OIDC Login Flow (Authorization Code + PKCE)

```
 Browser                    Next.js Server                      OIDC Provider
    │                            │                                   │
    │  1. Click "Login with SSO" │                                   │
    │──────────────────────────► │                                   │
    │                            │                                   │
    │  2. GET /api/auth/oidc/login                                   │
    │                            │  3. discoverProvider()            │
    │                            │──────────────────────────────────►│
    │                            │◄─ /.well-known/openid-config   ───│
    │                            │                                   │
    │                            │  4. generateAuthUrl()             │
    │                            │     ├─ code_verifier (random)     │
    │                            │     ├─ code_challenge (S256 hash) │
    │                            │     ├─ state (random)             │
    │                            │     └─ nonce (random)             │
    │                            │                                   │
    │                            │  5. encryptState({                │
    │                            │       code_verifier, state, nonce │
    │                            │     }) → signed JWT cookie        │
    │                            │                                   │
    │  6. Set-Cookie: oidc-state │                                   │
    │◄── 302 → authorize_endpoint│                                   │
    │     ?client_id=xxx          │                                  │
    │     &redirect_uri=callback  │                                  │
    │     &code_challenge=xxx     │                                  │
    │     &state=xxx              │                                  │
    │     &nonce=xxx              │                                  │
    │     &prompt=login           │                                  │
    │                            │                                   │
    │  7. User authenticates     │                                   │
    │────────────────────────────────────────────────────────────►   │
    │◄─── 302 /api/auth/oidc/callback?code=xxx&state=xxx ─────────── │
    │                            │                                   │
    │  8. GET /api/auth/oidc/callback                                │
    │──────────────────────────► │                                   │
    │                            │  9. decryptState(cookie)          │
    │                            │     └─ extract code_verifier,     │
    │                            │        state, nonce               │
    │                            │                                   │
    │                            │ 10. Validate state matches        │
    │                            │                                   │
    │                            │ 11. exchangeCode()                │
    │                            │─────────────────────────────────► │
    │                            │◄── id_token + access_token ─────  │
    │                            │                                   │
    │                            │ 12. Extract claims from id_token  │
    │                            │ 13. mapOIDCRole(claims)           │
    │                            │     └─ admin or user              │
    │                            │                                   │
    │                            │ 14. login(role, email)            │
    │                            │     └─ signJWT → auth-token cookie│
    │                            │                                   │
    │                            │ 15. Delete oidc-state cookie      │
    │                            │                                   │
    │  16. Set-Cookie: auth-token│                                   │
    │◄── 302 → / or /admin ─────│                                    │
    │                            │                                   │
    ╞════════════════════════════════════════════════════════════════╡
    │  From here: identical to local password login                  │
    │  proxy.ts reads auth-token, useAuth reads /api/auth/me         │
    ╘════════════════════════════════════════════════════════════════╛
```

### OIDC Logout Flow

```
 Browser                    Next.js Server              OIDC Provider
    │                            │                           │
    │  1. handleLogout()          │                           │
    │     POST /api/auth/logout  │                           │
    │──────────────────────────► │                           │
    │                            │  2. logout()               │
    │                            │     └─ delete auth-token   │
    │                            │                           │
    │                            │  3. if OIDC mode:          │
    │                            │     buildLogoutUrl(returnTo)│
    │                            │                           │
    │  4. { success, redirectUrl }│                           │
    │◄───────────────────────────│                           │
    │                            │                           │
    │  5. window.location.href   │                           │
    │     = redirectUrl           │                           │
    │─────────────────────────────────────────────────────► │
    │                            │                           │
    │◄─── 302 → /login (returnTo) ─────────────────────────│
    │                            │                           │
```

### Local Login Flow (for comparison)

```
 Browser                    Next.js Server
    │                            │
    │  POST /api/auth/login       │
    │  { email, password }       │
    │──────────────────────────► │
    │                            │  validate credentials
    │                            │  login(role, email)
    │                            │  └─ signJWT → auth-token
    │  { success, role }         │
    │◄───────────────────────────│
    │                            │
    │  router.push(/ or /admin)  │
```

---

## Module Deep Dive

### `src/lib/oidc.ts`

The OIDC module is a pure utility library with no side effects. All functions are stateless except for the discovery cache.

#### Types

```typescript
interface OIDCConfig {
  issuer: string;          // e.g. "https://dev-xxx.auth0.com"
  clientId: string;
  clientSecret: string;
  scope: string;           // Default: "openid profile email"
  roleClaim: string;       // e.g. "realm_access.roles"
  adminRoles: string[];    // e.g. ["admin"]
}

interface OIDCState {
  code_verifier: string;   // PKCE random bytes (base64url)
  state: string;           // CSRF protection random
  nonce: string;           // Replay protection random
}

interface OIDCClaims {
  sub: string;             // Subject identifier
  email?: string;
  name?: string;
  [key: string]: unknown;  // Provider-specific claims
}
```

#### Function Dependency Graph

```
getOIDCConfig()                     ← reads env vars
    │
    ▼
discoverProvider(config?)           ← openid-client discovery + 5-min cache
    │
    ├──► generateAuthUrl(config, redirectUri, scope)
    │        └─ returns { url, state: OIDCState }
    │
    └──► exchangeCode(config, callbackUrl, codeVerifier, state, nonce)
             └─ returns OIDCClaims | null

mapOIDCRole(claims, roleClaim, adminRoles)   ← pure function, no deps

encryptState(data) / decryptState(token)     ← jose JWT sign/verify

buildLogoutUrl(returnTo)                     ← reads getOIDCConfig()
```

#### Discovery Cache

```typescript
// In-memory, module-level singleton
let cachedConfig: client.Configuration | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// discoverProvider() checks:
if (cachedConfig && Date.now() - cacheTimestamp < CACHE_TTL) {
  return cachedConfig; // Cache hit
}
// Otherwise: fetch /.well-known/openid-configuration

// resetDiscoveryCache() — exposed for testing
```

The cache prevents hitting the provider's discovery endpoint on every login. 5-minute TTL balances freshness with performance. The cache is process-level (shared across all requests in the same Next.js server instance).

### `src/lib/auth.ts`

The JWT session layer is completely auth-mode agnostic:

```typescript
// Same function called by both local login route and OIDC callback:
export async function login(role: Role, username?: string) {
  const token = await signJWT({ role, username: username || role });
  const cookieStore = await cookies();
  cookieStore.set('auth-token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 86400,     // 24 hours
    path: '/',
  });
}
```

The optional `username` parameter was added for OIDC — local login passes the email, OIDC callback passes `claims.email || claims.sub`.

### `src/proxy.ts`

The proxy (Next.js 16 middleware) has zero OIDC awareness:

```typescript
// Public routes — includes /api/auth/* which covers OIDC routes
const publicPaths = ['/api/auth', '/_next', '/favicon.ico', '/api/db/health'];

// All auth checks use the same auth-token JWT
const token = request.cookies.get('auth-token')?.value;
const payload = token ? await verifyJWT(token) : null;
```

OIDC routes (`/api/auth/oidc/login`, `/api/auth/oidc/callback`) are automatically public because they match the `/api/auth` prefix.

---

## State Management

### PKCE State Cookie

The OIDC login flow requires carrying three values from the login route to the callback route: `code_verifier`, `state`, and `nonce`. These are stored in a signed JWT cookie:

```
┌─────────────────────────────────────────────┐
│  Cookie: oidc-state                         │
│  Value: JWT (HS256 signed with JWT_SECRET)  │
│                                             │
│  Payload: {                                 │
│    code_verifier: "dBjftJeZ4CVP...",        │
│    state: "xyz123",                         │
│    nonce: "abc789",                         │
│    exp: <now + 5 minutes>                   │
│  }                                          │
│                                             │
│  Cookie flags:                              │
│    httpOnly: true                           │
│    secure: true (production)                │
│    sameSite: lax                            │
│    maxAge: 300 (5 minutes)                  │
│    path: /                                  │
└─────────────────────────────────────────────┘
```

**Why JWT and not a plain cookie?**
- The state must be tamper-proof — an attacker shouldn't be able to forge a state cookie
- JWT signing with `JWT_SECRET` provides integrity verification without needing server-side storage
- The 5-minute expiry prevents stale state cookies from accumulating

**Lifecycle:**
1. Created in `/api/auth/oidc/login` via `encryptState()`
2. Read in `/api/auth/oidc/callback` via `decryptState()`
3. Deleted in callback after successful exchange (set maxAge: 0)

### Session Cookie

After OIDC (or local) authentication:

```
┌─────────────────────────────────────────────┐
│  Cookie: auth-token                         │
│  Value: JWT (HS256 signed with JWT_SECRET)  │
│                                             │
│  Payload: {                                 │
│    role: "admin" | "user",                  │
│    username: "user@example.com",            │
│    exp: <now + 24 hours>                    │
│  }                                          │
│                                             │
│  Cookie flags:                              │
│    httpOnly: true                           │
│    secure: true (production)                │
│    sameSite: lax                            │
│    maxAge: 86400 (24 hours)                 │
│    path: /                                  │
└─────────────────────────────────────────────┘
```

---

## Security Model

### PKCE (Proof Key for Code Exchange)

Prevents authorization code interception attacks in the callback redirect:

```
Login route:
  code_verifier = random(32 bytes, base64url)
  code_challenge = base64url(SHA256(code_verifier))

  → Send code_challenge to provider
  → Store code_verifier in signed cookie

Callback route:
  → Send code_verifier to provider's token endpoint
  → Provider verifies: SHA256(code_verifier) === code_challenge
```

Even if an attacker intercepts the authorization code in the redirect URL, they cannot exchange it without the `code_verifier` (stored in an httpOnly cookie on the user's browser).

### State Parameter (CSRF Protection)

```
Login route:
  state = random(32 bytes, base64url)
  → Send state to provider in auth URL
  → Store state in signed cookie

Callback route:
  → Verify: URL query state === cookie state
```

Prevents CSRF attacks where an attacker tricks a user into completing an OAuth flow initiated by the attacker.

### Nonce (Replay Protection)

```
Login route:
  nonce = random(32 bytes, base64url)
  → Send nonce to provider in auth URL
  → Store nonce in signed cookie

Callback route:
  → openid-client validates: id_token.nonce === expected nonce
```

Prevents replay attacks where an intercepted ID token is reused.

### `prompt=login`

```typescript
// In generateAuthUrl():
parameters.set('prompt', 'login');
```

Forces the OIDC provider to show the login screen on every SSO click, even if the user has an active session at the provider. This prevents:
- Session fixation (user A clicks SSO but gets user B's session)
- Unintended auto-login (user logs out of LibreDB but still has a provider session)

### Cookie Security Summary

| Cookie | HttpOnly | Secure | SameSite | MaxAge | Signed |
|--------|----------|--------|----------|--------|--------|
| `oidc-state` | Yes | Yes (prod) | Lax | 5 min | JWT (HS256) |
| `auth-token` | Yes | Yes (prod) | Lax | 24 hours | JWT (HS256) |

---

## Role Mapping Engine

The role mapping system converts provider-specific claims into LibreDB's binary role model (`admin` | `user`).

### Algorithm (`mapOIDCRole`)

```
Input: claims object, roleClaim path, adminRoles list

1. If roleClaim is empty → return "user"

2. Navigate claim path (dot-notation):
   "realm_access.roles" → claims["realm_access"]["roles"]

3. Get claim value:
   a. If Array → check if ANY element matches adminRoles (case-insensitive)
   b. If String → check if it matches any adminRole (case-insensitive)
   c. Otherwise → return "user"

4. Match found → "admin", no match → "user"
```

### Examples

```
Provider: Auth0
Claims:   { "https://libredb.org/roles": ["admin", "viewer"] }
Config:   OIDC_ROLE_CLAIM=https://libredb.org/roles
          OIDC_ADMIN_ROLES=admin
Result:   "admin" ✓ (array contains "admin")

Provider: Keycloak
Claims:   { "realm_access": { "roles": ["offline_access", "uma_authorization", "admin"] } }
Config:   OIDC_ROLE_CLAIM=realm_access.roles
          OIDC_ADMIN_ROLES=admin
Result:   "admin" ✓ (dot-notation navigates nested object)

Provider: Okta
Claims:   { "groups": ["Everyone", "Engineering"] }
Config:   OIDC_ROLE_CLAIM=groups
          OIDC_ADMIN_ROLES=admin,Admin
Result:   "user" ✗ (no match in groups array)

Provider: Google
Claims:   { "sub": "123", "email": "user@gmail.com" }
Config:   OIDC_ROLE_CLAIM=  (empty)
Result:   "user" (no claim configured, default)
```

---

## Provider Logout Strategy

Different OIDC providers have different logout endpoint conventions. `buildLogoutUrl()` handles this:

```typescript
function buildLogoutUrl(returnTo: string): string | null {
  const config = getOIDCConfig();
  const issuerUrl = new URL(config.issuer);

  if (issuerUrl.hostname.includes('auth0.com')) {
    // Auth0: /v2/logout?client_id=xxx&returnTo=xxx
    return new URL('/v2/logout', config.issuer) + params;
  }

  // Generic OIDC (Keycloak, etc.):
  // /protocol/openid-connect/logout?client_id=xxx&post_logout_redirect_uri=xxx
  return new URL('/protocol/openid-connect/logout', config.issuer) + params;
}
```

### Provider Logout Endpoints

| Provider | Endpoint | Return Param |
|----------|----------|--------------|
| **Auth0** | `{issuer}/v2/logout` | `returnTo` |
| **Keycloak** | `{issuer}/protocol/openid-connect/logout` | `post_logout_redirect_uri` |
| **Okta** | RP-Initiated Logout (via discovery) | `post_logout_redirect_uri` |
| **Azure AD** | `{issuer}/oauth2/v2.0/logout` | `post_logout_redirect_uri` |

### Extension Point

To add a new provider's logout format, extend `buildLogoutUrl()` with a new hostname check:

```typescript
if (issuerUrl.hostname.includes('okta.com')) {
  const logoutUrl = new URL('/oauth2/v1/logout', config.issuer);
  logoutUrl.searchParams.set('id_token_hint', idToken);
  logoutUrl.searchParams.set('post_logout_redirect_uri', returnTo);
  return logoutUrl.toString();
}
```

---

## Error Handling

### Callback Error Codes

The callback route redirects to `/login?error=<code>` on failure:

| Error Code | Cause | When |
|------------|-------|------|
| `oidc_state_missing` | `oidc-state` cookie not found | Cookie expired (>5 min) or blocked by browser |
| `oidc_state_invalid` | State decryption failed or state mismatch | Tampered cookie, wrong JWT_SECRET, or CSRF attempt |
| `oidc_no_claims` | Token exchange returned no claims | Provider returned invalid/empty ID token |
| `oidc_failed` | Generic catch-all error | Network error, invalid client credentials, etc. |
| `oidc_config` | OIDC configuration invalid | Missing env vars, unreachable discovery endpoint |

### Login Page Error Display

```tsx
// login/page.tsx reads ?error= param
const oidcError = searchParams.get('error');

{oidcError && (
  <div className="border-destructive/50 bg-destructive/10 text-destructive">
    Authentication failed. Please try again.
  </div>
)}
```

### Server-Side Error Logging

All routes log errors to `console.error` before redirecting. In production, these should be captured by your logging infrastructure (e.g., Datadog, Sentry).

---

## Testing Architecture

### Test Strategy

The OIDC module is tested at three layers:

```
┌──────────────────────────────────────────────┐
│  Unit Tests (tests/unit/lib/oidc.test.ts)    │
│  Pure functions: mapOIDCRole, getOIDCConfig,  │
│  encryptState, decryptState, buildLogoutUrl,  │
│  discoverProvider, generateAuthUrl,            │
│  exchangeCode, resetDiscoveryCache             │
├──────────────────────────────────────────────┤
│  API Tests (tests/api/auth/)                  │
│  Route handlers: oidc-login, oidc-callback,   │
│  logout (OIDC mode), login (email/password)   │
├──────────────────────────────────────────────┤
│  Hook + Component Tests                       │
│  use-auth (OIDC redirect), LoginPageOIDC      │
├──────────────────────────────────────────────┤
│  E2E Tests (e2e/)                             │
│  Full browser login flow (local mode only,    │
│  OIDC requires real provider)                 │
└──────────────────────────────────────────────┘
```

### Mock Strategy

Since `openid-client` performs real HTTP requests, it must be mocked in tests:

```typescript
// tests/unit/lib/oidc.test.ts
const mockDiscoveryFn = mock(async () => 'mock-config');

mock.module('openid-client', () => ({
  discovery: mockDiscoveryFn,
  fetchUserInfo: mock(async () => ({})),
  buildEndSessionUrl: mock(() => new URL('https://example.com')),
  authorizationCodeGrant: mock(async () => ({ claims: () => mockClaims })),
  // ...
}));

// Dynamic import AFTER mocking:
const { discoverProvider, generateAuthUrl, exchangeCode } = await import('@/lib/oidc');
```

Key testing patterns:
- **`mock.module()` before dynamic `import()`** — ensures the mock is in place when the module loads
- **Process env manipulation** — `process.env.OIDC_ISSUER = 'https://...'` in `beforeEach`, restore in `afterEach`
- **Module-level env reads moved to function body** — `const authProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER` inside the route handler, not at module scope (for testability)

### Test File Map

| File | Tests | Coverage Target |
|------|-------|-----------------|
| `tests/unit/lib/oidc.test.ts` | ~30 | All `oidc.ts` functions |
| `tests/api/auth/oidc-login.test.ts` | ~4 | Login route redirect, PKCE state |
| `tests/api/auth/oidc-callback.test.ts` | ~9 | Code exchange, role mapping, errors |
| `tests/api/auth/logout.test.ts` | ~8 | Local + OIDC logout modes |
| `tests/hooks/use-auth.test.ts` | ~12 | Including OIDC redirect test |
| `tests/components/LoginPageOIDC.test.tsx` | ~7 | SSO button, error display |

---

## Extension Points

### Adding a New OIDC Provider

No code changes needed if the provider is OIDC-compliant. Just set the env vars. If the provider has a non-standard logout endpoint, add a case in `buildLogoutUrl()`.

### Adding SAML 2.0

Future SAML support would follow the same pattern:
1. Create `src/lib/saml.ts` (config, assertion parsing, attribute mapping)
2. Create `/api/auth/saml/login/route.ts` and `/api/auth/saml/callback/route.ts`
3. Call `login(role, email)` at the end — same JWT session
4. Add `NEXT_PUBLIC_AUTH_PROVIDER=saml` as a third option
5. No changes to proxy, hooks, or protected routes

### Adding Refresh Token Support

Currently, the local JWT session has a fixed 24-hour expiry. To add OIDC refresh tokens:
1. Store `refresh_token` in an encrypted httpOnly cookie during callback
2. Create `/api/auth/refresh/route.ts` that uses `openid-client` to refresh
3. Update `proxy.ts` to check token expiry and trigger refresh
4. No changes to the OIDC login/callback flow

### Adding User Profile Display

The OIDC claims contain `name`, `email`, `picture` etc. To display these:
1. Extend `UserPayload` in `auth.ts` with optional profile fields
2. Include claim values in `signJWT()` call during callback
3. The existing `/api/auth/me` endpoint and `useAuth` hook will automatically carry the new fields

---

## Decision Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| **`openid-client` v6 over `@auth0/nextjs-auth0`** | Vendor-agnostic, same author as `jose` (already in project), zero extra deps | Auth0 SDK locks to one provider; `next-auth` adds 15+ deps and complexity |
| **Local JWT after OIDC** | Zero coupling — proxy, hooks, and routes don't know about OIDC | Forwarding provider tokens requires token refresh logic in middleware |
| **PKCE state in JWT cookie** | Stateless — no server-side session store needed | Redis/DB session store adds infrastructure dependency |
| **5-minute state cookie TTL** | Long enough for slow providers, short enough to limit replay window | Shorter: may fail on slow networks. Longer: increases attack window |
| **`prompt=login` always** | Prevents confusing auto-login behavior; user expects to choose account | `prompt=consent`: too aggressive. No prompt: users get stuck with one account |
| **Provider-specific logout detection via hostname** | Simple, works for 90% of cases | OIDC Discovery `end_session_endpoint`: not all providers support it; would require async call |
| **Module-level discovery cache** | Fast (avoids HTTP on every login), simple, process-scoped | Redis cache: overkill for single-instance deployments. No cache: 200-500ms per login |
| **Binary role model (admin/user)** | Matches existing RBAC, simple to map from any claim format | Fine-grained roles: would require schema changes in JWT, proxy, and all components |
