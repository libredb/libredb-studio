import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READS_FILE_ACCESS_POSTURE, REFUSES_DENIED_FILE_ACCESS, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider, type ExecutionProfile, executionContextFor } from "@/lib/db/factory";
import { admittedFileConnection } from "@/lib/db/provider-files";
import type { DatabaseProvider, ProviderExecutionContext } from "@/lib/db/types";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { createDuckdbFile, createSqliteFile } from "../../helpers/mcp-fixtures";

/**
 * `REFUSES_DENIED_FILE_ACCESS` against what each engine that reads the file-access posture does when it
 * opens under the context an MCP open gives a caller whose file access is denied.
 *
 * The record is static because MCP decides before any provider exists: `list_connections` and
 * `inspect_schema` ask it whether any open of a listed connection can succeed for its caller, and no
 * provider declares the fact. So the failure that matters is the record, the provider factory and `connect()`
 * disagreeing: a refusing row's sentence must be what the factory refuses with before the provider is built, and
 * what the provider's own `connect()` raises for a handle built with that context, and a null row must open a real
 * file, under both MCP profiles. How to build each refusing engine's provider without the factory and a real file of
 * each posture engine are tables here, so a new posture engine fails until someone answers for it.
 */

const MCP_PROFILES: readonly ExecutionProfile[] = ["agent-read-only", "agent-operations"];
const POSTURE_ENGINES = SHIPPED_DATABASE_TYPES.filter((type) => READS_FILE_ACCESS_POSTURE[type]);

/** Each refusing engine's provider, built without the factory on the connection the factory admits. */
const BUILD_DIRECTLY: Partial<
  Record<DatabaseType, (connection: DatabaseConnection, context: ProviderExecutionContext) => Promise<DatabaseProvider>>
> = {
  sqlite: async (connection, context) => {
    const { SQLiteProvider } = await import("@/lib/db/providers/sql/sqlite");
    return new SQLiteProvider(admittedFileConnection(connection), {}, context);
  },
};

/** A real database file of each posture engine, which a false row must open. */
const WRITE_FILE: Partial<Record<DatabaseType, (path: string) => Promise<void>>> = {
  sqlite: async (path) => createSqliteFile(path, ["CREATE TABLE t (id INTEGER)"]),
  duckdb: (path) => createDuckdbFile(path, ["CREATE TABLE t (id INTEGER)"]),
};

const dir = mkdtempSync(join(tmpdir(), "libredb-refuses-denied-"));
const realFile = (type: DatabaseType) => join(dir, `real.${type}`);
const connectionOf = (type: DatabaseType, database: string): DatabaseConnection => ({
  id: `census-${type}`,
  name: "census",
  type,
  database,
  createdAt: new Date(0),
});

let savedEnabled: string | undefined;

// A first DuckDB native open on a Windows runner takes most of a minute, so the files are written once.
beforeAll(async () => {
  // The factory refuses an engine LIBREDB_ENABLED_PROVIDERS leaves out, so a developer's setting is set aside.
  savedEnabled = process.env.LIBREDB_ENABLED_PROVIDERS;
  delete process.env.LIBREDB_ENABLED_PROVIDERS;
  await Promise.all(POSTURE_ENGINES.map((type) => WRITE_FILE[type]?.(realFile(type))));
}, 180_000);

afterAll(() => {
  if (savedEnabled === undefined) delete process.env.LIBREDB_ENABLED_PROVIDERS;
  else process.env.LIBREDB_ENABLED_PROVIDERS = savedEnabled;
  rmSync(dir, { recursive: true, force: true });
});

/** What the provider factory settles to: the refusal it threw, or null when it built a provider. */
async function buildRefusalOf(
  type: DatabaseType,
  database: string,
  context: ProviderExecutionContext,
): Promise<unknown> {
  return createDatabaseProvider(connectionOf(type, database), {}, context).then(
    () => null,
    (error: unknown) => error,
  );
}

/** What the provider's own `connect()` raises when it is built without the factory. */
async function connectRefusalOf(
  type: DatabaseType,
  database: string,
  context: ProviderExecutionContext,
): Promise<unknown> {
  const provider = await BUILD_DIRECTLY[type]!(connectionOf(type, database), context);
  const refusal = await provider.connect().then(
    () => null,
    (error: unknown) => error,
  );
  expect(provider.isConnected()).toBe(false);
  return refusal;
}

describe("REFUSES_DENIED_FILE_ACCESS", () => {
  test("answers for every shipped type-id and for nothing else", () => {
    expect(Object.keys(REFUSES_DENIED_FILE_ACCESS).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test("is frozen, so no reader can change it at run time", () => {
    expect(Object.isFrozen(REFUSES_DENIED_FILE_ACCESS)).toBe(true);
  });

  test("holds a sentence only for an engine that reads the file-access posture", () => {
    expect(
      SHIPPED_DATABASE_TYPES.filter(
        (type) => REFUSES_DENIED_FILE_ACCESS[type] !== null && !READS_FILE_ACCESS_POSTURE[type],
      ),
    ).toEqual([]);
  });

  test("SQLite refuses a handle opened with file access denied, and DuckDB confines one", () => {
    expect(SHIPPED_DATABASE_TYPES.filter((type) => REFUSES_DENIED_FILE_ACCESS[type] !== null)).toEqual(["sqlite"]);
    expect(REFUSES_DENIED_FILE_ACCESS.sqlite).toBe(
      "SQLite connections require an administrator because this driver cannot confine statement-level file access",
    );
    expect(REFUSES_DENIED_FILE_ACCESS.duckdb).toBeNull();
  });

  test("the census knows how to build each refusing engine without the factory and a real file of each posture engine", () => {
    expect(Object.keys(BUILD_DIRECTLY).sort()).toEqual(
      SHIPPED_DATABASE_TYPES.filter((type) => REFUSES_DENIED_FILE_ACCESS[type] !== null).sort(),
    );
    expect(Object.keys(WRITE_FILE).sort()).toEqual([...POSTURE_ENGINES].sort());
  });

  test.each(POSTURE_ENGINES.flatMap((type) => MCP_PROFILES.map((profile) => [type, profile] as const)))(
    "%s under %s with file access denied: the factory and connect() answer what the row says",
    async (type, profile) => {
      const context = executionContextFor(profile, { allowExternalFileAccess: false });
      expect(context).toMatchObject({ readOnly: true, allowExternalFileAccess: false });
      const sentence = REFUSES_DENIED_FILE_ACCESS[type];
      if (sentence !== null) {
        // Refused by the factory before the provider is built, and by the provider's own connect() before it opens
        // anything: a path that does not exist gets the same refusal and is still absent after it, and a real file is
        // refused alike, so the refusal is the posture's and not the file's.
        const missing = join(dir, `missing-${type}-${profile}`);
        const refusals = await Promise.all([
          buildRefusalOf(type, missing, context),
          buildRefusalOf(type, realFile(type), context),
          connectRefusalOf(type, missing, context),
          connectRefusalOf(type, realFile(type), context),
        ]);
        for (const refusal of refusals) {
          expect(refusal).toBeInstanceOf(DatabaseConfigError);
          const { message, provider } = refusal as DatabaseConfigError;
          expect([message, provider]).toEqual([sentence, type]);
        }
        expect(existsSync(missing)).toBe(false);
      } else {
        const provider = await createDatabaseProvider(connectionOf(type, realFile(type)), {}, context);
        await provider.connect();
        try {
          expect(provider.isConnected()).toBe(true);
        } finally {
          await provider.disconnect();
        }
      }
    },
    180_000,
  );
});
