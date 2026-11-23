/**
 * Every per-engine table in `src/` is accounted for (docs/providers/CONTRACT.md, clause M-16): either its facts are
 * in the engine declarations, or the inventory names the contract segment they are planned for or the reason core
 * keeps them.
 *
 * A per-engine table is a module-level variable outside the provider directory whose declared type, a `satisfies` or
 * `as` type in its initializer, or the type arguments of a `new` expression in its initializer (`new Map<DatabaseType,
 * T>()`), is a `Record`, a mapped type or a `Map` keyed by `DatabaseType`. A table written as an array of rows or as an
 * object whose type is only inferred is not one. A new table that is in neither list fails here by module and name, so
 * the contract cannot fall behind a table without anyone deciding where it goes.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ENGINE_TABLE_INVENTORY, type InventoryEntry } from "./engine-declarations/inventory";

const ROOT = path.resolve(import.meta.dir, "../../..");
const PROVIDER_DIRECTORY = "src/lib/db/providers/";
const KEYED_BY_TYPE = /Record<DatabaseType\b|Map<DatabaseType\b|in DatabaseType\]/;

interface SourceText {
  readonly path: string;
  readonly text: string;
}

interface Table {
  readonly module: string;
  readonly name: string;
}

/** Every `.ts` and `.tsx` file under `src/` outside the provider directory, as repository-relative POSIX paths. */
function sourceFiles(): SourceText[] {
  return readdirSync(path.join(ROOT, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter((file) => !file.startsWith(PROVIDER_DIRECTORY))
    .sort()
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), "utf8") }));
}

/**
 * The per-engine tables of `files`, sorted by module and name. Only a file whose text matches the key pattern is
 * parsed, which skips none: a table's type names `DatabaseType` in its own text.
 */
function perEngineTables(files: readonly SourceText[]): Table[] {
  const tables: Table[] = [];
  for (const file of files) {
    if (!KEYED_BY_TYPE.test(file.text)) continue;
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const types: string[] = declaration.type ? [declaration.type.getText(source)] : [];
        const visit = (node: ts.Node): void => {
          if (ts.isSatisfiesExpression(node) || ts.isAsExpression(node)) types.push(node.type.getText(source));
          if (ts.isNewExpression(node) && node.typeArguments) {
            const typeArguments = node.typeArguments.map((argument) => argument.getText(source)).join(", ");
            types.push(`${node.expression.getText(source)}<${typeArguments}>`);
          }
          ts.forEachChild(node, visit);
        };
        if (declaration.initializer) visit(declaration.initializer);
        if (types.some((type) => KEYED_BY_TYPE.test(type))) {
          tables.push({ module: file.path, name: declaration.name.getText(source) });
        }
      }
    }
  }
  return tables.sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
}

const key = ({ module, name }: Table): string => `${module} ${name}`;

/** The tables the inventory lacks, and the inventory entries no table matches, each as `module name`. */
function compareInventory(tables: readonly Table[], inventory: readonly InventoryEntry[]) {
  const found = new Set(tables.map(key));
  const listed = new Set(inventory.map(key));
  return {
    unlisted: tables.map(key).filter((entry) => !listed.has(entry)),
    stale: inventory.map(key).filter((entry) => !found.has(entry)),
  };
}

describe("the per-engine table inventory", () => {
  const tables = perEngineTables(sourceFiles());

  test("the scan finds ENGINE_FACETS and SSH_TUNNEL_REFUSAL", () => {
    expect(tables.map(key)).toContain("src/lib/db/engine-facets/index.ts ENGINE_FACETS");
    expect(tables.map(key)).toContain("src/lib/db/compatibility.ts SSH_TUNNEL_REFUSAL");
  });

  test("every per-engine table in src is in the inventory", () => {
    expect(compareInventory(tables, ENGINE_TABLE_INVENTORY).unlisted).toEqual([]);
  });

  test("every inventory entry exists", () => {
    expect(compareInventory(tables, ENGINE_TABLE_INVENTORY).stale).toEqual([]);
  });

  test("every inventory entry is listed once and names where its facts go", () => {
    const keys = ENGINE_TABLE_INVENTORY.map(key);

    expect(new Set(keys).size).toBe(keys.length);
    const unplaced = ENGINE_TABLE_INVENTORY.filter(
      (entry) => !/^(engine declaration|planned segment|core-owned): \S/.test(entry.destination),
    );

    expect(unplaced).toEqual([]);
  });

  test("no inventory text names an internal change number or a ledger path", () => {
    const offending = ENGINE_TABLE_INVENTORY.filter((entry) => /\bPR ?\d|#\d|\.team\b/.test(entry.destination));

    expect(offending).toEqual([]);
  });

  test("a planted table outside the inventory and a stale entry each fail by module and name", () => {
    const planted: SourceText[] = [
      {
        path: "src/lib/planted.ts",
        text: [
          "export const ROWS: Readonly<Record<DatabaseType, boolean>> = Object.freeze({});",
          "const OTHER = Object.freeze({} as const satisfies Record<DatabaseType, string>);",
          "const MAPPED: { [T in DatabaseType]: number } = {};",
          "const PLAIN: Record<string, boolean> = {};",
          "const MEMO = new Map<DatabaseType, number>();",
          "const CAST = Object.freeze({} as Record<DatabaseType, number>);",
          "const NAMES = new Map<string, DatabaseType>();",
          "function local() { const INNER: Record<DatabaseType, boolean> = {}; return INNER; }",
        ].join("\n"),
      },
      { path: "src/lib/unrelated.ts", text: "export const X = 1;\n" },
    ];
    const plantedTables = perEngineTables(planted);

    expect(plantedTables.map(key)).toEqual([
      "src/lib/planted.ts CAST",
      "src/lib/planted.ts MAPPED",
      "src/lib/planted.ts MEMO",
      "src/lib/planted.ts OTHER",
      "src/lib/planted.ts ROWS",
    ]);
    expect(
      compareInventory(plantedTables, [
        { module: "src/lib/planted.ts", name: "ROWS", destination: "engine declaration: connection" },
        { module: "src/lib/planted.ts", name: "GONE", destination: "engine declaration: connection" },
      ]),
    ).toEqual({
      unlisted: [
        "src/lib/planted.ts CAST",
        "src/lib/planted.ts MAPPED",
        "src/lib/planted.ts MEMO",
        "src/lib/planted.ts OTHER",
      ],
      stale: ["src/lib/planted.ts GONE"],
    });
  });
});
