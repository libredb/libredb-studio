# Firestore captures

What the Firestore emulator answered the Firestore provider, one file per scenario.
The integration test (`tests/integration/db/firestore-provider.test.ts`) and the end-to-end stub (`e2e/helpers/firestore-stub.ts`) replay them; no test here reaches a live emulator.

## Where they come from

`bun tests/live/firestore-evidence.ts --jar <path>` starts the pinned `cloud-firestore-emulator` 1.22.0 jar (SHA-256 `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`, Java 21 or later) on `127.0.0.1` under the project `demo-libredb`, and for each scenario of `tests/live/firestore-evidence-plan.ts` flushes it, writes `docker/firestore/seed.json` unless the scenario is unseeded, and runs the scenario's steps through the real provider in emulator mode.
It records every transport the provider creates at its `createTransport` seam, so a replay answers exactly the requests the provider sends.
A step whose answer does not show what the plan expects stops the run, and nothing is written; nothing is written either when the files would total 1 MB.
`manifest.json` names the emulator version, the jar's SHA-256, the Java version, the Studio commit, the harness files that differ from it (`uncommitted`), the date and each scenario's step and exchange counts.

| Scenario | Seeded | What it shows |
| --- | --- | --- |
| `browse` | Yes | connect, the tree, a sampled field expand, the bulk describe, every Keys panel level, an expired page token, the Source tab |
| `console` | Yes | one statement of every kind, and the refusals answered before any request |
| `surface` | Yes | the shared object-surface conformance, under recording |
| `empty` | No | the empty-project hint |
| `datastore` | No | an emulator started in Datastore mode, refused on connect |

Each file holds `{ scenario, lanes, exchanges }`: a lane is the kind, the origin, the connection header names, the class of the `authorization` header and whether link-local addresses are refused; an exchange is the lane, the request (method, path and query, body, the request header names, the response cap) and the answer (status, content type, `Retry-After`, body).
No header value is recorded.

## The replay

`tests/helpers/firestore-replay.ts` matches the emulator and API lanes on the method, the path, the sorted query and the body, the token lane on the method, the path and `grant_type`, and the metadata lane on the method, the path and the sorted query; a key recorded more than once answers in order and then repeats its last answer, and a request nobody recorded answers a `text/plain` 404.

## The scrub

Every capture passes `tests/helpers/firestore-evidence-scrub.ts`; on emulator captures it changes nothing, because a `demo-` project and `(default)` are kept and the emulator sends no token.

## What the emulator does not serve

Emulator 1.22.0 answers a page token it cannot decode with HTTP 500 and `{"error":{"code":500,"status":"UNKNOWN"}}`, not with a refusal of the token.
The `browse` scenario therefore sends `bm90LWEtcGFnZS10b2tlbg`, the base64 of `not-a-page-token`, which the emulator refuses with 400 `INVALID_ARGUMENT` "invalid page token", the answer the provider turns into "This listing expired; list the level again".
`findNearest` is served without a vector index, so the `console` scenario captures a real vector query.

## What is built, not captured

The emulator proves no authentication, IAM, index error or Query Explain, so the integration test builds those answers itself and lists each one by name.
