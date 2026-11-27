/**
 * The lock reader: the one module that decides which packages of the providers directory pass their lock
 * (docs/providers/CONTRACT.md, clauses C-43 and C-91 to C-96). Only modules under `src/lib/provider-host/` import it
 * (`tests/unit/lib/provider-host/providers-lock.test.ts` holds that); the lock command (`scripts/providers-lock.ts`)
 * writes a lock with the same artifact functions and never reads one through this module.
 *
 * `readProvidersLock(directory)` reads the providers directory's real path and its lock, `providers.lock.json`, under
 * the lock's closed, capped format (`./providers-lock-format`), and refuses the whole lock as `PROVIDER_LOCK_INVALID`
 * when the directory or the lock is missing, of the wrong kind or unreadable, when the lock is over its byte cap, not
 * UTF-8 JSON without a byte order mark, or not the format. Otherwise it answers each entry, sorted by name, as a verified
 * package or one refusal, the first of, in this order:
 *
 * 1. `PROVIDER_ID_COLLISION`, read from the lock alone before any file of the package is read: `bundled-engine` when an
 *    engine id is one Studio's bundled catalog serves (`isDatabaseType`), else `shared-engine` when another entry serves
 *    one of its engine ids, every claimant refused and naming the others;
 * 2. the directory `<name>/<version>/`, resolved inside the providers directory by real path (`resolveArtifactDirectory`);
 * 3. the walk of its files (`walkArtifact`);
 * 4. the digest of its files and its entry's import record against the lock's (`digest-differs`);
 * 5. its package.json and manifest (`readArtifactIdentity`), then each field against the entry (`compareIdentity`);
 * 6. the entry file, a regular file of the listing (`checkEntryFile`).
 *
 * The answer is frozen and built from checked values; the order of the lock's entries changes nothing in it. The digest
 * is computed at every read, and nothing is kept between reads. Nothing here imports or runs a package's code.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isDatabaseType } from "@/lib/db/type-id";
import {
  type ArtifactFile,
  artifactDigest,
  checkEntryFile,
  compareIdentity,
  decodeJson,
  readArtifactIdentity,
  readBoundedFile,
  resolveArtifactDirectory,
  walkArtifact,
} from "./provider-artifact";
import { lockRefusal, packageRefusal } from "./lock-refusals";
import {
  bundledEngineRefusal,
  type LockRefusal,
  type PackageName,
  type PackageRefusal,
  sharedEngineRefusal,
} from "./provider-refusals";
import { checkProvidersLock, LOCK_BYTE_CAP, LOCK_FILE_NAME, type LockEntry } from "./providers-lock-format";

/** A package that passed its lock: what the admission's later steps read. */
export interface VerifiedPackage {
  readonly verified: true;
  readonly name: string;
  readonly version: string;
  /** Its engine ids, sorted. */
  readonly engines: readonly string[];
  readonly source: LockEntry["source"];
  readonly digest: string;
  /** Its directory's real path. */
  readonly directory: string;
  /** The absolute path of its entry module, for the loader. */
  readonly entryFile: string;
  /** Its listing, sorted by path. */
  readonly files: readonly ArtifactFile[];
  /** The import record its lock entry gives, which the digest covers, frozen. */
  readonly imports: LockEntry["imports"];
}

/** A package its lock refused. */
export interface RefusedPackage {
  readonly verified: false;
  readonly name: string;
  readonly version: string;
  /**
   * The engine ids its lock entry names, sorted, which the operator wrote and the lock's format checked: the engines
   * the server answers as unavailable, naming this refusal's code (docs/providers/CONTRACT.md, clause C-107).
   */
  readonly engines: readonly string[];
  readonly refusal: PackageRefusal;
}

/** The read of a providers directory's lock. */
export type ProvidersLockRead =
  | { readonly read: false; readonly refusal: LockRefusal }
  | {
      readonly read: true;
      readonly lockFile: string;
      readonly packages: readonly (VerifiedPackage | RefusedPackage)[];
    };

/** The codes that mean "nothing at this path", ENOTDIR for a path below a file included. */
const NO_ENTRY: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/** The read refused as a whole. */
function refused(refusal: LockRefusal): ProvidersLockRead {
  return Object.freeze({ read: false, refusal });
}

/** Code-unit order; package names are ASCII by their form. */
function byName(a: PackageName, b: PackageName): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Code-unit order, the same on every machine and locale; engine ids are ASCII by their form. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The collision refusal of each entry that has one, by name. */
function collisions(entries: readonly LockEntry[]): Map<string, PackageRefusal> {
  const found = new Map<string, PackageRefusal>();
  for (const entry of entries) {
    if (entry.engines.some((id) => isDatabaseType(id))) {
      found.set(entry.name, bundledEngineRefusal(entry));
      continue;
    }
    const others = entries
      .filter((other) => other !== entry && other.engines.some((id) => entry.engines.includes(id)))
      .sort(byName);
    if (others.length > 0) found.set(entry.name, sharedEngineRefusal(entry, others));
  }
  return found;
}

/** The refused package of `entry`, refused with `refusal`. */
function refusedPackage(entry: LockEntry, refusal: PackageRefusal): RefusedPackage {
  return Object.freeze({
    verified: false,
    name: entry.name,
    version: entry.version,
    engines: Object.freeze([...entry.engines].sort(byCodeUnit)),
    refusal,
  });
}

/** One entry's package, past the collision check. */
function readPackage(providers: string, entry: LockEntry): VerifiedPackage | RefusedPackage {
  const refuse = (fault: Parameters<typeof packageRefusal>[1]): RefusedPackage =>
    refusedPackage(entry, packageRefusal(entry, fault));
  const resolved = resolveArtifactDirectory(providers, entry.name, entry.version);
  if (!resolved.ok) return refuse(resolved.fault);
  const walked = walkArtifact(resolved.directory);
  if (!walked.ok) return refuse(walked.fault);
  if (artifactDigest(walked.files, entry.imports) !== entry.digest) {
    return refuse({ code: "PROVIDER_DIGEST_MISMATCH", rule: "digest-differs" });
  }
  const identity = readArtifactIdentity(resolved.directory);
  if (!identity.ok) return refuse(identity.fault);
  const mismatch = compareIdentity(identity.identity, entry) ?? checkEntryFile(walked.files, entry.entry);
  if (mismatch !== null) return refuse(mismatch);
  return Object.freeze({
    verified: true,
    name: entry.name,
    version: entry.version,
    engines: Object.freeze([...identity.identity.engines]),
    source: entry.source,
    digest: entry.digest,
    directory: resolved.directory,
    entryFile: path.join(resolved.directory, ...entry.entry.split("/")),
    files: walked.files,
    imports: entry.imports,
  });
}

/** The lock of the providers directory `directory` and each package it names, or the refusal of the whole lock. */
export function readProvidersLock(directory: string): ProvidersLockRead {
  let providers: string;
  try {
    providers = fs.realpathSync.native(directory);
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (typeof errno !== "string") throw error;
    const lockFile = path.join(directory, LOCK_FILE_NAME);
    return refused(
      NO_ENTRY.has(errno)
        ? lockRefusal(lockFile, "directory-missing")
        : lockRefusal(lockFile, "directory-unreadable", { errno }),
    );
  }
  const lockFile = path.join(providers, LOCK_FILE_NAME);
  if (!fs.statSync(providers).isDirectory()) return refused(lockRefusal(lockFile, "directory-not-a-directory"));
  const read = readBoundedFile(lockFile, LOCK_BYTE_CAP);
  if (!read.ok) {
    if (read.failure === "missing") return refused(lockRefusal(lockFile, "lock-missing"));
    if (read.failure === "not-a-file") return refused(lockRefusal(lockFile, "lock-not-a-file"));
    if (read.failure === "over-cap") return refused(lockRefusal(lockFile, "lock-over-cap"));
    return refused(lockRefusal(lockFile, "lock-unreadable", { errno: read.errno }));
  }
  const decoded = decodeJson(read.bytes);
  if (decoded === undefined) return refused(lockRefusal(lockFile, "lock-not-json"));
  const checked = checkProvidersLock(decoded.value, lockFile);
  if (!checked.ok) return refused(checked.refusal);
  const collided = collisions(checked.entries);
  const packages = [...checked.entries].sort(byName).map((entry) => {
    const collision = collided.get(entry.name);
    if (collision !== undefined) return refusedPackage(entry, collision);
    return readPackage(providers, entry);
  });
  return Object.freeze({ read: true, lockFile, packages: Object.freeze(packages) });
}
