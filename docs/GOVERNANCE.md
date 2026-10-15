# Governance contract

Studio can run under a control plane: a separate service that decides which databases each person may open in Studio, with which credential, and that keeps a record of what they ran.
The two never call each other.
The control plane publishes a governance source, a set of PostgreSQL views and tables in one schema, and Studio reads it with a role of its own and writes its heartbeat and query events back into it.
This document is that contract, version 1, for anyone who builds or operates a control plane.

Governance is off unless an operator sets `GOVERNANCE_SOURCE=postgres`, and a Studio without that variable behaves exactly as it would without this document.
With it set, Studio runs in governance mode, and the governance source is its only catalog of connections and grants, as the rest of this document describes.

## Contents

- [Conformance files](#conformance-files)
- [Schema and roles](#schema-and-roles)
- [Studio configuration](#studio-configuration)
- [Sign-in](#sign-in)
- [Objects](#objects)
- [Row semantics](#row-semantics)
- [Grants and the connection list](#grants-and-the-connection-list)
- [Per-user providers](#per-user-providers)
- [Snapshot protocol](#snapshot-protocol)
- [Change notification](#change-notification)
- [Freshness and readiness](#freshness-and-readiness)
- [Operating notes](#operating-notes)
- [Admin status](#admin-status)
- [Heartbeat](#heartbeat)
- [Versioning and upgrade order](#versioning-and-upgrade-order)
- [Row admission and skip codes](#row-admission-and-skip-codes)
- [Runtime settings](#runtime-settings)
- [Query events](#query-events)
- [Sealed credentials: lsb1](#sealed-credentials-lsb1)
- [API codes](#api-codes)

## Conformance files

Studio publishes three files at every release tag, and a control plane pins all three from one tag, each with a `.sha256` of its bytes:

| File | What it is |
| --- | --- |
| `docs/GOVERNANCE.md` | This document. |
| `tests/fixtures/governance/contract-v1.json` | The manifest: every object with its columns, types, nullability, defaults, CHECKs and required grants, every statement Studio issues with sample parameters, the settings registry, the skip, envelope and API codes, the definition key allowlist with each key's value domain, and the heartbeat and readiness shapes as JSON Schema with an example each. |
| `tests/fixtures/governance/lsb1-vectors.json` | Test vectors for the `lsb1` envelope that seals each credential. |

A control plane never edits a vendored file; it vendors a newer release instead.
The manifest is generated from `src/lib/governance/contract.ts` and `src/lib/governance/settings-registry.ts` with `bun scripts/generate-governance-manifest.ts --write`, and Studio's unit tests fail when the checked-in file differs from what the code builds by a single byte.

With these files a control plane can:

- check after its migrations that every object exists with the listed kind, columns, base types, nullability, CHECK value sets and grants;
- run every listed statement as `libredb_studio` with its sample parameters;
- generate its settings allowlist from the registry;
- build its connection form from the definition allowlist, so Studio never skips a connection the control plane created;
- reproduce every envelope of the vectors byte for byte with its own sealer.

An installer pairs a control plane only with the Studio release whose files that control plane vendored.

Studio holds itself to the same manifest.
Its live check, `tests/live/governance-live-check.ts`, builds a governance source in a throwaway PostgreSQL 17 database from the manifest alone, with `tests/helpers/governance/fixture-ddl.ts`: the roles, one source table per read view with exactly the published columns and CHECKs, the views with the published options, the grants, and a statement-level trigger on each source table that sends the view's notification kind.
It seeds connections sealed to a fresh key and runs Studio's own snapshot loader as `libredb_studio`, so a view shape, a grant or a statement that drifts from the manifest fails Studio's CI before a control plane meets it.
It also runs Studio's change notification listener against that database, and checks that a deleted grant refuses its connection within a second through the trigger's notification alone.
And it inserts query events through Studio's own sink as `libredb_studio`, which holds only INSERT on `query_events_v1`, and checks that a retried batch adds no duplicate and that a row the table's CHECK refuses is dropped alone while the rest of its batch lands.
Run it against a disposable server as a superuser, because it creates and drops a database and the roles:

```sh
LIBREDB_LIVE_POSTGRES_URL='postgresql://postgres:<password>@127.0.0.1:55432/postgres?sslmode=disable' \
  bun tests/live/governance-live-check.ts
```

## Schema and roles

The contract lives in one schema, `bridge` unless `GOVERNANCE_POSTGRES_SCHEMA` names another.
Studio quotes the schema name in every statement and accepts only a lowercase identifier of at most 63 characters.
The contract needs PostgreSQL 15 or later, the first release with the `security_invoker` view option.

| Role | Used by | Holds |
| --- | --- | --- |
| an owner role | the control plane's migrations only | every object in the schema, and the tables behind the read views |
| `libredb_platform` | the control plane at run time | `USAGE` on the schema and the privileges the objects table lists |
| `libredb_studio` | Studio, through `GOVERNANCE_POSTGRES_URL` | `USAGE` on the schema and the privileges the objects table lists |

Neither runtime role can create objects in the schema.
Studio's role cannot read the control plane's own tables, cannot read the query events it writes, and cannot run the retention function.
Every view is created `WITH (security_barrier = true, security_invoker = false)`, so it reads its sources with its owner's rights and a function in a reader's query cannot see the rows the view leaves out.

## Studio configuration

An installer switches Studio into governance mode with environment variables.
Nothing in the governance source can switch it on or off.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOVERNANCE_SOURCE` | unset | `postgres` switches governance mode on, and unset or empty leaves it off. Any other value counts as on as well, so a typo fails closed and the boot checks below refuse it. |
| `GOVERNANCE_POSTGRES_URL` | none, required | The governance source as a `postgresql://` or `postgres://` URL for `libredb_studio`. |
| `GOVERNANCE_POSTGRES_SCHEMA` | `bridge` | The schema of the contract, a lowercase identifier of at most 63 characters. |
| `GOVERNANCE_REFRESH_MS` | `30000` | How often Studio reloads when no notification arrives, from 1000 to 600000 milliseconds. |
| `GOVERNANCE_MAX_STALENESS_MS` | `120000` | How old the snapshot may grow while reloads fail, from `GOVERNANCE_REFRESH_MS` to 3600000 milliseconds. A refresh interval above 120000 needs this raised with it. |
| `GOVERNANCE_ALLOWED_ENGINES` | `postgres,mysql,mssql,oracle,mongodb,redis` | The connection type ids Studio admits, separated by commas. |
| `GOVERNANCE_INSTANCE_ID` | none, required | This instance's id, as the next section describes. |
| `GOVERNANCE_PRIVATE_KEYS_FILE` | none, required | The path of the keyring file that holds Studio's private keys, as [keyring](#keyring) describes. |

### Instance id

`GOVERNANCE_INSTANCE_ID` keys the instance's heartbeat row and names its listener's ping channel.

- It is required, and it matches `^[A-Za-z0-9._:-]{1,128}$`, the CHECK on `instance_id`.
- It stays the same across restarts, so a recreated container or pod updates the row it left.
- Studio never falls back to the host name.
  A container's host name changes every time the container is recreated, and each new name would leave a dead heartbeat row behind.
- Every instance needs an id of its own, and an install that runs one replica uses `libredb-studio`.

### Boot checks

With governance on, Studio refuses to start when any of these holds.
It prints one banner that names every variable to fix and never prints a secret, and exits with status 1, so an orchestrator sees a failed start instead of a server that looks healthy and cannot serve.

- `NEXT_PUBLIC_AUTH_PROVIDER` is not `oidc`, or `OIDC_ROLE_CLAIM` or `OIDC_USER_ROLES` is empty.
- `ADMIN_PASSWORD`, `USER_PASSWORD` or `LAUNCH_TOKEN_SECRET` is set.
- `ALLOW_CUSTOM_CONNECTIONS` is set to anything but empty or a value that switches custom connections off: `false`, `0`, `off` or `no`.
- `LIBREDB_EMBEDDED_SAMPLE` or `SQLITE_EMBEDDED_SAMPLE` is set to anything but empty or `false`.
- `SEED_CONFIG_PATH` or `SEED_DISCOVERY_PATH` is set.
- `BIGQUERY_SERVER_CREDENTIALS` or `FIRESTORE_SERVER_CREDENTIALS` is `true`, because the server's own identity would stand in for the credential a grant selects.
- `LIBREDB_MCP_ENABLED` or `LIBREDB_AGENT_ENABLED` is set to anything but empty or a value that switches it off: `false`, `off` or `0`.
- `GOVERNANCE_POSTGRES_URL`, `GOVERNANCE_INSTANCE_ID`, `GOVERNANCE_PRIVATE_KEYS_FILE` or `STORAGE_POSTGRES_SCHEMA` is missing.
- The keyring file does not load, for one of the reasons [keyring](#keyring) lists.
- A variable of the table above has an invalid value, `GOVERNANCE_SOURCE` included, or `GOVERNANCE_ALLOWED_ENGINES` names an engine Studio has no connection type for.

### What governance mode switches off

- Sign-in with a password, a passkey or a launch token: the identity provider is the only way in, for an account that holds the admin or the user role, as [sign-in](#sign-in) describes.
- Custom connections, the embedded samples, seed files and discovery: the governance source is the only catalog of connections.
- The server's own Google identity for BigQuery and Firestore connections.
- MCP and the agent, until a later Studio release runs them under governance.

## Sign-in

Under governance the identity provider at `OIDC_ISSUER` is the only way into Studio, and the `subject` of a grant is that provider's `sub` for the user.
Studio checks the session of every request against these rules:

- A session counts only when Studio's OIDC callback minted it: it carries the ID token's `sub` as a non-empty subject and the ID token's `iss` as its issuer, and the issuer equals `OIDC_ISSUER`, the two compared as URLs with one trailing slash ignored.
- A password, passkey or launch session carries no subject and is refused, and so is a session whose subject is empty or whose issuer is not `OIDC_ISSUER`.
  With `OIDC_ISSUER` unset or not a URL every session is refused, and a changed `OIDC_ISSUER` ends the sessions of the previous issuer.
- A session issued at or before its subject's latest `revoked_before` in [`bridge.session_revocations_v1`](#row-semantics) is refused, typically within a second of the commit that adds the row, because its change notification reloads the snapshot.
  A session's issue time is its token's `iat`, in whole seconds, so a session signed within the second of `revoked_before` counts as issued before it.
  A sign-in after that second gets a session the row does not refuse, so a control plane that means to keep someone out also disables them at the identity provider.
- The OIDC callback applies the same rule to the session it is about to mint: when the subject's latest `revoked_before` is at or after the current second, as when the control plane's clock runs ahead of Studio's or the row's `revoked_before` cannot be read, the sign-in ends on `/login?error=oidc_session_revoked` with no session, and the audit trail records `login_failure` with reason `oidc_session_revoked`.
  So `OIDC_AUTO_REDIRECT` never answers a refused session with a sign-in that every request refuses again.
- Only a snapshot that data routes are served from revokes a session.
  While none can be served, data routes answer 503 instead and no session is refused for a revocation, so an outage of the governance source sets off no wave of sign-ins.
- A refused session's cookie is cleared, so the next page load reaches the sign-in page.
- The OIDC callback applies the same rule to the ID token, so an ID token with an empty `sub` or with an `iss` other than `OIDC_ISSUER` signs no one in and the sign-in ends on `/login?error=oidc_config`.
- `POST /api/auth/login` answers 403 with `{ "success": false, "message": "Password sign-in is disabled: this server signs in through the identity provider only" }` before it reads a credential, and Studio's audit trail records `login_failure` with reason `password_login_disabled`.
- An account whose role claim holds neither the admin nor the user role gets no session.

The identity provider needs:

- `OIDC_ISSUER` set to the issuer the provider writes in its ID tokens, for Microsoft Entra ID the tenant's own issuer rather than the `common` or `organizations` endpoint.
- A confidential client for Studio that uses the authorization code flow with PKCE.
- The roles `admin` and `user` in a flat ID-token claim: an array of strings at the top level of the ID token, named by `OIDC_ROLE_CLAIM`, with `OIDC_ADMIN_ROLES=admin` and `OIDC_USER_ROLES=user`.
- No pairwise subject mapper on Studio's client or on the control plane's.
  The control plane writes a grant under the `sub` it sees and Studio matches it against the `sub` of the session, so both clients must see the same `sub` for a user.

`docs/OIDC.md` describes the session claims and a Keycloak realm set up this way.

The identity provider's `sub` also keys each user's server storage in Studio: their saved queries, history and the rest of their workspace are filed under `sub:` followed by the subject, never under the email.
So a later email change at the identity provider does not move a user's storage, and the next sign-in finds the same rows.
`docs/STORAGE.md` describes the key under governance mode.

## Objects

| Object | Kind | `libredb_studio` | `libredb_platform` | Purpose |
| --- | --- | --- | --- | --- |
| `bridge.contract` | view | SELECT | SELECT | The published contract versions: `version`, `status` (`current` or `deprecated`), `sunset_after` and `notify_channel`. Its shape never changes. |
| `bridge.connections_v1` | view | SELECT | SELECT | The active connections: id, name, engine, environment, group, color, non-secret definition, sealed read and write credentials, MCP flag and update time. |
| `bridge.grants_v1` | view | SELECT | SELECT | One effective grant per subject and connection: `level`, `expires_at`, `downgraded` and `granted_at`. |
| `bridge.settings_v1` | view | SELECT | SELECT | The runtime settings the control plane set: key, JSON value and update time. |
| `bridge.session_revocations_v1` | view | SELECT | SELECT | One row per subject: the latest `revoked_before`. |
| `bridge.seal_canary_v1` | view | SELECT | SELECT | One sealed test envelope per key id. |
| `bridge.query_event` | table | none | SELECT | The rows behind `bridge.query_events_v1`. |
| `bridge.query_events_v1` | view over `bridge.query_event` | INSERT | none | One row per executed unit. |
| `bridge.studio_instance` | table | none | SELECT, DELETE | The rows behind `bridge.studio_instances_v1`. |
| `bridge.studio_instances_v1` | view over `bridge.studio_instance` | SELECT, INSERT, UPDATE | none | Each Studio instance's heartbeat and health. |
| `bridge.trim_query_events(p_retention_days, p_batch)` | function | none | EXECUTE | Retention: deletes the oldest events that started more than `p_retention_days` ago (90 when null, never fewer than 7), at most `p_batch` a call (10000 by default, never more than 100000), and returns how many it deleted. |

The manifest gives every column its type, nullability, default and CHECK, and each table its primary key and the constraints that span several columns.
Four conventions need stating:

- A column's `type` is a name that `::regtype` accepts, such as `timestamptz` or `smallint[]`.
  Compare it by type, as `atttypid = '<type>'::regtype`, because PostgreSQL prints `timestamptz` as `timestamp with time zone`.
- A view column's `nullable` is whether the view's definition can yield NULL there.
  PostgreSQL records no NOT NULL for a view column, so a conformance test reads it from the data or from the table behind the view, never from `pg_attribute.attnotnull`.
- A CHECK on a column of a read view is a rule the governance source keeps for the rows behind it.
  A governance source that breaks one hands Studio a row it skips.
- A view's `default` is only a default set on the view itself.
  An insert through a view over a table otherwise takes the table's default.

## Row semantics

`bridge.connections_v1`:

- `connection_id` matches `^[a-z0-9-]{1,64}$`.
  A control plane generates it before it seals the credentials, because the envelope binds it.
- `engine` is a Studio connection type id, such as `postgres`.
- `definition` is a JSON object of non-secret connection fields from the closed allowlist of [row admission](#row-admission-and-skip-codes).
  A credential in it is a skip, and a governance source should refuse one with a CHECK of its own.
- `read_secret` is required and `write_secret` is optional, both `lsb1` envelopes.
- A NULL `environment`, `group_name` or `color` means the field is absent.

`bridge.grants_v1`:

- One effective row per subject and connection, aggregated from every grant of an active subject on an active connection.
- `subject` is the identity provider's `sub` for the user, opaque text of up to 512 characters.
  An email address is never a key.
- `level` is `write` only when some valid grant is `write` and the connection has a write credential.
  Otherwise it is `read`, and `downgraded` is true when a write was asked for.
- `expires_at` is when the row's current level stops.
  No notification fires at expiry, so Studio compares it with its own clock at every decision.

`bridge.settings_v1` exposes only allowlisted keys published by contract 1, with the values of the [runtime settings](#runtime-settings) registry.

`bridge.session_revocations_v1` is deny-only: a control plane can make a user sign in again with it, and never grant anything.
Studio refuses a session issued at or before its subject's `revoked_before`.
A row whose `revoked_before` Studio cannot read revokes every session of its subject, as `infinity` would, because reading it as no revocation would let through the sessions it was meant to end.
A row without a readable subject can match no session and revokes nothing.
Studio logs both at error level as `Governance revocation rows unreadable`, with the number of each, and neither fails the load, which would hold back every other revocation.

`bridge.seal_canary_v1` holds the canary of each key id, described under [sealed credentials](#sealed-credentials-lsb1).

`bridge.query_events_v1`:

- `connection_id` is the `bridge.connections_v1` id, also for a refused request, so every row joins the control plane's list of connections.
- Studio generates `event_id`, a UUIDv7, before its first attempt, so a retry with `ON CONFLICT DO NOTHING` is idempotent for a role that can only insert.
- `started_at` and `finished_at` are wall-clock times, `duration_ms` comes from a monotonic clock, and the database stamps `received_at`, which the view does not show.
- `source` and `transaction_outcome` are open vocabularies checked only by format, `^[a-z][a-z-]{0,31}$`, so an older governance source never refuses a newer Studio.
  Show an unknown value as it is.
- `status`, `statement_type` and `statement_capture` are closed vocabularies.
- An event dated more than 5 minutes ahead of the database's clock is refused, so the hosts need synchronised clocks.

`bridge.studio_instances_v1` is described under [heartbeat](#heartbeat).

## Grants and the connection list

Grants decide what each person sees and which credential Studio uses for them:

- A connection is visible to a person only while their identity provider subject holds an effective grant on it in `bridge.grants_v1`.
  Studio compares `expires_at` with its own clock at every decision, so an expired grant hides the connection without a notification.
- The role decides nothing about visibility: an admin sees only the connections granted to them, because the admin role opens the admin pages and maintenance only.
- Monitoring is admin-only under governance: `POST /api/db/monitoring` answers 403 to a session whose role is not `admin` before it resolves a connection, and records the denial as `permission_denied` with reason `insufficient_role`.
  Users who share a read principal would otherwise see each other's statements in `pg_stat_activity`.
  The `/monitoring` page shows the refusal as its connection error, and without governance every session keeps its monitoring access.
- The editor uses the credential of the grant's level: a `read` grant uses the read credential, and a `write` grant uses the write credential.
  The agent, MCP, classification and handover paths always use the read credential, whatever the grant.
- A connection that does not exist and one that is not granted to the caller answer the same 404 `CONNECTION_NOT_FOUND`, so a caller cannot learn which ids exist.

What a person sees in the connection list:

- `GET /api/connections/policy` answers `{"customConnections": false, "governance": true, "statementCapture": "redacted"}`, so the editor offers no connection of the person's own.
  `statementCapture` is the active `queryLog.statementCapture`, and while it is `full` the editor shows the one-line notice "Statements you run are recorded in full in this server's query log."
  Without governance the answer has neither `governance` nor `statementCapture`, as before.
- A person with no grants sees "No databases have been granted to you yet. Ask an administrator for access." instead of the list.
- While Studio cannot serve its snapshot, `GET /api/connections/managed` answers 503 `GOVERNANCE_UNAVAILABLE`, never an empty list.
  The connection list then shows a banner that connection access is temporarily unavailable, keeps the connections it already listed, and never shows the no-grants message.
  The list keeps reading the route on its refresh interval and when the window regains focus, and the banner goes away with the first read that answers.

## Per-user providers

Studio opens a governed connection for each person separately, even when two people hold the same grant and Studio opens the connection with the same credential for both:

- Each person's requests run on a provider of their own, named by their identity provider subject, with its own pool of database sessions.
  A `SET` value, a temporary table or any other session state one person leaves behind never reaches another person's statements.
- A person's pool opens a database session only when that person runs something, and holds at most `provider.poolMaxPerUser` sessions, 3 by default.
  So each person who uses a connection can hold that many of its database sessions per Studio instance, and the database's connection limit needs room for that.
- An interactive transaction belongs to the person who began it: another person neither sees it in the transaction status nor runs a statement inside it, and can begin their own beside it.
- A cancel reaches only the statements of the person who sends it, so naming another person's query id stops nothing.
- A disconnect request (`POST /api/db/disconnect`) closes only the providers of the person who sends it, never another person's sessions or transactions on the same connection.
- A session that carries no identity provider subject is refused instead of being given a provider that every person shares.

When a reload takes a person's access to a connection away or changes it, Studio closes that person's providers of the connection right after it swaps the new snapshot in, without waiting for their next request:

- Access is taken away when the grant row is deleted, the connection is gone or admission now skips it, or the grant expired since the previous reload.
- Access changes when the grant's level changes, either way, or when the control plane sealed again a credential the grant opens: the read credential for every grant, and the write credential for a write grant.
  A change that opens the connection the same way, such as a new name, closes nothing.
- An open interactive transaction is rolled back first, and Studio waits at most 5 seconds for the rollback.
  So a revoked person's uncommitted changes are discarded, typically within a second of the change that revoked them.
- Then the provider's database sessions are closed, and Studio waits at most 10 seconds for that.
  Sessions that do not close in time are abandoned and logged, so a database that hangs never holds the next reload.
- The person's next request on the connection is answered from the new snapshot: 404 `CONNECTION_NOT_FOUND` without a grant, or 409 `TRANSACTION_CREDENTIAL_CHANGED` when their transaction was open under a level or credential that changed.
- A provider idle for 30 minutes, and every provider at shutdown, is closed the same way, its open transaction rolled back first.

Without governance every person who opens a connection with the same credential shares one provider, as before.

## Snapshot protocol

Studio reads the governance source in one read-only transaction, so every read sees the same committed state:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SELECT version, status, sunset_after, notify_channel FROM "bridge".contract;
SELECT connection_id, name, engine, environment, group_name, color, definition,
       read_secret, write_secret, mcp_enabled, updated_at FROM "bridge".connections_v1;
SELECT subject, connection_id, level, expires_at, downgraded, granted_at FROM "bridge".grants_v1;
SELECT key, value, updated_at FROM "bridge".settings_v1;
SELECT subject, revoked_before FROM "bridge".session_revocations_v1;
SELECT kid, envelope FROM "bridge".seal_canary_v1;
COMMIT;
```

- Studio reads `bridge.contract` first, and stops as `incompatible` without touching any `_v1` object when no published version is one it supports.
- It names its columns and never selects `*`, and it reads only the columns of the version it supports, so a column appended within version 1 never breaks an older Studio.
- The new snapshot replaces the old one at once.
  Opened credentials are cached by the SHA-256 of their envelope together with the additional authenticated data they opened under, and never logged.
- On every reload Studio compares the effective grants with the previous snapshot and closes exactly the database sessions of the subject and connection pairs that lost access, a grant that expired since the previous reload included, or whose level or read or write envelope changed.
  It rolls back an open transaction there first, as [Per-user providers](#per-user-providers) describes.
- A load uses at most 4 pooled connections, a 5 second connect timeout, a 10 second statement timeout and a 20 second deadline for the whole load.

## Change notification

After a change commits, the governance source notifies channel `libredb_bridge` with the JSON object `{"v":1,"kind":"<kind>"}` as the payload, in any JSON spelling.
The channel is also published as `notify_channel` in `bridge.contract`.

| `kind` | Sent when the rows behind this view change |
| --- | --- |
| `connections` | `bridge.connections_v1` |
| `grants` | `bridge.grants_v1` |
| `settings` | `bridge.settings_v1`, including its allowlist of keys |
| `revocations` | `bridge.session_revocations_v1` |
| `canary` | `bridge.seal_canary_v1` |

- Send the notification from statement-level `AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE` triggers on every table behind those views.
  PostgreSQL delivers it only after commit, folds duplicates within a transaction and sends nothing on rollback.
- Any role that can connect can notify this channel, so the payload is only a hint.
  Studio parses it, never reads data from it, folds notifications into one reload per 250 milliseconds and always reloads the whole snapshot.
- The first notification opens a window of 250 milliseconds, and when it closes one reload runs for every notification that arrived in it.
  That reload starts after any load already under way has ended, so a change that commits while a load runs is in the next snapshot.
- Studio also reloads every `GOVERNANCE_REFRESH_MS`, 30 seconds by default, which covers a lost notification.

Studio's listener is one dedicated connection with TCP keepalive, outside the pool that loads the snapshot, named `libredb-studio-governance-listener` in `application_name`:

- After every connect it issues `LISTEN libredb_bridge` and `LISTEN` on its own ping channel, `libredb_bridge_ping_` followed by the first 16 hex digits of the SHA-256 of its instance id, and only then loads.
- Every 60 seconds it checks the connection with its liveness query, `SELECT 1`, and then pings itself with `SELECT pg_notify($1, $2)`, the ping channel and a random 16 hex digit nonce.
  A ping that has not come back by the next check is missed, and the second missed ping in a row marks the listener deaf and forces a reconnect.
- Its liveness query races a 5 second timer, and on timeout the socket is destroyed, because a half-open TCP connection never errors on its own.
  Every other statement of the listener races the same timer.
- It reconnects after a random delay below a bound that starts at 1 second and doubles with each attempt up to 30 seconds, and the bound starts over once a ping comes back.
- A ping never changes the time of the last notification, so `last_notification_at` proves that the governance source's own notifications arrive.

| Listener state | Meaning |
| --- | --- |
| `listening` | Notifications arrive and the pings come back. |
| `reconnecting` | No connection listens yet, a connect failed or the connection dropped, and Studio reconnects with the backoff from 1 to 30 seconds. |
| `polling` | The server refused `LISTEN`, as a hot standby or a transaction pooler does, so only the periodic reload keeps the snapshot current, and Studio tries `LISTEN` again with the same backoff. |
| `deaf` | Two pings in a row did not come back, and Studio reconnects. |

The connection behind `GOVERNANCE_POSTGRES_URL` must therefore reach the primary, directly or through a session-mode pooler.

## Freshness and readiness

| State | Meaning | Data routes | `GET /api/ready` |
| --- | --- | --- | --- |
| `loading` | No successful load since the start. | 503 `GOVERNANCE_UNAVAILABLE` | 503 `loading` |
| `ok` | The snapshot is younger than `GOVERNANCE_REFRESH_MS` (30 seconds by default), or a notification refreshed it. | served | 200 `ok` |
| `degraded` | Reloads fail, but the snapshot is younger than `GOVERNANCE_MAX_STALENESS_MS` (120 seconds by default). | served | 200 `degraded` |
| `unavailable` | The snapshot is older than the maximum staleness. | 503 `GOVERNANCE_UNAVAILABLE` | 200 `degraded`, so an administrator can still reach the status page |
| `misconfigured` | The governance source lacks the schema, an object or a column, or Studio's role lacks a privilege (SQLSTATE 42P01, 3F000, 42703 or 42501), or the keyring is empty. | 503 | 503 `misconfigured`, naming the object or privilege |
| `incompatible` | No contract version is common to Studio and the governance source. | 503 | 503 `incompatible`, listing both version sets |

`GET /api/ready` needs no session and answers one JSON body in every state:

```json
{ "status": "ok", "contract": { "supported": [1], "active": 1 } }
```

- `status` is `ready` only when governance is off.
  In governance mode it is `ok`, `degraded`, `loading`, `misconfigured` or `incompatible`.
- `contract.supported` lists the versions Studio supports, and `contract.active` is the version it negotiated, or null.
- `detail` is present when there is something to name, in Studio's own words only: the contract object with its SQLSTATE, such as `bridge.connections_v1: 42501`, the variable `GOVERNANCE_PRIVATE_KEYS_FILE` for a keyring that does not load, or both version sets.
  The route is public, so the server's or the keyring loader's message, which can carry file paths and role names, stays in the log.
- `contract.active` is null whenever no snapshot is served: while loading, misconfigured or incompatible, even when an older snapshot is kept for the admin status.

`GET /api/ready` is the readiness probe, and liveness stays on `GET /api/db/health`, which depends on nothing.
The route reads the in-process state only and never opens a user database.
It only reads the state and never starts a load, so an anonymous caller cannot keep loads running during an outage.
The background refresher already retries every 4 to 6 seconds while the snapshot is absent or old.

The manifest publishes the body as JSON Schema with an example for each status.
A background refresher retries every 5 seconds with jitter while the snapshot is absent or expired, so an instance that started before PostgreSQL becomes ready on its own, and the process never exits because the database is down.
An unavailable governance source never ends a session either: data routes answer 503 instead, so an outage sets off no wave of sign-ins.

## Operating notes

How an instance keeps its snapshot current:

- Studio starts its first load when the server starts, without delaying the start, so data routes answer 503 `GOVERNANCE_UNAVAILABLE` until that load succeeds.
- It loads again whenever the snapshot reaches the age `GOVERNANCE_REFRESH_MS`, and every 4 to 6 seconds while it has no snapshot or one older than that, whether or not any request arrives.
- One load runs at a time: a load asked for while another is under way, such as by the readiness probe, joins that load instead of starting a second one.
- A snapshot's age counts from the moment its load started, so its data is never older than its age says.
- A load that finds the schema, an object or a column missing, or a privilege of Studio's role missing, makes the state `misconfigured` at once, even when the snapshot in use is recent, and data routes answer 503 until a load succeeds.
  Its `detail` names the object Studio read, then the server's message and SQLSTATE, such as `bridge.grants_v1: permission denied for view grants_v1 (SQLSTATE 42501)`.
  PostgreSQL reports a schema missing from a qualified name as 42P01 and a schema without `USAGE` as 42501, so either way the message names the schema.
- No common contract version makes the state `incompatible` at once, in the same way.
- Any other failure, such as an outage, a refused connection or a timeout, keeps the snapshot in use: the state turns `degraded` once that snapshot is `GOVERNANCE_REFRESH_MS` old, and `unavailable` once it is `GOVERNANCE_MAX_STALENESS_MS` old.
  A snapshot that reaches the maximum staleness is `unavailable` even when no load has failed.
- The first load that succeeds again serves at once, and Studio logs the first load and every failed load with its cause, never with a value or a credential.

How an instance connects to the governance source:

- `GOVERNANCE_POSTGRES_URL` must reach the primary, directly or through a session-mode pooler, because neither a hot standby nor a transaction-mode pooler carries the listener's `LISTEN`.
- Set `sslmode=verify-full` in the URL wherever the network between Studio and PostgreSQL is not isolated, and make the certificate authority that signed the server's certificate known to Studio, with `sslrootcert` naming its file in the URL or with `NODE_EXTRA_CA_CERTS`.
  Studio's PostgreSQL driver treats `sslmode=require` as `verify-full` too, so a trusted certificate authority is needed either way.
- Always set `sslmode`: a URL without it gets the same TLS setting `STORAGE_POSTGRES_URL` gets, which encrypts a connection to a remote host without verifying the server, and leaves a connection to a local one unencrypted.
- Budget 5 connections of the governance source's database per Studio instance, besides its storage pool: at most 4 pooled connections for loads and 1 dedicated connection for the listener.
- Each pooled connection names itself `libredb-studio-governance` in `application_name`, and the listener's connection `libredb-studio-governance-listener`, so they show up as such in `pg_stat_activity`.
- A load waits at most 5 seconds for a connection, each statement runs under a `statement_timeout` of 10 seconds and is abandoned by Studio after 15, and the whole load gives up after 20 seconds, so a governance source that hangs never holds a load for long.
  Studio closes the connection of a load that gave up, and a statement still running on it keeps its server process busy until it ends, at most the 10 seconds of `statement_timeout`, because PostgreSQL notices a closed connection only when it next reads from it.
- On SIGTERM or SIGINT Studio first inserts the [query events](#query-events) it still holds, for at most 4 seconds, and closes the listener's connection and the governance pool, waiting at most 5 seconds for all of it, and then closes its connections to the users' databases and exits.

## Admin status

`GET /api/admin/governance` answers an administrator of Studio with the governance status of the instance, and the admin Overview page shows it.
It names ids, levels, paths and codes only, never a definition value, an envelope, a credential or a statement, with one exception: the full message of the latest load failure, which only an administrator reads here.

```json
{
  "governance": {
    "source": "postgres",
    "schema": "bridge",
    "contract": { "supported": [1], "published": [1], "active": 1 },
    "freshness": "degraded",
    "snapshot": { "loadedAt": "2026-10-15T08:00:00.000Z", "ageMs": 45000 },
    "lastError": { "at": "2026-10-15T08:00:40.000Z", "kind": "transient", "code": "ECONNREFUSED", "message": "connect ECONNREFUSED 10.0.0.5:5432" },
    "admittedConnections": 4,
    "skipped": [{ "kind": "connection", "id": "billing", "level": "read", "code": "READ_SECRET_UNOPENABLE", "envelopeCode": "UNKNOWN_KID" }],
    "keyringKids": ["<kid>"],
    "canary": { "<kid>": "ok" },
    "settings": [{ "key": "ai.enabled", "source": "runtime" }, { "key": "agent.enabled", "source": "environment" }, { "key": "query.timeoutMs", "source": "default" }],
    "ignoredSettings": [{ "key": "queryLog.statementCapture", "code": "SETTING_INVALID" }],
    "listener": { "state": "listening", "since": "2026-10-15T07:30:00.000Z", "heldMs": 1845000, "lastNotificationAt": "2026-10-15T08:00:12.000Z" },
    "sink": { "queued": 12, "dropped": 0, "rejected": 1, "lastFlushAt": "2026-10-15T08:00:44.000Z", "backingOff": false, "lastSqlstate": "23514" }
  }
}
```

- `freshness` is the state of [Freshness and readiness](#freshness-and-readiness), and `snapshot` is the snapshot in use with its age at the moment of the request, or null before the first successful load.
- `contract.published` and `contract.active` come from the last successful load, and are null before one.
- `lastError` is why the latest load failed, by its kind, its SQLSTATE or driver code and its full `message`, or null when it succeeded.
  The message is the one the log line of that failure carries, the server's own words included, such as the role and the object a privilege is missing on.
  The public `GET /api/ready` names the cause in Studio's own words only and never shows this message.
- `skipped` lists each row, or write level of a row, that [row admission](#row-admission-and-skip-codes) left out, as the heartbeat reports it, plus the envelope code for an envelope that did not open.
- `keyringKids` are the key ids of the keyring the instance opens envelopes with.
- `canary` maps each key id with a [seal canary](#sealed-credentials-lsb1) to `ok` or the envelope code its canary failed with, as the heartbeat reports it, or is null before the first successful load.
- `settings` lists every key of the [runtime settings](#runtime-settings) registry with the `source` of its value at the moment: `runtime` for a valid value the control plane set, `environment` for a key whose environment variable decides otherwise, and `default` for a key that falls back to Studio's default.
- `ignoredSettings` lists each key whose row the last successful load ignored, with its code, as the heartbeat reports it, and never with its value.
- `listener` is the [change notification](#change-notification) listener: its state, `since` when that state has held and `heldMs` for how long at the moment of the request, and `lastNotificationAt`, when the last `libredb_bridge` notification arrived, or null before the first.
  It is null only in a process where no listener runs.
- `sink` is the state of the instance's [query event](#query-events) queue, the value the [heartbeat](#heartbeat) reports in its `sink` column.
- With governance off the route answers `{ "governance": null }`, and a user who is not an administrator gets 403.

## Heartbeat

Every 30 seconds each instance upserts its row of `bridge.studio_instances_v1`, the first time as soon as governance starts:

```sql
INSERT INTO "bridge".studio_instances_v1 (instance_id, studio_version, supported_contracts, contract_version,
       keyring_kids, listener_state, last_notification_at, snapshot_loaded_at, skipped, sink, canary, started_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (instance_id) DO UPDATE SET studio_version = EXCLUDED.studio_version,
       supported_contracts = EXCLUDED.supported_contracts, contract_version = EXCLUDED.contract_version,
       keyring_kids = EXCLUDED.keyring_kids, listener_state = EXCLUDED.listener_state,
       last_notification_at = EXCLUDED.last_notification_at, snapshot_loaded_at = EXCLUDED.snapshot_loaded_at,
       skipped = EXCLUDED.skipped, sink = EXCLUDED.sink, canary = EXCLUDED.canary, last_seen_at = now()
```

- The parameters are bound in the order of the column list, `$1` to `$12`.
- `instance_id` is `GOVERNANCE_INSTANCE_ID`, which matches `^[A-Za-z0-9._:-]{1,128}$` and stays the same across restarts, so a recreated container or pod updates the same row.
  An installer of a one-replica install sets it to `libredb-studio`, as the manifest's samples do.
- The first beat writes `started_at`, the process start time.
  Every later beat sets each reported column and `last_seen_at = now()` and never changes `started_at`, so read liveness from `last_seen_at`.
- `studio_version` is the version of the Studio build, and `supported_contracts` the contract versions it reads, `{1}` in this release.
- `contract_version` is the negotiated version, or 0 while none is.
- `keyring_kids` lists the key ids of Studio's keyring, at most 16.
- `listener_state` is one of the listener states of [change notification](#change-notification).
- `last_notification_at` changes only when a `libredb_bridge` notification arrives, never on the listener's own ping, so it proves delivery.
- `snapshot_loaded_at` is the time of the last successful load, or null before one.
- A beat that fails, because the database is down or refuses the statement, is logged by the instance at most once a minute and changes nothing else: the freshness of the snapshot, and so whether data routes are served, depends on the loads alone.

The three JSON columns have published shapes, which the manifest gives as JSON Schema with an example each.

`skipped` lists the rows Studio left out of its snapshot, at most 500, by ids, levels, paths and codes and never by values.
An item is `{kind, id, level?, path?, code}`: `kind` is `connection` or `setting`, `id` is a connection id or a setting key, and `code` is a [skip code](#row-admission-and-skip-codes).

```json
[
  { "kind": "connection", "id": "0b1e7c3d-9f2a-4e6b-8c5d-7a4f3e2d1c0b", "level": "write", "code": "WRITE_SECRET_UNOPENABLE" },
  { "kind": "connection", "id": "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d", "path": "password", "code": "DEFINITION_HAS_SECRET" },
  { "kind": "setting", "id": "query.timeoutMs", "code": "SETTING_INVALID" }
]
```

`sink` is the state of Studio's [query event](#query-events) queue.
`queued` counts the events waiting for their insert, those of an insert under way included, `dropped` the events dropped because the queue was full, and `rejected` the events the database refused for good.
`lastFlushAt` is when an insert last settled its whole batch, `backingOff` is true while Studio waits out a failed insert, and `lastSqlstate` is the SQLSTATE of the latest failed insert, which a later successful insert leaves in place.
A failure without a SQLSTATE, such as a timeout or a connection the server never accepted, sets `lastSqlstate` to null, and the instance's log names its cause.
A Studio that has recorded no query event reports zero counters, a null `lastFlushAt` and `lastSqlstate`, and `backingOff` false.

```json
{ "queued": 12, "dropped": 0, "rejected": 1, "lastFlushAt": "2026-10-14T12:00:04.000Z", "backingOff": false, "lastSqlstate": "23514" }
```

`canary` maps each key id with a canary to `ok` or the [envelope code](#sealed-credentials-lsb1) its canary failed with.
It is `ok` only when the envelope opens to exactly `{"user":"libredb-canary"}`, and PLAINTEXT_INVALID when it opens to anything else.
It is empty before the first successful load and while the governance source publishes no canary.

```json
{ "0123456789abcdef": "ok", "fedcba9876543210": "UNKNOWN_KID" }
```

### Fleet view

A control plane reads `bridge.studio_instance` to show its Studio instances:

- An instance is live while `last_seen_at` is recent; one not seen for 2 minutes, four missed beats, is down.
  Compare `last_seen_at` with the database's own `now()`, never with the control plane's clock.
- `now() - started_at` is the instance's uptime, and a `started_at` that moves forward is a restart.
- `now() - snapshot_loaded_at` is the age of the snapshot the instance serves; one older than twice `GOVERNANCE_REFRESH_MS` means its loads fail, and the instance's admin status names why.
- `contract_version` 0 means the instance has not negotiated a version: it is still loading, or the governance source is misconfigured or incompatible.
- `listener_state` other than `listening` means changes reach the instance only through its periodic reload.
- A `canary` value other than `ok` means the control plane seals to a key this instance cannot use, so credentials sealed under that key id will not open there.
- `skipped` lists the connections and settings the instance left out, with their codes.
- A row of a retired instance stays until the control plane deletes it.

## Versioning and upgrade order

- `bridge.contract` keeps its shape forever.
- Within a version the only changes allowed are nullable columns appended to a view with `CREATE OR REPLACE VIEW`, new engines, new allowlisted settings and new sources of rows with the same meaning.
- Anything else is a new version, published as `_v2` objects next to the `_v1` ones, with `bridge.contract` listing both.
- Studio declares the versions it supports, `[1]` in this release, uses the highest version both sides have, and reports it in its heartbeat and in `GET /api/ready`.
- A control plane keeps version 1 until its `sunset_after` has passed and no heartbeat has reported version 1 for 7 days.
- Envelope formats are versioned apart from the contract: a version 2 contract still serves `lsb1` envelopes.
- Upgrade the control plane first and Studio after it.
  Studio can always roll back one release.

## Row admission and skip codes

Studio checks each `bridge.connections_v1` row in order and skips a row with a code instead of failing the whole snapshot:

1. `connection_id` has the published format, and no id appears twice.
2. The engine is in `GOVERNANCE_ALLOWED_ENGINES` (by default `postgres,mysql,mssql,oracle,mongodb,redis`) and opens no local file: `sqlite`, `duckdb` and `libredb` are never governed.
3. A PostgreSQL definition without a `database` is skipped, because a server-level connection opens sessions to every database the credential can reach.
4. The definition holds only keys of the allowlist below, each with a value in its domain.
5. The read envelope opens, and the record merged from the row and the read credential passes Studio's own connection validation.
   A NULL `environment`, `group_name` or `color` becomes absent in that record.
   Values from the governance source are used as written: a `${NAME}` or Vault reference in them is never resolved.
6. A write envelope, when the row has one, opens and its merged record passes the same validation.
   A write envelope that does not open, or whose record fails, keeps the row with read access only.

A row reports only its first fault, checked in this order: the id, the engine, the definition, the read envelope with the record merged from it, then the write envelope with its record.
Within the definition, a credential key is reported as `DEFINITION_HAS_SECRET` before any other key is checked.
A skip at the write level, one that carries `"level": "write"`, is the only one whose row stays admitted, with read access only; every other skip leaves the row out.

| Code | Meaning |
| --- | --- |
| `READ_SECRET_UNOPENABLE` | The read envelope did not open, so the row is skipped. |
| `WRITE_SECRET_UNOPENABLE` | The write envelope did not open, so the row is kept with read access only. |
| `DEFINITION_INVALID` | The id, a definition key or a value is not one the contract admits. |
| `DEFINITION_HAS_SECRET` | The definition carries a credential, which belongs in an envelope. |
| `ENGINE_UNSUPPORTED` | The engine is not a Studio type id, or it opens a local file. |
| `ENGINE_NOT_ALLOWED` | The engine is a Studio type id outside `GOVERNANCE_ALLOWED_ENGINES`. |
| `SERVER_LEVEL_NOT_ALLOWED` | A PostgreSQL definition has no `database`. |
| `SETTING_INVALID` | A runtime setting's value is outside its key's domain, so Studio ignores it. |

The definition key allowlist, with each key's value domain:

| Key | Values |
| --- | --- |
| `host` | a string |
| `port` | an integer from 1 to 65535 |
| `database` | a string |
| `schema` | a string |
| `serviceName` | a string |
| `instanceName` | a string |
| `authSource` | a string |
| `skipObjectScan` | a boolean |
| `ssl.mode` | `disable`, `require`, `verify-system`, `verify-ca` or `verify-full` |
| `ssl.rejectUnauthorized` | a boolean |
| `ssl.caCert` | a string, a PEM certificate |

A dotted key is a key of a nested object, as in `{"ssl": {"mode": "verify-full"}}`.
Every other key is refused: the credential keys of [sealed credentials](#sealed-credentials-lsb1), `agentUser`, `agentPassword`, `ssl.clientKey`, `ssl.clientCert`, `sshTunnel`, `queryTimeout`, `readOnly` and anything else.

## Runtime settings

A control plane may set these keys through `bridge.settings_v1`, and no others:

| Key | Type | Allowed | Studio default | Read by |
| --- | --- | --- | --- | --- |
| `ai.enabled` | boolean | | `true` | the routes of the AI bucket, which answer 403 `AI_DISABLED` while it is false |
| `agent.enabled` | boolean | | `LIBREDB_AGENT_ENABLED` | the query agent switch |
| `mcp.enabled` | boolean | | `LIBREDB_MCP_ENABLED` | the MCP endpoint switch, checked again on every request |
| `query.timeoutMs` | integer | 1000 to 3600000 | 60000 | the statement timeout of every governed connection |
| `provider.poolMaxPerUser` | integer | 1 to 10 | 3 | the pool size of each user's database sessions, for sessions opened after the change |
| `queryLog.statementCapture` | string | `none`, `redacted`, `full` | `none` | the query event builder, and a notice in the editor when it is `full` |
| `queryLog.maxStatementBytes` | integer | 256 to 65536 | 4096 | the query event builder, which cuts a captured statement to this many UTF-8 bytes |
| `queryLog.onSinkFailure` | string | `continue`, `refuse` | `continue` | the check that runs before every recorded execution |

- A valid runtime value wins over its environment counterpart.
  Prerequisites such as URLs, keys and the AI model stay in the environment, so `true` enables only what the environment configured.
- Studio checks every row of `bridge.settings_v1` against the registry on each load of the snapshot.
  A value is valid when its key is published by the contract version in use and the value has the key's type and lies inside its allowed values or bounds; a JSON string `"true"` is not a boolean and `1500.5` is not an integer.
- An invalid value is ignored and reported in the heartbeat and on Studio's admin status as a `SETTING_INVALID` skip, and the environment value or the default applies.
  The report names the key and the code, never the value.
  A key the registry does not publish, and a key with more than one row, are ignored and reported the same way.
- A key that is absent, or ignored, leaves the environment value or the default in force, exactly as without governance.
  With governance off Studio reads no runtime value at all.
- The last snapshot's values stay in force while a later load fails.
- Route handlers apply runtime values, and the proxy, which runs before them on every request, never reads them.
- Security posture is never a runtime setting: sign-in, keys, session lifetime, custom connections, samples, CSP and HSTS stay in the environment.
- `ai.enabled` set to `false` makes `POST /api/ai/explain`, `POST /api/ai/describe-schema`, `POST /api/ai/query-safety` and every other route of the AI bucket answer a signed-in caller with 403 and the code `AI_DISABLED`, before any LLM provider is built and before the rate limit is spent.
  A caller without a session still gets 401.
  `true`, or no value, leaves the routes as the environment configured them: without an LLM configuration they keep answering as they do without governance.
- `agent.enabled` feeds the agent's switch and `mcp.enabled` the MCP endpoint's, which `/api/mcp` reads again on every request; each wins over `LIBREDB_AGENT_ENABLED` or `LIBREDB_MCP_ENABLED`, and the model, the ledger and the MCP URL and token label stay prerequisites in the environment.
- In this contract version Studio keeps the agent and MCP off in governance mode whatever `agent.enabled` and `mcp.enabled` say, so a control plane shows those two keys read-only.
  The admin status reports each of them with `held: true` and the note `MCP and agent governance ship in v1.1`.
- A control plane chooses the capture mode it sets.
  `redacted` keeps statements searchable by table and column without their literals.

When the query and pool settings take effect:

- `query.timeoutMs` becomes the statement timeout of every governed connection from the next request after the snapshot that carries it.
  A provider already open with another timeout is closed and reopened with the new one on that request, as when a saved connection's timeout changes without governance.
- `provider.poolMaxPerUser` sizes the pool of each per-user provider Studio creates after the snapshot that carries it.
  A provider already open keeps its pool size until it is torn down: by a disconnect, the idle sweep, a revoked grant or a changed credential.
- `queryLog.statementCapture` is reported by `GET /api/connections/policy` from the next request, and the editor reads that route when the page loads, so the notice for `full` appears or goes away on the next page load.
- `queryLog.onSinkFailure` applies from the next execution after the snapshot that carries it, as [query events](#query-events) describes.

The manifest lists each key with its type, allowed values or bounds, Studio default or environment counterpart, the contract version that published it and the description a control plane shows next to it.

## Query events

Studio records one query event per executed unit:

| `source` | Rows |
| --- | --- |
| `editor` | One per editor statement; `explain` is set for a plan request. |
| `multi-query` | One per executed unit of a multi-statement run, with `unit_index`; units that never ran leave no row. |
| `transaction` | One per statement in an interactive transaction (`transaction_outcome` `open`), plus one when it ends: `committed`, `rolled-back` or `timed-out`. All rows of one transaction share `transaction_id`. |
| `object-edit` | One per applied object edit, with `correlation_id` set to the edit plan's id and the statement the plan sends: its statements one per line, or its command line. The status is `success` when the edit applied, and `error` for any other outcome, with the engine's code when it refused the edit; an apply refused with `AUDIT_UNAVAILABLE` records one `refused` event instead. |
| `maintenance` | One per administrator maintenance action, with status `error` when the action threw or the engine reported it did not run. The statement is NULL, because the engine's provider builds it and Studio's route never sees its text; an action refused with `AUDIT_UNAVAILABLE` records one `refused` event instead. |
| `profile` | One per data profile run (`POST /api/db/profile`), which reads aggregates of user data. Its statement is the profiled object's path as the route quotes it into its reads, such as `"public"."orders"`, or for MongoDB the JSON address of the collection, such as `{"database":"shop","collection":"items"}`; its `statement_type` is `SELECT` on every engine, and `row_count` is NULL. |
| `key-scan` | One per page of a key scan (`POST /api/db/keys/scan`), which reads key names. Its statement is the page request, `SCAN <cursor> [MATCH <pattern>] COUNT <count>` on every engine that walks a key space, its `statement_type` is `OTHER`, and `row_count` is the number of keys the page returned. |

A later version adds `agent`, `agent-handover` and `mcp` once the agent and MCP run under governance, and a control plane shows any source it does not know as it is.

The rows of one interactive transaction share `transaction_id`, a UUID Studio generates when `BEGIN` succeeds.
`BEGIN` and the transaction status record nothing, and each statement request records one `open` row with the text submitted, with `status` `error` when it failed.
Exactly one terminal row ends a transaction, with `statement_type` `OTHER`:

- `committed`, statement `COMMIT`, for the person's commit.
- `rolled-back`, statement `ROLLBACK`, for the person's rollback and for the rollbacks Studio makes itself: when the grant level or credential under the transaction changed (409 `TRANSACTION_CREDENTIAL_CHANGED`, with `status` `error` when Studio could not confirm the rollback), and when a reload takes the grant away and closes the person's providers.
  A close that fails records nothing and keeps the transaction's record, because the transaction may still be open, and is logged as `Governance teardown failed` with `transactionOutcome` `unknown`; the path that later sees the transaction end records its row.
- `timed-out`, with no statement and `status` `cancelled`, when the database driver rolled the transaction back at its five-minute limit, which Studio notices at most 1 second after the limit or at the person's next request.

A `COMMIT` or `ROLLBACK` that fails records `status` `error`: `rolled-back` when the transaction ended with it, else `open`.
A statement that itself ends the transaction, such as a typed `COMMIT`, records only its `open` row.
A statement, `COMMIT` or `ROLLBACK` request from a person who holds no open transaction on the connection, such as one sent right after the five-minute limit, is refused with 400 `QUERY_ERROR` and the sentence `No active transaction` before anything reaches the database, so no statement runs in a transaction without its row.
It is the sentence the database providers answer for a statement outside a transaction, so the editor leaves transaction mode on either.

How the editor and a multi-statement run record:

- An `editor` event has `status` `success`, `error` or `cancelled`, `row_count` when the engine reported a count, and `access_level`, the level of the grant the statement ran with.
- The `multi-query` events of one request share one `correlation_id`, a UUIDv7, and `unit_index` counts its units from 0.
  A run stops at its first failing unit, so the units after it leave no row.
- A request for a well-formed `seed:` id that Studio refuses before anything runs records one `refused` event with the refusal's API code in `error_code`.
  For a connection the caller holds no grant on, or while the snapshot cannot be served, `engine` and `access_level` are NULL; for a refusal of the admission gate (`AUDIT_UNAVAILABLE`) they are set.
- A request Studio rejects as malformed, such as one without a statement or a plan request for a statement the engine cannot explain, leaves no row, because nothing ran.
- `error_code` of a failed statement is the SQLSTATE the driver reported, else Studio's API code for the error, such as `QUERY_ERROR`.
Catalog and metadata reads, schema browsing, monitoring, health checks and pool statistics are not query events.

Delivery:

- Studio queues events in memory, at most 10000, and inserts them every second or at 500 rows with one multi-row `INSERT ... ON CONFLICT DO NOTHING`, and once more when it shuts down.
  An insert carries at most 500 events from the head of the queue and may take 10 seconds, and an event leaves the queue once the database holds it or refused it for good.
- When the queue is full, Studio drops the newest event and counts it in `dropped`, so the events already queued keep their order, and logs the first drop of each spell of a full queue.
- Studio generates each `event_id` when it records the event and keeps it across retries, so a batch sent again after an insert that did land, whose answer was lost, adds nothing.
- A transient failure (SQLSTATE classes 08, 53300, 57P01 to 57P03, 40001, 40P01, or a timeout) keeps the batch and backs off from 1 to 30 seconds: the next insert waits 1 second, then 2, 4, 8 and 16, and then 30 until one succeeds.
  Any other SQLSTATE outside classes 22 and 23, such as 42501 for a missing privilege, is handled the same way and shows in the sink state's `lastSqlstate`, and each failed insert is logged with its SQLSTATE or, for a failure without one, its message.
- A permanent failure (classes 22 and 23) splits the batch: its rows go in one by one, in order, and only the rows the database refuses again are dropped and counted in `rejected`.
  Each is logged as one line on standard output, `{"type":"query_event_rejected","event_id":"<uuid>","sqlstate":"23514","constraint":"query_event_not_future"}`, which carries neither the statement nor the server's message, because that can quote the row; `constraint` is null when the server names none.
  A refusal for good is not a reason to wait, so Studio does not back off after it.
- At shutdown Studio inserts every queued event at once, batch after batch and without waiting out a backoff, for at most 4 seconds, and logs how many events it could not send.
- With `queryLog.onSinkFailure` set to `refuse`, Studio refuses new executions with 503 `AUDIT_UNAVAILABLE` while it is backing off or its queue is at least 90% full, which is 9000 events.
  It checks before a statement reaches the database, for an interactive transaction's `BEGIN`, statements, `COMMIT` and `ROLLBACK` alike, so a refused request runs nothing, and it admits executions again once an insert settles its whole batch and the queue holds fewer than 9000 events.
  A row the database refused for good never trips it, because Studio drops that row and goes on without backing off.
  The sink state's `backingOff` and `queued`, in the [heartbeat](#heartbeat) and on the [admin status](#admin-status), show when it applies.
- With `continue`, the default, Studio keeps executing while it cannot record query events: their events wait in the queue, and once it is full the newest are dropped and counted in `dropped`.

Capture follows `queryLog.statementCapture`, which is `none` while the control plane sets no valid value:

| Mode | `statement` | `statement_fingerprint` | `error_message` |
| --- | --- | --- | --- |
| `none` | NULL | NULL | NULL |
| `redacted` | the statement with every string, number and comment replaced by `?` and white space collapsed, cut to `queryLog.maxStatementBytes` | the lowercase hex SHA-256 of the whole redacted text | NULL |
| `full` | the statement as submitted, with the value after `PASSWORD` or `IDENTIFIED BY` and the user information of every URI replaced by `[REDACTED]`, cut to `queryLog.maxStatementBytes` | NULL | the error text, masked the same way and cut to 1000 characters |

- The statement is the text the user submitted, never one Studio built around it, such as an `EXPLAIN` or an added row limit.
- A statement is cut at `queryLog.maxStatementBytes` UTF-8 bytes on a character boundary, and `statement_truncated` is true when it was.
  The fingerprint is taken before the cut, so every run of one long statement shape shares it.
- `redacted` reads a statement the way its engine reads it: SQL under the engine's own rules for literals and comments, a MongoDB command with its keys, operation, collection and database kept, and a Redis command with only its name kept.
  A password written as a bare word after `IDENTIFIED BY` is replaced as well, and the statement of an engine Studio has no reader for is stored as a single `?`.
- `full` keeps every other secret written into a statement, such as a Redis `AUTH` argument, and an error text that quotes a statement in the driver's own words can carry one, so choose it only where the statements themselves must be kept.
- A refused request whose connection did not resolve, such as one for a connection the caller holds no grant on, stores no statement and no error text in any mode, because the engine that would read them is unknown.
- In every mode `statement_type` is `SELECT`, `INSERT`, `UPDATE` or `DELETE` from the keyword that operates the statement, also behind a `WITH`, `DDL` for `CREATE`, `ALTER`, `DROP` and `TRUNCATE`, and `OTHER` for any other statement, for a unit without text and for every engine whose statements are not SQL.
  A `profile` row is `SELECT` and a `key-scan` row `OTHER` on every engine, because their statement names what was read rather than being a statement the user wrote.
- The statement of a `profile` or `key-scan` row is captured like any statement of its engine, so under `redacted` a quoted SQL name is kept while a Redis page request keeps only `SCAN` and one `?` per argument, and no cursor or pattern value reaches the row.
- A request the admission gate refuses records one `refused` row with its route's source, the connection's engine and access level, and `error_code` `AUDIT_UNAVAILABLE`.
- `explain` is `plan` for a plan request that only estimates and `analyze` for one that runs the statement.
- `error_code` is the SQLSTATE, the driver's code or the API code of a refusal, cut to 64 characters, in every mode.

Bind parameter values, result rows and credentials are never recorded: a row has no column for them.
Studio stores text so that a row is never refused for its shape: `username` is cut to 320 characters, `connection_name`, `correlation_id` and `transaction_id` to 128, a NUL character becomes U+FFFD, and `client_ip` is set only when the client address is an IP address.
A row takes about 950 bytes with a redacted statement of 170 characters and about 660 bytes with capture `none`.

## Sealed credentials: lsb1

A control plane stores each credential only as an `lsb1` envelope sealed to Studio's public key.
It can write envelopes and never open them; only Studio holds the private keys, in its [keyring](#keyring).
An envelope has this form and matches this pattern:

```text
lsb1.<kid>.<base64url(enc)>.<base64url(ciphertext || tag)>
^lsb1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22,})$
```

- `kid` is the lowercase hex of the first 8 bytes of the SHA-256 of the raw 32-byte X25519 public key.
- The cipher is HPKE (RFC 9180) in base mode with DHKEM(X25519, HKDF-SHA256) `0x0020`, HKDF-SHA256 `0x0001` and AES-256-GCM `0x0002`, single shot, with a fresh ephemeral key per seal, the `info` string `libredb/bridge/secret/v1` and no PSK.
- The additional authenticated data binds the envelope to its row: `UTF-8(JCS({c: connection_id, d: base64url(SHA-256(UTF-8(JCS(definition)))), e: engine, k: kid, l: "read" or "write", s: "lsb1"}))`, where JCS is RFC 8785.
  Moving an envelope to another connection, level or engine, or changing the definition it was sealed for, makes it fail with `AUTH_FAILED`.
- Definition values are limited to strings, booleans, null, integers within plus or minus 2^53, and objects and arrays of these.
  The contract version is not bound, so a new contract version does not invalidate stored envelopes.
- The plaintext is a JSON object of at most 65536 UTF-8 bytes whose keys are a subset of `user`, `password`, `connectionString`, `privateKey`, `privateKeyPassphrase`, `apiKeyId`, `apiKeySecret`, `sslClientKey` and `sslClientCert`, all strings.
  Each level's envelope is a complete credential set, and Studio maps `sslClientKey` and `sslClientCert` into `ssl.clientKey` and `ssl.clientCert`.
- Changing a connection's id, engine or definition therefore needs a newly sealed read credential, and a newly sealed write credential or its explicit removal.
  A governance source should enforce this with a trigger its runtime role cannot drop.

An envelope that does not open fails with one of these codes, and no message carries key material or plaintext:

| Code | Meaning |
| --- | --- |
| `FORMAT` | The envelope does not match the format above. |
| `UNKNOWN_KID` | No key in Studio's keyring has the envelope's key id. |
| `AUTH_FAILED` | The envelope was sealed to another key or for another binding, or it was altered. |
| `LOW_ORDER_POINT` | The ephemeral key gives an all-zero Diffie-Hellman result. |
| `PLAINTEXT_INVALID` | The plaintext is not a JSON object of string credential keys within the size limit. |

The canary proves the seal before the first real credential is created: the control plane publishes, for each key id it seals to, the envelope of `{"user":"libredb-canary"}` sealed for connection `canary`, level `read`, engine `canary` and definition `{}`.
Studio opens every canary on every load and reports `ok` or the failure code per key id in its heartbeat's `canary` column, so a wrong public key shows up at once.

The vectors file, `tests/fixtures/governance/lsb1-vectors.json`, holds positive and negative cases with their exact codes, and it is what a control plane tests its sealer against.
Studio generates it with `scripts/generate-governance-vectors.ts`, and `bun scripts/generate-governance-vectors.ts --check` exits 0 only when the file is exactly what the script builds.
Its keys are test keys and protect nothing: each private key is the SHA-256 of the UTF-8 of a published label under `testKeys`, so anyone can derive it, and none may ever seal or open a real credential.
`keyring` is the opening Studio's keyring in the form of a keyring file, `{"version":1,"keys":[...]}`, and every key in the file is the unpadded base64url of its raw 32 bytes.
Each vector records these fields:

| Field | What it holds |
| --- | --- |
| `id`, `description` | The vector's stable name, and what it shows. |
| `recipientPublicKey`, `kid` | The public key the envelope is sealed to, and its kid. |
| `binding` | The `connectionId`, `level`, `engine` and `definition` the envelope is sealed for. |
| `definitionJcs` | The RFC 8785 text of the definition. |
| `aadHex` | The additional authenticated data, in lowercase hex. |
| `ephemeralPrivateKey` | The fixed ephemeral key, which a real seal draws afresh every time. |
| `plaintext` | The credential set, sealed as the UTF-8 of its JSON text, which is also its RFC 8785 text. |
| `envelope` | The envelope sealed from the fields above. |
| `opening` | The `envelope` and `binding` Studio is given: the sealed ones, except that a negative vector changes one of them in a single respect. |
| `expected` | `ok` when Studio opens the envelope to `plaintext`, otherwise the code it fails with. |

From a vector's `recipientPublicKey`, `binding`, `plaintext` and `ephemeralPrivateKey`, a control plane's sealer must produce its `envelope` byte for byte, and its key id, canonical JSON and additional authenticated data must equal `kid`, `definitionJcs` and `aadHex`.
The positive vectors cover the canary, text beyond ASCII, the characters canonical JSON escapes, a nested `ssl` object with a PEM `caCert`, numbers and booleans, key order, the write level and all nine plaintext keys.
The negative vectors cover every code above: `FORMAT` for base64url that is not the canonical encoding of its bytes and for padded standard base64, `UNKNOWN_KID`, `AUTH_FAILED` for a changed level, connection id, engine, host and TLS mode and for a flipped ciphertext bit, `LOW_ORDER_POINT` for two points of small order, and `PLAINTEXT_INVALID` for an unknown key and for a value that is not a string.
An `lsb1` vector never changes; a change to one would be a new format, `lsb2`.

### Keyring

Studio holds the private keys that open envelopes in a keyring file, at the path `GOVERNANCE_PRIVATE_KEYS_FILE` names:

```json
{ "version": 1, "keys": ["<unpadded base64url of a raw 32-byte X25519 private key>"] }
```

- Studio holds each key under the `kid` of its public key, and opens an envelope only with the key its `kid` names.
- The file lists 1 to 16 keys, because the heartbeat reports every key id and `keyring_kids` takes at most 16.
- Deliver the keyring as a mounted file, never as an environment variable, readable only by the user Studio runs as, uid `1001` in Studio's image.
  With Docker that is a file with mode `0400` owned by uid `1001`, bind-mounted read-only, and in Kubernetes a Secret mounted as a file.
- Studio reads the file once, when it starts, and keeps the keys for the life of the process, so a changed keyring takes effect when Studio restarts.
- Studio refuses to start, naming `GOVERNANCE_PRIVATE_KEYS_FILE` and the reason, when the file cannot be read or is not JSON, when its `version` is not 1, when it lists no key or more than 16, when a key is not the unpadded base64url of 32 bytes, or when two keys have the same `kid`.
- Neither that message nor any log line carries key material: Studio logs the key ids it loaded and nothing else.
- Opened credentials stay in Studio's memory, cached under the SHA-256 of their envelope together with the additional authenticated data they opened under, so a cached credential is never served for any binding but its own.

The control plane holds only the public key, as the unpadded base64url of its raw 32 bytes, and seals to it.
OpenSSL makes a key pair, and prints the private key for the keyring, the public key for the control plane and its `kid`:

```sh
umask 077
openssl genpkey -algorithm X25519 -outform DER -out x25519.der
tail -c 32 x25519.der | base64 | tr '+/' '-_' | tr -d '=\n'
openssl pkey -inform DER -in x25519.der -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n'
openssl pkey -inform DER -in x25519.der -pubout -outform DER | tail -c 32 | openssl dgst -sha256 -binary | head -c 8 | od -An -tx1 | tr -d ' \n'
```

The private key is the last 32 bytes of the PKCS #8 file; delete `x25519.der` once the keyring holds it.

### Key rotation

A control plane cannot seal a stored credential again under a new key, by design, so a new key pair joins the keyring before the old one leaves it.
Steps 1, 2 and 5 are Studio's, and steps 3 and 4 are the control plane's:

1. Add the new private key to the keyring of every Studio instance, keep the old one in it, and restart Studio.
2. Wait until the heartbeat of every live instance lists the new key id in `keyring_kids`, and its `canary` still reports `ok` for the old key id.
3. Switch the control plane to the new public key.
   It publishes the canary of the new key id, and every heartbeat should report `ok` for that key id before the next step.
4. Enter again, in the control plane, every credential still sealed under the old key id.
   Each credential entered again is sealed anew, so Studio closes the sessions it opened and rolls back their open transactions; do this at a quiet time.
5. Remove the old private key from the keyring of every Studio instance and restart Studio.
   Keep the old private key in escrow for as long as backups that hold envelopes sealed to it are kept.

If a private key leaks, rotate every governed database credential as well, because that key and any copy of the governance source's database open every envelope sealed to it.

## API codes

Under governance Studio's API answers these codes in the `code` field of an error:

| Code | HTTP status | When |
| --- | --- | --- |
| `CONNECTION_NOT_FOUND` | 404 | The connection does not exist or is not granted to the caller; the two are indistinguishable. |
| `GOVERNANCE_UNAVAILABLE` | 503 | The snapshot is loading, too old, misconfigured or incompatible. |
| `AUDIT_UNAVAILABLE` | 503 | `queryLog.onSinkFailure` is `refuse` and Studio cannot record query events: it is backing off after a failed insert or its queue is at least 90% full, so the request was refused before any statement ran. |
| `TRANSACTION_CREDENTIAL_CHANGED` | 409 | The grant level or credential under the caller's open transaction changed, and Studio rolled the transaction back; `rolledBack` is `false` when it could not confirm the rollback. |
| `AI_DISABLED` | 403 | `ai.enabled` is `false`, and a route of the AI bucket refused a signed-in caller before any LLM provider was built. |
