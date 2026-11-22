import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as path from "path";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import {
  canonicalPath,
  DEFAULT_STORAGE_SQLITE_PATH,
  foldPathKey,
  forgetStorageLocation,
  getDataDir,
  getStorageSqlitePath,
  isReservedStoragePath,
  reservedStoragePaths,
  storageLocation,
} from "@/lib/data-dir";
import { logger } from "@/lib/logger";

describe("data-dir getDataDir()", () => {
  let origStoragePath: string | undefined;

  beforeEach(() => {
    origStoragePath = process.env.STORAGE_SQLITE_PATH;
  });

  afterEach(() => {
    if (origStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
    else process.env.STORAGE_SQLITE_PATH = origStoragePath;
  });

  test("defaults to the directory of the default SQLite storage path", () => {
    delete process.env.STORAGE_SQLITE_PATH;
    expect(getDataDir()).toBe(path.dirname(DEFAULT_STORAGE_SQLITE_PATH));
  });

  test("derives the data dir from STORAGE_SQLITE_PATH when set", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(getDataDir()).toBe("/var/lib/libredb");
  });

  test("treats an empty STORAGE_SQLITE_PATH as unset", () => {
    process.env.STORAGE_SQLITE_PATH = "";
    expect(getDataDir()).toBe(path.dirname(DEFAULT_STORAGE_SQLITE_PATH));
  });
});

describe("data-dir reserved storage paths", () => {
  let origStoragePath: string | undefined;

  // Each test sets STORAGE_SQLITE_PATH before its first check, so the location this process keeps is forgotten around
  // it and taken again by that check; a test that sets the variable more than once forgets the location after each set.
  beforeEach(() => {
    origStoragePath = process.env.STORAGE_SQLITE_PATH;
    forgetStorageLocation();
  });

  afterEach(() => {
    if (origStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
    else process.env.STORAGE_SQLITE_PATH = origStoragePath;
    forgetStorageLocation();
  });

  test("getStorageSqlitePath returns the default when unset", () => {
    delete process.env.STORAGE_SQLITE_PATH;
    expect(getStorageSqlitePath()).toBe(DEFAULT_STORAGE_SQLITE_PATH);
  });

  test("getStorageSqlitePath returns the configured path when set", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(getStorageSqlitePath()).toBe("/var/lib/libredb/storage.db");
  });

  test("getStorageSqlitePath treats an empty value as unset", () => {
    process.env.STORAGE_SQLITE_PATH = "";
    expect(getStorageSqlitePath()).toBe(DEFAULT_STORAGE_SQLITE_PATH);
  });

  test("reservedStoragePaths lists the storage file and its WAL/SHM sidecars, resolved", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "libredb-storage-path-"));
    try {
      process.env.STORAGE_SQLITE_PATH = path.join(dir, "storage.db");
      const base = path.join(fs.realpathSync(dir), "storage.db");
      expect(reservedStoragePaths()).toEqual([base, `${base}-wal`, `${base}-shm`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reservedStoragePaths resolves a relative configured path against the cwd", () => {
    process.env.STORAGE_SQLITE_PATH = "data/libredb-storage.db";
    const base = path.resolve("data/libredb-storage.db");
    expect(reservedStoragePaths()).toEqual([base, `${base}-wal`, `${base}-shm`]);
  });

  test("isReservedStoragePath matches the storage file however it is spelled", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(isReservedStoragePath("/var/lib/libredb/storage.db")).toBe(true);
    expect(isReservedStoragePath("/var/lib/libredb/../libredb/storage.db")).toBe(true);
  });

  test("isReservedStoragePath matches the WAL and SHM sidecars", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(isReservedStoragePath("/var/lib/libredb/storage.db-wal")).toBe(true);
    expect(isReservedStoragePath("/var/lib/libredb/storage.db-shm")).toBe(true);
  });

  test("isReservedStoragePath does not match an unrelated path", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(isReservedStoragePath("/var/lib/libredb/other.db")).toBe(false);
    expect(isReservedStoragePath("/tmp/user-data.db")).toBe(false);
  });

  test("isReservedStoragePath matches each storage file and bootstrap file in another letter case, none of them existing", () => {
    // On macOS and Windows each spelling names the reserved file itself.
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    for (const name of [
      "STORAGE.DB",
      "Storage.db",
      "storage.DB-WAL",
      "Storage.db-Shm",
      "Auth-Bootstrap.json",
      "AUTH-BOOTSTRAP.JSON.BAK",
      "auth-bootstrap.json.1234.TMP",
      "Auth-Bootstrap.JSON.1234.tmp",
    ]) {
      expect([name, isReservedStoragePath(`/var/lib/libredb/${name}`)]).toEqual([name, true]);
    }
    expect(isReservedStoragePath("/VAR/Lib/LibreDB/storage.db")).toBe(true);
  });

  test("isReservedStoragePath matches each storage file and bootstrap file in another Unicode normalization form", () => {
    const composed = "/var/lib/libr\u00e9db";
    const decomposed = "/var/lib/libre\u0301db";
    for (const [configured, candidate] of [
      [composed, decomposed],
      [decomposed, composed],
    ]) {
      process.env.STORAGE_SQLITE_PATH = `${configured}/storage.db`;
      forgetStorageLocation();
      for (const name of [
        "storage.db",
        "storage.db-wal",
        "storage.db-shm",
        "auth-bootstrap.json",
        "auth-bootstrap.json.bak",
        "auth-bootstrap.json.1234.tmp",
      ]) {
        expect([name, isReservedStoragePath(`${candidate}/${name}`)]).toEqual([name, true]);
      }
      expect(isReservedStoragePath(`${candidate.toUpperCase()}/STORAGE.DB-WAL`)).toBe(true);
    }
  });

  test("isReservedStoragePath still allows a name that differs in more than letter case or normalization", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    for (const name of [
      "STORAGE2.DB",
      "storage.db-journal",
      "Storage.db.bak",
      "AUTH-BOOTSTRAP.JSON.BAK2",
      "auth-bootstrap.json.1234.tmp2",
      "auth-bootstrap.jsonx.tmp",
      "auth-bootstrap.tmp",
      "storage.db.pre-reseal",
      "storage.dbx.pre-reseal-20261122T053000Z",
      "other.db.pre-reseal-20261122T053000Z",
    ]) {
      expect([name, isReservedStoragePath(`/var/lib/libredb/${name}`)]).toEqual([name, false]);
    }
    expect(isReservedStoragePath("/var/lib/libredb-other/STORAGE.DB")).toBe(false);
  });

  test("isReservedStoragePath matches every name the re-seal's backup of the store takes, none of them existing", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    for (const name of [
      "storage.db.pre-reseal-20261122T053000Z",
      "storage.db.pre-reseal-20261122T053000Z-wal",
      "STORAGE.DB.PRE-RESEAL-20261122T053000Z",
    ]) {
      expect([name, isReservedStoragePath(`/var/lib/libredb/${name}`)]).toEqual([name, true]);
    }
  });

  test("an error reading the data directory for the re-seal's backups, other than its absence, is raised", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "libredb-data-dir-backups-"));
    process.env.STORAGE_SQLITE_PATH = path.join(dir, "storage.db");
    const error = Object.assign(new Error("unreadable"), { code: "EACCES" });
    const readdir = spyOn(fs, "readdirSync").mockImplementation(() => {
      throw error;
    });
    try {
      expect(() => isReservedStoragePath(path.join(dir, "user.db"))).toThrow("unreadable");
    } finally {
      readdir.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("data-dir foldPathKey()", () => {
  test("folds letter case and Unicode normalization to one key", () => {
    expect(foldPathKey("/Data/LibreDB-Storage.DB")).toBe(foldPathKey("/data/libredb-storage.db"));
    expect(foldPathKey("/data/d\u00fcsseldorf")).toBe(foldPathKey("/DATA/Du\u0308sseldorf"));
  });

  test("folds letter case one code point at a time, so the two lower-case sigmas are one letter and sharp s is not SS", () => {
    // NTFS upcases both lower-case sigmas to the capital, and APFS folds the final sigma to the other.
    expect(foldPathKey("\u03bf\u03b4\u03bf\u03c3.db")).toBe(foldPathKey("\u03bf\u03b4\u03bf\u03c2.db"));
    expect(foldPathKey("\u03bf\u03b4\u03bf\u03c3.db")).toBe(foldPathKey("\u039f\u0394\u039f\u03a3.DB"));
    expect(foldPathKey("stra\u00dfe.db")).toBe(foldPathKey("STRA\u1e9eE.db"));
    expect(foldPathKey("stra\u00dfe.db")).not.toBe(foldPathKey("STRASSE.db"));
  });
});

/**
 * Studio's storage location is taken once per process (FND-2 slice 3): `STORAGE_SQLITE_PATH` resolved against the
 * working directory when the location is first read, and the directory that holds it. The reserved set is derived from
 * it, so a later setting or working directory moves neither.
 */
describe("Studio's storage location is taken once per process (FND-2 slice 3)", () => {
  const originalPath = process.env.STORAGE_SQLITE_PATH;
  const originalDirectory = process.cwd();
  let info: ReturnType<typeof spyOn>;
  let scratch: string;

  beforeEach(() => {
    forgetStorageLocation();
    info = spyOn(logger, "info").mockImplementation(() => {});
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "libredb-storage-location-")));
  });

  afterEach(() => {
    info.mockRestore();
    process.chdir(originalDirectory);
    if (originalPath === undefined) delete process.env.STORAGE_SQLITE_PATH;
    else process.env.STORAGE_SQLITE_PATH = originalPath;
    forgetStorageLocation();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test("the location is the storage file STORAGE_SQLITE_PATH names, resolved against the working directory when it is first read, and the directory that holds it", () => {
    process.chdir(scratch);
    process.env.STORAGE_SQLITE_PATH = "state/own.db";
    expect(storageLocation()).toEqual({
      storageFile: path.join(scratch, "state", "own.db"),
      dataDirectory: path.join(scratch, "state"),
    });
    for (const unset of [undefined, ""]) {
      forgetStorageLocation();
      if (unset === undefined) delete process.env.STORAGE_SQLITE_PATH;
      else process.env.STORAGE_SQLITE_PATH = unset;
      expect(storageLocation()).toEqual({
        storageFile: path.join(scratch, "data", "libredb-storage.db"),
        dataDirectory: path.join(scratch, "data"),
      });
    }
  });

  test("neither a later STORAGE_SQLITE_PATH nor a later working directory moves the location or the reserved set", () => {
    process.chdir(scratch);
    process.env.STORAGE_SQLITE_PATH = "data/own.db";
    const first = storageLocation();
    const storageFile = path.join(scratch, "data", "own.db");
    expect(isReservedStoragePath(storageFile)).toBe(true);
    expect(isReservedStoragePath(path.join(scratch, "data", "auth-bootstrap.json"))).toBe(true);

    process.env.STORAGE_SQLITE_PATH = "elsewhere/other.db";
    const other = fs.mkdtempSync(path.join(scratch, "other-"));
    process.chdir(other);

    expect(storageLocation()).toEqual(first);
    expect(isReservedStoragePath(storageFile)).toBe(true);
    expect(isReservedStoragePath(`${storageFile}-wal`)).toBe(true);
    expect(isReservedStoragePath(path.join(scratch, "data", "auth-bootstrap.json"))).toBe(true);
    // Neither the new setting nor the old relative spelling at the new working directory names a reserved file.
    expect(isReservedStoragePath(path.join(other, "elsewhere", "other.db"))).toBe(false);
    expect(isReservedStoragePath(path.join(other, "data", "own.db"))).toBe(false);
    expect(reservedStoragePaths()).toEqual([storageFile, `${storageFile}-wal`, `${storageFile}-shm`]);
  });

  test("the first read logs the location once, at info", () => {
    process.env.STORAGE_SQLITE_PATH = path.join(scratch, "own.db");
    storageLocation();
    storageLocation();
    isReservedStoragePath(path.join(scratch, "user.db"));
    const lines = info.mock.calls.filter(
      (call: unknown[]) => (call[1] as { route?: string })?.route === "storage-location",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({
      route: "storage-location",
      storageFile: path.join(scratch, "own.db"),
      dataDirectory: scratch,
    });
  });

  test("the kept location lives on globalThis under a registered symbol, so every copy of this module reads one location", () => {
    // Next.js bundles the instrumentation apart from the route handlers, so one server process loads this module twice.
    const slot = Symbol.for("libredb-studio.storage-location");
    process.env.STORAGE_SQLITE_PATH = path.join(scratch, "own.db");
    const location = storageLocation();
    expect((globalThis as Record<symbol, unknown>)[slot]).toBe(location);
    forgetStorageLocation();
    expect(slot in globalThis).toBe(false);
  });

  test("forgetStorageLocation makes the next read take it again", () => {
    process.env.STORAGE_SQLITE_PATH = path.join(scratch, "first.db");
    expect(storageLocation().storageFile).toBe(path.join(scratch, "first.db"));
    process.env.STORAGE_SQLITE_PATH = path.join(scratch, "second.db");
    expect(storageLocation().storageFile).toBe(path.join(scratch, "first.db"));
    forgetStorageLocation();
    expect(storageLocation().storageFile).toBe(path.join(scratch, "second.db"));
  });
});

/**
 * A path whose last component the process cannot read is canonicalized from its parent, as a missing one is. macOS
 * answers EACCES to the real-path read of a file without read permission, where Linux needs only search permission on
 * its directories, so the read is replaced here for the named paths and the case runs the same on every OS.
 */
describe("data-dir canonicalPath() on a path whose last component the process cannot read", () => {
  const originalPath = process.env.STORAGE_SQLITE_PATH;
  const realpath = fs.realpathSync;
  let scratch: string;
  let denied: ReturnType<typeof spyOn> | undefined;

  /** Makes the real-path read of each of `paths` fail with `code`; every other path reads as before. */
  function denyRealpath(paths: string[], code: string): void {
    const named = new Set(paths);
    denied = spyOn(fs, "realpathSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
      if (named.has(String(file))) {
        throw Object.assign(new Error(`${code}: denied, lstat '${String(file)}'`), { code });
      }
      return realpath(file, options as fs.EncodingOption);
    }) as typeof fs.realpathSync);
  }

  beforeEach(() => {
    forgetStorageLocation();
    scratch = realpath(fs.mkdtempSync(path.join(tmpdir(), "libredb-unreadable-last-")));
    fs.mkdirSync(path.join(scratch, "data"));
    fs.mkdirSync(path.join(scratch, "user"));
    fs.writeFileSync(path.join(scratch, "data", "storage.db"), "store");
    process.env.STORAGE_SQLITE_PATH = path.join(scratch, "data", "storage.db");
  });

  afterEach(() => {
    denied?.mockRestore();
    denied = undefined;
    if (originalPath === undefined) delete process.env.STORAGE_SQLITE_PATH;
    else process.env.STORAGE_SQLITE_PATH = originalPath;
    forgetStorageLocation();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  for (const code of ["EACCES", "EPERM"]) {
    test(`a file whose real path answers ${code} is its parent's real path joined with its name, and is decided`, () => {
      const file = path.join(scratch, "user", "locked.db");
      fs.writeFileSync(file, "user data");
      fs.symlinkSync(path.join(scratch, "user"), path.join(scratch, "alias"));
      const spelled = path.join(scratch, "alias", "locked.db");
      denyRealpath([spelled], code);

      expect(canonicalPath(spelled)).toBe(file);
      expect(isReservedStoragePath(spelled)).toBe(false);
    });
  }

  test("a link to a reserved file, whose own real path answers EACCES, is still reserved", () => {
    const store = path.join(scratch, "data", "storage.db");
    const links = {
      symbolic: path.join(scratch, "user", "symbolic.db"),
      hard: path.join(scratch, "user", "hard.db"),
      "symbolic to a sidecar not yet created": path.join(scratch, "user", "wal.db"),
      "symbolic to the bootstrap backup not yet created": path.join(scratch, "user", "bak.json"),
    };
    fs.symlinkSync(store, links.symbolic);
    fs.linkSync(store, links.hard);
    fs.symlinkSync(`${store}-wal`, links["symbolic to a sidecar not yet created"]);
    fs.symlinkSync(
      path.join(scratch, "data", "auth-bootstrap.json.bak"),
      links["symbolic to the bootstrap backup not yet created"],
    );
    const otherCase = path.join(scratch, "data", "STORAGE.DB");
    denyRealpath([...Object.values(links), otherCase], "EACCES");

    for (const [kind, link] of Object.entries(links)) {
      expect([kind, isReservedStoragePath(link)]).toEqual([kind, true]);
    }
    expect(isReservedStoragePath(otherCase)).toBe(true);
  });

  test("the root, which has no parent, raises its error", () => {
    denyRealpath([path.parse(scratch).root], "EACCES");

    expect(() => canonicalPath(path.parse(scratch).root)).toThrow("EACCES: denied");
  });

  test("any other error from the real-path read is still raised", () => {
    const file = path.join(scratch, "user", "broken.db");
    fs.writeFileSync(file, "user data");
    denyRealpath([file], "EIO");

    expect(() => canonicalPath(file)).toThrow("EIO: denied");
    expect(() => isReservedStoragePath(file)).toThrow("EIO: denied");
  });
});
