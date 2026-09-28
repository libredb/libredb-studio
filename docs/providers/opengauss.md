# openGauss Provider

> openGauss support for LibreDB Studio. The provider is the **PostgreSQL provider over a
> different password handshake** ([#815](https://github.com/libredb/libredb-studio/issues/815)):
> openGauss speaks the PostgreSQL wire protocol and the PostgreSQL SQL dialect, and the only
> thing it does differently is ask for the password in a form `pg` cannot answer.
> This document is the single reference point for the openGauss provider.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `opengauss` |
| **Family** | SQL (relational) |
| **Driver** | `pg`, over [`opengauss-socket.ts`](../../src/lib/db/providers/sql/opengauss-socket.ts) |
| **Query language** | `sql` (the PostgreSQL dialect) |
| **Default port** | `5432` — the same number PostgreSQL listens on; a stock openGauss answers there |
| **Connection pooling** | Yes — inherited `pg.Pool` from the PostgreSQL provider |
| **Connection string** | No toggle, exactly as on the `postgres` entry: the scheme would be PostgreSQL's own and two engines cannot own one scheme ([`connection-string-parser.ts`](../../src/lib/db/connection-string-parser.ts)) |
| **Transactions** | Yes — inherited; `BEGIN READ ONLY` is enforced by the engine, measured |
| **Query cancellation** | Yes — inherited; PID tracking + `pg_cancel_backend` |
| **Authentication** | openGauss request **10** (`sha256`) and request **11** (`md5_sha256`) |
| **Agent read-only profile** | Yes — `BEGIN READ ONLY`, with openGauss's own role probe (§5) |
| **Source** | [`src/lib/db/providers/sql/opengauss.ts`](../../src/lib/db/providers/sql/opengauss.ts) |
| **Handshake** | [`opengauss-auth.ts`](../../src/lib/db/providers/sql/opengauss-auth.ts), [`opengauss-socket.ts`](../../src/lib/db/providers/sql/opengauss-socket.ts) |
| **Base** | [`src/lib/db/providers/sql/postgres.ts`](../../src/lib/db/providers/sql/postgres.ts) |
| **Tests** | [`tests/integration/db/opengauss-provider.test.ts`](../../tests/integration/db/opengauss-provider.test.ts) |

---

## 1. Why the provider exists

openGauss is an open-source relational database donated by Huawei, and it is what
GaussDB, Vastbase and other derived engines are built from. Its wire protocol is
PostgreSQL's, its SQL is PostgreSQL's, and `pg` connects to it for anything that does not
ask for a password. What it does not do is answer PostgreSQL's authentication request
types: the two it sends instead, **10** and **11**, are outside what `pg` knows, and
`pg-protocol` mis-parses them as SASL — so a stock `pg` client cannot log in at all.

So the provider is a `PostgresProvider` subclass that swaps the authentication handshake and
nothing else. That is the whole design, and the reason it is a subclass rather than a new
provider: everything that is genuinely PostgreSQL's — the catalogs, the statistics, the
grammar, the maintenance statements, the monitoring views — is already correct here, and
re-measuring it would be claiming a second engine where there is one.

**What is openGauss's own, and therefore measured rather than inherited:**

1. the password handshake (§2),
2. the session-cleanup statement (§3),
3. the role-privilege vocabulary behind the agent's read-only boundary (§4),
4. two of the four composed catalog reads the agent grounds a run on (§5).

---

## 2. Authentication: requests 10 and 11

openGauss decides which handshake runs by the request it sends, and it is the server's
choice, not the operator's. There is therefore **no dialog setting**: a connection is
`opengauss` or it is `postgres`, and the same fields are asked either way
(`host`, `port`, `user`, `password`, `database`).

`opengauss-socket.ts` sits between the socket and `pg`'s connection code as a Duplex frame
filter and answers the server's authentication message itself, so `pg` never sees it. TLS
is owned by the same filter so that an encrypted connection is a real one rather than two
stacked.

### 2.1 Request 10 — `sha256`

The server sends a salt and an eight-character token, and expects an HMAC-SHA256 proof
built from a key the client derives and a signature the client signs.

| | |
|---|---|
| Payload | `[code i32][int i32][salt 64 ascii][token 8 ascii][tail]` — the int is openGauss's own `password_encryption_type` (2 on 5.0.0), not needed to answer and so skipped; a 64-character tail is the server's signature, a 4-byte tail is an iteration count, anything else means the default |
| Key derivation | `k = PBKDF2-HMAC-SHA1(password, hexDecoded(salt), iterations, 32)` |
| `serverKey` | `HMAC-SHA256(k, "Sever Key")` |
| `clientKey` | `HMAC-SHA256(k, "Client Key")` |
| `storedKey` | `SHA256(clientKey)` |
| Proof | `clientKey XOR HMAC-SHA256(storedKey, hexDecoded(token))`, sent as 64 lowercase hex characters |
| Signature | `HMAC-SHA256(serverKey, hexDecoded(token))` — verified, not used at runtime |

**"Sever Key" is the protocol's own misspelling**, in `crypt.cpp` and in the client alike, and
the derivation is an HMAC over that literal rather than a concatenation with `Key`. Reading
it as a typo to correct produces a 64-character hex string either way, so only a test that
recomputes the HMAC from the primitives can tell the two apart.

**The stored `rolpassword` is `sha256`(6) + salt(64) + serverKey(64) + storedKey(64) + `encodeIteration`(11).**

### 2.2 Request 11 — `md5_sha256`

Request 11 is what `gsql` sends, and it is the one whose published formula is incomplete:
`fe-auth.cpp` omits the iteration suffix, and a client built from it is refused at
`Fauth.cpp:328` with *Invalid md5 password*. The server's `crypt.cpp` hashes
`pg_md5_encrypt(shadow_pass + SHA256_LENGTH, md5Salt, 4)`, so the **suffix is part of the
input**. Its payload is a different layout from request 10's — `[code i32][salt 64 ascii][md5Salt 4 binary]`,
with no int after the code and a four-byte md5 salt at the end:

```
md5( latin1( salt + serverKeyHex + storedKeyHex + encodeIteration(iters) ) + md5Salt )
```

`encodeIteration(10000)` is `"ecdfecefade"`: the base is `"ecdfdcefade"`, and each digit is
placed least-significant-first (so 10000 → `e`, `c`, `d`, `f`, `e`). With the suffix omitted
the client sends 192 characters where the server expects 203.

### 2.3 The reply frame declares a length that counts itself

The reply is a `PasswordMessage` whose length field is `4 + payload.length` — it counts the
four bytes of the length field itself, where PostgreSQL's own `PasswordMessage` declares
`payload.length`. That is a real deviation from the protocol convention, so it is pinned by
a test rather than left to a reader of the code, and it is pinned **as it is, not as it
should be**: a raw socket was answered with `AuthenticationOk` (code 0) by
`opengauss/opengauss:5.0.0` with a reply carrying 65 bytes under a declared length of 69. A
stricter server would read that as a short frame and hang, which is the reason the number is
asserted rather than assumed harmless.

### 2.4 The other handshake is not this provider's

openGauss also accepts `md5`, the third of its three. It needs no socket filter — the
request is a normal `md5` one, with a random salt, in the form `pg` already answers — so it
is not a reason a connection has to be typed `opengauss`. Measured against a live
`opengauss/opengauss:5.0.0`: `md5` connects over stock `pg` with no filter, and both of
this provider's own handshakes connect with the filter in place and without it do not.

### 2.5 What the hba method chooses

`pg_hba.conf` decides which handshake the server *sends*:

| `pg_hba.conf` method | Request the server sends | Needs the filter |
| :--- | :--- | :--- |
| `md5` | 10 or 11, by server version and `password_encryption_type` | yes |
| `sha256` | 10 or 11, by server version and `password_encryption_type` | yes |
| `trust` | none (no password asked for) | no |

The row that surprises people is the last one: a `trust` line never asks for a password, so
the filter is never entered and a `trust` connection works over stock `pg`.

---

## 3. Session cleanup: openGauss has no `DISCARD`

The PostgreSQL provider ends a read-only session with `DISCARD ALL`, which exists to release
**advisory locks a `ROLLBACK` does not undo** — verified on PostgreSQL 18, where a session
holding an advisory lock across a rolled-back transaction keeps it until the session ends.
Without that, a pooled session would keep a lock the run that took it has already given up.

**openGauss has no `DISCARD` statement at all**: `DISCARD ALL` is refused with *not yet
supported*, and so is every other `DISCARD` target. So the cleanup is a seam on the base
provider and the openGauss provider overrides it with the one statement that does the same
job, `pg_advisory_unlock_all()`.

| Provider | Statement | Measured |
| :--- | :--- | :--- |
| `postgres` | `DISCARD ALL` | advisory lock taken and released across sessions |
| `opengauss` | `pg_advisory_unlock_all()` | advisory locks run; lock and unlock verified on `opengauss/opengauss:5.0.0` |

The seam is `discardSessionState(client)` on `PostgresProvider`, so the intent stays named in
one place and the vocabulary is the only thing that differs.

---

## 4. The agent's read-only boundary

`run_read_query` and the investigation agent refuse a connection whose own login could do
more than read, and the check asks a question in each engine's own vocabulary. For
PostgreSQL that is `pg_has_role` / `to_regrole` / `pg_read_server_files`
(`AGENT_ROLE_PRIVILEGE_SQL`); **none of that runs on openGauss**. The seam is
`readOnlyPrivilegeSql()`, and openGauss overrides it with the two columns its own privilege
model publishes:

| | `postgres` | `opengauss` |
| :--- | :--- | :--- |
| Superuser | `rolsuper` | `rolsuper` |
| System administrator | — (no such role) | `rolsystemadmin` |
| Other capabilities | `pg_read_server_files`, `pg_write_server_files` | — |

The row shape is unchanged on purpose: four booleans, `true` meaning *the capability is
held*, so `assertAgentRoleIsUnprivileged` keeps failing closed on a shape it cannot read.
An operator is told, in `docs/MCP.md` and in the dialog, that on openGauss the seed role
**must be neither a superuser nor a system administrator**.

Both directions were measured on a live `opengauss/opengauss:5.0.0` with a
least-privilege role and a `SYSADMIN` role: the first grounds a run, the second is refused.

---

## 5. What the agent grounds a run on

A run on openGauss reads the same four composed catalog reads every agent engine reads, and
three of the four are PostgreSQL's own text because they were measured to answer here:
`columns` and `statistics` are the PostgreSQL composers unchanged, and so is the
`EXPLAIN (FORMAT JSON)` plan prefix.

`relations` and `indexes` are **not** reusable. The PostgreSQL composers lean on three
constructs openGauss's grammar refuses (openGauss 5.0.0, each error verbatim):

| Construct | openGauss's answer |
| :--- | :--- |
| `WITH ORDINALITY` | `syntax error at or near "WITH ORDINALITY"` |
| multi-array `unnest(a, b)` | `function unnest(integer[], integer[]) does not exist` |
| `LATERAL` | a syntax error, and `invalid reference to FROM-clause entry` for the implicit form |

So `composeOpenGaussRelations` and `composeOpenGaussIndexes` expand the key arrays the way
openGauss does answer — a set-returning function in a subquery's own `SELECT` list, joined
back on `oid`, with `generate_subscripts` for the two `conkey`/`confkey` and `indkey` arrays
— and the two facts that make the substitution correct were measured rather than assumed:

- **`pg_index.indkey` is 0-based** here (`array_lower` is `0`, `array_upper` is `n - 1`),
  while **`pg_constraint.conkey` and `confkey` keep PostgreSQL's 1-based lower bound.** An
  index key therefore reads as `ix.indkey[k.ord]` and a column number as
  `pg_get_indexdef(ix.indexrelid, (k.ord + 1)::int, true)` — the same statement PostgreSQL
  wants, with a subscript shifted by one.
- A **two-key index whose first key is an expression** (`lower(name)`, then a plain `id`)
  comes back in key order with the expression named by `pg_get_indexdef`, which is what the
  PostgreSQL composer reports and what the index panel needs.

Each rewrite is its parent composition, character for character, with only the expansion
replaced; `tests/unit/lib/agent/composed-sql.test.ts` pins that, so the two cannot drift
apart silently. A composite foreign key (`(a, b)` → `(a, b)`) was used as the fixture
because it is the case that pairs two key arrays, and it came back with every column
matched to its own counterpart.

---

## 6. Capabilities, and what is inherited rather than re-measured

`opengauss` is a `PostgresProvider` subclass, so the capability set, the editable kinds, the
written fields and the container path shapes are the PostgreSQL ones. That is a statement
about the code, not a second measurement: the same tests walk the inherited declarations for
both type-ids (`tests/unit/db/container-path-shapes-capability.test.ts`, and the census in
`tests/isolated/object-*-declarations.test.ts`).

| Surface | Behaviour | Source |
| :--- | :--- | :--- |
| Schema introspection | inherited — `MATERIALIZED` CTE shape, two-phase loading | `PostgresProvider` |
| Statistics / monitoring | inherited — `pg_stat_*` views, graceful degradation | `PostgresProvider` |
| Maintenance (`VACUUM`, `ANALYZE`, `REINDEX`) | inherited | `PostgresProvider` |
| Inline row editing | inherited — keys declared, `hasSource` read through the catalog | `PostgresProvider` |
| `EXPLAIN (FORMAT JSON)` | inherited prefix; measured to answer on openGauss | `ESTIMATING_EXPLAIN_PREFIX` |
| Read-only boundary | **openGauss's own** — `rolsuper` / `rolsystemadmin` (§4) | `opengauss.ts` |
| Session cleanup | **openGauss's own** — `pg_advisory_unlock_all()` (§3) | `opengauss.ts` |
| Catalog grounding (agent) | **two of four own** — `relations`, `indexes` (§5) | `composed-sql.ts` |

---

## 7. Known limits

- **The agent's grounding reads are verified on `opengauss/opengauss:5.0.0` only.** A
  distribution built on openGauss (GaussDB, Vastbase) reports its own version string, so the
  version panel can tell it from stock openGauss; the grammar claims above were not re-probed
  on those builds.
- **`md5` is not this provider's handshake** (§2.3). A `md5`-hba connection works over
  stock `pg`; typing it `opengauss` is harmless but buys nothing.
- **`org_database` privileges** and openGauss's own security-label objects are not surfaced;
  the object browser is PostgreSQL's, so an openGauss-specific object type is not listed.
- **No `pg_stat_statements` assumption is made here**: slow queries behave as they do on
  PostgreSQL, which is a PostgreSQL statement about an extension that may or may not be
  installed, and openGauss's own `dbe_perf` views are not read.

---

## 8. Measured facts, and where they came from

Every fact in this document was measured against a live container, not read from a manual.

| Fact | Measured on |
| :--- | :--- |
| Request 10 accepted, request 11 accepted, `md5` accepted | `opengauss/opengauss:5.0.0` |
| `DISCARD ALL` and every `DISCARD` target refused | same |
| `pg_advisory_unlock_all()` runs; lock/unlock across sessions | same |
| `rolsystemadmin` exists; least-privilege role passes, `SYSADMIN` refused | same |
| `WITH ORDINALITY`, multi-array `unnest`, `LATERAL` refused | same |
| `indkey` 0-based; `conkey`/`confkey` 1-based | same |
| Composite-FK pairing and expression-index naming in the four composed reads | same |
| `password_encryption_type=2` | same |
| PostgreSQL's `AGENT_ROLE_PRIVILEGE_SQL` does not execute | same |

The image's superuser is **`opengauss`**, not `omm` — `omm` is the operating-system account
the server runs under, and every `Invalid username/password` seen before that was
discovered was a login name, not a handshake.
