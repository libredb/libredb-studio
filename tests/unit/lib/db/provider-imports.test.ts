/**
 * No core file gains an import into a provider directory (provider plugins program, FND-8).
 *
 * Core is every source file git lists under `src/`, `bin/`, `scripts/` and `vscode-extension/src/` outside
 * `src/lib/db/providers/`; the scanner is `./provider-imports/scan.ts`, whose docblock says what it reads and why.
 * The imports core holds today are listed by file in `./provider-imports/inward-allowlist.ts`, and compared by
 * (file, module) pair: a pair the allowlist does not list fails as new, and a listed pair the source no longer holds
 * fails as stale, so the list only shrinks as each slice of the program removes its rows.
 *
 * The decision record `docs/PROVIDER_IMPORTS.md` is held to the same source by two of its tables: the inward table
 * names exactly the allowlisted files, each with its module count and the change that removes it, and the outward
 * table names exactly the core modules provider code imports, each with a destination.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
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
  providerReach,
  resolveSpecifier,
  SCANNED_ROOTS,
  type SourceText,
  valueImportPaths,
  valueSpecifiers,
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

/** The rows of the Markdown table in `text` whose header row is `header`, each cell trimmed and unquoted. */
function tableRows(text: string, header: string): string[][] {
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

const INWARD_HEADER = "| Core file | Imports | Removed by | Destination |";
const OUTWARD_HEADER = "| Module | Destination | Reason |";

const STATEMENT_LANGUAGES: ReadonlySet<string> = new Set(
  Object.values(AGENT_STATEMENT_LANGUAGE).filter((language) => language !== null),
);
const SHIPPED_TYPE_IDS: ReadonlySet<string> = new Set(SHIPPED_DATABASE_TYPES);
const NAMED_REMOVERS: ReadonlySet<string> = new Set([
  "PR 8b",
  "PR 11 connection",
  "PR 11 editor and SQL text",
  "PR 11 policy",
  "PR 11 agent",
  "PR 12",
]);

/** Whether `remover` names a change of the program: a named slice, a language slice of PR 8, or a native port. */
function isRemover(remover: string): boolean {
  if (NAMED_REMOVERS.has(remover) || /^PR 10[a-g]$/.test(remover)) return true;
  const language = /^PR 8 (\S+)$/.exec(remover);
  if (language) return STATEMENT_LANGUAGES.has(language[1]);
  const native = /^(\S+) native PR$/.exec(remover);
  return native !== null && SHIPPED_TYPE_IDS.has(native[1]);
}

/** What the inward table gets wrong against the allowlist, one sentence each. */
function inwardRecordFindings(rows: readonly string[][], allowlist: readonly AllowlistEntry[]): string[] {
  const findings: string[] = [];
  const recorded = new Map(rows.map((row) => [row[0], row]));
  for (const { file, modules } of allowlist) {
    const row = recorded.get(file);
    if (!row) {
      findings.push(`${file} is allowlisted but has no row in the inward table`);
      continue;
    }
    if (!row[1].startsWith(`${modules.length} `)) {
      findings.push(`${file}: the Imports cell must start with its module count ${modules.length}, not "${row[1]}"`);
    }
    for (const remover of row[2].split(", ").filter((name) => !isRemover(name))) {
      findings.push(`${file}: "${remover}" names no change of the program`);
    }
    if (row[3] === "") findings.push(`${file}: the Destination cell is empty`);
  }
  const allowlisted = new Set(allowlist.map(({ file }) => file));
  for (const [file] of recorded) {
    if (!allowlisted.has(file)) findings.push(`${file} has a row in the inward table but is not allowlisted`);
  }
  const order = rows.map((row) => row[0]);
  if (order.join("\n") !== [...order].sort().join("\n")) findings.push("the inward table is not in path order");
  return findings;
}

const DESTINATION = /^(SDK \/[a-z][a-z-]*|host service: \S.*|core only)$/;

/** What the outward table gets wrong against the core modules provider files import, one sentence each. */
function outwardRecordFindings(rows: readonly string[][], outward: ReadonlyMap<string, readonly string[]>): string[] {
  const findings: string[] = [];
  const recorded = new Map(rows.map((row) => [row[0], row]));
  for (const [module, importers] of outward) {
    if (!recorded.has(module)) {
      findings.push(`${module} is imported by ${importers.join(", ")} but has no row in the outward table`);
    }
  }
  for (const [module, row] of recorded) {
    if (!outward.has(module)) findings.push(`${module} has a row in the outward table but no provider imports it`);
    if (!DESTINATION.test(row[1])) findings.push(`${module}: "${row[1]}" is not a destination`);
    if (row[2] === "") findings.push(`${module}: the Reason cell is empty`);
  }
  const order = rows.map((row) => row[0]);
  if (order.join("\n") !== [...order].sort().join("\n")) findings.push("the outward table is not in path order");
  return findings;
}

describe("the decision record", () => {
  test("a planted inward table fails on a missing row, an extra row, a wrong count and an unknown remover", () => {
    const allowlist: AllowlistEntry[] = [
      { file: "src/lib/a.ts", modules: ["sql/mysql.ts", "sql/postgres.ts"] },
      { file: "src/lib/b.ts", modules: ["vector/milvus/index.ts"] },
    ];
    const rows = [
      ["src/lib/a.ts", "3 sql rows", "PR 8 sql, PR 9", "the SQL family"],
      ["src/lib/c.ts", "1 row", "PR 8 cobol", ""],
    ];
    expect(inwardRecordFindings(rows, allowlist)).toEqual([
      'src/lib/a.ts: the Imports cell must start with its module count 2, not "3 sql rows"',
      'src/lib/a.ts: "PR 9" names no change of the program',
      "src/lib/b.ts is allowlisted but has no row in the inward table",
      "src/lib/c.ts has a row in the inward table but is not allowlisted",
    ]);
    expect(
      inwardRecordFindings(
        [["src/lib/b.ts", "1 milvus reader", "PR 8b, PR 10c, PR 12, snmp native PR, PR 11 agent", "core"]],
        [{ file: "src/lib/b.ts", modules: ["vector/milvus/index.ts"] }],
      ),
    ).toEqual([]);
    expect(inwardRecordFindings([["src/lib/b.ts", "1 x", "cobol native PR", ""]], allowlist.slice(1))).toEqual([
      'src/lib/b.ts: "cobol native PR" names no change of the program',
      "src/lib/b.ts: the Destination cell is empty",
    ]);
  });

  test("a planted outward table fails on a missing row, a stale row, a malformed destination and an empty reason", () => {
    const outward = new Map([
      ["src/lib/db/errors.ts", [POSTGRES]],
      ["src/lib/logger.ts", [POSTGRES]],
    ]);
    const rows = [
      ["src/lib/db/errors.ts", "SDK errors", ""],
      ["src/lib/db/types.ts", "core only", "a reason"],
    ];
    expect(outwardRecordFindings(rows, outward)).toEqual([
      `src/lib/logger.ts is imported by ${POSTGRES} but has no row in the outward table`,
      'src/lib/db/errors.ts: "SDK errors" is not a destination',
      "src/lib/db/errors.ts: the Reason cell is empty",
      "src/lib/db/types.ts has a row in the outward table but no provider imports it",
    ]);
    expect(
      outwardRecordFindings(
        [
          ["src/lib/db/errors.ts", "SDK /errors", "the error classes"],
          ["src/lib/logger.ts", "host service: logging", "the process logger"],
        ],
        outward,
      ),
    ).toEqual([]);
  });

  test(
    "its inward table lists exactly the allowlisted files, each removed by a named PR",
    () => {
      const rows = tableRows(readFileSync(join(ROOT, RECORD_FILE), "utf8"), INWARD_HEADER);
      expect(inwardRecordFindings(rows, INWARD_IMPORTS)).toEqual([]);
    },
    REAL_TREE_TIMEOUT,
  );

  test(
    "its outward table lists exactly the core modules provider code imports, each with a destination",
    () => {
      const tree = readRealTree();
      const rows = tableRows(readFileSync(join(ROOT, RECORD_FILE), "utf8"), OUTWARD_HEADER);
      expect(outwardRecordFindings(rows, outwardImports(tree.files, tree.listed))).toEqual([]);
    },
    REAL_TREE_TIMEOUT,
  );

  test("a record without a table fails by naming the header it looked for", () => {
    expect(() => tableRows("# Provider import census\n", INWARD_HEADER)).toThrow(
      `${RECORD_FILE} has no table with the header ${INWARD_HEADER}`,
    );
  });
});

const SDK_SQL = "SDK /sql";

/** One sentence per reader that reaches a provider module: how many, and the path to the first. */
function reachFindings(
  readers: readonly string[],
  tree: { files: SourceText[]; listed: ReadonlySet<string> },
): string[] {
  return readers.flatMap((reader) => {
    const reach = providerReach(reader, tree.files, tree.listed);
    if (reach.length === 0) return [];
    return [
      `${reader} reaches ${reach.length} provider modules through its value imports, first ${reach[0].join(" -> ")}`,
    ];
  });
}

describe("the SDK /sql readers", () => {
  test("valueSpecifiers reads what loads a module and leaves out what the compiler erases", () => {
    const text = [
      'import { a } from "./value";',
      'import type { B } from "./type-only";',
      'import { type C, type D } from "./inline-types";',
      'import { type E, f } from "./mixed";',
      'import g, { type H } from "./default";',
      'import * as i from "./namespace";',
      'import "./side-effect";',
      'export type { J } from "./export-type";',
      'export { type K } from "./export-inline-type";',
      'export { l } from "./export-value";',
      'export * from "./export-star";',
      'import m = require("./import-equals");',
      'export type N = typeof import("./typeof-import");',
      'export const o = () => import("./dynamic");',
      'export const p = require("./require");',
      "export const q = (name: string) => import(name);",
    ].join("\n");

    expect(valueSpecifiers(text)).toEqual([
      "./value",
      "./mixed",
      "./default",
      "./namespace",
      "./side-effect",
      "./export-value",
      "./export-star",
      "./import-equals",
      "./dynamic",
      "./require",
    ]);
  });

  test("a reader that value-imports the grammar module is reported with the path it took", () => {
    const tree = plant({
      "src/lib/sql/reader.ts":
        'import { resolveSqlGrammar } from "./grammar";\nimport { x } from "@libredb/provider-sdk/sql";',
      "src/lib/sql/grammar.ts": 'import { sqlGrammarFor } from "@/lib/db/sql-grammar";',
      "src/lib/db/sql-grammar/index.ts": `import { POSTGRES_GRAMMAR } from "${POSTGRES_SPECIFIER}";\nimport data from "./data.json";`,
      "src/lib/db/sql-grammar/data.json": "{}",
      [POSTGRES]: "export const POSTGRES_GRAMMAR = {};",
    });

    expect(reachFindings(["src/lib/sql/reader.ts"], tree)).toEqual([
      `src/lib/sql/reader.ts reaches 1 provider modules through its value imports, first src/lib/sql/reader.ts -> src/lib/sql/grammar.ts -> src/lib/db/sql-grammar/index.ts -> ${POSTGRES}`,
    ]);
  });

  test("a type-only import of the grammar module reaches no provider module", () => {
    const tree = plant({
      "src/lib/sql/reader.ts": 'import type { G } from "./grammar";\nimport { type H } from "./grammar";',
      "src/lib/sql/grammar.ts": `import { P } from "${POSTGRES_SPECIFIER}";`,
      [POSTGRES]: "export const P = 1;",
    });

    expect(reachFindings(["src/lib/sql/reader.ts"], tree)).toEqual([]);
  });

  test("an unresolved specifier or an unread source file in the closure throws, naming it", () => {
    expect(() =>
      valueImportPaths("src/a.ts", plant({ "src/a.ts": 'import "./missing";' }).files, new Set(["src/a.ts"])),
    ).toThrow('src/a.ts: "./missing" resolves to no listed file');
    expect(() =>
      valueImportPaths("src/a.ts", plant({ "src/a.ts": 'import "./b";' }).files, new Set(["src/a.ts", "src/b.ts"])),
    ).toThrow("src/b.ts is reached but its text was not read");
  });

  test(
    "every core module the outward table sends to SDK /sql reaches no provider module",
    () => {
      const tree = readRealTree();
      const readers = tableRows(readFileSync(join(ROOT, RECORD_FILE), "utf8"), OUTWARD_HEADER)
        .filter((row) => row[1] === SDK_SQL)
        .map((row) => row[0]);

      expect(readers.length).toBeGreaterThan(0);
      expect(reachFindings(readers, tree)).toEqual([]);
    },
    REAL_TREE_TIMEOUT,
  );
});
