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
  AGENT_TEXT_FILLS,
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

/** The policy claims of the fixture's one engine. */
const policyOf = (m: Json): Json => m.engines[0].policy;

/** The pointer of the fixture's one engine's policy claims. */
const POLICY = "/engines/0/policy";

/** The MCP claims of the fixture's one engine. */
const mcpOf = (m: Json): Json => m.engines[0].mcp;

/** The pointer of the fixture's one engine's MCP claims. */
const MCP = "/engines/0/mcp";

/** The safeguards of the fixture's one engine. */
const safeguardsOf = (m: Json): Json => m.engines[0].safeguards;

/** The write paths of the fixture's one engine. */
const writePathsOf = (m: Json): Json => m.engines[0].safeguards.writePaths;

/** The pointer of the fixture's one engine's safeguards. */
const SAFEGUARDS = "/engines/0/safeguards";

/** The pointer of the fixture's one engine's write paths. */
const WRITE_PATHS = `${SAFEGUARDS}/writePaths`;

/** The pointer of the fixture's one engine's metadata-only answer. */
const METADATA_ONLY = `${SAFEGUARDS}/metadataOnly`;

/** A module and an export that keep a write path's answer, as a package names them. */
const WRITE_PROOF = { module: "src/exampledb/read-policy.ts", symbol: "EXAMPLEDB_READS" };

/** The four write paths, each with the reach `reach` gives it. */
function writePaths(reach: (path: string) => Json): Json {
  return Object.fromEntries(["editor", "objectEdit", "maintenance", "transaction"].map((path) => [path, reach(path)]));
}

/** Every write path open, the paths the write reach `open` is the summary of. */
const openPaths = (): Json => writePaths(() => ({ reach: "open" }));

/** Every write path absent, the editor naming its proof: the paths the write reach `none` is the summary of. */
const absentPaths = (): Json =>
  writePaths((path) => ({ reach: "absent", proof: path === "editor" ? { ...WRITE_PROOF } : null }));

/** The editor path gated and the others absent: the paths the write reach `guarded` is the summary of. */
const guardedPaths = (): Json => ({ ...absentPaths(), editor: { reach: "gated", gate: { ...WRITE_PROOF } } });

/** A metadata-only operation named `operation` whose columns are `columns`, each a name. */
function metadataOperation(operation: string, columns: readonly string[] = ["name"]): Json {
  return { operation, columns: columns.map((column) => ({ column, kind: "name" })) };
}

/** A masking exemption whose column pattern is `column`. */
function maskingExemption(column: string): Json {
  return { column, reason: "The address is a register number, not a stored value." };
}

/** An inline edit refusal whose type pattern is `type`. */
function inlineEditRefusal(type: string): Json {
  return { type, reason: "Large object columns are refused, since a cell shows only part of one." };
}

/** The facets of the fixture's one engine. */
const facetsOf = (m: Json): Json => m.engines[0].facets;

/** The maintenance specs of the fixture's one engine. */
const maintenanceSpecsOf = (m: Json): Json[] => m.engines[0].facets.maintenanceSpecs;

/** The pointer of the fixture's one engine's maintenance specs. */
const MAINTENANCE_SPECS = "/engines/0/facets/maintenanceSpecs";

/** A maintenance spec for `operation`, labelled `label` and placed as stated, with every optional member at its absence. */
function maintenanceSpec(operation: string, label: string, perEntity: boolean, global: boolean, rest: Json = {}): Json {
  return {
    operation,
    label,
    perEntity,
    global,
    title: null,
    description: null,
    confirmation: null,
    preview: false,
    kinds: null,
    ...rest,
  };
}

/**
 * The fixture's one engine offering five maintenance operations, each with a spec of one shipped shape, in the list's
 * order: both placements (vacuum), the whole database only (check), one row only with its kinds, a typed target, a
 * description and a preview (release), a whole-database card with its title, description and typed confirmation
 * (compact), and placed nowhere (kill).
 */
function withMaintenance(m: Json): void {
  facetsOf(m).maintenance = ["vacuum", "check", "release", "compact", "kill"];
  facetsOf(m).maintenanceSpecs = [
    maintenanceSpec("vacuum", "Vacuum", true, true),
    maintenanceSpec("check", "Check Database", false, true),
    maintenanceSpec("release", "Release", true, false, {
      description: "Releases the collection from memory, so a search on it fails until it is loaded again.",
      confirmation: "typed-target",
      preview: true,
      kinds: ["collection", "materialized_query_table", "file-format"],
    }),
    maintenanceSpec("compact", "Compact", false, true, {
      title: "Compact Revisions",
      description: "Discards every revision older than the current one.",
      confirmation: "typed",
    }),
    maintenanceSpec("kill", "Kill", false, false),
  ];
}

/** A refusal sentence a test states as an engine's denied file access refusal. */
const DENIED_FILE_ACCESS_REFUSAL =
  "Kafka connections require an administrator because this client cannot confine file access.";

/**
 * Every claim of the fixture's one engine at its restrictive value, the value under which every gate that reads the
 * claim refuses, withholds or keeps apart the most, with the seeds declaring read roots so the rules hold on an engine
 * that has an agent credential form, as Kafka's has, and every write path open, the paths the write reach `open` is the
 * summary of.
 */
function restrictiveClaims(m: Json): void {
  Object.assign(policyOf(m), {
    writeReach: "open",
    readsFileAccessPosture: true,
    deniedFileAccessRefusal: DENIED_FILE_ACCESS_REFUSAL,
    singleWriterFile: false,
    readRootsRequired: true,
    agentCredentialForm: "none",
    maskingExemptColumns: null,
  });
  safeguardsOf(m).writePaths = openPaths();
  Object.assign(mcpOf(m), {
    exposable: false,
    statementRead: false,
    metadataReadChangesState: true,
    agentCredentialRequired: true,
  });
  connectionOf(m).seedOnly = {
    fields: ["agentReadRoots"],
    scope: "each",
    refusal: "{field} is Kafka only.",
    projectionRefusal: null,
  };
}

/** The agent segment of the fixture's one engine. */
const agentOf = (m: Json): Json => m.engines[0].agent;

/** The SQL dialect of the fixture's one engine's agent overlay. */
const sqlDialectOf = (m: Json): Json => m.engines[0].agent.overlay.dialect;

/** The pointer of the fixture's one engine's agent overlay. */
const OVERLAY = "/engines/0/agent/overlay";

/** The pointer of the fixture's one engine's SQL dialect. */
const DIALECT = `${OVERLAY}/dialect`;

/** The pointer of the fixture's one engine's statement language data. */
const LANGUAGE_DATA = "/engines/0/statementLanguageData";

/** The pointer of the confirmation part of the fixture's one engine's statement language data. */
const CONFIRMATION = `${LANGUAGE_DATA}/confirmation`;

/**
 * Statement language data named `name` whose confirmation is a request language that names no operation, decides
 * alone, stays out of the safety analysis and bounds no statement.
 */
function languageData(name: string): Json {
  return {
    name,
    confirmation: {
      operations: [],
      reader: "names-no-operation",
      decidesAlone: true,
      safetyAnalysis: false,
      maxTextBytes: null,
    },
    agent: null,
  };
}

/** The confirmation part of the fixture's one engine's statement language data. */
const confirmationOf = (m: Json): Json => m.engines[0].statementLanguageData.confirmation;

/** The pointer of the request form of the fixture's one engine's statement language data. */
const REQUEST = `${LANGUAGE_DATA}/agent/request`;

/** A refusal of a request form, its code `code` and a sentence naming it. */
const requestRefusal = (code: string): Json => ({ code, sentence: `The request is refused as ${code}.` });

/**
 * A request form in every shape the vocabulary has: a selector naming two reads, a common integer check with a default,
 * a read refusing a key, a required name with its refused names and prefixes, an optional name, an enumeration and an
 * optional integer, so every key of every read is ruled exactly once.
 */
function requestForm(): Json {
  return {
    kind: "json-object",
    maxCharacters: 4096,
    refusals: {
      tooLong: requestRefusal("too-long"),
      empty: requestRefusal("empty"),
      notAnObject: requestRefusal("not-an-object"),
      repeatedKey: requestRefusal("repeated-key"),
      unknownKey: requestRefusal("unknown-key"),
    },
    keys: ["read", "topic", "after", "limit", "mode"],
    selector: { key: "read", refusal: requestRefusal("not-a-read") },
    common: [
      {
        key: "limit",
        absent: null,
        rule: { kind: "integer", minimum: 1, maximum: 500, default: 50, refusal: requestRefusal("limit") },
      },
    ],
    reads: [
      {
        value: "topics",
        refuses: [{ key: "topic", refusal: requestRefusal("topic-not-taken") }],
        checks: [
          {
            key: "after",
            absent: null,
            rule: {
              kind: "name",
              characters: [
                { from: "a", to: "z" },
                { from: ".", to: "." },
              ],
              minLength: 1,
              maxLength: 249,
              refused: [{ names: [".", ".."], prefixes: [], refusal: requestRefusal("cursor") }],
              refusal: requestRefusal("cursor"),
            },
          },
          {
            key: "mode",
            absent: null,
            rule: { kind: "enumeration", values: ["fast", "slow"], refusal: requestRefusal("mode") },
          },
        ],
      },
      {
        value: "offsets",
        refuses: [{ key: "mode", refusal: requestRefusal("mode-not-taken") }],
        checks: [
          {
            key: "topic",
            absent: requestRefusal("topic-required"),
            rule: {
              kind: "name",
              characters: [
                { from: "a", to: "z" },
                { from: "_", to: "_" },
                { from: "-", to: "-" },
              ],
              minLength: 1,
              maxLength: 249,
              refused: [
                { names: ["internal"], prefixes: [], refusal: requestRefusal("internal") },
                { names: [], prefixes: ["_", "connect-"], refusal: requestRefusal("withheld") },
              ],
              refusal: requestRefusal("topic"),
            },
          },
          {
            key: "after",
            absent: null,
            rule: {
              kind: "integer",
              minimum: 0,
              maximum: 2147483647,
              default: null,
              refusal: requestRefusal("cursor"),
            },
          },
        ],
      },
    ],
  };
}

/** The pointer of the text of the fixture's one engine's statement language data. */
const TEXT = `${LANGUAGE_DATA}/agent/text`;

/**
 * An agent text in both shapes a text takes: plain strings, and each text Studio fills a value into written as parts,
 * every part naming a fill its text takes.
 */
function agentText(): Json {
  return {
    copy: {
      subject: "an Acme cluster",
      noun: "read request",
      writes: "every write and every read of a record",
      reached: "the broker",
      defect: "your read request",
    },
    investigation: {
      classifierDescription: "a question about the cluster's topics that is answered from what the run establishes",
      objective: "Your objective is a question about this cluster. Answer it from what you establish.",
      toolDescription: 'Run one bounded read, written as one JSON object such as {"read": "topics"}.',
      toolRule: 'Read the cluster with run_read_query, one JSON request at a time: {"read": "topics"}.',
    },
    posture: {
      qualifier: ["metadata only, ", { fill: "rows" }, " rows and ", { fill: "seconds" }, " s per read"],
      title: "Agent mode reads the cluster's topics",
      body: ["Each read is bounded to ", { fill: "rows" }, " rows and ", { fill: "seconds" }, " seconds."],
      handover: ["An answer is never run in your editor, however many of its ", { fill: "rows" }, " rows it holds."],
    },
    grounding: {
      omissionAdvice: 'Read any topic with run_read_query, for example {"read": "offsets", "topic": "orders"}.',
      ungrounded: ["So nothing about this cluster has been established for you: not one ", { fill: "noun" }, " name."],
    },
    advice: {
      rowCap: ["Ask for at most ", { fill: "allowed" }, ' rows: write "limit": ', { fill: "allowed" }, " or less."],
      shape: "The request's shape falls outside what a bounded read may be.",
    },
  };
}

/** The fixture's statement language data `acmeread`, whose agent part states the form and the text, changed by `change`. */
function agentManifest(change: (agent: Json) => void = () => {}): Json {
  const changed = kafkaManifest();
  agentOf(changed).statementLanguage = "acmeread";
  changed.engines[0].statementLanguageData = {
    ...languageData("acmeread"),
    agent: { request: requestForm(), text: agentText() },
  };
  change(changed.engines[0].statementLanguageData.agent);
  return changed;
}

/**
 * The Kafka fixture speaking `acmeread`, whose statement language data states the request form of `requestForm`,
 * changed by `change`, and the text of `agentText`.
 */
function requestManifest(change: (form: Json) => void = () => {}): Json {
  return agentManifest((agent) => change(agent.request));
}

/** The Kafka fixture speaking `acmeread`, whose statement language data states the text of `agentText`, changed by `change`. */
function textManifest(change: (text: Json) => void): Json {
  return agentManifest((agent) => change(agent.text));
}

/**
 * An SQL dialect in every shape a shipped engine gives one: a catalog read with a schema fold, a retry, the command
 * claim and a row mapper; a prefix estimating plan; a profile with an uncountable type pattern; statistics with a probe
 * and a note; and a capture with its kinds and kind words. Each function is named by the slot it fills.
 */
function sqlDialect(): Json {
  return {
    catalogRead: {
      compose: {
        columns: "catalogColumns",
        relations: "catalogRelations",
        indexes: "catalogIndexes",
        statistics: "catalogStatistics",
      },
      declaredSchema: "declaredSchema",
      retry: { matches: "retryMatches", rewrite: "retryRewrite" },
      commandShaped: true,
      mapRows: "mapRows",
    },
    planEstimate: { kind: "prefix", prefix: "EXPLAIN (FORMAT JSON)" },
    profileComposition: {
      shapeTests: { email: "emailShapeTest", digitRun: "digitRunShapeTest" },
      incomparableType: { source: "\\b(jsonb?|xml)\\b", flags: "i" },
      uncountableType: { source: "\\b(text|ntext|image)\\b", flags: "i" },
    },
    statistics: {
      probe: "SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'",
      build: "statisticsBuild",
      limitNote: "The engine keeps no column distribution.",
    },
    catalogCapture: {
      kinds: ["columns", "relations", "indexes"],
      build: "captureBuild",
      kindWords: [
        { word: "r", kind: "table" },
        { word: "v", kind: "view" },
        { word: "S", kind: "sequence" },
      ],
    },
  };
}

/** The fixture's one engine as an SQL engine whose overlay gives `sqlDialect()` and a grounding override. */
function withSqlDialect(m: Json): void {
  agentOf(m).statementLanguage = "sql";
  agentOf(m).overlay = { dialect: sqlDialect(), grounding: "groundingOverride" };
}

/** The fixture's one engine as `withSqlDialect` makes it, then changed by `change`. */
const dialected = (change: (m: Json) => void) =>
  manifest((m) => {
    withSqlDialect(m);
    change(m);
  });

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
    ["policy", (m: Json) => delete m.engines[0].policy, "/engines/0", "policy"],
    ["mcp", (m: Json) => delete m.engines[0].mcp, "/engines/0", "mcp"],
    ["safeguards", (m: Json) => delete m.engines[0].safeguards, "/engines/0", "safeguards"],
    ...missingRows("policy", policyOf, POLICY, [
      "writeReach",
      "readsFileAccessPosture",
      "deniedFileAccessRefusal",
      "singleWriterFile",
      "readRootsRequired",
      "agentCredentialForm",
      "maskingExemptColumns",
    ]),
    ...missingRows("safeguards", safeguardsOf, SAFEGUARDS, ["writePaths", "metadataOnly", "inlineEditRefusedColumns"]),
    ...missingRows("safeguards.writePaths", writePathsOf, WRITE_PATHS, [
      "editor",
      "objectEdit",
      "maintenance",
      "transaction",
    ]),
    ...missingRows("mcp", mcpOf, MCP, [
      "exposable",
      "statementRead",
      "metadataReadChangesState",
      "agentCredentialRequired",
    ]),
    ...missingRows("connection", connectionOf, "/engines/0/connection", ["readsTrustMaterial"]),
    ...missingRows("facets", facetsOf, "/engines/0/facets", ["maintenanceSpecs"]),
    ...missingRows(
      "facets.maintenanceSpecs[0]",
      (m) => {
        withMaintenance(m);
        return maintenanceSpecsOf(m)[0] as Json;
      },
      `${MAINTENANCE_SPECS}/0`,
      ["operation", "label", "perEntity", "global", "title", "description", "confirmation", "preview", "kinds"],
    ),
    ["agent.overlay", (m: Json) => delete agentOf(m).overlay, "/engines/0/agent", "overlay"],
    ...missingRows(
      "agent.overlay",
      (m) => {
        withSqlDialect(m);
        return agentOf(m).overlay;
      },
      OVERLAY,
      ["dialect", "grounding"],
    ),
    ...missingRows(
      "agent.overlay.dialect",
      (m) => {
        withSqlDialect(m);
        return sqlDialectOf(m);
      },
      DIALECT,
      ["catalogRead", "planEstimate", "profileComposition", "statistics", "catalogCapture"],
    ),
    ...missingRows(
      "agent.overlay.dialect.catalogRead",
      (m) => {
        withSqlDialect(m);
        return sqlDialectOf(m).catalogRead;
      },
      `${DIALECT}/catalogRead`,
      ["compose", "declaredSchema", "retry", "commandShaped", "mapRows"],
    ),
    ...missingRows(
      "agent.overlay.dialect.catalogRead.compose",
      (m) => {
        withSqlDialect(m);
        return sqlDialectOf(m).catalogRead.compose;
      },
      `${DIALECT}/catalogRead/compose`,
      ["columns", "relations", "indexes", "statistics"],
    ),
    ...missingRows(
      "agent.overlay.dialect.catalogRead.retry",
      (m) => {
        withSqlDialect(m);
        return sqlDialectOf(m).catalogRead.retry;
      },
      `${DIALECT}/catalogRead/retry`,
      ["matches", "rewrite"],
    ),
    ...missingRows(
      "agent.overlay.dialect.profileComposition",
      (m) => {
        withSqlDialect(m);
        return sqlDialectOf(m).profileComposition;
      },
      `${DIALECT}/profileComposition`,
      ["shapeTests", "incomparableType", "uncountableType"],
    ),
    ...missingRows(
      "agent.overlay.dialect.profileComposition.shapeTests",
      (m) => {
        withSqlDialect(m);
        return sqlDialectOf(m).profileComposition.shapeTests;
      },
      `${DIALECT}/profileComposition/shapeTests`,
      ["email", "digitRun"],
    ),
    ...missingRows(
      "agent.overlay.dialect.profileComposition.incomparableType",
      (m) => {
        withSqlDialect(m);
        return sqlDialectOf(m).profileComposition.incomparableType;
      },
      `${DIALECT}/profileComposition/incomparableType`,
      ["source", "flags"],
    ),
    ...missingRows(
      "agent.overlay.dialect.statistics",
      (m) => {
        withSqlDialect(m);
        return sqlDialectOf(m).statistics;
      },
      `${DIALECT}/statistics`,
      ["probe", "build", "limitNote"],
    ),
    ...missingRows(
      "agent.overlay.dialect.catalogCapture",
      (m) => {
        withSqlDialect(m);
        return sqlDialectOf(m).catalogCapture;
      },
      `${DIALECT}/catalogCapture`,
      ["kinds", "build", "kindWords"],
    ),
    ...missingRows(
      "agent.overlay.dialect.catalogCapture.kindWords[0]",
      (m) => {
        withSqlDialect(m);
        return sqlDialectOf(m).catalogCapture.kindWords[0];
      },
      `${DIALECT}/catalogCapture/kindWords/0`,
      ["word", "kind"],
    ),
  ])("a missing %s is refused as missing-key", (_name, change, pointer, key) => {
    expect(refusalsFor(manifest(change))).toEqual([refusal("missing-key", pointer, key)]);
  });

  test.each([
    ["a location outside the vocabulary", (m: Json) => (m.engines[0].location = "remote"), "/engines/0/location"],
    [
      "a TLS mode outside the vocabulary",
      (m: Json) => (m.engines[0].connection.tls = { modes: ["disable", "prefer"] }),
      "/engines/0/connection/tls/modes/1",
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

  test.each([
    ["every mode", ["disable", "require", "verify-system", "verify-ca", "verify-full"]],
    ["the two verifying against Studio's trust store or the connection's CA", ["verify-system", "verify-full"]],
    ["one mode", ["disable"]],
    ["no mode", []],
  ])("TLS modes in the provider contract's order, %s, are admitted", (_name, modes) => {
    const changed = manifest((m) => (connectionOf(m).tls = { modes }));

    expect(refusalsFor(changed)).toEqual([]);
    expect(validator.validateEngine(changed.engines[0]).admitted).toBe(true);
  });

  test("a TLS mode outside the provider contract's modes is refused as value-not-allowed at its own pointer", () => {
    const changed = manifest((m) => (connectionOf(m).tls = { modes: ["disable", "prefer", "verify-full"] }));

    expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", "/engines/0/connection/tls/modes/1")]);
  });

  test("a TLS mode listed twice is refused as duplicate at the second", () => {
    const changed = manifest((m) => (connectionOf(m).tls = { modes: ["require", "require"] }));

    expect(refusalsFor(changed)).toEqual([refusal("duplicate", "/engines/0/connection/tls/modes/1")]);
  });

  test.each(["offered", "not-offered"])("a TLS offer stated as the word %s is refused as wrong-type", (word) => {
    const changed = manifest((m) => (connectionOf(m).tls = word));

    expect(refusalsFor(changed)).toEqual([refusal("wrong-type", "/engines/0/connection/tls")]);
  });

  test("a TLS offer with no modes member is refused as missing-key, and one with another member as unknown-key", () => {
    const empty = manifest((m) => (connectionOf(m).tls = {}));
    const extra = manifest((m) => (connectionOf(m).tls = { modes: [], extra: 1 }));

    expect(refusalsFor(empty)).toEqual([refusal("missing-key", "/engines/0/connection/tls", "modes")]);
    expect(refusalsFor(extra)).toEqual([refusal("unknown-key", "/engines/0/connection/tls", "extra")]);
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

  test("an explain format, a query dialect, a query language, a Monaco language or a formatter language of its form is admitted whatever it names", () => {
    for (const name of ["exampleql", "example-plan", "e", `e${"x".repeat(30)}`]) {
      const named = manifest((m) => {
        editorOf(m).explainFormat = name;
        editorOf(m).dialect = { ...dialect(), name: name.replace("-", "") };
        languageOf(m).queryLanguage = name.replace("-", "");
        languageOf(m).monacoId = name;
        grammarOf(m).formatterLanguage = name.replace("-", "");
      });

      expect(refusalsFor(named)).toEqual([]);
    }
    expect(refusalsFor(manifest((m) => (editorOf(m).explainFormat = null)))).toEqual([]);
  });

  test("an explain format, a query dialect, a query language, a Monaco language or a formatter language not of its form is refused as pattern-mismatch at its own pointer", () => {
    const cases: [(m: Json, name: string) => void, string, readonly string[]][] = [
      [
        (m, name) => (editorOf(m).explainFormat = name),
        "/engines/0/editor/explainFormat",
        ["Example", "-x", "example_plan", "x-", "a--b"],
      ],
      [
        (m, name) => (editorOf(m).dialect = { ...dialect(), name }),
        "/engines/0/editor/dialect/name",
        ["Example", "-x", "example-ql", "1x"],
      ],
      [
        (m, name) => (languageOf(m).queryLanguage = name),
        `${LANGUAGE}/queryLanguage`,
        ["Example", "-x", "example-ql", ""],
      ],
      [(m, name) => (languageOf(m).monacoId = name), `${LANGUAGE}/monacoId`, ["Example", "-x", "example_plan", "x-"]],
      [
        (m, name) => (grammarOf(m).formatterLanguage = name),
        `${SQL_TEXT}/grammar/formatterLanguage`,
        ["Example", "-x", "example_ql"],
      ],
    ];
    for (const [change, pointer, names] of cases) {
      for (const name of names) {
        expect(refusalsFor(manifest((m) => change(m, name)))).toEqual([refusal("pattern-mismatch", pointer)]);
      }
    }
    const long = `e${"x".repeat(32)}`;

    expect(refusalsFor(manifest((m) => (editorOf(m).explainFormat = long)))).toEqual([
      refusal("out-of-range", "/engines/0/editor/explainFormat"),
    ]);
    expect(refusalsFor(manifest((m) => (languageOf(m).monacoId = long)))).toEqual([
      refusal("out-of-range", `${LANGUAGE}/monacoId`),
    ]);
    expect(refusalsFor(manifest((m) => (languageOf(m).queryLanguage = long)))).toEqual([
      refusal("pattern-mismatch", `${LANGUAGE}/queryLanguage`),
    ]);
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

  test("a grammar rule or a script separator outside its vocabulary is refused", () => {
    const cases: [(m: Json) => void, string][] = [
      [(m) => (grammarOf(m).hash = "slash"), "/grammar/hash"],
      [(m) => (grammarOf(m).bracket = "array"), "/grammar/bracket"],
      [(m) => (grammarOf(m).blockComment = "nested"), "/grammar/blockComment"],
      [(m) => (grammarOf(m).script.blocks = "plpgsql"), "/grammar/script/blocks"],
      [(m) => (grammarOf(m).script.separatorLine = "go"), "/grammar/script/separatorLine"],
      [(m) => (grammarOf(m).script.unit = "script"), "/grammar/script/unit"],
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

  test("an engine declaration may state sqlText, sqlWriting and migrationDdl as null", () => {
    const members = ["sqlText", "sqlWriting", "migrationDdl"] as const;
    const stating = (nullMembers: readonly string[]) =>
      manifest((m) => {
        for (const member of nullMembers) m.engines[0][member] = null;
      });
    const all = stating(members);

    expect(refusalsFor(all)).toEqual([]);
    expect(validator.validateEngine(all.engines[0]).admitted).toBe(true);
    for (const member of members) {
      const alone = stating([member]);
      expect(refusalsFor(alone)).toEqual([]);
      expect(validator.validateEngine(alone.engines[0]).admitted).toBe(true);
    }
    expect(refusalsFor(manifest((m) => delete m.engines[0].sqlText))).toEqual([
      refusal("missing-key", "/engines/0", "sqlText"),
    ]);
    expect(refusalsFor(manifest((m) => (m.engines[0].sqlText = false)))).toEqual([refusal("wrong-type", SQL_TEXT)]);
    expect(refusalsFor(manifest((m) => (m.engines[0].sqlWriting = false)))).toEqual([
      refusal("wrong-type", SQL_WRITING),
    ]);
    expect(refusalsFor(manifest((m) => (m.engines[0].migrationDdl = false)))).toEqual([
      refusal("no-variant", MIGRATION_DDL),
    ]);
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

  test("a policy and an MCP segment at every claim's restrictive value are admitted", () => {
    const restrictive = kafkaManifest();
    restrictiveClaims(restrictive);

    expect(policyOf(manifest())).toEqual({
      writeReach: "open",
      readsFileAccessPosture: false,
      deniedFileAccessRefusal: null,
      singleWriterFile: false,
      readRootsRequired: false,
      agentCredentialForm: "pair",
      maskingExemptColumns: null,
    });
    expect(writePathsOf(manifest())).toEqual(openPaths());
    expect(mcpOf(manifest())).toEqual({
      exposable: false,
      statementRead: false,
      metadataReadChangesState: false,
      agentCredentialRequired: false,
    });
    expect(connectionOf(manifest()).readsTrustMaterial).toBe(false);
    expect(refusalsFor(manifest())).toEqual([]);
    expect(policyOf(kafkaManifest()).writeReach).toBe("none");
    expect(mcpOf(kafkaManifest())).toEqual({
      exposable: true,
      statementRead: true,
      metadataReadChangesState: false,
      agentCredentialRequired: false,
    });
    expect(refusalsFor(kafkaManifest())).toEqual([]);
    expect(policyOf(restrictive)).toMatchObject({ agentCredentialForm: "none", maskingExemptColumns: null });
    expect(refusalsFor(restrictive)).toEqual([]);
  });

  test("an engine whose connection, facets, agent and SQL text claims are at their restrictive values is admitted", () => {
    const restrictive = kafkaManifest();
    Object.assign(connectionOf(restrictive), {
      opensLocalFile: true,
      serverLevelWithoutDatabase: true,
      sshTunnel: { offered: false, refusal: "Kafka does not run through an SSH tunnel. Turn the tunnel off." },
      seedOnly: {
        fields: ["clientCertificatePath"],
        scope: "each",
        refusal: "{field} is Kafka only.",
        projectionRefusal: null,
      },
      hostPathFields: ["clientCertificatePath"],
      agentCredential: null,
    });
    restrictive.engines[0].agent.statementLanguage = null;
    restrictive.engines[0].agent.overlay = null;
    restrictive.engines[0].facets.agentReadings = [];
    sqlTextOf(restrictive).redaction = { kind: "none" };

    expect(refusalsFor(restrictive)).toEqual([]);
    expect(validator.validateEngine(restrictive.engines[0]).admitted).toBe(true);
  });

  test("a write reach outside the claim's values is refused as value-not-allowed", () => {
    for (const reach of ["partial", "OPEN"]) {
      const changed = manifest((m) => (policyOf(m).writeReach = reach));

      expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", `${POLICY}/writeReach`)]);
    }
    for (const [reach, paths] of [
      ["none", absentPaths()],
      ["guarded", guardedPaths()],
      ["open", openPaths()],
    ] as const) {
      const admitted = manifest((m) => {
        policyOf(m).writeReach = reach;
        safeguardsOf(m).writePaths = paths;
      });

      expect(refusalsFor(admitted)).toEqual([]);
    }
  });

  test("an agent credential form outside the claim's values is refused as value-not-allowed, and null as wrong-type beside it", () => {
    for (const form of ["user", "PAIR", "secret"]) {
      const changed = manifest((m) => (policyOf(m).agentCredentialForm = form));

      expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", `${POLICY}/agentCredentialForm`)]);
    }
    expect(refusalsFor(manifest((m) => (policyOf(m).agentCredentialForm = null)))).toEqual([
      refusal("value-not-allowed", `${POLICY}/agentCredentialForm`),
      refusal("wrong-type", `${POLICY}/agentCredentialForm`),
    ]);
    for (const form of ["pair", "token", "service-account-key", "dedicated-user", "none"]) {
      expect(refusalsFor(manifest((m) => (policyOf(m).agentCredentialForm = form)))).toEqual([]);
    }
  });

  test("a masking exemption or inline edit refusal whose pattern or reason is empty or past its bound is refused as out-of-range", () => {
    const masking = (exemption: Json) => manifest((m) => (policyOf(m).maskingExemptColumns = exemption));
    const inline = (stated: Json) => manifest((m) => (safeguardsOf(m).inlineEditRefusedColumns = stated));
    const MASKING = `${POLICY}/maskingExemptColumns`;
    const INLINE = `${SAFEGUARDS}/inlineEditRefusedColumns`;

    expect(refusalsFor(masking(maskingExemption("^")))).toEqual([refusal("out-of-range", `${MASKING}/column`)]);
    expect(refusalsFor(masking(maskingExemption(`^${"a".repeat(511)}$`)))).toEqual([
      refusal("out-of-range", `${MASKING}/column`),
    ]);
    expect(refusalsFor(masking({ column: "^address$", reason: "" }))).toEqual([
      refusal("out-of-range", `${MASKING}/reason`),
    ]);
    expect(refusalsFor(masking({ column: "^address$", reason: "x".repeat(2001) }))).toEqual([
      refusal("out-of-range", `${MASKING}/reason`),
    ]);
    expect(refusalsFor(inline(inlineEditRefusal("")))).toEqual([refusal("out-of-range", `${INLINE}/type`)]);
    expect(refusalsFor(inline(inlineEditRefusal("a".repeat(513))))).toEqual([
      refusal("out-of-range", `${INLINE}/type`),
    ]);
    expect(refusalsFor(inline({ type: "^BLOB$", reason: "" }))).toEqual([refusal("out-of-range", `${INLINE}/reason`)]);
    expect(refusalsFor(inline({ type: "^BLOB$", reason: "x".repeat(2001) }))).toEqual([
      refusal("out-of-range", `${INLINE}/reason`),
    ]);
    expect(refusalsFor(masking({ column: `^${"a".repeat(510)}$`, reason: "x".repeat(2000) }))).toEqual([]);
    expect(refusalsFor(inline({ type: "a".repeat(512), reason: "x".repeat(2000) }))).toEqual([]);
  });

  test("a write path that is not one of the three reaches, or whose gate or proof is not a .ts module under src with an export name, is refused as no-variant at the path", () => {
    const proof = (module: string, symbol = "EXAMPLEDB_READS") => ({ reach: "absent", proof: { module, symbol } });
    const refused = [
      { reach: "partial" },
      { reach: "open", proof: null },
      { reach: "gated" },
      { reach: "absent" },
      { reach: "gated", gate: null },
      ...["lib/x.ts", "src/../x.ts", "src/./x.ts", "src/x.js", "src/x.d.ts", "/src/x.ts", "src/", "src/x"].map(
        (module) => proof(module),
      ),
      proof("src/x.ts", "a-b"),
      proof("src/x.ts", "1a"),
      { reach: "gated", gate: { module: "src/x.ts", symbol: "a-b" } },
      { reach: "absent", proof: { ...WRITE_PROOF, bogus: 1 } },
    ];
    for (const path of refused) {
      const changed = manifest((m) => (writePathsOf(m).editor = path));

      expect(refusalsFor(changed)).toEqual([refusal("no-variant", `${WRITE_PATHS}/editor`)]);
    }
    const admitted = [
      { reach: "absent", proof: { module: "src/a/b-c_d.ts", symbol: "_X1" } },
      { reach: "gated", gate: { module: "src/readOnlyGate.ts", symbol: "refuseWrites" } },
      { reach: "open" },
    ];
    for (const path of admitted) {
      expect(refusalsFor(manifest((m) => (writePathsOf(m).editor = path)))).toEqual([]);
    }
  });

  test("a metadata-only answer with no operation or an operation with no column is refused as too-few, and a kind outside name, count and flag as value-not-allowed", () => {
    const answering = (operations: unknown) => manifest((m) => (safeguardsOf(m).metadataOnly = operations));
    const valueKind = metadataOperation("window", ["name"]);
    valueKind.columns[0].kind = "value";

    expect(refusalsFor(answering([]))).toEqual([refusal("too-few", METADATA_ONLY)]);
    expect(refusalsFor(answering([metadataOperation("window", [])]))).toEqual([
      refusal("too-few", `${METADATA_ONLY}/0/columns`),
    ]);
    expect(refusalsFor(answering([valueKind]))).toEqual([
      refusal("value-not-allowed", `${METADATA_ONLY}/0/columns/0/kind`),
    ]);
    expect(
      refusalsFor(
        answering([
          {
            operation: "topics",
            columns: [
              { column: "topic", kind: "name" },
              { column: "partitions", kind: "count" },
            ],
          },
          { operation: "brokers", columns: [{ column: "offline", kind: "flag" }] },
        ]),
      ),
    ).toEqual([]);
  });

  test("a metadata operation or column name outside its pattern is refused as pattern-mismatch", () => {
    const answering = (operation: Json) => manifest((m) => (safeguardsOf(m).metadataOnly = [operation]));

    for (const operation of [" window", "window ", "win/dow", "1window", ""]) {
      expect(refusalsFor(answering(metadataOperation(operation)))).toEqual([
        refusal("pattern-mismatch", `${METADATA_ONLY}/0/operation`),
      ]);
    }
    for (const column of ["1st", "a-b", "a b", ""]) {
      expect(refusalsFor(answering(metadataOperation("window", [column])))).toEqual([
        refusal("pattern-mismatch", `${METADATA_ONLY}/0/columns/0/column`),
      ]);
    }
    for (const operation of ["OBJECT ENCODING", "lease timetolive", "load_state", "list-buckets", "edgeNode", "x"]) {
      expect(refusalsFor(answering(metadataOperation(operation)))).toEqual([]);
    }
  });

  test("the machine redaction, billed compute and the write paths are no claims, each refused as unknown-key where it is not a member", () => {
    const redaction = manifest((m) => (safeguardsOf(m).machineRedaction = { maskedNameKinds: ["secrets"] }));
    const billed = manifest((m) => (safeguardsOf(m).resumesBilledCompute = true));
    const paths = manifest((m) => (policyOf(m).writePaths = openPaths()));

    expect(refusalsFor(redaction)).toEqual([refusal("unknown-key", SAFEGUARDS, "machineRedaction")]);
    expect(refusalsFor(billed)).toEqual([refusal("unknown-key", SAFEGUARDS, "resumesBilledCompute")]);
    expect(refusalsFor(paths)).toEqual([refusal("unknown-key", POLICY, "writePaths")]);
  });

  test("a claim that is not of its type is refused as wrong-type", () => {
    const exposable = manifest((m) => (mcpOf(m).exposable = "yes"));
    const posture = manifest((m) => (policyOf(m).readsFileAccessPosture = 1));
    const refusalFlag = manifest((m) => (policyOf(m).deniedFileAccessRefusal = false));
    const trust = manifest((m) => (connectionOf(m).readsTrustMaterial = null));

    expect(refusalsFor(exposable)).toEqual([refusal("wrong-type", `${MCP}/exposable`)]);
    expect(refusalsFor(posture)).toEqual([refusal("wrong-type", `${POLICY}/readsFileAccessPosture`)]);
    expect(refusalsFor(refusalFlag)).toEqual([refusal("wrong-type", `${POLICY}/deniedFileAccessRefusal`)]);
    expect(refusalsFor(trust)).toEqual([refusal("wrong-type", "/engines/0/connection/readsTrustMaterial")]);
  });

  test("a denied file access refusal that is empty or longer than 2000 characters is refused as out-of-range", () => {
    const refusing = (sentence: string) =>
      manifest((m) => Object.assign(policyOf(m), { readsFileAccessPosture: true, deniedFileAccessRefusal: sentence }));

    expect(refusalsFor(refusing(""))).toEqual([refusal("out-of-range", `${POLICY}/deniedFileAccessRefusal`)]);
    expect(refusalsFor(refusing("x".repeat(2001)))).toEqual([
      refusal("out-of-range", `${POLICY}/deniedFileAccessRefusal`),
    ]);
    expect(refusalsFor(refusing("x".repeat(2000)))).toEqual([]);
  });

  test("read-only enforcement, Studio's agent execution record and the trust material are no claims, each refused as unknown-key", () => {
    const readOnly = manifest((m) => (policyOf(m).readOnlyEnforced = true));
    const execution = manifest((m) => (mcpOf(m).agentExecution = true));
    const trust = manifest((m) => (policyOf(m).readsTrustMaterial = false));

    expect(refusalsFor(readOnly)).toEqual([refusal("unknown-key", POLICY, "readOnlyEnforced")]);
    expect(refusalsFor(execution)).toEqual([refusal("unknown-key", MCP, "agentExecution")]);
    expect(refusalsFor(trust)).toEqual([refusal("unknown-key", POLICY, "readsTrustMaterial")]);
  });

  test("every shipped shape of a maintenance spec is admitted", () => {
    const shaped = manifest(withMaintenance);
    const kafka = kafkaManifest();
    withMaintenance(kafka);

    expect(refusalsFor(shaped)).toEqual([]);
    expect(validator.validateEngine(shaped.engines[0]).admitted).toBe(true);
    expect(refusalsFor(kafka)).toEqual([]);
    expect(refusalsFor(manifest())).toEqual([]);
    expect(refusalsFor(kafkaManifest())).toEqual([]);
  });

  test("a maintenance spec whose label, title or description is empty or past its bound is refused as out-of-range", () => {
    for (const [member, index, bound] of [
      ["label", 0, 128],
      ["title", 3, 128],
      ["description", 3, 2000],
    ] as const) {
      for (const text of ["", "x".repeat(bound + 1)]) {
        const changed = manifest((m) => {
          withMaintenance(m);
          maintenanceSpecsOf(m)[index][member] = text;
        });

        expect(refusalsFor(changed)).toEqual([refusal("out-of-range", `${MAINTENANCE_SPECS}/${index}/${member}`)]);
      }
      const longest = manifest((m) => {
        withMaintenance(m);
        maintenanceSpecsOf(m)[index][member] = "x".repeat(bound);
      });

      expect(refusalsFor(longest)).toEqual([]);
    }
  });

  test("a maintenance spec's operation or confirmation outside its vocabulary is refused as value-not-allowed", () => {
    const operation = manifest((m) => {
      withMaintenance(m);
      maintenanceSpecsOf(m)[0].operation = "truncate";
    });

    expect(refusalsFor(operation)).toEqual([refusal("value-not-allowed", `${MAINTENANCE_SPECS}/0/operation`)]);
    for (const confirmation of ["typed-name", "TYPED"]) {
      const changed = manifest((m) => {
        withMaintenance(m);
        maintenanceSpecsOf(m)[3].confirmation = confirmation;
      });

      expect(refusalsFor(changed)).toEqual([refusal("value-not-allowed", `${MAINTENANCE_SPECS}/3/confirmation`)]);
    }
  });

  test("a maintenance spec member that is not of its type is refused as wrong-type", () => {
    for (const [member, value] of [
      ["perEntity", "yes"],
      ["preview", null],
      ["kinds", "table"],
    ] as const) {
      const changed = manifest((m) => {
        withMaintenance(m);
        maintenanceSpecsOf(m)[2][member] = value;
      });

      expect(refusalsFor(changed)).toEqual([refusal("wrong-type", `${MAINTENANCE_SPECS}/2/${member}`)]);
    }
  });

  test("an object kind a maintenance spec names outside its pattern is refused as pattern-mismatch, an empty kind list as too-few and a repeated kind as duplicate", () => {
    const KINDS = `${MAINTENANCE_SPECS}/2/kinds`;
    const withKinds = (kinds: unknown[]) =>
      manifest((m) => {
        withMaintenance(m);
        maintenanceSpecsOf(m)[2].kinds = kinds;
      });

    for (const kind of ["Table", "1table", "table kind"]) {
      expect(refusalsFor(withKinds([kind]))).toEqual([refusal("pattern-mismatch", `${KINDS}/0`)]);
    }
    expect(refusalsFor(withKinds([]))).toEqual([refusal("too-few", KINDS)]);
    expect(refusalsFor(withKinds(["table", "table"]))).toEqual([refusal("duplicate", `${KINDS}/1`)]);
  });

  test("a maintenance spec member Studio's spec has none of is refused as unknown-key", () => {
    for (const key of ["destructive", "confirmed"]) {
      const changed = manifest((m) => {
        withMaintenance(m);
        maintenanceSpecsOf(m)[1][key] = true;
      });

      expect(refusalsFor(changed)).toEqual([refusal("unknown-key", `${MAINTENANCE_SPECS}/1`, key)]);
    }
  });

  test("more maintenance specs than there are operations are refused as too-many", () => {
    const changed = manifest((m) => {
      withMaintenance(m);
      facetsOf(m).maintenanceSpecs = Array.from({ length: 12 }, () => maintenanceSpec("vacuum", "Vacuum", true, true));
    });

    expect(refusalsFor(changed)).toEqual([refusal("too-many", MAINTENANCE_SPECS)]);
  });

  test("every shipped shape of an agent overlay is admitted", () => {
    const shaped = dialected(() => {});
    const bare = dialected((m) => {
      Object.assign(sqlDialectOf(m).catalogRead, {
        declaredSchema: null,
        retry: null,
        commandShaped: false,
        mapRows: null,
      });
      sqlDialectOf(m).profileComposition.uncountableType = null;
      Object.assign(sqlDialectOf(m).statistics, { probe: null, limitNote: null });
      sqlDialectOf(m).catalogCapture.kindWords = [];
      agentOf(m).overlay.grounding = null;
    });
    const sessionMode = dialected(
      (m) => (sqlDialectOf(m).planEstimate = { kind: "session-mode", mode: "estimate-plan" }),
    );
    const composesNothing = dialected((m) =>
      Object.assign(sqlDialectOf(m), {
        catalogRead: null,
        planEstimate: null,
        profileComposition: null,
        statistics: null,
        catalogCapture: null,
      }),
    );
    const kafka = kafkaManifest();
    agentOf(kafka).overlay.grounding = "groundingOverride";

    for (const admitted of [shaped, bare, sessionMode, composesNothing, kafka, manifest(), kafkaManifest()]) {
      expect(refusalsFor(admitted)).toEqual([]);
      expect(validator.validateEngine(admitted.engines[0]).admitted).toBe(true);
    }
  });

  test("an agent overlay member Studio's declaration has no place for is refused as unknown-key", () => {
    for (const key of ["workflowToolRules", "answerNotADataRead", "executes", "family"]) {
      const changed = dialected((m) => (agentOf(m).overlay[key] = null));

      expect(refusalsFor(changed)).toEqual([refusal("unknown-key", OVERLAY, key)]);
    }
    const views = dialected((m) => (sqlDialectOf(m).catalogRead.compose.views = "catalogViews"));

    expect(refusalsFor(views)).toEqual([refusal("unknown-key", `${DIALECT}/catalogRead/compose`, "views")]);
  });

  test("a capture kind or pattern flag outside its vocabulary is refused as value-not-allowed", () => {
    const kind = dialected((m) => (sqlDialectOf(m).catalogCapture.kinds = ["columns", "tables"]));
    const flag = dialected((m) => (sqlDialectOf(m).profileComposition.incomparableType.flags = "g"));

    expect(refusalsFor(kind)).toEqual([refusal("value-not-allowed", `${DIALECT}/catalogCapture/kinds/1`)]);
    expect(refusalsFor(flag)).toEqual([
      refusal("value-not-allowed", `${DIALECT}/profileComposition/incomparableType/flags`),
    ]);
  });

  test("an agent overlay member that is not of its type is refused as wrong-type", () => {
    const command = dialected((m) => (sqlDialectOf(m).catalogRead.commandShaped = "yes"));
    const words = dialected((m) => (sqlDialectOf(m).catalogCapture.kindWords = { r: "table" }));
    const unsupported = dialected((m) => (sqlDialectOf(m).catalogRead = "unsupported"));

    expect(refusalsFor(command)).toEqual([refusal("wrong-type", `${DIALECT}/catalogRead/commandShaped`)]);
    expect(refusalsFor(words)).toEqual([refusal("wrong-type", `${DIALECT}/catalogCapture/kindWords`)]);
    expect(refusalsFor(unsupported)).toEqual([refusal("wrong-type", `${DIALECT}/catalogRead`)]);
  });

  test("a function name, kind word or kind word's kind outside its pattern is refused as pattern-mismatch", () => {
    const name = dialected((m) => (sqlDialectOf(m).catalogRead.compose.columns = "Columns"));
    const word = dialected((m) => (sqlDialectOf(m).catalogCapture.kindWords[0].word = "1r"));
    const kind = dialected((m) => (sqlDialectOf(m).catalogCapture.kindWords[0].kind = "Table"));

    expect(refusalsFor(name)).toEqual([refusal("pattern-mismatch", `${DIALECT}/catalogRead/compose/columns`)]);
    expect(refusalsFor(word)).toEqual([refusal("pattern-mismatch", `${DIALECT}/catalogCapture/kindWords/0/word`)]);
    expect(refusalsFor(kind)).toEqual([refusal("pattern-mismatch", `${DIALECT}/catalogCapture/kindWords/0/kind`)]);
  });

  test("an estimating plan that is neither an EXPLAIN prefix nor the session mode is refused as no-variant", () => {
    const estimate = (planEstimate: Json) => dialected((m) => (sqlDialectOf(m).planEstimate = planEstimate));

    for (const planEstimate of [
      { kind: "prefix", prefix: "SHOW PLAN" },
      { kind: "prefix", prefix: "explain" },
      { kind: "prefix", prefix: "EXPLAIN  (FORMAT JSON)" },
      { kind: "prefix", prefix: `EXPLAIN ${"x".repeat(121)}` },
      { kind: "session-mode", mode: "execute" },
      { kind: "prefix" },
    ]) {
      expect(refusalsFor(estimate(planEstimate))).toEqual([refusal("no-variant", `${DIALECT}/planEstimate`)]);
    }
    for (const prefix of [
      "EXPLAIN",
      "EXPLAIN QUERY PLAN",
      "EXPLAIN json = 1, indexes = 1",
      `EXPLAIN ${"x".repeat(120)}`,
    ]) {
      expect(refusalsFor(estimate({ kind: "prefix", prefix }))).toEqual([]);
    }
  });

  test("a statistics probe or note or a profile type pattern that is empty or past its bound is refused as out-of-range", () => {
    const STATISTICS = `${DIALECT}/statistics`;
    const SOURCE = `${DIALECT}/profileComposition/incomparableType/source`;
    for (const [member, bound] of [
      ["probe", 2000],
      ["limitNote", 2000],
    ] as const) {
      for (const text of ["", "x".repeat(bound + 1)]) {
        expect(refusalsFor(dialected((m) => (sqlDialectOf(m).statistics[member] = text)))).toEqual([
          refusal("out-of-range", `${STATISTICS}/${member}`),
        ]);
      }
      expect(refusalsFor(dialected((m) => (sqlDialectOf(m).statistics[member] = "x".repeat(bound))))).toEqual([]);
    }
    for (const source of ["", "x".repeat(513)]) {
      expect(
        refusalsFor(dialected((m) => (sqlDialectOf(m).profileComposition.incomparableType.source = source))),
      ).toEqual([refusal("out-of-range", SOURCE)]);
    }
    expect(
      refusalsFor(dialected((m) => (sqlDialectOf(m).profileComposition.incomparableType.source = "x".repeat(512)))),
    ).toEqual([]);
  });

  test("a capture's kinds that are none, more than the catalog's or repeated, and too many kind words, are refused", () => {
    const CAPTURE = `${DIALECT}/catalogCapture`;
    const kinds = (list: string[]) => dialected((m) => (sqlDialectOf(m).catalogCapture.kinds = list));
    const words = Array.from({ length: 65 }, (_, index) => ({ word: `w${index}`, kind: "table" }));

    expect(refusalsFor(kinds([]))).toEqual([refusal("too-few", `${CAPTURE}/kinds`)]);
    expect(refusalsFor(kinds(["columns", "relations", "indexes", "statistics", "columns"]))).toEqual([
      refusal("too-many", `${CAPTURE}/kinds`),
      refusal("duplicate", `${CAPTURE}/kinds/4`),
    ]);
    expect(refusalsFor(kinds(["columns", "columns"]))).toEqual([refusal("duplicate", `${CAPTURE}/kinds/1`)]);
    expect(refusalsFor(dialected((m) => (sqlDialectOf(m).catalogCapture.kindWords = words)))).toEqual([
      refusal("too-many", `${CAPTURE}/kindWords`),
    ]);
    expect(refusalsFor(dialected((m) => (sqlDialectOf(m).catalogCapture.kindWords = words.slice(1))))).toEqual([]);
  });

  test("a catalog read that claims no command, the claim's restrictive value, is admitted", () => {
    const restrictive = dialected((m) => (sqlDialectOf(m).catalogRead.commandShaped = false));

    expect(refusalsFor(restrictive)).toEqual([]);
    expect(validator.validateEngine(restrictive.engines[0]).admitted).toBe(true);
  });

  test("a statement language's confirmation states its operations, its reader kind, whether it decides alone, whether the safety analysis may read it and its byte bound, and names no function", () => {
    const stated = (change: (confirmation: Json) => void) =>
      manifest((m) => {
        m.engines[0].statementLanguageData = languageData("acmeql");
        change(confirmationOf(m));
      });

    for (const admitted of [
      stated(() => {}),
      stated((c) => Object.assign(c, { decidesAlone: false, safetyAnalysis: true, maxTextBytes: 1 })),
      stated((c) => (c.maxTextBytes = 16777216)),
    ]) {
      expect(refusalsFor(admitted)).toEqual([]);
      expect(validator.validateEngine(admitted.engines[0]).admitted).toBe(true);
    }

    for (const key of ["read", "refuse", "typedConfirmation"]) {
      expect(refusalsFor(stated((c) => (c[key] = "readStatement")))).toEqual([
        refusal("unknown-key", CONFIRMATION, key),
      ]);
    }
    for (const key of ["operations", "reader", "decidesAlone", "safetyAnalysis", "maxTextBytes"]) {
      expect(refusalsFor(stated((c) => delete c[key]))).toEqual([refusal("missing-key", CONFIRMATION, key)]);
    }
    for (const key of ["name", "confirmation", "agent"]) {
      const lacking = manifest((m) => {
        m.engines[0].statementLanguageData = languageData("acmeql");
        delete m.engines[0].statementLanguageData[key];
      });
      expect(refusalsFor(lacking)).toEqual([refusal("missing-key", LANGUAGE_DATA, key)]);
    }

    expect(refusalsFor(stated((c) => (c.reader = "parses-statement")))).toEqual([
      refusal("value-not-allowed", `${CONFIRMATION}/reader`),
    ]);
    expect(refusalsFor(stated((c) => (c.decidesAlone = "yes")))).toEqual([
      refusal("wrong-type", `${CONFIRMATION}/decidesAlone`),
    ]);
    expect(refusalsFor(stated((c) => (c.safetyAnalysis = null)))).toEqual([
      refusal("wrong-type", `${CONFIRMATION}/safetyAnalysis`),
    ]);
    for (const bound of [0, 16777217]) {
      expect(refusalsFor(stated((c) => (c.maxTextBytes = bound)))).toEqual([
        refusal("out-of-range", `${CONFIRMATION}/maxTextBytes`),
      ]);
    }
    expect(refusalsFor(stated((c) => (c.maxTextBytes = 1.5)))).toEqual([
      refusal("wrong-type", `${CONFIRMATION}/maxTextBytes`),
    ]);
    for (const operation of ["lease  revoke", "1drop", " drop", "drop "]) {
      expect(refusalsFor(stated((c) => (c.operations = [operation])))).toEqual([
        refusal("pattern-mismatch", `${CONFIRMATION}/operations/0`),
      ]);
    }
    expect(refusalsFor(stated((c) => (c.operations = [`d${"r".repeat(64)}`])))).toEqual([
      refusal("out-of-range", `${CONFIRMATION}/operations/0`),
    ]);
    expect(refusalsFor(stated((c) => (c.operations = ["drop", "drop"])))).toEqual([
      refusal("duplicate", `${CONFIRMATION}/operations/1`),
    ]);
  });

  test("several failures are each refused, ordered by pointer", () => {
    const changed = manifest((m) => {
      m.bogus = true;
      m.engines[0].location = "remote";
      m.engines[0].connection.tls = { modes: ["maybe"] };
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("unknown-key", "", "bogus"),
      refusal("value-not-allowed", "/engines/0/connection/tls/modes/0"),
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

  test("a TLS mode listed after one the provider contract orders after it is refused as tls-mode-order, at each such mode", () => {
    const TLS = "/engines/0/connection/tls/modes";
    const modes = (...listed: string[]) => manifest((m) => (connectionOf(m).tls = { modes: listed }));

    expect(refusalsFor(modes("verify-full", "disable", "require"))).toEqual([
      refusal("tls-mode-order", `${TLS}/1`),
      refusal("tls-mode-order", `${TLS}/2`),
    ]);
    expect(refusalsFor(modes("require", "disable"))).toEqual([refusal("tls-mode-order", `${TLS}/1`)]);
    expect(refusalsFor(modes("disable", "verify-ca", "verify-system", "verify-full"))).toEqual([
      refusal("tls-mode-order", `${TLS}/2`),
    ]);
    expect(refusalsFor(modes("disable", "verify-system", "verify-full"))).toEqual([]);
    expect(validator.validateEngine(modes("verify-full", "verify-ca").engines[0])).toEqual({
      admitted: false,
      refusals: [refusal("tls-mode-order", "/connection/tls/modes/1")],
    });
  });

  test("a TLS mode out of order is refused in one sentence naming its pointer and no mode", () => {
    const [refused] = refusalsFor(
      manifest((m) => (connectionOf(m).tls = { modes: ["verify-full", "verify-system"] })),
    ) as ManifestRefusal[];
    const sentence = refusalSentence(refused);

    expect(sentence).toBe(
      "The TLS mode at /engines/0/connection/tls/modes/1 is listed after a mode the provider contract orders after it.",
    );
    for (const mode of ["verify-full", "verify-system"]) expect(sentence).not.toContain(mode);
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

  test("a statement read on an engine not exposed to MCP is refused as statement-read-unexposed", () => {
    const changed = kafkaManifest();
    mcpOf(changed).exposable = false;

    expect(mcpOf(changed).statementRead).toBe(true);
    expect(refusalsFor(changed)).toEqual([refusal("statement-read-unexposed", `${MCP}/statementRead`)]);
  });

  test("an agent credential required of an engine whose seeds take none is refused as agent-credential-form-missing", () => {
    const changed = manifest((m) => (mcpOf(m).agentCredentialRequired = true));

    expect(connectionOf(changed).agentCredential).toBeNull();
    expect(refusalsFor(changed)).toEqual([refusal("agent-credential-form-missing", `${MCP}/agentCredentialRequired`)]);
  });

  test("a seed agent credential whose form is not the one the agent credential form request names is refused as agent-credential-seed-form-differs, a request of none excepted", () => {
    const pairing = (seedForm: string | null, request: string): Json => {
      const changed = kafkaManifest();
      connectionOf(changed).agentCredential = seedForm === null ? null : { form: seedForm, supersededBy: [] };
      policyOf(changed).agentCredentialForm = request;
      return changed;
    };
    const differing: readonly [string, string][] = [
      ["pair", "token"],
      ["pair", "service-account-key"],
      ["pair", "dedicated-user"],
      ["secret", "pair"],
      ["secret", "dedicated-user"],
      ["dedicated-pair", "pair"],
      ["dedicated-pair", "token"],
    ];
    const matching: readonly (readonly [string | null, string])[] = [
      ["pair", "pair"],
      ["dedicated-pair", "dedicated-user"],
      ["secret", "token"],
      ["secret", "service-account-key"],
      ["pair", "none"],
      ["secret", "none"],
      ["dedicated-pair", "none"],
      ...["pair", "token", "service-account-key", "dedicated-user", "none"].map((request) => [null, request] as const),
    ];

    for (const [seedForm, request] of differing) {
      const changed = pairing(seedForm, request);
      expect(refusalsFor(changed)).toEqual([
        refusal("agent-credential-seed-form-differs", "/engines/0/connection/agentCredential/form"),
      ]);
      expect(validator.validateEngine(changed.engines[0])).toEqual({
        admitted: false,
        refusals: [refusal("agent-credential-seed-form-differs", "/connection/agentCredential/form")],
      });
    }
    for (const [seedForm, request] of matching) {
      expect({ seedForm, request, refusals: refusalsFor(pairing(seedForm, request)) }).toEqual({
        seedForm,
        request,
        refusals: [],
      });
    }
    const sentence = refusalSentence(refusalsFor(pairing("pair", "token"))[0] as ManifestRefusal);
    expect(sentence).toContain("/engines/0/connection/agentCredential/form");
    for (const value of ["pair", "token"]) expect(sentence).not.toContain(` ${value}`);
  });

  test("read roots required of an engine whose seeds cannot declare them are refused as read-roots-field-undeclared", () => {
    const unseeded = manifest((m) => (policyOf(m).readRootsRequired = true));
    const otherField = kafkaManifest();
    policyOf(otherField).readRootsRequired = true;
    connectionOf(otherField).seedOnly = {
      fields: ["securityPolicyUri"],
      scope: "each",
      refusal: "{field} is Kafka only.",
      projectionRefusal: null,
    };

    expect(connectionOf(unseeded).seedOnly).toBeNull();
    expect(refusalsFor(unseeded)).toEqual([refusal("read-roots-field-undeclared", `${POLICY}/readRootsRequired`)]);
    expect(refusalsFor(otherField)).toEqual([refusal("read-roots-field-undeclared", `${POLICY}/readRootsRequired`)]);
  });

  test("a denied file access refusal on an engine that reads no file-access posture is refused as denied-file-access-unread", () => {
    const unread = manifest((m) => (policyOf(m).deniedFileAccessRefusal = DENIED_FILE_ACCESS_REFUSAL));
    const read = manifest((m) =>
      Object.assign(policyOf(m), { readsFileAccessPosture: true, deniedFileAccessRefusal: DENIED_FILE_ACCESS_REFUSAL }),
    );

    expect(refusalsFor(unread)).toEqual([refusal("denied-file-access-unread", `${POLICY}/deniedFileAccessRefusal`)]);
    expect(refusalsFor(read)).toEqual([]);
  });

  test("a write reach claim that is not the summary of the engine's write paths is refused as write-reach-summary-differs", () => {
    const kafka = (change: (m: Json) => void) => {
      const changed = kafkaManifest();
      change(changed);
      return changed;
    };
    const differs = [refusal("write-reach-summary-differs", `${POLICY}/writeReach`)];

    expect(writePathsOf(kafkaManifest()).editor.reach).toBe("absent");
    for (const reach of ["guarded", "open"]) {
      expect(refusalsFor(kafka((m) => (policyOf(m).writeReach = reach)))).toEqual(differs);
    }
    const gatedMaintenance = (m: Json) => (writePathsOf(m).maintenance = { reach: "gated", gate: { ...WRITE_PROOF } });
    const openTransaction = (m: Json) => (writePathsOf(m).transaction = { reach: "open" });
    for (const reach of ["none", "open"]) {
      expect(refusalsFor(kafka((m) => (gatedMaintenance(m), (policyOf(m).writeReach = reach))))).toEqual(differs);
    }
    for (const reach of ["none", "guarded"]) {
      expect(refusalsFor(kafka((m) => (openTransaction(m), (policyOf(m).writeReach = reach))))).toEqual(differs);
    }
    expect(refusalsFor(kafka((m) => (gatedMaintenance(m), (policyOf(m).writeReach = "guarded"))))).toEqual([]);
    expect(refusalsFor(kafka((m) => (openTransaction(m), (policyOf(m).writeReach = "open"))))).toEqual([]);
    expect(
      refusalsFor(kafka((m) => (gatedMaintenance(m), openTransaction(m), (policyOf(m).writeReach = "open")))),
    ).toEqual([]);
    expect(refusalsFor(manifest((m) => (policyOf(m).writeReach = "none")))).toEqual(differs);
    expect(refusalsFor(manifest((m) => (policyOf(m).writeReach = "guarded")))).toEqual(differs);
  });

  test("an absent editor write path that names no proof is refused as editor-write-path-unproven", () => {
    const unproven = kafkaManifest();
    writePathsOf(unproven).editor.proof = null;
    const objectEditProven = kafkaManifest();
    writePathsOf(objectEditProven).objectEdit.proof = { ...WRITE_PROOF };

    expect(writePathsOf(kafkaManifest()).objectEdit).toEqual({ reach: "absent", proof: null });
    expect(refusalsFor(unproven)).toEqual([refusal("editor-write-path-unproven", `${WRITE_PATHS}/editor/proof`)]);
    expect(refusalsFor(objectEditProven)).toEqual([]);
  });

  test("a masking exemption whose column pattern does not match whole names only is refused as masking-exemption-unanchored", () => {
    const exempting = (column: string) =>
      manifest((m) => (policyOf(m).maskingExemptColumns = maskingExemption(column)));

    for (const column of [
      "address",
      "^address",
      "address$",
      "^address\\$",
      "^address$|ip",
      "^a$|^b$",
      "^address$(?=x)",
      "^[$]",
      "^a(b|c$)",
    ]) {
      expect([column, refusalsFor(exempting(column))]).toEqual([
        column,
        [refusal("masking-exemption-unanchored", `${POLICY}/maskingExemptColumns/column`)],
      ]);
    }
    for (const column of ["^address$", "^(?:address|value)$", "^[|]address$", "^address\\\\$", "^[\\]$]x$", "^.*$"]) {
      expect([column, refusalsFor(exempting(column))]).toEqual([column, []]);
    }
  });

  test("a masking exemption or inline edit refusal pattern that does not compile is refused as pattern-invalid", () => {
    const masking = manifest((m) => (policyOf(m).maskingExemptColumns = maskingExemption("^(address$")));
    const inline = manifest((m) => (safeguardsOf(m).inlineEditRefusedColumns = inlineEditRefusal("(")));

    expect(refusalsFor(masking)).toEqual([refusal("pattern-invalid", `${POLICY}/maskingExemptColumns/column`)]);
    expect(refusalsFor(inline)).toEqual([refusal("pattern-invalid", `${SAFEGUARDS}/inlineEditRefusedColumns/type`)]);
  });

  test("a metadata operation named twice is refused as metadata-operation-duplicate, at the later one", () => {
    const changed = manifest(
      (m) =>
        (safeguardsOf(m).metadataOnly = [
          metadataOperation("window"),
          metadataOperation("other"),
          metadataOperation("window"),
        ]),
    );

    expect(refusalsFor(changed)).toEqual([refusal("metadata-operation-duplicate", `${METADATA_ONLY}/2/operation`)]);
  });

  test("a column named twice in one metadata operation is refused as metadata-column-duplicate, and the same column in two operations is admitted", () => {
    const repeated = manifest(
      (m) => (safeguardsOf(m).metadataOnly = [metadataOperation("window", ["count", "name", "count"])]),
    );
    const shared = manifest(
      (m) =>
        (safeguardsOf(m).metadataOnly = [
          metadataOperation("window", ["count"]),
          metadataOperation("other", ["count"]),
        ]),
    );

    expect(refusalsFor(repeated)).toEqual([
      refusal("metadata-column-duplicate", `${METADATA_ONLY}/0/columns/2/column`),
    ]);
    expect(refusalsFor(shared)).toEqual([]);
  });

  /** The fixture's one engine offering maintenance in every shipped shape, then changed by `change`. */
  const maintained = (change: (m: Json) => void) =>
    manifest((m) => {
      withMaintenance(m);
      change(m);
    });

  /** The spec at `index` of the fixture's one engine, with `members` assigned over it. */
  const respec = (index: number, members: Json) => (m: Json) => Object.assign(maintenanceSpecsOf(m)[index], members);

  test("a maintenance spec for an operation the maintenance facet does not list is refused as maintenance-spec-unlisted", () => {
    const changed = maintained((m) => (facetsOf(m).maintenance = ["vacuum", "check", "compact", "kill"]));

    expect(refusalsFor(changed)).toEqual([refusal("maintenance-spec-unlisted", `${MAINTENANCE_SPECS}/2/operation`)]);
  });

  test("a maintenance operation given two specs is refused as maintenance-spec-duplicate, at the later one", () => {
    const changed = maintained((m) =>
      maintenanceSpecsOf(m).push(maintenanceSpec("vacuum", "Vacuum Again", true, true)),
    );

    expect(refusalsFor(changed)).toEqual([refusal("maintenance-spec-duplicate", `${MAINTENANCE_SPECS}/5/operation`)]);
  });

  test("a listed maintenance operation with no spec is refused as maintenance-spec-missing, at the operation", () => {
    const changed = maintained((m) => maintenanceSpecsOf(m).splice(1, 1));

    expect(refusalsFor(changed)).toEqual([refusal("maintenance-spec-missing", "/engines/0/facets/maintenance/1")]);
  });

  test("a maintenance spec that places its operation nowhere is refused as maintenance-spec-unplaced, and kill's is admitted", () => {
    const changed = maintained(respec(0, { perEntity: false, global: false }));

    const kill = maintained(() => {});

    expect(refusalsFor(changed)).toEqual([refusal("maintenance-spec-unplaced", `${MAINTENANCE_SPECS}/0`)]);
    expect(maintenanceSpecsOf(kill)[4]).toMatchObject({ operation: "kill", perEntity: false, global: false });
    expect(refusalsFor(kill)).toEqual([]);
  });

  test("a typed confirmation is admitted only on a spec placed over the whole database alone, with a title and a description, and refused elsewhere as maintenance-typed-confirmation-unasked", () => {
    const at = `${MAINTENANCE_SPECS}/3/confirmation`;

    for (const members of [{ perEntity: true }, { title: null }, { description: null }]) {
      expect(refusalsFor(maintained(respec(3, members)))).toEqual([
        refusal("maintenance-typed-confirmation-unasked", at),
      ]);
    }
    expect(refusalsFor(maintained(respec(3, { global: false })))).toEqual([
      refusal("maintenance-spec-unplaced", `${MAINTENANCE_SPECS}/3`),
      refusal("maintenance-typed-confirmation-unasked", at),
    ]);
    expect(refusalsFor(maintained(respec(4, { confirmation: "typed" })))).toEqual([
      refusal("maintenance-typed-confirmation-unasked", `${MAINTENANCE_SPECS}/4/confirmation`),
    ]);
  });

  test("a typed target is admitted only on a spec placed on a row alone, and refused elsewhere as maintenance-typed-target-unasked", () => {
    const at = `${MAINTENANCE_SPECS}/2`;

    expect(refusalsFor(maintained(respec(2, { global: true })))).toEqual([
      refusal("maintenance-typed-target-unasked", `${at}/confirmation`),
    ]);
    expect(refusalsFor(maintained(respec(2, { perEntity: false, global: true })))).toEqual([
      refusal("maintenance-typed-target-unasked", `${at}/confirmation`),
      refusal("maintenance-preview-unplaced", `${at}/preview`),
    ]);
    expect(refusalsFor(maintained(respec(2, { perEntity: false, global: false })))).toEqual([
      refusal("maintenance-spec-unplaced", at),
      refusal("maintenance-typed-target-unasked", `${at}/confirmation`),
      refusal("maintenance-preview-unplaced", `${at}/preview`),
    ]);
  });

  test("a maintenance preview no per-row control shows is refused as maintenance-preview-unplaced", () => {
    expect(refusalsFor(maintained(respec(1, { preview: true })))).toEqual([
      refusal("maintenance-preview-unplaced", `${MAINTENANCE_SPECS}/1/preview`),
    ]);
    expect(refusalsFor(maintained(respec(0, { preview: true })))).toEqual([]);
  });

  test("an agent reading whose monitoring panel the engine does not offer is refused as agent-reading-panel-not-offered", () => {
    const changed = manifest((m) => (facetsOf(m).agentReadings = ["sessions", "health", "storage"]));
    const [first] = refusalsFor(changed);

    expect(refusalsFor(changed)).toEqual([
      refusal("agent-reading-panel-not-offered", "/engines/0/facets/agentReadings/0"),
      refusal("agent-reading-panel-not-offered", "/engines/0/facets/agentReadings/2"),
    ]);
    expect(refusalSentence(first as ManifestRefusal)).toBe(
      "The agent reading at /engines/0/facets/agentReadings/0 is read through a monitoring panel the engine does not offer.",
    );
  });

  test("the health reading and a reading whose panel the engine offers are admitted", () => {
    const panelsOff = manifest((m) => {
      for (const panel of Object.keys(facetsOf(m).monitoring)) facetsOf(m).monitoring[panel] = "not-offered";
      facetsOf(m).agentReadings = ["health"];
    });
    const offered = manifest((m) => {
      Object.assign(facetsOf(m).monitoring, { activeSessions: "offered", slowQueries: "offered", tables: "offered" });
      Object.assign(facetsOf(m).monitoring, { indexes: "offered", storage: "offered" });
      facetsOf(m).agentReadings = ["sessions", "slow-queries", "table-stats", "index-stats", "storage", "health"];
    });

    expect(refusalsFor(panelsOff)).toEqual([]);
    expect(refusalsFor(offered)).toEqual([]);
  });

  test("an engine that speaks a statement language with no agent overlay is refused as agent-overlay-missing", () => {
    const changed = kafkaManifest();
    agentOf(changed).overlay = null;

    expect(refusalsFor(changed)).toEqual([refusal("agent-overlay-missing", OVERLAY)]);
  });

  test("an agent overlay on an engine that speaks no statement language is refused as agent-overlay-unspoken", () => {
    const changed = manifest((m) => (agentOf(m).overlay = { dialect: null, grounding: null }));

    expect(refusalsFor(changed)).toEqual([refusal("agent-overlay-unspoken", OVERLAY)]);
  });

  test("an SQL engine with no dialect is refused as agent-dialect-missing", () => {
    const changed = dialected((m) => (agentOf(m).overlay.dialect = null));

    expect(refusalsFor(changed)).toEqual([refusal("agent-dialect-missing", DIALECT)]);
  });

  test("a dialect on an engine of another family is refused as agent-dialect-unspoken", () => {
    const changed = kafkaManifest();
    agentOf(changed).overlay.dialect = sqlDialect();

    expect(refusalsFor(changed)).toEqual([refusal("agent-dialect-unspoken", DIALECT)]);
  });

  test("a statistics reading without a catalog read is refused as statistics-without-catalog-read", () => {
    const changed = dialected((m) => (sqlDialectOf(m).catalogRead = null));
    const composesNone = dialected((m) =>
      Object.assign(sqlDialectOf(m), { catalogRead: null, statistics: null, catalogCapture: null }),
    );

    expect(refusalsFor(changed)).toEqual([
      refusal("catalog-capture-without-catalog-read", `${DIALECT}/catalogCapture`),
      refusal("statistics-without-catalog-read", `${DIALECT}/statistics`),
    ]);
    expect(refusalsFor(composesNone)).toEqual([]);
  });

  test("a catalog capture without a catalog read is refused as catalog-capture-without-catalog-read", () => {
    const changed = dialected((m) => Object.assign(sqlDialectOf(m), { catalogRead: null, statistics: null }));

    expect(refusalsFor(changed)).toEqual([
      refusal("catalog-capture-without-catalog-read", `${DIALECT}/catalogCapture`),
    ]);
  });

  test("a kind word given twice is refused as capture-kind-word-duplicate, at the later one", () => {
    const KIND_WORDS = `${DIALECT}/catalogCapture/kindWords`;
    const repeated = dialected((m) => sqlDialectOf(m).catalogCapture.kindWords.push({ word: "r", kind: "view" }));
    const sharedKind = dialected((m) => sqlDialectOf(m).catalogCapture.kindWords.push({ word: "p", kind: "table" }));

    expect(refusalsFor(repeated)).toEqual([refusal("capture-kind-word-duplicate", `${KIND_WORDS}/3/word`)]);
    expect(refusalsFor(sharedKind)).toEqual([]);
  });

  test("an estimating prefix that executes the plan is refused as plan-estimate-prefix-executes", () => {
    const prefixed = (prefix: string) => dialected((m) => (sqlDialectOf(m).planEstimate = { kind: "prefix", prefix }));

    for (const prefix of ["EXPLAIN ANALYZE", "EXPLAIN analyse", "EXPLAIN (ANALYZE, FORMAT JSON)"]) {
      expect(refusalsFor(prefixed(prefix))).toEqual([
        refusal("plan-estimate-prefix-executes", `${DIALECT}/planEstimate/prefix`),
      ]);
    }
    expect(refusalsFor(prefixed("EXPLAIN ANALYZED"))).toEqual([]);
  });

  test("a profile type pattern that does not compile is refused as pattern-invalid", () => {
    const PROFILE = `${DIALECT}/profileComposition`;
    const changed = dialected((m) => {
      sqlDialectOf(m).profileComposition.incomparableType.source = "(";
      sqlDialectOf(m).profileComposition.uncountableType.source = "[";
    });

    expect(refusalsFor(changed)).toEqual([
      refusal("pattern-invalid", `${PROFILE}/incomparableType/source`),
      refusal("pattern-invalid", `${PROFILE}/uncountableType/source`),
    ]);
  });

  test("a sign-in shaped like Snowflake's is admitted", () => {
    expect(refusalsFor(manifest(signInShaped))).toEqual([]);
  });

  test("an engine declaration states its statement language data or null, and the data's name equals its agent statement language", () => {
    const named = (agentLanguage: string, dataName: string) => {
      const changed = kafkaManifest();
      agentOf(changed).statementLanguage = agentLanguage;
      changed.engines[0].statementLanguageData = languageData(dataName);
      return changed;
    };
    const lacking = manifest((m) => delete m.engines[0].statementLanguageData);
    const unspoken = manifest((m) => (m.engines[0].statementLanguageData = languageData("acmeql")));

    for (const admitted of [
      manifest(),
      kafkaManifest(),
      named("kafkaread", "kafkaread"),
      named("acmeql", "acmeql"),
      unspoken,
    ]) {
      expect(refusalsFor(admitted)).toEqual([]);
      expect(validator.validateEngine(admitted.engines[0]).admitted).toBe(true);
    }
    expect(refusalsFor(lacking)).toEqual([refusal("missing-key", "/engines/0", "statementLanguageData")]);
    expect(refusalsFor(manifest((m) => (m.engines[0].statementLanguageData = "acmeql")))).toEqual([
      refusal("wrong-type", LANGUAGE_DATA),
    ]);
    expect(refusalsFor(named("acmeql", "otherql"))).toEqual([
      refusal("statement-language-name-differs", `${LANGUAGE_DATA}/name`),
    ]);
    expect(refusalsFor(named("kafkaread", "acmeql"))).toEqual([
      refusal("statement-language-name-differs", `${LANGUAGE_DATA}/name`),
    ]);
  });

  test("the statement language name is a form, not Studio's list", () => {
    const schema = JSON.parse(SCHEMA_BYTES.toString("utf8"));
    const spoken = (name: string) => {
      const changed = kafkaManifest();
      agentOf(changed).statementLanguage = name;
      return changed;
    };
    const data = (name: string) => manifest((m) => (m.engines[0].statementLanguageData = languageData(name)));

    expect(schema.$defs.statementLanguage.enum).toBeUndefined();
    expect(schema.$defs.statementLanguage.pattern).toBe(schema.$defs.fenceTag.pattern);
    expect(schema.$defs.statementLanguageName.pattern).toBe(schema.$defs.fenceTag.pattern);
    for (const name of ["acmeql", "q", `a${"b".repeat(31)}`, "kafkaread"]) {
      expect(refusalsFor(spoken(name))).toEqual([]);
    }
    for (const name of ["acmeql", "q", `a${"b".repeat(31)}`]) expect(refusalsFor(data(name))).toEqual([]);
    for (const name of ["AcmeQL", "1ql", `a${"b".repeat(32)}`, "", "acme-ql", "acme ql"]) {
      expect(refusalsFor(spoken(name))).toEqual([refusal("pattern-mismatch", "/engines/0/agent/statementLanguage")]);
      expect(refusalsFor(data(name))).toEqual([refusal("pattern-mismatch", `${LANGUAGE_DATA}/name`)]);
    }
  });

  test("statement language data named after the SQL family is refused at its name, since an engine that speaks SQL states null", () => {
    const sqlSpoken = dialected((m) => (m.engines[0].statementLanguageData = languageData("sql")));
    const sqlUnspoken = manifest((m) => (m.engines[0].statementLanguageData = languageData("sql")));

    expect(refusalsFor(dialected(() => {}))).toEqual([]);
    expect(refusalsFor(sqlSpoken)).toEqual([refusal("statement-language-data-sql", `${LANGUAGE_DATA}/name`)]);
    expect(refusalsFor(sqlUnspoken)).toEqual([refusal("statement-language-data-sql", `${LANGUAGE_DATA}/name`)]);
  });

  test("a reader kind that names no operation lists no operation", () => {
    const listing = manifest((m) => {
      m.engines[0].statementLanguageData = languageData("acmeql");
      confirmationOf(m).operations = ["drop", "lease revoke"];
    });

    expect(refusalsFor(listing)).toEqual([refusal("confirmation-operations-unread", `${CONFIRMATION}/operations`)]);
    expect(refusalsFor(manifest((m) => (m.engines[0].statementLanguageData = languageData("acmeql"))))).toEqual([]);
  });

  test("a statement language's agent part states its request form as data: a bound in characters, the closed key set, each key's value rule, the keys each read requires or refuses, and each refusal's code and sentence, and names no function", () => {
    const AGENT = `${LANGUAGE_DATA}/agent`;
    const COMMON_RULE = `${REQUEST}/common/0/rule`;
    const NAME_RULE = `${REQUEST}/reads/0/checks/0/rule`;
    const ENUMERATION_RULE = `${REQUEST}/reads/0/checks/1/rule`;

    for (const admitted of [
      requestManifest(),
      requestManifest((r) =>
        Object.assign(r.reads[1].checks[0].rule, {
          characters: [{ from: "\u{1F600}", to: "\u{1F64F}" }],
          refused: [{ names: ["\u{1F600}"], prefixes: ["\u{1F64F}\u{1F600}"], refusal: requestRefusal("withheld") }],
        }),
      ),
      requestManifest((r) => Object.assign(r, { maxCharacters: 65536, selector: null, reads: [], keys: ["limit"] })),
      requestManifest((r) => (r.common[0].rule.minimum = -9007199254740991)),
      requestManifest((r) => (r.common[0].rule = { ...r.common[0].rule, minimum: 7, maximum: 7, default: 7 })),
    ]) {
      expect(refusalsFor(admitted)).toEqual([]);
      expect(validator.validateEngine(admitted.engines[0]).admitted).toBe(true);
    }

    for (const key of ["kind", "maxCharacters", "refusals", "keys", "selector", "common", "reads"]) {
      expect(refusalsFor(requestManifest((r) => delete r[key]))).toEqual([refusal("missing-key", REQUEST, key)]);
    }
    for (const key of ["tooLong", "empty", "notAnObject", "repeatedKey", "unknownKey"]) {
      expect(refusalsFor(requestManifest((r) => delete r.refusals[key]))).toEqual([
        refusal("missing-key", `${REQUEST}/refusals`, key),
      ]);
    }
    for (const key of ["code", "sentence"]) {
      expect(refusalsFor(requestManifest((r) => delete r.refusals.empty[key]))).toEqual([
        refusal("missing-key", `${REQUEST}/refusals/empty`, key),
      ]);
    }
    for (const key of ["key", "refusal"]) {
      expect(refusalsFor(requestManifest((r) => delete r.selector[key]))).toEqual([
        refusal("missing-key", `${REQUEST}/selector`, key),
      ]);
      expect(refusalsFor(requestManifest((r) => delete r.reads[0].refuses[0][key]))).toEqual([
        refusal("missing-key", `${REQUEST}/reads/0/refuses/0`, key),
      ]);
    }
    for (const key of ["value", "refuses", "checks"]) {
      expect(refusalsFor(requestManifest((r) => delete r.reads[0][key]))).toEqual([
        refusal("missing-key", `${REQUEST}/reads/0`, key),
      ]);
    }
    for (const key of ["key", "absent", "rule"]) {
      expect(refusalsFor(requestManifest((r) => delete r.common[0][key]))).toEqual([
        refusal("missing-key", `${REQUEST}/common/0`, key),
      ]);
    }
    const lackingRequest = requestManifest();
    delete lackingRequest.engines[0].statementLanguageData.agent.request;
    expect(refusalsFor(lackingRequest)).toEqual([refusal("missing-key", AGENT, "request")]);

    // A value rule is one of three shapes, so a rule lacking a member, or holding a stray one, has none of them.
    for (const key of ["kind", "minimum", "maximum", "default", "refusal"]) {
      expect(refusalsFor(requestManifest((r) => delete r.common[0].rule[key]))).toEqual([
        refusal("no-variant", COMMON_RULE),
      ]);
    }
    for (const key of ["characters", "minLength", "maxLength", "refused", "refusal"]) {
      expect(refusalsFor(requestManifest((r) => delete r.reads[0].checks[0].rule[key]))).toEqual([
        refusal("no-variant", NAME_RULE),
      ]);
    }
    for (const key of ["values", "refusal"]) {
      expect(refusalsFor(requestManifest((r) => delete r.reads[0].checks[1].rule[key]))).toEqual([
        refusal("no-variant", ENUMERATION_RULE),
      ]);
    }
    expect(refusalsFor(requestManifest((r) => delete r.reads[0].checks[0].rule.characters[0].to))).toEqual([
      refusal("no-variant", NAME_RULE),
    ]);
    for (const key of ["names", "prefixes", "refusal"]) {
      expect(refusalsFor(requestManifest((r) => delete r.reads[0].checks[0].rule.refused[0][key]))).toEqual([
        refusal("no-variant", NAME_RULE),
      ]);
    }
    for (const stray of ["pattern", "reader", "regex"]) {
      expect(refusalsFor(requestManifest((r) => (r.reads[0].checks[0].rule[stray] = "^[a-z]+$")))).toEqual([
        refusal("no-variant", NAME_RULE),
      ]);
    }
    expect(refusalsFor(requestManifest((r) => (r.common[0].rule.kind = "pattern")))).toEqual([
      refusal("no-variant", COMMON_RULE),
    ]);
    for (const key of ["reader", "pattern", "read"]) {
      expect(refusalsFor(requestManifest((r) => (r[key] = "readRequest")))).toEqual([
        refusal("unknown-key", REQUEST, key),
      ]);
    }
    const strayAgent = requestManifest();
    strayAgent.engines[0].statementLanguageData.agent.reader = "readRequest";
    expect(refusalsFor(strayAgent)).toEqual([refusal("unknown-key", AGENT, "reader")]);

    expect(refusalsFor(requestManifest((r) => (r.kind = "command-line")))).toEqual([
      refusal("value-not-allowed", `${REQUEST}/kind`),
    ]);
    for (const bound of [0, 65537]) {
      expect(refusalsFor(requestManifest((r) => (r.maxCharacters = bound)))).toEqual([
        refusal("out-of-range", `${REQUEST}/maxCharacters`),
      ]);
    }
    expect(refusalsFor(requestManifest((r) => (r.maxCharacters = 1.5)))).toEqual([
      refusal("wrong-type", `${REQUEST}/maxCharacters`),
    ]);
    for (const code of ["Empty", "1empty", "empty-", "empty--key", "empty key"]) {
      expect(refusalsFor(requestManifest((r) => (r.refusals.empty.code = code)))).toEqual([
        refusal("pattern-mismatch", `${REQUEST}/refusals/empty/code`),
      ]);
    }
    expect(refusalsFor(requestManifest((r) => (r.refusals.empty.code = "e".repeat(33))))).toEqual([
      refusal("out-of-range", `${REQUEST}/refusals/empty/code`),
    ]);
    for (const sentence of ["Two\nlines.", "A\ttab.", "A\u0000nul."]) {
      expect(refusalsFor(requestManifest((r) => (r.refusals.empty.sentence = sentence)))).toEqual([
        refusal("pattern-mismatch", `${REQUEST}/refusals/empty/sentence`),
      ]);
    }
    for (const sentence of ["", "s".repeat(4097)]) {
      expect(refusalsFor(requestManifest((r) => (r.refusals.empty.sentence = sentence)))).toEqual([
        refusal("out-of-range", `${REQUEST}/refusals/empty/sentence`),
      ]);
    }
    for (const key of ["__proto__", "constructor-", "Read", "1read", "re ad", `r${"e".repeat(64)}`]) {
      expect(refusalsFor(requestManifest((r) => r.keys.push(key)))).toEqual([
        refusal("pattern-mismatch", `${REQUEST}/keys/5`),
      ]);
    }
    expect(refusalsFor(requestManifest((r) => r.keys.push("read")))).toEqual([
      refusal("duplicate", `${REQUEST}/keys/5`),
    ]);
    expect(refusalsFor(requestManifest((r) => (r.keys = [])))).toEqual([refusal("too-few", `${REQUEST}/keys`)]);
    for (const value of ["", "v".repeat(65)]) {
      expect(refusalsFor(requestManifest((r) => (r.reads[0].value = value)))).toEqual([
        refusal("out-of-range", `${REQUEST}/reads/0/value`),
      ]);
    }
    expect(refusalsFor(requestManifest((r) => (r.common[0].absent = "required")))).toEqual([
      refusal("no-variant", `${REQUEST}/common/0/absent`),
    ]);
  });

  test("a refusal's sentence holds no control character and no character that makes text read other than it is written", () => {
    const SENTENCE = `${REQUEST}/refusals/empty/sentence`;
    const sentenceManifest = (sentence: string) => requestManifest((r) => (r.refusals.empty.sentence = sentence));

    for (const [name, character] of [
      ["DEL", "\u007f"],
      ["the first C1 control", "\u0080"],
      ["the last C1 control", "\u009f"],
      ["the line separator", "\u2028"],
      ["the paragraph separator", "\u2029"],
      ["the first bidi embedding", "\u202a"],
      ["the last bidi override", "\u202e"],
      ["the first bidi isolate", "\u2066"],
      ["the last bidi isolate", "\u2069"],
      ["the left-to-right mark", "\u200e"],
      ["the right-to-left mark", "\u200f"],
      ["the Arabic letter mark", "\u061c"],
    ]) {
      expect(refusalsFor(sentenceManifest(`The request holds ${name}: ${character}.`))).toEqual([
        refusal("pattern-mismatch", SENTENCE),
      ]);
    }

    for (const ordinary of [
      "Die Anfrage f\u00fcr \u201eStra\u00dfe\u201c ist abgelehnt: bitte sp\u00e4ter erneut, danke!",
      "La requ\u00eate \u00ab caf\u00e9 \u00bb est refus\u00e9e (essayez encore ; merci).",
      "No-break\u00a0space, \u2027 and \u202f and \u2065 and \u206a sit beside the refused ranges.",
    ]) {
      expect(refusalsFor(sentenceManifest(ordinary))).toEqual([]);
    }
  });

  test("a request form that does not rule every key of every read exactly once is refused at the key or read that breaks it", () => {
    const limitCheck = (key: string): Json => ({
      key,
      absent: null,
      rule: { kind: "integer", minimum: 1, maximum: 9, default: null, refusal: requestRefusal("limit") },
    });

    expect(refusalsFor(requestManifest((r) => r.common.push(limitCheck("nope"))))).toEqual([
      refusal("request-key-undeclared", `${REQUEST}/common/1/key`),
    ]);
    expect(refusalsFor(requestManifest((r) => (r.reads[0].refuses[0].key = "nope")))).toEqual([
      refusal("request-key-unruled", `${REQUEST}/reads/0`),
      refusal("request-key-undeclared", `${REQUEST}/reads/0/refuses/0/key`),
    ]);
    expect(refusalsFor(requestManifest((r) => r.reads[1].checks.push(limitCheck("nope"))))).toEqual([
      refusal("request-key-undeclared", `${REQUEST}/reads/1/checks/2/key`),
    ]);
    expect(
      refusalsFor(
        requestManifest((r) =>
          Object.assign(r, { keys: ["topic", "after", "limit", "mode"], selector: { ...r.selector, key: "nope" } }),
        ),
      ),
    ).toEqual([refusal("request-key-undeclared", `${REQUEST}/selector/key`)]);

    expect(refusalsFor(requestManifest((r) => r.reads[1].checks.pop()))).toEqual([
      refusal("request-key-unruled", `${REQUEST}/reads/1`),
    ]);
    expect(
      refusalsFor(requestManifest((r) => Object.assign(r, { keys: ["limit", "mode"], selector: null, reads: [] }))),
    ).toEqual([refusal("request-key-unruled", `${REQUEST}/keys/1`)]);

    expect(refusalsFor(requestManifest((r) => r.common.push(limitCheck("read"))))).toEqual([
      refusal("request-key-ruled-twice", `${REQUEST}/common/1/key`),
    ]);
    expect(refusalsFor(requestManifest((r) => r.common.push(limitCheck("limit"))))).toEqual([
      refusal("request-key-ruled-twice", `${REQUEST}/common/1/key`),
    ]);
    expect(
      refusalsFor(requestManifest((r) => r.reads[0].refuses.push({ key: "after", refusal: requestRefusal("a") }))),
    ).toEqual([refusal("request-key-ruled-twice", `${REQUEST}/reads/0/checks/0/key`)]);
    expect(refusalsFor(requestManifest((r) => r.reads[1].checks.push(limitCheck("after"))))).toEqual([
      refusal("request-key-ruled-twice", `${REQUEST}/reads/1/checks/2/key`),
    ]);
    expect(
      refusalsFor(requestManifest((r) => r.reads[1].refuses.push({ key: "read", refusal: requestRefusal("a") }))),
    ).toEqual([refusal("request-key-ruled-twice", `${REQUEST}/reads/1/refuses/1/key`)]);

    expect(refusalsFor(requestManifest((r) => (r.reads[1].value = "topics")))).toEqual([
      refusal("request-read-duplicate", `${REQUEST}/reads/1/value`),
    ]);
    expect(refusalsFor(requestManifest((r) => (r.reads = [])))).toEqual([
      refusal("request-reads-without-selector", `${REQUEST}/reads`),
    ]);
    expect(refusalsFor(requestManifest((r) => (r.selector = null)))).toEqual([
      refusal("request-key-unruled", `${REQUEST}/keys/0`),
      refusal("request-key-unruled", `${REQUEST}/keys/1`),
      refusal("request-key-unruled", `${REQUEST}/keys/2`),
      refusal("request-key-unruled", `${REQUEST}/keys/4`),
      refusal("request-reads-without-selector", `${REQUEST}/reads`),
    ]);
    expect(validator.validateEngine(requestManifest((r) => (r.reads[1].value = "topics")).engines[0])).toEqual({
      admitted: false,
      refusals: [refusal("request-read-duplicate", "/statementLanguageData/agent/request/reads/1/value")],
    });
  });

  test("an integer rule whose range is empty or whose default is outside it, and a name rule whose character range is reversed or not one character or whose length range is empty, is refused at its pointer", () => {
    const INTEGER = `${REQUEST}/common/0/rule`;
    const NAME = `${REQUEST}/reads/1/checks/0/rule`;

    expect(refusalsFor(requestManifest((r) => (r.common[0].rule.minimum = 501)))).toEqual([
      refusal("request-integer-default-outside", `${INTEGER}/default`),
      refusal("request-integer-range-empty", `${INTEGER}/minimum`),
    ]);
    for (const outside of [0, 501]) {
      expect(refusalsFor(requestManifest((r) => (r.common[0].rule.default = outside)))).toEqual([
        refusal("request-integer-default-outside", `${INTEGER}/default`),
      ]);
    }
    expect(refusalsFor(requestManifest((r) => (r.common[0].rule.minimum = 10000000000000000)))).toEqual([
      refusal("no-variant", INTEGER),
    ]);

    expect(
      refusalsFor(requestManifest((r) => (r.reads[1].checks[0].rule.characters[0] = { from: "z", to: "a" }))),
    ).toEqual([refusal("request-name-range-reversed", `${NAME}/characters/0`)]);
    for (const [from, to, pointer] of [
      ["\ud800", "z", "from"],
      ["a", "\udfff", "to"],
    ] as const) {
      expect(refusalsFor(requestManifest((r) => (r.reads[1].checks[0].rule.characters[0] = { from, to })))).toEqual([
        refusal("request-name-range-not-one-character", `${NAME}/characters/0/${pointer}`),
      ]);
    }
    for (const two of ["ab", ""]) {
      expect(refusalsFor(requestManifest((r) => (r.reads[1].checks[0].rule.characters[0].from = two)))).toEqual([
        refusal("no-variant", NAME),
      ]);
    }
    expect(refusalsFor(requestManifest((r) => (r.reads[1].checks[0].rule.minLength = 250)))).toEqual([
      refusal("request-name-length-empty", `${NAME}/minLength`),
    ]);
  });

  test("an agent part on an engine whose agent mode sends no statement is refused at the agent part", () => {
    const unspoken = manifest((m) => {
      m.engines[0].statementLanguageData = {
        ...languageData("acmeread"),
        agent: { request: requestForm(), text: agentText() },
      };
    });

    expect(refusalsFor(unspoken)).toEqual([refusal("statement-language-agent-unspoken", `${LANGUAGE_DATA}/agent`)]);
    expect(validator.validateEngine(unspoken.engines[0])).toEqual({
      admitted: false,
      refusals: [refusal("statement-language-agent-unspoken", "/statementLanguageData/agent")],
    });
    expect(refusalsFor(manifest((m) => (m.engines[0].statementLanguageData = languageData("acmeread"))))).toEqual([]);
  });

  test("a statement language's agent part states its text as data: the copy, the investigation's words, the posture, the grounding and the advice, each a text or its parts with the values Studio fills, and names no function", () => {
    const AGENT = `${LANGUAGE_DATA}/agent`;
    const members: readonly (readonly [string, readonly string[]])[] = [
      ["copy", ["subject", "noun", "writes", "reached", "defect"]],
      ["investigation", ["classifierDescription", "objective", "toolDescription", "toolRule"]],
      ["posture", ["qualifier", "title", "body", "handover"]],
      ["grounding", ["omissionAdvice", "ungrounded"]],
      ["advice", ["rowCap", "shape"]],
    ];
    const plain = (text: Json) => {
      for (const [group, names] of members) for (const name of names) text[group][name] = `The ${group} ${name}.`;
    };

    for (const admitted of [
      agentManifest(),
      textManifest(plain),
      textManifest((t) => (t.copy.subject = "s".repeat(8192))),
      textManifest((t) => (t.copy.subject = Array.from({ length: 64 }, (_, index) => `part ${index} `))),
      textManifest((t) => (t.posture.title = [{ fill: "rows" }])),
    ]) {
      expect(refusalsFor(admitted)).toEqual([]);
      expect(validator.validateEngine(admitted.engines[0]).admitted).toBe(true);
    }

    const lackingText = agentManifest((a) => delete a.text);
    expect(refusalsFor(lackingText)).toEqual([refusal("missing-key", AGENT, "text")]);
    expect(validator.validateEngine(lackingText.engines[0])).toEqual({
      admitted: false,
      refusals: [refusal("missing-key", "/statementLanguageData/agent", "text")],
    });
    for (const [group, names] of members) {
      expect(refusalsFor(textManifest((t) => delete t[group]))).toEqual([refusal("missing-key", TEXT, group)]);
      for (const name of names) {
        expect(refusalsFor(textManifest((t) => delete t[group][name]))).toEqual([
          refusal("missing-key", `${TEXT}/${group}`, name),
        ]);
      }
    }

    // No member names a function or a value Studio composes: a stray one is refused, never read.
    for (const [group, stray] of [
      ["copy", "readPast"],
      ["copy", "argument"],
      ["advice", "fingerprint"],
      ["investigation", "verifier"],
    ] as const) {
      expect(refusalsFor(textManifest((t) => (t[group][stray] = "readPastRows")))).toEqual([
        refusal("unknown-key", `${TEXT}/${group}`, stray),
      ]);
    }
    expect(refusalsFor(textManifest((t) => (t.describe = "describeTool")))).toEqual([
      refusal("unknown-key", TEXT, "describe"),
    ]);

    // A text is a string or a list of parts, so anything else in either shape has neither shape.
    const SUBJECT = `${TEXT}/copy/subject`;
    for (const unlike of [
      "",
      "s".repeat(8193),
      [],
      Array.from({ length: 65 }, () => "part"),
      [""],
      ["s".repeat(8193)],
      [5],
      [{ read: "topics" }],
      [{ fill: "rows", read: "topics" }],
      [{}],
      [{ fill: "Rows" }],
      [{ fill: "1rows" }],
      [{ fill: "row_count" }],
      [{ fill: `r${"o".repeat(32)}` }],
      [{ fill: 5 }],
      5,
      null,
      { fill: "rows" },
    ]) {
      expect(refusalsFor(textManifest((t) => (t.copy.subject = unlike)))).toEqual([refusal("no-variant", SUBJECT)]);
    }
  });

  test("a declared text naming a value Studio does not fill into it is refused by name at the fill's pointer", () => {
    expect(AGENT_TEXT_FILLS).toEqual({
      copy: { subject: [], noun: [], writes: [], reached: [], defect: [] },
      investigation: { classifierDescription: [], objective: [], toolDescription: [], toolRule: [] },
      posture: {
        qualifier: ["rows", "seconds"],
        title: ["rows", "seconds"],
        body: ["rows", "seconds"],
        handover: ["rows", "seconds"],
      },
      grounding: { omissionAdvice: [], ungrounded: ["noun"] },
      advice: { rowCap: ["allowed"], shape: [] },
    });
    // The exported table is frozen whole: the table, each group and each text's list of fills.
    expect(Object.isFrozen(AGENT_TEXT_FILLS)).toBe(true);
    for (const texts of Object.values(AGENT_TEXT_FILLS)) {
      expect(Object.isFrozen(texts)).toBe(true);
      for (const fills of Object.values(texts as Record<string, readonly string[]>)) {
        expect(Object.isFrozen(fills)).toBe(true);
      }
    }
    // The table names every text of the schema, and no other.
    const definitions = JSON.parse(SCHEMA_BYTES.toString("utf8")).$defs;
    const groups = definitions.agentLanguageText.properties as Record<string, { $ref: string }>;
    expect(Object.keys(groups)).toEqual(Object.keys(AGENT_TEXT_FILLS));
    for (const [group, { $ref }] of Object.entries(groups)) {
      const definition = definitions[$ref.slice("#/$defs/".length)];
      expect(Object.keys(definition.properties)).toEqual(
        Object.keys(AGENT_TEXT_FILLS[group as keyof typeof AGENT_TEXT_FILLS]),
      );
    }

    // Every fill a text takes is admitted in it.
    for (const [group, texts] of Object.entries(AGENT_TEXT_FILLS)) {
      for (const [name, fills] of Object.entries(texts as Record<string, readonly string[]>)) {
        const filled = textManifest((t) => (t[group][name] = ["Read ", ...fills.map((fill) => ({ fill })), "."]));
        expect(refusalsFor(filled)).toEqual([]);
      }
    }

    expect(refusalsFor(textManifest((t) => (t.copy.subject = [{ fill: "rows" }])))).toEqual([
      refusal("agent-text-fill-unknown", `${TEXT}/copy/subject/0/fill`),
    ]);
    expect(
      refusalsFor(
        textManifest((t) => (t.posture.body = ["Bounded to ", { fill: "rows" }, " by ", { fill: "allowed" }])),
      ),
    ).toEqual([refusal("agent-text-fill-unknown", `${TEXT}/posture/body/3/fill`)]);
    expect(
      refusalsFor(
        textManifest((t) => {
          t.grounding.ungrounded = [{ fill: "engines" }, " and ", { fill: "noun" }];
          t.advice.rowCap = [{ fill: "seconds" }];
          t.investigation.toolDescription = ["Limits: ", { fill: "limits" }];
        }),
      ),
    ).toEqual([
      refusal("agent-text-fill-unknown", `${TEXT}/advice/rowCap/0/fill`),
      refusal("agent-text-fill-unknown", `${TEXT}/grounding/ungrounded/0/fill`),
      refusal("agent-text-fill-unknown", `${TEXT}/investigation/toolDescription/1/fill`),
    ]);
    const unknown = textManifest((t) => (t.copy.noun = [{ fill: "shown" }]));
    expect(validator.validateEngine(unknown.engines[0])).toEqual({
      admitted: false,
      refusals: [refusal("agent-text-fill-unknown", "/statementLanguageData/agent/text/copy/noun/0/fill")],
    });
    expect(refusalSentence(refusalsFor(unknown)[0] as ManifestRefusal)).toBe(
      `The fill at ${TEXT}/copy/noun/0/fill names a value Studio does not fill into that text.`,
    );
  });

  test("an agent text holds no control character and no character that makes text read other than it is written", () => {
    const SUBJECT = `${TEXT}/copy/subject`;
    const BODY = `${TEXT}/posture/body`;

    for (const [name, character] of [
      ["a line feed", "\u000a"],
      ["a tab", "\u0009"],
      ["NUL", "\u0000"],
      ["DEL", "\u007f"],
      ["the next line control", "\u0085"],
      ["the line separator", "\u2028"],
      ["the paragraph separator", "\u2029"],
      ["the right-to-left override", "\u202e"],
      ["the left-to-right isolate", "\u2066"],
      ["the right-to-left mark", "\u200f"],
      ["the Arabic letter mark", "\u061c"],
    ]) {
      expect(refusalsFor(textManifest((t) => (t.copy.subject = `The subject holds ${name}: ${character}.`)))).toEqual([
        refusal("no-variant", SUBJECT),
      ]);
      expect(
        refusalsFor(textManifest((t) => (t.posture.body = ["Bounded to ", { fill: "rows" }, ` rows${character}`]))),
      ).toEqual([refusal("no-variant", BODY)]);
    }

    for (const ordinary of [
      "Die Anfrage für „Straße“ ist abgelehnt.",
      "No-break space, ‧ and   and ⁥ and ⁪ sit beside the refused ranges.",
      'A JSON request such as {"read": "topics", "limit": 50} is written as it reads.',
    ]) {
      expect(refusalsFor(textManifest((t) => (t.copy.subject = ordinary)))).toEqual([]);
    }
  });

  test("a name rule's refused name or prefix that no admitted name could hold is refused at its pointer", () => {
    const NAME = `${REQUEST}/reads/1/checks/0/rule`;
    const refusedOf = (r: Json): Json => r.reads[1].checks[0].rule.refused;

    for (const [names, prefixes, pointer] of [
      [["Internal"], [], "names/0"],
      [["internal", "a\ud800"], [], "names/1"],
      [["\u{1F600}"], [], "names/0"],
      [["x".repeat(250)], [], "names/0"],
      [[], ["\ud800"], "prefixes/0"],
      [[], ["_", "A"], "prefixes/1"],
      [[], ["x".repeat(250)], "prefixes/0"],
    ] as const) {
      expect(
        refusalsFor(
          requestManifest((r) => (refusedOf(r)[0] = { names, prefixes, refusal: requestRefusal("internal") })),
        ),
      ).toEqual([refusal("request-name-refused-unreachable", `${NAME}/refused/0/${pointer}`)]);
    }
    // A name of the least length and a prefix of the greatest are reachable, so both are admitted.
    expect(
      refusalsFor(
        requestManifest((r) => {
          r.reads[1].checks[0].rule.minLength = 2;
          refusedOf(r)[0] = { names: ["ab"], prefixes: ["x".repeat(249)], refusal: requestRefusal("internal") };
        }),
      ),
    ).toEqual([]);
    expect(
      refusalsFor(requestManifest((r) => (r.reads[1].checks[0].rule.minLength = 9))).map(
        (item) => (item as SchemaRefusal).pointer,
      ),
    ).toEqual([`${NAME}/refused/0/names/0`]);
    // A rule whose ranges or length are already refused is not read for its refused names as well.
    expect(
      refusalsFor(requestManifest((r) => (r.reads[1].checks[0].rule.characters[0] = { from: "z", to: "a" }))),
    ).toEqual([refusal("request-name-range-reversed", `${NAME}/characters/0`)]);
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

  test("console calls that leave out transaction are refused as missing-key", () => {
    expect(refusalsFor(manifest((m) => delete m.calls.console.transaction))).toEqual([
      refusal("missing-key", "/calls/console", "transaction"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.console.transaction = "maybe")))).toEqual([
      refusal("value-not-allowed", "/calls/console/transaction"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.console.transaction = "offered")))).toEqual([]);
  });

  test("a request field execute does not know, or one listed twice, is refused", () => {
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["params", "params"])))).toEqual([
      refusal("duplicate", "/calls/console/execute/honours/1"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["rows"])))).toEqual([
      refusal("value-not-allowed", "/calls/console/execute/honours/0"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["params", "offset"])))).toEqual([]);
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["params", "offset", "readOnly"])))).toEqual(
      [],
    );
    expect(refusalsFor(manifest((m) => (m.calls.console.execute.honours = ["readonly"])))).toEqual([
      refusal("value-not-allowed", "/calls/console/execute/honours/0"),
    ]);
  });

  test("a console facet offer outside the vocabulary, or a key the calls segment does not define, is refused", () => {
    expect(refusalsFor(manifest((m) => (m.calls.console.cancel = "maybe")))).toEqual([
      refusal("value-not-allowed", "/calls/console/cancel"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.explain = {})))).toEqual([refusal("unknown-key", "/calls", "explain")]);
    expect(refusalsFor(manifest((m) => (m.calls.console.explain = "offered")))).toEqual([
      refusal("unknown-key", "/calls/console", "explain"),
    ]);
  });
  test("calls that leave out objects, or objects that leave out tree, are refused as missing-key", () => {
    expect(refusalsFor(manifest((m) => delete m.calls.objects))).toEqual([refusal("missing-key", "/calls", "objects")]);
    expect(refusalsFor(manifest((m) => delete m.calls.objects.tree))).toEqual([
      refusal("missing-key", "/calls/objects", "tree"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.objects.source = "offered")))).toEqual([
      refusal("unknown-key", "/calls/objects", "source"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.objects.tree = "maybe")))).toEqual([
      refusal("value-not-allowed", "/calls/objects/tree"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.objects.tree = "offered")))).toEqual([]);
  });
  test("calls that leave out maintenance, or maintenance that leaves out run or preview, are refused as missing-key", () => {
    expect(refusalsFor(manifest((m) => delete m.calls.maintenance))).toEqual([
      refusal("missing-key", "/calls", "maintenance"),
    ]);
    expect(refusalsFor(manifest((m) => delete m.calls.maintenance.run))).toEqual([
      refusal("missing-key", "/calls/maintenance", "run"),
    ]);
    expect(refusalsFor(manifest((m) => delete m.calls.maintenance.preview))).toEqual([
      refusal("missing-key", "/calls/maintenance", "preview"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.maintenance.explain = "offered")))).toEqual([
      refusal("unknown-key", "/calls/maintenance", "explain"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.maintenance.run = "maybe")))).toEqual([
      refusal("value-not-allowed", "/calls/maintenance/run"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.maintenance = { run: "offered", preview: "offered" })))).toEqual([]);
  });
  test("calls that leave out monitoring, or monitoring that leaves out panel or poolStats, are refused as missing-key", () => {
    expect(refusalsFor(manifest((m) => delete m.calls.monitoring))).toEqual([
      refusal("missing-key", "/calls", "monitoring"),
    ]);
    expect(refusalsFor(manifest((m) => delete m.calls.monitoring.panel))).toEqual([
      refusal("missing-key", "/calls/monitoring", "panel"),
    ]);
    expect(refusalsFor(manifest((m) => delete m.calls.monitoring.poolStats))).toEqual([
      refusal("missing-key", "/calls/monitoring", "poolStats"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.monitoring.sessions = "offered")))).toEqual([
      refusal("unknown-key", "/calls/monitoring", "sessions"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.monitoring.panel = "maybe")))).toEqual([
      refusal("value-not-allowed", "/calls/monitoring/panel"),
    ]);
    expect(refusalsFor(manifest((m) => (m.calls.monitoring = { panel: "offered", poolStats: "offered" })))).toEqual([]);
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

  test("an engine declaration's claims are held to the rules the schema cannot state, at pointers into it", () => {
    const declaration = engine();
    Object.assign(declaration.policy, {
      deniedFileAccessRefusal: DENIED_FILE_ACCESS_REFUSAL,
      readRootsRequired: true,
    });
    Object.assign(declaration.mcp, { statementRead: true, agentCredentialRequired: true });

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("agent-credential-form-missing", "/mcp/agentCredentialRequired"),
        refusal("statement-read-unexposed", "/mcp/statementRead"),
        refusal("denied-file-access-unread", "/policy/deniedFileAccessRefusal"),
        refusal("read-roots-field-undeclared", "/policy/readRootsRequired"),
      ],
    });

    const seeded = kafkaManifest().engines[0] as Json;
    seeded.policy.agentCredentialForm = "token";
    expect(validator.validateEngine(seeded)).toEqual({
      admitted: false,
      refusals: [refusal("agent-credential-seed-form-differs", "/connection/agentCredential/form")],
    });
  });

  test("an engine declaration's safeguards and its new claims are held to their rules, at pointers into it", () => {
    const declaration = kafkaManifest().engines[0] as Json;
    declaration.policy.writeReach = "open";
    declaration.policy.maskingExemptColumns = maskingExemption("address");
    declaration.safeguards.writePaths.editor.proof = null;
    declaration.safeguards.inlineEditRefusedColumns = inlineEditRefusal("(");
    declaration.safeguards.metadataOnly.push(structuredClone(declaration.safeguards.metadataOnly[0]));
    declaration.safeguards.metadataOnly[1].columns.push({ column: "rack", kind: "name" });

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("masking-exemption-unanchored", "/policy/maskingExemptColumns/column"),
        refusal("write-reach-summary-differs", "/policy/writeReach"),
        refusal("pattern-invalid", "/safeguards/inlineEditRefusedColumns/type"),
        refusal("metadata-column-duplicate", "/safeguards/metadataOnly/1/columns/3/column"),
        refusal("metadata-operation-duplicate", "/safeguards/metadataOnly/4/operation"),
        refusal("editor-write-path-unproven", "/safeguards/writePaths/editor/proof"),
      ],
    });
  });

  test("an engine declaration's maintenance specs are held to their rules, at pointers into it", () => {
    const shaped = kafkaManifest();
    withMaintenance(shaped);
    const declaration = shaped.engines[0] as Json;
    declaration.facets.maintenance = ["vacuum", "check", "compact", "kill", "analyze"];
    declaration.facets.maintenanceSpecs.push(maintenanceSpec("kill", "Kill Again", false, false));
    Object.assign(declaration.facets.maintenanceSpecs[0], { perEntity: false, global: false });
    Object.assign(declaration.facets.maintenanceSpecs[1], { preview: true });
    Object.assign(declaration.facets.maintenanceSpecs[3], { title: null });
    Object.assign(declaration.facets.maintenanceSpecs[2], { global: true });

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("maintenance-spec-missing", "/facets/maintenance/4"),
        refusal("maintenance-spec-unplaced", "/facets/maintenanceSpecs/0"),
        refusal("maintenance-preview-unplaced", "/facets/maintenanceSpecs/1/preview"),
        refusal("maintenance-typed-target-unasked", "/facets/maintenanceSpecs/2/confirmation"),
        refusal("maintenance-spec-unlisted", "/facets/maintenanceSpecs/2/operation"),
        refusal("maintenance-typed-confirmation-unasked", "/facets/maintenanceSpecs/3/confirmation"),
        refusal("maintenance-spec-duplicate", "/facets/maintenanceSpecs/5/operation"),
      ],
    });
  });

  test("an engine declaration's agent overlay is held to its rules, at pointers into it", () => {
    const declaration = dialected(() => {}).engines[0] as Json;
    const dialectOf = declaration.agent.overlay.dialect;
    dialectOf.catalogRead = null;
    dialectOf.planEstimate = { kind: "prefix", prefix: "EXPLAIN ANALYZE" };
    dialectOf.profileComposition.incomparableType.source = "(";
    dialectOf.profileComposition.uncountableType.source = "[";
    dialectOf.catalogCapture.kindWords.push({ word: "v", kind: "table" });
    const unspoken = kafkaManifest().engines[0] as Json;
    unspoken.agent.statementLanguage = null;
    const missing = kafkaManifest().engines[0] as Json;
    missing.agent.overlay = null;
    const sqlWithout = dialected(() => {}).engines[0] as Json;
    sqlWithout.agent.overlay.dialect = null;
    const otherWith = kafkaManifest().engines[0] as Json;
    otherWith.agent.overlay.dialect = sqlDialect();

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [
        refusal("catalog-capture-without-catalog-read", "/agent/overlay/dialect/catalogCapture"),
        refusal("capture-kind-word-duplicate", "/agent/overlay/dialect/catalogCapture/kindWords/3/word"),
        refusal("plan-estimate-prefix-executes", "/agent/overlay/dialect/planEstimate/prefix"),
        refusal("pattern-invalid", "/agent/overlay/dialect/profileComposition/incomparableType/source"),
        refusal("pattern-invalid", "/agent/overlay/dialect/profileComposition/uncountableType/source"),
        refusal("statistics-without-catalog-read", "/agent/overlay/dialect/statistics"),
      ],
    });
    expect(validator.validateEngine(unspoken)).toEqual({
      admitted: false,
      refusals: [refusal("agent-overlay-unspoken", "/agent/overlay")],
    });
    expect(validator.validateEngine(missing)).toEqual({
      admitted: false,
      refusals: [refusal("agent-overlay-missing", "/agent/overlay")],
    });
    expect(validator.validateEngine(sqlWithout)).toEqual({
      admitted: false,
      refusals: [refusal("agent-dialect-missing", "/agent/overlay/dialect")],
    });
    expect(validator.validateEngine(otherWith)).toEqual({
      admitted: false,
      refusals: [refusal("agent-dialect-unspoken", "/agent/overlay/dialect")],
    });
  });

  test("an engine declaration's write reach is refused at its own pointer under validateEngine", () => {
    const declaration = kafkaManifest().engines[0] as Json;
    declaration.policy.writeReach = "partial";

    expect(validator.validateEngine(declaration)).toEqual({
      admitted: false,
      refusals: [refusal("value-not-allowed", "/policy/writeReach")],
    });
  });

  test("an engine declaration's statement language data is refused at its own pointer under validateEngine", () => {
    const stated = (name: string, change: (data: Json) => void = () => {}) => {
      const declaration = kafkaManifest().engines[0] as Json;
      declaration.statementLanguageData = languageData(name);
      change(declaration.statementLanguageData);
      return declaration;
    };

    expect(validator.validateEngine(stated("otherql"))).toEqual({
      admitted: false,
      refusals: [refusal("statement-language-name-differs", "/statementLanguageData/name")],
    });
    expect(validator.validateEngine(stated("kafkaread", (d) => (d.confirmation.reader = "parses-statement")))).toEqual({
      admitted: false,
      refusals: [refusal("value-not-allowed", "/statementLanguageData/confirmation/reader")],
    });
    expect(validator.validateEngine(stated("kafkaread", (d) => (d.confirmation.operations = ["drop"])))).toEqual({
      admitted: false,
      refusals: [refusal("confirmation-operations-unread", "/statementLanguageData/confirmation/operations")],
    });
    const sqlData = engine();
    sqlData.statementLanguageData = languageData("sql");
    expect(validator.validateEngine(sqlData)).toEqual({
      admitted: false,
      refusals: [refusal("statement-language-data-sql", "/statementLanguageData/name")],
    });
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

    const sentence = `planted-${randomUUID()} cannot confine file access.`;
    const ruled = manifest((m) => (policyOf(m).deniedFileAccessRefusal = sentence));
    const ruledRefusals = refusalsFor(ruled);

    expect(ruledRefusals).toEqual([refusal("denied-file-access-unread", `${POLICY}/deniedFileAccessRefusal`)]);
    expect(JSON.stringify(ruledRefusals)).not.toContain(sentence);
    for (const item of ruledRefusals) expect(refusalSentence(item)).not.toContain(sentence);

    const formed = kafkaManifest();
    policyOf(formed).agentCredentialForm = "service-account-key";
    const formRefusals = refusalsFor(formed);

    expect(formRefusals).toEqual([
      refusal("agent-credential-seed-form-differs", "/engines/0/connection/agentCredential/form"),
    ]);
    for (const item of formRefusals) {
      for (const value of ["service-account-key", " pair"]) expect(refusalSentence(item)).not.toContain(value);
    }

    const name = randomUUID()
      .replaceAll("-", "")
      .replace(/[0-9]/g, (digit) => "ghijklmnop".charAt(Number(digit)));
    const safeguarded = manifest((m) => {
      policyOf(m).maskingExemptColumns = maskingExemption(name);
      safeguardsOf(m).metadataOnly = [metadataOperation(name, [name]), metadataOperation(name, [name, name])];
    });
    const safeguardRefusals = refusalsFor(safeguarded);

    expect(safeguardRefusals).toEqual([
      refusal("masking-exemption-unanchored", `${POLICY}/maskingExemptColumns/column`),
      refusal("metadata-column-duplicate", `${METADATA_ONLY}/1/columns/1/column`),
      refusal("metadata-operation-duplicate", `${METADATA_ONLY}/1/operation`),
    ]);
    expect(JSON.stringify(safeguardRefusals)).not.toContain(name);
    for (const item of safeguardRefusals) expect(refusalSentence(item)).not.toContain(name);

    const label = `Label ${randomUUID()}`;
    const unlisted = manifest((m) => {
      withMaintenance(m);
      maintenanceSpecsOf(m).push(maintenanceSpec("analyze", label, true, false, { description: label, title: label }));
    });
    const maintenanceRefusals = refusalsFor(unlisted);

    expect(maintenanceRefusals).toEqual([refusal("maintenance-spec-unlisted", `${MAINTENANCE_SPECS}/5/operation`)]);
    expect(JSON.stringify(maintenanceRefusals)).not.toContain(label);
    for (const item of maintenanceRefusals) expect(refusalSentence(item)).not.toContain(label);

    const word = `w${randomUUID().replaceAll("-", "")}`;
    const repeatedWord = dialected((m) => {
      sqlDialectOf(m).catalogCapture.kindWords = [
        { word, kind: "table" },
        { word, kind: "view" },
      ];
    });
    const overlayRefusals = refusalsFor(repeatedWord);

    expect(overlayRefusals).toEqual([
      refusal("capture-kind-word-duplicate", `${DIALECT}/catalogCapture/kindWords/1/word`),
    ]);
    expect(JSON.stringify(overlayRefusals)).not.toContain(word);
    for (const item of overlayRefusals) expect(refusalSentence(item)).not.toContain(word);
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

  test("no statement language data refusal carries the name or the operation it refuses", () => {
    const requested = `q${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const declared = `q${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const operation = `op${randomUUID().replaceAll("-", "")}`;
    const changed = kafkaManifest();
    agentOf(changed).statementLanguage = requested;
    changed.engines[0].statementLanguageData = languageData(declared);
    changed.engines[0].statementLanguageData.confirmation.operations = [operation];

    const refusals = refusalsFor(changed);

    expect(refusals).toEqual([
      refusal("confirmation-operations-unread", `${CONFIRMATION}/operations`),
      refusal("statement-language-name-differs", `${LANGUAGE_DATA}/name`),
    ]);
    for (const item of refusals) {
      for (const value of [requested, declared, operation]) {
        expect(JSON.stringify(item)).not.toContain(value);
        expect(refusalSentence(item)).not.toContain(value);
      }
    }

    const key = `k${randomUUID().replaceAll("-", "")}`;
    const read = `r${randomUUID().replaceAll("-", "")}`;
    const code = `c${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const sentence = `S${randomUUID()}.`;
    const planted = { code, sentence };
    const fill = `f${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const formed = requestManifest((r) => {
      r.reads[0].value = read;
      r.reads[1].value = read;
      r.reads[0].refuses[0] = { key, refusal: planted };
      r.common[0].rule = { kind: "integer", minimum: 9, maximum: 1, default: 5, refusal: planted };
      r.reads[1].checks[0].rule.characters = [
        { from: "\ud800", to: "z" },
        { from: "z", to: "a" },
      ];
      r.reads[1].checks[0].rule.minLength = 300;
      r.reads[1].checks.push({ key: "after", absent: planted, rule: r.common[0].rule });
      r.reads[0].checks[0].rule.refused[0].names = [".", `${key}.`];
    });
    formed.engines[0].statementLanguageData.name = declared;
    formed.engines[0].statementLanguageData.agent.text.copy.subject = [sentence, { fill }];
    Object.assign(agentOf(formed), { statementLanguage: null, overlay: null });

    const formRefusals = refusalsFor(formed);

    expect(new Set(formRefusals.map((item) => (item as SchemaRefusal).rule))).toEqual(
      new Set<SchemaRefusalRule>([
        "request-key-undeclared",
        "request-key-unruled",
        "request-key-ruled-twice",
        "request-read-duplicate",
        "request-integer-range-empty",
        "request-integer-default-outside",
        "request-name-range-reversed",
        "request-name-range-not-one-character",
        "request-name-length-empty",
        "request-name-refused-unreachable",
        "agent-text-fill-unknown",
        "statement-language-agent-unspoken",
      ]),
    );
    for (const item of formRefusals) {
      for (const value of [key, read, code, sentence, declared, fill]) {
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
