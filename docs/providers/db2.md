# Db2 LUW Provider

The `db2` type-id: IBM Db2 for Linux, UNIX and Windows over DRDA, through the `db2-node` 1.0.22 driver.
Source: [`src/lib/db/providers/sql/db2/`](../../src/lib/db/providers/sql/db2/).
Tests: [`tests/unit/db/db2/`](../../tests/unit/db/db2/) and [`tests/integration/db/db2-provider.test.ts`](../../tests/integration/db/db2-provider.test.ts).
Tracking issue: [#786](https://github.com/libredb/libredb-studio/issues/786).

Every measured fact on this page was measured on 2026-10-03 against the `icr.io/db2_community/db2` 12.1.0.0 and 11.5.9.0 containers, through `db2-node` 1.0.22 on Node 24 and Bun 1.4.2, unless the sentence names another basis.

## 1. Overview

Studio connects to a Db2 LUW database, lists its schemas and their objects, describes tables, views and materialized query tables, shows the stored definition of views, routines and triggers, runs SQL with server-side paging, and offers RUNSTATS and REORG on one table at a time.
This first version is deliberately narrow, because the driver it runs on has defects that corrupt or drop data on some types: read [Known issues](#4-known-issues-db2-node-1022) before you rely on a result.

Db2 for z/OS and Db2 for IBM i are out of scope.
Both need IBM's Db2 Connect gateway to be reached over DRDA, and nothing here was measured against either.

### 1.1 The driver, and why

`db2-node` is a DRDA client written in Rust and shipped as a native N-API addon, one prebuilt binary per platform, under the MIT licence.
It needs no IBM client, no `IBM_DB_HOME` and no CLI driver download, which is what lets every image and the desktop build carry Db2 without an IBM licence step.
It is pinned exactly, at 1.0.22, as a regular dependency.
The defects of section 4 are reported upstream at [gurungabit/db2-node#12](https://github.com/gurungabit/db2-node/issues/12), and the provider will move to a release that fixes them.

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
| `params.ts` | `normaliseParams()`, which keeps a `bigint` away from the driver (K10) |
| `values.ts` | `db2TypeName()`, `readResult()` and `DB2_PREVIEW_PROJECTION` |
| `catalog.ts` | The catalog SQL, and the decoders that read its rows: names, column types, object detail and source text |
| `objects.ts` | The row mappers of the object surface |
| `maintenance.ts` | `adminCommandTarget()`, `maintenanceStatement()` and the statement that reads a target's type |
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
| Password | No | Sent empty when none is given; sent in cleartext without TLS (K11), see section 3.3; a password holding `!`, `[`, `]`, `^` or `\|` is refused before connecting (K23) |
| SSL panel | Yes, unless you opt out | Section 3.3 |

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
The version shown in the monitoring overview is `SERVICE_LEVEL` of `SYSIBMADM.ENV_INST_INFO`, for example "DB2 v12.1.0.0"; the driver's own `serverInfo()` answers the instance name and `SQL12010` and is never read (K13).

### 3.3 TLS

TLS is the part of this provider to set up first.
Without it, `db2-node` 1.0.22 downgrades the security mechanism in silence and sends the password to the server in EBCDIC cleartext, even when it is asked for an encrypted mechanism (K11).
So the provider refuses a connection with no TLS settings, with an error that names that defect, unless the connection carries the explicit insecure opt-in, `allowInsecureAuth: true`, shown in the connection form as a checkbox that says the password travels in cleartext.
Turn the opt-in on only for a database on a network you trust end to end, such as a local container.

The SSL panel's modes map to `db2-node` options as follows:

| Mode | `db2-node` options | What is checked |
|---|---|---|
| Disabled, with the insecure opt-in | `ssl: false` | Nothing; the password travels in cleartext |
| Require (no verification) | `ssl: true, rejectUnauthorized: false` | Encryption only; a server that impersonates the host is not detected |
| Verify (system trust) | `ssl: true, rejectUnauthorized: true` | The chain, against the system trust store |
| Verify CA | `ssl: true, rejectUnauthorized: true, caCert: <file>, sslClientHostnameValidation: "OFF"` | The chain, against your CA; not the host name |
| Verify full | `ssl: true, rejectUnauthorized: true, caCert: <file>, sslClientHostnameValidation: "Basic"` | The chain and the host name |

Verification is the default once TLS is on; "Require" is a separate choice you make on purpose.
Verify full without a CA certificate checks the chain against the system trust store, and the host name as before.
Verify CA without a CA certificate is refused: it checks no host name, so against the system trust store it would accept any publicly trusted certificate, issued for any name, and send it the password.
The panel holds the CA as PEM text and `db2-node` wants a file path, so the provider writes the PEM to `ca.pem` in a fresh `libredb-db2-` directory under the system temp directory, mode 0600, on connect, and removes the directory on disconnect and on a failed connect.
On Windows the mode bits do not apply, and the file is private through the per-user access control on the temp directory under the user profile.
A client certificate or key is refused with "db2-node 1.0.22 has no client-certificate authentication; remove the client certificate and key from this Db2 connection.", never ignored.

Measured: the connection negotiates TLS 1.3; a CA certificate with host-name validation, host-name validation `OFF` and `rejectUnauthorized: false` each connect; the system trust store alone answers `UnknownIssuer` for a server signed by a private CA; Verify full by an IP address the certificate does not name fails with "invalid peer certificate: certificate not valid for name", where Verify CA connects; and a plaintext connection to the TLS port is reset.

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

## 4. Known issues (db2-node 1.0.22)

K1 to K17 are reported upstream at [gurungabit/db2-node#12](https://github.com/gurungabit/db2-node/issues/12); K18 to K23 were measured after that report and are not in it yet.
The provider will move to a driver release that fixes them, and the maintainer's fork, [libredb/database-provider-db2-node](https://github.com/libredb/database-provider-db2-node), is the fallback if upstream does not.
The live script `tests/live/db2-known-issues.ts` probes each row against a running Db2 and prints `PRESENT` or `GONE`, so a driver bump starts by running it.

| # | Issue | What you see | Mitigated by the provider | Workaround |
|---|---|---|---|---|
| K1 | Non-ASCII text in CHAR or VARCHAR is decoded as EBCDIC 037 | "Grüße" reads as mojibake; the bytes on the server are correct | No | None for reads; write non-ASCII text with another client. Inline row edit, data import and Create Table are off, so Studio never writes the garbled text back |
| K2 | INTEGER is byte-swapped when a DECFLOAT or BOOLEAN column sits in the same row | 1 reads as 16777216 | No | Select the INTEGER and the DECFLOAT or BOOLEAN columns in separate queries, or `CAST(col AS VARCHAR(40))` the DECFLOAT or BOOLEAN |
| K3 | A BOOLEAN column alone returns phantom rows | 7 rows for 3 | No | `CAST(col AS VARCHAR(5))` |
| K4 | `SELECT *` on a table with such columns returns too few rows and no error | rowCount 0, or some of the rows, and columns missing from the header: `APP.ALLTYPES` answered 2 rows of 3 and 20 of 25 columns, while the projected preview answered all 3 rows exactly | Partly: the object browser's preview names and casts its columns | Name the columns and cast the defect types |
| K5 | XML rows whose value is NULL are dropped | 1 row of 3 | No | `XMLSERIALIZE(col AS VARCHAR(32000))`, which drops a row whose document is longer than 32000 bytes, silently |
| K6 | BIGINT is read as a JS number, lossy above 2^53, and cannot be bound losslessly | 9223372036854775807 reads as 9223372036854776000 | Partly: the preview casts BIGINT, and a result with a BIGINT column carries an integrity warning | `CAST(col AS VARCHAR(20))` or `CHAR(col)` |
| K7 | CLOB, DBCLOB and BLOB fetches fail | SQLSTATE 58009, SQLCODE -30020, and the LOB column vanishes from the header | Yes for the provider's own reads: no catalog query selects a LOB | `VARCHAR(SUBSTRING(col, 1, 32672, OCTETS), 32672)` for text, never a `CAST` that truncates (K20), or leave the LOB column out |
| K8 | TIMESTAMP(0) and TIMESTAMP(12) fail to decode | "expected 26 bytes" | No | `VARCHAR(ts)` |
| K9 | Every `CALL` fails | SQLSTATE 07005, SQLCODE -517 | Yes for maintenance, which wraps its call in a compound block | None in the editor: Studio's statement splitter cuts a `BEGIN ... END` block at its inner `;`, so use RUNSTATS and REORG from the object tree |
| K10 | Binding a JS `bigint` panics in Rust and aborts the process | An uncatchable crash of the whole server | Yes: `normaliseParams()` turns a safe-integer `bigint` into a number, refuses anything larger, and refuses an array or object parameter, inside which a `bigint` aborts the process too, each with a query error before the driver sees it | Not needed |
| K11 | Without TLS the password is sent in EBCDIC cleartext | Nothing visible: the downgrade is silent | Yes: a connection without TLS is refused unless it opts in | Enable TLS (section 3.3) |
| K12 | The `currentSchema` option has no effect | | Yes: never passed; every catalog query binds its schema | Qualify names in your own SQL |
| K13 | `serverInfo()` answers the instance name, not the product | `SQL12010` | Yes: never read; the version comes from `SYSIBMADM.ENV_INST_INFO` | Not needed |
| K14 | `queryTimeout` rejects on the client and leaves the statement running on the server | The statement keeps running and the client reconnects in silence | Yes: never set; the app's query timeout is not applied to Db2 | Set a server-side limit, see section 7.4 |
| K15 | Duplicate column names collapse in a row | `columns` lists both, the row holds one value | Yes, by visibility: the result carries a warning naming the column | Alias each column |
| K16 | A GRAPHIC parameter is padded with U+0000; TIMESTAMP(12) and `Date` parameters are refused; a BOOLEAN bound beside another parameter fails | "expected timestamp length 26 or 29 bytes", and "parameter descriptor count 1 does not match parameter count 2" | Yes for the provider's own SQL, which binds only VARCHAR-compatible values; a `Date`, array or object parameter is refused before the driver sees it, because a `Date` bound where a string fits is sent as `{}` | Write the value as a literal |
| K17 | Client-side failures carry no SQLSTATE | A protocol message only | No | Read the message |
| K18 | A statement that starts with a comment, block or line, is refused | SQLSTATE 42612, SQLCODE -84 | Yes: the provider strips leading comments before the statement reaches the driver | Not needed |
| K19 | A searched UPDATE or DELETE that matches no row reports -2147221503 changed rows | A negative row count | Yes: that value is read as 0, and any other negative count is reported as 0 with a warning that the count is unknown | Not needed |
| K20 | A value truncated with a warning desynchronises the driver | `VALUES CAST(REPEAT('x', 100) AS VARCHAR(10))` answers "Protocol error: query ended with undecoded row data"; a `CAST` of a 40868-byte CLOB to VARCHAR(32672) answered 36 garbage rows in one run and "Protocol error: invalid DSS magic byte" in another, and `VARGRAPHIC()` over a value longer than 16336 units returned garbage rows | Yes for the provider's own reads: a definition is read in `SUBSTRING` chunks, and the preview casts only values that fit | `VARCHAR(SUBSTRING(col, start, n, OCTETS), n)` |
| K21 | A row wider than one DRDA block fails | Two VARCHAR(32672) columns answer "Protocol error: invalid DSS magic byte", on the first run or the second | Yes for the provider's own reads: a definition is read one chunk per statement | Select fewer wide columns per statement |
| K22 | A bound DECIMAL that does not fit its column, or is not a number, is stored as a wrong value with no error | `SET AMT = ?` with "12345.67" into DECIMAL(5,2) stored 345.67, and `CAST(? AS DECIMAL(5,2))` answered 999.00 for 99999 and 323.00 for "abc", where the same literal is refused with SQLSTATE 22003, SQLCODE -413 | No: a statement run with parameters writes what the driver sends | Write DECIMAL values as literals; until a driver release fixes this, a bound DECIMAL write is not safe |
| K23 | A password holding `!`, `[`, `]`, `^` or `\|` is sent wrongly | The server answers "Security check failed: check_code=0x0F (user id or password invalid)" for a password that is right | Yes: the provider refuses such a password before connecting and names the characters, instead of letting the server call it wrong | Change the Db2 user's password to one without those five characters |

K23 was measured on 2026-10-04 against the compose `db2` service, Db2 12.1.0.0, through db2-node 1.0.22.
Over plaintext, `!` was refused under the driver's default security mechanism and under `securityMechanism: 'userPassword'`, each with `credentialEncoding` left out, `'utf8'` and `'ebcdic'`; `[`, `]`, `^` and `|` were refused with `credentialEncoding` left out and with `'utf8'`.
Over TLS (the recipe in section 3.3, Verify CA), all five were refused under the default mechanism.
Over plaintext every other printable ASCII character tried (`@ # $ % & * ? ~ { \`) was accepted, and over TLS `@` was.
The IBM CLP inside the container signed in over TCP with `Password123!`, so the server takes the password and the driver sends it wrongly.
The five are exactly the printable ASCII characters EBCDIC code page 037 places differently from code page 500.
`tests/live/db2-known-issues.ts` has no probe for K23, because it needs a Db2 user whose password holds one of the five; to re-measure it, set such a password with `chpasswd` in the container and connect with db2-node directly.

A result with a BIGINT, DECFLOAT, BOOLEAN or XML column carries an integrity warning above the grid that names those columns, says what the driver does to them and which cast reads them correctly, and says that exported or copied rows carry the same values; copy and export stay available, so read the warning before you hand the rows on.
TIMESTAMP(0), TIMESTAMP(12) and LOB columns need no warning, because they fail with an error instead.
A `SELECT *` you write yourself cannot be rewritten, so K4 still applies to it.

## 5. Capabilities

| Capability | Value | Why |
|---|---|---|
| Query language | SQL | |
| Default port | 50000 | DRDA listener convention |
| EXPLAIN | No | Db2's EXPLAIN fills the explain tables rather than answering a plan |
| External query limiting | Yes | Inherited |
| Create Table | No | No Db2 row of column types exists for the dialog, which would otherwise emit PostgreSQL DDL |
| Inline row edit | No | K1: a read-then-write-back stores corrupted text; it comes back when the driver decodes non-ASCII text |
| Data import | No | The same reason: no kind declares `acceptsRowWrites` |
| Result pagination | Yes | Section 7.2 |
| Transactions and SANDBOX | No | No held session in this version |
| Query cancel | No | `close()` waits for the running statement to end, so it is no cancel, and `queryTimeout` leaves it running (K14) |
| Foreign keys | Yes | Inherited |
| Maintenance | Yes | Run Statistics and Reorganize Table, per table only |
| Connection string | Yes | A `db2://` paste fills the fields |
| Identifier quoting | Double quotes | Declared, because port 50000 would otherwise fall to the PostgreSQL heuristic |
| Statement terminator | None | A trailing `;` is accepted |
| Container levels | Schema | |
| Container path shapes | Exact | Like Oracle |

The application's query timeout is not forwarded to Db2, because the driver's own timeout leaves the statement running on the server (K14).

## 6. Object surface

### 6.1 Containers

The containers are the rows of `SYSCAT.SCHEMATA` whose name does not start with `SYS` and is not `NULLID` or `SQLJ`, sorted by name.
The schema equal to `CURRENT SCHEMA` is marked as the session default.
Schema names are stored blank-padded in the catalog (`SCHEMANAME` arrives as `"APP     "`), so every schema column is trimmed on its right.
Every other name is read as stored, so an object name that ends in a blank keeps it.
On a database whose code set is UTF-8 (1208, the default since Db2 9.5) names and column defaults are read as `HEX(...)` and decoded in the provider, so a non-ASCII identifier survives K1.
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

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`.
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
A column default is a CLOB in the catalog, so its first 254 bytes are read as `HEX(VARCHAR(SUBSTRING("DEFAULT", 1, 254, OCTETS), 254))` beside `LENGTH("DEFAULT")` (K7).
254 bytes is the most IBM allows a default constant; a longer default is left out of the detail rather than shown cut, because a column's detail cannot say that a default is partial and a cut expression handed to a migration is worse than none.

A column's type is spelled as its declaration: `VARCHAR(n)`, `CHARACTER(n) FOR BIT DATA` for a binary character column, `DECIMAL(p,s)`, `TIMESTAMP` at the default precision 6 and `TIMESTAMP(p)` otherwise, `DECFLOAT(34)` or `DECFLOAT(16)`, and a character or graphic type declared in a unit other than its default keeps that unit, because its `LENGTH` is in bytes: `VARCHAR(10 CODEUNITS32)` has `LENGTH` 40 and `STRINGUNITSLENGTH` 10 (measured), and prints as declared.

`describeObjects()` describes a whole folder in four round trips: the target list, then the columns, the foreign keys and the indexes of every target at once.
A caller-bound limit cuts the target list and says so.

### 6.5 Source

Views, materialized query tables, procedures, functions and triggers show their stored definition text, labelled "Definition".
The text is a CLOB, so it is read as two `HEX(VARCHAR(SUBSTRING(TEXT, start, 16336, OCTETS), 16336))` chunks together with `LENGTH(TEXT)` (K7), and the blanks `SUBSTRING` pads a short chunk with are cut off by that length.
The obvious `CAST(TEXT AS VARCHAR(32672))` was measured and is worse than failing: on a longer text its truncation warning desynchronised the driver, which answered 36 rows of garbage for one view and "Protocol error: invalid DSS magic byte" for another.
A definition longer than 32672 bytes is shown cut, marked partial, and carries the reason "Db2 stores this definition as a CLOB longer than 32672 bytes, and db2-node 1.0.22 cannot fetch a CLOB, so only the first 32672 bytes are shown.", because a cut text does not run.
Because the chunks are read as hex and decoded in the provider, a non-ASCII character in a definition survives on a Unicode database; a cut that falls inside a character drops that character rather than showing a replacement glyph.

A routine with no text is refused with a reason chosen by its `ORIGIN`:

| ORIGIN | Reason shown |
|---|---|
| `E` | EXTERNAL routine: its body is compiled code outside the database. |
| `U` | SOURCED routine: it is defined as another function, with no body of its own. |
| `F` | FEDERATED procedure: its body lives on the remote data source. |
| other | SYSCAT answered no definition text for this routine (ORIGIN code). |

An empty definition answers "SYSCAT answered an empty definition.", and an object that is not found raises a query error naming it.

## Object edit (#789)

Object edit is absent in this version: no kind declares `acceptsSourceEdits`.
It was measured on the #787 branch and deferred: a failing `CREATE OR REPLACE PROCEDURE` or `TRIGGER` answers SQL0206N and leaves the old object valid with its old text, which is the safe outcome, but replacing a view leaves every dependent view `VALID 'N'` until its next use, so an edit would break objects the editor never showed.
`tests/isolated/object-edit-declarations.test.ts` is what holds that absence and this section together.

## 7. Query execution

### 7.1 Results

`query()` normalises the parameters (K10), strips leading comments (K18), sends the statement, and reads the result.
`fields` and `columnTypes` come from the driver's column metadata, so a zero-row result still has its header.
A SELECT reports the number of rows returned; any other statement reports the driver's affected-row count.
Each statement commits on its own.
The driver's diagnostics are passed through as result warnings, beside the duplicate-column warning of K15 and the integrity warning of section 4.
Errors go through the shared `mapDatabaseError()`, which reads the SQLSTATE and SQLCODE when the driver's message carries them.

### 7.2 Paging

A SELECT without its own limit is paged on the server: the first page gets `FETCH FIRST n ROWS ONLY`, a later one `OFFSET m ROWS FETCH NEXT n ROWS ONLY`, placed between the statement and its trailing `;` or comment.
A statement that already carries `FETCH FIRST` or `LIMIT` is left as written, and so is any statement that is not a SELECT.

### 7.3 Values

| Db2 type | Arrives as | Correct |
|---|---|---|
| SMALLINT, INTEGER | number | Yes, except K2 |
| BIGINT | number | Lossy above 2^53 (K6) |
| REAL, DOUBLE | number | Yes |
| DECIMAL(p,s) | string | Yes, lossless |
| DECFLOAT | string | Yes alone; K2 beside an INTEGER |
| CHAR(n) | string, blank-padded | ASCII only (K1) |
| VARCHAR | string | ASCII only (K1) |
| GRAPHIC, VARGRAPHIC | string | Yes |
| BINARY, VARBINARY | bytes | Yes |
| DATE | `2024-02-29` | Yes |
| TIME | `23.59.59` | Yes, in Db2's dot format |
| TIMESTAMP(6) | `2024-02-29-23.59.59.123456` | Yes |
| TIMESTAMP(0), TIMESTAMP(12) | error | No (K8) |
| CLOB, DBCLOB, BLOB | error | No (K7) |
| XML | string without the `<?xml` declaration | NULL rows dropped (K5) |
| BOOLEAN | | Phantom rows (K3) |

Column keys are upper case, and an unnamed expression is keyed `1`, `2` and so on.
A timestamp stays a string and is never turned into a `Date`, so no time zone shifts it.

### 7.4 No timeout and no cancel

Nothing bounds a statement on the Studio side: the app's query timeout is not applied to Db2 and there is no cancel (K14).
For a production database, bound statements on the server, with a Db2 workload management threshold such as `ACTIVITYTOTALTIME`, so an expensive query from any client ends there.

## 8. Maintenance

Run Statistics and Reorganize Table run on one table or materialized query table at a time, from its menu in the object tree; a view, an alias or any other kind is refused by name before anything is sent (RUNSTATS on a view answers SQLSTATE 428DY, measured), and there is no database-wide card, because Db2 LUW has no whole-database RUNSTATS or REORG.
The provider sends each as `SYSPROC.ADMIN_CMD` inside a compound block, because a bare `CALL` fails (K9):

```sql
BEGIN CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE "APP"."ORDERS" WITH DISTRIBUTION AND DETAILED INDEXES ALL'); END
BEGIN CALL SYSPROC.ADMIN_CMD('REORG TABLE "APP"."ORDERS"'); END
```

The target is the schema and table, each a delimited identifier with `"` doubled, and then every `'` doubled because the whole command is a string literal: the table `O'Brien` becomes `"APP"."O''Brien"`.
A request without a schema is refused; the provider never falls back to `CURRENT SCHEMA`.
Run these from the object tree, not the editor: the editor's statement splitter cuts the block at its inner `;`.

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

The `rustls` and `rustls-webpki` versions compiled into 1.0.22 fall inside published RustSec advisories, checked on 2026-10-03: `rustls` 0.23.37 is inside RUSTSEC-2026-0285 (patched in 0.23.45), and `rustls-webpki` 0.103.10 inside RUSTSEC-2026-0098, RUSTSEC-2026-0099 and RUSTSEC-2026-0104 (patched in 0.103.13).
They are compiled into the addon, so only a new `db2-node` release can pick the fixes up.
P7 in `docs/BACKLOG.md` tracks that release, and P8 tracks the pin bump to the release that fixes K1 to K22.
Only linux x64 was measured; arm64, macOS and Windows load the addon in the release probes but were not run against a Db2.

## 13. Testing

- `tests/integration/db/db2-provider.test.ts` drives the provider against a mocked driver that mirrors the fixture, and ends with the shared object-surface conformance check.
- `tests/unit/db/db2/` holds the unit tests of each module.
- `tests/live/db2-known-issues.ts` prints `PRESENT` or `GONE` for every row of section 4, and `tests/live/db2-live-check.ts` runs the provider against a live Db2; neither runs in `bun run test`.

The `db2` service of `database-compose.yml` runs `icr.io/db2_community/db2:12.1.0.0` unprivileged, with `cap_add: [IPC_LOCK, IPC_OWNER]`, on port 50000.
Its first boot creates the instance and the database and takes several minutes; wait for the health check before you connect.
The fixture under `docker/db2-init/` creates the schemas `APP` and `REPORTING` with tables, a cross-schema foreign key, a view, an invalid view, a materialized query table, an alias, a sequence, a procedure, an overloaded function, an external function, two triggers (one cross-schema), a module, `APP."Mixed Case"`, `APP."O'Brien"` for the maintenance quoting, and `APP.ALLTYPES` and `APP.EMPTY_T` for the value checks.

```bash
docker compose -f database-compose.yml up -d db2
bun tests/live/db2-known-issues.ts
```

## 14. References

- [IBM Db2 12.1 documentation](https://www.ibm.com/docs/en/db2/12.1.x)
- [db2-node on npm](https://www.npmjs.com/package/db2-node), and the upstream defect report [gurungabit/db2-node#12](https://github.com/gurungabit/db2-node/issues/12)
- [#786](https://github.com/libredb/libredb-studio/issues/786), the tracking issue, and [#787](https://github.com/libredb/libredb-studio/pull/787), the earlier ibm_db attempt whose catalog SQL this provider keeps
