import { type LucideIcon } from "lucide-react";
import {
  PostgreSQLIcon,
  MySQLIcon,
  SQLiteIcon,
  MongoDBIcon,
  RedisIcon,
  OracleIcon,
  MSSQLIcon,
  LibreDBIcon,
  ModbusIcon,
  MtconnectIcon,
  NetconfIcon,
  SparkplugIcon,
  OpcuaIcon,
  SnmpIcon,
  CouchbaseIcon,
  ClickHouseIcon,
  DruidIcon,
  ElasticsearchIcon,
  OpenSearchIcon,
  TrinoIcon,
  CassandraIcon,
  LibSQLIcon,
  DuckDBIcon,
  PrometheusIcon,
  KafkaIcon,
  EtcdIcon,
  Db2Icon,
  Neo4jIcon,
  QdrantIcon,
  WeaviateIcon,
  MilvusIcon,
  InfluxDBIcon,
  OxiaIcon,
  DatabendIcon,
  BigQueryIcon,
  S3Icon,
  MqttIcon,
  FirestoreIcon,
  RabbitMQIcon,
  KubernetesIcon,
  SnowflakeIcon,
  SparkIcon,
} from "@/components/icons/db-icons";
import type { HostUriScheme } from "@/lib/connection-host-uri";
import type { ConnectionField } from "@/lib/db/connection-fields";
import { CONNECTION_FORM, type ConnectionFormSpec, type FieldPlacementDeclaration } from "@/lib/db/connection-form";
import type { DatabaseType } from "@/lib/types";

export {
  connectionFieldHint,
  connectionFieldLabel,
  connectionFieldPlaceholder,
  connectionFieldPlacement,
  connectionFieldRefusal,
  connectionFieldShown,
  DATABEND_FIELD_HINTS,
  DATABEND_FIELD_RULES,
  type FieldPlacementDeclaration,
  KUBERNETES_FIELD_HINTS,
  KUBERNETES_FIELD_RULES,
  offersSslPanel,
  RABBITMQ_FIELD_HINTS,
  RABBITMQ_FIELD_RULES,
  readOnlyHint,
  S3_FIELD_HINTS,
  S3_FIELD_RULES,
  SNOWFLAKE_FIELD_HINTS,
  SNOWFLAKE_FIELD_RULES,
  SPARK_FIELD_HINTS,
  SPARK_FIELD_RULES,
} from "@/lib/db/connection-form";

// DB brand icons share the same interface as LucideIcon (className + SVG props)
export type DBIcon = LucideIcon | React.FC<React.SVGAttributes<SVGSVGElement> & { className?: string }>;

/** The connection dialog's entry for one engine: its form data (src/lib/db/connection-form.ts), its icon and its colour. */
export interface DatabaseUIConfig extends ConnectionFormSpec {
  icon: DBIcon;
  color: string;
}

export type { ConnectionField } from "@/lib/db/connection-fields";

/**
 * One engine's form entry with its icon and colour in front of it. Every property of the form entry is copied by its
 * descriptor, so the `credentialWarnings` getter stays a getter, and the key order is `icon`, `color`, then the form's.
 */
function branded<F extends object>(form: F, icon: DBIcon, color: string): F & { icon: DBIcon; color: string } {
  return Object.defineProperties({ icon, color }, Object.getOwnPropertyDescriptors(form)) as F & {
    icon: DBIcon;
    color: string;
  };
}

export const DB_UI_CONFIG: {
  [T in DatabaseType]: Omit<DatabaseUIConfig, "fieldPlacement"> & FieldPlacementDeclaration<T>;
} = {
  postgres: branded(CONNECTION_FORM.postgres, PostgreSQLIcon, "text-hue-blue"),
  mysql: branded(CONNECTION_FORM.mysql, MySQLIcon, "text-hue-amber"),
  sqlite: branded(CONNECTION_FORM.sqlite, SQLiteIcon, "text-hue-cyan"),
  // DuckDB's own mark is a bright yellow (#FFF000), and `hue-yellow` is already
  // ClickHouse's. `-alt` is the second step of that hue, kept apart from its base
  // in both palettes; the distinct-colour assertion in
  // tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
  duckdb: branded(CONNECTION_FORM.duckdb, DuckDBIcon, "text-hue-yellow-alt"),
  // Turso's own mark is a bright mint green (#4FF8D2). emerald-300 is the nearest
  // free shade - emerald-400 is MongoDB's, both teals are taken by Couchbase and
  // Elasticsearch, and the distinct-colour assertion in
  // tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
  libsql: branded(CONNECTION_FORM.libsql, LibSQLIcon, "text-hue-emerald-alt"),
  mongodb: branded(CONNECTION_FORM.mongodb, MongoDBIcon, "text-hue-emerald"),
  redis: branded(CONNECTION_FORM.redis, RedisIcon, "text-hue-rose"),
  oracle: branded(CONNECTION_FORM.oracle, OracleIcon, "text-hue-red"),
  db2: branded(CONNECTION_FORM.db2, Db2Icon, "text-hue-purple"),
  mssql: branded(CONNECTION_FORM.mssql, MSSQLIcon, "text-hue-sky"),
  couchbase: branded(CONNECTION_FORM.couchbase, CouchbaseIcon, "text-hue-orange"),
  clickhouse: branded(CONNECTION_FORM.clickhouse, ClickHouseIcon, "text-hue-yellow"),
  // Issue #265 specified sky, which mssql already owns; the distinct-colour
  // assertion in tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
  // `hue-teal` was free and is closer to Druid's own petrol-teal mark anyway.
  druid: branded(CONNECTION_FORM.druid, DruidIcon, "text-hue-teal"),
  // The Elastic mark's own hues are teal (#00bfb3) and yellow (#fed10a); teal-400
  // and yellow-400 are already owned by druid and clickhouse, and the distinct-colour
  // assertion in tests/unit/lib/db-ui-config.test.ts rules a duplicate out. teal-300
  // is the nearest free shade to the brand teal.
  elasticsearch: branded(CONNECTION_FORM.elasticsearch, ElasticsearchIcon, "text-hue-teal-alt"),
  // OpenSearch's Pacific Blue (#005EB8) is deeper and bluer than postgres' own
  // blue-400, which already owns "blue" here; indigo-400 is the nearest free shade.
  opensearch: branded(CONNECTION_FORM.opensearch, OpenSearchIcon, "text-hue-indigo"),
  // Trino's own mark is a magenta-pink (#DD00A1); pink-400 is the nearest free
  // shade, and the distinct-colour assertion in tests/unit/lib/db-ui-config.test.ts
  // rules a duplicate out.
  trino: branded(CONNECTION_FORM.trino, TrinoIcon, "text-hue-pink"),
  // Cassandra's own mark is a mid-cyan eye (#1287B1). sky-400 is mssql's and the
  // distinct-colour assertion in tests/unit/lib/db-ui-config.test.ts rules a
  // duplicate out, so sky-300 is the nearest free shade.
  cassandra: branded(CONNECTION_FORM.cassandra, CassandraIcon, "text-hue-sky-alt"),
  // Prometheus's own mark is a flame orange (#E6522C), and `hue-orange` is Couchbase's. The
  // theme has no second orange identity step, and adding one would be a palette change with a
  // separation test of its own (tests/unit/theme-accent-contrast.test.ts); `hue-fuchsia` is a
  // declared identity hue no engine here carries, and the distinct-colour assertion in
  // tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
  prometheus: branded(CONNECTION_FORM.prometheus, PrometheusIcon, "text-hue-fuchsia"),
  // Kafka's own mark is black, which is no identity hue at all. `hue-green` is a declared base
  // identity hue no engine here carries (purple, the other free one, is VisualExplain's AI accent),
  // and the distinct-colour assertion in tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
  kafka: branded(CONNECTION_FORM.kafka, KafkaIcon, "text-hue-green"),
  // etcd's own mark is a mid blue (#419EDA). `hue-blue` is PostgreSQL's; its `-alt` step is a
  // second identity only if it clears the separation test, which is why `blue` joined
  // IDENTITY_ALTS in tests/unit/theme-accent-contrast.test.ts with this entry (KE9).
  etcd: branded(CONNECTION_FORM.etcd, EtcdIcon, "text-hue-blue-alt"),
  // A generic graph glyph, never Neo4j's logo (spec E12).
  // No identity hue is free. `hue-fuchsia` is Prometheus's; its `-alt` step is a second identity only
  // because it clears the separation test, which is why `fuchsia` joined IDENTITY_ALTS in
  // tests/unit/theme-accent-contrast.test.ts with this entry, as `blue` did with etcd's.
  neo4j: branded(CONNECTION_FORM.neo4j, Neo4jIcon, "text-hue-fuchsia-alt"),
  // A mark drawn for Studio, never the project's logo or any vendor or Attu asset (vector-family spec 10.3).
  // Milvus's own mark is a blue. `hue-blue` is PostgreSQL's and its `-alt` etcd's, and `hue-sky` and its `-alt`
  // are taken; `hue-cyan-alt` fails the separation test and `hue-indigo-alt` clears it, which is why `indigo`
  // joined IDENTITY_ALTS in tests/unit/theme-accent-contrast.test.ts with this entry (vector-family spec 10.3).
  milvus: branded(CONNECTION_FORM.milvus, MilvusIcon, "text-hue-indigo-alt"),
  // A mark drawn for Studio, never the vendor's logo (vector-family spec 10.3).
  // Qdrant's own mark is a crimson. `hue-rose` is Redis's; its `-alt` step is a second identity only because it
  // clears the separation test, which is why `rose` joined IDENTITY_ALTS in tests/unit/theme-accent-contrast.test.ts
  // with this entry, as `fuchsia` did with Neo4j's.
  qdrant: branded(CONNECTION_FORM.qdrant, QdrantIcon, "text-hue-rose-alt"),
  // A mark drawn for Studio, never the vendor's logo (#1566). A NEW hue, as for Sparkplug's `olive`: every base hue,
  // every `-alt` step and every grey theme.css declared was an engine's, so the palette gains `zinc`. Measured, not
  // chosen: `zinc-900` light and `zinc-400` dark leave both closest identity pairs where they were (theme.css says the
  // figures, tests/unit/theme-accent-contrast.test.ts holds them).
  weaviate: branded(CONNECTION_FORM.weaviate, WeaviateIcon, "text-hue-zinc"),
  // A generic time-series mark drawn for Studio, never InfluxData's logo (InfluxDB spec E19), shared by both types.
  // `hue-purple` is Db2's; its `-alt` step is a second identity only because it clears the separation test, which
  // is why `purple` joined IDENTITY_ALTS in tests/unit/theme-accent-contrast.test.ts with this entry.
  influxdb: branded(CONNECTION_FORM.influxdb, InfluxDBIcon, "text-hue-purple-alt"),
  // The same mark as the InfluxQL type: one product, two connection types.
  // The first hue with no identity `-alt` before it whose `-alt` step clears the separation test, which is why
  // `violet` joined IDENTITY_ALTS in tests/unit/theme-accent-contrast.test.ts with this entry (InfluxDB spec K-D4).
  influxdb3: branded(CONNECTION_FORM.influxdb3, InfluxDBIcon, "text-hue-violet-alt"),
  // A mark drawn for Studio, never Oxia's logo (DECISIONS O16).
  // `hue-orange` is Couchbase's; its `-alt` step joins IDENTITY_ALTS with this entry, measured in
  // tests/unit/theme-accent-contrast.test.ts next to InfluxDB's `purple-alt` and `violet-alt` (O16, O17).
  oxia: branded(CONNECTION_FORM.oxia, OxiaIcon, "text-hue-orange-alt"),
  // Databend's published icon in its own colours, at the Databend team's request (databendlabs/databend-docs#3512).
  // `hue-red` is Oracle's; its `-alt` step joins IDENTITY_ALTS with this entry, the first of the hues with no
  // identity `-alt` to clear tests/unit/theme-accent-contrast.test.ts. The icon has fixed fills, so this class no
  // longer paints it; the entry still needs a distinct one.
  databend: branded(CONNECTION_FORM.databend, DatabendIcon, "text-hue-red-alt"),
  bigquery: branded(CONNECTION_FORM.bigquery, BigQueryIcon, "text-hue-cyan-alt"),
  // A six-armed snowflake drawn for Studio, never the company's logo.
  // Every chromatic hue and every `-alt` step was already an engine's, `lime-alt` RabbitMQ's last, so `mist`, the
  // blue-tinted neutral, joined the identity palette with this entry: mist-700 in light and mist-400 in dark leave
  // both closest pairs where they were (tests/unit/theme-accent-contrast.test.ts).
  snowflake: branded(CONNECTION_FORM.snowflake, SnowflakeIcon, "text-hue-mist"),
  // A stage DAG drawn for Studio, never the Apache Spark logo.
  // Every chromatic hue, every `-alt` step, `mist` and `slate` were already an engine's, so `taupe`, the warm neutral
  // nearest Spark's orange mark, joined the identity palette with this entry: taupe-700 in light and taupe-400 in dark
  // leave both closest pairs where they were (tests/unit/theme-accent-contrast.test.ts).
  spark: branded(CONNECTION_FORM.spark, SparkIcon, "text-hue-taupe"),
  // A generic bucket drawn for Studio, never a vendor's logo.
  // `hue-green` is Kafka's; of the hues with no identity `-alt` (amber, pink, green, cyan), `green-alt` left the light
  // set's minimum where it was within 0.0006 and the dark one unchanged, which is why `green` joined IDENTITY_ALTS in
  // tests/unit/theme-accent-contrast.test.ts with this entry.
  s3: branded(CONNECTION_FORM.s3, S3Icon, "text-hue-green-alt"),
  // A mark drawn for Studio, never the project's own logo.
  // `hue-amber` is MySQL's; its `-alt` step joins IDENTITY_ALTS with this entry, measured in
  // tests/unit/theme-accent-contrast.test.ts.
  kubernetes: branded(CONNECTION_FORM.kubernetes, KubernetesIcon, "text-hue-amber-alt"),
  // A mark drawn for Studio, never a product's logo: a node with the arcs of a broadcast.
  // Every identity `-alt` theme.css declared was taken again, so `pink` joined IDENTITY_ALTS with this entry:
  // of the two hues with none left (pink, cyan), `pink-alt` was tried first and cleared every test - it leaves
  // both closest pairs exactly where Kubernetes's `amber-alt` left them, 0.0205 in light against 0.0160 in dark
  // (tests/unit/theme-accent-contrast.test.ts). It is also the step nearest MQTT's own magenta mark.
  mqtt: branded(CONNECTION_FORM.mqtt, MqttIcon, "text-hue-pink-alt"),
  // A mark drawn for Studio, never the Firebase or Google Cloud logo: a document with a second one behind it.
  // Every identity hue and every `-alt` step was an engine's already, so `lime` joined the identity palette with this
  // entry: lime-800 in light and lime-400 in dark leave both closest pairs where they were (0.0205 in light, 0.0160 in
  // dark), and the light step clears AA at 4.67 on every ground (tests/unit/theme-accent-contrast.test.ts).
  firestore: branded(CONNECTION_FORM.firestore, FirestoreIcon, "text-hue-lime"),
  // A mark drawn for Studio, never the project's own logo.
  // Every base hue and every other identity `-alt` is an engine's, Firestore's `lime` among them, so `lime-alt`
  // joined the identity steps with this entry (tests/unit/theme-accent-contrast.test.ts measures it).
  rabbitmq: branded(CONNECTION_FORM.rabbitmq, RabbitMQIcon, "text-hue-lime-alt"),
  // A mark drawn for Studio, never the OPC Foundation's logo: a root with two branches and a leaf.
  // A NEW hue, for the second time: every identity hue carried two engines by the time this one
  // registered, and while it was being built Firestore took `lime` and RabbitMQ its `-alt` step,
  // so the palette gains `slate` here (#1677). A steel grey is also the one colour a plant's
  // address space can carry without borrowing the mark of an engine beside it.
  opcua: branded(CONNECTION_FORM.opcua, OpcuaIcon, "text-hue-slate"),
  // A mark drawn for Studio, never the MTConnect Institute's logo: a baseline with three samples on it.
  // The step this hue never had, rather than a new colour. MEASURED on theme.css at 90881379: of nineteen base
  // hues exactly two carried no `-alt` in either theme, `mist` and `slate`, and `slate`'s base is OPC UA's. The
  // pairing says nothing about a provider family, which the palette itself shows: `trino` and `mqtt` share a hue
  // across two families, as do `mysql` and `kubernetes`. `slate-alt` joined the identity steps with this entry and
  // leaves both closest identity pairs exactly where they were (tests/unit/theme-accent-contrast.test.ts).
  mtconnect: branded(CONNECTION_FORM.mtconnect, MtconnectIcon, "text-hue-slate-alt"),
  // A mark drawn for Studio, never the Modbus Organization's: a terminal block with three screws.
  // A NEW hue. Every base hue and every `-alt` step was an engine's by the time this one registered -
  // MTConnect took `slate-alt` while it was being built - so the palette gains `stone`. Of the four greys
  // Tailwind ships that no identity used, `stone`, `neutral` and `zinc` clear every test at -700, -800 and
  // -900 and `gray-800` does not clear AA in light, measured by running
  // tests/unit/theme-accent-contrast.test.ts against all twelve. A warm grey was chosen of the three that
  // pass because it stands furthest from `slate`, which is OPC UA's: those two are the industrial pair a
  // reader is most likely to need to tell apart on one tree.
  modbus: branded(CONNECTION_FORM.modbus, ModbusIcon, "text-hue-stone"),
  // A mark drawn for Studio, never a vendor's: a device with the configuration tree it serves
  // above it, forking once, because a datastore holds modules and a module holds nodes and those
  // two levels are what the browser draws.
  // A NEW hue, and the step was chosen by SEPARATION rather than contrast. `neutral-600`, `-700`
  // and `-800` all clear AA in light by a wide margin (6.85, 9.12, 13.27), so contrast alone would
  // have allowed any of them; in OKLab distance `neutral-700` sits 0.0166 from Snowflake's
  // `mist-700`, nearer than the closest identity pair this palette had (0.0205), while
  // `neutral-600` stands 0.0368 from its own nearest.
  netconf: branded(CONNECTION_FORM.netconf, NetconfIcon, "text-hue-neutral"),
  // A mark drawn for Studio: a trunk with three numbered stops descending from it, because an
  // agent answers from a named tree and is read by walking it. Not a router silhouette, which
  // would say what is being read rather than what the reading is.
  // `mauve`, measured rather than chosen. Four grey hues were already spoken for by the time
  // this registered (slate, mist, stone, neutral), and clearing AA stopped being the deciding
  // test among them: `zinc`, `gray` and `taupe` all clear it and all sit closer to a
  // neighbour. Against the declared identity set, `mauve-700` reads 9.51 on the worst light
  // ground and leaves the closest pair in BOTH palettes exactly where it was, light 0.0166 and
  // dark 0.0100, which none of the other three do. Putting `gray-800` in this slot instead
  // fails the separation test (tests/unit/theme-accent-contrast.test.ts).
  snmp: branded(CONNECTION_FORM.snmp, SnmpIcon, "text-hue-mauve"),
  // A mark drawn for Studio, never the Eclipse Foundation's logo, and deliberately not a spark.
  // A NEW hue, for the third time: every base hue and every `-alt` step theme.css declared was an
  // engine's by the time this registered, so the palette gains `olive`. The step is `-600` rather than
  // the -700/-800 the others use, and that is measured rather than stylistic: `olive-700` would clear
  // AA more comfortably and fall to 0.0351 from `mist-700`, and `olive-800` to 0.0237 from `stone-800`.
  // The unusual step is the separable one.
  //
  // THE SEPARATION FIGURE, RE-MEASURED against the palette as it now stands (42 identity tokens,
  // holding stone, neutral, mauve and taupe, which it did not when the line above was written):
  // `olive`'s nearest identity is `neutral` at 0.0373 in light and `taupe` at 0.0305 in dark, while
  // the closest pair the palette already had without it is 0.0205 in light and 0.0076 in dark. So the
  // hue tightens neither palette. Those figures are read from the hex values theme.css stores, which
  // are 8-bit; the same pair measured from the installed palette's oklch, before that rounding, gives
  // 0.0368. Two numbers, one distance, and neither is wrong - said here so a reader does not "correct"
  // one of them. The earlier note said 0.0940, measured
  // before stone, neutral, mauve and taupe joined;
  // the figures that hold the palette are the separation assertions in
  // tests/unit/theme-accent-contrast.test.ts, which read theme.css at run time and now see `olive`.
  //
  // This class resolved to NO RULE until theme.css declared `--studio-hue-olive`: the entry named a
  // hue the stylesheet did not have, Tailwind emitted no `.text-hue-olive`, and the mark inherited
  // the surrounding text colour. Nothing was red, because both completeness tests walked a list of
  // hues kept by hand. The census that reads these entries closes that direction.
  sparkplug: branded(CONNECTION_FORM.sparkplug, SparkplugIcon, "text-hue-olive"),
  libredb: branded(CONNECTION_FORM.libredb, LibreDBIcon, "text-hue-violet"),
};

export function getDBConfig(type: DatabaseType): DatabaseUIConfig {
  return DB_UI_CONFIG[type];
}

export function getDBIcon(type: DatabaseType): DBIcon {
  return DB_UI_CONFIG[type].icon;
}

export function getDBColor(type: DatabaseType): string {
  return DB_UI_CONFIG[type].color;
}

/**
 * A file-based provider carries only a filesystem path (no host/port/credentials).
 * Derived from connectionFields so callers never hard-code provider type ids.
 */
export function isFileBased(type: DatabaseType): boolean {
  const fields = DB_UI_CONFIG[type].connectionFields;
  return fields.length === 1 && fields[0] === "database";
}

/**
 * Whether this engine takes a given addressing field at all.
 *
 * One list, two readers: `buildConnection` writes a field only when this says so, and the
 * connection modal renders an input for it only when this says so. They used to disagree -
 * the modal drew Username and Database for every networked engine while the write list
 * discarded them - so libSQL asked for a user name it has none of, and Druid and the two
 * search engines asked for a database they do not take. A box whose value is thrown away is
 * the UI equivalent of reporting an absence as a measurement.
 */
export function takesConnectionField(type: DatabaseType, field: ConnectionField): boolean {
  return DB_UI_CONFIG[type].connectionFields.includes(field);
}

const NO_HOST_URI_SCHEMES: readonly HostUriScheme[] = Object.freeze([]);

/**
 * The schemes the Host box takes as a whole address for this engine: its `hostAcceptsUri`, or none.
 *
 * One rule, two readers in `useConnectionForm`, as `offersSshTunnel` has: the host setter it returns, which
 * splits a pasted address on arrival, and `buildConnection`, which splits one that was typed and which no path
 * to a tested or saved connection bypasses. Loading a connection to edit reads neither, so its host shows as it
 * was saved.
 */
export function hostUriSchemes(type: DatabaseType): readonly HostUriScheme[] {
  return DB_UI_CONFIG[type].hostAcceptsUri ?? NO_HOST_URI_SCHEMES;
}

/**
 * Whether this engine's connections may carry an SSH tunnel: false only where the entry
 * declares `showSshTunnel: false`, which Kafka does, because a tunnel forwards one address and
 * a Kafka client reaches every broker at the address the broker advertises.
 *
 * One rule, two readers, as `takesConnectionField` is: the connection modal renders the SSH
 * toggle only when this says so, and `buildConnection` writes `sshTunnel` only when this says
 * so. The second reader is the one that matters: the dialog keeps a tunnel switched on under
 * another type in its state, and a hidden panel would leave no control to turn it off. A
 * file-based engine answers true and has its panel hidden by `isFileBased` instead; a tunnel
 * left in the dialog's state is saved on it but inert, because no tunnel opens for a
 * connection without a host and port (docs/BACKLOG.md records the dialog's SSH state).
 */
export function offersSshTunnel(type: DatabaseType): boolean {
  return DB_UI_CONFIG[type].showSshTunnel !== false;
}
