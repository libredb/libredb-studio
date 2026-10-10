import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  connectionFieldHint,
  connectionFieldLabel,
  connectionFieldPlaceholder,
  connectionFieldRefusal,
  DATABEND_FIELD_HINTS,
  DATABEND_FIELD_RULES,
  DB_UI_CONFIG,
  getDBConfig,
  getDBIcon,
  getDBColor,
  hostUriSchemes,
  isFileBased,
  offersSshTunnel,
  readOnlyHint,
  S3_FIELD_HINTS,
  S3_FIELD_RULES,
  takesConnectionField,
  type ConnectionField,
  type DatabaseUIConfig,
} from "@/lib/db-ui-config";
import { SHOWCASE_DATABASE_ORDER, SHOWCASE_RANK, listShowcaseDatabases } from "@/lib/db-showcase";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import {
  buildDatabendConnectionOptions,
  DATABEND_CONNECTION_SENTENCES,
} from "@/lib/db/providers/sql/databend/connection-options";
import {
  buildS3ConnectionOptions,
  S3_ACCESS_KEY_ID_PATTERN,
  S3_BUCKET_PATTERN,
  S3_CONNECTION_SENTENCES,
  S3_REGION_PATTERN,
} from "@/lib/db/providers/objectstore/s3/connection-options";
import { S3_ACCESS_KEY_ID_MAX_CHARS, S3_ACCESS_KEY_ID_MIN_CHARS } from "@/lib/db/providers/objectstore/s3/constants";
import { DatabendIcon, InfluxDBIcon, S3Icon } from "@/components/icons/db-icons";
import { CREDENTIAL_WARNINGS } from "@/lib/db/credential-warnings";
import { declareHostUri } from "../../helpers/synthetic-host-uri";
import { providerDirectoryFiles } from "../../helpers/provider-directory-map";
import {
  declareCredentialWarnings,
  SYNTHETIC_NO_SECRET,
  SYNTHETIC_PAIR,
} from "../../helpers/synthetic-credential-warnings";

const ROOT = path.resolve(import.meta.dir, "../../..");

const ALL_TYPES: DatabaseType[] = [
  "postgres",
  "mysql",
  "sqlite",
  "mongodb",
  "redis",
  "oracle",
  "db2",
  "mssql",
  "libredb",
  "couchbase",
  "clickhouse",
  "druid",
  "elasticsearch",
  "opensearch",
  "trino",
  "cassandra",
  "libsql",
  "duckdb",
  "prometheus",
  "kafka",
  "etcd",
  "neo4j",
  "milvus",
  "qdrant",
  "influxdb",
  "influxdb3",
  "oxia",
  "databend",
  "s3",
];

describe("db-ui-config", () => {
  describe("getDBConfig", () => {
    test("returns a full config for every database type", () => {
      for (const type of ALL_TYPES) {
        const config = getDBConfig(type);
        expect(config).toBeDefined();
        expect(typeof config.label).toBe("string");
        expect(config.label.length).toBeGreaterThan(0);
        expect(typeof config.color).toBe("string");
        expect(typeof config.defaultPort).toBe("string");
        expect(typeof config.showConnectionStringToggle).toBe("boolean");
        expect(config.connectionFields.length).toBeGreaterThan(0);
      }
    });

    test("exposes the expected labels and default ports", () => {
      expect(getDBConfig("postgres").label).toBe("PostgreSQL");
      expect(getDBConfig("postgres").defaultPort).toBe("5432");
      expect(getDBConfig("mysql").defaultPort).toBe("3306");
      expect(getDBConfig("redis").defaultPort).toBe("6379");
      expect(getDBConfig("mssql").label).toBe("SQL Server");
      expect(getDBConfig("sqlite").defaultPort).toBe("");
    });

    test("exposes the connection string toggle only for the URI-addressed providers", () => {
      // MongoDB (mongodb+srv), Couchbase (couchbase://, couchbases://) and ClickHouse
      // (its HTTP endpoint is itself a URL) are the providers a user routinely has a
      // full URI for; everything else is field-based. Druid is field-based on purpose:
      // it has no URI convention for its HTTP SQL API (its JDBC driver uses
      // `jdbc:avatica:remote:url=...`), so there is no string a user could paste.
      // libSQL joins them: `libsql://<database>-<org>.turso.io?authToken=<jwt>` is the
      // URL Turso's own CLI prints, so there is a real string to paste here - unlike
      // Trino, whose canonical form is a JDBC URL.
      const withToggle = new Set<DatabaseType>(["mongodb", "couchbase", "clickhouse", "libsql"]);
      for (const type of ALL_TYPES) {
        expect(getDBConfig(type).showConnectionStringToggle).toBe(withToggle.has(type));
      }
    });

    test("couchbase exposes its label, management port and connection fields", () => {
      expect(getDBConfig("couchbase").label).toBe("Couchbase");
      expect(getDBConfig("couchbase").defaultPort).toBe("8091");
      expect(getDBConfig("couchbase").connectionFields).toEqual([
        "host",
        "port",
        "user",
        "password",
        "database",
        "connectionString",
      ]);
    });

    test("clickhouse exposes its label, HTTP port and connection fields", () => {
      expect(getDBConfig("clickhouse").label).toBe("ClickHouse");
      expect(getDBConfig("clickhouse").defaultPort).toBe("8123");
      expect(getDBConfig("clickhouse").connectionFields).toEqual([
        "host",
        "port",
        "user",
        "password",
        "database",
        "connectionString",
      ]);
    });

    test("druid exposes its label, Router port and connection fields", () => {
      expect(getDBConfig("druid").label).toBe("Apache Druid");
      expect(getDBConfig("druid").defaultPort).toBe("8888");
      expect(getDBConfig("druid").connectionFields).toEqual(["host", "port", "user", "password"]);
    });

    test("druid offers no database field, because Druid has exactly one catalog", () => {
      // INFORMATION_SCHEMA.SCHEMATA reports exactly one catalog, always named `druid`
      // (issue #265, live-verified against Druid 37.0.0). A database selector would be
      // a control with no effect, so the field is absent rather than ignored.
      expect(getDBConfig("druid").connectionFields).not.toContain("database");
    });

    test("trino exposes its label, coordinator port and connection fields", () => {
      expect(getDBConfig("trino").label).toBe("Trino");
      expect(getDBConfig("trino").defaultPort).toBe("8080");
      expect(getDBConfig("trino").connectionFields).toEqual(["host", "port", "user", "password", "database", "schema"]);
    });

    test("trino keeps the database field, because it selects the catalog", () => {
      // The opposite of Druid, and the reason the two HTTP engines differ here: a Trino
      // coordinator fronts MANY catalogs (measured on 476: `SHOW CATALOGS` answers
      // jmx, memory, system, tpcds, tpch), and a connection pins one the way a
      // PostgreSQL connection pins a database. Without the field every connection would
      // open on whatever the coordinator defaults to, which is nothing.
      expect(getDBConfig("trino").connectionFields).toContain("database");
    });

    test("elasticsearch offers the API key pair, and OpenSearch does not", () => {
      // #708. Deleting either half from elasticsearch's list (or adding either to
      // opensearch's) is the silent loss the maintainer measured: every other suite
      // stayed green. The form reads this list; the transport refuses the pair on
      // OpenSearch rather than sending it.
      expect(getDBConfig("elasticsearch").connectionFields).toEqual([
        "host",
        "port",
        "user",
        "password",
        "apiKeyId",
        "apiKeySecret",
      ]);
      expect(getDBConfig("opensearch").connectionFields).toEqual(["host", "port", "user", "password"]);
      expect(takesConnectionField("elasticsearch", "apiKeyId")).toBe(true);
      expect(takesConnectionField("elasticsearch", "apiKeySecret")).toBe(true);
      expect(takesConnectionField("opensearch", "apiKeyId")).toBe(false);
      expect(takesConnectionField("opensearch", "apiKeySecret")).toBe(false);
    });

    test("mongodb asks where the credentials live, alongside the database to open", () => {
      // Two different questions on MongoDB, and only there: users are created in a
      // database of their own, and the driver checks them against whichever database
      // the URI names. Without the field the ordinary deployment - users in `admin`,
      // data elsewhere - had no form to fill in.
      expect(getDBConfig("mongodb").label).toBe("MongoDB");
      expect(getDBConfig("mongodb").defaultPort).toBe("27017");
      expect(getDBConfig("mongodb").connectionFields).toEqual([
        "host",
        "port",
        "user",
        "password",
        "database",
        "connectionString",
        "authSource",
      ]);
    });

    test("cassandra asks for the data centre its driver refuses to start without", () => {
      expect(getDBConfig("cassandra").label).toBe("Apache Cassandra");
      expect(getDBConfig("cassandra").defaultPort).toBe("9042");
      expect(getDBConfig("cassandra").connectionFields).toEqual([
        "host",
        "port",
        "user",
        "password",
        "database",
        "localDataCenter",
      ]);
    });

    test("cassandra offers no connection-string paste, because there is no URI to paste", () => {
      // `cassandra-driver` takes contact points plus a REQUIRED localDataCenter, and no
      // URI convention carries the second. Offering the toggle would promise a paste
      // the parser refuses (`cassandra://` is in no branch of
      // connection-string-parser.ts).
      expect(getDBConfig("cassandra").showConnectionStringToggle).toBe(false);
    });

    test("duckdb is file-based, so the modal renders a path input and no host section", () => {
      // The exact triple `isFileBased` tests for. One extra connection field here and
      // the "Database File Path" input silently becomes a host/user/password form for
      // an engine that has no host at all.
      const config = getDBConfig("duckdb");

      expect(config.connectionFields).toEqual(["database"]);
      expect(isFileBased("duckdb")).toBe(true);
      expect(config.defaultPort).toBe("");
    });

    test("duckdb offers no connection-string paste, because a DuckDB connection is a path", () => {
      // There is no `duckdb://` scheme in any DuckDB tooling, so the toggle would
      // promise a paste `connection-string-parser.ts` has no branch for.
      expect(getDBConfig("duckdb").showConnectionStringToggle).toBe(false);
    });

    test("prometheus exposes its label, the API port and the four fields its HTTP API reads", () => {
      expect(getDBConfig("prometheus").label).toBe("Prometheus");
      expect(getDBConfig("prometheus").defaultPort).toBe("9090");
      expect(getDBConfig("prometheus").connectionFields).toEqual(["host", "port", "user", "password"]);
    });

    test("prometheus offers no Database box, because the server holds one TSDB and nothing to select", () => {
      // Every read of the HTTP API is addressed to the one TSDB the server holds (#1085 6.1), the
      // Druid and OpenSearch shape: a selector would be a control with no effect.
      expect(getDBConfig("prometheus").connectionFields).not.toContain("database");
      expect(takesConnectionField("prometheus", "database")).toBe(false);
      // The control: the same entry takes the credential boxes its transport reads.
      expect(takesConnectionField("prometheus", "user")).toBe(true);
      expect(takesConnectionField("prometheus", "password")).toBe(true);
    });

    test("kafka declares saslMechanism as a select with exactly the three mechanisms, no database field and no SSH tunnel", () => {
      const kafka = DB_UI_CONFIG.kafka;
      expect(kafka.label).toBe("Apache Kafka");
      expect(kafka.defaultPort).toBe("9092");
      expect(kafka.showConnectionStringToggle).toBe(false);
      expect(kafka.showSshTunnel).toBe(false);
      expect(kafka.connectionFields).toEqual(["host", "port", "saslMechanism", "user", "password"]);
      expect(kafka.fieldOptions?.saslMechanism?.map((option) => option.value)).toEqual([
        "PLAIN",
        "SCRAM-SHA-256",
        "SCRAM-SHA-512",
      ]);
      // Each mechanism is offered under its own name, the word the broker's configuration uses.
      expect(kafka.fieldOptions?.saslMechanism?.map((option) => option.label)).toEqual([
        "PLAIN",
        "SCRAM-SHA-256",
        "SCRAM-SHA-512",
      ]);
      expect(kafka.fieldLabels?.saslMechanism).toBe("SASL mechanism");
      expect(kafka.fieldHints?.saslMechanism).toBe("PLAIN and SCRAM require TLS");
      // The one rule the modal and buildConnection read: false only where an entry declares it.
      expect(offersSshTunnel("kafka")).toBe(false);
      expect(offersSshTunnel("postgres")).toBe(true);
    });

    test("only kafka's connections refuse an SSH tunnel, and only because its entry declares it", () => {
      // Derived from the declaration rather than typed out: a tunnel forwards one address, and a
      // Kafka client reaches every broker at the address the broker advertises (docs/providers/kafka.md).
      for (const type of ALL_TYPES) {
        expect({ type, offered: offersSshTunnel(type) }).toEqual({
          type,
          offered: getDBConfig(type).showSshTunnel !== false,
        });
      }
      const refusing = ALL_TYPES.filter((type) => !offersSshTunnel(type));
      expect(refusing).toEqual(["kafka"]);
      // A file-based engine still answers true: its panel is hidden by isFileBased instead.
      expect(offersSshTunnel("sqlite")).toBe(true);
    });

    test("a field an engine draws as a select is a field it takes, and the SASL select is drawn exactly where the field is taken", () => {
      // The dialog renders a select from `fieldOptions` where the engine takes the field, and
      // buildConnection writes the field on the same condition, so a declaration that named
      // options for a field the engine does not take, or took the field with no options to
      // choose from, would draw a control that writes nothing or a select that offers nothing.
      for (const type of ALL_TYPES) {
        const config = getDBConfig(type);
        for (const field of Object.keys(config.fieldOptions ?? {}) as ConnectionField[]) {
          expect({ type, field, taken: takesConnectionField(type, field) }).toEqual({ type, field, taken: true });
        }
        expect({ type, declared: config.fieldOptions?.saslMechanism !== undefined }).toEqual({
          type,
          declared: takesConnectionField(type, "saslMechanism"),
        });
      }
      expect(ALL_TYPES.filter((type) => takesConnectionField(type, "saslMechanism"))).toEqual(["kafka"]);
    });

    test("every provider carries a distinct colour class", () => {
      const colors = ALL_TYPES.map((type) => getDBConfig(type).color);
      expect(new Set(colors).size).toBe(colors.length);
    });
  });

  describe("getDBIcon", () => {
    test("returns the icon component from the config for every type", () => {
      for (const type of ALL_TYPES) {
        const icon = getDBIcon(type);
        expect(typeof icon).toBe("function");
        expect(icon).toBe(getDBConfig(type).icon);
      }
    });
  });

  describe("getDBColor", () => {
    test("returns a Tailwind text color class for every type", () => {
      for (const type of ALL_TYPES) {
        const color = getDBColor(type);
        expect(color).toStartWith("text-");
        expect(color).toBe(getDBConfig(type).color);
      }
    });
  });

  describe("isFileBased", () => {
    test("sqlite and libredb are file-based", () => {
      expect(isFileBased("sqlite")).toBe(true);
      expect(isFileBased("libredb")).toBe(true);
    });

    test("network databases are not file-based", () => {
      expect(isFileBased("postgres")).toBe(false);
      expect(isFileBased("mysql")).toBe(false);
      expect(isFileBased("mongodb")).toBe(false);
      expect(isFileBased("redis")).toBe(false);
      expect(isFileBased("oracle")).toBe(false);
      expect(isFileBased("mssql")).toBe(false);
      expect(isFileBased("couchbase")).toBe(false);
      expect(isFileBased("clickhouse")).toBe(false);
      expect(isFileBased("druid")).toBe(false);
      expect(isFileBased("prometheus")).toBe(false);
      // Not file-based, so the dialog keeps its TLS panel: only the SSH half is withheld.
      expect(isFileBased("kafka")).toBe(false);
      expect(isFileBased("influxdb")).toBe(false);
      expect(isFileBased("influxdb3")).toBe(false);
      expect(isFileBased("databend")).toBe(false);
    });
  });

  /*
    `connectionFields` decides what a save WRITES: `buildConnection` in
    `src/hooks/use-connection-form.ts` spreads `host`/`port`/`user`/`password`/`database`
    only when this list names them. So an engine whose provider authenticates with a field
    the list omits discards the value between the box the user typed it into and the driver
    that needed it, and nothing fails - the connection simply acts as a principal the user
    did not choose.

    That is not hypothetical. #502 taught `RedisProvider.connect()` to pass `config.user` to
    ioredis as `username`, measured on both arms against `redis:latest` (without it
    `ACL WHOAMI` answered `default` and a restricted principal reported full health). The
    repair was correct and unreachable: `redis` did not name `user` here, so the form threw
    the value away before the provider could ever see it.

    These tests derive the answer rather than restating the table: the factory says which
    module implements each type-id, and the module (with its directory siblings, for the
    providers split across files) says whether it ever reads the field. Comments and
    docblocks are stripped first, so a docblock that merely DISCUSSES `config.user` does not
    count as a read.

    Two ways the `config.<field>` pattern can be wrong, and they are not symmetric:

    - A FALSE POSITIVE - the token inside a SQL string literal, say - makes this test fail
      loudly with a name in the message. Someone reads it and adds the exclusion. Safe.
    - A FALSE NEGATIVE is the dangerous one: a provider reading the field some other way
      (`const { user } = this.config`, or `this.config` bound to a local first) would be
      seen as not reading it, and a list that omits the field would pass. Measured
      2026-08-27 across every provider directory: there are no destructured reads of `user`
      or `database` and `this.config` is never aliased to a bare variable, so the pattern
      catches every real read today. If you add one of those shapes, widen this first.
  */
  describe("the write list names every addressing field its provider reads", () => {
    const FACTORY = readFileSync(path.join(ROOT, "src/lib/db/factory.ts"), "utf8");

    /** `case "redis": ... await import("./providers/keyvalue/redis")` */
    const moduleForType = (type: DatabaseType): string => {
      const pattern = new RegExp(`case "${type}":[\\s\\S]{0,400}?await import\\("\\./providers/([^"]+)"\\)`);
      const match = pattern.exec(FACTORY);
      if (match === null) throw new Error(`factory.ts declares no module for ${type}`);
      return match[1].replace(/\/index$/, "");
    };

    const providerSource = (type: DatabaseType): string => {
      const base = path.join(ROOT, "src/lib/db/providers", moduleForType(type));
      // A directory that serves two type-ids declares which of its files each one reads
      // (tests/helpers/provider-directory-map.ts); any other directory is read whole.
      const files = existsSync(`${base}.ts`)
        ? [`${base}.ts`]
        : (providerDirectoryFiles(base, type) ??
          readdirSync(base, { recursive: true, encoding: "utf8" })
            .map((entry) => path.join(base, entry))
            .filter((entry) => entry.endsWith(".ts")));
      // A provider on the shared graph layer reads the connection in the base class it extends
      // (`src/lib/db/graph/graph-base-provider.ts`), outside its own directory, so every graph-layer
      // module the provider imports is read with it; without this, Neo4j would be seen reading nothing.
      const own = files.map((file) => readFileSync(file, "utf8")).join("\n");
      const shared = [...own.matchAll(/from "@\/lib\/db\/graph\/([^"]+)"/g)].map((match) =>
        readFileSync(path.join(ROOT, "src/lib/db/graph", `${match[1]}.ts`), "utf8"),
      );
      const source = [own, ...shared].join("\n");
      return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    };

    test("the factory names a readable module for every type", () => {
      // Every assertion below is vacuously true if the source comes back empty.
      for (const type of ALL_TYPES) expect(providerSource(type).length).toBeGreaterThan(200);
    });

    /**
     * A field a provider reads only to refuse it, which the dialog therefore must not offer: Qdrant has no user
     * name, and its provider refuses a non-empty `config.user` naming the field before any socket (vector-family
     * spec 4.4), pinned in tests/unit/db/qdrant/credential-record.test.ts. InfluxDB 3 has no user name either: its
     * token is the password, and the connection layer it shares with the InfluxQL type refuses a user on it (InfluxDB
     * spec A.3). Oxia has no user name either, and its provider refuses a non-empty `config.user` with "Oxia has no
     * user name: clear User. A bearer token goes under Token." (SB1-4.3) Listed by name, so the read stays visible.
     */
    const READ_ONLY_TO_REFUSE: Readonly<Record<"user" | "database", readonly DatabaseType[]>> = {
      user: ["qdrant", "influxdb3", "oxia"],
      database: [],
    };

    test("every field read only to refuse it is really read and really not offered", () => {
      for (const [field, types] of Object.entries(READ_ONLY_TO_REFUSE)) {
        for (const type of types) {
          expect(new RegExp(`config\\.${field}\\b`).test(providerSource(type))).toBe(true);
          expect(getDBConfig(type).connectionFields).not.toContain(field);
        }
      }
    });

    test.each(["user", "database"] as const)("a provider that reads config.%s is given it", (field) => {
      const diverging = ALL_TYPES.filter(
        (type) =>
          !READ_ONLY_TO_REFUSE[field].includes(type) &&
          new RegExp(`config\\.${field}\\b`).test(providerSource(type)) !==
            getDBConfig(type).connectionFields.includes(field),
      );
      expect(diverging).toEqual([]);
    });

    /*
      The predicate the modal reads. It has to be exercised here rather than through
      `ConnectionModal`, because both component test files mock `@/lib/db-ui-config` - so a
      test driving the modal never runs this function at all, and the coverage gate is what
      said so.
    */
    describe("takesConnectionField", () => {
      test("answers for the engines whose field set is not the networked default", () => {
        // libSQL: a user for sqld's HTTP Basic auth beside the token box; and the database IS the host.
        expect(takesConnectionField("libsql", "user")).toBe(true);
        expect(takesConnectionField("libsql", "database")).toBe(false);
        expect(takesConnectionField("libsql", "host")).toBe(true);
        expect(takesConnectionField("libsql", "password")).toBe(true);

        // The three HTTP-Basic engines take a credential but name their datasource or
        // index in the statement.
        for (const type of ["druid", "elasticsearch", "opensearch"] as const) {
          expect(takesConnectionField(type, "user")).toBe(true);
          expect(takesConnectionField(type, "database")).toBe(false);
        }

        // Redis takes both, which is the fix this round made.
        expect(takesConnectionField("redis", "user")).toBe(true);
        expect(takesConnectionField("redis", "database")).toBe(true);
      });

      test("agrees with the list it reads, for every type and every field", () => {
        // Derived rather than enumerated: the predicate must not develop an opinion of its
        // own about any engine.
        const FIELDS = [
          "host",
          "port",
          "user",
          "password",
          "database",
          "connectionString",
          "apiKeyId",
          "apiKeySecret",
          "saslMechanism",
          "warehouse",
          "region",
        ] as const;
        for (const type of ALL_TYPES) {
          for (const field of FIELDS) {
            expect(takesConnectionField(type, field)).toBe(getDBConfig(type).connectionFields.includes(field));
          }
        }
      });
    });

    test("redis names the ACL user, because its provider authenticates with it", () => {
      // Pinned by name as well as by the rule above: this is the one the rule was written
      // for, and a rule can be weakened by a future edit without anyone noticing which
      // case it existed to catch.
      expect(getDBConfig("redis").connectionFields).toContain("user");
    });

    test("libsql names the user, because its transport sends one as HTTP Basic", () => {
      // Pinned by name for the same reason: the transport reads `config.user` for a server started with
      // SQLD_HTTP_AUTH, and a list without it would leave that server reachable from the form only through
      // sqld's lenient header parsing, which is the Redis ACL user again.
      expect(getDBConfig("libsql").connectionFields).toContain("user");
    });
  });

  test("libsql declares when its Username box is filled, and keeps the token box's own label", () => {
    const libsql = getDBConfig("libsql");
    expect(libsql).toMatchObject({
      label: "libSQL",
      defaultPort: "8080",
      showConnectionStringToggle: true,
      connectionFields: ["host", "port", "user", "password", "connectionString"],
    });
    expect(libsql.fieldHints).toEqual({
      user: "Only for a self-hosted libSQL server started with SQLD_HTTP_AUTH, which checks a user name and password as HTTP Basic: the Auth Token box then takes the password. Leave it empty for Turso Cloud and for a server that checks tokens.",
    });
    // "Auth Token" stays the per-type word in ConnectionModal.tsx, so nothing relabels the password box here.
    expect(libsql.fieldLabels).toBeUndefined();
  });

  test("db2 declares its label, DRDA port and fields, the consent box's hint and no password hint (#786)", () => {
    const db2 = getDBConfig("db2");
    expect(db2).toMatchObject({
      label: "Db2 LUW",
      color: "text-hue-purple",
      defaultPort: "50000",
      // A `db2://` paste fills the fields, the Oracle precedent, so no toggle is drawn.
      showConnectionStringToggle: false,
      // The last is the consent to a cleartext password the provider refuses a connection with no
      // TLS without (#786), drawn as a checkbox while SSL Mode is disable.
      connectionFields: ["host", "port", "user", "password", "database", "allowInsecureAuth"],
    });
    expect(takesConnectionField("db2", "allowInsecureAuth")).toBe(true);
    expect(takesConnectionField("postgres", "allowInsecureAuth")).toBe(false);
    // No password hint: a declared hint is drawn whatever SSL Mode says, so a cleartext warning there
    // stood under a verify-ca connection on the TLS port too (#1303). The warning is the consent box's,
    // drawn only while SSL Mode is disable, with the sentence each type declares (InfluxDB spec R4).
    expect(db2.fieldHints).toEqual({
      allowInsecureAuth:
        "With no SSL mode this driver sends the password in cleartext, so the connection is refused unless this is ticked. Choose an SSL mode under SSL / TLS instead wherever the server offers one.",
    });
    expect(db2.fieldLabels).toBeUndefined();
  });

  test("etcd declares the field hints of #1089 6.1, one connection per cluster and no connection string", () => {
    const etcd = getDBConfig("etcd");
    expect(etcd).toMatchObject({
      label: "etcd",
      defaultPort: "2379",
      showConnectionStringToggle: false,
      connectionFields: ["host", "port", "user", "password"],
    });
    expect(etcd.showSshTunnel).toBeUndefined();
    expect(etcd.fieldHints).toEqual({
      host: "A name or address only. For etcdctl's --endpoints=https://10.0.0.5:2379, type 10.0.0.5 here, 2379 in Port, and choose an SSL mode under SSL / TLS.",
      user: "Leave User and Password empty to sign in with the client certificate under SSL / TLS (shown in verify-ca and verify-full): etcd uses its Common Name as the user when the server runs with --client-cert-auth. When both are set, etcd uses the password.",
      password:
        "etcd receives the password, then a token on every call, so a password needs an SSL mode other than disable, with or without an SSH tunnel.",
    });
    expect(etcd.fieldLabels).toBeUndefined();
  });

  test("neo4j declares the fields of its spec 6.1, the Bolt port, no connection string and the read-only hint", () => {
    const neo4j = getDBConfig("neo4j");
    expect(neo4j).toMatchObject({
      label: "Neo4j",
      color: "text-hue-fuchsia-alt",
      defaultPort: "7687",
      showConnectionStringToggle: false,
      connectionFields: ["host", "port", "user", "password", "database"],
    });
    // The SSL panel and the SSH tunnel are both offered: a bolt:// URI dials the one server it names.
    expect(neo4j.showSshTunnel).toBeUndefined();
    expect(offersSshTunnel("neo4j")).toBe(true);
    expect(neo4j.fieldHints).toEqual({ database: "Leave empty to use the server's home database." });
    // The Read-only toggle's own sentence: the dialog's default says the mode can be turned off (spec A7).
    expect(readOnlyHint(neo4j)).toBe(
      "Neo4j connections are read-only in this version, whether or not this is ticked: this user's write privileges are never used.",
    );
    expect(readOnlyHint(DB_UI_CONFIG.etcd)).toBe(
      "Writes, value edits and maintenance are refused on this connection. You can turn this off here, so on your own connection it is a safety rail, not a permission.",
    );
    expect(neo4j.fieldLabels).toBeUndefined();
    expect(neo4j.fieldOptions).toBeUndefined();
  });
});

// ============================================================================
// Declared connection-field copy (#1085)
// ============================================================================

/**
 * Every connection field, as a total record so a field added to `connectionFields` fails to
 * compile here until it is listed, and the walk below cannot miss it.
 */
const FIELD_CHECKLIST: Record<ConnectionField, true> = {
  host: true,
  port: true,
  user: true,
  password: true,
  database: true,
  schema: true,
  connectionString: true,
  serviceName: true,
  instanceName: true,
  localDataCenter: true,
  authSource: true,
  apiKeyId: true,
  apiKeySecret: true,
  saslMechanism: true,
  allowInsecureAuth: true,
  dataServers: true,
  warehouse: true,
  region: true,
};
const EVERY_FIELD = Object.keys(FIELD_CHECKLIST) as ConnectionField[];

describe("declared connection-field copy (#1085)", () => {
  const plain = getDBConfig("postgres");
  /** A synthetic declaration, so the helpers' rule is tested apart from what any shipped entry declares. */
  const declaring: DatabaseUIConfig = {
    ...plain,
    fieldLabels: { password: "Password or token" },
    fieldHints: { password: "Leave User empty to send this as a bearer token." },
  };

  test("a declared label replaces the caller's fallback for its field", () => {
    expect(connectionFieldLabel(declaring, "password", "Password")).toBe("Password or token");
    // The control: a field the same declaration does not name keeps the caller's word.
    expect(connectionFieldLabel(declaring, "user", "Username")).toBe("Username");
  });

  test("with nothing declared, the caller's fallback is the label", () => {
    expect(connectionFieldLabel(plain, "password", "Password")).toBe("Password");
  });

  test("a declared hint is answered for its field and no other", () => {
    expect(connectionFieldHint(declaring, "password")).toBe("Leave User empty to send this as a bearer token.");
    expect(connectionFieldHint(declaring, "user")).toBeUndefined();
    expect(connectionFieldHint(plain, "password")).toBeUndefined();
  });

  test("an empty declaration declares nothing", () => {
    const empty: DatabaseUIConfig = { ...plain, fieldLabels: {}, fieldHints: {} };
    expect(connectionFieldLabel(empty, "password", "Password")).toBe("Password");
    expect(connectionFieldHint(empty, "password")).toBeUndefined();
  });

  test("qdrant declares its port, no Database box, no User field, API key or JWT, the hints and the Host box addresses (vector-family spec 6.2)", () => {
    const qdrant = getDBConfig("qdrant");
    expect(qdrant).toMatchObject({
      label: "Qdrant",
      color: "text-hue-rose-alt",
      defaultPort: "6333",
      showConnectionStringToggle: false,
      connectionFields: ["host", "port", "password"],
    });
    // The SSL panel and the SSH tunnel are both offered, the tunnel's far end being the TLS identity (vector-family spec 4.4).
    expect(qdrant.showSshTunnel).toBeUndefined();
    expect(offersSshTunnel("qdrant")).toBe(true);
    expect(takesConnectionField("qdrant", "user")).toBe(false);
    expect(takesConnectionField("qdrant", "database")).toBe(false);
    expect(qdrant.fieldLabels).toEqual({ password: "API key or JWT" });
    expect(qdrant.fieldHints).toEqual({
      host: "A name or address, or a pasted http:// or https:// address such as http://localhost:6333, which is split into Host and Port. Studio dials this REST port only, never Qdrant's gRPC port 6334 or its cluster port 6335.",
      password:
        "Qdrant receives the API key or JWT on every request, so a key needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection. A read-only or collection-scoped key with an expiry is the safest choice.",
    });
    expect(hostUriSchemes("qdrant")).toEqual(["http", "https"]);
    expect(qdrant.credentialWarnings).toBe(CREDENTIAL_WARNINGS.qdrant);
  });

  test("oxia declares its label, port, fields, labels, the five hints and the read-only hint (SB3-1.5)", () => {
    const oxia = getDBConfig("oxia");
    expect(oxia.label).toBe("Oxia");
    expect(oxia.color).toBe("text-hue-orange-alt");
    expect(oxia.defaultPort).toBe("6648");
    expect(oxia.showConnectionStringToggle).toBe(false);
    expect(oxia.connectionFields).toEqual(["host", "port", "password", "database", "dataServers", "allowInsecureAuth"]);
    expect(oxia.fieldLabels).toEqual({ password: "Token", database: "Namespace", dataServers: "Data servers" });
    expect(oxia.fieldHints).toEqual({
      host: "A name or address only. For Pulsar's oxia://host:6648/ns, type host here, 6648 in Port and ns in Namespace. If Studio runs in a container, localhost is that container: use host.docker.internal.",
      password:
        "An OIDC token, sent as a bearer token on every call; empty for a server without authentication. A token grants read and write on every namespace: Oxia has no authorization. A token needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection.",
      database:
        "Empty means default, the only namespace of oxia standalone. Names are case sensitive, and a cluster's namespaces are in its coordinator configuration.",
      dataServers:
        "Only for a cluster that advertises other addresses: every data server's public address (servers[].public in the coordinator configuration) as host:port, separated by commas or spaces, at most 64. List every server, not only today's leaders. Patterns are not accepted, because the token would follow any address a pattern matches. Leave empty for oxia standalone.",
      allowInsecureAuth:
        "Oxia receives the token on every call, so with no SSL mode it crosses the network in cleartext, to the host and to every data server. A token sent without TLS to a host that is not this machine is refused unless this is ticked. Choose an SSL mode under SSL / TLS instead wherever the server offers one.",
    });
    expect(oxia.readOnlyHint).toBe(
      "Oxia connections are read-only in this version, whether or not this is ticked: Studio sends Oxia no write.",
    );
    // The Namespace box shows the namespace an empty one means, not the dialog's "db" (ruling R34).
    expect(oxia.fieldPlaceholders).toEqual({ database: "default" });
    expect(connectionFieldPlaceholder(oxia, "database", "db")).toBe("default");
    expect(connectionFieldPlaceholder(oxia, "host", "localhost")).toBe("localhost");
    expect(connectionFieldPlaceholder(getDBConfig("postgres"), "database", "db")).toBe("db");
    expect(readOnlyHint(oxia)).toBe(oxia.readOnlyHint ?? "");
    // No User box, no Host address, no option list and the default SSH tunnel (SB3-1.5).
    expect(takesConnectionField("oxia", "user")).toBe(false);
    expect(oxia.hostAcceptsUri).toBeUndefined();
    expect(oxia.fieldOptions).toBeUndefined();
    expect(oxia.showSshTunnel).toBeUndefined();
    expect(offersSshTunnel("oxia")).toBe(true);
    expect(hostUriSchemes("oxia")).toEqual([]);
    expect(oxia.credentialWarnings).toBe(CREDENTIAL_WARNINGS.oxia);
  });

  test("databend declares its label, port, fields, Warehouse, the placeholders, the exported hints and the Host box addresses (design 6.1)", () => {
    const databend = getDBConfig("databend");
    expect(databend).toMatchObject({
      label: "Databend",
      color: "text-hue-red-alt",
      // Self-hosted's HTTP handler port. 443 comes from a DSN or an https:// paste, never the SSL mode or a host heuristic.
      defaultPort: "8000",
      showConnectionStringToggle: false,
      connectionFields: ["host", "port", "user", "password", "database", "warehouse", "allowInsecureAuth"],
    });
    expect(databend.icon).toBe(DatabendIcon);
    // The SSL panel and the SSH tunnel are both offered.
    expect(databend.showSshTunnel).toBeUndefined();
    expect(offersSshTunnel("databend")).toBe(true);
    expect(takesConnectionField("databend", "warehouse")).toBe(true);
    expect(takesConnectionField("postgres", "warehouse")).toBe(false);
    expect(databend.fieldLabels).toEqual({ warehouse: "Warehouse" });
    expect(databend.fieldPlaceholders).toEqual({ user: "root", database: "default" });
    expect(connectionFieldPlaceholder(databend, "database", "db")).toBe("default");
    expect(databend.fieldHints).toBe(DATABEND_FIELD_HINTS);
    expect(DATABEND_FIELD_HINTS).toEqual({
      host: "A host name or address, or a pasted https:// address, which is split into Host and Port. Databend Cloud: the host from Connect in the Cloud console, on port 443 with SSL mode verify-system. Self-hosted: the query node, port 8000 unless http_handler_port was changed.",
      user: "A SQL user. On Databend Cloud: cloudapp, or a user created with CREATE USER; the email you sign in to the Cloud console with is not a SQL user.",
      database: "The current database for names a statement does not qualify. Empty means default.",
      warehouse:
        "Databend Cloud: the warehouse= value of the DSN from Connect. A suspended warehouse resumes on the first statement, opening the connection included, because it reads the object tree, and is billed while it runs; with Warehouse set, Studio sends no background health checks. Self-hosted: leave empty unless your cluster routes requests by warehouse.",
      allowInsecureAuth:
        "Ticked, the password crosses the network in cleartext to this host. Databend Cloud never needs this: it serves HTTPS on port 443.",
    });
    expect(databend.readOnlyHint).toBeUndefined();
    expect(databend.fieldOptions).toBeUndefined();
    expect(hostUriSchemes("databend")).toEqual(["http", "https"]);
    expect(databend.credentialWarnings).toBe(CREDENTIAL_WARNINGS.databend);
  });

  test("s3 declares its label, port, fields, labels, placeholders, the exported hints, the rules, the read-only hint and the Host box addresses", () => {
    const s3 = getDBConfig("s3");
    expect(s3).toMatchObject({
      label: "S3-compatible object storage",
      color: "text-hue-green-alt",
      // MinIO and RustFS serve on 9000 by default; Garage's 3900 and an https:// paste's 443 are in the Host hint.
      defaultPort: "9000",
      showConnectionStringToggle: false,
      connectionFields: ["host", "port", "user", "password", "database", "region", "allowInsecureAuth"],
    });
    expect(s3.icon).toBe(S3Icon);
    // The SSL panel and the SSH tunnel are both offered: path style addresses one origin, which one forward carries.
    expect(s3.showSshTunnel).toBeUndefined();
    expect(offersSshTunnel("s3")).toBe(true);
    expect(takesConnectionField("s3", "region")).toBe(true);
    expect(takesConnectionField("databend", "region")).toBe(false);
    expect(s3.fieldLabels).toEqual({
      host: "Endpoint host",
      user: "Access key ID",
      password: "Secret access key",
      database: "Bucket",
      region: "Region",
      allowInsecureAuth: "Connect without TLS",
    });
    expect(s3.fieldPlaceholders).toEqual({ database: "all buckets", region: "us-east-1" });
    expect(connectionFieldPlaceholder(s3, "region", "the dialog's own example")).toBe("us-east-1");
    // The User box keeps the dialog's own placeholder.
    expect(connectionFieldPlaceholder(s3, "user", "user")).toBe("user");
    expect(s3.fieldHints).toBe(S3_FIELD_HINTS);
    expect(S3_FIELD_HINTS).toEqual({
      host: "A host name or address, or a pasted http:// or https:// endpoint such as http://localhost:9000, which is split into Host and Port. The endpoint only: a bucket goes under Bucket, never in the address. MinIO and RustFS serve on port 9000 unless configured otherwise, Garage on 3900. If Studio runs in a container, localhost is that container: use host.docker.internal.",
      user: "The access key ID. It is stored and shown in the clear, like a user name. Leave both keys empty only for a bucket that allows anonymous reads: Studio then sends unsigned requests, never this server's own cloud credentials.",
      password:
        "The secret access key. Studio's server signs every request with it and never sends it to the S3 server. Fill in both keys, or neither.",
      database:
        "Optional. With a bucket here, Studio reads only that bucket and never lists the others, which a key limited to one bucket needs. Empty: every bucket this key can list.",
      region:
        "The region every request is signed for. Empty means us-east-1, which MinIO accepts unless it was started with a region of its own. Garage: its s3_region setting. AWS: the bucket's region.",
      allowInsecureAuth:
        "Ticked, Studio connects to this host over plain HTTP. The secret access key is never sent to this server, but bucket and object names, listings and previewed contents travel in the clear, readable by anyone on the path, and a captured request can be replayed for several minutes. Choose an SSL mode under SSL / TLS, or an SSH tunnel, wherever the server offers one.",
    });
    expect(s3.fieldRules).toBe(S3_FIELD_RULES);
    expect(readOnlyHint(s3)).toBe(
      "S3-compatible connections are read-only in this version, whether or not this is ticked: Studio sends no write.",
    );
    expect(s3.fieldOptions).toBeUndefined();
    expect(hostUriSchemes("s3")).toEqual(["http", "https"]);
    expect(s3.credentialWarnings).toBe(CREDENTIAL_WARNINGS.s3);
  });

  test("milvus declares its port, the Database box, Password or token, the field hints and the Host box addresses (vector-family spec 5.2)", () => {
    const milvus = getDBConfig("milvus");
    expect(milvus).toMatchObject({
      label: "Milvus",
      color: "text-hue-indigo-alt",
      defaultPort: "19530",
      showConnectionStringToggle: false,
      connectionFields: ["host", "port", "user", "password", "database"],
    });
    // The SSL panel and the SSH tunnel are both offered (vector-family spec 5.2).
    expect(milvus.showSshTunnel).toBeUndefined();
    expect(offersSshTunnel("milvus")).toBe(true);
    expect(milvus.fieldLabels).toEqual({ password: "Password or token" });
    expect(milvus.fieldHints).toEqual({
      host: "A name or address, or a pasted http:// or https:// address such as a Zilliz Cloud endpoint, which is split into Host and Port. Port 9091 is Milvus's management port, which Studio never dials.",
      database: "Optional; empty means default. A dbName in a request body overrides it.",
      user: "Optional. At most 32 characters, starting with a letter. Leave it empty to put a token in Password or token.",
      password:
        "Milvus receives the password or token on every call, so a password needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection.",
    });
    expect(hostUriSchemes("milvus")).toEqual(["http", "https"]);
    expect(milvus.credentialWarnings).toBe(CREDENTIAL_WARNINGS.milvus);
  });

  /** The sentences both InfluxDB types share (InfluxDB spec A.3). */
  const INFLUX_HOST_HINT =
    "A name or address, or a pasted http:// or https:// address, which is split into Host and Port. InfluxDB Cloud endpoints are https on port 443.";
  const INFLUX_CONSENT_HINT =
    "Ticked, the password or token crosses the network in cleartext to this host. On InfluxDB 3 Core every token is an admin token that reaches server-side code. Prefer TLS or an SSH tunnel; SSL mode require sends the token to a server whose certificate is not checked.";
  const INFLUX_READ_ONLY_HINT =
    "InfluxDB connections are read-only whether or not this is ticked: Studio sends no write.";

  test("influxdb declares its label, port, fields, Password or token, the hints, the consent hint and the Host box addresses (InfluxDB spec A.3)", () => {
    const influxdb = getDBConfig("influxdb");
    expect(influxdb).toMatchObject({
      label: "InfluxDB (InfluxQL)",
      color: "text-hue-purple-alt",
      defaultPort: "8086",
      showConnectionStringToggle: false,
      connectionFields: ["host", "port", "user", "password", "database", "allowInsecureAuth"],
    });
    expect(influxdb.icon).toBe(InfluxDBIcon);
    // The SSL panel and the SSH tunnel are both offered.
    expect(influxdb.showSshTunnel).toBeUndefined();
    expect(offersSshTunnel("influxdb")).toBe(true);
    expect(influxdb.fieldLabels).toEqual({ password: "Password or token" });
    expect(influxdb.fieldHints).toEqual({
      host: INFLUX_HOST_HINT,
      password: "1.x: the user's password. 2.x and InfluxDB 3: an API token, with User empty.",
      database:
        'A 1.x database, a 2.x bucket, or an InfluxDB 3 database: the default for a run, not a filter. Empty: the only database the credential can list, or name it in the statement as "db".."measurement".',
      allowInsecureAuth: INFLUX_CONSENT_HINT,
    });
    expect(readOnlyHint(influxdb)).toBe(INFLUX_READ_ONLY_HINT);
    expect(hostUriSchemes("influxdb")).toEqual(["http", "https"]);
    expect(influxdb.credentialWarnings).toBe(CREDENTIAL_WARNINGS.influxdb);
  });

  test("influxdb3 declares its label, port, no User field, Token, the hints, the consent hint and the Host box addresses (InfluxDB spec A.3)", () => {
    const influxdb3 = getDBConfig("influxdb3");
    expect(influxdb3).toMatchObject({
      label: "InfluxDB 3 (SQL)",
      color: "text-hue-violet-alt",
      defaultPort: "8181",
      showConnectionStringToggle: false,
      connectionFields: ["host", "port", "password", "database", "allowInsecureAuth"],
    });
    // The same generic mark as the InfluxQL type: one product, two query languages.
    expect(influxdb3.icon).toBe(InfluxDBIcon);
    expect(influxdb3.showSshTunnel).toBeUndefined();
    expect(offersSshTunnel("influxdb3")).toBe(true);
    expect(takesConnectionField("influxdb3", "user")).toBe(false);
    expect(influxdb3.fieldLabels).toEqual({ password: "Token" });
    expect(influxdb3.fieldHints).toEqual({
      host: INFLUX_HOST_HINT,
      password:
        "Empty only for a server started with --without-auth. On InfluxDB 3 Core every token is an admin token.",
      database:
        "The one InfluxDB 3 database this connection reads. Empty: the only database the token can list; with more than one, set it here.",
      allowInsecureAuth: INFLUX_CONSENT_HINT,
    });
    expect(readOnlyHint(influxdb3)).toBe(INFLUX_READ_ONLY_HINT);
    expect(hostUriSchemes("influxdb3")).toEqual(["http", "https"]);
    expect(influxdb3.credentialWarnings).toBe(CREDENTIAL_WARNINGS.influxdb3);
  });

  test("every type that takes allowInsecureAuth declares its hint", () => {
    // The consent box draws the type's own sentence, with no fallback, so a type that takes the field and declares no
    // hint would draw an empty paragraph under the box (InfluxDB spec R4).
    const taking = ALL_TYPES.filter((type) => takesConnectionField(type, "allowInsecureAuth"));
    expect(taking).toEqual(["db2", "influxdb", "influxdb3", "oxia", "databend", "s3"]);
    for (const type of taking) {
      const hint = connectionFieldHint(getDBConfig(type), "allowInsecureAuth");
      expect({ type, hint: typeof hint, empty: hint?.length === 0 }).toEqual({ type, hint: "string", empty: false });
    }
  });

  test("only libsql, db2, prometheus, kafka, etcd, neo4j, milvus, qdrant, the two InfluxDB types, oxia, databend and s3 declare field copy, so every other engine draws every label and hint it drew before", () => {
    const declared = Object.entries(DB_UI_CONFIG)
      .filter(([, config]) => config.fieldLabels !== undefined || config.fieldHints !== undefined)
      .map(([type]) => type);
    expect(declared).toEqual([
      "libsql",
      "db2",
      "prometheus",
      "kafka",
      "etcd",
      "neo4j",
      "milvus",
      "qdrant",
      "influxdb",
      "influxdb3",
      "oxia",
      "databend",
      "s3",
    ]);
    // The control that the walk saw the whole table rather than nothing.
    expect(Object.keys(DB_UI_CONFIG).sort()).toEqual([...ALL_TYPES].sort());
    for (const type of ALL_TYPES.filter((candidate) => !declared.includes(candidate))) {
      for (const field of EVERY_FIELD) {
        expect(connectionFieldLabel(getDBConfig(type), field, "the dialog's own word")).toBe("the dialog's own word");
        expect(connectionFieldHint(getDBConfig(type), field)).toBeUndefined();
      }
    }
  });

  test("prometheus declares the password label and hint, because its one password box also carries a bearer token", () => {
    const config = getDBConfig("prometheus");
    expect(connectionFieldLabel(config, "password", "Password")).toBe("Password or token");
    expect(connectionFieldHint(config, "password")).toBe("Leave User empty to send this as a bearer token.");
    // The hint and the credential refusal both name the field "User", so the label says it too.
    expect(connectionFieldLabel(config, "user", "Username")).toBe("User");
    expect(connectionFieldHint(config, "user")).toBeUndefined();
    // The control: every other field keeps the dialog's own word and draws no hint.
    for (const field of EVERY_FIELD.filter((candidate) => candidate !== "password" && candidate !== "user")) {
      expect(connectionFieldLabel(config, field, "the dialog's own word")).toBe("the dialog's own word");
      expect(connectionFieldHint(config, field)).toBeUndefined();
    }
  });

  test("kafka declares the SASL select's label and hint, because the select says TLS is required before the refusal does", () => {
    const config = getDBConfig("kafka");
    expect(connectionFieldLabel(config, "saslMechanism", "the dialog's own word")).toBe("SASL mechanism");
    expect(connectionFieldHint(config, "saslMechanism")).toBe("PLAIN and SCRAM require TLS");
    // The control: every other field keeps the dialog's own word and draws no hint, so the user
    // and password boxes read "Username" and "Password" as they do on every networked engine.
    for (const field of EVERY_FIELD.filter((candidate) => candidate !== "saslMechanism")) {
      expect(connectionFieldLabel(config, field, "the dialog's own word")).toBe("the dialog's own word");
      expect(connectionFieldHint(config, field)).toBeUndefined();
    }
  });
});

describe("declared field rules (Databend design 6.3)", () => {
  const databend = (fields: Partial<DatabaseConnection>): DatabaseConnection => ({
    id: "c1",
    name: "Databend",
    type: "databend",
    host: "localhost",
    port: 8000,
    user: "root",
    createdAt: new Date(),
    ...fields,
  });
  const LONGEST = "w".repeat(63);

  test("databend declares User required and the Warehouse rule, in the provider's own sentences", () => {
    const config = getDBConfig("databend");
    expect(config.fieldRules).toBe(DATABEND_FIELD_RULES);
    expect(DATABEND_FIELD_RULES.user?.required).toBe(DATABEND_CONNECTION_SENTENCES.userRequired);
    expect(DATABEND_FIELD_RULES.warehouse?.format?.sentence).toBe(DATABEND_CONNECTION_SENTENCES.warehouse);
    expect(DATABEND_FIELD_RULES.warehouse?.required).toBeUndefined();
    // Each sentence names its field first and holds no value, so a refusal never repeats what was typed.
    expect(DATABEND_FIELD_RULES.user?.required).toStartWith("User ");
    expect(DATABEND_FIELD_RULES.warehouse?.format?.sentence).toStartWith("Warehouse ");
  });

  test("the form's warehouse pattern is the provider's, which the dialog cannot import because it is server code", () => {
    const source = readFileSync(path.join(ROOT, "src/lib/db/providers/sql/databend/connection-options.ts"), "utf8");
    const declared = /const WAREHOUSE_NAME = \/(.+)\/;/.exec(source);
    expect(declared?.[1]).toBe(DATABEND_FIELD_RULES.warehouse?.format?.pattern.source);
    expect(DATABEND_FIELD_RULES.warehouse?.format?.pattern.flags).toBe("");
    // The control that the two copies agree on the values that matter, not only on their spelling.
    for (const warehouse of ["small-xy2t", "wh_1", LONGEST, `${LONGEST}w`, "small xy", "wh.1", "wh:1", " wh"]) {
      const form = connectionFieldRefusal(getDBConfig("databend"), databend({ warehouse }));
      let provider: string | undefined;
      try {
        buildDatabendConnectionOptions(databend({ warehouse }), { queryTimeout: 30_000, appVersion: null });
      } catch (error) {
        provider = (error as Error).message;
      }
      expect({ warehouse, form }).toEqual({ warehouse, form: provider });
    }
  });

  test("connectionFieldRefusal requires User and checks Warehouse, naming the field and never the value", () => {
    const config = getDBConfig("databend");
    expect(connectionFieldRefusal(config, databend({ user: "" }))).toBe(DATABEND_CONNECTION_SENTENCES.userRequired);
    expect(connectionFieldRefusal(config, databend({ user: undefined }))).toBe(
      DATABEND_CONNECTION_SENTENCES.userRequired,
    );
    for (const warehouse of ["small xy", `${LONGEST}w`]) {
      const refusal = connectionFieldRefusal(config, databend({ warehouse }));
      expect(refusal).toBe(DATABEND_CONNECTION_SENTENCES.warehouse);
      expect(refusal).not.toContain(warehouse);
    }
    // A valid Warehouse and an absent one pass.
    expect(connectionFieldRefusal(config, databend({ warehouse: "small-xy2t" }))).toBeUndefined();
    expect(connectionFieldRefusal(config, databend({ warehouse: LONGEST }))).toBeUndefined();
    expect(connectionFieldRefusal(config, databend({}))).toBeUndefined();
    expect(connectionFieldRefusal(config, databend({ warehouse: "" }))).toBeUndefined();
    // Fields are checked in the dialog's order, so User is named before Warehouse.
    expect(connectionFieldRefusal(config, databend({ user: "", warehouse: "small xy" }))).toBe(
      DATABEND_CONNECTION_SENTENCES.userRequired,
    );
  });

  test("only databend and s3 declare field rules, so no other engine's Test Connection or Save is checked", () => {
    const declaring = Object.entries(DB_UI_CONFIG)
      .filter(([, config]) => config.fieldRules !== undefined)
      .map(([type]) => type);
    expect(declaring).toEqual(["databend", "s3"]);
    for (const type of ALL_TYPES.filter((candidate) => candidate !== "databend" && candidate !== "s3")) {
      expect(
        connectionFieldRefusal(
          getDBConfig(type),
          databend({ type, user: "", warehouse: "small xy", region: "us/east" }),
        ),
      ).toBe(undefined);
    }
  });
});

describe("declared field rules", () => {
  const s3 = (fields: Partial<DatabaseConnection>): DatabaseConnection => ({
    id: "c1",
    name: "Objects",
    type: "s3",
    host: "localhost",
    port: 9000,
    user: "minio-reader",
    password: "reader-secret-key",
    createdAt: new Date(),
    ...fields,
  });
  const providerRefusal = (connection: DatabaseConnection): string | undefined => {
    try {
      buildS3ConnectionOptions(connection, { executionReadOnly: false, queryTimeout: 30_000 });
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  };
  const FORMAT = S3_FIELD_RULES.user?.format?.sentence;
  const RANGE = S3_FIELD_RULES.user?.charRange?.sentence;
  const BUCKET = S3_FIELD_RULES.database?.format?.sentence;
  const REGION = S3_FIELD_RULES.region?.format?.sentence;

  test("the form's S3 patterns and sentences are the provider's, which the dialog cannot import because it is server code", () => {
    expect(S3_FIELD_RULES.user?.format?.pattern.source).toBe(S3_ACCESS_KEY_ID_PATTERN.source);
    expect(S3_FIELD_RULES.database?.format?.pattern.source).toBe(S3_BUCKET_PATTERN.source);
    expect(S3_FIELD_RULES.region?.format?.pattern.source).toBe(S3_REGION_PATTERN.source);
    for (const rule of [S3_FIELD_RULES.user, S3_FIELD_RULES.database, S3_FIELD_RULES.region]) {
      expect(rule?.format?.pattern.flags).toBe("");
      // Blank passes on every field: an empty key pair is unsigned, an empty Bucket pins nothing, an empty Region is
      // us-east-1.
      expect(rule?.required).toBeUndefined();
    }
    expect(S3_FIELD_RULES.user?.charRange?.min).toBe(S3_ACCESS_KEY_ID_MIN_CHARS);
    expect(S3_FIELD_RULES.user?.charRange?.max).toBe(S3_ACCESS_KEY_ID_MAX_CHARS);
    const providerSentences: readonly unknown[] = Object.values(S3_CONNECTION_SENTENCES);
    for (const sentence of [FORMAT, RANGE, BUCKET, REGION]) expect(providerSentences).toContain(sentence);
    // Each sentence names its field first and holds no value.
    expect(FORMAT).toStartWith("Access key ID ");
    expect(RANGE).toStartWith("Access key ID ");
    expect(BUCKET).toStartWith("Bucket ");
    expect(REGION).toStartWith("Region ");
  });

  test("connectionFieldRefusal checks the access key ID, the bucket and the region, naming the field and never the value", () => {
    const config = getDBConfig("s3");
    expect(connectionFieldRefusal(config, s3({ user: "", password: "", database: "", region: "" }))).toBeUndefined();
    expect(connectionFieldRefusal(config, s3({ user: undefined, password: undefined }))).toBeUndefined();
    for (const user of ["AKIA EXAMPLE", "a/b", "a,b", "a=b"]) {
      const refusal = connectionFieldRefusal(config, s3({ user }));
      expect(refusal).toBe(FORMAT);
      expect(refusal).not.toContain(user);
    }
    expect(connectionFieldRefusal(config, s3({ user: "ab" }))).toBe(RANGE);
    expect(connectionFieldRefusal(config, s3({ user: "abc" }))).toBeUndefined();
    expect(connectionFieldRefusal(config, s3({ user: "a".repeat(512) }))).toBeUndefined();
    expect(connectionFieldRefusal(config, s3({ user: "a".repeat(513) }))).toBe(RANGE);
    for (const database of [".", "..", "-x", "a/b"]) {
      expect(connectionFieldRefusal(config, s3({ database }))).toBe(BUCKET);
    }
    expect(connectionFieldRefusal(config, s3({ database: "Legacy_Bucket.Name" }))).toBeUndefined();
    for (const region of [" us-east-1", "us/east"]) {
      expect(connectionFieldRefusal(config, s3({ region }))).toBe(REGION);
    }
    for (const region of ["garage", "auto"]) {
      expect(connectionFieldRefusal(config, s3({ region }))).toBeUndefined();
    }
  });

  // The copies agree on the values a user types or pastes, not only on their spelling.
  test.each([
    ["user", "AKIAIOSFODNN7EXAMPLE"],
    ["user", "abc"],
    ["user", "a".repeat(512)],
    ["user", "ab"],
    ["user", "a".repeat(513)],
    ["user", "AKIA EXAMPLE"],
    ["user", "a/b"],
    ["user", "a,b"],
    ["user", "a=b"],
    ["user", "ÅKIA1234"],
    ["user", "AKIA\u200BEXAMPLE"],
    ["user", "AKIA1234\n"],
    ["database", "sales"],
    ["database", "Legacy_Bucket.Name"],
    ["database", "b".repeat(255)],
    ["database", "b".repeat(256)],
    ["database", "."],
    ["database", ".."],
    ["database", "-x"],
    ["database", "x-"],
    ["database", "a/b"],
    ["database", "   "],
    ["region", "us-east-1"],
    ["region", "garage"],
    ["region", "auto"],
    ["region", "r".repeat(64)],
    ["region", "r".repeat(65)],
    ["region", " us-east-1"],
    ["region", "us/east"],
    ["region", "us-east-1\n"],
    ["region", "   "],
  ] as const)("the form and the provider give one answer for %s %p", (field, value) => {
    const connection = s3({ [field]: value });
    expect({ field, value, form: connectionFieldRefusal(getDBConfig("s3"), connection) }).toEqual({
      field,
      value,
      form: providerRefusal(connection),
    });
  });

  // With two fields wrong, both name the access key ID first, the dialog's field order and the provider's row order.
  test("two wrong fields name the access key ID first on both sides", () => {
    const connection = s3({ user: "a/b", region: "us/east" });
    expect(connectionFieldRefusal(getDBConfig("s3"), connection)).toBe(FORMAT);
    expect(providerRefusal(connection)).toBe(FORMAT);
  });
});

describe("a declared character range", () => {
  const FORMAT = "Name must be lower-case letters. Nothing was sent.";
  const RANGE = "Name holds 3 to 5 characters. Nothing was sent.";
  const config: DatabaseUIConfig = {
    ...getDBConfig("postgres"),
    fieldRules: {
      user: { format: { pattern: /^[a-z]+$/, sentence: FORMAT }, charRange: { min: 3, max: 5, sentence: RANGE } },
    },
  };
  const named = (user: string | undefined): DatabaseConnection => ({
    id: "c1",
    name: "Synthetic",
    type: "postgres",
    host: "localhost",
    port: 5432,
    user,
    createdAt: new Date(),
  });

  test("connectionFieldRefusal checks charRange after format", () => {
    // Out of range and failing the format: the format sentence, as the provider's format row runs before its range row.
    expect(connectionFieldRefusal(config, named("AB"))).toBe(FORMAT);
    expect(connectionFieldRefusal(config, named("ABCDEFG"))).toBe(FORMAT);
    // Passing the format and outside the range: the range sentence, at either end.
    expect(connectionFieldRefusal(config, named("ab"))).toBe(RANGE);
    expect(connectionFieldRefusal(config, named("abcdef"))).toBe(RANGE);
    // Both ends are inside.
    expect(connectionFieldRefusal(config, named("abc"))).toBeUndefined();
    expect(connectionFieldRefusal(config, named("abcde"))).toBeUndefined();
  });

  test("a blank value never reaches the range, so a blank field still passes", () => {
    expect(connectionFieldRefusal(config, named(""))).toBeUndefined();
    expect(connectionFieldRefusal(config, named(undefined))).toBeUndefined();
  });

  test("a range declared without a format is checked on its own", () => {
    const rangeOnly: DatabaseUIConfig = {
      ...config,
      fieldRules: { user: { charRange: { min: 3, max: 5, sentence: RANGE } } },
    };
    expect(connectionFieldRefusal(rangeOnly, named("A B"))).toBeUndefined();
    expect(connectionFieldRefusal(rangeOnly, named("A"))).toBe(RANGE);
  });
});

describe("db-showcase", () => {
  describe("SHOWCASE_RANK", () => {
    test("assigns every database type a distinct rank covering 0..N-1", () => {
      // A stable sort silently preserves insertion order when two keys compare equal,
      // so a duplicated rank would swap two engines without ever failing a type check.
      // Asserting the ranks are a bijection onto 0..N-1 is what rules that out.
      const ranks = ALL_TYPES.map((type) => SHOWCASE_RANK[type]);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ALL_TYPES.map((_, index) => index));
    });
  });

  describe("SHOWCASE_DATABASE_ORDER", () => {
    test("renders every configured engine exactly once", () => {
      expect([...SHOWCASE_DATABASE_ORDER].sort()).toEqual([...ALL_TYPES].sort());
    });

    test("includes the embedded libredb provider", () => {
      // Decided in issue #425 step 2: libredb is a shipped, user-selectable provider
      // with its own doc and icon, so hiding it on the page that says "Supported
      // Databases" would contradict the connection picker one click later.
      expect(SHOWCASE_DATABASE_ORDER).toContain("libredb");
    });

    test("orders the engines by recognisability, best known first", () => {
      expect([...SHOWCASE_DATABASE_ORDER]).toEqual([
        "postgres",
        "mysql",
        "sqlite",
        // Immediately after SQLite: the two file-based engines read together, and
        // DuckDB is the best-known name of the analytical group.
        "duckdb",
        "mongodb",
        "redis",
        "oracle",
        "mssql",
        // Right after SQL Server (#786): a mainstream relational engine, read beside Oracle and
        // SQL Server rather than among the search and analytical engines.
        "db2",
        "elasticsearch",
        "opensearch",
        "cassandra",
        // Behind Cassandra and ahead of the analytical stores: the best-known graph database, and the
        // only one on this page.
        "neo4j",
        "couchbase",
        "clickhouse",
        "druid",
        "trino",
        // Behind Trino and ahead of libSQL (#1085): a name every cloud-native evaluator knows,
        // met as the metrics store beside their databases rather than as one of them.
        "prometheus",
        // Directly after Prometheus (InfluxDB spec R28): the two time-series stores read together, one InfluxDB
        // connection type per query language.
        "influxdb",
        "influxdb3",
        // Behind the time-series stores and ahead of libSQL (#1088), for the same reason: the message log
        // those teams run beside their databases, met beside them rather than as one of them.
        "kafka",
        // Behind Kafka and ahead of libSQL (#1089), for the reason the two before it sit where they do: the store
        // a Kubernetes control plane keeps its state in, met beside the databases rather than as one of them.
        "etcd",
        // Behind etcd and ahead of libSQL (vector-family spec 10.3): the vector databases a team runs beside its
        // databases, met beside them rather than as one of them, as the three before them are; Milvus first,
        // the one of the two an evaluator is more likely to have met.
        "milvus",
        "qdrant",
        // Behind Qdrant and ahead of libSQL (SB3-1.2 R19): the store an Apache Pulsar cluster keeps its metadata
        // in, met beside the databases rather than as one of them.
        "oxia",
        // Behind Oxia and ahead of libSQL (design 7.2): the cloud data warehouse a team runs beside its databases,
        // the newest name on this page, so only libSQL and the embedded store move (the Milvus, Qdrant, Oxia precedent).
        "databend",
        // Behind Databend and ahead of libSQL: the object store a team keeps its files in beside its
        // databases, the newest name on this page, so only libSQL and the embedded store move (the Milvus, Qdrant, Oxia
        // and Databend precedent).
        "s3",
        "libsql",
        "libredb",
      ]);
    });
  });

  describe("listShowcaseDatabases", () => {
    test("carries the label, icon and colour straight from DB_UI_CONFIG", () => {
      const entries = listShowcaseDatabases();
      expect(entries.map((entry) => entry.type)).toEqual([...SHOWCASE_DATABASE_ORDER]);
      for (const entry of entries) {
        const config = getDBConfig(entry.type);
        expect(entry.label).toBe(config.label);
        expect(entry.icon).toBe(config.icon);
        expect(entry.color).toBe(config.color);
      }
    });

    test("returns a fresh array each call, so a caller cannot mutate the shared order", () => {
      expect(listShowcaseDatabases()).not.toBe(listShowcaseDatabases());
      expect(listShowcaseDatabases()).toEqual(listShowcaseDatabases());
    });
  });
});

describe("Host box addresses and credential warnings", () => {
  test("only milvus, qdrant, the two InfluxDB types, databend and s3 declare hostAcceptsUri, so every other Host box takes a host alone", () => {
    expect(ALL_TYPES.filter((type) => hostUriSchemes(type).length > 0)).toEqual([
      "milvus",
      "qdrant",
      "influxdb",
      "influxdb3",
      "databend",
      "s3",
    ]);
  });

  test("hostUriSchemes reads an entry's declaration, and only that entry's", () => {
    const restore = declareHostUri("etcd", ["http", "https"]);
    try {
      expect(hostUriSchemes("etcd")).toEqual(["http", "https"]);
      expect(hostUriSchemes("postgres")).toEqual([]);
    } finally {
      restore();
    }
    expect(hostUriSchemes("etcd")).toEqual([]);
  });

  test("every entry's credentialWarnings is the shared record's own array, never a copy", () => {
    for (const type of ALL_TYPES) {
      expect({ type, same: getDBConfig(type).credentialWarnings === CREDENTIAL_WARNINGS[type] }).toEqual({
        type,
        same: true,
      });
    }
  });

  test("an entry's credentialWarnings is the shared record's array once a type declares one", () => {
    const declared = [SYNTHETIC_PAIR, SYNTHETIC_NO_SECRET];
    const restore = declareCredentialWarnings("etcd", declared);
    try {
      expect(getDBConfig("etcd").credentialWarnings).toBe(declared);
      expect(getDBConfig("etcd").credentialWarnings).toBe(CREDENTIAL_WARNINGS.etcd);
      expect(getDBConfig("postgres").credentialWarnings).toBeUndefined();
    } finally {
      restore();
    }
    expect(getDBConfig("etcd").credentialWarnings).toBeUndefined();
  });
});
