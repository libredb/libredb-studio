# etcd v3.7.2 wire definitions

The etcd provider's gRPC client speaks etcd's v3 API as the `.proto` files in this directory define it.
Nothing here is edited by hand: the vendored files are upstream's bytes, the two stubs are described below, and `descriptor.ts` is generated from them.

## Provenance

Upstream is `etcd-io/etcd` at the tag `v3.7.2`, an annotated tag (object `cb9b1aa2b1237b59255d65773c34ab0cd9df3679`) that points at the commit `68c065e562994b89e333e77b039ad066f933c586`, the build that `etcd --version` reports as `68c065e`.
Each file was fetched at that commit with `gh api -H "Accept: application/vnd.github.raw" "repos/etcd-io/etcd/contents/<upstream path>?ref=68c065e562994b89e333e77b039ad066f933c586"`.
`tests/unit/db/etcd/descriptor.test.ts` holds every vendored file to the digest recorded here.

| Vendored file | Upstream path | SHA-256 |
|---|---|---|
| `etcd/api/etcdserverpb/rpc.proto` | `api/etcdserverpb/rpc.proto` | `d50fe7e0c2cb9d80fa6fed1b47fb5cadcda06674bef99c445adab40c24feedb2` |
| `etcd/api/mvccpb/kv.proto` | `api/mvccpb/kv.proto` | `fa1da1204a680c5c8f3043edb77b9d5895a16a5b5ccb64b438ae1a65ab2f169c` |
| `etcd/api/authpb/auth.proto` | `api/authpb/auth.proto` | `b10ca65b012299f4fb87d9b0ef3e134149ce310dd48be07fccc7b965c36138fb` |
| `etcd/api/versionpb/version.proto` | `api/versionpb/version.proto` | `bfad8707459d304930a71261d6343005380c33bbcacb36b21c604fef1c8b43b2` |
| `LICENSE` | `api/LICENSE` | `7e85b38339bf9f7f43308b103c1186f49417f2d3da37ef8b02e2ad7b5f619402` |

`rpc.proto` defines the six services and their 42 RPCs, and the other three `.proto` files are the ones it imports from etcd.
They keep upstream's directory layout, because `rpc.proto` imports them by the paths `etcd/api/mvccpb/kv.proto`, `etcd/api/authpb/auth.proto` and `etcd/api/versionpb/version.proto`.
The files carry no license header of their own: the etcd `api` module they belong to is licensed under the Apache License 2.0, and `LICENSE` is that module's copy of it.

## What is stubbed, and why

`rpc.proto` also imports two files of grpc-gateway, the HTTP gateway that etcd generates beside its gRPC server:

- `google/api/annotations.proto`, for the `(google.api.http)` option on 41 of the 42 RPCs (`RangeStream` is gRPC-only);
- `protoc-gen-openapiv2/options/annotations.proto`, for the one `openapiv2_swagger` option on the file.

Only grpc-gateway's code generators read those options, and a gRPC client never does, so `stubs/` holds a stand-in for each file that declares its package and nothing else.
protobufjs records a custom option without resolving its definition, so the options still appear in the descriptor as plain values that nothing reads.
Vendoring the real files would add googleapis' and grpc-gateway's option definitions to the descriptor, for a client that never reads them.

`versionpb/version.proto` imports `google/protobuf/descriptor.proto`, which is not vendored either.
`@grpc/proto-loader` registers protobufjs's own copy of it as a common file when it loads, so the generator imports proto-loader before it loads the protos.
That works only while the generator and proto-loader resolve one protobufjs, which is why package.json pins protobufjs exactly beside proto-loader (its `//dependencies` note says so, and `tests/unit/db/etcd/dependency-resolution.test.ts` holds the layout).
The types `version.proto` extends (`MessageOptions` and the rest) are therefore part of the generated descriptor.

## Regenerating the descriptor

`descriptor.ts` is the output of `scripts/generate-etcd-descriptor.mjs`: every definition `rpc.proto` reaches, resolved, as the JSON that proto-loader's `fromJSON` reads, with the field names the `.proto` files spell (`range_end`, not `rangeEnd`) and without their comments.
Run `node scripts/generate-etcd-descriptor.mjs` after any change in this directory and commit the result.
With `--out <file>` it writes the same bytes to that file instead, resolved against the working directory, and leaves `descriptor.ts` alone.
`tests/unit/db/etcd/descriptor.test.ts` regenerates it in memory and fails on any difference from the committed bytes.
It also runs the command with `--out` in child processes, directly and through a symlinked checkout, so a broken command fails a test rather than exiting 0 with nothing written.

To move to another etcd release, fetch the same four `.proto` files and `api/LICENSE` at that release's commit, replace them, update the tag, the commit and the digests above, and regenerate.
That is a provider change, measured again like any other, and `tests/unit/db/etcd/descriptor.test.ts` pins the RPCs `rpc.proto` defines, so a release that adds one fails until the test names it.
