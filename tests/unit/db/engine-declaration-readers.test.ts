/**
 * Only the modules `DECLARATION_READERS` lists read an engine declaration or a projection of the declarations, none of
 * them reads a claim, no member a declaration authors is a claim, and every claim record Studio keeps in core is
 * written by hand (docs/providers/CONTRACT.md, clauses M-52, M-54, M-70, M-71, M-72, M-74, M-75 and M-77).
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
import { AUTHORED_MEMBERS } from "../../../scripts/generate-engine-declarations";
import { CONFIRMATION_GATE_CLAIMS, SEGMENT_CLAIMS } from "./engine-declarations/claims";
import { ENGINE_TABLE_INVENTORY } from "./engine-declarations/inventory";

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

/** The members of the data-only connection tables the connection module holds, M-71: authored members, M-15. */
const CONNECTION_TABLE_MEMBERS = [
  "connection.fields",
  "connection.seedOnly",
  "connection.refused",
  "connection.credentialWarnings",
] as const;

/** The members of the connection tables the connection flags module holds, the three compatibility.ts reads, M-71. */
const CONNECTION_FLAG_MEMBERS = [
  "connection.readsTrustMaterial",
  "connection.connectionString.accepted",
  "connection.connectionString.dialogOffersUri",
] as const;

/**
 * The members of the connection form the connection form module holds, M-72: authored members, M-15, each presentation
 * or a rule that only adds a refusal, none a claim.
 */
const CONNECTION_FORM_MEMBERS = [
  "displayName",
  "connection.defaults",
  "connection.tls",
  "connection.dialog",
  "connection.hostUriSchemes",
  "connection.fieldRules",
  "connection.hostHint",
  "connection.hostIdentity",
  "connection.import",
] as const;

/**
 * The members of the connection string the connection string module holds, M-74: authored members, M-15, each
 * presentation, a reader bound only to Studio's own function for that engine, or a seed check that only refuses earlier
 * what the provider refuses again when the connection opens, none a claim.
 */
const CONNECTION_STRING_MEMBERS = [
  "connection.connectionString.scheme",
  "connection.connectionString.urlTls",
  "connection.connectionString.paste",
  "connection.connectionString.seedCheck",
] as const;

/** The editor members each engine's execution UI is projected from, M-75: authored members, M-15. */
const EXECUTION_UI_MEMBERS = ["editor.commitKeyword", "editor.consentDeadline"] as const;

/** The editor member the fence aliases are projected from, M-75: an authored member, M-15. */
const FENCE_ALIAS_MEMBERS = ["editor.fenceAliases"] as const;

/**
 * The editor members the query dialects, the tab type editors and the editor languages are projected from, M-77:
 * authored members, M-15, each an offer, presentation or a mask that only adds to what history drops, none a claim.
 */
const QUERY_EDITOR_MEMBERS = ["editor.dialect", "editor.language"] as const;

/**
 * The SQL text members the SQL text is projected from, M-78: authored members, M-15, its redaction, a claim, never
 * among them. `readsSqlText` and an exempt form of the grammar are the confirmation gate's claims, which the gate
 * counts only through `CONFIRMATION_CLAIM_REVIEW` (S-8), and every other reader reads as declared.
 */
const SQL_TEXT_MEMBERS = [
  "sqlText.readsSqlText",
  "sqlText.grammar",
  "sqlText.updateTarget",
  "sqlText.completion",
] as const;

/**
 * The SQL writing segment the SQL writing is projected from, M-79: an authored member, M-15, holding no claim, each
 * function a name bound only to Studio's own function for that engine.
 */
const SQL_WRITING_MEMBERS = ["sqlWriting"] as const;

/**
 * The migration DDL segment the migration DDL is projected from, M-80: an authored member, M-15, holding no claim, each
 * function a name bound only to Studio's own function for that engine.
 */
const MIGRATION_DDL_MEMBERS = ["migrationDdl"] as const;

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
      "the shipped engines and each engine's location, read from the engine catalog, and three connection records, read from the connection flags",
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
    path: "src/lib/db/connection-form.ts",
    members: CONNECTION_FORM_MEMBERS,
    reason:
      "each engine's connection form, composed from the connection form module and Studio's function table, which binds each named function",
  },
  {
    path: "src/lib/db/connection-string/index.ts",
    members: CONNECTION_STRING_MEMBERS,
    reason:
      "each engine's connection string, composed from the connection string module and Studio's connection string function table, which binds each named function",
  },
  {
    path: "src/lib/db/credential-warnings.ts",
    members: ["connection.credentialWarnings"],
    reason: "each engine's credential warnings, read from the connection tables",
  },
  {
    path: "src/lib/db/editor-language/index.ts",
    members: ["editor.language"],
    reason:
      "each editor language's accent and console, read from the generated editor language record and composed with Studio's code of each language",
  },
  {
    path: "src/lib/db/engine-catalog/catalog.generated.ts",
    members: CATALOG_MEMBERS,
    reason: "the engine catalog, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/connection-flags.generated.ts",
    members: CONNECTION_FLAG_MEMBERS,
    reason: "the connection tables compatibility.ts reads, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/connection-form.generated.ts",
    members: CONNECTION_FORM_MEMBERS,
    reason: "the connection forms, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/connection-string.generated.ts",
    members: CONNECTION_STRING_MEMBERS,
    reason: "the connection strings, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/connection.generated.ts",
    members: CONNECTION_TABLE_MEMBERS,
    reason: "the other data-only connection tables, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/editor.generated.ts",
    members: [...EXECUTION_UI_MEMBERS, ...FENCE_ALIAS_MEMBERS],
    reason: "each engine's execution UI and the fence aliases, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/migration-ddl.generated.ts",
    members: MIGRATION_DDL_MEMBERS,
    reason: "each engine's migration DDL, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/projection.ts",
    members: [
      ...CATALOG_MEMBERS,
      ...CONNECTION_TABLE_MEMBERS,
      ...CONNECTION_FLAG_MEMBERS,
      ...CONNECTION_FORM_MEMBERS,
      ...CONNECTION_STRING_MEMBERS,
      ...EXECUTION_UI_MEMBERS,
      ...FENCE_ALIAS_MEMBERS,
      ...QUERY_EDITOR_MEMBERS,
      ...SQL_TEXT_MEMBERS,
      ...SQL_WRITING_MEMBERS,
      ...MIGRATION_DDL_MEMBERS,
    ],
    reason:
      "projects the admitted declarations into the engine catalog, the connection tables, the connection forms, the connection strings, the execution UI and fence aliases, the query dialects, tab type editors and editor languages, the SQL text, the SQL writing and the migration DDL",
  },
  {
    path: "src/lib/db/engine-catalog/query-editor.generated.ts",
    members: QUERY_EDITOR_MEMBERS,
    reason:
      "the query dialects, the tab type editors and the editor languages, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/sql-text.generated.ts",
    members: SQL_TEXT_MEMBERS,
    reason: "each engine's SQL text, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/engine-catalog/sql-writing.generated.ts",
    members: SQL_WRITING_MEMBERS,
    reason: "each engine's SQL writing, generated from the admitted declarations",
  },
  {
    path: "src/lib/db/execution-ui/index.ts",
    members: EXECUTION_UI_MEMBERS,
    reason: "each engine's execution UI, read from the generated execution UI record",
  },
  {
    path: "src/lib/db/migration-ddl/index.ts",
    members: MIGRATION_DDL_MEMBERS,
    reason:
      "each engine's migration DDL row, composed from the generated migration DDL and Studio's migration DDL function table, which binds each named function",
  },
  {
    path: "src/lib/db/query-dialects.ts",
    members: ["editor.dialect"],
    reason: "each query dialect's row, read from the generated query dialect record",
  },
  {
    path: "src/lib/db/sql-grammar/index.ts",
    members: SQL_TEXT_MEMBERS,
    reason:
      "each engine's SQL grammar row, composed from the generated SQL text, Studio's hand-written redaction record and Studio's grammar function table, which binds each named function",
  },
  {
    path: "src/lib/db/sql-writing/index.ts",
    members: SQL_WRITING_MEMBERS,
    reason:
      "each engine's SQL writing row, composed from the generated SQL writing and Studio's SQL writing function table, which binds each named function",
  },
  {
    path: "src/lib/editor/dialect-editors.ts",
    members: QUERY_EDITOR_MEMBERS,
    reason: "each tab type's editor language, read from the generated tab type editor record",
  },
  {
    path: "src/lib/sql/fence-tags.ts",
    members: FENCE_ALIAS_MEMBERS,
    reason: "the fence aliases that name each engine, read from the generated fence alias record",
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

/** Each member of `authored` that is, holds or lies inside a claim, with what that breaks. */
function authoredClaims(authored: readonly string[], claims: readonly string[]): string[] {
  return authored.flatMap((member) =>
    claims
      .filter((claim) => overlaps(member, claim))
      .map(
        (claim) =>
          `${member} is authored, and it holds the claim ${claim}, but an authored member feeds a projection Studio reads, and a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)`,
      ),
  );
}

/** A per-engine record Studio keeps in core: its module and its module-level name. */
interface CoreRecord {
  readonly module: string;
  readonly name: string;
}

/** An inventory destination in the claim form: the member the engine requests, which the table grants. */
const CLAIM_DESTINATION =
  /^engine declaration: [\w.]+, the engine's request, which this table grants as Studio's review record of the claim$/;

/**
 * The registry whose claims sit in rows beside each provider, M-54's case: each row is written in its provider's
 * directory and its index collects them, so the record is no single literal and this guard does not hold it.
 */
const ROW_REGISTRIES: readonly CoreRecord[] = [{ module: "src/lib/db/engine-facets/index.ts", name: "ENGINE_FACETS" }];

/**
 * The confirmation gate's review record (docs/providers/CONTRACT.md, clause M-52): a list keyed by a claim's kind, its
 * engine and an exempt form's words rather than a table over the type ids, so the inventory does not list it, and this
 * guard holds it beside the inventory's claim records.
 */
const CONFIRMATION_RECORDS: readonly CoreRecord[] = [
  { module: "src/lib/db/confirmation-claim-review.ts", name: "CONFIRMATION_CLAIM_REVIEW" },
];

/**
 * Why each of `records` is not written by hand, read from the module text `files` holds for it: its initializer, seen
 * through parentheses, `as`, `satisfies` and `Object.freeze`, must be a literal, a list or a record of them, or the
 * name of a module-level `const` of its own module written the same way. A call, an imported binding, a function, a
 * spread and a computed member are each named, so no projection, generated or computed, can feed a claim record.
 */
function computedClaimRecords(files: readonly SourceText[], records: readonly CoreRecord[]): string[] {
  return records.flatMap(({ module, name }) => {
    const file = files.find((candidate) => candidate.path === module);
    if (file === undefined) return [`${module} ${name} is not in the source read`];
    const source = ts.createSourceFile(module, file.text, ts.ScriptTarget.Latest, true);
    const constants = new Map<string, ts.Expression>();
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          constants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    const unwrapped = (expression: ts.Expression): ts.Expression => {
      let current = expression;
      for (;;) {
        if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
          current = current.expression;
        } else if (
          ts.isCallExpression(current) &&
          current.expression.getText(source) === "Object.freeze" &&
          current.arguments.length === 1
        ) {
          current = current.arguments[0] as ts.Expression;
        } else {
          return current;
        }
      }
    };
    const visited = new Set<string>();
    const why = (expression: ts.Expression): string | null => {
      const node = unwrapped(expression);
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isNumericLiteral(node) ||
        node.kind === ts.SyntaxKind.TrueKeyword ||
        node.kind === ts.SyntaxKind.FalseKeyword ||
        node.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
      ) {
        return null;
      }
      if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements) {
          const problem = ts.isSpreadElement(element)
            ? `it spreads ${element.expression.getText(source)}`
            : why(element);
          if (problem !== null) return problem;
        }
        return null;
      }
      if (ts.isObjectLiteralExpression(node)) {
        for (const member of node.properties) {
          let problem: string | null;
          if (ts.isSpreadAssignment(member)) problem = `it spreads ${member.expression.getText(source)}`;
          else if (ts.isShorthandPropertyAssignment(member)) problem = why(member.name);
          else if (ts.isPropertyAssignment(member) && !ts.isComputedPropertyName(member.name)) {
            problem = why(member.initializer);
          } else problem = `it computes the member ${member.getText(source)}`;
          if (problem !== null) return problem;
        }
        return null;
      }
      if (ts.isIdentifier(node)) {
        const initializer = constants.get(node.text);
        if (initializer === undefined) {
          return `it reads ${node.text}, which is no module-level const of ${module}`;
        }
        if (visited.has(node.text)) return null;
        visited.add(node.text);
        return why(initializer);
      }
      return `it is computed by ${node.getText(source).split("\n")[0]}`;
    };
    const initializer = constants.get(name);
    const problem = initializer === undefined ? "it is no module-level const of its module" : why(initializer);
    return problem === null ? [] : [`${module} ${name} is not written by hand: ${problem}`];
  });
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
    expect(authoredClaims(AUTHORED_MEMBERS, claims)).toEqual([]);
    expect(authoredClaims([...AUTHORED_MEMBERS, "connection.opensLocalFile"], claims)).toEqual([
      "connection.opensLocalFile is authored, and it holds the claim connection.opensLocalFile, but an authored member feeds a projection Studio reads, and a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)",
    ]);
    expect(authoredClaims(["id", "policy"], claims)).toEqual(
      claims
        .filter((claim) => claim.startsWith("policy."))
        .map(
          (claim) =>
            `policy is authored, and it holds the claim ${claim}, but an authored member feeds a projection Studio reads, and a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)`,
        ),
    );
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

  test("the confirmation gate's claims are authored only in the SQL text, read only by its projection, its module and the SQL grammar, and counted by the gate only through CONFIRMATION_CLAIM_REVIEW", () => {
    const gateClaims = (member: string) =>
      CONFIRMATION_GATE_CLAIMS.filter((claim) => overlaps(member, claim)).map(
        (claim) =>
          `${member} is authored, and it holds the claim ${claim}, but an authored member feeds a projection Studio reads, and a claim reaches a gate only through Studio's review record of it (docs/providers/CONTRACT.md, clause M-54)`,
      );
    // The only authored members holding one of the gate's claims: readsSqlText, and the grammar, which holds the forms.
    expect(authoredClaims(AUTHORED_MEMBERS, CONFIRMATION_GATE_CLAIMS)).toEqual([
      ...gateClaims("sqlText.readsSqlText"),
      ...gateClaims("sqlText.grammar"),
    ]);
    expect(authoredClaims(AUTHORED_MEMBERS, CONFIRMATION_GATE_CLAIMS)).toHaveLength(2);
    // The only readers of them: the projection, its generated module and the SQL grammar that composes each row.
    const readers = [
      ...new Set(claimReaders(DECLARATION_READERS, CONFIRMATION_GATE_CLAIMS).map((problem) => problem.split(" ")[0])),
    ];
    expect(readers).toEqual([
      "src/lib/db/engine-catalog/projection.ts",
      "src/lib/db/engine-catalog/sql-text.generated.ts",
      "src/lib/db/sql-grammar/index.ts",
    ]);
    // The gate counts each through the review record: the modules that import it are the gate's two, each importing
    // only isReviewedConfirmationClaim, and the SQL reading asks it about exactly these two kinds of claim.
    const importers = sourceFiles().flatMap((file) => {
      const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false);
      return source.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
        if (statement.moduleSpecifier.text !== "@/lib/db/confirmation-claim-review") return [];
        const bindings = statement.importClause?.namedBindings;
        const names =
          bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements.map((e) => e.name.text) : [];
        return [{ path: file.path, names }];
      });
    });
    expect(importers).toEqual([
      { path: "src/lib/db/destructive-commands.ts", names: ["isReviewedConfirmationClaim"] },
      { path: "src/lib/sql/dangerous-query.ts", names: ["isReviewedConfirmationClaim"] },
    ]);
    const gate = readFileSync(path.join(ROOT, "src/lib/sql/dangerous-query.ts"), "utf8");
    expect(gate).toContain('isReviewedConfirmationClaim({ kind: "exempt-form", type: databaseType, form })');
    expect(gate).toContain('isReviewedConfirmationClaim({ kind: "text-not-sql", type: databaseType })');
  }, 60_000);

  test("every claim record Studio keeps in core is written by hand, so no projection of the declarations can feed one", () => {
    const records = ENGINE_TABLE_INVENTORY.filter((entry) => CLAIM_DESTINATION.test(entry.destination));
    const modules = [...new Set([...records, ...CONFIRMATION_RECORDS].map((record) => record.module))];
    const files = modules.map((module) => ({ path: module, text: readFileSync(path.join(ROOT, module), "utf8") }));

    expect(records.length).toBe(18);
    expect(records).toContainEqual(
      expect.objectContaining({ module: "src/lib/db/sql-grammar/redaction.ts", name: "SQL_TEXT_REDACTION" }),
    );
    expect(computedClaimRecords(files, [...records, ...CONFIRMATION_RECORDS])).toEqual([]);
    // The registry whose claims sit in rows beside providers is named in the claim's words, but not in its form.
    for (const registry of ROW_REGISTRIES) {
      const entry = ENGINE_TABLE_INVENTORY.find(
        (candidate) => candidate.module === registry.module && candidate.name === registry.name,
      );
      expect(entry?.destination).toContain("which this table grants as Studio's review record of the claim");
      expect(records).not.toContainEqual(entry);
    }

    const planted: SourceText = {
      path: "src/lib/db/planted-claims.ts",
      text: [
        'import { BUNDLED_CATALOG } from "./engine-catalog/catalog.generated";',
        'import { IMPORTED_ROW } from "./elsewhere";',
        'const ROW = Object.freeze({ reach: "none", sentence: null });',
        "const NESTED = [ROW, -1, `text`] as const;",
        "function helper(): boolean {",
        "  return true;",
        "}",
        "let REASSIGNED = true;",
        "export const LITERAL: Readonly<Record<string, unknown>> = Object.freeze({",
        "  postgres: ROW,",
        "  mysql: (NESTED satisfies readonly unknown[]) as readonly unknown[],",
        '  sqlite: { open: true, roots: Object.freeze(["a", 2, false]) },',
        "  NESTED,",
        "});",
        "export const COMPUTED = Object.fromEntries(Object.keys(BUNDLED_CATALOG).map((id) => [id, false]));",
        "export const IMPORTED = Object.freeze({ postgres: IMPORTED_ROW });",
        "export const HELPED = Object.freeze({ postgres: helper });",
        "export const SPREAD = Object.freeze({ ...LITERAL, mysql: true });",
        "export const LISTED = Object.freeze([...NESTED]);",
        'export const KEYED = Object.freeze({ ["postgres"]: true });',
        "export const MUTABLE = Object.freeze({ postgres: REASSIGNED });",
      ].join("\n"),
    };
    const name = (record: string) => ({ module: planted.path, name: record });

    expect(computedClaimRecords([planted], [name("LITERAL")])).toEqual([]);
    expect(
      computedClaimRecords(
        [planted],
        ["COMPUTED", "IMPORTED", "HELPED", "SPREAD", "LISTED", "KEYED", "MUTABLE", "ABSENT"].map(name),
      ),
    ).toEqual([
      "src/lib/db/planted-claims.ts COMPUTED is not written by hand: it is computed by Object.fromEntries(Object.keys(BUNDLED_CATALOG).map((id) => [id, false]))",
      "src/lib/db/planted-claims.ts IMPORTED is not written by hand: it reads IMPORTED_ROW, which is no module-level const of src/lib/db/planted-claims.ts",
      "src/lib/db/planted-claims.ts HELPED is not written by hand: it reads helper, which is no module-level const of src/lib/db/planted-claims.ts",
      "src/lib/db/planted-claims.ts SPREAD is not written by hand: it spreads LITERAL",
      "src/lib/db/planted-claims.ts LISTED is not written by hand: it spreads NESTED",
      'src/lib/db/planted-claims.ts KEYED is not written by hand: it computes the member ["postgres"]: true',
      "src/lib/db/planted-claims.ts MUTABLE is not written by hand: it reads REASSIGNED, which is no module-level const of src/lib/db/planted-claims.ts",
      "src/lib/db/planted-claims.ts ABSENT is not written by hand: it is no module-level const of its module",
    ]);
    expect(computedClaimRecords([], [name("LITERAL")])).toEqual([
      "src/lib/db/planted-claims.ts LITERAL is not in the source read",
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
