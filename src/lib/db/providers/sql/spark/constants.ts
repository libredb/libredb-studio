/**
 * Every fixed number and fixed identity value of the Apache Spark provider.
 * Pure: no I/O, no logger (tests/unit/db/spark/seam-guard.test.ts).
 */

/** Spark Connect's port unless the server was started on another. */
export const SPARK_DEFAULT_PORT = 15002;
/** The TLS name an IP identity is checked as: `.invalid` belongs to no host (RFC 6761); Node 25+ and Bun refuse an IP as a server name. */
export const SPARK_IP_SERVER_NAME = "spark.invalid";
/** Spark's built-in session catalog, the default of spark.sql.defaultCatalog. */
export const SPARK_SESSION_CATALOG = "spark_catalog";
/** The version floor: result chunking, which Studio needs to read large results, arrived in 4.1.0 (SPARK-53525). */
export const SPARK_MIN_VERSION = { major: 4, minor: 1, patch: 0 } as const;

/** One gRPC message: the cap every gRPC provider passes. */
export const SPARK_RECEIVE_CAP_BYTES = 16_777_216;
/** The preferred Arrow chunk size each ExecutePlan asks for, and the session's maxChunkSize. */
export const SPARK_ARROW_CHUNK_BYTES = 4_194_304;
/** Rows per relation batch, chosen from the measured read cost. */
export const SPARK_ARROW_MAX_RECORDS_PER_BATCH = 1_000;
/** Decoded cost kept per statement, Snowflake's budget. */
export const SPARK_RESULT_BYTE_BUDGET = 16_777_216;
/** The heap a kept batch holds beyond its values, measured at about 810 bytes for a one-row batch, rounded up. */
export const SPARK_BATCH_OVERHEAD_BYTES = 1_024;
/** Bytes received per ExecutePlan stream: the budget plus one relation batch. */
export const SPARK_STREAM_MAX_RECEIVED_BYTES = 33_554_432;
/** The largest IPC message metadata the stream check reads. */
export const SPARK_IPC_METADATA_MAX_BYTES = 1_048_576;
/** Schema depth and field count, for the Arrow schema and the DataType proto. */
export const SPARK_SCHEMA_MAX_DEPTH = 64;
export const SPARK_SCHEMA_MAX_FIELDS = 10_000;

/** One unary Config call per interval while a call is open; 15 s is under the 20 s measured worst case. */
export const SPARK_HEARTBEAT_INTERVAL_MS = 15_000;
export const SPARK_HEARTBEAT_DEADLINE_MS = 5_000;
/** Config, Interrupt, ReleaseSession, FetchErrorDetails and AnalyzePlan, from the moment each is sent. */
export const SPARK_CONTROL_DEADLINE_MS = 10_000;

/** The fixed identity of every request: never a Studio user's name. */
export const SPARK_USER_CONTEXT = { user_id: "libredb-studio", user_name: "libredb-studio" } as const;
export const SPARK_CLIENT_TYPE = "libredb-studio";
/** A run's tag is this prefix and a random UUID; a tag holds no comma (base.proto ExecutePlanRequest field 7). */
export const SPARK_RUN_TAG_PREFIX = "libredb-studio-";

/**
 * Sent by Config `set` on every new session, in this order. Every key is settable at run time on
 * 4.1.3 and 4.2.0, accepted in one call and read back as sent.
 */
export const SPARK_SESSION_CONF: readonly (readonly [string, string])[] = [
  // ${...} is never expanded, so the text Spark parses is the text the confirmation gate read.
  ["spark.sql.variable.substitute", "false"],
  // A server-wide codec never compresses Studio's results.
  ["spark.sql.execution.arrow.compression.codec", "none"],
  // String and binary columns arrive as Utf8 and Binary.
  ["spark.sql.execution.arrow.useLargeVarTypes", "false"],
  // Spark chunks only while this is above 0 and honours the preferred size only up to it.
  ["spark.connect.session.resultChunking.maxChunkSize", "4194304"],
  ["spark.sql.execution.arrow.maxRecordsPerBatch", "1000"],
  // Spark's default; a server default cannot silence a run's stream.
  ["spark.connect.progress.reportInterval", "2s"],
  // Spark's default; without it an error carries no errorId.
  ["spark.sql.connect.enrichError.enabled", "true"],
];

/** Sent in the same Config call on the metadata session only. */
export const SPARK_METADATA_SESSION_CONF: readonly (readonly [string, string])[] = [
  // SHOW NAMESPACES and SHOW TABLES answer the column names introspection reads.
  ["spark.sql.legacy.keepCommandOutputSchema", "false"],
  // DESCRIBE spells a struct type whole.
  ["spark.sql.debug.maxToStringFields", "10000"],
];

/** The nested namespace walk's bounds. */
export const SPARK_NAMESPACE_WALK_MAX = 1_000;
export const SPARK_NAMESPACE_MAX_PARTS = 8;
export const SPARK_DESCRIBE_OBJECTS_MAX = 1_000;
/** Metadata statements in flight at once on one connection, and the size of the namespace walk's batches. */
export const SPARK_INTROSPECT_IN_FLIGHT_MAX = 8;
/** FetchErrorDetails: one root, at most 5 causes of at most 1,024 characters. */
export const SPARK_ERROR_CAUSES_MAX = 5;
export const SPARK_ERROR_CAUSE_MAX_CHARS = 1_024;
/** The most of a server's version text a version sentence quotes, in code points (errors.ts sparkVersionText). */
export const SPARK_VERSION_TEXT_MAX_CHARS = 64;
/** grpc-status-details-bin: at most 64 KiB, 16 details, 8 KiB per map value. */
export const SPARK_STATUS_DETAILS_MAX_BYTES = 65_536;
export const SPARK_STATUS_DETAILS_MAX_ENTRIES = 16;
export const SPARK_STATUS_DETAILS_VALUE_MAX_BYTES = 8_192;
/**
 * Probe sessions a server below the floor keeps, by connection id and configured endpoint, the far end under an SSH
 * tunnel.
 */
export const SPARK_REFUSED_SESSION_MAP_MAX = 256;
