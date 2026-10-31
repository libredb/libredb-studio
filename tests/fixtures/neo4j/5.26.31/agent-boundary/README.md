# Neo4j 5.26.31 agent boundary captures

What three digest-pinned 5.26.31 servers answered each agent principal, recorded by `run.sh` through `tests/live/neo4j-agent-captures.ts`.
Every statement was sent raw through the graph layer's Bolt client, in a READ session on the database `neo4j`, with no Studio policy in front of it.
No value in these files was typed by hand, and none holds a password: each run generates its own and the capture script refuses to write a file that holds one.

## Servers

| Server | Image | What it is |
|---|---|---|
| `-ee` | `neo4j:5.26.31-enterprise@sha256:02d30e0a80f0aaed71cfdfaa85c8ea01cf44aacd55510d4a2b4a53f9f1a2e1ad` | stock Enterprise Edition, a second database `other` |
| `-ext` | the same image | the same, plus the test extension built from `extension/` |
| `-ce` | `neo4j:5.26.31-community@sha256:d9cfe82983d27f5a75b3aaae8f316d04f9a698a3b7f6103a508f7caf8362f255` | Community Edition, every database read-only |

The Enterprise image runs only when the person running `run.sh` has exported `NEO4J_ACCEPT_LICENSE_AGREEMENT` themselves; the script never sets it.

## Principals

One directory per principal, each replayable with `recordedGraphClient(<directory>)`.
`write-session/` holds what the same principal was answered in a WRITE session on a driver of its own, which no replay reads.

| Directory | Server | Roles |
|---|---|---|
| `reader_stock` | `-ee` | `reader`, with PUBLIC still holding `LOAD ON ALL DATA` (captured before the revoke) |
| `agent` | `-ee` | `agent_reader`, a copy of `reader`, after `REVOKE GRANT LOAD ON ALL DATA FROM PUBLIC` |
| `loader` | `-ee` | `agent_reader` and `csv_loader` (`GRANT LOAD ON ALL DATA`) |
| `cidr` | `-ee` | `agent_reader` and `cidr_loader` (`GRANT LOAD ON CIDR '10.0.0.0/8'`) |
| `denied` | `-ee` | `agent_reader`, `csv_loader` and `no_load` (`DENY LOAD ON ALL DATA`) |
| `editor` | `-ee` | `editor` |
| `boosted` | `-ee` | `agent_reader` and `boosted` (`GRANT EXECUTE BOOSTED PROCEDURE * ON DBMS`) |
| `admin` | `-ee` | `admin`; also the full `SHOW PROCEDURES` and `SHOW FUNCTIONS` listings |
| `widened-before`, `widened-after` | `-ee` | `agent_reader`, then also `csv_loader`, granted between the two |
| `ext_agent` | `-ext` | `agent_reader` |
| `ext_denied` | `-ext` | `agent_reader` and `no_extension` (`DENY EXECUTE` on `libredbtest.*`) |
| `community` | `-ce` | the only user, an implied administrator |

## What the captures show

- The stock reader is answered `LOAD CSV` from `file:///` and fetches the server's own HTTP port (`reader_stock/load-csv-http` fails parsing the page it fetched).
- After the revoke, `agent` is refused `Neo.ClientError.Security.Forbidden` for `LOAD CSV` in every spelling captured: upper and lower case, after `WITH`, and inside `CALL { }`.
- `loader` and `widened-after` are answered `LOAD CSV` through the second role; `denied` is refused it, since a denial wins over a grant.
- `CREATE`, `MERGE`, `SET`, `DELETE`, `CALL { } IN TRANSACTIONS` and `db.createLabel` are refused in a READ session (`AccessMode`), and the same writes are refused `Forbidden` to `agent` in a WRITE session (`agent/write-session/`), while `editor`'s write passes the privilege check (`editor/write-session/create` is refused only for a new label).
- `USE other` is answered, so the database is pinned by Studio's statement reader, which refuses `USE`.
- `db.checkpoint()` and `db.resampleOutdatedIndexes()` are built-ins a reader may run; Studio's reader refuses both by name, and `dbms.setConfigValue` is refused by the server.
- `ext_agent` can execute `libredbtest.touch` and `libredbtest.touchFn`, and each wrote its marker file in the server (`state-after.json`); `ext_denied` is refused both and lists only the built-ins.
- Community answers `SHOW CURRENT USER` with no roles, refuses `SHOW USER PRIVILEGES` as unsupported, and answers `LOAD CSV` on a read-only database, which refuses a write (`community/write-session/create`).
- A `//` comment ends at a line feed or a lone carriage return and runs on past U+2028 and U+0085; a block comment ends at its first star-slash, nested or not.

`state-before.json` and `state-after.json` hold the node counts of both databases and the extension's marker files; the counts are unchanged.
