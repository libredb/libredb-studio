# Neo4j 5.26.31 captures

What the compose `neo4j` service answered to the graph layer's Bolt client, one statement per file, written by `tests/live/neo4j-evidence.ts`.
Tests replay them through `recordedGraphClient` in `tests/helpers/neo4j-fixtures.ts`, which answers a run by the exact database and statement text and fails on any other.
No value in these files was typed by hand.

## Provenance

| Item | Value |
|---|---|
| Image | `neo4j:5.26.31-community` |
| Digest | `sha256:d9cfe82983d27f5a75b3aaae8f316d04f9a698a3b7f6103a508f7caf8362f255` |
| Server | `Neo4j/5.26.31`, Bolt 5.5 |
| Home database | `neo4j` |
| Seed | `docker/neo4j/seed.cypher` |
| Captured | 2026-10-03 |

There are 78 statement captures, plus `verify.json` and three transport captures under `transport/`.
The node and relationship counts and the index and constraint names were read before and after the run, and were the same.

## Encoding

Each statement file is `{ "$captured": { image, digest, date, database }, "statement", "options": { database, maxRows }, "outcome": "pass" | "fail", "result" | "error" }`.
A `result` is the client's `GraphRunResult`, so its rows are already the JSON-safe values `record-values.ts` writes.
An `error` is `{ category, code, message }` of the client's `GraphClientError`.
A transport file carries a `surface` sentence instead of a statement and options.
The `explain-*` captures ran with `maxRows: 0`, as the statement gate runs them.

## Measured, not captured

`CREATE (n)` in a READ session was refused by the server:

```text
Neo.ClientError.Statement.AccessMode: Writing in read access mode not allowed. Attempted write to neo4j
```

`session.close()` on a READ session running `UNWIND range(1, 2000000000) AS x RETURN count(x)` returned in 2.5 ms.
The transaction left `SHOW TRANSACTIONS` 7 ms after the close started, and the run ended with:

```text
Neo.ClientError.Transaction.Terminated: The transaction has been terminated. Retry your operation in a new transaction, and you should see a successful result. Explicitly terminated by the user.
```
