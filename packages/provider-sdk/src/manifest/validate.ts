/**
 * The provider manifest validator (docs/providers/CONTRACT.md, the manifest chapter).
 *
 * `compileManifestValidator` takes the bytes of the schema file, refuses them unless their SHA-256 is
 * `MANIFEST_SCHEMA_SHA256`, and compiles them with ajv's documented JSON Schema 2020-12 entry, `ajv/dist/2020`, in
 * strict mode with every error reported. The caller reads the bytes: the SDK reads no file and keeps no state, so each
 * call builds its own ajv instance and two validators share nothing.
 *
 * A manifest is read in three steps. The envelope first, `{ contract }`, which every contract keeps, so a host can tell
 * a manifest built against another contract from a broken one. Then, only for the contract this schema serves, the
 * whole schema. Then, only on a manifest the schema admits, the rules JSON Schema cannot state, each a code rule with a
 * name of its own. Every failure is a refusal naming its rule and a JSON Pointer into the manifest, and the key for an
 * unknown or missing one; no refusal carries a value of the manifest, except the refusal of a contract this SDK does
 * not serve, which names the contract the envelope declares.
 */
import { createHash } from "node:crypto";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { type EngineDeclaration, MANIFEST_SCHEMA_SHA256, type ProviderManifest } from "./manifest-types.generated";

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
  "fence-alias-engine-id",
  "fence-alias-duplicate",
  "fence-alias-generic",
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

/** The vocabularies of the schema the rules read: the seed-only, placeable and select field names, and the generic fence tags. */
interface FieldVocabularies {
  readonly seedOnly: ReadonlySet<string>;
  readonly placeable: ReadonlySet<string>;
  readonly select: ReadonlySet<string>;
  readonly genericFenceTags: ReadonlySet<string>;
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
 * takes a host field. Where a rule is repeated, the first is the one the dialog reads.
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
 * compiles with its flags.
 */
function clausePatternRefusals(engine: EngineDeclaration, at: string): SchemaRefusal[] {
  return engine.sqlText.grammar.trailingLimitClauses.flatMap(({ source, flags }, index) =>
    compiled(source, flags) === null
      ? [schemaRefusal("pattern-invalid", `${at}/sqlText/grammar/trailingLimitClauses/${index}/source`)]
      : [],
  );
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

/** The rules of one engine's connection, editor and SQL text facts the schema cannot state, at pointers under `at`. */
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
  refusals.push(...editorRuleRefusals(engine, at, vocabularies));
  refusals.push(...clausePatternRefusals(engine, at));
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
 * compatibility entries that match, and fence aliases that name one engine each.
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
    case "fence-alias-engine-id":
      return `The fence alias at ${at} is the id of an engine of the manifest, which is already a fence tag naming that engine.`;
    case "fence-alias-duplicate":
      return `The fence alias at ${at} is already declared by an earlier engine of the manifest.`;
    case "fence-alias-generic":
      return `The fence alias at ${at} is a generic fence tag, which names a language several engines speak and no engine.`;
  }
}
