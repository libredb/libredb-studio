/**
 * The governance switch and the settings read with it (docs/GOVERNANCE.md#studio-configuration).
 *
 * `src/lib/governance/config.ts` is the one place Studio reads `GOVERNANCE_SOURCE` and the `GOVERNANCE_*` settings.
 * Unset, governance is off and Studio behaves as it always has; any value other than `postgres` still counts as on,
 * so a typo fails closed. Every reader refuses an invalid value with an error naming its variable instead of falling
 * back, and the module stays free of Node built-ins because `src/proxy.ts` reaches it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONTRACT_OBJECTS, DEFAULT_GOVERNANCE_SCHEMA } from "@/lib/governance/contract";
import {
  governanceAllowedEngines,
  governanceEnabled,
  governanceMaxStalenessMs,
  governancePostgresSchema,
  governancePostgresUrl,
  governanceRefreshMs,
  governanceSource,
} from "@/lib/governance/config";

const ROOT = path.resolve(import.meta.dir, "../../../..");

const KEYS = [
  "GOVERNANCE_SOURCE",
  "GOVERNANCE_POSTGRES_URL",
  "GOVERNANCE_POSTGRES_SCHEMA",
  "GOVERNANCE_REFRESH_MS",
  "GOVERNANCE_MAX_STALENESS_MS",
  "GOVERNANCE_ALLOWED_ENGINES",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** The pattern of a column's CHECK in the contract, which the manifest publishes. */
const contractPattern = (objectName: string, columnName: string): RegExp => {
  const object = CONTRACT_OBJECTS.find((candidate) => candidate.name === objectName);
  if (object === undefined || object.kind === "function") throw new Error(`no columns on ${objectName}`);
  const check = object.columns.find((column) => column.name === columnName)?.check;
  if (check?.kind !== "pattern") throw new Error(`${objectName}.${columnName} has no pattern CHECK`);
  return new RegExp(check.pattern);
};

describe("governanceSource and governanceEnabled", () => {
  test("unset or empty is off, and governance stays off", () => {
    expect(governanceSource()).toBe("off");
    expect(governanceEnabled()).toBe(false);
    process.env.GOVERNANCE_SOURCE = "";
    expect(governanceSource()).toBe("off");
    expect(governanceEnabled()).toBe(false);
  });

  test("postgres switches governance on", () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    expect(governanceSource()).toBe("postgres");
    expect(governanceEnabled()).toBe(true);
  });

  test("any other value is invalid and still counts as on, so the server fails closed", () => {
    for (const value of ["postgress", "Postgres", " postgres", "postgres ", "off", "false", "0", " "]) {
      process.env.GOVERNANCE_SOURCE = value;
      expect(governanceSource(), value).toBe("invalid");
      expect(governanceEnabled(), value).toBe(true);
    }
  });
});

describe("GOVERNANCE_POSTGRES_URL", () => {
  test("a postgres:// or postgresql:// URL is returned as set", () => {
    for (const url of [
      "postgresql://libredb_studio:example-only@db.internal:5432/libredb?sslmode=verify-full",
      "postgres://libredb_studio@db.internal/libredb",
      "postgresql:///libredb?host=/var/run/postgresql",
    ]) {
      process.env.GOVERNANCE_POSTGRES_URL = url;
      expect(governancePostgresUrl()).toBe(url);
    }
  });

  test("unset or empty is refused, naming the variable", () => {
    expect(() => governancePostgresUrl()).toThrow("GOVERNANCE_POSTGRES_URL is not set");
    process.env.GOVERNANCE_POSTGRES_URL = "";
    expect(() => governancePostgresUrl()).toThrow("GOVERNANCE_POSTGRES_URL is not set");
  });

  test("anything but a PostgreSQL URL is refused, and the message never quotes the value", () => {
    for (const url of [
      "mysql://root:example-only-secret@db.internal/libredb",
      "db.internal:5432/libredb",
      "host=db.internal user=libredb_studio password=example-only-secret",
      "http://example-only-secret@db.internal/",
    ]) {
      process.env.GOVERNANCE_POSTGRES_URL = url;
      let message = "";
      try {
        governancePostgresUrl();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, url).toContain("GOVERNANCE_POSTGRES_URL");
      expect(message, url).toContain("postgresql://");
      expect(message, url).not.toContain("example-only-secret");
      expect(message, url).not.toContain("db.internal");
    }
  });
});

describe("GOVERNANCE_POSTGRES_SCHEMA", () => {
  test("defaults to the contract's schema, bridge", () => {
    expect(DEFAULT_GOVERNANCE_SCHEMA).toBe("bridge");
    expect(governancePostgresSchema()).toBe(DEFAULT_GOVERNANCE_SCHEMA);
    process.env.GOVERNANCE_POSTGRES_SCHEMA = "";
    expect(governancePostgresSchema()).toBe(DEFAULT_GOVERNANCE_SCHEMA);
  });

  test("a lowercase identifier is returned, and anything else is refused by readSchemaName()", () => {
    process.env.GOVERNANCE_POSTGRES_SCHEMA = "governance_v1";
    expect(governancePostgresSchema()).toBe("governance_v1");
    process.env.GOVERNANCE_POSTGRES_SCHEMA = "Bridge";
    expect(() => governancePostgresSchema()).toThrow(
      'GOVERNANCE_POSTGRES_SCHEMA must be a lowercase PostgreSQL schema name matching ^[a-z_][a-z0-9_]{0,62}$, got "Bridge"',
    );
  });
});

describe("GOVERNANCE_REFRESH_MS", () => {
  test("defaults to 30000 and accepts whole milliseconds from 1000 to 600000", () => {
    expect(governanceRefreshMs()).toBe(30000);
    process.env.GOVERNANCE_REFRESH_MS = " ";
    expect(governanceRefreshMs()).toBe(30000);
    for (const [value, expected] of [
      ["1000", 1000],
      [" 45000 ", 45000],
      ["600000", 600000],
    ] as const) {
      process.env.GOVERNANCE_REFRESH_MS = value;
      expect(governanceRefreshMs()).toBe(expected);
    }
  });

  test("anything else is refused, naming the variable, the range and the value", () => {
    for (const value of ["999", "600001", "0", "-5000", "1e4", "30000.5", "30s", "abc"]) {
      process.env.GOVERNANCE_REFRESH_MS = value;
      expect(() => governanceRefreshMs(), value).toThrow(
        `GOVERNANCE_REFRESH_MS must be a whole number of milliseconds from 1000 to 600000, got ${JSON.stringify(value)}`,
      );
    }
  });
});

describe("GOVERNANCE_MAX_STALENESS_MS", () => {
  test("defaults to 120000 and accepts from GOVERNANCE_REFRESH_MS to 3600000", () => {
    expect(governanceMaxStalenessMs()).toBe(120000);
    process.env.GOVERNANCE_MAX_STALENESS_MS = "30000";
    expect(governanceMaxStalenessMs()).toBe(30000);
    process.env.GOVERNANCE_MAX_STALENESS_MS = "3600000";
    expect(governanceMaxStalenessMs()).toBe(3600000);
    process.env.GOVERNANCE_REFRESH_MS = "60000";
    process.env.GOVERNANCE_MAX_STALENESS_MS = "60000";
    expect(governanceMaxStalenessMs()).toBe(60000);
  });

  test("GOVERNANCE_MAX_STALENESS_MS below GOVERNANCE_REFRESH_MS is invalid", () => {
    process.env.GOVERNANCE_MAX_STALENESS_MS = "29999";
    expect(() => governanceMaxStalenessMs()).toThrow(
      "GOVERNANCE_MAX_STALENESS_MS 29999 is below GOVERNANCE_REFRESH_MS 30000: set it from 30000 to 3600000",
    );
    process.env.GOVERNANCE_REFRESH_MS = "90000";
    process.env.GOVERNANCE_MAX_STALENESS_MS = "60000";
    expect(() => governanceMaxStalenessMs()).toThrow(
      "GOVERNANCE_MAX_STALENESS_MS 60000 is below GOVERNANCE_REFRESH_MS 90000: set it from 90000 to 3600000",
    );
  });

  test("its default below a longer GOVERNANCE_REFRESH_MS is invalid too, and the message says it is the default", () => {
    process.env.GOVERNANCE_REFRESH_MS = "300000";
    expect(() => governanceMaxStalenessMs()).toThrow(
      "GOVERNANCE_MAX_STALENESS_MS is unset, and its default 120000 is below GOVERNANCE_REFRESH_MS 300000: set it from 300000 to 3600000",
    );
  });

  test("a value that is not whole milliseconds up to 3600000 is refused, naming the variable and the value", () => {
    for (const value of ["3600001", "-1", "2m", "120000.0"]) {
      process.env.GOVERNANCE_MAX_STALENESS_MS = value;
      expect(() => governanceMaxStalenessMs(), value).toThrow(
        `GOVERNANCE_MAX_STALENESS_MS must be a whole number of milliseconds from GOVERNANCE_REFRESH_MS to 3600000, got ${JSON.stringify(value)}`,
      );
    }
  });

  test("an invalid GOVERNANCE_REFRESH_MS is reported as itself", () => {
    process.env.GOVERNANCE_REFRESH_MS = "fast";
    expect(() => governanceMaxStalenessMs()).toThrow("GOVERNANCE_REFRESH_MS must be a whole number");
  });
});

describe("GOVERNANCE_ALLOWED_ENGINES", () => {
  test("defaults to the six engines a governance install supports", () => {
    expect(governanceAllowedEngines()).toEqual(["postgres", "mysql", "mssql", "oracle", "mongodb", "redis"]);
    process.env.GOVERNANCE_ALLOWED_ENGINES = "  ";
    expect(governanceAllowedEngines()).toEqual(["postgres", "mysql", "mssql", "oracle", "mongodb", "redis"]);
  });

  test("a comma list is trimmed, drops empty entries and keeps each engine once, in order", () => {
    process.env.GOVERNANCE_ALLOWED_ENGINES = " postgres, mysql,,postgres ,clickhouse ";
    expect(governanceAllowedEngines()).toEqual(["postgres", "mysql", "clickhouse"]);
  });

  test("a list naming no engine is refused", () => {
    for (const value of [",", " , ,"]) {
      process.env.GOVERNANCE_ALLOWED_ENGINES = value;
      expect(() => governanceAllowedEngines(), value).toThrow(
        `GOVERNANCE_ALLOWED_ENGINES must list Studio connection type ids such as postgres, separated by commas, got ${JSON.stringify(value)}`,
      );
    }
  });

  test("an entry is accepted exactly when it has the shape the contract's engine CHECK admits", () => {
    const engineShape = contractPattern("connections_v1", "engine");
    for (const entry of ["postgres", "db2", "influxdb3", "Postgres", "my-sql", "sql_server", "2db", "a".repeat(33)]) {
      process.env.GOVERNANCE_ALLOWED_ENGINES = `mysql,${entry}`;
      if (engineShape.test(entry)) {
        expect(governanceAllowedEngines(), entry).toEqual(["mysql", entry]);
      } else {
        expect(() => governanceAllowedEngines(), entry).toThrow(
          `GOVERNANCE_ALLOWED_ENGINES must list Studio connection type ids such as postgres, separated by commas, got ${JSON.stringify(`mysql,${entry}`)}`,
        );
      }
    }
  });
});

describe("the module boundary", () => {
  test("config.ts imports no Node built-in and nothing but the schema name rule, because src/proxy.ts reaches it", () => {
    const source = readFileSync(path.join(ROOT, "src/lib/governance/config.ts"), "utf8");
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    expect(imports).toEqual(["@/lib/storage/schema-name"]);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
});
