# Weaviate captures

What the Weaviate provider sent to the fixture servers of [`docker/weaviate/README.md`](../../../docker/weaviate/README.md), what each server answered, and what each provider call returned or threw, one scenario per file.
The integration test `tests/integration/db/weaviate-provider.test.ts` replays these files through a transport that answers from them; no test here reaches a live server.

## Where they come from

`tests/live/weaviate-evidence.ts` writes every file, `<service>/<scenario>.json`, one per scenario of `tests/live/weaviate-scenarios.ts`.
Each file records the image, its digest, the server version, the date, the runtime and the credential the scenario used, the transport each connect built, every exchange (method, path, body, then the answer or the error the transport threw) and every outcome (a value, or an error's class and message).
A credential header is recorded as `Bearer <key>`, never as its value, and the harness refuses to write a file that holds any key it read.

## The scenarios

- `surface`: the tree, the columns, the Source and the panels, on `weaviate` (1.40.2), `weaviate-1-38`, `weaviate-1-37` and `weaviate-nographql`.
- `reads`: every read route, the tenant guard and the not-found answers, on 1.40.2 and 1.37.4.
- `searches`: BM25, hybrid at `alpha` 0, near-vector, near-object and aggregates in the REST shape, run over REST on 1.40.2 and over GraphQL on 1.38.22 and 1.37.4.
- `refusals`: what is refused before anything is sent.
- `weaviate-auth`: the `viewer` user, the root user, a wrong key and no key.
- `weaviate-tls`: the `viewer` user over TLS with the fixture's CA, and plain HTTP to the TLS port.

## Running it

Bring the six services up as `docker/weaviate/README.md` says, then copy the keys volume out, outside the repository:

```sh
dir=$(mktemp -d)
docker cp libredb-weaviate-auth:/keys "$dir/keys"
bun tests/live/weaviate-evidence.ts --keys "$dir/keys"
bun tests/live/weaviate-live-check.ts --keys "$dir/keys"
```

The live check holds a fresh run to these files and checks that no run changed the schema, the aliases or any tenant's status.
