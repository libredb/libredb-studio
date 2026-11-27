/**
 * The providers lock (src/lib/provider-host/providers-lock.ts): the lock `providers.lock.json` is read under its closed,
 * capped format before any entry is walked; each entry's directory `<name>/<version>/` resolves inside the providers
 * directory by real path, holds only regular files and directories, matches the digest the lock pins at every read and
 * has the identity its entry names; an entry serving an engine id Studio's bundled catalog serves, or one another entry
 * serves, is refused before any of its files is read. Every refusal is one code of one closed list, and names nothing
 * of the package beyond its name and version.
 *
 * Links in the cross-platform cases are junctions, which need no privilege on Windows and are plain links on POSIX. A
 * case that hands the reader a named pipe or a device runs in a bounded child (tests/helpers/special-files.ts), since a
 * walk that opened one would block or read forever.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { isDatabaseType } from "@/lib/db/type-id";
import { artifactDigest, walkArtifact } from "@/lib/provider-host/provider-artifact";
import {
  type PackageRefusal,
  PROVIDER_REFUSAL_CODES,
  PROVIDER_REFUSAL_RULES,
} from "@/lib/provider-host/provider-refusals";
import { type ProvidersLockRead, readProvidersLock } from "@/lib/provider-host/providers-lock";
import {
  DIGEST_FORM,
  ENGINE_ID_FORM,
  ENTRY_FORM,
  IMPORT_FROM_FORM,
  IMPORT_SPECIFIER_FORM,
  LOCK_BYTE_CAP,
  LOCK_ENGINE_CAP,
  LOCK_ENTRY_CAP,
  LOCK_FILE_NAME,
  LOCK_IMPORT_CAP,
  type LockEntry,
  PACKAGE_NAME_FORM,
  PACKAGE_VERSION_FORM,
  serializeProvidersLock,
} from "@/lib/provider-host/providers-lock-format";
import { describeIf } from "../../../helpers/posix-tools";
import {
  artifactDirectoryOf,
  type FixturePackage,
  lockEntryOf,
  removeScratch,
  scratchDirectory,
  UNMATCHED_DIGEST,
  writeArtifact,
  writeLock,
  writeLockText,
} from "../../../helpers/provider-artifacts";
import {
  CHILD_TEST_TIMEOUT_MS,
  MISSING_POSIX_SPECIAL_FILES,
  makeFifo,
  runInChild,
} from "../../../helpers/special-files";
import { valueImportsOf } from "../../../helpers/value-import-closure";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const LOCK_READER = "src/lib/provider-host/providers-lock.ts";
/**
 * The modules outside src/lib/provider-host that may import the lock reader, each with its reason: the packed lock
 * check reads back, in CI, the lock the packed npm package's command wrote, and decides no package's admission.
 */
const LOCK_READER_CHECKS: readonly string[] = ["scripts/check-lib-lock.ts"];
const ARTIFACT_MODULE = "src/lib/provider-host/provider-artifact.ts";
const LOCK_READER_PATH = path.join(REPOSITORY_ROOT, LOCK_READER);
const SCHEMA_FILE = path.join(REPOSITORY_ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json");

const scratch = scratchDirectory("libredb-providers-lock-");
let counter = 0;

afterAll(() => {
  removeScratch(scratch);
});

/** A new empty providers directory under the scratch root. */
function freshProviders(): string {
  counter += 1;
  const directory = path.join(scratch, `providers-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/** A fixture package with fixture engine ids, never one the bundled catalog serves. */
function fixture(name: string, engines: readonly string[] = [name.replace(/[^a-z0-9]/g, "")]): FixturePackage {
  return { name, version: "1.0.0", engines };
}

/** Writes each package and a lock that pins each as it stands now. */
function lockedProviders(...packages: FixturePackage[]): string {
  const providers = freshProviders();
  for (const pkg of packages) writeArtifact(providers, pkg);
  writeLock(
    providers,
    packages.map((pkg) => lockEntryOf(providers, pkg)),
  );
  return providers;
}

/** The read of a lock that must be read as a whole. */
function readPackages(providers: string): Extract<ProvidersLockRead, { read: true }>["packages"] {
  const result = readProvidersLock(providers);
  if (!result.read) throw new Error(`the lock was refused: ${result.refusal.sentence}`);
  return result.packages;
}

/** The code and rule each package of a lock read answers, by name: `verified` for a verified one. */
function outcomes(providers: string): Record<string, string> {
  return Object.fromEntries(
    readPackages(providers).map((pkg) => [
      pkg.name,
      pkg.verified
        ? "verified"
        : `${pkg.refusal.code} ${pkg.refusal.rule}${pkg.refusal.errno ? ` ${pkg.refusal.errno}` : ""}`,
    ]),
  );
}

/** The one package of a lock read. */
function onlyPackage(providers: string) {
  const packages = readPackages(providers);
  expect(packages.length).toBe(1);
  return packages[0] as (typeof packages)[number];
}

/** The refusal of the whole lock, as code, rule and pointer. */
function lockRefusal(providers: string): { rule: string; pointer?: string; key?: string; errno?: string } {
  const result = readProvidersLock(providers);
  if (result.read) throw new Error("the lock was read");
  expect(result.refusal.code).toBe("PROVIDER_LOCK_INVALID");
  const { rule, pointer, key, errno } = result.refusal;
  return {
    rule,
    ...(pointer === undefined ? {} : { pointer }),
    ...(key === undefined ? {} : { key }),
    ...(errno === undefined ? {} : { errno }),
  };
}

/** A lock entry of the right form whose directory need not exist. */
function entry(name: string, engines: readonly string[], digest = UNMATCHED_DIGEST): LockEntry {
  return { name, version: "1.0.0", engines, entry: "dist/index.mjs", digest, source: "local", imports: [] };
}

/** A lock whose text is the JSON of `value`. */
function lockOf(providers: string, value: unknown): string {
  return writeLockText(providers, JSON.stringify(value));
}

/** A valid lock entry as a plain value, for the shape cases to break. */
const VALID_ENTRY = { ...entry("acme-shape", ["acmeshape"]) };

describe("an entry's directory resolves inside the providers directory", () => {
  test("an entry whose directory resolves outside the providers directory, a symbolic link included, is refused as PROVIDER_PATH_OUTSIDE", () => {
    const providers = freshProviders();
    const outside = freshProviders();
    // The version directory is a link to an artifact outside.
    const viaVersion = fixture("acme-version");
    const outsideArtifact = writeArtifact(outside, viaVersion);
    fs.mkdirSync(path.join(providers, "acme-version"));
    fs.symlinkSync(outsideArtifact, artifactDirectoryOf(providers, viaVersion), "junction");
    // The name directory is a link to a directory outside.
    const viaName = fixture("acme-name");
    writeArtifact(outside, viaName);
    fs.symlinkSync(path.join(outside, "acme-name"), path.join(providers, "acme-name"), "junction");
    // The scope directory is a link to a directory outside.
    const viaScope = fixture("@acme/scoped", ["acmescoped"]);
    writeArtifact(outside, viaScope);
    fs.symlinkSync(path.join(outside, "@acme"), path.join(providers, "@acme"), "junction");
    writeLock(
      providers,
      [viaVersion, viaName, viaScope].map((pkg) => lockEntryOf(providers, pkg)),
    );

    expect(outcomes(providers)).toEqual({
      "@acme/scoped": "PROVIDER_PATH_OUTSIDE directory-outside",
      "acme-name": "PROVIDER_PATH_OUTSIDE directory-outside",
      "acme-version": "PROVIDER_PATH_OUTSIDE directory-outside",
    });
  });

  test("a directory that resolves inside the providers directory through a link is read as its real path", () => {
    const providers = freshProviders();
    const pkg = fixture("acme-linked");
    const stored = path.join(providers, "store", "acme-linked-1.0.0");
    writeArtifact(path.join(providers, "store-staging"), pkg);
    fs.mkdirSync(path.dirname(stored), { recursive: true });
    fs.renameSync(artifactDirectoryOf(path.join(providers, "store-staging"), pkg), stored);
    fs.mkdirSync(path.join(providers, "acme-linked"));
    fs.symlinkSync(stored, artifactDirectoryOf(providers, pkg), "junction");
    writeLock(providers, [lockEntryOf(providers, pkg)]);

    const read = onlyPackage(providers);
    expect(read.verified).toBe(true);
    if (!read.verified) return;
    expect(read.directory).toBe(fs.realpathSync.native(stored));
    expect(read.entryFile).toBe(path.join(fs.realpathSync.native(stored), "dist", "index.mjs"));
  });

  test("a providers directory named through another spelling of itself reads as its real path does", () => {
    const providers = lockedProviders(fixture("acme-spelled"), fixture("@acme/spelled-scoped", ["acmespelledscoped"]));
    const real = readProvidersLock(providers);
    expect(real.read).toBe(true);

    const alias = path.join(scratch, `alias-${randomUUID()}`);
    fs.symlinkSync(providers, alias, "junction");
    expect(readProvidersLock(alias)).toEqual(real);

    // The temporary directory as the system names it: the 8.3 form on windows-latest, /var for /private/var on macOS.
    const unresolved = path.join(tmpdir(), path.relative(fs.realpathSync.native(tmpdir()), providers));
    expect(readProvidersLock(unresolved)).toEqual(real);
  });
});

describe("an artifact is a plain tree", () => {
  test("an artifact that holds a symbolic link or junction is refused as PROVIDER_PATH_OUTSIDE, and the link is never followed", () => {
    const providers = freshProviders();
    const outside = freshProviders();
    const toInside = fixture("acme-link-inside");
    const toOutside = fixture("acme-link-outside");
    const dangling = fixture("acme-link-dangling");
    for (const pkg of [toInside, toOutside, dangling]) writeArtifact(providers, pkg);
    fs.symlinkSync(
      path.join(artifactDirectoryOf(providers, toInside), "dist"),
      path.join(artifactDirectoryOf(providers, toInside), "again"),
      "junction",
    );
    fs.symlinkSync(outside, path.join(artifactDirectoryOf(providers, toOutside), "dist", "elsewhere"), "junction");
    fs.symlinkSync(
      path.join(outside, "never-made"),
      path.join(artifactDirectoryOf(providers, dangling), "gone"),
      "junction",
    );
    writeLock(
      providers,
      [toInside, toOutside, dangling].map((pkg) => entry(pkg.name, pkg.engines)),
    );

    expect(outcomes(providers)).toEqual({
      "acme-link-dangling": "PROVIDER_PATH_OUTSIDE artifact-link",
      "acme-link-inside": "PROVIDER_PATH_OUTSIDE artifact-link",
      "acme-link-outside": "PROVIDER_PATH_OUTSIDE artifact-link",
    });
  });

  describeIf(MISSING_POSIX_SPECIAL_FILES, "special files, read in a bounded child", () => {
    test(
      "an artifact that holds a named pipe or a link to a device is refused at once, and neither is opened",
      async () => {
        const providers = freshProviders();
        const piped = fixture("acme-piped");
        const device = fixture("acme-device");
        writeArtifact(providers, piped);
        writeArtifact(providers, device);
        makeFifo(path.join(artifactDirectoryOf(providers, piped), "dist", "pipe"));
        fs.symlinkSync("/dev/zero", path.join(artifactDirectoryOf(providers, device), "zero"));
        writeLock(providers, [entry(piped.name, piped.engines), entry(device.name, device.engines)]);

        const outcome = await runInChild(
          [
            `const { readProvidersLock } = await import(${JSON.stringify(LOCK_READER_PATH)});`,
            `const result = readProvidersLock(${JSON.stringify(providers)});`,
            "report(result.packages.map((pkg) => [pkg.name, pkg.refusal.code, pkg.refusal.rule]));",
          ].join("\n"),
        );
        expect(outcome).toEqual({
          report: [
            ["acme-device", "PROVIDER_PATH_OUTSIDE", "artifact-link"],
            ["acme-piped", "PROVIDER_PATH_OUTSIDE", "artifact-special-file"],
          ],
          failure: null,
        });
      },
      CHILD_TEST_TIMEOUT_MS,
    );

    test(
      "a lock that is a named pipe is refused at once",
      async () => {
        const providers = freshProviders();
        makeFifo(path.join(providers, LOCK_FILE_NAME));
        const outcome = await runInChild(
          [
            `const { readProvidersLock } = await import(${JSON.stringify(LOCK_READER_PATH)});`,
            `const result = readProvidersLock(${JSON.stringify(providers)});`,
            "report([result.read, result.refusal.code, result.refusal.rule]);",
          ].join("\n"),
        );
        expect(outcome).toEqual({ report: [false, "PROVIDER_LOCK_INVALID", "lock-not-a-file"], failure: null });
      },
      CHILD_TEST_TIMEOUT_MS,
    );
  });

  test("an entry the lock names that is not a regular file of the artifact is refused as PROVIDER_PATH_OUTSIDE", () => {
    const providers = freshProviders();
    const missing = fixture("acme-entry-missing");
    const directory = fixture("acme-entry-directory");
    writeArtifact(providers, missing);
    writeArtifact(providers, directory);
    fs.rmSync(path.join(artifactDirectoryOf(providers, missing), "dist", "index.mjs"));
    fs.writeFileSync(path.join(artifactDirectoryOf(providers, missing), "dist", "other.mjs"), "export default {};\n");
    const entryAsDirectory = path.join(artifactDirectoryOf(providers, directory), "dist", "index.mjs");
    fs.rmSync(entryAsDirectory);
    fs.mkdirSync(entryAsDirectory);
    fs.writeFileSync(path.join(entryAsDirectory, "index.mjs"), "export default {};\n");
    writeLock(providers, [lockEntryOf(providers, missing), lockEntryOf(providers, directory)]);

    expect(outcomes(providers)).toEqual({
      "acme-entry-directory": "PROVIDER_PATH_OUTSIDE entry-not-a-file",
      "acme-entry-missing": "PROVIDER_PATH_OUTSIDE entry-not-a-file",
    });
  });
});

describe("the digest the lock pins", () => {
  test("an artifact whose files differ from the lock digest is refused as PROVIDER_DIGEST_MISMATCH", () => {
    const edits: [string, (directory: string) => void][] = [
      ["a byte in a nested file", (d) => fs.appendFileSync(path.join(d, "dist", "index.mjs"), " ")],
      ["a byte in package.json", (d) => fs.appendFileSync(path.join(d, "package.json"), " ")],
      ["a byte in the manifest", (d) => fs.appendFileSync(path.join(d, "libredb-provider.json"), " ")],
      ["a file added", (d) => fs.writeFileSync(path.join(d, "dist", "added.mjs"), "")],
      ["a file removed", (d) => fs.rmSync(path.join(d, "dist", "extra.mjs"))],
      ["a file renamed", (d) => fs.renameSync(path.join(d, "dist", "extra.mjs"), path.join(d, "dist", "renamed.mjs"))],
    ];
    for (const [label, edit] of edits) {
      const pkg = { ...fixture("acme-digest"), files: { "dist/extra.mjs": "export const extra = 1;\n" } };
      const providers = lockedProviders(pkg);
      expect([label, outcomes(providers)]).toEqual([label, { "acme-digest": "verified" }]);
      edit(artifactDirectoryOf(providers, pkg));
      expect([label, outcomes(providers)]).toEqual([
        label,
        { "acme-digest": "PROVIDER_DIGEST_MISMATCH digest-differs" },
      ]);
    }
  });

  test("the digest covers the import record, so a record edited without its files is refused as PROVIDER_DIGEST_MISMATCH", () => {
    const pkg: FixturePackage = {
      ...fixture("acme-record"),
      files: {
        "dist/index.mjs": 'import { extra } from "./extra.mjs";\nexport default { extra };\n',
        "dist/extra.mjs": 'import "node:fs";\nexport const extra = 1;\n',
      },
    };
    const providers = freshProviders();
    writeArtifact(providers, pkg);
    const locked = lockEntryOf(providers, pkg);
    expect(locked.imports).toEqual([
      { from: "dist/extra.mjs", specifier: "node:fs", kind: "import" },
      { from: "dist/index.mjs", specifier: "./extra.mjs", kind: "import" },
    ]);
    writeLock(providers, [locked]);
    expect(outcomes(providers)).toEqual({ "acme-record": "verified" });

    const edits: [string, LockEntry["imports"]][] = [
      ["the record emptied", []],
      ["a pair removed", locked.imports.slice(1)],
      ["a pair added", [...locked.imports, { from: "dist/index.mjs", specifier: "node:path", kind: "import" }]],
      [
        "a specifier changed",
        [
          locked.imports[0] as LockEntry["imports"][number],
          { from: "dist/index.mjs", specifier: "./other.mjs", kind: "import" },
        ],
      ],
      [
        "a kind changed",
        [
          locked.imports[0] as LockEntry["imports"][number],
          { from: "dist/index.mjs", specifier: "./extra.mjs", kind: "require" },
        ],
      ],
    ];
    for (const [label, imports] of edits) {
      writeLock(providers, [{ ...locked, imports }]);
      expect([label, outcomes(providers)]).toEqual([
        label,
        { "acme-record": "PROVIDER_DIGEST_MISMATCH digest-differs" },
      ]);
    }
    // The record's order is no difference: the serializer and the digest both sort it.
    writeLockText(providers, serializeProvidersLock([{ ...locked, imports: [...locked.imports].reverse() }]));
    expect(outcomes(providers)).toEqual({ "acme-record": "verified" });
  });

  test("a verified package carries its import record as the lock wrote it, frozen", () => {
    const pkg: FixturePackage = {
      ...fixture("acme-carried"),
      files: { "dist/index.mjs": 'import "./b.mjs";\nimport "node:fs";\nexport default {};\n', "dist/b.mjs": "" },
    };
    const providers = lockedProviders(pkg);
    const only = onlyPackage(providers);
    expect(only.verified).toBe(true);
    if (!only.verified) return;
    expect(only.imports).toEqual([
      { from: "dist/index.mjs", specifier: "./b.mjs", kind: "import" },
      { from: "dist/index.mjs", specifier: "node:fs", kind: "import" },
    ]);
    expect(Object.isFrozen(only.imports)).toBe(true);
    expect(only.imports.every((pair) => Object.isFrozen(pair))).toBe(true);
    expect(only.digest).toBe(artifactDigest(only.files, only.imports));
  });

  test("a byte changed in any file of an artifact is refused at the next read, and nothing is kept between reads", () => {
    const pkg = fixture("acme-next-read");
    const providers = lockedProviders(pkg);
    const file = path.join(artifactDirectoryOf(providers, pkg), "dist", "index.mjs");
    const original = fs.readFileSync(file);
    expect(outcomes(providers)).toEqual({ "acme-next-read": "verified" });

    const changed = Buffer.from(original);
    changed[0] = (changed[0] as number) ^ 0x01;
    fs.writeFileSync(file, changed);
    expect(outcomes(providers)).toEqual({ "acme-next-read": "PROVIDER_DIGEST_MISMATCH digest-differs" });

    fs.writeFileSync(file, original);
    expect(outcomes(providers)).toEqual({ "acme-next-read": "verified" });
  });

  test("a missing or unreadable artifact is refused as PROVIDER_DIGEST_MISMATCH, naming why", () => {
    const providers = freshProviders();
    const present = fixture("acme-present");
    writeArtifact(providers, present);
    const asFile = fixture("acme-as-file");
    fs.mkdirSync(path.join(providers, "acme-as-file"));
    fs.writeFileSync(artifactDirectoryOf(providers, asFile), "not a directory");
    writeLock(providers, [
      lockEntryOf(providers, present),
      entry("acme-absent", ["acmeabsent"]),
      entry(asFile.name, asFile.engines),
    ]);
    const expected: Record<string, string> = {
      "acme-absent": "PROVIDER_DIGEST_MISMATCH artifact-missing",
      "acme-as-file": "PROVIDER_DIGEST_MISMATCH artifact-unreadable ENOTDIR",
      "acme-present": "verified",
    };
    expect(outcomes(providers)).toEqual(expected);

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const directory = artifactDirectoryOf(providers, present);
      fs.chmodSync(directory, 0o000);
      try {
        expect(outcomes(providers)).toEqual({
          ...expected,
          "acme-present": "PROVIDER_DIGEST_MISMATCH artifact-unreadable EACCES",
        });
      } finally {
        fs.chmodSync(directory, 0o755);
      }
    }
  });
});

describe("a package's identity", () => {
  test("a package.json whose name, version or engine ids differ from its entry is refused naming the field", () => {
    const providers = freshProviders();
    const packages: [FixturePackage, (directory: string) => void][] = [
      [
        fixture("acme-id-name"),
        (d) => fs.writeFileSync(path.join(d, "package.json"), '{"name":"acme-other","version":"1.0.0"}'),
      ],
      [
        fixture("acme-id-version"),
        (d) => fs.writeFileSync(path.join(d, "package.json"), '{"name":"acme-id-version","version":"1.0.1"}'),
      ],
      [fixture("acme-id-unreadable"), (d) => fs.writeFileSync(path.join(d, "package.json"), "[]")],
      [
        fixture("acme-id-engines"),
        (d) =>
          fs.writeFileSync(
            path.join(d, "libredb-provider.json"),
            '{"engines":[{"id":"acmeidengines"},{"id":"acmemore"}],"runtime":{"entry":"dist/index.mjs"}}',
          ),
      ],
      [
        fixture("acme-id-entry"),
        (d) => {
          fs.writeFileSync(path.join(d, "dist", "other.mjs"), "export default {};\n");
          fs.writeFileSync(
            path.join(d, "libredb-provider.json"),
            '{"engines":[{"id":"acmeidentry"}],"runtime":{"entry":"dist/other.mjs"}}',
          );
        },
      ],
      [fixture("acme-id-manifest"), (d) => fs.rmSync(path.join(d, "libredb-provider.json"))],
    ];
    for (const [pkg, edit] of packages) edit(writeArtifact(providers, pkg));
    // Engine order alone is no difference.
    const reordered = fixture("acme-id-order", ["acmeorderb", "acmeordera"]);
    writeArtifact(providers, { ...reordered, engines: ["acmeordera", "acmeorderb"] });
    writeLock(providers, [...packages.map(([pkg]) => lockEntryOf(providers, pkg)), lockEntryOf(providers, reordered)]);

    expect(outcomes(providers)).toEqual({
      "acme-id-engines": "PROVIDER_IDENTITY_MISMATCH engines",
      "acme-id-entry": "PROVIDER_IDENTITY_MISMATCH entry",
      "acme-id-manifest": "PROVIDER_IDENTITY_MISMATCH manifest-unreadable",
      "acme-id-name": "PROVIDER_IDENTITY_MISMATCH name",
      "acme-id-order": "verified",
      "acme-id-unreadable": "PROVIDER_IDENTITY_MISMATCH package-json-unreadable",
      "acme-id-version": "PROVIDER_IDENTITY_MISMATCH version",
    });
  });
});

describe("an engine id has one server", () => {
  test("an entry serving an engine id the bundled catalog serves is refused as PROVIDER_ID_COLLISION", () => {
    const providers = freshProviders();
    const bundled = SHIPPED_DATABASE_TYPES.map((id, index) => entry(`acme-bundled-${index}`, [id]));
    const mixed = entry("acme-mixed", ["acmemixeda", SHIPPED_DATABASE_TYPES[0] as string, "acmemixedb"]);
    writeLock(providers, [...bundled, mixed]);

    const read = readPackages(providers);
    expect(read.length).toBe(SHIPPED_DATABASE_TYPES.length + 1);
    for (const pkg of read) {
      expect([pkg.name, pkg.verified ? "verified" : `${pkg.refusal.code} ${pkg.refusal.rule}`]).toEqual([
        pkg.name,
        "PROVIDER_ID_COLLISION bundled-engine",
      ]);
    }
    expect(SHIPPED_DATABASE_TYPES.length).toBeGreaterThan(0);
    for (const id of ["acmemixeda", "acmemixedb"]) expect(isDatabaseType(id)).toBe(false);
  });

  test("two entries serving one engine id are both refused as PROVIDER_ID_COLLISION, each naming the other, before any of their files is read", () => {
    const providers = freshProviders();
    const alone = fixture("acme-alone");
    writeArtifact(providers, alone);
    writeLock(providers, [
      entry("acme-first", ["acmeshared", "acmefirst"]),
      entry("acme-second", ["acmesecond", "acmeshared"]),
      entry("acme-third", ["acmethird", "acmefirst"]),
      lockEntryOf(providers, alone),
    ]);

    const read = readPackages(providers);
    const refusals = Object.fromEntries(
      read.map((pkg) => [pkg.name, pkg.verified ? "verified" : [pkg.refusal.rule, pkg.refusal.others]]),
    );
    expect(refusals).toEqual({
      "acme-alone": "verified",
      "acme-first": [
        "shared-engine",
        [
          { name: "acme-second", version: "1.0.0" },
          { name: "acme-third", version: "1.0.0" },
        ],
      ],
      "acme-second": ["shared-engine", [{ name: "acme-first", version: "1.0.0" }]],
      "acme-third": ["shared-engine", [{ name: "acme-first", version: "1.0.0" }]],
    });
    const second = read.find((pkg) => pkg.name === "acme-second");
    expect(second?.verified === false && second.refusal.sentence).toBe(
      "PROVIDER_ID_COLLISION: acme-second 1.0.0: it serves an engine id another entry of the lock serves too: acme-first 1.0.0",
    );
  });
});

describe("the lock's format", () => {
  test("a lock over its caps is refused before any entry is read", () => {
    expect([LOCK_BYTE_CAP, LOCK_ENTRY_CAP, LOCK_ENGINE_CAP]).toEqual([1024 * 1024, 256, 64]);
    const providers = freshProviders();

    writeLockText(providers, serializeProvidersLock([]).padEnd(LOCK_BYTE_CAP, " "));
    expect(readProvidersLock(providers).read).toBe(true);
    writeLockText(providers, serializeProvidersLock([]).padEnd(LOCK_BYTE_CAP + 1, " "));
    expect(lockRefusal(providers)).toEqual({ rule: "lock-over-cap" });

    const entries = Array.from({ length: LOCK_ENTRY_CAP + 1 }, (_, index) =>
      entry(`acme-many-${index}`, [`acmemany${index}`]),
    );
    lockOf(providers, { lockVersion: 1, entries });
    expect(lockRefusal(providers)).toEqual({ rule: "too-many", pointer: "/entries" });
    lockOf(providers, { lockVersion: 1, entries: entries.slice(0, LOCK_ENTRY_CAP) });
    expect(readProvidersLock(providers).read).toBe(true);

    const engines = Array.from({ length: LOCK_ENGINE_CAP + 1 }, (_, index) => `acmeengine${index}`);
    lockOf(providers, { lockVersion: 1, entries: [entry("acme-engines", engines)] });
    expect(lockRefusal(providers)).toEqual({ rule: "too-many", pointer: "/entries/0/engines" });

    // Each string one over its length, then at its length.
    const lengths: [string, keyof LockEntry, unknown, unknown][] = [
      ["/entries/0/name", "name", "a".repeat(215), "a".repeat(214)],
      ["/entries/0/version", "version", `1.0.0-${"a".repeat(59)}`, `1.0.0-${"a".repeat(58)}`],
      ["/entries/0/engines/0", "engines", [`a${"b".repeat(32)}`], [`a${"b".repeat(31)}`]],
      ["/entries/0/entry", "entry", `${"a".repeat(253)}.mjs`, `${"a".repeat(252)}.mjs`],
      ["/entries/0/digest", "digest", `${UNMATCHED_DIGEST}0`, UNMATCHED_DIGEST],
    ];
    expect(
      [PACKAGE_NAME_FORM, PACKAGE_VERSION_FORM, ENGINE_ID_FORM, ENTRY_FORM, DIGEST_FORM].map((form) => form.maxLength),
    ).toEqual([214, 64, 32, 256, 71]);
    for (const [pointer, field, over, fitting] of lengths) {
      lockOf(providers, { lockVersion: 1, entries: [{ ...VALID_ENTRY, [field]: over }] });
      expect([pointer, lockRefusal(providers)]).toEqual([pointer, { rule: "out-of-range", pointer }]);
      lockOf(providers, { lockVersion: 1, entries: [{ ...VALID_ENTRY, [field]: fitting }] });
      expect([pointer, readProvidersLock(providers).read]).toEqual([pointer, true]);
    }
  });

  test("a lock that is not the closed schema is refused as PROVIDER_LOCK_INVALID with its rule and pointer, and no value is walked", () => {
    const providers = freshProviders();
    const deep = "[".repeat(200_000) + "]".repeat(200_000);
    const valid = JSON.stringify(VALID_ENTRY);
    const cases: [string, string | Uint8Array, Record<string, string>][] = [
      ["a byte order mark", `﻿${JSON.stringify({ lockVersion: 1, entries: [] })}`, { rule: "lock-not-json" }],
      ["invalid UTF-8", Buffer.from([0x7b, 0xc3, 0x28, 0x7d]), { rule: "lock-not-json" }],
      ["not JSON", "{lockVersion: 1}", { rule: "lock-not-json" }],
      ["an array", "[]", { rule: "wrong-type", pointer: "" }],
      [
        "an unknown key with a deep value",
        `{"lockVersion":1,"entries":[],"extra":${deep}}`,
        { rule: "unknown-key", pointer: "", key: "extra" },
      ],
      ["lockVersion missing", '{"entries":[]}', { rule: "missing-key", pointer: "", key: "lockVersion" }],
      ["entries missing", '{"lockVersion":1}', { rule: "missing-key", pointer: "", key: "entries" }],
      ["lockVersion a string", '{"lockVersion":"1","entries":[]}', { rule: "wrong-type", pointer: "/lockVersion" }],
      ["lockVersion 2", '{"lockVersion":2,"entries":[]}', { rule: "value-not-allowed", pointer: "/lockVersion" }],
      ["entries an object", '{"lockVersion":1,"entries":{}}', { rule: "wrong-type", pointer: "/entries" }],
      ["an entry an array", '{"lockVersion":1,"entries":[[]]}', { rule: "wrong-type", pointer: "/entries/0" }],
      [
        "an entry's unknown key",
        `{"lockVersion":1,"entries":[${valid.slice(0, -1)},"license":"MIT"}]}`,
        { rule: "unknown-key", pointer: "/entries/0", key: "license" },
      ],
      [
        "an entry's missing key",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, digest: undefined }] }),
        { rule: "missing-key", pointer: "/entries/0", key: "digest" },
      ],
      [
        "a name not a string",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, name: 7 }] }),
        { rule: "wrong-type", pointer: "/entries/0/name" },
      ],
      [
        "a name outside its form",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, name: "Acme" }] }),
        { rule: "pattern-mismatch", pointer: "/entries/0/name" },
      ],
      [
        "a version that is a range",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, version: "^1.0.0" }] }),
        { rule: "pattern-mismatch", pointer: "/entries/0/version" },
      ],
      [
        "engines not a list",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, engines: "acmeshape" }] }),
        { rule: "wrong-type", pointer: "/entries/0/engines" },
      ],
      [
        "engines empty",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, engines: [] }] }),
        { rule: "too-few", pointer: "/entries/0/engines" },
      ],
      [
        "a deep value in place of an engine id",
        `{"lockVersion":1,"entries":[${valid.replace('["acmeshape"]', `["acmeshape",${deep}]`)}]}`,
        { rule: "wrong-type", pointer: "/entries/0/engines/1" },
      ],
      [
        "an engine id outside its form",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, engines: ["acme-shape"] }] }),
        { rule: "pattern-mismatch", pointer: "/entries/0/engines/0" },
      ],
      [
        "one engine twice in an entry",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, engines: ["acmeshape", "acmeshape"] }] }),
        { rule: "duplicate", pointer: "/entries/0/engines/1" },
      ],
      [
        "an entry with a dot segment",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, entry: "../index.mjs" }] }),
        { rule: "pattern-mismatch", pointer: "/entries/0/entry" },
      ],
      [
        "a digest of another form",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, digest: `sha512:${"0".repeat(64)}` }] }),
        { rule: "pattern-mismatch", pointer: "/entries/0/digest" },
      ],
      [
        "a source other than local",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, source: "registry" }] }),
        { rule: "value-not-allowed", pointer: "/entries/0/source" },
      ],
      [
        "a source not a string",
        JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, source: null }] }),
        { rule: "wrong-type", pointer: "/entries/0/source" },
      ],
      [
        "one name twice",
        JSON.stringify({
          lockVersion: 1,
          entries: [VALID_ENTRY, { ...VALID_ENTRY, version: "2.0.0", engines: ["acmeother"] }],
        }),
        { rule: "duplicate", pointer: "/entries/1/name" },
      ],
    ];
    for (const [label, text, expected] of cases) {
      writeLockText(providers, text);
      expect<unknown>([label, lockRefusal(providers)]).toEqual([label, expected]);
    }
    const result = readProvidersLock(providers);
    expect(result.read === false && result.refusal.sentence).toBe(
      `PROVIDER_LOCK_INVALID: ${path.join(providers, LOCK_FILE_NAME)}: duplicate at /entries/1/name: the value appears twice`,
    );
  });

  test("a lock entry's import record is closed and capped, each import in its forms and listed once", () => {
    expect([LOCK_IMPORT_CAP, IMPORT_FROM_FORM.maxLength, IMPORT_SPECIFIER_FORM.maxLength]).toEqual([4096, 1024, 1024]);
    const providers = freshProviders();
    const withImports = (imports: unknown): string =>
      JSON.stringify({ lockVersion: 1, entries: [{ ...VALID_ENTRY, imports }] });
    const pair = { from: "dist/index.mjs", specifier: "./a.mjs", kind: "import" };
    const withoutImports = Object.fromEntries(Object.entries(VALID_ENTRY).filter(([key]) => key !== "imports"));

    // The count is checked before any item is read: 4,097 items that are not pairs are refused as too-many.
    lockOf(providers, { lockVersion: 1, entries: [{ ...VALID_ENTRY, imports: Array(LOCK_IMPORT_CAP + 1).fill(0) }] });
    expect(lockRefusal(providers)).toEqual({ rule: "too-many", pointer: "/entries/0/imports" });
    const atCap = Array.from({ length: LOCK_IMPORT_CAP }, (_, index) => ({
      from: "a.mjs",
      specifier: `./${index}`,
      kind: "import",
    }));
    lockOf(providers, { lockVersion: 1, entries: [{ ...VALID_ENTRY, imports: atCap }] });
    expect(readProvidersLock(providers).read).toBe(true);

    const cases: [string, string, Record<string, string>][] = [
      [
        "a lock entry without its record, as #2528's command wrote it",
        JSON.stringify({ lockVersion: 1, entries: [withoutImports] }),
        { rule: "missing-key", pointer: "/entries/0", key: "imports" },
      ],
      ["a record that is not a list", withImports({}), { rule: "wrong-type", pointer: "/entries/0/imports" }],
      ["an item that is not a pair", withImports(["./a.mjs"]), { rule: "wrong-type", pointer: "/entries/0/imports/0" }],
      [
        "an item's unknown key",
        withImports([{ ...pair, type: "static" }]),
        { rule: "unknown-key", pointer: "/entries/0/imports/0", key: "type" },
      ],
      [
        "an item's missing key",
        withImports([{ from: pair.from }]),
        { rule: "missing-key", pointer: "/entries/0/imports/0", key: "specifier" },
      ],
      [
        "a module path not a string",
        withImports([{ ...pair, from: 7 }]),
        { rule: "wrong-type", pointer: "/entries/0/imports/0/from" },
      ],
      [
        "a module path over its length",
        withImports([{ ...pair, from: `${"a/".repeat(511)}abc` }]),
        { rule: "out-of-range", pointer: "/entries/0/imports/0/from" },
      ],
      [
        "a module path with a parent segment",
        withImports([{ ...pair, from: "dist/../index.mjs" }]),
        { rule: "pattern-mismatch", pointer: "/entries/0/imports/0/from" },
      ],
      [
        "a module path with a dot segment",
        withImports([{ ...pair, from: "./index.mjs" }]),
        { rule: "pattern-mismatch", pointer: "/entries/0/imports/0/from" },
      ],
      [
        "an absolute module path",
        withImports([{ ...pair, from: "/index.mjs" }]),
        { rule: "pattern-mismatch", pointer: "/entries/0/imports/0/from" },
      ],
      [
        "a module path with a backslash",
        withImports([{ ...pair, from: "dist\\index.mjs" }]),
        { rule: "pattern-mismatch", pointer: "/entries/0/imports/0/from" },
      ],
      [
        "a specifier not a string",
        withImports([{ ...pair, specifier: null }]),
        { rule: "wrong-type", pointer: "/entries/0/imports/0/specifier" },
      ],
      [
        "an empty specifier",
        withImports([{ ...pair, specifier: "" }]),
        { rule: "pattern-mismatch", pointer: "/entries/0/imports/0/specifier" },
      ],
      [
        "a specifier with a space",
        withImports([{ ...pair, specifier: "./a b.mjs" }]),
        { rule: "pattern-mismatch", pointer: "/entries/0/imports/0/specifier" },
      ],
      [
        "a specifier outside printable ASCII",
        withImports([{ ...pair, specifier: "./é.mjs" }]),
        { rule: "pattern-mismatch", pointer: "/entries/0/imports/0/specifier" },
      ],
      [
        "a kind missing, as the record before kinds wrote it",
        withImports([{ from: pair.from, specifier: pair.specifier }]),
        { rule: "missing-key", pointer: "/entries/0/imports/0", key: "kind" },
      ],
      [
        "a kind not a string",
        withImports([{ ...pair, kind: 1 }]),
        { rule: "wrong-type", pointer: "/entries/0/imports/0/kind" },
      ],
      [
        "a kind the scanner reports but the lock does not record",
        withImports([{ ...pair, kind: "import-statement" }]),
        { rule: "value-not-allowed", pointer: "/entries/0/imports/0/kind" },
      ],
      [
        "a specifier over its length",
        withImports([{ ...pair, specifier: `./${"a".repeat(1023)}` }]),
        { rule: "out-of-range", pointer: "/entries/0/imports/0/specifier" },
      ],
      [
        "one pair twice",
        withImports([pair, { from: "dist/index.mjs", specifier: "node:fs", kind: "import" }, pair]),
        { rule: "duplicate", pointer: "/entries/0/imports/2" },
      ],
    ];
    for (const [label, text, expected] of cases) {
      writeLockText(providers, text);
      expect<unknown>([label, lockRefusal(providers)]).toEqual([label, expected]);
    }
    for (const fitting of [
      [{ from: `${"a/".repeat(511)}a`, specifier: `./${"a".repeat(1022)}`, kind: "import" }],
      [
        pair,
        { from: pair.from, specifier: "node:fs", kind: "import" },
        { from: "dist/a.mjs", specifier: "./a.mjs", kind: "import" },
      ],
      [{ from: "dist/.hidden.mjs", specifier: "#internal", kind: "require" }],
      // One module importing one specifier in both kinds holds two imports.
      [pair, { ...pair, kind: "require" }],
    ]) {
      writeLockText(providers, withImports(fitting));
      expect([fitting, readProvidersLock(providers).read]).toEqual([fitting, true]);
    }
  });

  test("a missing providers directory or lock, or one of the wrong kind, is refused as PROVIDER_LOCK_INVALID", () => {
    const parent = freshProviders();
    expect(lockRefusal(path.join(parent, "absent"))).toEqual({ rule: "directory-missing" });
    const missing = readProvidersLock(path.join(parent, "absent"));
    expect(missing.read === false && missing.refusal.sentence).toBe(
      `PROVIDER_LOCK_INVALID: ${path.join(parent, "absent", LOCK_FILE_NAME)}: the providers directory does not exist`,
    );

    const asFile = path.join(parent, "a-file");
    fs.writeFileSync(asFile, "");
    expect(lockRefusal(asFile)).toEqual({ rule: "directory-not-a-directory" });

    const empty = freshProviders();
    expect(lockRefusal(empty)).toEqual({ rule: "lock-missing" });
    fs.mkdirSync(path.join(empty, LOCK_FILE_NAME));
    expect(lockRefusal(empty)).toEqual({ rule: "lock-not-a-file" });

    if (process.platform !== "win32") {
      const loop = path.join(parent, "loop");
      fs.symlinkSync(loop, loop);
      expect(lockRefusal(loop)).toEqual({ rule: "directory-unreadable", errno: "ELOOP" });
    }
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      // The lock, not its directory, loses its permissions: macOS's realpath opens the path it resolves, so a
      // directory with none is refused one step earlier there, as directory-unreadable.
      const locked = freshProviders();
      writeLock(locked, []);
      const lock = path.join(locked, LOCK_FILE_NAME);
      fs.chmodSync(lock, 0o000);
      try {
        expect(lockRefusal(locked)).toEqual({ rule: "lock-unreadable", errno: "EACCES" });
      } finally {
        fs.chmodSync(lock, 0o644);
      }
    }
  });
});

describe("order and emptiness", () => {
  test("the entries' order changes no result", () => {
    const providers = freshProviders();
    const verified = fixture("acme-order-ok");
    const digest = fixture("acme-order-digest");
    const identity = fixture("acme-order-identity");
    for (const pkg of [verified, digest, identity]) writeArtifact(providers, pkg);
    const entries = [
      lockEntryOf(providers, verified),
      { ...lockEntryOf(providers, digest), digest: UNMATCHED_DIGEST },
      { ...lockEntryOf(providers, identity), version: "1.0.0", engines: ["acmeorderidentity", "acmeorderextra"] },
      entry("acme-order-shared-a", ["acmeordershared"]),
      entry("acme-order-shared-b", ["acmeordershared"]),
    ];
    const permutations = (items: LockEntry[]): LockEntry[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, index) =>
            permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item].concat(rest)),
          );
    const orders = permutations(entries);
    expect(orders.length).toBe(120);

    const lockFile = path.join(providers, LOCK_FILE_NAME);
    let first: ProvidersLockRead | undefined;
    for (const order of orders) {
      writeLockText(providers, JSON.stringify({ lockVersion: 1, entries: order }));
      const result = readProvidersLock(providers);
      first ??= result;
      expect(result).toEqual(first);
    }
    expect(first).toBeDefined();
    expect(outcomes(providers)).toEqual({
      "acme-order-digest": "PROVIDER_DIGEST_MISMATCH digest-differs",
      "acme-order-identity": "PROVIDER_IDENTITY_MISMATCH engines",
      "acme-order-ok": "verified",
      "acme-order-shared-a": "PROVIDER_ID_COLLISION shared-engine",
      "acme-order-shared-b": "PROVIDER_ID_COLLISION shared-engine",
    });
    expect(first?.read && first.lockFile).toBe(lockFile);
  });

  test("a lock with no entries names no package", () => {
    const providers = freshProviders();
    writeLock(providers, []);
    expect(readProvidersLock(providers)).toEqual({
      read: true,
      lockFile: path.join(providers, LOCK_FILE_NAME),
      packages: [],
    });
  });
});

describe("no package code runs", () => {
  test("reading and writing a lock run no code of a package", () => {
    const providers = freshProviders();
    const marker = path.join(scratch, `ran-${randomUUID()}`);
    const sentinel: FixturePackage = {
      ...fixture("acme-sentinel"),
      files: {
        "dist/index.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport default {};\n`,
      },
    };
    writeArtifact(providers, sentinel);

    const written = Bun.spawnSync([process.execPath, "run", "--silent", "providers:lock", "--", "--dir", providers], {
      cwd: REPOSITORY_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    expect([written.exitCode, written.stderr.toString()]).toEqual([0, ""]);
    expect(outcomes(providers)).toEqual({ "acme-sentinel": "verified" });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("what a refusal carries", () => {
  test("no refusal carries a value read from the package beyond its name and version", () => {
    const providers = freshProviders();
    const markers = Array.from({ length: 6 }, () => randomUUID());
    const hex = (marker: string): string => marker.replaceAll("-", "");
    const edits: [FixturePackage, (directory: string) => void][] = [
      [
        fixture("acme-mark-name"),
        (d) => fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: markers[0], version: "1.0.0" })),
      ],
      [
        fixture("acme-mark-version"),
        (d) =>
          fs.writeFileSync(
            path.join(d, "package.json"),
            JSON.stringify({ name: "acme-mark-version", version: markers[1] }),
          ),
      ],
      [
        fixture("acme-mark-engine"),
        (d) =>
          fs.writeFileSync(
            path.join(d, "libredb-provider.json"),
            JSON.stringify({
              engines: [{ id: `m${hex(markers[2] as string).slice(0, 31)}` }],
              runtime: { entry: "dist/index.mjs" },
            }),
          ),
      ],
      [
        fixture("acme-mark-entry"),
        (d) => {
          fs.writeFileSync(path.join(d, `${markers[3]}.mjs`), "");
          fs.writeFileSync(
            path.join(d, "libredb-provider.json"),
            JSON.stringify({ engines: [{ id: "acmemarkentry" }], runtime: { entry: `${markers[3]}.mjs` } }),
          );
        },
      ],
    ];
    for (const [pkg, edit] of edits) edit(writeArtifact(providers, pkg));
    const named = fixture("acme-mark-file");
    writeArtifact(providers, named);
    const linked = fixture("acme-mark-link");
    writeArtifact(providers, linked);
    writeLock(providers, [
      ...edits.map(([pkg]) => lockEntryOf(providers, pkg)),
      lockEntryOf(providers, named),
      lockEntryOf(providers, linked),
    ]);
    fs.writeFileSync(path.join(artifactDirectoryOf(providers, named), `${markers[4]}.txt`), "x");
    fs.symlinkSync(providers, path.join(artifactDirectoryOf(providers, linked), markers[5] as string), "junction");

    const result = readProvidersLock(providers);
    expect(outcomes(providers)).toEqual({
      "acme-mark-engine": "PROVIDER_IDENTITY_MISMATCH engines",
      "acme-mark-entry": "PROVIDER_IDENTITY_MISMATCH entry",
      "acme-mark-file": "PROVIDER_DIGEST_MISMATCH digest-differs",
      "acme-mark-link": "PROVIDER_PATH_OUTSIDE artifact-link",
      "acme-mark-name": "PROVIDER_IDENTITY_MISMATCH name",
      "acme-mark-version": "PROVIDER_IDENTITY_MISMATCH version",
    });
    const text = JSON.stringify(result);
    for (const marker of markers) {
      expect([marker, text.includes(marker), text.includes(hex(marker).slice(0, 31))]).toEqual([marker, false, false]);
    }
    for (const pkg of readPackages(providers)) {
      if (pkg.verified) continue;
      expect(pkg.refusal.sentence.startsWith(`${pkg.refusal.code}: ${pkg.name} ${pkg.version}: `)).toBe(true);
      expect(pkg.refusal.sentence.includes("\n")).toBe(false);
    }
  });

  test("the refusal codes are one closed list, and every refusal names a code and a rule of its lists", () => {
    expect(PROVIDER_REFUSAL_CODES).toEqual([
      "PROVIDER_LOCK_INVALID",
      "PROVIDER_PATH_OUTSIDE",
      "PROVIDER_DIGEST_MISMATCH",
      "PROVIDER_IDENTITY_MISMATCH",
      "PROVIDER_ID_COLLISION",
      "PROVIDER_CONTRACT_UNSUPPORTED",
      "PROVIDER_SCHEMA_INVALID",
      "PROVIDER_MODULE_FORMAT",
      "PROVIDER_LOAD_FAILED",
      "PROVIDER_NATIVE_UNSUPPORTED",
      "PROVIDER_RECORD_INVALID",
      "PROVIDER_CATALOG_CONFLICT",
    ]);
    expect(Object.isFrozen(PROVIDER_REFUSAL_CODES)).toBe(true);
    expect(Object.isFrozen(PROVIDER_REFUSAL_RULES)).toBe(true);
    expect(Object.keys(PROVIDER_REFUSAL_RULES).sort()).toEqual([...PROVIDER_REFUSAL_CODES].sort());
    for (const rules of Object.values(PROVIDER_REFUSAL_RULES)) expect(Object.isFrozen(rules)).toBe(true);

    const providers = freshProviders();
    const ok = fixture("acme-closed-ok");
    writeArtifact(providers, ok);
    writeLock(providers, [
      lockEntryOf(providers, ok),
      entry("acme-closed-missing", ["acmeclosedmissing"]),
      entry("acme-closed-bundled", [SHIPPED_DATABASE_TYPES[0] as string]),
      entry("acme-closed-shared-a", ["acmeclosedshared"]),
      entry("acme-closed-shared-b", ["acmeclosedshared"]),
    ]);
    const refusals: PackageRefusal[] = readPackages(providers).flatMap((pkg) => (pkg.verified ? [] : [pkg.refusal]));
    expect(refusals.length).toBe(4);
    for (const refusal of refusals) {
      expect(PROVIDER_REFUSAL_CODES).toContain(refusal.code);
      expect(PROVIDER_REFUSAL_RULES[refusal.code] as readonly string[]).toContain(refusal.rule);
      expect(Object.isFrozen(refusal)).toBe(true);
    }
    const whole = readProvidersLock(path.join(providers, "absent"));
    expect(whole.read).toBe(false);
    if (!whole.read) {
      expect(PROVIDER_REFUSAL_RULES.PROVIDER_LOCK_INVALID as readonly string[]).toContain(whole.refusal.rule);
      expect(Object.isFrozen(whole.refusal)).toBe(true);
    }
  });

  test("a refused package carries its lock entry's engine ids", () => {
    const providers = freshProviders();
    writeLock(providers, [
      entry("acme-engines-missing", ["acmeenginesb", "acmeenginesa"]),
      entry("acme-engines-bundled", [SHIPPED_DATABASE_TYPES[0] as string, "acmeenginesc"]),
      entry("acme-engines-shared-a", ["acmeenginesshared"]),
      entry("acme-engines-shared-b", ["acmeenginesshared"]),
    ]);
    const engines = Object.fromEntries(
      readPackages(providers).map((pkg) => [pkg.name, pkg.verified ? "verified" : pkg.engines]),
    );
    expect(engines).toEqual({
      "acme-engines-bundled": [SHIPPED_DATABASE_TYPES[0], "acmeenginesc"].sort(),
      "acme-engines-missing": ["acmeenginesa", "acmeenginesb"],
      "acme-engines-shared-a": ["acmeenginesshared"],
      "acme-engines-shared-b": ["acmeenginesshared"],
    });
    for (const pkg of readPackages(providers)) {
      if (!pkg.verified) expect(Object.isFrozen(pkg.engines)).toBe(true);
    }
  });

  test("a verified package answers its real directory, its entry file and its listing, frozen", () => {
    const pkg: FixturePackage = {
      name: "@acme/answered",
      version: "2.1.0",
      engines: ["acmeanswereda", "acmeansweredb"],
    };
    const providers = freshProviders();
    writeArtifact(providers, { ...pkg, engines: ["acmeansweredb", "acmeanswereda"] });
    writeLock(providers, [lockEntryOf(providers, pkg)]);
    const directory = artifactDirectoryOf(providers, pkg);
    const walked = walkArtifact(directory);
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;

    const result = readProvidersLock(providers);
    expect(result).toEqual({
      read: true,
      lockFile: path.join(providers, LOCK_FILE_NAME),
      packages: [
        {
          verified: true,
          name: "@acme/answered",
          version: "2.1.0",
          engines: ["acmeanswereda", "acmeansweredb"],
          source: "local",
          digest: artifactDigest(walked.files, []),
          directory,
          entryFile: path.join(directory, "dist", "index.mjs"),
          files: walked.files,
          imports: [],
        },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.read) return;
    const [only] = result.packages;
    expect(Object.isFrozen(result.packages)).toBe(true);
    expect(Object.isFrozen(only)).toBe(true);
    expect(only?.verified && Object.isFrozen(only.engines)).toBe(true);
    expect(only?.verified && Object.isFrozen(only.files)).toBe(true);
  });
});

const scriptTranspiler = new Bun.Transpiler({ loader: "ts" });

/**
 * The modules of this repository `file` imports by value. A script under scripts/ starts with a `#!` line, which Bun's
 * transpiler refuses, so its relative specifiers are read with the line removed; every other file is read by
 * `valueImportsOf`.
 */
function importsOf(file: string): string[] {
  if (!file.startsWith("scripts/")) return valueImportsOf(file);
  const text = fs.readFileSync(path.join(REPOSITORY_ROOT, file), "utf8").replace(/^#!.*\n/, "");
  return scriptTranspiler
    .scanImports(text)
    .map(({ path: specifier }) => specifier)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => path.posix.join(path.posix.dirname(file), `${specifier}.ts`));
}

describe("the lock's boundaries", () => {
  test("no module outside src/lib/provider-host imports the lock reader but the packed lock check", () => {
    const sources = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "bin", "scripts", "vscode-extension/src"],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(
        (file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts") && fs.existsSync(path.join(REPOSITORY_ROOT, file)),
      );
    const importersOf = (module: string): string[] => sources.filter((file) => importsOf(file).includes(module)).sort();

    expect(importersOf(LOCK_READER).filter((file) => !file.startsWith("src/lib/provider-host/"))).toEqual([
      ...LOCK_READER_CHECKS,
    ]);
    // A control on the scan: the command imports the artifact module.
    expect(importersOf(ARTIFACT_MODULE)).toContain("scripts/providers-lock.ts");
  });

  test("the lock's name, version, engine id and entry forms are the provider contract's", () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
    const native = schema.$defs.nativePackage.properties;
    const runtime = schema.$defs.runtime.properties;
    const asRegExp = (pattern: string): string => new RegExp(pattern).source;
    expect(PACKAGE_NAME_FORM.pattern.source).toBe(asRegExp(native.package.pattern));
    expect(PACKAGE_NAME_FORM.maxLength).toBe(native.package.maxLength);
    expect(PACKAGE_VERSION_FORM.pattern.source).toBe(asRegExp(native.version.pattern));
    expect(PACKAGE_VERSION_FORM.maxLength).toBe(native.version.maxLength);
    expect(ENGINE_ID_FORM.pattern.source).toBe(asRegExp(schema.$defs.engineId.pattern));
    expect(ENGINE_ID_FORM.maxLength).toBe(32);
    expect(ENTRY_FORM.pattern.source).toBe(asRegExp(runtime.entry.pattern));
    expect(ENTRY_FORM.maxLength).toBe(runtime.entry.maxLength);
    expect(DIGEST_FORM.pattern.source).toBe("^sha256:[0-9a-f]{64}$");
  });
});
