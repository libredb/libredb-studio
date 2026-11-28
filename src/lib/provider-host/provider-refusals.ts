/**
 * The refusals of a provider package read from the providers directory, admitted and composed into the server's engine
 * catalog (docs/providers/CONTRACT.md, clauses C-91 to C-106): one closed list of codes, each with its closed list of rules, and the records and one-line
 * sentences that carry them.
 *
 * A package's refusal names the package by the name and version its lock entry gives, which the lock's format has
 * already checked, and never carries a value read from the package: no file name inside its directory, no value of its
 * package.json or its manifest, no engine id, no key the package chose. The rules of `PROVIDER_SCHEMA_INVALID` and
 * `PROVIDER_RECORD_INVALID` are the SDK's own lists, imported; an admission refusal names the first one, with the
 * manifest's JSON pointer for a schema rule (every object of the schema is closed but `vendor`, which no rule points
 * into, so a pointer holds only the schema's own names and list positions), and how many more there are.
 *
 * The lock's rules and sentences and the sentences of the artifact module's rules live in `./lock-refusals`, with
 * `lockRefusal`, `packageRefusal` and `artifactFaultReason`: the lock command (scripts/providers-lock.ts) prints them and
 * ships to operators, so it reaches neither the SDK this module imports nor Studio's engine catalog. This module keeps
 * the types of every refusal and the sentences of the refusals only Studio's read and admission draw.
 */
import { DEFINITION_REFUSAL_RULES } from "@libredb/provider-sdk/calls";
import { SCHEMA_REFUSAL_RULES } from "@libredb/provider-sdk/manifest";
import { LOCK_FILE_RULES, LOCK_SHAPE_RULES } from "./lock-refusals";

/**
 * The rules across the whole set of admitted packages, Studio's bundled catalog and Studio's grant register
 * (`catalogConflicts` in src/lib/db/server-catalog-compose.ts, and `moduleMcpToolConflicts` there for the module
 * languages' MCP statement tools boot's caller hands), each the rule of a `PROVIDER_CATALOG_CONFLICT` refusal. Kept
 * here with the other closed rule lists, so a module that refuses a package reaches no record of the server's engine
 * catalog.
 */
export const CATALOG_CONFLICT_RULES = Object.freeze([
  "engine-id",
  "fence-alias",
  "query-dialect",
  "tab-type",
  "editor-language",
  "statement-language",
  "mcp-tool",
] as const);

export type CatalogConflictRule = (typeof CATALOG_CONFLICT_RULES)[number];

/** Every code a provider package or its lock is refused with. */
export const PROVIDER_REFUSAL_CODES = Object.freeze([
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
] as const);

export type ProviderRefusalCode = (typeof PROVIDER_REFUSAL_CODES)[number];

/** The provider loader's refusal reasons (src/lib/provider-loader/index.d.cts, `LoadRefusalReason`), by value. */
export const LOADER_REFUSAL_REASONS = Object.freeze([
  "import-threw",
  "deadline-passed",
  "default-missing",
  "interop-wrapper",
  "not-a-record",
] as const);

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
  PROVIDER_ID_COLLISION: Object.freeze([
    "bundled-engine",
    "shared-engine",
    "registered-engine",
    "registered-package",
    "inherited-name",
    "legacy-package",
  ] as const),
  PROVIDER_CONTRACT_UNSUPPORTED: Object.freeze(["contract-not-served"] as const),
  PROVIDER_SCHEMA_INVALID: SCHEMA_REFUSAL_RULES,
  PROVIDER_MODULE_FORMAT: Object.freeze(["entry-commonjs", "package-scope-unreadable", "typescript-module"] as const),
  PROVIDER_LOAD_FAILED: Object.freeze(["closure-outside", ...LOADER_REFUSAL_REASONS] as const),
  PROVIDER_NATIVE_UNSUPPORTED: Object.freeze(["native-file", "native-declared"] as const),
  PROVIDER_RECORD_INVALID: Object.freeze([...DEFINITION_REFUSAL_RULES, "record-proxy", "manifest-differs"] as const),
  PROVIDER_CATALOG_CONFLICT: CATALOG_CONFLICT_RULES,
});

export type LockShapeRule = (typeof LOCK_SHAPE_RULES)[number];
export type LockRule = (typeof PROVIDER_REFUSAL_RULES)["PROVIDER_LOCK_INVALID"][number];
type PackageCode = Exclude<ProviderRefusalCode, "PROVIDER_LOCK_INVALID">;
/** The codes the artifact module answers. */
type ArtifactCode = "PROVIDER_PATH_OUTSIDE" | "PROVIDER_DIGEST_MISMATCH" | "PROVIDER_IDENTITY_MISMATCH";

/** A rule of `code`. */
export type RuleOf<Code extends ProviderRefusalCode> = (typeof PROVIDER_REFUSAL_RULES)[Code][number];

/** A refusal of one package, before the package's name and version are added: what the artifact module answers. */
export type ArtifactFault = {
  [Code in ArtifactCode]: {
    readonly code: Code;
    readonly rule: RuleOf<Code>;
    readonly errno?: string;
  };
}[ArtifactCode];

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
  /** For `PROVIDER_SCHEMA_INVALID`: the JSON pointer into the manifest of the first refusal, `""` its top level. */
  readonly pointer?: string;
  /** For `PROVIDER_SCHEMA_INVALID` and an SDK rule of `PROVIDER_RECORD_INVALID`: how many more refusals there are. */
  readonly more?: number;
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

/** Why a package is refused for an engine id or a name it collides on, by rule. */
const PACKAGE_SENTENCES: Readonly<Record<string, string>> = {
  "bundled-engine": "it serves an engine id Studio's bundled catalog serves",
  "shared-engine": "it serves an engine id another entry of the lock serves too",
  "registered-engine": "it serves an engine id a package admitted earlier in this process serves",
  "registered-package": "a package of its name was admitted earlier in this process",
  "inherited-name": "it serves an engine id that names a member every JavaScript object inherits",
  "legacy-package": "its name is the name LibreDB Studio serves its bundled engines under",
};

/** Why a package is refused at admission, by code and rule, for the rules whose sentence is fixed. */
const ADMISSION_SENTENCES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  PROVIDER_MODULE_FORMAT: {
    "entry-commonjs": 'its entry is a .js file whose nearest package.json does not declare "type": "module"',
    "package-scope-unreadable": "the package.json nearest its entry is over its byte limit or not a JSON object",
    "typescript-module":
      "its directory holds a TypeScript file, which a package of this contract, a JavaScript bundle, does not hold",
  },
  PROVIDER_LOAD_FAILED: {
    "closure-outside":
      "a module of it imports what its directory does not hold, or in a form admission does not resolve inside it",
    "import-threw": "its entry threw while it was imported",
    "deadline-passed": "its entry did not finish importing within its deadline",
    "default-missing": "its entry has no default export",
    "interop-wrapper": "its entry's default is a CommonJS interop wrapper",
    "not-a-record": "its entry's default is not a plain record",
  },
  PROVIDER_NATIVE_UNSUPPORTED: {
    "native-file": "its directory holds a native addon, a .node file, which this Studio does not admit yet",
    "native-declared": "its manifest declares native packages, which this Studio does not admit yet",
  },
  PROVIDER_RECORD_INVALID: {
    "record-proxy": "its record's implementation is a Proxy",
    "manifest-differs": "its record's manifest differs from its libredb-provider.json",
  },
};

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

/**
 * The refusal of a package of a collision found at admission: `registered-*`, `inherited-name`, or `legacy-package`, a
 * package named as LibreDB Studio's legacy adapter serves its bundled engines.
 */
export function admittedCollisionRefusal(
  pkg: PackageName,
  rule: "registered-engine" | "registered-package" | "inherited-name" | "legacy-package",
): PackageRefusal {
  return Object.freeze({
    code: "PROVIDER_ID_COLLISION",
    rule,
    name: pkg.name,
    version: pkg.version,
    sentence: `PROVIDER_ID_COLLISION: ${pkg.name} ${pkg.version}: ${PACKAGE_SENTENCES[rule]}`,
  });
}

/** The refusal of a package whose manifest names a contract other than `served`, the one this Studio serves. */
export function contractRefusal(pkg: PackageName, served: string): PackageRefusal {
  return Object.freeze({
    code: "PROVIDER_CONTRACT_UNSUPPORTED",
    rule: "contract-not-served",
    name: pkg.name,
    version: pkg.version,
    sentence: `PROVIDER_CONTRACT_UNSUPPORTED: ${pkg.name} ${pkg.version}: its manifest was built against another provider contract than this Studio's, ${served}`,
  });
}

/** `, and <n> more` when `more` is above zero. */
function moreSuffix(more: number): string {
  return more > 0 ? `, and ${more} more` : "";
}

/** The refusal of a package whose manifest the SDK's validator refused, at the first refusal's rule and pointer. */
export function schemaRefusal(
  pkg: PackageName,
  rule: RuleOf<"PROVIDER_SCHEMA_INVALID">,
  pointer: string,
  more: number,
): PackageRefusal {
  const at = pointer === "" ? "the top level" : pointer;
  return Object.freeze({
    code: "PROVIDER_SCHEMA_INVALID",
    rule,
    name: pkg.name,
    version: pkg.version,
    pointer,
    more,
    sentence: `PROVIDER_SCHEMA_INVALID: ${pkg.name} ${pkg.version}: its manifest is not one the provider contract admits: ${rule} at ${at}${moreSuffix(more)}`,
  });
}

/** The refusal of a package whose record the SDK's `checkProviderModule` refused, at the first refusal's rule. */
export function definitionRefusal(
  pkg: PackageName,
  rule: (typeof DEFINITION_REFUSAL_RULES)[number],
  more: number,
): PackageRefusal {
  return Object.freeze({
    code: "PROVIDER_RECORD_INVALID",
    rule,
    name: pkg.name,
    version: pkg.version,
    more,
    sentence: `PROVIDER_RECORD_INVALID: ${pkg.name} ${pkg.version}: its record is not one the provider contract admits: ${rule}${moreSuffix(more)}`,
  });
}

/** A rule of admission whose sentence is fixed, by code. */
export type AdmissionFault =
  | { readonly code: "PROVIDER_MODULE_FORMAT"; readonly rule: RuleOf<"PROVIDER_MODULE_FORMAT"> }
  | { readonly code: "PROVIDER_LOAD_FAILED"; readonly rule: RuleOf<"PROVIDER_LOAD_FAILED"> }
  | { readonly code: "PROVIDER_NATIVE_UNSUPPORTED"; readonly rule: RuleOf<"PROVIDER_NATIVE_UNSUPPORTED"> }
  | { readonly code: "PROVIDER_RECORD_INVALID"; readonly rule: "record-proxy" | "manifest-differs" };

/** The refusal of a package at an admission rule whose sentence is fixed. */
export function admissionRefusal(pkg: PackageName, fault: AdmissionFault): PackageRefusal {
  return Object.freeze({
    code: fault.code,
    rule: fault.rule,
    name: pkg.name,
    version: pkg.version,
    sentence: `${fault.code}: ${pkg.name} ${pkg.version}: ${ADMISSION_SENTENCES[fault.code]?.[fault.rule]}`,
  });
}

/** Why a package is refused by a rule of the server catalog's set rules. */
const CATALOG_CONFLICT_SENTENCES: Readonly<Record<CatalogConflictRule, string>> = {
  "engine-id": "it serves an engine id Studio's catalog or another package serves",
  "fence-alias": "it states a fence alias Studio's catalog or another package states, or one that names another engine",
  "query-dialect": "it states a query dialect with another row than Studio's catalog or another package",
  "tab-type": "it opens a tab type in another editor language than Studio's catalog or another package",
  "editor-language":
    "it states an editor language with another accent or console than Studio's catalog or another package",
  "statement-language": "it is granted a statement language Studio's catalog holds or another engine is granted",
  "mcp-tool":
    "it is granted a statement language whose MCP statement tool Studio's catalog or another engine's granted language holds",
};

/**
 * The refusal of an admitted package a rule across the whole set of admitted packages and Studio's bundled catalog
 * refuses (`catalogConflicts` in src/lib/db/server-catalog-compose.ts), naming the rule and no value it states.
 */
export function catalogConflictRefusal(pkg: PackageName, rule: CatalogConflictRule): PackageRefusal {
  return Object.freeze({
    code: "PROVIDER_CATALOG_CONFLICT",
    rule,
    name: pkg.name,
    version: pkg.version,
    sentence: `PROVIDER_CATALOG_CONFLICT: ${pkg.name} ${pkg.version}: ${CATALOG_CONFLICT_SENTENCES[rule]}`,
  });
}

/** What a lock refusal adds to its rule: the pointer and key of a shape rule, the errno code of a file rule. */
export interface LockRefusalDetail {
  readonly pointer?: string;
  readonly key?: string;
  readonly errno?: string;
}
