# Snowflake Provider

> Snowflake support for LibreDB Studio over the Snowflake SQL API v2 (`https://<account>.snowflakecomputing.com/api/v2/statements`), with Studio's own client and no Snowflake driver.
> Every statement is one asynchronous SQL API request through the shared `node:https` transport, signed with a key-pair JWT or a programmatic access token.
> This document is the reference for the Snowflake provider: connecting, the recommended Snowflake-side setup, sessions, cost, results, the tree, features, the confirmation gate, security, errors and the embedded package.

|                        |                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| **Status**             | Implemented                                                                                         |
| **Database type id**   | `snowflake`                                                                                         |
| **Family**             | SQL (`src/lib/db/providers/sql/snowflake/`)                                                         |
| **Driver**             | None: the SQL API v2 over the shared transport; `node:crypto` signs the JWT; no new dependency       |
| **Query language**     | `sql` (Snowflake SQL)                                                                               |
| **Default port**       | None: the endpoint is always the account host on 443                                                |
| **Connection string**  | Not stored: a pasted Snowflake URL is decomposed into fields                                        |
| **EXPLAIN**            | `snowflake-json`: `EXPLAIN USING JSON`, which compiles the statement; never sent for a `SYSTEM$` call |
| **Writes**             | Whatever the role allows; the confirmation gate asks before Snowflake's destructive forms            |
| **Transactions**       | None across statements; a transaction runs inside one `EXECUTE IMMEDIATE $$ ... $$` block           |
| **Maintenance**        | None                                                                                                |
| **Query parameters**   | Not supported: v1 sends no bindings                                                                 |
| **Query cancellation** | Supported: Studio cancels the statement by its handle                                               |

## 1. What it is

The provider speaks the SQL API v2 with its own client: a submit, a status poll, one request per result partition and a cancel, all to the account host.
It adds no Snowflake driver and no new dependency.
The connection is the account; the tree's two container levels are database and schema.

| Snowflake | Studio |
| --- | --- |
| Account | The connection (the Account field) |
| Database | Container, level 0, labelled "Database" |
| Schema | Container, level 1, labelled "Schema" |
| Table, view, stream, task, sequence, stage, file format, pipe, function, procedure | Object kinds ([section 7](#7-the-tree)) |
| Role | Sent on every request; every statement runs as this role |
| Warehouse | Sent on every request; the compute a statement that needs one runs on |

| File | Role |
| --- | --- |
| `src/lib/db/providers/sql/snowflake/index.ts` | The provider: capabilities, labels, object kinds, lifecycle |
| `src/lib/db/providers/sql/snowflake/account-host.ts`, `account.ts` | The Account field's forms and the host rule |
| `src/lib/db/providers/sql/snowflake/auth.ts` | Key intake, the JWT and the access token |
| `src/lib/db/providers/sql/snowflake/transport.ts` | The text and byte transports, their lanes and retries |
| `src/lib/db/providers/sql/snowflake/statements.ts` | Submit, poll, cancel, the role check, the session notices and the tags |
| `src/lib/db/providers/sql/snowflake/rows.ts`, `decode.ts` | Partitions, the budgets and type decoding |
| `src/lib/db/providers/sql/snowflake/introspect.ts`, `monitoring.ts` | The tree, describe, source, health and the monitoring panels |
| `src/lib/db/providers/sql/snowflake/errors.ts` | The error table |
| `src/lib/explain/snowflake-json.ts` | The EXPLAIN strategy |

## 2. Connecting

### 2.1 Fields

The dialog shows no port field, no SSL panel and no SSH tunnel.

| Label | Field | Required | Hint |
| --- | --- | --- | --- |
| Account | `host` | Yes | An account identifier such as myorg-myaccount, or its https:// URL. Once it reads, the hint names the host Studio connects to instead |
| User | `user` | Yes | The user's login name (LOGIN_NAME). |
| Sign-in | `authMethod` | Always set, Key pair by default | Key pair, or Programmatic access token |
| Private key | `privateKey` | For Key pair | Paste the private key's contents. Studio reads no key file. |
| Passphrase | `privateKeyPassphrase` | No | Only for an encrypted key. |
| Access token | `password` | For a programmatic access token | A programmatic access token for this user. |
| Warehouse | `warehouse` | No | Leave empty to use the user's default warehouse. Queries need one; browsing does not. |
| Database | `database` | No | Opened first in the tree, and the default for unqualified names. |
| Schema | `schema` | No | The default schema for unqualified names. |
| Role | `role` | Yes | Every statement runs as this role; Studio checks it when it connects. |

The key and passphrase fields show only for Key pair and the token field only for a programmatic access token; switching the method clears the other method's secret, so a saved connection holds one credential.
The fields marked Yes carry a required mark in the dialog; User, Warehouse, Database, Schema and Role show no example value, since a name such as `user` or `default` reads as one already typed, and each box's hint says what it takes.
A Test connection result is withdrawn as soon as any field changes, so it never stands beside fields it was not run on.
User, Role, Warehouse, Database and Schema are read without the whitespace around them, so a trailing space does not turn a registered key, a granted role or an existing warehouse into a missing one; a quoted name keeps the spaces inside its quotes.
Passphrase loses only a line break at its end, as a paste from a file leaves one; a space is part of the passphrase.
An empty or malformed field is refused in the dialog and again by `connect()`, before any socket, with these sentences:

- `Enter Account: an account identifier such as myorg-myaccount, or its URL. Nothing was sent.`
- `Enter an account identifier such as myorg-myaccount, or its https URL; a jdbc: or snowflake:// URL goes into Paste URL instead. Nothing was sent.`
- `A PrivateLink account locator needs its region, such as xy12345.us-east-1.privatelink. Nothing was sent.`
- `Enter the user's login name. Nothing was sent.`
- `Enter the role every statement runs as. Nothing was sent.`
- `Paste the private key for key-pair sign-in. Nothing was sent.`
- `Enter the programmatic access token. Nothing was sent.`
- `Choose Key pair or Programmatic access token for Sign-in. Nothing was sent.`, by `connect()` and the seed load only, since the dialog's select offers only the two methods

### 2.2 The Account field

Account takes:

- an organisation identifier `orgname-account_name`, with `_` or `-` in the account part;
- a locator `locator[.region[.cloud]]` (AWS Oregon needs no region);
- either of those with `.privatelink`, and the `.snowflakecomputing.cn` suffix for China;
- an account URL `https://<identifier>.snowflakecomputing.com` (or `.cn`), with an optional trailing `/`;
- a Snowsight URL `https://app.snowflake.com/<org>/<account>/...`, read as `<org>-<account>`, or `https://app.snowflake.com/<region>/<locator>/...`, which Snowsight still issues, read as `<locator>.<region>` (`<locator>` alone for AWS Oregon, `us-west-2`); a first segment holding a hyphen is the region, since an organisation name has none. Either has no query, fragment, user part or port, and Studio never sends a request to `app.snowflake.com`.

Studio builds the origin itself as `https://<identifier>.snowflakecomputing.com:443` and accepts a host only under `.snowflakecomputing.com` or `.snowflakecomputing.cn`, with at most five labels before the suffix, no IP literal, no other port, and no path, query or user part.
Each label is at most 63 characters and neither starts nor ends with a hyphen, and spaces around the text are ignored.
The dialog's hint ("Studio connects to `<host>`.") appears only for a text `connect()` takes, since the hint, the dialog's check and `connect()` read the text with one function; a text it refuses is named under Account when Test connection or Save refuses it, and editing Account clears that sentence.
The suffix comes off once, and an identifier whose labels still name a Snowflake domain is refused, such as a doubled suffix or `app.snowflake.com`; a label holding `snowflakecomputing` is refused wherever it appears, while `snowflake` is compared as a whole label beside `com`, so `snowflake.community` reads as a locator and its region.
For an account name with an underscore, prefer the hyphen form (`myorg-my-account`): Node's certificate checker accepts both, but OpenSSL-based validators on a proxy or gateway can refuse the underscore form.

### 2.3 Key pair

Generate an encrypted key and its public key:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -v2 aes-256-cbc -out rsa_key.p8
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

The public key's body is the lines between `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`, joined into one line.
Studio names a key `libredb_studio_<fp8>`, where `<fp8>` is the first 8 hex characters of the SHA-256 of the key's DER public key, which this prints:

```bash
openssl pkey -pubin -in rsa_key.pub -outform DER | openssl dgst -sha256
```

An administrator registers it, then checks it:

```sql
ALTER USER <name> ADD KEY PAIR libredb_studio_<fp8> PUBLIC_KEY = '<public key body>';
SHOW USER KEY PAIRS FOR USER <name>;
```

`ALTER USER <name>` takes the user's NAME, which `DESC USER` and `SHOW USERS` show and which can differ from the login name in User.
`ALTER USER <name> SET RSA_PUBLIC_KEY = '<public key body>'` is the documented alternative.
Signed in as itself, a user lists its keys with `SHOW USER KEY PAIRS`.
The self-service form, `ALTER USER ADD KEY PAIR libredb_studio_<fp8> PUBLIC_KEY = '<public key body>'`, was refused on the trial with 003001, by a message that names MODIFY PROGRAMMATIC AUTHENTICATION METHODS on the user as the privilege it needs.

Either order works:

1. Generate the key, have an administrator register it, then connect.

1. Generate the key and connect with it.
2. Studio refuses the key pair and prints the administrator's registration statement for this key, which the dialog shows with a copy button.
3. An administrator runs that statement with the user's NAME in place of `<name>`, then you connect again.

Paste the private key's contents into Private key: Studio reads no key file, and no field is ever read as a path.
A PKCS#8 key (`PRIVATE KEY` or `ENCRYPTED PRIVATE KEY`) and a PKCS#1 key (`RSA PRIVATE KEY`, encrypted or not) are accepted; the key must be RSA, 2048 to 4096 bits, and at most 16 KiB of text.
An encrypted PKCS#8 key must use PBES2 with PBKDF2 or scrypt and AES-CBC, at a cost no higher than 1,000,000 PBKDF2 iterations with hmacWithSHA256, 500,000 with hmacWithSHA1 (the PRF when none is named), 200,000 with hmacWithSHA384 or hmacWithSHA512, or scrypt N 16,384, r 8, p 1; the command above uses OpenSSL's default of 2,048 iterations.
Under the Bun runtime, whose BoringSSL decrypts neither scrypt PBES2 nor PBKDF2 with hmacWithSHA384 or hmacWithSHA512, such a key is refused with `Studio could not read this private key. Nothing was sent.` once a passphrase is entered (with Passphrase empty, the passphrase sentence comes first).
Node, which the Docker image, the Helm chart and `npx` run Studio on, opens them, and a PBKDF2 key with hmacWithSHA256 or hmacWithSHA1, such as the command above makes, opens under both (measured on Bun 1.4.2 and Node 24, 26.10 and 26.12.1).
Whether a key is encrypted is read from its contents, not its label: an encrypted PKCS#8 body armoured as `PRIVATE KEY` meets the same bound, and an `RSA PRIVATE KEY` body that is not a PKCS#1 key is refused as unreadable.
Each refusal is one of these sentences:

- `The private key is larger than Studio accepts (16 KiB). Nothing was sent.`
- `This is the public key. Paste the private key; the public key is what you register on the Snowflake user. Nothing was sent.`
- `The private key is not a PEM key. Paste the key's contents, starting with -----BEGIN. Nothing was sent.`
- `The private key field holds more than one PEM block. Paste the private key's block alone, from -----BEGIN to -----END. Nothing was sent.`
- `The private key ends before its -----END line. Paste the whole key. Nothing was sent.`
- `This is a certificate, not a private key. Paste the private key whose public key is registered on the Snowflake user. Nothing was sent.`
- `This PEM block is not a private key Studio reads. Paste an RSA private key armoured as PRIVATE KEY, ENCRYPTED PRIVATE KEY or RSA PRIVATE KEY. Nothing was sent.`
- `This key's encryption is set to cost more work than Studio allows. Re-encrypt it with openssl pkcs8 -topk8 -v2 aes-256-cbc. Nothing was sent.`
- `This key is encrypted with a scheme Studio does not read, such as PBES1 or a PKCS#12 one; Studio reads PBES2 with PBKDF2 or scrypt and AES-CBC. Re-encrypt it with openssl pkcs8 -topk8 -v2 aes-256-cbc. Nothing was sent.`
- `This key is encrypted; enter its passphrase. Nothing was sent.`
- `The passphrase does not open this key. Nothing was sent.`
- `Studio could not read this private key. Nothing was sent.`
- `Studio signs with RSA keys only; this is an EC key. Nothing was sent.`, with `a DSA`, `an Ed25519` or `an Ed448` in place of `an EC` for those types, the type read from the key, or from the label of an `EC PRIVATE KEY` or `DSA PRIVATE KEY` block
- `Snowflake needs an RSA key of at least 2048 bits. Nothing was sent.`
- `Studio accepts RSA keys up to 4096 bits; this key is <bits> bits. Nothing was sent.`

The JWT lives 15 minutes and is renewed at the first request 10 minutes after it was signed, so a captured token replays for at most 15 minutes and an idle connection signs nothing.
A refused key is reported, never re-signed and retried.

### 2.4 Programmatic access token

With Sign-in set to Programmatic access token, paste the token into Access token.
For a PAT on a PERSON user, a network policy must allow the public address Studio connects from, which on a laptop changes with the network.
The durable relief is an authentication policy with `PAT_POLICY = (NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED)`.
On the trial on 2026-10-13 that policy let a token sign in for a user with no network policy, and each policy change took up to about 45 s to show.
Key pair avoids that requirement, though a network policy that applies to the user still refuses an address it excludes.
Use Key pair for npx and the desktop app, and a PAT for a server with a fixed egress address.
A token names its own user and the SQL API takes no user beside it, so Studio compares User with the `CURRENT_USER()` the role check answers and fails the connect when they differ.
The comparison ignores case unless User is double-quoted; `CURRENT_USER()` answers the user's NAME, so for a token enter the NAME when it differs from the login name.
Spaces, tabs and line breaks around the token and a leading `Bearer ` come off before it is sent, so a token read from a file or copied from a curl example works.
Studio does not otherwise read a token's format, but it refuses before anything is sent a token longer than 4,096 characters or holding a character an HTTP header cannot carry, and a key-pair JWT pasted as the token, which Snowflake accepts and which signs in as its own user until it expires within the hour:

- `The access token is longer than Studio accepts (4,096 characters); a programmatic access token is far shorter. Paste the token alone. Nothing was sent.`
- `The access token holds characters a token cannot have, such as a space, a line break or a non-ASCII letter. Paste the token alone. Nothing was sent.`
- `This is a key-pair JWT, not a programmatic access token: it signs in as the user its key belongs to and expires within the hour. Choose Key pair for Sign-in and paste the private key instead. Nothing was sent.`

### 2.5 Test connection

Test connection checks the key, the account, the role Snowflake runs as and the warehouse's state, without starting the warehouse.
Your first query starts the warehouse if it is suspended, and Snowflake bills at least one minute for that.

Test connection, Save and every connect send one `SHOW WAREHOUSES LIKE '<warehouse>'`, or `SHOW DATABASES LIMIT 1` when Warehouse is empty, then the role check, `SELECT CURRENT_ROLE() AS r, CURRENT_SECONDARY_ROLES() AS s, CURRENT_USER() AS u, CURRENT_DATABASE() AS d, CURRENT_SCHEMA() AS c, CURRENT_WAREHOUSE() AS w`, with the same context.
Neither needs a running warehouse: on the trial the role check answered with the warehouse suspended and left it suspended, and answered under a role holding no warehouse at all, so a connection with Warehouse empty passes it too.
The check with `CURRENT_USER()` added answered the same way on 2026-10-14, the warehouse suspended before and after it.
A role other than Role fails the connect with the role mismatch sentence of [section 11](#11-errors).
Under token sign-in a user other than User fails it too, with the token user sentence of [section 11](#11-errors).
Either statement unanswered within its bound fails the connect with the connect sentence of [section 11](#11-errors), never the query-timeout one: Test connection sends them under its own 10 s timeout, which Query Timeout does not change, so its connect sentence reads 15 s, Studio's deadline with its 5 s grace.
They add a caution only when something is wrong:

- `Snowflake shows no warehouse named <wh> to role <role>. Check the name, and that the role has USAGE on it.`
- `Warehouse <wh> is suspended and does not resume on its own, so queries fail until someone resumes it.`
- `Warehouse is empty, so queries use the user's default warehouse and fail if the user has none. Browsing works without one.`
- `Snowflake resolves no database named <db> for role <role>, so statements run with no current database and unqualified names fail. Check the name, its case, and that the role has USAGE on it.`
- `Snowflake resolves no schema named <schema> in the connection's database for role <role>, so statements run with no current schema and unqualified names fail. Check the name, its case, and that the role has USAGE on it.`
- `Snowflake resolves no warehouse named <wh> for role <role>, so queries fail although browsing works. Check the name, its case, and that the role has USAGE on it.`

The last three come from the role check's `CURRENT_DATABASE()`, `CURRENT_SCHEMA()` and `CURRENT_WAREHOUSE()` answering NULL for a name the connection sets: the schema caution is left out when the database's was given, and the warehouse caution when the `SHOW WAREHOUSES` caution above already named that warehouse.

When secondary roles are active for the user, Test connection shows this caution, because the tree, every SHOW and every statement can reach what those roles can, not only Role:

`Secondary roles are active for this user (<roles>), so this connection can read and change what those roles can, not only role <role>. An administrator can set DEFAULT_SECONDARY_ROLES = () on the user.`

### 2.6 Paste URL

The paste box reads an account host (`<identifier>.snowflakecomputing.com` or `.cn`), an account URL, a Snowsight URL, `jdbc:snowflake://<host>/?<params>` and `snowflake://<user>@<account>/<database>/<schema>?<params>` into fields; the scheme and the parameter names are read in any case.
A bare account identifier such as `myorg-myaccount` is typed into Account instead: as a paste it is one word, which would claim any text, so the box refuses it with the list of formats it reads, the same list its hint shows.
The pasted text is read in the browser and never kept: it is not stored as a connection string, sent to a route or kept in form state after the parse.
It applies `user`, `warehouse`, `db` or `database`, `schema`, `role`, `authenticator` (`SNOWFLAKE_JWT` or `PROGRAMMATIC_ACCESS_TOKEN`), `token`, and the key passphrase parameters.
An inline key parameter and every file-path parameter are refused by name.
A password (in the user part or as `password`), `passcode`, an OAuth client secret, `proxyPassword`, `insecureMode`, `disableOCSPChecks` and an `authenticator` of any other value are named as not applied; every other parameter is counted, never named, and no value is ever echoed.
A `jdbc:snowflake://` URL carries the account's host, so one whose host is not under `.snowflakecomputing.com` or `.snowflakecomputing.cn` is refused, and so is a `snowflake://` URL whose account is neither such a host nor an account identifier (a name, then optionally a region, its cloud and `privatelink`), rather than read as a locator and region under Snowflake's domain: `This URL names a host outside Snowflake. A jdbc:snowflake:// URL carries the account's host, ending in .snowflakecomputing.com or .snowflakecomputing.cn, and a snowflake:// URL that host or the account identifier, such as myorg-myaccount. Nothing was applied.`
A refused paste fills no field and clears the paste box, and the dialog switches to Snowflake, so the Private key box its sentence names is in view.
A paste that names another account than Account holds, or that switches the dialog from another engine, first clears every credential and context field (User, Sign-in, Private key, Passphrase, Access token, Warehouse, Database, Schema, Role), so one account's token or key is never sent to another; a paste naming the account already in Account fills in over what was typed.
Choosing another engine in the dialog clears the same fields the other way, so a Snowflake warehouse, user or secret does not follow to it; only the name, the environment, the query timeout, the read-only and no-scan choices, and the Account text, which stays in the next engine's Host box, are kept.
`insecureMode` and `disableOCSPChecks` never lower TLS.

### 2.7 Seeding

A Snowflake connection is seeded like any other ([SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md)); keep the key or token out of the file:

```yaml
version: "1"

connections:
  - id: "snowflake-analytics"
    name: "Snowflake analytics"
    type: "snowflake"
    host: "myorg-myaccount"
    user: "STUDIO_SVC"
    authMethod: "keypair"
    privateKey: "${SNOWFLAKE_PRIVATE_KEY}"
    privateKeyPassphrase: "${SNOWFLAKE_KEY_PASSPHRASE}"
    warehouse: "STUDIO_WH"
    database: "ANALYTICS"
    role: "STUDIO_RO"
    roles: ["admin", "user"]
    mcp: true
```

For a token, set `authMethod: "pat"` and `password: "${SNOWFLAKE_PAT}"` instead of the two key fields.
A seed that sets `connectionString` for `snowflake` is refused.
The file load also checks, on every field that is not a reference, what `connect()` checks first: the account as `connect()` reads it, that User, Role and the key or token the method needs are not empty, and that the method is `keypair` or `pat`.
It refuses the file with `Seed connection "<id>": <field> is refused: <sentence>`, the sentence without its closing `Nothing was sent.`, so an entry that could never open is named in the Seed sources card instead of loading and failing when it is opened; the key's and the token's contents are read only when the connection opens.

### Connection string

Snowflake has no connection string scheme and no `readTls` ([`connection-string.ts`](../../src/lib/db/providers/sql/snowflake/connection-string.ts)); a pasted URL is read as section 2.6 describes.
Its `validateSeed` runs at seed load the checks its provider makes in `connect()` before any socket, each skipped for a field that holds a `${...}` reference, and every refusal is the provider's own sentence.
The checks are, in order: `host`, the account, by `checkSnowflakeAccount`; `user`, which may not be empty; `authMethod`, which must be `keypair` (the default) or `pat`; `privateKey`, which a key pair needs; `password`, which holds the token `pat` needs; and `role`, which may not be empty.

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `snowflake` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/sql/snowflake/execution-ui.ts).

## 3. The recommended Snowflake setup

Studio runs every statement as Role and stops nothing a role may do.
The role is the boundary, not Studio: grant it no MODIFY, OPERATE, MANAGE WAREHOUSES or CREATE TASK, and keep `DEFAULT_SECONDARY_ROLES = ()` on the user or use a role-restricted credential, because with secondary roles ALL a read-only role is not a boundary.
On the trial on 2026-10-13 a key restricted to one role signed in under that role and under no role, and was refused under another with 390186.
On 2026-10-12 a token restricted to one role signed in under that role and was refused under another with 390186.
Every name below is a placeholder:

```sql
-- As an administrator. Placeholders: STUDIO_RO, STUDIO_WH, ANALYTICS, STUDIO_SVC.
-- CREDIT_QUOTA, the trigger percentages and STATEMENT_TIMEOUT_IN_SECONDS are starting values.
CREATE WAREHOUSE STUDIO_WH WAREHOUSE_SIZE = XSMALL GENERATION = '1' ENABLE_QUERY_ACCELERATION = FALSE
  AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE STATEMENT_TIMEOUT_IN_SECONDS = 600;
CREATE RESOURCE MONITOR STUDIO_RM WITH CREDIT_QUOTA = 10
  TRIGGERS ON 80 PERCENT DO NOTIFY ON 100 PERCENT DO SUSPEND_IMMEDIATE;
ALTER WAREHOUSE STUDIO_WH SET RESOURCE_MONITOR = STUDIO_RM;
CREATE ROLE STUDIO_RO;
GRANT USAGE ON WAREHOUSE STUDIO_WH TO ROLE STUDIO_RO;
GRANT USAGE ON DATABASE ANALYTICS TO ROLE STUDIO_RO;
GRANT USAGE ON ALL SCHEMAS IN DATABASE ANALYTICS TO ROLE STUDIO_RO;
GRANT USAGE ON FUTURE SCHEMAS IN DATABASE ANALYTICS TO ROLE STUDIO_RO;
GRANT SELECT ON ALL TABLES IN DATABASE ANALYTICS TO ROLE STUDIO_RO;
GRANT SELECT ON FUTURE TABLES IN DATABASE ANALYTICS TO ROLE STUDIO_RO;
GRANT SELECT ON ALL VIEWS IN DATABASE ANALYTICS TO ROLE STUDIO_RO;
GRANT SELECT ON FUTURE VIEWS IN DATABASE ANALYTICS TO ROLE STUDIO_RO;
GRANT SELECT ON ALL MATERIALIZED VIEWS IN DATABASE ANALYTICS TO ROLE STUDIO_RO;
GRANT SELECT ON FUTURE MATERIALIZED VIEWS IN DATABASE ANALYTICS TO ROLE STUDIO_RO;
-- Optional, for the monitoring panels: GRANT MONITOR ON WAREHOUSE STUDIO_WH TO ROLE STUDIO_RO;
CREATE USER STUDIO_SVC TYPE = SERVICE DEFAULT_ROLE = STUDIO_RO DEFAULT_WAREHOUSE = STUDIO_WH
  DEFAULT_SECONDARY_ROLES = ();
GRANT ROLE STUDIO_RO TO USER STUDIO_SVC;
-- The key Studio's key-pair refusal names; <fp8> is the first 8 hex characters of the key's SHA-256 (section 2.3):
ALTER USER STUDIO_SVC ADD KEY PAIR libredb_studio_<fp8> PUBLIC_KEY = '<public key body>';
```

- Assigning a key needs MODIFY PROGRAMMATIC AUTHENTICATION METHODS on the user, or OWNERSHIP, usually an administrator ([section 2.3](#23-key-pair)).
- A resource monitor caps warehouse credits only, not serverless features such as the Query Acceleration Service.
  On the trial on 2026-10-13 a monitor at its quota suspended the warehouse mid-statement, and the statement ended with HTTP 422, code 000629 and SQLSTATE 57014, `Warehouse ... was suspended immediate by resource monitor ..., statement aborted.`, which Studio shows with Snowflake's text and code; a statement that needs no warehouse still answered.
  A warehouse created without `GENERATION = '1'` may be Gen2, at another credit rate and with query acceleration on by default, which is why the recipe sets both.
- The warehouse's `STATEMENT_TIMEOUT_IN_SECONDS` caps the connection's Query Timeout, because Snowflake applies the lowest non-zero value of the two: under the recipe's 600 s, a longer Query Timeout still ends at 600 s.
  On the trial (Snowflake 10.37.100, 2026-10-12) a 700 s Query Timeout ended at the warehouse's 600 s with HTTP 408, code 000630 and SQLSTATE 57014, which Studio reports with the sentence of [section 5.3](#53-timeouts-cancel-and-disconnect).
- The credit quota, the trigger percentages and the statement timeout are starting values for a first setup, not Snowflake's advice.
- The recipe ran as written on the trial on 2026-10-13, and its user was refused an INSERT with 003001.

## 4. Sessions, transactions and blocks

Every request is its own Snowflake session context: Studio sends Database, Schema, Warehouse and Role on every request, and leaves a field out only when the connection leaves it empty, so Snowflake falls back to the user's default.
Each of the four is read as a name in Snowflake SQL: an unquoted name made only of letters, digits, `_` and `$` is upper-cased, a double-quoted name keeps its case without its quotes, and any other name is sent as typed, so `studio_ro` is sent as `STUDIO_RO` and `"Mixed Case"` as `Mixed Case`.
The SQL API reads the four fields as exact names: a role it cannot resolve is refused, while a database, schema or warehouse name Snowflake cannot resolve leaves that context unset without an error: `CURRENT_DATABASE()`, `CURRENT_SCHEMA()` or `CURRENT_WAREHOUSE()` then answers NULL.
The role check reads all three, so Test connection cautions on a configured name that answers NULL ([section 2.5](#25-test-connection)).
Studio sends no `TIMEZONE`, so every statement is evaluated in the user's own Snowflake `TIMEZONE` parameter (the account's, `America/Los_Angeles` by default, unless the user sets another), as Snowsight evaluates it: `CURRENT_DATE`, a `TIMESTAMP_LTZ` literal, a `TIMESTAMP_TZ` written without an offset and `DATE_TRUNC` over an LTZ value give the same rows in both.
How a result shows a `TIMESTAMP_LTZ` is in [section 6](#6-results).
The SQL API does not run `USE` (it answers code 391911, `Command not supported by SQL API: USE`), so a statement whose operative keyword is `USE` is refused before anything is sent:

`Snowflake's SQL API does not run USE. Set Database, Schema, Warehouse or Role on the connection instead, or use fully qualified names such as database.schema.table. Nothing was sent.`

`ALTER SESSION SET`, `ALTER SESSION UNSET`, `SET` and `UNSET` run without the confirmation gate, since nothing they change outlives the statement, and the result says the setting does not carry over (`ALTER SESSION POLICY` alters an account object, so it asks and carries no such notice):

`Each Snowflake statement runs in its own session, so a session setting or variable does not carry over to the next statement.`

A `CREATE` whose modifiers include `TEMP`, `TEMPORARY` or `VOLATILE` (a temporary table, stage, file format or any other temporary object) runs, and the object belongs to that statement's session, which no later request joins.
Measured on the trial on 2026-10-14: the next statement's `SELECT`, `INSERT`, `LIST` or `DROP` answers that the object does not exist or is not authorized, `SHOW STAGES LIKE` in the schema does not list it, yet `SHOW STAGES IN ACCOUNT` still lists a temporary stage after such a `DROP`, since the session that owns it lives on until Snowflake ends it.
The result says so:

`Each Snowflake statement runs in its own session, so this temporary object belongs to a session no later statement joins: the next statement cannot use or drop it, and Snowflake removes it only when that session ends. Create a permanent or TRANSIENT object instead, or use it inside one EXECUTE IMMEDIATE $$ ... $$ block.`

A statement whose code calls `LAST_QUERY_ID()` runs, and the function answers NULL, since its session holds no earlier statement; `RESULT_SCAN(LAST_QUERY_ID())` and `BEFORE(STATEMENT => LAST_QUERY_ID())` then fail with Snowflake's `Statement null not found`. The result, or the error after Snowflake's own text, says:

`Each Snowflake statement runs in its own session, so LAST_QUERY_ID() names no earlier statement here and answers NULL. Use the query ID from Query History instead, or call it inside one EXECUTE IMMEDIATE $$ ... $$ block.`

Inside an `EXECUTE IMMEDIATE $$ ... $$` block both work as in any session, so neither sentence is added there.

A lone transaction statement (`BEGIN [WORK | TRANSACTION] [NAME <n>]`, `START TRANSACTION [NAME <n>]`, and `COMMIT` or `ROLLBACK`, each alone or followed by `WORK`) is refused before it is sent:

`Snowflake's SQL API runs each statement in its own session, so a transaction cannot span statements. Nothing was sent. Run the whole transaction inside one EXECUTE IMMEDIATE $$ ... $$ block.`

Run a transaction or a Snowflake Scripting block inside one `EXECUTE IMMEDIATE $$ ... $$` statement:

```sql
EXECUTE IMMEDIATE $$
BEGIN
  BEGIN TRANSACTION;
  UPDATE orders SET status = 'shipped' WHERE id = 42;
  COMMIT;
END;
$$;
```

The confirmation gate asks before such a block runs ([section 9](#9-the-confirmation-gate)).
A bare block, as Snowsight runs it, fails at its first fragment with Snowflake's own syntax error, and Studio adds `A Snowflake Scripting block runs through the SQL API only inside EXECUTE IMMEDIATE $$ ... $$.`
The editor splits a script with Snowflake's grammar, `//` comments included, and sends each statement as its own request with a statement count of 1.
In that grammar `$` is a name character and only `$$` opens a string, as Snowflake's reference gives it, so a `$t$` run is code and `a$b$c` is one name, as the trial capture measured.
A backslash inside `"..."` is part of the name, so `"a\b"` names the column `a\b`.

### 4.1 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/sql/snowflake/sql-grammar.ts`](../../src/lib/db/providers/sql/snowflake/sql-grammar.ts), the `snowflake` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
Its grammar is `SNOWFLAKE_GRAMMAR`, the one reading the statement splitter, the row limiter, the confirmation gate and query-event redaction share, so they cannot disagree about where a literal or a comment ends.
The lexical facts were measured on the trial capture of 2026-10-12 (Snowflake 10.37.100), each recorded in `tests/fixtures/snowflake/trial-2026-10-12-v10.37.100/`; the rest are read off Snowflake's SQL reference.
`#` is code: the trial refused `SELECT 3 # 2` at the `#`.
`[` is a subscript into a semi-structured value, and names are quoted with `"` only.
Block comments are flat: the trial ran `SELECT /* a /* b */ 1` and refused the same text with a second `*/`.
`//` is a line comment: the trial ran `SELECT 1 AS c // a comment`.
A backslash escapes inside `'...'` but not inside `"..."` (a column named from `"a\b"` is `a\b`), and a `$` that would open a tagged run is code (`SELECT 1 AS a$b$c` ran as the name `A$B$C`).
The trial also ran `'a\<line feed>b'` as a three-character string, which the shared reader leaves unterminated, the fail-safe direction.
`NULL`, `''` and `$$$$` are unlimited row bounds, each measured on the trial on 2026-10-14 to return every row with a `LIMIT` appended after one a syntax error, and the bound goes before `FOR UPDATE [NOWAIT | WAIT <n>]`.
`readsSqlText` is `true`: the editor text is SQL, and the provider extends `SQLBaseProvider`.
Redaction is `sql` with no name quote: a redacted statement keeps its words, and every literal and quoted run becomes `?`.

## 5. What runs on a warehouse

Every `SHOW`, every `DESCRIBE`, every `EXPLAIN`, `GET_DDL`, the role check, a status poll and a cancel need no running warehouse; Snowflake bills such cloud-services work only above 10 percent of the day's warehouse use.
This was measured on the trial (Snowflake 10.37.100, 2026-10-12): `SHOW COLUMNS` and the other `SHOW` forms, `DESCRIBE`, `EXPLAIN USING JSON`, `GET_DDL`, the role check, a status GET and the MCP reads each left a suspended warehouse suspended.
Every other `SELECT`, DML, DDL with data, `CALL` and block, and every Information Schema view run on the warehouse.
A statement that needs a warehouse resumes a suspended one when AUTO_RESUME is TRUE, and Snowflake bills at least 60 seconds per start, then per second, and a running warehouse bills while idle until AUTO_SUSPEND.

### 5.1 Every billed surface

| Surface | What it sends | Warehouse | Control |
| --- | --- | --- | --- |
| Editor run | the user's statement | yes, if the statement needs one | the user's click; Query Timeout; cancel |
| Multi-statement script | one request per statement | per statement | Stop, a closed tab or a dropped request stops the remaining statements |
| Explain button | `EXPLAIN USING JSON` of a query, never for a call, dynamic SQL, a Scripting block or a statement naming a `SYSTEM$` function | no | the user's click |
| Background explain estimate | `EXPLAIN USING JSON` beside each run of a single `SELECT` that names no `SYSTEM$` function | no | the user's run; typing sends nothing |
| Monitoring dashboard | `SHOW` for every panel; three Information Schema reads only on a warehouse a fresh state read shows running | no; it resumes one only if the warehouse suspends between that read and the statement | opening the dashboard, which selects a connection by itself; a 60 s cache; auto-refresh off by default |
| Tree, object counts, describe, inventory, autocomplete | `SHOW`; one `SHOW TERSE OBJECTS` per schema expand | no | `resumesBilledCompute`; the user's open |
| View source of a non-view | `GET_DDL` | no | the user's click; a Source tab restored on reload or sign-in reads nothing until the user presses Read definition, or otherwise uses the connection |
| Plan mode walk | `SHOW` | no | a 10 s timer |
| Agent operations workflow | the sessions and slow-queries reads (Information Schema); `SHOW` for table stats, index stats and health | no; Information Schema is read only on a warehouse a fresh state read shows running | the model's call; the 60 s cache |
| MCP `inspect_schema` | `SHOW` | no | an operator seed with `mcp: true` |
| Test connection, Save, a connect on a cache miss | one `SHOW`, then the role check | no | the user's click |
| Role check | the `SELECT CURRENT_ROLE() ... CURRENT_WAREHOUSE()` of [section 2.5](#25-test-connection) once per connect | no | sent by every connect, after its `SHOW`; a role or token-user mismatch fails the connect, an unresolved name adds a caution |
| Health | `SHOW WAREHOUSES LIKE`, or `SHOW DATABASES LIMIT 1` with Warehouse empty | no | - |
| Connection pulse, fleet health | none | - | skipped for `resumesBilledCompute` |
| Tree refresh after DDL | `SHOW` | no | - |
| Export | none: it writes the rows the grid holds | - | - |
| Load More, inline edit, profiler, test data, maintenance | none: off in v1 | - | - |
| AI panels, history, code generation | none: text only | - | - |
| Schema diff | the inventory with columns, of the configured Database and Schema only (with no Schema, that database's schemas less `INFORMATION_SCHEMA`); with no Database the diff is refused in a sentence and shows no difference or migration for that side | no (`SHOW`) | the user's compare |
| Object search | `SHOW` per kind | no | the user's search |

A Source tab restored on a connection Studio opened by itself says, until the user acts:

`Studio restored this tab without reading the definition, because any request to this connection can resume compute that is billed while it runs.`

### 5.2 `query_tag`

Every request carries a fixed tag for its kind of work, with no user identity, so an administrator finds Studio's statements in QUERY_HISTORY: `libredb-studio:editor` (user statements, the Explain button and the background explain estimate), `libredb-studio:connect` (connect and Test connection), `libredb-studio:role-check`, `libredb-studio:tree`, `libredb-studio:describe`, `libredb-studio:inventory`, `libredb-studio:source`, `libredb-studio:health` and `libredb-studio:monitoring`.

### 5.3 Timeouts, cancel and disconnect

A statement's `timeout` is the connection's Query Timeout in whole seconds, from 1 to Snowflake's maximum of 604,800; a statement Studio sends on its own takes the smaller of 30 s and that value.
Studio polls the statement from 250 ms, doubling to 2 s, and cancels it at its deadline, 5 s past its `timeout`, so Snowflake's own timeout fires first.
Studio keeps at most 4 statements of one connection, and 8 across every Snowflake connection of the server, in flight at once; a further statement waits in a queue of at most 64, with nothing sent, and one past that is refused with the shared limiter's sentence ([section 11](#11-errors)).
Its deadline starts only when it is sent, so a statement that waited still gets its whole `timeout` on Snowflake.
The wait has its own bound of the same length (`timeout` plus 5 s); a statement still waiting when it passes is not sent and reads the slots sentence of [section 11](#11-errors), never the timeout sentence.
Every request takes a slot, Studio's own included: the background explain estimate beside a `SELECT` holds one while its `EXPLAIN` compiles, which needs no warehouse and usually answers within a second, so it can delay a run by that much but no longer shortens its timeout.
When Snowflake's own timeout fires first, it answers HTTP 408, and its message, which names the timeout that fired, is not read, so the sentence names every bound that can end the statement:

`Snowflake ended this statement at a timeout and cancelled it: the connection's query timeout of <n> s, or a lower STATEMENT_TIMEOUT_IN_SECONDS on the warehouse, the user or the account. Snowflake applies the lowest of these, so raising Query Timeout (ms) on the connection cannot lengthen a statement past the others.`

For a statement Studio sends on its own at its 30 s bound, Snowflake's 408 reads:

`Snowflake ended this Studio read at a timeout and cancelled it: the 30 s bound Studio keeps for the statements it sends on its own, or a lower STATEMENT_TIMEOUT_IN_SECONDS on the warehouse, the user or the account.`

When Studio's own deadline passes first, Studio cancels the statement and says so:

`Snowflake did not finish this statement within the connection's query timeout of <n> s, so Studio cancelled it. Raise Query Timeout (ms) on the connection to allow longer statements; saving it ends statements still running on this connection.`

A statement Studio sends on its own that passes its 30 s bound reads this instead, since raising Query Timeout does not lengthen that bound:

`Snowflake did not finish this Studio read within 30 s, the bound Studio keeps for the statements it sends on its own whatever the connection's query timeout, so Studio cancelled it.`

Stop cancels the statement by its handle, under a 5 s bound; if the cancel request fails, Snowflake's own `timeout` still ends the statement.
Deleting a connection, changing its query timeout or restarting the Studio server cancels every statement still running on it, for every user of that connection; leaving it idle does not, because Studio keeps a connection open while one of its statements runs.
Any signed-in user who sends that connection's id to Studio's disconnect route has the same effect.
A disconnect waits at most 5 s for a statement whose submit has not answered yet, so a close never hangs on Snowflake; past that bound Studio stops waiting without a handle to cancel, and a statement Snowflake accepted in that submit runs on until its own `timeout` ends it.
A statement nobody can reach any more stops billing at that moment.

## 6. Results

Snowflake answers in partitions, every request setting `client_result_chunk_size` to 16: the first arrives inline, up to 24 MiB of text, and each further one is fetched in order, gzip-decoded as a stream.
A failed partition answer is gzip-decoded the same way, under the same bound, before its error is read; one that inflates past the bound is classified by its HTTP status alone.
One budget spans a statement's whole result: 16 MiB of decoded rows and 100,000 rows.
A cut keeps the rows before it, marks the result limited, and says so:

- `The result reached Studio's statement budget of 16 MiB, so only the rows before it are shown. Snowflake reported <numRows> rows.`
  Studio asks Snowflake for at most 100,001 rows (`rows_per_resultset`), so Snowflake's count stops there; a result that reaches it ends `Snowflake reported more than 100,000 rows.` instead, since its true size is not known.
- `The first row of this result is larger than Studio's statement budget of 16 MiB, so no row is shown. Select fewer columns, or part of a large value with LEFT or SUBSTR.` The grid then reads "No row is shown: the result was cut before its first row" rather than "Query returned no data".
- `The result reached Studio's statement budget of 100,000 rows, so only the rows before it are shown.`
- `Snowflake returned only part of this result because it is too large (391908), so only the rows it sent are shown. Add a LIMIT, or select fewer columns.`

Snowflake decides the size of the first partition itself, so a wide result can send more than 24 MiB inline even with a `LIMIT` and a chunk size of 16 (measured on the trial: 4,096 rows of 10,000 characters, about 41 MB).
Studio then reads that answer again as a stream, cut at the budget plus 64 KiB: Snowflake writes `resultSetMetaData` before `data`, so the column list is read whole and the rows that fit are kept, with the 16 MiB cut sentence.
Only an answer whose column list alone does not fit in that read is refused, with the first sentence below.

A partition Studio cannot take is refused:

- `Snowflake's first result partition is larger than Studio reads (24 MiB). Add a LIMIT, or select fewer columns.`
- `Snowflake sent a result partition Studio could not read.`
- `Snowflake sent a result partition in an encoding Studio does not read (<encoding>).`
- `Snowflake sent a cell that is not text in column "<column>", so the result is not shown.`

The shared limiter appends `LIMIT 500` to a `SELECT`; a longer result shows 500 rows with no Load More.
A `SELECT` that ends in its own bound keeps it and gets none appended, and that includes Snowflake's unlimited forms `LIMIT NULL`, `LIMIT ''` and `LIMIT $$$$`, which return every row up to Studio's budget, and `OFFSET NULL`, `OFFSET ''` and `OFFSET $$$$`, which skip none.
Snowflake takes an `OFFSET` only before a `FETCH` or after a `LIMIT`, so a `SELECT` that ends in a lone `OFFSET NULL`, `OFFSET ''` or `OFFSET $$$$` is sent as written and Snowflake answers with its own `unexpected '<EOF>'`, the error its SQL API gives that text (measured on the trial on 2026-10-14); `LIMIT 500 OFFSET NULL` or `OFFSET NULL FETCH 500` is the form that runs.
A lone digit `OFFSET` still gets `LIMIT 500` appended, which Snowflake refuses as `unexpected 'LIMIT'`.
Snowflake parses the bound with the statement, so a syntax error in the user's text can be reported at it (`unexpected 'LIMIT'`, `unexpected '501'`); such an error gets the sentence of [Where the bound is placed](../editor/query-optimization.md#an-error-that-names-the-bound) after Snowflake's message.
Export writes the rows the grid shows, in the browser, and sends no statement; over a cut or limited result the export menu reads "Writes the <n> rows shown." with "The result was cut, so the file is not the whole result."
Which budget ends a large result depends on its width, measured on the trial: all 16 columns of the sample `TPCH_SF1.LINEITEM` with `LIMIT 100000` showed every one of the 100,000 rows, uncut, on 2026-10-13, while `L_ORDERKEY`, `L_LINENUMBER` and `REPEAT(L_COMMENT, 10)` with `LIMIT 200000` were cut at 16 MiB after 58,725 rows on 2026-10-14.
The first partition arrives uncompressed, because Studio's HTTP transport asks every server for an uncompressed body; later partitions arrive gzip-compressed as Snowflake stores them.
A large first partition is therefore bounded by the network: measured on 2026-10-14, one 8 MB text cell took 5.5 s to arrive uncompressed against 1.4 s compressed (36 KB), while Studio decoded and returned it in under half a second ([BACKLOG](../BACKLOG.md) D363).

| Wire type | Cell | Column type |
| --- | --- | --- |
| `fixed`, scale 0 | a number when the text is a safe integer, else the exact text | `NUMBER(p,0)` |
| `fixed`, scale above 0 | the exact text | `NUMBER(p,s)` |
| `decfloat` | the exact text | `DECFLOAT` |
| `real` | a number; `NaN`, `Infinity` and `-Infinity` as words | `FLOAT` |
| `text` | the string | `VARCHAR(n)` |
| `boolean` | `true` or `false` | `BOOLEAN` |
| `binary` | bytes | `BINARY` |
| `date` | `YYYY-MM-DD` | `DATE` |
| `time` | `HH:MM:SS[.f]` | `TIME(s)` |
| `timestamp_ntz` | `YYYY-MM-DD HH:MM:SS[.f]` | `TIMESTAMP_NTZ(s)` |
| `timestamp_ltz` | the instant at UTC, with `+00:00` | `TIMESTAMP_LTZ(s)` |
| `timestamp_tz` | the wall time at its offset, with `+HH:MM` or `-HH:MM` | `TIMESTAMP_TZ(s)` |
| `variant`, `object`, `array`, `map`, structured types | the JSON text, never parsed | the type name; an `object` with `extTypeName` `GEOGRAPHY` or `GEOMETRY` is typed by that name |
| `vector` | the JSON array text | `VECTOR`: the SQL API reports `vector` with no element type or dimension |
| `geography`, `geometry`, `uuid`, `file` and any other | the text | the reported name |

Snowflake sends every date, time and timestamp as days or seconds since the epoch, a `TIMESTAMP_TZ` with its own offset, so no cell depends on the session's `TIMEZONE`; measured on the trial on 2026-10-14, the same `SELECT` answered identical cells under UTC, `America/Los_Angeles` and `Asia/Kolkata`.
A `TIMESTAMP_LTZ` arrives as a bare instant, and the answer does not name the session's zone, so Studio shows the exact instant at UTC with `+00:00` rather than guess the zone: `'2026-06-01 12:00:00'::TIMESTAMP_LTZ` under `America/Los_Angeles` shows `2026-06-01 19:00:00.000000000+00:00`, the instant Snowsight shows as `2026-06-01 12:00:00.000 -0700`.
To see an LTZ value at the session's own offset, cast it: `ltz_col::TIMESTAMP_TZ` carries that offset (`2026-06-01 12:00:00.000000000-07:00`).

Dates and timestamps follow the proleptic Gregorian calendar with astronomical years, as Snowflake counts its days.
Snowflake stores years outside 1 to 9999, and Studio shows such a value with every digit of its year and a `-` at or before year 0, never refusing it: `10000-01-01`, and `-0002-06-01` for 3 BC, which `'-0002-06-01'::DATE` reads back to the same day.
Snowflake's own text for that date, `DATE::VARCHAR`, is `0003-06-01`, with no sign.
The SQL INSERT export writes such a cell too, never skipping its row: the `TO_*` mask reads a year of any length, so `10000-01-01` is `TO_DATE('10000-01-01', 'YYYY-MM-DD')`, but no mask or cast reads a signed timestamp year (100097, 100035), so a year before 1 is written whole 400-year eras later and moved back by their exact day count, `DATEADD(DAY, -146097, TO_DATE('0398-06-01', 'YYYY-MM-DD'))` for `-0002-06-01`; an LTZ cell is moved as a `TIMESTAMP_TZ` at `+00:00` and cast back to `TIMESTAMP_LTZ`, so the session's zone never takes part.
`DATEADD(DAY, ...)` is used because `DATEADD(YEAR, ...)` moves a February 29 to the 28th.
Replayed on the trial on 2026-10-14 under the session zones UTC and `America/Los_Angeles`, DATE, TIMESTAMP_NTZ, TIMESTAMP_LTZ and TIMESTAMP_TZ cells at years -2, -400 (February 29), -10000, 10000 and 252026 came back as the same day counts, instants and offsets.
CSV and JSON write the text.

The trial capture (section 13) reports a GEOGRAPHY, GEOMETRY, MAP or FILE column as `object` and a UUID column as `text`; a GEOGRAPHY or GEOMETRY entry also carries `extTypeName`, so a result types those two `GEOGRAPHY` and `GEOMETRY`, and MAP, FILE and UUID `OBJECT` and `VARCHAR`; describe shows the catalog's spelling from `SHOW COLUMNS`.
A CHAR(n) column is reported as `text` of length n, exactly as a VARCHAR(n) is, so a result types it `VARCHAR(n)`: Snowflake stores CHAR as VARCHAR, and both hold the same values.

A cell whose text does not match its type is refused with the column name, never shown as a wrong value:

- `Snowflake sent a <type> value in column "<column>" that Studio could not read, so the result is not shown.`
- `Snowflake sent a result whose column list Studio could not read.`

The SQL INSERT export writes semi-structured, structured and vector cells as `INSERT ... SELECT` rows through `PARSE_JSON`, and dates and timestamps through `TO_DATE`, `TO_TIME` and `TO_TIMESTAMP_*` with an explicit format.
A vector column carries no dimension in the result, so each vector cell is cast to `VECTOR(<element>, <n>)`, `<n>` being the number of elements in the cell and the element `FLOAT` when any element has a decimal point, an exponent or a non-finite word, else `INT`.
A FLOAT NaN or infinity is written as `'NaN'::FLOAT`, `'inf'::FLOAT` or `'-inf'::FLOAT`.
The DDL (CREATE TABLE) export declares a VECTOR column as the `VECTOR(<element>, <n>)` its first non-null cell spells, by the same rule, since `VECTOR` alone is a syntax error (001003); a VECTOR column with no such cell in the export is declared `ARRAY`, which holds the NULLs the file inserts.
A GEOGRAPHY or GEOMETRY cell is written as its quoted text, which Snowflake casts to the column's type on insert.
A DECFLOAT cell is written as its exact text quoted and cast, `'1.23e40'::DECFLOAT`, never as a bare number: Snowflake reads a bare numeric literal as NUMBER or FLOAT first, and a replay on 2026-10-14 changed `1.23e40` to `1.22999999999999995e40`, stored `-4.2e-5432` as 0 and refused `1e16384`, while the quoted form came back exactly.
A structured OBJECT, ARRAY or MAP column is reported as `object` or `array`, as a semi-structured one is, so its cells are written as semi-structured values, which a structured column refuses with `incompatible types` (001010).
Replayed on the trial on 2026-10-13, the export of the capture's every-type table came back cell for cell into a copy whose structured columns were semi-structured, vector and FLOAT infinities included, except DECFLOAT, which came back exactly once it was written in the quoted form above.

## 7. The tree

Databases are listed with `SHOW DATABASES` and schemas with `SHOW SCHEMAS IN DATABASE`; the configured database opens first.
The configured schema is marked as the session's only inside the configured database, since every database holds its own `PUBLIC`; with no Database set, no schema is marked.
A kind's `SHOW` is sent only when the user opens that kind:

| Kind | Statement |
| --- | --- |
| Tables | `SHOW TABLES IN SCHEMA`; dynamic, external, Iceberg, hybrid and event tables are listed here with their flags |
| Views | `SHOW VIEWS IN SCHEMA`; materialized and secure views carry their flags |
| Streams | `SHOW STREAMS IN SCHEMA` |
| Tasks | `SHOW TASKS IN SCHEMA` |
| Sequences | `SHOW SEQUENCES IN SCHEMA` |
| Stages | `SHOW STAGES IN SCHEMA`; no stage browsing and no definition in v1 |
| File formats | `SHOW FILE FORMATS IN SCHEMA` |
| Pipes | `SHOW PIPES IN SCHEMA` |
| Functions | `SHOW USER FUNCTIONS IN SCHEMA`, so built-ins are not listed |
| Procedures | `SHOW PROCEDURES IN SCHEMA`, less the built-in rows (`is_builtin` `Y`) it also answers |

A schema expand sends one `SHOW TERSE OBJECTS IN SCHEMA ... LIMIT 10000` to count its tables and views.
On the trial on 2026-10-13, over 10,250 tables in one scratch schema and 10,250 sequences in another, `SHOW TABLES` and `SHOW TERSE OBJECTS` without a `LIMIT` answered all 10,250 rows, with no error and no 10,000-row ceiling.
Studio still sends `LIMIT 10000` wherever Snowflake offers paging, so each answer stays bounded:

- A pageable listing (databases, schemas, tables, views, streams, tasks) is read in pages of 10,000 rows, each from the previous page's last name with `FROM`, which starts after the name it is given (a page with nothing past that name ends the listing), up to five pages: `Snowflake has more than 50,000 objects of this kind here; Studio shows the first 50,000 by name.`
- Any other listing has no paging and is sent with no `LIMIT`: `SHOW SEQUENCES` answered all 10,250 rows with and without `LIMIT` and `FROM`, since it ignores both, and the 10,000 rows Snowflake's reference gives as the most the other listings answer is not measured.
- When the `SHOW TERSE OBJECTS` answer reaches 10,000 rows, Studio's own `LIMIT`, both the table and the view count carry: `Studio counts at most 10,000 objects here, so this is a floor.`

The tree has no place for a listing's sentence, so it shows the first 50,000 objects of a pageable kind without one; the object inventory, which the agent and the inventory route read, reads at most 5,000 objects, so it stops at its own `inventory limit reached` before that cap.

The object inventory reads a schema's columns with one `SHOW COLUMNS IN SCHEMA`; when that answers a full 10,000 rows it reads them one object at a time instead, for at most the first 1,000 objects: `Snowflake answered a full 10,000-row column listing for this schema, so Studio read the columns of the first 1,000 objects one at a time`.
Describe reads `SHOW COLUMNS IN TABLE` (or `IN VIEW`); a table also reads `SHOW PRIMARY KEYS` and `SHOW TABLES LIKE`, and a hybrid table `SHOW INDEXES`; a primary key column is shown as a key with no further mark, although Snowflake does not enforce primary keys on standard tables; indexes exist only on hybrid tables.
Studio draws no foreign keys, so the ER diagram shows tables without relations.
A view's source comes from `SHOW VIEWS`; a stage has none; every other kind's comes from `SELECT GET_DDL(...)`, which needs no running warehouse.
A secure view the role does not own shows `Snowflake hides a secure view's definition from roles that do not own it.`
Every statement Studio writes quotes each name with `"`, so a lower-case catalog name always round-trips.

## 8. Features

### 8.1 Explain

The Explain button sends `EXPLAIN USING JSON <statement>`, which compiles the statement without running it and needs no warehouse, and renders the plan's partition and byte totals and its operations tree.
Snowflake has no executing `EXPLAIN`, so the button's analyze request gets the same form.
The background estimate beside each run of a single `SELECT` sends the same `EXPLAIN USING JSON`, with the same declines, and needs no running warehouse either; typing in the editor sends nothing.
Compiling is not inert for a `SYSTEM$` function: Snowflake evaluates it while it explains the statement, measured on the trial (Snowflake 10.37.100), where `EXPLAIN USING JSON SELECT SYSTEM$WAIT(5)` took 6.5 s and an Explain of `SELECT SYSTEM$CANCEL_QUERY('<id>')` cancelled the other statement.
So a statement whose code names a `SYSTEM$` function (the confirmation gate's code forms, [section 9](#9-the-confirmation-gate)) is never explained: the Explain button says `Snowflake runs a SYSTEM$ function while it explains a statement, so Studio does not explain one. Run it instead; the confirmation gate asks first.`, and a run of one sends no background estimate, so a confirmed call runs once.
A call, dynamic SQL, a Scripting block or an anonymous procedure is declined before that check: `Snowflake explains a query only; this statement calls a procedure, runs dynamic SQL or opens a Scripting block.`

### 8.2 Monitoring

Overview, table stats, index stats and health send only `SHOW`.
The Overview reads the warehouse row (`SHOW WAREHOUSES LIKE`), `SHOW DATABASES`, `SHOW TERSE TABLES` and `SHOW INDEXES`, the last two in the configured database, or in the account when Database is empty.
Its Tables card is that table count (from 10,000, Studio's `LIMIT`, it reads `10,000+`, "counted from the first 10,000 tables Snowflake listed in database <db>"), and its index count is the hybrid-table indexes `SHOW INDEXES` lists.
The warehouse's running and queued counts are shown only while it is `STARTED` or `RESIZING`, as `<n> running and <m> queued, Studio's own reads included`: Snowflake counts every statement that names the warehouse, Studio's own `SHOW` reads too, and measured on the trial it reported `running 3` for a `SUSPENDED` warehouse while three `SHOW COLUMNS` named it, so a suspended warehouse shows its state and size alone.
Performance, slow queries and running statements read Information Schema, and each read that misses the cache first sends a fresh `SHOW WAREHOUSES LIKE` and reads only when the warehouse is running; otherwise the panel reads `Warehouse <wh> is suspended, and Studio does not start it to fill this panel. Run a query, then Refresh.`
A warehouse that suspends in the moment between that state read and the Information Schema statement is resumed once by the statement.
Information Schema reads are cached for 60 s.
Auto-refresh is off until the user starts it, as on every engine, and since `resumesBilledCompute` is declared, the toggle carries `Each refresh runs statements on this connection, which keeps its billed compute running.`

- With Warehouse empty: `Set Warehouse on the connection to see its load and queries.`
- A warehouse the role cannot see: `Snowflake shows no warehouse named <wh> to role <role>. Check the name, and that the role has USAGE on it.`
- Performance without the grant: `Needs MONITOR on warehouse <wh> or MONITOR USAGE.`
- Slow queries without the grant: `Without MONITOR or OPERATE on the warehouse, Snowflake shows only this user's queries.`
- Running statements: `Snowflake exposes no live session list here; these are running statements.`
- Index stats: `Snowflake has indexes only on hybrid tables; this schema has none.`
- Storage is not offered: `Snowflake storage needs ACCOUNTADMIN; Studio does not read it.`

### 8.3 Plan mode and agent operations

Plan mode grounds through `SHOW` only, under its 10 s timer, and drafts SQL without running it; the draft reaches the editor, where the gate applies.
With a Schema set, it reads that schema alone.
With a Database set and no Schema, Snowflake's session has no current schema, so it reads that database's schemas in listing order, leaving out `INFORMATION_SCHEMA`, within the same timer and the walk's limits.
With neither, it reads no schema.
In each case the inventory tells the model how many schemas it did not read and names the ones it did.
The agent operations workflow is offered and reads through the monitoring panels' gate.
A Role edit makes a new connection identity, so a plan held under one role is not validated under another.

### 8.4 MCP

An operator-seeded connection with `mcp: true` is offered to `list_connections` and `inspect_schema`, which send only `SHOW`.
`run_read_query` is refused, because the provider has no read-only enforcement.

### 8.5 Off in v1

| Feature | Reason |
| --- | --- |
| Load More | Each page re-runs the statement on the warehouse, billed at least 60 s when it resumes, and pages without ORDER BY can repeat or drop rows |
| Inline row edit | An apply would be several warehouse statements and as many separate commits |
| Column profiler | Up to 20 full-column scans per click, which cannot be cancelled |
| Object edit | DDL commits implicitly and `ALTER COLUMN` is limited, so no kind is editable |
| Create table | The provider declares no create-table (it declares no `createTable`; the Create Table form has no Snowflake grammar), so neither the explorer nor the tree offers Create Table; write the `CREATE TABLE` in the editor |
| Data import | No kind accepts row writes and there is no create-table, so the import dialog opens on `Studio's import has no target on this connection: it offers no existing table here to write into and cannot create one.` |
| Test data generation | It writes on the warehouse |
| Transactions | No transaction spans two requests ([section 4](#4-sessions-transactions-and-blocks)) |
| Maintenance | A kill would cancel other users' queries the role can see, an account-level action from a shared connection |
| Agent execute mode, MCP `run_read_query` | Studio has no engine-side read-only boundary for Snowflake |

### 8.6 Object edit (#789): not in this version

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: object edit is not implemented in this version.
Snowflake commits every DDL statement implicitly, so an edit spanning several statements could not be rolled back, and `ALTER COLUMN` changes only a narrow set of column properties, so most designer edits would need a table rebuild.
Snowflake also enforces no primary key on a standard table, so a row edit would have no row identity.
The absence is `snowflake`'s entry in `EXPECTED_EDIT_ABSTAINERS` (`tests/helpers/object-edit-expectation.ts`), and `tests/isolated/object-edit-declarations.test.ts` holds that entry and this section together.

### 8.7 Editor

Format uses sql-formatter's Snowflake language (the grammar's `formatterLanguage`), so `QUALIFY` stays a clause on its own line; text that language cannot read, such as a `@stage` reference, is left as written.
Completion offers Snowflake's own clauses and functions (the grammar's `completionWords`, among them `QUALIFY`, `ARRAY_AGG`, `PARSE_JSON`, `FLATTEN`, `CURRENT_ROLE` and `CURRENT_WAREHOUSE`) beside the shared SQL lists, a function inserted as a call; no `SYSTEM$` function is offered.

### 8.8 SQL writing

[`snowflake/sql-writing.ts`](../../src/lib/db/providers/sql/snowflake/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalDoubleAndBackslash` and read back by `unquoteDoubleAndBackslash`: the quote is doubled and a backslash escapes, so the backslash is doubled first.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
Snowflake reads both escapes in a single-quoted string constant: a doubled quote is one quote, and a backslash escapes the next character, so it is doubled first, as Databend's is.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field spells a result export's column types through `ddlTypes`, the standard spelling with `FLOAT` for a float and `BINARY` for a binary column, since Snowflake has no BLOB; provisional until a replay on an account.
No Snowflake account read a probe column back, so it holds `NOTHING_STANDS_ALONE` and every bare name is re-spelled portably until one does.
A binary cell is written by `binaryStandardHex`, which Snowflake reads as a BINARY constant; not yet measured on an account.
`nonFinite` writes `'NaN'::FLOAT`, `'inf'::FLOAT` and `'-inf'::FLOAT`: Snowflake's trial setup (2026-10-12) created its FLOAT infinities with the last two, and the first is the same documented form.
`insertForm` is `"select"`: Snowflake's `INSERT ... VALUES` refuses `PARSE_JSON`, which its semi-structured cells are written with, so every Snowflake row takes the `INSERT ... SELECT` form; provisional until a replay on an account confirms it.
`declareFromSample` declares a VECTOR column from its first value: Snowflake reports a VECTOR result column as `vector` with no element type and no dimension, and `CREATE TABLE t (v VECTOR)` is a syntax error (001003).
`typedLiteral` writes the semi-structured, structured, VECTOR and temporal cells, from the engine's own [`snowflake/typed-literals.ts`](../../src/lib/db/providers/sql/snowflake/typed-literals.ts).
`NO_BARE_SPELLING` completes it.

## 9. The confirmation gate

The gate is a browser confirmation, not a boundary: it asks before a statement runs from the editor, and the role decides what can happen.
On top of the shared destructive keywords, `MERGE` among them, it asks for these Snowflake forms, at the top level and inside a block.
Forms that replace, overwrite, unload or delete: `CREATE OR REPLACE`, `CREATE OR ALTER` (which drops the columns its new definition leaves out), `INSERT OVERWRITE`, `COPY`, `REMOVE` and `RM`.
Forms that run text or work the gate cannot read: `EXECUTE IMMEDIATE`, `EXECUTE TASK`, `EXECUTE ALERT`, `EXECUTE NOTEBOOK`, `EXECUTE JOB SERVICE`, `EXECUTE DBT PROJECT` and `CALL`.
Forms that spend credits on their own, once or on a schedule: `CREATE WAREHOUSE`, `CREATE TASK`, `CREATE ALERT`, `CREATE COMPUTE POOL`, `CREATE SERVICE`, `CREATE DYNAMIC TABLE`, `CREATE TRANSIENT DYNAMIC TABLE`, `CREATE MATERIALIZED VIEW`, `CREATE SECURE MATERIALIZED VIEW`, `CREATE PIPE`, `CREATE DYNAMIC ICEBERG TABLE` and `CREATE CORTEX SEARCH SERVICE`.
Forms that change who gets in or what leaves the account: `CREATE USER`, `CREATE ROLE`, `CREATE NETWORK POLICY`, `CREATE NETWORK RULE`, `CREATE EXTERNAL ACCESS INTEGRATION`, `CREATE API INTEGRATION`, `CREATE SECURITY INTEGRATION`, `CREATE NOTIFICATION INTEGRATION`, `CREATE STORAGE INTEGRATION`, `CREATE SHARE`, `CREATE REPLICATION GROUP` and `CREATE FAILOVER GROUP`.
Forms that create a billed account: `CREATE ACCOUNT` and `CREATE MANAGED ACCOUNT`.
An external stage, which reads and writes files outside the account, asks when its code names a `URL`: `CREATE STAGE ... URL`, `CREATE TEMPORARY STAGE ... URL` and `CREATE TEMP STAGE ... URL`; an internal stage, with no URL, keeps its files in the account and runs unconfirmed.
The shared `ALTER` keyword asks for every Snowflake `ALTER` but `ALTER SESSION SET` and `ALTER SESSION UNSET`, whose setting cannot outlive the statement's own session ([section 4](#4-sessions-transactions-and-blocks)); `ALTER SESSION POLICY` still asks, since a session policy is an account object, and on every other engine `ALTER SESSION` still asks.
It also asks wherever `AS PROCEDURE` (an anonymous procedure) or an identifier starting `SYSTEM$` appears in a statement's code, a quoted `"SYSTEM$..."` name included when it is called as a function.
Still unconfirmed: every Snowflake form not named above, among them `CREATE CATALOG INTEGRATION`, `CREATE EXTERNAL VOLUME` and `CREATE LISTING`; a statement whose effect hides behind an `IDENTIFIER()` target; and whatever a procedure created earlier does when a statement that does not name it reaches it.

## 10. Security

- Secrets of a connection a user creates are kept in browser storage, and `GET /api/storage` returns them to their owner ([STORAGE.md](../STORAGE.md)); keep an operator-seeded connection `managed: true` so its key stays on the server.
- In browser storage the private key, its passphrase and the access token are kept in the clear in the same connection object, as every other engine's password is; the passphrase is stored beside the key it unlocks, so the key's encryption does not protect it from anyone who can read that storage. The `sqlite` and `postgres` storage providers encrypt all three at rest on the server ([STORAGE.md](../STORAGE.md#credential-encryption-at-rest)).
- The dialog draws a key as text only while its box has focus or after Show key: a pasted key is hidden at once, a typed one when the box is left, and a saved one is not drawn when the connection is opened with Edit; Replace key empties the box for a new key.
- Studio reads no key file; the key's text is parsed once at connect, and no field the provider owns keeps the key text or its passphrase: it keeps the key object and its fingerprint, while the connection object passed in still holds both.
- Statement text, secrets in it included, is kept in the query history and sent to the AI safety check, as on every SQL engine.
- A PAT created in the editor with `ALTER USER ... ADD PAT` appears once in the grid, as Snowflake returns it; Studio keeps no copy beyond that result.
- A pasted string is read in the browser and never kept ([section 2.6](#26-paste-url)).
- TLS is fixed: the certificate is checked against the runtime's CA store with the account host as its name, and there is no SSL panel, no SSH tunnel and no HTTP proxy, so a proxy-only network cannot reach Snowflake.
- Studio sends nothing to any host but the account host: not `app.snowflake.com`, an OCSP server, a stage or a cloud metadata address.
- PrivateLink names resolve to private addresses, so with `DB_HTTP_BLOCK_PRIVATE_HOSTS=true` every PrivateLink connection is refused before any socket.
- Server text reaches a sentence only after every secret form (the token, the passphrase and every JWT in use) is withheld, and is cut at 2,000 characters.

## 11. Errors

| Case | Class | Studio's sentence |
| --- | --- | --- |
| Key pair refused (390144) | `AuthenticationError`, with the administrator's registration statement to copy, `ALTER USER <name> ADD KEY PAIR libredb_studio_<fp8> PUBLIC_KEY = '<body>'`, which the dialog shows under the sentence | `Snowflake refused the key pair (JWT token is invalid, [<uuid>]) for <ACCOUNT>.<USER>: no user has this login name, or the key whose fingerprint is SHA256:<fp> is not registered on it. Check User; an administrator registers the key with ALTER USER <name> ADD KEY PAIR, where <name> is the user's NAME from SHOW USERS, and Test connection shows the full statement to copy. If the key is registered, check the account and this computer's clock; an administrator can see the exact cause with SELECT SYSTEM$GET_LOGIN_FAILURE_DETAILS('<uuid>').` |
| Key pair refused while a statement ran | `AuthenticationError` | `Snowflake stopped accepting Studio's key-pair token while this statement ran (<code>). The statement may still be running; Studio could not read or cancel it.` |
| A key-pair connection with no key | `DatabaseError` | `Studio has no public key to name for this key-pair connection. This is a Studio defect; please report it.` |
| Token refused | `AuthenticationError` | `Snowflake did not accept the access token: check that it is complete and has not expired or been revoked. A token also signs in only for a user under a network policy that allows the public address Studio connects from, which on a laptop changes with the network, or under an authentication policy that sets PAT_POLICY NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED. Key-pair sign-in avoids the network-policy requirement.` |
| Network policy refuses the address (390422 at HTTP 401, for a key pair or a token; Snowflake's message names the address and is not shown) | `AuthenticationError` | `A network policy on the Snowflake account or on this user does not allow the address Studio connects from. An administrator adds that address to the policy's allowed list.` |
| Token for a user under no network policy (390432 at HTTP 401; on the trial the authentication policy named let the token sign in) | `AuthenticationError` | `Snowflake signs in with an access token only for a user under a network policy, and this user has none. An administrator either attaches a network policy that allows the address Studio connects from, or sets an authentication policy with PAT_POLICY = (NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED).` |
| Role refused for a token (390186 under token sign-in: a token restricted to another role, or a role not granted) | `AuthenticationError` | `Snowflake refused role <role> for this access token: the token may be restricted to another role, since a token generated with a role restriction signs in only as that role, or role <role> is not granted to user <user>. Set Role to the token's role, which SHOW USER PROGRAMMATIC ACCESS TOKENS lists under role_restriction, or use a token restricted to <role>.` |
| Role refused (390186 at HTTP 400 under key pair, as Snowflake answers; 390189 and 3013, as documented) | `AuthenticationError` | `Snowflake refused role <role> for user <user>: the role does not exist, it is not granted to this user, or the key pair or access token is restricted to another role. Check the Role field; an administrator grants it with GRANT ROLE <role> TO USER <user>.` |
| Token of another user (token sign-in, `CURRENT_USER()` is not User) | `AuthenticationError` | `Snowflake signed this access token in as user <u>, not <user>. A token signs in only as the user it belongs to: enter <u> in User, or paste a token of user <user>.` |
| Role mismatch | `AuthenticationError` | `Snowflake ran this connection as role <r>, not <role>. Check the Role field; a role-restricted key or token signs in only as its own role.` |
| Warehouse set but not usable (000606 or 391920 with Warehouse filled: a misspelt name, no USAGE, a name in another case) | `QueryError` | `Snowflake could not use warehouse <wh> for this statement: it does not exist, role <role> has no USAGE on it, or its name differs in case. Check Warehouse in the connection settings. Browsing works without a warehouse; queries do not.` |
| No warehouse (000606, as documented; 391920, as Snowflake answers a role that can use no warehouse; Warehouse empty) | `QueryError` | `No warehouse is selected for this connection. Enter one in the connection settings, or ask an administrator to set DEFAULT_WAREHOUSE on the user. Browsing works without one; queries do not.` |
| Object missing or hidden (002003) | `QueryError` | `Snowflake says this object does not exist or role <role> may not see it. Check the name, the database and schema, and the role; CALL EXPLAIN_PRIVILEGES(statement => '<statement>', missing_only => true) lists what is missing, and an administrator adds for_role => '<role>'.`, then the server text |
| Insufficient privileges (003001) | `QueryError` | `Role <role> lacks a privilege this statement needs.`, then the server text |
| API disabled or network policy (403) | `AuthenticationError` | `Snowflake refused the request (403): the SQL API may not be enabled for this account, or a network policy blocks the address Studio connects from.` |
| A command the SQL API does not run (391911) | `QueryError` | `Snowflake's SQL API does not run this command.`, then the server text |
| Any other refusal (422 among them) | `QueryError` | `Snowflake: <message> (code <code>, SQLSTATE <sqlstate>)`, without the parts Snowflake did not send |
| A refusal with no message | `QueryError` | `Snowflake refused the request (HTTP <n>, code <code>) and sent no message.`, without the code when there is none |
| Headers too large (431, the gateway's answer to an oversized token header) | `AuthenticationError` | `Snowflake's gateway refused the request because its headers are too large (431). The access token is the one header Studio fills from a field: paste the token alone.` |
| Token not readable (390146, under token sign-in) | `AuthenticationError` | `Snowflake found no usable token in the request (390146). Paste the access token alone, without a Bearer prefix or anything around it.` |
| Snowflake's 408 | `QueryError` | `Snowflake ended this statement at a timeout and cancelled it: the connection's query timeout of <n> s, or a lower STATEMENT_TIMEOUT_IN_SECONDS on the warehouse, the user or the account. Snowflake applies the lowest of these, so raising Query Timeout (ms) on the connection cannot lengthen a statement past the others.` |
| Snowflake's 408 of a statement Studio sent on its own at its 30 s bound | `QueryError` | `Snowflake ended this Studio read at a timeout and cancelled it: the 30 s bound Studio keeps for the statements it sends on its own, or a lower STATEMENT_TIMEOUT_IN_SECONDS on the warehouse, the user or the account.` |
| Studio's deadline | `QueryError` | `Snowflake did not finish this statement within the connection's query timeout of <n> s, so Studio cancelled it. Raise Query Timeout (ms) on the connection to allow longer statements; saving it ends statements still running on this connection.` |
| Studio's deadline of a statement Studio sent on its own at its 30 s bound | `QueryError` | `Snowflake did not finish this Studio read within 30 s, the bound Studio keeps for the statements it sends on its own whatever the connection's query timeout, so Studio cancelled it.` |
| Stop | `QueryCancelledError` | `The query was cancelled.` |
| Rate limit after retries (429) | `ConnectionError` | `Snowflake is limiting requests from this account (429). Try again in a moment.` |
| Server unavailable after retries (500, 502, 503, 504) | `ConnectionError` | `Snowflake did not answer this request (HTTP <n>) after <attempts> attempts.` |
| Certificate refused by Snowflake (522) | `ConnectionError` | `Snowflake refused the TLS certificate of this request (522). Studio sends no client certificate, so a proxy or gateway between Studio and Snowflake may be presenting one.` |
| Result gone (404 on the status or partition GET of a statement Snowflake accepted) | `QueryError` | `Snowflake no longer holds this statement's result; run it again.` |
| Account not found (404 on the first submit: `*.snowflakecomputing.com` resolves for any name, and the load balancer answers an account it does not have with a `File not Found` page) | `ConnectionError` | `Snowflake has no account at <host> (HTTP 404 on the first request). Check the account identifier: an organisation account is written orgname-account_name, with a hyphen after the organisation, and a locator outside AWS Oregon needs its region.` |
| Invalid payload (390142) | `DatabaseError` | `Snowflake could not read the request Studio sent (390142). This is a Studio defect; please report it.` |
| No answer to the connect statement or the role check within their bound (the statement's `timeout` plus 5 s; Test connection sends them under 10 s, so it gives up after 15 s) | `ConnectionError` | `Studio gave up connecting to <host> after <n> s with no answer. Check the account identifier and the network path to Snowflake; a locator outside AWS Oregon needs its region, and a PrivateLink name resolves only inside its private network.` |
| Host unreachable | `ConnectionError` | `Studio could not reach <host>. Check the account identifier; a locator outside AWS Oregon needs its region.` |
| Certificate mismatch | `ConnectionError` | `The certificate <host> presented does not match its name. Check the account identifier, including the region for a locator.` |
| Statement slots busy | `ConnectionError` | `Studio's Snowflake statement slots stayed busy for <n> seconds, so nothing was sent. Try again when a running statement finishes.` |
| Bare Scripting block (422, code 001003, a statement opening with `BEGIN` or `DECLARE`) | `QueryError` | `Snowflake: <message> (code 001003, SQLSTATE <sqlstate>)`, then `A Snowflake Scripting block runs through the SQL API only inside EXECUTE IMMEDIATE $$ ... $$.` |
| No usable statement handle | `DatabaseError` | `Snowflake answered without a statement handle Studio can use.` |
| A link outside the account's statements | `DatabaseError` | `Snowflake answered with a link outside this account's statements, so Studio did not follow it.` |
| Lone transaction, `USE`, result partitions, key and field checks | as above | the sentences of sections 2, 4 and 6 |

A data movement policy refusal answers HTTP 422 with code 001003, the code a syntax error answers, and `Data movement policy triggered. Contact your administrator for details.`, so Studio shows Snowflake's text.

Every request sends the User-Agent `LibreDB-Studio/<version>`, or `LibreDB-Studio` in the embedded package, whose build injects no version, unless the host sets `NEXT_PUBLIC_APP_VERSION`.
A submit answered 429, 500, 502, 503 or 504 is resent with the same request id and `retry=true`, so Snowflake never runs it twice, after a backoff from 500 ms doubling to 8 s, at most 5 sends; 401, 403, 404, 422 and 522 are never retried.
Studio holds 4 statements per connection, 8 across all Snowflake connections of the Studio process, and a queue of 64 shared by them, from the submit to the last partition, which bounds the memory results take; a full queue refuses with the shared limiter's sentence.

## 12. Embedded package

A host that embeds Studio renders the exported `ConnectionModal`, whose `onTestConnection` adapter may return `fixStatement` (the registration statement the dialog shows with a copy button); a `warnings` array it adds (the Test connection cautions of [section 2.5](#25-test-connection)) is shown too, though the exported prop type does not declare it.
`WorkspaceProps.onTestConnection` takes a fixed set of fields that has none of Snowflake's, so a host tests a Snowflake connection through `ConnectionModal`.
The embedded package mounts no route, so a host that runs statements from its own backend must call `cancelQuery` itself when its user stops or leaves; until it does, an abandoned statement runs until its `timeout`.

## 13. Evidence

The unit tests under `tests/unit/db/snowflake/` drive every module through its seams, and `tests/integration/db/snowflake-provider.test.ts` runs the real provider over an injected transport.
Its payloads are a capture: `tests/fixtures/snowflake/trial-2026-10-12-v10.37.100/` is what a trial account answered on 2026-10-12, Snowflake 10.37.100, Enterprise edition, on AWS, and the integration test replays its scenarios.
The capture account is named here only by placeholder (`<account>`, the setup of [section 3](#3-the-recommended-snowflake-setup) under its own names), and Snowflake releases weekly, so a capture's `CURRENT_VERSION()` and date describe that capture, not a pinned version.
To repeat the capture, run `tests/live/snowflake-evidence.ts --scenarios --step 1,2,3,4,5` by hand against such an account, with the operator's env file of the variables `tests/fixtures/snowflake/README.md` lists loaded; nothing in CI sends a request to Snowflake.
What the capture could not ask, such as a 403 from an address a network policy refuses, is built by the test that needs it and labelled BUILT there; the README lists those cases and the items still answered by hand.

### References

- SQL API v2: https://docs.snowflake.com/en/developer-guide/sql-api/index
- Key-pair authentication: https://docs.snowflake.com/en/user-guide/key-pair-auth
- Programmatic access tokens: https://docs.snowflake.com/en/user-guide/programmatic-access-tokens
- Account identifiers: https://docs.snowflake.com/en/user-guide/admin-account-identifier
- Warehouse billing: https://docs.snowflake.com/en/user-guide/cost-understanding-compute

## Migration DDL

[`SNOWFLAKE_MIGRATION_DDL`](../../src/lib/db/providers/sql/snowflake/migration-ddl.ts) is what the schema-diff migration generator writes for `snowflake`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
A Snowflake DDL statement commits the open transaction, and each SQL API statement runs in its own session, so `transactionWrapper` is `null` (#284).
A type change is spelled `SET DATA TYPE`, and `ALTER COLUMN` sets a default only to a sequence's `NEXTVAL`, so any other default change is a comment while dropping one is plain.
Index changes are a comment, because Snowflake has indexes only on hybrid tables.
The fields it takes unchanged from `src/lib/db/migration-ddl/shared.ts` are `standardAddColumn`, `standardAddForeignKey`, `standardColumnDef`, `standardCreateTableForeignKey`, `standardDropColumn`, `standardDropForeignKey`, `standardDropTable` and `standardPrimaryKey`.

Every refusal reason it can print, verbatim:

- "Snowflake: Cannot generate index DDL. Snowflake has indexes only on hybrid tables; write the index change by hand."
- "ALTER COLUMN sets a default only to a sequence's NEXTVAL; recreate the column with its default."
