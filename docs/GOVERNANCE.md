# Governance contract

Studio can run under a control plane: a separate service that decides which databases each person may open in Studio, with which credential, and that keeps a record of what they ran.
The two never call each other.
The control plane publishes a governance source, a set of PostgreSQL views and tables in one schema, and Studio reads it with a role of its own and writes its heartbeat and query events back into it.
This document is that contract, version 1, for anyone who builds or operates a control plane.

Governance is off unless an operator sets `GOVERNANCE_SOURCE=postgres`, and a Studio without that variable behaves exactly as it would without this document.
Studio publishes the contract before it implements all of it: until a release's notes announce governance mode, a release publishes the files below and reads no governance source.

## Contents

- [Conformance files](#conformance-files)
- [Schema and roles](#schema-and-roles)
- [Objects](#objects)
- [Row semantics](#row-semantics)
- [Snapshot protocol](#snapshot-protocol)
- [Change notification](#change-notification)
- [Freshness and readiness](#freshness-and-readiness)
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
  Opened credentials are cached by the SHA-256 of their envelope and never logged.
- On every reload Studio compares the effective grants with the previous snapshot and closes exactly the database sessions of the subject and connection pairs that lost access, or whose level or credential changed.
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
- Studio also reloads every `GOVERNANCE_REFRESH_MS`, 30 seconds by default, which covers a lost notification.

Studio's listener is one dedicated connection with TCP keepalive:

- After every connect it issues `LISTEN libredb_bridge` and `LISTEN` on its own ping channel, `libredb_bridge_ping_` followed by the first 16 hex digits of the SHA-256 of its instance id, and only then loads.
- Every 60 seconds it pings itself with `SELECT pg_notify($1, $2)`.
  Two missed pings mark it deaf and force a reconnect.
- Its liveness query, `SELECT 1`, races a 5 second timer, and on timeout the socket is destroyed, because a half-open TCP connection never errors on its own.

| Listener state | Meaning |
| --- | --- |
| `listening` | Notifications arrive and the pings come back. |
| `reconnecting` | The connection dropped, and Studio reconnects with a backoff from 1 to 30 seconds. |
| `polling` | The server refused `LISTEN`, as a hot standby or a transaction pooler does, so only the periodic reload keeps the snapshot current. |
| `deaf` | Two pings did not come back, and Studio reconnects. |

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
- `detail` is present when there is something to name: the missing object or privilege, or both version sets.

The manifest publishes the body as JSON Schema with an example for each status.
A background refresher retries every 5 seconds with jitter while the snapshot is absent or expired, so an instance that started before PostgreSQL becomes ready on its own, and the process never exits because the database is down.
An unavailable governance source never ends a session either: data routes answer 503 instead, so an outage sets off no wave of sign-ins.

## Heartbeat

Every 30 seconds each instance upserts its row of `bridge.studio_instances_v1`:

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

- `instance_id` is `GOVERNANCE_INSTANCE_ID`, which matches `^[A-Za-z0-9._:-]{1,128}$` and stays the same across restarts, so a recreated container or pod updates the same row.
  An installer of a one-replica install sets it to `libredb-studio`, as the manifest's samples do.
- The first beat writes `started_at`, the process start time.
  Every later beat sets each reported column and `last_seen_at = now()` and never changes `started_at`, so read liveness from `last_seen_at`.
- `contract_version` is the negotiated version, or 0 while none is.
- `keyring_kids` lists the key ids of Studio's keyring, at most 16.
- `listener_state` is one of the listener states of [change notification](#change-notification).
- `last_notification_at` changes only when a `libredb_bridge` notification arrives, never on the listener's own ping, so it proves delivery.
- `snapshot_loaded_at` is the time of the last successful load.

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

`sink` is the state of Studio's query event queue: events waiting, events dropped because the queue was full, events the database refused, the last successful flush, whether Studio is backing off, and the last SQLSTATE it saw.

```json
{ "queued": 12, "dropped": 0, "rejected": 1, "lastFlushAt": "2026-10-14T12:00:04.000Z", "backingOff": false, "lastSqlstate": "23514" }
```

`canary` maps each key id with a canary to `ok` or the [envelope code](#sealed-credentials-lsb1) its canary failed with.

```json
{ "0123456789abcdef": "ok", "fedcba9876543210": "UNKNOWN_KID" }
```

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
5. A NULL `environment`, `group_name` or `color` becomes absent, and the merged record must pass Studio's own connection validation.
   Values from the governance source are used as written: a `${NAME}` or Vault reference in them is never resolved.
6. The read envelope opens.
   A write envelope that does not open keeps the row with read access only.

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
- An invalid value is ignored and reported in the heartbeat and on Studio's admin status as a `SETTING_INVALID` skip, and the environment value or the default applies.
- Security posture is never a runtime setting: sign-in, keys, session lifetime, custom connections, samples, CSP and HSTS stay in the environment.
- In this contract version Studio keeps the agent and MCP off in governance mode whatever `agent.enabled` and `mcp.enabled` say, so a control plane shows those two keys read-only.
- A control plane chooses the capture mode it sets.
  `redacted` keeps statements searchable by table and column without their literals.

The manifest lists each key with its type, allowed values or bounds, Studio default or environment counterpart, the contract version that published it and the description a control plane shows next to it.

## Query events

Studio records one query event per executed unit:

| `source` | Rows |
| --- | --- |
| `editor` | One per editor statement; `explain` is set for a plan request. |
| `multi-query` | One per executed unit of a multi-statement run, with `unit_index`; units that never ran leave no row. |
| `transaction` | One per statement in an interactive transaction (`transaction_outcome` `open`), plus one when it ends: `committed`, `rolled-back` or `timed-out`. All rows of one transaction share `transaction_id`. |
| `object-edit` | One per applied object edit, with `correlation_id` set to the edit plan's id. |
| `maintenance` | One per administrator maintenance action. |
| `profile` | One per data profile run, which reads aggregates of user data. |
| `key-scan` | One per page of a key scan, which reads key names. |

A later version adds `agent`, `agent-handover` and `mcp` once the agent and MCP run under governance, and a control plane shows any source it does not know as it is.
Catalog and metadata reads, schema browsing, monitoring, health checks and pool statistics are not query events.

Delivery:

- Studio queues events in memory, at most 10000, and inserts them every second or at 500 rows with one multi-row `INSERT ... ON CONFLICT DO NOTHING`, and once more when it shuts down.
- A transient failure (SQLSTATE classes 08, 53300, 57P01 to 57P03, 40001, 40P01, or a timeout) keeps the batch and backs off from 1 to 30 seconds.
- A permanent failure (classes 22 and 23) splits the batch and drops only the rows the database refuses, each logged as one line `{type: "query_event_rejected", event_id, sqlstate, constraint}` without statement text.
- With `queryLog.onSinkFailure` set to `refuse`, Studio refuses new executions with 503 `AUDIT_UNAVAILABLE` while it is backing off or its queue is at least 90% full.
  A refused row never trips this.

Capture follows `queryLog.statementCapture`:

| Mode | `statement` | `statement_fingerprint` | `error_message` |
| --- | --- | --- | --- |
| `none` | none | none | none |
| `redacted` | literals, numbers and comments replaced with `?`, whitespace collapsed | SHA-256 of the redacted text | none |
| `full` | the statement cut to `queryLog.maxStatementBytes` (`statement_truncated` says when it was), with password literals and URI user information masked | none | the error text, cut to 1000 characters |

Bind parameter values, result rows and credentials are never recorded.
A row takes about 950 bytes with a redacted statement of 170 characters and about 660 bytes with capture `none`.

## Sealed credentials: lsb1

A control plane stores each credential only as an `lsb1` envelope sealed to Studio's public key.
It can write envelopes and never open them; only Studio holds the private keys, in its keyring.
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

## API codes

Under governance Studio's API answers these codes in the `code` field of an error:

| Code | HTTP status | When |
| --- | --- | --- |
| `CONNECTION_NOT_FOUND` | 404 | The connection does not exist or is not granted to the caller; the two are indistinguishable. |
| `GOVERNANCE_UNAVAILABLE` | 503 | The snapshot is loading, too old, misconfigured or incompatible. |
| `AUDIT_UNAVAILABLE` | 503 | `queryLog.onSinkFailure` is `refuse` and Studio cannot record query events. |
| `TRANSACTION_CREDENTIAL_CHANGED` | 409 | The grant level or credential under an open transaction changed, and Studio rolled the transaction back. |
