# Spark Connect v4.2.0 wire definitions

The Apache Spark provider's gRPC client speaks Spark Connect as the `.proto` files in this directory define it.
Nothing here is edited by hand: the vendored files are upstream's bytes, and `descriptor.ts` is generated from them.

## Provenance

Upstream is `apache/spark` at the tag `v4.2.0`, which points at the commit `32f7299601108917fb01920a54e084595b7b3bf8`.
Each `.proto` file was fetched at that commit with `gh api -H "Accept: application/vnd.github.raw" "repos/apache/spark/contents/sql/connect/common/src/main/protobuf/<vendored file>?ref=32f7299601108917fb01920a54e084595b7b3bf8"`, and `LICENSE` and `NOTICE` the same way from the repository root.
`tests/unit/db/spark/descriptor.test.ts` holds every vendored file to the digest recorded here.

| Vendored file | Upstream path | SHA-256 |
|---|---|---|
| `spark/connect/base.proto` | `sql/connect/common/src/main/protobuf/spark/connect/base.proto` | `86d49472e8c905245b5007f19a3ed9cea740140376b5515c6034fbd2a2f6d31f` |
| `spark/connect/catalog.proto` | `sql/connect/common/src/main/protobuf/spark/connect/catalog.proto` | `c0f655f0edc9c83b2229da28233dbf2802bd8d8f91035942e53f22bfdeb94fd5` |
| `spark/connect/commands.proto` | `sql/connect/common/src/main/protobuf/spark/connect/commands.proto` | `923a4fddf21120e8d5f6ed304fbfd7ed8aa5885c7548ed1b909db56e0f12496d` |
| `spark/connect/common.proto` | `sql/connect/common/src/main/protobuf/spark/connect/common.proto` | `1c111676e247370259273863e2b37247b913f94221c6f1f4a609fe037169e783` |
| `spark/connect/expressions.proto` | `sql/connect/common/src/main/protobuf/spark/connect/expressions.proto` | `03a0995ca94aa8c87af64462e6926eade335732e6edf95e2a0625496c39d1eb5` |
| `spark/connect/ml.proto` | `sql/connect/common/src/main/protobuf/spark/connect/ml.proto` | `7d61c9098d25dd8b1c3484222d8298e6891a02366c59f454e24dd90993422a13` |
| `spark/connect/ml_common.proto` | `sql/connect/common/src/main/protobuf/spark/connect/ml_common.proto` | `237628488246b193c2711d05b2657d640b5e044c4bcffd786dcd2ae56224e8ba` |
| `spark/connect/pipelines.proto` | `sql/connect/common/src/main/protobuf/spark/connect/pipelines.proto` | `6624415fc3dd80834eb7fa14e6427f5af0ec41ea80280380a0645df13190f98e` |
| `spark/connect/relations.proto` | `sql/connect/common/src/main/protobuf/spark/connect/relations.proto` | `cf6b233f07d9fb4c1b708ac74260b3885b2cbbed1ee5a6b139e58423fd44c60d` |
| `spark/connect/types.proto` | `sql/connect/common/src/main/protobuf/spark/connect/types.proto` | `192e4c1af57e81247e946813f37c886af0ed201d9305e2350e9a228030ea0b8b` |
| `LICENSE` | `LICENSE` | `b8ea0873b8410497804dbb19dac00ffa5017d2ab33582b9e7ce46692fa4a0da1` |
| `NOTICE` | `NOTICE` | `9346e8e0a1e21cb45ac792b75ca4d3adfd858bc57dd6627e47714c761e917a0d` |

`base.proto` reaches the other nine files, and they import nothing else of Spark's.
`example_plugins.proto` is not imported, so it is not vendored.
Each file keeps its own Apache License 2.0 header; `LICENSE` and `NOTICE` are Spark's own, from the same commit.
From outside Spark the files import only `google/protobuf/any.proto` and `google/protobuf/timestamp.proto`, which protobufjs serves from memory, so neither is vendored.
`google.rpc.Status` and `google.rpc.ErrorInfo` are not vendored either: the provider reads them by hand in `status-details.ts`.
The 4.2.0 files serve servers from 4.1.0 on: Spark gates each release's protos against the previous one, and the provider's surfaces were run against 4.1.3 with this descriptor.

## What the descriptor holds

The whole API is kept: one service, `spark.connect.SparkConnectService`, and its twelve RPCs.
The client calls through a stub built from that service filtered to the six RPCs of `SPARK_ALLOWLISTED_RPCS` in `grpc-client.ts`, so `AddArtifacts`, `ArtifactStatus`, `ReattachExecute`, `ReleaseExecute`, `CloneSession` and `GetStatus` cannot be called.

## Regenerating the descriptor

`descriptor.ts` is the output of `scripts/generate-spark-descriptor.mjs`: every definition `spark/connect/base.proto` reaches, resolved, as the JSON that proto-loader's `fromJSON` reads, with the field names the `.proto` files spell and without their comments.
Run `node scripts/generate-spark-descriptor.mjs` after any change in this directory and commit the result.
To move to another Spark release, fetch the same files at that release's commit, replace them, update the tag, the commit and the digests above, and regenerate; that is a provider change, measured again like any other.
