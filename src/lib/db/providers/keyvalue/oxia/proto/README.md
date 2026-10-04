# Oxia v0.16.10 wire definitions

The Oxia provider's gRPC client speaks Oxia's client API and the gRPC health service as the `.proto` files in this directory define them.
Nothing here is edited by hand: the vendored files are upstream's bytes, and `descriptor.ts` is generated from them.

## Provenance

`client.proto`, `LICENSE` and `NOTICE` come from `oxia-db/oxia` at the tag `v0.16.10`, an annotated tag (object `22ad8b8867c5a0a764937fb016eaac27739e3de9`) that points at the commit `c72b0bfce3fa0058fe200462b64f0d502dd56b02`.
`grpc/health/v1/health.proto` and `grpc/LICENSE` come from `grpc/grpc-proto` at the commit `2eb777aba6593c31e21f7f69a163486bdc793501`, the last commit that touched the file; that repository has no tags.
Each file was fetched at its commit with `gh api -H "Accept: application/vnd.github.raw" "repos/<owner>/<repo>/contents/<upstream path>?ref=<commit>"`.
`tests/unit/db/oxia/descriptor.test.ts` holds every vendored file to the digest recorded here.

| Vendored file | Upstream path | SHA-256 |
|---|---|---|
| `client.proto` | `common/proto/client.proto` | `9daaa46ad75c7066d43ae48190825daef62846351ff9800f26383202a71fd979` |
| `LICENSE` | `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `NOTICE` | `NOTICE` | `9953b70aeffa0bc570a9d564c566e27528d7be114b017f661a3c1c5ae6b1cf82` |
| `grpc/health/v1/health.proto` | `grpc/health/v1/health.proto` | `164b670058855c6277a0511a14e2a302dd5a8ff899853ca6851b6b201a413d28` |
| `grpc/LICENSE` | `LICENSE` | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |

The first three rows are `oxia-db/oxia`'s files and the last two `grpc/grpc-proto`'s.
Neither `.proto` file imports another file.
`client.proto` carries the Oxia Authors' Apache License 2.0 header and `health.proto` the gRPC Authors'; each `LICENSE` is its repository's copy of the Apache License 2.0, and `NOTICE` is Oxia's attribution notice, which the licence's section 4(d) asks a redistribution to carry; `grpc/grpc-proto` has no NOTICE file at that commit.

## What the descriptor holds

Both files are kept whole: package `io.oxia.proto.v1` with the service `OxiaClient` and its 11 RPCs, and package `grpc.health.v1` with the service `Health` and its 3 RPCs (`Check`, `List`, `Watch`), 9,697 bytes as compact JSON.
Trimming it to the RPCs Studio calls would save under 10 KB, and the client calls through a stub built from the two services filtered to its allowlist (`GetShardAssignments`, `Read`, `List`, `RangeScan` and `Health/Check`), so no other method can be reached.

## Regenerating the descriptor

`descriptor.ts` is the output of `scripts/generate-oxia-descriptor.mjs`: every definition of the two files, resolved, as the JSON that proto-loader's `fromJSON` reads, with the field names the `.proto` files spell and without their comments.
Run `node scripts/generate-oxia-descriptor.mjs` after any change in this directory and commit the result.
To move to another Oxia release, fetch `client.proto`, `LICENSE` and `NOTICE` at that release's commit, replace them, update the tag, the tag object, the commit and the digests above, and regenerate; that is a provider change, measured again like any other.
