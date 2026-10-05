# Launch sign-in

A platform that hosts Studio can sign its own users in to Studio with one click.
The platform signs a short-lived token, opens `https://<studio>/launch#token=<token>` in a new tab, and Studio exchanges the token for its ordinary session cookie and opens the editor, on a seeded connection when the token names one.
Launch sign-in is off until an operator sets `LAUNCH_TOKEN_SECRET`.

It needs a release later than 0.17.0, which does not read `LAUNCH_TOKEN_SECRET`.

---

## Table of Contents

- [Configuration](#configuration)
- [The launch link](#the-launch-link)
- [The token](#the-token)
- [Minting a token](#minting-a-token)
- [Accounts](#accounts)
- [Answers of POST /api/auth/launch](#answers-of-post-apiauthlaunch)
- [Audit](#audit)
- [Troubleshooting](#troubleshooting)
- [What this does and does not protect](#what-this-does-and-does-not-protect)

---

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `LAUNCH_TOKEN_SECRET` | To turn the feature on | The HMAC-SHA256 key the platform signs tokens with, at least 32 characters and used exactly as set, so surrounding spaces are part of the key; unset or empty turns launch sign-in off |
| `LAUNCH_TOKEN_AUDIENCE` | When the secret is set | The value the token's `aud` claim must equal: the name this Studio has on the platform |
| `LAUNCH_TOKEN_ISSUER` | When the secret is set | The value the token's `iss` claim must equal: the name of the platform |

Generate a secret and give the same value to the platform:

```bash
openssl rand -hex 32
```

A secret under 32 characters, a missing audience or issuer, or a secret equal to `JWT_SECRET` (or to the development fallback Studio signs sessions with while `JWT_SECRET` is unset) does not stop the server.
A launch secret must differ from the session key because a token signed with the session key would pass as a session.
`POST /api/auth/launch` answers `503` with a message that names the variable, the server log says the same once, and everything else keeps working.
While the secret is unset (and `NEXT_PUBLIC_AUTH_PROVIDER` is not `oidc`) the route answers `404` and the `/launch` page says launch sign-in is not enabled.

Launch sign-in is not available with `NEXT_PUBLIC_AUTH_PROVIDER=oidc`, whatever the three variables say: the route and the `/launch` page answer `503` with `Launch sign-in is not available when NEXT_PUBLIC_AUTH_PROVIDER=oidc.`
In that mode the identity provider manages the accounts and no session is checked against Studio's registry, so a disable or a role change would never reach a launched session.
In that mode, and while the configuration is broken, the `/launch` page answers before any script runs, so the token stays in the address bar and the browser history.
That is harmless: the fragment never reaches a server, the token is never spent and Studio refuses it for as long as that answer holds, it expires a minute after the platform minted it, and its audience names only this Studio, so whoever reads it from that browser within the minute holds no more than the link itself gave.

A platform that deploys Studio can set all three itself at deploy time: a secret it generates at random for that Studio and keeps, the Studio's own id on the platform as the audience, and the platform's name as the issuer, so nothing has to be set by hand.
Generate the secret at random rather than derive it from values the platform's users can see: anyone who can compute the secret can sign in to Studio as anyone, with either role.

## The launch link

```
https://studio.example.com/launch#token=<token>
```

The token rides in the URL fragment, which a browser never sends to a server, so it reaches no access log, no reverse-proxy log and no `Referer` header.
The `/launch` page reads the fragment and removes it from the address bar and the history entry, then asks `GET /api/auth/me` whether the browser holds a Studio session.
With no session, the page names the account the link signs into, the `email` claim it reads from the token for display only, and posts the token only after the person clicks **Continue as <email>**: a link someone else minted for their own account then cannot sign you in as them without your seeing whose account it is.
With a session, it posts the token at once, so the route can refuse a link for another account (below).
Either way it posts the token as JSON to `POST /api/auth/launch` on its own origin, and the route alone decides; a token whose payload carries no readable email is refused on the page without being posted.
On success it replaces itself with the editor; on a refusal it shows the reason and a link to the password sign-in.
When the browser is already signed in to Studio as another account, the page names both accounts and offers to sign out; the link is used up either way, so continuing as the other account takes a fresh launch from the platform.
Under a build-time `BASE_PATH` the page is at `<BASE_PATH>/launch`.

Serve Studio over HTTPS: on a plain-HTTP address the token crosses the network in the page's POST body unencrypted, as the session cookie does, and single use only narrows the window in which a copy could be used.

Open the link in a new tab without an opener, and without a referrer where the platform can: the Studio tab needs nothing from the page that opened it.
A platform that opens a blank tab on the click and navigates it once the link arrives, so that a pop-up blocker lets it through, cannot drop the referrer, and that is safe: the token is in the fragment, which a `Referer` header never carries.

## The token

A compact JWS with the header `{"alg": "HS256", "typ": "libredb-launch+jwt"}`, signed with the UTF-8 bytes of `LAUNCH_TOKEN_SECRET`.

| Claim | Rule |
|---|---|
| `iss` | Equals `LAUNCH_TOKEN_ISSUER` |
| `aud` | A string equal to `LAUNCH_TOKEN_AUDIENCE`; an array is refused |
| `sub` | The person's id on the platform, a non-empty string; in the server store the account a launch creates is bound to it and to `iss` |
| `email` | The Studio username, an email address of at most 254 characters |
| `role` | `admin` or `user`, the Studio role the platform grants |
| `conn` | Optional: the seed id of the connection to open, matching `^[a-z0-9-]{1,64}$` |
| `iat` | Issue time in seconds |
| `exp` | Expiry in seconds, at most 60 after `iat` |
| `jti` | A unique id for this token, a non-empty string of at most 128 characters |

Studio refuses a token whose `typ` is anything other than exactly `libredb-launch+jwt`, `JWT` included, before it checks the signature: explicit typing (RFC 8725 section 3.11) keeps a launch token from ever being taken for another JWT type, such as a Studio session.
Studio pins the algorithm, so a token whose header names `none` or any algorithm other than HS256 is refused before its signature or claims are read.
Five seconds of clock difference are tolerated in each direction.
Each token signs in once: its `jti` is remembered until the token could no longer verify, and a second presentation is refused.
A process remembers at most 4096 tokens that could still verify; while it holds that many, a new launch is refused with `503` until the oldest expire, rather than forgetting a used token that could then be replayed.

When `conn` is present the launch opens the editor at `/?connection=seed%3A<conn>`, which selects that seeded connection once the managed connections have loaded.
An id the first load does not list, such as a database the platform added moments before the click, is checked again at the next managed refresh, a few seconds later when `SEED_CACHE_TTL_MS` is short, and opens then; an id that refresh does not list either, or one the person's role cannot see, leaves the editor on its default connection and says so once.

## Minting a token

Any JWT library that signs HS256 works.
With `node:crypto` alone:

```ts
import { createHmac, randomBytes } from "node:crypto";

function launchToken(input: { email: string; role: "admin" | "user"; userId: string; conn?: string }): string {
  const iat = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "libredb-launch+jwt" });
  const payload = encode({
    iss: process.env.LAUNCH_TOKEN_ISSUER,
    aud: process.env.LAUNCH_TOKEN_AUDIENCE,
    sub: input.userId,
    email: input.email,
    role: input.role,
    ...(input.conn ? { conn: input.conn } : {}),
    iat,
    exp: iat + 60,
    jti: randomBytes(16).toString("base64url"),
  });
  const signature = createHmac("sha256", process.env.LAUNCH_TOKEN_SECRET ?? "")
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}
```

Mint the token when the person clicks, not when the page that shows the button renders: it is valid for one minute.
Rate-limit minting per user on the platform: every launch a Studio process accepts holds one of its 4096 replay slots for about a minute, and all users share those slots, so one account or script minting in a loop can make launch sign-in answer `503` for everyone (see [The token](#the-token)).

## Accounts

With `STORAGE_PROVIDER=sqlite` or `postgres` every session must match an account in the server store, so a launch provides one, and it reaches only an account a launch created for the same person on the same platform.

- An email with no account gets one, bound to the token's `iss` and `sub`, with the token's role and no password, so it signs in only through launch.
- A later launch signs in to that account when its token carries the same `iss` and `sub`; the email is matched without regard to case, and the session names the email as it is stored.
- An account that has a password, an authenticator or a passkey is refused, and so is an account a launch created for another `iss` or `sub`.
  That covers every account an admin created and an email the platform has since given to someone else: a launch never takes over an account it did not create for that person.
  The `ADMIN_EMAIL` address is refused for every launch, whether or not its account exists, so a launch never creates or takes the break-glass account.
  Sign in to such an account with its password.
- An admin who sets a password for a launched account under Admin, Accounts turns it into a password account, and launches for it are refused from then on.
  A launched account cannot add an authenticator or a passkey, because both ask for the current password, which it does not have.
- A bound account whose role differs from the token's takes the token's role.
  That ends its other sessions, as an admin's role change does.
- A disabled account is refused and stays disabled.
- A launch that would make the last enabled admin a user is refused, so the registry always keeps an admin.
- The first request to an empty registry seeds it from `ADMIN_EMAIL` and `ADMIN_PASSWORD` before anything else, on this path as on the password one.

A platform that deploys Studio should therefore set `ADMIN_EMAIL` to an address none of its users has, in a reserved domain such as `admin@studio.invalid`, and hand `ADMIN_EMAIL` with `ADMIN_PASSWORD` to its owners as the password sign-in for recovery: the platform's owner then launches into an account of their own, with the admin role their token names.

Account changes made by a launch are recorded as `account` events whose actor is `launch`.

With `STORAGE_PROVIDER=local` there is no registry to consult, and the accounts that exist are the ones the environment defines: `ADMIN_EMAIL`, and `USER_EMAIL` while `USER_PASSWORD` is set.
Both sign in with a password, so a launch for either is refused with `403`, in any letter case; any other email gets a session that carries the token's email and role, and nothing is stored.

## Answers of POST /api/auth/launch

The body is `{"token": "<token>"}`.
Every answer carries `Cache-Control: no-store`.

| Status | Body | When |
|---|---|---|
| `200` | `{"success": true, "redirect": "/"}` or `{"success": true, "redirect": "/?connection=seed%3A<conn>"}` | The token verified, and the session cookie is set |
| `400` | `{"success": false, "message": "Invalid request body"}` | The body is not JSON or carries no non-empty string `token` |
| `401` | `{"success": false, "message": "<reason>"}` | The token is refused, or the account is disabled |
| `403` | `{"success": false, "message": "This email belongs to a Studio account that a launch link cannot sign in to. Sign in with that account's password, or ask a Studio admin."}` | The email is `ADMIN_EMAIL`, or with `STORAGE_PROVIDER=local` `USER_EMAIL` while `USER_PASSWORD` is set; in the server store, the account has a password, an authenticator or a passkey, or a launch created it for another `iss` or `sub` |
| `404` | `{"success": false, "message": "Launch sign-in is not enabled on this server."}` | `LAUNCH_TOKEN_SECRET` is unset or empty and `NEXT_PUBLIC_AUTH_PROVIDER` is not `oidc` |
| `409` | `{"success": false, "message": "This browser is already signed in to Studio as <current>, and this launch link is for <email>. Sign out, then open Studio again from the platform to continue as <email>.", "signedInAs": "<current>", "launchFor": "<email>"}` | The browser holds a valid session for another account; that session stays and the token is spent |
| `409` | `{"success": false, "message": "<reason>"}` | The role change would demote the last enabled admin, or the account changed at the same moment |
| `413` | `{"success": false, "message": "Request body is too large"}` | The body is over 8192 bytes |
| `429` | `{"error": "Too many requests. Try again in <seconds> seconds.", "code": "RATE_LIMITED", "statusCode": 429, "retryable": true}` with `Retry-After` | The address spent its failed sign-in budget |
| `503` | `{"success": false, "message": "<problem>"}` | `NEXT_PUBLIC_AUTH_PROVIDER=oidc`, the launch variables are misconfigured, the server cannot sign sessions, or more launches arrived in the last minute than the process can remember |

Every refusal and every malformed body spends one unit of the `login_client` budget, the per-address budget of the password sign-in, and it is checked before the body is read.
A successful launch clears the address's failures.
The per-account password budget is neither spent nor cleared, because a launch is not a password guess.

## Audit

A launch records the same events as a password sign-in, with the route `POST /api/auth/launch`: `login_success` naming the account, or `login_failure` with one of these reasons.

| Reason | Meaning |
|---|---|
| `launch_token_malformed` | Not a compact JWS, or a claim is missing or of the wrong shape |
| `launch_token_type` | A header `typ` other than `libredb-launch+jwt`, or none |
| `launch_token_signature` | Unsigned, signed with another algorithm, or signed with another secret |
| `launch_token_issuer` | Another issuer than `LAUNCH_TOKEN_ISSUER` |
| `launch_token_audience` | Another audience than `LAUNCH_TOKEN_AUDIENCE` |
| `launch_token_expired` | Past its expiry by more than 5 seconds |
| `launch_token_premature` | Issued, or valid from, more than 5 seconds in the future |
| `launch_token_lifetime` | Issued for longer than 60 seconds |
| `launch_token_replayed` | Already used |
| `launch_capacity_exceeded` | A valid token refused because the process already remembers 4096 launches that could still verify |
| `launch_account_disabled` | A valid token for a disabled account |
| `launch_identity_mismatch` | A valid token for an account a launch cannot sign in to: one with a password, an authenticator or a passkey, or one a launch created for another `iss` or `sub` |
| `launch_session_conflict` | A valid token opened in a browser signed in as another account; the session stayed |
| `account_refused` | A valid token whose role change the registry refused, or that crossed another change to the account |
| `malformed_body` | The body carried no token |

A refused token is recorded against `anonymous`, because its claims are not an identity until it verifies.
The token itself is never logged or recorded.

## Troubleshooting

| What the launch page says | Cause |
|---|---|
| "This launch link does not carry a Studio launch token." | The platform signs its tokens with a header `typ` other than `libredb-launch+jwt`, for example the generic `JWT`; Studio refuses any other `typ` |
| "This launch link was not signed for this Studio." | The platform and Studio hold different secrets; give both the same `LAUNCH_TOKEN_SECRET`, and when the platform injects it at deploy time, redeploy Studio so it receives the current one |
| "This launch link has expired." | More than 65 seconds passed between minting and the click landing, or the clocks differ by more than 5 seconds |
| "This launch link is not valid yet: the clocks of the platform and this Studio disagree." | Studio's clock is behind the platform's by more than 5 seconds; synchronise both with NTP |
| "This launch link has already been used." | The link was opened twice, for example by reloading the page or by a link scanner; open Studio again from the platform |
| "This launch link was issued for a different Studio." | `LAUNCH_TOKEN_AUDIENCE` differs from the platform's name for this Studio |
| "Launch sign-in is not enabled on this server." | `LAUNCH_TOKEN_SECRET` is not set in Studio's environment |
| "This account is disabled in Studio." | An admin disabled the account under Admin, Accounts |
| "This email belongs to a Studio account that a launch link cannot sign in to." | Studio already has an account with that email that signs in with a password, or that a launch created for another person on the platform; sign in to it with its password, or have an admin delete it so a launch can create the person's own |
| "You are already signed in to Studio" | The browser is signed in as another account; sign out on that page, then open Studio again from the platform |
| "Launch sign-in is not available when NEXT_PUBLIC_AUTH_PROVIDER=oidc." | Studio runs with OIDC sign-in, where launch sign-in is not available; sign in through the identity provider |
| "Too many launches arrived at this Studio in the last minute." | More than 4096 launches that could still verify reached this Studio process within about a minute; wait a minute and open Studio again, and if it happens again, find what is launching in a loop |

## What this does and does not protect

- It moves trust to the platform: whoever can make the platform mint a token signs in to Studio with the role the token names, without Studio's password or authenticator code.
  Keep `LAUNCH_TOKEN_SECRET` as secret as `JWT_SECRET`.
- A launch link signs in whoever opens it within its minute, as the person it names, once they click Continue in a browser with no Studio session.
  A browser that is already signed in to Studio as someone else refuses the link and keeps its session.
  A browser with no session shows the account the link signs into and signs in only when the person clicks **Continue as <email>**, so a link someone else sends you no longer signs you in as them without a word; a person who clicks Continue for an email that is not their own is still signed in as that account, and what they save in Studio is saved to it.
- A token is single use per Studio process.
  With more than one replica each process remembers only the tokens it accepted, so a copied token could sign in once per replica within its minute.
- The session cookie is the same one a password sign-in sets, so `AUTH_COOKIE_SECURE` applies unchanged: on a plain-HTTP address the cookie travels unencrypted, and so does the token in the page's POST body.
- A launched session lasts up to 24 hours, as a password session does, and the account a launch created stays enabled: removing someone's access on the platform does not end a session they already opened.
  To cut it at once in the server store, disable their account under Admin, Accounts, which ends its sessions at their next request; without a server store there is no account to disable, and only a new `JWT_SECRET` ends a session early, every session at once.
- The platform decides who may launch; Studio's two roles decide what a launched person may do, and the seeded connections are open to every role their seed lists.
