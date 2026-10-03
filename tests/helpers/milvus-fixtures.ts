/**
 * The one reader of tests/fixtures/milvus/ (vector-family spec 7.3): what Milvus 3.0.2 answered @grpc/grpc-js before
 * any provider code ran, one surface per file, captured by tests/live/milvus-evidence.ts. A row whose Bun and Node
 * answers differed is written twice, `<name>.bun.json` and `<name>.node.json`; any other once, `<name>.json`.
 * `reviveMilvusFixture` turns the files back into what grpc-js hands over with the adapter's loader options, so a test
 * replays an answer through `recordedMilvusWire` and the real adapter, and a failure through `toMilvusError`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MilvusFixtureService = "milvus" | "milvus-tls" | "milvus-mtls";

export interface MilvusCaptureProvenance {
  readonly service: MilvusFixtureService;
  readonly image: string;
  readonly version: string;
  readonly date: string;
  readonly runtime: string;
  readonly rpc: string;
  readonly user: string;
  readonly surface: string;
  readonly request: unknown;
}

export interface MilvusCapture {
  readonly $captured: MilvusCaptureProvenance;
  readonly outcome: "pass" | "fail";
  readonly payload: unknown;
}

export const MILVUS_FIXTURES_DIR = join(import.meta.dir, "..", "fixtures", "milvus");

const ALLOWLIST = [
  "GetVersion",
  "CheckHealth",
  "GetMetrics",
  "ListDatabases",
  "DescribeDatabase",
  "ShowCollections",
  "DescribeCollection",
  "BatchDescribeCollection",
  "DescribeIndex",
  "GetLoadState",
  "GetLoadingProgress",
  "GetCollectionStatistics",
  "ShowPartitions",
  "ListAliases",
  "DescribeAlias",
  "Query",
  "Search",
  "HybridSearch",
  "LoadCollection",
  "ReleaseCollection",
];
const kebab = (rpc: string) => rpc.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
const SEEDED = [
  "default-docs_int64",
  "default-docs_varchar",
  "default-fts",
  "default-unloaded_big",
  "default-scratch",
  "default-edge_values",
  "default-pk_partitioned",
  "default-large_topk",
  "default-shadowed",
  "default-wide_768",
  "default-emb_list",
  "probe_db-notes",
];
const EDGE_FIELDS = ["f32", "f16", "bf16", "bin", "i8", "sp"];
const MILVUS_ERRORS = [
  "error-unauthenticated",
  "error-permission-denied",
  "error-unimplemented",
  "error-connection-dropped",
  "error-deadline-exceeded",
  "error-deadline-status-10001",
  "error-cancelled-on-client",
  "error-receive-cap",
  "error-receive-cap-decompressed",
  "error-not-loaded",
  "error-input",
  "error-collection-not-exists",
  "error-database-not-exists",
  "error-query-node-2000",
  "error-query-node-2001",
  "error-query-node-2099",
  "error-tls-to-plaintext",
];

/** Every capture as "<service>/<name>", sorted; the harness writes exactly these. */
export const MILVUS_FIXTURE_NAMES: readonly string[] = [
  ...ALLOWLIST.flatMap((rpc) => ["root", "reader", "nobody"].map((user) => `milvus/${kebab(rpc)}-${user}`)),
  "milvus/get-load-state-loaded",
  ...SEEDED.map((collection) => `milvus/describe-collection-${collection}`),
  "milvus/get-load-state-unloaded-big",
  "milvus/query-count",
  "milvus/query-edge-values",
  ...EDGE_FIELDS.map((field) => `milvus/search-edge-values-${field}`),
  ...MILVUS_ERRORS.map((name) => `milvus/${name}`),
  "milvus-tls/get-version-tls-localhost",
  "milvus-tls/get-version-tls-ip-rule",
  "milvus-tls/error-tls-chain",
  "milvus-tls/error-plaintext-to-tls",
  "milvus-tls/error-deadline-cancelled",
  "milvus-tls/error-ping-goaway",
  "milvus-mtls/get-version-mtls",
  "milvus-mtls/error-tls-client-certificate-required",
  "milvus-mtls/error-tls-client-certificate-refused",
  "milvus-mtls/error-tls-client-certificate-expired",
  "milvus-mtls/error-tls-client-key-mismatch",
].sort();

export function reviveMilvusFixture(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveMilvusFixture);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && typeof record.$bytes === "string") return Buffer.from(record.$bytes, "base64");
  if (keys.length === 1 && typeof record.$float === "string") return Number(record.$float);
  return Object.fromEntries(keys.map((key) => [key, reviveMilvusFixture(record[key])]));
}

/** The file or files a name was written as: one `.json`, or the `.bun.json` and `.node.json` pair. */
export function milvusCaptureFiles(name: string): readonly string[] {
  const base = join(MILVUS_FIXTURES_DIR, name);
  const once = `${base}.json`;
  return existsSync(once) ? [once] : [`${base}.bun.json`, `${base}.node.json`].filter((file) => existsSync(file));
}

export function milvusCapture(name: string, runtime: "bun" | "node" = "bun"): MilvusCapture {
  const base = join(MILVUS_FIXTURES_DIR, name);
  const file = existsSync(`${base}.json`) ? `${base}.json` : `${base}.${runtime}.json`;
  return reviveMilvusFixture(JSON.parse(readFileSync(file, "utf8"))) as MilvusCapture;
}

function errorOf(capture: MilvusCapture): Readonly<Record<string, unknown>> | undefined {
  const payload = capture.payload as { readonly error?: Readonly<Record<string, unknown>> } | null;
  return payload !== null && typeof payload === "object" ? payload.error : undefined;
}

/** A failure as grpc-js rejected it: an Error with `code`, `details` and `metadata` own, or a runtime's plain Error. */
export function capturedFailure(capture: MilvusCapture): Error {
  const error = errorOf(capture);
  if (error === undefined) throw new Error(`${capture.$captured.surface} holds an answer, not a failure`);
  const failure = new Error(String(error.message));
  if (!("code" in error)) {
    failure.name = String(error.name);
    return failure;
  }
  return Object.assign(failure, { code: error.code ?? undefined, details: error.details ?? undefined, metadata: {} });
}

/** An answer as grpc-js decoded it, for a recorded wire to hand back. */
export function capturedAnswer(capture: MilvusCapture): object {
  if (errorOf(capture) !== undefined) throw new Error(`${capture.$captured.surface} holds a failure, not an answer`);
  return capture.payload as object;
}
