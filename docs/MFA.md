# Two-Factor Authentication (TOTP) — LibreDB Studio

LibreDB Studio can require a time-based one-time password (TOTP) after the password on the **local**
auth provider. It is opt-in per account, configured entirely through environment variables, and
verified against RFC 6238 — so any standard authenticator app works: Google Authenticator, Authy,
1Password, Bitwarden, Aegis, KeePassXC, and the rest.

> **Using SSO instead?** For most teams that is the better answer: under
> `NEXT_PUBLIC_AUTH_PROVIDER=oidc` the login page shows no password form, and your identity
> provider already enforces MFA, passkeys, device trust and conditional access — Studio consumes
> the result. See [`docs/OIDC.md`](OIDC.md). Note that switching to OIDC does not *disable*
> `POST /api/auth/login`; see [Running both](#running-both) below.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
  - [Running both](#running-both)
- [Deploying with Docker](#deploying-with-docker)
- [Deploying with Helm](#deploying-with-helm)
- [How it works](#how-it-works)
- [Rate limiting and lockout](#rate-limiting-and-lockout)
- [Troubleshooting](#troubleshooting)
- [What this does and does not protect](#what-this-does-and-does-not-protect)

---

## Quick Start

### 1. Generate a secret

A TOTP secret is base32 (RFC 4648: the letters `A`–`Z` and the digits `2`–`7`). 160 bits is what
RFC 4226 recommends:

```bash
openssl rand 20 | base32 | tr -d '='
# => JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
```

`base32` comes with GNU coreutils. On a machine without it, any authenticator app can generate a
secret for you — create a manual entry and copy the key it shows.

### 2. Set it on the account

```env
NEXT_PUBLIC_AUTH_PROVIDER=local
ADMIN_EMAIL=admin@libredb.org
ADMIN_PASSWORD=your_secure_admin_password
ADMIN_TOTP_SECRET=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
```

Restart the server. The variable is read per login attempt, so nothing is cached across a restart.

### 3. Enrol the secret in your authenticator

Add a manual (key-based) entry with:

| Field | Value |
|---|---|
| Account | your admin email |
| Key | the secret from step 1 |
| Type | Time-based |
| Digits | 6 |
| Period | 30 seconds |
| Algorithm | SHA-1 |

Those are every app's defaults, so in practice you only paste the key.

Prefer to scan a QR code? Build the standard URI yourself and render it with any offline QR tool —
Studio does not mint one, because doing so would mean the server handing the shared secret back
over HTTP after startup:

```
otpauth://totp/LibreDB%20Studio:admin@libredb.org?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=LibreDB%20Studio
```

### 4. Sign in

Enter your email and password as usual. The form then asks for the 6-digit code, and the session is
created only once that code verifies.

---

## Configuration Reference

| Variable | Required | Description |
|---|---|---|
| `ADMIN_TOTP_SECRET` | No | Base32 secret for the admin account. Absent or empty = no second factor. |
| `USER_TOTP_SECRET` | No | Base32 secret for the optional non-admin account. Inert unless `USER_PASSWORD` is also set — with no password there is no user account to protect. |

**Formatting is forgiving, content is not.** Lowercase, spaces, hyphens and `=` padding are all
normalized away, so you can paste a secret exactly as your password manager displays it. A value
containing anything outside the base32 alphabet is a **misconfiguration, not a disabled factor**:
login stops with a `503` naming the offending variable, rather than silently letting the password
through or rejecting every correct code. To turn MFA off, blank or unset the variable.

Each account is independent — protect the admin and leave an automation-owned user account on a
password alone if that is what you need.

### Running both

`NEXT_PUBLIC_AUTH_PROVIDER=oidc` changes what the login page renders; it does not disable
`POST /api/auth/login`. If a deployment sets `ADMIN_PASSWORD` *and* runs OIDC, that route remains a
working way in — one that never touches your identity provider, and so never meets the MFA policy
you configured there. Two ways to close it, and they compose:

- Leave `ADMIN_PASSWORD` unset under OIDC. Nothing generates it in OIDC mode, and with no password
  the route can only answer `503`.
- Set `ADMIN_TOTP_SECRET` anyway. These variables are honoured in every mode, so the local route
  keeps a second factor even when the intended path is SSO.

---

## Deploying with Docker

```bash
docker run -d -p 3000:3000 \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  -e ADMIN_PASSWORD=your_secure_admin_password \
  -e ADMIN_TOTP_SECRET=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP \
  ghcr.io/libredb/libredb-studio:latest
```

Prefer a file or a secret store over an inline `-e` for the secret itself: anything on the command
line is visible to `docker inspect` and to the shell history of whoever ran it.

---

## Deploying with Helm

The chart carries the secret in its Kubernetes `Secret` and references it from the pod, so the value
never appears in the Deployment spec:

```bash
helm install libredb-studio oci://ghcr.io/libredb/charts/libredb-studio \
  --set secrets.adminPassword=MyAdmin123 \
  --set secrets.adminTotpSecret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
```

Bringing your own Secret works too — add the keys `admin-totp-secret` and `user-totp-secret`
(rename them through `secrets.existingSecretKeys`) to the Secret named by `secrets.existingSecret`.
Both references are optional, so an existing Secret that predates this feature keeps working
untouched.

Do not use `extraEnv` for this. It writes the literal secret into the Deployment's pod spec, where
anyone with `get deployments` can read it — a wider audience than the password it protects.

---

## How it works

```
Browser → POST /api/auth/login {email, password}
Server  → password verified (constant time) → account has a TOTP secret
Server  → 401 {mfaRequired: true}          ← no session is created
Browser → POST /api/auth/login {email, password, totp}
Server  → code verified → step marked spent → JWT session cookie
```

| Parameter | Value |
|---|---|
| Algorithm | HMAC-SHA-1 (RFC 6238 §1.2 default; the only algorithm apps interoperate on for a bare `otpauth` URI) |
| Digits | 6 |
| Period | 30 seconds |
| Accepted skew | ±1 step, so a code stays usable for up to 90 seconds |
| Replay | An accepted `(account, step)` pair is spent and cannot be reused (RFC 6238 §5.2) |

Verification lives in [`src/lib/totp.ts`](../src/lib/totp.ts) with no third-party dependency: HOTP is
a truncated HMAC and base32 is a 32-character alphabet, and the one code path that exists to raise
the cost of a compromise is a poor place to add supply-chain surface.

SHA-1 here is correct and must not be "upgraded". The construction's security rests on HMAC, which
does not depend on the collision resistance SHA-1 lost, and changing it would break every
authenticator app.

---

## Rate limiting and lockout

Being **asked** for a code costs nothing — it is the first half of a two-request flow, not a failed
attempt, so ordinary logins never eat into your budget.

Submitting a **wrong** code does count, against both login buckets: `RATE_LIMIT_LOGIN_MAX` (5 per
5 minutes, per client address) and `RATE_LIMIT_LOGIN_ACCOUNT_MAX` (20 per 5 minutes, per account).
Guessing a 6-digit code is therefore bounded to a few dozen tries per window against roughly a
million values.

Locked out of your own account? The secret is an environment variable, so recovery is the same as
for a lost password: blank `ADMIN_TOTP_SECRET` and restart. There are no recovery codes, and none
are needed — whoever can restart the server already holds the stronger credential.

---

## Troubleshooting

**"Invalid authentication code" for every code.** Almost always clock drift on the server: TOTP is a
function of the current time, and the accepted window is ±30 seconds. Check the host clock
(`timedatectl status`, or the node's NTP state) rather than re-enrolling.

**"Invalid authentication code" for a code that just worked.** Each code is single-use. Wait for the
next one rather than resubmitting the same digits.

**A 503 naming `ADMIN_TOTP_SECRET` or `USER_TOTP_SECRET`.** The value is not valid base32. Copy it
again from the authenticator app — `0`, `1`, `8` and `9` are not in the alphabet, and a secret
containing them was mistyped.

**The code field never appears.** The account has no secret configured, or the deployment is running
`NEXT_PUBLIC_AUTH_PROVIDER=oidc`, where these variables are ignored.

**Nothing happens after a correct code.** Check for a `429`: the client bucket may have tripped from
earlier wrong codes. It clears on its own within the window.

---

## What this does and does not protect

It defeats a password that leaked on its own — reused from another breach, read out of a
`docker inspect`, or shoulder-surfed. That is the threat this control exists for, and it is the
common one.

It is not a substitute for the identity provider. There is no passkey or WebAuthn support here, no
per-user enrolment, no recovery codes, and no device management — one shared secret per account,
provisioned by whoever runs the server. Teams that need more should run
[OIDC](OIDC.md) and enforce it upstream.

One deployment note: the spent-code set lives in the application process, like the login rate-limit
counters. Above one replica each process enforces its own view, so a captured code can be replayed
once per replica inside its 90-second window. The chart defaults to `replicaCount: 1`.

Stated as a control, with its verifying test, in
[`docs/SECURITY.md`](SECURITY.md#controls) (row 1.6).
