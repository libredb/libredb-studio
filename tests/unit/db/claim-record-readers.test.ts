/**
 * Studio's review of each policy, MCP, connection and agent mode claim is read only by Studio's grant reader,
 * `src/lib/db/claim-grants.ts` (docs/providers/CONTRACT.md, clauses M-54, M-82 and M-83): every gate reads the grant,
 * the more restrictive of the engine's request and the review, so a gate that read the review again would read a claim
 * no grant covers once a loader admits a package's declaration.
 *
 * Studio's review of each policy, MCP and connection claim and of the statement language claim, and the two host review
 * records, is the grant register, `@libredb/grant-register`, and no longer a record of core: no module but the grant
 * reader loads the register, by an import declaration, a side-effect import, a re-export, an `export *`, a dynamic
 * `import()` or a `require()` of its package name, a subpath of it or a relative path into packages/grant-register/,
 * while a type-only import or export, which loads nothing, passes. The grant reader imports none of the records whose
 * rows moved there, `MOVED_TO_REGISTER`, and no module of `MOVED_FROM_MODULES` exports one; `STUDIO_CLAIM_RECORDS`, the
 * table form the grant reader once composed from the register's legacy rows, is among them, since every engine is now
 * granted against its own row by one call.
 *
 * Studio's review of the agent readings is the register's legacy rows' `agentReadings`, which only the grant reader
 * loads. The member is still held by member rather than by name, a request's or a grant table's alike: no module but
 * the grant reader, the claim projection, which reads each declaration's request and never Studio's row, and the agent
 * readers of an engine record's grant, which read the grant the grant reader answers, reads a member named
 * `agentReadings`, by a property access, a string element access or a binding pattern key, whatever the object. Each
 * reader of the record's grant is listed by path rather than passed over by the shape of its read, so a new module that
 * reads the grant is refused until it is reviewed and listed. An object literal key and a type member key of that name are no read, so the generated requests and their
 * types are passed over. A file whose text does not hold the name is not parsed. The capabilities member of the same
 * name, `ProviderCapabilities.agentReadings`, which no module reads, is refused by the same rule, until the closed list
 * of that claim's readers decides it.
 *
 * The agent overlay's claim that its catalog read is a command is held by member the same way, its request and its
 * grant apart: no module but the claim projection, which reads each declaration's request, reads a member named
 * `commandShaped`, and no module but the grant reader, which grants the request against the register row's review, and
 * the catalog read's admission in src/lib/agent/tools.ts, which reads the engine record's grant, reads a member named
 * `catalogReadCommandShaped`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../../..");

/** The grant reader: the one module that may read Studio's review of a claim. */
const GRANT_READER = "src/lib/db/claim-grants.ts";

/**
 * The claim records whose rows are now the grant register's rows, and the table form the grant reader once composed
 * from them: none of them may be imported by the grant reader or exported by a module of `MOVED_FROM_MODULES`.
 */
const MOVED_TO_REGISTER: readonly string[] = [
  "STUDIO_CLAIM_RECORDS",
  "WRITE_REACH",
  "READS_FILE_ACCESS_POSTURE",
  "REFUSES_DENIED_FILE_ACCESS",
  "SINGLE_WRITER_FILE",
  "READ_ROOTS_REQUIRED",
  "AGENT_CREDENTIAL_FORM",
  "MASKING_EXEMPT_COLUMNS",
  "MCP_EXPOSABLE",
  "MCP_STATEMENT_READ",
  "MCP_METADATA_READ_CHANGES_STATE",
  "MCP_AGENT_CREDENTIAL_REQUIRED",
  "OPENS_LOCAL_FILE",
  "HOST_PATH_FIELDS",
  "OPENS_SERVER_LEVEL_WITHOUT_DATABASE",
  "SSH_TUNNEL_REFUSAL",
  "SEED_AGENT_CREDENTIAL",
  "AGENT_STATEMENT_LANGUAGE",
  "SERVES_ONE_SESSION",
  "AGENT_EXECUTION_ENGINES",
];

/**
 * The modules, without their extension, a record of `MOVED_TO_REGISTER` was or could be exported from: the two that
 * held them and the grant reader. A closed list, so a moved record exported again from one of them is refused by name.
 */
const MOVED_FROM_MODULES: readonly string[] = [
  "src/lib/db/compatibility",
  "src/lib/db/connection-fields",
  "src/lib/db/claim-grants",
];

/** The grant register's package name, and its directory in this repository. */
const GRANT_REGISTER_PACKAGE = "@libredb/grant-register";
const GRANT_REGISTER_DIRECTORY = "packages/grant-register";

interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** Every `.ts` and `.tsx` file under `directory`, a repository path, read as text. */
function sourceFiles(directory: string): SourceText[] {
  return readdirSync(path.join(ROOT, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort()
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), "utf8") }));
}

/** The member that requests, reviews and grants the agent readings. */
const AGENT_READINGS = "agentReadings";

/** The modules that may read a member named `agentReadings`, each with why. */
const AGENT_READINGS_READERS: Readonly<Record<string, string>> = {
  [GRANT_READER]: "the grant reader, which grants each engine's request against its legacy row in the grant register",
  "src/lib/db/engine-catalog/projection.ts":
    "the claim projection, which reads each declaration's request and never Studio's row, a CLAIM_READERS entry of tests/unit/db/engine-declaration-readers.test.ts",
  "src/lib/agent/agent-manifest.ts":
    "reads a legacy engine's grant, `legacyEngineGrants(...).agentReadings`, and an agent engine's `grants.agentReadings`, which the grant reader answers",
  "src/lib/agent/run-ledger-ids.ts":
    "reads the engine record's grant, `servedEngineRecord(...).grants.agentReadings`, which the grant reader answers",
  "src/lib/agent/tools.ts":
    "reads the engine record's grant, `servedEngineRecord(...).grants.agentReadings`, which the grant reader answers",
};

/** The member of an engine's server overlay catalog read that is its request to be read as a command. */
const COMMAND_SHAPED = "commandShaped";

/** The modules that may read a member named `commandShaped`, each with why. */
const COMMAND_SHAPED_READERS: Readonly<Record<string, string>> = {
  "src/lib/db/engine-catalog/projection.ts":
    "the claim projection, which reads each declaration's request into `agent.catalogReadCommandShaped` and never Studio's row",
};

/** The member of a register row, of a claim request and of an engine's grants that names the overlay's claim. */
const CATALOG_READ_COMMAND_SHAPED = "catalogReadCommandShaped";

/** The modules that may read a member named `catalogReadCommandShaped`, each with why. */
const CATALOG_READ_COMMAND_SHAPED_READERS: Readonly<Record<string, string>> = {
  [GRANT_READER]:
    "the grant reader, which grants each engine's request against its register row's review in `grantEngineClaims`",
  "src/lib/agent/tools.ts":
    "the catalog read's admission, `catalogReadAdmission`, which reads the engine record's grant, `servedEngineRecord(...).grants.catalogReadCommandShaped`",
};

/** Each read `file` makes of a member named `member`, as `<file> reads <member>`, once per file. */
function memberReads(file: SourceText, member: string): string[] {
  if (!file.text.includes(member)) return [];
  const source = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let reads = false;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === member) reads = true;
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === member
    )
      reads = true;
    else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === member) reads = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads ? [`${file.path} reads ${member}`] : [];
}

/** Each read of a member named `member` in `files` that no module of `readers` makes. */
function memberReaders(
  files: readonly SourceText[],
  member: string,
  readers: Readonly<Record<string, string>>,
): string[] {
  return files.filter((file) => !Object.hasOwn(readers, file.path)).flatMap((file) => memberReads(file, member));
}

/** Each read of a member named `agentReadings` in `files` that no module of `AGENT_READINGS_READERS` makes. */
function agentReadingsReaders(files: readonly SourceText[]): string[] {
  return memberReaders(files, AGENT_READINGS, AGENT_READINGS_READERS);
}

/**
 * Whether `specifier`, written in `file`, names the grant register: its package name or a subpath of it, or a relative
 * specifier resolving into its directory.
 */
function namesGrantRegister(file: string, specifier: string): boolean {
  if (specifier === GRANT_REGISTER_PACKAGE || specifier.startsWith(`${GRANT_REGISTER_PACKAGE}/`)) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return resolved === GRANT_REGISTER_DIRECTORY || resolved.startsWith(`${GRANT_REGISTER_DIRECTORY}/`);
}

/**
 * Whether `file` loads the grant register: an import declaration, a side-effect import among them, a re-export, an
 * `export *`, or a dynamic `import()` or `require()` of a string naming it. A type-only import or export, `import type`,
 * an import whose every named binding is `type`, or `export type`, loads nothing and is passed over.
 */
function importsGrantRegister(file: SourceText): boolean {
  const source = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let imports = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly)));
      if (!typeOnly && namesGrantRegister(file.path, node.moduleSpecifier.text)) imports = true;
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((element) => element.isTypeOnly));
      if (!typeOnly && namesGrantRegister(file.path, node.moduleSpecifier.text)) imports = true;
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const loads =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require");
      const argument = node.arguments[0];
      if (loads && argument !== undefined && ts.isStringLiteralLike(argument)) {
        if (namesGrantRegister(file.path, argument.text)) imports = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

/** Each module of `files` but the grant reader that loads the grant register, as `<file> imports the grant register`. */
function grantRegisterImporters(files: readonly SourceText[]): string[] {
  return files
    .filter((file) => file.path !== GRANT_READER && importsGrantRegister(file))
    .map((file) => `${file.path} imports the grant register`);
}

/** Whether `file` declares an exported variable named `name`, by a TypeScript parse of its statements. */
function exportsName(file: SourceText, name: string): boolean {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  return source.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true &&
      statement.declarationList.declarations.some((declaration) => declaration.name.getText(source) === name),
  );
}

/** The names `file`'s import declarations bind by name from any module, a type-only one included. */
function importedNames(file: SourceText): string[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return [];
    return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
  });
}

describe("the claim record readers", () => {
  test("only the grant reader imports the grant register, and the scan finds each way a module could import it", () => {
    const files = [...sourceFiles("src"), ...sourceFiles("vscode-extension/src")];

    expect(grantRegisterImporters(files)).toEqual([]);
    // Vacuity: the grant reader itself imports the register.
    const grantReader = files.find((file) => file.path === GRANT_READER);
    if (grantReader === undefined) throw new Error(`${GRANT_READER} is not in the source read`);
    expect(importsGrantRegister(grantReader)).toBe(true);

    const planted = (file: string, text: string) => grantRegisterImporters([{ path: file, text }]);
    const imports = (file: string) => [`${file} imports the grant register`];
    // An import declaration, a side-effect import, a re-export, an export *, a dynamic import and a require, by the
    // package's name, a subpath of it or a relative path into its directory.
    expect(planted("src/lib/a.ts", 'import { readGrantRegister } from "@libredb/grant-register";')).toEqual(
      imports("src/lib/a.ts"),
    );
    expect(planted("src/lib/a.ts", 'import register from "@libredb/grant-register";')).toEqual(imports("src/lib/a.ts"));
    expect(planted("src/lib/a.ts", 'import * as register from "@libredb/grant-register";')).toEqual(
      imports("src/lib/a.ts"),
    );
    expect(planted("src/lib/a.ts", 'import "@libredb/grant-register";')).toEqual(imports("src/lib/a.ts"));
    expect(
      planted("src/lib/a.ts", 'import { type GrantRegister, LEGACY_KEY } from "@libredb/grant-register";'),
    ).toEqual(imports("src/lib/a.ts"));
    expect(planted("src/lib/a.ts", 'import schema from "@libredb/grant-register/register.schema.json";')).toEqual(
      imports("src/lib/a.ts"),
    );
    expect(planted("src/lib/a.ts", 'export { LEGACY_KEY } from "@libredb/grant-register";')).toEqual(
      imports("src/lib/a.ts"),
    );
    expect(planted("src/lib/a.ts", 'export * from "@libredb/grant-register";')).toEqual(imports("src/lib/a.ts"));
    expect(planted("src/lib/a.ts", 'export * as register from "@libredb/grant-register";')).toEqual(
      imports("src/lib/a.ts"),
    );
    expect(planted("src/lib/a.ts", 'const register = await import("@libredb/grant-register");')).toEqual(
      imports("src/lib/a.ts"),
    );
    expect(planted("src/lib/a.ts", 'const register = require("@libredb/grant-register");')).toEqual(
      imports("src/lib/a.ts"),
    );
    expect(
      planted("src/lib/db/a.ts", 'import rows from "../../../packages/grant-register/src/register.json";'),
    ).toEqual(imports("src/lib/db/a.ts"));
    expect(
      planted("vscode-extension/src/backend/a.ts", 'import { readGrantRegister } from "@libredb/grant-register";'),
    ).toEqual(imports("vscode-extension/src/backend/a.ts"));

    // Not imports: a type-only import or export in every form, another package whose name begins the same, a relative
    // path outside the directory, a string that is no specifier, a comment, and the grant reader itself.
    expect(
      planted(
        "src/lib/a.ts",
        [
          'import type { GrantRegister } from "@libredb/grant-register";',
          'import type * as register from "@libredb/grant-register";',
          'import { type GrantRegister as G, type RegisterGrants } from "@libredb/grant-register";',
          'export type { GrantRegister } from "@libredb/grant-register";',
          'export { type RegisterGrants } from "@libredb/grant-register";',
          'import { readGrantRegisterFake } from "@libredb/grant-register-elsewhere";',
          'import { other } from "../../packages/grant-register-elsewhere/src/index";',
          'const name = "@libredb/grant-register";',
          '// import { readGrantRegister } from "@libredb/grant-register";',
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(planted(GRANT_READER, 'import { readGrantRegister } from "@libredb/grant-register";')).toEqual([]);
  }, 60_000);

  test("the grant reader imports no claim record whose rows moved to the grant register", () => {
    const grantReader = { path: GRANT_READER, text: readFileSync(path.join(ROOT, GRANT_READER), "utf8") };
    const imported = importedNames(grantReader);

    expect(imported.filter((name) => MOVED_TO_REGISTER.includes(name))).toEqual([]);
    const modules = MOVED_FROM_MODULES.map((recordModule) => {
      const file = `${recordModule}.ts`;
      return { path: file, text: readFileSync(path.join(ROOT, file), "utf8") };
    });
    expect(
      modules.flatMap((file) =>
        MOVED_TO_REGISTER.filter((name) => exportsName(file, name)).map((name) => `${file.path} exports ${name}`),
      ),
    ).toEqual([]);
    // Vacuity: the parse reads the grant reader's named imports, the generated claim requests among them, and each
    // module's exported names, the grant reader's own projections among them.
    expect(imported).toContain("BUNDLED_CLAIM_REQUESTS");
    const grantReaderModule = modules.find((file) => file.path === GRANT_READER);
    if (grantReaderModule === undefined) throw new Error(`${GRANT_READER} is not among the modules read`);
    expect(exportsName(grantReaderModule, "GRANTED_WRITE_REACH")).toBe(true);
    expect(
      importedNames({ path: "src/lib/a.ts", text: 'import { WRITE_REACH as reach } from "./compatibility";' }),
    ).toEqual(["WRITE_REACH"]);
    expect(
      exportsName({ path: "src/lib/db/a.ts", text: "export const WRITE_REACH = Object.freeze({});" }, "WRITE_REACH"),
    ).toBe(true);
  });

  test("the agent readings member is read only by the grant reader, the claim projection and the readers of an engine record's grant, and the scan finds each way a module could read it", () => {
    const files = [...sourceFiles("src"), ...sourceFiles("vscode-extension/src")];

    expect(agentReadingsReaders(files)).toEqual([]);
    // Vacuity: each listed reader reads the member, and the generated claim requests module declares it.
    for (const reader of Object.keys(AGENT_READINGS_READERS)) {
      const file = files.find((candidate) => candidate.path === reader);
      if (file === undefined) throw new Error(`${reader} is not in the source read`);
      expect(memberReads(file, AGENT_READINGS)).toEqual([`${reader} reads ${AGENT_READINGS}`]);
    }
    expect(
      files
        .find((file) => file.path === "src/lib/db/engine-catalog/claims.generated.ts")
        ?.text.includes(AGENT_READINGS),
    ).toBe(true);

    const planted = (text: string) => agentReadingsReaders([{ path: "src/lib/agent/a.ts", text }]);
    const read = [`src/lib/agent/a.ts reads ${AGENT_READINGS}`];
    // A property access, optional or not, a string element access and a binding pattern key are reads.
    expect(planted(`ENGINE_FACETS.postgres.${AGENT_READINGS}.length;`)).toEqual(read);
    expect(planted(`engineFacetsFor(type)?.${AGENT_READINGS};`)).toEqual(read);
    // A read of the engine record's grant outside the listed readers is refused like any other.
    expect(planted(`servedEngineRecord(type).grants.${AGENT_READINGS};`)).toEqual(read);
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

  test("the overlay's command-shaped catalog read request is read only by the claim projection, and its grant only by the grant reader and the catalog read's admission, and the scan finds each way a module could read either", () => {
    const files = [...sourceFiles("src"), ...sourceFiles("vscode-extension/src")];
    const scans = [
      [COMMAND_SHAPED, COMMAND_SHAPED_READERS],
      [CATALOG_READ_COMMAND_SHAPED, CATALOG_READ_COMMAND_SHAPED_READERS],
    ] as const;

    for (const [member, readers] of scans) {
      expect(memberReaders(files, member, readers)).toEqual([]);
      // Vacuity: each listed reader reads the member.
      for (const reader of Object.keys(readers)) {
        const file = files.find((candidate) => candidate.path === reader);
        if (file === undefined) throw new Error(`${reader} is not in the source read`);
        expect(memberReads(file, member)).toEqual([`${reader} reads ${member}`]);
      }
    }
    // Vacuity: the two overlays that request the claim are in the source read.
    expect(
      files
        .filter((file) => file.path.endsWith(".ts") && file.text.includes(`${COMMAND_SHAPED}: true`))
        .map((file) => file.path),
    ).toEqual([
      "src/lib/agent/languages/sql/engines/elasticsearch.ts",
      "src/lib/agent/languages/sql/engines/opensearch.ts",
    ]);

    for (const [member, readers] of scans) {
      const planted = (text: string) =>
        memberReaders([{ path: "src/lib/agent/composed-sql.ts", text }], member, readers);
      const read = [`src/lib/agent/composed-sql.ts reads ${member}`];
      // A property access, optional or not, a string element access and a binding pattern key are reads.
      expect(planted(`dialect.catalogRead.${member} === true;`)).toEqual(read);
      expect(planted(`servedEngineRecord(type).grants?.${member};`)).toEqual(read);
      expect(planted(`read["${member}"];`)).toEqual(read);
      expect(planted(`const { ${member} } = read;`)).toEqual(read);
      expect(planted(`const { ${member}: command } = read;`)).toEqual(read);
      // Not reads: an object literal key, a type member key, a string, a comment and another member.
      expect(
        planted(
          [
            `const read = { ${member}: true };`,
            `interface Read { readonly ${member}?: boolean }`,
            `const claim = "agent.overlay.dialect.catalogRead.${member}";`,
            `// read.${member}`,
            "read.declaredSchema;",
          ].join("\n"),
        ),
      ).toEqual([]);
      // A listed reader is passed over.
      const [listed] = Object.keys(readers);
      expect(memberReaders([{ path: listed, text: `read.${member};` }], member, readers)).toEqual([]);
    }
  }, 60_000);
});
