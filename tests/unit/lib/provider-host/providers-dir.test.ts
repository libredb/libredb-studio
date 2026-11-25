/**
 * The providers directory (src/lib/provider-host/providers-dir.ts): `LIBREDB_PROVIDERS_DIR` is taken once per process,
 * resolved against the working directory of the first read and logged once, and the directory, everything in it and
 * its lock are reserved against a connection's file and host paths, by folded name and by file identity.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@/lib/logger";
import {
  forgetProvidersDirectory,
  LOCK_FILE_NAME,
  providersDirectory,
  providersDirectoryCheck,
} from "@/lib/provider-host/providers-dir";
import { removeScratch, scratchDirectory } from "../../../helpers/provider-artifacts";
import { MISSING_POSIX_SPECIAL_FILES } from "../../../helpers/special-files";

const VARIABLE = "LIBREDB_PROVIDERS_DIR";
const originalValue = process.env[VARIABLE];
const originalDirectory = process.cwd();
const scratch = scratchDirectory("libredb-providers-dir-");
let info: ReturnType<typeof spyOn>;

beforeEach(() => {
  forgetProvidersDirectory();
  info = spyOn(logger, "info").mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  process.chdir(originalDirectory);
  if (originalValue === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = originalValue;
  forgetProvidersDirectory();
});

afterAll(() => {
  removeScratch(scratch);
});

/** The info lines the providers directory logged. */
function directoryLines(): unknown[][] {
  return info.mock.calls.filter((call: unknown[]) => (call[1] as { route?: string })?.route === "providers-directory");
}

describe("the providers directory is taken once per process", () => {
  test("the directory is read once and a later change of working directory changes nothing", () => {
    const first = path.join(scratch, "first");
    const second = path.join(scratch, "second");
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    process.chdir(first);
    process.env[VARIABLE] = "providers";

    const taken = providersDirectory();
    process.chdir(second);
    process.env[VARIABLE] = path.join(scratch, "elsewhere");

    expect(taken).toBe(path.join(first, "providers"));
    expect(providersDirectory()).toBe(taken);
  });

  test("an absolute LIBREDB_PROVIDERS_DIR is kept, and a relative one is resolved against the working directory when it is first read", () => {
    const absolute = path.join(scratch, "absolute", "providers");
    process.env[VARIABLE] = `  ${absolute}  `;
    expect(providersDirectory()).toBe(absolute);

    forgetProvidersDirectory();
    process.chdir(scratch);
    process.env[VARIABLE] = path.join("relative", "providers");
    expect(providersDirectory()).toBe(path.join(scratch, "relative", "providers"));
  });

  test("an unset, empty or blank LIBREDB_PROVIDERS_DIR is no providers directory", () => {
    for (const value of [undefined, "", "   \t "]) {
      forgetProvidersDirectory();
      if (value === undefined) delete process.env[VARIABLE];
      else process.env[VARIABLE] = value;
      expect([value, providersDirectory()]).toEqual([value, null]);
    }
  });

  test("the first read logs the directory once, at info, and says once that none is set", () => {
    const directory = path.join(scratch, "logged");
    process.env[VARIABLE] = directory;
    providersDirectory();
    providersDirectory();
    expect(directoryLines()).toEqual([
      [
        "Studio's providers directory is taken for this process",
        { route: "providers-directory", providersDirectory: directory },
      ],
    ]);

    info.mockClear();
    forgetProvidersDirectory();
    delete process.env[VARIABLE];
    providersDirectory();
    providersDirectory();
    expect(directoryLines()).toEqual([
      [
        "No providers directory is set for this process, so no provider package is read",
        { route: "providers-directory" },
      ],
    ]);
  });

  test("the kept directory lives on globalThis under a registered symbol, so every copy of this module reads one directory", () => {
    const directory = path.join(scratch, "kept");
    process.env[VARIABLE] = directory;
    providersDirectory();
    const kept = (globalThis as Record<symbol, unknown>)[Symbol.for("libredb-studio.providers-directory")];
    expect(kept).toEqual({ directory });
    expect(Object.isFrozen(kept)).toBe(true);

    forgetProvidersDirectory();
    delete process.env[VARIABLE];
    providersDirectory();
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("libredb-studio.providers-directory")]).toEqual({
      directory: null,
    });
  });

  test("forgetProvidersDirectory makes the next read take it again", () => {
    process.env[VARIABLE] = path.join(scratch, "before");
    expect(providersDirectory()).toBe(path.join(scratch, "before"));
    process.env[VARIABLE] = path.join(scratch, "after");
    expect(providersDirectory()).toBe(path.join(scratch, "before"));
    forgetProvidersDirectory();
    expect(providersDirectory()).toBe(path.join(scratch, "after"));
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("libredb-studio.providers-directory")]).toBeDefined();
    forgetProvidersDirectory();
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("libredb-studio.providers-directory")]).toBeUndefined();
  });
});

describe("the providers directory and its lock are reserved", () => {
  /** A providers directory with one artifact and a lock, set as this process's directory. */
  function reservedLayout(name: string): { providers: string; artifactFile: string; lock: string } {
    const providers = path.join(scratch, name, "providers");
    const artifactFile = path.join(providers, "acme-provider", "1.0.0", "dist", "index.mjs");
    fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
    fs.writeFileSync(artifactFile, "export default {};\n");
    const lock = path.join(providers, LOCK_FILE_NAME);
    fs.writeFileSync(lock, "{}\n");
    process.env[VARIABLE] = providers;
    return { providers, artifactFile, lock };
  }

  test("the providers directory, everything in it and its lock, by real path too, are reserved in any letter case, normalization form or spelling", () => {
    const { providers, artifactFile, lock } = reservedLayout("reserved");
    const outside = path.join(scratch, "reserved", "outside");
    fs.mkdirSync(outside, { recursive: true });
    const hardLink = path.join(outside, "lock-hard.json");
    fs.linkSync(lock, hardLink);
    const alias = path.join(scratch, "reserved", "alias");
    fs.symlinkSync(providers, alias, "junction");
    const accented = path.join(providers, "caf\u00e9", "x.db");
    const isReserved = providersDirectoryCheck();

    const cases: [string, string][] = [
      ["the directory", providers],
      ["a file in an artifact", artifactFile],
      ["a path under a directory not created yet", path.join(providers, "later", "deeper", "x.db")],
      ["the lock", lock],
      ["a hard link to the lock elsewhere", hardLink],
      ["upper case", providers.toUpperCase()],
      ["NFD", accented.normalize("NFD")],
      ["a junction alias", path.join(alias, "acme-provider", "1.0.0", "dist", "index.mjs")],
    ];
    // A file symlink needs a privilege on Windows (MISSING_POSIX_SPECIAL_FILES), so that case runs on POSIX only.
    if (MISSING_POSIX_SPECIAL_FILES === null) {
      const lockLink = path.join(outside, "lock-link.json");
      fs.symlinkSync(lock, lockLink);
      cases.push(["a link at the lock's name", lockLink]);
    }
    for (const [label, candidate] of cases) {
      expect([label, isReserved(candidate)]).toEqual([label, true]);
    }

    // A canonicalizer that keeps every spelling stands for Node's real-path read on Windows, which keeps a short 8.3
    // name: the alias is then reserved by the identity of its existing ancestor alone.
    const keepsSpelling = providersDirectoryCheck((candidate) => candidate);
    expect(keepsSpelling(path.join(alias, "acme-provider", "1.0.0", "dist", "index.mjs"))).toBe(true);
    expect(keepsSpelling(path.join(alias, "not-created", "x.db"))).toBe(true);
    expect(keepsSpelling(hardLink)).toBe(true);
    expect(keepsSpelling(path.join(outside, "free.db"))).toBe(false);
  });

  test("a sibling whose name starts with the directory's name is not reserved, and nothing is with no directory set", () => {
    const { providers } = reservedLayout("siblings");
    const sibling = `${providers}-old`;
    fs.mkdirSync(sibling, { recursive: true });
    const isReserved = providersDirectoryCheck();
    expect(isReserved(path.join(sibling, "x.db"))).toBe(false);
    expect(isReserved(sibling)).toBe(false);
    expect(isReserved(path.dirname(providers))).toBe(false);

    forgetProvidersDirectory();
    delete process.env[VARIABLE];
    const nothing = providersDirectoryCheck();
    expect(nothing(providers)).toBe(false);
    expect(nothing(path.join(providers, LOCK_FILE_NAME))).toBe(false);
  });

  test("a providers directory or lock not created yet is reserved by name, and an error reading their identity is the server's", () => {
    const providers = path.join(scratch, "not-yet", "providers");
    process.env[VARIABLE] = providers;
    const isReserved = providersDirectoryCheck();
    expect(isReserved(path.join(providers, LOCK_FILE_NAME))).toBe(true);
    expect(isReserved(path.join(providers, "a", "b"))).toBe(true);
    expect(isReserved(path.join(scratch, "not-yet", "free.db"))).toBe(false);

    const fault = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    const stat = spyOn(fs, "statSync").mockImplementation(() => {
      throw fault;
    });
    try {
      expect(() => providersDirectoryCheck()).toThrow(fault);
    } finally {
      stat.mockRestore();
    }
  });

  test("an error reading a candidate's identity, other than no entry, is raised as the candidate's", () => {
    const { providers } = reservedLayout("candidate-errors");
    const isReserved = providersDirectoryCheck((candidate) => candidate);
    const free = path.join(scratch, "candidate-errors", "free.db");
    const realStat = fs.statSync;
    const fault = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const stat = spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (target === free) throw fault;
      return realStat(target, options);
    }) as typeof fs.statSync);
    try {
      expect(() => isReserved(free)).toThrow(fault);
    } finally {
      stat.mockRestore();
    }
    expect(isReserved(providers)).toBe(true);
  });

  test("the root as the providers directory reserves every path under it", () => {
    process.env[VARIABLE] = path.parse(scratch).root;
    const isReserved = providersDirectoryCheck((candidate) => candidate);
    expect(isReserved(path.join(scratch, "anything.db"))).toBe(true);
    expect(isReserved(tmpdir())).toBe(true);
  });
});
