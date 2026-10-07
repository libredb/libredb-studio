import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTION_FORM_URI_MODE, CONNECTION_STRING_ACCEPTED, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * The two connection-string records of Spec A section 7, each held equal to its source of truth.
 *
 * Both are static because their readers decide before anything is built: the seed schema refuses a
 * `connectionString` at load where `CONNECTION_STRING_ACCEPTED` answers false, and the environment-URL source
 * of PR A2 will keep a pasted URI verbatim only where `CONNECTION_FORM_URI_MODE` answers true. The seed layer
 * must not read `DB_UI_CONFIG` itself, because `src/lib/db-ui-config.ts` value-imports the React icon
 * components.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a constructor, the
 * reading `CENSUS_CONNECTION` documents.
 */
describe("CONNECTION_FORM_URI_MODE against the connection form (Spec A section 7)", () => {
  test("answers for every shipped type-id and for nothing else", () => {
    expect(Object.keys(CONNECTION_FORM_URI_MODE).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test("is frozen, so no reader can change an answer at run time", () => {
    expect(Object.isFrozen(CONNECTION_FORM_URI_MODE)).toBe(true);
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s: the record answers what the form's toggle declares", (type) => {
    expect(CONNECTION_FORM_URI_MODE[type]).toBe(DB_UI_CONFIG[type].showConnectionStringToggle);
  });

  test("offers a URI mode for libsql, clickhouse, mongodb and couchbase only", () => {
    // Vacuity, by name: a record that answered false everywhere would pass the census above against a form
    // that also offered nothing.
    expect(SHIPPED_DATABASE_TYPES.filter((type) => CONNECTION_FORM_URI_MODE[type])).toEqual([
      "libsql",
      "clickhouse",
      "mongodb",
      "couchbase",
    ]);
  });
});

/**
 * The declared exceptions of Spec A section 7, where the record follows what the provider does with
 * `connectionString` instead of its `supportsConnectionString` flag: sqlite declares false but opens the string as
 * the file path, and mssql declares true for the form's paste but builds from the fields only. The census holds
 * every other type to its flag; each type here is pinned by a behavioural test instead.
 */
const CENSUS_EXCEPTIONS: readonly DatabaseType[] = ["sqlite", "mssql"];

const sqliteDir = mkdtempSync(join(tmpdir(), "libredb-connection-string-records-"));

afterAll(() => {
  rmSync(sqliteDir, { recursive: true, force: true });
});

describe("CONNECTION_STRING_ACCEPTED against each provider's own declaration (Spec A section 7)", () => {
  test("answers for every shipped type-id and for nothing else", () => {
    expect(Object.keys(CONNECTION_STRING_ACCEPTED).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test("is frozen, so no reader can change an answer at run time", () => {
    expect(Object.isFrozen(CONNECTION_STRING_ACCEPTED)).toBe(true);
  });

  test.each(SHIPPED_DATABASE_TYPES.filter((type) => !CENSUS_EXCEPTIONS.includes(type)))(
    "%s: the record answers what its provider declares",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      expect(CONNECTION_STRING_ACCEPTED[type]).toBe(provider.getCapabilities().supportsConnectionString === true);
    },
  );

  test("the record and the flag disagree on exactly sqlite and mssql, the census exceptions", async () => {
    // Measured, not restated: a third disagreement, or a flag corrected to match its provider, fails here.
    const providers = await Promise.all(
      SHIPPED_DATABASE_TYPES.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])),
    );
    const disagreeing = SHIPPED_DATABASE_TYPES.filter(
      (type, index) =>
        CONNECTION_STRING_ACCEPTED[type] !== (providers[index].getCapabilities().supportsConnectionString === true),
    );
    expect(disagreeing).toEqual(["sqlite", "mssql"]);
    expect([...CENSUS_EXCEPTIONS]).toEqual(disagreeing);
  });

  test("sqlite: the record accepts the string although the provider's flag still says false", async () => {
    // If the flag is corrected to true, this fails: drop sqlite from CENSUS_EXCEPTIONS, and the census covers it.
    const provider = await createDatabaseProvider(CENSUS_CONNECTION.sqlite);
    expect(provider.getCapabilities().supportsConnectionString).toBe(false);
    expect(CONNECTION_STRING_ACCEPTED.sqlite).toBe(true);
  });

  test("sqlite: a file: connection string with no database opens, and creates, the file it names", async () => {
    // The behaviour the record follows (sqlite.ts getDatabasePath): without it, the exception above would be a guess.
    const file = join(sqliteDir, "x.db");
    const provider = await createDatabaseProvider({
      id: "connection-string-sqlite",
      name: "Connection string sqlite",
      type: "sqlite",
      connectionString: `file:${file}`,
      createdAt: new Date(0),
    });
    await provider.connect();
    try {
      expect(existsSync(file)).toBe(true);
    } finally {
      await provider.disconnect();
    }
  });

  test("mssql: the record refuses the string although the provider's flag says true", async () => {
    // The flag is true for the form's paste, which splits the URI into fields (docs/providers/mssql.md 4.4). If the
    // provider starts reading the string, drop mssql from CENSUS_EXCEPTIONS and set the record to true.
    const provider = await createDatabaseProvider(CENSUS_CONNECTION.mssql);
    expect(provider.getCapabilities().supportsConnectionString).toBe(true);
    expect(CONNECTION_STRING_ACCEPTED.mssql).toBe(false);
  });

  test("mssql: a config with only a connection string validates and builds against localhost, the string unread", async () => {
    // The behaviour the record follows (mssql.ts validate and buildConfig): a seed entry like this would list a
    // connection that opens localhost instead of db.example, so the seed schema refuses it.
    const provider = await createDatabaseProvider({
      id: "connection-string-mssql",
      name: "Connection string mssql",
      type: "mssql",
      connectionString: "mssql://sa:pw@db.example:1433/app",
      createdAt: new Date(0),
    });
    expect(() => provider.validate()).not.toThrow();
    // buildConfig is private; reached through a cast, as tests/integration/db/mssql-provider.test.ts reaches the
    // protected escapeIdentifier. Nothing connects.
    const config = (
      provider as unknown as { buildConfig(): { server: string; port: number; database?: string } }
    ).buildConfig();
    expect(config.server).toBe("localhost");
    expect(config.port).toBe(1433);
    expect(config.database).toBeUndefined();
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s declares supportsConnectionString as a boolean", async (type) => {
    // The comparison above reads anything but `true` as not accepting, so only this can tell a provider that
    // declared the flag some other way from one that declared false.
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect(typeof provider.getCapabilities().supportsConnectionString).toBe("boolean");
  });

  test("accepts a connection string on nine engines and refuses it on the other eighteen", () => {
    expect(SHIPPED_DATABASE_TYPES.filter((type) => CONNECTION_STRING_ACCEPTED[type])).toEqual([
      "postgres",
      "mysql",
      "sqlite",
      "libsql",
      "oracle",
      "db2",
      "clickhouse",
      "mongodb",
      "couchbase",
    ]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => !CONNECTION_STRING_ACCEPTED[type])).toEqual([
      "duckdb",
      "mssql",
      "druid",
      "trino",
      "cassandra",
      "elasticsearch",
      "opensearch",
      "redis",
      "prometheus",
      "kafka",
      "etcd",
      "neo4j",
      "milvus",
      "qdrant",
      "influxdb",
      "influxdb3",
      "oxia",
      "libredb",
    ]);
  });

  test("every type whose form offers a URI mode also has a provider that reads the string", () => {
    const formOnly = SHIPPED_DATABASE_TYPES.filter(
      (type) => CONNECTION_FORM_URI_MODE[type] && !CONNECTION_STRING_ACCEPTED[type],
    );
    expect(formOnly).toEqual([]);
  });
});

describe("docs/SEED_CONNECTIONS.md names the types CONNECTION_STRING_ACCEPTED answers (Spec A section 7)", () => {
  const doc = readFileSync(join(import.meta.dir, "../../../docs/SEED_CONNECTIONS.md"), "utf8");
  const list = (types: readonly string[]) => `${types.slice(0, -1).join(", ")} and ${types[types.length - 1]}`;

  test("the accepting types, in registry order", () => {
    const accepting = SHIPPED_DATABASE_TYPES.filter((type) => CONNECTION_STRING_ACCEPTED[type]);
    expect(doc).toContain(`The types whose provider reads it are ${list(accepting)}.`);
  });

  test("the refusing types, with their count, in registry order", () => {
    const refusing = SHIPPED_DATABASE_TYPES.filter((type) => !CONNECTION_STRING_ACCEPTED[type]);
    expect(doc).toContain(`The ${refusing.length} that refuse it are ${list(refusing)}.`);
  });
});
