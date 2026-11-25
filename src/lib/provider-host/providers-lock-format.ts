/**
 * The providers lock's format, `providers.lock.json` (docs/providers/CONTRACT.md, clause C-91): closed at both levels,
 * capped, and read without walking any value it does not name.
 *
 *     { "lockVersion": 1, "entries": [ { "name", "version", "engines", "entry", "digest", "source" } ] }
 *
 * - `name`: an npm package name, `version`: an exact version, `engines`: 1 to 64 distinct engine ids, `entry`: the
 *   package-relative path of its ES module entry, each the form the SDK's manifest schema gives it, so a lock entry
 *   says nothing a package cannot declare; `digest`: `sha256:` and 64 lower-case hex digits (`artifactDigest` in
 *   `./provider-artifact`); `source`: `"local"`, the only source of milestone 1.
 * - Caps, checked before any value is walked: `LOCK_BYTE_CAP` bytes (the reader's, `./providers-lock`),
 *   `LOCK_ENTRY_CAP` entries, `LOCK_ENGINE_CAP` engine ids an entry, and each string's length before its pattern. A lock
 *   of 256 entries, each at every longest value, is 912,426 bytes written by `serializeProvidersLock`, so every lock
 *   within the entry limits fits the byte cap.
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

/** One entry of the lock. */
export interface LockEntry {
  readonly name: string;
  readonly version: string;
  readonly engines: readonly string[];
  readonly entry: string;
  readonly digest: string;
  readonly source: typeof LOCAL_SOURCE;
}

/** The lock's checked entries, or its refusal. */
export type LockCheck =
  | { readonly ok: true; readonly entries: readonly LockEntry[] }
  | { readonly ok: false; readonly refusal: LockRefusal };

const TOP_KEYS: readonly string[] = ["lockVersion", "entries"];
const ENTRY_KEYS: readonly string[] = ["name", "version", "engines", "entry", "digest", "source"];

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
  return Object.freeze({ name, version, engines: Object.freeze(engines), entry, digest, source: LOCAL_SOURCE });
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
 * The lock's text for `entries`: entries by name and each entry's engine ids in ascending order, two-space JSON and
 * one final newline, so the same entries in any order give the same bytes.
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
    }));
  return `${JSON.stringify({ lockVersion: LOCK_VERSION, entries: sorted }, null, 2)}\n`;
}
