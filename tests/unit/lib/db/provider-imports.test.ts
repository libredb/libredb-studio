/**
 * No core file gains an import into a provider directory (provider plugins program, FND-8).
 *
 * Core is every source file git lists under `src/`, `bin/`, `scripts/` and `vscode-extension/src/` outside
 * `src/lib/db/providers/`; the scanner is `./provider-imports/scan.ts`, whose docblock says what it reads and why.
 * The imports core holds today are listed by file in `./provider-imports/inward-allowlist.ts`, and compared by
 * (file, module) pair: a pair the allowlist does not list fails as new, and a listed pair the source no longer holds
 * fails as stale, so the list only shrinks as each slice of the program removes its rows.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INWARD_IMPORTS } from "./provider-imports/inward-allowlist";
import {
  type AllowlistEntry,
  compareToAllowlist,
  type InwardImport,
  inwardImports,
  isCandidate,
  isCorePath,
  isSourcePath,
  moduleSpecifiers,
  outwardImports,
  PROVIDER_DIRECTORY,
  resolveSpecifier,
  SCANNED_ROOTS,
  type SourceText,
} from "./provider-imports/scan";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ALLOWLIST_FILE = "tests/unit/lib/db/provider-imports/inward-allowlist.ts";
const RECORD_FILE = "docs/PROVIDER_IMPORTS.md";
const REAL_TREE_TIMEOUT = 30_000;

/** A planted tree: the files with their text, and the set of every listed path the resolver may answer with. */
function plant(files: Readonly<Record<string, string>>): { files: SourceText[]; listed: ReadonlySet<string> } {
  return {
    files: Object.entries(files).map(([path, text]) => ({ path, text })),
    listed: new Set(Object.keys(files)),
  };
}

const POSTGRES = "src/lib/db/providers/sql/postgres.ts";
const POSTGRES_SPECIFIER = "@/lib/db/providers/sql/postgres";

/** Every import form the scanner reads, each naming the postgres provider module once. */
const IMPORT_FORMS: readonly (readonly [string, string])[] = [
  ["a static import", `import { PostgresProvider } from "${POSTGRES_SPECIFIER}";`],
  ["a type-only import", `import type { PostgresProvider } from "${POSTGRES_SPECIFIER}";`],
  ["an inline type import", `import { type PostgresProvider } from "${POSTGRES_SPECIFIER}";`],
  ["a named re-export", `export { PostgresProvider } from "${POSTGRES_SPECIFIER}";`],
  ["a star re-export", `export * from "${POSTGRES_SPECIFIER}";`],
  ["a side-effect import", `import "${POSTGRES_SPECIFIER}";`],
  ["a dynamic import", `export async function load() {\n  return await import("${POSTGRES_SPECIFIER}");\n}`],
  ["a require call", `const loaded = require("${POSTGRES_SPECIFIER}");\nexport default loaded;`],
  ["an import-equals require", `import loaded = require("${POSTGRES_SPECIFIER}");\nexport default loaded;`],
  ["a typeof import type", `export type Loaded = typeof import("${POSTGRES_SPECIFIER}");`],
];

describe("scan", () => {
  test.each(IMPORT_FORMS)("finds a core import into the provider directory in every import form: %s", (_form, text) => {
    const tree = plant({ "src/lib/core.ts": text, [POSTGRES]: "export class PostgresProvider {}" });
    expect(inwardImports(tree.files, tree.listed)).toEqual([{ file: "src/lib/core.ts", module: "sql/postgres.ts" }]);
  });

  test("finds nothing in a comment, a string or a template literal", () => {
    const tree = plant({
      "src/lib/core.ts": [
        `// import "${POSTGRES_SPECIFIER}";`,
        `/* export * from "${POSTGRES_SPECIFIER}"; */`,
        `export const named = "${POSTGRES_SPECIFIER}";`,
        `export const templated = \`${POSTGRES_SPECIFIER}\`;`,
      ].join("\n"),
      [POSTGRES]: "export class PostgresProvider {}",
    });
    expect(inwardImports(tree.files, tree.listed)).toEqual([]);
  });

  test("a provider file and a test file are not core", () => {
    const tree = plant({
      "src/lib/db/providers/sql/mysql.ts": `import { PostgresProvider } from "./postgres";`,
      "tests/unit/core.test.ts": `import { PostgresProvider } from "${POSTGRES_SPECIFIER}";`,
      [POSTGRES]: "export class PostgresProvider {}",
    });
    expect(isCorePath("src/lib/db/providers/sql/mysql.ts")).toBe(false);
    expect(isCorePath("tests/unit/core.test.ts")).toBe(false);
    expect(inwardImports(tree.files, tree.listed)).toEqual([]);
  });

  test("a path that only begins like the provider directory is outside it", () => {
    const tree = plant({
      "src/lib/core.ts": [
        `import { a } from "@/lib/db/providers-x/y";`,
        `import { b } from "@/lib/db/provider-files";`,
      ].join("\n"),
      "src/lib/db/providers-x/y.ts": "export const a = 1;",
      "src/lib/db/provider-files.ts": "export const b = 1;",
    });
    expect(isCorePath("src/lib/db/providers-x/y.ts")).toBe(true);
    expect(inwardImports(tree.files, tree.listed)).toEqual([]);
  });

  test("resolves @/ and relative specifiers from src, bin and vscode-extension/src to the module file, index and .js-to-.ts included", () => {
    const tree = plant({
      "src/lib/db/relative.ts": `import "./providers/sql/postgres";`,
      "src/lib/api/parent.ts": `import "../db/providers/sql/postgres";`,
      "vscode-extension/src/host.ts": `import "${POSTGRES_SPECIFIER}";`,
      "bin/cli.js": `require("../src/lib/db/providers/sql/postgres");`,
      "src/lib/index-import.ts": `import "@/lib/db/providers/vector/milvus";`,
      "src/lib/js-import.ts": `import "${POSTGRES_SPECIFIER}.js";`,
      [POSTGRES]: "export class PostgresProvider {}",
      "src/lib/db/providers/vector/milvus/index.ts": "export class MilvusProvider {}",
    });
    expect(inwardImports(tree.files, tree.listed)).toEqual([
      { file: "bin/cli.js", module: "sql/postgres.ts" },
      { file: "src/lib/api/parent.ts", module: "sql/postgres.ts" },
      { file: "src/lib/db/relative.ts", module: "sql/postgres.ts" },
      { file: "src/lib/index-import.ts", module: "vector/milvus/index.ts" },
      { file: "src/lib/js-import.ts", module: "sql/postgres.ts" },
      { file: "vscode-extension/src/host.ts", module: "sql/postgres.ts" },
    ]);
    expect(resolveSpecifier("src/lib/core.ts", "pg", tree.listed)).toEqual({ kind: "package" });
    expect(resolveSpecifier("src/lib/core.ts", "node:fs", tree.listed)).toEqual({ kind: "package" });
    expect(resolveSpecifier("src/lib/core.ts", "@grpc/proto-loader", tree.listed)).toEqual({ kind: "package" });
    expect(resolveSpecifier("src/lib/core.ts", "./gone", tree.listed)).toEqual({
      kind: "unresolved",
      path: "src/lib/gone",
    });
  });

  test("an unresolvable specifier into the provider directory is still a finding, named by its path", () => {
    const tree = plant({ "src/lib/core.ts": `import "@/lib/db/providers/sql/gone";\nimport "./also-gone";` });
    expect(inwardImports(tree.files, tree.listed)).toEqual([{ file: "src/lib/core.ts", module: "sql/gone" }]);
  });

  test("parses only core files whose text names providers", () => {
    expect(isCandidate({ path: "src/lib/core.ts", text: `import "${POSTGRES_SPECIFIER}";` })).toBe(true);
    expect(isCandidate({ path: "src/lib/core.ts", text: `import "@/lib/db/types";` })).toBe(false);
    expect(isCandidate({ path: POSTGRES, text: `import "./providers";` })).toBe(false);
    expect(isCandidate({ path: "tests/unit/core.test.ts", text: `import "${POSTGRES_SPECIFIER}";` })).toBe(false);
    expect(isCandidate({ path: "src/lib/notes.md", text: "providers" })).toBe(false);
    for (const [, text] of IMPORT_FORMS) {
      for (const specifier of moduleSpecifiers(text)) expect(specifier).toContain("providers");
    }
    expect(isSourcePath("src/lib/core.mts")).toBe(true);
    expect(isSourcePath("bin/cli.cjs")).toBe(true);
    expect(isSourcePath("src/lib/notes.md")).toBe(false);
    expect(SCANNED_ROOTS).toEqual(["src", "bin", "scripts", "vscode-extension/src"]);
  });

  test("outward: lists the core modules provider files import, type-only included, and leaves packages and provider modules out", () => {
    const tree = plant({
      [POSTGRES]: [
        `import type { QueryResult } from "@/lib/db/types";`,
        `import { QueryError } from "../../errors";`,
        `import pg from "pg";`,
        `import { createHash } from "node:crypto";`,
        `import { SQLBaseProvider } from "./sql-base";`,
      ].join("\n"),
      "src/lib/db/providers/sql/sql-base.ts": `import { QueryError } from "@/lib/db/errors";`,
      "src/lib/db/core.ts": `import { QueryError } from "@/lib/db/errors";\nimport "@/lib/logger";`,
      "src/lib/db/types.ts": "export type QueryResult = unknown;",
      "src/lib/db/errors.ts": "export class QueryError {}",
      "src/lib/logger.ts": "export const logger = {};",
    });
    expect([...outwardImports(tree.files, tree.listed)]).toEqual([
      ["src/lib/db/errors.ts", [POSTGRES, "src/lib/db/providers/sql/sql-base.ts"]],
      ["src/lib/db/types.ts", [POSTGRES]],
    ]);
  });

  test("outward: an unresolved specifier in a provider file throws, naming it", () => {
    const tree = plant({ [POSTGRES]: `import { gone } from "./gone";` });
    expect(() => outwardImports(tree.files, tree.listed)).toThrow(`${POSTGRES}: "./gone" resolves to no listed file`);
  });
});

describe("allowlist", () => {
  test("an import the allowlist does not list is new", () => {
    const found: InwardImport[] = [
      { file: "src/lib/a.ts", module: "sql/mysql.ts" },
      { file: "src/lib/a.ts", module: "sql/postgres.ts" },
    ];
    const allowlist: AllowlistEntry[] = [{ file: "src/lib/a.ts", modules: ["sql/postgres.ts"] }];
    expect(compareToAllowlist(found, allowlist)).toEqual({
      added: [{ file: "src/lib/a.ts", module: "sql/mysql.ts" }],
      stale: [],
    });
  });

  test("an allowlist pair no import matches is stale", () => {
    const found: InwardImport[] = [{ file: "src/lib/a.ts", module: "sql/postgres.ts" }];
    const allowlist: AllowlistEntry[] = [
      { file: "src/lib/a.ts", modules: ["sql/mysql.ts", "sql/postgres.ts"] },
      { file: "src/lib/b.ts", modules: ["vector/milvus/index.ts"] },
    ];
    expect(compareToAllowlist(found, allowlist)).toEqual({
      added: [],
      stale: [
        { file: "src/lib/a.ts", module: "sql/mysql.ts" },
        { file: "src/lib/b.ts", module: "vector/milvus/index.ts" },
      ],
    });
  });

  test("the allowlist names each file once, files and modules sorted and unique, every module a provider file that exists", () => {
    const files = INWARD_IMPORTS.map((entry) => entry.file);
    expect(files).toEqual([...new Set(files)].sort());
    for (const entry of INWARD_IMPORTS) {
      expect(isCorePath(entry.file)).toBe(true);
      expect(entry.modules.length).toBeGreaterThan(0);
      expect([...entry.modules]).toEqual([...new Set(entry.modules)].sort());
      const missing = entry.modules.filter((module) => !existsSync(join(ROOT, PROVIDER_DIRECTORY, module)));
      expect({ file: entry.file, missing }).toEqual({ file: entry.file, missing: [] });
    }
  });
});

/** Every file git lists in the repository: tracked, or untracked and not ignored, read once per file run. */
let realTree: { files: SourceText[]; listed: ReadonlySet<string> } | undefined;
function readRealTree(): { files: SourceText[]; listed: ReadonlySet<string> } {
  if (realTree) return realTree;
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const listed = [...new Set(output.split("\0"))].filter((path) => path !== "" && existsSync(join(ROOT, path))).sort();
  const files = listed
    .filter((path) => isSourcePath(path) && SCANNED_ROOTS.some((root) => path.startsWith(`${root}/`)))
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
  realTree = { files, listed: new Set(listed) };
  return realTree;
}

describe("the real tree", () => {
  test(
    "core imports into provider directories are exactly the allowlisted pairs",
    () => {
      const tree = readRealTree();
      const { added, stale } = compareToAllowlist(inwardImports(tree.files, tree.listed), INWARD_IMPORTS);
      expect(
        added.map(
          ({ file, module }) =>
            `new import ${file} -> ${module}: a core file may not import a provider module (${RECORD_FILE}, "The rule")`,
        ),
      ).toEqual([]);
      expect(
        stale.map(
          ({ file, module }) =>
            `${file} no longer imports ${module}: delete it from ${ALLOWLIST_FILE} and, with its file's last module, from ${RECORD_FILE}`,
        ),
      ).toEqual([]);
    },
    REAL_TREE_TIMEOUT,
  );
});
