/**
 * The refusals of a provider package read from the providers directory (docs/providers/CONTRACT.md, clauses C-91 to
 * C-96): one closed list of codes, each with its closed list of rules, and the records and one-line sentences that
 * carry them.
 *
 * A package's refusal names the package by the name and version its lock entry gives, which the lock's format has
 * already checked, and never carries a value read from the package: no file name inside its directory, no value of its
 * package.json or its manifest, no engine id. A lock's refusal names the lock file, the rule and, for a rule of the
 * lock's shape, the JSON pointer and the key, both read from the operator's own lock. An errno code may be named.
 */
import { quoteTypeId } from "@/lib/db/type-id";

/** Every code a provider package or its lock is refused with. Milestone 1's later admission steps append theirs. */
export const PROVIDER_REFUSAL_CODES = Object.freeze([
  "PROVIDER_LOCK_INVALID",
  "PROVIDER_PATH_OUTSIDE",
  "PROVIDER_DIGEST_MISMATCH",
  "PROVIDER_IDENTITY_MISMATCH",
  "PROVIDER_ID_COLLISION",
] as const);

export type ProviderRefusalCode = (typeof PROVIDER_REFUSAL_CODES)[number];

/** The rules of the lock's shape, in the vocabulary of the SDK's manifest validator. */
const LOCK_SHAPE_RULES = [
  "unknown-key",
  "missing-key",
  "wrong-type",
  "value-not-allowed",
  "pattern-mismatch",
  "out-of-range",
  "too-few",
  "too-many",
  "duplicate",
] as const;

/** The rules of the providers directory and its lock as a whole. */
const LOCK_FILE_RULES = [
  "directory-missing",
  "directory-not-a-directory",
  "directory-unreadable",
  "lock-missing",
  "lock-not-a-file",
  "lock-unreadable",
  "lock-over-cap",
  "lock-not-json",
] as const;

/** Each code's closed list of rules. */
export const PROVIDER_REFUSAL_RULES = Object.freeze({
  PROVIDER_LOCK_INVALID: Object.freeze([...LOCK_FILE_RULES, ...LOCK_SHAPE_RULES]),
  PROVIDER_PATH_OUTSIDE: Object.freeze([
    "directory-outside",
    "artifact-link",
    "artifact-special-file",
    "entry-not-a-file",
  ] as const),
  PROVIDER_DIGEST_MISMATCH: Object.freeze([
    "artifact-missing",
    "artifact-unreadable",
    "artifact-name",
    "artifact-over-limit",
    "digest-differs",
  ] as const),
  PROVIDER_IDENTITY_MISMATCH: Object.freeze([
    "package-json-unreadable",
    "name",
    "version",
    "manifest-unreadable",
    "engines",
    "entry",
  ] as const),
  PROVIDER_ID_COLLISION: Object.freeze(["bundled-engine", "shared-engine"] as const),
});

export type LockShapeRule = (typeof LOCK_SHAPE_RULES)[number];
export type LockRule = (typeof PROVIDER_REFUSAL_RULES)["PROVIDER_LOCK_INVALID"][number];
type PackageCode = Exclude<ProviderRefusalCode, "PROVIDER_LOCK_INVALID">;

/** A refusal of one package, before the package's name and version are added: what the artifact module answers. */
export type ArtifactFault = {
  [Code in Exclude<PackageCode, "PROVIDER_ID_COLLISION">]: {
    readonly code: Code;
    readonly rule: (typeof PROVIDER_REFUSAL_RULES)[Code][number];
    readonly errno?: string;
  };
}[Exclude<PackageCode, "PROVIDER_ID_COLLISION">];

/** A package as its lock entry names it. */
export interface PackageName {
  readonly name: string;
  readonly version: string;
}

/** The refusal of one package of the lock. */
export interface PackageRefusal {
  readonly code: PackageCode;
  readonly rule: string;
  readonly name: string;
  readonly version: string;
  /** The errno code of the filesystem's answer, for `artifact-unreadable`. */
  readonly errno?: string;
  /** For `shared-engine`: every other entry that serves one of this entry's engine ids, by name and version. */
  readonly others?: readonly PackageName[];
  /** `<code>: <name> <version>: <why>`, on one line. */
  readonly sentence: string;
}

/** The refusal of the lock as a whole. */
export interface LockRefusal {
  readonly code: "PROVIDER_LOCK_INVALID";
  readonly rule: LockRule;
  /** The lock file, `providers.lock.json` in the providers directory. */
  readonly lockFile: string;
  /** For a rule of the lock's shape: the JSON pointer of the value refused. */
  readonly pointer?: string;
  /** For `unknown-key` and `missing-key`: the key, as the lock spells it or as the format requires it. */
  readonly key?: string;
  /** The errno code of the filesystem's answer, for `directory-unreadable` and `lock-unreadable`. */
  readonly errno?: string;
  /** `PROVIDER_LOCK_INVALID: <lock file>: <why>`, on one line. */
  readonly sentence: string;
}

/** Why a package is refused, by rule. */
const PACKAGE_SENTENCES: Readonly<Record<string, string>> = {
  "directory-outside": "its directory resolves outside the providers directory",
  "artifact-link": "its directory holds a symbolic link or junction, which is never followed",
  "artifact-special-file":
    "its directory holds an entry that is neither a regular file nor a directory, which is never opened",
  "entry-not-a-file": "the entry its manifest names is not a regular file of its directory",
  "artifact-missing": "its directory does not exist",
  "artifact-unreadable": "its directory could not be read",
  "artifact-name": "its directory holds a name outside letters, digits and . _ - @ + ~, or longer than 255 characters",
  "artifact-over-limit": "its directory holds more files or more levels of directories than an artifact may",
  "digest-differs": "its files differ from the digest its lock entry pins",
  "package-json-unreadable": "its package.json is missing, over its byte limit, or not a JSON object",
  name: "its package.json names another package name",
  version: "its package.json names another version",
  "manifest-unreadable":
    "its libredb-provider.json is missing, over its byte limit, not a JSON object, or its engines or runtime.entry are not in their form",
  engines: "its manifest serves other engine ids than its lock entry names",
  entry: "its manifest names another entry than its lock entry",
  "bundled-engine": "it serves an engine id Studio's bundled catalog serves",
  "shared-engine": "it serves an engine id another entry of the lock serves too",
};

/** Why a lock is refused, by rule. */
const LOCK_SENTENCES: Readonly<Record<LockRule, string>> = {
  "directory-missing": "the providers directory does not exist",
  "directory-not-a-directory": "the providers directory is not a directory",
  "directory-unreadable": "the providers directory could not be read",
  "lock-missing": "the lock does not exist",
  "lock-not-a-file": "the lock is not a regular file",
  "lock-unreadable": "the lock could not be read",
  "lock-over-cap": "the lock is over its byte limit",
  "lock-not-json": "the lock is not UTF-8 JSON without a byte order mark",
  "unknown-key": "the key is not in the lock's format",
  "missing-key": "the key is missing",
  "wrong-type": "the value is not of its type",
  "value-not-allowed": "the value is not one the format allows",
  "pattern-mismatch": "the value is not in its form",
  "out-of-range": "the value is longer than its form allows",
  "too-few": "the list has fewer items than its form allows",
  "too-many": "the list has more items than its form allows",
  duplicate: "the value appears twice",
};

/** ` (<errno>)` when there is one. */
function errnoSuffix(errno: string | undefined): string {
  return errno === undefined ? "" : ` (${errno})`;
}

/** The refusal of a package the artifact module refused. */
export function packageRefusal(pkg: PackageName, fault: ArtifactFault): PackageRefusal {
  const sentence = `${fault.code}: ${pkg.name} ${pkg.version}: ${PACKAGE_SENTENCES[fault.rule]}${errnoSuffix(fault.errno)}`;
  return Object.freeze({
    code: fault.code,
    rule: fault.rule,
    name: pkg.name,
    version: pkg.version,
    ...(fault.errno === undefined ? {} : { errno: fault.errno }),
    sentence,
  });
}

/** The refusal of a package that serves an engine id the bundled catalog serves. */
export function bundledEngineRefusal(pkg: PackageName): PackageRefusal {
  return Object.freeze({
    code: "PROVIDER_ID_COLLISION",
    rule: "bundled-engine",
    name: pkg.name,
    version: pkg.version,
    sentence: `PROVIDER_ID_COLLISION: ${pkg.name} ${pkg.version}: ${PACKAGE_SENTENCES["bundled-engine"]}`,
  });
}

/** The refusal of a package that serves an engine id `others` serve too. */
export function sharedEngineRefusal(pkg: PackageName, others: readonly PackageName[]): PackageRefusal {
  const named = others.map((other) => `${other.name} ${other.version}`).join(", ");
  return Object.freeze({
    code: "PROVIDER_ID_COLLISION",
    rule: "shared-engine",
    name: pkg.name,
    version: pkg.version,
    others: Object.freeze(others.map((other) => Object.freeze({ name: other.name, version: other.version }))),
    sentence: `PROVIDER_ID_COLLISION: ${pkg.name} ${pkg.version}: ${PACKAGE_SENTENCES["shared-engine"]}: ${named}`,
  });
}

/** What a lock refusal adds to its rule: the pointer and key of a shape rule, the errno code of a file rule. */
export interface LockRefusalDetail {
  readonly pointer?: string;
  readonly key?: string;
  readonly errno?: string;
}

/** The refusal of the lock as a whole. */
export function lockRefusal(lockFile: string, rule: LockRule, detail: LockRefusalDetail = {}): LockRefusal {
  const at = detail.pointer === undefined ? "" : `${rule} at ${detail.pointer === "" ? "the top" : detail.pointer}: `;
  const key = detail.key === undefined ? "" : ` (key ${quoteTypeId(detail.key)})`;
  return Object.freeze({
    code: "PROVIDER_LOCK_INVALID",
    rule,
    lockFile,
    ...detail,
    sentence: `PROVIDER_LOCK_INVALID: ${lockFile}: ${at}${LOCK_SENTENCES[rule]}${key}${errnoSuffix(detail.errno)}`,
  });
}
