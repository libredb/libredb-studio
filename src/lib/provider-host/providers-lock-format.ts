/**
 * The providers lock's format, `providers.lock.json` (docs/providers/CONTRACT.md, clause C-91): closed at both levels,
 * capped, and read without walking any value it does not name.
 *
 *     { "lockVersion": 1, "entries": [ { "name", "version", "engines", "entry", "digest", "source", "imports" } ] }
 *
 * - `name`: an npm package name, `version`: an exact version, `engines`: 1 to 64 distinct engine ids, `entry`: the
 *   package-relative path of its ES module entry, each the form the SDK's manifest schema gives it, so a lock entry
 *   says nothing a package cannot declare; `digest`: `sha256:` and 64 lower-case hex digits (`artifactDigest` in
 *   `./provider-artifact`); `source`: `"local"`, the only source of milestone 1; `imports`: the import record (clause
 *   C-102), each static import of each module file of the package as `{ "from", "specifier" }`, the module file's path
 *   in the package and the specifier as written, each pair once, at most `LOCK_IMPORT_CAP` pairs. The lock command
 *   records it and the entry's digest covers it, so the record is the package's as much as its files are.
 * - Caps, checked before any value is walked: `LOCK_BYTE_CAP` bytes (the reader's, `./providers-lock`),
 *   `LOCK_ENTRY_CAP` entries, `LOCK_ENGINE_CAP` engine ids and `LOCK_IMPORT_CAP` imports an entry, and each string's
 *   length before its pattern. The byte cap binds first: a lock of entries at their longest import records is many times
 *   over it, so the lock command refuses to write a lock over the byte cap, and the reader refuses one as `lock-over-cap`.
 * - The check reads only the keys of the format at their depths, with `Object.keys` on the two objects it reads, and
 *   answers values built from the primitives it checked, so a deep value under an unknown key or in place of an engine
 *   id is refused without being walked. `JSON.parse` keeps the last of two equal keys, so a duplicate key cannot be
 *   told apart; the lock is the operator's own file.
 * - Any violation refuses the whole lock as `PROVIDER_LOCK_INVALID`, naming the rule (the SDK validator's shape
 *   vocabulary) and the JSON pointer of the value. One name in two entries is `duplicate`, since the loader's registry
 *   is keyed by name (C-90).
 *
 * This module is pure: it reads no file. The lock reader reads the bytes; the lock command writes the text
 * `serializeProvidersLock` gives, which is the same for the same entries in any order.
 */
import { type LockRefusal, type LockShapeRule, lockRefusal } from "./provider-refusals";

/** The format's version. */
const LOCK_VERSION = 1;

/** The lock's byte cap: 1 MiB. */
export const LOCK_BYTE_CAP = 1024 * 1024;

/** At most 256 entries. */
export const LOCK_ENTRY_CAP = 256;

/** At most 64 engine ids an entry, the manifest's own limit (schema `/properties/engines/maxItems`). */
export const LOCK_ENGINE_CAP = 64;

/** The one source of milestone 1: a package an operator put in the providers directory. */
export const LOCAL_SOURCE = "local";

/** A string's form: its longest length, checked first, then its pattern. */
export interface StringForm {
  readonly pattern: RegExp;
  readonly maxLength: number;
}

/** An npm package name (schema `/$defs/nativePackage/properties/package`). */
export const PACKAGE_NAME_FORM: StringForm = Object.freeze({
  pattern: /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
  maxLength: 214,
});

/** An exact version, never a range (schema `/$defs/nativePackage/properties/version`). */
export const PACKAGE_VERSION_FORM: StringForm = Object.freeze({
  pattern: /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/,
  maxLength: 64,
});

/** An engine id (schema `/$defs/engineId`, manifest clause M-7): its pattern allows at most 32 characters. */
export const ENGINE_ID_FORM: StringForm = Object.freeze({ pattern: /^[a-z][a-z0-9]{0,31}$/, maxLength: 32 });

/** The package-relative path of the entry module (schema `/$defs/runtime/properties/entry`, clause M-13). */
export const ENTRY_FORM: StringForm = Object.freeze({
  pattern: /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.m?js$/,
  maxLength: 256,
});

/** An artifact digest. */
export const DIGEST_FORM: StringForm = Object.freeze({ pattern: /^sha256:[0-9a-f]{64}$/, maxLength: 71 });

/** At most 4,096 imports an entry. */
export const LOCK_IMPORT_CAP = 4096;

/**
 * A module file's path in its package: names of the artifact's portable set (`ARTIFACT_NAME` in `./provider-artifact`)
 * joined by `/`, no name `.` or `..`, at most 1,024 characters.
 */
export const IMPORT_FROM_FORM: StringForm = Object.freeze({
  pattern: /^(?!\.\.?(?:\/|$))[A-Za-z0-9._@+~-]+(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._@+~-]+)*$/,
  maxLength: 1024,
});

/** A specifier as written: 1 to 1,024 printable ASCII characters and no space, so a digest line is unambiguous. */
export const IMPORT_SPECIFIER_FORM: StringForm = Object.freeze({ pattern: /^[\x21-\x7e]+$/, maxLength: 1024 });

/**
 * How a module reaches an import: `require` for a `require()` call, which Node.js's CommonJS resolver resolves, and
 * `import` for an import declaration, a re-export or an `import()`, which its ES module resolver resolves.
 */
export const IMPORT_KINDS = ["import", "require"] as const;

/** One of `IMPORT_KINDS`. */
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** One static import of a module file of a package. */
export interface ModuleImport {
  /** The module file's path in the package, `/` between names. */
  readonly from: string;
  /** The specifier as the module writes it. */
  readonly specifier: string;
  /** How the module reaches it. */
  readonly kind: ImportKind;
}

/** One entry of the lock. */
export interface LockEntry {
  readonly name: string;
  readonly version: string;
  readonly engines: readonly string[];
  readonly entry: string;
  readonly digest: string;
  readonly source: typeof LOCAL_SOURCE;
  /** Its import record, in any order: the serializer and the digest sort it. */
  readonly imports: readonly ModuleImport[];
}

/** The lock's checked entries, or its refusal. */
export type LockCheck =
  | { readonly ok: true; readonly entries: readonly LockEntry[] }
  | { readonly ok: false; readonly refusal: LockRefusal };

const TOP_KEYS: readonly string[] = ["lockVersion", "entries"];
const ENTRY_KEYS: readonly string[] = ["name", "version", "engines", "entry", "digest", "source", "imports"];
const IMPORT_KEYS: readonly string[] = ["from", "specifier", "kind"];

/** A shape violation found while checking. */
class ShapeViolation {
  constructor(
    readonly rule: LockShapeRule,
    readonly pointer: string,
    readonly key?: string,
  ) {}
}

/** Whether `value` is a JSON object: not null, not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refuses an object with a key outside `keys` or without one of them. */
function checkKeys(value: Record<string, unknown>, keys: readonly string[], pointer: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new ShapeViolation("unknown-key", pointer, unknown);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new ShapeViolation("missing-key", pointer, missing);
}

/** `value` as a string of `form`, or the violation. */
function checkString(value: unknown, form: StringForm, pointer: string): string {
  if (typeof value !== "string") throw new ShapeViolation("wrong-type", pointer);
  if (value.length > form.maxLength) throw new ShapeViolation("out-of-range", pointer);
  if (!form.pattern.test(value)) throw new ShapeViolation("pattern-mismatch", pointer);
  return value;
}

/** An entry's engine ids, in the lock's order: 1 to `LOCK_ENGINE_CAP` distinct ids, the count checked first. */
function checkEngines(value: unknown, pointer: string): string[] {
  if (!Array.isArray(value)) throw new ShapeViolation("wrong-type", pointer);
  if (value.length === 0) throw new ShapeViolation("too-few", pointer);
  if (value.length > LOCK_ENGINE_CAP) throw new ShapeViolation("too-many", pointer);
  const engines: string[] = [];
  value.forEach((item: unknown, index) => {
    const id = checkString(item, ENGINE_ID_FORM, `${pointer}/${index}`);
    if (engines.includes(id)) throw new ShapeViolation("duplicate", `${pointer}/${index}`);
    engines.push(id);
  });
  return engines;
}

/** An entry's import record, in the lock's order: at most `LOCK_IMPORT_CAP` distinct imports, the count checked first. */
function checkImports(value: unknown, pointer: string): ModuleImport[] {
  if (!Array.isArray(value)) throw new ShapeViolation("wrong-type", pointer);
  if (value.length > LOCK_IMPORT_CAP) throw new ShapeViolation("too-many", pointer);
  const imports: ModuleImport[] = [];
  const seen = new Set<string>();
  value.forEach((item: unknown, index) => {
    const at = `${pointer}/${index}`;
    if (!isObject(item)) throw new ShapeViolation("wrong-type", at);
    checkKeys(item, IMPORT_KEYS, at);
    const from = checkString(item.from, IMPORT_FROM_FORM, `${at}/from`);
    const specifier = checkString(item.specifier, IMPORT_SPECIFIER_FORM, `${at}/specifier`);
    const kind = checkKind(item.kind, `${at}/kind`);
    // Neither form admits a space, so the import's line is one key.
    const key = `${from} ${specifier} ${kind}`;
    if (seen.has(key)) throw new ShapeViolation("duplicate", at);
    seen.add(key);
    imports.push(Object.freeze({ from, specifier, kind }));
  });
  return imports;
}

/** `value` as one of `IMPORT_KINDS`, or the violation. */
function checkKind(value: unknown, pointer: string): ImportKind {
  if (typeof value !== "string") throw new ShapeViolation("wrong-type", pointer);
  const kind = IMPORT_KINDS.find((known) => known === value);
  if (kind === undefined) throw new ShapeViolation("value-not-allowed", pointer);
  return kind;
}

/** One entry, built from its checked values. */
function checkEntry(value: unknown, pointer: string): LockEntry {
  if (!isObject(value)) throw new ShapeViolation("wrong-type", pointer);
  checkKeys(value, ENTRY_KEYS, pointer);
  const name = checkString(value.name, PACKAGE_NAME_FORM, `${pointer}/name`);
  const version = checkString(value.version, PACKAGE_VERSION_FORM, `${pointer}/version`);
  const engines = checkEngines(value.engines, `${pointer}/engines`);
  const entry = checkString(value.entry, ENTRY_FORM, `${pointer}/entry`);
  const digest = checkString(value.digest, DIGEST_FORM, `${pointer}/digest`);
  if (typeof value.source !== "string") throw new ShapeViolation("wrong-type", `${pointer}/source`);
  if (value.source !== LOCAL_SOURCE) throw new ShapeViolation("value-not-allowed", `${pointer}/source`);
  const imports = checkImports(value.imports, `${pointer}/imports`);
  return Object.freeze({
    name,
    version,
    engines: Object.freeze(engines),
    entry,
    digest,
    source: LOCAL_SOURCE,
    imports: Object.freeze(imports),
  });
}

/** The lock's entries, in the lock's order; any violation is thrown. */
function checkLock(value: unknown): LockEntry[] {
  if (!isObject(value)) throw new ShapeViolation("wrong-type", "");
  checkKeys(value, TOP_KEYS, "");
  if (typeof value.lockVersion !== "number") throw new ShapeViolation("wrong-type", "/lockVersion");
  if (value.lockVersion !== LOCK_VERSION) throw new ShapeViolation("value-not-allowed", "/lockVersion");
  if (!Array.isArray(value.entries)) throw new ShapeViolation("wrong-type", "/entries");
  if (value.entries.length > LOCK_ENTRY_CAP) throw new ShapeViolation("too-many", "/entries");
  const entries: LockEntry[] = [];
  value.entries.forEach((item: unknown, index) => {
    const entry = checkEntry(item, `/entries/${index}`);
    if (entries.some((earlier) => earlier.name === entry.name)) {
      throw new ShapeViolation("duplicate", `/entries/${index}/name`);
    }
    entries.push(entry);
  });
  return entries;
}

/**
 * The lock's entries, checked against the format, from `value`, the lock's text as `JSON.parse` read it; or the
 * refusal of the whole lock, naming `lockFile`, the rule, the JSON pointer and, for a key rule, the key.
 */
export function checkProvidersLock(value: unknown, lockFile: string): LockCheck {
  try {
    return Object.freeze({ ok: true, entries: Object.freeze(checkLock(value)) });
  } catch (error) {
    if (!(error instanceof ShapeViolation)) throw error;
    const detail = { pointer: error.pointer, ...(error.key === undefined ? {} : { key: error.key }) };
    return Object.freeze({ ok: false, refusal: lockRefusal(lockFile, error.rule, detail) });
  }
}

/** Code-unit order: every value it sorts is ASCII by its form, so this is also the order of its bytes. */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `imports` sorted by module path, then by specifier, then by kind, in code-unit order: the order of the lock and of
 * the digest.
 */
export function sortImports(imports: readonly ModuleImport[]): ModuleImport[] {
  return [...imports].sort(
    (a, b) => byCodeUnits(a.from, b.from) || byCodeUnits(a.specifier, b.specifier) || byCodeUnits(a.kind, b.kind),
  );
}

/**
 * The lock's text for `entries`: entries by name, each entry's engine ids in ascending order and its imports by
 * `sortImports`, two-space JSON and one final newline, so the same entries in any order give the same bytes.
 */
export function serializeProvidersLock(entries: readonly LockEntry[]): string {
  const sorted = [...entries]
    .sort((a, b) => byCodeUnits(a.name, b.name))
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      engines: [...entry.engines].sort(byCodeUnits),
      entry: entry.entry,
      digest: entry.digest,
      source: entry.source,
      imports: sortImports(entry.imports).map((pair) => ({
        from: pair.from,
        specifier: pair.specifier,
        kind: pair.kind,
      })),
    }));
  return `${JSON.stringify({ lockVersion: LOCK_VERSION, entries: sorted }, null, 2)}\n`;
}
