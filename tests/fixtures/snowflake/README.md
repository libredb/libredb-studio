# Snowflake fixtures

What the Snowflake SQL API v2 answers, one scenario per file, replayed by `tests/integration/db/snowflake-provider.test.ts` through the provider's `deps` seam.
No test here reaches a Snowflake account.

## The capture

`trial-2026-10-12-v10.37.100/` is what a Snowflake trial account answered on 2026-10-12, recorded by `tests/live/snowflake-evidence.ts` and scrubbed before it was written.
The trial account is named here only as `<account>`.
Its `manifest.json` records the cloud (`AWS`), the region (`EU_CENTRAL_2`), `CURRENT_VERSION()` (`10.37.100`), the edition (`Enterprise`), the capture date (`2026-10-12`), the Studio commit the harness ran from (`cce47e3b9`), the files that commit did not hold (`uncommitted`, none), and `results`, each item and scenario with its duration and its exchange count.
Snowflake releases weekly, so 10.37.100 is the version this capture saw, not a pin.
`tests/unit/db/snowflake/fixture-manifest.test.ts` fails on any set whose manifest lacks one of those fields or says `"provisional": true`.

Each scenario file holds `scenario`, the `connection` it was answered for (user, sign-in method, role, warehouse, database and schema, never a credential), and `exchanges` in order, each the request the provider builds (method, path with its query, allow-listed headers, body) and the answer (status, allow-listed headers, body), with the field names the scrub dropped.
A scenario the provider stops at a refusal also holds `stopped`: the statement it stopped at, counted from 0, its SQL, and the reason.
A body that is not JSON, such as a gateway's HTML page, is kept as `{"text": ...}`.
A partition answer is kept decoded, with the `content-encoding` it was sent with; the replay compresses it again.

## The scenarios

The requests of each are `SNOWFLAKE_EVIDENCE_SCENARIOS` in `tests/live/snowflake-evidence-plan.ts`, the requests the provider sends.
The provider runs the role check, `SELECT CURRENT_ROLE() AS r, CURRENT_SECONDARY_ROLES() AS s`, inside `connect()`, right after the connect `SHOW`, because M100 measured that it needs no running warehouse and resumes none.
So every scenario starts with the connect `SHOW` (`SHOW WAREHOUSES LIKE`, or `SHOW DATABASES LIMIT 1` with no warehouse) and then the role check, before anything else.
The harness stops a scenario at its first answer that is not 200, or at a role check answering another role, as the provider does.

| Scenario | Principal | What it shows |
|---|---|---|
| `connect-keypair` | `studio_svc` | `connect()` with a key-pair JWT: the connect `SHOW` and the role check, each answered `333334` and then on the status GET, no secondary role active |
| `connect-pat` | `studio_pat` | The same over a programmatic access token restricted to `STUDIO_RO` |
| `connect-no-warehouse` | `studio_reader` | A browse-only connection with no warehouse field: `SHOW DATABASES LIMIT 1` and the role check both answer, and the role check names `STUDIO_NOWH` as an active secondary role |
| `refusal-390144` | `studio_reader` | A key no user holds: the connect submit refused at HTTP 401 with `390144`, "JWT token is invalid. null", no login-failure id |
| `refusal-390186` | `studio_svc` | A role the user does not hold (`STUDIO_NOWH`): the connect submit refused at HTTP 400 with `390186`, as M18 measured |
| `refusal-002003` | `studio_reader` | An object that does not exist or the role may not see, 422 on the status GET |
| `refusal-003001` | `studio_reader` | An `INSERT` the role lacks the privilege for, 422 on the status GET |
| `refusal-422` | `studio_reader` | A syntax error, `001003` at 422 |
| `tree-show` | `studio_reader` | The tree: databases, one database's schemas, and each kind's `SHOW` in `studio_demo.probe`, where `SHOW PROCEDURES IN SCHEMA` also answers 33 built-in procedures |
| `describe-columns` | `studio_reader` | `SHOW COLUMNS`, `SHOW PRIMARY KEYS` (no row) and the `SHOW TABLES LIKE` row of `every_type` |
| `partitions` | `studio_svc` | `SELECT ID, PAD FROM STUDIO_DEMO.PROBE.BIG ORDER BY ID LIMIT 8200`: 8,192 rows inline and 8 in partition 1, fetched gzipped |
| `every-type` | `studio_svc` | All 26 columns of `every_type` and its 5 rows |
| `cancel` | `studio_svc` | `SELECT SYSTEM$WAIT(120)`, its status still `333334`, and its cancel answered `000604` |
| `role-check-match` | `studio_svc` | The role check answering the configured role, then `SELECT 1 AS N` |
| `monitoring-started` | `studio_svc` | A monitoring panel: the fresh state read, then the Information Schema count, polled once at `333334` |
| `monitoring-suspended` | `studio_svc` | The panel's state read alone; the warehouse was still running from the scenario before it, so it reads `STARTED` |
| `monitoring-started-without-monitor` | `studio_reader` | `monitoring-started` under `studio_ro`, which holds no MONITOR on the warehouse |
| `monitoring-suspended-without-monitor` | `studio_reader` | `monitoring-suspended` under `studio_ro`, also read `STARTED` |
| `role-restricted-pat-show` | `studio_pat` | The PAT restricted to `STUDIO_RO` on a connection configured with `STUDIO_NOWH`: refused at connect with `390186`, so the `SHOW` after it is never sent |

A three-partition result of `big` needs over 49,152 rows, since the second partition holds up to 40,960, which is too large to commit.

## The measurement items

The other 53 files are the measurement items of `SNOWFLAKE_EVIDENCE_PLAN`, each with `item`, `step`, `asks`, its exchanges, and, for a warehouse-sensitive item, the warehouse state before and after it:

- Step 1, the cold items, each started on a suspended warehouse: M25, M26, M29-show-columns, M29-describe, M29-get-ddl, M31, M100, M101 and M110.
- Step 2, sign-in and connect: M7, M8, M10, M12, M23, M25b, M82, M97 and M105.
- Step 3, results and the dialect: M52, M53, M58 and M60 to M64.
- Step 4, sessions, polling, retries and types: M15, M18, M24', M33 to M38, M41, M42, M44, M48, M51, M57, M83 and M104.
- Step 5, the operator's items and M80.

An item's rows are summarised, by `tests/helpers/snowflake-evidence-summary.ts`, so the set stays a few megabytes: each partition answer and each statement's own inline rows keep the status, the allow-listed headers (`content-encoding` among them) and every other body field, and record `rows` with the byte length on the wire, the decoded byte length, the row count, and the first and the last row.
Each item's file says so in `rowsSummarised`.
The partition items M51, M52 and M53 read 100,001 rows of `big` in four partitions of 4,905, 37,605, 39,240 and 18,251 rows: partition 0 inline and uncompressed, the later ones gzipped, about a sixth of their decoded size on the wire.

## What remains by hand

These items are the ones the harness cannot ask alone, so their files hold an `operator` field and no exchange:

- M15 and M17: each confirms the default the spec records under its number; the operator follows the spec's item and notes the answer.
- M22: a request from an address the network policy does not allow, sent from another network.
- M50: the code that ends a statement the resource monitor suspends mid-run, with the quota lowered for one run.
- M55: the status GET of a handle whose result has expired, rerun on an old handle.
- M70: whether the export of `every_type` replays through `INSERT ... SELECT` with `PARSE_JSON` and the explicit date masks, which the live check's replay answers.
- M78: whether the provider doc's read-only setup recipe runs as written, MATERIALIZED VIEWS as a grant type included, under the operator's own placeholder names.
- M81: whether `SHOW` stops at 10,000 rows, with and without `LIMIT`, over objects the operator creates past that count in scratch schemas.
- M84: the code a data movement policy refusal answers, with one set for one run.
- M98: what a key never registered on the user answers, and so how specific the key-pair refusal can be.

The operator answered M15, M17, M22, M50, M70, M78, M81, M84 and M98 by hand on 2026-10-13, each in its file's `operator` field: what was run, the answer, and each step with its time, status, code and message.
M55 remains pending, its `operator` field still `"pending: the operator's answer is added to this file by hand"`.
M58, M61, M64 and M100 also carry an `operator` field, with further probes the operator asked by hand the same day beside the harness's exchanges.

Three scenarios of the plan have no file, for the reasons its `operator` field gives:

- `refusal-403`: a connect sent from an address the network policy does not allow, such as another network.
- `refusal-404`: the status GET of the statement's handle sent again once Snowflake no longer holds its result (M55).
- `role-check-secondary`: run with `DEFAULT_SECONDARY_ROLES = ('ALL')` on `studio_svc`, and `role-check-match` with `DEFAULT_SECONDARY_ROLES = ()`, then set back.

## What the tests build

What an account cannot be asked for, or this capture did not ask, is built by the test that needs it, in the shape the capture shows, labelled BUILT in that test's header, and is never a fixture:

- the role check answering another role: the account refuses a role the credentials may not use at connect with `390186`, so no captured role check answers another role;
- a role holding no warehouse: with secondary roles off, a statement that needs compute is refused with `391920` at 422, with or without a warehouse field; with them on, as they are by default, it runs on the user's default warehouse, and a small `GENERATOR` count needs no warehouse at all;
- active secondary roles on `studio_svc`, in the cell shape M38 records;
- a suspended warehouse under the panels, from the `SUSPENDED` row M25 captured for the same warehouse;
- a 403 gateway page and a status GET of a gone handle, the two pending scenarios above;
- the cut past the 16 MiB result budget, a status link to another host, the answers that echo a sentinel credential, and a transport failure.

## Repeating the capture

Run by hand, never by `bun run test` (`tests/runner/discover.ts` excludes `tests/live/`), with the operator's env file loaded:

```bash
(set -a; . <the operator's env file>; set +a; bun tests/live/snowflake-evidence.ts --scenarios --step 1,2,3,4,5)
```

It writes `trial-<date>-v<CURRENT_VERSION>/` with one file per item and scenario and the full `manifest.json`.
Its inputs come from the environment only: `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_SVC_USER` and `SNOWFLAKE_SVC_KEY_FILE` with an optional `SNOWFLAKE_SVC_KEY_PASSPHRASE`, `SNOWFLAKE_READER_USER` and `SNOWFLAKE_READER_KEY_FILE` with an optional `SNOWFLAKE_READER_KEY_PASSPHRASE`, `SNOWFLAKE_PAT_USER` and `SNOWFLAKE_PAT`, and `SNOWFLAKE_WAREHOUSE`.
The harness also reads `SNOWFLAKE_EDITION`, which the manifest records, `SNOWFLAKE_OPERATOR_USER`, the administrator who set the account up and registered the service user's key, which the scrub replaces and every printed line masks, and, when the operator knows it, `SNOWFLAKE_EGRESS_IP`, which the scrub looks for.
Before the first item it asks the account for its locator, organisation name and account name (`CURRENT_ACCOUNT()`, `CURRENT_ORGANIZATION_NAME()`, `CURRENT_ACCOUNT_NAME()`), so the scrub and the mask know them whatever form `SNOWFLAKE_ACCOUNT` took.
A missing or malformed one stops the run with exit code 2 before any socket.
The account is set up once as ACCOUNTADMIN with the names the scenarios use: a resource monitor `studio_probe_rm`, an X-Small Gen1 warehouse `studio_probe_wh` with `AUTO_SUSPEND = 60`, the database `studio_demo` with schema `probe`, the roles `studio_ro`, `studio_rw` and `studio_nowh`, a network policy on the users for `<operator egress IPv4>`, and the users `studio_svc` (key pair, `studio_rw`), `studio_reader` (key pair, `studio_ro` and `studio_nowh`) and `studio_pat` (a PAT restricted to `STUDIO_RO`).
Keys and the PAT live in the operator's env file, never in this repository.

The scenarios and items read these objects in `studio_demo.probe`, created as `studio_rw` unless named, so a capture can be repeated:

- `every_type`, 26 columns, one per row of the provider's type table: `id`, `n38`, `n_scaled`, `i`, `f`, `df` (DECFLOAT), `vc`, `ch`, `bin`, `b`, `d`, `t` (TIME(9)), `ts_ntz`, `ts_ltz`, `ts_tz`, `v`, `o`, `a`, `so` (OBJECT(city VARCHAR, zip NUMBER)), `sa` (ARRAY(NUMBER)), `m` (MAP(VARCHAR, NUMBER)), `geog`, `geom`, `u` (UUID), `vec` (VECTOR(FLOAT, 3)) and `fl` (FILE).
  Its 5 rows hold 2^53 + 1 and 10^38 - 1, NaN and both infinities, nanosecond and pre-1970 timestamps, an offset TIMESTAMP_TZ, nested NULLs, a FILE value of a staged file, and a row of NULLs.
- `wide`, `ID` and `C01` to `C60`, one row.
- `big`, `ID NUMBER` and `PAD VARCHAR`, 2,000,000 rows, `PAD` being `'pad-'` and the 7-digit zero-padded `ID`.
- `every_type_v`, a view, and `seq1`, a sequence.
- `files`, an internal stage created by ACCOUNTADMIN, holding `hello.txt` for the FILE cell.
- `every_type_mv`, a materialized view the operator creates just before a capture and drops right after it.

Every exchange passes through `tests/helpers/snowflake-evidence-scrub.ts` before it is written.
Only the named headers and body fields are kept, and the rest are listed in `dropped`.
Every bearer token becomes `<token-N>`, so the Authorization header reads `Bearer <token-N>` and a token signed later in a run reads as another one; every UUID (statement handles, query ids, request ids, login-failure ids) becomes `00000000-0000-0000-0000-00000000000N`, the same placeholder for the same id across every file of a run, still UUID-shaped so the replay passes the provider's handle check; the host, the account locator, the organisation and the account name, the last three as the account answered them, become `<host>`, `<account-locator>`, `<organization>` and `<account>`; user names, the three principals' and then the operator user's, become `<user-N>`, in any case; a user or account name is found in its underscore and its hyphen spelling and also inside a longer identifier it is joined to by `_`; IP addresses become `<ip-N>`.
Nothing is written while any file still holds a PAT or a passphrase in any spelling, a JWT-shaped string, a private key's armour, a Snowflake host, the account's names, the operator user's name, the egress IP or an email address; the three principals' setup names stay in each scenario's `connection` block, the user the replay signs as.
`tests/unit/db/snowflake/evidence-scrub.test.ts` renders every committed fixture again through the scrub, so a fixture the scrub would refuse, or would write differently, fails the suite.

## Credits

Everything run on the trial on 2026-10-12, its setup, a demo and both capture sessions, used 0.449 credits on `studio_probe_wh`: 0.312 for compute and 0.137 for cloud services.
They were read from `WAREHOUSE_METERING_HISTORY` on 2026-10-13.
The plan estimated 25.6 credits for the whole work.
