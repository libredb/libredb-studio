/**
 * The vector family's content guard (vector-family spec 3.2): the shared modules name no engine and hold no
 * engine's vocabulary, and each exports exactly the symbols listed here.
 *
 * Over the whole text of every file of src/lib/db/vector/ and src/lib/db/console/, code and comments alike, it
 * refuses an engine's name, a vendor's path, and an engine's own spelling of a vector type, a metric or an index.
 * Each spelling matches case-sensitively on word boundaries, so `squared Euclidean` and the lower-case union
 * members `cosine` and `hnsw` pass; an engine's name matches in any case and anywhere, inside an identifier too.
 * The files are every file under the two directories, whatever its depth and extension. The exported symbol set of
 * every file is listed exactly, so a symbol with one reader cannot enter a shared module unnoticed: adding an
 * export is an edit of this list, which a reviewer sees. src/lib/db/utils/server-text.ts, which both providers
 * read, is held to the engine-name rule and to its two exports.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DIRECTORIES = ["src/lib/db/vector", "src/lib/db/console"];
const SERVER_TEXT = "src/lib/db/utils/server-text.ts";

/** In any case and anywhere in the text, inside an identifier included: `isQdrant` names an engine as a comment does. */
const ENGINE_NAMES: readonly RegExp[] = [/milvus/i, /qdrant/i, /zilliz/i];
const VENDOR_PATHS: readonly string[] = ["/v2/vectordb/", "collections/{"];
const NATIVE_SPELLINGS: readonly string[] = [
  "FloatVector",
  "SparseFloatVector",
  "Float16Vector",
  "BFloat16Vector",
  "Int8Vector",
  "BinaryVector",
  "COSINE",
  "Euclid",
  "HNSW",
  "AUTOINDEX",
];

/** Every file's exported symbols, sorted. A change here is a reviewed change to what the shared modules publish. */
const EXPORTS: Readonly<Record<string, readonly string[]>> = {
  "src/lib/db/console/bounds.ts": ["exceedsUtf8Bytes", "utf8ByteLength"],
  "src/lib/db/console/completion.ts": ["RouteCompletion", "routeCompletions", "routeListText"],
  "src/lib/db/console/dialect.ts": [
    "ConsoleDialectSpec",
    "ParamKind",
    "QueryKeySpec",
    "RequestRefusal",
    "RouteClass",
    "RouteSpec",
    "ValidationPhase",
  ],
  "src/lib/db/console/format.ts": ["formatConsole"],
  "src/lib/db/console/guard.ts": ["classifyConsole"],
  "src/lib/db/console/lexer.ts": [
    "ConsoleLineState",
    "ConsoleToken",
    "ConsoleTokenKind",
    "INITIAL_CONSOLE_STATE",
    "consoleLineStatesEqual",
    "tokenizeLine",
  ],
  "src/lib/db/console/parser.ts": [
    "ConsoleRefusal",
    "ConsoleRefusalCode",
    "ConsoleRequest",
    "ConsoleText",
    "consoleTokens",
    "parseConsole",
    "readConsoleBody",
  ],
  "src/lib/db/console/shell-words.ts": [
    "INITIAL_SHELL_LINE_STATE",
    "ShellLineState",
    "ShellQuote",
    "ShellReading",
    "ShellRefusal",
    "ShellRefusalCode",
    "ShellSection",
    "ShellToken",
    "ShellTokenKind",
    "ShellWord",
    "quoteShellWord",
    "readShellCommand",
    "shellLineStatesEqual",
    "tokenizeShellLine",
  ],
  "src/lib/db/console/tagged-json.ts": [
    "IntRange",
    "TaggedFloat",
    "TaggedInt",
    "TaggedJson",
    "TaggedObject",
    "checkIntRange",
    "isTaggedFloat",
    "isTaggedInt",
    "taggedNumber",
    "toJsonText",
  ],
  "src/lib/db/vector/count.ts": ["countLabel"],
  "src/lib/db/vector/dense.ts": [
    "DTYPE_RANGES",
    "DTypeRange",
    "VectorRefusal",
    "VectorTarget",
    "checkDenseElements",
    "checkMultiVector",
    "vectorNumbers",
  ],
  "src/lib/db/vector/float32.ts": ["isFiniteFloat32"],
  "src/lib/db/vector/probe.ts": ["ProbeVector", "probeVector"],
  "src/lib/db/vector/score.ts": ["ScoreCell", "nonFiniteScoreWarning", "scoreCell", "scoreColumnType"],
  "src/lib/db/vector/sparse.ts": [
    "SparseVector",
    "checkSparse",
    "sparseFromCell",
    "sparseFromIndexMap",
    "sparseFromIndicesValues",
  ],
  "src/lib/db/vector/types.ts": [
    "CountKind",
    "ScoreKind",
    "ScoreSemantics",
    "SparseEncoding",
    "VECTOR_DTYPES",
    "VectorColumn",
    "VectorDType",
    "VectorFieldInfo",
    "VectorIndexKind",
    "VectorKind",
    "VectorMetric",
  ],
  [SERVER_TEXT]: ["secretForms", "serverText"],
};

const sortedNames = (names: Iterable<string>): string[] => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The names a file exports: declarations marked export, and the names of export lists; `*` for a star re-export. */
function exportedNames(file: string, text: string): string[] {
  const names = new Set<string>();
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true).statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) names.add("*");
      else if (ts.isNamedExports(clause)) for (const element of clause.elements) names.add(element.name.text);
      else names.add(clause.name.text);
    } else if (ts.isExportAssignment(statement)) {
      names.add("default");
    } else if (exported(statement)) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) names.add(declaration.name.getText());
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name !== undefined
      ) {
        names.add(statement.name.text);
      }
    }
  }
  return sortedNames(names);
}

/** What one shared file holds that the rule refuses, as findings. */
function contentFindings(file: string, text: string, engineNamesOnly = false): string[] {
  const findings: string[] = [];
  for (const pattern of ENGINE_NAMES) {
    const match = pattern.exec(text);
    if (match !== null) findings.push(`content: ${file} names the engine ${match[0]}`);
  }
  if (engineNamesOnly) return findings;
  for (const path of VENDOR_PATHS)
    if (text.includes(path)) findings.push(`content: ${file} holds the vendor path ${path}`);
  for (const spelling of NATIVE_SPELLINGS) {
    if (new RegExp(`\\b${spelling}\\b`).test(text))
      findings.push(`content: ${file} holds the native spelling ${spelling}`);
  }
  return findings;
}

function exportFindings(file: string, text: string): string[] {
  const listed = new Set(EXPORTS[file] ?? []);
  const found = exportedNames(file, text);
  return [
    ...found
      .filter((name) => !listed.has(name))
      .map((name) => `exports: ${file} exports ${name}, which this guard's list does not hold`),
    ...[...listed]
      .filter((name) => !found.includes(name))
      .map((name) => `exports: ${file} no longer exports ${name}, which this guard's list holds`),
  ];
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
/** Every file under the two shared directories, whatever its depth and its extension. */
const sharedFiles = (root = ROOT): string[] =>
  DIRECTORIES.flatMap((directory) =>
    readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${entry.parentPath.slice(root.length + 1)}/${entry.name}`.split("\\").join("/")),
  ).sort();

describe("the shared vector and console modules (spec 3.2)", () => {
  test("are exactly the files the export list names", () => {
    expect(sharedFiles()).toEqual(
      Object.keys(EXPORTS)
        .filter((file) => file !== SERVER_TEXT)
        .sort(),
    );
  });

  test("name no engine and hold no vendor path or native spelling, in code or comments", () => {
    expect(sharedFiles().flatMap((file) => contentFindings(file, read(file)))).toEqual([]);
  });

  test("export exactly the listed symbols", () => {
    expect(sharedFiles().flatMap((file) => exportFindings(file, read(file)))).toEqual([]);
  });

  test("server-text.ts names no engine and exports exactly secretForms and serverText", () => {
    expect(contentFindings(SERVER_TEXT, read(SERVER_TEXT), true)).toEqual([]);
    expect(exportedNames(SERVER_TEXT, read(SERVER_TEXT))).toEqual(["secretForms", "serverText"]);
  });
});

describe("planted violations fail by name, and the near misses pass", () => {
  const score = "src/lib/db/vector/score.ts";

  test.each([
    ["// a squared Euclidean distance\n"],
    ['const metric: "cosine" | "hnsw" = "cosine";\n'],
    ["// cosineSimilarity and hnswIndex are not the native spellings\n"],
    ["// the Euclidean norm\n"],
  ])("%p passes", (planted) => {
    expect(contentFindings(score, planted + read(score))).toEqual([]);
  });

  test.each([
    ["// Euclid\n", "content: src/lib/db/vector/score.ts holds the native spelling Euclid"],
    ['const index = "HNSW";\n', "content: src/lib/db/vector/score.ts holds the native spelling HNSW"],
    ["// COSINE scores\n", "content: src/lib/db/vector/score.ts holds the native spelling COSINE"],
    ["// a BFloat16Vector field\n", "content: src/lib/db/vector/score.ts holds the native spelling BFloat16Vector"],
    ["// AUTOINDEX\n", "content: src/lib/db/vector/score.ts holds the native spelling AUTOINDEX"],
    [
      'const route = "collections/{name}";\n',
      "content: src/lib/db/vector/score.ts holds the vendor path collections/{",
    ],
    ['const prefix = "/v2/vectordb/";\n', "content: src/lib/db/vector/score.ts holds the vendor path /v2/vectordb/"],
    ["// as Milvus answers\n", "content: src/lib/db/vector/score.ts names the engine Milvus"],
    ['const host = "qdrant";\n', "content: src/lib/db/vector/score.ts names the engine qdrant"],
    ["// Zilliz Cloud\n", "content: src/lib/db/vector/score.ts names the engine Zilliz"],
    ["const milvusRoutes = 1;\n", "content: src/lib/db/vector/score.ts names the engine milvus"],
    ["const isQdrant = false;\n", "content: src/lib/db/vector/score.ts names the engine Qdrant"],
    ['const MILVUS_PREFIX = "";\n', "content: src/lib/db/vector/score.ts names the engine MILVUS"],
    ["const qdrant_key = 1;\n", "content: src/lib/db/vector/score.ts names the engine qdrant"],
    ["// zillizcloud\n", "content: src/lib/db/vector/score.ts names the engine zilliz"],
  ])("%p fails by name", (planted, finding) => {
    expect(contentFindings(score, planted + read(score))).toEqual([finding]);
  });

  test("an export the list does not hold fails, and so does one the file stopped exporting", () => {
    expect(exportFindings(score, `${read(score)}\nexport const oneReader = 1;\n`)).toEqual([
      "exports: src/lib/db/vector/score.ts exports oneReader, which this guard's list does not hold",
    ]);
    expect(exportFindings(score, read(score).replace("export function scoreCell", "function scoreCell"))).toEqual([
      "exports: src/lib/db/vector/score.ts no longer exports scoreCell, which this guard's list holds",
    ]);
  });

  test("a re-export counts, by name and as a star", () => {
    expect(
      exportedNames("x.ts", 'export { a, b as c } from "./y";\nexport * from "./z";\nexport * as w from "./v";\n'),
    ).toEqual(["*", "a", "c", "w"]);
  });

  test("a file in a subdirectory and a .tsx file are listed, so neither escapes the rule or the export list", () => {
    const root = mkdtempSync(join(tmpdir(), "content-guard-"));
    try {
      mkdirSync(join(root, "src/lib/db/vector/nested"), { recursive: true });
      mkdirSync(join(root, "src/lib/db/console"), { recursive: true });
      writeFileSync(join(root, "src/lib/db/vector/a.ts"), "");
      writeFileSync(join(root, "src/lib/db/vector/nested/b.ts"), "");
      writeFileSync(join(root, "src/lib/db/console/cell.tsx"), "");
      expect(sharedFiles(root)).toEqual([
        "src/lib/db/console/cell.tsx",
        "src/lib/db/vector/a.ts",
        "src/lib/db/vector/nested/b.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an engine's name in server-text.ts fails", () => {
    expect(contentFindings(SERVER_TEXT, `// the Qdrant api-key\n${read(SERVER_TEXT)}`, true)).toEqual([
      "content: src/lib/db/utils/server-text.ts names the engine Qdrant",
    ]);
  });
});
