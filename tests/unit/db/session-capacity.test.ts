import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { forgetStorageLocation } from "@/lib/data-dir";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { admittedFileConnection, namesInMemoryDatabase } from "@/lib/db/provider-files";
import { sessionCapacity } from "@/lib/db/session-capacity";
import { ADMITTED_FILE, type DatabaseConnection, type DatabaseType, type WithAdmittedFile } from "@/lib/types";
import { legacyRegisterTable } from "../../helpers/legacy-register";

const opensLocalFile = legacyRegisterTable("opensLocalFile");
const servesOneSession = legacyRegisterTable("servesOneSession");

/**
 * The host's session capacity class (docs/providers/CONTRACT.md, clause C-66): whether a connection's object tree reads
 * on the editor's session (`one`) or on a metadata session of its own (`several`), decided from Studio's records and
 * the connection alone. The admission's reading of an in-memory name is the class's too, so the agreement case runs
 * the real admission against a storage location under its own scratch directory, as tests/unit/lib/db/provider-files.test.ts
 * does, and no file of this checkout is reserved or created.
 */

const originalStoragePath = process.env.STORAGE_SQLITE_PATH;
const originalDirectory = process.cwd();
let scratch: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "libredb-session-capacity-")));
  process.env.STORAGE_SQLITE_PATH = path.join(scratch, "studio", "libredb-storage.db");
  forgetStorageLocation();
  process.chdir(scratch);
});

afterAll(() => {
  process.chdir(originalDirectory);
  if (originalStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
  else process.env.STORAGE_SQLITE_PATH = originalStoragePath;
  forgetStorageLocation();
  rmSync(scratch, { recursive: true, force: true });
});

/** A connection of `type`: a file where the engine opens a local file, a host otherwise, with `overrides` on top. */
function connection(type: DatabaseType, overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  const opensFile = opensLocalFile[type];
  return {
    id: `capacity-${type}`,
    name: `Capacity ${type}`,
    type,
    ...(opensFile ? { database: "orders.db" } : { host: "db.example.com", port: 1, database: "orders" }),
    createdAt: new Date(0),
    ...overrides,
  } as DatabaseConnection;
}

/** The in-memory spellings the admission reads as `:memory:`, on the engines that accept them. */
const IN_MEMORY_CASES: readonly [string, DatabaseConnection][] = [
  ['SQLite database ":memory:"', connection("sqlite", { database: ":memory:" })],
  ['SQLite connection string "file::memory:"', connection("sqlite", { connectionString: "file::memory:" })],
  ['DuckDB database ":memory:"', connection("duckdb", { database: ":memory:" })],
  ['SQLite connection string ":memory:" without a scheme', connection("sqlite", { connectionString: ":memory:" })],
];

/** Names that only look like memory: the admission resolves each as a relative file path. */
const FILE_CASES: readonly [string, DatabaseConnection][] = [
  ['SQLite database ":MEMORY:"', connection("sqlite", { database: ":MEMORY:" })],
  ['SQLite database " :memory:"', connection("sqlite", { database: " :memory:" })],
  ['SQLite database ":memory:x"', connection("sqlite", { database: ":memory:x" })],
  ['SQLite connection string "file::MEMORY:"', connection("sqlite", { connectionString: "file::MEMORY:" })],
  ['SQLite database "orders.db"', connection("sqlite")],
  ['DuckDB database ":memory:named"', connection("duckdb", { database: ":memory:named" })],
];

describe("sessionCapacity", () => {
  test("every shipped engine's session capacity is one exactly where Studio's record names a reason", () => {
    const one = SHIPPED_DATABASE_TYPES.filter((type) => sessionCapacity(connection(type)) === "one");
    expect(one).toEqual(SHIPPED_DATABASE_TYPES.filter((type) => servesOneSession[type] !== null));
    // Vacuity, by name: a record and a class that both answered nothing, or everything, would agree above.
    expect([...one].sort()).toEqual(["duckdb", "libredb", "modbus", "mqtt", "netconf", "opcua", "snmp", "sparkplug"]);
    expect(SHIPPED_DATABASE_TYPES.length - one.length).toBe(35);
  });

  test("an in-memory database serves one session on every engine that opens a local file", () => {
    for (const [label, record] of IN_MEMORY_CASES) {
      expect([label, sessionCapacity(record)]).toEqual([label, "one"]);
    }
    // SQLite is the engine whose record names no reason, so its in-memory answer is the connection's alone.
    expect(servesOneSession.sqlite).toBeNull();
    expect(sessionCapacity(connection("sqlite"))).toBe("several");
    // Every engine that opens a local file answers one for an in-memory name, whatever its record says.
    for (const type of SHIPPED_DATABASE_TYPES.filter((each) => opensLocalFile[each])) {
      expect([type, sessionCapacity(connection(type, { database: ":memory:" }))]).toEqual([type, "one"]);
    }
  });

  test("a name the file admission reads as a file is a file, whatever it spells", () => {
    for (const [label, record] of FILE_CASES.filter(([, each]) => each.type === "sqlite")) {
      expect([label, sessionCapacity(record)]).toEqual([label, "several"]);
    }
    // An engine that opens no local file never reads its database as memory, whatever it is named.
    expect(sessionCapacity(connection("postgres", { database: ":memory:" }))).toBe("several");
    expect(namesInMemoryDatabase(connection("postgres", { database: ":memory:" }))).toBe(false);
  });

  test("the class and the file admission read one in-memory name", () => {
    const admitted = (record: DatabaseConnection) =>
      (admittedFileConnection(record) as DatabaseConnection & WithAdmittedFile)[ADMITTED_FILE];
    for (const [label, record] of [...IN_MEMORY_CASES, ...FILE_CASES]) {
      expect([label, namesInMemoryDatabase(record)]).toEqual([label, admitted(record) === ":memory:"]);
    }
    // Vacuity: both sides of the agreement are reached.
    expect(IN_MEMORY_CASES.every(([, record]) => namesInMemoryDatabase(record))).toBe(true);
    expect(FILE_CASES.some(([, record]) => namesInMemoryDatabase(record))).toBe(false);
  });

  test("the class reads Studio's records and the connection, never a provider or a manifest", () => {
    const source = readFileSync(path.join(originalDirectory, "src/lib/db/session-capacity.ts"), "utf8");
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)].map((match) => match[1]).sort();
    expect(imports).toEqual(["./claim-grants", "./provider-files", "./type-id", "@/lib/types"]);
    // A connection whose type names no provider is refused by name before any record is read.
    expect(() => sessionCapacity(connection("postgres", { type: "nonesuch" as DatabaseType }))).toThrow("nonesuch");
  });
});
