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
  LINKS_FOLLOWED_LIMIT,
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

/**
 * A path whose resolution follows more than `LINKS_FOLLOWED_LIMIT` symbolic links is refused with ELOOP. The real-path
 * read of every path under the chain's directory answers "no such file" here, so the walk follows each link itself and
 * the kernel's own link limit never decides; the chain's directory itself reads as before.
 */
describe("data-dir canonicalPath() follows at most LINKS_FOLLOWED_LIMIT links", () => {
  const originalPath = process.env.STORAGE_SQLITE_PATH;
  const realpath = fs.realpathSync;
  let scratch: string;
  let chain: string;
  let missing: ReturnType<typeof spyOn> | undefined;

  /** Answers ENOENT to the real-path read of every path under `chain`; every other path reads as before. */
  function walkChainByHand(): void {
    const under = `${chain}${path.sep}`;
    missing = spyOn(fs, "realpathSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
      if (String(file).startsWith(under)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${String(file)}'`), {
          code: "ENOENT",
        });
      }
      return realpath(file, options as fs.EncodingOption);
    }) as typeof fs.realpathSync);
  }

  /** Links `<name>1 -> <name>2 -> ... -> <name><count> -> <target>`, each with an absolute target; returns the first. */
  function linkChain(count: number, target: string, name = "n"): string {
    for (let i = 1; i <= count; i++) {
      const next = i === count ? target : path.join(chain, `${name}${i + 1}`);
      fs.symlinkSync(next, path.join(chain, `${name}${i}`));
    }
    return path.join(chain, `${name}1`);
  }

  beforeEach(() => {
    forgetStorageLocation();
    scratch = realpath(fs.mkdtempSync(path.join(tmpdir(), "libredb-link-limit-")));
    chain = path.join(scratch, "chain");
    fs.mkdirSync(path.join(scratch, "data"));
    fs.mkdirSync(chain);
    fs.writeFileSync(path.join(scratch, "data", "storage.db"), "store");
    process.env.STORAGE_SQLITE_PATH = path.join(scratch, "data", "storage.db");
  });

  afterEach(() => {
    missing?.mockRestore();
    missing = undefined;
    if (originalPath === undefined) delete process.env.STORAGE_SQLITE_PATH;
    else process.env.STORAGE_SQLITE_PATH = originalPath;
    forgetStorageLocation();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test("the limit is the 40 links Linux follows in one path resolution", () => {
    expect(LINKS_FOLLOWED_LIMIT).toBe(40);
  });

  test("a path whose resolution follows exactly LINKS_FOLLOWED_LIMIT links resolves to the file the last one names", () => {
    const end = path.join(chain, "end.db");
    const first = linkChain(LINKS_FOLLOWED_LIMIT, end);
    walkChainByHand();

    expect(canonicalPath(first)).toBe(end);
  });

  test("a path whose resolution follows one link more is refused with ELOOP, naming the path", () => {
    const first = linkChain(LINKS_FOLLOWED_LIMIT + 1, path.join(chain, "end.db"));
    walkChainByHand();

    let thrown: unknown;
    try {
      canonicalPath(first);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      code: "ELOOP",
      path: first,
      message: `ELOOP: more than ${LINKS_FOLLOWED_LIMIT} symbolic links followed while resolving '${first}'`,
    });
  });

  // The leaf's chain ends at a file under the parent's chain, so the walk follows both in one call; each chain alone is
  // short enough that the filesystem's own lstat through the parent's chain answers "no such file", not ELOOP.
  test("the links followed while resolving a missing path's parents count toward the same limit", () => {
    const parents = LINKS_FOLLOWED_LIMIT / 2 + 1;
    const parent = linkChain(parents, path.join(chain, "elsewhere"), "p");
    const within = linkChain(LINKS_FOLLOWED_LIMIT - parents, path.join(parent, "file.db"), "w");
    const over = linkChain(LINKS_FOLLOWED_LIMIT - parents + 1, path.join(parent, "file.db"), "o");
    walkChainByHand();

    expect(canonicalPath(within)).toBe(path.join(chain, "elsewhere", "file.db"));
    expect(() => canonicalPath(over)).toThrow(
      `ELOOP: more than ${LINKS_FOLLOWED_LIMIT} symbolic links followed while resolving '${over}'`,
    );
  });

  // Bun 1.4.4 passes at most 65,536 arguments to a call made with a spread and drops the rest without an error
  // (measured), so the names are joined into one string, not spread into path.join. Linux only: macOS allows a link's
  // target 1023 bytes, so 40 links there add about 20,000 names, and Windows makes a link only with a privilege.
  test.skipIf(process.platform !== "linux")(
    "a path whose links add more names than one call takes as arguments resolves to every one of them",
    () => {
      const depth = 1_700;
      const tail = Array.from({ length: depth }, () => "m").join(path.sep);
      for (let i = 1; i <= LINKS_FOLLOWED_LIMIT; i++) {
        fs.symlinkSync(path.join(`n${i + 1}`, tail), path.join(chain, `n${i}`));
      }
      const resolved = canonicalPath(path.join(chain, "n1")).split(path.sep);

      expect(resolved.filter((name) => name === "m").length).toBe(LINKS_FOLLOWED_LIMIT * depth);
      expect(resolved.slice(0, chain.split(path.sep).length + 1)).toEqual([
        ...chain.split(path.sep),
        `n${LINKS_FOLLOWED_LIMIT + 1}`,
      ]);
    },
  );

  test("a chain of links within the limit that ends at a reserved file not yet created is still reserved", () => {
    const first = linkChain(LINKS_FOLLOWED_LIMIT - 1, path.join(scratch, "data", "storage.db-wal"));
    walkChainByHand();

    expect(canonicalPath(first)).toBe(path.join(scratch, "data", "storage.db-wal"));
    expect(isReservedStoragePath(first)).toBe(true);
  });
});

/**
 * A missing path is resolved with one lookup per ancestor: the filesystem calls `canonicalPath` makes are counted here
 * through the `fs` functions it calls, on links that each add many missing components, so the count shows whether it
 * grows with those components.
 */
describe("data-dir canonicalPath() looks up each ancestor of a missing path once", () => {
  let scratch: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "libredb-ancestor-walk-")));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * Links `L0 -> L1/m/.../m -> ... -> L<links - 1> -> end/m/.../m` in a directory of their own, each target adding
   * `missing` components; returns that directory.
   */
  function deepChain(name: string, links: number, missing: number): string {
    const deep = path.join(scratch, name);
    fs.mkdirSync(deep);
    const tail = Array.from({ length: missing }, () => "m").join(path.sep);
    for (let i = 0; i < links; i++) {
      fs.symlinkSync(path.join(i === links - 1 ? "end" : `L${i + 1}`, tail), path.join(deep, `L${i}`));
    }
    return deep;
  }

  /** Resolves `candidate` and returns its real path with the number of filesystem calls it took. */
  function counted(candidate: string): { resolved: string; calls: number } {
    let calls = 0;
    for (const name of ["realpathSync", "lstatSync", "readlinkSync", "statSync"] as const) {
      const original = fs[name] as (...args: unknown[]) => unknown;
      spies.push(
        spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
          calls += 1;
          return original(...args);
        }) as never),
      );
    }
    try {
      return { resolved: canonicalPath(candidate), calls };
    } finally {
      for (const spy of spies) spy.mockRestore();
      spies = [];
    }
  }

  // Each link costs its own three calls (the real-path read, the lookup that finds the link, the read of its target)
  // and one jump to the deepest existing ancestor of its target: the real-path read and lookup of the target, then one
  // lookup for each of the deep directory's ancestors below the root, for the deep directory, for the next link and for
  // the first missing name after it. The last target ends at the deep directory, read once more.
  test("the calls are linear in the links followed plus the depth of the existing directory, whatever each link adds", () => {
    const links = 30;
    // macOS's realpath expands every link it follows, with the names left after it, into one 1,024-byte buffer and
    // answers ENAMETOOLONG past it, so 30 links of 10 names each (about 600 bytes) stay under it.
    const added = 10;
    const many = deepChain("many", links, added);
    const few = deepChain("few", links, 5);
    const depth = many.split(path.sep).filter((name) => name !== "").length;
    const bound = links * 3 + links * (depth + 4) + 1;

    const deep = counted(path.join(many, "L0"));
    const shallow = counted(path.join(few, "L0"));

    expect(deep.resolved).toBe(path.join(many, "end", ...Array.from({ length: links * added }, () => "m")));
    expect(shallow.resolved).toBe(path.join(few, "end", ...Array.from({ length: links * 5 }, () => "m")));
    expect(deep.calls).toBe(shallow.calls);
    expect(deep.calls).toBeLessThanOrEqual(bound);
  });

  test("a missing path under existing directories is their real path joined with every missing name, in order", () => {
    fs.mkdirSync(path.join(scratch, "real", "inner"), { recursive: true });
    fs.symlinkSync(path.join(scratch, "real"), path.join(scratch, "alias"));
    const candidate = path.join(scratch, "alias", "inner", "a", "b", "c.db");

    const { resolved, calls } = counted(candidate);

    expect(resolved).toBe(path.join(scratch, "real", "inner", "a", "b", "c.db"));
    expect(calls).toBeLessThanOrEqual(candidate.split(path.sep).length + 3);
  });

  test("a missing path under a missing root is refused with the root's error", () => {
    const root = path.parse(scratch).root;
    const realpath = fs.realpathSync;
    const lstat = fs.lstatSync;
    const missing = (file: fs.PathLike) => String(file).startsWith(root);
    spies.push(
      spyOn(fs, "realpathSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
        if (missing(file)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, '${String(file)}'`), { code: "ENOENT" });
        }
        return realpath(file, options as fs.EncodingOption);
      }) as typeof fs.realpathSync),
      spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: fs.StatOptions) => {
        if (missing(file)) return undefined;
        return lstat(file, options);
      }) as typeof fs.lstatSync),
    );

    expect(() => canonicalPath(path.join(scratch, "a", "b"))).toThrow(`ENOENT: no such file or directory, '${root}'`);
  });
});
