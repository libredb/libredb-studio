import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { getDBConfig, getDBIcon, getDBColor, isFileBased, takesConnectionField } from "@/lib/db-ui-config";
import { SHOWCASE_DATABASE_ORDER, SHOWCASE_RANK, listShowcaseDatabases } from "@/lib/db-showcase";
import type { DatabaseType } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../..");

const ALL_TYPES: DatabaseType[] = [
  "postgres",
  "mysql",
  "sqlite",
  "mongodb",
  "redis",
  "oracle",
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
      expect(getDBConfig("trino").connectionFields).toEqual(["host", "port", "user", "password", "database"]);
    });

    test("trino keeps the database field, because it selects the catalog", () => {
      // The opposite of Druid, and the reason the two HTTP engines differ here: a Trino
      // coordinator fronts MANY catalogs (measured on 476: `SHOW CATALOGS` answers
      // jmx, memory, system, tpcds, tpch), and a connection pins one the way a
      // PostgreSQL connection pins a database. Without the field every connection would
      // open on whatever the coordinator defaults to, which is nothing.
      expect(getDBConfig("trino").connectionFields).toContain("database");
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
      const files = existsSync(`${base}.ts`)
        ? [`${base}.ts`]
        : readdirSync(base, { recursive: true, encoding: "utf8" })
            .map((entry) => path.join(base, entry))
            .filter((entry) => entry.endsWith(".ts"));
      const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
      return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    };

    test("the factory names a readable module for every type", () => {
      // Every assertion below is vacuously true if the source comes back empty.
      for (const type of ALL_TYPES) expect(providerSource(type).length).toBeGreaterThan(200);
    });

    test.each(["user", "database"] as const)("a provider that reads config.%s is given it", (field) => {
      const diverging = ALL_TYPES.filter(
        (type) =>
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
        // libSQL: a token, not a user name; and the database IS the host.
        expect(takesConnectionField("libsql", "user")).toBe(false);
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
        const FIELDS = ["host", "port", "user", "password", "database", "connectionString"] as const;
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
        "elasticsearch",
        "opensearch",
        "cassandra",
        "couchbase",
        "clickhouse",
        "druid",
        "trino",
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
