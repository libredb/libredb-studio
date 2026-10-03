# Qdrant captures

What Qdrant 1.19.1 answered over `node:http(s)` before any provider code ran, one surface per file, and the part of the pinned OpenAPI document the console is held to.
The Qdrant provider's unit tests replay these files through a recording transport; no test here reaches a live server.

## Where they come from

`tests/live/qdrant-evidence.ts` writes every file under `qdrant/`, `qdrant-auth/`, `qdrant-tls/` and `qdrant-mtls/`, one directory per service of `docker/qdrant/README.md`.
`tests/live/qdrant-evidence-catalog.ts` lists the 235 captures it writes, and `tests/helpers/qdrant-fixtures.ts` reads that list, so a file the catalog does not name, or a name with no file, fails `tests/unit/db/qdrant/qdrant-fixtures.test.ts`.
Each capture records the image, its digest, the server version, the date, the runtime, the surface it called and its request, then a pass or the verbatim failure.
A credential header is recorded as `<api-key>` or `<token>`, never as its value, and the harness refuses to write a file that holds a key, a JWT or any segment of one.
Every JWT is minted at run time from the auth service's admin key and is never written anywhere.

`openapi-extract.json` is written by the same harness from `docs/redoc/master/openapi.json` of github.com/qdrant/qdrant at tag v1.19.1, which it refuses unless its sha256 is `eb3e5d71ba74e1d99124ca1a77d563bbfa47084f04a13ef9b197e339f5a4ce0a`.
It holds the 17 operations of the console with their methods, paths and parameters, and every schema their request bodies reach, without prose.

## The groups

- `routes`: the 17 routes, the 14 that name a collection on each of the seven seeded collections.
- `credentials`: six requests with each of twelve credentials on `qdrant-auth`.
- `aliases`: the alias matrix of three scoped JWTs on `qdrant-auth`.
- `timeouts`: a scroll, an exact count, a query and two answers of a grouped query, each past `?timeout=1`, and a `timeout` of 0.
- `strict`: the strict-mode texts and a rate limit, on two collections the harness creates under `qdrant_evidence_` and removes.
- `errors`: one capture per row of the error table that needs no credential.
- `filters`: the server's own answer to a misspelled filter key, beside the controls that tell a dropped key from an honoured one.
- `tls`: TLS by name and by address, the keys over TLS, a client certificate, and three refused connections.

A grouped query past its time limit answers 408 or 500 depending on a timer race on the server, so its two captures are asked for until each shape arrives, and record how many attempts that took.

## Running it

Bring the four services up as `docker/qdrant/README.md` says, then copy the keys volume out, outside the repository:

```sh
dir=$(mktemp -d)
docker cp libredb-qdrant-keys:/keys "$dir/keys"
bun tests/live/qdrant-evidence.ts --keys "$dir/keys" --report "$dir/report.json"
bun tests/live/qdrant-evidence.ts --openapi <openapi.json at tag v1.19.1>
```

An answer whose status is not the one its capture declares stops the run before anything is written.
`--only <group,...>` captures some groups again and leaves the other files as they are.
