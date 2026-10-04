/**
 * Every number and fixed name of the Oxia provider (SB1-11), in one pure, browser-safe module.
 *
 * Every other module of the provider imports its numbers from here, and no module restates one. The module holds no
 * logic and imports nothing but a type, so the console's browser-safe modules can read it.
 */
import type { DatabaseType } from "@/lib/types";

/** The provider's type-id, the one every error of this provider is tagged with. */
export const OXIA_TYPE: DatabaseType = "oxia";
/** The data server's public port, the CLI's default. */
export const OXIA_DEFAULT_PORT = 6648;
/** The admin port, named only by the sentence for a port that does not serve the client API. */
export const OXIA_ADMIN_PORT = 6651;
/** The namespace the server means by an empty name. */
export const OXIA_DEFAULT_NAMESPACE = "default";
/** Keys under this prefix are Oxia's own internal records; no surface of Studio reads them. */
export const OXIA_INTERNAL_PREFIX = "__oxia/";
/** The TLS server name sent to a server addressed by IP, a name that never resolves (RFC 6761). */
export const OXIA_IP_SERVER_NAME = "oxia.invalid";

/** Received bytes of one message a channel accepts (`grpc.max_receive_message_length`). */
export const OXIA_RECEIVE_CAP_BYTES = 16 * 1024 * 1024;
/** Key and value bytes a console run keeps for its answer; also the per-stream received limit of a console stream and of Read. */
export const OXIA_RUN_BYTE_BUDGET = 8 * 1024 * 1024;
/** Received bytes of one shard stream of a walk page: two of the server's 2 MiB chunks. */
export const OXIA_PAGE_STREAM_BYTES = 4 * 1024 * 1024;
/** Key bytes a walk page keeps across all its shards. */
export const OXIA_PAGE_KEPT_BYTES = 16 * 1024 * 1024;
/** Received bytes the order probe's extended sample may read. */
export const OXIA_ORDER_PROBE_BYTES = 8 * 1024 * 1024;
/** Keys of each shard the order probe's pair sample keeps from its first List message. */
export const OXIA_ORDER_SAMPLE_KEYS = 100;

/** Shards a snapshot may hold; a larger map is refused. */
export const OXIA_MAX_SHARDS = 1_024;
/** Shard calls a run keeps in flight, whatever the shard count. */
export const OXIA_MAX_SHARD_STREAMS = 8;
/** Addresses the Data servers field may list. */
export const OXIA_MAX_DATA_SERVERS = 64;
/** Bytes of a leader address the snapshot may carry; also the bound on a secondary index name. */
export const OXIA_LEADER_MAX_BYTES = 300;
/** Bytes of a namespace name. */
export const OXIA_NAMESPACE_MAX_BYTES = 300;
/** Gets in one Read request: the Go client's `maxRequestsPerBatch`. */
export const OXIA_READ_BATCH_GETS = 1_000;
/** Bytes of the key a Keys panel cursor carries. */
export const OXIA_CURSOR_KEY_MAX_BYTES = 65_536;

/** How long a read snapshot is reused before the next call reads it again. */
export const OXIA_SNAPSHOT_TTL_MS = 5_000;
/** The latest deadline of a snapshot read, now plus this: the surface deadline Milvus uses. */
export const OXIA_SURFACE_DEADLINE_MS = 10_000;
/** The deadline of one health check. */
export const OXIA_HEALTH_DEADLINE_MS = 5_000;
/** Concurrent shard calls per provider and per engine, and the queue behind them: the Milvus and Qdrant bounds, one permit per shard call. */
export const OXIA_LIMITER_OPTIONS = { perProvider: 4, perEngine: 16, queueDepth: 64 } as const;

/** Rounds folder discovery may run before it ends with the folders found so far. */
export const OXIA_DISCOVERY_MAX_ROUNDS = 256;
/** Shard calls folder discovery may make in all. */
export const OXIA_DISCOVERY_MAX_CALLS = 2_048;
/** The deadline of folder discovery. */
export const OXIA_DISCOVERY_DEADLINE_MS = 3_000;

/** `list --limit` when the command names none. */
export const OXIA_LIST_DEFAULT_LIMIT = 500;
/** `range-scan --limit` when the command names none. */
export const OXIA_SCAN_DEFAULT_LIMIT = 100;
/**
 * The largest `--limit` a console command may ask. A literal rather than an import of `DEFAULT_QUERY_LIMIT`: the
 * query limiter's module imports the SQL readers, which a browser-safe module may not pull in, and the console's test
 * holds the two equal.
 */
export const OXIA_MAX_LIMIT = 500;
/** Bytes of one console command's text. */
export const OXIA_MAX_TEXT_BYTES = 65_536;
/** Characters of a typed word a sentence echoes; never more. */
export const OXIA_ECHO_WORD_CHARS = 40;
/** Characters one grid cell holds. */
export const OXIA_CELL_LIMIT = 65_536;
/** Bytes of a value the Source tab dumps as hex. */
export const OXIA_SOURCE_HEX_BYTES = 65_536;
/** Characters of a key a sentence shows. */
export const OXIA_SHOWN_KEY_CHARS = 120;
/** Keys a Keys panel page asks when the caller names no count. */
export const OXIA_KEY_SCAN_DEFAULT_COUNT = 500;
/** The most keys a Keys panel page may ask. */
export const OXIA_KEY_SCAN_MAX_COUNT = 1_000;
