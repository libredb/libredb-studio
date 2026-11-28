/**
 * Reads what one provider directory imports, symbol by symbol, and holds a record of each imported symbol's home to it.
 *
 * A record is a Markdown table in `docs/PROVIDER_IMPORTS.md` with one row per (module, symbol) and four cells: the
 * core module's path, the symbol, the symbol's home in the provider's contract form, and where the directory imports
 * it from now. The last cell is either `leaves with the legacy class`, for a symbol the directory imports from core
 * and that leaves with the provider's move, or an `@libredb/provider-sdk` specifier, for a symbol the directory
 * imports from the SDK. The Module cell of an SDK row is the core path the symbol had before it moved, which no
 * longer needs to exist.
 *
 * `directoryImports` parses each listed source file under the directory with the TypeScript compiler's
 * `createSourceFile` and reads every `import` and `export ... from` declaration: a named binding as its exported
 * name (`propertyName ?? name`), a default import as `default`, and a namespace import, an `export *`, an
 * `export * as` and a side-effect import as `*`, so none of them can hide a symbol. A specifier that is
 * `@libredb/provider-sdk` or one of its subpaths is an SDK pair, named by the specifier as written. Any other
 * specifier resolves through `resolveSpecifier` of `./scan.ts`: a package is skipped, a file inside any provider directory, this one
 * included, is skipped, a file elsewhere is a core pair named by its path, and a specifier that
 * resolves to no listed file throws, naming it. A dynamic `import()` or a `require()` is not read; the outward census
 * of `./scan.ts` still counts its module.
 *
 * Every function is pure over `{ path, text }` records and a set of listed paths, so a test can plant a tree.
 */
import ts from "typescript";
import { PROVIDER_DIRECTORY, resolveSpecifier, type SourceText, isSourcePath } from "./scan";

export const RECORD_FILE = "docs/PROVIDER_IMPORTS.md";

const SDK_PACKAGE = "@libredb/provider-sdk";
const LEAVES = "leaves with the legacy class";

/** One symbol imported from one module: a core path, or an SDK specifier as written. */
export interface ImportedSymbol {
  readonly module: string;
  readonly symbol: string;
}

/** What a provider directory imports from core and from the SDK, each sorted by module and then symbol. */
export interface DirectoryImports {
  readonly directory: string;
  readonly core: readonly ImportedSymbol[];
  readonly sdk: readonly ImportedSymbol[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byModuleThenSymbol = (a: ImportedSymbol, b: ImportedSymbol): number =>
  compareText(a.module, b.module) || compareText(a.symbol, b.symbol);
const keyOf = ({ module, symbol }: ImportedSymbol): string => `${module}\0${symbol}`;

function isSdkSpecifier(specifier: string): boolean {
  return specifier === SDK_PACKAGE || specifier.startsWith(`${SDK_PACKAGE}/`);
}

/** The exported names one declaration takes from its module. */
function boundSymbols(statement: ts.ImportDeclaration | ts.ExportDeclaration): string[] {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return ["*"];
    const symbols = clause.name ? ["default"] : [];
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) symbols.push("*");
    else if (bindings) symbols.push(...bindings.elements.map((element) => (element.propertyName ?? element.name).text));
    return symbols;
  }
  const clause = statement.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return ["*"];
  return clause.elements.map((element) => (element.propertyName ?? element.name).text);
}

function unique(symbols: ImportedSymbol[]): ImportedSymbol[] {
  return [...new Map(symbols.map((entry) => [keyOf(entry), entry])).values()].sort(byModuleThenSymbol);
}

/** Every symbol the source files under `directory` import from core and from the SDK. */
export function directoryImports(
  files: readonly SourceText[],
  directory: string,
  listed: ReadonlySet<string>,
): DirectoryImports {
  const core: ImportedSymbol[] = [];
  const sdk: ImportedSymbol[] = [];
  for (const file of files.filter((entry) => entry.path.startsWith(directory) && isSourcePath(entry.path))) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (isSdkSpecifier(specifier)) {
        sdk.push(...boundSymbols(statement).map((symbol) => ({ module: specifier, symbol })));
        continue;
      }
      const resolution = resolveSpecifier(file.path, specifier, listed);
      if (resolution.kind === "package") continue;
      if (resolution.kind === "unresolved") throw new Error(`${file.path}: "${specifier}" resolves to no listed file`);
      if (resolution.path.startsWith(`${PROVIDER_DIRECTORY}/`)) continue;
      core.push(...boundSymbols(statement).map((symbol) => ({ module: resolution.path, symbol })));
    }
  }
  return { directory, core: unique(core), sdk: unique(sdk) };
}

/** What a record of a directory's imported symbols gets wrong against what the directory imports, sorted. */
export function homeRecordFindings(rows: readonly string[][], imports: DirectoryImports): string[] {
  const findings: string[] = [];
  const fromCore = new Set(imports.core.map(keyOf));
  const fromSdk = new Set(imports.sdk.map(keyOf));
  const recorded = new Set<string>();
  for (const [module, symbol, , source] of rows) {
    const key = keyOf({ module, symbol });
    const name = `${module} ${symbol}`;
    if (recorded.has(key)) findings.push(`${name}: the record has two rows for it`);
    recorded.add(key);
    if (source === LEAVES) {
      if (!fromCore.has(key)) {
        findings.push(
          `${name}: the record says it leaves with the legacy class, and ${imports.directory} no longer imports it from core`,
        );
      }
    } else if (isSdkSpecifier(source)) {
      if (fromCore.has(key))
        findings.push(`${name}: the record says ${source}, and ${imports.directory} imports it from core`);
      if (!fromSdk.has(keyOf({ module: source, symbol }))) {
        findings.push(`${name}: the record says ${source}, and ${imports.directory} does not import it from there`);
      }
    } else {
      findings.push(`${name}: "${source}" is neither "${LEAVES}" nor an ${SDK_PACKAGE} subpath`);
    }
  }
  for (const entry of imports.core) {
    if (!recorded.has(keyOf(entry))) {
      findings.push(
        `${entry.module} ${entry.symbol}: ${imports.directory} imports it from core, and the record has no row for it`,
      );
    }
  }
  const order = rows.map(([module, symbol]) => ({ module, symbol }));
  const inOrder = order.every((entry, at) => at === 0 || byModuleThenSymbol(order[at - 1], entry) <= 0);
  if (!inOrder) findings.push("the record is not in module and symbol order");
  return findings.sort(compareText);
}

/** The rows of the Markdown table in `text` whose header row is `header`, each cell trimmed and unquoted. */
export function tableRows(text: string, header: string): string[][] {
  const lines = text.split("\n");
  const start = lines.indexOf(header);
  if (start < 0) throw new Error(`${RECORD_FILE} has no table with the header ${header}`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim().replace(/^`(.*)`$/, "$1")),
    );
  }
  return rows;
}
