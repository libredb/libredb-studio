/**
 * Every policy, MCP, connection and agent mode claim record Studio keeps in core is read only by Studio's grant reader,
 * `src/lib/db/claim-grants.ts` (docs/providers/CONTRACT.md, clauses M-54, M-82 and M-83): every gate reads the grant,
 * the more restrictive of the engine's request and the record, so a gate that read a record again would read a claim no
 * grant covers once a loader admits a package's declaration.
 *
 * The scan parses every `.ts` and `.tsx` file under Studio's `src/` and the VS Code extension's `src/` with the
 * TypeScript compiler (a `.tsx` file as TSX) and finds each reference to a record: an import or re-export specifier
 * naming it from its module, an `export *` of its module, a property access or a string-literal element access naming
 * it on a namespace import of its module, on a dynamic import or require of it, or on a `const` alias of either, a
 * destructuring of such an import, require or alias, and, inside the record's own module, any use of its name but the
 * declaration. A module specifier names a record module when it resolves to it, written relative to the importing file
 * or through the `@/` alias for `src/`. A type-only import or export, `import type`, `import { type X }`,
 * `export type { X } from` or `import type * as ns`, is passed over: it carries no value to any gate, and is how the
 * agent packs read `AGENT_STATEMENT_LANGUAGE`'s literal type (`AgentEngineType` in src/lib/agent/languages/pack.ts). A
 * value import stays a reference wherever the name is then used, a `typeof` in a type position included.
 * An object literal key, a type member key, a property of another object and a string such as an error code are not
 * references, and a comment is trivia the parser attaches to no node, so the record's name in either is passed over.
 * `STUDIO_CLAIM_RECORDS`, the records as the grant reader hands them to `grantClaims`, is held the same way, so no
 * module reads the records through it either.
 *
 * Studio's record of the agent readings is a member of each `ENGINE_FACETS` row, `agentReadings`, beside members other
 * gates read, so it is held by member rather than by name: no module but the grant reader and the claim projection,
 * which reads each declaration's request and never Studio's row, reads a member named `agentReadings`, by a property
 * access, a string element access or a binding pattern key, whatever the object. An object literal key and a type
 * member key of that name are no read, so the rows and their types are passed over. A file whose text does not hold
 * the name is not parsed. The capabilities member of the same name, `ProviderCapabilities.agentReadings`, which no
 * module reads, is refused by the same rule, until the closed list of that claim's readers decides it.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../../..");

/** The grant reader: the one module that may read a claim record. */
const GRANT_READER = "src/lib/db/claim-grants.ts";

/**
 * Each module holding a policy, MCP, connection or agent mode claim record, without its extension, and the records it
 * holds.
 */
const CLAIM_RECORD_MODULES: Readonly<Record<string, readonly string[]>> = {
  "src/lib/db/compatibility": [
    "OPENS_LOCAL_FILE",
    "HOST_PATH_FIELDS",
    "OPENS_SERVER_LEVEL_WITHOUT_DATABASE",
    "SSH_TUNNEL_REFUSAL",
    "WRITE_REACH",
    "READS_FILE_ACCESS_POSTURE",
    "REFUSES_DENIED_FILE_ACCESS",
    "SINGLE_WRITER_FILE",
    "READ_ROOTS_REQUIRED",
    "MASKING_EXEMPT_COLUMNS",
    "MCP_EXPOSABLE",
    "MCP_STATEMENT_READ",
    "MCP_METADATA_READ_CHANGES_STATE",
    "MCP_AGENT_CREDENTIAL_REQUIRED",
    "AGENT_STATEMENT_LANGUAGE",
  ],
  "src/lib/db/connection-fields": ["AGENT_CREDENTIAL_FORM", "SEED_AGENT_CREDENTIAL"],
  "src/lib/db/claim-grants": ["STUDIO_CLAIM_RECORDS"],
};

interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** The repository path, without extension, that `specifier` written in `file` resolves to, or null for a package. */
function resolvedModule(file: string, specifier: string): string | null {
  const written = specifier.replace(/\.(c|m)?(t|j)sx?$/, "");
  if (written.startsWith("@/")) return `src/${written.slice(2)}`;
  if (written.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(file), written));
  return null;
}

/** The records the module `module` (a repository path without extension) holds, or none. */
function recordsOf(module: string | null): readonly string[] {
  return module !== null && Object.hasOwn(CLAIM_RECORD_MODULES, module) ? (CLAIM_RECORD_MODULES[module] ?? []) : [];
}

/** `node` seen through parentheses, `await`, `as` and non-null assertions. */
function unwrapped(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The records of the module a dynamic `import()` or `require()` call loads, or none for any other expression. */
function loadedRecords(file: string, node: ts.Expression): readonly string[] {
  const call = unwrapped(node);
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return [];
  const loads =
    call.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(call.expression) && call.expression.text === "require");
  const argument = call.arguments[0];
  if (!loads || argument === undefined || !ts.isStringLiteralLike(argument)) return [];
  return recordsOf(resolvedModule(file, argument.text));
}

/** Whether `node`, an identifier, is a key or a member name rather than a reference to a binding. */
function isKeyOrMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
      parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  );
}

/** Each reference `file` makes to a claim record, as `<file> reads <record>`. */
function recordReferences(file: SourceText): string[] {
  const source = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const own = recordsOf(file.path.replace(/\.tsx?$/, ""));
  const namespaces = new Map<string, readonly string[]>();
  const found = new Set<string>();
  const read = (record: string) => found.add(`${file.path} reads ${record}`);
  const readNamed = (records: readonly string[], name: string) => {
    if (records.includes(name)) read(name);
  };

  /**
   * The records of the module `initializer` binds: a dynamic import or require of a record module, or an identifier
   * naming a namespace or loaded module already bound, so an alias of one is followed.
   */
  const boundRecords = (initializer: ts.Expression): readonly string[] => {
    const target = unwrapped(initializer);
    if (ts.isIdentifier(target)) return namespaces.get(target.text) ?? [];
    return loadedRecords(file.path, target);
  };

  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const records = recordsOf(resolvedModule(file.path, node.moduleSpecifier.text));
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      // A type-only import carries no value, so it reads no record.
      if (records.length > 0 && bindings !== undefined && clause?.isTypeOnly !== true) {
        if (ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, records);
        else
          for (const element of bindings.elements)
            if (!element.isTypeOnly) readNamed(records, (element.propertyName ?? element.name).text);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const records = recordsOf(resolvedModule(file.path, node.moduleSpecifier.text));
      if (node.isTypeOnly) {
        // A type-only re-export carries no value, so it reads no record.
      } else if (node.exportClause === undefined) for (const record of records) read(record);
      else if (ts.isNamespaceExport(node.exportClause)) for (const record of records) read(record);
      else
        for (const element of node.exportClause.elements)
          if (!element.isTypeOnly) readNamed(records, (element.propertyName ?? element.name).text);
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const records = boundRecords(node.initializer);
      if (records.length > 0 && ts.isIdentifier(node.name)) namespaces.set(node.name.text, records);
      if (records.length > 0 && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key) || ts.isStringLiteral(key)) readNamed(records, key.text);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  /** The records of the namespace or loaded module `expression` names, or none. */
  const namespaceRecords = (expression: ts.Expression): readonly string[] => {
    const target = unwrapped(expression);
    if (ts.isIdentifier(target)) return namespaces.get(target.text) ?? [];
    return loadedRecords(file.path, target);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      readNamed(namespaceRecords(node.expression), node.name.text);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      readNamed(namespaceRecords(node.expression), node.argumentExpression.text);
    } else if (ts.isIdentifier(node) && own.includes(node.text) && !isKeyOrMemberName(node)) {
      const declared = ts.isVariableDeclaration(node.parent) && node.parent.name === node;
      if (!declared) read(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}

/** Every `.ts` and `.tsx` file under `directory`, a repository path, read as text. */
function sourceFiles(directory: string): SourceText[] {
  return readdirSync(path.join(ROOT, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort()
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), "utf8") }));
}

/** The member of each `ENGINE_FACETS` row that is Studio's record of the agent readings. */
const AGENT_READINGS = "agentReadings";

/** The modules that may read a member named `agentReadings`, each with why. */
const AGENT_READINGS_READERS: Readonly<Record<string, string>> = {
  [GRANT_READER]: "the grant reader, which grants each engine's request against Studio's facet row",
  "src/lib/db/engine-catalog/projection.ts":
    "the claim projection, which reads each declaration's request and never Studio's row, a CLAIM_READERS entry of tests/unit/db/engine-declaration-readers.test.ts",
};

/** Each read `file` makes of a member named `agentReadings`, as `<file> reads agentReadings`, once per file. */
function agentReadingsReads(file: SourceText): string[] {
  if (!file.text.includes(AGENT_READINGS)) return [];
  const source = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let reads = false;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === AGENT_READINGS) reads = true;
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === AGENT_READINGS
    )
      reads = true;
    else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === AGENT_READINGS) reads = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads ? [`${file.path} reads ${AGENT_READINGS}`] : [];
}

/** Each read of a member named `agentReadings` in `files` that no module of `AGENT_READINGS_READERS` makes. */
function agentReadingsReaders(files: readonly SourceText[]): string[] {
  return files.filter((file) => !Object.hasOwn(AGENT_READINGS_READERS, file.path)).flatMap(agentReadingsReads);
}

/** Each reference to a claim record in `files` that the grant reader does not make. */
function recordReaders(files: readonly SourceText[]): string[] {
  return files.filter((file) => file.path !== GRANT_READER).flatMap(recordReferences);
}

describe("the claim record readers", () => {
  test("every policy, MCP, connection and agent mode claim record is read only by the grant reader", () => {
    const files = [...sourceFiles("src"), ...sourceFiles("vscode-extension/src")];

    expect(recordReaders(files)).toEqual([]);
    // Vacuity: the scan reads both trees, and finds the grant reader's own reads of every record, its own
    // STUDIO_CLAIM_RECORDS among them.
    expect(files.some((file) => file.path.startsWith("vscode-extension/src/"))).toBe(true);
    const grantReader = files.find((file) => file.path === GRANT_READER);
    if (grantReader === undefined) throw new Error(`${GRANT_READER} is not in the source read`);
    expect(recordReferences(grantReader).sort()).toEqual(
      [
        ...(CLAIM_RECORD_MODULES["src/lib/db/compatibility"] ?? []),
        ...(CLAIM_RECORD_MODULES["src/lib/db/connection-fields"] ?? []),
        "STUDIO_CLAIM_RECORDS",
      ]
        .map((record) => `${GRANT_READER} reads ${record}`)
        .sort(),
    );
  }, 60_000);

  test("the scan finds each way a module could reference a claim record, an alias of a namespace binding included, and passes over an error code, an object key of the same name and a type-only import", () => {
    const planted = (file: string, text: string) => recordReaders([{ path: file, text }]);

    expect(planted("src/lib/a.ts", 'import { WRITE_REACH } from "@/lib/db/compatibility";')).toEqual([
      "src/lib/a.ts reads WRITE_REACH",
    ]);
    expect(planted("src/lib/db/a.ts", 'import { SINGLE_WRITER_FILE as single } from "./compatibility";')).toEqual([
      "src/lib/db/a.ts reads SINGLE_WRITER_FILE",
    ]);
    expect(planted("src/lib/mcp/a.ts", 'export { MCP_EXPOSABLE } from "../db/compatibility.ts";')).toEqual([
      "src/lib/mcp/a.ts reads MCP_EXPOSABLE",
    ]);
    expect(planted("src/lib/a.ts", 'export * from "@/lib/db/connection-fields";')).toEqual([
      "src/lib/a.ts reads AGENT_CREDENTIAL_FORM",
      "src/lib/a.ts reads SEED_AGENT_CREDENTIAL",
    ]);
    expect(planted("src/lib/db/a.ts", 'import { SSH_TUNNEL_REFUSAL } from "./compatibility";')).toEqual([
      "src/lib/db/a.ts reads SSH_TUNNEL_REFUSAL",
    ]);
    expect(
      planted("vscode-extension/src/backend/a.ts", 'import { OPENS_LOCAL_FILE } from "@/lib/db/compatibility";'),
    ).toEqual(["vscode-extension/src/backend/a.ts reads OPENS_LOCAL_FILE"]);
    // An alias of a namespace or loaded module binding is followed, however many times it is renamed.
    expect(
      planted(
        "src/lib/a.ts",
        'import * as records from "@/lib/db/compatibility";\nconst m = records;\nconst n = (m);\nn.WRITE_REACH;',
      ),
    ).toEqual(["src/lib/a.ts reads WRITE_REACH"]);
    expect(
      planted(
        "src/lib/a.ts",
        'const loaded = await import("@/lib/db/connection-fields");\nconst m = loaded;\nm["SEED_AGENT_CREDENTIAL"];',
      ),
    ).toEqual(["src/lib/a.ts reads SEED_AGENT_CREDENTIAL"]);
    expect(
      planted(
        "src/lib/a.ts",
        'import * as records from "@/lib/db/compatibility";\nconst m = records;\nconst { HOST_PATH_FIELDS: h } = m;',
      ),
    ).toEqual(["src/lib/a.ts reads HOST_PATH_FIELDS"]);
    expect(
      planted("src/lib/a.ts", 'import * as records from "@/lib/db/compatibility";\nrecords.READ_ROOTS_REQUIRED.opcua;'),
    ).toEqual(["src/lib/a.ts reads READ_ROOTS_REQUIRED"]);
    expect(
      planted("src/lib/a.tsx", 'import * as records from "@/lib/db/compatibility";\nrecords["MCP_STATEMENT_READ"];'),
    ).toEqual(["src/lib/a.tsx reads MCP_STATEMENT_READ"]);
    expect(planted("src/lib/a.ts", 'const reach = (await import("@/lib/db/compatibility")).WRITE_REACH;')).toEqual([
      "src/lib/a.ts reads WRITE_REACH",
    ]);
    expect(
      planted("src/lib/a.ts", 'const records = await import("@/lib/db/compatibility");\nrecords.WRITE_REACH;'),
    ).toEqual(["src/lib/a.ts reads WRITE_REACH"]);
    expect(planted("src/lib/db/a.ts", 'const { MASKING_EXEMPT_COLUMNS: m } = require("./compatibility");')).toEqual([
      "src/lib/db/a.ts reads MASKING_EXEMPT_COLUMNS",
    ]);
    expect(
      planted(
        "vscode-extension/src/backend/a.ts",
        'import { MCP_METADATA_READ_CHANGES_STATE } from "@/lib/db/compatibility";',
      ),
    ).toEqual(["vscode-extension/src/backend/a.ts reads MCP_METADATA_READ_CHANGES_STATE"]);
    expect(planted("src/lib/a.ts", 'import { STUDIO_CLAIM_RECORDS } from "@/lib/db/claim-grants";')).toEqual([
      "src/lib/a.ts reads STUDIO_CLAIM_RECORDS",
    ]);
    expect(
      planted(
        "src/lib/db/compatibility.ts",
        "export const WRITE_REACH = Object.freeze({});\nexport const OPEN = Object.keys(WRITE_REACH);",
      ),
    ).toEqual(["src/lib/db/compatibility.ts reads WRITE_REACH"]);

    // Not references: the record's own declaration, an error code, an object key, a type member key, a property of
    // another object, a comment, another name of the record module, and the grant reader itself.
    expect(planted("src/lib/db/compatibility.ts", "export const WRITE_REACH = Object.freeze({});")).toEqual([]);
    expect(
      planted(
        "src/lib/db/error-record.ts",
        [
          'throw new ExecutionProfileError(sentence, "READ_ROOTS_REQUIRED");',
          "const codes = { READ_ROOTS_REQUIRED: true };",
          "type Codes = { READ_ROOTS_REQUIRED: boolean };",
          "codes.READ_ROOTS_REQUIRED;",
          "// WRITE_REACH, read from compatibility.ts",
          'import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";',
          "const other = { WRITE_REACH: 1 };\nconst alias = other;\nalias.WRITE_REACH;",
          'import { WRITE_REACH } from "@/lib/db/write-reach-elsewhere";',
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(planted(GRANT_READER, 'import { WRITE_REACH } from "./compatibility";')).toEqual([]);

    // A type-only import or re-export carries no value to a gate, so it is passed over in every form.
    const language = "AGENT_STATEMENT_LANGUAGE";
    expect(
      planted(
        "src/lib/agent/languages/a.ts",
        [
          `import type { ${language} } from "@/lib/db/compatibility";`,
          `import { type ${language} as L } from "@/lib/db/compatibility";`,
          `export type { ${language} } from "@/lib/db/compatibility";`,
          'import type * as records from "@/lib/db/compatibility";',
          `type T = typeof ${language};`,
          `type U = (typeof records)["${language}"];`,
        ].join("\n"),
      ),
    ).toEqual([]);
    // A value import is a reference however the name is used: in a type position, renamed, through a namespace or an
    // alias of one, loaded dynamically, or re-exported.
    expect(
      planted(
        "src/lib/agent/languages/a.ts",
        `import { ${language} } from "@/lib/db/compatibility";\ntype T = typeof ${language};`,
      ),
    ).toEqual([`src/lib/agent/languages/a.ts reads ${language}`]);
    expect(
      planted("src/lib/a.ts", `import { type WRITE_REACH, ${language} as L } from "@/lib/db/compatibility";`),
    ).toEqual([`src/lib/a.ts reads ${language}`]);
    expect(
      planted("src/lib/a.ts", `import * as records from "@/lib/db/compatibility";\nconst m = records;\nm.${language};`),
    ).toEqual([`src/lib/a.ts reads ${language}`]);
    expect(planted("src/lib/a.ts", `const { ${language}: l } = await import("@/lib/db/compatibility");`)).toEqual([
      `src/lib/a.ts reads ${language}`,
    ]);
    expect(planted("src/lib/a.ts", `export { ${language} } from "@/lib/db/compatibility";`)).toEqual([
      `src/lib/a.ts reads ${language}`,
    ]);
    expect(planted("src/lib/a.ts", 'export type * from "@/lib/db/compatibility";')).toEqual([]);
  });

  test("the agent readings of Studio's facet rows are read only by the grant reader, and the scan finds each way a module could read them", () => {
    const files = [...sourceFiles("src"), ...sourceFiles("vscode-extension/src")];

    expect(agentReadingsReaders(files)).toEqual([]);
    // Vacuity: each listed reader reads the member, and the rows that declare it are in the source read.
    for (const reader of Object.keys(AGENT_READINGS_READERS)) {
      const file = files.find((candidate) => candidate.path === reader);
      if (file === undefined) throw new Error(`${reader} is not in the source read`);
      expect(agentReadingsReads(file)).toEqual([`${reader} reads ${AGENT_READINGS}`]);
    }
    expect(files.filter((file) => file.text.includes(AGENT_READINGS)).length).toBeGreaterThan(40);

    const planted = (text: string) => agentReadingsReaders([{ path: "src/lib/agent/a.ts", text }]);
    const read = [`src/lib/agent/a.ts reads ${AGENT_READINGS}`];
    // A property access, optional or not, a string element access and a binding pattern key are reads.
    expect(planted(`ENGINE_FACETS.postgres.${AGENT_READINGS}.length;`)).toEqual(read);
    expect(planted(`engineFacetsFor(type)?.${AGENT_READINGS};`)).toEqual(read);
    expect(planted(`row["${AGENT_READINGS}"];`)).toEqual(read);
    expect(planted(`row[\`${AGENT_READINGS}\`];`)).toEqual(read);
    expect(planted(`const { ${AGENT_READINGS} } = row;`)).toEqual(read);
    expect(planted(`const { ${AGENT_READINGS}: offered } = row;`)).toEqual(read);
    expect(planted(`const { "${AGENT_READINGS}": offered } = row;`)).toEqual(read);
    expect(planted(`function offered({ ${AGENT_READINGS} }: EngineFacets) { return ${AGENT_READINGS}; }`)).toEqual(
      read,
    );
    // Not reads: an object literal key, a type member key, a string such as a log line, a comment, and another member.
    expect(
      planted(
        [
          `const row = { ${AGENT_READINGS}: ["health"] };`,
          `const quoted = { "${AGENT_READINGS}": [] };`,
          `interface Row { readonly ${AGENT_READINGS}: readonly string[] }`,
          `type Other = { ${AGENT_READINGS}?: readonly string[] };`,
          `const line = "${AGENT_READINGS}";`,
          `// row.${AGENT_READINGS}`,
          "row.agentReading;",
        ].join("\n"),
      ),
    ).toEqual([]);
    // A file that does not hold the name is not read at all, and a listed reader is passed over.
    expect(planted("row.maintenance;")).toEqual([]);
    expect(agentReadingsReaders([{ path: GRANT_READER, text: `row.${AGENT_READINGS};` }])).toEqual([]);
  }, 60_000);
});
