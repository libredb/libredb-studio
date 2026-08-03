import { describe, test, expect } from "bun:test";
import { getDBConfig, getDBIcon, getDBColor, isFileBased } from "@/lib/db-ui-config";
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
      // MongoDB (mongodb+srv) and Couchbase (couchbase://, couchbases://) are the
      // providers a user routinely has a full URI for; everything else is field-based.
      const withToggle = new Set<DatabaseType>(["mongodb", "couchbase"]);
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
    });
  });
});
