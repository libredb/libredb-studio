/**
 * The scanner behind `tests/unit/lib/no-engine-branches.test.ts`, held to each branch shape it names, to the
 * spellings that are not a branch (a comment, a plain string argument, an untyped object key, and a longer word that
 * starts with a type id), to the file's own syntax, and to a type alias or constant read from another module. Each
 * case is a planted source, so a shape the scanner stops seeing fails here by name.
 */
import { describe, expect, test } from "bun:test";
import { type BranchFinding, type BranchShape, findEngineBranches } from "./scan";

const TYPE_IDS: ReadonlySet<string> = new Set(["postgres", "oracle", "mssql", "libredb"]);
const PATH = "src/planted.ts";

const scan = (source: string, modules: Readonly<Record<string, string>> = {}, path = PATH): BranchFinding[] =>
  findEngineBranches(path, source, TYPE_IDS, (module) => modules[module]);
const shapes = (
  source: string,
  modules: Readonly<Record<string, string>> = {},
): { declaration: string; shape: BranchShape }[] =>
  scan(source, modules).map(({ declaration, shape }) => ({ declaration, shape }));

describe("keyed-table", () => {
  test.each([
    ["a Partial Record", "const X: Partial<Record<DatabaseType, string>> = {};"],
    ["a ReadonlySet keyed by the connection's type", 'const X: ReadonlySet<DatabaseConnection["type"]> = new Set();'],
    ["a Map", "const X: Map<DatabaseType, number> = new Map();"],
    ["a mapped type", "const X: { [K in DatabaseType]: string } = {} as never;"],
    ["a Record keyed through an alias", "type Engine = DatabaseType;\nconst X: Record<Engine, string> = {} as never;"],
    [
      "a Record keyed through an alias of an alias and a union",
      'type A = DatabaseType | DatabaseConnection["type"];\ntype B = A;\nconst X: Record<B, string> = {} as never;',
    ],
    ["a Record keyed by an Exclude", 'const X: Record<Exclude<DatabaseType, "libredb">, string> = {} as never;'],
    ["a Map built with type arguments", "const X = new Map<DatabaseType, number>();"],
    ["a Record keyed by DatabaseType or a word", 'const X: Record<DatabaseType | "default", string> = {} as never;'],
    ["a Record keyed by DatabaseType or any string", "const X: Record<DatabaseType | string, string> = {};"],
    ["a Set keyed by a type id or a word", 'const X: Set<"postgres" | "none"> = new Set();'],
  ])("%s", (_name, source) => {
    expect(shapes(source)).toEqual([{ declaration: "X", shape: "keyed-table" }]);
  });

  test("a keyed table in a type alias, an interface and a function signature names that declaration", () => {
    const source = [
      "type T = Record<DatabaseType, string>;",
      "interface I { readonly rows: ReadonlyMap<DatabaseType, string> }",
      "function f(rows: Set<DatabaseType>): void {}",
    ].join("\n");
    expect(shapes(source)).toEqual([
      { declaration: "T", shape: "keyed-table" },
      { declaration: "I", shape: "keyed-table" },
      { declaration: "f", shape: "keyed-table" },
    ]);
  });

  test("a Record keyed by a string, or a plain DatabaseType array type, is no table", () => {
    expect(scan("const X: Record<string, DatabaseType> = {};\nconst Y: DatabaseType[] = [];")).toEqual([]);
  });

  test("a Record keyed by a union of words that are not type ids is no table", () => {
    expect(scan('const X: Record<"default" | "none" | string, string> = {};')).toEqual([]);
  });
});

describe("type-id-array", () => {
  test("a typed array and a const array name their declarations", () => {
    const source = 'const L: DatabaseType[] = ["postgres"];\nconst M = ["postgres", "oracle"] as const;';
    expect(shapes(source)).toEqual([
      { declaration: "L", shape: "type-id-array" },
      { declaration: "M", shape: "type-id-array" },
    ]);
  });

  test.each([
    ["an annotation", "const L: DatabaseType[] = [first, second];"],
    ["a read-only annotation", "const L: readonly DatabaseType[] = [first];"],
    ["an Array annotation", 'const L: ReadonlyArray<DatabaseConnection["type"]> = [first];'],
    ["an assertion", "const L = [first] as DatabaseType[];"],
    ["a satisfies", "const L = [first] satisfies Array<DatabaseType>;"],
  ])("an array typed as engine types through %s, holding no literal", (_name, source) => {
    expect(shapes(source)).toEqual([{ declaration: "L", shape: "type-id-array" }]);
  });

  test("an empty engine array, and an array of other types, is no finding", () => {
    expect(scan("const L: DatabaseType[] = [];\nconst M: string[] = [first];")).toEqual([]);
  });

  test("an array is one finding however many type ids it holds", () => {
    expect(scan('const M = new Set(["postgres", "oracle", "mssql"]);')).toHaveLength(1);
  });

  test("an array of other strings is no finding", () => {
    expect(scan('const M = ["postgresql", "mysql8"];')).toEqual([]);
  });
});

describe("comparison and case-label", () => {
  test("an equality either way round is a comparison", () => {
    const source = 'function a(type: string) { if (type === "oracle") return 1; }\nconst b = "mssql" !== dialect;';
    expect(shapes(source)).toEqual([
      { declaration: "a", shape: "comparison" },
      { declaration: "b", shape: "comparison" },
    ]);
  });

  test("a case label", () => {
    expect(shapes('function s(d: string) { switch (d) { case "postgres": return 1; } }')).toEqual([
      { declaration: "s", shape: "case-label" },
    ]);
  });

  test("a parenthesised or asserted literal still counts", () => {
    expect(shapes('const c = t === ("libredb" as DatabaseType);')).toEqual([{ declaration: "c", shape: "comparison" }]);
  });

  test("an angle-bracket assertion still counts", () => {
    expect(shapes('const c = t === <DatabaseType>"libredb";')).toEqual([{ declaration: "c", shape: "comparison" }]);
  });

  test("Object.is with a type id is a comparison", () => {
    expect(shapes('const c = Object.is(t, "mssql");')).toEqual([{ declaration: "c", shape: "comparison" }]);
  });
});

describe("default-position", () => {
  test.each([
    ["an or default", 'const d = conn?.type || "postgres";', "d"],
    ["a nullish default", 'const d = x ?? "oracle";', "d"],
    ["a conditional branch", 'const d = ok ? "postgres" : y;', "d"],
    ["a parameter default", 'function f(t = "postgres") {}', "f"],
    ["a destructuring default", 'function h() { const { type: d = "mssql" } = conn; }', "h"],
    ["a nullish assignment", 'function g() { t ??= "oracle"; }', "g"],
  ])("%s", (_name, source, declaration) => {
    expect(shapes(source)).toEqual([{ declaration, shape: "default-position" }]);
  });
});

describe("not a branch", () => {
  test.each([
    ["a line comment", '// if (type === "postgres")\nconst a = 1;'],
    ["a block comment", '/* case "oracle": */\nconst a = 1;'],
    ["a plain string argument", 'log("postgres");'],
    ["an object key outside a typed table", "const o = { postgres: 1 };"],
    ["a longer word", 'const a = t === "postgresql";'],
    ["a template with a substitution", "const a = t === `${x}postgres`;"],
  ])("%s", (_name, source) => {
    expect(scan(source)).toEqual([]);
  });

  test("a JSX attribute", () => {
    expect(scan('const a = <Icon type="postgres" />;', {}, "src/planted.tsx")).toEqual([]);
  });
});

describe("the file's own syntax", () => {
  test("a .ts file is read as TypeScript, so a generic arrow hides no later branch", () => {
    const source = 'export const first = <T>(xs: readonly T[]): T | undefined => xs[0];\nconst c = t === "oracle";';
    expect(shapes(source)).toEqual([{ declaration: "c", shape: "comparison" }]);
  });

  test("a .tsx file is read with JSX, so a branch inside an element is found", () => {
    const source = 'const a = <Icon on={t === "oracle"} />;';
    expect(scan(source, {}, "src/planted.tsx").map(({ shape }) => shape)).toEqual(["comparison"]);
  });

  test("a file that does not parse fails the scan, naming the file", () => {
    expect(() => scan("const = ;")).toThrow("src/planted.ts");
    expect(() => scan('const a = <Icon type="postgres" />;')).toThrow("src/planted.ts");
  });
});

describe("another module", () => {
  const ENGINE =
    'import type { DatabaseType } from "@/lib/types";\nexport type Engine = Exclude<DatabaseType, "libredb">;';

  test.each([
    ["a relative import", 'import type { Engine } from "./engine";', { "src/engine.ts": ENGINE }],
    ["an alias import", 'import type { Engine } from "@/engine";', { "src/engine.ts": ENGINE }],
    ["an index module", 'import type { Engine } from "./engine";', { "src/engine/index.ts": ENGINE }],
    [
      "a renamed import",
      'import type { Kind as Engine } from "./engine";',
      { "src/engine.ts": ENGINE.replace("Engine", "Kind") },
    ],
    ["a renamed DatabaseType, unresolved", 'import type { DatabaseType as Engine } from "@/lib/types";', {}],
  ])("a Record keyed by an alias from %s", (_name, imports, modules) => {
    const source = `${imports}\nconst X: Partial<Record<Engine, string>> = {};`;
    expect(shapes(source, modules)).toEqual([{ declaration: "X", shape: "keyed-table" }]);
  });

  test("an alias of the connection, an import type and a Lowercase are engine types", () => {
    const source = [
      'type Conn = DatabaseConnection;\nconst A: Set<Conn["type"]> = new Set();',
      'const B: Record<import("@/lib/types").DatabaseType, string> = {} as never;',
      "const C: ReadonlyMap<Lowercase<DatabaseType>, string> = new Map();",
    ].join("\n");
    expect(shapes(source).map(({ declaration }) => declaration)).toEqual(["A", "B", "C"]);
  });

  test("an imported alias that is no engine type, or a module that is not found, is no table", () => {
    const source =
      'import type { Mode } from "./mode";\nimport type { Gone } from "./gone";\nconst X: Record<Mode | Gone, string> = {} as never;';
    expect(scan(source, { "src/mode.ts": 'export type Mode = "light" | "dark";' })).toEqual([]);
  });

  test("an alias that refers to itself across two modules is no table", () => {
    const modules = {
      "src/a.ts": 'import type { B } from "./b";\nexport type A = B;',
      "src/b.ts": 'import type { A } from "./a";\nexport type B = A;',
    };
    expect(scan('import type { A } from "./a";\nconst X: Record<A, string> = {} as never;', modules)).toEqual([]);
  });
});

describe("a type id behind a constant", () => {
  test.each([
    ["a comparison", 'const PG = "postgres";\nconst c = t === PG;', "c", "comparison"],
    [
      "a case label",
      'const PG = "postgres";\nfunction s(d: string) { switch (d) { case PG: return 1; } }',
      "s",
      "case-label",
    ],
    [
      "a default",
      'const DEFAULT_ENGINE: DatabaseType = "postgres";\nconst d = x ?? DEFAULT_ENGINE;',
      "d",
      "default-position",
    ],
    ["an array", 'const PG = "postgres" as const;\nconst L = [PG];', "L", "type-id-array"],
    [
      "a constant of a constant",
      'const PG = "postgres";\nconst ENGINE = PG;\nconst c = t === ENGINE;',
      "c",
      "comparison",
    ],
  ] satisfies [string, string, string, BranchShape][])("still counts in %s", (_name, source, declaration, shape) => {
    expect(shapes(source)).toEqual([{ declaration, shape }]);
  });

  test("an imported constant, renamed or not, still counts", () => {
    const modules = { "src/engines.ts": 'export const ORACLE: DatabaseType = "oracle";' };
    const source = 'import { ORACLE, ORACLE as O } from "./engines";\nconst c = t === ORACLE;\nconst d = t === O;';
    expect(shapes(source, modules)).toEqual([
      { declaration: "c", shape: "comparison" },
      { declaration: "d", shape: "comparison" },
    ]);
  });

  test("a constant that is no type id, a let, or a constant that refers to itself, is no finding", () => {
    const source =
      'const PG = "postgresql";\nlet MY = "oracle";\nconst A = B;\nconst B = A;\nconst c = t === PG || t === MY || t === A;';
    expect(scan(source)).toEqual([]);
  });
});

describe("the finding's place", () => {
  test("path, 1-based line, declaration and the node's text", () => {
    const source = 'const a = 1;\n\nexport class K {\n  readonly p = mode === "oracle";\n}';
    expect(scan(source)).toEqual([
      { path: PATH, declaration: "p", shape: "comparison", line: 4, text: 'mode === "oracle"' },
    ]);
  });

  test("a method names itself, and a top-level statement is the module", () => {
    const source = 'class K { m(t: string) { return t == "mssql"; } }\nif (t != "libredb") run();';
    expect(shapes(source)).toEqual([
      { declaration: "m", shape: "comparison" },
      { declaration: "<module>", shape: "comparison" },
    ]);
  });

  test("text spanning lines is folded onto one", () => {
    const source = "const X: Record<\n  DatabaseType,\n  string\n> = {} as never;";
    expect(scan(source)[0]?.text).toBe("Record< DatabaseType, string >");
  });
});
