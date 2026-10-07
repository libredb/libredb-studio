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
- K14: `queryTimeout` rejected on the client and left the statement running on the server. It now cancels it on the server, given the privileges section 7.4 names; the provider still sets none.
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
| Transactions and SANDBOX | No | No held session in this version; 1.0.24's `beginTransaction()` makes one possible (D148) |
| Query cancel | No | Not wired yet: 1.0.24's `Client.cancel()` and its `queryTimeout` cancel the statement on the server through `WLM_CANCEL_ACTIVITY`, which needs monitoring and cancel privileges a plain user may not hold (D148) |
| Foreign keys | Yes | Inherited |
| Maintenance | Yes | Run Statistics and Reorganize Table, per table only |
| Connection string | Yes | A `db2://` paste fills the fields |
| Identifier quoting | Double quotes | Declared, because port 50000 would otherwise fall to the PostgreSQL heuristic |
| Statement terminator | Not declared | A generated statement ends with `;`, the default when none is declared; a trailing `;` is accepted |
| Container levels | Schema | |
| Container path shapes | Exact | Like Oracle |
| Preview projection | Yes | `previewProjection` is `DB2_PREVIEW_PROJECTION`: the object browser's preview names each column and leaves CLOB, DBCLOB and BLOB columns out, named in a comment above the statement, because the grid does not edit them (K24); XML is read; a preview whose column list is not loaded yet still reads `SELECT *`, under a comment that says so |

The application's query timeout is not forwarded to Db2: on 1.0.22 the driver's own timeout left the statement running on the server (K14), and on 1.0.24 it cancels it through a second session that needs privileges this version does not ask a user to hold.

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
The driver's diagnostics are passed through as result warnings, after the LOB warning of K24.
A failure the driver raises itself carries a `driverCode` and no SQLSTATE: `DB2_PARAMETER_COUNT` and `DB2_PARAMETER_TYPE`, a wrong number of parameters or a value that does not fit its target, are a query error, and `DB2_PROTOCOL` and `DB2_INVALID_OPTION` are the driver's own and stay a plain database error whatever their words say, each with the driver's message (K17, fixed in 1.0.25).
Every other error goes through the shared `mapDatabaseError()`, which reads the SQLSTATE and SQLCODE when the driver's message carries them.

### 7.2 Paging

A SELECT without its own limit is paged on the server: the first page gets `FETCH FIRST n ROWS ONLY`, a later one `OFFSET m ROWS FETCH NEXT n ROWS ONLY`, placed between the statement and its trailing `;` or comment.
A statement that already carries `FETCH FIRST` or `LIMIT` is left as written, and so is any statement that is not a SELECT.

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

### 7.4 No timeout and no cancel

Nothing bounds a statement on the Studio side: the app's query timeout is not applied to Db2 and there is no cancel.
`db2-node` 1.0.24 makes both possible, through `Client.cancel()` and a `queryTimeout` that cancels on the server, given a user with monitoring privileges and `EXECUTE` on `SYSPROC.WLM_CANCEL_ACTIVITY`; wiring them is D148.
For a production database, bound statements on the server, with a Db2 workload management threshold such as `ACTIVITYTOTALTIME`, so an expensive query from any client ends there.

### 7.5 Writes

A table takes the grid's inline edits and an import into it; a view, a materialized query table and every other kind take neither.
An inline edit is one `UPDATE "SCHEMA"."TABLE" SET "C" = ?, ... WHERE "KEY" = ?` per row, every value bound as text and a numeric key as a number.
Measured through 1.0.24 on 12.1.0.0 and 11.5.9.0 (`tests/live/db2-live-check.ts`): an edit of a VARCHAR to "Grüße, 世界 𝄞 çğış" and a DECIMAL(7,2) to 12345.67 read back with the same `HEX` bytes, an import of the same text into an existing table did too, and a DECIMAL that does not fit its column is refused with "Protocol error: DECIMAL parameter out of range for DECIMAL(7,2)" and leaves the stored value as it was.
Measured through 1.0.25 on 12.1.0.0 and 11.5.9.0: a BOOLEAN edited from the grid, which binds the text `true` or `false`, is stored as that boolean (K16, fixed; 1.0.24 refused the text with "expected boolean-compatible parameter").
A value bound to a CLOB, DBCLOB or BLOB column declared 32768 bytes or longer is not written and no error is reported (K24), so the inline editor offers no edit of any such column and says why on the cell, the preview leaves those columns out, and a result holding one carries a warning.
An import writes its values as literals, so K24 does not reach it.

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

Db2 takes Oracle's posture.
Plan mode drafts SQL for it and `inspect_schema` reads its schema through the provider's object surface.
The provider has no `queryReadOnly`, so an agent run executes nothing on Db2 and the MCP tool `run_read_query` refuses a Db2 connection.
`READ_ONLY_ENFORCED` is false for Db2, so a seed that asks for a read-only Db2 connection is refused.

`endOpenQueryTransaction()` is not implemented, because the engine has no transaction to leave open: `query()` autocommits every statement and holds no session for a later caller.

## 11. Schema diff

A column modification is written as a comment, not as DDL: Db2 changes a column with `ALTER COLUMN ... SET DATA TYPE` and may leave the table REORG-pending, so the change is yours to write.
Added and dropped columns use `ADD COLUMN` and `DROP COLUMN`, which Db2 LUW accepts; a dropped column can leave the table REORG-pending, measured, and Reorganize Table clears it.
The migration is not wrapped in `BEGIN;` and `COMMIT;`, because in Db2 `BEGIN` opens a compound block.
Db2 refuses `DROP CONSTRAINT IF EXISTS` and `DROP INDEX IF EXISTS`, so those statements are written without `IF EXISTS`.
The shared diff keys objects by name only, so a table in one schema collides with a table of the same name in another, writes a view or a materialized query table as `CREATE TABLE`, and quotes a cross-schema reference as one identifier; read a Db2 migration before you run it (D150 in `docs/BACKLOG.md`).

## 12. Packaging and platforms

`db2-node` ships one native addon per platform, and each channel keeps only the one it runs on: the Debian image keeps the glibc addon and both Alpine images keep the musl one, each asserting that exactly one addon is left and loading it once at build time.
The Linux tarballs keep both the glibc and the musl addon, the macOS and Windows payloads keep their own (`scripts/lib/prune-db2-node.sh`), and the AppImage and Flatpak keep only glibc.
The Windows addon imports `VCRUNTIME140.dll`, so Windows needs the Microsoft Visual C++ 2015-2022 Redistributable (x64); the winget and Chocolatey packages declare it, and with Scoop you install it once with `scoop install extras/vcredist2022` ([DISTRIBUTION.md](../DISTRIBUTION.md)).

The addons statically link 62 Rust crates whose licences the npm package does not carry.
`THIRD_PARTY_NOTICES.txt` holds the `db2-node` MIT text and each crate's notice, is generated by `scripts/generate-db2-node-notices.sh` from the upstream `Cargo.lock`, and ships in every image and payload.

The 1.0.25 addons link `rustls` 0.23.45 and `rustls-webpki` 0.103.15, the patched versions: 1.0.22 and 1.0.24 linked 0.23.37 and 0.103.10, inside RUSTSEC-2026-0285 (`rustls`, patched in 0.23.45) and RUSTSEC-2026-0098, RUSTSEC-2026-0099 and RUSTSEC-2026-0104 (`rustls-webpki`, patched in 0.103.13), reported upstream as [gurungabit/db2-node#24](https://github.com/gurungabit/db2-node/issues/24).
Checked on 2026-10-04 through the OSV API, those two are the only crates that changed from the 1.0.24 `Cargo.lock`, and OSV names no advisory for any crate of the 1.0.25 one but two unmaintained notices: RUSTSEC-2025-0134 for `rustls-pemfile`, which the addons link, and RUSTSEC-2024-0436 for `paste`, a build-time macro that leaves no code in them.
The crates are compiled into the addon, so only a new `db2-node` release can move one; repeat the check on every bump.
Only linux x64 was measured; arm64, macOS and Windows load the addon in the release probes but were not run against a Db2.

## 13. Testing

- `tests/integration/db/db2-provider.test.ts` drives the provider against a mocked driver that mirrors the fixture, and ends with the shared object-surface conformance check.
- `tests/unit/db/db2/` holds the unit tests of each module.
- `tests/live/db2-known-issues.ts` prints `PRESENT` or `GONE` for every row of section 4 and for the K rows fixed in 1.0.24 and 1.0.25, so a regression back to a fixed defect shows as `PRESENT`, and `tests/live/db2-live-check.ts` runs the provider against a live Db2, writes included; neither runs in `bun run test`.

The integration test needs no Db2, and runs on its own with:

```bash
bun tests/run-tests.ts tests/integration/db/db2-provider.test.ts
```

The `db2` service of `database-compose.yml` runs `icr.io/db2_community/db2:12.1.0.0` unprivileged, with `cap_add: [IPC_LOCK, IPC_OWNER]`, on port 50000.
Its first boot creates the instance and the database and takes several minutes; wait for the health check before you connect.
The service has no TLS, so a Studio connection to it needs "Send the password without TLS" ticked, or the provider refuses it (section 3.3).
The fixture under `docker/db2-init/` creates the schemas `APP` and `REPORTING` with tables, a cross-schema foreign key, a view, an invalid view, a materialized query table, an alias, a sequence, a procedure, an overloaded function, an external function, two triggers (one cross-schema), a module, `APP."Mixed Case"`, `APP."O'Brien"` for the maintenance quoting, and `APP.ALLTYPES` and `APP.EMPTY_T` for the value checks.

```bash
docker compose -f database-compose.yml up -d db2
bun tests/live/db2-known-issues.ts
DB2_CA_FILE=<ca.pem> DB2_TLS_HOST=<host> bun tests/live/db2-live-check.ts
```

Both scripts connect as the compose service's `db2inst1` / `Password123` unless `DB2_USER` and `DB2_PASSWORD` say otherwise.
The K23 probe and the live check's password check need `DB2_K23_USER` and `DB2_K23_PASSWORD`, a user whose password holds all of `!`, `^`, `[`, `]` and `|`; without them the probe prints `PRESENT (not probed)` and the check prints `SKIP`.
The 2026-10-04 runs on 1.0.25 made that user in the container with `useradd` and `chpasswd` from a file, so no shell read the password, granted it `CONNECT`, enabled TLS as section 3.3 shows, and loaded the fixture by hand after the image skipped it on a fresh volume (D160).

## 14. References

- [IBM Db2 12.1 documentation](https://www.ibm.com/docs/en/db2/12.1.x)
- [db2-node on npm](https://www.npmjs.com/package/db2-node), the upstream defect report [gurungabit/db2-node#12](https://github.com/gurungabit/db2-node/issues/12), its fix [gurungabit/db2-node#13](https://github.com/gurungabit/db2-node/pull/13) and the [1.0.24 release](https://github.com/gurungabit/db2-node/releases/tag/v1.0.24); the reports [gurungabit/db2-node#19](https://github.com/gurungabit/db2-node/issues/19) to [#25](https://github.com/gurungabit/db2-node/issues/25), their fixes [#26](https://github.com/gurungabit/db2-node/pull/26) to [#29](https://github.com/gurungabit/db2-node/pull/29) and the [1.0.25 release](https://github.com/gurungabit/db2-node/releases/tag/v1.0.25)
- [#786](https://github.com/libredb/libredb-studio/issues/786), the tracking issue, and [#787](https://github.com/libredb/libredb-studio/pull/787), the earlier ibm_db attempt whose catalog SQL this provider keeps
