# OIDC Setup Guide

LibreDB Studio supports vendor-agnostic OpenID Connect (OIDC) authentication. This guide covers setup for popular identity providers.

---

## How It Works

LibreDB Studio uses the **Authorization Code Flow with PKCE** (S256). After OIDC authentication, a local JWT session is created — the rest of the app (middleware, hooks, protected routes) works identically to local email/password login.

```
Browser → /api/auth/oidc/login → OIDC Discovery → PKCE + state → redirect to provider
Browser → Authenticate at provider → /api/auth/oidc/callback?code=xxx&state=xxx
Server  → Validate state → Exchange code → Extract claims → Map role → Create JWT session
Browser → Redirect to app (/ or /admin based on role)
```

---

## Quick Start

### 1. Set Environment Variables

```env
NEXT_PUBLIC_AUTH_PROVIDER=oidc
OIDC_ISSUER=https://your-provider.com
OIDC_CLIENT_ID=your_client_id
OIDC_CLIENT_SECRET=your_client_secret
```

### 2. Configure Your Provider

Set these URLs in your identity provider:

| Setting | Value |
|---------|-------|
| **Allowed Callback URL** | `https://your-domain.com/api/auth/oidc/callback` |
| **Allowed Logout URL** | `https://your-domain.com/login` |
| **Allowed Web Origins** | `https://your-domain.com` |

For local development, use `http://localhost:3000` instead.

### 3. Start the App

```bash
bun dev
```

Navigate to `/login` and click **"Login with SSO"**.

---

## Provider-Specific Setup

### Auth0

1. **Create Application** in Auth0 Dashboard → Applications → Create Application → Regular Web Application

2. **Settings:**
   ```
   Allowed Callback URLs: http://localhost:3000/api/auth/oidc/callback
   Allowed Logout URLs:   http://localhost:3000/login
   Allowed Web Origins:   http://localhost:3000
   ```

3. **Environment Variables:**
   ```env
   NEXT_PUBLIC_AUTH_PROVIDER=oidc
   OIDC_ISSUER=https://your-tenant.auth0.com
   OIDC_CLIENT_ID=your_client_id
   OIDC_CLIENT_SECRET=your_client_secret
   ```

4. **Role Mapping (Optional):**

   Create a Post Login Action in Auth0 to add roles to the ID token:

   ```javascript
   // Auth0 Action: Add roles to ID token
   exports.onExecutePostLogin = async (event, api) => {
     const namespace = 'https://libredb.org';
     const roles = event.authorization?.roles || [];
     api.idToken.setCustomClaim(`${namespace}/roles`, roles);
   };
   ```

   Then configure:
   ```env
   OIDC_ROLE_CLAIM=https://libredb.org/roles
   OIDC_ADMIN_ROLES=admin
   ```

### Keycloak

1. **Create Client** in Keycloak Admin → Clients → Create Client
   - Client type: OpenID Connect
   - Client authentication: On

2. **Settings:**
   ```
   Valid Redirect URIs:    http://localhost:3000/api/auth/oidc/callback
   Valid Post Logout URIs: http://localhost:3000/login
   Web Origins:            http://localhost:3000
   ```

3. **Environment Variables:**
   ```env
   NEXT_PUBLIC_AUTH_PROVIDER=oidc
   OIDC_ISSUER=https://keycloak.example.com/realms/your-realm
   OIDC_CLIENT_ID=libredb-studio
   OIDC_CLIENT_SECRET=your_client_secret
   ```

4. **Role Mapping:**

   Keycloak includes realm roles in the ID token by default:
   ```env
   OIDC_ROLE_CLAIM=realm_access.roles
   OIDC_ADMIN_ROLES=admin
   ```

   > The dot-notation `realm_access.roles` navigates nested claims: `{ "realm_access": { "roles": ["admin", "user"] } }`

### Okta

1. **Create Application** in Okta Admin → Applications → Create App Integration → OIDC → Web Application

2. **Settings:**
   ```
   Sign-in redirect URI:  http://localhost:3000/api/auth/oidc/callback
   Sign-out redirect URI: http://localhost:3000/login
   ```

3. **Environment Variables:**
   ```env
   NEXT_PUBLIC_AUTH_PROVIDER=oidc
   OIDC_ISSUER=https://your-org.okta.com
   OIDC_CLIENT_ID=your_client_id
   OIDC_CLIENT_SECRET=your_client_secret
   ```

4. **Role Mapping:**

   Assign users to groups in Okta, then use the `groups` claim:
   ```env
   OIDC_ROLE_CLAIM=groups
   OIDC_ADMIN_ROLES=admin,Admin,LibreDB-Admin
   ```

### Azure AD (Microsoft Entra ID)

1. **Register Application** in Azure Portal → App Registrations → New Registration
   - Redirect URI: `http://localhost:3000/api/auth/oidc/callback` (Web)

2. **Create Client Secret** in Certificates & Secrets → New Client Secret

3. **Environment Variables:**
   ```env
   NEXT_PUBLIC_AUTH_PROVIDER=oidc
   OIDC_ISSUER=https://login.microsoftonline.com/{tenant-id}/v2.0
   OIDC_CLIENT_ID=your_application_id
   OIDC_CLIENT_SECRET=your_client_secret
   ```

4. **Role Mapping:**

   Define App Roles in Azure → use the `roles` claim:
   ```env
   OIDC_ROLE_CLAIM=roles
   OIDC_ADMIN_ROLES=Admin,admin
   ```

### Zitadel

1. **Create Project & Application** in Zitadel Console → Projects → Create New Project → Add Application (Web)
   - Auth Method: PKCE

2. **Settings:**
   ```
   Redirect URIs:       http://localhost:3000/api/auth/oidc/callback
   Post Logout URIs:    http://localhost:3000/login
   ```

3. **Environment Variables:**
   ```env
   NEXT_PUBLIC_AUTH_PROVIDER=oidc
   OIDC_ISSUER=https://your-instance.zitadel.cloud
   OIDC_CLIENT_ID=your_client_id
   OIDC_CLIENT_SECRET=your_client_secret
   ```

4. **Role Mapping:**

   Zitadel includes roles if requested via scopes. Ensure `OIDC_SCOPE` includes `urn:zitadel:iam:org:project:roles`.
   ```env
   OIDC_SCOPE=openid profile email urn:zitadel:iam:org:project:roles
   OIDC_ROLE_CLAIM=urn:zitadel:iam:org:project:roles
   OIDC_ADMIN_ROLES=admin
   ```

### Google Workspace

1. **Create OAuth Client** in Google Cloud Console → APIs & Services → Credentials → Create OAuth Client ID → Web Application

2. **Settings:**
   ```
   Authorized redirect URI: http://localhost:3000/api/auth/oidc/callback
   ```

3. **Environment Variables:**
   ```env
   NEXT_PUBLIC_AUTH_PROVIDER=oidc
   OIDC_ISSUER=https://accounts.google.com
   OIDC_CLIENT_ID=your_client_id.apps.googleusercontent.com
   OIDC_CLIENT_SECRET=your_client_secret
   ```

   > Google does not include role claims by default. Without `OIDC_ROLE_CLAIM`, all users are mapped to the `user` role.

---

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_AUTH_PROVIDER` | No | `local` | Auth mode: `local` or `oidc` |
| `OIDC_ISSUER` | When `oidc` | — | Issuer URL (must serve `/.well-known/openid-configuration`) |
| `OIDC_CLIENT_ID` | When `oidc` | — | OAuth client ID |
| `OIDC_CLIENT_SECRET` | When `oidc` | — | OAuth client secret |
| `OIDC_SCOPE` | No | `openid profile email` | OAuth scopes to request |
| `OIDC_ROLE_CLAIM` | No | — | Claim path for role extraction (dot-notation supported) |
| `OIDC_ADMIN_ROLES` | No | `admin` | Comma-separated values that map to admin role |

### Role Mapping

The role mapping system:

1. Reads the claim specified by `OIDC_ROLE_CLAIM` from the ID token
2. Supports dot-notation for nested claims (e.g., `realm_access.roles`)
3. If the claim value is an array, checks if any element matches `OIDC_ADMIN_ROLES`
4. If the claim value is a string, checks for exact match (case-insensitive)
5. If no match or no claim configured, defaults to `user` role

**Examples:**

```json
// Flat string claim: OIDC_ROLE_CLAIM=role
{ "role": "admin" }  →  admin

// Array claim: OIDC_ROLE_CLAIM=roles
{ "roles": ["viewer", "admin"] }  →  admin

// Nested claim: OIDC_ROLE_CLAIM=realm_access.roles
{ "realm_access": { "roles": ["admin"] } }  →  admin

// No match → defaults to user
{ "roles": ["viewer", "editor"] }  →  user
```

---

## Security Features

| Feature | Description |
|---------|-------------|
| **PKCE S256** | Proof Key for Code Exchange prevents authorization code interception |
| **State Cookie** | PKCE state encrypted as JWT with `JWT_SECRET`, httpOnly, sameSite=lax, 5-min expiry |
| **Prompt Login** | `prompt=login` forces re-authentication on every SSO click |
| **Provider Logout** | Logout clears both local JWT and provider session |
| **Discovery Cache** | OIDC provider metadata cached for 5 minutes to reduce network calls |
| **Nonce Validation** | ID token nonce validated to prevent replay attacks |

---

## Troubleshooting

### Login redirects back to `/login` without error

- Check that your OIDC issuer URL is correct and serves `/.well-known/openid-configuration`
- Verify `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` match your provider configuration
- Check server logs for token exchange errors

### "Authentication failed" error on login page

- The callback received an error from the provider. Check that the callback URL is registered correctly in your provider
- Ensure the client secret hasn't expired

### Same user auto-logs in on every SSO click

- This is handled automatically — LibreDB Studio sends `prompt=login` to force re-authentication
- If the issue persists, check your provider's session settings

### Role is always "user" even for admins

- Verify `OIDC_ROLE_CLAIM` points to the correct claim in your ID token
- Use your provider's token debugger to inspect the actual claims returned
- Check `OIDC_ADMIN_ROLES` matches the role value exactly (case-insensitive)
- For nested claims, use dot-notation: `realm_access.roles` not `realm_access/roles`

### Logout doesn't clear provider session

- Auth0: Ensure `http://localhost:3000/login` is in Allowed Logout URLs
- Keycloak: Provider logout is handled via RP-Initiated Logout endpoint
- Other providers: Check if your provider supports end_session_endpoint

---

## Switching Between Auth Modes

You can switch between local and OIDC authentication by changing a single environment variable:

```env
# Local email/password login
NEXT_PUBLIC_AUTH_PROVIDER=local

# OIDC Single Sign-On
NEXT_PUBLIC_AUTH_PROVIDER=oidc
```

Both modes use the same JWT session after authentication. The middleware, hooks, protected routes, and RBAC all work identically regardless of the auth mode.
