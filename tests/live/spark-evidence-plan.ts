/**
 * The capture catalog of the Apache Spark evidence harness, its sample data and the session settings it sends, in the
 * role tests/live/snowflake-evidence-plan.ts plays for Snowflake.
 *
 * Every capture is one RPC exchange in a fresh session. A query flows over two ExecutePlan calls, the command step and
 * the relation step, and the integration replay needs both, so a relation-step capture names the capture of its command
 * step. The replay also sends every statement an entry runs before its capture, so each of those is captured under its
 * own name; a statement runs uncaptured only when another entry captures it, as set-catalog does the session setup's
 * SET CATALOG, or no replay sends it. The session settings are copies of the provider's SPARK_SESSION_CONF and
 * SPARK_METADATA_SESSION_CONF, held to the same values by tests/unit/db/spark/capture-catalog.test.ts, because the
 * harness never imports the provider: a capture records what Spark sent independently of the code under test.
 */
import type { SparkLiveService } from "../helpers/spark-live";

export const SPARK_CAPTURE_NAMES = [
  // on 4.2.0 and 4.1.3
  "connect-version",
  "connect-session-setup",
  "request-session-setup",
  "connect-current-namespace",
  "set-catalog",
  "use-namespace",
  "use-namespace-current",
  "connect-current-namespace-studio",
  "session-conf-readback",
  "tokenless-connect",
  "every-type-command",
  "every-type-relation",
  "time-type-refused-command",
  "time-type-refused",
  "time-type-refused-details",
  "show-tables-inline",
  "explain-formatted",
  "large-var-types-set",
  "large-var-types-refused-command",
  "large-var-types-refused",
  "negative-scale-decimal-command",
  "negative-scale-decimal",
  "batch-rows-command",
  "batch-rows",
  "release-session",
  "cancel-interrupt-command",
  "cancel-interrupt",
  "cancel-interrupt-relation",
  "show-catalogs",
  "config-catalog-keys",
  "show-namespaces",
  "show-namespaces-unloaded",
  "show-namespaces-unloaded-details",
  "show-tables-default",
  "show-views-default",
  "show-user-functions-default",
  // on 4.2.0 only
  "auth-no-token",
  "auth-wrong-token",
  "row-budget-cut-command",
  "row-budget-cut",
  "temp-view-create",
  "temp-view-script-command",
  "temp-view-script",
  "error-syntax",
  "error-syntax-details",
  "error-missing-table",
  "error-missing-table-details",
  "error-permission-denied",
  "error-permission-denied-details",
  "error-max-result-size-command",
  "error-max-result-size",
  "error-max-result-size-details",
  "session-closed",
  "session-closed-show-catalogs",
  "substitution-set",
  "substitution-off-command",
  "substitution-off",
  "compressed-zstd-set",
  "compressed-zstd-command",
  "compressed-zstd",
  "compressed-lz4-set",
  "compressed-lz4-command",
  "compressed-lz4",
  "show-tables",
  "show-views",
  "show-user-functions",
  "show-user-functions-quoted",
  "describe-table",
  "describe-view",
  "describe-table-struct30",
  "show-create-table",
  "show-create-view",
  "show-create-table-missing",
  "show-create-table-missing-details",
  "overview-app-conf",
  "proxy-silent-timeout-command",
  "proxy-silent-timeout",
  "command-over-batch-bound",
] as const;

export type SparkCaptureName = (typeof SPARK_CAPTURE_NAMES)[number];
export type SparkCaptureVersionDir = "4.2.0" | "4.1.3";

/** The namespace the sample statements fill. */
export const SPARK_SAMPLE_NAMESPACE = "studio";

/** Copies of the provider's session settings, in the order the provider sends them. */
export const SPARK_CAPTURE_SESSION_CONF: readonly (readonly [string, string])[] = [
  ["spark.sql.variable.substitute", "false"],
  ["spark.sql.execution.arrow.compression.codec", "none"],
  ["spark.sql.execution.arrow.useLargeVarTypes", "false"],
  ["spark.connect.session.resultChunking.maxChunkSize", "4194304"],
  ["spark.sql.execution.arrow.maxRecordsPerBatch", "1000"],
  ["spark.connect.progress.reportInterval", "2s"],
  ["spark.sql.connect.enrichError.enabled", "true"],
];
export const SPARK_CAPTURE_METADATA_SESSION_CONF: readonly (readonly [string, string])[] = [
  ["spark.sql.legacy.keepCommandOutputSchema", "false"],
  ["spark.sql.debug.maxToStringFields", "10000"],
];

/** The image each service runs, as database-compose.yml pins it; spark-tls is answered by spark-auth's server. */
export const SPARK_SERVICE_IMAGES: Readonly<
  Record<SparkLiveService, { readonly image: string; readonly digest: string }>
> = {
  spark: {
    image: "apache/spark:4.2.0",
    digest: "sha256:fc64959c04bd87b0ac686be9aaa9008b69cdb1afc695400528279c8b01f43d89",
  },
  "spark-4-1": {
    image: "apache/spark:4.1.3",
    digest: "sha256:bf9d035a7c32a8ca46aa58d6348182ffd7d2dff6409206ecfbb3915ff1fef211",
  },
  "spark-auth": {
    image: "apache/spark:4.2.0",
    digest: "sha256:fc64959c04bd87b0ac686be9aaa9008b69cdb1afc695400528279c8b01f43d89",
  },
  "spark-tls": {
    image: "apache/spark:4.2.0",
    digest: "sha256:fc64959c04bd87b0ac686be9aaa9008b69cdb1afc695400528279c8b01f43d89",
  },
};

const pinned = (service: SparkLiveService) =>
  `${SPARK_SERVICE_IMAGES[service].image}@${SPARK_SERVICE_IMAGES[service].digest}`;

/**
 * The container of database-compose.yml each service's target must be published by, the image it runs and the
 * container port behind the target. The harness dials a target only once `docker port` lists it for that container, so
 * a loopback port that leads anywhere else is refused; spark-tls's proxy is checked with the spark-auth server behind it.
 */
export const SPARK_FIXTURE_CONTAINERS: Readonly<
  Record<SparkLiveService, { readonly container: string; readonly image: string; readonly port: number }>
> = {
  spark: { container: "libredb-spark", image: pinned("spark"), port: 15002 },
  "spark-4-1": { container: "libredb-spark-4-1", image: pinned("spark-4-1"), port: 15002 },
  "spark-auth": { container: "libredb-spark-auth", image: pinned("spark-auth"), port: 15002 },
  "spark-tls": {
    container: "libredb-spark-tls",
    image:
      "public.ecr.aws/docker/library/nginx:stable-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94",
    port: 15005,
  },
};

const WIDE_STRUCT_FIELDS = Array.from({ length: 30 }, (_, index) => `f${index + 1}: INT`).join(", ");

/**
 * Idempotent statements that create the sample objects: run by `--setup <service>` after every start, because the
 * standalone server's catalog is in memory. `every_type` holds every type of the type table in docs/providers/spark.md
 * that a table stores; the void column and the calendar interval are added by SPARK_EVERY_TYPE_SELECT, since no table
 * stores them.
 */
export const SPARK_SAMPLE_STATEMENTS: readonly string[] = [
  "CREATE NAMESPACE IF NOT EXISTS spark_catalog.studio",
  "CREATE NAMESPACE IF NOT EXISTS spark_catalog.studio_empty",
  "CREATE NAMESPACE IF NOT EXISTS spark_catalog.studio_unloaded",
  "CREATE NAMESPACE IF NOT EXISTS spark_catalog.studio_functions",
  "CREATE TABLE IF NOT EXISTS spark_catalog.studio.every_type (c_boolean BOOLEAN, c_tinyint TINYINT, c_smallint SMALLINT, c_int INT, c_bigint_safe BIGINT, c_bigint_large BIGINT, c_float FLOAT, c_double DOUBLE, c_double_nan DOUBLE, c_double_inf DOUBLE, c_decimal DECIMAL(10,2), c_decimal_neg DECIMAL(4,2), c_decimal_38 DECIMAL(38,0), c_string STRING, c_string_collated STRING COLLATE UTF8_LCASE, c_char CHAR(5), c_varchar VARCHAR(10), c_binary BINARY, c_date DATE, c_date_min DATE, c_timestamp TIMESTAMP, c_timestamp_ntz TIMESTAMP_NTZ, c_ym_interval INTERVAL YEAR TO MONTH, c_year_interval INTERVAL YEAR, c_dt_interval INTERVAL DAY TO SECOND, c_hour_interval INTERVAL HOUR, c_array ARRAY<INT>, c_map MAP<STRING, INT>, c_map_nested_key MAP<ARRAY<INT>, STRING>, c_struct STRUCT<x: INT, y: STRING>, c_variant VARIANT, c_null_int INT) USING parquet",
  "INSERT OVERWRITE TABLE spark_catalog.studio.every_type VALUES (true, -7Y, -300S, -70000, 9007199254740991L, 9223372036854775807L, CAST(0.1 AS FLOAT), 1.5D, CAST('NaN' AS DOUBLE), CAST('Infinity' AS DOUBLE), 12345678.91BD, -0.05BD, CAST('12345678901234567890123456789012345678' AS DECIMAL(38,0)), 'héllo, wörld', 'Ab', 'ab', 'abc', X'00FF10', DATE'2026-10-13', DATE'0001-01-01', TIMESTAMP'2026-10-13 12:34:56.789', TIMESTAMP_NTZ'2026-10-13 12:34:56.123456', INTERVAL '3-7' YEAR TO MONTH, INTERVAL '3' YEAR, INTERVAL '1 02:03:04.567891' DAY TO SECOND, INTERVAL '26' HOUR, array(1, 2, NULL), map('a', 1, 'b', 2), map(array(1), 'x'), named_struct('x', 1, 'y', 'two'), parse_json('{\"b\": 1.10, \"a\": [true, null]}'), NULL)",
  "CREATE OR REPLACE VIEW spark_catalog.studio.every_type_view AS SELECT c_int, c_string FROM spark_catalog.studio.every_type",
  `CREATE TABLE IF NOT EXISTS spark_catalog.studio.wide_struct (s STRUCT<${WIDE_STRUCT_FIELDS}>) USING parquet`,
  "CREATE OR REPLACE FUNCTION spark_catalog.studio.f1(x INT) RETURNS INT RETURN x + 1",
  "CREATE OR REPLACE FUNCTION spark_catalog.studio_functions.`f.x`() RETURNS INT RETURN 1",
  "CREATE OR REPLACE FUNCTION spark_catalog.studio_functions.`f y`() RETURNS INT RETURN 2",
  "CREATE OR REPLACE FUNCTION spark_catalog.studio_functions.`f``q`() RETURNS INT RETURN 3",
  "CREATE OR REPLACE FUNCTION spark_catalog.studio_functions.F2() RETURNS INT RETURN 4",
];

/** The every-type SELECT: the 32 stored columns, then void and the calendar interval; 34, no TIME. */
export const SPARK_EVERY_TYPE_SELECT =
  "SELECT t.*, NULL AS c_void, make_interval(1, 2, 3, 4, 5, 6, 7.000008) AS c_calendar_interval FROM spark_catalog.studio.every_type AS t";

export type SparkCaptureAction =
  /** AnalyzePlan spark_version. */
  | { readonly kind: "version" }
  /** The session's own setup Config set, captured: seven pairs, or nine on the metadata session. */
  | { readonly kind: "config-set"; readonly metadata: boolean }
  | { readonly kind: "config-get"; readonly keys: readonly string[] }
  | { readonly kind: "config-get-all"; readonly prefix: string }
  /** One statement; `command` captures ExecutePlan 1, `relation` captures ExecutePlan 2 and, when named, ExecutePlan 1. */
  | {
      readonly kind: "statement";
      readonly sql: string;
      readonly step: "command" | "relation";
      readonly commandName?: SparkCaptureName;
    }
  /** A query interrupted by tag after its relation step's first response: `<name>-command`, `<name>`, `<name>-relation`. */
  | { readonly kind: "interrupt"; readonly sql: string }
  | { readonly kind: "release" }
  /** A call on a session released just before: a Config get_option, or with `sql` its command step. */
  | { readonly kind: "after-release"; readonly sql?: string }
  /**
   * One run: `sql`'s failing step under the entry's name, then FetchErrorDetails of that failure's errorId in the same
   * session under `<name>-details`, so the replay's request carries the errorId of the failure it replays. The failing
   * step is the command step; with `commandName` the command step passes, captured under that name, and the relation
   * step fails.
   */
  | { readonly kind: "fetch-error-details"; readonly sql: string; readonly commandName?: SparkCaptureName };

/** A statement run before an entry's capture that the replay sends too: its command step is captured under `name`. */
export interface SparkBeforeStatement {
  readonly name: SparkCaptureName;
  readonly sql: string;
}

export interface SparkCaptureEntry {
  readonly name: SparkCaptureName;
  readonly versions: readonly SparkCaptureVersionDir[];
  /** The 4.2.0 service; the 4.1.3 capture of an entry runs against spark-4-1. */
  readonly service: Exclude<SparkLiveService, "spark-4-1">;
  readonly token: "configured" | "none" | "wrong";
  readonly surface: string;
  /** The setup sent first and not captured: "user" (seven pairs), "metadata" (nine pairs) or "none". */
  readonly session: "user" | "metadata" | "none";
  /** Config pairs set after the setup, not captured. */
  readonly conf?: readonly (readonly [string, string])[];
  /** Statements run after the setup in the same session, each answered inline and captured, expecting pass. */
  readonly before?: readonly SparkBeforeStatement[];
  /**
   * Statements run after the setup and not captured by this entry: a setup step another entry captures, or a statement
   * no replay sends (held by capture-catalog.test.ts).
   */
  readonly uncaptured?: readonly string[];
  readonly action: SparkCaptureAction;
  /** The outcome of the capture named `name`; any other stops the run, so a surprise is reported, not recorded. */
  readonly expect: "pass" | "error";
}

const BOTH: readonly SparkCaptureVersionDir[] = ["4.2.0", "4.1.3"];
const NEWEST: readonly SparkCaptureVersionDir[] = ["4.2.0"];
const ALL_NINE = [...SPARK_CAPTURE_SESSION_CONF, ...SPARK_CAPTURE_METADATA_SESSION_CONF].map(([key]) => key);
/**
 * The command answer of command-over-batch-bound: SHOW TABLES over 200 temp views whose names are about 4,000
 * characters, about 800 KB in rows. Spark closes an inline answer's batch once its estimate passes the bound, so the
 * answer needs many rows; one wide row, such as a SET of a long value, always fits in one batch and passes.
 */
const WIDE_TEMP_VIEWS = Array.from(
  { length: 200 },
  (_, index) =>
    `CREATE OR REPLACE TEMP VIEW studio_wide_${String(index).padStart(3, "0")}_${"w".repeat(4000)} AS SELECT 1 AS x`,
);
const LONG_RUN = "SELECT count(*) AS n FROM range(0, 20000000000, 1, 4)";

export const SPARK_CAPTURE_CATALOG: readonly SparkCaptureEntry[] = [
  {
    name: "connect-version",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "none",
    surface: "connect: AnalyzePlan spark_version on a fresh session",
    action: { kind: "version" },
    expect: "pass",
  },
  {
    name: "connect-session-setup",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "none",
    surface: "connect: the metadata session's Config set of nine pairs",
    action: { kind: "config-set", metadata: true },
    expect: "pass",
  },
  {
    name: "request-session-setup",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "none",
    surface: "a request session's Config set of seven pairs",
    action: { kind: "config-set", metadata: false },
    expect: "pass",
  },
  {
    name: "connect-current-namespace",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "connect: SHOW CURRENT NAMESPACE on the metadata session",
    action: { kind: "statement", sql: "SHOW CURRENT NAMESPACE", step: "command" },
    expect: "pass",
  },
  {
    name: "set-catalog",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    surface: "session setup step 2: SET CATALOG as a string literal",
    action: { kind: "statement", sql: "SET CATALOG 'spark_catalog'", step: "command" },
    expect: "pass",
  },
  {
    name: "use-namespace",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    uncaptured: ["SET CATALOG 'spark_catalog'"],
    surface: "session setup step 3: USE NAMESPACE",
    action: { kind: "statement", sql: "USE NAMESPACE `studio`", step: "command" },
    expect: "pass",
  },
  {
    name: "use-namespace-current",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    uncaptured: ["SET CATALOG 'spark_catalog'", "USE NAMESPACE studio_unloaded"],
    surface: "SHOW CURRENT NAMESPACE after USE NAMESPACE studio_unloaded",
    action: { kind: "statement", sql: "SHOW CURRENT NAMESPACE", step: "command" },
    expect: "pass",
  },
  {
    name: "connect-current-namespace-studio",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "metadata",
    // The two setup statements a connection with Catalog spark_catalog and Namespace studio sends, which set-catalog
    // and use-namespace capture.
    uncaptured: ["SET CATALOG 'spark_catalog'", "USE NAMESPACE `studio`"],
    surface: "connect with a catalog and a namespace: SHOW CURRENT NAMESPACE on the metadata session, in studio",
    action: { kind: "statement", sql: "SHOW CURRENT NAMESPACE", step: "command" },
    expect: "pass",
  },
  {
    name: "session-conf-readback",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "Config get of the nine keys after the setup",
    action: { kind: "config-get", keys: ALL_NINE },
    expect: "pass",
  },
  {
    name: "tokenless-connect",
    versions: BOTH,
    service: "spark",
    token: "configured",
    session: "none",
    surface: "a tokenless server answers a call that carries a token",
    action: { kind: "version" },
    expect: "pass",
  },
  {
    name: "every-type-command",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    surface: "every-type SELECT",
    action: { kind: "statement", sql: SPARK_EVERY_TYPE_SELECT, step: "command" },
    expect: "pass",
  },
  {
    name: "every-type-relation",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    surface: "every-type SELECT",
    action: { kind: "statement", sql: SPARK_EVERY_TYPE_SELECT, step: "relation" },
    expect: "pass",
  },
  {
    name: "time-type-refused",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    surface: "a TIME literal with TIME values off",
    action: {
      kind: "fetch-error-details",
      sql: "SELECT TIME'12:34:56' AS t",
      commandName: "time-type-refused-command",
    },
    expect: "error",
  },
  {
    name: "show-tables-inline",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    surface: "a command answered inline with no Spark job",
    action: { kind: "statement", sql: "SHOW TABLES IN spark_catalog.studio", step: "command" },
    expect: "pass",
  },
  {
    name: "explain-formatted",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    surface: "EXPLAIN FORMATTED of a never-run SELECT",
    action: {
      kind: "statement",
      sql: "EXPLAIN FORMATTED SELECT c_int, c_string FROM spark_catalog.studio.every_type WHERE c_int > 0",
      step: "command",
    },
    expect: "pass",
  },
  {
    name: "large-var-types-refused",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    before: [{ name: "large-var-types-set", sql: "SET spark.sql.execution.arrow.useLargeVarTypes=true" }],
    surface: "a SELECT after a session SET of useLargeVarTypes=true",
    action: {
      kind: "statement",
      sql: "SELECT 'x' AS v, X'01' AS b",
      step: "relation",
      commandName: "large-var-types-refused-command",
    },
    expect: "pass",
  },
  {
    name: "negative-scale-decimal",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    conf: [["spark.sql.legacy.allowNegativeScaleOfDecimal", "true"]],
    surface: "1E10BD under allowNegativeScaleOfDecimal",
    action: {
      kind: "statement",
      sql: "SELECT 1E10BD AS d",
      step: "relation",
      commandName: "negative-scale-decimal-command",
    },
    expect: "pass",
  },
  {
    name: "batch-rows",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    surface: "2,500 rows in batches of maxRecordsPerBatch",
    action: {
      kind: "statement",
      sql: "FROM range(0, 2500, 1, 1) SELECT id",
      step: "relation",
      commandName: "batch-rows-command",
    },
    expect: "pass",
  },
  {
    name: "release-session",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    surface: "ReleaseSession at the end of a request",
    action: { kind: "release" },
    expect: "pass",
  },
  {
    name: "auth-no-token",
    versions: NEWEST,
    service: "spark-auth",
    token: "none",
    session: "none",
    surface: "a call without a token to a token server",
    action: { kind: "version" },
    expect: "error",
  },
  {
    name: "auth-wrong-token",
    versions: NEWEST,
    service: "spark-auth",
    token: "wrong",
    session: "none",
    surface: "a call with a wrong token",
    action: { kind: "version" },
    expect: "error",
  },
  {
    name: "row-budget-cut",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "user",
    surface: "100,001 bigint rows, FROM-led, which the row budget cuts",
    action: {
      kind: "statement",
      sql: "FROM range(0, 100001, 1, 1) SELECT id",
      step: "relation",
      commandName: "row-budget-cut-command",
    },
    expect: "pass",
  },
  {
    name: "temp-view-script",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "user",
    before: [{ name: "temp-view-create", sql: "CREATE OR REPLACE TEMP VIEW studio_temp_v AS SELECT 1 AS x" }],
    surface: "a temp view made by one statement, read by the next",
    action: {
      kind: "statement",
      sql: "SELECT x FROM studio_temp_v",
      step: "relation",
      commandName: "temp-view-script-command",
    },
    expect: "pass",
  },
  {
    name: "error-syntax",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "user",
    surface: "a syntax error with ErrorInfo",
    action: { kind: "fetch-error-details", sql: "SELEC 1" },
    expect: "error",
  },
  {
    name: "error-missing-table",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "user",
    surface: "a missing table",
    action: { kind: "fetch-error-details", sql: "SELECT * FROM spark_catalog.studio.no_such_table" },
    expect: "error",
  },
  {
    name: "error-permission-denied",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "user",
    surface: "a file the server's user cannot read",
    action: { kind: "fetch-error-details", sql: "SELECT * FROM csv.`file:///tmp/studio-unreadable/data.csv`" },
    expect: "error",
  },
  {
    name: "error-max-result-size",
    versions: NEWEST,
    service: "spark-auth",
    token: "configured",
    session: "user",
    surface: "a result above spark.driver.maxResultSize=4m",
    action: {
      kind: "fetch-error-details",
      sql: "SELECT id, repeat('x', 1000) AS v FROM range(0, 20000, 1, 4)",
      commandName: "error-max-result-size-command",
    },
    expect: "error",
  },
  {
    name: "cancel-interrupt",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "user",
    surface: "Interrupt by tag of a running statement",
    action: { kind: "interrupt", sql: LONG_RUN },
    expect: "pass",
  },
  {
    name: "session-closed",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "user",
    surface: "a call on a released session",
    action: { kind: "after-release" },
    expect: "error",
  },
  {
    name: "session-closed-show-catalogs",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "a metadata read on a released session: SHOW CATALOGS",
    action: { kind: "after-release", sql: "SHOW CATALOGS" },
    expect: "error",
  },
  {
    name: "substitution-off",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "user",
    before: [{ name: "substitution-set", sql: "SET x=1" }],
    surface: "SELECT '${x}' with substitution off",
    action: { kind: "statement", sql: "SELECT '${x}' AS v", step: "relation", commandName: "substitution-off-command" },
    expect: "pass",
  },
  {
    name: "compressed-zstd",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "user",
    before: [{ name: "compressed-zstd-set", sql: "SET spark.sql.execution.arrow.compression.codec=zstd" }],
    surface: "a result after a session SET of the codec to zstd",
    action: {
      kind: "statement",
      sql: "SELECT id, 'x' AS v FROM range(0, 3, 1, 1)",
      step: "relation",
      commandName: "compressed-zstd-command",
    },
    expect: "pass",
  },
  {
    name: "compressed-lz4",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "user",
    before: [{ name: "compressed-lz4-set", sql: "SET spark.sql.execution.arrow.compression.codec=lz4" }],
    surface: "a result after a session SET of the codec to lz4",
    action: {
      kind: "statement",
      sql: "SELECT id, 'x' AS v FROM range(0, 3, 1, 1)",
      step: "relation",
      commandName: "compressed-lz4-command",
    },
    expect: "pass",
  },
  {
    name: "show-catalogs",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "tree: SHOW CATALOGS",
    action: { kind: "statement", sql: "SHOW CATALOGS", step: "command" },
    expect: "pass",
  },
  {
    name: "config-catalog-keys",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "tree: Config get_all of spark.sql.catalog., values written <value>",
    action: { kind: "config-get-all", prefix: "spark.sql.catalog." },
    expect: "pass",
  },
  {
    name: "show-namespaces",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "tree: SHOW NAMESPACES IN spark_catalog",
    action: { kind: "statement", sql: "SHOW NAMESPACES IN `spark_catalog`", step: "command" },
    expect: "pass",
  },
  {
    name: "show-namespaces-unloaded",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "agent grounding walk: SHOW NAMESPACES IN studio_unloaded, a configured catalog Spark cannot load",
    action: { kind: "fetch-error-details", sql: "SHOW NAMESPACES IN `studio_unloaded`" },
    expect: "error",
  },
  {
    name: "show-tables",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "tree and object surface: SHOW TABLES",
    action: { kind: "statement", sql: "SHOW TABLES IN `spark_catalog`.`studio`", step: "command" },
    expect: "pass",
  },
  {
    name: "show-views",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "tree and object surface: SHOW VIEWS",
    action: { kind: "statement", sql: "SHOW VIEWS IN `spark_catalog`.`studio`", step: "command" },
    expect: "pass",
  },
  {
    name: "show-tables-default",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "overview: SHOW TABLES of the current namespace, for the table count",
    action: { kind: "statement", sql: "SHOW TABLES IN `spark_catalog`.`default`", step: "command" },
    expect: "pass",
  },
  {
    name: "show-views-default",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "overview: SHOW VIEWS of the current namespace, for the table count",
    action: { kind: "statement", sql: "SHOW VIEWS IN `spark_catalog`.`default`", step: "command" },
    expect: "pass",
  },
  {
    name: "show-user-functions-default",
    versions: BOTH,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "agent grounding walk: SHOW USER FUNCTIONS of the current namespace, for its count",
    action: { kind: "statement", sql: "SHOW USER FUNCTIONS IN `spark_catalog`.`default`", step: "command" },
    expect: "pass",
  },
  {
    name: "show-user-functions",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "tree and object surface: SHOW USER FUNCTIONS",
    action: { kind: "statement", sql: "SHOW USER FUNCTIONS IN `spark_catalog`.`studio`", step: "command" },
    expect: "pass",
  },
  {
    name: "show-user-functions-quoted",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "function names that need quoting",
    action: { kind: "statement", sql: "SHOW USER FUNCTIONS IN `spark_catalog`.`studio_functions`", step: "command" },
    expect: "pass",
  },
  {
    name: "describe-table",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "object surface: DESCRIBE TABLE every_type",
    action: { kind: "statement", sql: "DESCRIBE TABLE `spark_catalog`.`studio`.`every_type`", step: "command" },
    expect: "pass",
  },
  {
    name: "describe-view",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "object surface: DESCRIBE TABLE every_type_view",
    action: { kind: "statement", sql: "DESCRIBE TABLE `spark_catalog`.`studio`.`every_type_view`", step: "command" },
    expect: "pass",
  },
  {
    name: "describe-table-struct30",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "object surface: DESCRIBE TABLE wide_struct, its 30-field struct whole",
    action: { kind: "statement", sql: "DESCRIBE TABLE `spark_catalog`.`studio`.`wide_struct`", step: "command" },
    expect: "pass",
  },
  {
    name: "show-create-table",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "source: SHOW CREATE TABLE of a table",
    action: { kind: "statement", sql: "SHOW CREATE TABLE `spark_catalog`.`studio`.`every_type`", step: "command" },
    expect: "pass",
  },
  {
    name: "show-create-view",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "source: SHOW CREATE TABLE of a view",
    action: { kind: "statement", sql: "SHOW CREATE TABLE `spark_catalog`.`studio`.`every_type_view`", step: "command" },
    expect: "pass",
  },
  {
    name: "show-create-table-missing",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "source: SHOW CREATE TABLE of a table that does not exist",
    action: { kind: "fetch-error-details", sql: "SHOW CREATE TABLE `spark_catalog`.`studio`.`no_such_table`" },
    expect: "error",
  },
  {
    name: "overview-app-conf",
    versions: NEWEST,
    service: "spark",
    token: "none",
    session: "metadata",
    surface: "overview: Config get_all of spark.app.",
    action: { kind: "config-get-all", prefix: "spark.app." },
    expect: "pass",
  },
  {
    name: "proxy-silent-timeout",
    versions: NEWEST,
    service: "spark-tls",
    token: "configured",
    session: "user",
    conf: [["spark.connect.progress.reportInterval", "-1"]],
    surface: "a silent run of about 15 s through the TLS proxy, under its 300 s read timeout",
    action: {
      kind: "statement",
      sql: "SELECT sum(hash(id)) AS n FROM range(0, 25000000000, 1, 4)",
      step: "relation",
      commandName: "proxy-silent-timeout-command",
    },
    expect: "pass",
  },
  {
    name: "command-over-batch-bound",
    versions: NEWEST,
    service: "spark-auth",
    token: "configured",
    session: "user",
    uncaptured: WIDE_TEMP_VIEWS,
    surface: "a command answer above 0.7 times spark.connect.grpc.arrow.maxBatchSize=1m",
    action: { kind: "statement", sql: "SHOW TABLES", step: "command" },
    expect: "error",
  },
];

/** Every capture an entry writes, its own name first, then its other steps, then the statements run before it. */
export function capturesOf(entry: SparkCaptureEntry): SparkCaptureName[] {
  const { action } = entry;
  const before = (entry.before ?? []).map((statement) => statement.name);
  if (action.kind === "interrupt") {
    return [
      entry.name,
      `${entry.name}-command` as SparkCaptureName,
      `${entry.name}-relation` as SparkCaptureName,
      ...before,
    ];
  }
  if (action.kind === "fetch-error-details") {
    const command = action.commandName === undefined ? [] : [action.commandName];
    return [entry.name, `${entry.name}-details` as SparkCaptureName, ...command, ...before];
  }
  if (action.kind === "statement" && action.commandName !== undefined)
    return [entry.name, action.commandName, ...before];
  return [entry.name, ...before];
}
