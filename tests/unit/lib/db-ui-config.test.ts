import { describe, test, expect } from "bun:test";
import { getDBConfig, getDBIcon, getDBColor, isFileBased } from "@/lib/db-ui-config";
import { SHOWCASE_DATABASE_ORDER, SHOWCASE_RANK, listShowcaseDatabases } from "@/lib/db-showcase";
import type { DatabaseType } from "@/lib/types";

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
      const withToggle = new Set<DatabaseType>(["mongodb", "couchbase", "clickhouse"]);
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
