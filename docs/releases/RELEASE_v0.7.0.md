# Release v0.7.0 - OIDC Authentication & Next.js 16

This release introduces vendor-agnostic OpenID Connect (OIDC) authentication supporting any OIDC-compliant provider (Auth0, Keycloak, Okta, Azure AD, Google), upgrades the framework to Next.js 16 with React 19.2, and migrates the login system from password-only to email/password format.

---

## Highlights

- **OIDC Single Sign-On:** Vendor-agnostic OpenID Connect authentication with PKCE, role mapping, and session management
- **Next.js 16 Upgrade:** Framework upgrade from Next.js 15 to 16 with Turbopack as default bundler
- **Email/Password Login:** Login system migrated from password-only to email/password format with configurable default users
- **Middleware to Proxy:** `middleware.ts` renamed to `proxy.ts` per Next.js 16 conventions
- **ESLint Configuration:** Updated ESLint config for `eslint-config-next` v16 compatibility

---

## New Features

### OIDC Authentication (Single Sign-On)

Vendor-agnostic OpenID Connect authentication that works with any OIDC-compliant identity provider. After OIDC authentication, a local JWT session is created — middleware, hooks, and protected routes remain unchanged.

**Supported Providers:**
| Provider | Role Claim Example |
|----------|-------------------|
| **Auth0** | `https://myapp.com/roles` (via Actions) |
| **Keycloak** | `realm_access.roles` (dot-notation) |
| **Okta** | `groups` |
| **Azure AD** | `roles` |

**Auth Flow:**

```
Browser → GET /api/auth/oidc/login → OIDC Discovery (cached) → Generate PKCE + state + nonce
       → Set oidc-state cookie (signed, httpOnly, 5min)
       → 302 redirect to provider's authorize endpoint

Browser → Authenticate at provider → 302 /api/auth/oidc/callback?code=xxx&state=xxx
       → Validate state → Exchange code for tokens → Extract claims → Map role
       → Create local JWT session (auth-token cookie) → Redirect to app
```

**Key Features:**
- **PKCE (S256):** Proof Key for Code Exchange for secure authorization code flow
- **OIDC Discovery:** Auto-discovery via `/.well-known/openid-configuration` with 5-minute cache
- **State Encryption:** PKCE state cookie signed with JWT_SECRET (5-minute expiry)
- **Role Mapping:** Configurable claim path with dot-notation for nested claims, case-insensitive matching
- **Prompt Login:** `prompt=login` parameter forces re-authentication on every SSO click
- **OIDC Logout:** Logout clears both local JWT and provider session (Auth0 `/v2/logout`, generic RP-Initiated Logout)

**Environment Variables:**

```env
# Auth provider: "local" (default) or "oidc"
NEXT_PUBLIC_AUTH_PROVIDER=local

# OIDC Configuration (required when AUTH_PROVIDER=oidc)
OIDC_ISSUER=https://dev-xxx.auth0.com
OIDC_CLIENT_ID=your_client_id
OIDC_CLIENT_SECRET=your_client_secret
OIDC_SCOPE=openid profile email
OIDC_ROLE_CLAIM=https://myapp.com/roles
OIDC_ADMIN_ROLES=admin
```

### Email/Password Login

Login system upgraded from password-only to email/password format with configurable default users for both local and demo environments.

**Default Users:**

| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@libredb.org` | `LibreDB.2026` |
| User | `user@libredb.org` | `LibreDB.2026` |

**Environment Variables:**

```env
ADMIN_EMAIL=admin@libredb.org
ADMIN_PASSWORD=your_secure_admin_password
USER_EMAIL=user@libredb.org
USER_PASSWORD=your_secure_user_password
```

**Login Page:**
- Conditional rendering: OIDC mode shows "Login with SSO" button, local mode shows email/password form
- Quick access demo buttons for Admin and User with pre-filled credentials
- OIDC error display from `?error=` query parameter
- Wrapped in `Suspense` boundary for `useSearchParams()` compatibility

---

## Framework Upgrade

### Next.js 15 → 16

| Package | Before | After |
|---------|--------|-------|
| `next` | `15.5.7` | `16.1.6` |
| `react` | `19.2.1` | `19.2.4` |
| `react-dom` | `19.2.1` | `19.2.4` |
| `eslint-config-next` | `15.5.7` | `16.1.6` |
| `@types/react` | `^19` | `^19.2.14` |
| `@types/react-dom` | `^19` | `^19.2.3` |

**Key Changes:**
- **Turbopack Default:** `next dev` now uses Turbopack by default (removed explicit `--turbopack` flag)
- **Middleware → Proxy:** `src/middleware.ts` renamed to `src/proxy.ts`, `middleware()` function renamed to `proxy()`
- **ESLint Config:** Updated `eslint.config.mjs` for v16 compatibility

---

## Architecture Changes

### New Files

| File | Description |
|------|-------------|
| `src/lib/oidc.ts` | OIDC utility module (~230 lines): config, discovery, PKCE, token exchange, role mapping, state encryption, logout URL |
| `src/app/api/auth/oidc/login/route.ts` | OIDC login route: discovery, auth URL generation, state cookie, redirect |
| `src/app/api/auth/oidc/callback/route.ts` | OIDC callback route: state validation, code exchange, role mapping, session creation |

### Modified Files

| File | Change |
|------|--------|
| `src/lib/auth.ts` | Added optional `username` parameter to `login()` function |
| `src/app/api/auth/login/route.ts` | Email/password authentication with `ADMIN_EMAIL`/`USER_EMAIL` env vars |
| `src/app/api/auth/logout/route.ts` | OIDC logout support: returns `redirectUrl` for provider session cleanup |
| `src/app/login/page.tsx` | Conditional OIDC/local login UI, email/password form, Suspense boundary |
| `src/hooks/use-auth.ts` | OIDC logout redirect handling via `window.location.href` |
| `src/proxy.ts` | Renamed from `middleware.ts`, function renamed from `middleware()` to `proxy()` |
| `.env.example` | OIDC configuration section with provider-specific examples |

### OIDC Module (`src/lib/oidc.ts`)

```
getOIDCConfig()        → reads + validates OIDC env vars
discoverProvider()     → OIDC Discovery with 5-min in-memory cache
generateAuthUrl()      → authorization URL with PKCE + prompt=login
exchangeCode()         → token exchange, ID token validation
mapOIDCRole()          → role extraction from claims (dot-notation, case-insensitive)
encryptState()         → sign PKCE state as JWT
decryptState()         → verify + extract PKCE state from JWT
buildLogoutUrl()       → provider-specific logout URL (Auth0, Keycloak, etc.)
```

---

## Breaking Changes

### Login API Format

The `POST /api/auth/login` endpoint now requires `email` in addition to `password`:

```typescript
// Before (v0.6.x)
{ password: "admin123" }

// After (v0.7.0)
{ email: "admin@libredb.org", password: "LibreDB.2026" }
```

### Environment Variables

```env
# Before (v0.6.x)
ADMIN_PASSWORD=admin123
USER_PASSWORD=user123

# After (v0.7.0)
ADMIN_EMAIL=admin@libredb.org
ADMIN_PASSWORD=LibreDB.2026
USER_EMAIL=user@libredb.org
USER_PASSWORD=LibreDB.2026
```

### Middleware Rename

```typescript
// Before (v0.6.x) — Next.js 15
// src/middleware.ts
export async function middleware(request: NextRequest) { ... }

// After (v0.7.0) — Next.js 16
// src/proxy.ts
export async function proxy(request: NextRequest) { ... }
```

---

## Dependencies

### Added
- `openid-client` v6 — OIDC Discovery, PKCE, Authorization Code Flow, ID token validation (by Filip Skokan, same author as `jose`)

### Updated
- `next` 15.5.7 → 16.1.6
- `react` 19.2.1 → 19.2.4
- `react-dom` 19.2.1 → 19.2.4
- `eslint-config-next` 15.5.7 → 16.1.6
- `@types/react` ^19 → ^19.2.14
- `@types/react-dom` ^19 → ^19.2.3

**Note:** `openid-client` depends on `jose ^6.1.3` — same version already in the project, zero extra transitive dependencies.

---

## Testing

### New Test Files

| File | Tests | Description |
|------|-------|-------------|
| `tests/unit/lib/oidc.test.ts` | 17 | `mapOIDCRole`, `getOIDCConfig`, `encryptState`/`decryptState`, `buildLogoutUrl` |
| `tests/api/auth/oidc-login.test.ts` | 4 | OIDC login redirect, PKCE state cookie, redirect URI, error handling |
| `tests/api/auth/oidc-callback.test.ts` | 9 | Code exchange, role mapping, session creation, error handling |

### Updated Test Files

| File | Change |
|------|--------|
| `tests/api/auth/login.test.ts` | Updated for `{ email, password }` format (9 tests) |
| `tests/api/auth/logout.test.ts` | Updated for OIDC logout support (3 tests) |
| `tests/components/LoginPage.test.tsx` | Updated for email/password form and new credentials (14 tests) |
| `tests/setup.ts` | Added `ADMIN_EMAIL`, `USER_EMAIL` env vars |

### Test Results

```
494 pass, 0 fail across 23 component test files + 68 non-component test files
All 15 isolation groups passed
```

---

## Migration Guide

### For Users

1. **Update environment variables:**
   ```env
   # Add these new variables
   ADMIN_EMAIL=admin@libredb.org
   USER_EMAIL=user@libredb.org

   # Update passwords (or keep existing ones)
   ADMIN_PASSWORD=your_password
   USER_PASSWORD=your_password
   ```

2. **To enable OIDC authentication:**
   ```env
   NEXT_PUBLIC_AUTH_PROVIDER=oidc
   OIDC_ISSUER=https://your-provider.com
   OIDC_CLIENT_ID=your_client_id
   OIDC_CLIENT_SECRET=your_client_secret
   ```

3. **Auth0 specific setup:**
   - Set Allowed Callback URLs: `http://localhost:3000/api/auth/oidc/callback`
   - Set Allowed Logout URLs: `http://localhost:3000/login`
   - Set Allowed Web Origins: `http://localhost:3000`
   - Create a Post Login Action for role mapping with namespace claim

### For Developers

1. **Middleware rename:** If referencing `middleware.ts` directly, update to `proxy.ts`
2. **Login API:** Update any direct calls to `/api/auth/login` to include `email` field
3. **Test setup:** Ensure `ADMIN_EMAIL` and `USER_EMAIL` are set in test environment

---

## Security

- **PKCE S256:** Authorization code flow uses Proof Key for Code Exchange to prevent code interception
- **State Cookie Encryption:** OIDC state signed as JWT with `JWT_SECRET`, 5-minute expiry, httpOnly, sameSite=lax
- **Prompt Login:** Every SSO attempt forces re-authentication, preventing session fixation
- **OIDC Logout:** Both local JWT and provider session are cleared on logout
- **Production Validation:** OIDC env vars are validated at startup, missing vars throw immediately

---

## What's Next

### v0.7.x (Planned)
- OIDC user profile display (name, avatar from claims)
- Multi-tenant role mapping with custom claim schemas
- Session refresh with OIDC refresh tokens
- SAML 2.0 support for enterprise environments

---

## Full Changelog

### Added
- Vendor-agnostic OIDC authentication with PKCE, discovery, and role mapping
- `openid-client` v6 dependency for OIDC protocol handling
- OIDC login route (`/api/auth/oidc/login`) with PKCE state cookie
- OIDC callback route (`/api/auth/oidc/callback`) with code exchange and session creation
- OIDC logout support with provider session cleanup (Auth0, Keycloak, generic)
- `buildLogoutUrl()` for provider-specific logout URL generation
- `prompt=login` parameter to force re-authentication on every SSO click
- Email field to login form and API (email/password authentication)
- `ADMIN_EMAIL` and `USER_EMAIL` environment variables
- Quick access demo buttons with `admin@libredb.org` / `user@libredb.org`
- 30 new tests for OIDC module, routes, and updated login/logout flows
- OIDC configuration section in `.env.example` with provider-specific examples

### Changed
- Next.js 15.5.7 → 16.1.6 (Turbopack default)
- React 19.2.1 → 19.2.4
- `middleware.ts` → `proxy.ts` (Next.js 16 convention)
- `middleware()` → `proxy()` function rename
- ESLint configuration updated for `eslint-config-next` v16
- Login API from `{ password }` to `{ email, password }` format
- Default demo password from `admin123`/`user123` to `LibreDB.2026`
- `login()` function signature: added optional `username` parameter
- Logout route returns `redirectUrl` for OIDC provider logout
- `useAuth` hook handles OIDC logout redirect

### Fixed
- Session persistence across SSO re-authentication (Auth0 session cookie issue)

### Removed
- `--turbopack` flag from dev script (now default in Next.js 16)
- `next.config.ts` middleware configuration (replaced by proxy convention)

---

**Full Changelog:** [Compare v0.6.51...v0.7.0](https://github.com/libredb/libredb-studio/compare/v0.6.51...v0.7.0)
