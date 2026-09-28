# Passkey sign-in

A local account that lives in the server store can register passkeys and sign in with one from the login page, without typing an email.
A passkey is a WebAuthn credential kept by the user's device, password manager or security key, and unlocked with a fingerprint, face or device PIN.
Passkeys are off until an operator sets `PASSKEY_ORIGIN`.

> **Using SSO instead?** Under `NEXT_PUBLIC_AUTH_PROVIDER=oidc` your identity provider manages passkeys, and Studio offers none of its own.
> See [`docs/OIDC.md`](OIDC.md).

---

## Table of Contents

- [Quick start](#quick-start)
- [Configuration reference](#configuration-reference)
- [Adding and managing passkeys](#adding-and-managing-passkeys)
- [Signing in](#signing-in)
- [Admin actions and recovery](#admin-actions-and-recovery)
- [How it works](#how-it-works)
- [Deploying with Docker](#deploying-with-docker)
- [Deploying with Helm](#deploying-with-helm)
- [Upgrading a DBA-managed schema](#upgrading-a-dba-managed-schema)
- [Troubleshooting](#troubleshooting)
- [What this does and does not protect](#what-this-does-and-does-not-protect)

---

## Quick start

Passkeys need three things on the server: local sign-in (`NEXT_PUBLIC_AUTH_PROVIDER` unset or `local`), a server store (`STORAGE_PROVIDER=sqlite` or `postgres`), and `PASSKEY_ORIGIN` set to the address people open Studio at.
With none of them set, which is the default, the login page shows no passkey button and the settings page says why.

For local development:

```bash
STORAGE_PROVIDER=sqlite PASSKEY_ORIGIN=http://localhost:3000 bun dev
```

Then open exactly `http://localhost:3000`.
Browsers tie a passkey to the host name and refuse passkeys on an IP address, so the page must be at the `PASSKEY_ORIGIN` address and never at the `http://127.0.0.1:3000` URL the startup banner prints.
With `PASSKEY_ORIGIN` set, the banner prints a second line that names the address to open:

```
LibreDB Studio 0.x.y  ->  http://127.0.0.1:3000
Passkeys  ->  http://localhost:3000
```

When passkeys cannot work, that second line reads `Passkeys are unavailable: <reason>` instead, and the reason names what to change.

1. Sign in with your email and password.
2. Open the user menu, then **Sign-in security** (`/settings/authenticator`).
   An admin also finds the section at the foot of Admin → Accounts.
3. Under **Passkeys**, choose **Add passkey**, give the passkey a name if you like, enter your current password (and a current authenticator code when your account has one), then **Create passkey**, and confirm on your device.
4. Sign out, then choose **Use a passkey** on the login page.

Docker and Helm recipes are in [Deploying with Docker](#deploying-with-docker) and [Deploying with Helm](#deploying-with-helm), and they follow the same rule: open exactly the `PASSKEY_ORIGIN` address.
Both need an image from a release that includes passkey sign-in (#785): release 0.17.0 does not read `PASSKEY_ORIGIN`.

---

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `PASSKEY_ORIGIN` | unset: passkeys off | The origin people open Studio at: scheme, host and optional port, such as `https://studio.example.com` |
| `RATE_LIMIT_PASSKEY_MAX` | `10` | Failed passkey sign-ins allowed per client address per window |
| `RATE_LIMIT_PASSKEY_WINDOW_SEC` | `300` | The window of that budget, in seconds |

`PASSKEY_ORIGIN` is read on every request, and nothing derives it from a request's `Host`, `X-Forwarded-Host` or URL.
The expected origin of every ceremony is exactly this value, and the relying party ID (RP ID) is its host name, so passkeys belong to that one host and never to a parent domain.
The value is checked in this order, and the first rule it breaks is reported:

1. It is an absolute URL.
2. It uses `https:`, or `http:` only with the host `localhost`.
3. It carries no user name or password.
4. It has no path other than `/`, no query and no fragment.
   A `BASE_PATH` prefix does not belong in it: under a subpath the origin is still `https://example.com`.
5. Its host is a domain name, not an IPv4 or IPv6 address.
6. Its host does not end with a dot.

An invalid value never falls back to anything: adding a passkey (`register-options` and `register-verify`) and passkey sign-in answer 503 with a message that names the variable and the rule, and never quote the value.
`GET /api/auth/passkey` still answers 200, with `canAdd: false` and that message as the reason, and renaming and removing a passkey keep working.
TLS terminated at an ingress or a reverse proxy still means `https://`, because that is what the browser sees.

`PASSKEY_ORIGIN`, `ALLOWED_ORIGINS` (when a proxy in front rewrites `Host`) and `LIBREDB_MCP_URL` all name the same public origin, so they change together.
Changing the host name means everyone registers their passkeys again: a passkey belongs to the host it was created on, and Studio lists passkeys from the old host as "Not usable on this server" so they can be removed.

Passkeys need `STORAGE_PROVIDER=sqlite` or `postgres` because the server store keeps the passkey records next to the accounts; `STORAGE_PROVIDER=local` has no account registry, and passkeys stay unavailable there.
Under `NEXT_PUBLIC_AUTH_PROVIDER=oidc` Studio offers no passkeys of its own, because the identity provider is where OIDC users keep them.
`GET /api/auth/passkey` answers 200 with `{"available": false, "mode": "oidc"}` and the reason, so the settings page can say so.
Every action on `POST /api/auth/passkey` (`register-options`, `register-verify`, `rename`, `remove`) and both actions on `POST /api/auth/passkey/sign-in` refuse with 409.

The two ceremony cookies, `passkey-registration` and `passkey-sign-in`, follow the same Secure rule as the session cookie (`AUTH_COOKIE_SECURE`).

---

## Adding and managing passkeys

Every account manages its own passkeys under the user menu → **Sign-in security** (`/settings/authenticator`), below the authenticator app.
The list shows each passkey's name, when it was added, when it was last used, and its sync state: "Synced", "Not synced yet" (it can sync but has not), or "This device only".
Add one on each device you sign in from; an account holds at most 20.

**Keep your password.**
Adding or removing a passkey asks for your current password, and a current authenticator code when your account has one, so a stolen session cookie alone can neither plant a passkey nor remove one.
The server decides whether the code is needed: when it is and none was sent, the dialog shows the code field and nothing is charged.
A wrong password or code is charged to the same two budgets as a failed login (5 per client address and 20 per account per 5 minutes by default), so `429` follows once either is spent.
There is no page to change your own password: an admin sets a new one when you forget it (see [Admin actions and recovery](#admin-actions-and-recovery)).

Adding is one button in two requests.
The first checks your password and returns the setup your device signs; if you cancel the device prompt, or it fails, **Try again** repeats only the device step while the setup is less than 10 minutes old, so your password and code are not sent again.
An expired setup, or a refusal from the server, returns to the password step.

Renaming needs only your session.
A name is 1 to 64 characters after trimming, with no control characters; a passkey added without one is called "Passkey".

**Removing a passkey** stops it at once, ends every other session of your account and every MCP token you created, and keeps the session you removed it from.
Create a new MCP token under MCP afterwards if you need one.
Delete the passkey from your password manager or security key too: otherwise the device keeps offering it, and the login page refuses it.
When it is your last passkey, you sign in with your password afterwards, and your authenticator code when you have one.

When your account has an authenticator app and passkeys, the section says so: passkeys sign you in without the code, so remove any you do not recognise.

Passkeys stay listed, and can be renamed and removed, while `PASSKEY_ORIGIN` is unset or invalid; only adding needs passkeys to be ready.

---

## Signing in

The login page shows **Use a passkey** below the password form when all of these hold:

- passkeys are ready on the server (local sign-in, a server store, a valid `PASSKEY_ORIGIN`);
- the browser supports WebAuthn;
- the page is open at exactly the `PASSKEY_ORIGIN` origin;
- the form is not waiting for an authenticator code.

Sign-in is username-less: the device offers the passkeys it holds for this host, you pick one and unlock it, and you land on `/admin` or `/` by your role, as with a password.
A failed or cancelled passkey shows a message and changes nothing else; it never falls back to another method, and the password form stays usable.

**A passkey sign-in replaces both the password and the authenticator code.**
Registration and sign-in both require user verification (the PIN, fingerprint or face on the device), so a verified passkey is two factors in one step: something you have and something you know or are.
NIST SP 800-63B-4 treats such an authenticator as multi-factor and phishing-resistant, at AAL2 (synced passkeys included), so asking for a password or code on top of it adds no factor.
An assertion without user verification is refused on every account.

A passkey sign-in creates the same session a password sign-in does, carrying the stored account's current role and session version, so disabling the account, changing its role or setting its password ends it as it ends any other session.
A disabled or deleted account cannot sign in with a passkey, and a role change applies to the next passkey session.
The account is checked again inside the write that spends the challenge, so a change that lands during a sign-in refuses it rather than answering with a session the next request would end.

Every refusal answers the same message, whatever the reason: "That passkey could not sign you in. If it was removed from Studio, delete it from your password manager too. Sign in with your password."
The reason is recorded only in the audit log (see [Troubleshooting](#troubleshooting)).
Failed passkey sign-ins spend their own budget, `RATE_LIMIT_PASSKEY_MAX` per client address, and never the password sign-in budgets, so retrying a removed passkey can never lock an address out of password sign-in.

---

## Admin actions and recovery

Admin → Accounts shows each account's passkey count.
Admins cannot see or add another account's passkeys; they can remove all of them.

**Remove passkeys.**
The row menu offers **Remove passkeys** when the account has any.
It asks you to type the account's email, removes every passkey of the account, and ends every session and MCP token the account holds; its password and authenticator stay.
On your own row, your other sessions and MCP tokens end and the session you act from continues, which the dialog says.
The API is `PATCH /api/admin/accounts/<email>` with `{"clearPasskeys": true}`, audited as `account` / `passkey_clear` with you as the actor.

**Set password removes passkeys unless you keep them.**
Owners cannot change their own password, so an admin password set is the recovery of a stolen password, and whoever held the password (with the code, when TOTP was on) could have added a passkey of their own.
The Set password dialog therefore shows "Also remove their N passkeys", checked by default, when the account has passkeys.
Keep them only when you know the account is not compromised, for example when the owner simply forgot the password: then they sign in with the new password or any of their passkeys, and nobody registers again on every device.
Through the API, `{"password": "..."}` removes the passkeys, and `{"password": "...", "keepPasskeys": true}` keeps them.

**Clear two-factor** removes the authenticator app only.
An account with passkeys still signs in with any of them afterwards, which the dialog says; if the lost device also held a passkey, use **Remove passkeys** too.

**`ADMIN_PASSWORD_RESET=true`** makes `ADMIN_EMAIL` an enabled admin that signs in with `ADMIN_PASSWORD`, with `ADMIN_TOTP_SECRET` or no second factor, and with no passkeys, whatever the store held; its older sessions end.
Remove the variable afterwards: every start applies it again while it is set, and the log says so.
See [STORAGE.md](STORAGE.md#accounts).

Deleting an account removes its passkeys with it.
Every change that removes passkeys lands only on the account row it read: a change that crosses another admin's change to the same account answers 409 "The account changed at the same time. Reload the page and try again." and writes nothing.

---

## How it works

```
Browser -> POST /api/auth/passkey/sign-in {action: "options"}
Server  -> 32 random bytes, signed into the passkey-sign-in cookie; nothing is stored
Browser -> the device signs the challenge after verifying the user
Browser -> POST /api/auth/passkey/sign-in {action: "verify", response}
Server  -> cookie taken and cleared -> origin, RP ID, credential, user handle, signature, flags checked
Server  -> account read: present and enabled
Server  -> one transaction: challenge marked spent, counter advanced -> JWT session cookie
```

**Ceremonies are bound to the browser that started them.**
Each registration and sign-in gets a fresh 32-byte challenge, carried in a token signed with a key derived from `JWT_SECRET` for this purpose alone, so a ceremony token is never a session and a session is never a ceremony token.
The token travels in its own cookie, `passkey-registration` or `passkey-sign-in`: HttpOnly, SameSite=Strict, scoped to `<BASE_PATH>/api/auth/passkey`, valid 600 seconds.
The verify request takes the cookie and clears it whatever the outcome, so one cookie serves one attempt, and a cookie issued for registration never completes a sign-in or the reverse.
A registration cookie also records the account and session version whose password confirmed it, so the confirmation is at most 10 minutes old when the passkey is stored.
Rotating `JWT_SECRET` fails any ceremony in flight and ends every session; the stored passkeys keep working.

**A successful challenge can never succeed again.**
The SHA-256 of the challenge is written to `passkey_spent_challenges` in the same transaction that stores the passkey or records the sign-in, so a replay fails on this or any other replica.
A spent row is kept until 600 seconds after its token expired, so a replica whose clock trails another by up to 10 minutes, and therefore still accepts the token, still finds the row.
Keep replica clocks synchronized (NTP): beyond that skew the token expiry itself is unreliable.
Failed attempts write nothing, so no anonymous request writes a passkey or challenge row unless its assertion verified.
The one store write an anonymous verify can cause is the first seeding of an empty account registry from the environment accounts, which a password sign-in runs the same way.

**Replicas.**
On PostgreSQL every replica completes any ceremony: the token verifies anywhere with the same `JWT_SECRET`, and the credentials and the spent challenges live in the database.
SQLite remains single-replica, as for every other stored row.

**Writes are conditional.**
Every account write applies only while the account row still has the session version and update time the writer read, and every write that touches both an account and its passkeys changes the account row first.
So a passkey registration whose account's sessions ended during the ceremony stores nothing, a removal whose session version moved answers 409, and no disable, password set or passkey removal is ever reverted by a request that read the row before it.

**What is stored.**
Three tables sit next to `accounts` in the server store: `passkey_users` (one random 64-byte user handle per account, never the email), `passkey_credentials` (the public key, credential ID, counter, sync flags, transports, the RP ID it was registered under, name and dates) and `passkey_spent_challenges`.
None of it signs anything, so the rows are not sealed with the storage encryption key; the DDL is in [STORAGE.md](STORAGE.md#manual-table-creation-optional).
Both passkey tables follow their account through foreign keys with `ON DELETE CASCADE`.

**Verification.**
`@simplewebauthn/server` does the cryptography, and Studio adds what the library leaves to the caller: the one configured origin, cross-origin and embedded ceremonies refused, only the attestation shapes a browser returns under `none` accepted (so registration never fetches anything), the credential ID bounded and taken from the attested data, credential IDs unique across all accounts, the user handle matched to the credential's owner, and a signature counter that must increase unless the authenticator always reports 0.
A counter that goes backwards is refused and audited as a possible cloned authenticator; the account is not locked.

**Headers.**
Studio's `Permissions-Policy` denies `publickey-credentials-get` except while passkeys are ready on this server, when it drops that one entry; the Content Security Policy is unchanged.

---

## Deploying with Docker

```bash
docker run -d -p 3000:3000 \
  -v libredb-data:/app/data \
  -e STORAGE_PROVIDER=sqlite \
  -e PASSKEY_ORIGIN=http://localhost:3000 \
  ghcr.io/libredb/libredb-studio:latest
```

**The recipe needs an image from a release that includes passkey sign-in (#785).**
Release 0.17.0, which `latest` names until the next release, does not read `PASSKEY_ORIGIN`, so its banner prints no passkey line and its settings page has no Passkeys section.
Until that release is out, run the `main` tag instead, which every push to `main` rebuilds.

Open exactly `http://localhost:3000` on the machine that runs the container, not the `127.0.0.1` URL in `docker logs`.
Behind a reverse proxy, set the public `https://` origin instead, such as `-e PASSKEY_ORIGIN=https://studio.example.com`.
`docker-compose.example.yml` carries the same setting as a commented block.
A first run without `STORAGE_PROVIDER` uses local storage, where the settings page says passkeys need `sqlite` or `postgres`.

---

## Deploying with Helm

```bash
helm install libredb-studio oci://ghcr.io/libredb/charts/libredb-studio \
  --set secrets.adminPassword="$ADMIN_PASSWORD" \
  --set postgresql.enabled=true \
  --set postgresql.auth.password="$PG_PASSWORD" \
  --set ingress.enabled=true \
  --set "ingress.hosts[0].host=studio.example.com" \
  --set "ingress.hosts[0].paths[0].path=/" \
  --set "ingress.hosts[0].paths[0].pathType=Prefix" \
  --set "ingress.tls[0].secretName=studio-tls" \
  --set "ingress.tls[0].hosts[0]=studio.example.com" \
  --set config.passkeyOrigin=https://studio.example.com
```

`config.passkeyOrigin` is written to `PASSKEY_ORIGIN` only when it is non-empty.
Passkeys also need an effective storage provider of `sqlite` or `postgres` (`config.storageProvider`, or `postgresql.enabled=true`) and `authProvider: local`; the install notes warn when either is missing, and suggest a value from the first ingress host when the ingress has TLS and the value is empty.

**The value needs an application image that includes passkey sign-in (#785).**
The chart value was published before an application release reads it: chart 0.1.72 pins `appVersion` 0.17.0, which ignores `PASSKEY_ORIGIN`, so the value acts only once `appVersion`, or your `image.tag`, names a release that includes passkey sign-in.

---

## Upgrading a DBA-managed schema

Where the application creates its own tables, an upgrade needs nothing: the first request that needs the store after the upgrade runs `CREATE TABLE IF NOT EXISTS` for the three passkey tables.
On PostgreSQL that needs `REFERENCES` on `accounts`, for the foreign keys, in addition to `CREATE` on the schema that every start already needs.

Where a DBA owns the schema, create the three tables and grant them **before** the new image starts.
Otherwise the server keeps running and health checks pass, but every request that needs the store, sign-in first, fails with an error that names the tables, the privileges and [STORAGE.md](STORAGE.md#manual-table-creation-optional-1), so a rollout gated on readiness completes anyway:

1. Run the PostgreSQL DDL for `passkey_users`, `passkey_credentials` and `passkey_spent_challenges`, with their two indexes, from [STORAGE.md](STORAGE.md#manual-table-creation-optional-1).
2. Grant the app user `SELECT, INSERT, UPDATE, DELETE` on the three tables.
   It needs no `REFERENCES` when the DBA created them.
3. Keep `CREATE` on the schema for the app user: PostgreSQL checks it even for `CREATE TABLE IF NOT EXISTS` of a table that already exists (see [STORAGE.md](STORAGE.md#minimal-privileges-when-table-already-exists)).

---

## Troubleshooting

**Where the reasons are.**
Every passkey registration, rename, removal and admin clear is one JSON line on stdout with `"schema":"libredb.audit.v1"`, and so is every audited refusal, with a `reason` and, where one is known, the internal `passkey` id (never a credential ID or key).
Audited refusals: every refused passkey sign-in, including a malformed or oversized sign-in body, and a rate-limited one once per window, when the budget trips; a wrong password or authenticator code when adding or removing a passkey; a registration whose ceremony, origin or attestation is refused, or that conflicts with another change to the account; and a removal that crosses another change to the account.
Not audited: the per-account passkey limit at `register-options`, a 404 for an unknown passkey id or an account that no longer exists, a missing password or code, a rate-limited add or remove (429), the readiness answers (409 for OIDC or `STORAGE_PROVIDER=local`, 503 for an invalid `PASSKEY_ORIGIN`), and a malformed or oversized body on `POST /api/auth/passkey` (400 or 413).
Read it with `docker logs <container> | grep libredb.audit.v1`, or `kubectl logs` of **each** pod, since every replica writes its own lines.
Admin → Audit shows the same events with their reason and passkey id, searchable, and exports them, but it holds only the events of the replica that answered the page.

### No "Use a passkey" button

The button appears only when all four hold:

1. local sign-in with a server store (`NEXT_PUBLIC_AUTH_PROVIDER` not `oidc`, `STORAGE_PROVIDER` `sqlite` or `postgres`);
2. a valid `PASSKEY_ORIGIN`;
3. WebAuthn in this browser;
4. the page open at exactly that origin: scheme, host and port.

Sign in with your password and open **Sign-in security**: the passkey section names the condition that fails, in the words of the variable to set or the address to open.
With `PASSKEY_ORIGIN` set, the startup banner prints a passkey line: the origin to open when the first two hold, or the reason they do not.
With `PASSKEY_ORIGIN` unset it prints no passkey line at all.
A wrong `PASSKEY_ORIGIN` shows up this way, as a missing button and no passkey events at all, never as an audit reason.

### Notices on the settings page

**"Passkeys for this sign-in are managed by your identity provider."**
The server runs `NEXT_PUBLIC_AUTH_PROVIDER=oidc`; use your identity provider's passkeys.

**"This page is open at an IP address, and browsers offer passkeys only on a host name: https with your server's name, or http://localhost on this machine."**
Browsers refuse WebAuthn on an IP address, whatever the server says; this includes the desktop shell, which runs on `127.0.0.1`.
Open Studio by its host name.

**"This page is plain http, and browsers offer passkeys only on https, or on http://localhost."**
The page is not a secure context, as on a plain-HTTP LAN address.
Serve Studio over https, or open it at `http://localhost` on the machine itself.

**"Passkeys need STORAGE_PROVIDER=sqlite or postgres: with STORAGE_PROVIDER=local there is no account registry to keep them in."**
Set `STORAGE_PROVIDER=sqlite` or `postgres`; see [STORAGE.md](STORAGE.md).

**"Passkeys are off on this server. An administrator turns them on by setting PASSKEY_ORIGIN to the address people open Studio at, such as https://studio.example.com."**
`PASSKEY_ORIGIN` is unset or empty.

**A message that starts with "PASSKEY_ORIGIN".**
The value breaks one of the rules in [Configuration reference](#configuration-reference), and the message names which: not an absolute URL, not https (or http other than `localhost`), a user name or password, a path, query or fragment, an IP address, or a trailing dot.
Adding a passkey and passkey sign-in answer 503 with the same message until it is fixed; the list, rename and remove keep working.

**"This page is open at `<address>`, but passkeys on this server work at `<origin>`. Open Studio there to add or use a passkey."**
Passkeys are ready, but the page is at another address, such as `127.0.0.1` instead of `localhost`, another port, or a second DNS name.
Open the origin it names.

**"This browser cannot use passkeys. Try another browser, or sign in with your password."**
The page is at the `PASSKEY_ORIGIN` address, but the browser offers no WebAuthn, as in some in-app browsers and older browsers.
Open Studio in a current browser, or keep signing in with your password.

**"Not usable on this server"** next to a passkey.
It was registered under another host name, from an earlier `PASSKEY_ORIGIN`, and this server cannot use it.
Remove it and add a new one here.

**"Your passkeys sign you in without the authenticator code. Remove any you do not recognise."**
Not a fault: the account has an authenticator app and passkeys, and a passkey sign-in does not ask for the code.

### Audit reasons

**`passkey_ceremony_invalid`.**
The ceremony cookie was missing, forged, expired (older than 600 seconds), issued for the other ceremony, for another account or session version, or for another RP ID.
It is also recorded when two first registrations for the same account race, and the other one bound the account's passkey user handle first ("Another passkey was added at the same time. Start again.").
It is common after a device prompt left open for more than 10 minutes, after an admin action ended the account's sessions during a registration, or when a proxy in front drops cookies; start again.

**`passkey_origin_mismatch`.**
A response made on another origin than `PASSKEY_ORIGIN`: a non-browser client, a modified client, or a page on a subdomain of Studio's host.
Studio's own pages never produce it in a real browser, which writes the page's own origin into what the device signs, so it is never a configuration symptom; treat repeated occurrences as a probe.

**`passkey_unknown`.**
No passkey with that credential ID is stored for this host, or the response carried no user handle.
Usually a passkey removed from Studio that the device still offers, or one registered under an earlier host name; delete it from the password manager.

**`passkey_rejected`.**
Verification refused the response: challenge, RP ID, flags (no user verification included), signature, an attestation format other than the browser's own, a cross-origin or embedded ceremony, a credential ID that is not the attested one, or a user handle or backup eligibility that does not match the stored passkey.

**`passkey_counter`.**
The signature counter did not increase: a possible cloned authenticator.
The sign-in was refused and the account is not locked; check with the owner which devices hold the passkey, and remove it if the answer is unclear.

**`passkey_replayed`.**
The challenge of a ceremony that already succeeded was presented again, on this or another replica.
A legitimate browser never does this; check that replica clocks agree if it appears without a reason.

**`passkey_account_unavailable`.**
A valid passkey of an account that is disabled or no longer exists, or whose role or session version changed while the sign-in was in flight.

**`passkey_duplicate`.**
A registration presented a credential already registered to an account, this one or another.
The dialog says "This passkey is already registered."

Passkey events can also carry these reasons, which other routes use too: `bad_credentials` and `bad_totp` (a wrong password or code when adding or removing a passkey), `account_refused` (the 20-passkey limit, or a removal whose session version moved), `malformed_body` (a sign-in body that was not valid JSON, too large, or had an unknown action) and `rate_limited` (the `passkey_client` budget tripped).

### Other symptoms

**A 409 "The account changed at the same time. Reload the page and try again."**
In Admin → Accounts, another admin's change to the same account landed first; reload and repeat.
In a passkey dialog under **Sign-in security**, it means the account's sessions ended while the dialog was open, this one included, for example because an admin changed the account or another session of it removed a passkey.
Sign in again, then repeat.

**Sign-in and every other request that needs the store fail with "PostgreSQL storage cannot create or check its tables", while health checks pass.**
The app user lacks `CREATE` on the schema, or `REFERENCES` on `accounts` while the passkey tables do not exist yet; see [Upgrading a DBA-managed schema](#upgrading-a-dba-managed-schema).

**A 429 on the login page after several passkey attempts.**
The `passkey_client` budget of that address is spent; it clears within `RATE_LIMIT_PASSKEY_WINDOW_SEC`, and password sign-in stays available meanwhile.

---

## What this does and does not protect

It defeats phishing: a passkey signs only for the host it was created on, and the server accepts only the one configured origin, so a look-alike site cannot relay a sign-in.
It adds no secret to the server that could leak: the store holds public keys only.

What it does not cover:

- **User verification is the authenticator's claim.**
  Some password managers report a PIN or biometric check they did not perform, and without attestation, which public-facing sites should not require, Studio cannot tell.
- **Script on Studio's own origin.**
  Injected script can phish the password in the page and relay a registration to an attacker's authenticator; the password (and code) are still required, and the new passkey appears in the owner's list and the audit log.
  While passkeys are ready, such script could also ask for assertions for a registrable parent of Studio's host, which matters only if another application uses that parent as its RP ID and accepts subdomain origins; Studio's `Permissions-Policy` blocks that in Chromium whenever passkeys are not ready.
  See [SECURITY.md](SECURITY.md#known-limits).
- **The NIST binding rule, for accounts with a passkey but no authenticator app.**
  NIST would ask for an existing passkey before adding another; Studio asks for the password, because every account keeps its password and whoever holds it already reaches everything a passkey would.
  The residual, a stolen password buying a passkey that survives recovery, is closed by an admin password set removing passkeys by default and by `ADMIN_PASSWORD_RESET`.
- **No out-of-band notice.**
  Studio sends no email when a passkey is added; the dated list, the audit line and the admin's count are the substitutes.
- **A host name change** orphans every passkey, by WebAuthn's design; people register again.
- **Plain HTTP and IP addresses.**
  A plain-HTTP LAN install and the desktop shell on `127.0.0.1` cannot use passkeys, because browsers refuse WebAuthn there.

Stated as controls, with their verifying tests, in [`docs/SECURITY.md`](SECURITY.md#controls).
