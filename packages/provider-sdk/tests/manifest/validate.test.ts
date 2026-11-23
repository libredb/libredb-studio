/**
 * Every failure of a manifest is a named refusal, and no refusal carries a value of the manifest
 * (docs/providers/CONTRACT.md, clauses M-4, M-5, M-7, M-11 and M-14).
 *
 * Each case starts from the minimal fixture, changes one thing, and asserts the exact refusal list, so a change in how
 * ajv reports an error fails here rather than reaching a host as a different refusal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  compileManifestValidator,
  type ManifestRefusal,
  refusalSentence,
  type SchemaRefusal,
  SCHEMA_REFUSAL_RULES,
  type SchemaRefusalRule,
} from "@libredb/provider-sdk/manifest";
import { errorsOf, refusalsOf } from "../../src/manifest/validate";
import { boundedChild } from "../helpers/node-child";

const SCHEMA_BYTES = readFileSync(path.join(import.meta.dir, "../../src/manifest/manifest.schema.json"));
const validator = compileManifestValidator(SCHEMA_BYTES);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a draft manifest each case bends into a shape the schema refuses.
type Json = Record<string, any>;

/** A fresh copy of the minimal fixture, changed by `change`. */
function manifest(change: (draft: Json) => void = () => {}): Json {
  const draft = JSON.parse(readFileSync(path.join(import.meta.dir, "../fixtures/minimal-manifest.json"), "utf8"));
  change(draft);
  return draft;
}

function refusal(rule: SchemaRefusalRule, pointer: string, key?: string): SchemaRefusal {
  return key === undefined
    ? { code: "PROVIDER_SCHEMA_INVALID", rule, pointer }
    : { code: "PROVIDER_SCHEMA_INVALID", rule, pointer, key };
}

function refusalsFor(value: unknown): readonly ManifestRefusal[] {
  const verdict = validator.validate(value);
  return verdict.admitted ? [] : verdict.refusals;
}

const SEED_ONLY = {
  fields: ["database"],
  scope: "each",
  refusal: "{field} is ExampleDB only.",
  projectionRefusal: null,
};
const NATIVE = {
  package: "exampledb-native-linux-x64",
  version: "1.2.3",
  targets: [{ os: "linux", cpu: "x64", libc: "glibc" }],
  nodeApi: 8,
};

/** The connection of the fixture's one engine. */
const connectionOf = (m: Json): Json => m.engines[0].connection;

/** The connection string of the fixture's one engine. */
const connectionStringOf = (m: Json): Json => m.engines[0].connection.connectionString;

/** The editor facts of the fixture's one engine. */
const editorOf = (m: Json): Json => m.engines[0].editor;

/** The SQL text facts of the fixture's one engine. */
const sqlTextOf = (m: Json): Json => m.engines[0].sqlText;

/** The SQL grammar facts of the fixture's one engine. */
const grammarOf = (m: Json): Json => m.engines[0].sqlText.grammar;

/** The pointer of the fixture's one engine's SQL text facts. */
const SQL_TEXT = "/engines/0/sqlText";

/** A trailing limit clause pattern matching `words` at a statement's end, with `flags`. */
function clause(words: string, flags = "i"): Json {
  return { source: `\\s+${words}\\s*$`, flags };
}

/** A grammar stating every fact the SDK's SqlGrammar may leave out, each with a value other than its absent reading. */
function everyGrammarFact(m: Json): void {
  Object.assign(grammarOf(m), {
    hash: "code",
    bracket: "subscript",
    blockComment: "nesting",
    alternateQuoting: true,
    doubleSlashComment: true,
    backslashAlwaysEscapes: true,
    tripleQuotedStrings: true,
    backtickBackslashEscapes: true,
    dollarTags: false,
    doubleQuoteBackslashEscapes: false,
    singleQuoteBackslashEscapes: true,
    rawStrings: true,
    hintsAreCode: true,
    lineCommentBackslashContinues: true,
    lineCommentEndsAtCarriageReturn: true,
    script: { blocks: "pl-sql", separatorLine: "/", unit: "batch", terminatedStatements: ["MERGE"] },
    trailingLimitClauses: [clause("BYPASS\\s+CACHE"), clause("ALLOW\\s+FILTERING", "iu")],
    nonNumericRowBounds: ["ALL", "$$$$"],
    confirmForms: [
      ["CREATE", "STAGE"],
      ["COPY", "INTO", "LOCATION"],
    ],
    confirmCodeForms: [
      ["SYSTEM", "FUNCTION"],
      { prefix: "SYSTEM$" },
      { wordThenLiteral: "USING" },
      { wordThenBody: "DO" },
      { quotedCall: "REFLECT" },
      { computedCall: "IDENTIFIER" },
      { dollarQuoted: true },
    ],
    confirmFormsWhen: [{ form: ["CREATE", "STAGE"], when: "URL" }],
    confirmExemptForms: [["ALTER", "SESSION", "SET"]],
    formatterLanguage: "snowflake",
    completionWords: { keywords: ["ASOF JOIN", "QUALIFY"], functions: ["IFF", "TRY_CAST"] },
    confirmConfigKeys: ["spark.sql.defaultCatalog", "spark.sql.catalog."],
    explainExecutesWithAnalyze: true,
  });
}

/** The SQL writing facts of the fixture's one engine. */
const sqlWritingOf = (m: Json): Json => m.engines[0].sqlWriting;

/** The type vocabulary of the fixture's one engine's result export. */
const vocabularyOf = (m: Json): Json => m.engines[0].sqlWriting.export.typeVocabulary;

/** The pointer of the fixture's one engine's SQL writing facts. */
const SQL_WRITING = "/engines/0/sqlWriting";

/** The pointer of the fixture's one engine's type vocabulary. */
const VOCABULARY = `${SQL_WRITING}/export/typeVocabulary`;

/** A type pattern of `source` with `flags`. */
function typePattern(source: string, flags = ""): Json {
  return { source, flags };
}

const SCHEMA_PATH = path.join(import.meta.dir, "../../src/manifest/manifest.schema.json");

interface WrapperCountDeps {
  readonly compileManifestValidator: typeof compileManifestValidator;
  readonly manifest: Json;
  readonly readFileSync: typeof readFileSync;
}

interface WrapperCountReport {
  readonly sourceLength: number;
  readonly admitted: boolean;
}

/**
 * Runs in the child, from its text, with the schema's path as its name: the minimal fixture whose wrapper pattern is
 * anchored, captures one group and fits the schema's length bound, yet takes 2 to the 50th steps to fail on the empty
 * string, since each of its 50 `(?:\B|\B)` alternations is retried before the group that can never match. Counting
 * that pattern's groups by running it against the empty string never returns, so the child is killed at its timeout.
 */
function runWrapperCount(deps: WrapperCountDeps, schemaPath: string): WrapperCountReport {
  const validator = deps.compileManifestValidator(deps.readFileSync(schemaPath));
  const manifest = JSON.parse(JSON.stringify(deps.manifest));
  const source = `^${"(?:\\B|\\B)".repeat(50)}((?!))$`;
  manifest.engines[0].sqlWriting.export.typeVocabulary.numericWrapper = { source, flags: "" };
  return { sourceLength: source.length, admitted: validator.validate(manifest).admitted };
}

const wrapperCountChild = boundedChild({
  label: "wrapper-count",
  imports: [
    {
      from: path.join(import.meta.dir, "..", "..", "src", "manifest", "index.ts"),
      names: ["compileManifestValidator"],
    },
    { from: path.join(import.meta.dir, "..", "fixtures", "minimal-manifest.json"), defaultAs: "manifest" },
    { from: "node:fs", names: ["readFileSync"] },
  ],
  runCase: runWrapperCount,
  heapLimitMiB: 256,
  timeoutMs: 10_000,
});

beforeAll(() => wrapperCountChild.build(), 60_000);

afterAll(() => {
  wrapperCountChild.remove();
});

/**
 * SQL writing facts naming every hook a row may leave out, with a bound edit, every key float64, a standing-alone name,
 * a bare spelling, own non-finite literals, an INSERT written as a SELECT and a create table key whose note is two
 * comment lines.
 */
function everySqlWritingHook(m: Json): void {
  const writing = sqlWritingOf(m);
  Object.assign(writing, {
    placeholder: "placeholder",
    temporalLiteral: "temporalLiteral",
    insertDocuments: "insertDocuments",
  });
  Object.assign(writing.inlineEdit, { float64TypeNames: "all", boundEdit: "boundEdit" });
  Object.assign(writing.export, {
    standsAlone: ["varchar", "timestamp with time zone"],
    bareSpelling: [
      { name: "bit", spelling: "bit(64)" },
      { name: "time", spelling: "time(6)" },
    ],
    nonFinite: { NaN: "'NaN'::FLOAT", Infinity: "CAST('Infinity' AS DOUBLE)", "-Infinity": "-9e999" },
    insertForm: "select",
    rewriteDeclared: "rewriteDeclared",
    declareFromSample: "declareFromSample",
    typedLiteral: "typedLiteral",
    columnWriters: "columnWriters",
    createTableKey: { note: "-- One key.\n-- Confirm it.\n", clause: "createTableKeyClause" },
  });
}

/** The migration DDL of the fixture's one engine. */
const migrationDdlOf = (m: Json): Json => m.engines[0].migrationDdl;

/** The pointer of the fixture's one engine's migration DDL. */
const MIGRATION_DDL = "/engines/0/migrationDdl";

/** The members of a migration DDL segment that writes table DDL, in the schema's order. */
const WRITTEN_MIGRATION_DDL_MEMBERS = [
  "tableDdl",
  "transactionWrapper",
  "createTable",
  "columnDef",
  "createIndex",
  "dropIndex",
  "addForeignKey",
  "dropForeignKey",
  "addColumn",
  "dropColumn",
  "modifyColumn",
  "dropTable",
  "reasons",
] as const;

/** A migration DDL segment that writes table DDL, its wrapper BEGIN; and COMMIT; and its CREATE TABLE written. */
function writtenMigrationDdl(): Json {
  return {
    tableDdl: "written",
    transactionWrapper: { begin: "BEGIN;", commit: "COMMIT;" },
    createTable: { kind: "written", primaryKey: "createTablePrimaryKey", foreignKey: "createTableForeignKey" },
    columnDef: "columnDef",
    createIndex: "createIndex",
    dropIndex: "dropIndex",
    addForeignKey: "addForeignKey",
    dropForeignKey: "dropForeignKey",
    addColumn: "addColumn",
    dropColumn: "dropColumn",
    modifyColumn: "modifyColumn",
    dropTable: "dropTable",
    reasons: [],
  };
}

/** A migration DDL segment that refuses table DDL, with its one comment line and the reason the line gives. */
function refusedMigrationDdl(): Json {
  return {
    tableDdl: "refused",
    refusal: "-- ExampleDB: Cannot generate table DDL. A bucket holds documents, not rows with declared columns.",
    transactionWrapper: null,
    reasons: ["A bucket holds documents, not rows with declared columns."],
  };
}

/** The editor language of the fixture's one engine. */
const languageOf = (m: Json): Json => m.engines[0].editor.language;

/** The pointer of the fixture's one engine's editor language. */
const LANGUAGE = "/engines/0/editor/language";

/** The SQL generator forms of the fixture's one engine. */
const sqlGeneratorsOf = (m: Json): Json => m.engines[0].sqlGenerators;

/** The pointer of the fixture's one engine's SQL generator forms. */
const SQL_GENERATORS = "/engines/0/sqlGenerators";

/** An SQL generator segment naming every form by its slot, counting with `count`. */
function namedSqlGenerators(count = "COUNT_BIG(*)"): Json {
  return {
    quote: "generatorQuote",
    table: "generatorTable",
    select: "generatorSelect",
    selectList: "generatorSelectList",
    countExpression: count,
  };
}

/** One missing-key row per member of the part `of` returns, named `<name>.<member>` and refused at `pointer`. */
function missingRows(
  name: string,
  of: (m: Json) => Json,
  pointer: string,
  members: readonly string[],
): (readonly [string, (m: Json) => boolean, string, string])[] {
  return members.map((member) => [`${name}.${member}`, (m: Json) => delete of(m)[member], pointer, member] as const);
}

/** A fresh copy of the Kafka-shaped fixture, whose one engine is `kafka`. */
function kafkaManifest(): Json {
  return JSON.parse(readFileSync(path.join(import.meta.dir, "../fixtures/kafka-manifest.json"), "utf8"));
}

/** A dialect row named `kubectl` that offers nothing and masks `flags`. */
function dialect(flags: unknown[] | null = ["--token"]): Json {
  return {
    name: "kubectl",
    offersColumnProfiling: false,
    offersCodeGeneration: false,
    offersCountQuery: false,
    offersSqlExport: true,
    historyMask: flags === null ? null : { credentialFlags: flags },
  };
}

/** A paste reader named `pasteReader`, not a catch-all, naming `formats`. */
function paste(formats: unknown[] = ["exampledb://"]): Json {
  return { reader: "pasteReader", catchAll: false, formats };
}

/** A field rule for `field` that states only what `members` gives, every other member null. */
function fieldRule(field: string, members: Json = {}): Json {
  return { field, required: null, format: null, charRange: null, check: null, ...members };
}

/** A format whose pattern is `source` with `flags`, refused with a generated sentence. */
function format(source: string, flags = ""): Json {
  return { pattern: { source, flags }, sentence: randomUUID() };
}

/**
 * The fixture's engine shaped like Snowflake's sign-in: a select, `authMethod`, whose choices are `keypair` and `pat`,
 * a private key shown only on `keypair`, a password shown only on `pat`, and `keypair` as the absent value.
 */
function signInShaped(m: Json): void {
  const connection = connectionOf(m);
  connection.fields = ["host", "user", "authMethod", "privateKey", "password", "warehouse"];
  connection.dialog.options = [
    {
      field: "authMethod",
      choices: [
        { value: "keypair", label: "Key pair" },
        { value: "pat", label: "Programmatic access token" },
      ],
    },
  ];
  connection.dialog.shownWhen = [
    { field: "privateKey", when: { field: "authMethod", equals: "keypair" } },
    { field: "password", when: { field: "authMethod", equals: "pat" } },
  ];
  connection.dialog.absentValues = [{ field: "authMethod", value: "keypair" }];
}

describe("schema refusals", () => {
  test.each([
    ["at the top level", (m: Json) => (m.bogus = 1), ""],
    ["in an engine", (m: Json) => (m.engines[0].bogus = 1), "/engines/0"],
    ["in a connection", (m: Json) => (m.engines[0].connection.bogus = 1), "/engines/0/connection"],
    ["in a native package", (m: Json) => (m.runtime.native = [{ ...NATIVE, bogus: 1 }]), "/runtime/native/0"],
    ["in an editor", (m: Json) => (editorOf(m).bogus = 1), "/engines/0/editor"],
    [
      "in a consent deadline",
      (m: Json) => (editorOf(m).consentDeadline = { chip: "c", sentence: "s", bogus: 1 }),
      "/engines/0/editor/consentDeadline",
    ],
    ["in a dialect row", (m: Json) => (editorOf(m).dialect = { ...dialect(), bogus: 1 }), "/engines/0/editor/dialect"],
    [
      "in a history mask",
      (m: Json) => (editorOf(m).dialect = { ...dialect(), historyMask: { credentialFlags: ["--token"], bogus: 1 } }),
      "/engines/0/editor/dialect/historyMask",
    ],
    ["in an SQL generator segment", (m: Json) => (sqlGeneratorsOf(m).bogus = "generatorBogus"), SQL_GENERATORS],
    ["in an editor language", (m: Json) => (languageOf(m).bogus = "sql"), LANGUAGE],
  ])("an unknown key %s is refused as unknown-key at its pointer", (_where, change, pointer) => {
    expect(refusalsFor(manifest(change))).toEqual([refusal("unknown-key", pointer, "bogus")]);
  });

  test.each([
    ["contract", (m: Json) => delete m.contract, "", "contract"],
    ["engines", (m: Json) => delete m.engines, "", "engines"],
    ["connection.refused", (m: Json) => delete m.engines[0].connection.refused, "/engines/0/connection", "refused"],
    ["connection.dialog", (m: Json) => delete m.engines[0].connection.dialog, "/engines/0/connection", "dialog"],
    [
      "connection.fieldRules",
      (m: Json) => delete m.engines[0].connection.fieldRules,
      "/engines/0/connection",
      "fieldRules",
    ],
    ["connection.hostHint", (m: Json) => delete m.engines[0].connection.hostHint, "/engines/0/connection", "hostHint"],
    [
      "connection.hostIdentity",
      (m: Json) => delete m.engines[0].connection.hostIdentity,
      "/engines/0/connection",
      "hostIdentity",
    ],
    ["connection.import", (m: Json) => delete m.engines[0].connection.import, "/engines/0/connection", "import"],
    [
      "connection.connectionString.scheme",
      (m: Json) => delete m.engines[0].connection.connectionString.scheme,
      "/engines/0/connection/connectionString",
      "scheme",
    ],
    [
      "connection.connectionString.urlTls",
      (m: Json) => delete m.engines[0].connection.connectionString.urlTls,
      "/engines/0/connection/connectionString",
      "urlTls",
    ],
    [
      "connection.connectionString.paste",
      (m: Json) => delete m.engines[0].connection.connectionString.paste,
      "/engines/0/connection/connectionString",
      "paste",
    ],
    [
      "connection.connectionString.seedCheck",
      (m: Json) => delete m.engines[0].connection.connectionString.seedCheck,
      "/engines/0/connection/connectionString",
      "seedCheck",
    ],
    [
      "connection.dialog.absentValues",
      (m: Json) => delete m.engines[0].connection.dialog.absentValues,
      "/engines/0/connection/dialog",
      "absentValues",
    ],
    [
      "facets.monitoring.storage",
      (m: Json) => delete m.engines[0].facets.monitoring.storage,
      "/engines/0/facets/monitoring",
      "storage",
    ],
    ["editor", (m: Json) => delete m.engines[0].editor, "/engines/0", "editor"],
    ...["commitKeyword", "consentDeadline", "fenceAliases", "explainFormat", "dialect"].map(
      (member) => [`editor.${member}`, (m: Json) => delete editorOf(m)[member], "/engines/0/editor", member] as const,
    ),
    ...["chip", "sentence"].map(
      (member) =>
        [
          `editor.consentDeadline.${member}`,
          (m: Json) => {
            editorOf(m).consentDeadline = { chip: "c", sentence: "s" };
            delete editorOf(m).consentDeadline[member];
          },
          "/engines/0/editor/consentDeadline",
          member,
        ] as const,
    ),
    ...[
      "name",
      "offersColumnProfiling",
      "offersCodeGeneration",
      "offersCountQuery",
      "offersSqlExport",
      "historyMask",
    ].map(
      (member) =>
        [
          `editor.dialect.${member}`,
          (m: Json) => {
            editorOf(m).dialect = dialect();
            delete editorOf(m).dialect[member];
          },
          "/engines/0/editor/dialect",
          member,
        ] as const,
    ),
    [
      "editor.dialect.historyMask.credentialFlags",
      (m: Json) => (editorOf(m).dialect = { ...dialect(), historyMask: {} }),
      "/engines/0/editor/dialect/historyMask",
      "credentialFlags",
    ],
    ["sqlText", (m: Json) => delete m.engines[0].sqlText, "/engines/0", "sqlText"],
    ...["readsSqlText", "grammar", "redaction", "updateTarget", "completion"].map(
      (member) => [`sqlText.${member}`, (m: Json) => delete sqlTextOf(m)[member], SQL_TEXT, member] as const,
    ),
    ...[
      "hash",
      "bracket",
      "blockComment",
      "alternateQuoting",
      "doubleSlashComment",
      "backslashAlwaysEscapes",
      "tripleQuotedStrings",
      "backtickBackslashEscapes",
      "dollarTags",
      "doubleQuoteBackslashEscapes",
      "singleQuoteBackslashEscapes",
      "rawStrings",
      "hintsAreCode",
      "lineCommentBackslashContinues",
      "lineCommentEndsAtCarriageReturn",
      "script",
      "trailingLimitClauses",
      "nonNumericRowBounds",
      "confirmForms",
      "confirmCodeForms",
      "confirmFormsWhen",
      "confirmExemptForms",
      "formatterLanguage",
      "completionWords",
      "confirmConfigKeys",
      "explainExecutesWithAnalyze",
    ].map(
      (member) =>
        [`sqlText.grammar.${member}`, (m: Json) => delete grammarOf(m)[member], `${SQL_TEXT}/grammar`, member] as const,
    ),
    ...["blocks", "separatorLine", "unit", "terminatedStatements"].map(
      (member) =>
        [
          `sqlText.grammar.script.${member}`,
          (m: Json) => delete grammarOf(m).script[member],
          `${SQL_TEXT}/grammar/script`,
          member,
        ] as const,
    ),
    ...["keywords", "functions"].map(
      (member) =>
        [
          `sqlText.grammar.completionWords.${member}`,
          (m: Json) => delete grammarOf(m).completionWords[member],
          `${SQL_TEXT}/grammar/completionWords`,
          member,
        ] as const,
    ),
    ...["dashCommentNeedsSeparator", "extraQueryOpeners", "extraSetOperators"].map(
      (member) =>
        [
          `sqlText.updateTarget.${member}`,
          (m: Json) => delete sqlTextOf(m).updateTarget[member],
          `${SQL_TEXT}/updateTarget`,
          member,
        ] as const,
    ),
    ...["formatSegment", "readQuotedQualifier"].map(
      (member) =>
        [
          `sqlText.completion.${member}`,
          (m: Json) => delete sqlTextOf(m).completion[member],
          `${SQL_TEXT}/completion`,
          member,
        ] as const,
    ),
    ["sqlWriting", (m: Json) => delete m.engines[0].sqlWriting, "/engines/0", "sqlWriting"],
    ...missingRows("sqlWriting", sqlWritingOf, SQL_WRITING, [
      "escapeLiteral",
      "unescapeLiteral",
      "quoteIdentifier",
      "placeholder",
      "temporalLiteral",
      "inlineEdit",
      "export",
      "insertDocuments",
    ]),
    ...missingRows("sqlWriting.inlineEdit", (m) => sqlWritingOf(m).inlineEdit, `${SQL_WRITING}/inlineEdit`, [
      "instantTypeNames",
      "exactDecimalTypeNames",
      "float64TypeNames",
      "boundEdit",
    ]),
    ...missingRows("sqlWriting.export", (m) => sqlWritingOf(m).export, `${SQL_WRITING}/export`, [
      "ddlTypes",
      "standsAlone",
      "bareSpelling",
      "typeVocabulary",
      "binaryLiteral",
      "nonFinite",
      "insertForm",
      "rewriteDeclared",
      "declareFromSample",
      "typedLiteral",
      "columnWriters",
      "createTableKey",
    ]),
    ...missingRows(
      "sqlWriting.export.ddlTypes",
      (m) => sqlWritingOf(m).export.ddlTypes,
      `${SQL_WRITING}/export/ddlTypes`,
      ["text", "integer", "numeric", "boolean", "timestamp", "binary"],
    ),
    ...missingRows(
      "sqlWriting.export.nonFinite",
      (m) => sqlWritingOf(m).export.nonFinite,
      `${SQL_WRITING}/export/nonFinite`,
      ["NaN", "Infinity", "-Infinity"],
    ),
    ...missingRows("sqlWriting.export.typeVocabulary", vocabularyOf, VOCABULARY, [
      "bareTypeFamily",
      "floatType",
      "exactNumericType",
      "numericWrapper",
    ]),
    ...missingRows(
      "sqlWriting.export.typeVocabulary.bareTypeFamily",
      (m) => vocabularyOf(m).bareTypeFamily,
      `${VOCABULARY}/bareTypeFamily`,
      ["text", "integer", "numeric", "boolean", "timestamp", "binary"],
    ),
    ...missingRows(
      "sqlWriting.export.typeVocabulary.floatType",
      (m) => vocabularyOf(m).floatType,
      `${VOCABULARY}/floatType`,
      ["source", "flags"],
    ),
    ...missingRows(
      "sqlWriting.export.bareSpelling entry",
      (m) => {
        sqlWritingOf(m).export.bareSpelling = [{ name: "bit", spelling: "bit(64)" }];
        return sqlWritingOf(m).export.bareSpelling[0];
      },
      `${SQL_WRITING}/export/bareSpelling/0`,
      ["name", "spelling"],
    ),
    ...missingRows(
      "sqlWriting.export.createTableKey",
      (m) => {
        everySqlWritingHook(m);
        return sqlWritingOf(m).export.createTableKey;
      },
      `${SQL_WRITING}/export/createTableKey`,
      ["note", "clause"],
    ),
    ["migrationDdl", (m: Json) => delete m.engines[0].migrationDdl, "/engines/0", "migrationDdl"],
    ["sqlGenerators", (m: Json) => delete m.engines[0].sqlGenerators, "/engines/0", "sqlGenerators"],
    ["editor.language", (m: Json) => delete editorOf(m).language, "/engines/0/editor", "language"],
    ...missingRows("editor.language", languageOf, LANGUAGE, ["queryLanguage", "monacoId", "accent", "console"]),
    ...missingRows("sqlGenerators", sqlGeneratorsOf, SQL_GENERATORS, [
      "quote",
      "table",
      "select",
      "selectList",
      "countExpression",
    ]),
  ])("a missing %s is refused as missing-key", (_name, change, pointer, key) => {
    expect(refusalsFor(manifest(change))).toEqual([refusal("missing-key", pointer, key)]);
  });

  test.each([
    ["a location outside the vocabulary", (m: Json) => (m.engines[0].location = "remote"), "/engines/0/location"],
    [
      "a TLS offer outside the vocabulary",
      (m: Json) => (m.engines[0].connection.tls = "maybe"),
      "/engines/0/connection/tls",
    ],
    [
      "a field name outside the vocabulary",
      (m: Json) => m.engines[0].connection.fields.push("colour"),
      "/engines/0/connection/fields/5",
    ],
    [
      "a monitoring offer outside the vocabulary",
      (m: Json) => (m.engines[0].facets.monitoring.overview = "stub"),
      "/engines/0/facets/monitoring/overview",
    ],
  ])("%s is refused as value-not-allowed", (_name, change, pointer) => {
    expect(refusalsFor(manifest(change))).toEqual([refusal("value-not-allowed", pointer)]);
  });

  test.each([
    ["an upper-case engine id", (m: Json) => (m.engines[0].id = "Foo"), "/engines/0/id"],
    ["a contract with no minor", (m: Json) => (m.contract = "1"), "/contract"],
    ["an entry that climbs out of the package", (m: Json) => (m.runtime.entry = "../escape.mjs"), "/runtime/entry"],
    [
      "an image without a full sha256 digest",
      (m: Json) =>
        (m.compatibility[0].tested[0].image = { repository: "docker.io/exampledb/server", digest: "sha256:abc" }),
      "/compatibility/0/tested/0/image/digest",
    ],
    [
      "a refusal template naming {value}",
      (m: Json) => (m.engines[0].connection.seedOnly = { ...SEED_ONLY, refusal: "{value} is ExampleDB only." }),
      "/engines/0/connection/seedOnly/refusal",
    ],
  ])("%s is refused as pattern-mismatch", (_name, change, pointer) => {
    expect(refusalsFor(manifest(change))).toEqual([refusal("pattern-mismatch", pointer)]);
  });

  test("an empty engine list is refused as too-few", () => {
    expect(refusalsFor(manifest((m) => (m.engines = [])))).toEqual([refusal("too-few", "/engines")]);
  });

  test("a list longer than its maxItems is refused as too-many", () => {
    const changed = manifest((m) => {
      m.engines = Array.from({ length: 65 }, (_, index) => ({ ...structuredClone(m.engines[0]), id: `db${index}` }));
    });

    expect(refusalsFor(changed)).toEqual([refusal("too-many", "/engines")]);
  });

  test("a field listed twice is refused as duplicate at the second", () => {
    const changed = manifest((m) => m.engines[0].connection.fields.push("host"));

    expect(refusalsFor(changed)).toEqual([refusal("duplicate", "/engines/0/connection/fields/5")]);
  });

  test.each([0, 70000])("port %d is refused as out-of-range", (port) => {
    const changed = manifest((m) => (m.engines[0].connection.defaults.port = port));

    expect(refusalsFor(changed)).toEqual([refusal("out-of-range", "/engines/0/connection/defaults/port")]);
  });

  test("a display name longer than 64 characters is refused as out-of-range", () => {
    const changed = manifest((m) => (m.engines[0].displayName = "x".repeat(65)));

    expect(refusalsFor(changed)).toEqual([refusal("out-of-range", "/engines/0/displayName")]);
  });

  test("a string where a list belongs is refused as wrong-type", () => {
    const changed = manifest((m) => (m.engines[0].connection.fields = "host"));

    expect(refusalsFor(changed)).toEqual([refusal("wrong-type", "/engines/0/connection/fields")]);
  });

  test("a value that is not an object is refused as wrong-type at the top level", () => {
    expect(refusalsFor("manifest")).toEqual([refusal("wrong-type", "")]);
  });

  test("a failed variant is one no-variant refusal and nothing under it", () => {
    const changed = manifest((m) => (m.engines[0].connection.sshTunnel = { offered: false }));

    expect(refusalsFor(changed)).toEqual([refusal("no-variant", "/engines/0/connection/sshTunnel")]);
  });

  test("a version claim of no known kind is one no-variant refusal", () => {
    const changed = manifest((m) => (m.compatibility[0].versions = { kind: "rnage", from: "1", to: "2" }));

    expect(refusalsFor(changed)).toEqual([refusal("no-variant", "/compatibility/0/versions")]);
  });

  test.each([
    ["a label longer than 128 characters", "labels", "x".repeat(129)],
    ["an empty label", "labels", ""],
    ["a hint longer than 2000 characters", "hints", "x".repeat(2001)],
    ["an empty hint", "hints", ""],
    ["a placeholder longer than 256 characters", "placeholders", "x".repeat(257)],
  ])("%s is refused as out-of-range", (_name, list, text) => {
    const changed = manifest((m) => (connectionOf(m).dialog[list] = [{ field: "user", text }]));

    expect(refusalsFor(changed)).toEqual([refusal("out-of-range", `/engines/0/connection/dialog/${list}/0/text`)]);
  });

  test("an empty placeholder is admitted: it means the field shows no example", () => {
    const changed = manifest((m) => (connectionOf(m).dialog.placeholders = [{ field: "user", text: "" }]));

    expect(refusalsFor(changed)).toEqual([]);
  });

  test("a placement for a field that is not placeable is refused as value-not-allowed", () => {
    const changed = manifest((m) => (connectionOf(m).dialog.placement = [{ field: "host", where: "open" }]));

    expect(refusalsFor(changed)).toEqual([
      refusal("value-not-allowed", "/engines/0/connection/dialog/placement/0/field"),
    ]);
  });

  test("a placement other than open or advanced is refused as value-not-allowed", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields.push("serviceName");
      connectionOf(m).dialog.placement = [{ field: "serviceName", where: "hidden" }];
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("value-not-allowed", "/engines/0/connection/dialog/placement/0/where"),
    ]);
  });

  test("choices for a field that is not a select are refused as value-not-allowed", () => {
    const changed = manifest(
      (m) => (connectionOf(m).dialog.options = [{ field: "database", choices: [{ value: "a", label: "A" }] }]),
    );

    expect(refusalsFor(changed)).toEqual([
      refusal("value-not-allowed", "/engines/0/connection/dialog/options/0/field"),
    ]);
  });

  test("an options entry with no choice is refused as too-few", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields.push("saslMechanism");
      connectionOf(m).dialog.options = [{ field: "saslMechanism", choices: [] }];
    });

    expect(refusalsFor(changed)).toEqual([refusal("too-few", "/engines/0/connection/dialog/options/0/choices")]);
  });

  test("a dialog order naming a field twice is refused as duplicate at the second", () => {
    const changed = manifest((m) => (connectionOf(m).dialog.order = ["user", "host", "user"]));

    expect(refusalsFor(changed)).toEqual([refusal("duplicate", "/engines/0/connection/dialog/order/2")]);
  });

  test("a condition with a second key is refused as unknown-key", () => {
    const changed = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen[0].when.in = ["keypair", "pat"];
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("unknown-key", "/engines/0/connection/dialog/shownWhen/0/when", "in"),
    ]);
  });

  test("a URI scheme other than http or https is refused as value-not-allowed", () => {
    const changed = manifest((m) => (connectionOf(m).hostUriSchemes = ["https", "ftp"]));

    expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", "/engines/0/connection/hostUriSchemes/1")]);
  });

  test("the three credential warning kinds are admitted, a pair with an empty password among them", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).credentialWarnings = [
          { kind: "pair", user: "root", password: "", message: randomUUID() },
          { kind: "pair", user: "admin", password: randomUUID(), message: randomUUID() },
          { kind: "jwt", noExp: true, access: ["m", "absent"], message: randomUUID() },
          { kind: "jwt", noExp: true, access: [], message: randomUUID() },
          { kind: "no-secret", message: randomUUID() },
        ]),
    );

    expect(refusalsFor(changed)).toEqual([]);
  });

  test.each([
    ["of no known kind", { kind: "default", message: "m" }],
    ["of the jwt kind with noExp false", { kind: "jwt", noExp: false, access: [], message: "m" }],
    ["of the jwt kind naming one access claim twice", { kind: "jwt", noExp: true, access: ["m", "m"], message: "m" }],
    ["of the pair kind with no user", { kind: "pair", password: "", message: "m" }],
  ])("a credential warning %s is one no-variant refusal", (_name, warning) => {
    const changed = manifest((m) => (connectionOf(m).credentialWarnings = [warning]));

    expect(refusalsFor(changed)).toEqual([refusal("no-variant", "/engines/0/connection/credentialWarnings/0")]);
  });

  test("refused entries, each a field with its sentence, are admitted", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).refused = [
          { field: "apiKeyId", refusal: randomUUID() },
          { field: "apiKeySecret", refusal: "x".repeat(2000) },
        ]),
    );

    expect(refusalsFor(changed)).toEqual([]);
  });

  test("a refused entry without its sentence is refused as missing-key", () => {
    const changed = manifest((m) => (connectionOf(m).refused = [{ field: "region" }]));

    expect(refusalsFor(changed)).toEqual([refusal("missing-key", "/engines/0/connection/refused/0", "refusal")]);
  });

  test.each([
    ["an empty sentence", ""],
    ["a sentence longer than 2000 characters", "x".repeat(2001)],
  ])("a refused entry with %s is refused as out-of-range", (_name, sentence) => {
    const changed = manifest((m) => (connectionOf(m).refused = [{ field: "region", refusal: sentence }]));

    expect(refusalsFor(changed)).toEqual([refusal("out-of-range", "/engines/0/connection/refused/0/refusal")]);
  });

  test("a refused entry with a third key is refused as unknown-key", () => {
    const changed = manifest(
      (m) => (connectionOf(m).refused = [{ field: "region", refusal: randomUUID(), value: randomUUID() }]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("unknown-key", "/engines/0/connection/refused/0", "value")]);
  });

  test("a field rule with a pattern, a range and a named check, both host readers and an import are admitted", () => {
    const changed = manifest((m) => {
      connectionOf(m).fieldRules = [
        fieldRule("host", {
          required: randomUUID(),
          format: format("^[a-z]+$"),
          charRange: { min: 3, max: 512, sentence: randomUUID() },
          check: "hostCheck",
        }),
        fieldRule("database", { format: format("^\\p{L}+$", "u") }),
        fieldRule("user", { required: randomUUID() }),
      ];
      connectionOf(m).hostHint = "hostHint";
      connectionOf(m).hostIdentity = "hostIdentity";
      connectionOf(m).import = { label: "Import kubeconfig", importer: "importer" };
    });

    expect(refusalsFor(changed)).toEqual([]);
  });

  test("a field rule's pattern longer than 512 characters is refused as out-of-range", () => {
    const long = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("a".repeat(513)) })]),
    );
    const empty = manifest((m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("") })]));
    const longest = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("a".repeat(512)) })]),
    );

    expect(refusalsFor(long)).toEqual([
      refusal("out-of-range", "/engines/0/connection/fieldRules/0/format/pattern/source"),
    ]);
    expect(refusalsFor(empty)).toEqual([
      refusal("out-of-range", "/engines/0/connection/fieldRules/0/format/pattern/source"),
    ]);
    expect(refusalsFor(longest)).toEqual([]);
  });

  test("a field rule's pattern with a flag other than u is refused as value-not-allowed", () => {
    for (const flags of ["g", "y", "ui", "i"]) {
      const changed = manifest(
        (m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("^a$", flags) })]),
      );

      expect(refusalsFor(changed)).toEqual([
        refusal("value-not-allowed", "/engines/0/connection/fieldRules/0/format/pattern/flags"),
      ]);
    }
  });

  test.each([
    ["an empty required sentence", { required: "" }, "/required"],
    ["a required sentence longer than 2000 characters", { required: "x".repeat(2001) }, "/required"],
    [
      "an empty format sentence",
      { format: { pattern: { source: "^a$", flags: "" }, sentence: "" } },
      "/format/sentence",
    ],
    ["a range minimum below 0", { charRange: { min: -1, max: 3, sentence: "s" } }, "/charRange/min"],
    ["a range maximum of 0", { charRange: { min: 0, max: 0, sentence: "s" } }, "/charRange/max"],
    ["a range maximum above 65535", { charRange: { min: 0, max: 65536, sentence: "s" } }, "/charRange/max"],
  ])("a field rule with %s is refused as out-of-range", (_name, members, under) => {
    const changed = manifest((m) => (connectionOf(m).fieldRules = [fieldRule("host", members)]));

    expect(refusalsFor(changed)).toEqual([refusal("out-of-range", `/engines/0/connection/fieldRules/0${under}`)]);
  });

  test("a fractional range minimum is refused as wrong-type", () => {
    const changed = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("host", { charRange: { min: 1.5, max: 3, sentence: "s" } })]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("wrong-type", "/engines/0/connection/fieldRules/0/charRange/min")]);
  });

  test("a field rule with a fifth key, or without its check, is refused by key", () => {
    const fifth = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("host", { required: "r", message: randomUUID() })]),
    );
    const noCheck = manifest((m) => {
      const rule = fieldRule("host", { required: "r" });
      delete rule.check;
      connectionOf(m).fieldRules = [rule];
    });

    expect(refusalsFor(fifth)).toEqual([refusal("unknown-key", "/engines/0/connection/fieldRules/0", "message")]);
    expect(refusalsFor(noCheck)).toEqual([refusal("missing-key", "/engines/0/connection/fieldRules/0", "check")]);
  });

  test("a field rule check named in another form is one no-variant refusal", () => {
    for (const check of ["Host-check", "", "1check", "x".repeat(65), 7]) {
      const changed = manifest((m) => (connectionOf(m).fieldRules = [fieldRule("host", { check })]));

      expect(refusalsFor(changed)).toEqual([refusal("no-variant", "/engines/0/connection/fieldRules/0/check")]);
    }
  });

  test("a host hint named in another form is one no-variant refusal", () => {
    const hint = manifest((m) => (connectionOf(m).hostHint = "host hint"));
    const identity = manifest((m) => (connectionOf(m).hostIdentity = "HostIdentity"));

    expect(refusalsFor(hint)).toEqual([refusal("no-variant", "/engines/0/connection/hostHint")]);
    expect(refusalsFor(identity)).toEqual([refusal("no-variant", "/engines/0/connection/hostIdentity")]);
  });

  test("an importer named in another form is refused as pattern-mismatch", () => {
    const changed = manifest((m) => (connectionOf(m).import = { label: "Import", importer: "import-kubeconfig" }));

    expect(refusalsFor(changed)).toEqual([refusal("pattern-mismatch", "/engines/0/connection/import/importer")]);
  });

  test("an import without its importer is refused as missing-key, and a label longer than 128 characters as out-of-range", () => {
    const noImporter = manifest((m) => (connectionOf(m).import = { label: "Import" }));
    const longLabel = manifest((m) => (connectionOf(m).import = { label: "x".repeat(129), importer: "importer" }));

    expect(refusalsFor(noImporter)).toEqual([refusal("missing-key", "/engines/0/connection/import", "importer")]);
    expect(refusalsFor(longLabel)).toEqual([refusal("out-of-range", "/engines/0/connection/import/label")]);
  });

  test("a connection string with a scheme, a URL TLS reader, a paste reader and a seed check is admitted", () => {
    const full = manifest((m) => {
      Object.assign(connectionStringOf(m), {
        scheme: "exampledb",
        urlTls: "urlTls",
        paste: paste(["exampledb://", "Server=\u2026 (ADO.NET)", "x".repeat(128)]),
        seedCheck: "seedCheck",
      });
    });
    const catchAll = manifest((m) => {
      Object.assign(connectionStringOf(m), { scheme: "exampledb+srv", paste: { ...paste(), catchAll: true } });
    });

    expect(refusalsFor(manifest())).toEqual([]);
    expect(refusalsFor(full)).toEqual([]);
    expect(refusalsFor(catchAll)).toEqual([]);
  });

  test("a connection string scheme that is not a lower-case URI scheme is refused as pattern-mismatch", () => {
    for (const scheme of ["Postgres", "pg sql", "1db", "", "a".repeat(33), "postgres://"]) {
      const changed = manifest((m) => Object.assign(connectionStringOf(m), { scheme, paste: paste() }));

      expect(refusalsFor(changed)).toEqual([
        refusal("pattern-mismatch", "/engines/0/connection/connectionString/scheme"),
      ]);
    }
    const longest = manifest((m) => Object.assign(connectionStringOf(m), { scheme: "a".repeat(32), paste: paste() }));

    expect(refusalsFor(longest)).toEqual([]);
  });

  test("a URL TLS reader or a seed check named in another form is one no-variant refusal", () => {
    const urlTls = manifest((m) => Object.assign(connectionStringOf(m), { urlTls: "url-tls", paste: paste() }));
    const seedCheck = manifest((m) => (connectionStringOf(m).seedCheck = "Seed"));

    expect(refusalsFor(urlTls)).toEqual([refusal("no-variant", "/engines/0/connection/connectionString/urlTls")]);
    expect(refusalsFor(seedCheck)).toEqual([refusal("no-variant", "/engines/0/connection/connectionString/seedCheck")]);
  });

  test("a paste reader named in another form is refused as pattern-mismatch", () => {
    const changed = manifest((m) => (connectionStringOf(m).paste = { ...paste(), reader: "paste-reader" }));

    expect(refusalsFor(changed)).toEqual([
      refusal("pattern-mismatch", "/engines/0/connection/connectionString/paste/reader"),
    ]);
  });

  test("a paste with no format is refused as too-few, and one naming a format twice as duplicate", () => {
    const none = manifest((m) => (connectionStringOf(m).paste = paste([])));
    const twice = manifest((m) => (connectionStringOf(m).paste = paste(["exampledb://", "exampledb://"])));
    const many = manifest(
      (m) => (connectionStringOf(m).paste = paste(Array.from({ length: 17 }, (_, index) => `f${index}://`))),
    );

    expect(refusalsFor(none)).toEqual([refusal("too-few", "/engines/0/connection/connectionString/paste/formats")]);
    expect(refusalsFor(twice)).toEqual([
      refusal("duplicate", "/engines/0/connection/connectionString/paste/formats/1"),
    ]);
    expect(refusalsFor(many)).toEqual([refusal("too-many", "/engines/0/connection/connectionString/paste/formats")]);
  });

  test("a paste format longer than 128 characters is refused as out-of-range", () => {
    for (const format of ["x".repeat(129), ""]) {
      const changed = manifest((m) => (connectionStringOf(m).paste = paste([format])));

      expect(refusalsFor(changed)).toEqual([
        refusal("out-of-range", "/engines/0/connection/connectionString/paste/formats/0"),
      ]);
    }
  });

  test("a paste without its catch-all flag is refused as missing-key", () => {
    const noFlag = manifest((m) => {
      const reader = paste();
      delete reader.catchAll;
      connectionStringOf(m).paste = reader;
    });
    const fourth = manifest((m) => (connectionStringOf(m).paste = { ...paste(), order: 1 }));

    expect(refusalsFor(noFlag)).toEqual([
      refusal("missing-key", "/engines/0/connection/connectionString/paste", "catchAll"),
    ]);
    expect(refusalsFor(fourth)).toEqual([
      refusal("unknown-key", "/engines/0/connection/connectionString/paste", "order"),
    ]);
  });

  test("an editor with a consent deadline, fence aliases, an explain format and a dialect with a history mask is admitted", () => {
    const full = manifest((m) => {
      m.engines[0].editor = {
        commitKeyword: "EXEC",
        consentDeadline: { chip: "x".repeat(128), sentence: "y".repeat(2000) },
        fenceAliases: ["exampleql", `q${"a".repeat(31)}`],
        explainFormat: "postgres-json",
        dialect: dialect(["--token", "--client-key", `--${"a".repeat(63)}`]),
        language: { queryLanguage: "json", monacoId: "kubectl", accent: "border-hue-sky/40", console: false },
      };
    });

    expect(refusalsFor(manifest())).toEqual([]);
    expect(refusalsFor(kafkaManifest())).toEqual([]);
    expect(refusalsFor(full)).toEqual([]);
  });

  test("a commit keyword that is not one word is refused as pattern-mismatch", () => {
    for (const keyword of ["COMMIT WORK", "1COMMIT", "", "A".repeat(33), "COMMIT;"]) {
      const changed = manifest((m) => (editorOf(m).commitKeyword = keyword));

      expect(refusalsFor(changed)).toEqual([refusal("pattern-mismatch", "/engines/0/editor/commitKeyword")]);
    }
    const longest = manifest((m) => (editorOf(m).commitKeyword = `C${"o_1".repeat(10)}T`));

    expect(refusalsFor(longest)).toEqual([]);
  });

  test("a consent deadline chip longer than 128 characters or a sentence longer than 2000 is refused as out-of-range", () => {
    const longChip = manifest((m) => (editorOf(m).consentDeadline = { chip: "x".repeat(129), sentence: "s" }));
    const longSentence = manifest((m) => (editorOf(m).consentDeadline = { chip: "c", sentence: "y".repeat(2001) }));
    const empty = manifest((m) => (editorOf(m).consentDeadline = { chip: "", sentence: "" }));

    expect(refusalsFor(longChip)).toEqual([refusal("out-of-range", "/engines/0/editor/consentDeadline/chip")]);
    expect(refusalsFor(longSentence)).toEqual([refusal("out-of-range", "/engines/0/editor/consentDeadline/sentence")]);
    expect(refusalsFor(empty)).toEqual([
      refusal("out-of-range", "/engines/0/editor/consentDeadline/chip"),
      refusal("out-of-range", "/engines/0/editor/consentDeadline/sentence"),
    ]);
  });

  test("a fence alias that is not a lower-case tag is refused as pattern-mismatch, one listed twice as duplicate, and a seventeenth as too-many", () => {
    for (const alias of ["PgSQL", "pg-sql", "1sql", "", `q${"a".repeat(32)}`]) {
      const changed = manifest((m) => (editorOf(m).fenceAliases = [alias]));

      expect(refusalsFor(changed)).toEqual([refusal("pattern-mismatch", "/engines/0/editor/fenceAliases/0")]);
    }
    const twice = manifest((m) => (editorOf(m).fenceAliases = ["exampleql", "exampleql"]));
    const many = manifest((m) => (editorOf(m).fenceAliases = Array.from({ length: 17 }, (_, index) => `q${index}`)));

    expect(refusalsFor(twice)).toEqual([refusal("duplicate", "/engines/0/editor/fenceAliases/1")]);
    expect(refusalsFor(many)).toEqual([refusal("too-many", "/engines/0/editor/fenceAliases")]);
  });

  test("an explain format outside Studio's strategies is one refusal at the editor's explain format", () => {
    const changed = manifest((m) => (editorOf(m).explainFormat = "oracle-xplan"));

    expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", "/engines/0/editor/explainFormat")]);
  });

  test("a dialect outside Studio's dialects is refused as value-not-allowed", () => {
    const changed = manifest((m) => (editorOf(m).dialect = { ...dialect(), name: "graphql" }));

    expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", "/engines/0/editor/dialect/name")]);
  });

  test("a history mask with no flag is refused as too-few, and a flag that is not a long option as pattern-mismatch", () => {
    const none = manifest((m) => (editorOf(m).dialect = dialect([])));
    const many = manifest(
      (m) => (editorOf(m).dialect = dialect(Array.from({ length: 33 }, (_, index) => `--f${index}`))),
    );
    const twice = manifest((m) => (editorOf(m).dialect = dialect(["--token", "--token"])));

    expect(refusalsFor(none)).toEqual([refusal("too-few", "/engines/0/editor/dialect/historyMask/credentialFlags")]);
    expect(refusalsFor(many)).toEqual([refusal("too-many", "/engines/0/editor/dialect/historyMask/credentialFlags")]);
    expect(refusalsFor(twice)).toEqual([
      refusal("duplicate", "/engines/0/editor/dialect/historyMask/credentialFlags/1"),
    ]);
    for (const flag of ["-t", "--Token", "token", "--", `--${"a".repeat(64)}`]) {
      const changed = manifest((m) => (editorOf(m).dialect = dialect([flag])));

      expect(refusalsFor(changed)).toEqual([
        refusal("pattern-mismatch", "/engines/0/editor/dialect/historyMask/credentialFlags/0"),
      ]);
    }
  });

  test("a SQL text segment with every grammar fact stated, a command redaction and both completion readers is admitted", () => {
    const full = manifest((m) => {
      everyGrammarFact(m);
      sqlTextOf(m).redaction = { kind: "command", reader: "redactionReader" };
      sqlTextOf(m).updateTarget = {
        dashCommentNeedsSeparator: true,
        extraQueryOpeners: ["PIVOT", "FROM"],
        extraSetOperators: ["MINUS"],
      };
      sqlTextOf(m).completion = { formatSegment: "formatSegment", readQuotedQualifier: "readQuotedQualifier" };
    });
    const quoted = ['"', "`", "[", null].map((nameQuote) =>
      manifest((m) => (sqlTextOf(m).redaction = { kind: "sql", nameQuote })),
    );
    const noKeys = manifest((m) => (grammarOf(m).confirmConfigKeys = []));

    expect(refusalsFor(full)).toEqual([]);
    for (const changed of quoted) expect(refusalsFor(changed)).toEqual([]);
    expect(refusalsFor(noKeys)).toEqual([]);
  });

  test("a trailing limit clause longer than 512 characters is refused as out-of-range", () => {
    const words = (length: number) => "A".repeat(length - "\\s+\\s*$".length);
    const long = manifest((m) => (grammarOf(m).trailingLimitClauses = [clause(words(513))]));
    const longest = manifest((m) => (grammarOf(m).trailingLimitClauses = [clause(words(512))]));

    expect(refusalsFor(long)).toEqual([refusal("out-of-range", `${SQL_TEXT}/grammar/trailingLimitClauses/0/source`)]);
    expect(refusalsFor(longest)).toEqual([]);
  });

  test("a trailing limit clause whose flags are not i or iu is refused as value-not-allowed", () => {
    for (const flags of ["g", "", "im", "u", "ig"]) {
      const changed = manifest((m) => (grammarOf(m).trailingLimitClauses = [clause("LIMIT", flags)]));

      expect(refusalsFor(changed)).toEqual([
        refusal("value-not-allowed", `${SQL_TEXT}/grammar/trailingLimitClauses/0/flags`),
      ]);
    }
    const unicode = manifest((m) => (grammarOf(m).trailingLimitClauses = [clause("LIMIT", "iu")]));

    expect(refusalsFor(unicode)).toEqual([]);
  });

  test("a trailing limit clause that does not open with \\s+ and close with \\s*$ is refused as pattern-mismatch", () => {
    for (const source of ["BYPASS\\s+CACHE\\s*$", "\\s+BYPASS\\s+CACHE", "\\s*BYPASS\\s*$", " BYPASS\\s*$"]) {
      const changed = manifest((m) => (grammarOf(m).trailingLimitClauses = [{ source, flags: "i" }]));

      expect(refusalsFor(changed)).toEqual([
        refusal("pattern-mismatch", `${SQL_TEXT}/grammar/trailingLimitClauses/0/source`),
      ]);
    }
  });

  test("a keyword that is not one upper-case word is refused as pattern-mismatch, and an empty keyword sequence as too-few", () => {
    for (const word of ["drop", "DROP TABLE", "1DROP", "", `D${"A".repeat(64)}`]) {
      const changed = manifest((m) => (grammarOf(m).confirmForms = [[word]]));

      expect(refusalsFor(changed)).toEqual([refusal("pattern-mismatch", `${SQL_TEXT}/grammar/confirmForms/0/0`)]);
    }
    const empty = manifest((m) => (grammarOf(m).confirmForms = [[]]));
    const many = manifest((m) => (grammarOf(m).confirmExemptForms = [Array.from({ length: 17 }, () => "SET")]));
    const opener = manifest((m) => (sqlTextOf(m).updateTarget.extraQueryOpeners = ["pivot"]));
    const terminated = manifest((m) => (grammarOf(m).script.terminatedStatements = ["Merge"]));

    expect(refusalsFor(empty)).toEqual([refusal("too-few", `${SQL_TEXT}/grammar/confirmForms/0`)]);
    expect(refusalsFor(many)).toEqual([refusal("too-many", `${SQL_TEXT}/grammar/confirmExemptForms/0`)]);
    expect(refusalsFor(opener)).toEqual([refusal("pattern-mismatch", `${SQL_TEXT}/updateTarget/extraQueryOpeners/0`)]);
    expect(refusalsFor(terminated)).toEqual([
      refusal("pattern-mismatch", `${SQL_TEXT}/grammar/script/terminatedStatements/0`),
    ]);
  });

  test("a code form of no listed shape is refused as no-variant", () => {
    for (const form of [
      { prefix: "x", extra: 1 },
      { dollarQuoted: false },
      { prefix: "SYSTEM$", quotedCall: "A" },
      [],
    ]) {
      const changed = manifest((m) => (grammarOf(m).confirmCodeForms = [form]));

      expect(refusalsFor(changed)).toEqual([refusal("no-variant", `${SQL_TEXT}/grammar/confirmCodeForms/0`)]);
    }
  });

  test("a redaction of no listed kind, a name quote outside the vocabulary and a reader that is not a function name are each one refusal at the redaction", () => {
    for (const redaction of [
      { kind: "masked" },
      { kind: "sql", nameQuote: "'" },
      { kind: "sql" },
      { kind: "command", reader: "Redact" },
      { kind: "command", reader: null },
      { kind: "none", nameQuote: null },
    ]) {
      const changed = manifest((m) => (sqlTextOf(m).redaction = redaction));

      expect(refusalsFor(changed)).toEqual([refusal("no-variant", `${SQL_TEXT}/redaction`)]);
    }
  });

  test("a grammar rule, a script separator or a formatter language outside its vocabulary is refused", () => {
    const cases: [(m: Json) => void, string][] = [
      [(m) => (grammarOf(m).hash = "slash"), "/grammar/hash"],
      [(m) => (grammarOf(m).bracket = "array"), "/grammar/bracket"],
      [(m) => (grammarOf(m).blockComment = "nested"), "/grammar/blockComment"],
      [(m) => (grammarOf(m).script.blocks = "plpgsql"), "/grammar/script/blocks"],
      [(m) => (grammarOf(m).script.separatorLine = "go"), "/grammar/script/separatorLine"],
      [(m) => (grammarOf(m).script.unit = "script"), "/grammar/script/unit"],
      [(m) => (grammarOf(m).formatterLanguage = "mysql"), "/grammar/formatterLanguage"],
    ];
    for (const [change, pointer] of cases) {
      expect(refusalsFor(manifest(change))).toEqual([refusal("value-not-allowed", `${SQL_TEXT}${pointer}`)]);
    }
  });

  test("a row bound value holding whitespace is refused as pattern-mismatch, and a word listed twice in a set as duplicate at the later", () => {
    for (const bound of ["A B", "", " ALL", "x".repeat(33)]) {
      const changed = manifest((m) => (grammarOf(m).nonNumericRowBounds = [bound]));

      expect(refusalsFor(changed)).toEqual([refusal("pattern-mismatch", `${SQL_TEXT}/grammar/nonNumericRowBounds/0`)]);
    }
    const twice = manifest((m) => (sqlTextOf(m).updateTarget.extraSetOperators = ["MINUS", "EXCEPT", "MINUS"]));
    const twiceForm = manifest(
      (m) =>
        (grammarOf(m).confirmForms = [
          ["CREATE", "STAGE"],
          ["CREATE", "STAGE"],
        ]),
    );
    const twiceKey = manifest((m) => (grammarOf(m).confirmConfigKeys = ["spark.sql.a", "spark.sql.a"]));
    const badKey = manifest((m) => (grammarOf(m).confirmConfigKeys = ["spark sql"]));
    const keyword = manifest(
      (m) => (grammarOf(m).completionWords = { keywords: ["ASOF  JOIN"], functions: ["IFF", "IFF"] }),
    );

    expect(refusalsFor(twice)).toEqual([refusal("duplicate", `${SQL_TEXT}/updateTarget/extraSetOperators/2`)]);
    expect(refusalsFor(twiceForm)).toEqual([refusal("duplicate", `${SQL_TEXT}/grammar/confirmForms/1`)]);
    expect(refusalsFor(twiceKey)).toEqual([refusal("duplicate", `${SQL_TEXT}/grammar/confirmConfigKeys/1`)]);
    expect(refusalsFor(badKey)).toEqual([refusal("pattern-mismatch", `${SQL_TEXT}/grammar/confirmConfigKeys/0`)]);
    expect(refusalsFor(keyword)).toEqual([
      refusal("duplicate", `${SQL_TEXT}/grammar/completionWords/functions/1`),
      refusal("pattern-mismatch", `${SQL_TEXT}/grammar/completionWords/keywords/0`),
    ]);
  });

  test("an SQL writing segment with every hook named, a create table key, a bare spelling and every key float64 is admitted", () => {
    const full = manifest(everySqlWritingHook);
    const flagged = ["", "i", "u", "iu"].map((flags) =>
      manifest((m) => {
        vocabularyOf(m).floatType.flags = flags;
        vocabularyOf(m).numericWrapper.flags = flags;
      }),
    );
    const longest = manifest((m) => {
      sqlWritingOf(m).inlineEdit.instantTypeNames = [`d${"a".repeat(63)}`];
      sqlWritingOf(m).export.standsAlone = [`a${" b".repeat(31)}c`];
      sqlWritingOf(m).export.ddlTypes.text = `N${"A".repeat(63)}`;
      sqlWritingOf(m).export.nonFinite.NaN = `'${"x".repeat(61)}'`;
    });

    expect(refusalsFor(full)).toEqual([]);
    for (const changed of flagged) expect(refusalsFor(changed)).toEqual([]);
    expect(refusalsFor(longest)).toEqual([]);
  });

  test("an inline edit type name that is not one lower-case word is refused as pattern-mismatch", () => {
    for (const name of ["Timestamp", "timestamp with time zone", "", "1date", "date-time", `d${"a".repeat(64)}`]) {
      const instant = manifest((m) => (sqlWritingOf(m).inlineEdit.instantTypeNames = [name]));
      const exact = manifest((m) => (sqlWritingOf(m).inlineEdit.exactDecimalTypeNames = ["numeric", name]));

      expect(refusalsFor(instant)).toEqual([
        refusal("pattern-mismatch", `${SQL_WRITING}/inlineEdit/instantTypeNames/0`),
      ]);
      expect(refusalsFor(exact)).toEqual([
        refusal("pattern-mismatch", `${SQL_WRITING}/inlineEdit/exactDecimalTypeNames/1`),
      ]);
    }
  });

  test("a declared type name that is not lower-case words separated by single spaces is refused as pattern-mismatch", () => {
    for (const name of ["Text", "a  b", "decimal(10)", " text", "text ", "a\tb", ""]) {
      const alone = manifest((m) => (sqlWritingOf(m).export.standsAlone = [name]));
      const spelled = manifest((m) => (sqlWritingOf(m).export.bareSpelling = [{ name, spelling: "bit(64)" }]));
      const family = manifest((m) => vocabularyOf(m).bareTypeFamily.boolean.push(name));

      expect(refusalsFor(alone)).toEqual([refusal("pattern-mismatch", `${SQL_WRITING}/export/standsAlone/0`)]);
      expect(refusalsFor(spelled)).toEqual([refusal("pattern-mismatch", `${SQL_WRITING}/export/bareSpelling/0/name`)]);
      expect(refusalsFor(family)).toEqual([refusal("pattern-mismatch", `${VOCABULARY}/bareTypeFamily/boolean/0`)]);
    }
    const long = manifest((m) => (sqlWritingOf(m).export.standsAlone = ["a".repeat(65)]));

    expect(refusalsFor(long)).toEqual([refusal("out-of-range", `${SQL_WRITING}/export/standsAlone/0`)]);
  });

  test("a DDL type, a bare spelling or a non-finite literal that would not stay on its line is refused as pattern-mismatch", () => {
    for (const spelling of ["TEXT;", "TEXT\nDROP TABLE t", "TEXT\r", "1TEXT", ""]) {
      const ddl = manifest((m) => (sqlWritingOf(m).export.ddlTypes.text = spelling));
      const bare = manifest((m) => (sqlWritingOf(m).export.bareSpelling = [{ name: "bit", spelling }]));

      expect(refusalsFor(ddl)).toEqual([refusal("pattern-mismatch", `${SQL_WRITING}/export/ddlTypes/text`)]);
      expect(refusalsFor(bare)).toEqual([refusal("pattern-mismatch", `${SQL_WRITING}/export/bareSpelling/0/spelling`)]);
    }
    for (const literal of ["NULL\n", " NULL", "NULL ", "NULL ", "", "é", "x".repeat(65)]) {
      const changed = manifest((m) => (sqlWritingOf(m).export.nonFinite["-Infinity"] = literal));

      expect(refusalsFor(changed)).toEqual([refusal("pattern-mismatch", `${SQL_WRITING}/export/nonFinite/-Infinity`)]);
    }
  });

  test("a create table key note that is not whole comment lines is refused as pattern-mismatch", () => {
    const keyed = (note: string) =>
      manifest((m) => (sqlWritingOf(m).export.createTableKey = { note, clause: "createTableKeyClause" }));
    for (const note of ["CREATE TABLE x;\n", "-- a", "-- a\nDROP TABLE t;\n", "-- a\r\n", "-- a b\n", "--a\n", ""]) {
      expect(refusalsFor(keyed(note))).toEqual([
        refusal("pattern-mismatch", `${SQL_WRITING}/export/createTableKey/note`),
      ]);
    }
    const long = keyed(`-- ${"a".repeat(1021)}\n`);
    const longest = keyed(`-- ${"a".repeat(1020)}\n`);

    expect(refusalsFor(long)).toEqual([refusal("out-of-range", `${SQL_WRITING}/export/createTableKey/note`)]);
    expect(refusalsFor(longest)).toEqual([]);
  });

  test("a type pattern longer than 512 characters is refused as out-of-range, and one not written with ^ and $ as pattern-mismatch", () => {
    const long = manifest((m) => (vocabularyOf(m).floatType = typePattern(`^${"a".repeat(511)}$`, "i")));
    const longest = manifest((m) => (vocabularyOf(m).floatType = typePattern(`^${"a".repeat(510)}$`, "i")));

    expect(refusalsFor(long)).toEqual([refusal("out-of-range", `${VOCABULARY}/floatType/source`)]);
    expect(refusalsFor(longest)).toEqual([]);
    for (const source of ["real$", "^real", "real", "$^", "^"]) {
      const changed = manifest((m) => (vocabularyOf(m).exactNumericType = typePattern(source, "i")));
      const expected =
        source.length < 2
          ? [
              refusal("out-of-range", `${VOCABULARY}/exactNumericType/source`),
              refusal("pattern-mismatch", `${VOCABULARY}/exactNumericType/source`),
            ]
          : [refusal("pattern-mismatch", `${VOCABULARY}/exactNumericType/source`)];

      expect(refusalsFor(changed)).toEqual(expected);
    }
  });

  test("a type pattern whose flags are not none, i, u or iu is refused as value-not-allowed", () => {
    for (const flags of ["g", "m", "y", "gi", "s", "d", "ui"]) {
      const changed = manifest((m) => (vocabularyOf(m).numericWrapper.flags = flags));

      expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", `${VOCABULARY}/numericWrapper/flags`)]);
    }
  });

  test("float64 type names that are neither a list nor all are one refusal at the member", () => {
    for (const names of ["some", true, null, ["Double"], ["double", "double"]]) {
      const changed = manifest((m) => (sqlWritingOf(m).inlineEdit.float64TypeNames = names));

      expect(refusalsFor(changed)).toEqual([refusal("no-variant", `${SQL_WRITING}/inlineEdit/float64TypeNames`)]);
    }
  });

  test("an insert form outside values and select is refused as value-not-allowed", () => {
    for (const form of ["merge", "VALUES", ""]) {
      const changed = manifest((m) => (sqlWritingOf(m).export.insertForm = form));

      expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", `${SQL_WRITING}/export/insertForm`)]);
    }
  });

  test("a hook that is not a function name or null is refused, and a type name listed twice in one list as duplicate at the later", () => {
    const hook = manifest((m) => (sqlWritingOf(m).export.typedLiteral = "Typed literal"));
    const required = manifest((m) => (sqlWritingOf(m).escapeLiteral = null));
    const instant = manifest((m) => (sqlWritingOf(m).inlineEdit.instantTypeNames = ["date", "timestamp", "date"]));
    const alone = manifest((m) => (sqlWritingOf(m).export.standsAlone = ["text", "text"]));
    const family = manifest((m) => vocabularyOf(m).bareTypeFamily.integer.push("year"));
    const spelled = manifest(
      (m) =>
        (sqlWritingOf(m).export.bareSpelling = [
          { name: "bit", spelling: "bit(64)" },
          { name: "bit", spelling: "bit(64)" },
        ]),
    );

    expect(refusalsFor(hook)).toEqual([refusal("no-variant", `${SQL_WRITING}/export/typedLiteral`)]);
    expect(refusalsFor(required)).toEqual([refusal("wrong-type", `${SQL_WRITING}/escapeLiteral`)]);
    expect(refusalsFor(instant)).toEqual([refusal("duplicate", `${SQL_WRITING}/inlineEdit/instantTypeNames/2`)]);
    expect(refusalsFor(alone)).toEqual([refusal("duplicate", `${SQL_WRITING}/export/standsAlone/1`)]);
    expect(refusalsFor(family)).toEqual([refusal("duplicate", `${VOCABULARY}/bareTypeFamily/integer/1`)]);
    expect(refusalsFor(spelled)).toEqual([refusal("duplicate", `${SQL_WRITING}/export/bareSpelling/1`)]);
  });

  test("a migration DDL segment that refuses table DDL, one that writes it with a transaction wrapper, and one whose CREATE TABLE is refused are admitted", () => {
    const transaction = manifest(
      (m) => (migrationDdlOf(m).transactionWrapper = { begin: "BEGIN TRANSACTION;", commit: "COMMIT;" }),
    );
    const createTableRefused = manifest((m) => {
      Object.assign(migrationDdlOf(m), {
        transactionWrapper: null,
        createTable: { kind: "refused", createTableRefusal: "createTableRefusal" },
        reasons: [
          "Each table needs a primary key.",
          "An index is written by its own statement.",
          "A column type is changed by recreating the table.",
          "A foreign key is not enforced.",
        ],
      });
    });
    const refused = manifest((m) => (m.engines[0].migrationDdl = refusedMigrationDdl()));

    expect(migrationDdlOf(manifest())).toEqual(writtenMigrationDdl());
    expect(refusalsFor(manifest())).toEqual([]);
    expect(refusalsFor(kafkaManifest())).toEqual([]);
    expect(migrationDdlOf(kafkaManifest()).tableDdl).toBe("refused");
    expect(refusalsFor(transaction)).toEqual([]);
    expect(refusalsFor(createTableRefused)).toEqual([]);
    expect(refusalsFor(refused)).toEqual([]);
  });

  test("a migration DDL refusal that is not one comment line is one no-variant refusal at the segment", () => {
    const refusing = (line: string) =>
      manifest((m) => (m.engines[0].migrationDdl = { ...refusedMigrationDdl(), refusal: line }));
    for (const line of [
      "ExampleDB: Cannot generate table DDL.",
      "--ExampleDB: Cannot generate table DDL.",
      "-- ",
      "-- ExampleDB.\nDROP TABLE t;",
      "-- ExampleDB.\r",
      "-- ExampleDB. DROP TABLE t;",
      "-- ExampleDB. ",
      `-- ${"a".repeat(1022)}`,
    ]) {
      expect(refusalsFor(refusing(line))).toEqual([refusal("no-variant", MIGRATION_DDL)]);
    }
    expect(refusalsFor(refusing("-- ExampleDB: Cannot generate table DDL. Rows have no columns."))).toEqual([]);
    expect(refusalsFor(refusing(`-- ${"a".repeat(1021)}`))).toEqual([]);
  });

  test("a migration DDL reason that is not one line, or is listed twice, is one no-variant refusal at the segment", () => {
    const giving = (reasons: readonly string[]) => manifest((m) => (migrationDdlOf(m).reasons = reasons));
    const distinct = (count: number) => Array.from({ length: count }, (_, index) => `Reason ${index}.`);
    for (const reasons of [
      ["A reason.\nDROP TABLE t;"],
      ["A reason.\r"],
      ["A reason. "],
      [""],
      ["A reason.", "A reason."],
      distinct(65),
      ["a".repeat(1025)],
    ]) {
      expect(refusalsFor(giving(reasons))).toEqual([refusal("no-variant", MIGRATION_DDL)]);
    }
    expect(refusalsFor(giving(["A reason.", "Another reason."]))).toEqual([]);
    expect(refusalsFor(giving(distinct(64)))).toEqual([]);
    expect(refusalsFor(giving(["a".repeat(1024)]))).toEqual([]);
  });

  test("a transaction wrapper statement that is not words ending in one semicolon is one no-variant refusal at the segment", () => {
    const wrapping = (wrapper: unknown) => manifest((m) => (migrationDdlOf(m).transactionWrapper = wrapper));
    for (const begin of [
      "BEGIN",
      "BEGIN; DROP TABLE t;",
      "BEGIN;\n",
      "BEGIN;;",
      " BEGIN;",
      "BEGIN  TRANSACTION;",
      "BEGIN ;",
      `${"A".repeat(64)};`,
    ]) {
      expect(refusalsFor(wrapping({ begin, commit: "COMMIT;" }))).toEqual([refusal("no-variant", MIGRATION_DDL)]);
    }
    expect(refusalsFor(wrapping({ begin: "BEGIN;", commit: "COMMIT ;" }))).toEqual([
      refusal("no-variant", MIGRATION_DDL),
    ]);
    expect(refusalsFor(wrapping({ begin: "BEGIN;", commit: "COMMIT;", rollback: "ROLLBACK;" }))).toEqual([
      refusal("no-variant", MIGRATION_DDL),
    ]);
    expect(refusalsFor(wrapping({ begin: "BEGIN;" }))).toEqual([refusal("no-variant", MIGRATION_DDL)]);
    expect(refusalsFor(wrapping({ begin: "START TRANSACTION;", commit: "COMMIT WORK;" }))).toEqual([]);
    expect(refusalsFor(wrapping({ begin: `${"A".repeat(63)};`, commit: "COMMIT;" }))).toEqual([]);
    expect(refusalsFor(wrapping(null))).toEqual([]);
  });

  test("a migration DDL member of the other form, a missing one or an unknown one is one no-variant refusal at the segment", () => {
    const segment = (value: Json) => manifest((m) => (m.engines[0].migrationDdl = value));
    const without = (value: Json, member: string) => {
      const rest = { ...value };
      delete rest[member];
      return rest;
    };
    const refused = refusedMigrationDdl();
    const written = writtenMigrationDdl();
    const changed: Json[] = [
      { ...refused, transactionWrapper: { begin: "BEGIN;", commit: "COMMIT;" } },
      { ...refused, columnDef: "columnDef" },
      { ...refused, createTable: written.createTable },
      { ...written, refusal: refused.refusal },
      { ...written, dropTable: "Drop_table" },
      { ...written, dropTable: null },
      { ...written, tableDdl: "refused" },
      { ...refused, tableDdl: "written" },
      { ...written, tableDdl: "partial" },
      { ...written, bogus: "bogus" },
      ...WRITTEN_MIGRATION_DDL_MEMBERS.map((member) => without(written, member)),
      ...["tableDdl", "refusal", "transactionWrapper", "reasons"].map((member) => without(refused, member)),
    ];

    for (const value of changed) {
      expect(refusalsFor(segment(value))).toEqual([refusal("no-variant", MIGRATION_DDL)]);
    }
    expect(refusalsFor(segment(written))).toEqual([]);
    expect(refusalsFor(segment(refused))).toEqual([]);
    expect(refusalsFor(segment({ ...written, dropTable: "dropTable2" }))).toEqual([]);
  });

  test("a create table of no listed kind, or with a member of the other kind, is one no-variant refusal at the segment", () => {
    const creating = (createTable: Json | null) => manifest((m) => (migrationDdlOf(m).createTable = createTable));
    for (const createTable of [
      { kind: "partial", primaryKey: "createTablePrimaryKey", foreignKey: "createTableForeignKey" },
      { kind: "refused", createTableRefusal: "createTableRefusal", primaryKey: "createTablePrimaryKey" },
      { kind: "refused", primaryKey: "createTablePrimaryKey" },
      { kind: "written", primaryKey: "createTablePrimaryKey" },
      { kind: "written", primaryKey: "createTablePrimaryKey", foreignKey: "createTableForeignKey", note: "n" },
      { kind: "written", createTableRefusal: "createTableRefusal" },
      { primaryKey: "createTablePrimaryKey", foreignKey: "createTableForeignKey" },
      null,
    ]) {
      expect(refusalsFor(creating(createTable))).toEqual([refusal("no-variant", MIGRATION_DDL)]);
    }
    expect(refusalsFor(creating({ kind: "refused", createTableRefusal: "createTableRefusal" }))).toEqual([]);
    expect(
      refusalsFor(creating({ kind: "written", primaryKey: "primaryKey", foreignKey: "createTableForeignKey" })),
    ).toEqual([]);
  });

  test("a DDL type or a bare spelling that is more than one type at the top level is refused as pattern-mismatch", () => {
    const ddl = (spelling: string) => manifest((m) => (sqlWritingOf(m).export.ddlTypes.text = spelling));
    const bare = (spelling: string) =>
      manifest((m) => (sqlWritingOf(m).export.bareSpelling = [{ name: "bit", spelling }]));
    for (const spelling of [
      "INT, x INT",
      "NUMBER(19), y INT",
      "INT)",
      "(INT)",
      "INT(",
      "INT()",
      "INT(1)(2)",
      "INT(1, )",
      "INT  X",
      "INT ",
      "INT,",
      "Array(Nullable(String))",
    ]) {
      expect(refusalsFor(ddl(spelling))).toEqual([refusal("pattern-mismatch", `${SQL_WRITING}/export/ddlTypes/text`)]);
      expect(refusalsFor(bare(spelling))).toEqual([
        refusal("pattern-mismatch", `${SQL_WRITING}/export/bareSpelling/0/spelling`),
      ]);
    }
    for (const spelling of [
      "DECIMAL(38, 9)",
      "DECIMAL(38,9)",
      "TIMESTAMP(6) WITH TIME ZONE",
      "Map(String, String)",
      "CHARACTER VARYING(255)",
      "NVARCHAR(MAX)",
      "bit varying",
    ]) {
      expect(refusalsFor(ddl(spelling))).toEqual([]);
      expect(refusalsFor(bare(spelling))).toEqual([]);
    }
    expect(refusalsFor(ddl(`T${"A".repeat(64)}`))).toEqual([
      refusal("out-of-range", `${SQL_WRITING}/export/ddlTypes/text`),
    ]);
  });

  test("an SQL generator segment naming every form, one naming only its quoting, and a null one are admitted", () => {
    const named = manifest((m) => (m.engines[0].sqlGenerators = namedSqlGenerators()));
    const quoteOnly = manifest((m) =>
      Object.assign(sqlGeneratorsOf(m), { selectList: null, countExpression: "COUNT(*)" }),
    );
    const none = manifest((m) => (m.engines[0].sqlGenerators = null));

    expect(sqlGeneratorsOf(manifest())).toEqual({ ...namedSqlGenerators("COUNT(*)"), table: null, select: null });
    expect(refusalsFor(manifest())).toEqual([]);
    expect(sqlGeneratorsOf(kafkaManifest())).toBeNull();
    expect(refusalsFor(kafkaManifest())).toEqual([]);
    expect(refusalsFor(named)).toEqual([]);
    expect(refusalsFor(quoteOnly)).toEqual([]);
    expect(refusalsFor(none)).toEqual([]);
  });

  test("an SQL generator segment that is not an object or null is refused as wrong-type", () => {
    const text = manifest((m) => (m.engines[0].sqlGenerators = "generatorQuote"));

    expect(refusalsFor(text)).toEqual([refusal("wrong-type", SQL_GENERATORS)]);
  });

  test("an SQL generator form named in another form is refused at the form", () => {
    const quote = manifest((m) => (sqlGeneratorsOf(m).quote = "Generator_quote"));
    const table = manifest((m) => (sqlGeneratorsOf(m).table = "Generator_quote"));
    const flag = manifest((m) => (sqlGeneratorsOf(m).table = false));
    const quoteNull = manifest((m) => (sqlGeneratorsOf(m).quote = null));

    expect(refusalsFor(quote)).toEqual([refusal("pattern-mismatch", `${SQL_GENERATORS}/quote`)]);
    expect(refusalsFor(table)).toEqual([refusal("no-variant", `${SQL_GENERATORS}/table`)]);
    expect(refusalsFor(flag)).toEqual([refusal("no-variant", `${SQL_GENERATORS}/table`)]);
    expect(refusalsFor(quoteNull)).toEqual([refusal("wrong-type", `${SQL_GENERATORS}/quote`)]);
  });

  test("a count expression that is not one aggregate call over every row is refused as pattern-mismatch, and one longer than 64 characters as out-of-range", () => {
    const counting = (count: unknown) => manifest((m) => (sqlGeneratorsOf(m).countExpression = count));
    for (const count of [
      "COUNT(*); DROP TABLE t",
      "COUNT(*) AS n",
      "COUNT(*)\n",
      "COUNT(1)",
      "COUNT (*)",
      "COUNT(DISTINCT x)",
      "(*)",
      "1COUNT(*)",
      "COUNT(*)(*)",
      "",
    ]) {
      expect(refusalsFor(counting(count))).toEqual([refusal("pattern-mismatch", `${SQL_GENERATORS}/countExpression`)]);
    }
    for (const count of ["COUNT(*)", "COUNT_BIG(*)", "count(*)", `${"C".repeat(61)}(*)`]) {
      expect(refusalsFor(counting(count))).toEqual([]);
    }
    expect(refusalsFor(counting(`${"C".repeat(62)}(*)`))).toEqual([
      refusal("out-of-range", `${SQL_GENERATORS}/countExpression`),
    ]);
    expect(refusalsFor(counting(null))).toEqual([refusal("wrong-type", `${SQL_GENERATORS}/countExpression`)]);
  });

  test("an editor language with Studio's query language, Monaco language and accent is admitted, and a console language too", () => {
    const consoleLanguage = manifest((m) =>
      Object.assign(languageOf(m), {
        queryLanguage: "json",
        monacoId: "milvus",
        accent: "border-hue-teal/40",
        console: true,
      }),
    );
    const alt = manifest((m) => (languageOf(m).accent = "border-hue-teal-alt/40"));
    const cypher = manifest((m) =>
      Object.assign(languageOf(m), {
        queryLanguage: "cypher",
        monacoId: "graph-cypher",
        accent: "border-hue-violet/40",
      }),
    );

    expect(languageOf(manifest())).toEqual({
      queryLanguage: "sql",
      monacoId: "sql",
      accent: "border-hue-blue/40",
      console: false,
    });
    expect(refusalsFor(manifest())).toEqual([]);
    expect(languageOf(kafkaManifest()).monacoId).toBe("json");
    expect(refusalsFor(kafkaManifest())).toEqual([]);
    expect(refusalsFor(consoleLanguage)).toEqual([]);
    expect(refusalsFor(alt)).toEqual([]);
    expect(refusalsFor(cypher)).toEqual([]);
  });

  test("a query language or a Monaco language outside Studio's is refused as value-not-allowed", () => {
    const graphql = manifest((m) => (languageOf(m).queryLanguage = "graphql"));
    const cypher = manifest((m) => (languageOf(m).monacoId = "cypher"));

    expect(refusalsFor(graphql)).toEqual([refusal("value-not-allowed", `${LANGUAGE}/queryLanguage`)]);
    expect(refusalsFor(cypher)).toEqual([refusal("value-not-allowed", `${LANGUAGE}/monacoId`)]);
  });

  test("an accent that is not one border hue class of Studio's palette, or is a status hue, is refused as pattern-mismatch", () => {
    const accenting = (accent: string) => manifest((m) => (languageOf(m).accent = accent));
    for (const accent of [
      "border-hue-amber/40",
      "border-hue-rose-alt/40",
      "border-hue-emerald/40",
      "border-hue-blue/40 bg-red-500",
      "border-hue-blue/50",
      "border-hue-blue-tint/40",
      "text-hue-blue/40",
      "border-hue-Blue/40",
      "border-hue-blue/40\n",
      "border-hue-/40",
      "border-hue-blue-alt-alt/40",
    ]) {
      expect(refusalsFor(accenting(accent))).toEqual([refusal("pattern-mismatch", `${LANGUAGE}/accent`)]);
    }
    expect(refusalsFor(accenting("border-hue-teal-alt/40"))).toEqual([]);
    expect(refusalsFor(accenting(`border-hue-${"a".repeat(18)}/40`))).toEqual([]);
    expect(refusalsFor(accenting(`border-hue-${"a".repeat(19)}/40`))).toEqual([
      refusal("out-of-range", `${LANGUAGE}/accent`),
    ]);
  });

  test("an editor language that states a tab type or a console dialect id is refused as unknown-key", () => {
    const tabType = manifest((m) => (languageOf(m).tabType = "sql"));
    const consoleDialect = manifest((m) => (languageOf(m).consoleDialect = "sql"));
    const flag = manifest((m) => (languageOf(m).console = "yes"));

    expect(refusalsFor(tabType)).toEqual([refusal("unknown-key", LANGUAGE, "tabType")]);
    expect(refusalsFor(consoleDialect)).toEqual([refusal("unknown-key", LANGUAGE, "consoleDialect")]);
    expect(refusalsFor(flag)).toEqual([refusal("wrong-type", `${LANGUAGE}/console`)]);
  });

  test("a connect budget of null or within 30,000 to 300,000 ms is admitted", () => {
    const budgeting = (budget: unknown) => manifest((m) => (connectionOf(m).connectBudgetMs = budget));

    expect(connectionOf(manifest()).connectBudgetMs).toBeNull();
    expect(refusalsFor(manifest())).toEqual([]);
    expect(connectionOf(kafkaManifest()).connectBudgetMs).toBeNull();
    expect(refusalsFor(kafkaManifest())).toEqual([]);
    for (const budget of [30_000, 140_000, 300_000]) expect(refusalsFor(budgeting(budget))).toEqual([]);
  });

  test("a connect budget below 30,000 ms or above 300,000 ms is refused as out-of-range at the connection's connectBudgetMs", () => {
    for (const budget of [29_999, 300_001, 0]) {
      const changed = manifest((m) => (connectionOf(m).connectBudgetMs = budget));
      expect(refusalsFor(changed)).toEqual([refusal("out-of-range", "/engines/0/connection/connectBudgetMs")]);
    }
  });

  test("a connect budget that is not a whole number is refused as wrong-type", () => {
    for (const budget of [45_000.5, "70000", true]) {
      const changed = manifest((m) => (connectionOf(m).connectBudgetMs = budget));
      expect(refusalsFor(changed)).toEqual([refusal("wrong-type", "/engines/0/connection/connectBudgetMs")]);
    }
  });

  test("a connection without connectBudgetMs is refused as missing-key", () => {
    const changed = manifest((m) => delete connectionOf(m).connectBudgetMs);

    expect(refusalsFor(changed)).toEqual([refusal("missing-key", "/engines/0/connection", "connectBudgetMs")]);
  });

  test("several failures are each refused, ordered by pointer", () => {
    const changed = manifest((m) => {
      m.bogus = true;
      m.engines[0].location = "remote";
      m.engines[0].connection.tls = "maybe";
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("unknown-key", "", "bogus"),
      refusal("value-not-allowed", "/engines/0/connection/tls"),
      refusal("value-not-allowed", "/engines/0/location"),
    ]);
  });
});

describe("rules the schema cannot state", () => {
  const second = (m: Json) => ({ ...structuredClone(m.engines[0]), id: "otherdb" });

  test("two engines with one id are refused as engine-id-duplicate at the second", () => {
    const changed = manifest((m) => m.engines.push(structuredClone(m.engines[0])));

    expect(refusalsFor(changed)).toEqual([refusal("engine-id-duplicate", "/engines/1/id")]);
  });

  test("an engine with no compatibility entry is refused as compatibility-engine-missing", () => {
    const changed = manifest((m) => m.engines.push(second(m)));

    expect(refusalsFor(changed)).toEqual([refusal("compatibility-engine-missing", "/engines/1/id")]);
  });

  test("a compatibility entry for an undeclared engine is refused as compatibility-engine-undeclared", () => {
    const changed = manifest((m) =>
      m.compatibility.push({ ...structuredClone(m.compatibility[0]), engine: "ghostdb" }),
    );

    expect(refusalsFor(changed)).toEqual([refusal("compatibility-engine-undeclared", "/compatibility/1/engine")]);
  });

  test("a range endpoint missing from the tested versions is refused as compatibility-endpoint-untested", () => {
    const fromUntested = manifest((m) => (m.compatibility[0].versions = { kind: "range", from: "2.0", to: "2.4" }));
    const toUntested = manifest((m) => (m.compatibility[0].versions = { kind: "range", from: "2.4", to: "2.9" }));
    const bothTested = manifest((m) => {
      m.compatibility[0].versions = { kind: "range", from: "2.0", to: "2.4" };
      m.compatibility[0].tested.unshift({ version: "2.0" });
    });

    expect(refusalsFor(fromUntested)).toEqual([
      refusal("compatibility-endpoint-untested", "/compatibility/0/versions/from"),
    ]);
    expect(refusalsFor(toUntested)).toEqual([
      refusal("compatibility-endpoint-untested", "/compatibility/0/versions/to"),
    ]);
    expect(refusalsFor(bothTested)).toEqual([]);
  });

  test("a refused field that is also declared is refused as refused-field-declared", () => {
    const changed = manifest(
      (m) =>
        (m.engines[0].connection.refused = [
          { field: "region", refusal: randomUUID() },
          { field: "user", refusal: randomUUID() },
        ]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("refused-field-declared", "/engines/0/connection/refused/1")]);
  });

  test("two refused entries naming one field are refused as refused-field-duplicate at the second", () => {
    const changed = manifest(
      (m) =>
        (m.engines[0].connection.refused = [
          { field: "region", refusal: randomUUID() },
          { field: "apiKeyId", refusal: randomUUID() },
          { field: "region", refusal: randomUUID() },
        ]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("refused-field-duplicate", "/engines/0/connection/refused/2")]);
  });

  test("a seed-only field neither declared nor a seed-only name is refused as seed-only-field-undeclared", () => {
    const changed = manifest(
      (m) => (m.engines[0].connection.seedOnly = { ...SEED_ONLY, fields: ["database", "agentReadRoots", "region"] }),
    );

    expect(refusalsFor(changed)).toEqual([
      refusal("seed-only-field-undeclared", "/engines/0/connection/seedOnly/fields/2"),
    ]);
  });

  test("a host path field that is not a seed-only field of its engine is refused as host-path-field-undeclared", () => {
    const changed = manifest((m) => {
      m.engines[0].connection.seedOnly = { ...SEED_ONLY, fields: ["clientCertificatePath"] };
      m.engines[0].connection.hostPathFields = ["clientCertificatePath", "clientPrivateKeyPath"];
    });
    const withoutSeedOnly = manifest((m) => (m.engines[0].connection.hostPathFields = ["clientPrivateKeyPath"]));

    expect(refusalsFor(changed)).toEqual([
      refusal("host-path-field-undeclared", "/engines/0/connection/hostPathFields/1"),
    ]);
    expect(refusalsFor(withoutSeedOnly)).toEqual([
      refusal("host-path-field-undeclared", "/engines/0/connection/hostPathFields/0"),
    ]);
  });

  test.each([
    ["a label", "labels", { field: "warehouse", text: "Warehouse" }],
    ["a hint", "hints", { field: "warehouse", text: "w" }],
    ["a placeholder", "placeholders", { field: "warehouse", text: "" }],
    ["a placement", "placement", { field: "serviceName", where: "open" }],
    ["an options entry", "options", { field: "saslMechanism", choices: [{ value: "PLAIN", label: "PLAIN" }] }],
  ])("%s for a field the engine does not take is refused as field-undeclared", (_name, list, entry) => {
    const changed = manifest((m) => (connectionOf(m).dialog[list] = [entry]));

    expect(refusalsFor(changed)).toEqual([refusal("field-undeclared", `/engines/0/connection/dialog/${list}/0/field`)]);
  });

  test("an order item naming a field the engine does not take is refused as field-undeclared", () => {
    const changed = manifest((m) => (connectionOf(m).dialog.order = ["host", "warehouse"]));

    expect(refusalsFor(changed)).toEqual([refusal("field-undeclared", "/engines/0/connection/dialog/order/1")]);
  });

  test("a condition on, or reading, a field the engine does not take is refused as field-undeclared", () => {
    const shown = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen.push({ field: "region", when: { field: "authMethod", equals: "pat" } });
    });
    const read = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen[1].when.field = "region";
    });

    expect(refusalsFor(shown)).toEqual([refusal("field-undeclared", "/engines/0/connection/dialog/shownWhen/2/field")]);
    expect(refusalsFor(read)).toEqual([
      refusal("field-undeclared", "/engines/0/connection/dialog/shownWhen/1/when/field"),
    ]);
  });

  test("two entries of one list naming one field are refused as dialog-entry-duplicate at the second", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).dialog.labels = [
          { field: "password", text: "Token" },
          { field: "user", text: "Login" },
          { field: "password", text: "Secret" },
        ]),
    );
    const across = manifest((m) => {
      connectionOf(m).dialog.labels = [{ field: "password", text: "Token" }];
      connectionOf(m).dialog.hints = [{ field: "password", text: "A token." }];
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("dialog-entry-duplicate", "/engines/0/connection/dialog/labels/2/field"),
    ]);
    expect(refusalsFor(across)).toEqual([]);
  });

  test("a placeable field the engine takes with no placement is refused as placement-missing", () => {
    const changed = manifest((m) => connectionOf(m).fields.push("serviceName"));
    const placed = manifest((m) => {
      connectionOf(m).fields.push("serviceName");
      connectionOf(m).dialog.placement = [{ field: "serviceName", where: "advanced" }];
    });

    expect(refusalsFor(changed)).toEqual([refusal("placement-missing", "/engines/0/connection/fields/5")]);
    expect(refusalsFor(placed)).toEqual([]);
  });

  test("a select field the engine takes with no options is refused as options-missing", () => {
    const changed = manifest((m) => connectionOf(m).fields.push("saslMechanism"));

    expect(refusalsFor(changed)).toEqual([refusal("options-missing", "/engines/0/connection/fields/5")]);
  });

  test("two choices of one field with one value are refused as option-value-duplicate at the second", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields.push("saslMechanism");
      connectionOf(m).dialog.options = [
        {
          field: "saslMechanism",
          choices: [
            { value: "PLAIN", label: "PLAIN" },
            { value: "SCRAM-SHA-256", label: "SCRAM" },
            { value: "PLAIN", label: "Plain text" },
          ],
        },
      ];
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("option-value-duplicate", "/engines/0/connection/dialog/options/0/choices/2/value"),
    ]);
  });

  test("a condition reading a field that has a condition of its own is refused as shown-when-chained", () => {
    const chained = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen.push({ field: "warehouse", when: { field: "privateKey", equals: "x" } });
    });
    const itself = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen.push({ field: "warehouse", when: { field: "warehouse", equals: "x" } });
    });

    expect(refusalsFor(chained)).toEqual([
      refusal("shown-when-chained", "/engines/0/connection/dialog/shownWhen/2/when/field"),
    ]);
    expect(refusalsFor(itself)).toEqual([
      refusal("shown-when-chained", "/engines/0/connection/dialog/shownWhen/2/when/field"),
    ]);
  });

  test("a condition on a select naming a value none of its choices is refused as shown-when-value-not-an-option", () => {
    const changed = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen[1].when.equals = "oauth";
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("shown-when-value-not-an-option", "/engines/0/connection/dialog/shownWhen/1/when/equals"),
    ]);
  });

  test("an absent value that is none of its field's choices is refused as absent-value-not-an-option", () => {
    const changed = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.absentValues[0].value = "oauth";
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("absent-value-not-an-option", "/engines/0/connection/dialog/absentValues/0/value"),
    ]);
  });

  test("an absent value for a field no condition reads is refused as absent-value-unread", () => {
    const changed = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.absentValues.push({ field: "warehouse", value: "compute" });
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("absent-value-unread", "/engines/0/connection/dialog/absentValues/1/field"),
    ]);
  });

  test("a select field a condition reads with no absent value is refused as absent-value-missing", () => {
    const changed = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.absentValues = [];
    });
    const textField = manifest((m) => {
      signInShaped(m);
      connectionOf(m).dialog.shownWhen.push({ field: "warehouse", when: { field: "user", equals: "admin" } });
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("absent-value-missing", "/engines/0/connection/dialog/shownWhen/0/when/field"),
      refusal("absent-value-missing", "/engines/0/connection/dialog/shownWhen/1/when/field"),
    ]);
    expect(refusalsFor(textField)).toEqual([]);
  });

  test("URI schemes on an engine without a host field are refused as host-uri-schemes-without-host", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields = ["user", "password", "database"];
      connectionOf(m).hostUriSchemes = ["https"];
    });
    const withHost = manifest((m) => (connectionOf(m).hostUriSchemes = ["https", "http"]));

    expect(refusalsFor(changed)).toEqual([
      refusal("host-uri-schemes-without-host", "/engines/0/connection/hostUriSchemes"),
    ]);
    expect(refusalsFor(withHost)).toEqual([]);
  });

  test("a credential warning on a field the engine does not take is refused as credential-warning-field-undeclared", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields = ["host", "port", "password"];
      connectionOf(m).credentialWarnings = [
        { kind: "no-secret", message: randomUUID() },
        { kind: "pair", user: "admin", password: randomUUID(), message: randomUUID() },
      ];
    });
    const noPassword = manifest((m) => {
      connectionOf(m).fields = ["host", "port", "user"];
      connectionOf(m).credentialWarnings = [
        { kind: "jwt", noExp: true, access: [], message: randomUUID() },
        { kind: "no-secret", message: randomUUID() },
        { kind: "pair", user: "admin", password: randomUUID(), message: randomUUID() },
      ];
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("credential-warning-field-undeclared", "/engines/0/connection/credentialWarnings/1"),
    ]);
    expect(refusalsFor(noPassword)).toEqual([
      refusal("credential-warning-field-undeclared", "/engines/0/connection/credentialWarnings/0"),
      refusal("credential-warning-field-undeclared", "/engines/0/connection/credentialWarnings/1"),
      refusal("credential-warning-field-undeclared", "/engines/0/connection/credentialWarnings/2"),
    ]);
  });

  test("a second no-secret warning is refused as no-secret-warning-duplicate", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).credentialWarnings = [
          { kind: "no-secret", message: randomUUID() },
          { kind: "jwt", noExp: true, access: ["m"], message: randomUUID() },
          { kind: "no-secret", message: randomUUID() },
        ]),
    );

    expect(refusalsFor(changed)).toEqual([
      refusal("no-secret-warning-duplicate", "/engines/0/connection/credentialWarnings/2"),
    ]);
  });

  test("a field rule for a field the engine does not take is refused as field-undeclared", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).fieldRules = [
          fieldRule("host", { required: randomUUID() }),
          fieldRule("warehouse", { format: format("^[a-z]+$") }),
        ]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("field-undeclared", "/engines/0/connection/fieldRules/1/field")]);
  });

  test("two field rules naming one field are refused as field-rule-duplicate at the second", () => {
    const changed = manifest(
      (m) =>
        (connectionOf(m).fieldRules = [
          fieldRule("host", { required: randomUUID() }),
          fieldRule("user", { required: randomUUID() }),
          fieldRule("host", { format: format("^[a-z]+$") }),
        ]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("field-rule-duplicate", "/engines/0/connection/fieldRules/2/field")]);
  });

  test("a field rule that states nothing is refused as field-rule-empty", () => {
    const changed = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("user", { required: randomUUID() }), fieldRule("host")]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("field-rule-empty", "/engines/0/connection/fieldRules/1")]);
  });

  test("a pattern that does not compile is refused as pattern-invalid", () => {
    const source = `^(${randomUUID()}`;
    const changed = manifest((m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format(source) })]));
    const notUnicode = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("^\\p{L$", "u") })]),
    );
    const plain = manifest((m) => (connectionOf(m).fieldRules = [fieldRule("host", { format: format("^\\p{L$") })]));

    const refusals = refusalsFor(changed);
    expect(refusals).toEqual([refusal("pattern-invalid", "/engines/0/connection/fieldRules/0/format/pattern/source")]);
    expect(refusalsFor(notUnicode)).toEqual([
      refusal("pattern-invalid", "/engines/0/connection/fieldRules/0/format/pattern/source"),
    ]);
    expect(refusalsFor(plain)).toEqual([]);
    const sentence = refusalSentence(refusals[0] as ManifestRefusal);
    expect(sentence).not.toContain(source);
    expect(sentence).not.toContain("Unterminated");
    expect(sentence).not.toContain("Invalid regular expression");
  });

  test("a trailing limit clause that does not compile is refused as pattern-invalid", () => {
    const source = `\\s+(${randomUUID()}\\s*$`;
    const changed = manifest((m) => (grammarOf(m).trailingLimitClauses = [clause("LIMIT"), { source, flags: "i" }]));
    const notUnicode = manifest((m) => (grammarOf(m).trailingLimitClauses = [clause("\\p{L", "iu")]));
    const plain = manifest((m) => (grammarOf(m).trailingLimitClauses = [clause("\\p{L")]));

    const refusals = refusalsFor(changed);
    expect(refusals).toEqual([refusal("pattern-invalid", `${SQL_TEXT}/grammar/trailingLimitClauses/1/source`)]);
    expect(refusalsFor(notUnicode)).toEqual([
      refusal("pattern-invalid", `${SQL_TEXT}/grammar/trailingLimitClauses/0/source`),
    ]);
    expect(refusalsFor(plain)).toEqual([]);
    const sentence = refusalSentence(refusals[0] as ManifestRefusal);
    expect(sentence).not.toContain(source);
    expect(sentence).not.toContain("Invalid regular expression");
  });

  test("a type pattern that does not compile is refused as pattern-invalid", () => {
    const source = `^(${randomUUID()}$`;
    const changed = manifest((m) => (vocabularyOf(m).floatType = typePattern(source, "i")));
    const notUnicode = manifest((m) => (vocabularyOf(m).exactNumericType = typePattern("^\\p{L$", "u")));
    const plain = manifest((m) => (vocabularyOf(m).exactNumericType = typePattern("^\\p{L$")));
    const all = manifest((m) => {
      vocabularyOf(m).floatType = typePattern("^[$");
      vocabularyOf(m).exactNumericType = typePattern("^)$");
      vocabularyOf(m).numericWrapper = typePattern("^(?<a>x)(?<a>y)$");
    });

    const refusals = refusalsFor(changed);
    expect(refusals).toEqual([refusal("pattern-invalid", `${VOCABULARY}/floatType/source`)]);
    expect(refusalsFor(notUnicode)).toEqual([refusal("pattern-invalid", `${VOCABULARY}/exactNumericType/source`)]);
    expect(refusalsFor(plain)).toEqual([]);
    expect(refusalsFor(all)).toEqual([
      refusal("pattern-invalid", `${VOCABULARY}/exactNumericType/source`),
      refusal("pattern-invalid", `${VOCABULARY}/floatType/source`),
      refusal("pattern-invalid", `${VOCABULARY}/numericWrapper/source`),
    ]);
    const sentence = refusalSentence(refusals[0] as ManifestRefusal);
    expect(sentence).not.toContain(source);
    expect(sentence).not.toContain("Invalid regular expression");
  });

  test("a wrapper pattern that does not capture exactly one group is refused as wrapper-group-count", () => {
    const wrapped = (source: string, flags = "") =>
      manifest((m) => (vocabularyOf(m).numericWrapper = typePattern(source, flags)));
    const pointer = `${VOCABULARY}/numericWrapper/source`;

    for (const source of ["^Nullable\\(.*\\)$", "^(a)(b)$", "^(?:Nullable)\\(.*\\)$", "^((a))$", "^\\(.*\\)$"]) {
      expect(refusalsFor(wrapped(source))).toEqual([refusal("wrapper-group-count", pointer)]);
    }
    for (const source of [
      "^Nullable\\((.*)\\)$",
      "^(?:Nullable|LowCardinality)\\((.*)\\)$",
      "^(?<inner>.*)$",
      "^(a)|(?:b)$",
    ]) {
      expect(refusalsFor(wrapped(source))).toEqual([]);
    }
    expect(refusalsFor(wrapped("^Nullable\\((\\p{L}+)\\)$", "u"))).toEqual([]);
    expect(refusalsFor(wrapped("^(x$"))).toEqual([refusal("pattern-invalid", pointer)]);
    expect(refusalsFor(wrapped("^(x)$", "i"))).toEqual([]);
  });

  test("a wrapper pattern that backtracks without end on the empty string is still counted at once", async () => {
    const report = await wrapperCountChild.run<WrapperCountReport>(SCHEMA_PATH);
    expect(report).toEqual({ sourceLength: 458, admitted: true });
  }, 20_000);

  test("a type name under two families, or a bare spelling named twice, is refused as type-name-duplicate at the later", () => {
    const families = manifest((m) => {
      const family = vocabularyOf(m).bareTypeFamily;
      family.binary.push("varchar");
      family.boolean.push("decimal");
      family.timestamp.push("decimal");
    });
    const spellings = manifest(
      (m) =>
        (sqlWritingOf(m).export.bareSpelling = [
          { name: "bit", spelling: "bit(64)" },
          { name: "time", spelling: "time(6)" },
          { name: "bit", spelling: "bit(1)" },
        ]),
    );
    const apart = manifest((m) => {
      sqlWritingOf(m).export.bareSpelling = [{ name: "decimal", spelling: "decimal(38, 10)" }];
      sqlWritingOf(m).export.standsAlone = ["decimal"];
    });
    const reordered = manifest((m) => {
      const { text, integer, numeric, boolean, timestamp, binary } = vocabularyOf(m).bareTypeFamily;
      vocabularyOf(m).bareTypeFamily = { binary: [...binary, "varchar"], timestamp, boolean, numeric, integer, text };
    });
    const timestamp = vocabularyOf(manifest()).bareTypeFamily.timestamp.length;
    const binary = vocabularyOf(manifest()).bareTypeFamily.binary.length;

    expect(refusalsFor(families)).toEqual([
      refusal("type-name-duplicate", `${VOCABULARY}/bareTypeFamily/binary/${binary}`),
      refusal("type-name-duplicate", `${VOCABULARY}/bareTypeFamily/boolean/0`),
      refusal("type-name-duplicate", `${VOCABULARY}/bareTypeFamily/timestamp/${timestamp}`),
    ]);
    expect(refusalsFor(spellings)).toEqual([
      refusal("type-name-duplicate", `${SQL_WRITING}/export/bareSpelling/2/name`),
    ]);
    expect(refusalsFor(apart)).toEqual([]);
    // The kinds are read in the schema's order, so the name under binary is the later even where binary is written first.
    expect(refusalsFor(reordered)).toEqual([
      refusal("type-name-duplicate", `${VOCABULARY}/bareTypeFamily/binary/${binary}`),
    ]);
  });

  test("a character range whose minimum exceeds its maximum is refused as char-range-inverted", () => {
    const inverted = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("user", { charRange: { min: 9, max: 3, sentence: "s" } })]),
    );
    const single = manifest(
      (m) => (connectionOf(m).fieldRules = [fieldRule("user", { charRange: { min: 3, max: 3, sentence: "s" } })]),
    );

    expect(refusalsFor(inverted)).toEqual([
      refusal("char-range-inverted", "/engines/0/connection/fieldRules/0/charRange"),
    ]);
    expect(refusalsFor(single)).toEqual([]);
  });

  test("a host reader on an engine without a host field is refused as host-reader-without-host", () => {
    const changed = manifest((m) => {
      connectionOf(m).fields = ["user", "password", "database"];
      connectionOf(m).hostHint = "hostHint";
      connectionOf(m).hostIdentity = "hostIdentity";
    });
    const withHost = manifest((m) => {
      connectionOf(m).hostHint = "hostHint";
      connectionOf(m).hostIdentity = "hostIdentity";
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("host-reader-without-host", "/engines/0/connection/hostHint"),
      refusal("host-reader-without-host", "/engines/0/connection/hostIdentity"),
    ]);
    expect(refusalsFor(withHost)).toEqual([]);
  });

  test("a scheme on an engine whose connection string names no paste reader is refused as scheme-without-paste", () => {
    const changed = manifest((m) => (connectionStringOf(m).scheme = "kafka"));
    const withPaste = manifest((m) => Object.assign(connectionStringOf(m), { scheme: "kafka", paste: paste() }));

    expect(refusalsFor(changed)).toEqual([
      refusal("scheme-without-paste", "/engines/0/connection/connectionString/scheme"),
    ]);
    expect(refusalsFor(withPaste)).toEqual([]);
  });

  test("a URL TLS reader on an engine whose connection string names no paste reader is refused as url-tls-without-paste", () => {
    const changed = manifest((m) => (connectionStringOf(m).urlTls = "urlTls"));
    const withPaste = manifest((m) => Object.assign(connectionStringOf(m), { urlTls: "urlTls", paste: paste() }));

    expect(refusalsFor(changed)).toEqual([
      refusal("url-tls-without-paste", "/engines/0/connection/connectionString/urlTls"),
    ]);
    expect(refusalsFor(withPaste)).toEqual([]);
  });

  /** The fixture with a second engine, `otherdb`, and its compatibility entry. */
  const withSecond = (m: Json) => {
    m.engines.push(second(m));
    m.compatibility.push({ ...structuredClone(m.compatibility[0]), engine: "otherdb" });
  };

  test("a fence alias equal to an engine id of the manifest is refused as fence-alias-engine-id", () => {
    const own = kafkaManifest();
    own.engines[0].editor.fenceAliases = ["kafkaread", "kafka"];
    const earlier = manifest((m) => {
      withSecond(m);
      m.engines[1].editor.fenceAliases = ["exampledb"];
    });
    const later = manifest((m) => {
      withSecond(m);
      m.engines[0].editor.fenceAliases = ["otherdb"];
    });

    expect(refusalsFor(own)).toEqual([refusal("fence-alias-engine-id", "/engines/0/editor/fenceAliases/1")]);
    expect(validator.validateEngine(own.engines[0])).toEqual({
      admitted: false,
      refusals: [refusal("fence-alias-engine-id", "/editor/fenceAliases/1")],
    });
    expect(refusalsFor(earlier)).toEqual([refusal("fence-alias-engine-id", "/engines/1/editor/fenceAliases/0")]);
    expect(refusalsFor(later)).toEqual([refusal("fence-alias-engine-id", "/engines/0/editor/fenceAliases/0")]);
    expect(validator.validateEngine(later.engines[0]).admitted).toBe(true);
  });

  test("a fence alias an earlier engine declares is refused as fence-alias-duplicate at the later", () => {
    const changed = manifest((m) => {
      withSecond(m);
      m.engines[0].editor.fenceAliases = ["exampleql"];
      m.engines[1].editor.fenceAliases = ["otherql", "exampleql"];
    });
    const distinct = manifest((m) => {
      withSecond(m);
      m.engines[0].editor.fenceAliases = ["exampleql"];
      m.engines[1].editor.fenceAliases = ["otherql"];
    });

    expect(refusalsFor(changed)).toEqual([refusal("fence-alias-duplicate", "/engines/1/editor/fenceAliases/1")]);
    expect(validator.validateEngine(changed.engines[1]).admitted).toBe(true);
    expect(refusalsFor(distinct)).toEqual([]);
  });

  test("a generic fence tag declared as an alias is refused as fence-alias-generic", () => {
    for (const tag of ["sql", "cql"]) {
      const changed = manifest((m) => (editorOf(m).fenceAliases = ["exampleql", tag]));

      expect(refusalsFor(changed)).toEqual([refusal("fence-alias-generic", "/engines/0/editor/fenceAliases/1")]);
      expect(validator.validateEngine(changed.engines[0])).toEqual({
        admitted: false,
        refusals: [refusal("fence-alias-generic", "/editor/fenceAliases/1")],
      });
    }
  });

  test("a sign-in shaped like Snowflake's is admitted", () => {
    expect(refusalsFor(manifest(signInShaped))).toEqual([]);
  });

  test("the rules run only on a manifest the schema admits", () => {
    const changed = manifest((m) => {
      m.engines.push(structuredClone(m.engines[0]));
      m.engines[1].location = "remote";
    });

    expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", "/engines/1/location")]);
  });
});

describe("the calls segment", () => {
  test("a manifest without its calls is refused as missing-key", () => {
    expect(refusalsFor(manifest((m) => delete m.calls))).toEqual([refusal("missing-key", "", "calls")]);
    expect(refusalsFor(manifest((m) => delete m.calls.console.cancel))).toEqual([
      refusal("missing-key", "/calls/console", "cancel"),
    ]);
    expect(refusalsFor(manifest((m) => delete m.calls.console.execute.honours))).toEqual([
      refusal("missing-key", "/calls/console/execute", "honours"),
    ]);
  });

  test("a request field execute does not know, or one listed twice, is refused", () => {
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["params", "params"])))).toEqual([
      refusal("duplicate", "/calls/console/execute/honours/1"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["rows"])))).toEqual([
      refusal("value-not-allowed", "/calls/console/execute/honours/0"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["params", "offset"])))).toEqual([]);
  });

  test("a console facet offer outside the vocabulary, or a key the calls segment does not define, is refused", () => {
    expect(refusalsFor(manifest((m) => (m.calls.console.cancel = "maybe")))).toEqual([
      refusal("value-not-allowed", "/calls/console/cancel"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.objects = {})))).toEqual([refusal("unknown-key", "/calls", "objects")]);
    expect(refusalsFor(manifest((m) => (m.calls.console.explain = "offered")))).toEqual([
      refusal("unknown-key", "/calls/console", "explain"),
    ]);
  });
});

describe("proxy variables", () => {
  const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
  const purpose = `purpose-${randomUUID()}`;
  const declared = (name: string) => ({ name, purpose });

  test("a proxy variable declared in runtime.env is refused as env-proxy-variable", () => {
    for (const name of PROXY_VARIABLES) {
      const changed = manifest((m) => (m.runtime.env = [declared("EXAMPLEDB_HOME"), declared(name)]));

      const refusals = refusalsFor(changed);

      expect(refusals).toEqual([refusal("env-proxy-variable", "/runtime/env/1/name")]);
      expect(JSON.stringify(refusals)).not.toContain(purpose);
      expect(refusalSentence(refusals[0] as ManifestRefusal)).not.toContain(name);
    }
    expect(refusalsFor(manifest((m) => (m.runtime.env = [declared("EXAMPLEDB_PROXY_HOME")])))).toEqual([]);
  });

  test("a lower-case proxy variable is refused by the name pattern", () => {
    for (const name of PROXY_VARIABLES.map((item) => item.toLowerCase())) {
      const changed = manifest((m) => (m.runtime.env = [declared(name)]));

      expect(refusalsFor(changed)).toEqual([refusal("pattern-mismatch", "/runtime/env/0/name")]);
    }
  });
});

describe("the contract a manifest was built against", () => {
  test("a manifest built against another contract is refused as PROVIDER_CONTRACT_UNSUPPORTED without schema refusals", () => {
    const changed = manifest((m) => {
      m.contract = "0.2";
      m.engines = "not a list";
      m.bogus = true;
    });

    expect(validator.validate(changed)).toEqual({
      admitted: false,
      refusals: [{ code: "PROVIDER_CONTRACT_UNSUPPORTED", contract: "0.2" }],
    });
  });

  test("the envelope is read first: a missing contract is the only refusal", () => {
    const changed = manifest((m) => {
      delete m.contract;
      m.bogus = true;
    });

    expect(refusalsFor(changed)).toEqual([refusal("missing-key", "", "contract")]);
  });
});

describe("one engine declaration", () => {
  const engine = () => manifest().engines[0] as Json;

  test("an engine declaration is admitted on its own", () => {
    const declaration = engine();

    expect<unknown>(validator.validateEngine(declaration)).toEqual({ admitted: true, engine: declaration });
  });

  test("an engine declaration's refusals point into the declaration", () => {
    const declaration = { ...engine(), bogus: 1 };

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [refusal("unknown-key", "", "bogus")],
    });
  });

  test("an engine declaration is held to the rules of its own connection", () => {
    const declaration = engine();
    declaration.connection.refused = [{ field: "password", refusal: randomUUID() }];

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [refusal("refused-field-declared", "/connection/refused/0")],
    });
  });
  test("an engine declaration's field rules and host readers are held to the rules the schema cannot state, at pointers into it", () => {
    const declaration = engine();
    declaration.connection.fields = ["user", "password", "database"];
    declaration.connection.fieldRules = [
      fieldRule("user", { format: format("^(a"), charRange: { min: 2, max: 1, sentence: "s" } }),
      fieldRule("user", { required: "r" }),
      fieldRule("warehouse"),
    ];
    declaration.connection.hostIdentity = "hostIdentity";

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("char-range-inverted", "/connection/fieldRules/0/charRange"),
        refusal("pattern-invalid", "/connection/fieldRules/0/format/pattern/source"),
        refusal("field-rule-duplicate", "/connection/fieldRules/1/field"),
        refusal("field-rule-empty", "/connection/fieldRules/2"),
        refusal("field-undeclared", "/connection/fieldRules/2/field"),
        refusal("host-reader-without-host", "/connection/hostIdentity"),
      ],
    });
  });

  test("an engine declaration's connection string is held to the rules the schema cannot state, at pointers into it", () => {
    const declaration = engine();
    Object.assign(declaration.connection.connectionString, { scheme: "exampledb", urlTls: "urlTls" });

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("scheme-without-paste", "/connection/connectionString/scheme"),
        refusal("url-tls-without-paste", "/connection/connectionString/urlTls"),
      ],
    });
  });

  test("an engine declaration's fence aliases are held to the rules the schema cannot state, at pointers into it", () => {
    const declaration = engine();
    declaration.editor.fenceAliases = ["exampledb", "sql", "exampleql"];

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("fence-alias-engine-id", "/editor/fenceAliases/0"),
        refusal("fence-alias-generic", "/editor/fenceAliases/1"),
      ],
    });
  });

  test("an engine declaration's trailing limit clauses are held to the rules the schema cannot state, at pointers into it", () => {
    const declaration = engine();
    declaration.sqlText.grammar.trailingLimitClauses = [clause("(LIMIT"), clause("LIMIT"), clause("[")];

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("pattern-invalid", "/sqlText/grammar/trailingLimitClauses/0/source"),
        refusal("pattern-invalid", "/sqlText/grammar/trailingLimitClauses/2/source"),
      ],
    });
  });

  test("an engine declaration's SQL writing facts are held to the rules the schema cannot state, at pointers into it", () => {
    const declaration = engine();
    const writing = declaration.sqlWriting;
    writing.export.typeVocabulary.floatType = typePattern("^(x$", "i");
    writing.export.typeVocabulary.numericWrapper = typePattern("^x$");
    writing.export.typeVocabulary.bareTypeFamily.integer.push("money");
    writing.export.bareSpelling = [
      { name: "bit", spelling: "bit(64)" },
      { name: "bit", spelling: "bit(1)" },
    ];

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("type-name-duplicate", "/sqlWriting/export/bareSpelling/1/name"),
        // money is the numeric family's last name, and integer comes before numeric in the schema's kind order.
        refusal("type-name-duplicate", "/sqlWriting/export/typeVocabulary/bareTypeFamily/numeric/5"),
        refusal("pattern-invalid", "/sqlWriting/export/typeVocabulary/floatType/source"),
        refusal("wrapper-group-count", "/sqlWriting/export/typeVocabulary/numericWrapper/source"),
      ],
    });
  });

  test("an engine declaration's migration DDL is refused at its own pointer under validateEngine", () => {
    const declaration = kafkaManifest().engines[0] as Json;
    declaration.migrationDdl.refusal = "Apache Kafka: Cannot generate table DDL.";

    expect(validator.validateEngine(kafkaManifest().engines[0])).toEqual({
      admitted: true,
      engine: kafkaManifest().engines[0],
    });
    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [refusal("no-variant", "/migrationDdl")],
    });
  });

  test("an engine declaration's editor language is refused at its own pointer under validateEngine", () => {
    const declaration = kafkaManifest().engines[0] as Json;
    declaration.editor.language.accent = "border-hue-amber/40";

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [refusal("pattern-mismatch", "/editor/language/accent")],
    });
  });

  test("an engine declaration's SQL generators are refused at their own pointer under validateEngine", () => {
    const declaration = kafkaManifest().engines[0] as Json;
    declaration.sqlGenerators = { ...namedSqlGenerators("COUNT(1)"), table: null };

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [refusal("pattern-mismatch", "/sqlGenerators/countExpression")],
    });
    declaration.sqlGenerators.countExpression = "COUNT(*)";
    expect<unknown>(validator.validateEngine(declaration)).toEqual({ admitted: true, engine: declaration });
  });

  test("an engine declaration's dialog is held to the rules the schema cannot state, at pointers into it", () => {
    const declaration = engine();
    declaration.connection.fields.push("serviceName");
    declaration.connection.dialog.hints = [{ field: "warehouse", text: "w" }];

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("field-undeclared", "/connection/dialog/hints/0/field"),
        refusal("placement-missing", "/connection/fields/5"),
      ],
    });
  });
});

describe("refusals carry no value", () => {
  /** Every string value replaced by `planted`, keys kept, so every pattern and vocabulary check fails on it. */
  function plant(value: unknown, planted: string): unknown {
    if (typeof value === "string") return planted;
    if (Array.isArray(value)) return value.map((item) => plant(item, planted));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plant(item, planted)]));
    }
    return value;
  }

  test("no refusal carries a value of the manifest", () => {
    const planted = `planted-${randomUUID()}`;
    const changed = plant(
      manifest((m) => {
        signInShaped(m);
        connectionOf(m).dialog.labels = [{ field: "user", text: "Login" }];
        connectionOf(m).dialog.hints = [{ field: "user", text: "The login name." }];
        connectionOf(m).dialog.placeholders = [{ field: "user", text: "admin" }];
        connectionOf(m).credentialWarnings = [{ kind: "no-secret", message: "Set a password." }];
        connectionOf(m).fieldRules = [
          fieldRule("host", {
            required: "Host is required.",
            format: { pattern: { source: "^[a-z]+$", flags: "u" }, sentence: "Host must be letters." },
            charRange: { min: 1, max: 9, sentence: "Host is too long." },
            check: "hostCheck",
          }),
        ];
        connectionOf(m).hostHint = "hostHint";
        connectionOf(m).hostIdentity = "hostIdentity";
        connectionOf(m).import = { label: "Import kubeconfig", importer: "importer" };
        connectionOf(m).refused = [{ field: "region", refusal: "Region is refused." }];
        Object.assign(connectionStringOf(m), {
          scheme: "exampledb",
          urlTls: "urlTls",
          paste: { reader: "pasteReader", catchAll: true, formats: ["exampledb://"] },
          seedCheck: "seedCheck",
        });
        m.engines[0].editor = {
          commitKeyword: "EXEC",
          consentDeadline: { chip: "Killed at its timeout", sentence: "The read ends at the timeout." },
          fenceAliases: ["exampleql", "sql"],
          explainFormat: "postgres-json",
          dialect: dialect(["--token"]),
        };
        everyGrammarFact(m);
        sqlTextOf(m).redaction = { kind: "sql", nameQuote: "`" };
        sqlTextOf(m).updateTarget.extraSetOperators = ["MINUS"];
        sqlTextOf(m).completion = { formatSegment: "formatSegment", readQuotedQualifier: "readQuotedQualifier" };
        everySqlWritingHook(m);
      }),
      planted,
    ) as Json;
    changed.contract = "0.1";
    changed.engines[0].connection.defaults.port = planted;
    changed.engines[0].connection.seedOnly = plant(SEED_ONLY, planted);
    changed.runtime.env = [{ name: "HTTPS_PROXY", purpose: planted }];

    const refusals = refusalsFor(changed);
    const engineVerdict = validator.validateEngine(changed.engines[0]);

    expect(refusals.length).toBeGreaterThan(10);
    expect(engineVerdict.admitted).toBe(false);
    expect(JSON.stringify(refusals)).not.toContain(planted);
    expect(JSON.stringify(engineVerdict)).not.toContain(planted);
    for (const item of refusals) expect(refusalSentence(item)).not.toContain(planted);
  });

  test("no SQL writing rule refusal carries the pattern or the type name it refuses", () => {
    const name = `t${randomUUID().replaceAll("-", "")}`;
    const invalid = `^(${randomUUID()}$`;
    const ungrouped = `^${randomUUID()}$`;
    const changed = manifest((m) => {
      vocabularyOf(m).floatType = typePattern(invalid, "i");
      vocabularyOf(m).numericWrapper = typePattern(ungrouped);
      vocabularyOf(m).bareTypeFamily.text.push(name);
      vocabularyOf(m).bareTypeFamily.binary.push(name);
      sqlWritingOf(m).export.bareSpelling = [
        { name, spelling: "bit(64)" },
        { name, spelling: "bit(1)" },
      ];
    });

    const refusals = refusalsFor(changed);

    expect(refusals.map((item) => (item as SchemaRefusal).rule)).toEqual([
      "type-name-duplicate",
      "type-name-duplicate",
      "pattern-invalid",
      "wrapper-group-count",
    ]);
    for (const item of refusals) {
      for (const value of [name, invalid, ungrouped]) {
        expect(JSON.stringify(item)).not.toContain(value);
        expect(refusalSentence(item)).not.toContain(value);
      }
    }
  });

  test("no fence alias refusal carries the alias it refuses", () => {
    const tag = `q${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const keyword = `K${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const changed = manifest((m) => {
      m.engines.push({ ...structuredClone(m.engines[0]), id: tag });
      m.compatibility.push({ ...structuredClone(m.compatibility[0]), engine: tag });
      m.engines[0].editor.commitKeyword = keyword;
      m.engines[0].editor.fenceAliases = [tag, "sql"];
      m.engines[1].editor.fenceAliases = [tag];
    });

    const refusals = refusalsFor(changed);

    expect(refusals).toEqual([
      refusal("fence-alias-engine-id", "/engines/0/editor/fenceAliases/0"),
      refusal("fence-alias-generic", "/engines/0/editor/fenceAliases/1"),
      refusal("fence-alias-duplicate", "/engines/1/editor/fenceAliases/0"),
      refusal("fence-alias-engine-id", "/engines/1/editor/fenceAliases/0"),
    ]);
    for (const item of refusals) {
      expect(JSON.stringify(item)).not.toContain(tag);
      expect(refusalSentence(item)).not.toContain(tag);
      expect(refusalSentence(item)).not.toContain(keyword);
    }
  });
});

describe("refusalSentence", () => {
  test("words each rule in one sentence naming the pointer, and the key where there is one", () => {
    for (const rule of SCHEMA_REFUSAL_RULES) {
      const sentence = refusalSentence(refusal(rule, "/engines/0/connection", "refused"));

      expect(sentence).toMatch(/^[A-Z][^]*\.$/);
      expect(sentence).not.toMatch(/\. [A-Z]/);
      expect(sentence).toContain("/engines/0/connection");
      if (rule === "unknown-key" || rule === "missing-key") expect(sentence).toContain('"refused"');
    }
  });

  test("names the top level for an empty pointer", () => {
    expect(refusalSentence(refusal("unknown-key", "", "bogus"))).toBe(
      'The manifest has the key "bogus" at the top level, which the provider contract does not define there.',
    );
  });

  test("quotes an unknown key as a JSON string, so a key with a line break stays on one line", () => {
    expect(refusalSentence(refusal("unknown-key", "", "a\nb"))).toBe(
      'The manifest has the key "a\\nb" at the top level, which the provider contract does not define there.',
    );
    expect(refusalSentence(refusal("missing-key", "/engines/0", 'say "hi"'))).toBe(
      'The manifest lacks the key "say \\"hi\\"" at /engines/0, which the provider contract requires there.',
    );
  });

  test("names the contract a manifest declares that the host does not serve", () => {
    expect(refusalSentence({ code: "PROVIDER_CONTRACT_UNSUPPORTED", contract: "0.2" })).toBe(
      "The manifest was built against provider contract 0.2, which this SDK does not serve.",
    );
  });
});

describe("errorsOf", () => {
  test("raises when a validation failed without reporting why, rather than answer no refusal", () => {
    const silent = Object.assign(() => false, { errors: null }) as unknown as Parameters<typeof errorsOf>[0];

    expect(() => errorsOf(silent)).toThrow("The manifest validator failed a value without reporting why.");
  });
});

describe("how ajv's errors become refusals", () => {
  const error = (keyword: string, instancePath: string, params: Record<string, unknown> = {}) => ({
    keyword,
    instancePath,
    schemaPath: `#/${keyword}`,
    params,
  });

  test("a keyword no rule maps is thrown by name rather than dropped", () => {
    expect(() => refusalsOf([error("multipleOf", "/x")])).toThrow('"multipleOf"');
  });

  test("nested failed variants at one pointer give one no-variant refusal and drop every error under it", () => {
    const refusals = refusalsOf([
      error("required", "/a", { missingProperty: "b" }),
      error("pattern", "/a/c"),
      error("oneOf", "/a"),
      error("oneOf", "/a"),
      error("oneOf", "/a/d"),
      error("type", "/ab"),
    ]);

    expect(refusals).toEqual([refusal("no-variant", "/a"), refusal("wrong-type", "/ab")]);
  });

  test("a repeated item is refused at the later of the two indices ajv names, in either order", () => {
    expect(refusalsOf([error("uniqueItems", "/a", { i: 0, j: 2 })])).toEqual([refusal("duplicate", "/a/2")]);
    expect(refusalsOf([error("uniqueItems", "/b", { i: 3, j: 1 })])).toEqual([refusal("duplicate", "/b/3")]);
  });
});
