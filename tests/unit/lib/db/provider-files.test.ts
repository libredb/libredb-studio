import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as dataDir from "@/lib/data-dir";
import { BOOTSTRAP_FILE_NAME, forgetStorageLocation, LINKS_FOLLOWED_LIMIT, storageLocation } from "@/lib/data-dir";
import { SEED_ONLY_FIELD_NAMES } from "@/lib/db/connection-fields";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import {
  admittedFileConnection,
  admittedHostPathConnection,
  FILE_NAME_NOT_TEXT,
  NO_FILE_AFTER_SCHEME,
  NUL_IN_DATABASE_PATH,
  OPCUA_PKI_DIRECTORY,
  OPCUA_PKI_ROOT_ENV,
  opcuaPkiRoot,
  PATH_NOT_CHECKED,
  RESERVED_PROVIDERS_PATH,
  RESERVED_STORAGE_PATH,
} from "@/lib/db/provider-files";
import type { DatabaseConnection } from "@/lib/db/types";
import { holdsSecretForm, secretForms } from "@/lib/db/utils/server-text";
import { logger } from "@/lib/logger";
import { forgetProvidersDirectory } from "@/lib/provider-host/providers-dir";
import { LOCK_FILE_NAME } from "@/lib/provider-host/providers-lock-format";
import {
  ADMITTED_FILE,
  ADMITTED_HOST_PATHS,
  type DatabaseType,
  type HostPathField,
  TUNNEL_FAR_END,
  type WithAdmittedFile,
  type WithAdmittedHostPaths,
} from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";
import { legacyRegisterTable } from "../../../helpers/legacy-register";

const opensLocalFile = legacyRegisterTable("opensLocalFile");
const hostPathFields = legacyRegisterTable("hostPathFields");

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
  test("a postgres connection, and any engine whose legacy register row opens no local file, comes back as the same object", () => {
    const postgres = connection("postgres", { database: "app.db", connectionString: "file:app.db" });
    expect(admittedFileConnection(postgres)).toBe(postgres);
    for (const type of Object.keys(opensLocalFile) as DatabaseType[]) {
      if (opensLocalFile[type]) continue;
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
      // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
      const refused = await createDatabaseProvider(connection("sqlite", fields)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(DatabaseConfigError);
      expect((refused as DatabaseConfigError).message).toBe(NO_FILE_AFTER_SCHEME);
      expect((refused as DatabaseConfigError).provider).toBe("sqlite");
    }
  });

  test("the refusal of a connection string that is file: holds no form of that connection string", () => {
    expect(holdsSecretForm(NO_FILE_AFTER_SCHEME, secretForms(["file:"]))).toBe(false);
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
            // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
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

  /**
   * A path whose resolution follows more than `LINKS_FOLLOWED_LIMIT` links is one the check cannot read. The real-path
   * read of every path under the chain's directory answers "no such file" here, so the check follows each link itself
   * and the kernel's own link limit never decides.
   */
  // Windows makes a symbolic link only with a privilege the runner may lack (the rows above).
  test.skipIf(onWindows)(
    "a path whose resolution follows more than LINKS_FOLLOWED_LIMIT links is refused by name with ELOOP when the provider is built, for every engine whose legacy register row opens a local file",
    async () => {
      const chain = path.join(scratch, "link-chain");
      fs.mkdirSync(chain);
      for (let i = 1; i <= LINKS_FOLLOWED_LIMIT + 1; i++)
        fs.symlinkSync(path.join(chain, `n${i + 1}`), path.join(chain, `n${i}`));
      const database = path.join(chain, "n1");
      const realpath = fs.realpathSync;
      const missing = spyOn(fs, "realpathSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
        if (String(file).startsWith(`${chain}${path.sep}`)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${String(file)}'`), {
            code: "ENOENT",
          });
        }
        return realpath(file, options as fs.EncodingOption);
      }) as typeof fs.realpathSync);
      try {
        const marked = (Object.keys(opensLocalFile) as DatabaseType[]).filter((type) => opensLocalFile[type]);
        for (const type of marked) {
          // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
          const refused = await createDatabaseProvider(connection(type, { database })).then(
            () => null,
            (error: unknown) => error,
          );
          expect(refused).toBeInstanceOf(DatabaseConfigError);
          const error = refused as DatabaseConfigError;
          expect([type, error.provider]).toEqual([type, type]);
          expect(error.message).toBe(
            `${PATH_NOT_CHECKED}: ELOOP: more than ${LINKS_FOLLOWED_LIMIT} symbolic links followed while resolving '${database}'`,
          );
          expect((error.cause as NodeJS.ErrnoException).code).toBe("ELOOP");
        }
      } finally {
        missing.mockRestore();
      }
    },
  );

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
          // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
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

  test("every engine whose legacy register row opens a local file, built by createDatabaseProvider from its census connection, holds an absolute admitted file, and no other engine holds one", async () => {
    const holders: string[] = [];
    for (const type of Object.keys(CENSUS_CONNECTION) as DatabaseType[]) {
      // oxlint-disable-next-line no-await-in-loop -- one build at a time, each read before the next.
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const file = admitted(provider.config);
      if (file === undefined) continue;
      holders.push(type);
      expect(path.isAbsolute(file)).toBe(true);
    }
    const marked = (Object.keys(opensLocalFile) as DatabaseType[]).filter((type) => opensLocalFile[type]);
    expect(holders.sort()).toEqual(marked.sort());
  });
});

/**
 * OPC UA's `clientCertificatePath` and `clientPrivateKeyPath` (its legacy register row's host path fields) name files on Studio's own host that
 * the provider reads, so core admits them as it admits a local-file connection's database: resolved against the working
 * directory when the provider is built, refused by name when one names Studio's own storage files, and handed to the
 * provider under `ADMITTED_HOST_PATHS` (`admittedHostPathConnection` in `src/lib/db/provider-files.ts`).
 */
describe("core admits OPC UA's certificate and key paths like a database file", () => {
  const FIELDS = ["clientCertificatePath", "clientPrivateKeyPath"] as const satisfies readonly HostPathField[];
  const hostPaths = (value: DatabaseConnection) => (value as WithAdmittedHostPaths)[ADMITTED_HOST_PATHS];
  const other = (field: HostPathField): HostPathField =>
    field === "clientCertificatePath" ? "clientPrivateKeyPath" : "clientCertificatePath";
  const onWindows = process.platform === "win32";

  /** What building `value` with createDatabaseProvider threw, settled into a value before it is asserted on. */
  async function buildRefusal(value: DatabaseConnection): Promise<unknown> {
    return createDatabaseProvider(value).then(
      () => null,
      (error: unknown) => error,
    );
  }

  test("either path naming one of Studio's own storage files is refused by name, with the field and the connection's type, before any provider is built", async () => {
    const { storageFile, dataDirectory } = storageLocation();
    const bootstrap = path.join(dataDirectory, BOOTSTRAP_FILE_NAME);
    const ownFiles = [storageFile, `${storageFile}-wal`, bootstrap, `${bootstrap}.bak`];
    for (const field of FIELDS) {
      for (const own of ownFiles) {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
        const refused = await buildRefusal(
          connection("opcua", { [field]: own, [other(field)]: path.join(scratch, "scratch.pem") }),
        );
        expect([field, own, refused instanceof DatabaseConfigError]).toEqual([field, own, true]);
        expect((refused as DatabaseConfigError).message).toBe(`${field}: ${RESERVED_STORAGE_PATH}`);
        expect((refused as DatabaseConfigError).provider).toBe("opcua");
      }
    }
  });

  test("a relative path is resolved against the working directory when the provider is built, and the provider is handed the absolute path", async () => {
    process.chdir(scratch);
    const record = connection("opcua", { clientCertificatePath: "pki/c.pem", clientPrivateKeyPath: "pki/../k.pem" });
    const provider = await createDatabaseProvider(record);
    expect(hostPaths(provider.config)).toEqual({
      clientCertificatePath: path.join(scratch, "pki", "c.pem"),
      clientPrivateKeyPath: path.join(scratch, "k.pem"),
    });
    expect(Object.isFrozen(hostPaths(provider.config))).toBe(true);
    expect(provider.config.clientCertificatePath).toBe("pki/c.pem");
    expect(provider.config.clientPrivateKeyPath).toBe("pki/../k.pem");
    expect(hostPaths(record)).toBeUndefined();
  });

  test("an absent, null or empty path is not admitted, and the provider's pair rule still answers one without the other", async () => {
    for (const empty of [undefined, null, ""]) {
      const neither = admittedHostPathConnection(
        connection("opcua", { clientCertificatePath: empty, clientPrivateKeyPath: empty } as never),
      );
      expect([empty, hostPaths(neither)]).toEqual([empty, {}]);
      const one = admittedHostPathConnection(
        connection("opcua", {
          clientCertificatePath: path.join(scratch, "c.pem"),
          clientPrivateKeyPath: empty,
        } as never),
      );
      expect([empty, hostPaths(one)]).toEqual([empty, { clientCertificatePath: path.join(scratch, "c.pem") }]);
    }
    const provider = await createDatabaseProvider(
      connection("opcua", { host: "opc.tcp://127.0.0.1:1/", clientCertificatePath: path.join(scratch, "c.pem") }),
    );
    await expect(provider.connect()).rejects.toThrow(/supplied together or not at all/);
  });

  test("a path that is not text, or holds a NUL byte, is refused by name", async () => {
    for (const field of FIELDS) {
      for (const [value, message] of [
        [42, `Invalid ${field}: the file it names must be text`],
        [{ path: "c.pem" }, `Invalid ${field}: the file it names must be text`],
        [`${path.join(scratch, "c.pem")}\0.txt`, `Invalid ${field}: NUL bytes are not allowed`],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
        const refused = await buildRefusal(connection("opcua", { [field]: value } as never));
        expect([field, refused instanceof DatabaseConfigError]).toEqual([field, true]);
        expect((refused as DatabaseConfigError).message).toBe(message);
        expect((refused as DatabaseConfigError).provider).toBe("opcua");
      }
    }
  });

  // POSIX reports a path through a regular file as ENOTDIR; Windows reports it as absent (the rows above).
  test.skipIf(onWindows)(
    "a path the check cannot read is refused by name with the filesystem's reason (POSIX)",
    async () => {
      const plain = path.join(scratch, "plain-pem");
      fs.writeFileSync(plain, "");
      for (const field of FIELDS) {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
        const refused = await buildRefusal(connection("opcua", { [field]: path.join(plain, "c.pem") }));
        expect([field, refused instanceof DatabaseConfigError]).toEqual([field, true]);
        const error = refused as DatabaseConfigError;
        expect(error.provider).toBe("opcua");
        expect(error.message.startsWith(`${field}: ${PATH_NOT_CHECKED}: ENOTDIR: `)).toBe(true);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOTDIR");
      }
    },
  );

  test("a caller-set ADMITTED_HOST_PATHS is replaced by core's, and an engine with no host path field comes back as the same object", () => {
    const farEnd = { host: "plc.internal", port: 4840 };
    const record = Object.freeze({
      ...connection("opcua", { clientCertificatePath: path.join(scratch, "c.pem") }),
      [ADMITTED_HOST_PATHS]: { clientCertificatePath: "/caller/chose.pem", clientPrivateKeyPath: "/caller/k.pem" },
      [TUNNEL_FAR_END]: farEnd,
    });
    const copy = admittedHostPathConnection(record);
    expect(hostPaths(copy)).toEqual({ clientCertificatePath: path.join(scratch, "c.pem") });
    expect((copy as { [TUNNEL_FAR_END]?: unknown })[TUNNEL_FAR_END]).toBe(farEnd);
    expect(hostPaths(record)).toEqual({
      clientCertificatePath: "/caller/chose.pem",
      clientPrivateKeyPath: "/caller/k.pem",
    });

    const postgres = connection("postgres", { clientCertificatePath: "/etc/c.pem" });
    expect(admittedHostPathConnection(postgres)).toBe(postgres);
    const marked = { ...postgres, [ADMITTED_HOST_PATHS]: { clientCertificatePath: "/caller/chose.pem" } };
    const unmarked = admittedHostPathConnection(marked);
    expect(unmarked).not.toBe(marked);
    expect(ADMITTED_HOST_PATHS in unmarked).toBe(false);
    expect(hostPaths(marked)).toEqual({ clientCertificatePath: "/caller/chose.pem" });
  });

  test("every field a legacy row names as a host path field is a seed-only field, so only an operator's seed file or an embedder's own code names one", () => {
    const named = new Set(Object.values(hostPathFields).flat());
    expect(named.size).toBeGreaterThan(0);
    for (const field of named)
      expect([field, (SEED_ONLY_FIELD_NAMES as readonly string[]).includes(field)]).toEqual([field, true]);
  });

  test("every engine whose legacy register row names a host path field, built from its census connection with both paths set, holds absolute admitted paths, and no other engine holds any", async () => {
    const holders: string[] = [];
    for (const type of Object.keys(CENSUS_CONNECTION) as DatabaseType[]) {
      // oxlint-disable-next-line no-await-in-loop -- one build at a time, each read before the next.
      const provider = await createDatabaseProvider({
        ...CENSUS_CONNECTION[type],
        clientCertificatePath: "census-c.pem",
        clientPrivateKeyPath: "census-k.pem",
      });
      const admittedPaths = hostPaths(provider.config);
      if (admittedPaths === undefined) continue;
      holders.push(type);
      expect(Object.keys(admittedPaths).sort()).toEqual([...hostPathFields[type]].sort());
      for (const file of Object.values(admittedPaths)) expect(path.isAbsolute(file)).toBe(true);
    }
    const named = (Object.keys(hostPathFields) as DatabaseType[]).filter((type) => hostPathFields[type].length > 0);
    expect(holders.sort()).toEqual(named.sort());
    expect(named).toEqual(["opcua"]);
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

/**
 * The providers directory (`LIBREDB_PROVIDERS_DIR`, src/lib/provider-host/providers-dir.ts) holds the packages Studio
 * may load and their lock, so no connection's file or host path names it, a path in it or its lock: each is refused by
 * name, after the storage check, before any provider is built.
 */
describe("core refuses a connection naming the providers directory", () => {
  const originalProviders = process.env.LIBREDB_PROVIDERS_DIR;

  afterEach(() => {
    if (originalProviders === undefined) delete process.env.LIBREDB_PROVIDERS_DIR;
    else process.env.LIBREDB_PROVIDERS_DIR = originalProviders;
    forgetProvidersDirectory();
  });

  test("a file or host path naming the providers directory, a path in it or its lock is refused by name before any provider is built", async () => {
    const providers = path.join(scratch, "providers-reserved", "providers");
    const artifactFile = path.join(providers, "acme-provider", "1.0.0", "dist", "index.mjs");
    fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
    fs.writeFileSync(artifactFile, "export default {};\n");
    fs.writeFileSync(path.join(providers, LOCK_FILE_NAME), "{}\n");
    process.env.LIBREDB_PROVIDERS_DIR = providers;
    forgetProvidersDirectory();
    const named = [providers, artifactFile, path.join(providers, "later.db"), path.join(providers, LOCK_FILE_NAME)];

    const fileTypes = (Object.keys(opensLocalFile) as DatabaseType[]).filter((type) => opensLocalFile[type]);
    expect(fileTypes.length).toBeGreaterThan(0);
    for (const type of fileTypes) {
      for (const file of named) {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
        const refused = await createDatabaseProvider(connection(type, { database: file })).then(
          () => null,
          (error: unknown) => error,
        );
        expect([type, file, refused instanceof DatabaseConfigError]).toEqual([type, file, true]);
        expect((refused as DatabaseConfigError).message).toBe(RESERVED_PROVIDERS_PATH);
        expect((refused as DatabaseConfigError).provider).toBe(type);
      }
    }

    const hostPathTypes = (Object.keys(hostPathFields) as DatabaseType[]).filter(
      (type) => hostPathFields[type].length > 0,
    );
    expect(hostPathTypes.length).toBeGreaterThan(0);
    for (const type of hostPathTypes) {
      for (const field of hostPathFields[type]) {
        for (const file of named) {
          // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
          const refused = await createDatabaseProvider(connection(type, { [field]: file })).then(
            () => null,
            (error: unknown) => error,
          );
          expect([type, field, file, refused instanceof DatabaseConfigError]).toEqual([type, field, file, true]);
          expect((refused as DatabaseConfigError).message).toBe(`${field}: ${RESERVED_PROVIDERS_PATH}`);
          expect((refused as DatabaseConfigError).provider).toBe(type);
        }
      }
    }

    // A sibling of the providers directory is a file like any other.
    const sibling = admittedFileConnection(
      connection(fileTypes[0] as DatabaseType, { database: `${providers}-old.db` }),
    );
    expect(admitted(sibling)).toBe(`${providers}-old.db`);
  });

  test("a candidate the providers check cannot read is refused as not checked, naming the field", () => {
    const providers = path.join(scratch, "providers-unchecked", "providers");
    fs.mkdirSync(providers, { recursive: true });
    process.env.LIBREDB_PROVIDERS_DIR = providers;
    forgetProvidersDirectory();
    const candidate = path.join(scratch, "providers-unchecked", "free.db");
    const fault = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const realStat = fs.statSync;
    // The providers check reads identities as bigint stats, the storage check as plain ones, so only the former fails.
    const stat = spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (target === candidate && options?.bigint === true) throw fault;
      return realStat(target, options);
    }) as typeof fs.statSync);
    let refused: unknown = null;
    try {
      admittedHostPathConnection(connection("opcua", { clientCertificatePath: candidate }));
    } catch (error) {
      refused = error;
    } finally {
      stat.mockRestore();
    }
    expect(refused).toBeInstanceOf(DatabaseConfigError);
    expect((refused as DatabaseConfigError).message).toBe(
      `clientCertificatePath: ${PATH_NOT_CHECKED}: EACCES: permission denied`,
    );
    expect((refused as DatabaseConfigError).cause).toBe(fault);
  });
});
