/**
 * The provider manifest validator (docs/providers/CONTRACT.md, the manifest chapter).
 *
 * `compileManifestValidator` takes the bytes of the schema file, refuses them unless their SHA-256 is
 * `MANIFEST_SCHEMA_SHA256`, and compiles them with ajv's documented JSON Schema 2020-12 entry, `ajv/dist/2020.js`, in
 * strict mode with every error reported. The caller reads the bytes: the SDK reads no file and keeps no state, so each
 * call builds its own ajv instance and two validators share nothing. The specifier carries its `.js` because ajv 8 has
 * no `exports` map and Node's ES module loader adds no extension, so the packed SDK (scripts/sdk-pack.ts) would fail to
 * load under Node without it; Bun and every bundler resolve the same file either way.
 *
 * A manifest is read in three steps. The envelope first, `{ contract }`, which every contract keeps, so a host can tell
 * a manifest built against another contract from a broken one. Then, only for the contract this schema serves, the
 * whole schema. Then, only on a manifest the schema admits, the rules JSON Schema cannot state, each a code rule with a
 * name of its own. Every failure is a refusal naming its rule and a JSON Pointer into the manifest, and the key for an
 * unknown or missing one; no refusal carries a value of the manifest, except the refusal of a contract this SDK does
 * not serve, which names the contract the envelope declares.
 */
import { createHash } from "node:crypto";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { AGENT_READING_PANELS } from "../calls/types";
import {
  type AgentCredentialForm,
  type AgentCredentialFormClaim,
  type AgentLanguageText,
  type AgentMcpText,
  type AgentRequestForm,
  type AgentText,
  type AgentRequestKeyCheck,
  type CaptureKindWord,
  type EngineDeclaration,
  MANIFEST_SCHEMA_SHA256,
  type MaintenanceOperation,
  type MaintenanceSpec,
  type MaskingExemption,
  type ProfileComposition,
  type ProviderManifest,
  type SqlDialect,
  type StatementLanguage,
  type TlsMode,
  type TypeFamilies,
  type WritePaths,
  type WriteReachClaim,
} from "./manifest-types.generated";

/** Every rule a schema refusal can name: the schema's own first, then the code rules. */
export const SCHEMA_REFUSAL_RULES = Object.freeze([
  "unknown-key",
  "missing-key",
  "wrong-type",
  "value-not-allowed",
  "pattern-mismatch",
  "out-of-range",
  "too-few",
  "too-many",
  "duplicate",
  "no-variant",
  "engine-id-duplicate",
  "compatibility-engine-missing",
  "compatibility-engine-undeclared",
  "compatibility-endpoint-untested",
  "refused-field-declared",
  "refused-field-duplicate",
  "seed-only-field-undeclared",
  "host-path-field-undeclared",
  "field-undeclared",
  "dialog-entry-duplicate",
  "placement-missing",
  "options-missing",
  "option-value-duplicate",
  "shown-when-chained",
  "shown-when-value-not-an-option",
  "absent-value-not-an-option",
  "absent-value-unread",
  "absent-value-missing",
  "host-uri-schemes-without-host",
  "credential-warning-field-undeclared",
  "no-secret-warning-duplicate",
  "env-proxy-variable",
  "field-rule-duplicate",
  "field-rule-empty",
  "pattern-invalid",
  "char-range-inverted",
  "host-reader-without-host",
  "scheme-without-paste",
  "url-tls-without-paste",
  "tls-mode-order",
  "fence-alias-engine-id",
  "fence-alias-duplicate",
  "fence-alias-generic",
  "wrapper-group-count",
  "type-name-duplicate",
  "statement-read-unexposed",
  "agent-credential-form-missing",
  "agent-credential-seed-form-differs",
  "read-roots-field-undeclared",
  "denied-file-access-unread",
  "masking-exemption-unanchored",
  "write-reach-summary-differs",
  "editor-write-path-unproven",
  "metadata-operation-duplicate",
  "metadata-column-duplicate",
  "maintenance-spec-unlisted",
  "maintenance-spec-duplicate",
  "maintenance-spec-missing",
  "maintenance-spec-unplaced",
  "maintenance-typed-confirmation-unasked",
  "maintenance-typed-target-unasked",
  "maintenance-preview-unplaced",
  "agent-reading-panel-not-offered",
  "agent-overlay-missing",
  "agent-overlay-unspoken",
  "agent-dialect-missing",
  "agent-dialect-unspoken",
  "statement-language-name-differs",
  "statement-language-data-sql",
  "confirmation-operations-unread",
  "statement-language-agent-unspoken",
  "request-key-undeclared",
  "request-key-unruled",
  "request-key-ruled-twice",
  "request-read-duplicate",
  "request-reads-without-selector",
  "request-integer-range-empty",
  "request-integer-default-outside",
  "request-name-range-reversed",
  "request-name-range-not-one-character",
  "request-name-length-empty",
  "request-name-refused-unreachable",
  "agent-text-fill-unknown",
  "agent-tool-not-offered",
  "statistics-without-catalog-read",
  "catalog-capture-without-catalog-read",
  "capture-kind-word-duplicate",
  "plan-estimate-prefix-executes",
  "object-model-missing",
  "object-level-duplicate",
  "object-level-order",
  "object-kind-duplicate",
  "object-kind-unstated",
  "object-row-activation-duplicate",
  "object-source-inconsistent",
  "object-source-not-offered",
] as const);

export type SchemaRefusalRule = (typeof SCHEMA_REFUSAL_RULES)[number];

/** A manifest the schema, or a rule it cannot state, refuses: the rule, where, and for a key its name. */
export interface SchemaRefusal {
  readonly code: "PROVIDER_SCHEMA_INVALID";
  readonly rule: SchemaRefusalRule;
  /** A JSON Pointer into the value validated; the empty string is its top level. */
  readonly pointer: string;
  /** The key, for an unknown or a missing one. */
  readonly key?: string;
}

/** A manifest built against a contract this schema does not serve, named by the contract it declares. */
export interface ContractRefusal {
  readonly code: "PROVIDER_CONTRACT_UNSUPPORTED";
  readonly contract: string;
}

export type ManifestRefusal = SchemaRefusal | ContractRefusal;

export type ManifestVerdict =
  | { readonly admitted: true; readonly manifest: ProviderManifest }
  | { readonly admitted: false; readonly refusals: readonly ManifestRefusal[] };

export type EngineVerdict =
  | { readonly admitted: true; readonly engine: EngineDeclaration }
  | { readonly admitted: false; readonly refusals: readonly SchemaRefusal[] };

export interface ManifestValidator {
  /** The contract this schema serves, `MAJOR.MINOR`. */
  readonly contract: string;
  /** Reads a whole manifest. */
  readonly validate: (value: unknown) => ManifestVerdict;
  /** Reads one engine declaration, `#/$defs/engineDeclaration`, with the rules of its own connection. */
  readonly validateEngine: (value: unknown) => EngineVerdict;
}

/** Thrown when the schema bytes given are not the schema this SDK was built with. */
export class ManifestSchemaDigestError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(
      `The provider manifest schema given has SHA-256 ${actual}, not ${expected}, the digest of the schema this SDK was built with: load the manifest.schema.json file this SDK ships.`,
    );
    this.name = "ManifestSchemaDigestError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** The schema rule each ajv keyword the schema uses is refused under. */
const RULE_OF_KEYWORD: Readonly<Record<string, SchemaRefusalRule>> = Object.freeze({
  additionalProperties: "unknown-key",
  required: "missing-key",
  type: "wrong-type",
  enum: "value-not-allowed",
  const: "value-not-allowed",
  pattern: "pattern-mismatch",
  minimum: "out-of-range",
  maximum: "out-of-range",
  minLength: "out-of-range",
  maxLength: "out-of-range",
  minItems: "too-few",
  maxItems: "too-many",
  uniqueItems: "duplicate",
  oneOf: "no-variant",
});

type AjvError = Pick<ErrorObject, "keyword" | "instancePath" | "params">;

function schemaRefusal(rule: SchemaRefusalRule, pointer: string, key?: string): SchemaRefusal {
  return key === undefined
    ? { code: "PROVIDER_SCHEMA_INVALID", rule, pointer }
    : { code: "PROVIDER_SCHEMA_INVALID", rule, pointer, key };
}

/** Whether `pointer` is `parent` or lies under it, compared by whole reference token. */
function within(pointer: string, parent: string): boolean {
  return pointer === parent || pointer.startsWith(`${parent}/`);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Refusals sorted by pointer, then rule, then key, with exact repeats removed. */
function ordered(refusals: readonly SchemaRefusal[]): SchemaRefusal[] {
  const sorted = [...refusals].sort(
    (a, b) => compareText(a.pointer, b.pointer) || compareText(a.rule, b.rule) || compareText(a.key ?? "", b.key ?? ""),
  );
  return sorted.filter(
    (item, index) =>
      index === 0 ||
      item.pointer !== sorted[index - 1]?.pointer ||
      item.rule !== sorted[index - 1]?.rule ||
      item.key !== sorted[index - 1]?.key,
  );
}

/**
 * ajv's errors as refusals. A failed `oneOf` is one `no-variant` refusal at its pointer, and every error at or under
 * that pointer, which only its branches can report since the schema's generator keeps `oneOf` alone in its schema, is
 * dropped. A repeated item is refused at the later of the two indices ajv names, `i` and `j`, whose order depends on
 * whether the list's items schema states a type. A keyword no rule maps is thrown by name: it means the schema uses a
 * keyword this validator does not read.
 */
export function refusalsOf(errors: readonly AjvError[]): SchemaRefusal[] {
  const variants = errors.filter((error) => error.keyword === "oneOf").map((error) => error.instancePath);
  const outermost = variants.filter(
    (pointer) => !variants.some((other) => other !== pointer && within(pointer, other)),
  );
  const refusals: SchemaRefusal[] = outermost.map((pointer) => schemaRefusal("no-variant", pointer));
  for (const error of errors) {
    if (error.keyword === "oneOf" || variants.some((pointer) => within(error.instancePath, pointer))) continue;
    if (!Object.hasOwn(RULE_OF_KEYWORD, error.keyword)) {
      throw new Error(`ajv reported the keyword "${error.keyword}", which no manifest refusal rule maps`);
    }
    const rule = RULE_OF_KEYWORD[error.keyword] as SchemaRefusalRule;
    const params = error.params as Record<string, unknown>;
    if (rule === "unknown-key")
      refusals.push(schemaRefusal(rule, error.instancePath, String(params.additionalProperty)));
    else if (rule === "missing-key")
      refusals.push(schemaRefusal(rule, error.instancePath, String(params.missingProperty)));
    else if (rule === "duplicate") {
      refusals.push(schemaRefusal(rule, `${error.instancePath}/${Math.max(Number(params.i), Number(params.j))}`));
    } else refusals.push(schemaRefusal(rule, error.instancePath));
  }
  return ordered(refusals);
}

/**
 * The vocabularies of the schema the rules read: the seed-only, placeable and select field names, the generic fence
 * tags, the kinds of a bare type family in the schema's order, and the TLS modes in the schema's order.
 */
interface FieldVocabularies {
  readonly seedOnly: ReadonlySet<string>;
  readonly placeable: ReadonlySet<string>;
  readonly select: ReadonlySet<string>;
  readonly genericFenceTags: ReadonlySet<string>;
  /** The inferred kinds of a bare type family, in the order of the schema's `typeFamilies`. */
  readonly typeFamilyKinds: readonly (keyof TypeFamilies)[];
  /** The TLS modes, in the order of the schema's `tlsMode`. */
  readonly tlsModes: readonly TlsMode[];
}

/**
 * The rules of an engine's connection dialog the schema cannot state, at pointers under `at`. Every entry names a field
 * the engine takes, once per list. Every placeable and every select field the engine takes has its placement and its
 * choices, and no two choices of a field share a value. A condition reads a field with no condition of its own, and on
 * a field with choices names one of them. An absent value is for a field a condition reads and, where the field has
 * choices, is one of them; every select field a condition reads has one. Where an entry is repeated, the first is the
 * one the other rules read.
 */
function dialogRuleRefusals(
  connection: EngineDeclaration["connection"],
  at: string,
  vocabularies: FieldVocabularies,
): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const { dialog } = connection;
  const base = `${at}/connection/dialog`;
  const fields = new Set<string>(connection.fields);
  const entryLists = [
    ["labels", dialog.labels],
    ["hints", dialog.hints],
    ["placeholders", dialog.placeholders],
    ["placement", dialog.placement],
    ["options", dialog.options],
    ["shownWhen", dialog.shownWhen],
    ["absentValues", dialog.absentValues],
  ] as const;
  for (const [list, entries] of entryLists) {
    const seen = new Set<string>();
    entries.forEach(({ field }, index) => {
      const pointer = `${base}/${list}/${index}/field`;
      if (!fields.has(field)) refusals.push(schemaRefusal("field-undeclared", pointer));
      if (seen.has(field)) refusals.push(schemaRefusal("dialog-entry-duplicate", pointer));
      seen.add(field);
    });
  }
  dialog.order?.forEach((field, index) => {
    if (!fields.has(field)) refusals.push(schemaRefusal("field-undeclared", `${base}/order/${index}`));
  });

  const placed = new Set<string>(dialog.placement.map((entry) => entry.field));
  const choicesOf = new Map<string, ReadonlySet<string>>();
  dialog.options.forEach((entry, index) => {
    const values = new Set<string>();
    entry.choices.forEach((choice, position) => {
      if (values.has(choice.value)) {
        refusals.push(schemaRefusal("option-value-duplicate", `${base}/options/${index}/choices/${position}/value`));
      }
      values.add(choice.value);
    });
    if (!choicesOf.has(entry.field)) choicesOf.set(entry.field, values);
  });
  connection.fields.forEach((field, index) => {
    if (vocabularies.placeable.has(field) && !placed.has(field)) {
      refusals.push(schemaRefusal("placement-missing", `${at}/connection/fields/${index}`));
    }
    if (vocabularies.select.has(field) && !choicesOf.has(field)) {
      refusals.push(schemaRefusal("options-missing", `${at}/connection/fields/${index}`));
    }
  });

  const conditioned = new Set<string>(dialog.shownWhen.map((entry) => entry.field));
  const read = new Set<string>(dialog.shownWhen.map((entry) => entry.when.field));
  const absent = new Set<string>(dialog.absentValues.map((entry) => entry.field));
  dialog.shownWhen.forEach(({ when }, index) => {
    const pointer = `${base}/shownWhen/${index}/when`;
    if (!fields.has(when.field)) refusals.push(schemaRefusal("field-undeclared", `${pointer}/field`));
    if (conditioned.has(when.field)) refusals.push(schemaRefusal("shown-when-chained", `${pointer}/field`));
    const choices = choicesOf.get(when.field);
    if (choices !== undefined && !choices.has(when.equals)) {
      refusals.push(schemaRefusal("shown-when-value-not-an-option", `${pointer}/equals`));
    }
    if (vocabularies.select.has(when.field) && !absent.has(when.field)) {
      refusals.push(schemaRefusal("absent-value-missing", `${pointer}/field`));
    }
  });
  dialog.absentValues.forEach((entry, index) => {
    const choices = choicesOf.get(entry.field);
    if (choices !== undefined && !choices.has(entry.value)) {
      refusals.push(schemaRefusal("absent-value-not-an-option", `${base}/absentValues/${index}/value`));
    }
    if (!read.has(entry.field))
      refusals.push(schemaRefusal("absent-value-unread", `${base}/absentValues/${index}/field`));
  });
  return refusals;
}

/**
 * The rules of an engine's Host box and credential warnings the schema cannot state, at pointers under `at`: URI schemes
 * only where the engine takes a host, a warning only on the fields it reads, and at most one `no-secret` warning.
 */
function hostAndWarningRuleRefusals(connection: EngineDeclaration["connection"], at: string): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const fields = new Set<string>(connection.fields);
  if (connection.hostUriSchemes.length > 0 && !fields.has("host")) {
    refusals.push(schemaRefusal("host-uri-schemes-without-host", `${at}/connection/hostUriSchemes`));
  }
  let noSecretSeen = false;
  connection.credentialWarnings.forEach((warning, index) => {
    const pointer = `${at}/connection/credentialWarnings/${index}`;
    const reads = warning.kind === "pair" ? ["user", "password"] : ["password"];
    if (!reads.every((field) => fields.has(field))) {
      refusals.push(schemaRefusal("credential-warning-field-undeclared", pointer));
    }
    if (warning.kind === "no-secret") {
      if (noSecretSeen) refusals.push(schemaRefusal("no-secret-warning-duplicate", pointer));
      noSecretSeen = true;
    }
  });
  return refusals;
}

/**
 * `source` compiled with `flags` as a JavaScript regular expression, or null where it does not compile; the error,
 * which quotes the source, is dropped.
 */
function compiled(source: string, flags: string): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/**
 * The rules of an engine's field rules and Host text readers the schema cannot state, at pointers under `at`. A rule
 * names a field the engine takes, at most one rule per field, and states at least one check; its pattern compiles with
 * its flags, and its character range does not end before it starts. A Host text reader is named only on an engine that
 * takes a host field. A repeated rule is refused, at the second and every later rule for the field, so no reader
 * meets two rules for one field.
 */
function fieldRuleRefusals(connection: EngineDeclaration["connection"], at: string): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const fields = new Set<string>(connection.fields);
  const seen = new Set<string>();
  connection.fieldRules.forEach((rule, index) => {
    const pointer = `${at}/connection/fieldRules/${index}`;
    if (!fields.has(rule.field)) refusals.push(schemaRefusal("field-undeclared", `${pointer}/field`));
    if (seen.has(rule.field)) refusals.push(schemaRefusal("field-rule-duplicate", `${pointer}/field`));
    seen.add(rule.field);
    if (rule.required === null && rule.format === null && rule.charRange === null && rule.check === null) {
      refusals.push(schemaRefusal("field-rule-empty", pointer));
    }
    if (rule.format !== null && compiled(rule.format.pattern.source, rule.format.pattern.flags) === null) {
      refusals.push(schemaRefusal("pattern-invalid", `${pointer}/format/pattern/source`));
    }
    if (rule.charRange !== null && rule.charRange.min > rule.charRange.max) {
      refusals.push(schemaRefusal("char-range-inverted", `${pointer}/charRange`));
    }
  });
  for (const reader of ["hostHint", "hostIdentity"] as const) {
    if (connection[reader] !== null && !fields.has("host")) {
      refusals.push(schemaRefusal("host-reader-without-host", `${at}/connection/${reader}`));
    }
  }
  return refusals;
}

/**
 * The rule of an engine's trailing limit clauses the schema cannot state, at pointers under `at`: each clause's source
 * compiles with its flags. An engine whose `sqlText` is null states no clause, so none is refused.
 */
function clausePatternRefusals(engine: EngineDeclaration, at: string): SchemaRefusal[] {
  if (engine.sqlText === null) return [];
  return engine.sqlText.grammar.trailingLimitClauses.flatMap(({ source, flags }, index) =>
    compiled(source, flags) === null
      ? [schemaRefusal("pattern-invalid", `${at}/sqlText/grammar/trailingLimitClauses/${index}/source`)]
      : [],
  );
}

/**
 * How many capturing groups the compiled `pattern` has. `exec` answers one slot per capturing group plus one for the
 * match (ECMAScript's RegExpBuiltinExec), and an empty alternative put before the source matches the empty string at
 * once, so the count is exact without reading the source: a group the matching alternative never enters is still a
 * slot, undefined. The empty alternative goes first because alternatives are tried left to right: the declared pattern
 * is never entered, so a pattern that backtracks without end on the empty string is counted as quickly as any other.
 */
function capturingGroups(pattern: RegExp): number {
  const answer = new RegExp(`|${pattern.source}`, pattern.flags).exec("");
  return (answer?.length ?? 0) - 1;
}

/**
 * The rules of an engine's SQL writing facts the schema cannot state, at pointers under `at`: each type pattern compiles
 * with its flags, the wrapper pattern captures exactly one group, the type it wraps, and no type name is named twice in
 * one table, either under two bare type families, the later kind in the schema's order refused, or by two bare
 * spellings, the later refused. The kinds are read in the schema's order, whatever order the declaration writes them in.
 * An engine whose `sqlWriting` is null states none of these facts, so none is refused.
 */
function sqlWritingRuleRefusals(
  engine: EngineDeclaration,
  at: string,
  vocabularies: FieldVocabularies,
): SchemaRefusal[] {
  if (engine.sqlWriting === null) return [];
  const refusals: SchemaRefusal[] = [];
  const base = `${at}/sqlWriting/export`;
  const { bareSpelling, typeVocabulary } = engine.sqlWriting.export;
  for (const member of ["floatType", "exactNumericType", "numericWrapper"] as const) {
    const { source, flags } = typeVocabulary[member];
    const pattern = compiled(source, flags);
    const pointer = `${base}/typeVocabulary/${member}/source`;
    if (pattern === null) refusals.push(schemaRefusal("pattern-invalid", pointer));
    else if (member === "numericWrapper" && capturingGroups(pattern) !== 1) {
      refusals.push(schemaRefusal("wrapper-group-count", pointer));
    }
  }
  const families = new Set<string>();
  for (const kind of vocabularies.typeFamilyKinds) {
    typeVocabulary.bareTypeFamily[kind].forEach((name, index) => {
      if (families.has(name)) {
        refusals.push(schemaRefusal("type-name-duplicate", `${base}/typeVocabulary/bareTypeFamily/${kind}/${index}`));
      }
      families.add(name);
    });
  }
  const spelled = new Set<string>();
  bareSpelling.forEach(({ name }, index) => {
    if (spelled.has(name)) refusals.push(schemaRefusal("type-name-duplicate", `${base}/bareSpelling/${index}/name`));
    spelled.add(name);
  });
  return refusals;
}

/**
 * The rules of an engine's connection string the schema cannot state, at pointers under `at`: a scheme and a URL TLS
 * reader only on an engine whose connection string names a paste reader, since Studio shows a scheme as one a paste of
 * it reads, and only the paste reader reads a URL's query.
 */
function connectionStringRuleRefusals(connection: EngineDeclaration["connection"], at: string): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const { connectionString } = connection;
  const pointer = `${at}/connection/connectionString`;
  if (connectionString.paste !== null) return refusals;
  if (connectionString.scheme !== null) refusals.push(schemaRefusal("scheme-without-paste", `${pointer}/scheme`));
  if (connectionString.urlTls !== null) refusals.push(schemaRefusal("url-tls-without-paste", `${pointer}/urlTls`));
  return refusals;
}

/**
 * The rule of an engine's TLS modes the schema cannot state, at pointers under `at`: the modes are listed in the order
 * of the schema's `tlsMode`, so each mode is refused where a mode listed before it comes later in that order. Every
 * mode is one of the vocabulary's, which the schema has already checked.
 */
function tlsModeRuleRefusals(
  connection: EngineDeclaration["connection"],
  at: string,
  order: readonly TlsMode[],
): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  let highest = -1;
  connection.tls.modes.forEach((mode, index) => {
    const rank = order.indexOf(mode);
    if (rank < highest) refusals.push(schemaRefusal("tls-mode-order", `${at}/connection/tls/modes/${index}`));
    highest = Math.max(highest, rank);
  });
  return refusals;
}

/**
 * The rules of one engine's fence aliases the schema cannot state, at pointers under `at`: an alias is never the
 * engine's own id, which is always a fence tag naming it, and never a generic fence tag, which names no engine.
 */
function editorRuleRefusals(engine: EngineDeclaration, at: string, vocabularies: FieldVocabularies): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  engine.editor.fenceAliases.forEach((alias, index) => {
    const pointer = `${at}/editor/fenceAliases/${index}`;
    if (alias === engine.id) refusals.push(schemaRefusal("fence-alias-engine-id", pointer));
    if (vocabularies.genericFenceTags.has(alias)) refusals.push(schemaRefusal("fence-alias-generic", pointer));
  });
  return refusals;
}

/**
 * Whether a masking exemption's column pattern matches whole column names only, read from its source text and never
 * run: the source opens with `^`, closes with a `$` no backslash escapes and no character class holds, and holds no
 * `|` outside every group and class, so no alternative reaches past the anchors. `^a$|^b$`, anchored per alternative,
 * is refused for the group form `^(?:a|b)$`, which says the same once.
 */
function matchesWholeNames(source: string): boolean {
  if (!source.startsWith("^")) return false;
  let depth = 0;
  let inClass = false;
  let closed = false;
  for (let index = 1; index < source.length; index += 1) {
    const char = source.charAt(index);
    closed = false;
    if (char === "\\") index += 1;
    else if (inClass) inClass = char !== "]";
    else if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "|" && depth === 0) return false;
    else closed = char === "$" && depth === 0;
  }
  return closed;
}

/**
 * The rules of an engine's masking exemption the schema cannot state, at pointers under `at`: its column pattern
 * compiles with no flag, the way Studio's masking compiles it, and, where it compiles, matches whole column names only.
 */
function maskingExemptionRefusals(exemption: MaskingExemption, at: string): SchemaRefusal[] {
  if (exemption === null) return [];
  const pointer = `${at}/policy/maskingExemptColumns/column`;
  if (compiled(exemption.column, "") === null) return [schemaRefusal("pattern-invalid", pointer)];
  return matchesWholeNames(exemption.column) ? [] : [schemaRefusal("masking-exemption-unanchored", pointer)];
}

/**
 * The seed agent credential form each agent credential form request takes: a user and a password for `pair`, a user
 * other than the connection's own for `dedicated-user`, and a secret alone for `token` and `service-account-key`. A
 * request of `none` refuses every agent acquisition, so it takes no seed form and has no entry.
 */
const SEED_FORM_OF_REQUEST: Readonly<Record<Exclude<AgentCredentialFormClaim, "none">, AgentCredentialForm>> =
  Object.freeze({
    pair: "pair",
    "dedicated-user": "dedicated-pair",
    token: "secret",
    "service-account-key": "secret",
  });

/**
 * The rules of one engine's policy and MCP claims the schema cannot state, at pointers under `at`. Each checks a
 * request, never the value Studio grants it: a statement read only on an engine exposed to MCP, an agent credential
 * required only of an engine whose seeds take one, a seed agent credential only in the form the agent credential form
 * request names unless that request is `none`, read roots required only of an engine whose seeds can declare them, a
 * denied file access refusal only on an engine that reads the file-access posture, and a masking exemption only of
 * whole column names, in a pattern that compiles.
 */
function claimRuleRefusals(engine: EngineDeclaration, at: string): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const { connection, mcp, policy } = engine;
  if (mcp.statementRead && !mcp.exposable) {
    refusals.push(schemaRefusal("statement-read-unexposed", `${at}/mcp/statementRead`));
  }
  if (mcp.agentCredentialRequired && connection.agentCredential === null) {
    refusals.push(schemaRefusal("agent-credential-form-missing", `${at}/mcp/agentCredentialRequired`));
  }
  if (
    connection.agentCredential !== null &&
    policy.agentCredentialForm !== "none" &&
    connection.agentCredential.form !== SEED_FORM_OF_REQUEST[policy.agentCredentialForm]
  ) {
    refusals.push(schemaRefusal("agent-credential-seed-form-differs", `${at}/connection/agentCredential/form`));
  }
  if (policy.readRootsRequired && !(connection.seedOnly?.fields ?? []).includes("agentReadRoots")) {
    refusals.push(schemaRefusal("read-roots-field-undeclared", `${at}/policy/readRootsRequired`));
  }
  if (policy.deniedFileAccessRefusal !== null && !policy.readsFileAccessPosture) {
    refusals.push(schemaRefusal("denied-file-access-unread", `${at}/policy/deniedFileAccessRefusal`));
  }
  refusals.push(...maskingExemptionRefusals(policy.maskingExemptColumns, at));
  return refusals;
}

/** The write reach `paths` sum to: open where any path is open, else guarded where any is gated, else none. */
function summaryOf(paths: WritePaths): WriteReachClaim {
  const reaches = Object.values(paths).map((path) => path.reach);
  if (reaches.includes("open")) return "open";
  return reaches.includes("gated") ? "guarded" : "none";
}

/**
 * The rules of one engine's safeguards the schema cannot state, at pointers under `at`. The write reach claim is the
 * summary of the write paths, so the request and its evidence are one statement; an absent editor path names its
 * proof; the inline edit refusal's type pattern compiles with no flag, the way the inline editor compiles it; and the
 * metadata-only answer names each operation once, and each column once within its operation, the later repeat refused.
 */
function safeguardRuleRefusals(engine: EngineDeclaration, at: string): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const { policy, safeguards } = engine;
  const { editor } = safeguards.writePaths;
  if (policy.writeReach !== summaryOf(safeguards.writePaths)) {
    refusals.push(schemaRefusal("write-reach-summary-differs", `${at}/policy/writeReach`));
  }
  if (editor.reach === "absent" && editor.proof === null) {
    refusals.push(schemaRefusal("editor-write-path-unproven", `${at}/safeguards/writePaths/editor/proof`));
  }
  const inline = safeguards.inlineEditRefusedColumns;
  if (inline !== null && compiled(inline.type, "") === null) {
    refusals.push(schemaRefusal("pattern-invalid", `${at}/safeguards/inlineEditRefusedColumns/type`));
  }
  const operations = new Set<string>();
  safeguards.metadataOnly?.forEach(({ operation, columns }, index) => {
    const pointer = `${at}/safeguards/metadataOnly/${index}`;
    if (operations.has(operation)) refusals.push(schemaRefusal("metadata-operation-duplicate", `${pointer}/operation`));
    operations.add(operation);
    const named = new Set<string>();
    columns.forEach(({ column }, position) => {
      if (named.has(column)) {
        refusals.push(schemaRefusal("metadata-column-duplicate", `${pointer}/columns/${position}/column`));
      }
      named.add(column);
    });
  });
  return refusals;
}

/** The maintenance operation whose target is a session the session list names, so its spec places it nowhere. */
const SESSION_TARGETED_OPERATION: MaintenanceOperation = "kill";

/**
 * The rules of where one maintenance spec places its operation, its confirmation and its preview, at pointers under
 * `pointer`, the spec's own: a spec places its operation on a row or over the whole database, except kill's; a typed
 * confirmation is admitted only on a spec placed over the whole database alone, with a title and a description, the
 * only spec whose operation is sent by its declared card alone, whose typed dialog asks for the connection's name under
 * the title and the description; a typed target only on a spec placed on a row alone, the only spec whose operation is
 * sent from its objects' rows alone, whose dialog asks for the object's own name; so every control that sends an
 * operation asks the confirmation its spec declares; and a preview only on a spec placed on a row, since only a row's
 * dialog shows one.
 */
function maintenanceSpecRefusals(spec: MaintenanceSpec, pointer: string): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const { perEntity, global, confirmation } = spec;
  if (!perEntity && !global && spec.operation !== SESSION_TARGETED_OPERATION) {
    refusals.push(schemaRefusal("maintenance-spec-unplaced", pointer));
  }
  const card = global && !perEntity && spec.title !== null && spec.description !== null;
  if (confirmation === "typed" && !card) {
    refusals.push(schemaRefusal("maintenance-typed-confirmation-unasked", `${pointer}/confirmation`));
  }
  if (confirmation === "typed-target" && !(perEntity && !global)) {
    refusals.push(schemaRefusal("maintenance-typed-target-unasked", `${pointer}/confirmation`));
  }
  if (spec.preview && !perEntity) refusals.push(schemaRefusal("maintenance-preview-unplaced", `${pointer}/preview`));
  return refusals;
}

/**
 * The rules of an engine's maintenance specs the schema cannot state, at pointers under `at`: one spec for each
 * operation the maintenance list names and for no other, the later of two specs for one operation refused, and each
 * spec held to where it places its operation, its confirmation and its preview.
 */
function maintenanceRuleRefusals(engine: EngineDeclaration, at: string): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const { maintenance, maintenanceSpecs } = engine.facets;
  const listed = new Set<string>(maintenance);
  const specified = new Set<string>();
  maintenanceSpecs.forEach((spec, index) => {
    const pointer = `${at}/facets/maintenanceSpecs/${index}`;
    if (!listed.has(spec.operation)) refusals.push(schemaRefusal("maintenance-spec-unlisted", `${pointer}/operation`));
    if (specified.has(spec.operation)) {
      refusals.push(schemaRefusal("maintenance-spec-duplicate", `${pointer}/operation`));
    }
    specified.add(spec.operation);
    refusals.push(...maintenanceSpecRefusals(spec, pointer));
  });
  maintenance.forEach((operation, index) => {
    if (!specified.has(operation)) {
      refusals.push(schemaRefusal("maintenance-spec-missing", `${at}/facets/maintenance/${index}`));
    }
  });
  return refusals;
}

/**
 * The rule of an engine's agent readings the schema cannot state, at pointers under `at`: a reading read through a
 * monitoring panel, as `AGENT_READING_PANELS` names it, is listed only where the engine offers that panel, since the
 * host refuses every panel call for a panel the engine does not offer; `health`, which the health call serves, is
 * admitted whatever the panels.
 */
function agentReadingRuleRefusals(engine: EngineDeclaration, at: string): SchemaRefusal[] {
  const { monitoring, agentReadings } = engine.facets;
  const refusals: SchemaRefusal[] = [];
  agentReadings.forEach((reading, index) => {
    const panel = AGENT_READING_PANELS[reading];
    if (panel !== null && monitoring[panel] !== "offered") {
      refusals.push(schemaRefusal("agent-reading-panel-not-offered", `${at}/facets/agentReadings/${index}`));
    }
  });
  return refusals;
}

/**
 * The statement language whose family has members bound to its dialect, so the only one whose engines state a dialect
 * in their agent overlay. A second family that gains dialect members is a contract change.
 */
const DIALECT_LANGUAGE: StatementLanguage = "sql";

/** A word that makes EXPLAIN run the plan rather than estimate it, in any case. */
const PLAN_EXECUTING_WORD = /\bANALY[SZ]E\b/i;

/**
 * The rule of a profile's type patterns the schema cannot state, at pointers under `at`, the profile's own: each
 * pattern compiles with its flags.
 */
function profilePatternRefusals(profile: NonNullable<ProfileComposition>, at: string): SchemaRefusal[] {
  return (["incomparableType", "uncountableType"] as const).flatMap((member) => {
    const pattern = profile[member];
    return pattern !== null && compiled(pattern.source, pattern.flags) === null
      ? [schemaRefusal("pattern-invalid", `${at}/${member}/source`)]
      : [];
  });
}

/** The rule of a capture's kind words the schema cannot state, at pointers under `at`: each word once, the later refused. */
function kindWordRefusals(kindWords: readonly CaptureKindWord[], at: string): SchemaRefusal[] {
  const seen = new Set<string>();
  return kindWords.flatMap(({ word }, index) => {
    const repeated = seen.has(word);
    seen.add(word);
    return repeated ? [schemaRefusal("capture-kind-word-duplicate", `${at}/${index}/word`)] : [];
  });
}

/**
 * The rules of an SQL dialect the schema cannot state, at pointers under `at`, the dialect's own: an estimating prefix
 * holds no word that executes the plan, since one strip built from every engine's prefix serves every engine; each
 * profile type pattern compiles; a statistics reading and a capture are stated only beside a catalog read, since the
 * statistics are its statistics kind and the capture composes through it; and a capture gives each kind word once.
 */
function sqlDialectRefusals(dialect: NonNullable<SqlDialect>, at: string): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const { catalogRead, planEstimate, profileComposition, statistics, catalogCapture } = dialect;
  if (planEstimate?.kind === "prefix" && PLAN_EXECUTING_WORD.test(planEstimate.prefix)) {
    refusals.push(schemaRefusal("plan-estimate-prefix-executes", `${at}/planEstimate/prefix`));
  }
  if (profileComposition !== null) {
    refusals.push(...profilePatternRefusals(profileComposition, `${at}/profileComposition`));
  }
  if (catalogRead === null && statistics !== null) {
    refusals.push(schemaRefusal("statistics-without-catalog-read", `${at}/statistics`));
  }
  if (catalogRead === null && catalogCapture !== null) {
    refusals.push(schemaRefusal("catalog-capture-without-catalog-read", `${at}/catalogCapture`));
  }
  if (catalogCapture !== null) {
    refusals.push(...kindWordRefusals(catalogCapture.kindWords, `${at}/catalogCapture/kindWords`));
  }
  return refusals;
}

/**
 * The rules of an engine's agent overlay the schema cannot state, at pointers under `at`: an overlay is stated exactly
 * where the engine speaks a statement language, a dialect exactly where that language is the SQL family's, and an SQL
 * dialect is held to its own rules.
 */
function agentOverlayRuleRefusals(engine: EngineDeclaration, at: string): SchemaRefusal[] {
  const { statementLanguage, overlay } = engine.agent;
  const pointer = `${at}/agent/overlay`;
  if (statementLanguage === null) return overlay === null ? [] : [schemaRefusal("agent-overlay-unspoken", pointer)];
  if (overlay === null) return [schemaRefusal("agent-overlay-missing", pointer)];
  const { dialect } = overlay;
  if (statementLanguage !== DIALECT_LANGUAGE) {
    return dialect === null ? [] : [schemaRefusal("agent-dialect-unspoken", `${pointer}/dialect`)];
  }
  if (dialect === null) return [schemaRefusal("agent-dialect-missing", `${pointer}/dialect`)];
  return sqlDialectRefusals(dialect, `${pointer}/dialect`);
}

/**
 * The container level lists an object model may state, outermost first, each as its level ids joined by commas: none, a
 * lone schema, a lone catalog, and a catalog then the schema inside it. These are the lists the shipped engines state,
 * and the ones Studio's object kind readers read, which take a catalog level for the outer one wherever it stands.
 */
const CONTAINER_LEVEL_LISTS: readonly string[] = Object.freeze(["", "schema", "catalog", "catalog,schema"]);

/**
 * The rules of an engine's object model the schema cannot state, at pointers under `at`: each container level id and
 * each object kind id once, the later repeat refused, the container levels one of `CONTAINER_LEVEL_LISTS`, refused at
 * the levels' pointer (a list with a repeated level is the duplicate rule's refusal alone), and every kind the declaration names elsewhere one the model
 * states: a masked kind, a row action's kind, a child kind, an attached kind, a maintenance spec's kind and a catalog
 * capture's kind word. A repeated kind still counts as stated, so only the repeat itself is refused. At most one row
 * action states `activates` for a kind: a later activating action naming a kind an earlier one names is refused at its
 * `activates`. Each kind's source members agree with its `hasSource`: a kind with source states its `sourceLanguage`,
 * and a kind without source states none and does not accept source edits, each refused at the member's pointer as
 * `object-source-inconsistent`. A declaration that states no model is read by none of them here:
 * `manifestRuleRefusals` refuses its facet kinds, since no model states any kind, requires a model where the package
 * offers objects.tree or objects.source, and refuses a kind with source where the package does not offer
 * objects.source. A declaration read alone keeps those rules out, so a legacy declaration with no model stays admitted
 * under `validateEngine`.
 */
function objectModelRuleRefusals(engine: EngineDeclaration, at: string): SchemaRefusal[] {
  const model = engine.objects;
  if (model === undefined) return [];
  const refusals: SchemaRefusal[] = [];
  const base = `${at}/objects`;
  const levels = new Set<string>();
  model.containerLevels.forEach(({ id }, index) => {
    if (levels.has(id)) refusals.push(schemaRefusal("object-level-duplicate", `${base}/containerLevels/${index}/id`));
    levels.add(id);
  });
  const levelList = model.containerLevels.map(({ id }) => id).join(",");
  if (levels.size === model.containerLevels.length && !CONTAINER_LEVEL_LISTS.includes(levelList)) {
    refusals.push(schemaRefusal("object-level-order", `${base}/containerLevels`));
  }
  const stated = new Set<string>();
  model.objectKinds.forEach(({ id }, index) => {
    if (stated.has(id)) refusals.push(schemaRefusal("object-kind-duplicate", `${base}/objectKinds/${index}/id`));
    stated.add(id);
  });
  const named = (kind: string, pointer: string) => {
    if (!stated.has(kind)) refusals.push(schemaRefusal("object-kind-unstated", pointer));
  };
  model.maskedNameKinds.forEach((kind, index) => named(kind, `${base}/maskedNameKinds/${index}`));
  const activated = new Set<string>();
  model.rowActions.forEach((action, index) => {
    action.kinds.forEach((kind, position) => named(kind, `${base}/rowActions/${index}/kinds/${position}`));
    if (!action.activates) return;
    if (action.kinds.some((kind) => activated.has(kind))) {
      refusals.push(schemaRefusal("object-row-activation-duplicate", `${base}/rowActions/${index}/activates`));
    }
    for (const kind of action.kinds) activated.add(kind);
  });
  model.objectKinds.forEach(({ childKinds, attachedTo }, index) => {
    childKinds.forEach((kind, position) => named(kind, `${base}/objectKinds/${index}/childKinds/${position}`));
    if (attachedTo !== null) named(attachedTo, `${base}/objectKinds/${index}/attachedTo`);
  });
  model.objectKinds.forEach(({ hasSource, sourceLanguage, acceptsSourceEdits }, index) => {
    const at = `${base}/objectKinds/${index}`;
    if (hasSource === (sourceLanguage === null)) {
      refusals.push(schemaRefusal("object-source-inconsistent", `${at}/sourceLanguage`));
    }
    if (acceptsSourceEdits && !hasSource)
      refusals.push(schemaRefusal("object-source-inconsistent", `${at}/acceptsSourceEdits`));
  });
  for (const [kind, pointer] of facetKindReferences(engine, at)) named(kind, pointer);
  return refusals;
}

/**
 * Each object kind an engine declaration names outside its object model, with its pointer under `at`: a maintenance
 * spec's kind and a catalog capture's kind word.
 */
function facetKindReferences(engine: EngineDeclaration, at: string): [kind: string, pointer: string][] {
  const references: [kind: string, pointer: string][] = [];
  engine.facets.maintenanceSpecs.forEach(({ kinds }, index) => {
    kinds?.forEach((kind, position) =>
      references.push([kind, `${at}/facets/maintenanceSpecs/${index}/kinds/${position}`]),
    );
  });
  engine.agent.overlay?.dialect?.catalogCapture?.kindWords.forEach(({ kind }, index) => {
    references.push([kind, `${at}/agent/overlay/dialect/catalogCapture/kindWords/${index}/kind`]);
  });
  return references;
}

/** Whether `text` is exactly one well-formed code point, never a lone surrogate. */
function isOneCharacter(text: string): boolean {
  return [...text].length === 1 && text.isWellFormed();
}

/**
 * The rules of one key check's value rule the schema cannot state, at pointers under `at`, the check's pointer: an
 * integer rule's range holds a value and its default; a name rule's character range runs from one well-formed code
 * point up to another, and its length range holds a length; and where all of those hold, each name it refuses is one
 * it could admit (`refusedNameRefusals`).
 */
function requestRuleRefusals(check: AgentRequestKeyCheck, at: string): SchemaRefusal[] {
  const { rule } = check;
  const pointer = `${at}/rule`;
  const refusals: SchemaRefusal[] = [];
  if (rule.kind === "integer") {
    if (rule.minimum > rule.maximum) refusals.push(schemaRefusal("request-integer-range-empty", `${pointer}/minimum`));
    if (rule.default !== null && (rule.default < rule.minimum || rule.default > rule.maximum)) {
      refusals.push(schemaRefusal("request-integer-default-outside", `${pointer}/default`));
    }
  }
  if (rule.kind === "name") {
    rule.characters.forEach(({ from, to }, index) => {
      const range = `${pointer}/characters/${index}`;
      const ends = [
        ["from", from],
        ["to", to],
      ] as const;
      const malformed = ends.filter(([, end]) => !isOneCharacter(end));
      for (const [name] of malformed) {
        refusals.push(schemaRefusal("request-name-range-not-one-character", `${range}/${name}`));
      }
      if (malformed.length === 0 && (from.codePointAt(0) as number) > (to.codePointAt(0) as number)) {
        refusals.push(schemaRefusal("request-name-range-reversed", range));
      }
    });
    if (rule.minLength > rule.maxLength)
      refusals.push(schemaRefusal("request-name-length-empty", `${pointer}/minLength`));
    if (refusals.length === 0) refusals.push(...refusedNameRefusals(rule, pointer));
  }
  return refusals;
}

/**
 * The refused names and prefixes of a name rule whose ranges and length hold a name, at pointers under `at`, the rule's
 * pointer, that no name the rule admits could hold: a refused name that is not well-formed, holds a code point outside
 * every range, or whose length in code points is outside the rule's length range; and a refused prefix that is not
 * well-formed, holds a code point outside every range, or is longer than the longest name. Such an entry never refuses
 * anything, so a form that lists one reads as refusing what it never refuses.
 */
function refusedNameRefusals(
  rule: Extract<AgentRequestKeyCheck["rule"], { kind: "name" }>,
  at: string,
): SchemaRefusal[] {
  const within = (text: string) =>
    text.isWellFormed() &&
    [...text].every((character) => {
      const point = character.codePointAt(0) as number;
      return rule.characters.some(
        ({ from, to }) => point >= (from.codePointAt(0) as number) && point <= (to.codePointAt(0) as number),
      );
    });
  const refusals: SchemaRefusal[] = [];
  rule.refused.forEach(({ names, prefixes }, group) => {
    names.forEach((name, index) => {
      const length = [...name].length;
      if (!within(name) || length < rule.minLength || length > rule.maxLength) {
        refusals.push(schemaRefusal("request-name-refused-unreachable", `${at}/refused/${group}/names/${index}`));
      }
    });
    prefixes.forEach((prefix, index) => {
      if (!within(prefix) || [...prefix].length > rule.maxLength) {
        refusals.push(schemaRefusal("request-name-refused-unreachable", `${at}/refused/${group}/prefixes/${index}`));
      }
    });
  });
  return refusals;
}

/** One text's list of the values Studio fills into it, frozen, with each name kept as its literal type. */
function fills<const Names extends readonly string[]>(...names: Names): Readonly<Names> {
  return Object.freeze(names);
}

/**
 * The values Studio fills into each text of a statement language's agent part, by the text's group and name under
 * `statementLanguageData.agent.text`: rows, the most rows a read answers; seconds, the most seconds a read runs; noun,
 * what the inventory calls one of its objects; allowed, the most rows a refused read may ask for. A text names only its
 * own values in a fill, which `agentTextRefusals` holds; core fills each text from this table. The table is frozen
 * whole, each text's list of fills included.
 */
export const AGENT_TEXT_FILLS = Object.freeze({
  copy: Object.freeze({ subject: fills(), noun: fills(), writes: fills(), reached: fills(), defect: fills() }),
  investigation: Object.freeze({
    classifierDescription: fills(),
    objective: fills(),
    toolDescription: fills(),
    toolRule: fills(),
  }),
  posture: Object.freeze({
    qualifier: fills("rows", "seconds"),
    title: fills("rows", "seconds"),
    body: fills("rows", "seconds"),
    handover: fills("rows", "seconds"),
  }),
  grounding: Object.freeze({ omissionAdvice: fills(), ungrounded: fills("noun") }),
  advice: Object.freeze({ rowCap: fills("allowed"), shape: fills() }),
} as const satisfies {
  readonly [Group in keyof AgentLanguageText]: { readonly [Name in keyof AgentLanguageText[Group]]: readonly string[] };
});

/**
 * The values Studio fills into each text of a statement language's MCP statement tool, by the text's name under
 * `statementLanguageData.agent.mcp.text`: engines, the served engines' names; limits, the result limits every statement
 * tool shares; shown, the number of rows a cut result returned. A text names only its own values in a fill, which
 * `agentTextRefusals` holds as it holds `AGENT_TEXT_FILLS`; core fills each text from this table. A table of its own,
 * since the tool may be null where every group of `AGENT_TEXT_FILLS` is required. Frozen whole, each list included.
 */
export const AGENT_MCP_TEXT_FILLS = Object.freeze({
  title: fills(),
  description: fills("engines", "limits"),
  fewerFields: fills(),
  readPast: fills("shown"),
  rowOverCap: fills(),
} as const satisfies { readonly [Name in keyof AgentMcpText]: readonly string[] });

/**
 * Every tool Studio's agent mode may offer a run, in any workflow and any statement language: the names a rule text is
 * read against (`agentToolsNamedIn`). It holds tools no declared language is offered, so a rule naming one is refused,
 * never read as plain text. Studio's census, tests/unit/lib/agent/tool-offer-census.test.ts, holds it equal to the
 * tools Studio's agent defines. Frozen.
 */
export const AGENT_TOOL_NAMES = Object.freeze([
  "inspect_schema",
  "run_read_query",
  "inspect_plan",
  "profile_table",
  "compare_plans",
  "recommend_change",
  "inspect_operations",
  "inspect_usage",
  "profile_workloads",
  "present_answer",
  "compose_report",
] as const);

/** A tool of Studio's agent mode, by name. */
type AgentToolVocabularyName = (typeof AGENT_TOOL_NAMES)[number];

/**
 * The tools Studio's agent mode offers each workflow of an engine's declared statement language, by workflow. A
 * declared language's investigation rule, `agent.text.investigation.toolRule`, is the one rule an engine's text states,
 * and names only the investigation's tools (`agentToolRuleRefusals`); the operations rule is Studio's own. Studio's
 * census, tests/unit/lib/agent/tool-offer-census.test.ts, holds each list equal to the tools Studio offers that workflow.
 * Frozen whole, each list included.
 */
export const AGENT_WORKFLOW_TOOLS = Object.freeze({
  investigation: Object.freeze(["run_read_query", "compose_report"] as const),
  operations: Object.freeze(["inspect_operations", "recommend_change", "compose_report"] as const),
} as const satisfies { readonly [Workflow: string]: readonly AgentToolVocabularyName[] });

/**
 * The tools of `AGENT_TOOL_NAMES` that `text`, a rule text, names, in the vocabulary's order: each name as a whole word,
 * except one written as an absence, the whole word "no" in any letter case before it ("there is no inspect_schema",
 * "No inspect_schema" at a sentence start), which says what a run does not hold. A tool name is lower-case letters and
 * underscores, so it is written into the expression as it stands and matched as written.
 */
export function agentToolsNamedIn(text: string): AgentToolVocabularyName[] {
  return AGENT_TOOL_NAMES.filter((tool) => new RegExp(`(?<!\\b[Nn][Oo] )\\b${tool}\\b`).test(text));
}

/**
 * The investigation's tool rule of an agent text, at the text's pointer `at`, where it names a tool the investigation
 * is not offered (`AGENT_WORKFLOW_TOOLS`): one refusal at the rule's pointer, however many such tools it names. A rule
 * written as parts is read as its string parts joined with nothing between them; a fill in it is refused by
 * `agent-text-fill-unknown` already.
 */
function agentToolRuleRefusals(text: AgentLanguageText, at: string): SchemaRefusal[] {
  const rule = text.investigation.toolRule;
  const written = typeof rule === "string" ? rule : rule.map((part) => (typeof part === "string" ? part : "")).join("");
  const offered: readonly string[] = AGENT_WORKFLOW_TOOLS.investigation;
  return agentToolsNamedIn(written).some((tool) => !offered.includes(tool))
    ? [schemaRefusal("agent-tool-not-offered", `${at}/investigation/toolRule`)]
    : [];
}

/**
 * The fills of the texts in `texts`, at pointers under `at`, their group's pointer, that name a value Studio does not
 * fill into that text: one rule for every agent text, `fills` listing the values each text of the group takes.
 */
function textFillRefusals(
  texts: Readonly<Record<string, AgentText>>,
  fills: Readonly<Record<string, readonly string[]>>,
  at: string,
): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  for (const [name, taken] of Object.entries(fills)) {
    const parts = texts[name] as AgentText;
    if (typeof parts === "string") continue;
    parts.forEach((part, index) => {
      if (typeof part !== "string" && !taken.includes(part.fill)) {
        refusals.push(schemaRefusal("agent-text-fill-unknown", `${at}/${name}/${index}/fill`));
      }
    });
  }
  return refusals;
}

/**
 * The fills of an agent text, at pointers under `at`, the text's pointer, that name a value Studio does not fill into
 * that text (`AGENT_TEXT_FILLS`).
 */
function agentTextRefusals(text: AgentLanguageText, at: string): SchemaRefusal[] {
  const groups = text as unknown as Readonly<Record<string, Readonly<Record<string, AgentText>>>>;
  return Object.entries(AGENT_TEXT_FILLS).flatMap(([group, members]) =>
    textFillRefusals(groups[group] as Readonly<Record<string, AgentText>>, members, `${at}/${group}`),
  );
}

/**
 * The rules of a request form the schema cannot state, at pointers under `at`, the form's pointer, so that an admission
 * reads the form whole. Every key a check, a refusal or the selector names is one of the form's keys. Each key is ruled
 * exactly once for each read: by the selector, a common check, the read's refusals or the read's checks, and with no
 * selector by a common check, so no key is admitted with a value no rule reads. Reads exist exactly where a selector
 * names them, no two of one value. And every value rule holds a value (`requestRuleRefusals`).
 */
function requestFormRefusals(form: AgentRequestForm, at: string): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const keys = new Set<string>(form.keys);
  const declared = (key: string, pointer: string) => {
    if (!keys.has(key)) refusals.push(schemaRefusal("request-key-undeclared", pointer));
  };
  const rule = (ruled: Set<string>, key: string, pointer: string) => {
    declared(key, pointer);
    if (ruled.has(key)) refusals.push(schemaRefusal("request-key-ruled-twice", pointer));
    ruled.add(key);
  };
  const common = new Set<string>();
  if (form.selector !== null) rule(common, form.selector.key, `${at}/selector/key`);
  form.common.forEach((check, index) => {
    rule(common, check.key, `${at}/common/${index}/key`);
    refusals.push(...requestRuleRefusals(check, `${at}/common/${index}`));
  });
  const values = new Set<string>();
  form.reads.forEach((read, index) => {
    const pointer = `${at}/reads/${index}`;
    if (values.has(read.value)) refusals.push(schemaRefusal("request-read-duplicate", `${pointer}/value`));
    values.add(read.value);
    const ruled = new Set(common);
    read.refuses.forEach(({ key }, position) => rule(ruled, key, `${pointer}/refuses/${position}/key`));
    read.checks.forEach((check, position) => {
      rule(ruled, check.key, `${pointer}/checks/${position}/key`);
      refusals.push(...requestRuleRefusals(check, `${pointer}/checks/${position}`));
    });
    if (form.selector !== null && form.keys.some((key) => !ruled.has(key))) {
      refusals.push(schemaRefusal("request-key-unruled", pointer));
    }
  });
  if (form.selector === null) {
    form.keys.forEach((key, index) => {
      if (!common.has(key)) refusals.push(schemaRefusal("request-key-unruled", `${at}/keys/${index}`));
    });
  }
  if ((form.selector === null) !== (form.reads.length === 0)) {
    refusals.push(schemaRefusal("request-reads-without-selector", `${at}/reads`));
  }
  return refusals;
}

/**
 * The rules of an engine's statement language data the schema cannot state, at pointers under `at`: the data's name is
 * the engine's agent statement language where both are stated; it is never the SQL family's name, since an engine that
 * speaks SQL states null; a reader kind that names no operation lists none, since no reader could ever answer one it
 * lists; and an agent part is stated only for an engine whose agent mode sends a statement, with a request form read
 * whole (`requestFormRefusals`), a text, and an MCP statement tool's texts where it states one, whose fills each name a
 * value Studio fills into that text (`agentTextRefusals`, `textFillRefusals`), and whose investigation tool rule names
 * only tools the investigation is offered (`agentToolRuleRefusals`).
 */
function statementLanguageDataRefusals(engine: EngineDeclaration, at: string): SchemaRefusal[] {
  const data = engine.statementLanguageData;
  if (data === null) return [];
  const refusals: SchemaRefusal[] = [];
  const pointer = `${at}/statementLanguageData`;
  const requested = engine.agent.statementLanguage;
  if (requested !== null && requested !== data.name) {
    refusals.push(schemaRefusal("statement-language-name-differs", `${pointer}/name`));
  }
  if (data.name === DIALECT_LANGUAGE) refusals.push(schemaRefusal("statement-language-data-sql", `${pointer}/name`));
  const { reader, operations } = data.confirmation;
  if (reader === "names-no-operation" && operations.length > 0) {
    refusals.push(schemaRefusal("confirmation-operations-unread", `${pointer}/confirmation/operations`));
  }
  if (data.agent !== null) {
    if (requested === null) refusals.push(schemaRefusal("statement-language-agent-unspoken", `${pointer}/agent`));
    refusals.push(...requestFormRefusals(data.agent.request, `${pointer}/agent/request`));
    refusals.push(...agentTextRefusals(data.agent.text, `${pointer}/agent/text`));
    refusals.push(...agentToolRuleRefusals(data.agent.text, `${pointer}/agent/text`));
    if (data.agent.mcp !== null) {
      const texts = data.agent.mcp.text as Readonly<Record<keyof AgentMcpText, AgentText>>;
      refusals.push(...textFillRefusals(texts, AGENT_MCP_TEXT_FILLS, `${pointer}/agent/mcp/text`));
    }
  }
  return refusals;
}

/**
 * The rules of one engine's connection, editor, SQL text, SQL writing facts, maintenance specs, agent readings, agent
 * overlay, statement language data, claims, safeguards and object model the schema cannot state, at pointers under
 * `at`.
 */
function engineRuleRefusals(engine: EngineDeclaration, at: string, vocabularies: FieldVocabularies): SchemaRefusal[] {
  const seedOnlyNames = vocabularies.seedOnly;
  const refusals: SchemaRefusal[] = [];
  const { connection } = engine;
  const fields = new Set<string>(connection.fields);
  const refusedSeen = new Set<string>();
  connection.refused.forEach(({ field }, index) => {
    const pointer = `${at}/connection/refused/${index}`;
    if (fields.has(field)) refusals.push(schemaRefusal("refused-field-declared", pointer));
    if (refusedSeen.has(field)) refusals.push(schemaRefusal("refused-field-duplicate", pointer));
    refusedSeen.add(field);
  });
  const seedOnly = new Set<string>(connection.seedOnly?.fields ?? []);
  connection.seedOnly?.fields.forEach((field, index) => {
    if (!fields.has(field) && !seedOnlyNames.has(field)) {
      refusals.push(schemaRefusal("seed-only-field-undeclared", `${at}/connection/seedOnly/fields/${index}`));
    }
  });
  connection.hostPathFields.forEach((field, index) => {
    if (!seedOnly.has(field)) {
      refusals.push(schemaRefusal("host-path-field-undeclared", `${at}/connection/hostPathFields/${index}`));
    }
  });
  refusals.push(...dialogRuleRefusals(connection, at, vocabularies));
  refusals.push(...hostAndWarningRuleRefusals(connection, at));
  refusals.push(...fieldRuleRefusals(connection, at));
  refusals.push(...connectionStringRuleRefusals(connection, at));
  refusals.push(...tlsModeRuleRefusals(connection, at, vocabularies.tlsModes));
  refusals.push(...editorRuleRefusals(engine, at, vocabularies));
  refusals.push(...clausePatternRefusals(engine, at));
  refusals.push(...sqlWritingRuleRefusals(engine, at, vocabularies));
  refusals.push(...maintenanceRuleRefusals(engine, at));
  refusals.push(...agentReadingRuleRefusals(engine, at));
  refusals.push(...agentOverlayRuleRefusals(engine, at));
  refusals.push(...statementLanguageDataRefusals(engine, at));
  refusals.push(...claimRuleRefusals(engine, at));
  refusals.push(...safeguardRuleRefusals(engine, at));
  refusals.push(...objectModelRuleRefusals(engine, at));
  return refusals;
}

/**
 * The rules of the manifest's fence aliases across its engines, which one engine's rules cannot see: an alias is never
 * the id of another engine of the manifest, and never an alias an earlier engine declares, so a tag names at most one
 * engine. The repeat is refused at the later engine.
 */
function fenceAliasRuleRefusals(engines: readonly EngineDeclaration[]): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  const ids = engines.map((engine) => engine.id);
  const declared = new Set<string>();
  engines.forEach((engine, position) => {
    engine.editor.fenceAliases.forEach((alias, index) => {
      const pointer = `/engines/${position}/editor/fenceAliases/${index}`;
      if (ids.some((id, other) => other !== position && id === alias)) {
        refusals.push(schemaRefusal("fence-alias-engine-id", pointer));
      }
      if (declared.has(alias)) refusals.push(schemaRefusal("fence-alias-duplicate", pointer));
    });
    for (const alias of engine.editor.fenceAliases) declared.add(alias);
  });
  return refusals;
}

/**
 * The proxy variables, upper-case, which `runtime.env` may not declare: a package never reads a proxy setting, so
 * every route out of Studio's process is core's. The lower-case forms are already refused by the name pattern.
 */
const PROXY_VARIABLES: readonly string[] = Object.freeze(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);

/**
 * The rules of a whole manifest the schema cannot state: no proxy variable in the environment, unique engine ids,
 * compatibility entries that match, fence aliases that name one engine each, an object model stated by every
 * engine where the package offers objects.tree or objects.source, since both are read only through it, no kind with
 * source where the package does not offer objects.source, since an engine's source is read only through it, and no
 * maintenance spec kind or catalog capture kind word in an engine that states no model, since no model states that
 * kind.
 */
function manifestRuleRefusals(manifest: ProviderManifest, vocabularies: FieldVocabularies): SchemaRefusal[] {
  const refusals: SchemaRefusal[] = [];
  manifest.runtime.env?.forEach((variable, index) => {
    if (PROXY_VARIABLES.includes(variable.name)) {
      refusals.push(schemaRefusal("env-proxy-variable", `/runtime/env/${index}/name`));
    }
  });
  const declared = new Set<string>();
  const covered = new Set(manifest.compatibility.map((entry) => entry.engine));
  manifest.engines.forEach((engine, index) => {
    if (declared.has(engine.id)) refusals.push(schemaRefusal("engine-id-duplicate", `/engines/${index}/id`));
    declared.add(engine.id);
    if (!covered.has(engine.id)) refusals.push(schemaRefusal("compatibility-engine-missing", `/engines/${index}/id`));
    if (engine.objects === undefined) {
      if (manifest.calls.objects.tree === "offered" || manifest.calls.objects.source === "offered") {
        refusals.push(schemaRefusal("object-model-missing", `/engines/${index}`));
      }
      for (const [, pointer] of facetKindReferences(engine, `/engines/${index}`)) {
        refusals.push(schemaRefusal("object-kind-unstated", pointer));
      }
    } else if (manifest.calls.objects.source !== "offered") {
      engine.objects.objectKinds.forEach(({ hasSource }, position) => {
        if (hasSource) {
          refusals.push(
            schemaRefusal("object-source-not-offered", `/engines/${index}/objects/objectKinds/${position}/hasSource`),
          );
        }
      });
    }
    refusals.push(...engineRuleRefusals(engine, `/engines/${index}`, vocabularies));
  });
  refusals.push(...fenceAliasRuleRefusals(manifest.engines));
  manifest.compatibility.forEach((entry, index) => {
    if (!declared.has(entry.engine)) {
      refusals.push(schemaRefusal("compatibility-engine-undeclared", `/compatibility/${index}/engine`));
    }
    const { versions } = entry;
    if (versions.kind !== "range") return;
    const tested = new Set(entry.tested.map((item) => item.version));
    for (const end of ["from", "to"] as const) {
      if (!tested.has(versions[end])) {
        refusals.push(schemaRefusal("compatibility-endpoint-untested", `/compatibility/${index}/versions/${end}`));
      }
    }
  });
  return refusals;
}

/** The members of the schema document the validator reads, which the digest guarantees are there. */
interface ServedSchema {
  readonly $id: string;
  readonly properties: { readonly contract: { readonly const: string } };
  readonly $defs: {
    readonly seedOnlyFieldName: { readonly enum: readonly string[] };
    readonly placeableFieldName: { readonly enum: readonly string[] };
    readonly selectFieldName: { readonly enum: readonly string[] };
    readonly genericFenceTag: { readonly enum: readonly string[] };
    readonly typeFamilies: { readonly properties: Readonly<Record<keyof TypeFamilies, unknown>> };
    readonly tlsMode: { readonly enum: readonly TlsMode[] };
  };
}

/** The errors a failed ajv validation reported; ajv sets them on every failure, so a failure without them is a fault. */
export function errorsOf(validate: ValidateFunction): readonly ErrorObject[] {
  if (!validate.errors) throw new Error("The manifest validator failed a value without reporting why.");
  return validate.errors;
}

/**
 * A validator for the schema in `schemaBytes`, which must be the schema this SDK was built with.
 *
 * @throws {ManifestSchemaDigestError} When the bytes' SHA-256 is not `MANIFEST_SCHEMA_SHA256`, before they are parsed.
 */
export function compileManifestValidator(schemaBytes: Uint8Array): ManifestValidator {
  const actual = createHash("sha256").update(schemaBytes).digest("hex");
  if (actual !== MANIFEST_SCHEMA_SHA256) throw new ManifestSchemaDigestError(MANIFEST_SCHEMA_SHA256, actual);
  const schema = JSON.parse(new TextDecoder().decode(schemaBytes)) as ServedSchema;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validateManifest = ajv.compile(schema);
  const validateEnvelope = ajv.compile({ $ref: `${schema.$id}#/$defs/envelope` });
  const validateDeclaration = ajv.compile({ $ref: `${schema.$id}#/$defs/engineDeclaration` });
  const contract = schema.properties.contract.const;
  const vocabularies: FieldVocabularies = {
    seedOnly: new Set(schema.$defs.seedOnlyFieldName.enum),
    placeable: new Set(schema.$defs.placeableFieldName.enum),
    select: new Set(schema.$defs.selectFieldName.enum),
    genericFenceTags: new Set(schema.$defs.genericFenceTag.enum),
    typeFamilyKinds: Object.keys(schema.$defs.typeFamilies.properties) as (keyof TypeFamilies)[],
    tlsModes: schema.$defs.tlsMode.enum,
  };

  return {
    contract,
    validate(value) {
      if (!validateEnvelope(value)) return { admitted: false, refusals: refusalsOf(errorsOf(validateEnvelope)) };
      const declared = (value as { contract: string }).contract;
      if (declared !== contract) {
        return { admitted: false, refusals: [{ code: "PROVIDER_CONTRACT_UNSUPPORTED", contract: declared }] };
      }
      if (!validateManifest(value)) return { admitted: false, refusals: refusalsOf(errorsOf(validateManifest)) };
      const manifest = value as ProviderManifest;
      const refusals = ordered(manifestRuleRefusals(manifest, vocabularies));
      return refusals.length === 0 ? { admitted: true, manifest } : { admitted: false, refusals };
    },
    validateEngine(value) {
      if (!validateDeclaration(value)) return { admitted: false, refusals: refusalsOf(errorsOf(validateDeclaration)) };
      const engine = value as EngineDeclaration;
      const refusals = ordered(engineRuleRefusals(engine, "", vocabularies));
      return refusals.length === 0 ? { admitted: true, engine } : { admitted: false, refusals };
    },
  };
}

/**
 * A refusal in one sentence for people, naming where it is and, for a key, which, quoted as a JSON string so the
 * sentence stays one line; never a value of the manifest.
 */
export function refusalSentence(refusal: ManifestRefusal): string {
  if (refusal.code === "PROVIDER_CONTRACT_UNSUPPORTED") {
    return `The manifest was built against provider contract ${refusal.contract}, which this SDK does not serve.`;
  }
  const at = refusal.pointer === "" ? "the top level" : refusal.pointer;
  switch (refusal.rule) {
    case "unknown-key":
      return `The manifest has the key ${JSON.stringify(refusal.key)} at ${at}, which the provider contract does not define there.`;
    case "missing-key":
      return `The manifest lacks the key ${JSON.stringify(refusal.key)} at ${at}, which the provider contract requires there.`;
    case "wrong-type":
      return `The value at ${at} is not of the type the provider contract defines there.`;
    case "value-not-allowed":
      return `The value at ${at} is not one the provider contract allows there.`;
    case "pattern-mismatch":
      return `The value at ${at} does not have the form the provider contract defines there.`;
    case "out-of-range":
      return `The value at ${at} is outside the range or length the provider contract allows there.`;
    case "too-few":
      return `The list at ${at} has fewer items than the provider contract requires there.`;
    case "too-many":
      return `The list at ${at} has more items than the provider contract allows there.`;
    case "duplicate":
      return `The item at ${at} repeats an earlier item of its list.`;
    case "no-variant":
      return `The value at ${at} has none of the shapes the provider contract defines there.`;
    case "engine-id-duplicate":
      return `The engine id at ${at} repeats the id of an earlier engine.`;
    case "compatibility-engine-missing":
      return `The engine whose id is at ${at} has no compatibility entry.`;
    case "compatibility-engine-undeclared":
      return `The compatibility entry's engine at ${at} is not an engine the manifest declares.`;
    case "compatibility-endpoint-untested":
      return `The range endpoint at ${at} is not one of the entry's tested versions.`;
    case "refused-field-declared":
      return `The refused field at ${at} is also one of the engine's connection fields.`;
    case "refused-field-duplicate":
      return `The refused field at ${at} is already refused by an earlier entry.`;
    case "seed-only-field-undeclared":
      return `The seed-only field at ${at} is neither one of the engine's connection fields nor a seed-only field name.`;
    case "host-path-field-undeclared":
      return `The host path field at ${at} is not one of the engine's seed-only fields.`;
    case "field-undeclared":
      return `The field named at ${at} is not one of the engine's connection fields.`;
    case "dialog-entry-duplicate":
      return `The field named at ${at} already has an entry earlier in its list.`;
    case "placement-missing":
      return `The placeable field at ${at} has no placement in the engine's connection dialog.`;
    case "options-missing":
      return `The select field at ${at} has no choices in the engine's connection dialog.`;
    case "option-value-duplicate":
      return `The choice value at ${at} repeats the value of an earlier choice of its field.`;
    case "shown-when-chained":
      return `The condition at ${at} reads a field that is itself drawn only under a condition.`;
    case "shown-when-value-not-an-option":
      return `The condition value at ${at} is not one of the choices of the field it reads.`;
    case "absent-value-not-an-option":
      return `The absent value at ${at} is not one of the choices of its field.`;
    case "absent-value-unread":
      return `The field named at ${at} has an absent value, but no condition reads it.`;
    case "absent-value-missing":
      return `The select field named at ${at} is read by a condition but declares no absent value.`;
    case "host-uri-schemes-without-host":
      return `The URI schemes at ${at} are declared for an engine that takes no host field.`;
    case "credential-warning-field-undeclared":
      return `The credential warning at ${at} reads a field that is not one of the engine's connection fields.`;
    case "no-secret-warning-duplicate":
      return `The credential warning at ${at} is a second no-secret warning of its engine.`;
    case "env-proxy-variable":
      return `The environment variable at ${at} is a proxy setting, which a package never reads.`;
    case "field-rule-duplicate":
      return `The field named at ${at} already has a rule earlier in the engine's field rules.`;
    case "field-rule-empty":
      return `The field rule at ${at} states no check: its required, format, character range and check are all null.`;
    case "pattern-invalid":
      return `The pattern at ${at} does not compile as a regular expression with its flags.`;
    case "char-range-inverted":
      return `The character range at ${at} has a minimum greater than its maximum.`;
    case "host-reader-without-host":
      return `The Host text reader at ${at} is named for an engine that takes no host field.`;
    case "scheme-without-paste":
      return `The scheme at ${at} is declared for an engine whose connection string names no paste reader.`;
    case "url-tls-without-paste":
      return `The URL TLS reader at ${at} is named for an engine whose connection string names no paste reader.`;
    case "tls-mode-order":
      return `The TLS mode at ${at} is listed after a mode the provider contract orders after it.`;
    case "fence-alias-engine-id":
      return `The fence alias at ${at} is the id of an engine of the manifest, which is already a fence tag naming that engine.`;
    case "fence-alias-duplicate":
      return `The fence alias at ${at} is already declared by an earlier engine of the manifest.`;
    case "fence-alias-generic":
      return `The fence alias at ${at} is a generic fence tag, which names a language several engines speak and no engine.`;
    case "wrapper-group-count":
      return `The wrapper pattern at ${at} does not capture exactly one group, the wrapped type.`;
    case "type-name-duplicate":
      return `The type name at ${at} is already named earlier in the same table.`;
    case "statement-read-unexposed":
      return `The statement read claim at ${at} is made for an engine whose MCP claims do not expose it.`;
    case "agent-credential-form-missing":
      return `The agent credential claim at ${at} is made for an engine whose seeds take no agent credential.`;
    case "agent-credential-seed-form-differs":
      return `The seed agent credential at ${at} is not in the form the engine's agent credential form request names.`;
    case "read-roots-field-undeclared":
      return `The read roots claim at ${at} is made for an engine whose seed-only fields do not name agentReadRoots.`;
    case "denied-file-access-unread":
      return `The denied file access refusal at ${at} is stated for an engine that reads no file-access posture.`;
    case "masking-exemption-unanchored":
      return `The masking exemption pattern at ${at} does not match whole column names only: it must open with ^, close with an unescaped $ and keep every alternative inside a group.`;
    case "write-reach-summary-differs":
      return `The write reach claim at ${at} is not the summary of the engine's write paths.`;
    case "editor-write-path-unproven":
      return `The editor write path at ${at} is absent but names no proof of what keeps it so.`;
    case "metadata-operation-duplicate":
      return `The metadata operation at ${at} is already named by an earlier operation.`;
    case "metadata-column-duplicate":
      return `The metadata column at ${at} is already named earlier in its operation.`;
    case "maintenance-spec-unlisted":
      return `The maintenance spec's operation at ${at} is not one the engine's maintenance list names.`;
    case "maintenance-spec-duplicate":
      return `The maintenance spec's operation at ${at} already has an earlier spec.`;
    case "maintenance-spec-missing":
      return `The maintenance operation at ${at} has no spec in the engine's maintenance specs.`;
    case "maintenance-spec-unplaced":
      return `The maintenance spec at ${at} places its operation neither on a row nor over the whole database, which only kill's may.`;
    case "maintenance-typed-confirmation-unasked":
      return `The typed confirmation at ${at} is admitted only on a spec placed over the whole database alone, with a title and a description: only that spec's operation is sent by its declared card alone, whose typed dialog asks for the connection's name under the title and the description.`;
    case "maintenance-typed-target-unasked":
      return `The typed target at ${at} is admitted only on a spec placed on a row alone: only that spec's operation is sent from its objects' rows alone, whose dialog asks for the object's own name.`;
    case "maintenance-preview-unplaced":
      return `The maintenance preview at ${at} is declared for a spec no per-row control shows it on.`;
    case "agent-reading-panel-not-offered":
      return `The agent reading at ${at} is read through a monitoring panel the engine does not offer.`;
    case "agent-overlay-missing":
      return `The agent overlay at ${at} is null for an engine that speaks a statement language, whose overlay the provider contract requires.`;
    case "agent-overlay-unspoken":
      return `The agent overlay at ${at} is stated for an engine that speaks no statement language.`;
    case "agent-dialect-missing":
      return `The dialect at ${at} is null for an engine of the SQL family, whose dialect-bound members the provider contract requires.`;
    case "agent-dialect-unspoken":
      return `The dialect at ${at} is stated for an engine whose family has no member bound to its dialect.`;
    case "statement-language-name-differs":
      return `The statement language data's name at ${at} is not the statement language the engine's agent segment names.`;
    case "statement-language-data-sql":
      return `The statement language data's name at ${at} is the SQL family's, whose engines state no statement language data.`;
    case "confirmation-operations-unread":
      return `The operations at ${at} are listed for a reader kind that names no operation, so no statement could ever run one.`;
    case "statement-language-agent-unspoken":
      return `The agent part at ${at} is stated for an engine whose agent mode sends no statement.`;
    case "request-key-undeclared":
      return `The request key named at ${at} is not one of the request form's keys.`;
    case "request-key-unruled":
      return `The request form at ${at} leaves a key of the form with no rule, so a value no rule reads would be admitted.`;
    case "request-key-ruled-twice":
      return `The request key named at ${at} is already ruled for the same read by the selector, a common check, a refusal or a check.`;
    case "request-read-duplicate":
      return `The read's value at ${at} is already the value of an earlier read.`;
    case "request-reads-without-selector":
      return `The reads at ${at} are not stated exactly where a selector names them: a form with a selector states its reads, and one without states none.`;
    case "request-integer-range-empty":
      return `The integer rule's minimum at ${at} is above its maximum, so no value is admitted.`;
    case "request-integer-default-outside":
      return `The integer rule's default at ${at} is outside its range.`;
    case "request-name-range-reversed":
      return `The character range at ${at} runs from a code point above the one it runs to.`;
    case "request-name-range-not-one-character":
      return `The character range's end at ${at} is not exactly one well-formed character.`;
    case "request-name-length-empty":
      return `The name rule's minimum length at ${at} is above its maximum length, so no name is admitted.`;
    case "request-name-refused-unreachable":
      return `The refused name or prefix at ${at} is or opens no name the rule admits, so it refuses nothing.`;
    case "agent-text-fill-unknown":
      return `The fill at ${at} names a value Studio does not fill into that text.`;
    case "agent-tool-not-offered":
      return `The tool rule at ${at} names a tool of Studio's agent that its workflow does not offer.`;
    case "statistics-without-catalog-read":
      return `The statistics reading at ${at} is stated beside no catalog read, whose statistics kind it reads.`;
    case "catalog-capture-without-catalog-read":
      return `The catalog capture at ${at} is stated beside no catalog read, through which it reads the catalog.`;
    case "capture-kind-word-duplicate":
      return `The kind word at ${at} is already given by an earlier kind word of the capture.`;
    case "plan-estimate-prefix-executes":
      return `The estimating prefix at ${at} holds ANALYZE or ANALYSE, a word that runs the plan rather than estimating it.`;
    case "object-model-missing":
      return `The engine declaration at ${at} states no object model, which an engine of a package that offers objects.tree or objects.source states.`;
    case "object-level-duplicate":
      return `The container level id at ${at} repeats the id of an earlier level of the engine's object model.`;
    case "object-level-order":
      return `The container levels at ${at} are not none, a schema, a catalog, or a catalog then the schema inside it.`;
    case "object-kind-duplicate":
      return `The object kind id at ${at} repeats the id of an earlier kind of the engine's object model.`;
    case "object-kind-unstated":
      return `The object kind at ${at} is not one the engine's object model states, or the engine states no object model.`;
    case "object-row-activation-duplicate":
      return `The row action at ${at} activates a row of a kind an earlier activating row action of the engine's object model already names.`;
    case "object-source-inconsistent":
      return `The object kind member at ${at} contradicts the kind's hasSource: a kind with source states its source language, and only a kind with source states one or accepts source edits.`;
    case "object-source-not-offered":
      return `The object kind at ${at} has source, which an engine reads only through objects.source, and the package does not offer it.`;
  }
}
