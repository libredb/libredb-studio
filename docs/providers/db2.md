# Db2 LUW Provider

The `db2` type-id: IBM Db2 for Linux, UNIX and Windows over DRDA, through the `db2-node` 1.0.25 driver.
Source: [`src/lib/db/providers/sql/db2/`](../../src/lib/db/providers/sql/db2/).
Tests: [`tests/unit/db/db2/`](../../tests/unit/db/db2/) and [`tests/integration/db/db2-provider.test.ts`](../../tests/integration/db/db2-provider.test.ts).
Tracking issue: [#786](https://github.com/libredb/libredb-studio/issues/786).

Every measured fact on this page was measured against the `icr.io/db2_community/db2` 12.1.0.0 and 11.5.9.0 containers, first on 2026-10-03 through `db2-node` 1.0.22 on Node 24 and Bun 1.4.2, again on 2026-10-04 through 1.0.24 on Bun 1.4.2, and a third time on 2026-10-04 through 1.0.25 on Bun 1.4.2, unless the sentence names another basis.
A sentence that names 1.0.22 or 1.0.24 describes that version and is kept for the reason it gives.

## 1. Overview

Studio connects to a Db2 LUW database, lists its schemas and their objects, describes tables, views and materialized query tables, shows the stored definition of views, routines and triggers, runs SQL with server-side paging, and offers RUNSTATS and REORG on one table at a time.
A table takes inline edits and imports into an existing table.
The driver still has one defect that can lose a write: a value bound to a large CLOB, DBCLOB or BLOB column is not written and no error says so, which reaches the grid's inline editor; read [Known issues](#4-known-issues-db2-node-1025) before you edit such a column.

Db2 for z/OS and Db2 for IBM i are out of scope.
Both need IBM's Db2 Connect gateway to be reached over DRDA, and nothing here was measured against either.

### 1.1 The driver, and why

`db2-node` is a DRDA client written in Rust and shipped as a native N-API addon, one prebuilt binary per platform, under the MIT licence.
It needs no IBM client, no `IBM_DB_HOME` and no CLI driver download, which is what lets every image and the desktop build carry Db2 without an IBM licence step.
It is pinned exactly, at 1.0.25, as a regular dependency.
The defects 1.0.22 had were reported upstream at [gurungabit/db2-node#12](https://github.com/gurungabit/db2-node/issues/12) and fixed in 1.0.24 by [gurungabit/db2-node#13](https://github.com/gurungabit/db2-node/pull/13), and the ones 1.0.24 still had were reported as [gurungabit/db2-node#19](https://github.com/gurungabit/db2-node/issues/19) to [#25](https://github.com/gurungabit/db2-node/issues/25) and fixed in [1.0.25](https://github.com/gurungabit/db2-node/releases/tag/v1.0.25); the one still present is in section 4.

### Concept mapping

| Db2 | Studio |
|---|---|
| One database (`TESTDB`) | One connection; the database is not a level, because nothing switches it on a live connection |
| A schema | A container in the object tree |
| A table, view, materialized query table, alias, sequence | A row in its kind's folder |
| A module | A group whose children are its procedures and functions |
| A procedure or function | A routine row, addressed by its `SPECIFICNAME` |
| A trigger | A row under its table, or under its own schema when the table lives in another schema |

## 2. Architecture

`Db2Provider` extends `SQLBaseProvider`, and every module but one talks to the driver through the local `Db2Driver` types of `driver.ts`.

| File | What it owns |
|---|---|
| `capabilities.ts` | `DB2_CONTAINER_LEVELS`, `DB2_OBJECT_KINDS`, `db2Capabilities`, `db2Labels`: pure data, no driver import |
| `driver.ts` | The `Db2Driver` types, `loadDb2Driver()`, the one `import("db2-node")`, and `describeDriverAbsence()` |
| `connection.ts` | `resolveTarget()`, `assertTransport()`, `clientOptions()` and `openClient()`: the TLS mapping and the CA temp-file lifecycle |
| `params.ts` | `normaliseParams()`, which refuses an array or object parameter before the driver reads it as bytes |
| `values.ts` | `db2TypeName()`, `readResult()` and its LOB integrity warning, and `DB2_PREVIEW_PROJECTION` |
| `catalog.ts` | The catalog SQL, and the decoders that read its rows: names, column types, object detail and source text |
| `objects.ts` | The row mappers of the object surface |
| `maintenance.ts` | `adminCommandTarget()`, `maintenanceStatement()` (a plain `CALL SYSPROC.ADMIN_CMD`) and the statement that reads a target's type |
| `monitoring.ts` | The version, catalog-count and table-list statements, and their reads |
| `index.ts` | The composition root |

The constructor opens nothing.
`connect()` resolves the target, checks the transport, loads the driver, writes the CA file when one is given and opens one `Client`; there is no pool.
`disconnect()` closes that client, removes the CA file and its directory, and marks the provider disconnected.
A deployment without the driver answers `describeDriverAbsence()`'s message, "Db2 is not available in this deployment: the db2-node driver is not installed. Install it, or use an image that ships it, to open Db2 connections.", and every other engine keeps working.

## 3. Connection

### 3.1 Fields

| Field | Required | Notes |
|---|---|---|
| Host | Yes | "Host is required for Db2" |
| Port | No | `50000`, Db2's conventional DRDA listener |
| Database | Yes | "Database name is required for Db2" |
| User | Yes | "User is required for Db2" |
| Password | No | Sent empty when none is given; sent in cleartext without TLS, see section 3.3; any printable character is sent as typed, `!`, `^`, `[`, `]` and `\|` included since 1.0.25 (K23, fixed) |
| SSL panel | Yes, unless you opt out | Section 3.3 |
| Send the password without TLS | Yes, while SSL Mode is disable | A checkbox the form shows only while SSL Mode is disable; without it ticked, a connection with no TLS is refused (section 3.3) |

A pasted `db2://user:password@host:50000/TESTDB` fills the fields; there is no connection-string toggle, the Oracle precedent.
`?ssl=true`, `?ssl=1` and `?security=SSL` (any case) turn TLS on in the pasted form as Verify (system trust), never as Require, and `?ssl=false` or `?ssl=0` turn it off.
A stored connection string is re-parsed by the shared parser on every connect and must start with `db2://`, or the connect fails with "A Db2 connection string must start with db2://".
Its parsed fields win over the form fields, as they do for PostgreSQL, and a TLS parameter the parser does not know, or one that contradicts the SSL panel, is an error rather than a setting dropped in silence.
Any query parameter other than `ssl` and `security` is refused, naming the parameter, and so is a string that carries both.
Behind an SSH tunnel the provider dials the tunnel's local end, never the host re-parsed from the string.
Because `db2-node` checks a certificate against the name it dials, which there is the tunnel's local address, Verify (system trust) and Verify full are refused through a tunnel; use Verify CA with the server's CA certificate.

`db2-node` takes a structured options object, not a CLI keyword string, so a `;` in a field cannot inject a connection attribute and no guard for it exists.

### 3.2 Server versions

Db2 LUW 12.1.0.0 and 11.5.9.0 were measured.
The version shown in the monitoring overview is `SERVICE_LEVEL` of `SYSIBMADM.ENV_INST_INFO`, for example "DB2 v12.1.0.0"; the driver's own `serverInfo()` is never read, because it answers the server class `QDB2/LINUXX8664` and the release code `SQL12010` on 1.0.24 (the instance name on 1.0.22, K13), neither of which names the version a reader expects.

### 3.3 TLS

TLS is the part of this provider to set up first.
A stock Db2 server with `AUTHENTICATION=SERVER` offers only DRDA security mechanism 3 without TLS, which sends the user and the password in cleartext.
`db2-node` 1.0.22 fell back to it in silence, even when asked for an encrypted mechanism (K11); 1.0.24 refuses to send the password that way unless the connection asks for the mechanism by name, measured on 12.1.0.0 and 11.5.9.0: "Server does not support the requested encrypted security mechanism (requested=0x0009, offered=0x0003); refusing to send credentials without encryption."
So the provider refuses a connection with no TLS settings, with an error that says the password would travel in cleartext, unless the connection carries the explicit insecure opt-in, `allowInsecureAuth: true`, shown in the connection form as a checkbox that says so.
With the opt-in, and only then, the provider passes `securityMechanism: "userPassword"`, which is how the opt-in reaches the driver; over TLS it passes no mechanism and the driver's encrypted default is kept, which the stock server answers with mechanism 3 inside the TLS session (measured).
Turn the opt-in on only for a database on a network you trust end to end, such as a local container.

The SSL panel's modes map to `db2-node` options as follows:

| Mode | `db2-node` options | What is checked |
|---|---|---|
| Disabled, with the insecure opt-in | `ssl: false, securityMechanism: "userPassword"` | Nothing; the password travels in cleartext |
| Require (no verification) | `ssl: true, rejectUnauthorized: false` | Encryption only; a server that impersonates the host is not detected |
| Verify (system trust) | `ssl: true, rejectUnauthorized: true` | The chain, against the system trust store |
| Verify CA | `ssl: true, rejectUnauthorized: true, caCert: <file>, sslClientHostnameValidation: "OFF"` | The chain, against your CA; not the host name |
| Verify full | `ssl: true, rejectUnauthorized: true, caCert: <file>, sslClientHostnameValidation: "Basic"` | The chain and the host name |

Verification is the default once TLS is on; "Require" is a separate choice you make on purpose.
Verify full without a CA certificate checks the chain against the system trust store, and the host name as before.
Verify CA without a CA certificate is refused: it checks no host name, so against the system trust store it would accept any publicly trusted certificate, issued for any name, and send it the password.
The panel holds the CA as PEM text and `db2-node` wants a file path, so the provider writes the PEM to `ca.pem` in a fresh `libredb-db2-` directory under the system temp directory, mode 0600, on connect, and removes the directory on disconnect and on a failed connect.
On Windows the mode bits do not apply, and the file is private through the per-user access control on the temp directory under the user profile.
A client certificate or key is refused with "db2-node 1.0.25 has no client-certificate authentication; remove the client certificate and key from this Db2 connection.", never ignored.

Measured through 1.0.24 on 12.1.0.0 and 11.5.9.0, and again through 1.0.25: Verify CA with the CA held as PEM text connects through the provider, and the opt-in connects without TLS where the same connection without the named mechanism is refused.
Measured through 1.0.22: the connection negotiates TLS 1.3; a CA certificate with host-name validation, host-name validation `OFF` and `rejectUnauthorized: false` each connect; the system trust store alone answers `UnknownIssuer` for a server signed by a private CA; Verify full by an IP address the certificate does not name fails with "invalid peer certificate: certificate not valid for name", where Verify CA connects; and a plaintext connection to the TLS port is reset.

#### Enabling TLS on the server

These are the commands the measurement ran on the 12.1.0.0 container as `db2inst1`, with a private CA; with a CA you already have, skip the CA steps and import its certificate instead.
Check them against IBM's Db2 documentation for your version before you run them on a server you care about.

```bash
D=/database/config/db2inst1/ssl
mkdir -p $D && cd $D
G=gsk8capicmd_64
# A private CA (skip with a CA of your own)
$G -keydb -create -db ca.kdb -pw caPassw0rd -stash
$G -cert -create -db ca.kdb -stashed -label myca -dn "CN=My Db2 CA" -ca true -size 2048 -sigalg SHA256_WITH_RSA -expire 365
$G -cert -extract -db ca.kdb -stashed -label myca -target ca.arm -format ascii
# The server keystore, a request, the signed certificate, and the CA it chains to
$G -keydb -create -db server.kdb -pw svPassw0rd -stash
$G -certreq -create -db server.kdb -stashed -label db2server -dn "CN=db2.example.com" -san_dnsname db2.example.com -size 2048 -sigalg SHA256_WITH_RSA -file server.csr
$G -cert -sign -db ca.kdb -stashed -label myca -target server.arm -format ascii -file server.csr -expire 300 -sigalg SHA256_WITH_RSA -san_dnsname db2.example.com
$G -cert -add -db server.kdb -stashed -label myca -file ca.arm -format ascii -trust enable
$G -cert -receive -db server.kdb -stashed -file server.arm
# Point the instance at the keystore and open the TLS port
db2 update dbm cfg using SSL_SVR_KEYDB $D/server.kdb SSL_SVR_STASH $D/server.sth SSL_SVR_LABEL db2server SSL_SVCENAME 50001
db2set DB2COMM=SSL,TCPIP
db2stop && db2start
```

Then paste `ca.arm` (it is PEM) into the SSL panel's CA certificate field, set the port to 50001, and choose Verify full.
`DB2COMM=SSL,TCPIP` keeps the plaintext port open beside the TLS one; drop `TCPIP` once every client uses TLS.

### Connection string

The scheme shown for Db2 is `db2://`.
Its row in `CONNECTION_STRING` is declared in [`connection-string.ts`](../../src/lib/db/providers/sql/db2/connection-string.ts).
Its `paste` claims `db2://`, with port 50000 by default.
Its `readTls` reads `security` first and the boolean `ssl` only without it (#786).
`security=SSL` is the keyword Db2's own CLI and JDBC drivers read, and it maps to `verify-system`, a verifying mode, because the Db2 provider fails closed on unverified transport: without TLS the password crosses the network in cleartext.
`ssl` maps `true` and `1` onto that same mode, and `false` and `0` onto `disable`.
It runs no seed load check.

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `db2` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/sql/db2/execution-ui.ts).
How `mapDatabaseError` classifies its driver's errors, its SQLCODEs of an access refusal, is the `db2` row of `DRIVER_ERROR_CLASSIFIERS`, declared in [`driver-errors.ts`](../../src/lib/db/providers/sql/db2/driver-errors.ts).

## 4. Known issues (db2-node 1.0.25)

The live script `tests/live/db2-known-issues.ts` probes the row below and every row fixed in 1.0.24 and 1.0.25 against a running Db2 and prints `PRESENT` or `GONE`, so a driver bump starts by running it.
On 2026-10-04 it printed the same verdict for every row on 12.1.0.0 and on 11.5.9.0: `PRESENT` for K24 and `GONE` for every other row, K23 included, probed with a user whose password holds all five of its characters.

| # | Issue | What you see | Mitigated by the provider | Workaround |
|---|---|---|---|---|
| K24 | A value bound to a CLOB, DBCLOB or BLOB column declared 32768 bytes or longer is not written | The statement answers 0 changed rows, with no error and no diagnostic, and the row keeps its old value; beside other parameters the whole statement writes nothing; at 32767 bytes the value is written | Yes for the grid: its inline editor offers no edit of a CLOB, DBCLOB or BLOB cell and says why on the cell, the object browser's preview leaves those columns out, and a result holding one carries a warning that the grid does not edit it ([gurungabit/db2-node#31](https://github.com/gurungabit/db2-node/issues/31)) | Write the value with an `UPDATE` of your own, as a literal, or bound through `CAST(? AS VARCHAR(n))` or `CAST(? AS VARBINARY(n))`, which Db2 converts to the LOB |

K24 was found on 2026-10-04 while moving to 1.0.25, and 1.0.24 has it too: a `CLOB(1M)` or `BLOB(1M)` bound alone answered 0 rows on both, and beside another parameter 1.0.24 refused the statement with "parameter descriptor count 1 does not match parameter count 2" where 1.0.25 writes nothing.
The README of 1.0.25 binds a Buffer through `CAST(? AS BLOB(1M))`, and that statement wrote nothing either, on 12.1.0.0 and 11.5.9.0.
A `DBCLOB(1K)` and an `XML` column are written.
It is reported upstream as [gurungabit/db2-node#31](https://github.com/gurungabit/db2-node/issues/31); D225 in `docs/BACKLOG.md` tracks it.

The provider declares CLOB, DBCLOB and BLOB in `inlineEditRefusedColumns`, so the grid's inline editor opens no editor on such a cell and shows the reason on it, and a result with such a column carries a warning above the grid that names those columns and says the grid does not edit them.
The declared length does not reach a result, a `CLOB(1M)` column arrives described as `VarChar(32777)` and a `CLOB(1K)` as `CLOB`, so every such column is refused and named, a short one included.
Reading them is exact since 1.0.25: `SELECT *` over `APP.ALLTYPES` answers all 25 columns and 3 rows, each value equal to the column read on its own (K4, fixed).

### Fixed in 1.0.25

These were measured on 1.0.24, reported upstream one issue each, and fixed in [1.0.25](https://github.com/gurungabit/db2-node/releases/tag/v1.0.25); each now probes `GONE` on 12.1.0.0 and 11.5.9.0, and the provider workaround each one needed is gone with it unless the line says otherwise.

- K4: a LOB or XML column read beside other columns came back wrong, lost rows or failed: a BLOB beside a CLOB answered the CLOB's bytes, a CLOB(1M) beside a GRAPHIC dropped rows when a later LOB was NULL, a CLOB beside a DOUBLE failed with "Protocol error: Invalid SQLDTAGRP indicator 0xEF", and `SELECT *` over `APP.ALLTYPES` answered 1 row of 3 and 23 of 25 columns ([gurungabit/db2-node#19](https://github.com/gurungabit/db2-node/issues/19), [#20](https://github.com/gurungabit/db2-node/issues/20), fixed by [#27](https://github.com/gurungabit/db2-node/pull/27)). Every such read, NULL LOB rows and a 50000-byte CLOB included, now answers what each column read alone answers. The integrity warning is gone; the preview still leaves CLOB, DBCLOB and BLOB out, for K24, and reads XML.
- K15: two columns of one name collapsed into one value in a row ([gurungabit/db2-node#21](https://github.com/gurungabit/db2-node/issues/21), fixed by [#28](https://github.com/gurungabit/db2-node/pull/28)). Object rows still keep only the last; the provider reads `rowMode: "array"`, which keeps both, and names the repeat `A (2)`, never a name the statement itself declares.
- K16: a BOOLEAN parameter had to be a JS boolean, so the text `true` the grid's inline editor binds was refused ([gurungabit/db2-node#22](https://github.com/gurungabit/db2-node/issues/22), fixed by [#28](https://github.com/gurungabit/db2-node/pull/28)). The texts `true` and `false` are now stored as those booleans, so a BOOLEAN cell takes an inline edit.
- K17: a failure the driver raised itself carried no SQLSTATE and nothing else to classify it by ([gurungabit/db2-node#23](https://github.com/gurungabit/db2-node/issues/23), fixed by [#28](https://github.com/gurungabit/db2-node/pull/28)). It still carries no SQLSTATE, which only a server gives, and now carries a `driverCode`, which the provider maps (section 7.1).
- K23: a password holding `!`, `^`, `[`, `]` or `|` was sent wrongly and refused as "user id or password invalid" ([gurungabit/db2-node#25](https://github.com/gurungabit/db2-node/issues/25), fixed by [#29](https://github.com/gurungabit/db2-node/pull/29)). Measured with one user per character and one holding all five, over TLS under the default mechanism and under `userPassword` and without TLS under `userPassword`, through Bun and Node: every one signs in, the IBM CLP signs in with the same passwords over TCP, and a wrong password is still refused. The provider's refusal of those characters is gone.
- The TLS library compiled into the addons is past four RustSec advisories, section 12 ([gurungabit/db2-node#24](https://github.com/gurungabit/db2-node/issues/24), fixed by [#26](https://github.com/gurungabit/db2-node/pull/26)).

### Fixed in 1.0.24

These were measured on 1.0.22, reported upstream at [gurungabit/db2-node#12](https://github.com/gurungabit/db2-node/issues/12), K18 to K22 in [a later comment](https://github.com/gurungabit/db2-node/issues/12#issuecomment-5965620029) on 2026-10-03, and fixed by [gurungabit/db2-node#13](https://github.com/gurungabit/db2-node/pull/13), released as [1.0.24](https://github.com/gurungabit/db2-node/releases/tag/v1.0.24); each now probes `GONE` on 12.1.0.0 and 11.5.9.0, and the provider workaround each one needed is gone with it unless the line says otherwise.

- K1: non-ASCII text in CHAR or VARCHAR read back as EBCDIC 037 mojibake. Catalog names are still read as HEX, for the reasons section 6.1 gives.
- K2: an INTEGER beside a DECFLOAT or BOOLEAN was byte-swapped.
- K3: a BOOLEAN column alone returned phantom rows.
- K5: XML rows whose value is NULL were dropped.
- K6: BIGINT read as a JS number, lossy above 2^53, and could not be bound losslessly.
- K7: no CLOB, DBCLOB or BLOB could be fetched. One read on its own now is, and beside other columns too since 1.0.25 (K4).
- K8: TIMESTAMP(0) and TIMESTAMP(12) failed to decode.
- K9: every `CALL` failed with SQLSTATE 07005, SQLCODE -517.
- K10: binding a JS `bigint`, alone or inside an array or object, aborted the process.
- K11: without TLS the driver fell back to sending the password in cleartext in silence. It now refuses unless asked by name, which is how the insecure opt-in asks (section 3.3).
- K12: the `currentSchema` option had no effect. The provider still binds every catalog query's schema and passes none.
- K13: `serverInfo()` answered the instance name. It now answers the server class, and the provider still reads the version from `SYSIBMADM.ENV_INST_INFO`.
- K14: `queryTimeout` rejected on the client and left the statement running on the server. It now cancels it on the server, given the privileges section 7.4 names; the provider still sets none, and bounds a transaction statement by closing its session instead (section 7.4).
- K18: a statement that starts with a comment was refused with SQLSTATE 42612, SQLCODE -84.
- K19: an UPDATE or DELETE that matched no row reported -2147221503 changed rows.
- K20: a value truncated with a warning desynchronised the driver.
- K21: a row wider than one DRDA block failed with "Protocol error: invalid DSS magic byte".
- K22: a bound DECIMAL that did not fit its column, or was not a number, was stored as a wrong value with no error. It is now refused before the statement runs, with K17's message.
- From K16: a GRAPHIC parameter is padded with blanks rather than U+0000, and TIMESTAMP(12) and `Date` parameters are taken.

## 5. Capabilities

| Capability | Value | Why |
|---|---|---|
| Query language | SQL | |
| Default port | 50000 | DRDA listener convention |
| EXPLAIN | No | Db2's EXPLAIN fills the explain tables rather than answering a plan; reading them back is possible on 1.0.24, where a `CALL` runs, and is not built yet |
| External query limiting | Yes | Inherited |
| Create Table | No | No Db2 row of column types exists for the dialog, which would otherwise emit PostgreSQL DDL, and an import into a new table would write `TEXT`, which Db2 refuses, and `NUMERIC`, which Db2 reads as `DECIMAL(5,0)` (D145) |
| Inline row edit | Yes | Tables only, and never a CLOB, DBCLOB or BLOB column, which db2-node does not write when bound (K24). Off on 1.0.22, where a read-then-write-back stored corrupted text (K1) and a DECIMAL that did not fit was stored wrong (K22); see section 7.5 |
| Data import | Yes | Into an existing table, the one kind that declares `acceptsRowWrites`; not into a new table, as Create Table above |
| Result pagination | Yes | Section 7.2 |
| Transactions and SANDBOX | Yes | On a session of its own, section 7.7; SANDBOX refuses `BEGIN` and `CALL`, which can commit |
| Query cancel | No | Not wired yet: 1.0.24's `Client.cancel()` and its `queryTimeout` cancel the statement on the server through `WLM_CANCEL_ACTIVITY`, which needs monitoring and cancel privileges a plain user may not hold (D392) |
| Foreign keys | Yes | Inherited |
| Maintenance | Yes | Run Statistics and Reorganize Table, per table only |
| Connection string | Yes | A `db2://` paste fills the fields |
| Identifier quoting | Double quotes | Declared, because port 50000 would otherwise fall to the PostgreSQL heuristic |
| Statement terminator | Not declared | A generated statement ends with `;`, the default when none is declared; a trailing `;` is accepted |
| Container levels | Schema | |
| Container path shapes | Exact | Like Oracle |
| Preview projection | Yes | `previewProjection` is `DB2_PREVIEW_PROJECTION`: the object browser's preview names each column and leaves CLOB, DBCLOB and BLOB columns out, named in a comment above the statement, because the grid does not edit them (K24); XML is read; a preview whose column list is not loaded yet still reads `SELECT *`, under a comment that says so |

The application's query timeout is not forwarded to the driver: on 1.0.22 the driver's own timeout left the statement running on the server (K14), and on 1.0.24 it cancels it through a second session that needs privileges this version does not ask a user to hold.
The provider bounds a transaction statement with it instead, section 7.4.

### SQL writing

[`db2/sql-writing.ts`](../../src/lib/db/providers/sql/db2/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalStandard` and read back by `unquoteStandard`: the quote is doubled and a backslash is data.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
A bind is spelled by `placeholderQuestion`, as `?` at every position.
Measured on Db2 LUW 12.1.0.0 through db2-node 1.0.22 (#786), both directions: `VALUES 'O''Brien'` answers `O'Brien`, and `VALUES 'a\b'` answers the three characters `a\b` with `LENGTH` 3, so a backslash is data.
db2-node binds a params array against `?`, measured on the same server (#786).
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field spells a result export's column types through `ddlTypes`, the standard spelling with `CLOB` for text: Db2 has no TEXT, and measured on 12.1.0.0, `CREATE TABLE ... (c TEXT)` is SQL0204N `"TEXT" is an undefined name`, while BIGINT, DOUBLE PRECISION, BOOLEAN, TIMESTAMP and BLOB are whole types.
`CLOB` is the unbounded character type, chosen over a VARCHAR whose bound a cell could pass (#786).
No name was measured standing alone on Db2 in its first version (#786), so it holds `NOTHING_STANDS_ALONE` and every bare name is re-spelled from its family.
A binary cell is written by `binaryBinaryHex`, `BX'0102'`: measured on Db2 LUW 12.1.0.0 (#786), `INSERT … VALUES (X'0102deadbeef')` into a `BLOB` or a `VARBINARY` column is SQL0408N, "a value is not compatible with the data type of its assignment target", because `X'…'` is a character string here.
`BX'0102deadbeef'` goes into `BLOB`, `VARBINARY` and `VARCHAR FOR BIT DATA` alike, reading back as `HEX(…)` = `0102DEADBEEF`, and `BX''` inserts the zero-length value into all three.
`NO_BARE_SPELLING` and `NULL_NON_FINITE` complete it.

## 6. Object surface

### 6.1 Containers

The containers are the rows of `SYSCAT.SCHEMATA` whose name does not start with `SYS` and is not `NULLID` or `SQLJ`, sorted by name.
The schema equal to `CURRENT SCHEMA` is marked as the session default.
Schema names are stored blank-padded in the catalog (`SCHEMANAME` arrives as `"APP     "`), so every schema column is trimmed on its right.
Every other name is read as stored, so an object name that ends in a blank keeps it.
On a database whose code set is UTF-8 (1208, the default since Db2 9.5) names and column defaults are read as `HEX(...)` and decoded in the provider.
That began as the way round K1, which 1.0.24 fixed, and it stays because a column default and a definition are read in byte chunks that can end inside a character, and because the driver's decoding on a database with another code page was not measured.
The code page is read once from `SYSCAT.COLUMNS`, which a plain user can read.
On a database with another code page an all-ASCII name reads as written, and a non-ASCII one is refused with an error that names the code page, because the provider carries no table to decode it and a guessed name could not be addressed by any statement.

### 6.2 Kinds

| Kind | Role | Columns | Source | Read from |
|---|---|---|---|---|
| Table | relation | Yes | No | `SYSCAT.TABLES` type `T` |
| View | relation | Yes | Yes | type `V`, text from `SYSCAT.VIEWS` |
| Materialized Query Table | relation | Yes | Yes | type `S`, text from `SYSCAT.VIEWS` |
| Alias | config | No | No | type `A` |
| Sequence | config | No | No | `SYSCAT.SEQUENCES`, `SEQTYPE 'S'` |
| Module | group of procedures and functions | No | No | `SYSCAT.MODULES`, `MODULETYPE 'M'` or `'P'` |
| Procedure | routine | No | Yes | `SYSCAT.ROUTINES`, type `P` |
| Function | routine | No | Yes | `SYSCAT.ROUTINES`, type `F` |
| Trigger | attached to a table | No | Yes | `SYSCAT.TRIGGERS` |

Only a table declares `acceptsRowWrites`, and no kind declares `acceptsSourceEdits`.
Routines inside a module are not listed at the schema level, and only routines of origin `E`, `F`, `Q` and `U` are listed, which leaves out the system-generated ones.

### 6.3 Counts and listings

`countObjects()` is one statement that binds the schema five times and reads catalog rows only.
Every declared kind starts at zero, and a refused read answers every kind as unavailable with the driver's message, never as zero.

A row's path is `[schema, parent?, name]`.
A routine is addressed by its `SPECIFICNAME`, because Db2 overloads routine names, and shows its `ROUTINENAME`.
A trigger hangs under its table when both live in one schema, and under its own schema when the table lives in another, so a cross-schema trigger is still listed once.
A table or materialized query table shows its `CARD` as the row count when `CARD` is not negative, which is the count as of the last RUNSTATS.

Status mapping:

| Catalog value | Status shown |
|---|---|
| `VALID 'N'` | INVALID |
| `VALID 'X'` or `STATUS 'X'` | INOPERATIVE |
| `STATUS 'C'` | SET INTEGRITY PENDING |
| anything else | nothing |

### 6.4 Detail

Tables, views and materialized query tables are described; every other kind answers an empty detail without a round trip.
Columns come from `SYSCAT.COLUMNS` in `COLNO` order, the primary key from `KEYSEQ`, foreign keys from `SYSCAT.REFERENCES` joined to `SYSCAT.KEYCOLUSE` on both sides, the referenced table included in the join, and indexes from `SYSCAT.INDEXES` filtered by the table's schema, because a system-named key index lives in `SYSIBM`.
A foreign key's referenced table is bare inside the object's schema and `SCHEMA.TABLE` across schemas.
A column default is a CLOB in the catalog, so its first 254 bytes are read as `HEX(VARCHAR(SUBSTRING("DEFAULT", 1, 254, OCTETS), 254))` beside `LENGTH("DEFAULT")`, because on 1.0.24 a LOB read beside the row's other columns could come back wrong (K4, fixed in 1.0.25), and the hex read is what decodes it (section 6.1).
254 bytes is the most IBM allows a default constant; a longer default is left out of the detail rather than shown cut, because a column's detail cannot say that a default is partial and a cut expression handed to a migration is worse than none.

A column's type is spelled as its declaration: `VARCHAR(n)`, `CHARACTER(n) FOR BIT DATA` for a binary character column, `DECIMAL(p,s)`, `TIMESTAMP` at the default precision 6 and `TIMESTAMP(p)` otherwise, `DECFLOAT(34)` or `DECFLOAT(16)`, and a character or graphic type declared in a unit other than its default keeps that unit, because its `LENGTH` is in bytes: `VARCHAR(10 CODEUNITS32)` has `LENGTH` 40 and `STRINGUNITSLENGTH` 10 (measured), and prints as declared.

`describeObjects()` describes a whole folder in four round trips: the target list, then the columns, the foreign keys and the indexes of every target at once.
A caller-bound limit cuts the target list and says so.

### 6.5 Source

Views, materialized query tables, procedures, functions and triggers show their stored definition text, labelled "Definition".
The text is a CLOB, so it is read as up to two `HEX(VARCHAR(SUBSTRING(TEXT, start, 16336, OCTETS), 16336))` chunks together with `LENGTH(TEXT)`, which began as the way round K4 (fixed in 1.0.25), and the blanks `SUBSTRING` pads a short chunk with are cut off by that length.
The second chunk is a statement of its own, run only for a definition longer than one chunk, so a short one carries no chunk of padding; on 1.0.22 a row carrying both chunks also lost the driver's framing (K21).
On 1.0.22 the obvious `CAST(TEXT AS VARCHAR(32672))` was worse than failing: on a longer text its truncation warning desynchronised the driver, which answered 36 rows of garbage for one view and "Protocol error: invalid DSS magic byte" for another (K20).
A definition longer than 32672 bytes is shown cut, marked partial, and carries the reason "Db2 stores this definition as a CLOB longer than 32672 bytes, and this provider reads at most the first 32672, so only those are shown.", because a cut text does not run.
1.0.24 fetches a CLOB read on its own whole, measured with a 40067-byte view definition, and 1.0.25 one beside other columns too, so the bound could go (D165).
Because the chunks are read as hex and decoded in the provider, a non-ASCII character in a definition survives on a Unicode database; a cut that falls inside a character drops that character rather than showing a replacement glyph.

A routine with no text is refused with a reason chosen by its `ORIGIN`:

| ORIGIN | Reason shown |
|---|---|
| `E` | EXTERNAL routine: its body is compiled code outside the database. |
| `U` | SOURCED routine: it is defined as another function, with no body of its own. |
| `F` | FEDERATED procedure: its body lives on the remote data source. |
| other | SYSCAT answered no definition text for this routine (ORIGIN code). |

An empty definition answers "SYSCAT answered an empty definition.", and an object that is not found raises a query error naming it.

### 6.6 Object edit (#789)

Object edit is absent in this version: no kind declares `acceptsSourceEdits`.
It was measured on the #787 branch and deferred: a failing `CREATE OR REPLACE PROCEDURE` or `TRIGGER` answers SQL0206N and leaves the old object valid with its old text, which is the safe outcome, but replacing a view leaves every dependent view `VALID 'N'` until its next use, so an edit would break objects the editor never showed.
`tests/isolated/object-edit-declarations.test.ts` is what holds that absence and this section together.

## 7. Query execution

### 7.1 Results

`query()` checks the parameters, sends the statement as written, and reads the result.
A string, number, `bigint`, boolean, `Date`, `null` or byte buffer goes to the driver as it is: 1.0.24 binds a `bigint` exactly and a `Date` as its UTC timestamp, where 1.0.22 aborted the process on the first (K10) and bound the second as `{}`.
An array or any other object is refused before the driver sees it, because the driver reads an array of small integers as BINARY bytes.
A statement may start with a comment, which 1.0.22 refused (K18).
`fields` and `columnTypes` come from the driver's column metadata, so a zero-row result still has its header.
A SELECT reports the number of rows returned; any other statement reports the driver's affected-row count, which is 0 for an UPDATE or DELETE that matched no row (on 1.0.22 it was -2147221503, K19).
Each statement commits on its own.
The statement is read with `rowMode: "array"`, so two columns of one name keep both values: the repeat is named `A (2)`, then `A (3)`, never a name the statement itself declares, before or after the repeat (K15, fixed in 1.0.25).
So `SELECT 1 AS A, 2 AS A, 3 AS "A (2)"` comes back as `A`, `A (3)`, `A (2)`, and the user's own `A (2)` keeps its value.
Db2 names an unaliased expression itself (`1`, `2`, see below), so an empty name is not something it declares.
A row whose value count differs from the column count is refused with a query error rather than read by position, which would leave a value `undefined` or drop one.
The driver's diagnostics are passed through as result warnings, after the LOB warning of K24.
A failure the driver raises itself carries a `driverCode` and no SQLSTATE: `DB2_PARAMETER_COUNT` and `DB2_PARAMETER_TYPE`, a wrong number of parameters or a value that does not fit its target, are a query error, and `DB2_PROTOCOL` and `DB2_INVALID_OPTION` are the driver's own and stay a plain database error whatever their words say, each with the driver's message (K17, fixed in 1.0.25).
Every other error goes through the shared `mapDatabaseError()`, which reads the SQLSTATE and SQLCODE when the driver's message carries them.
A privilege the user lacks, SQLSTATE `42501` (SQL0551N) or `42502` (SQL0552N), or SQLCODE `-1060` for a user without the `CONNECT` privilege, answers `403 PERMISSION_DENIED`; SQLCODE `-30082`, security processing failed, is a refused credential and answers `401 AUTH_ERROR`.

### 7.2 Paging

A SELECT without its own limit is paged on the server: the first page gets `FETCH FIRST n ROWS ONLY`, a later one `OFFSET m ROWS FETCH NEXT n ROWS ONLY`, placed between the statement and its trailing `;` or comment.
A statement that already carries `FETCH FIRST` or `LIMIT` is left as written, and so is any statement that is not a SELECT.
A `limit` or an `offset` that is not a non-negative safe integer is refused with a `QueryError` before any of this, by the check the shared limiter runs first (`assertRowBounds` in [`query-limiter.ts`](../../src/lib/db/utils/query-limiter.ts)).

### 7.3 Values

| Db2 type | Arrives as | Correct |
|---|---|---|
| SMALLINT, INTEGER | number | Yes |
| BIGINT | number inside the safe integer range, an exact decimal string beyond it | Yes |
| REAL, DOUBLE | number | Yes |
| DECIMAL(p,s) | string | Yes, lossless |
| DECFLOAT | string | Yes |
| CHAR(n) | string, blank-padded | Yes |
| VARCHAR | string | Yes |
| GRAPHIC, VARGRAPHIC | string | Yes |
| BINARY, VARBINARY | bytes | Yes |
| DATE | `2024-02-29` | Yes |
| TIME | `23.59.59` | Yes, in Db2's dot format |
| TIMESTAMP(p), any p | `2024-02-29-23.59.59.123456`, with p fraction digits | Yes |
| CLOB, DBCLOB | string | Yes; the inline editor does not write it, see K24 |
| BLOB | bytes | Yes; the inline editor does not write it, see K24 |
| XML | string without the `<?xml` declaration | Yes |
| BOOLEAN | boolean | Yes |

A CLOB column can arrive described as `VarChar(32777)` (measured: a `CLOB(1M)` column, a `CLOB(2G)` cast and `SYSCAT.VIEWS.TEXT`), and since no VARCHAR is longer than 32672 the provider declares it as `CLOB`.
Column keys are upper case, and an unnamed expression is keyed `1`, `2` and so on.
A timestamp stays a string and is never turned into a `Date`, so no time zone shifts it.

### 7.4 Timeout and cancel

A statement inside a transaction is bounded by the connection's query timeout (60 seconds unless the connection sets one), and nothing else is: `query()` on the shared client, the catalog reads and maintenance are not, and there is no cancel.
The bound needs no privilege, because it sends nothing to the server: at the deadline the provider stops waiting, answers a timeout error, forgets the transaction's session and closes it (`boundByClose` in [`driver.ts`](../../src/lib/db/providers/sql/db2/driver.ts)).
That ends the wait, not the work.
Measured on 12.1.0.0 through 1.0.25: `close()` called while a statement runs returns only once that statement has ended on the server, 43.9 seconds later on a cross join that ran 45.9 seconds, and the connection closes then.
`tests/live/db2-live-check.ts` runs it with a 2-second timeout: the wait ended at 2000 ms, the row the transaction had updated stayed locked until the statement ended on the server, 19968 ms after it began, and then read back unchanged.
So the timeout error says the statement keeps running, that the transaction is over and is rolled back once the connection closes, and that a new transaction is needed to continue.
The shared client is not bounded the same way, because closing it would wait for the statement just the same and then end every other request on it.

An agent statement is bounded the same way, by its call's own connection (section 10.1).
Cancelling the statement on the server is D392: `db2-node` 1.0.24 does it through `Client.cancel()` and a `queryTimeout`, given a user with monitoring privileges and `EXECUTE` on `SYSPROC.WLM_CANCEL_ACTIVITY`, which this provider does not ask a user to hold.
For a production database, bound statements on the server, with a Db2 workload management threshold such as `ACTIVITYTOTALTIME`, so an expensive query from any client ends there.

### 7.5 Writes

A table takes the grid's inline edits and an import into it; a view, a materialized query table and every other kind take neither.
An inline edit is one `UPDATE "SCHEMA"."TABLE" SET "C" = ?, ... WHERE "KEY" = ?` per row, every value bound as text and a numeric key as a number.
Measured through 1.0.24 on 12.1.0.0 and 11.5.9.0 (`tests/live/db2-live-check.ts`): an edit of a VARCHAR to "Grüße, 世界 𝄞 çğış" and a DECIMAL(7,2) to 12345.67 read back with the same `HEX` bytes, an import of the same text into an existing table did too, and a DECIMAL that does not fit its column is refused with "Protocol error: DECIMAL parameter out of range for DECIMAL(7,2)" and leaves the stored value as it was.
Measured through 1.0.25 on 12.1.0.0 and 11.5.9.0: a BOOLEAN edited from the grid, which binds the text `true` or `false`, is stored as that boolean (K16, fixed; 1.0.24 refused the text with "expected boolean-compatible parameter").
A value bound to a CLOB, DBCLOB or BLOB column declared 32768 bytes or longer is not written and no error is reported (K24), so the inline editor offers no edit of any such column and says why on the cell, the preview leaves those columns out, and a result holding one carries a warning.
An import writes its values as literals, so K24 does not reach it.

### 7.6 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/sql/db2/sql-grammar.ts`](../../src/lib/db/providers/sql/db2/sql-grammar.ts), the `db2` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
Its grammar is `DB2_GRAMMAR`, the one reading the statement splitter, the row limiter, the confirmation gate and query-event redaction share, so they cannot disagree about where a literal or a comment ends.
Every fact was probed on 2026-10-03 on DB2/LINUXX8664 12.1.0.0 through db2-node 1.0.22, the driver the provider sends statements with (#786).
`#` is code: `SELECT 1 AS a FROM SYSIBM.SYSDUMMY1 # note` and `SELECT 1 # 2 AS a FROM SYSIBM.SYSDUMMY1` are both SQLCODE -104 at the `#`.
`[` is not established: `SELECT 1 AS [a] FROM SYSIBM.SYSDUMMY1` is SQLCODE -104, so it is no name quote, but SQL PL writes an array element as `a[1]` and no subscript reading was measured in plain SQL, so the fail-safe default stays.
Block comments nest: `SELECT 1 AS a /* a /* b */ FROM SYSIBM.SYSDUMMY1 */ FROM SYSIBM.SYSDUMMY1` answers the row, and the same text without the outer closer is SQLCODE -104.
`q'[x]'` and `// note` are each SQLCODE -104, so there is no alternate quoting and no `//` comment.
`readsSqlText` is `true`: the editor text is SQL, and the provider extends `SQLBaseProvider`.
Redaction is `sql` with no name quote: a redacted statement keeps its words, and every literal and quoted run becomes `?`.

### 7.7 Transactions and SANDBOX

BEGIN opens a second client, the transaction's session, connected exactly as the shared one is, through the same tunnel and TLS settings, with its own CA file, and calls `db2-node`'s `beginTransaction()`, which turns autocommit off on it.
Every statement of the transaction runs there, and nothing else the provider sends does, so the object browser and other tabs keep autocommitting on the shared client.
COMMIT and ROLLBACK end the unit of work and close the session, whichever way they went; a refused BEGIN closes it too.
One transaction is open per provider, and a second BEGIN, or one sent while the first is still opening, is refused with "Transaction already active".
Disconnecting closes an open session without waiting, and Db2 rolls back what it did.
A BEGIN still opening its session when the provider disconnects is refused, and that session is closed, even if the provider has reconnected by the time it opens.
COMMIT and ROLLBACK forget the session before they are sent, so a statement sent while one is pending is refused rather than run on the closing session.
No timer rolls back an abandoned transaction: it holds its session and its locks until COMMIT, ROLLBACK or the provider's disconnect.

Measured on 12.1.0.0 through 1.0.25, each inside a transaction with a row inserted first and ROLLBACK last:

- a ROLLBACK removed the row, a COMMIT kept it, and closing the connection without either removed it;
- `CREATE TABLE` was rolled back, so Db2 DDL is transactional and is not refused by SANDBOX;
- `BEGIN COMMIT; END` and a `CALL` of a procedure that runs `COMMIT` each kept the row, so SANDBOX refuses every `BEGIN` and `CALL` (`implicitCommitStatements`), as the provider reads no transaction state back to tell those that commit from those that do not;
- `CALL SYSPROC.ADMIN_CMD('RUNSTATS ...')` committed nothing, and is refused all the same, by the `CALL` rule;
- `TRUNCATE TABLE ... IMMEDIATE` is refused by the server inside a transaction, first statement or not (SQLSTATE 25001, SQLCODE -428).

The server does not report whether a transaction is open, so a `COMMIT` sent as a statement inside the transaction commits and the session runs on in a new unit of work; SANDBOX refuses it before it is sent.

## 8. Maintenance

Run Statistics and Reorganize Table run on one table or materialized query table at a time, from its menu in the object tree; a view, an alias or any other kind is refused by name before anything is sent (RUNSTATS on a view answers SQLSTATE 428DY, measured), and there is no database-wide card, because Db2 LUW has no whole-database RUNSTATS or REORG.
The provider sends each as a plain call of `SYSPROC.ADMIN_CMD`:

```sql
CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE "APP"."ORDERS" WITH DISTRIBUTION AND DETAILED INDEXES ALL')
CALL SYSPROC.ADMIN_CMD('REORG TABLE "APP"."ORDERS"')
```

On 1.0.22 every bare `CALL` failed with SQLSTATE 07005, SQLCODE -517 (K9), and the provider wrapped the call in a `BEGIN ... END` block; 1.0.24 runs a `CALL` through EXCSQLSTT, so the same statements also run from the editor.
The target is the schema and table, each a delimited identifier with `"` doubled, and then every `'` doubled because the whole command is a string literal: the table `O'Brien` becomes `"APP"."O''Brien"`.
A request without a schema is refused; the provider never falls back to `CURRENT SCHEMA`.

## 9. Monitoring

Only three things are read: the version, from `SYSIBMADM.ENV_INST_INFO`, the counts of tables and indexes in `SYSCAT`, and the list of user tables and materialized query tables in `SYSCAT.TABLES`.
The table list is what Run Statistics and Reorganize Table are run from: the object tree's menu items open the admin Operations list, or the monitoring Tables panel, at the table's row.
Each row carries the catalog's `CARD` as its row count, which is -1 until RUNSTATS has run and reads as 0 then, and no size, which reads N/A.
Every other panel is empty on purpose in this version, and says so:

- Sessions: "Db2 sessions are not read in this version of the Db2 provider."
- Slow queries: "Db2 query statistics are not read in this version of the Db2 provider."

Database size and uptime read N/A, the cache ratio reads unavailable, and the index and storage statistics are empty.
Only the table list can fail: a refused read is reported on that panel with the server's message, and the other panels still answer.

## 10. Agent and MCP

Plan mode drafts SQL for Db2 and `inspect_schema` reads its schema through the provider's object surface on any connection, whatever its user.
Agent mode executes statements on Db2 through `queryReadOnly` in [`index.ts`](../../src/lib/db/providers/sql/db2/index.ts), under the profile section 10.1 describes.
MCP's statement read stays closed on Db2 (`MCP_STATEMENT_READ.db2` is false) until a change of its own opens it, so the MCP tool `run_read_query` refuses a Db2 connection.
`READ_ONLY_ENFORCED` is false for Db2, so a seed that asks for a read-only Db2 connection is refused: the read-only boundary below holds only for the agent's own statements.

`endOpenQueryTransaction()` is not implemented, because `query()` leaves no transaction open: it autocommits every statement on the shared client, and an interactive transaction runs on a session of its own (section 7.7).

### 10.1 Agent read-only execution profile

The boundary is credential-enforced.
Db2 has no read-only user or session, so the agent signs in as a user that holds `CONNECT` and `SELECT` and nothing that writes, which the server refuses every write.
What those two privileges do not stop is what the user reaches through others, so before every statement the user is checked, as itself, to reach none of it ([`agent-read.ts`](../../src/lib/db/providers/sql/db2/agent-read.ts)).
Studio's agent admission in front of the provider is defence in depth on top of those two.

The factory passes the execution context as the constructor's third argument; the driver seams a test replaces moved to the fourth.
`queryReadOnly` answers only when that context sets both `readOnly` and `sendsStatements`, the agent and hand-over profiles; it refuses on any other handle, an ordinary editor handle and the operations profile's included, before it opens anything.
The operations profile and plan mode send no statement of the model's, so they open unchecked, and plan mode keeps grounding on a privileged connection.

#### What CONNECT and SELECT refuse, and what they do not

Measured on Db2 Community Edition 12.1.0.0 (`icr.io/db2_community/db2`, digest pinned in `run.sh`), with the scripts and their answers in [`tests/fixtures/db2/12.1.0.0/agent-boundary/`](../../tests/fixtures/db2/12.1.0.0/agent-boundary/):

- A user holding `CONNECT` and `SELECT` on two tables is refused an `INSERT`, a data change in `FINAL TABLE`, a `BEGIN ATOMIC` block that inserts, and `NEXT VALUE FOR` on a sequence it holds no `USAGE` on, each with `SQL0551N`, and `CREATE TABLE` with `SQL0552N`; a declared temporary table fails with `SQL0286N`, for want of a user temporary tablespace (captures 02 and 08).
- It is not refused `LOCK TABLE ... IN EXCLUSIVE MODE` on a table it may read, `SET CURRENT SCHEMA` or `SET CURRENT PATH`, which last for its session (capture 02).
- A fresh database grants `PUBLIC` `EXECUTE` on 456 `SYSPROC` routines, `SYSPROC.ADMIN_CMD` among them, which exported a table to a server file as that user; `CREATEIN` on `SYSTOOLS`, where the user created a function; `CREATEIN` and `DROPIN` on `SYSPUBLIC`, the public alias schema; `UPDATE` on fourteen `SYSSTAT` statistics views; `EXECUTE` on eleven `SYSIBMADM` modules, `DBMS_JOB` among them; `BIND` and `EXECUTE` on IBM's packages in `NULLID`; and `SELECT` on the catalog (captures 00, 02 and 03). It grants `PUBLIC` no `CONNECT`.
- Of what `PUBLIC` keeps after the seed's revokes, 81 `SYSPROC` functions, monitor and catalog readers such as the `SNAP_GET_*` and `HEALTH_*` table functions, read `EXTERNAL_ACTION` E in their own catalog row, and seven `SYSIBMADM` modules hold a function that reads E or `SQL_DATA_ACCESS` M: `DBMS_DDL`, `DBMS_LOB`, `DBMS_LOCK`, `DBMS_RANDOM`, `DBMS_SQL`, `DBMS_STATS` and `DBMS_UTILITY` (capture 10).
  Both columns are blank for a built-in (`ORIGIN` B) and for a function Db2 generates for a type (`ORIGIN` S), and the catalog views declare them nullable.
- The instance owner can neither add a type or a routine to an IBM module (`SQL0551N`) nor create a module in `SYSIBMADM` (`SQL0553N`); the functions Db2 generated inside IBM's modules for their types read `ORIGIN` S and are owned by the instance owner that created the database (capture 11).
- A granted SQL table function that `MODIFIES SQL DATA` wrote a row, with its owner's authority, into a table the user may not insert into; a granted view that calls a function read, with its owner's authority, a table the user may not read; and a column mask whose secured function reads such a table returns that table's data to the user's plain `SELECT` (captures 02 and 03, and the live check).
- `NEXT VALUE FOR` advanced a sequence the user was granted `USAGE` on, and the advance outlives a rollback (captures 02 and 03).
- An administrator cannot create in `SYSPROC`, `SYSCAT`, `SYSIBM` or `SYSIBMADM` (`SQL0553N`), and what it creates in `SYSTOOLS` is owned by it, `OWNERTYPE` U, while every object the database made for itself reads `OWNERTYPE` S; the five row and column access controls of a fresh database are IBM's own masks on its catalog tables (capture 00).
- The packages db2-node sends dynamic SQL through, `NULLID.SYSSH200` and `SYSLH200`, are IBM's, `DYNAMICRULES` R; a `REBIND` of one, and a `BIND` of the CLI packages with `DYNAMICRULES BIND`, by the instance owner leave them bound by `SYSIBM` with `DYNAMICRULES` R (measured).

#### The check before each statement

Every `queryReadOnly` call runs the check on its own connection, as the agent user, inside the unit of work the statement then runs in, and keeps no verdict: a grant or a control added after one call refuses the next call on the same handle, and a refusal lifted between two calls admits the second (measured).
Each catalog view is named `SYSCAT.<view>` and each function `SYSPROC.<name>`: an unqualified name resolves through the session's schema and path, and an object in the user's schema or a public alias, which `PUBLIC` may create on a fresh database, could stand in for it.
An object is IBM's only when its own catalog row says the system owns it, `OWNERTYPE` S, and for a package `BOUNDBYTYPE` S as well, never by its schema.
The session's grantees are the user, `PUBLIC`, the user's operating-system groups (`AUTH_LIST_GROUPS_FOR_AUTHID`) and every role it holds, directly or through a group, `PUBLIC` or another role (`AUTH_LIST_ROLES_FOR_AUTHID`).
That list leaves out the one role a session can hold without a grant to the user: a trusted context's default role.
Db2 makes a connection trusted without being asked when its system authorization ID and its address match an enabled trusted context, and the session then holds the context's default role, which `AUTH_LIST_ROLES_FOR_AUTHID` does not list (measured: a function granted only to that role ran for the agent user with its owner's authority, and the user's raw `INSERT` through that role ran).
So the check reads the trusted contexts first.

0. No trusted context, enabled or not, names the user as its system authorization ID (`SYSCAT.CONTEXTS`). A disabled one is refused too, since enabling it changes nothing the user's own grants would show. The refusal names each context and its default role; dropping the context, or giving the agent its own user that no context names, lifts it. A fresh database holds one context, IBM's `SYSATSCONTEXT`, whose system authorization ID is `SYSATS`, and `PUBLIC` may read `SYSCAT.CONTEXTS` (capture 09).
1. The user holds no database or instance authority but `CONNECT`, in any of those ways (`AUTH_LIST_AUTHORITIES_FOR_AUTHID`).
2. Its grantees hold no table, column or index privilege but `SELECT`, no schema privilege (`CREATEIN` and `SELECTIN` included), no tablespace `USE`, no sequence privilege, since `NEXT VALUE FOR` advances a sequence and the rollback does not take that back, no role's `ADMIN OPTION`, no `PASSTHRU` and no `SETSESSIONUSER` (`SYSCAT.TABAUTH`, `COLAUTH`, `INDEXAUTH`, `SCHEMAAUTH`, `TBSPACEAUTH`, `SEQUENCEAUTH`, `ROLEAUTH`, `PASSTHRUAUTH`, `SURROGATEAUTHIDS`).
3. They may execute no routine, module or package that is not IBM's, since that code runs with its owner's authority (`SYSCAT.ROUTINEAUTH`, `MODULEAUTH`, `PACKAGEAUTH`).
   Of IBM's code, the rule is the routine's own catalog row, not a list of names: a function or method is refused when `SYSCAT.ROUTINES` reads `EXTERNAL_ACTION` E or `SQL_DATA_ACCESS` M, or a missing value in either, and a sourced one when its source is neither a built-in nor an IBM routine that passes the same rule.
   An IBM module is refused when any function in it is, and its routines count as IBM's when their own row reads `OWNERTYPE` S or, inside that module only, `ORIGIN` S, the functions Db2 generated for the module's types, which only Db2 can add (capture 11).
   IBM's procedures are admitted, whatever they do: the agent's statement is a fullselect in a derived table, where no `CALL` fits, so only a function or method can be invoked from it.
   The one exception is a short list of IBM functions that read `EXTERNAL_ACTION` E yet were measured as reading only, by exact specific name ([`reading-functions.ts`](../../src/lib/db/providers/sql/db2/reading-functions.ts)): the 81 capture 10 lists, which a unit test holds equal to that capture.
   A function IBM adds in another release is refused until it is measured, so another Db2 release may need the list measured again.
   A grant on every routine of a schema is refused when any routine there is not admitted.
   They may read or write no global variable that is not IBM's, whose default can call code (`SYSCAT.VARIABLEAUTH`).
4. They may read no table object that is not IBM's and is a nickname, which reads another server, or a view that is not valid, which a `SELECT` revalidates and runs as it reads now, or a view whose dependencies (`SYSCAT.TABDEP`) hold anything but a table, a function that is IBM's and admitted by item 3, a variable that is IBM's, a view that is IBM's or one this check also examines, or an alias of a table object this check examines.
   A view that calls a routine of an IBM module depends on the module itself, so it is refused whatever the routine reads, `DBMS_UTILITY.GET_HASH_VALUE` included.
5. `SYSCAT.CONTROLS` lists no row permission or column mask anywhere in the database that is not IBM's, enabled or not: Db2 evaluates it for any reader of the table it guards, through a view included, and it can call a secured function with its owner's authority. A database that holds one is refused whatever the user is granted, since which tables the user reaches through views is not proven.

Each finding is collected, and one `PROFILE_PRIVILEGES_TOO_BROAD` refusal names them all, as the statements that lift them or, for a trusted context or a control, as the object itself.
A check read that fails is reported as a connection failure rather than as a failure of the model's statement, so the agent does not offer it to the model to repair.
On the measured database the check's seven reads take about 200 ms, and a whole call, its own connection included, about 280 ms.

#### Each statement

[`index.ts`](../../src/lib/db/providers/sql/db2/index.ts) runs each call on a connection opened for it alone, with the profile's user and the connection's TLS settings, never the shared client:

- the connection begins a unit of work, runs the check above in it, then describes the statement in a derived table under `WHERE 1 = 0`, so its column types are read before any row is fetched, and a `CLOB`, `DBCLOB`, `BLOB` or `XML` column is refused unread, since db2-node fetches each value whole and a row can carry up to 2 GB of one;
- the statement is then sent inside `SELECT * FROM (` ... `) AS LIBREDB_AGENT_READ ORDER BY ORDER OF LIBREDB_AGENT_READ FETCH FIRST n ROWS ONLY`, where n is one past the row budget, its own text on lines of its own with its terminator and trailing comments left out, so a result past the budget is refused rather than cut, and its own order is kept;
- before any connection opens, the statement is refused unless that derived table provably holds it whole: its end must be readable under Db2's grammar, no literal, quoted name or comment left open to swallow what follows, and every parenthesis outside a literal, a quoted name or a comment must close one the statement opened, all of them closing; a statement that closed the derived table early could put a lateral read, a table expression or a union beside it, and measured raw, the lateral and table forms still ended under the outer `FETCH FIRST` and the union form was refused (`SQL0204N`, since the outer `ORDER OF` cannot name the derived table there), but the bound is not left to that;
- only a fullselect fits there, `WITH` and `VALUES` included: a `CALL`, a `SET`, `COMMIT`, `LOCK TABLE`, a declared temporary table and a compound block are refused by the server's parser with `SQL0104N`, a data change with `SQL20165N`, and `NEXT VALUE FOR` with `SQL0348N` (capture 04, and the live check); the privileges the check proves are the boundary behind that, measured raw (capture 08);
- every value is counted against the byte budget;
- the unit of work is rolled back and the connection closed on every path, an answered call included, so nothing one call set on its session, a special register included, reaches the next.

The deadline is the statement budget, over the whole call: past it the call answers the shared time refusal and the connection is closed without waiting (`boundByClose` in [`driver.ts`](../../src/lib/db/providers/sql/db2/driver.ts)), which ends the wait, not the work, as section 7.4 records for a transaction; Db2 rolls the unit of work back when the connection closes.
No server-side cancel is sent, so the agent user needs no `WLM_CANCEL_ACTIVITY` grant or monitoring privilege (D392).
Every refusal is a sentence of [`read-only-budget.ts`](../../src/lib/db/providers/sql/read-only-budget.ts) or the server's own error.
The estimate-plan session mode is refused: Db2's `EXPLAIN` writes its rows into the explain tables, a write the agent user is refused, so the agent composes no estimating plan here (B148).

#### The agent user

The agent credential takes a user and a password, both required, the form every engine without an `agentCredential` declaration takes.
An agent credential beside a connection string is refused (`AGENT_CREDENTIAL_WITH_CONNECTION_STRING`); with no agent credential the agent signs in as the connection's own user, which the check must admit.
A Db2 LUW user is an operating-system user of the server; give it `CONNECT` and `SELECT` on the tables it may read, and nothing else:

```sql
GRANT CONNECT ON DATABASE TO USER LIBREDB_AGENT;
GRANT SELECT ON APP.ORDERS TO USER LIBREDB_AGENT;
GRANT SELECT ON APP.CUSTOMERS TO USER LIBREDB_AGENT;
```

A fresh database refuses that user, because of what it grants `PUBLIC`.
Run the revokes the refusal names; on the measured 12.1.0.0 they are those in [`docker/db2-init/02-agent-principal.sql`](../../docker/db2-init/02-agent-principal.sql), which seeds the compose service's `AGENT_RO` the same way:

```sql
REVOKE UPDATE ON SYSSTAT.COLDIST FROM PUBLIC;  -- and the thirteen other SYSSTAT views
REVOKE CREATEIN, DROPIN ON SCHEMA SYSPUBLIC FROM PUBLIC;
REVOKE CREATEIN ON SCHEMA SYSTOOLS FROM PUBLIC;
REVOKE EXECUTE ON SPECIFIC PROCEDURE SYSPROC.ADMIN_CMD FROM PUBLIC RESTRICT;
REVOKE EXECUTE ON SPECIFIC PROCEDURE SYSPROC.ADMIN_TASK_ADD FROM PUBLIC RESTRICT;
REVOKE EXECUTE ON SPECIFIC PROCEDURE SYSPROC.ADMIN_TASK_UPDATE FROM PUBLIC RESTRICT;
REVOKE EXECUTE ON SPECIFIC PROCEDURE SYSPROC.DB2LOAD FROM PUBLIC RESTRICT;
REVOKE EXECUTE ON SPECIFIC PROCEDURE SYSPROC.REMOTE_QUERY FROM PUBLIC RESTRICT;
REVOKE EXECUTE ON SPECIFIC PROCEDURE SYSPROC.SNAP_WRITE_FILE FROM PUBLIC RESTRICT;
REVOKE EXECUTE ON SPECIFIC PROCEDURE SYSPROC.SYSTS_ADMIN_CMD FROM PUBLIC RESTRICT;
REVOKE EXECUTE ON MODULE SYSIBMADM.DBMS_JOB FROM PUBLIC;
REVOKE EXECUTE ON MODULE SYSIBMADM.DBMS_DDL FROM PUBLIC;
REVOKE EXECUTE ON MODULE SYSIBMADM.DBMS_LOB FROM PUBLIC;
REVOKE EXECUTE ON MODULE SYSIBMADM.DBMS_LOCK FROM PUBLIC;
REVOKE EXECUTE ON MODULE SYSIBMADM.DBMS_RANDOM FROM PUBLIC;
REVOKE EXECUTE ON MODULE SYSIBMADM.DBMS_SQL FROM PUBLIC;
REVOKE EXECUTE ON MODULE SYSIBMADM.DBMS_STATS FROM PUBLIC;
REVOKE EXECUTE ON MODULE SYSIBMADM.DBMS_UTILITY FROM PUBLIC;
```

The check needs the `SYSSTAT`, `SYSPUBLIC`, `SYSTOOLS` revokes and the last seven module revokes.
The `SYSPROC` procedure revokes and the `DBMS_JOB` revoke are hygiene the check does not need, since no agent statement can call a procedure; the seed keeps them because they close what the credential itself could do outside Studio.
The module revokes take `DBMS_LOB`, `DBMS_UTILITY` and the others from every user: grant `EXECUTE` on a module back to each user or role whose code calls it, as `GRANT EXECUTE ON MODULE SYSIBMADM.DBMS_LOB TO USER APP_USER`, before revoking it from `PUBLIC`.

Revoking from `PUBLIC` reaches every user of the database: grant a privilege back to each user or role that needs it before revoking.
A schema Db2 creates implicitly, for a `CREATE` in a schema that does not exist, gives `PUBLIC` `CREATEIN` on it (measured), which the check refuses with the revoke that lifts it.
Grant `SELECT` on tables, or on views whose definitions read only tables, views the user may also read, and IBM's functions: a view that calls a function of yours refuses the user.
A table with a row permission or a column mask anywhere in the database refuses every agent user; dropping the control, at the cost of what it protects, is the one remedy.

What the agent reads beyond the tables needs no grant: the catalog reads below and plan-mode grounding read the `SYSCAT` views, which `PUBLIC` may read on a fresh database.

#### What only the operator stops

- IBM's functions that pass item 3, IBM's packages and IBM's views are trusted as the vendor's boundary: a function whose catalog row reads neither an external action nor a data change, or one of the 81 measured as reading only, is taken at its catalog's word.
- A built-in function (`ORIGIN` B) needs no grant and has no catalog facts to read, so it is part of the SQL language the server parses, not something the check can refuse.
- Inside the derived table only a function can be invoked, so no procedure, IBM's or not, is reachable from an agent statement, whatever the grants.
- `LOCK TABLE` and `SET` are not residuals: the user may run them raw, and neither fits inside the derived table.

#### Boundary record

Measured on 12.1.0.0 (the digest `run.sh` pins, 2026-10-29) by [`tests/live/db2-agent-boundary.ts`](../../tests/live/db2-agent-boundary.ts), with Studio's agent admission bypassed: 102 checks, all passing.

| Probe | Admitted agent user, through `queryReadOnly` | The same user, raw | Instance owner, positive control |
| --- | --- | --- | --- |
| `INSERT` | `SQL0104N` | `SQL0551N` | ran |
| a data change in `FINAL TABLE` | `SQL20165N` | `SQL0551N` | ran |
| the same in the outer `FROM`, the derived table closed early | refused before it is sent | not sent | `SQL20165N` raw |
| `NEXT VALUE FOR` | `SQL0348N` | `SQL0551N` | ran |
| `BEGIN ATOMIC` with an `INSERT` | `SQL0104N` | `SQL0551N` | ran |
| `CALL SYSPROC.ADMIN_CMD('EXPORT ...')` | `SQL0104N` | `SQL0551N` after the revoke | not sent |
| `SET CURRENT SCHEMA`, a declared temporary table, `LOCK TABLE`, `COMMIT`, a second statement | `SQL0104N` | not sent | `LOCK TABLE` ran |
| `CREATE TABLE`, a function in `SYSTOOLS`, `UPDATE SYSSTAT.TABLES` | not sent | `SQL0552N`, `SQL0551N`, `SQL0551N` | not sent |

The rows and `APP.ORDER_SEQ` read back the same before and after.
The check refused, and admitted again once the grant or the object was gone: `EXECUTE` on an SQL table function that writes, granted to the user, to `PUBLIC`, to a role and through a grant on every function of its schema, measured to write a row for the user; `EXECUTE` on a module and on a package of the owner's; `READ` on a variable of the owner's; `USAGE` on a sequence; `INSERT` on a table; `CREATEIN` on a schema; `CREATETAB` and `IMPLICIT_SCHEMA` to `PUBLIC`; `DBADM`; `SETSESSIONUSER`; a role's `ADMIN OPTION`; `SELECT` on a view that calls a function of the owner's, on a view over a view the user may not read, lifted by granting the inner view, on a view over an alias of a table the user may not read, and on a view left inoperative by a dropped table; `EXECUTE` on IBM's `UTL_FILE` and `DBMS_PIPE` modules and on its `AUDIT_ARCHIVE` table function, each acting outside the call by its own catalog row and not on the measured list; `SELECT` on a view that calls IBM's `DBMS_RANDOM.VALUE`, refused by its module, and on a view over IBM's `AUDIT_ARCHIVE` table function, refused by the function's own row; a column mask on a table the user may not read; and a trusted context naming the agent user as its system authorization ID on the address the server saw the script at, enabled and then disabled, after a raw connection of the agent user was shown to hold its default role's `INSERT` with that role absent from `AUTH_LIST_ROLES_FOR_AUTHID`.
It admitted a view over a table, a view over a view the user may read, and a view calling `UPPER` and `LENGTH`.
It admitted `SYSPROC.DB_MEMBERS`, read through `queryReadOnly`, and a view calling `SYSPROC.GET_INDEX_COLNAMES`, both on the measured list.
On one handle a call ran, an `INSERT` granted after it refused the next call, and the call after its revoke ran; each call read the agent user's own `CURRENT SCHEMA`.
The operations profile opened the instance owner unchecked and listed its tables; it and an editor handle refused `queryReadOnly` before sending anything.
The four catalog kinds answered as the agent user, and the column kind read a table in a schema made implicitly, which `SYSIBM` owns; that schema gave `PUBLIC` `CREATEIN`, which the check refused until it was revoked.
A lateral read, a union and a table expression put beside the derived table by closing it early were each refused before they were sent, and a parenthesis inside a literal or a comment was read past.
The budgets: a result of more than 3 rows under a budget of 3 was refused at the 4th, a result past a 20-byte budget was refused, a `CLOB`, a `BLOB` and an `XML` column were refused before any row was read, and a cross join under a 1.5-second deadline was refused at 1.5 seconds, the next call answering.

The script creates objects carrying the `LIBREDB_AB` prefix and drops them on exit; run it on a disposable database holding the fixture and the seeded agent user, such as the compose service:

```sh
LIBREDB_LIVE_DB2_PORT=50000 LIBREDB_LIVE_DB2_PASSWORD=<db2inst1's password> bun tests/live/db2-agent-boundary.ts
```

#### Agent language pack

Statement-language family: `sql`.
Overlay: [`src/lib/agent/languages/sql/engines/db2.ts`](../../src/lib/agent/languages/sql/engines/db2.ts), with its client row in [`src/lib/agent/languages/sql/engines/client.ts`](../../src/lib/agent/languages/sql/engines/client.ts).
The agent reads it through `runServerPack` and `agentEnginePack`, and the dialect through `engineServerDialect`.

| Member | Kind | Value |
| --- | --- | --- |
| `catalogRead` | Dialect-bound | Supplied |
| `planEstimate` | Dialect-bound | `"unsupported"` |
| `profileComposition` | Dialect-bound | `"unsupported"` |
| `statistics` | Dialect-bound | `"unsupported"` |
| `catalogCapture` | Dialect-bound | `"unsupported"` |

This overlay overrides no Shared member, so every Shared member is the `sql` statement-language family's own.
The catalog read takes `SYSCAT.COLUMNS` for the column kind, `SYSCAT.REFERENCES` and `SYSCAT.KEYCOLUSE` for the foreign keys, `SYSCAT.INDEXES` and `SYSCAT.INDEXCOLUSE` for the indexes, and `SYSCAT.TABLES.CARD` for the row estimates, which the last `RUNSTATS` recorded; every kind leaves out the system's own tables (`SYSCAT.TABLES.OWNERTYPE` S), by that fact rather than by a schema name, since a schema created implicitly is itself owned by `SYSIBM` (measured), names are trimmed, and a selector's schema and table are compared as string literals, exactly as the catalog spells them, an undelimited name in upper case.
Each kind was run as the agent user through `queryReadOnly`.
Investigation, database assessment and data analysis open on Db2; assessment cannot pass there, because its verdict needs a table profile and the engine composes none (B146); query optimization stays closed, and `inspect_plan` and `profile_table` answer `UNSUPPORTED_DIALECT`, because the engine composes no estimating plan and no table profile (B148).
A pack does not open agent mode: execution is gated by `AGENT_EXECUTION_ENGINES` and the execution-profile check.

## 11. Schema diff

A column modification is written as a comment, not as DDL: Db2 changes a column with `ALTER COLUMN ... SET DATA TYPE` and may leave the table REORG-pending, so the change is yours to write.
Added and dropped columns use `ADD COLUMN` and `DROP COLUMN`, which Db2 LUW accepts; a dropped column can leave the table REORG-pending, measured, and Reorganize Table clears it.
The migration is not wrapped in `BEGIN;` and `COMMIT;`, because in Db2 `BEGIN` opens a compound block.
Db2 refuses `DROP CONSTRAINT IF EXISTS` and `DROP INDEX IF EXISTS`, so those statements are written without `IF EXISTS`.
The shared diff keys objects by their schema and name, so `APP.T` and `REPORTING.T` are two tables, names each table as `"SCHEMA"."TABLE"`, and names a differing view or materialized query table in a comment instead of writing table DDL for it. A foreign key's cross-schema reference is still quoted as one identifier; read a Db2 migration before you run it (D150 in `docs/BACKLOG.md`).

## 12. Packaging and platforms

`db2-node` ships one native addon per platform, and each channel keeps only the one it runs on: the Debian image keeps the glibc addon and both Alpine images keep the musl one, each asserting that exactly one addon is left and loading it once at build time.
The Linux tarballs keep both the glibc and the musl addon, the macOS and Windows payloads keep their own (`scripts/lib/prune-db2-node.sh`), and the AppImage and Flatpak keep only glibc.
The Windows addon imports `VCRUNTIME140.dll`, so Windows needs the Microsoft Visual C++ 2015-2022 Redistributable (x64); the winget and Chocolatey packages declare it, and with Scoop you install it once with `scoop install extras/vcredist2022` ([DISTRIBUTION.md](../DISTRIBUTION.md)).

The addons statically link 62 Rust crates whose licences the npm package does not carry.
`THIRD_PARTY_NOTICES.txt` holds the `db2-node` MIT text and each crate's notice, is generated by `scripts/generate-db2-node-notices.sh` from the upstream `Cargo.lock`, and ships in every image and payload.

The 1.0.25 addons link `rustls` 0.23.45 and `rustls-webpki` 0.103.15, past the fixes for the advisories 1.0.22 and 1.0.24 were inside: those linked 0.23.37 and 0.103.10, inside RUSTSEC-2026-0285 (`rustls`, patched in 0.23.45) and RUSTSEC-2026-0098, RUSTSEC-2026-0099 and RUSTSEC-2026-0104 (`rustls-webpki`, patched in 0.103.13), reported upstream as [gurungabit/db2-node#24](https://github.com/gurungabit/db2-node/issues/24).
Checked on 2026-10-04 through the OSV API, those two were the only crates that changed from the 1.0.24 `Cargo.lock`, and OSV then named no advisory for any crate of the 1.0.25 one but two unmaintained notices: RUSTSEC-2025-0134 for `rustls-pemfile`, which the addons link, and RUSTSEC-2024-0436 for `paste`, a build-time macro that leaves no code in them.
Checked again through the OSV API on 2026-10-26, those crates carry six advisories published after 2026-10-04, besides the two unmaintained notices, and no `db2-node` release links a fixed version yet: the 1.0.26 and 1.0.27 `Cargo.lock` are byte for byte the 1.0.25 one.
They are RUSTSEC-2026-0346, RUSTSEC-2026-0347, RUSTSEC-2026-0348 and RUSTSEC-2026-0349 for `rustls` (patched in 0.23.46), RUSTSEC-2026-0382 for `rustls-webpki` (patched in 0.103.16), and RUSTSEC-2026-0386, an informational unsoundness notice for `tokio` 1.51.0 (patched in 1.51.6).
Read against the driver's source, only RUSTSEC-2026-0382 is reachable: a verified connection builds its trust store from the operating system's roots plus the given CA, so a certificate path through one of the distrusted emSign intermediates is accepted wherever that store still trusts its root.
The others need what the addons do not use: RUSTSEC-2026-0346 a custom `ClientSessionStore`, RUSTSEC-2026-0347 Encrypted Client Hello, RUSTSEC-2026-0348 the `brotli` feature, which is not in the `Cargo.lock`, RUSTSEC-2026-0349 a hybrid post-quantum group to downgrade from, which the `ring` provider the addons install does not offer (it offers X25519, secp256r1 and secp384r1), and RUSTSEC-2026-0386 `tokio::io::unix::AsyncFd`, which `db2-node` never calls.
P10 in `docs/BACKLOG.md` tracks them.
The crates are compiled into the addon, so only a new `db2-node` release can move one; repeat the check on every bump.
Only linux x64 was measured; arm64, macOS and Windows load the addon in the release probes but were not run against a Db2.

## 13. Testing

- `tests/integration/db/db2-provider.test.ts` drives the provider against a mocked driver that mirrors the fixture, and ends with the shared object-surface conformance check.
- `tests/unit/db/db2/` holds the unit tests of each module, the agent check's statements pinned whole in `agent-read.test.ts`.
- `tests/live/db2-known-issues.ts` prints `PRESENT` or `GONE` for every row of section 4 and for the K rows fixed in 1.0.24 and 1.0.25, so a regression back to a fixed defect shows as `PRESENT`, and `tests/live/db2-live-check.ts` runs the provider against a live Db2, writes, transactions and the transaction deadline included, and `tests/live/db2-agent-boundary.ts` runs the agent read-only profile (section 10.1); none runs in `bun run test`.

The integration test needs no Db2, and runs on its own with:

```bash
bun tests/run-tests.ts tests/integration/db/db2-provider.test.ts
```

The `db2` service of `database-compose.yml` runs `icr.io/db2_community/db2:12.1.0.0` unprivileged, with `cap_add: [IPC_LOCK, IPC_OWNER]`, on port 50000.
Its first boot creates the instance and the database and takes several minutes; wait for the health check before you connect.
The service has no TLS, so a Studio connection to it needs "Send the password without TLS" ticked, or the provider refuses it (section 3.3).
The seed under `docker/db2-init/` also creates the agent's least-privilege user `AGENT_RO` and revokes what a fresh database grants `PUBLIC` that its check refuses (section 10.1).
The fixture under `docker/db2-init/` creates the schemas `APP` and `REPORTING` with tables, a cross-schema foreign key, a view, an invalid view, a materialized query table, an alias, a sequence, a procedure, an overloaded function, an external function, two triggers (one cross-schema), a module, `APP."Mixed Case"`, `APP."O'Brien"` for the maintenance quoting, and `APP.ALLTYPES` and `APP.EMPTY_T` for the value checks.

```bash
docker compose -f database-compose.yml up -d db2
bun tests/live/db2-known-issues.ts
DB2_CA_FILE=<ca.pem> DB2_TLS_HOST=<host> bun tests/live/db2-live-check.ts
```

Both scripts connect as the compose service's `db2inst1` / `Password123` unless `DB2_USER` and `DB2_PASSWORD` say otherwise.
The K23 probe and the live check's password check need `DB2_K23_USER` and `DB2_K23_PASSWORD`, a user whose password holds all of `!`, `^`, `[`, `]` and `|`; without them the probe prints `PRESENT (not probed)` and the check prints `SKIP`.
The 2026-10-04 runs on 1.0.25 made that user in the container with `useradd` and `chpasswd` from a file, so no shell read the password, granted it `CONNECT`, enabled TLS as section 3.3 shows, and loaded the fixture by hand after the image skipped it on a fresh volume (D160).

## Migration DDL

[`DB2_MIGRATION_DDL`](../../src/lib/db/providers/sql/db2/migration-ddl.ts) is what the schema-diff migration generator writes for `db2`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
Db2 (#786) has no standalone `BEGIN;`, and `BEGIN` opens a compound SQL block, so `transactionWrapper` is `null`.
A dropped foreign key or index is written without `IF EXISTS`, measured on Db2 LUW 12.1.0.0: `ALTER TABLE "C" DROP CONSTRAINT IF EXISTS "fk_c"` and `DROP INDEX IF EXISTS "ix_c"` are both SQL0104N at `EXISTS`, while the bare statements run.
`DROP TABLE` keeps `IF EXISTS`, and `ADD COLUMN` and `DROP COLUMN` take the standard spelling, both measured on 12.1.0.0.
A modified column is a comment: Db2 retypes a column with `ALTER COLUMN ... SET DATA TYPE`, and several such changes leave the table REORG-pending until a REORG runs, which a flat migration file cannot schedule.
The fields it takes unchanged from `src/lib/db/migration-ddl/shared.ts` are `standardAddColumn`, `standardAddForeignKey`, `standardColumnDef`, `standardCreateIndex`, `standardCreateTableForeignKey`, `standardDropColumn`, `standardDropTable` and `standardPrimaryKey`.

The refusal reason it prints, verbatim:

- "Db2 changes a column with ALTER COLUMN ... SET DATA TYPE and may leave the table REORG-pending; write the change by hand."

## 14. References

- [IBM Db2 12.1 documentation](https://www.ibm.com/docs/en/db2/12.1.x)
- [db2-node on npm](https://www.npmjs.com/package/db2-node), the upstream defect report [gurungabit/db2-node#12](https://github.com/gurungabit/db2-node/issues/12), its fix [gurungabit/db2-node#13](https://github.com/gurungabit/db2-node/pull/13) and the [1.0.24 release](https://github.com/gurungabit/db2-node/releases/tag/v1.0.24); the reports [gurungabit/db2-node#19](https://github.com/gurungabit/db2-node/issues/19) to [#25](https://github.com/gurungabit/db2-node/issues/25), their fixes [#26](https://github.com/gurungabit/db2-node/pull/26) to [#29](https://github.com/gurungabit/db2-node/pull/29) and the [1.0.25 release](https://github.com/gurungabit/db2-node/releases/tag/v1.0.25)
- [#786](https://github.com/libredb/libredb-studio/issues/786), the tracking issue, and [#787](https://github.com/libredb/libredb-studio/pull/787), the earlier ibm_db attempt whose catalog SQL this provider keeps
