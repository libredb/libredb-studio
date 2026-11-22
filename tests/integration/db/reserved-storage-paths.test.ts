import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseProvider } from "@/lib/db/factory";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { ProviderExecutionContext } from "@/lib/db/types";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { forgetStorageLocation, isReservedStoragePath } from "@/lib/data-dir";
import { RESERVED_STORAGE_PATH } from "@/lib/db/provider-files";
import { SAMPLES } from "@/lib/seed/samples";
import { resealBackupLabel } from "@/lib/storage/reseal";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Studio's own storage files are refused by name when a SQLite, DuckDB or LibreDB provider is built, before any provider
 * exists to connect (FND-2 slice 3, docs/SECURITY.md control 3.45): `createDatabaseProvider` admits the file a
 * connection names against the storage location this process keeps. Each test sets STORAGE_SQLITE_PATH to its own
 * scratch directory and takes the location again (`forgetStorageLocation`), and one that sets it later takes it again
 * there too.
 */
let dir: string;
let original: string | undefined;
beforeEach(() => {
  original = process.env.STORAGE_SQLITE_PATH;
  dir = fs.mkdtempSync(path.join(tmpdir(), "libredb-reserved-"));
  process.env.STORAGE_SQLITE_PATH = path.join(dir, "storage.db");
  forgetStorageLocation();
});
afterEach(() => {
  if (original === undefined) delete process.env.STORAGE_SQLITE_PATH;
  else process.env.STORAGE_SQLITE_PATH = original;
  forgetStorageLocation();
  fs.rmSync(dir, { recursive: true, force: true });
});

const FILE_TYPES = ["sqlite", "duckdb", "libredb"] as const;

/** The backup the credential re-seal writes beside the store, named as its writer names it: `<store file>.<label>`. */
const BACKUP = `storage.db.${resealBackupLabel(new Date("2026-11-22T05:30:00Z"))}`;

function fileConnection(type: (typeof FILE_TYPES)[number], fields: Partial<DatabaseConnection>): DatabaseConnection {
  return { id: "reserved", name: "reserved", type, createdAt: new Date(), ...fields } as DatabaseConnection;
}

/** What `createDatabaseProvider` settles to for `connection`: the refusal it threw, or null when it built a provider. */
async function buildRefusal(
  connection: DatabaseConnection,
  execution: ProviderExecutionContext = {},
): Promise<unknown> {
  return createDatabaseProvider(connection, {}, execution).then(
    () => null,
    (error: unknown) => error,
  );
}

async function expectRefusedAtBuild(connection: DatabaseConnection, created: string): Promise<void> {
  const refused = await buildRefusal(connection);
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toBe(RESERVED_STORAGE_PATH);
  expect(fs.existsSync(created)).toBe(false);
}

for (const type of FILE_TYPES) {
  describe(`${type} reserved server files`, () => {
    for (const name of [
      "storage.db",
      "storage.db-wal",
      "storage.db-shm",
      "auth-bootstrap.json",
      "auth-bootstrap.json.bak",
      "auth-bootstrap.json.123.tmp",
      BACKUP,
      `${BACKUP}-wal`,
    ]) {
      test(`createDatabaseProvider refuses ${name} before the provider is built, and creates nothing`, async () => {
        const target = path.join(dir, name);
        await expectRefusedAtBuild(fileConnection(type, { database: target }), target);
      });
    }

    // On macOS and Windows each of these spellings names the reserved file itself.
    for (const name of [
      "STORAGE.DB",
      "Storage.db-WAL",
      "AUTH-BOOTSTRAP.JSON.BAK",
      "Auth-Bootstrap.json.123.TMP",
      BACKUP.toUpperCase(),
    ]) {
      test(`createDatabaseProvider refuses ${name}, another letter case of a reserved file, before the provider is built, and creates nothing`, async () => {
        const target = path.join(dir, name);
        await expectRefusedAtBuild(fileConnection(type, { database: target }), target);
      });
    }

    // On macOS (APFS) a name in NFD and the same name in NFC are one file.
    test("createDatabaseProvider refuses a reserved file in another Unicode normalization form before the provider is built, and creates nothing", async () => {
      const composed = path.join(dir, "Stud\u00fco");
      fs.mkdirSync(composed);
      process.env.STORAGE_SQLITE_PATH = path.join(composed, "storage.db");
      forgetStorageLocation();
      const decomposed = path.join(dir, "Studu\u0308o");
      for (const name of ["storage.db", "storage.db-wal", "auth-bootstrap.json.bak", BACKUP]) {
        const target = path.join(decomposed, name);
        // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
        await expectRefusedAtBuild(fileConnection(type, { database: target }), target);
      }
    });

    test("a relative spelling, a symbolic link to the storage file, a directory alias and a hard link are refused before the provider is built", async () => {
      const storage = process.env.STORAGE_SQLITE_PATH!;
      fs.writeFileSync(storage, "server state");
      fs.symlinkSync(storage, path.join(dir, "alias.db"));
      fs.symlinkSync(dir, path.join(dir, "directory-alias"), "junction");
      fs.linkSync(storage, path.join(dir, "hardlink.db"));
      const relative = path.relative(process.cwd(), storage);
      for (const database of [
        relative,
        path.join(dir, "alias.db"),
        path.join(dir, "directory-alias", "storage.db-wal"),
        path.join(dir, "hardlink.db"),
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
        const refused = await buildRefusal(fileConnection(type, { database }));
        expect([database, (refused as Error | null)?.message]).toEqual([database, RESERVED_STORAGE_PATH]);
      }
      expect(fs.existsSync(path.join(dir, "storage.db-wal"))).toBe(false);
    });

    test("the re-seal's backup of the store is refused by a relative spelling, a symbolic link, a directory alias and a hard link before the provider is built", async () => {
      const backup = path.join(dir, BACKUP);
      fs.writeFileSync(backup, "server state");
      fs.symlinkSync(backup, path.join(dir, "backup-alias.db"));
      fs.symlinkSync(dir, path.join(dir, "directory-alias"), "junction");
      fs.linkSync(backup, path.join(dir, "backup-hardlink.db"));
      for (const database of [
        path.relative(process.cwd(), backup),
        path.join(dir, "backup-alias.db"),
        path.join(dir, "directory-alias", BACKUP),
        path.join(dir, "backup-hardlink.db"),
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
        const refused = await buildRefusal(fileConnection(type, { database }));
        expect([database, (refused as Error | null)?.message]).toEqual([database, RESERVED_STORAGE_PATH]);
      }
      expect(fs.existsSync(`${backup}-wal`)).toBe(false);
    });
  });
}

test("SQLite's file: connection string naming the storage file is refused before the provider is built", async () => {
  await expectRefusedAtBuild(
    fileConnection("sqlite", { database: ":memory:", connectionString: `file:${process.env.STORAGE_SQLITE_PATH}` }),
    process.env.STORAGE_SQLITE_PATH!,
  );
});

test("resolves existing file and parent directory symlinks, including missing sidecars", () => {
  const storage = process.env.STORAGE_SQLITE_PATH!;
  fs.writeFileSync(storage, "server state");
  fs.symlinkSync(storage, path.join(dir, "alias.db"));
  fs.symlinkSync(dir, path.join(dir, "directory-alias"), "junction");
  expect(isReservedStoragePath(path.join(dir, "alias.db"))).toBe(true);
  expect(isReservedStoragePath(path.join(dir, "directory-alias", "storage.db-wal"))).toBe(true);
  expect(isReservedStoragePath(path.join(dir, "directory-alias", "auth-bootstrap.json"))).toBe(true);
  fs.linkSync(storage, path.join(dir, "hardlink.db"));
  expect(isReservedStoragePath(path.join(dir, "hardlink.db"))).toBe(true);
  expect(isReservedStoragePath(path.join(dir, "user.db"))).toBe(false);
});

test("a symlink in the configured storage path is canonicalized", () => {
  fs.mkdirSync(path.join(dir, "real"));
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "alias"), "junction");
  process.env.STORAGE_SQLITE_PATH = path.join(dir, "alias", "storage.db");
  forgetStorageLocation();
  expect(isReservedStoragePath(path.join(dir, "real", "storage.db"))).toBe(true);
  expect(isReservedStoragePath(path.join(dir, "real", "storage.db-shm"))).toBe(true);
});

for (const readOnly of [false, true]) {
  test(`SQLite refuses denied file access before the provider is built, readOnly=${readOnly}`, async () => {
    const refused = await createDatabaseProvider(
      { id: "denied", name: "denied", type: "sqlite", database: ":memory:", createdAt: new Date() },
      {},
      { allowExternalFileAccess: false, readOnly },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(DatabaseConfigError);
    expect((refused as Error).message).toContain("require an administrator");
  });
}

test("SQLite refuses denied file access before it reads the path the connection names, and creates nothing", async () => {
  const target = path.join(dir, "missing", "user.db");
  const reads = (["realpathSync", "lstatSync", "statSync", "readlinkSync"] as const).map((name) => spyOn(fs, name));
  try {
    const refused = await buildRefusal(fileConnection("sqlite", { database: target }), {
      allowExternalFileAccess: false,
    });
    expect((refused as Error | null)?.message).toContain("require an administrator");
    expect(reads.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))).toEqual([]);
  } finally {
    for (const spy of reads) spy.mockRestore();
  }
  expect(fs.existsSync(path.join(dir, "missing"))).toBe(false);
});

// The provider refuses only an explicit `false`: an absent posture, which the published package's factory takes by
// default and the agent runtime's operations context carries, opens as before, and so does a granted one.
for (const [label, execution] of [
  ["absent", {}],
  ["granted", { allowExternalFileAccess: true }],
] as const) {
  test(`SQLite with a file-access posture ${label} is built and opens its file`, async () => {
    const provider = await createDatabaseProvider(
      fileConnection("sqlite", { database: path.join(dir, "user.db") }),
      {},
      execution,
    );
    try {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    } finally {
      await provider.disconnect();
    }
  });
}

test("filesystem identity failures fail closed", () => {
  const error = Object.assign(new Error("unavailable"), { code: "EACCES" });
  const fail = () => {
    throw error;
  };
  const realpath = spyOn(fs, "realpathSync").mockImplementation(Object.assign(fail, { native: fail }));
  try {
    expect(() => isReservedStoragePath(path.join(dir, "user.db"))).toThrow("unavailable");
  } finally {
    realpath.mockRestore();
  }
  const stat = spyOn(fs, "statSync").mockImplementation(() => {
    throw error;
  });
  try {
    expect(() => isReservedStoragePath(path.join(dir, "user.db"))).toThrow("unavailable");
  } finally {
    stat.mockRestore();
  }
});

test("administrator SQLite connections to user data remain writable", async () => {
  const target = path.join(dir, "user.db");
  const provider = await createDatabaseProvider(
    { id: "user-data", name: "User data", type: "sqlite", database: target, createdAt: new Date() },
    {},
    { allowExternalFileAccess: true },
  );
  try {
    await provider.connect();
    await provider.query("CREATE TABLE example (value INTEGER)");
    await provider.query("INSERT INTO example VALUES (1)");
    expect((await provider.query("SELECT value FROM example")).rows).toEqual([{ value: 1 }]);
  } finally {
    await provider.disconnect();
  }
});

for (const [role, id, roles] of [
  ["user", "inline", []],
  ["admin", "seed:shared", ["*"]],
  ["user", "seed:shared", ["user"]],
] as const) {
  test(`SQLite denies server-derived posture for ${role} on ${id}`, async () => {
    const connection = {
      id,
      name: "SQLite",
      type: "sqlite" as const,
      database: ":memory:",
      roles: [...roles],
      createdAt: new Date(),
    };
    const context = editorExecutionContext({ role }, connection);
    const refused = await buildRefusal(connection, context);
    expect(refused).toBeInstanceOf(DatabaseConfigError);
    expect((refused as Error).message).toContain("require an administrator");
  });
}

test("the built-in SQLite sample, offered to administrators alone, is built and opens for an administrator", async () => {
  const sample = SAMPLES.get("sqlite")!;
  const connection = {
    id: `seed:${sample.seedId}`,
    name: sample.name,
    type: "sqlite" as const,
    database: path.join(dir, sample.fileName),
    roles: [...sample.roles],
    createdAt: new Date(),
  };
  const provider = await createDatabaseProvider(connection, {}, editorExecutionContext({ role: "admin" }, connection));
  try {
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
  } finally {
    await provider.disconnect();
  }
});

test("dangling symbolic links cannot create reserved files", () => {
  fs.symlinkSync("storage.db", path.join(dir, "dangling.db"));
  expect(isReservedStoragePath(path.join(dir, "dangling.db"))).toBe(true);
  expect(fs.existsSync(process.env.STORAGE_SQLITE_PATH!)).toBe(false);
});

test("sidecars follow the canonical storage file when its configured name is a symlink", () => {
  const target = path.join(dir, "actual.db");
  fs.writeFileSync(target, "server state");
  fs.symlinkSync(target, process.env.STORAGE_SQLITE_PATH!);
  expect(isReservedStoragePath(`${target}-wal`)).toBe(true);
  expect(isReservedStoragePath(`${target}-shm`)).toBe(true);
});

test("a dangling symbolic link at a sidecar or backup name is reserved, and so is the file it points to", () => {
  const elsewhere = path.join(dir, "elsewhere");
  for (const name of ["storage.db-wal", "storage.db-shm", "auth-bootstrap.json.bak", BACKUP]) {
    const target = path.join(elsewhere, `${name}.target`);
    fs.symlinkSync(target, path.join(dir, name));
    expect([name, isReservedStoragePath(path.join(dir, name)), isReservedStoragePath(target)]).toEqual([
      name,
      true,
      true,
    ]);
    expect(fs.existsSync(target)).toBe(false);
  }
});

test("under a symlinked data directory, the bootstrap file is reserved by its real path and by its configured spelling in another letter case", () => {
  const base = fs.realpathSync(dir);
  fs.mkdirSync(path.join(base, "real"));
  fs.symlinkSync(path.join(base, "real"), path.join(base, "alias"), "junction");
  process.env.STORAGE_SQLITE_PATH = path.join(base, "alias", "storage.db");
  forgetStorageLocation();
  for (const name of ["auth-bootstrap.json", "auth-bootstrap.json.bak", "auth-bootstrap.json.123.tmp", BACKUP]) {
    expect([name, isReservedStoragePath(path.join(base, "real", name))]).toEqual([name, true]);
    // On Linux ALIAS is not the symlink, so only the configured spelling, folded, names the file.
    expect([name, isReservedStoragePath(path.join(base, "ALIAS", name))]).toEqual([name, true]);
  }
  expect(isReservedStoragePath(path.join(base, "ALIAS", "auth-bootstrap.json.bak2"))).toBe(false);
});
