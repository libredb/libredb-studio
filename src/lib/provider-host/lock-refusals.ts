/**
 * The refusals of a providers directory's lock and of a package's artifact (docs/providers/CONTRACT.md, clauses C-91 to
 * C-94): the rules of the lock as a whole and of its shape, and the sentences of the lock's rules and of the rules the
 * artifact module (`./provider-artifact`) answers. The lock command (scripts/providers-lock.ts) prints these sentences
 * and ships to operators, so this module imports by value only `quoteOneLine`, which imports nothing: the lock command
 * reaches neither the SDK nor Studio's engine catalog through it. The other refusals of a package, and the types of
 * every refusal, live in `./provider-refusals`, which builds its closed lists from the two rule lists here.
 *
 * A package's refusal names the package by the name and version its lock entry gives, which the lock's format has
 * already checked, and never carries a value read from the package: no file name inside its directory, no value of its
 * package.json or its manifest, no engine id, no key the package chose. A lock's refusal names the lock file, the rule
 * and, for a rule of the lock's shape, the JSON pointer and the key, both read from the operator's own lock. An errno
 * code may be named.
 */
import { quoteOneLine } from "@/lib/one-line-quote";
import type {
  ArtifactFault,
  LockRefusal,
  LockRefusalDetail,
  LockRule,
  PackageName,
  PackageRefusal,
} from "./provider-refusals";

/** The rules of the lock's shape, in the vocabulary of the SDK's manifest validator. */
export const LOCK_SHAPE_RULES = [
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
export const LOCK_FILE_RULES = [
  "directory-missing",
  "directory-not-a-directory",
  "directory-unreadable",
  "lock-missing",
  "lock-not-a-file",
  "lock-unreadable",
  "lock-over-cap",
  "lock-not-json",
] as const;

/** Why the artifact module refuses a package, by rule. */
const ARTIFACT_SENTENCES: Readonly<Record<ArtifactFault["rule"], string>> = {
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

/** Why the artifact module refused a package, in the lock's words: its rule's sentence and its errno code, if any. */
export function artifactFaultReason(fault: ArtifactFault): string {
  return `${ARTIFACT_SENTENCES[fault.rule]}${errnoSuffix(fault.errno)}`;
}

/** The refusal of a package the artifact module refused. */
export function packageRefusal(pkg: PackageName, fault: ArtifactFault): PackageRefusal {
  const sentence = `${fault.code}: ${pkg.name} ${pkg.version}: ${artifactFaultReason(fault)}`;
  return Object.freeze({
    code: fault.code,
    rule: fault.rule,
    name: pkg.name,
    version: pkg.version,
    ...(fault.errno === undefined ? {} : { errno: fault.errno }),
    sentence,
  });
}

/** The refusal of the lock as a whole. */
export function lockRefusal(lockFile: string, rule: LockRule, detail: LockRefusalDetail = {}): LockRefusal {
  const at = detail.pointer === undefined ? "" : `${rule} at ${detail.pointer === "" ? "the top" : detail.pointer}: `;
  const key = detail.key === undefined ? "" : ` (key ${quoteOneLine(detail.key)})`;
  return Object.freeze({
    code: "PROVIDER_LOCK_INVALID",
    rule,
    lockFile,
    ...detail,
    sentence: `PROVIDER_LOCK_INVALID: ${lockFile}: ${at}${LOCK_SENTENCES[rule]}${key}${errnoSuffix(detail.errno)}`,
  });
}
