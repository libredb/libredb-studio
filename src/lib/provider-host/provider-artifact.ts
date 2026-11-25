/**
 * What a provider package's artifact is, as Studio reads it from the providers directory (docs/providers/CONTRACT.md,
 * clauses C-91 to C-94): where its directory is, which files it holds, their digest, and the identity its package.json
 * and manifest give. The lock reader (`./providers-lock`) and the lock command (`scripts/providers-lock.ts`) both use
 * these functions, so the digest a lock pins is computed exactly as the read that checks it computes it. Nothing here
 * knows the lock, and nothing here imports or runs a package's code.
 *
 * The directory. A package `<name>@<version>` sits at `<providers>/<name>/<version>`, a scoped name split at its
 * slash, resolved with `fs.realpathSync.native` (libuv's real-path read: on Windows a handle's final path, so junctions,
 * short 8.3 names and letter case are resolved), and inside the providers directory's real path by `path.relative`: not
 * empty, not `..` or under it, not absolute (which `path.win32.relative` answers across drives). A link at the scope,
 * name or version level that stays inside is followed; one that leaves is refused as `directory-outside`.
 *
 * The walk. From that real directory, each directory's names are read with `readdirSync` and sorted, each name is
 * checked against `ARTIFACT_NAME`, and each entry is read with `lstatSync`, which never follows a link (on Windows it
 * reports a junction as one). A link anywhere, the links a package manager writes under `node_modules/.bin` included,
 * is refused as `artifact-link` and never followed; a pipe, socket or device as `artifact-special-file`, and never
 * opened. A regular file is opened read-only and without waiting (`O_NONBLOCK`), its descriptor must still be a regular
 * file, and it is hashed in 1 MiB chunks to its end. At most `ARTIFACT_FILE_LIMIT` files and `ARTIFACT_DEPTH_LIMIT`
 * levels of directories; empty directories are not in the listing. Only an error carrying an errno code becomes a
 * refusal (`artifact-unreadable`, naming the code); any other error is raised.
 *
 * The digest. `sha256:` and the hex SHA-256 of the listing: one line per regular file, sorted by path,
 * `<mode> <hex SHA-256 of the file> <path>\n`, the path relative with `/` between names. The mode is `755` when the
 * owner execute bit (0o100) of the descriptor's mode is set and `644` otherwise (git's rule), because the group and
 * other bits follow the umask of whoever copied the files. Node.js and Bun read modes through libuv, whose Windows stat
 * never sets an execute bit, so every file reads `644` there, and an artifact holding an executable file has another
 * digest on Windows than on Linux and macOS; write the lock on the platform that reads it. The digest is computed at
 * every read; nothing is kept between reads.
 *
 * The identity. `package.json` and `libredb-provider.json` at the artifact's root, each read like the lock (opened
 * without waiting, a regular file, at most its byte cap, UTF-8 JSON without a byte order mark, an object): from
 * package.json only `name` and `version`; from the manifest only `engines[].id` (the list's length, 1 to 64, checked
 * before any item is read) and `runtime.entry`, each in the form the SDK's schema gives it. Validating the whole
 * manifest is the admission's later step.
 *
 * The limit: a hard link made elsewhere to a file of an artifact is not recognised as one; an artifact holds files the
 * operator copied into the providers directory, which must be writable only by the operator.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactFault } from "./provider-refusals";
import { ENGINE_ID_FORM, ENTRY_FORM, LOCK_ENGINE_CAP, type StringForm } from "./providers-lock-format";

/** The manifest's file name at an artifact's root. */
export const MANIFEST_FILE_NAME = "libredb-provider.json";

/** The package's own file at an artifact's root. */
const PACKAGE_JSON_FILE_NAME = "package.json";

/** package.json's byte cap: 1 MiB (the largest in Studio's own node_modules is 200,594 bytes). */
export const PACKAGE_JSON_BYTE_CAP = 1024 * 1024;

/** The manifest's byte cap: 2 MiB (64 engines at the largest committed declaration are 1.15 MB). */
export const MANIFEST_BYTE_CAP = 2 * 1024 * 1024;

/** At most 10,000 regular files in an artifact. */
export const ARTIFACT_FILE_LIMIT = 10_000;

/** At most 32 levels of directories below an artifact's root. */
export const ARTIFACT_DEPTH_LIMIT = 32;

/** A name inside an artifact: 1 to 255 letters, digits and `. _ - @ + ~`, so every listing line is unambiguous. */
const ARTIFACT_NAME = /^[A-Za-z0-9._@+~-]{1,255}$/;

/** The limits of one walk; the defaults are the contract's, and a test passes smaller ones. */
export interface WalkLimits {
  readonly files: number;
  readonly depth: number;
}

/** One regular file of an artifact. */
export interface ArtifactFile {
  /** The path relative to the artifact's directory, `/` between names. */
  readonly path: string;
  readonly mode: "644" | "755";
  /** The hex SHA-256 of its bytes. */
  readonly sha256: string;
}

/** A package's identity as its own files give it. */
export interface ArtifactIdentity {
  /** package.json's `name`, as read: not necessarily a string. */
  readonly name: unknown;
  /** package.json's `version`, as read. */
  readonly version: unknown;
  /** The manifest's engine ids, sorted. */
  readonly engines: readonly string[];
  /** The manifest's `runtime.entry`. */
  readonly entry: string;
}

/** The identity a lock entry names. */
export interface ExpectedIdentity {
  readonly name: string;
  readonly version: string;
  readonly engines: readonly string[];
  readonly entry: string;
}

export type Outcome<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly fault: ArtifactFault };

/** Read-only, and without waiting for a pipe's writer; Windows defines no O_NONBLOCK, and OR-ing undefined adds nothing. */
const READ_WITHOUT_WAITING = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;

/** The chunk a file is hashed in. */
const CHUNK_BYTES = 1024 * 1024;

/** The codes that mean "nothing at this path", ENOTDIR for a path below a file included. */
const NO_ENTRY: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/** The errno code of a filesystem error, or undefined for any other error. */
function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A fault, frozen. */
function fault(code: ArtifactFault["code"], rule: ArtifactFault["rule"], errno?: string): ArtifactFault {
  return Object.freeze({ code, rule, ...(errno === undefined ? {} : { errno }) }) as ArtifactFault;
}

/** The fault of a filesystem error on an artifact's path; an error without an errno code is raised. */
function unreadable(error: unknown): { readonly ok: false; readonly fault: ArtifactFault } {
  const errno = errnoOf(error);
  if (errno === undefined) throw error;
  return { ok: false, fault: fault("PROVIDER_DIGEST_MISMATCH", "artifact-unreadable", errno) };
}

/** Whether `candidate` is strictly inside `root`, both real paths. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The real directory of `<name>/<version>` under `providers`, itself a real path (`fs.realpathSync.native`): refused as
 * `artifact-missing` when nothing is there, `artifact-unreadable` for any other filesystem error, and
 * `directory-outside` when it resolves outside the providers directory.
 */
export function resolveArtifactDirectory(
  providers: string,
  name: string,
  version: string,
): Outcome<{ readonly directory: string }> {
  let directory: string;
  try {
    directory = fs.realpathSync.native(path.join(providers, ...name.split("/"), version));
  } catch (error) {
    if (NO_ENTRY.has(errnoOf(error) ?? "")) {
      return { ok: false, fault: fault("PROVIDER_DIGEST_MISMATCH", "artifact-missing") };
    }
    return unreadable(error);
  }
  if (!isInside(providers, directory)) {
    return { ok: false, fault: fault("PROVIDER_PATH_OUTSIDE", "directory-outside") };
  }
  return { ok: true, directory };
}

/** The hex SHA-256 and mode of the regular file at `file`, opened without waiting; null when it is not a regular file. */
function hashRegularFile(file: string): { readonly sha256: string; readonly mode: "644" | "755" } | null {
  const fd = fs.openSync(file, READ_WITHOUT_WAITING);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(CHUNK_BYTES);
    for (
      let read = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null);
      read > 0;
      read = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null)
    ) {
      hash.update(chunk.subarray(0, read));
    }
    return { sha256: hash.digest("hex"), mode: (stat.mode & 0o100) !== 0 ? "755" : "644" };
  } finally {
    fs.closeSync(fd);
  }
}

/** Code-unit order; every name is ASCII by `ARTIFACT_NAME`, so this is also the order of its bytes. */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The walk, with every filesystem error thrown for `walkArtifact` to answer. */
function walk(directory: string, limits: WalkLimits): Outcome<{ readonly files: readonly ArtifactFile[] }> {
  const files: ArtifactFile[] = [];
  const pending: { readonly relative: string; readonly depth: number }[] = [{ relative: "", depth: 0 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const names = fs.readdirSync(path.join(directory, next.relative)).sort(byCodeUnits);
    for (const name of names) {
      if (!ARTIFACT_NAME.test(name)) return { ok: false, fault: fault("PROVIDER_DIGEST_MISMATCH", "artifact-name") };
      const relative = next.relative === "" ? name : `${next.relative}/${name}`;
      const absolute = path.join(directory, ...relative.split("/"));
      const entry = fs.lstatSync(absolute);
      if (entry.isSymbolicLink()) return { ok: false, fault: fault("PROVIDER_PATH_OUTSIDE", "artifact-link") };
      if (entry.isDirectory()) {
        if (next.depth + 1 > limits.depth) {
          return { ok: false, fault: fault("PROVIDER_DIGEST_MISMATCH", "artifact-over-limit") };
        }
        pending.push({ relative, depth: next.depth + 1 });
        continue;
      }
      if (!entry.isFile()) return { ok: false, fault: fault("PROVIDER_PATH_OUTSIDE", "artifact-special-file") };
      if (files.length === limits.files) {
        return { ok: false, fault: fault("PROVIDER_DIGEST_MISMATCH", "artifact-over-limit") };
      }
      const hashed = hashRegularFile(absolute);
      if (hashed === null) return { ok: false, fault: fault("PROVIDER_PATH_OUTSIDE", "artifact-special-file") };
      files.push(Object.freeze({ path: relative, ...hashed }));
    }
  }
  return { ok: true, files: Object.freeze(files.sort((a, b) => byCodeUnits(a.path, b.path))) };
}

/** Every regular file of the artifact at `directory`, sorted by path and frozen, or the first refusal of the walk. */
export function walkArtifact(
  directory: string,
  limits: WalkLimits = { files: ARTIFACT_FILE_LIMIT, depth: ARTIFACT_DEPTH_LIMIT },
): Outcome<{ readonly files: readonly ArtifactFile[] }> {
  try {
    return walk(directory, limits);
  } catch (error) {
    return unreadable(error);
  }
}

/** The artifact digest of `files`, in any order. */
export function artifactDigest(files: readonly ArtifactFile[]): string {
  const listing = [...files]
    .sort((a, b) => byCodeUnits(a.path, b.path))
    .map((file) => `${file.mode} ${file.sha256} ${file.path}\n`)
    .join("");
  return `sha256:${createHash("sha256").update(listing).digest("hex")}`;
}

/** Why a bounded read did not answer bytes. */
export type BoundedReadFailure = "missing" | "not-a-file" | "over-cap" | "unreadable";

/** The bytes of a regular file of at most `cap` bytes, or why not. */
export type BoundedRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly failure: BoundedReadFailure; readonly errno?: string };

/**
 * The bytes of the regular file at `file`, read on the caller's thread without ever waiting: opened read-only with
 * `O_NONBLOCK`, so a pipe opens at once, then refused unless the descriptor is a regular file, then read to at most
 * `cap` + 1 bytes, so a file over its cap is refused without being read to its end. Nothing at the path is `missing`, a
 * directory is `not-a-file` (Windows refuses to open one with EISDIR), any other filesystem error is `unreadable` with
 * its errno code, and an error without one is raised.
 */
export function readBoundedFile(file: string, cap: number): BoundedRead {
  let fd: number;
  try {
    fd = fs.openSync(file, READ_WITHOUT_WAITING);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    if (NO_ENTRY.has(errno)) return { ok: false, failure: "missing" };
    if (errno === "EISDIR") return { ok: false, failure: "not-a-file" };
    return { ok: false, failure: "unreadable", errno };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { ok: false, failure: "not-a-file" };
    const bytes = Buffer.alloc(cap + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length <= cap; length += read) {
      read = fs.readSync(fd, bytes, length, cap + 1 - length, null);
    }
    if (length > cap) return { ok: false, failure: "over-cap" };
    return { ok: true, bytes: bytes.subarray(0, length) };
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    return { ok: false, failure: "unreadable", errno };
  } finally {
    fs.closeSync(fd);
  }
}

/** UTF-8 that refuses an invalid byte, and keeps a byte order mark so that `JSON.parse` refuses it. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The JSON value of `bytes`, which must be UTF-8 without a byte order mark; undefined when they are not JSON. */
export function decodeJson(bytes: Uint8Array): { readonly value: unknown } | undefined {
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

/** The JSON object in the file at `file`, read by `readBoundedFile` and `decodeJson`; undefined for anything else. */
function readJsonObject(file: string, cap: number): Record<string, unknown> | undefined {
  const read = readBoundedFile(file, cap);
  if (!read.ok) return undefined;
  const decoded = decodeJson(read.bytes);
  const value = decoded?.value;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whether `value` is a string of `form`. */
function inForm(value: unknown, form: StringForm): value is string {
  return typeof value === "string" && value.length <= form.maxLength && form.pattern.test(value);
}

/** The manifest's engine ids, sorted, when its `engines` is 1 to 64 objects with distinct ids in their form. */
function manifestEngines(engines: unknown): string[] | undefined {
  if (!Array.isArray(engines) || engines.length === 0 || engines.length > LOCK_ENGINE_CAP) return undefined;
  const ids: string[] = [];
  for (const engine of engines as unknown[]) {
    const id = typeof engine === "object" && engine !== null ? (engine as { id?: unknown }).id : undefined;
    if (!inForm(id, ENGINE_ID_FORM) || ids.includes(id)) return undefined;
    ids.push(id);
  }
  return ids.sort(byCodeUnits);
}

/** The manifest's `runtime.entry`, when it is in its form. */
function manifestEntry(runtime: unknown): string | undefined {
  const entry = typeof runtime === "object" && runtime !== null ? (runtime as { entry?: unknown }).entry : undefined;
  return inForm(entry, ENTRY_FORM) ? entry : undefined;
}

/** The identity of the artifact at `directory`, or why its package.json or manifest cannot give one. */
export function readArtifactIdentity(directory: string): Outcome<{ readonly identity: ArtifactIdentity }> {
  const packageJson = readJsonObject(path.join(directory, PACKAGE_JSON_FILE_NAME), PACKAGE_JSON_BYTE_CAP);
  if (packageJson === undefined) {
    return { ok: false, fault: fault("PROVIDER_IDENTITY_MISMATCH", "package-json-unreadable") };
  }
  const manifest = readJsonObject(path.join(directory, MANIFEST_FILE_NAME), MANIFEST_BYTE_CAP);
  const engines = manifestEngines(manifest?.engines);
  const entry = manifestEntry(manifest?.runtime);
  if (engines === undefined || entry === undefined) {
    return { ok: false, fault: fault("PROVIDER_IDENTITY_MISMATCH", "manifest-unreadable") };
  }
  return {
    ok: true,
    identity: Object.freeze({
      name: packageJson.name,
      version: packageJson.version,
      engines: Object.freeze(engines),
      entry,
    }),
  };
}

/**
 * The first field in which `identity` differs from `expected`, in the order name, version, engines (as sets, so their
 * order is no difference), entry; null when none does.
 */
export function compareIdentity(identity: ArtifactIdentity, expected: ExpectedIdentity): ArtifactFault | null {
  if (identity.name !== expected.name) return fault("PROVIDER_IDENTITY_MISMATCH", "name");
  if (identity.version !== expected.version) return fault("PROVIDER_IDENTITY_MISMATCH", "version");
  const engines = [...expected.engines].sort(byCodeUnits);
  if (identity.engines.length !== engines.length || identity.engines.some((id, index) => id !== engines[index])) {
    return fault("PROVIDER_IDENTITY_MISMATCH", "engines");
  }
  if (identity.entry !== expected.entry) return fault("PROVIDER_IDENTITY_MISMATCH", "entry");
  return null;
}

/** Null when `entry` is a regular file of the listing, compared by exact path; otherwise `entry-not-a-file`. */
export function checkEntryFile(files: readonly ArtifactFile[], entry: string): ArtifactFault | null {
  return files.some((file) => file.path === entry) ? null : fault("PROVIDER_PATH_OUTSIDE", "entry-not-a-file");
}
