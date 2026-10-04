# Milvus go-api/v3.0.2 wire definitions

The Milvus provider's gRPC client speaks Milvus's API as the `.proto` files in this directory define it.
Nothing here is edited by hand: the vendored files are upstream's bytes, and `descriptor.ts` is generated from them.

## Provenance

Upstream is `milvus-io/milvus-proto` at the tag `go-api/v3.0.2`, which points at the commit `9e4f0ebc92af3ecf9e13c12350c6fce13d0893fa`, the commit Milvus v3.0.2's `go.mod` requires.
Each file was fetched at that commit with `gh api -H "Accept: application/vnd.github.raw" "repos/milvus-io/milvus-proto/contents/<upstream path>?ref=9e4f0ebc92af3ecf9e13c12350c6fce13d0893fa"`.
`tests/unit/db/milvus/descriptor.test.ts` holds every vendored file to the digest recorded here.

| Vendored file | Upstream path | SHA-256 |
|---|---|---|
| `milvus.proto` | `proto/milvus.proto` | `690b9e5286e9c92451b76148301d31f9be1d87b117adca5a8c5233a1a0d84b0a` |
| `common.proto` | `proto/common.proto` | `43a2b2c9b3fb5cf0859fbaec3fcb4627bfda2e99183b1534b877b47b1a425df7` |
| `schema.proto` | `proto/schema.proto` | `89714bd8c5a8c2696b564eb4f23a28e9a75fe8337323a9b0319a3385946c500b` |
| `rg.proto` | `proto/rg.proto` | `463fb54bb7c8568a4735126d898640440dad46f431ca4e2266dcc0b4a1567657` |
| `feder.proto` | `proto/feder.proto` | `6d9c0a5601bf06b3e17a4f70146017e79c4f9eb4e29960f956f8bbf4cc96d563` |
| `msg.proto` | `proto/msg.proto` | `21627290774147ceec10475d9b1e4d6fa0b1432eda01b75244d00010efc44c91` |
| `LICENSE` | `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |

`milvus.proto` imports `common.proto`, `rg.proto`, `schema.proto`, `feder.proto` and `msg.proto`, and those import nothing else of milvus-proto.
`tokenizer.proto` is not imported, so it is not vendored.
The files carry no licence header of their own: the repository is licensed under the Apache License 2.0, and `LICENSE` is its copy of it.
`milvus.proto`, `schema.proto` and `common.proto` also import `google/protobuf/descriptor.proto`, which is not vendored: `@grpc/proto-loader` registers protobufjs's own copy when it loads, so the generator imports proto-loader before it loads the protos.

## What the descriptor holds

The whole API is kept: three services and 149 RPCs, 151,114 bytes as compact JSON.
Trimming it to the RPCs Studio calls would only halve it, and the client already calls through a stub built from MilvusService filtered to its allowlist, so no other method can be reached.

## Regenerating the descriptor

`descriptor.ts` is the output of `scripts/generate-milvus-descriptor.mjs`: every definition `milvus.proto` reaches, resolved, as the JSON that proto-loader's `fromJSON` reads, with the field names the `.proto` files spell and without their comments.
Run `node scripts/generate-milvus-descriptor.mjs` after any change in this directory and commit the result.
To move to another Milvus release, fetch the same files at that release's milvus-proto commit, replace them, update the tag, the commit and the digests above, and regenerate; that is a provider change, measured again like any other.
