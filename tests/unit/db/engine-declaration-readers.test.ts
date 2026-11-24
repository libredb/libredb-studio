/**
 * Only the modules `DECLARATION_READERS` lists read an engine declaration or a projection of the declarations, and none
 * of them reads a claim (docs/providers/CONTRACT.md, clauses M-52, M-54 and M-70).
 *
 * A declaration's `policy` and `mcp` members, and the members of its other segments M-53 names, are claims: requests
 * Studio grants only through its review record of each claim, the table of Studio's source every gate reads. A module
 * that read a claim from a declaration could hand a request to a gate as if it were granted, so every module that reads
 * a declaration or a projection of the declarations is listed here with the members it reads and why, and a listed
 * member that is a claim fails here, with the rule M-54 states for how a host grants one.
 *
 * The scan reads Studio's source under `src/`, and parses every `.ts` and `.tsx` file there with the TypeScript
 * compiler (a `.tsx` file as TSX). A file is a reader when its syntax tree holds `engine-declarations` or
 * `engine-catalog`, the directories every import, dynamic import, require or file path a module could read a
 * declaration or its projection by names, in a string literal, a template literal with no substitution, or the head, a
 * middle or the tail of a template literal with substitutions; when it reaches the SDK's `EngineDeclaration` type, by
 * importing or re-exporting it by name, naming it through a namespace import of the SDK, naming it in an inline import
 * type, or re-exporting with `export *` an SDK entry that exports it; or when it lies under
 * `src/lib/db/engine-catalog/`, where the projection is built and generated. A comment is trivia the parser attaches to
 * no node, so a path written in a comment is passed over whatever its quoting. The scan finds a reader, not what it
 * reads: each listed reader's members are declared here by hand.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SEGMENT_CLAIMS } from "./engine-declarations/claims";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCHEMA_FILE = path.join(ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json");

interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** A module that reads a declaration or a projection of the declarations: the members it reads, and why. */
interface DeclarationReader {
  readonly path: string;
  readonly members: readonly string[];
  readonly reason: string;
}

/** The catalog's members, M-70: members every declaration authors, M-15. */
const CATALOG_MEMBERS = ["id", "location", "connection.connectBudgetMs"] as const;

/** The data-only connection tables' members, M-71: members every declaration authors, M-15. */
const CONNECTION_TABLE_MEMBERS = [
  "connection.fields",
  "connection.seedOnly",
  "connection.refused",
  "connection.credentialWarnings",
  "connection.readsTrustMaterial",
  "connection.connectionString.accepted",
  "connection.connectionString.dialogOffersUri",
] as const;

/** Every module of Studio's source that reads a declaration or a projection of the declarations. */
const DECLARATION_READERS: readonly DeclarationReader[] = [
  {
    path: "src/lib/db/compatibility.ts",
    members: [
      "id",
      "location",
      "connection.readsTrustMaterial",
      "connection.connectionString.accepted",
      "connection.connectionString.dialogOffersUri",
    ],
    reason:
      "the shipped engines and each engine's location, read from the engine catalog, and three connection records, read from the connection tables",
  },
  {
    path: "src/lib/db/connect-budget.ts",
    members: ["connection.connectBudgetMs"],
    reason: "each engine's connect budget, read from the engine catalog",
  },
  {
    path: "src/lib/db/connection-fields.ts",
    members: ["connection.fields", "connection.seedOnly", "connection.refused"],
    reason: "each engine's connection fields, seed-only fields and refused fields, read from the connection tables",
  },
  {
    path: "src/lib/db/credential-warnings.ts",
    members: ["connection.credentialWarnings"],
    reason: "each engine's credential warnings, read from the connection tables",
  },
  {
    path: "src/lib/db/engine-catalog/catalog.generated.ts",
    members: CATALOG_MEMBERS,
    reason: "the engine catalog, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/connection.generated.ts",
    members: CONNECTION_TABLE_MEMBERS,
    reason: "the data-only connection tables, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/projection.ts",
    members: [...CATALOG_MEMBERS, ...CONNECTION_TABLE_MEMBERS],
    reason: "projects the admitted declarations into the engine catalog and the connection tables",
  },
];

/** The directory names every path a module could read a declaration or a projection of them by holds. */
const DECLARATION_DIRECTORIES = ["engine-declarations", "engine-catalog"] as const;

/** The directory of the catalog's own modules, every file of which is a reader. */
const CATALOG_DIRECTORY = "src/lib/db/engine-catalog/";

/** The SDK's entries an engine declaration's type is imported from. */
const SDK_MODULE = /^@libredb\/provider-sdk(\/|$)/;

/** The SDK's entries that export `EngineDeclaration`: `manifest`, and the root, which re-exports every entry. */
const SDK_DECLARATION_ENTRY = /^@libredb\/provider-sdk(\/manifest)?$/;

/** Every claim of an engine declaration, as a dotted member: the policy and MCP claims and the segment claims. */
function declarationClaims(): string[] {
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as {
    $defs: Record<string, { properties?: Record<string, unknown> }>;
  };
  const membersOf = (definition: string, segment: string) =>
    Object.keys(schema.$defs[definition]?.properties ?? {}).map((member) => `${segment}.${member}`);
  return [...membersOf("policyClaims", "policy"), ...membersOf("mcpClaims", "mcp"), ...SEGMENT_CLAIMS];
}

/** Whether `node` is a string or a template literal part whose text holds a declarations directory name. */
function namesADirectory(node: ts.Node): boolean {
  return (
    (ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)) &&
    DECLARATION_DIRECTORIES.some((directory) => node.text.includes(directory))
  );
}

/** Whether `node` is an import or an export declaration from one of the SDK's entries. */
function fromTheSdk(node: ts.Node): node is ts.ImportDeclaration | ts.ExportDeclaration {
  return (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    SDK_MODULE.test(node.moduleSpecifier.text)
  );
}

/**
 * Whether `node` imports or re-exports the SDK's `EngineDeclaration`, as a type or a value, under its name or another.
 */
function importsTheDeclarationType(node: ts.Node): boolean {
  if (!fromTheSdk(node)) return false;
  const named = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
  return (
    named !== undefined &&
    (ts.isNamedImports(named) || ts.isNamedExports(named)) &&
    named.elements.some((element) => (element.propertyName ?? element.name).text === "EngineDeclaration")
  );
}

/** The names `source` binds the SDK's namespace to: each `sdk` of an `import * as sdk` from one of its entries. */
function sdkNamespaces(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!fromTheSdk(statement) || !ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
  }
  return names;
}

/**
 * Whether `node` names `EngineDeclaration` through one of `namespaces`, as the type `sdk.EngineDeclaration` does. The
 * SDK declares it an interface, so a type is the only place a namespace can name it.
 */
function namesTheDeclarationType(node: ts.Node, namespaces: ReadonlySet<string>): boolean {
  return (
    ts.isQualifiedName(node) &&
    ts.isIdentifier(node.left) &&
    namespaces.has(node.left.text) &&
    node.right.text === "EngineDeclaration"
  );
}

/**
 * Whether `node` re-exports everything an SDK entry that exports `EngineDeclaration` holds, as `export *` or
 * `export * as sdk` does.
 */
function reExportsTheDeclarationEntry(node: ts.Node): boolean {
  return (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    SDK_DECLARATION_ENTRY.test(node.moduleSpecifier.text) &&
    (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause))
  );
}

/** Whether `node` is an inline import type of `EngineDeclaration` from one of the SDK's entries. */
function importsTheDeclarationTypeInline(node: ts.Node): boolean {
  return (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal) &&
    SDK_MODULE.test(node.argument.literal.text) &&
    node.qualifier !== undefined &&
    ts.isIdentifier(node.qualifier) &&
    node.qualifier.text === "EngineDeclaration"
  );
}

/** Whether `node` reaches the SDK's `EngineDeclaration`, in any of the ways the docblock lists. */
function reachesTheDeclarationType(node: ts.Node, namespaces: ReadonlySet<string>): boolean {
  return (
    importsTheDeclarationType(node) ||
    namesTheDeclarationType(node, namespaces) ||
    reExportsTheDeclarationEntry(node) ||
    importsTheDeclarationTypeInline(node)
  );
}

/** Whether `file` reads a declaration or a projection of the declarations, by the three rules of the docblock. */
function readsADeclaration(file: SourceText): boolean {
  if (file.path.startsWith(CATALOG_DIRECTORY)) return true;
  const kind = file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false, kind);
  const namespaces = sdkNamespaces(source);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (namesADirectory(node) || reachesTheDeclarationType(node, namespaces)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every `.ts` and `.tsx` file under `src/`, as repository-relative POSIX paths with their text. */
function sourceFiles(): SourceText[] {
  return readdirSync(path.join(ROOT, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort()
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), "utf8") }));
}

/** What breaks the closed list over `files`: each reader `readers` lacks, then each listed path that reads nothing. */
function unlistedReaders(files: readonly SourceText[], readers: readonly DeclarationReader[]): string[] {
  const listed = new Set(readers.map((reader) => reader.path));
  const reading = files.filter((file) => readsADeclaration(file)).map((file) => file.path);
  return [
    ...reading
      .filter((file) => !listed.has(file))
      .map(
        (file) =>
          `${file} reads an engine declaration or a projection of the declarations, but DECLARATION_READERS does not list it`,
      ),
    ...[...listed]
      .filter((file) => !reading.includes(file))
      .map((file) => `${file} is listed in DECLARATION_READERS, but reads no engine declaration`),
  ];
}

/** Whether a member read and a claim overlap: the same member, or one holding the other. */
function overlaps(member: string, claim: string): boolean {
  return member === claim || claim.startsWith(`${member}.`) || member.startsWith(`${claim}.`);
}

/** Each listed member of `readers` that is, holds or lies inside a claim, with what that breaks. */
function claimReaders(readers: readonly DeclarationReader[], claims: readonly string[]): string[] {
  return readers.flatMap((reader) =>
    reader.members.flatMap((member) =>
      claims
        .filter((claim) => overlaps(member, claim))
        .map(
          (claim) =>
            `${reader.path} reads ${member}, which holds the claim ${claim}, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)`,
        ),
    ),
  );
}

describe("engine declaration readers", () => {
  // Parsing every file under src/ takes seconds on a CI runner under coverage, past bun's 5 s default, so this test
  // takes the 60 s bound the other whole-tree scans take (tests/unit/lib/agent/language-boundary.test.ts).
  test("only the modules DECLARATION_READERS lists read an engine declaration or a projection of the declarations", () => {
    const files = sourceFiles();

    expect(files.length).toBeGreaterThan(100);
    expect(unlistedReaders(files, DECLARATION_READERS)).toEqual([]);
    expect(unlistedReaders(files, [])).toEqual(
      DECLARATION_READERS.map(
        (reader) =>
          `${reader.path} reads an engine declaration or a projection of the declarations, but DECLARATION_READERS does not list it`,
      ),
    );
  }, 60_000);

  test("no listed reader reads a claim, so a declared claim reaches a gate only through Studio's review record", () => {
    const claims = declarationClaims();
    const planted: DeclarationReader[] = [
      { path: "src/lib/planted-policy.ts", members: ["policy.writeReach"], reason: "planted" },
      { path: "src/lib/planted-connection.ts", members: ["id", "connection.opensLocalFile"], reason: "planted" },
      { path: "src/lib/planted-segment.ts", members: ["mcp"], reason: "planted" },
    ];

    expect(claimReaders(DECLARATION_READERS, claims)).toEqual([]);
    expect(claims).toContain("policy.writeReach");
    expect(claims).toContain("mcp.exposable");
    expect(claims).toContain("connection.opensLocalFile");
    expect(claimReaders(planted, claims)).toEqual([
      "src/lib/planted-policy.ts reads policy.writeReach, which holds the claim policy.writeReach, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)",
      "src/lib/planted-connection.ts reads connection.opensLocalFile, which holds the claim connection.opensLocalFile, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)",
      ...claims
        .filter((claim) => claim.startsWith("mcp."))
        .map(
          (claim) =>
            `src/lib/planted-segment.ts reads mcp, which holds the claim ${claim}, but a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)`,
        ),
    ]);
  });

  test("the scan finds each way a module could read a declaration or a projection, and passes over a backticked path in a comment", () => {
    const planted: SourceText[] = [
      { path: "src/lib/static.ts", text: 'import kafka from "@/lib/db/engine-declarations/kafka.json";\n' },
      { path: "src/lib/dynamic.ts", text: "const kafka = await import('./engine-declarations/kafka.json');\n" },
      { path: "src/lib/required.ts", text: 'const kafka = require("../db/engine-declarations/kafka.json");\n' },
      {
        path: "src/lib/read.ts",
        text: 'const kafka = readFileSync(path.join(root, "src/lib/db/engine-declarations", "kafka.json"), "utf8");\n',
      },
      {
        path: "src/lib/commented.ts",
        text: "// The facts are in `src/lib/db/engine-declarations/<type-id>.json`, which no gate reads.\nexport const X = 1;\n",
      },
      {
        path: "src/lib/templated.ts",
        text: "const declaration = await import(`@/lib/db/engine-declarations/${type}.json`);\n",
      },
      {
        path: "src/lib/untemplated.ts",
        text: 'const kafka = readFileSync(`src/lib/db/engine-declarations/kafka.json`, "utf8");\n',
      },
      { path: "src/lib/joined.ts", text: "const directory = path.join(root, `${base}/engine-declarations`);\n" },
      {
        path: "src/lib/apostrophes.ts",
        text: "// Studio's engine-declarations aren't read by any gate.\nexport const X = 1;\n",
      },
      { path: "src/lib/blocked.tsx", text: '/* "src/lib/db/engine-declarations" */\nexport const X = <div />;\n' },
      {
        path: "src/lib/catalog-reader.ts",
        text: 'import { BUNDLED_CATALOG } from "@/lib/db/engine-catalog/catalog.generated";\n',
      },
      {
        path: "src/lib/db/projection-reader.ts",
        text: 'import { projectCatalog } from "./engine-catalog/projection";\n',
      },
      {
        path: "src/lib/typed.ts",
        text: 'import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";\n',
      },
      {
        path: "src/lib/renamed.ts",
        text: 'import { type EngineDeclaration as Declared } from "@libredb/provider-sdk";\n',
      },
      {
        path: "src/lib/namespaced.ts",
        text: 'import * as sdk from "@libredb/provider-sdk";\nexport type Declared = sdk.EngineDeclaration;\n',
      },
      {
        path: "src/lib/reexported.ts",
        text: 'export type { EngineDeclaration } from "@libredb/provider-sdk/manifest";\n',
      },
      { path: "src/lib/starred.ts", text: 'export * from "@libredb/provider-sdk/manifest";\n' },
      { path: "src/lib/starred-root.ts", text: 'export * as sdk from "@libredb/provider-sdk";\n' },
      {
        path: "src/lib/inline.ts",
        text: 'export type Declared = import("@libredb/provider-sdk/manifest").EngineDeclaration;\n',
      },
      {
        path: "src/lib/db/engine-catalog/placed.ts",
        text: "export const PLACED = 1;\n",
      },
      {
        path: "src/lib/other-namespace.ts",
        text: 'import * as sdk from "@libredb/provider-sdk";\nimport * as local from "./local";\nexport type Located = sdk.EngineLocation;\nexport type Declared = local.EngineDeclaration;\n',
      },
      {
        path: "src/lib/other-reexport.ts",
        text: 'export type { EngineLocation } from "@libredb/provider-sdk";\nexport type { EngineDeclaration } from "./local";\n',
      },
      {
        path: "src/lib/other-star.ts",
        text: 'export * from "./local";\nexport * from "@libredb/provider-sdk/sql";\n',
      },
      {
        path: "src/lib/other-inline.ts",
        text: 'export type Declared = import("./local").EngineDeclaration;\nexport type Located = import("@libredb/provider-sdk").EngineLocation;\n',
      },
      {
        path: "src/lib/other-type.ts",
        text: 'import type { EngineLocation } from "@libredb/provider-sdk/manifest";\nimport type { EngineDeclaration } from "./local";\n',
      },
      {
        path: "src/lib/catalog-commented.ts",
        text: "// Read from `src/lib/db/engine-catalog/catalog.generated.ts`.\nexport const X = 1;\n",
      },
    ];

    expect(unlistedReaders(planted, []).map((problem) => problem.split(" ")[0])).toEqual([
      "src/lib/static.ts",
      "src/lib/dynamic.ts",
      "src/lib/required.ts",
      "src/lib/read.ts",
      "src/lib/templated.ts",
      "src/lib/untemplated.ts",
      "src/lib/joined.ts",
      "src/lib/catalog-reader.ts",
      "src/lib/db/projection-reader.ts",
      "src/lib/typed.ts",
      "src/lib/renamed.ts",
      "src/lib/namespaced.ts",
      "src/lib/reexported.ts",
      "src/lib/starred.ts",
      "src/lib/starred-root.ts",
      "src/lib/inline.ts",
      "src/lib/db/engine-catalog/placed.ts",
    ]);
    expect(
      unlistedReaders(planted, [{ path: "src/lib/commented.ts", members: ["id"], reason: "planted" }]).at(-1),
    ).toBe("src/lib/commented.ts is listed in DECLARATION_READERS, but reads no engine declaration");
  });
});
