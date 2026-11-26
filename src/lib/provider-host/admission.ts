/**
 * Admission: the step that decides whether a package that passed its lock (`./providers-lock`) is imported, and
 * registers Studio's record of a package boot keeps (docs/providers/CONTRACT.md, clauses C-97 to C-105). It runs in
 * Studio's code with Studio's copy of the SDK, never in the loader, and it is the only module of Studio that calls the
 * loader's `loadPackage` and `registerAdmitted`.
 *
 * `admitPackage(pkg, options)` answers the package admitted or its first refusal, in this order:
 *
 * 1. the manifest, `libredb-provider.json`, read as bytes within its byte cap, its SHA-256 the listing's the lock read
 *    verified (`PROVIDER_DIGEST_MISMATCH` otherwise), and a JSON object (`PROVIDER_SCHEMA_INVALID` at the top level
 *    otherwise);
 * 2. its contract: one of the envelope's form other than `HOST_CONTRACT` is `PROVIDER_CONTRACT_UNSUPPORTED` before the
 *    schema is applied, and the sentence names Studio's contract, never the manifest's;
 * 3. the SDK's validator, the schema then its code rules, the same rules Studio's generator admits its own
 *    declarations by (`PROVIDER_SCHEMA_INVALID`, the first refusal's rule and pointer and the count of the rest, never
 *    a key); the manifest admitted is deep-frozen;
 * 4. its engine ids and its name: an engine id the legacy adapter serves (`LEGACY_ENGINE_IDS`, the ids of Studio's
 *    bundled engines), the package name the legacy adapter serves them under (`LEGACY_SOURCE_NAME`,
 *    `legacy-package`), an engine id that is an own key of `Object.prototype` (a table keyed by plain object would
 *    answer an inherited member for it), one a package admitted earlier in this process serves, and a package name
 *    registered earlier, each `PROVIDER_ID_COLLISION`; the last two are checked again right before registration
 *    (`registerAdmission`), since another package may register while this one imports;
 * 5. its entry, an ES module: `.mjs`, or `.js` whose nearest package.json inside the package, read and bound to the
 *    listing like the manifest, declares `"type": "module"` (`PROVIDER_MODULE_FORMAT` otherwise); the lookup stops at a
 *    directory named `node_modules`, as Node.js's package scope lookup does, so a `.js` entry below one is CommonJS
 *    unless a package.json under it says otherwise; a module's syntax is never read to decide;
 * 6. no TypeScript file: a file whose name ends in `.ts`, `.mts`, `.cts` or `.tsx` in any letter case, a declaration
 *    file (`.d.ts`, `.d.mts`, `.d.cts`) among them, judged on the listing alone (`PROVIDER_MODULE_FORMAT`,
 *    `typescript-module`), since Bun maps an extensionless, a `.d` and a `.js` specifier onto a TypeScript file and
 *    Node.js's type stripping loads an import Bun's scanner drops, so a TypeScript file could run unseen on either
 *    runtime; a package of this contract is a JavaScript bundle;
 * 7. its import closure (`./provider-closure`), over the import record its lock entry gives (`PROVIDER_LOAD_FAILED`,
 *    `closure-outside`);
 * 8. native addons: a `.node` file in any letter case, or a manifest declaring `runtime.native`
 *    (`PROVIDER_NATIVE_UNSUPPORTED`), until a later milestone decides native admission;
 * 9. the import, by the loader under the caller's deadline; a loader refusal is `PROVIDER_LOAD_FAILED` with the
 *    loader's reason, and the thrown value of `import-threw` is answered as `cause`, for the host's log only;
 * 10. the record's manifest equal to the file's: compared by own data properties of plain objects and arrays, key order
 *    aside, by an iterative walk that follows the file's value, refusing a Proxy before it is read and an accessor
 *    without calling it (`PROVIDER_RECORD_INVALID`, `manifest-differs`);
 * 11. the implementation and its four segments, none a Proxy (`record-proxy`), since the SDK's check would run a nested
 *    Proxy's traps;
 * 12. the SDK's `checkProviderModule` (`PROVIDER_RECORD_INVALID`, the first refusal's rule and the count of the rest);
 * 13. the implementation and its segments frozen in place, and Studio's own record of them answered:
 *    `{ contract, manifest, impl }` with the manifest Studio validated and froze.
 *
 * Admission registers nothing. Boot (`./boot`) admits every package of the lock, runs the server catalog's set rules over
 * all of them, and only then calls `registerAdmission` for each package the rules keep, which checks the registered
 * engine ids and package names again as in step 4 (`PROVIDER_ID_COLLISION`) and registers the record once under the
 * package's name, with no `await` between the check and the registration. So the loader's registry and the server's
 * engine catalog name the same packages.
 *
 * No step before the import runs any of the package's code. A package refused after its import has run its top level,
 * is never registered and serves no engine. The entry module is read by the runtime's loader, not by admission, so a
 * change to it after the lock's read is not seen; the providers directory must be writable only by the operator
 * (C-93). Admission grants no claim: a package carries no grant in this contract, so every claim of its engines is read
 * as a claim with neither a review record nor a grant, at its restrictive value, whatever the manifest requests. It binds
 * no named function through any of Studio's function tables and reads no table keyed by engine id: a function name is
 * read for its form by the schema only.
 *
 * A host defect is thrown, never answered as a refusal: a validator for another contract than `HOST_CONTRACT`, a
 * loader option out of its range (the loader's TypeError), and a filesystem error without an errno code.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { types } from "node:util";
import { admitted, type LateSettle, loadPackage, registerAdmitted } from "@libredb/provider-loader";
import { checkProviderModule, PROVIDER_CONTRACT, type ProviderImpl } from "@libredb/provider-sdk/calls";
import {
  compileManifestValidator,
  type ManifestValidator,
  type ProviderManifest,
} from "@libredb/provider-sdk/manifest";
import { LEGACY_ENGINE_IDS, LEGACY_SOURCE_NAME } from "./legacy-adapter/identity";
import {
  type ArtifactFile,
  decodeJson,
  MANIFEST_BYTE_CAP,
  MANIFEST_FILE_NAME,
  PACKAGE_JSON_BYTE_CAP,
  readBoundedFile,
} from "./provider-artifact";
import { closureOutside } from "./provider-closure";
import {
  admissionRefusal,
  admittedCollisionRefusal,
  bundledEngineRefusal,
  contractRefusal,
  definitionRefusal,
  type PackageName,
  type PackageRefusal,
  packageRefusal,
  schemaRefusal,
} from "./provider-refusals";
import type { VerifiedPackage } from "./providers-lock";

/** The provider contract this Studio serves: the SDK's `PROVIDER_CONTRACT` and its schema's, held equal by a test. */
export const HOST_CONTRACT = "0.1";

/** The envelope's form of a contract, `MAJOR.MINOR`. */
const CONTRACT_FORM = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/** A TypeScript file by its extension, in any letter case, a declaration file among them. */
const TYPESCRIPT_FILE = /\.(?:[mc]?ts|tsx)$/i;

/** The implementation's segments, each read by its descriptor and frozen once admitted. */
const IMPL_SEGMENTS = ["console", "objects", "maintenance", "monitoring"] as const;

/**
 * The manifest validator boot compiles once for every package, from the bytes of the SDK's `manifest.schema.json`.
 *
 * @throws {ManifestSchemaDigestError} For any bytes but the schema the SDK was built with.
 */
export function hostManifestValidator(schemaBytes: Uint8Array): ManifestValidator {
  return compileManifestValidator(schemaBytes);
}

/** What admission needs besides the package. */
export interface AdmissionOptions {
  /** From `hostManifestValidator`, compiled once per boot. */
  readonly validator: ManifestValidator;
  /** The loader's import deadline, a whole number of milliseconds. */
  readonly deadlineMs: number;
  /** The loader's port for an import that settles after its refusal. */
  readonly onLateSettle: (settle: LateSettle) => void;
}

/** Studio's record of an admitted package, the one registered. */
export interface AdmittedProviderRecord {
  readonly contract: typeof PROVIDER_CONTRACT;
  readonly manifest: ProviderManifest;
  /** The implementation `checkProviderModule` proved, the one every session of the package opens on. */
  readonly impl: ProviderImpl<unknown>;
}

/** A package admitted, or refused with its first refusal. */
export type PackageAdmission =
  | {
      readonly admitted: true;
      readonly name: string;
      readonly version: string;
      readonly engines: readonly string[];
      readonly manifest: ProviderManifest;
      readonly record: AdmittedProviderRecord;
    }
  | {
      readonly admitted: false;
      readonly name: string;
      readonly version: string;
      readonly refusal: PackageRefusal;
      /** The value the entry threw, on `import-threw` only, for the host's log; never in the sentence. */
      readonly cause?: unknown;
    };

/** Thrown inside admission to answer a refusal. */
class Refused {
  constructor(
    readonly refusal: PackageRefusal,
    readonly cause?: unknown,
  ) {}
}

/** `value` frozen with every object and array it holds, by an iterative walk, so no depth exhausts the stack. */
function deepFreeze<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next !== "object" || next === null || Object.isFrozen(next)) continue;
    Object.freeze(next);
    for (const member of Object.values(next)) pending.push(member);
  }
  return value;
}

/**
 * The bytes of the listed file `file` of `pkg` within `cap`, its SHA-256 the listing's; `over-cap` when it is longer
 * than `cap`. Nothing at the path, another kind of file, or other bytes is `digest-differs`, since the file changed
 * after the lock's read; any other filesystem error is `artifact-unreadable` naming its errno.
 */
function readListed(pkg: VerifiedPackage, file: ArtifactFile, cap: number): Buffer | "over-cap" {
  const read = readBoundedFile(path.join(pkg.directory, ...file.path.split("/")), cap);
  if (!read.ok) {
    if (read.failure === "over-cap") return "over-cap";
    if (read.failure === "unreadable") {
      throw new Refused(
        packageRefusal(pkg, { code: "PROVIDER_DIGEST_MISMATCH", rule: "artifact-unreadable", errno: read.errno }),
      );
    }
    throw new Refused(packageRefusal(pkg, { code: "PROVIDER_DIGEST_MISMATCH", rule: "digest-differs" }));
  }
  if (createHash("sha256").update(read.bytes).digest("hex") !== file.sha256) {
    throw new Refused(packageRefusal(pkg, { code: "PROVIDER_DIGEST_MISMATCH", rule: "digest-differs" }));
  }
  return read.bytes;
}

/** Whether `value` is a JSON object: not null, not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The listed file at `relative`, or undefined. */
function listed(pkg: VerifiedPackage, relative: string): ArtifactFile | undefined {
  return pkg.files.find((file) => file.path === relative);
}

/** The package's manifest, read, bound to the listing and admitted by the validator, deep-frozen. */
function admitManifest(pkg: VerifiedPackage, validator: ManifestValidator): ProviderManifest {
  const file = listed(pkg, MANIFEST_FILE_NAME);
  // The lock's read read the manifest within its cap, so an unlisted or longer one changed since.
  const bytes = file === undefined ? undefined : readListed(pkg, file, MANIFEST_BYTE_CAP);
  if (bytes === undefined || bytes === "over-cap") {
    throw new Refused(packageRefusal(pkg, { code: "PROVIDER_DIGEST_MISMATCH", rule: "digest-differs" }));
  }
  const value = decodeJson(bytes)?.value;
  if (!isObject(value)) throw new Refused(schemaRefusal(pkg, "wrong-type", "", 0));
  const contract = Object.hasOwn(value, "contract") ? value.contract : undefined;
  if (typeof contract === "string" && CONTRACT_FORM.test(contract) && contract !== HOST_CONTRACT) {
    throw new Refused(contractRefusal(pkg, HOST_CONTRACT));
  }
  const verdict = validator.validate(value);
  if (!verdict.admitted) {
    const [first] = verdict.refusals;
    if (first === undefined)
      throw new Error("admitPackage: the manifest validator refused a manifest without a refusal");
    if (first.code === "PROVIDER_CONTRACT_UNSUPPORTED") throw new Refused(contractRefusal(pkg, HOST_CONTRACT));
    throw new Refused(schemaRefusal(pkg, first.rule, first.pointer, verdict.refusals.length - 1));
  }
  return deepFreeze(verdict.manifest);
}

/** The engine ids of the records admitted so far in this process; only admission registers, so each is Studio's. */
function registeredEngineIds(): Set<string> {
  const ids = new Set<string>();
  for (const { record } of admitted()) {
    for (const engine of (record as AdmittedProviderRecord).manifest.engines) ids.add(engine.id);
  }
  return ids;
}

/** Refuses an engine id or a package name already served. */
function checkServed(pkg: VerifiedPackage, manifest: ProviderManifest): void {
  const ids = manifest.engines.map((engine) => engine.id);
  if (ids.some((id) => LEGACY_ENGINE_IDS.includes(id))) throw new Refused(bundledEngineRefusal(pkg));
  if (pkg.name === LEGACY_SOURCE_NAME) throw new Refused(admittedCollisionRefusal(pkg, "legacy-package"));
  if (ids.some((id) => Object.hasOwn(Object.prototype, id))) {
    throw new Refused(admittedCollisionRefusal(pkg, "inherited-name"));
  }
  const collision = registeredCollision(pkg, manifest);
  if (collision !== undefined) throw new Refused(collision);
}

/**
 * The refusal of an engine id or a package name a package registered in this process serves, or undefined. Admission
 * reads it before the import, and `registerAdmission` again right before it registers, with no `await` between that read
 * and `registerAdmitted`, so two packages registered in one process never serve one engine id or share one name.
 */
function registeredCollision(pkg: PackageName, manifest: ProviderManifest): PackageRefusal | undefined {
  const ids = manifest.engines.map((engine) => engine.id);
  const registered = registeredEngineIds();
  if (ids.some((id) => registered.has(id))) return admittedCollisionRefusal(pkg, "registered-engine");
  if (admitted().some((record) => record.name === pkg.name)) {
    return admittedCollisionRefusal(pkg, "registered-package");
  }
  return undefined;
}

/**
 * Refuses an entry that is not an ES module: an `.mjs` is one, and a `.js` only when the nearest package.json from its
 * directory up to the package's root, or up to a directory named `node_modules`, declares `"type": "module"`.
 */
function checkEntryFormat(pkg: VerifiedPackage, entry: string): void {
  if (entry.endsWith(".mjs")) return;
  const scope = nearestPackageJson(pkg, entry);
  if (scope === undefined) {
    throw new Refused(admissionRefusal(pkg, { code: "PROVIDER_MODULE_FORMAT", rule: "entry-commonjs" }));
  }
  const bytes = readListed(pkg, scope, PACKAGE_JSON_BYTE_CAP);
  const value = bytes === "over-cap" ? undefined : decodeJson(bytes)?.value;
  if (!isObject(value)) {
    throw new Refused(admissionRefusal(pkg, { code: "PROVIDER_MODULE_FORMAT", rule: "package-scope-unreadable" }));
  }
  if (ownData(value, "type")?.value !== "module") {
    throw new Refused(admissionRefusal(pkg, { code: "PROVIDER_MODULE_FORMAT", rule: "entry-commonjs" }));
  }
}

/**
 * The listed package.json nearest the entry at `entry`, from its directory up to the package's root; none once the walk
 * reaches a directory named `node_modules`, where Node.js's package scope lookup stops without reading one.
 */
function nearestPackageJson(pkg: VerifiedPackage, entry: string): ArtifactFile | undefined {
  for (let directory = path.posix.dirname(entry); ; directory = path.posix.dirname(directory)) {
    if (path.posix.basename(directory) === "node_modules") return undefined;
    const found = listed(pkg, directory === "." ? "package.json" : `${directory}/package.json`);
    if (found !== undefined || directory === ".") return found;
  }
}

/**
 * Refuses a package whose listing holds a TypeScript file, a declaration file among them, whatever its imports: Bun
 * maps an extensionless, a `.d` and a `.js` specifier onto a TypeScript file and runs it, and Node.js's type stripping
 * loads an import Bun's scanner drops, so the record cannot hold every import a TypeScript file makes.
 */
function checkTypeScript(pkg: VerifiedPackage): void {
  if (pkg.files.some((file) => TYPESCRIPT_FILE.test(file.path))) {
    throw new Refused(admissionRefusal(pkg, { code: "PROVIDER_MODULE_FORMAT", rule: "typescript-module" }));
  }
}

/** The value of the own data property `key` of `target`, or undefined for an accessor or none; no getter is called. */
function ownData(target: object, key: string): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && "value" in descriptor ? { value: descriptor.value } : undefined;
}

/**
 * Whether `actual`, read from a package's record, equals `expected`, the JSON value of its manifest file: for a
 * primitive by `Object.is`; for an array, an array no Proxy with `Array.prototype` as its prototype, exactly the
 * indices and `length` as own keys, and the file's `length`, so a trailing hole is a difference; for an object, no Proxy, of prototype `Object.prototype` or null, with exactly the
 * file's keys as own keys, symbols counted; every member a data property equal again. The walk follows `expected`, so
 * it ends however `actual` is built, and no getter or trap runs.
 */
function equalsFile(expected: unknown, actual: unknown): boolean {
  const pending: [unknown, unknown][] = [[expected, actual]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [want, got] = pair;
    if (typeof want !== "object" || want === null) {
      if (!Object.is(want, got)) return false;
      continue;
    }
    if (typeof got !== "object" || got === null || types.isProxy(got)) return false;
    const prototype = Object.getPrototypeOf(got);
    const wantArray = Array.isArray(want);
    if (wantArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    if (Array.isArray(got) !== wantArray) return false;
    const keys = Object.keys(want);
    if (Reflect.ownKeys(got).length !== keys.length + (wantArray ? 1 : 0)) return false;
    if (wantArray && (got as unknown[]).length !== (want as unknown[]).length) return false;
    for (const key of keys) {
      const member = ownData(got, key);
      if (member === undefined) return false;
      pending.push([(want as Record<string, unknown>)[key], member.value]);
    }
  }
  return true;
}

/** The record's implementation, refused when it or a segment is a Proxy; undefined when it is no data object. */
function checkImplProxies(pkg: VerifiedPackage, record: object): object | undefined {
  const impl = ownData(record, "impl")?.value;
  if (typeof impl !== "object" || impl === null) return undefined;
  const proxied =
    types.isProxy(impl) ||
    IMPL_SEGMENTS.some((segment) => {
      const value = ownData(impl, segment)?.value;
      return typeof value === "object" && value !== null && types.isProxy(value);
    });
  if (proxied) throw new Refused(admissionRefusal(pkg, { code: "PROVIDER_RECORD_INVALID", rule: "record-proxy" }));
  return impl;
}

/** The admission of `pkg`, before its answer is built; every refusal is thrown as `Refused`. */
async function admit(pkg: VerifiedPackage, options: AdmissionOptions): Promise<AdmittedProviderRecord> {
  const manifest = admitManifest(pkg, options.validator);
  checkServed(pkg, manifest);
  checkEntryFormat(pkg, manifest.runtime.entry);
  checkTypeScript(pkg);
  if (closureOutside(pkg.imports)) {
    throw new Refused(admissionRefusal(pkg, { code: "PROVIDER_LOAD_FAILED", rule: "closure-outside" }));
  }
  if (pkg.files.some((file) => file.path.toLowerCase().endsWith(".node"))) {
    throw new Refused(admissionRefusal(pkg, { code: "PROVIDER_NATIVE_UNSUPPORTED", rule: "native-file" }));
  }
  if (Object.hasOwn(manifest.runtime, "native")) {
    throw new Refused(admissionRefusal(pkg, { code: "PROVIDER_NATIVE_UNSUPPORTED", rule: "native-declared" }));
  }
  const loaded = await loadPackage(pkg.entryFile, {
    deadlineMs: options.deadlineMs,
    onLateSettle: options.onLateSettle,
  });
  if (!loaded.loaded) {
    throw new Refused(admissionRefusal(pkg, { code: "PROVIDER_LOAD_FAILED", rule: loaded.reason }), loaded.cause);
  }
  const { record } = loaded;
  if (!equalsFile(manifest, ownData(record, "manifest")?.value)) {
    throw new Refused(admissionRefusal(pkg, { code: "PROVIDER_RECORD_INVALID", rule: "manifest-differs" }));
  }
  const impl = checkImplProxies(pkg, record);
  const refusals = checkProviderModule(record);
  const [first] = refusals;
  if (first !== undefined) throw new Refused(definitionRefusal(pkg, first.rule, refusals.length - 1));
  // The SDK's check admitted the implementation and each segment present as data records.
  for (const segment of IMPL_SEGMENTS) {
    const value = ownData(impl as object, segment)?.value;
    if (value !== undefined) Object.freeze(value);
  }
  return Object.freeze({
    contract: PROVIDER_CONTRACT,
    manifest,
    // `checkProviderModule` proved it a `ProviderImpl` above: the one place its type is read.
    impl: Object.freeze(impl as ProviderImpl<unknown>),
  });
}

/**
 * Admits the package `pkg`, which its lock read verified, and answers Studio's record of it, unregistered; or answers
 * its first refusal, naming the package by name and version and nothing it holds.
 *
 * @throws {TypeError} When `options.validator` serves another contract than `HOST_CONTRACT`, before any file is read.
 */
export async function admitPackage(pkg: VerifiedPackage, options: AdmissionOptions): Promise<PackageAdmission> {
  if (options.validator.contract !== HOST_CONTRACT) {
    throw new TypeError(
      `admitPackage: the validator serves provider contract ${options.validator.contract}, and this Studio serves ${HOST_CONTRACT}`,
    );
  }
  const named: PackageName = { name: pkg.name, version: pkg.version };
  try {
    const record = await admit(pkg, options);
    return Object.freeze({
      admitted: true,
      ...named,
      engines: pkg.engines,
      manifest: record.manifest,
      record,
    });
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return Object.freeze({
      admitted: false,
      ...named,
      refusal: error.refusal,
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    });
  }
}

/** A package admission admitted. */
export type AdmittedPackage = Extract<PackageAdmission, { readonly admitted: true }>;

/**
 * Registers Studio's record of `admission` in the loader's registry under the package's name, once boot's set rules
 * kept it; or answers `PROVIDER_ID_COLLISION` when a package registered in this process meanwhile serves one of its
 * engine ids (`registered-engine`) or has its name (`registered-package`), and registers nothing. The check and the
 * registration run with no `await` between them.
 */
export function registerAdmission(admission: AdmittedPackage): PackageRefusal | undefined {
  const collision = registeredCollision(admission, admission.manifest);
  if (collision !== undefined) return collision;
  registerAdmitted(admission.name, admission.record);
  return undefined;
}
