/**
 * LIBREDB_ENABLED_PROVIDERS, the enabled-provider allowlist (P1): unset or blank changes nothing, and a type
 * outside a set list is refused before its provider module is evaluated, so its driver is never required.
 * Runs in its own process, as the runner gives every file: the provider modules below are mocked process-wide.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/db/types";

const evaluated: string[] = [];
const providerModule = (name: string, exportName: string) => () => {
  evaluated.push(name);
  return {
    [exportName]: class {
      constructor(public config: unknown) {}
    },
  };
};
mock.module("@/lib/db/providers/sql/sqlite", providerModule("sqlite", "SQLiteProvider"));
mock.module("@/lib/db/providers/sql/duckdb", providerModule("duckdb", "DuckDBProvider"));
mock.module("@/lib/db/providers/sql/db2/index", providerModule("db2", "Db2Provider"));
mock.module("@/lib/db/providers/sql/oracle", providerModule("oracle", "OracleProvider"));
mock.module("@/lib/db/providers/sql/postgres", providerModule("postgres", "PostgresProvider"));

const createSSHTunnel = mock(async () => {
  throw new Error("the tunnel was dialled");
});
mock.module("@/lib/ssh/tunnel", () => ({
  createSSHTunnel,
  closeSSHTunnel: mock(async () => {}),
  hasTunnel: () => false,
}));

const {
  enabledProviderTypes,
  createDatabaseProvider,
  getOrCreateProvider,
  acquireExecutionProfileProvider,
  withOneShotTunnel,
} = await import("@/lib/db/factory");

const VSCODE_LIST = "postgres,mssql,mysql,mongodb";

afterEach(() => {
  delete process.env.LIBREDB_ENABLED_PROVIDERS;
  createSSHTunnel.mockClear();
});

describe("enabledProviderTypes", () => {
  test("unset answers null", () => {
    expect(enabledProviderTypes()).toBeNull();
  });
  test("blank answers null", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = "  \t ";
    expect(enabledProviderTypes()).toBeNull();
  });
  test("the VS Code list parses in order", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = VSCODE_LIST;
    expect(enabledProviderTypes()).toEqual(["postgres", "mssql", "mysql", "mongodb"]);
  });
  test("entries are trimmed, empty ones dropped, duplicates kept once", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = " postgres , ,mssql,postgres,, libredb ";
    expect(enabledProviderTypes()).toEqual(["postgres", "mssql", "libredb"]);
  });
  test("an entry that is not a type id throws naming it", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres,postgresql";
    expect(() => enabledProviderTypes()).toThrow(/LIBREDB_ENABLED_PROVIDERS.*"postgresql"/);
  });
  test("a set value with no entry throws", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = " , ,";
    expect(() => enabledProviderTypes()).toThrow(/LIBREDB_ENABLED_PROVIDERS/);
  });
});

const conn = (type: string, extra: Partial<DatabaseConnection> = {}): DatabaseConnection =>
  ({ id: "c1", name: "probe", type, host: "db.internal", port: 5000, database: "d", ...extra }) as DatabaseConnection;

const EXCLUDED = ["sqlite", "duckdb", "db2", "oracle"] as const;

describe("createDatabaseProvider under a set list", () => {
  for (const type of EXCLUDED) {
    test(`${type} is refused with CONFIG_ERROR and its module is never evaluated`, async () => {
      process.env.LIBREDB_ENABLED_PROVIDERS = VSCODE_LIST;
      const refusal = await createDatabaseProvider(conn(type)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(DatabaseConfigError);
      expect((refusal as DatabaseConfigError).message).toBe(
        `The ${type} provider is not available in this distribution of LibreDB Studio.`,
      );
      expect((refusal as DatabaseConfigError).code).toBe("CONFIG_ERROR");
      expect((refusal as DatabaseConfigError).provider).toBe(type);
      expect(evaluated).not.toContain(type);
    });
  }

  test("the refusal comes before the readOnly check", async () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = VSCODE_LIST;
    await expect(createDatabaseProvider(conn("sqlite", { readOnly: "yes" as never }))).rejects.toThrow(
      "The sqlite provider is not available in this distribution of LibreDB Studio.",
    );
  });

  test("a listed type is built", async () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = VSCODE_LIST;
    const provider = await createDatabaseProvider(conn("postgres"));
    expect(provider).toBeDefined();
    expect(evaluated).toContain("postgres");
  });

  test("a bad value refuses every type, naming the entry", async () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres,nosuch";
    await expect(createDatabaseProvider(conn("postgres"))).rejects.toThrow(/"nosuch"/);
  });

  test("unset builds a listed type", async () => {
    const provider = await createDatabaseProvider(conn("postgres"));
    expect(provider).toBeDefined();
  });
});
