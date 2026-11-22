import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as dataDir from "@/lib/data-dir";
import { forgetStorageLocation, storageLocation } from "@/lib/data-dir";
import { OPENS_LOCAL_FILE } from "@/lib/db/compatibility";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import {
  admittedFileConnection,
  FILE_NAME_NOT_TEXT,
  NO_FILE_AFTER_SCHEME,
  NUL_IN_DATABASE_PATH,
  OPCUA_PKI_DIRECTORY,
  OPCUA_PKI_ROOT_ENV,
  opcuaPkiRoot,
  PATH_NOT_CHECKED,
  RESERVED_STORAGE_PATH,
} from "@/lib/db/provider-files";
import type { DatabaseConnection } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { ADMITTED_FILE, type DatabaseType, TUNNEL_FAR_END, type WithAdmittedFile } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";

/**
 * Core decides the file a SQLite, DuckDB or LibreDB connection opens, and OPC UA's PKI root, before the provider is built
 * (FND-2 slice 3, the provider plugins design section 0.1): `admittedFileConnection` and `opcuaPkiRoot` in
 * `src/lib/db/provider-files.ts`. Each test here runs against a storage location under its own scratch directory, taken
 * again in `beforeAll`, so no file of this checkout is reserved or created.
 */
const FILE_TYPES = ["sqlite", "duckdb", "libredb"] as const satisfies readonly DatabaseType[];

const originalStoragePath = process.env.STORAGE_SQLITE_PATH;
const originalPkiRoot = process.env.LIBREDB_OPCUA_PKI_ROOT;
const originalDirectory = process.cwd();
let scratch: string;
let info: ReturnType<typeof spyOn>;

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "libredb-provider-files-")));
  process.env.STORAGE_SQLITE_PATH = path.join(scratch, "studio", "libredb-storage.db");
  forgetStorageLocation();
});

beforeEach(() => {
  info = spyOn(logger, "info").mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  process.chdir(originalDirectory);
});

afterAll(() => {
  if (originalStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
  else process.env.STORAGE_SQLITE_PATH = originalStoragePath;
  if (originalPkiRoot === undefined) delete process.env.LIBREDB_OPCUA_PKI_ROOT;
  else process.env.LIBREDB_OPCUA_PKI_ROOT = originalPkiRoot;
  forgetStorageLocation();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function connection(type: DatabaseType, fields: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return { id: `files-${type}`, name: `files ${type}`, type, createdAt: new Date(0), ...fields } as DatabaseConnection;
}

const admitted = (value: DatabaseConnection): string | undefined => (value as WithAdmittedFile)[ADMITTED_FILE];

/** The refusal `admittedFileConnection` throws for `value`, settled into a value before it is asserted on. */
function refusalOf(value: DatabaseConnection): unknown {
  try {
    admittedFileConnection(value);
    return null;
  } catch (error) {
    return error;
  }
}

describe("core decides the file a local-file connection opens (FND-2 slice 3)", () => {
  test("a postgres connection, and any engine OPENS_LOCAL_FILE does not mark, comes back as the same object", () => {
    const postgres = connection("postgres", { database: "app.db", connectionString: "file:app.db" });
    expect(admittedFileConnection(postgres)).toBe(postgres);
    for (const type of Object.keys(OPENS_LOCAL_FILE) as DatabaseType[]) {
      if (OPENS_LOCAL_FILE[type]) continue;
      const other = connection(type, { database: "app.db" });
      expect(admittedFileConnection(other)).toBe(other);
    }
  });

  test.each(FILE_TYPES)(
    "%s with a relative database is admitted as that path resolved against the working directory, and its database is unchanged",
    (type) => {
      process.chdir(scratch);
      const record = connection(type, { database: "user/app.db" });
      const copy = admittedFileConnection(record);
      expect(copy).not.toBe(record);
      expect(admitted(copy)).toBe(path.join(scratch, "user", "app.db"));
      expect(copy.database).toBe("user/app.db");
      expect(admitted(record)).toBeUndefined();
      const climbing = admittedFileConnection(connection(type, { database: "user/../../app.db" }));
      expect(admitted(climbing)).toBe(path.resolve("user/../../app.db"));
    },
  );

  test("SQLite's connection string names the file before database, with a leading file: removed, and DuckDB and LibreDB read database", () => {
    const viaScheme = admittedFileConnection(
      connection("sqlite", { database: "ignored.db", connectionString: `file:${path.join(scratch, "a.db")}` }),
    );
    expect(admitted(viaScheme)).toBe(path.join(scratch, "a.db"));
    expect(viaScheme.connectionString).toBe(`file:${path.join(scratch, "a.db")}`);
    const plain = admittedFileConnection(
      connection("sqlite", { database: "ignored.db", connectionString: path.join(scratch, "b.db") }),
    );
    expect(admitted(plain)).toBe(path.join(scratch, "b.db"));
    const emptyString = admittedFileConnection(
      connection("sqlite", { database: path.join(scratch, "c.db"), connectionString: "" }),
    );
    expect(admitted(emptyString)).toBe(path.join(scratch, "c.db"));
    for (const type of ["duckdb", "libredb"] as const) {
      const record = connection(type, {
        database: path.join(scratch, `${type}.db`),
        connectionString: path.join(scratch, "other.db"),
      });
      expect(admitted(admittedFileConnection(record))).toBe(path.join(scratch, `${type}.db`));
    }
  });

  test("exactly :memory: is admitted as :memory:, and :MEMORY: and a padded :memory: are paths", () => {
    process.chdir(scratch);
    expect(admitted(admittedFileConnection(connection("sqlite", { database: ":memory:" })))).toBe(":memory:");
    expect(admitted(admittedFileConnection(connection("sqlite", { connectionString: "file::memory:" })))).toBe(
      ":memory:",
    );
    expect(admitted(admittedFileConnection(connection("duckdb", { database: ":memory:" })))).toBe(":memory:");
    expect(admitted(admittedFileConnection(connection("sqlite", { database: ":MEMORY:" })))).toBe(
      path.join(scratch, ":MEMORY:"),
    );
    expect(admitted(admittedFileConnection(connection("duckdb", { database: " :memory: " })))).toBe(
      path.join(scratch, " :memory: "),
    );
  });

  test("an absent or empty name is admitted without a file, a caller's own removed, and the provider refuses it with today's sentence", async () => {
    for (const type of FILE_TYPES) {
      const bare = connection(type);
      expect(admittedFileConnection(bare)).toBe(bare);
      const marked = { ...connection(type, { database: "" }), [ADMITTED_FILE]: "/caller/chose.db" };
      const copy = admittedFileConnection(marked);
      expect(admitted(copy)).toBeUndefined();
      expect(ADMITTED_FILE in copy).toBe(false);
      expect(admitted(marked)).toBe("/caller/chose.db");
    }
    const refused = await createDatabaseProvider(connection("sqlite", { database: "" })).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(DatabaseConfigError);
    expect((refused as Error).message).toContain("Database file path is required for SQLite");
  });

  test("a SQLite connection string that names no file after file: is refused by name when the provider is built, with or without a database", async () => {
    for (const fields of [{ connectionString: "file:" }, { connectionString: "file:", database: "x.db" }]) {
      const refused = await createDatabaseProvider(connection("sqlite", fields)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(DatabaseConfigError);
      expect((refused as DatabaseConfigError).message).toBe(NO_FILE_AFTER_SCHEME);
      expect((refused as DatabaseConfigError).provider).toBe("sqlite");
    }
  });

  test("a name that is not text is refused by name", () => {
    for (const type of FILE_TYPES) {
      const refused = refusalOf(connection(type, { database: 5 as unknown as string }));
      expect(refused).toBeInstanceOf(DatabaseConfigError);
      expect((refused as DatabaseConfigError).message).toBe(FILE_NAME_NOT_TEXT);
      expect((refused as DatabaseConfigError).provider).toBe(type);
    }
    const refused = refusalOf(connection("sqlite", { connectionString: { file: "x" } as unknown as string }));
    expect((refused as DatabaseConfigError).message).toBe(FILE_NAME_NOT_TEXT);
  });

  test("a NUL byte is refused by name with today's SQLite and DuckDB sentence, which LibreDB now shares", () => {
    for (const type of FILE_TYPES) {
      const refused = refusalOf(connection(type, { database: "a\0b.db" }));
      expect(refused).toBeInstanceOf(DatabaseConfigError);
      expect((refused as DatabaseConfigError).message).toBe(NUL_IN_DATABASE_PATH);
      expect((refused as DatabaseConfigError).provider).toBe(type);
    }
    const viaString = refusalOf(connection("sqlite", { connectionString: "file:a\0b.db" }));
    expect((viaString as DatabaseConfigError).message).toBe(NUL_IN_DATABASE_PATH);
  });

  test("one of Studio's own files is refused by name with the reserved sentence and the connection's own type", () => {
    for (const type of FILE_TYPES) {
      const refused = refusalOf(connection(type, { database: storageLocation().storageFile }));
      expect(refused).toBeInstanceOf(DatabaseConfigError);
      expect((refused as DatabaseConfigError).message).toBe(RESERVED_STORAGE_PATH);
      expect((refused as DatabaseConfigError).provider).toBe(type);
    }
  });

  /**
   * A path the reserved check cannot read: the filesystem answers something other than "no such file" while the check
   * resolves it. Each case is built through createDatabaseProvider, as every route builds, and is refused by name with
   * the filesystem's own reason and the original error as its cause. Each row names the platforms where the
   * filesystem gives that answer, and is skipped elsewhere.
   */
  const onWindows = process.platform === "win32";
  const unreadable: [string, string, boolean, () => string][] = [
    [
      // POSIX reports a path through a regular file as ENOTDIR; Windows reports it as absent (ENOENT), which the check
      // reads as a file that does not exist yet, so it admits the connection (measured in samples.test.ts, "a target
      // through a regular file is refused as target-unreadable on POSIX and admitted on Windows").
      "a path that runs through a regular file (POSIX)",
      "ENOTDIR",
      onWindows,
      () => {
        const plain = path.join(scratch, "plain-file");
        fs.writeFileSync(plain, "");
        return path.join(plain, "x.db");
      },
    ],
    [
      // Windows makes a symbolic link only with a privilege the runner may lack.
      "a symbolic link loop (POSIX)",
      "ELOOP",
      onWindows,
      () => {
        const loop = path.join(scratch, "loop-a");
        fs.rmSync(loop, { force: true });
        fs.rmSync(path.join(scratch, "loop-b"), { force: true });
        fs.symlinkSync(path.join(scratch, "loop-b"), loop);
        fs.symlinkSync(loop, path.join(scratch, "loop-b"));
        return path.join(loop, "x.db");
      },
    ],
    [
      // Windows has no search permission bit, and root searches every directory.
      "a path under a directory the server cannot search (POSIX, not root)",
      "EACCES",
      onWindows || process.getuid?.() === 0,
      () => {
        const locked = path.join(scratch, "locked");
        fs.mkdirSync(locked, { recursive: true });
        fs.chmodSync(locked, 0o000);
        return path.join(locked, "x.db");
      },
    ],
  ];

  for (const [label, code, skip, make] of unreadable) {
    test.skipIf(skip)(
      `${label} (${code}) is refused by name when the provider is built, naming the connection's type and the filesystem's reason`,
      async () => {
        const database = make();
        try {
          for (const type of FILE_TYPES) {
            const refused = await createDatabaseProvider(connection(type, { database })).then(
              () => null,
              (error: unknown) => error,
            );
            expect(refused).toBeInstanceOf(DatabaseConfigError);
            const error = refused as DatabaseConfigError;
            expect(error.provider).toBe(type);
            expect(error.message.startsWith(`${PATH_NOT_CHECKED}: ${code}: `)).toBe(true);
            expect((error.cause as NodeJS.ErrnoException).code).toBe(code);
          }
        } finally {
          if (code === "EACCES") fs.chmodSync(path.join(scratch, "locked"), 0o700);
        }
      },
    );
  }

  // POSIX reports a path through a regular file as ENOTDIR; Windows reports it as absent (see the rows above).
  test.skipIf(onWindows)(
    "a filesystem error from reading Studio's own storage files is raised as it is, not as the connection's file (POSIX)",
    async () => {
      const plain = path.join(scratch, "storage-under-a-file");
      fs.writeFileSync(plain, "");
      process.env.STORAGE_SQLITE_PATH = path.join(plain, "libredb-storage.db");
      forgetStorageLocation();
      try {
        for (const type of FILE_TYPES) {
          const refused = await createDatabaseProvider(
            connection(type, { database: path.join(scratch, "valid.db") }),
          ).then(
            () => null,
            (error: unknown) => error,
          );
          expect([type, refused instanceof DatabaseConfigError]).toEqual([type, false]);
          expect([type, (refused as NodeJS.ErrnoException).code]).toEqual([type, "ENOTDIR"]);
        }
      } finally {
        process.env.STORAGE_SQLITE_PATH = path.join(scratch, "studio", "libredb-storage.db");
        forgetStorageLocation();
      }
    },
  );

  test("an error the reserved check raises without a filesystem error code is raised as it is", () => {
    const fault = new TypeError("not a filesystem answer");
    const check = spyOn(dataDir, "reservedStorageCheck").mockImplementation(() => () => {
      throw fault;
    });
    try {
      expect(refusalOf(connection("sqlite", { database: path.join(scratch, "any.db") }))).toBe(fault);
    } finally {
      check.mockRestore();
    }
  });

  test("a caller-set ADMITTED_FILE on a local-file connection is replaced by core's, other markers survive, and the record is never written", () => {
    const farEnd = { host: "db.internal", port: 5432 };
    const record = Object.freeze({
      ...connection("sqlite", { database: path.join(scratch, "mine.db") }),
      [ADMITTED_FILE]: "/caller/chose.db",
      [TUNNEL_FAR_END]: farEnd,
    });
    const copy = admittedFileConnection(record);
    expect(admitted(copy)).toBe(path.join(scratch, "mine.db"));
    expect((copy as { [TUNNEL_FAR_END]?: unknown })[TUNNEL_FAR_END]).toBe(farEnd);
    expect(admitted(record)).toBe("/caller/chose.db");
  });

  test("every engine OPENS_LOCAL_FILE marks, built by createDatabaseProvider from its census connection, holds an absolute admitted file, and no other engine holds one", async () => {
    const holders: string[] = [];
    for (const type of Object.keys(CENSUS_CONNECTION) as DatabaseType[]) {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const file = admitted(provider.config);
      if (file === undefined) continue;
      holders.push(type);
      expect(path.isAbsolute(file)).toBe(true);
    }
    const marked = (Object.keys(OPENS_LOCAL_FILE) as DatabaseType[]).filter((type) => OPENS_LOCAL_FILE[type]);
    expect(holders.sort()).toEqual(marked.sort());
  });
});

describe("core decides OPC UA's PKI root (FND-2 slice 3)", () => {
  afterEach(() => {
    delete process.env.LIBREDB_OPCUA_PKI_ROOT;
  });

  test("LIBREDB_OPCUA_PKI_ROOT, trimmed, is the root when it is set and absolute", () => {
    const root = path.join(scratch, "pki");
    process.env.LIBREDB_OPCUA_PKI_ROOT = `  ${root}  `;
    expect(opcuaPkiRoot("opcua")).toBe(root);
  });

  test.each([undefined, "", "   "])(
    "%p is opcua-pki under the storage location's data directory, whatever the working directory is by then",
    (value) => {
      if (value === undefined) delete process.env.LIBREDB_OPCUA_PKI_ROOT;
      else process.env.LIBREDB_OPCUA_PKI_ROOT = value;
      const expected = path.join(storageLocation().dataDirectory, OPCUA_PKI_DIRECTORY);
      process.chdir(scratch);
      expect(opcuaPkiRoot("opcua")).toBe(expected);
      expect(expected).toBe(path.join(scratch, "studio", "opcua-pki"));
    },
  );

  test("a relative value is refused naming the variable", () => {
    process.env.LIBREDB_OPCUA_PKI_ROOT = "relative/pki";
    let refused: unknown = null;
    try {
      opcuaPkiRoot("opcua");
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(DatabaseConfigError);
    expect((refused as DatabaseConfigError).message).toBe(
      `${OPCUA_PKI_ROOT_ENV} is an absolute path, and this one is relative: relative/pki. A relative path would ` +
        "resolve against whatever directory the server happened to start in.",
    );
    expect((refused as DatabaseConfigError).provider).toBe("opcua");
  });
});
