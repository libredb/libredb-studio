/**
 * Which files each gRPC seam guard holds, in one place.
 *
 * tests/unit/db/etcd/seam-guard.test.ts is the repository-wide default: its import lists (who imports @grpc/grpc-js,
 * @grpc/proto-loader, a descriptor and its generator) hold over every file except the ones another guard holds, which
 * it skips through `heldByAnotherGuard`. Every other gRPC seam guard reads its own row's `held` from here, so the files one guard
 * holds and the files the etcd guard skips are the same list by construction. A new gRPC provider adds its row here
 * and edits no other provider's guard.
 */

/** One gRPC seam guard's share of the repository. */
export interface GrpcSeamHolding {
  /** Files this row's own guard holds, which tests/unit/db/etcd/seam-guard.test.ts skips; empty for etcd, whose guard is the repository-wide default. */
  readonly held: readonly RegExp[];
  /** The source files of this row that import src/lib/db/grpc/, held exactly by tests/unit/db/grpc/seam-guard.test.ts (G5). */
  readonly transportImporters: readonly string[];
  /** The provider directory the "no third copy" TLS check reads (G10); absent for the transport row. */
  readonly providerDirectory?: string;
}

export const GRPC_SEAM_HOLDINGS: Readonly<Record<string, GrpcSeamHolding>> = {
  transport: {
    held: [/^src\/lib\/db\/grpc\//, /^tests\/unit\/db\/grpc\//, /^tests\/helpers\/grpc-/],
    transportImporters: [],
  },
  etcd: {
    held: [],
    transportImporters: [
      "src/lib/db/providers/keyvalue/etcd/grpc-client.ts",
      "src/lib/db/providers/keyvalue/etcd/connection-options.ts",
    ],
    providerDirectory: "src/lib/db/providers/keyvalue/etcd",
  },
  milvus: {
    held: [
      /^src\/lib\/db\/providers\/vector\/milvus\//,
      /^scripts\/generate-milvus-descriptor\.mjs$/,
      /^tests\/unit\/db\/milvus\//,
      /^tests\/helpers\/milvus-/,
      /^tests\/live\/milvus-/,
    ],
    transportImporters: [
      "src/lib/db/providers/vector/milvus/grpc-client.ts",
      "src/lib/db/providers/vector/milvus/connection-options.ts",
    ],
    providerDirectory: "src/lib/db/providers/vector/milvus",
  },
  oxia: {
    held: [
      /^src\/lib\/db\/providers\/keyvalue\/oxia\//,
      /^scripts\/generate-oxia-descriptor\.mjs$/,
      /^tests\/unit\/db\/oxia\//,
      /^tests\/helpers\/oxia-/,
      /^tests\/live\/oxia-/,
    ],
    transportImporters: [
      "src/lib/db/providers/keyvalue/oxia/connection-options.ts",
      "src/lib/db/providers/keyvalue/oxia/grpc-client.ts",
    ],
    providerDirectory: "src/lib/db/providers/keyvalue/oxia",
  },
};

/** Whether a repository path is held by a guard other than etcd's: any row's `held` pattern matches it. */
export function heldByAnotherGuard(path: string): boolean {
  return Object.values(GRPC_SEAM_HOLDINGS).some((holding) => holding.held.some((pattern) => pattern.test(path)));
}
