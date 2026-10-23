# OIDC SSO — LibreDB Studio

LibreDB Studio supports vendor-agnostic OpenID Connect (OIDC) authentication. This document is split into two parts: a **Setup Guide** for operators configuring SSO against a provider, and an **Architecture & Internals** reference for contributors working on the auth subsystem.

LibreDB Studio uses the **Authorization Code Flow with PKCE** (S256). After OIDC authentication, a local JWT session is created — the rest of the app (middleware, hooks, protected routes, RBAC) works identically to local email/password login.

```
Browser → /api/auth/oidc/login → OIDC Discovery → PKCE + state → redirect to provider
Browser → Authenticate at provider → /api/auth/oidc/callback?code=xxx&state=xxx
Server  → Validate state → Exchange code → Extract claims → Map role → Create JWT session
Browser → Redirect to app (/ or /admin based on role)
```

---

## Table of Contents

- [Part 1 — Setup Guide](#part-1--setup-guide)
  - [Quick Start](#quick-start)
  - [Try it locally with Keycloak](#try-it-locally-with-keycloak)
  - [Provider-Specific Setup](#provider-specific-setup)
    - [Auth0](#auth0)
    - [Keycloak](#keycloak)
    - [Okta](#okta)
    - [Azure AD (Microsoft Entra ID)](#azure-ad-microsoft-entra-id)
    - [Zitadel](#zitadel)
    - [Google Workspace](#google-workspace)
  - [Configuration Reference](#configuration-reference)
  - [Automatic redirect to the provider](#automatic-redirect-to-the-provider)
  - [Role Mapping](#role-mapping)
    - [Requiring a role](#requiring-a-role)
    - [Custom seed roles with OIDC_ROLE_PREFIX](#custom-seed-roles-with-oidc_role_prefix)
  - [Session Identity](#session-identity)
  - [Governance mode](#governance-mode)
  - [Bearer access tokens for native clients](#bearer-access-tokens-for-native-clients)
  - [Security Features](#security-features)
  - [Troubleshooting](#troubleshooting)
  - [Switching Between Auth Modes](#switching-between-auth-modes)
- [Part 2 — Architecture & Internals](#part-2--architecture--internals)
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

# Part 1 — Setup Guide

This part covers configuring SSO for popular identity providers. Most readers only need this part. Contributors working on the auth code should also read [Part 2 — Architecture & Internals](#part-2--architecture--internals).

## Quick Start

OIDC authentication is for teams past the two-account shape (one admin plus one user) who want individual logins, distinct team roles, and an audit trail that names the person who acted.
Pair OIDC with `STORAGE_PROVIDER=sqlite` or `postgres` to give each team member their own private workspace for connections, saved queries, and settings.
See [Storage Documentation](STORAGE.md) for configuring server storage.

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

## Try it locally with Keycloak

To see SSO login and role mapping before configuring your own provider, start the demo stack. It runs LibreDB Studio, a preconfigured Keycloak and a TLS proxy from one file, with no source checkout, `.env` file or second command:

```bash
curl -fsSLO https://raw.githubusercontent.com/libredb/libredb-studio/main/docker-compose.oidc-demo.yml
docker compose -f docker-compose.oidc-demo.yml up
```

When the stack is up, open **https://demo.127.0.0.1.nip.io:8443**.

**Before you start**

- **Docker Compose v2.23.1 or newer.** The Caddyfile and the Keycloak realm are inline in the compose file.
- **Network access.** A cold start pulls three images.
- **A resolver that answers `demo.127.0.0.1.nip.io`.** The name is served by the public [nip.io](https://nip.io) wildcard DNS and resolves to `127.0.0.1`. Check it first:

  ```bash
  getent hosts demo.127.0.0.1.nip.io              # Linux
  dscacheutil -q host -a name demo.127.0.0.1.nip.io   # macOS
  ```

  It should print `127.0.0.1  demo.127.0.0.1.nip.io`. If it prints nothing (`getent` exits with status 2) or an address other than `127.0.0.1`, your resolver filters wildcard DNS names, and the stack will start but the browser cannot reach it. Some corporate networks do this. The demo is meant for evaluating the product on a networked machine, not for air-gapped ones.

**Expected first step: one certificate warning.** The proxy serves the demo's own self-signed certificate, from Caddy's local CA, so your browser warns once on `https://demo.127.0.0.1.nip.io:8443`. Proceed past it. Every page, Keycloak included, is on that one origin, so there is no second warning. The certificate is short-lived (12 hours): if you leave the stack running longer, the browser warns once more after it renews.

**The walkthrough (about a minute)**

1. On the login page, click **Login with SSO** and sign in as `admin` / `admin`. You land on the admin dashboard.
2. Click **Logout**. Keycloak asks **Do you want to log out?**; confirm it, and you are back on the login page.
3. Click **Login with SSO** again and sign in as `user` / `user`. You land on the editor, and the admin surfaces are gone: `/admin` sends you back to `/`.

Keycloak asks for a password on that third step whether or not step 2 ended its session, because Studio sends `prompt=login` on every authorization request by default (`OIDC_PROMPT`, `src/lib/oidc.ts`). Treat the prompt as normal, not as proof: what shows the logout worked is that step 2 returns you to the login page and the app stays signed out until you sign in again.

The difference is the realm role (`admin` or `user`), mapped through `OIDC_ROLE_CLAIM=realm_access.roles` exactly as in the [Keycloak](#keycloak) setup below. The realm already has the roles in the ID token, so nothing needs changing in the Keycloak admin console.

**Not a production setup.** Keycloak runs `start-dev` with an embedded store that is lost when the container is removed, the certificate is self-signed, and the client secret and passwords are committed in the file. Use the provider sections below for real deployments. `docker compose -f docker-compose.oidc-demo.yml down -v` removes the stack and its volumes.

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

   Create a Post Login Action in Auth0 to add roles to the ID token, and to the access token for the [bearer channel](#bearer-access-tokens-for-native-clients):

   ```javascript
   // Auth0 Action: Add roles to the ID token and the access token
   exports.onExecutePostLogin = async (event, api) => {
     const namespace = 'https://libredb.org';
     const roles = event.authorization?.roles || [];
     api.idToken.setCustomClaim(`${namespace}/roles`, roles);
     api.accessToken.setCustomClaim(`${namespace}/roles`, roles);
   };
   ```

   Then configure (the claim name is read whole, since it is a top-level claim, so its dots are not a path):
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

   Verified on Keycloak 26.4: enable the realm-role mapper's **Add to ID token** setting via **Client scopes → roles → Mappers → realm roles → Add to ID token**, then click **Save**.
   This is required because Keycloak does not enable this setting by default.
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
| `OIDC_ISSUER` | When `oidc` | — | Issuer URL (must be `https://` and serve `/.well-known/openid-configuration`) |
| `OIDC_CLIENT_ID` | When `oidc` | — | OAuth client ID |
| `OIDC_CLIENT_SECRET` | When `oidc` | — | OAuth client secret |
| `OIDC_SCOPE` | No | `openid profile email` | OAuth scopes to request |
| `OIDC_ROLE_CLAIM` | No | — | Claim path for role extraction (dot-notation supported) |
| `OIDC_ADMIN_ROLES` | No | `admin` | Comma-separated values that map to admin role |
| `OIDC_USER_ROLES` | No | unset | Comma-separated values that map to user role. Set, an account that holds neither an admin nor a user role is refused at sign-in ([Requiring a role](#requiring-a-role)). Needs `OIDC_ROLE_CLAIM` |
| `OIDC_ROLE_PREFIX` | No | unset | Prefix filter for custom roles from the OIDC role claim; see [Custom seed roles with OIDC_ROLE_PREFIX](#custom-seed-roles-with-oidc_role_prefix). Needs `OIDC_ROLE_CLAIM` |
| `OIDC_PROMPT` | No | `login` | The `prompt` sent on sign-in: `login`, `consent`, `select_account`, or `omit` to send none; see [Single sign-on with OIDC_PROMPT](#single-sign-on-with-oidc_prompt) |
| `OIDC_AUTO_REDIRECT` | No | off | `true`, `1`, `on` or `yes` sends a signed-out `GET /login` straight to the identity provider; see [Automatic redirect to the provider](#automatic-redirect-to-the-provider) |
| `OIDC_LOGOUT_HINT` | No | off | `true`, `1`, `on` or `yes` sends `id_token_hint` with the provider's end-session request on logout; see [Logout with id_token_hint](#logout-with-id_token_hint) |
| `OIDC_BEARER_AUDIENCE` | No | unset | Turns on bearer access tokens for native clients: the audience the provider puts in their access tokens. Must differ from `OIDC_CLIENT_ID`; see [Bearer access tokens for native clients](#bearer-access-tokens-for-native-clients) |
| `OIDC_BEARER_CLIENT_IDS` | No | unset | Comma-separated client ids whose access tokens are accepted, checked against `azp`, else `client_id`. Recommended whenever `OIDC_BEARER_AUDIENCE` is set |
| `AUTH_SESSION_TTL_SECONDS` | No | `86400` | Session lifetime in seconds, from 300 to 86400; see [Session lifetime](#session-lifetime) |

### Single sign-on with OIDC_PROMPT

By default Studio sends `prompt=login`, so the provider asks for credentials on every sign-in, even when the user already has a provider session.
Set `OIDC_PROMPT=omit` to send no `prompt` parameter at all.
The provider then signs a user with a live session straight back in without a form, which is what single sign-on across Studio and other applications on the same provider needs.
`consent` and `select_account` are passed through for providers that support them.
The value is trimmed and case-insensitive.
Any other value, `none` included, is a configuration error: sign-in lands on `/login?error=oidc_config`.
`none` is refused because the provider answers it with `login_required` whenever there is no session, which leaves the user on an error instead of a sign-in form.

> Storage configuration (`STORAGE_PROVIDER` etc.) is independent of auth. See [STORAGE.md](./STORAGE.md).

### Automatic redirect to the provider

By default the login page shows a single sign-on button, and the user clicks it to reach the identity provider.
With `OIDC_AUTO_REDIRECT=true`, a signed-out `GET /login` answers 307 to `<BASE_PATH>/api/auth/oidc/login` instead, so the user sees the provider's sign-in page directly.
The values `true`, `1`, `on` and `yes` (trimmed, any case) turn it on; unset or empty leaves it off, and any other value leaves it off with one warning in the server log.
A safe `next` on the login address is carried along, so a deep link still opens what it named after sign-in; an unsafe one is dropped.
Every OIDC failure lands on `/login?error=<code>`, and a login address with `error` always renders the page, so a failing provider shows its error instead of looping.
After a logout the provider returns to `/login`, which then starts a new sign-in at the provider.
The flag has no effect unless `NEXT_PUBLIC_AUTH_PROVIDER=oidc`.

### Logout with id_token_hint

By default the end-session request Studio sends on logout names the client and the return address, but not the session to end.
Without a hint, some providers, Keycloak among them, ask the user to confirm the logout.
With `OIDC_LOGOUT_HINT=true`, the OIDC callback keeps the raw ID token in the cookie `oidc-logout-hint`, and `POST /api/auth/logout` adds it to the end-session request as `id_token_hint`.
The values `true`, `1`, `on` and `yes` (trimmed, any case) turn it on; unset or empty leaves it off, and any other value leaves it off with a warning in the server log.

- The cookie is `httpOnly` and `SameSite=Lax`, `Secure` under the same rule as the session cookie, scoped to `<BASE_PATH>/api/auth/logout` so no other request carries it, and lives as long as the session (`AUTH_SESSION_TTL_SECONDS`).
- A token over 3800 bytes is not kept, because a browser drops a cookie over 4096 bytes; a hint kept by an earlier sign-in is deleted instead, and logout proceeds without a hint.
- Logout sends the hint only when its `sub` equals the session's identity provider subject, and deletes the cookie whether it sent it or not.
- The hint is added on the Zitadel and the discovered end-session paths; Auth0's `/v2/logout` takes no hint, so its URL stays the same.
- With the flag off nothing is written, and the logout URL is exactly what it was before the flag existed.

Providers differ in how they treat a hint for a session that has already ended there, for example by asking the user to confirm or by showing an error.
An installer therefore turns the flag on only after verifying logout with it against the identity provider it ships.
The flag has no effect unless `NEXT_PUBLIC_AUTH_PROVIDER=oidc`.

### Role Mapping

The role mapping system:

1. Reads the claim specified by `OIDC_ROLE_CLAIM` from the ID token
2. Supports dot-notation for nested claims (e.g., `realm_access.roles`); a top-level claim named exactly `OIDC_ROLE_CLAIM`, such as `https://libredb.org/roles`, is read whole first
3. If the claim value is an array, checks if any element matches `OIDC_ADMIN_ROLES`; if it is an object, as Zitadel's roles claim is, its keys are the role names
4. If the claim value is a string, checks for exact match (case-insensitive)
5. If no match or no claim configured, defaults to `user` role, unless `OIDC_USER_ROLES` is set (see [Requiring a role](#requiring-a-role))

**Examples:**

```json
// Flat string claim: OIDC_ROLE_CLAIM=role
{ "role": "admin" }  →  admin

// Array claim: OIDC_ROLE_CLAIM=roles
{ "roles": ["viewer", "admin"] }  →  admin

// Nested claim: OIDC_ROLE_CLAIM=realm_access.roles
{ "realm_access": { "roles": ["admin"] } }  →  admin

// Object claim: OIDC_ROLE_CLAIM=urn:zitadel:iam:org:project:roles
{ "urn:zitadel:iam:org:project:roles": { "admin": { "1234": "acme.zitadel.cloud" } } }  →  admin

// No match → defaults to user
{ "roles": ["viewer", "editor"] }  →  user
```

### Requiring a role

By default every account the provider signs in is at least a `user`.
Set `OIDC_USER_ROLES` to let in only accounts that hold a role: the claim named by `OIDC_ROLE_CLAIM` must then hold a value of `OIDC_ADMIN_ROLES` or of `OIDC_USER_ROLES`.
An account that holds neither gets no session.
The callback sends it to `/login?error=oidc_no_role`, the login page says "Your account has no role that allows access to LibreDB Studio. Ask your administrator.", and the audit trail records `login_failure` with reason `oidc_no_role` and the account's email, username or subject as the actor.

The values are a comma list, trimmed, and compared case-insensitively.
An account that holds both roles is `admin`.
An empty value, or one of only commas and spaces, keeps the default rule.
`OIDC_USER_ROLES` needs `OIDC_ROLE_CLAIM`: set without it, every sign-in fails with `oidc_config`, because there is no claim to read the roles from.

A flat claim, one top-level claim whose name has no dot, is the simplest shape.
For example, Keycloak client roles `admin` and `user` reach the ID token as the claim `libredb_roles` through a **User Client Role** mapper whose **Client ID** names the client that holds the roles, with **Token Claim Name** `libredb_roles` and with **Multivalued** and **Add to ID token** on:

```env
OIDC_ROLE_CLAIM=libredb_roles
OIDC_ADMIN_ROLES=admin
OIDC_USER_ROLES=user
```

| `libredb_roles` in the ID token | Result |
|---------------------------------|--------|
| `["admin"]` | `admin` |
| `["user"]` | `user` |
| `["user", "admin"]` | `admin` |
| `["viewer"]`, `[]`, or no claim at all | Refused with `oidc_no_role` |

> For the precise algorithm and provider-by-provider worked examples, see the [Role Mapping Engine](#role-mapping-engine) in Part 2.

### Custom seed roles with OIDC_ROLE_PREFIX

In addition to mapping users to the binary `admin` or `user` application role, LibreDB Studio can extract fine-grained team roles from the identity provider and use them to gate access to [seed connections](SEED_CONNECTIONS.md).

When `OIDC_ROLE_PREFIX` is configured (for example, `OIDC_ROLE_PREFIX=team:`):
1. **Extraction**: `mapOIDCClaimRoles()` inspects the claim specified by `OIDC_ROLE_CLAIM`.
2. **Prefix filtering**: Any claim value that starts with `OIDC_ROLE_PREFIX` (case-sensitive) is treated as a candidate custom role.
3. **Reserved roles**: The names `*`, `admin`, and `user` (case-insensitively, e.g. `team:admin` is fine, but bare `admin`, `USER`, or `*` is not) are reserved and never mapped as custom claim roles.
4. **Limits & Overflow**:
   - Up to 20 matching claim roles are allowed per user.
   - Each role name must not exceed 64 bytes in UTF-8.
   - Matching roles are deduplicated and sorted lexicographically.
   - If an account carries more than 20 matching roles or any role exceeding 64 bytes, sign-in fails immediately with error code `oidc_role_overflow` (for all accounts, admins included). No session is created, the audit log records `login_failure` with reason `oidc_role_overflow`, and the user is redirected to `/login?error=oidc_role_overflow` ("Your account has too many roles or a role name is too long. Ask your administrator.").
5. **Session lifecycle**:
   - Extracted claim roles are embedded in the signed session JWT (`claimRoles`).
   - Claim roles are fixed for the lifetime of the session (and any MCP token created from it). When group memberships change in the IdP, the user must sign in again to refresh their roles; for an immediate cut, an administrator can revoke the account's sessions ([Governance mode](#governance-mode)).
6. **Seed connection enforcement**:
   - Seed connections defined with `roles: ["team:analytics", "team:ops"]` will be accessible only to users who hold at least one of those roles (an administrator sees a team seed only when the seed also lists `admin` or `*`).
   - The `/api/connections/managed` endpoint projects only the roles the caller actually holds (plus `*`), preventing the names of other teams' roles from leaking to unauthorized clients.

### Session Identity

A session signed in through OIDC also carries the provider's identifiers for the user, as two private claims of the `auth-token` JWT:

| Claim | Value |
|-------|-------|
| `idpSubject` | The ID token's `sub`, the provider's stable id for the user (for Keycloak, the user id) |
| `idpIssuer` | The ID token's `iss` |

`openid-client` accepts an ID token only when its `iss` is exactly the issuer that discovery at `OIDC_ISSUER` returned, and discovery accepts only an issuer that equals `OIDC_ISSUER` once both are normalized as URLs.
So for a Keycloak realm `idpIssuer` equals `OIDC_ISSUER`, while an issuer that is a bare host, such as Auth0's, ends in a slash that `OIDC_ISSUER` may leave out.
`username` keeps its meaning, for display, rate limiting and, without governance, as the key of the user's saved work: the email, unless the provider marks it unverified (`email_verified` is `false`, or the string `"false"` some providers send), else a `preferred_username` that is not email-shaped, else `sub`.
A provider that sends no `email_verified`, such as Microsoft Entra ID, marks nothing, so its email is taken; there the provider's own control over the `email` claim is what keeps it from being copied.
An unverified email and an email-shaped `preferred_username` are passed over because a provider may let a user set either freely, and `bob@example.com` chosen that way would otherwise open Bob's workspace.
A provider that marks its users' emails unverified, as Keycloak does for an account created without verification, therefore names them by `preferred_username`; set Email verified on those accounts to keep the email.
The registered JWT claims `sub` and `iss` stay unused, because MCP tokens already put the username in `sub`.
Password, passkey and launch sessions carry neither claim.
A session a native client's access token stands for carries both, from the access token ([Bearer access tokens for native clients](#bearer-access-tokens-for-native-clients)).
`GET /api/auth/me` answers with the session payload, so for an OIDC session its `user` object includes `idpSubject` and `idpIssuer`.
An ID token without a string `sub` or `iss` signs no one in: the callback redirects to `/login?error=oidc_no_claims`.

### Governance mode

With `GOVERNANCE_SOURCE=postgres` a control plane decides which databases each person may open ([GOVERNANCE.md](./GOVERNANCE.md#sign-in)), and the identity provider's `sub` is the key that joins a session to that person's grants.
The identity provider is then the only way into Studio, and Studio applies these rules on every request:

- A session counts only when it carries a non-empty `idpSubject` and an `idpIssuer` equal to `OIDC_ISSUER`, the two compared as URLs with one trailing slash ignored.
  Only the OIDC callback and a native client's access token write those claims, so a password, passkey or launch session is refused, and so is a session whose subject is empty or whose issuer is another provider's.
- A refused session's `auth-token` cookie is cleared, so the next page load reaches the sign-in page.
  A changed `OIDC_ISSUER` therefore ends every session of the previous issuer at its next request, and with `OIDC_ISSUER` unset or not a URL no session counts.
- The callback applies the same rule to the ID token before it mints a session: a token with an empty `sub`, or whose `iss` is not `OIDC_ISSUER`, signs no one in and lands on `/login?error=oidc_config`, so `OIDC_AUTO_REDIRECT` never repeats a sign-in that every request would refuse.
- A session issued at or before its subject's `revoked_before` in the control plane's session revocations is refused too, while Studio serves a snapshot of the governance source ([GOVERNANCE.md](./GOVERNANCE.md#sign-in)).
- `POST /api/auth/login` answers 403 with `Password sign-in is disabled: this server signs in through the identity provider only` before it reads a credential, and the audit trail records `login_failure` with reason `password_login_disabled`.

The identity provider needs:

- `OIDC_ISSUER` set to the issuer the provider writes in its ID tokens.
  openid-client accepts another `iss` from Microsoft Entra ID and Azure AD B2C, but governance does not: for Entra ID use the tenant's own `https://login.microsoftonline.com/<tenant id>/v2.0`, never the `common` or `organizations` endpoint, whose tokens name each user's own tenant.
- A confidential client for Studio that uses the authorization code flow with PKCE S256, with the redirect URI `https://<studio>/api/auth/oidc/callback` and the post-logout URI `https://<studio>/login`.
- The roles `admin` and `user` in a flat ID-token claim: an array of strings at the top level of the ID token, named by `OIDC_ROLE_CLAIM`, with `OIDC_ADMIN_ROLES=admin` and `OIDC_USER_ROLES=user`.
  An account that holds neither role is refused as `oidc_no_role` ([Requiring a role](#requiring-a-role)).
- A sign-in whose subject the governance source revoked at or after the current second gets no session and ends on `/login?error=oidc_session_revoked`, because every request would refuse that session (`docs/GOVERNANCE.md#sign-in`).
- No pairwise subject mapper on Studio's client or on the control plane's: both must see the same `sub` for a user, because the control plane writes grants under the `sub` it sees and Studio matches them against the session's `idpSubject`.

For single sign-on with the control plane, set `OIDC_PROMPT=omit` and `OIDC_AUTO_REDIRECT=true` as well.

With Keycloak, the roles come from client roles, because the built-in realm-role mapper writes no ID-token claim by default and its `realm_access.roles` claim is nested:

1. A client `libredb` that only holds the client roles `admin` and `user`, with every flow disabled.
2. A client scope `libredb-roles` with one mapper of type User Client Role: client `libredb`, token claim name `libredb_roles`, multivalued, claim JSON type String, and Add to ID token on.
   Give the scope the role scope mappings `libredb` `admin` and `libredb` `user`, so the claim is written even when a client has Full Scope Allowed off.
3. Studio's client: client authentication on, standard flow only, PKCE method S256, and `libredb-roles` among its default client scopes.
4. Each user assigned the `libredb` client role `admin` or `user`, directly or through a group.

```env
OIDC_ROLE_CLAIM=libredb_roles
OIDC_ADMIN_ROLES=admin
OIDC_USER_ROLES=user
```

### Bearer access tokens for native clients

A native client, such as a mobile app, signs in to the identity provider itself, as a public client with the authorization code flow and PKCE, and refreshes its own tokens.
It then calls Studio's API with `Authorization: Bearer <access token>`, and Studio accepts that token as a session when `OIDC_BEARER_AUDIENCE` is set.
Unset, the default, Studio ignores the `Authorization` header outside `/api/mcp`, as it always has.

```env
NEXT_PUBLIC_AUTH_PROVIDER=oidc
OIDC_BEARER_AUDIENCE=libredb-studio-api
OIDC_BEARER_CLIENT_IDS=libredb-mobile
```

Studio accepts an access token only when all of these hold:

- It is a JWT signed with an asymmetric key (RS, PS, ES or EdDSA) from the `jwks_uri` of `OIDC_ISSUER`'s discovery document; `none` and every HS algorithm are refused.
- Its `iss` equals `OIDC_ISSUER`, compared as URLs with one trailing slash ignored, and its `aud` contains `OIDC_BEARER_AUDIENCE`.
- Its `exp` is in the future and its `nbf`, when present, in the past, with 30 seconds of clock tolerance; `iat` is required.
- It is not an ID token: its `aud` does not contain `OIDC_CLIENT_ID`, it carries no `nonce`, `at_hash` or `c_hash`, Keycloak's `typ` claim is not `ID`, and its `typ` header is absent, `JWT` or `at+jwt`.
  For the same reason `OIDC_BEARER_AUDIENCE` equal to `OIDC_CLIENT_ID` is a configuration error.
- With `OIDC_BEARER_CLIENT_IDS` set, its `azp`, else its `client_id`, is one of them.
- It carries a non-empty `sub`, and a username under the rule of [Session Identity](#session-identity): an `email` the provider does not mark unverified, else a `preferred_username` that is not email-shaped; there is no fallback to `sub`, because `username` keys the user's saved work, so a token that named the person differently would open a second, empty workspace.
  The provider must put the claim the ID token carries in the access token too.
- `OIDC_ROLE_CLAIM`, `OIDC_ADMIN_ROLES` and `OIDC_USER_ROLES` map a role from the access token's claims, as at sign-in.
  With `OIDC_USER_ROLES` unset every holder of a token for the audience is at least a `user`, so set `OIDC_BEARER_CLIENT_IDS`, `OIDC_USER_ROLES`, or both.

Opaque access tokens and token introspection are not supported: the provider must issue JWT access tokens.
Google's access tokens are opaque, so Google cannot be used for this.

How Studio answers:

- A Bearer header decides alone on an API path that needs a session, even next to a valid cookie: a refused token answers `401` with `{"error":"Invalid access token","code":"AUTH_REQUIRED"}` and `WWW-Authenticate: Bearer error="invalid_token"`, never a redirect.
  Any other scheme, such as the `Basic` credentials a reverse proxy's basic authentication forwards, is ignored and the cookie decides.
- A token that verifies but whose account Studio refuses answers `403`, with code `BEARER_NO_ROLE` when its claims map to no role and `BEARER_NO_IDENTITY` when it carries no `sub` or no username under the rule above.
  A fresh token for the same account is refused the same way until an administrator changes the account, so a client shows the refusal instead of refreshing.
- The public routes that read a session, `GET /api/auth/me`, `POST /api/auth/logout` and `POST /api/db/health`, decide the header the same way.
  The other routes under `/api/auth/` never read it, so a client holding an expired token can still sign in.
- A `POST` that carries no `Origin` header passes the cross-site request check only with `Content-Type: application/json`, so a native client sends that header on every `POST`, the sign-out included.
- A provider whose discovery document or key set cannot be read answers `503` with code `IDENTITY_PROVIDER_UNAVAILABLE`, so a client keeps its token and retries instead of signing the user out.
- A page never takes a bearer, and no CORS header is added: the channel is for native clients, not for another web origin.
- `GET /api/auth/me` answers the session, with `idpSubject`, `idpIssuer`, the token's `iat` and `exp`, and `channel: "bearer"`.
- `POST /api/auth/logout` answers `{"success":true}` with no `redirectUrl` and sets no cookie; the client discards its tokens and ends the provider session itself.
  A refused token answers `401` with the challenge instead, so a client can refresh and record the sign-out.
- `GET /api/connections/managed` never sends a bearer session a connection's credentials, an editable seed's included.
- `POST /api/mcp/token` refuses a bearer session with `403`: an MCP token is created from a browser session only.
- A refusal is audited as `permission_denied` with reason `bearer_token_invalid`, `bearer_no_role` or `bearer_no_identity`.
  A bearer request writes no `login_success`, because the sign-in happened at the provider.
- Under [governance](#governance-mode) the access token's `sub`, `iss` and own `iat` go through the same rule as a session cookie's, so a subject's `revoked_before` ends the access tokens issued before it.
  A provider that issues pairwise subjects per client, such as Microsoft Entra ID, gives the native client a different `sub` than the web sign-in, and grants written for one do not match the other.
- An operator who turns the channel on behind a reverse proxy that injects its own `Authorization: Bearer` header must strip that header at the proxy.

With Keycloak:

1. A public client for the app, for example `libredb-mobile`: client authentication off, standard flow only, PKCE method S256, and the app's redirect URI.
2. An Audience mapper on that client's dedicated scope, with Included Custom Audience `libredb-studio-api` and Add to access token on, so the token's `aud` names the audience.
3. The role claim in the access token: realm roles are at `realm_access.roles` by default, so `OIDC_ROLE_CLAIM=realm_access.roles` reads them, as for the web sign-in.
   Under governance the roles come from the `libredb_roles` mapper described above, so turn on its Add to access token as well.

---

## Security Features

| Feature | Description |
|---------|-------------|
| **PKCE S256** | Proof Key for Code Exchange prevents authorization code interception |
| **State Cookie** | PKCE state signed as a JWT with a key derived from `JWT_SECRET` for this purpose, httpOnly, sameSite=lax, 5-min expiry |
| **Prompt Login** | `prompt=login` (the default) forces re-authentication on every SSO click; `OIDC_PROMPT=omit` turns it off for single sign-on |
| **Provider Logout** | Logout clears both local JWT and provider session |
| **Discovery Cache** | OIDC provider metadata cached for 5 minutes to reduce network calls |
| **Nonce Validation** | ID token nonce validated to prevent replay attacks |
| **Return Path** | When a session ends mid-use, an API call answers `401` `AUTH_REQUIRED` and the tab goes to `/login?next=<page>`. `Login with SSO` passes `next` to `/api/auth/oidc/login`, which keeps it in the signed state cookie; the callback lands there instead of `/` or `/admin`. Only an app-relative path is kept, judged on the path it resolves to (`/..//host` resolves to `//host` and is refused), at most 1024 UTF-8 bytes so the state cookie stays within the browser limit, and checked on the way in and again on the way out, so a crafted sign-in link cannot redirect off the deployment |

> See the [Security Model](#security-model) in Part 2 for the underlying threat model and implementation detail.

---

## Troubleshooting

### Login redirects back to `/login` without error

- Check that your OIDC issuer URL is correct and serves `/.well-known/openid-configuration`
- Verify `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` match your provider configuration
- Check server logs for token exchange errors

### "Single sign-on is not configured correctly on this server"

- `GET /api/auth/oidc/login` found the deployment incomplete: one of `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` is unset or the issuer is not `https://` (both checked before any network call), or the JWT secret the state cookie is signed with is missing or too short (checked after discovery, when the cookie is signed)
- In [governance mode](#governance-mode), the callback received an ID token with an empty `sub` or with an `iss` other than `OIDC_ISSUER`; the server log names the rule
- The audit trail records `login_failure` with reason `oidc_config`. Trying again cannot help until the environment is fixed

### "The identity provider could not be reached"

- The configuration was complete as far as Studio can tell up front (only the scheme is checked), but discovery against `OIDC_ISSUER/.well-known/openid-configuration` failed: the host does not resolve (a mistyped `OIDC_ISSUER` host lands here too), TLS verification failed, or the response is not JSON or names a different issuer
- The audit trail records `login_failure` with reason `oidc_discovery`. The server log line `OIDC login error` carries the underlying message, which is deliberately never shown on the login page

### Plain-http issuer

- **Not supported.** `openid-client` refuses it, on `localhost` too, with `only requests to HTTPS are allowed`, so Studio checks the scheme up front and reports a non-`https://` issuer as the configuration error it is. Studio wires no insecure-transport switch (openid-client's `allowInsecureRequests` is deliberately not exposed), because a switch that exists is a switch someone will eventually set in production
- To test against a local IdP, give it TLS: for Keycloak, run `start-dev --https-certificate-file=... --https-certificate-key-file=...` with a self-signed certificate, point `OIDC_ISSUER` at `https://localhost:8443/realms/<realm>`, and start Studio with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` so Node trusts it

### "Authentication failed" error on login page

- The callback received an error from the provider. Check that the callback URL is registered correctly in your provider
- Ensure the client secret hasn't expired

> The `?error=<code>` query param distinguishes failure causes. See [Error Handling](#error-handling) in Part 2 for the full error code table.

### Same user auto-logs in on every SSO click

- With the default `OIDC_PROMPT=login`, LibreDB Studio sends `prompt=login` to force re-authentication
- With `OIDC_PROMPT=omit` this is intended: the provider session signs the user in (single sign-on)
- If the issue persists, check your provider's session settings

### "Your account has no role that allows access to LibreDB Studio"

- `OIDC_USER_ROLES` is set, and the account's ID token holds no value of `OIDC_ADMIN_ROLES` or `OIDC_USER_ROLES` in the claim `OIDC_ROLE_CLAIM` names.
- Give the account an admin or a user role at the provider, directly or through a group the provider puts in that claim, and sign in again.
- The audit trail records `login_failure` with reason `oidc_no_role` and names the account, so the record shows whose role is missing.
- Use your provider's token debugger to see the claim it actually sends.

### Role is always "user" even for admins

- For Keycloak, first verify **Client scopes → roles → Mappers → realm roles → Add to ID token** is enabled and saved (verified on Keycloak 26.4)
- Verify `OIDC_ROLE_CLAIM` points to the correct claim in your ID token
- Use your provider's token debugger to inspect the actual claims returned
- Check `OIDC_ADMIN_ROLES` matches the role value exactly (case-insensitive)
- For nested claims, use dot-notation: `realm_access.roles` not `realm_access/roles`

### Logout doesn't clear provider session

- The return URL must be registered with the provider, or it rejects the redirect: Auth0 "Allowed Logout URLs", Keycloak "Valid post logout redirect URIs", Azure AD "Front-channel logout URL"
- Keycloak / Okta / Azure AD: the logout endpoint comes from the provider's own Discovery metadata, so no per-provider configuration is needed on Studio's side
- If the provider advertises no `end_session_endpoint` (Google, for one), the provider session survives on purpose — Studio clears its own cookie and skips the redirect. Signing in again still prompts, because Studio sends `prompt=login` unless `OIDC_PROMPT` says otherwise

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

---

# Part 2 — Architecture & Internals

> Developer reference for the OIDC authentication subsystem in LibreDB Studio.
> For user-facing setup instructions, see [Part 1 — Setup Guide](#part-1--setup-guide).

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
| `src/app/login/login-form.tsx` | ~320 | Login UI: conditional SSO button vs email/password form (`page.tsx` is a thin wrapper that reads `NEXT_PUBLIC_AUTH_PROVIDER` and renders it) |
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
    │                            │     ├─ admin or user              │
    │                            │     └─ neither (OIDC_USER_ROLES   │
    │                            │        set): no session, 302 →    │
    │                            │        /login?error=oidc_no_role  │
    │                            │                                   │
    │                            │ 14. login(role, email)            │
    │                            │     └─ signJWT → auth-token cookie│
    │                            │                                   │
    │                            │ 15. Delete oidc-state cookie      │
    │                            │                                   │
    │  16. Set-Cookie: auth-token│                                   │
    │◄── 302 → return_to, else / or /admin                           │
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
    │                            │     await buildLogoutUrl(…)│
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
  userRoles: string[];     // e.g. ["user"]; empty (the default) keeps "every non-admin is user"
  prompt: OIDCPrompt;      // "login" (default), "consent", "select_account" or "omit" (OIDC_PROMPT)
}

interface OIDCState {
  code_verifier: string;   // PKCE random bytes (base64url)
  state: string;           // CSRF protection random
  nonce: string;           // Replay protection random
  return_to?: string;      // App-relative page to land on after sign-in, when the session ended there
}

interface OIDCClaims {
  sub: string;                  // Subject identifier
  iss: string;                  // Issuer, checked by openid-client against discovery
  email?: string;
  preferred_username?: string;  // Used by Keycloak and others; username fallback
  [claim: string]: unknown;     // Provider-specific claims
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

mapOIDCRole(claims, roleClaim, adminRoles, userRoles = [])
                                             ← pure function, no deps; "admin", "user" or null

encryptState(data) / decryptState(token)     ← jose JWT sign/verify

buildLogoutUrl(returnTo)                     ← reads config; generic branch calls discoverProvider()
```

#### Discovery Cache

```typescript
// In-memory, module-level singleton
let cachedConfig: client.Configuration | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// discoverProvider() checks:
const now = Date.now();
if (cachedConfig && now < cacheExpiry) {
  return cachedConfig; // Cache hit
}
// Otherwise: fetch /.well-known/openid-configuration, then set cacheExpiry = now + CACHE_TTL

// resetDiscoveryCache() — exposed for testing
```

The cache prevents hitting the provider's discovery endpoint on every login. 5-minute TTL balances freshness with performance. The cache is process-level (shared across all requests in the same Next.js server instance).

### `src/lib/auth.ts`

The JWT session layer is completely auth-mode agnostic:

```typescript
// Same function called by every sign-in route; only the OIDC callback passes an identity:
export async function login(role: Role, username?: string, sessionVersion?: number, identity?: { subject: string; issuer: string }) {
  const idp = identity ? { idpSubject: identity.subject, idpIssuer: identity.issuer } : {};
  const token = await signJWT({ role, username: username || role, sessionVersion, ...idp });
  const cookieStore = await cookies();
  cookieStore.set('auth-token', token, {
    httpOnly: true,
    secure: await shouldMarkCookieSecure(),
    sameSite: 'lax',
    maxAge: sessionTtlSeconds(),     // AUTH_SESSION_TTL_SECONDS, 24 hours when unset
    path: getBasePath() || '/',
  });
}
```

`shouldMarkCookieSecure()` also decides the flag on the `oidc-state` cookie, so both cookies of the flow always agree. It resolves in this order:

1. `AUTH_COOKIE_SECURE` when set (`on`/`true`/`1` vs `off`/`false`/`0`) — the operator's explicit answer, needed when the browser itself reaches the app over plain HTTP on a non-loopback host (LAN or home server). TLS terminated at an ingress does not need it: the browser still speaks HTTPS. On the Helm chart this is `config.authCookieSecure` (three-state; unset leaves this default in place), added in chart 0.1.52.
2. Off outside production.
3. Off for a request that arrived on a loopback host over plain HTTP — WebKitGTK's cookie store discards a `Secure` cookie delivered over HTTP, which would break the desktop shell (issue #232). A proxy that forwarded HTTPS to loopback still gets the flag, via `x-forwarded-proto`.
4. On otherwise.

The optional `username` parameter was added for OIDC: local login passes the email, while the OIDC callback resolves it with `oidcUsername()` (`src/lib/oidc-identity.ts`), falling back to `claims.sub`, then the role: the email unless `email_verified` is `false`, else a `preferred_username` without an `@` (so a username is always set regardless of which claims the provider returns, and never one a user could copy from someone else).

The optional `identity` is passed only by the OIDC callback, as `{ subject: claims.sub, issuer: claims.iss }`, and becomes the private claims `idpSubject` and `idpIssuer` described under [Session Identity](#session-identity).
Every other caller passes none, so password, passkey and launch sessions sign exactly `role`, `username` and `sessionVersion`.

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
│  Value: JWT (HS256, key derived from        │
│         JWT_SECRET, typ                     │
│         libredb-oidc-state+jwt)             │
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
- JWT signing with a key derived from `JWT_SECRET` provides integrity verification without needing server-side storage
- The key is HMAC-SHA256(`JWT_SECRET`, `libredb.oidc.state.v1`) and the header pins `typ: libredb-oidc-state+jwt`, the same purpose-derived key convention the other non-session tokens follow
- The 5-minute expiry prevents stale state cookies from accumulating

> **`JWT_SECRET` is mandatory for OIDC state signing: no development fallback.** Secret reading is centralized in `src/lib/config/auth-env.ts`. The state signer calls `derivedSigningKey(label, { allowDevFallback: false })`, so a missing `JWT_SECRET` throws in *every* environment (unlike `auth.ts`, which permits a dev fallback outside production). A `JWT_SECRET` shorter than 32 characters is rejected everywhere, and rejected earliest of all at boot: `src/lib/config/auth-preflight.ts` exits the process with code 1 on a standalone start, so the misconfiguration surfaces in the server log instead of only in the first login attempt (issue #227). This is why an OIDC deployment must always set a real `JWT_SECRET` (zero-config boot generates one automatically).

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
│    exp: <now + AUTH_SESSION_TTL_SECONDS>    │
│  }                                          │
│                                             │
│  Cookie flags:                              │
│    httpOnly: true                           │
│    secure: true (production)                │
│    sameSite: lax                            │
│    maxAge: AUTH_SESSION_TTL_SECONDS         │
│    path: /                                  │
└─────────────────────────────────────────────┘
```

An OIDC session's payload also carries `idpSubject` and `idpIssuer`, described under [Session Identity](#session-identity).

#### Session lifetime

`AUTH_SESSION_TTL_SECONDS` sets both the token's `exp` and the cookie's `maxAge`.
It accepts a whole number of seconds from 300 to 86400, and unset keeps 86400 (24 hours).
Any other value stops a standalone start at boot with a banner naming the variable, rather than failing every login.

The session token carries the role it was issued with, so a role removed at the identity provider keeps working until the session expires.
A shorter lifetime bounds that window.
Paired with silent single sign-on, where the login page goes straight to the provider and the provider's own session signs the user in without a prompt, an expired Studio session renews itself and picks up the current role, so a short lifetime costs the user nothing.
The governance install sets `AUTH_SESSION_TTL_SECONDS=28800` (8 hours).

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
With `OIDC_USER_ROLES` set it can also find that an account holds neither role, and the callback then refuses the sign-in.

Studio reads role claims from the ID token returned by the authorization-code exchange; it does not read the access token.

### Algorithm (`mapOIDCRole`)

```
Input: claims object, roleClaim path, adminRoles list,
       userRoles list (OIDC_USER_ROLES, empty unless set)

0. unmatched = "user" when userRoles is empty (the default), null when it is set

1. If roleClaim is empty → return unmatched

2. Find the claim value:
   a. A top-level claim named exactly roleClaim → its value
      "https://libredb.org/roles" → claims["https://libredb.org/roles"]
   b. Otherwise navigate the claim path (dot-notation):
      "realm_access.roles" → claims["realm_access"]["roles"]
   A missing value, or a step through a non-object → return unmatched

3. Get claim values:
   a. If Array → its elements, as strings
   b. If Object → its keys (Zitadel: role name → organizations)
   c. Otherwise → the value, as a string

4. Any value matches adminRoles (case-insensitive) → "admin",
   so admin wins when the claim holds both roles

5. Any value matches userRoles (case-insensitive) → "user", otherwise → unmatched

The callback refuses null: no session, a login_failure audit record with
reason oidc_no_role, and a redirect to /login?error=oidc_no_role.
```

### Examples

```
Provider: Auth0
Claims:   { "https://libredb.org/roles": ["admin", "viewer"] }
Config:   OIDC_ROLE_CLAIM=https://libredb.org/roles
          OIDC_ADMIN_ROLES=admin
Result:   "admin" ✓ (top-level claim read whole; array contains "admin")

Provider: Keycloak
Claims:   { "realm_access": { "roles": ["offline_access", "uma_authorization", "admin"] } }
Config:   OIDC_ROLE_CLAIM=realm_access.roles
          OIDC_ADMIN_ROLES=admin
Result:   "admin" ✓ (dot-notation navigates nested object)

Provider: Zitadel
Claims:   { "urn:zitadel:iam:org:project:roles": { "admin": { "1234": "acme.zitadel.cloud" } } }
Config:   OIDC_ROLE_CLAIM=urn:zitadel:iam:org:project:roles
          OIDC_ADMIN_ROLES=admin
Result:   "admin" ✓ (object claim: its keys are the role names)

Provider: Okta
Claims:   { "groups": ["Everyone", "Engineering"] }
Config:   OIDC_ROLE_CLAIM=groups
          OIDC_ADMIN_ROLES=admin,Admin
Result:   "user" ✗ (no match in groups array)

Provider: Google
Claims:   { "sub": "123", "email": "user@gmail.com" }
Config:   OIDC_ROLE_CLAIM=  (empty)
Result:   "user" (no claim configured, default)

Provider: Keycloak, client roles in a flat claim
Claims:   { "libredb_roles": ["viewer"] }
Config:   OIDC_ROLE_CLAIM=libredb_roles
          OIDC_ADMIN_ROLES=admin
          OIDC_USER_ROLES=user
Result:   null (neither role: refused as oidc_no_role, no session)
```

### Claim Roles Mapping (`mapOIDCClaimRoles`)

When `OIDC_ROLE_PREFIX` is set, the callback invokes `mapOIDCClaimRoles(claims, prefix, roleClaim)` alongside `mapOIDCRole()`:

```
Input: claims object, prefix string, roleClaim path

1. Read values from roleClaim (same dot-notation navigation as mapOIDCRole).
2. Filter values:
   a. Value must be a string.
   b. Value must start with prefix (case-sensitive check).
   c. Lowercased value must not equal "*", "admin", or "user".
3. Validate limits:
   a. If any matching role byte length > 64 bytes (UTF-8) → return { roles: [], overflow: true }
   b. Deduplicate matching roles.
   c. If deduplicated count > 20 → return { roles: [], overflow: true }
4. Return { roles: sortedDeduplicatedRoles, overflow: false }
```

If `overflow` is true, the callback halts authentication:
- State cookie is cleared.
- A `login_failure` audit event is emitted with reason `oidc_role_overflow`.
- Redirects to `/login?error=oidc_role_overflow`.

---

## Provider Logout Strategy

Different OIDC providers have different logout endpoint conventions. `buildLogoutUrl()` preserves the existing Auth0
and Zitadel integrations, then uses the provider's discovered `end_session_endpoint` for generic OIDC:

```typescript
async function buildLogoutUrl(returnTo: string): Promise<string | null> {
  const config = getOIDCConfig();
  const issuerUrl = new URL(config.issuer);
  const roleClaim = config.roleClaim;

  // Auth0: /v2/logout?client_id=xxx&returnTo=xxx
  if (issuerUrl.hostname === 'auth0.com' || issuerUrl.hostname.endsWith('.auth0.com')) {
    const logoutUrl = new URL('/v2/logout', config.issuer);
    logoutUrl.searchParams.set('client_id', config.clientId);
    logoutUrl.searchParams.set('returnTo', returnTo);
    return logoutUrl.toString();
  }

  // Zitadel RP-Initiated Logout — detected via the role claim (urn:zitadel:...)
  if (roleClaim.includes('zitadel')) {
    const logoutUrl = new URL('/oidc/v1/end_session', config.issuer);
    logoutUrl.searchParams.set('client_id', config.clientId);
    logoutUrl.searchParams.set('post_logout_redirect_uri', returnTo);
    return logoutUrl.toString();
  }

  // Generic OIDC RP-Initiated Logout
  const discovered = await discoverProvider(config);
  const logoutUrl = client.buildEndSessionUrl(discovered, {
    post_logout_redirect_uri: returnTo,
  });
  return logoutUrl.toString();
}
```

> **Note:** Zitadel is detected by its role-claim URN (`OIDC_ROLE_CLAIM` containing `zitadel`), not by hostname — so its `/oidc/v1/end_session` endpoint is selected automatically when you configure Zitadel roles.

### Provider Logout Endpoints

> **What `buildLogoutUrl()` actually implements:** **Auth0** and **Zitadel** retain their existing special cases. Every
> other issuer uses the `end_session_endpoint` advertised by OIDC Discovery. Providers that do not advertise this
> metadata complete the local logout without a provider redirect. **Google is a real example of that last
> case** — its discovery document carries no `end_session_endpoint`, so signing out of Studio deliberately
> leaves the Google session alone (the next sign-in still prompts, because Studio always sends `prompt=login`).
>
> The request carries `post_logout_redirect_uri` and the `client_id` that `openid-client` adds; it does **not**
> carry `id_token_hint`, because Studio never persists the ID token. Providers that require `id_token_hint`
> for RP-initiated logout will reject the redirect — that is the one case the ✅ column below does not cover.

| Provider | Native Endpoint | Return Param | Wired? |
|----------|-----------------|--------------|--------|
| **Auth0** | `{issuer}/v2/logout` | `returnTo` | ✅ special-cased |
| **Zitadel** | `{issuer}/oidc/v1/end_session` (auto-detected via role claim) | `post_logout_redirect_uri` | ✅ special-cased |
| **Keycloak** | Discovery `end_session_endpoint` (typically `{issuer}/protocol/openid-connect/logout`) | `post_logout_redirect_uri` | ✅ discovery metadata |
| **Azure AD** | Discovery `end_session_endpoint` (measured: `{login.microsoftonline.com}/common/oauth2/v2.0/logout`) | `post_logout_redirect_uri` | ✅ discovery metadata |
| **Okta** | Discovery `end_session_endpoint` | `post_logout_redirect_uri` | ⚠️ endpoint is used, not probed against a live tenant — org authorization servers may require `id_token_hint` |
| **Google** | none advertised | — | ⚠️ local logout only, by design |

### Extension Point

Standards-compliant providers need no logout-specific code. If a provider does not advertise `end_session_endpoint`
and requires a non-standard endpoint, add a provider-specific case before the generic Discovery branch.

---

## Error Handling

### Error Codes

Both OIDC routes redirect to `/login?error=<code>` on failure, and record the same code as the `reason` of a `login_failure` audit event. Classification is by error type (`instanceof AuthConfigError`), never by matching on `error.message`.

| Error Code | Route | Cause | When |
|------------|-------|-------|------|
| `oidc_config` | login, callback | `AuthConfigError`, or the governed sign-in rule | Missing `OIDC_*` env vars, a non-`https://` issuer, or a missing/too-short JWT secret; in governance mode also an ID token with an empty `sub` or an `iss` other than `OIDC_ISSUER` |
| `oidc_discovery` | login | Any other error before discovery answered | Issuer does not resolve, TLS failure, response is not JSON or names a different issuer |
| `oidc_state_missing` | callback | `oidc-state` cookie not found | Cookie expired (>5 min) or blocked by browser |
| `oidc_state_invalid` | callback | State decryption failed or state mismatch | Tampered cookie, wrong JWT_SECRET, or CSRF attempt |
| `oidc_no_claims` | callback | Token exchange returned no claims, or no string `sub` or `iss` | Provider returned invalid/empty ID token |
| `oidc_no_role` | callback | `mapOIDCRole()` returned null: `OIDC_USER_ROLES` is set and the role claim holds no admin or user role | The account has no role at the provider; no session is created, and the audit record names the account |
| `oidc_role_overflow` | callback | `mapOIDCClaimRoles()` returned overflow: matching roles exceed 20 or any role exceeds 64 bytes in UTF-8 | The account carries too many or excessively long roles; no session is created, and the audit record names the account |
| `oidc_session_revoked` | callback | Governance mode only: the subject's latest `revoked_before` is at or after the current second | The control plane ended the account's sessions with a revocation that still applies, such as one dated ahead of Studio's clock; no session is created, and the audit record names the account |
| `oidc_failed` | login, callback | Any other error after the provider answered | A discovery document that parses but lacks an endpoint, PKCE or state-cookie failure on login; network error, invalid client credentials, etc. on callback |

### Login Page Error Display

`login/login-form.tsx` reads the `?error=` code and renders one fixed sentence per class through `oidcErrorMessage()`:

| Code | Message |
|------|---------|
| `oidc_config` | Single sign-on is not configured correctly on this server. Contact your administrator. |
| `oidc_discovery` | The identity provider could not be reached. Try again later, or contact your administrator if this continues. |
| `oidc_no_role` | Your account has no role that allows access to LibreDB Studio. Ask your administrator. |
| `oidc_role_overflow` | Your account has too many roles or a role name is too long. Ask your administrator. |
| `oidc_session_revoked` | An administrator has ended your sessions. Try again later, or ask your administrator. |
| anything else | Authentication failed. Please try again. |

The page is unauthenticated, so it is never given the underlying error: the code names the class and nothing the issuer said reaches the browser. `tests/components/LoginPageOIDC.test.tsx` asserts the negative.

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
| **Discovery-based generic logout with Auth0/Zitadel compatibility branches** | Uses the provider-advertised `end_session_endpoint` without changing the existing special integrations | Deriving a logout path from the issuer fails when the issuer contains a path or the provider uses a different endpoint |
| **Module-level discovery cache** | Fast (avoids HTTP on every login), simple, process-scoped | Redis cache: overkill for single-instance deployments. No cache: 200-500ms per login |
| **Binary role model (admin/user)** | Matches existing RBAC, simple to map from any claim format | Fine-grained roles: would require schema changes in JWT, proxy, and all components |
| **`OIDC_USER_ROLES` refuses an account with neither role, off unless set** | A deployment that grants access through provider roles must be able to turn away an account the provider authenticates but never gave a role; unset, every non-admin is a `user`, so existing deployments see no change | Refusing every non-admin by default: locks out every deployment that relies on the default `user` role |
