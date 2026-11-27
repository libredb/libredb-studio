/**
 * The isolation ratchet: counters of provider knowledge in core that may only fall, and of engines in packages that
 * may only rise, held to the committed baseline `tests/unit/isolation-ratchet.baseline.json`.
 *
 * `scripts/isolation-ratchet.ts` defines every counter and is a pure function over a file list and a reader, so most
 * cases here plant a small tree in memory; the last describe block measures the working tree and prints every counter,
 * report-only ones included.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BASELINE_FILE,
  type Baseline,
  compareWithBaseline,
  EXCEPTIONS,
  type Exception,
  GATE_COUNTERS,
  GRANT_REGISTER_DIRECTORY,
  GRANT_REGISTER_FILE,
  type Io,
  LANGUAGE_MACHINERY_MODULES,
  LANGUAGE_SCHEMA_FILE,
  LINE_GATES,
  main,
  type Measurement,
  measure,
  NON_ENGINE_PACKAGES,
  type NonEnginePackage,
  parseBaseline,
  REGENERATE_SENTENCE,
  REPORT_COUNTERS,
  realIo,
  renderBaseline,
  STATEMENT_LANGUAGE_PROJECTION,
} from "../../scripts/isolation-ratchet";
import { INWARD_IMPORTS } from "./lib/db/provider-imports/inward-allowlist";

const ROOT = path.resolve(import.meta.dir, "../..");
const REGENERATE = "run bun run isolation:baseline and commit the result";

type Files = Record<string, string>;

/** Two declared engines, one hand-written core file naming one of them, and the SDK package. */
const BASE: Files = {
  "src/lib/db/engine-declarations/alpha.json": "{}\n",
  "src/lib/db/engine-declarations/postgres.json": "{}\n",
  "src/lib/core.ts": 'export const DEFAULT = "postgres";\n',
  "packages/provider-sdk/src/index.ts": "export {};\n",
};

interface Lists {
  readonly inward?: readonly { readonly modules: readonly string[] }[];
  readonly exceptions?: readonly Exception[];
  readonly nonEnginePackages?: readonly NonEnginePackage[];
}

function tree(files: Files) {
  return {
    files: Object.keys(files),
    read: (file: string) => {
      const text = files[file];
      if (text === undefined) throw new Error(`fixture has no file ${file}`);
      return text;
    },
  };
}

function measureFiles(extra: Files, lists: Lists = {}, base: Files = BASE): Measurement {
  return measure(tree({ ...base, ...extra }), {
    inward: lists.inward ?? [],
    exceptions: lists.exceptions ?? [],
    nonEnginePackages: lists.nonEnginePackages ?? NON_ENGINE_PACKAGES,
  });
}

function gate(extra: Files, lists: Lists = {}, base: Files = BASE): Baseline["counters"] {
  return measureFiles(extra, lists, base).baseline.counters;
}

/** A legacy row of the grant register, keyed as the register keys it, granting no statement language. */
function legacyRow(engine: string): Record<string, unknown> {
  return { legacy: "@libredb/studio", engine, grants: { statementLanguage: null } };
}

/** A package row of the grant register, granting no statement language. */
function packageRow(engine: string): Record<string, unknown> {
  return {
    package: { name: `@libredb/provider-${engine}`, version: "1.0.0", digest: "sha256-x" },
    engine,
    grants: { statementLanguage: null },
  };
}

/** The grant register file holding `rows`. */
function register(rows: readonly unknown[]): Files {
  return { [GRANT_REGISTER_FILE]: `${JSON.stringify(rows, null, 2)}\n` };
}

/** The comparison's messages for a tree measured against the base tree's baseline. */
function messagesAgainstBase(extra: Files, lists: Lists = {}): string[] {
  return compareWithBaseline(measureFiles({}, lists).baseline, measureFiles(extra, lists).baseline).map(
    (finding) => finding.message,
  );
}

describe("naming an engine in hand-written core", () => {
  test("a new hand-written file naming an engine id raises the files counter and is refused", () => {
    const before = gate({});
    const after = gate({ "src/lib/other.ts": 'const a = "postgres";\nconst b = "postgres";\n' });

    expect(before["coreHandwritten.filesNamingAnEngine"]).toBe(1);
    expect(after["coreHandwritten.filesNamingAnEngine"]).toBe(2);
    expect(after["coreHandwritten.linesNamingAnEngine"]).toBe(3);
    expect(after["coreHandwritten.distinctEngineIds"]).toBe(1);
    expect(messagesAgainstBase({ "src/lib/other.ts": 'const a = "postgres";\n' })).toEqual([
      "coreHandwritten.filesNamingAnEngine: baseline 1, now 2; it may only fall",
      "coreHandwritten.linesNamingAnEngine: baseline 1, now 2; it may only fall",
    ]);
  });

  test("an object key naming an engine counts as naming it", () => {
    for (const line of ["alpha: 1,", "  alpha?: 1,", "const x = {alpha:1};", "type T = { a: 1; alpha : 2 };"]) {
      const measured = measureFiles({ "src/lib/keys.ts": `${line}\n` }).baseline;

      expect({ line, lines: measured.counters["coreHandwritten.linesNamingAnEngine"] }).toEqual({ line, lines: 2 });
      expect(measured.ids["coreHandwritten.engineIdsNamed"]).toEqual(["alpha", "postgres"]);
    }
  });

  test("each quoted literal form names an engine, and a literal holding more than the id does not", () => {
    for (const line of ['a = "alpha";', "a = 'alpha';", "a = `alpha`;"]) {
      expect({ line, lines: gate({ "src/lib/q.ts": `${line}\n` })["coreHandwritten.linesNamingAnEngine"] }).toEqual({
        line,
        lines: 2,
      });
    }
    for (const line of [
      'a = "alpha-x";',
      "alphaish: 1,",
      'a = "Alpha";',
      'import x from "./alpha/index";',
      "a = \"alpha';",
      "// the alpha engine",
    ]) {
      expect({ line, lines: gate({ "src/lib/q.ts": `${line}\n` })["coreHandwritten.linesNamingAnEngine"] }).toEqual({
        line,
        lines: 1,
      });
    }
  });

  test("two engines on one line count one line and both engines", () => {
    const measured = measureFiles({ "src/lib/two.ts": 'const both = ["alpha", "postgres"];\n' }).baseline;

    expect(measured.counters["coreHandwritten.linesNamingAnEngine"]).toBe(2);
    expect(measured.counters["coreHandwritten.distinctEngineIds"]).toBe(2);
  });

  test("only core source roots and code extensions count, and the ratchet script itself does not", () => {
    const line = 'x = "alpha";\n';
    const counted = [
      "src/a.ts",
      "src/a.tsx",
      "src/a.js",
      "src/a.mjs",
      "src/a.cjs",
      "src/a.mts",
      "src/a.cts",
      "src/a.jsx",
      "bin/a.js",
      "scripts/a.ts",
      "vscode-extension/src/a.ts",
    ];
    const ignored = [
      "tests/a.ts",
      "e2e/a.ts",
      "packages/provider-alpha/src/a.ts",
      "docs/a.ts",
      "src/a.md",
      "src/a.json",
      "vscode-extension/test/a.ts",
      "lib/a.ts",
      "scripts/isolation-ratchet.ts",
    ];
    for (const file of counted) {
      expect({ file, files: gate({ [file]: line })["coreHandwritten.filesNamingAnEngine"] }).toEqual({
        file,
        files: 2,
      });
    }
    for (const file of ignored) {
      expect({ file, files: gate({ [file]: line })["coreHandwritten.filesNamingAnEngine"] }).toEqual({
        file,
        files: 1,
      });
    }
  });

  test("a file under src/lib/provider-host/legacy-adapter/ counts as hand-written core, so moving engine code into the adapter is no fall", () => {
    const before = gate({ "src/lib/old.ts": 'x = "alpha";\n' });
    const after = gate({ "src/lib/provider-host/legacy-adapter/alpha.ts": 'x = "alpha";\n' });

    expect(after).toEqual(before);
    expect(after["coreHandwritten.filesNamingAnEngine"]).toBe(2);
  });
});

describe("generated and legacy provider files", () => {
  test("a generated module counts only toward generated lines", () => {
    const after = gate({
      "src/lib/db/engine-catalog/rows.generated.ts":
        "export const R = { alpha: 1 };\nconst T: Record<DatabaseType, 1> = {};\n",
    });

    expect(after["coreGenerated.lines"]).toBe(2);
    expect(after["coreHandwritten.filesNamingAnEngine"]).toBe(1);
    expect(after["coreHandwritten.linesNamingAnEngine"]).toBe(1);
    expect(after["coreHandwritten.distinctEngineIds"]).toBe(1);
    expect(after.engineKeyedTypePositions).toBe(0);
    expect(gate({})["coreGenerated.lines"]).toBe(0);
  });

  test("a file under src/lib/db/providers counts only toward legacy provider files", () => {
    const before = gate({});
    const after = gate({ "src/lib/db/providers/stream/alpha.ts": 'export const ID = "alpha";\n' });

    expect(after["legacyProviders.files"]).toBe(before["legacyProviders.files"] + 1);
    const expected: Record<string, number> = { ...after, "legacyProviders.files": before["legacyProviders.files"] };
    expect(expected).toEqual(before);
  });

  test("a file without a final newline counts its last line, and an empty file counts none", () => {
    expect(gate({ "src/lib/x.generated.ts": "a\nb" })["coreGenerated.lines"]).toBe(2);
    expect(gate({ "src/lib/x.generated.ts": "a\nb\n" })["coreGenerated.lines"]).toBe(2);
    expect(gate({ "src/lib/x.generated.ts": "" })["coreGenerated.lines"]).toBe(0);
  });
});

describe("directory and list counters", () => {
  test("agent language files count in a language directory, not directly in src/lib/agent/languages", () => {
    const after = gate({
      "src/lib/agent/languages/sql/pack.ts": "",
      "src/lib/agent/languages/sql/engines/x.ts": "",
      "src/lib/agent/languages/pack.ts": "",
    });

    expect(after["agentLanguages.filesInLanguageDirs"]).toBe(2);
  });

  test("every file under src/lib/languages counts", () => {
    expect(gate({ "src/lib/languages/kubectl/a.ts": "", "src/lib/languages/b.md": "" })["languages.files"]).toBe(2);
  });

  test("engine declarations count every json under src/lib/db/engine-declarations", () => {
    expect(gate({})["engineDeclarations.files"]).toBe(2);
    expect(gate({ "src/lib/db/engine-declarations/README.md": "" })["engineDeclarations.files"]).toBe(2);
  });

  test("provider docs in core count docs/providers/<id>.md only for an engine id", () => {
    const after = gate({
      "docs/providers/alpha.md": "",
      "docs/providers/CONTRACT.md": "",
      "docs/providers/README.md": "",
      "docs/providers/sub/postgres.md": "",
    });

    expect(after.providerDocsInCore).toBe(1);
  });

  test("provider integration tests in core count tests/integration/db/*-provider.test.ts", () => {
    const after = gate({
      "tests/integration/db/alpha-provider.test.ts": "",
      "tests/integration/db/alpha-helpers.test.ts": "",
      "tests/unit/db/alpha-provider.test.ts": "",
    });

    expect(after.providerIntegrationTestsInCore).toBe(1);
  });

  test("inward import pairs are the sum of every allowlisted core file's modules", () => {
    const inward = [{ modules: ["a.ts"] }, { modules: ["b.ts", "c.ts"] }];

    expect(gate({}, { inward }).inwardImportPairs).toBe(3);
  });

  test("engine-keyed type positions count each keyed form once in hand-written core", () => {
    const text = [
      "type A = Record<DatabaseType, string>;",
      "type B = Readonly<Record<\n  DatabaseType,\n  string\n>>;",
      "type C = { [K in DatabaseType]: number };",
      "type D = { readonly [k in Exclude<DatabaseType, 'x'>]?: number };",
      "const e = new Map<DatabaseType, number>();",
      "const f: ReadonlyMap<DatabaseType, number> = e;",
      "const g = new WeakMap<DatabaseType, object>();",
      "type H = Record<Extract<DatabaseType, 'y'>, 1>;",
      "const notKeyed: readonly DatabaseType[] = [];",
      "type NotKeyed = Record<string, DatabaseType>;",
      "type Other = Record<ExternalDatabaseType, 1>;",
    ].join("\n");

    expect(gate({ "src/lib/keyed.ts": `${text}\n` }).engineKeyedTypePositions).toBe(8);
  });
});

describe("engine ids and packages", () => {
  test("an engine id survives its move into packages", () => {
    const moved: Files = { ...BASE, "packages/provider-alpha/src/index.ts": "export {};\n" };
    delete moved["src/lib/db/engine-declarations/alpha.json"];
    const measured = measure(tree({ ...moved, "src/lib/k.ts": 'x = "alpha";\n' }), {
      inward: [],
      exceptions: [],
      nonEnginePackages: NON_ENGINE_PACKAGES,
    });

    expect(measured.baseline.counters.enginesInPackages).toBe(1);
    expect(measured.baseline.ids["enginesInPackages.ids"]).toEqual(["alpha"]);
    expect(measured.baseline.ids["coreHandwritten.engineIdsNamed"]).toEqual(["alpha", "postgres"]);
    expect(measured.report.engineIds).toBe(2);
  });

  test("the SDK package is not an engine", () => {
    const measured = measureFiles({ "src/lib/s.ts": 'x = "sdk";\n' });

    expect(measured.baseline.counters.enginesInPackages).toBe(0);
    expect(measured.baseline.counters["coreHandwritten.filesNamingAnEngine"]).toBe(1);
    expect(measured.report.engineIds).toBe(2);
    expect(NON_ENGINE_PACKAGES.map((entry) => entry.directory)).toEqual(["provider-sdk"]);
  });

  test("a non-engine package entry that names no directory is refused", () => {
    const measured = measureFiles(
      {},
      { nonEnginePackages: [...NON_ENGINE_PACKAGES, { directory: "provider-kit", reason: "a kit" }] },
    );

    expect(measured.stale).toEqual(["NON_ENGINE_PACKAGES: provider-kit names no directory under packages/"]);
  });

  test("a core source file with an engine id as a path segment counts toward coreSource.filesWithEngineInPath, and a file whose name only contains the id inside a word does not", () => {
    const counted = [
      "src/lib/explain/postgres-json.ts",
      "src/lib/alpha/x.ts",
      "scripts/generate-alpha-descriptor.mjs",
      "src/lib/x.postgres.ts",
      "src/lib/a_alpha.ts",
      "vscode-extension/src/types/alpha.d.ts",
      "src/lib/alpha.generated.ts",
    ];
    const ignored = [
      "src/lib/postgresql.ts",
      "src/lib/alphaish/x.ts",
      "src/lib/Alpha.ts",
      "src/lib/db/providers/stream/alpha.ts",
      "tests/unit/alpha.test.ts",
      "packages/provider-alpha/src/x.ts",
      "src/lib/alpha.md",
    ];
    const files = Object.fromEntries([...counted, ...ignored].map((file) => [file, ""]));

    expect(measureFiles({}).report["coreSource.filesWithEngineInPath"]).toBe(0);
    expect(measureFiles(files).report["coreSource.filesWithEngineInPath"]).toBe(counted.length);
    for (const file of ignored) {
      expect({ file, files: measureFiles({ [file]: "" }).report["coreSource.filesWithEngineInPath"] }).toEqual({
        file,
        files: 0,
      });
    }
  });
});

describe("non-engine packages", () => {
  const SDK_LINES = "nonEnginePackages.linesNamingAnEngine";
  const SDK_IDS = "nonEnginePackages.engineIdsNamed";

  test("a line naming an engine in a non-engine package's source counts toward nonEnginePackages.linesNamingAnEngine", () => {
    const before = gate({});
    const measured = measureFiles({
      "packages/provider-sdk/src/x.ts":
        'export type D = "alpha" | "postgres";\nconst k = { alpha: 1 };\nconst n = 1;\n',
    }).baseline;

    expect(before[SDK_LINES]).toBe(0);
    expect(measured.counters[SDK_LINES]).toBe(2);
    expect(measured.ids[SDK_IDS]).toEqual(["alpha", "postgres"]);
    const core: Record<string, number> = { ...measured.counters, [SDK_LINES]: 0 };
    expect(core).toEqual(before);
  });

  test("a file under a non-engine package's tests/ does not count", () => {
    expect(gate({ "packages/provider-sdk/tests/x.test.ts": 'x = "alpha";\n' })[SDK_LINES]).toBe(0);
    expect(gate({ "packages/provider-sdk/src/tests/x.ts": 'x = "alpha";\n' })[SDK_LINES]).toBe(1);
  });

  test("a JSON file of a non-engine package counts like a source file", () => {
    expect(gate({ "packages/provider-sdk/src/manifest/schema.json": '"enum": ["alpha"]\n' })[SDK_LINES]).toBe(1);
    expect(gate({ "packages/provider-sdk/README.md": "the `alpha` engine\n" })[SDK_LINES]).toBe(1);
  });

  test("a packages/provider-<id>/ directory of an engine counts toward engines in packages, not toward non-engine packages", () => {
    const measured = measureFiles({ "packages/provider-alpha/src/x.ts": 'export const ID = "alpha";\n' }).baseline;

    expect(measured.counters[SDK_LINES]).toBe(0);
    expect(measured.ids[SDK_IDS]).toEqual([]);
    expect(measured.counters.enginesInPackages).toBe(1);
  });

  test("an engine id newly named in a non-engine package is refused at an unchanged line count", () => {
    const file = "packages/provider-sdk/src/x.ts";
    const before = measureFiles({ [file]: 'x = "alpha";\n' }).baseline;
    const after = measureFiles({ [file]: 'x = "postgres";\n' }).baseline;

    expect(after.counters[SDK_LINES]).toBe(before.counters[SDK_LINES]);
    expect(compareWithBaseline(before, after)).toEqual([
      {
        kind: "worse",
        message: `${SDK_IDS}: postgres is named in a non-engine package and the baseline does not list it`,
      },
      {
        kind: "better",
        message: `${SDK_IDS}: alpha is no longer named in a non-engine package; ${REGENERATE}`,
      },
    ]);
  });
});

describe("the grant register", () => {
  const LEGACY_ROWS = "grantRegister.legacyRows";
  const REGISTER_LINES = "grantRegister.linesNamingAnEngine";
  const REGISTER_IDS = "grantRegister.engineIdsNamed";
  /** An empty register, planted beside any other register file, since a register file without it is refused. */
  const EMPTY_REGISTER: Files = { [GRANT_REGISTER_FILE]: "[]\n" };

  test("a legacy row of the grant register counts toward grantRegister.legacyRows, and a package row toward no gate counter", () => {
    const before = gate({});
    const two = register([legacyRow("alpha"), legacyRow("postgres")]);
    const withPackageRow = register([legacyRow("alpha"), legacyRow("postgres"), packageRow("mqtt")]);
    const three = register([legacyRow("alpha"), legacyRow("postgres"), legacyRow("mqtt")]);
    const one = register([legacyRow("alpha")]);

    expect(GRANT_REGISTER_FILE).toBe("packages/grant-register/src/register.json");
    expect(GATE_COUNTERS.at(-1)).toEqual({ name: LEGACY_ROWS, direction: "falls" });
    expect(before[LEGACY_ROWS]).toBe(0);
    expect(gate(two)[LEGACY_ROWS]).toBe(2);
    const others: Record<string, number> = { ...gate(two), [LEGACY_ROWS]: 0 };
    expect(others).toEqual(before);
    expect(gate(withPackageRow)).toEqual(gate(two));
    expect(compareWithBaseline(measureFiles(two).baseline, measureFiles(withPackageRow).baseline)).toEqual([]);
    expect(compareWithBaseline(measureFiles(two).baseline, measureFiles(three).baseline)).toEqual([
      { kind: "worse", message: `${LEGACY_ROWS}: baseline 2, now 3; it may only fall` },
    ]);
    expect(compareWithBaseline(measureFiles(two).baseline, measureFiles(one).baseline)).toEqual([
      { kind: "better", message: `${LEGACY_ROWS}: baseline 2, now 1, an improvement; ${REGENERATE}` },
    ]);
  });

  test("the register's lines, bytes and review notes are printed as report counters and never compared", () => {
    const small = measureFiles({
      ...EMPTY_REGISTER,
      "packages/grant-register/src/index.ts": "// é\n",
      "packages/grant-register/tests/x.test.ts": "a\nb\nc\n",
    });
    const rows = [
      { ...legacyRow("alpha"), reasons: { writeReach: "a", sshTunnel: "b" } },
      { ...packageRow("mqtt"), reasons: { ownWords: "c" } },
      legacyRow("postgres"),
    ];
    const noted = measureFiles(register(rows));
    const renoted = measureFiles(
      register([{ ...rows[0], reasons: { writeReach: "a much longer note" } }, rows[1], rows[2]]),
    );
    const text = `${JSON.stringify(rows, null, 2)}\n`;

    expect(REPORT_COUNTERS).toContain("grantRegister.lines");
    expect(REPORT_COUNTERS).toContain("grantRegister.bytes");
    expect(REPORT_COUNTERS).toContain("grantRegister.reviewNotes");
    expect(small.report["grantRegister.lines"]).toBe(2);
    expect(small.report["grantRegister.bytes"]).toBe(9);
    expect(small.report["grantRegister.reviewNotes"]).toBe(0);
    expect(noted.report["grantRegister.lines"]).toBe(text.split("\n").length - 1);
    expect(noted.report["grantRegister.bytes"]).toBe(new TextEncoder().encode(text).length);
    expect(noted.report["grantRegister.reviewNotes"]).toBe(3);
    expect(renoted.report["grantRegister.reviewNotes"]).toBe(2);
    expect(renoted.report["grantRegister.bytes"]).not.toBe(noted.report["grantRegister.bytes"]);
    expect(compareWithBaseline(noted.baseline, renoted.baseline)).toEqual([]);
    const rendered = renderBaseline(noted.baseline);
    for (const name of ["grantRegister.lines", "grantRegister.bytes", "grantRegister.reviewNotes", REGISTER_LINES]) {
      expect(rendered).not.toContain(`"${name}"`);
    }
  });

  test("an engine newly named in the grant register changes no gate counter and shows in the report id list", () => {
    const before = measureFiles(register([legacyRow("alpha")]));
    const after = measureFiles(register([legacyRow("alpha"), packageRow("postgres")]));

    expect(REPORT_COUNTERS).toContain(REGISTER_LINES);
    expect(before.report[REGISTER_LINES]).toBe(1);
    expect(after.report[REGISTER_LINES]).toBe(2);
    expect(before.reportIds[REGISTER_IDS]).toEqual(["alpha"]);
    expect(after.reportIds[REGISTER_IDS]).toEqual(["alpha", "postgres"]);
    expect(after.baseline.counters).toEqual(before.baseline.counters);
    expect(compareWithBaseline(before.baseline, after.baseline)).toEqual([]);
    expect(Object.keys(after.baseline.ids)).not.toContain(REGISTER_IDS);
  });

  test("a file under the register's tests/ does not count, and a JSON file of the register counts like a source file", () => {
    const lines = (files: Files) => measureFiles(files).report[REGISTER_LINES];

    expect(GRANT_REGISTER_DIRECTORY).toBe("grant-register");
    expect(lines({ "packages/grant-register/tests/x.test.ts": 'x = "alpha";\n' })).toBe(0);
    expect(lines({ ...EMPTY_REGISTER, "packages/grant-register/src/tests/x.ts": 'x = "alpha";\n' })).toBe(1);
    expect(
      lines({ ...EMPTY_REGISTER, "packages/grant-register/src/register.schema.json": '"enum": ["alpha"]\n' }),
    ).toBe(1);
    expect(
      lines({ ...EMPTY_REGISTER, "packages/grant-register/package.json": '{ "description": "the `alpha` engine" }\n' }),
    ).toBe(1);
  });

  test("a grant register file without register.json, or a register.json that is not an array of rows, is refused by name", () => {
    const refusal = (files: Files) => {
      try {
        measureFiles(files);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("measure accepted the register");
    };
    const at = (text: string) => refusal({ [GRANT_REGISTER_FILE]: text });

    expect(refusal({ "packages/grant-register/package.json": "{}\n" })).toBe(
      `${GRANT_REGISTER_FILE} is missing, and the grant register holds other files, so its rows cannot be counted`,
    );
    expect(at("{")).toStartWith(`${GRANT_REGISTER_FILE} is not JSON: `);
    expect(at("{}\n")).toBe(`${GRANT_REGISTER_FILE} is not a JSON array of rows`);
    expect(at("[1]\n")).toBe(`${GRANT_REGISTER_FILE}: row 0 is not an object with a string engine`);
    expect(at('[{"engine":"alpha","grants":{"statementLanguage":null}},{}]\n')).toBe(
      `${GRANT_REGISTER_FILE}: row 1 is not an object with a string engine`,
    );
    expect(at('[{"engine":"alpha","reasons":[]}]\n')).toBe(
      `${GRANT_REGISTER_FILE}: row 0 (alpha) has reasons that are not an object`,
    );
    const cause = (() => {
      try {
        measureFiles({ [GRANT_REGISTER_FILE]: "{" });
      } catch (error) {
        return (error as Error).cause;
      }
      return undefined;
    })();
    expect(cause).toBeInstanceOf(SyntaxError);
    const none = measureFiles({});
    expect(none.baseline.counters[LEGACY_ROWS]).toBe(0);
    expect(none.report["grantRegister.lines"]).toBe(0);
    expect(none.report["grantRegister.bytes"]).toBe(0);
    expect(none.report["grantRegister.reviewNotes"]).toBe(0);
  });

  /** The message measure refuses a register holding `rows` with. */
  const rowRefusal = (rows: readonly unknown[]) => {
    try {
      measureFiles(register(rows));
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("measure accepted the register");
  };

  test("a register row whose grants is not an object is refused by name, never read as granting no language", () => {
    const unreadable = (index: number, engine: string) =>
      `${GRANT_REGISTER_FILE}: row ${index} (${engine}) has grants that are not an object`;

    expect(rowRefusal([legacyRow("alpha"), { ...legacyRow("postgres"), grants: "sql" }])).toBe(
      unreadable(1, "postgres"),
    );
    expect(rowRefusal([{ ...packageRow("mqtt"), grants: [] }])).toBe(unreadable(0, "mqtt"));
    expect(rowRefusal([{ legacy: "@libredb/studio", engine: "alpha" }])).toBe(unreadable(0, "alpha"));
  });

  test("a register row whose statement language is neither a string nor null is refused by name, never read as granting no language", () => {
    const unreadable = (index: number, engine: string) =>
      `${GRANT_REGISTER_FILE}: row ${index} (${engine}) has a grants.statementLanguage that is neither a string nor null`;

    expect(rowRefusal([legacyRow("alpha"), { ...legacyRow("postgres"), grants: { statementLanguage: 7 } }])).toBe(
      unreadable(1, "postgres"),
    );
    expect(rowRefusal([{ ...legacyRow("alpha"), grants: {} }])).toBe(unreadable(0, "alpha"));
  });

  test("a packages/ directory that is neither an engine package, a non-engine package nor the register is refused by name", () => {
    const measured = measureFiles({
      "packages/registry/src/index.ts": 'x = "alpha";\n',
      "packages/registry/package.json": "{}\n",
      "packages/kit/package.json": "{}\n",
      "packages/README.md": "# Packages\n",
      "packages/provider-alpha/src/index.ts": "",
      "packages/grant-register/package.json": "{}\n",
      ...EMPTY_REGISTER,
    });

    expect(measured.unclassified).toEqual([
      "packages/kit/ is neither an engine package (provider-<id>), a NON_ENGINE_PACKAGES entry nor the grant register, so no counter counts it",
      "packages/registry/ is neither an engine package (provider-<id>), a NON_ENGINE_PACKAGES entry nor the grant register, so no counter counts it",
    ]);
    expect(measured.stale).toEqual([]);
    expect(measureFiles({}).unclassified).toEqual([]);
  });
});

describe("statement languages", () => {
  const LANGUAGE_LINES = "statementLanguages.lines";
  const SINGLE_LANGUAGE = "coreHandwritten.linesNamingASingleEngineLanguage";

  test("a line of a statement language module, a language admission module or the language data projection counts toward statementLanguages.lines, and the projection toward no generated line", () => {
    const before = measureFiles({});
    const counted = [
      "src/lib/languages/x/a.ts",
      "src/lib/languages/x/notes.md",
      "src/lib/languages/x/rows.generated.ts",
      "src/lib/agent/languages/x/a.ts",
      "src/lib/agent/languages/engines/client.ts",
      "src/lib/db/operations/x-admission.ts",
      STATEMENT_LANGUAGE_PROJECTION,
    ];
    const ignored = [
      "src/lib/db/operations/descriptors.ts",
      "src/lib/db/operations/x/y-admission.ts",
      "src/lib/db/operations/x-admission.test.ts",
      "src/lib/agent/languages/pack.ts",
      "src/lib/db/engine-catalog/rows.generated.ts",
      "tests/unit/db/operations/x-admission.ts",
    ];

    expect(STATEMENT_LANGUAGE_PROJECTION).toBe("src/lib/db/engine-catalog/statement-language.generated.ts");
    expect(before.baseline.counters[LANGUAGE_LINES]).toBe(0);
    for (const file of counted) {
      const after = measureFiles({ [file]: "a\n" });

      expect({
        file,
        lines: after.baseline.counters[LANGUAGE_LINES],
        generated: after.baseline.counters["coreGenerated.lines"],
        generatedFiles: after.report["coreGenerated.files"],
      }).toEqual({ file, lines: 1, generated: 0, generatedFiles: 0 });
    }
    for (const file of ignored) {
      expect({ file, lines: measureFiles({ [file]: "a\n" }).baseline.counters[LANGUAGE_LINES] }).toEqual({
        file,
        lines: 0,
      });
    }
    const projection = measureFiles({ [STATEMENT_LANGUAGE_PROJECTION]: 'export const L = { alpha: "alpharead" };\n' });
    expect(projection.baseline.counters["coreHandwritten.linesNamingAnEngine"]).toBe(1);
    const handwrittenLanguage = measureFiles({ "src/lib/languages/x/a.ts": 'x = "alpha";\n' });
    expect(handwrittenLanguage.baseline.counters["coreHandwritten.linesNamingAnEngine"]).toBe(2);
    expect(
      compareWithBaseline(before.baseline, measureFiles({ "src/lib/db/operations/x-admission.ts": "a\n" }).baseline),
    ).toEqual([{ kind: "worse", message: `${LANGUAGE_LINES}: baseline 0, now 1; it may only fall` }]);
  });

  test("every generated core module and every statement language module is counted by exactly one line gate, and a hand-written module by none", () => {
    const counted: Record<string, string> = {
      "src/lib/db/engine-catalog/rows.generated.ts": "coreGenerated.lines",
      [STATEMENT_LANGUAGE_PROJECTION]: LANGUAGE_LINES,
      "src/lib/languages/x/rows.generated.ts": LANGUAGE_LINES,
      "src/lib/languages/x/a.ts": LANGUAGE_LINES,
      "src/lib/agent/languages/x/a.ts": LANGUAGE_LINES,
      "src/lib/db/operations/x-admission.ts": LANGUAGE_LINES,
    };
    const handwritten = ["src/lib/x.ts", "src/lib/db/operations/descriptors.ts", "src/lib/agent/languages/pack.ts"];
    const measured = measureFiles(
      Object.fromEntries([...Object.keys(counted), ...handwritten].map((file) => [file, "a\n"])),
    );

    expect(LINE_GATES).toEqual(["coreGenerated.lines", LANGUAGE_LINES]);
    for (const [file, own] of Object.entries(counted)) {
      const gates: string[] = LINE_GATES.filter((name) => measured.lineGateFiles[name].includes(file));
      expect({ file, gates }).toEqual({ file, gates: [own] });
    }
    for (const file of [...handwritten, "src/lib/core.ts"]) {
      const gates: string[] = LINE_GATES.filter((name) => measured.lineGateFiles[name].includes(file));
      expect({ file, gates }).toEqual({ file, gates: [] });
    }
    expect(measured.lineGateFiles["coreGenerated.lines"]).toEqual(["src/lib/db/engine-catalog/rows.generated.ts"]);
    expect(measured.lineGateFiles[LANGUAGE_LINES]).toEqual(
      Object.keys(counted)
        .filter((file) => counted[file] === LANGUAGE_LINES)
        .sort(),
    );
    expect(measured.baseline.counters["coreGenerated.lines"]).toBe(1);
    expect(measured.baseline.counters[LANGUAGE_LINES]).toBe(5);
  });

  test("a hand-written core line naming a single-engine statement language id counts toward the gate, and a language several engines speak does not", () => {
    const rows = register([
      { ...legacyRow("alpha"), grants: { statementLanguage: "alpharead" } },
      { ...legacyRow("postgres"), grants: { statementLanguage: "sql" } },
      { ...packageRow("mysql"), grants: { statementLanguage: "sql" } },
      { ...legacyRow("mqtt"), grants: { statementLanguage: null } },
      legacyRow("etcd"),
    ]);
    const before = measureFiles(rows);
    const named = measureFiles({
      ...rows,
      "src/lib/x.ts": 'a = "alpharead";\nconst b = { alpharead: 1 };\nc = "sql";\nd = "alpharead-x";\n// alpharead\n',
    });

    expect(GATE_COUNTERS).toContainEqual({ name: SINGLE_LANGUAGE, direction: "falls" });
    expect(before.baseline.counters[SINGLE_LANGUAGE]).toBe(0);
    expect(named.baseline.counters[SINGLE_LANGUAGE]).toBe(2);
    expect(compareWithBaseline(before.baseline, named.baseline)).toEqual([
      { kind: "worse", message: `${SINGLE_LANGUAGE}: baseline 0, now 2; it may only fall` },
    ]);
    for (const file of [
      "src/lib/languages/alpharead/a.ts",
      "src/lib/agent/languages/alpharead/a.ts",
      "src/lib/agent/languages/engines/client.ts",
      "src/lib/db/operations/alpharead-admission.ts",
      STATEMENT_LANGUAGE_PROJECTION,
      "src/lib/db/engine-catalog/rows.generated.ts",
      "src/lib/db/providers/stream/alpha.ts",
      "tests/unit/x.test.ts",
      "packages/provider-sdk/src/x.ts",
    ]) {
      const measured = measureFiles({ ...rows, [file]: 'x = "alpharead";\n' });
      expect({ file, lines: measured.baseline.counters[SINGLE_LANGUAGE] }).toEqual({ file, lines: 0 });
    }
    expect(measureFiles({ "src/lib/x.ts": 'a = "alpharead";\n' }).baseline.counters[SINGLE_LANGUAGE]).toBe(0);
  });
});

describe("the language machinery report", () => {
  const MACHINERY = "statementLanguages.machineryLines";
  /** The seven modules, the first with no final newline: 2 lines, then 2, 3, 4, 5, 6 and 7, so 29 in all. */
  const MODULES: Files = Object.fromEntries(
    LANGUAGE_MACHINERY_MODULES.map((file, index) => [file, index === 0 ? "a\nb" : "a\n".repeat(index + 1)]),
  );
  /**
   * The language root references `statementLanguageData`, which references `a` and `b`; `b` references `a` and itself;
   * `c` is referenced only by another member of the engine declaration, so it is no language definition.
   */
  const DEFINITIONS = {
    engineDeclaration: {
      type: "object",
      properties: {
        statementLanguageData: { $ref: "#/$defs/statementLanguageData" },
        id: { $ref: "#/$defs/c" },
      },
    },
    statementLanguageData: { anyOf: [{ type: "null" }, { $ref: "#/$defs/a" }, { $ref: "#/$defs/b" }] },
    a: { type: "string" },
    b: { type: "object", properties: { x: { $ref: "#/$defs/a" }, self: { $ref: "#/$defs/b" } } },
    c: { type: "integer" },
  };
  const schema = (definitions: Record<string, unknown>, space: number | undefined = 2): Files => ({
    [LANGUAGE_SCHEMA_FILE]: `${JSON.stringify({ $defs: definitions }, null, space)}\n`,
  });
  /** The lines of a definition as the report counts them: printed by JSON.stringify at indent 2. */
  const printed = (value: unknown): number => JSON.stringify(value, null, 2).split("\n").length;

  test("the language machinery report counts the engine-neutral language modules and the SDK's language schema", () => {
    expect(LANGUAGE_MACHINERY_MODULES).toEqual([
      "src/lib/agent/languages/declared-client.ts",
      "src/lib/agent/languages/declared-mcp.ts",
      "src/lib/agent/languages/declared-server.ts",
      "src/lib/db/operations/declared-request-form.ts",
      "src/lib/db/operations/declared-language-read.ts",
      "src/lib/db/statement-language-row.ts",
      "src/lib/db/language-digest.ts",
    ]);
    expect(LANGUAGE_SCHEMA_FILE).toBe("packages/provider-sdk/src/manifest/manifest.schema.json");
    expect(REPORT_COUNTERS.indexOf(MACHINERY)).toBe(REPORT_COUNTERS.indexOf("languages.lines") + 1);
    expect(GATE_COUNTERS.map((counter) => counter.name)).not.toContain(MACHINERY);

    const measured = measureFiles({ ...MODULES, ...schema(DEFINITIONS) });
    // The three reachable definitions print as 13, 3 and 11 lines; the modules hold 29.
    expect([printed(DEFINITIONS.statementLanguageData), printed(DEFINITIONS.a), printed(DEFINITIONS.b)]).toEqual([
      13, 3, 11,
    ]);
    expect(measured.report[MACHINERY]).toBe(29 + 13 + 3 + 11);
    // The schema file's own layout does not count: its definitions are counted as printed at indent 2.
    expect(measureFiles({ ...MODULES, ...schema(DEFINITIONS, undefined) }).report[MACHINERY]).toBe(56);
    // The report counts no file a gate counts, and moves no gate counter.
    expect(measured.baseline.counters["statementLanguages.lines"]).toBe(0);
    expect(compareWithBaseline(measureFiles({}).baseline, measured.baseline)).toEqual([]);

    // A planted module line moves it by one.
    const firstModule = LANGUAGE_MACHINERY_MODULES[0];
    const planted = measureFiles({ ...MODULES, [firstModule]: "a\nb\nc", ...schema(DEFINITIONS) });
    expect(planted.report[MACHINERY]).toBe(57);
    // A planted line in a reachable definition moves it; a change to an unreachable one does not.
    const reachable = { ...DEFINITIONS, a: { type: "string", description: "x" } };
    expect(measureFiles({ ...MODULES, ...schema(reachable) }).report[MACHINERY]).toBe(57);
    const unreachable = { ...DEFINITIONS, c: { type: "integer", minimum: 0, description: "y" } };
    expect(measureFiles({ ...MODULES, ...schema(unreachable) }).report[MACHINERY]).toBe(56);

    // A tree holding none of the eight files reports 0.
    expect(measureFiles({}).report[MACHINERY]).toBe(0);
  });

  test("a tree holding only some of the language machinery files, or a schema whose language root or a reference is missing, is refused by name", () => {
    const lastModule = LANGUAGE_MACHINERY_MODULES.at(-1) as string;
    const withoutLast = Object.fromEntries(Object.entries(MODULES).filter(([file]) => file !== lastModule));
    expect(() => measureFiles({ ...withoutLast, ...schema(DEFINITIONS) })).toThrow(
      `the language machinery files ${lastModule} are missing while the tree holds the others, so the language machinery report cannot be counted`,
    );
    expect(() => measureFiles(MODULES)).toThrow(
      `the language machinery files ${LANGUAGE_SCHEMA_FILE} are missing while the tree holds the others, so the language machinery report cannot be counted`,
    );
    expect(() => measureFiles({ ...MODULES, [LANGUAGE_SCHEMA_FILE]: "{ not json\n" })).toThrow(
      `${LANGUAGE_SCHEMA_FILE} is not JSON: `,
    );
    const noRoot = {
      ...DEFINITIONS,
      engineDeclaration: { type: "object", properties: { id: { $ref: "#/$defs/c" } } },
    };
    expect(() => measureFiles({ ...MODULES, ...schema(noRoot) })).toThrow(
      `${LANGUAGE_SCHEMA_FILE} holds no $defs.engineDeclaration.properties.statementLanguageData, the root of the language definitions`,
    );
    const absent = { ...DEFINITIONS, b: { type: "object", properties: { x: { $ref: "#/$defs/absent" } } } };
    expect(() => measureFiles({ ...MODULES, ...schema(absent) })).toThrow(
      `${LANGUAGE_SCHEMA_FILE}: the language definitions reference #/$defs/absent, which the schema does not define`,
    );
    const otherForm = { ...DEFINITIONS, a: { $ref: "other.json#/x" } };
    expect(() => measureFiles({ ...MODULES, ...schema(otherForm) })).toThrow(
      `${LANGUAGE_SCHEMA_FILE}: the language definitions hold the reference "other.json#/x", not one of the form #/$defs/<name>`,
    );
  });
});

describe("direction and messages", () => {
  const worse: Record<string, Files> = {
    "coreHandwritten.distinctEngineIds": { "src/lib/core.ts": 'export const DEFAULT = ["postgres", "alpha"];\n' },
    "coreHandwritten.filesNamingAnEngine": { "src/lib/x.ts": 'x = "postgres";\n' },
    "coreHandwritten.linesNamingAnEngine": { "src/lib/core.ts": 'export const DEFAULT = "postgres";\n"postgres";\n' },
    "coreHandwritten.linesNamingASingleEngineLanguage": {
      ...register([{ ...legacyRow("alpha"), grants: { statementLanguage: "alpharead" } }]),
      "src/lib/x.ts": 'x = "alpharead";\n',
    },
    "coreGenerated.lines": { "src/lib/x.generated.ts": "a\n" },
    "statementLanguages.lines": { "src/lib/db/operations/x-admission.ts": "a\n" },
    "legacyProviders.files": { "src/lib/db/providers/x.ts": "" },
    "agentLanguages.filesInLanguageDirs": { "src/lib/agent/languages/sql/x.ts": "" },
    "languages.files": { "src/lib/languages/x.ts": "" },
    "engineDeclarations.files": { "src/lib/db/engine-declarations/mqtt.json": "{}\n" },
    providerDocsInCore: { "docs/providers/alpha.md": "" },
    providerIntegrationTestsInCore: { "tests/integration/db/alpha-provider.test.ts": "" },
    inwardImportPairs: {},
    engineKeyedTypePositions: { "src/lib/k.ts": "type K = Record<DatabaseType, 1>;\n" },
    "nonEnginePackages.linesNamingAnEngine": { "packages/provider-sdk/src/x.ts": 'x = "postgres";\n' },
    "grantRegister.legacyRows": register([legacyRow("alpha")]),
  };

  test.each(GATE_COUNTERS.filter((counter) => counter.direction === "falls").map((counter) => counter.name))(
    "a rise of %s is refused naming the counter, the baseline and the new value",
    (name) => {
      const files = worse[name];
      if (files === undefined) throw new Error(`no scenario raises ${name}`);
      const before = measureFiles({}, { inward: [] }).baseline;
      const after = measureFiles(files, {
        inward: name === "inwardImportPairs" ? [{ modules: ["a.ts"] }] : [],
      }).baseline;
      const findings = compareWithBaseline(before, after);
      const own = findings.find((finding) => finding.message.startsWith(`${name}:`));

      expect(own).toEqual({
        kind: "worse",
        message: `${name}: baseline ${before.counters[name]}, now ${after.counters[name]}; it may only fall`,
      });
    },
  );

  test("every only-falls counter has a scenario above, and engines in packages is the only one that rises", () => {
    expect(Object.keys(worse).sort()).toEqual(
      GATE_COUNTERS.filter((counter) => counter.direction === "falls")
        .map((counter) => counter.name)
        .sort(),
    );
    expect(GATE_COUNTERS.filter((counter) => counter.direction === "rises").map((counter) => counter.name)).toEqual([
      "enginesInPackages",
    ]);
  });

  test("a fall of engines in packages is refused", () => {
    const packaged = { ...BASE, "packages/provider-alpha/src/index.ts": "" };
    const before = measureFiles({}, {}, packaged).baseline;
    const after = measureFiles({}, {}, BASE).baseline;

    expect(compareWithBaseline(before, after).filter((finding) => finding.kind === "worse")).toEqual([
      { kind: "worse", message: "enginesInPackages: baseline 1, now 0; it may only rise" },
      { kind: "worse", message: "enginesInPackages.ids: alpha is in the baseline and is no longer a package" },
    ]);
  });

  test("an id named in core that the baseline does not list is refused even at the same count", () => {
    const after = measureFiles({ "src/lib/core.ts": 'export const DEFAULT = "alpha";\n' }).baseline;

    expect(compareWithBaseline(measureFiles({}).baseline, after)).toEqual([
      {
        kind: "worse",
        message: "coreHandwritten.engineIdsNamed: alpha is named in core and the baseline does not list it",
      },
      { kind: "better", message: `coreHandwritten.engineIdsNamed: postgres is no longer named in core; ${REGENERATE}` },
    ]);
  });

  test("an improvement with a stale baseline is refused", () => {
    const before = measureFiles({ "src/lib/old.ts": 'x = "alpha";\n' }).baseline;
    const after = measureFiles({}).baseline;
    const messages = compareWithBaseline(before, after).map((finding) => finding.message);

    expect(REGENERATE_SENTENCE).toBe(REGENERATE);
    expect(messages).toEqual([
      `coreHandwritten.distinctEngineIds: baseline 2, now 1, an improvement; ${REGENERATE}`,
      `coreHandwritten.filesNamingAnEngine: baseline 2, now 1, an improvement; ${REGENERATE}`,
      `coreHandwritten.linesNamingAnEngine: baseline 2, now 1, an improvement; ${REGENERATE}`,
      `coreHandwritten.engineIdsNamed: alpha is no longer named in core; ${REGENERATE}`,
    ]);
    for (const message of messages) expect(message.endsWith(REGENERATE)).toBe(true);
  });

  test("a new package is an improvement the baseline must take in, and equal measurements yield nothing", () => {
    const after = measureFiles({ "packages/provider-alpha/src/index.ts": "" }).baseline;

    expect(compareWithBaseline(measureFiles({}).baseline, after)).toEqual([
      { kind: "better", message: `enginesInPackages: baseline 0, now 1, an improvement; ${REGENERATE}` },
      { kind: "better", message: `enginesInPackages.ids: alpha is a new package; ${REGENERATE}` },
    ]);
    expect(compareWithBaseline(after, after)).toEqual([]);
  });

  test("a rise and an improvement in one change are reported together", () => {
    const before = measureFiles({ "src/lib/db/providers/x.ts": "" }).baseline;
    const after = measureFiles({ "src/lib/languages/x.ts": "" }).baseline;

    expect(compareWithBaseline(before, after).map((finding) => finding.kind)).toEqual(["better", "worse"]);
  });
});

describe("exceptions", () => {
  const storageLine = 'case "postgres": {';
  const storage: Exception = {
    file: "src/lib/storage/factory.ts",
    ids: ["postgres"],
    line: storageLine,
    reason: "the STORAGE_PROVIDER value",
  };

  test("an exception that matches no line is refused", () => {
    const measured = measureFiles({}, { exceptions: [storage] });

    expect(measured.stale).toEqual([
      'EXCEPTIONS: src/lib/storage/factory.ts names postgres on no line that reads exactly: case "postgres": {',
    ]);
  });

  test("an exception whose line does not name each of its ids is refused", () => {
    const measured = measureFiles(
      { "src/lib/storage/factory.ts": `  ${storageLine}\n` },
      { exceptions: [{ ...storage, ids: ["postgres", "alpha"] }] },
    );

    expect(measured.stale).toEqual([
      'EXCEPTIONS: src/lib/storage/factory.ts names postgres, alpha on no line that reads exactly: case "postgres": {',
    ]);
  });

  test("an exception removes only its ids, only on its lines, only in its file", () => {
    const measured = measureFiles(
      {
        "src/lib/storage/factory.ts": `  ${storageLine}\n  ${storageLine}\n  case "postgres": { // alpha: too\n`,
        "src/lib/storage/other.ts": `${storageLine}\n`,
      },
      { exceptions: [storage] },
    );

    expect(measured.stale).toEqual([]);
    expect(measured.baseline.counters["coreHandwritten.filesNamingAnEngine"]).toBe(3);
    expect(measured.baseline.counters["coreHandwritten.linesNamingAnEngine"]).toBe(3);

    const twoIds = measureFiles(
      { "src/lib/storage/factory.ts": 'type T = "alpha" | "postgres";\n' },
      { exceptions: [{ ...storage, line: 'type T = "alpha" | "postgres";' }] },
    );

    expect(twoIds.stale).toEqual([]);
    expect(twoIds.baseline.counters["coreHandwritten.linesNamingAnEngine"]).toBe(2);
    expect(twoIds.baseline.ids["coreHandwritten.engineIdsNamed"]).toEqual(["alpha", "postgres"]);
  });

  test("an excepted line in a generated or legacy provider file excepts nothing", () => {
    const measured = measureFiles(
      { "src/lib/storage/factory.generated.ts": `${storageLine}\n` },
      { exceptions: [{ ...storage, file: "src/lib/storage/factory.generated.ts" }] },
    );

    expect(measured.stale.length).toBe(1);
  });

  test("every exception is a storage provider value under src/lib/storage or the product name libredb", () => {
    for (const entry of EXCEPTIONS) {
      const storageValue =
        entry.file.startsWith("src/lib/storage/") &&
        entry.ids.length > 0 &&
        entry.ids.every((id) => id === "postgres" || id === "sqlite");
      const productName = entry.ids.length === 1 && entry.ids[0] === "libredb";

      expect({ entry, allowed: storageValue || productName }).toEqual({ entry, allowed: true });
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.line).toBe(entry.line.trim());
    }
  });
});

describe("the baseline file", () => {
  test("the baseline holds every gate counter and no report counter", () => {
    const measured = measureFiles({});
    const parsed = JSON.parse(renderBaseline(measured.baseline)) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual(["//", "counters", "ids"]);
    expect(parsed["//"]).toBe(
      "Generated by bun run isolation:baseline from scripts/isolation-ratchet.ts; never edit by hand.",
    );
    expect(Object.keys(parsed.counters as object)).toEqual(GATE_COUNTERS.map((counter) => counter.name));
    expect(Object.keys(parsed.ids as object)).toEqual([
      "coreHandwritten.engineIdsNamed",
      "enginesInPackages.ids",
      "nonEnginePackages.engineIdsNamed",
    ]);
    for (const name of REPORT_COUNTERS) expect(JSON.stringify(parsed)).not.toContain(`"${name}"`);
    expect(JSON.stringify(parsed)).not.toContain('"grantRegister.engineIdsNamed"');
    expect(renderBaseline(measured.baseline).endsWith("}\n")).toBe(true);
    expect(parseBaseline(renderBaseline(measured.baseline))).toEqual(measured.baseline);
  });

  test("a baseline missing a counter, or holding an unknown one, is refused by name", () => {
    const valid = JSON.parse(renderBaseline(measureFiles({}).baseline)) as {
      counters: Record<string, unknown>;
      ids: Record<string, unknown>;
    };
    const variant = (change: (copy: typeof valid) => void) => {
      const copy = structuredClone(valid);
      change(copy);
      return JSON.stringify(copy);
    };
    const refusal = (text: string) => {
      try {
        parseBaseline(text);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("parseBaseline accepted the text");
    };
    const suffix = "; the file is generated by bun run isolation:baseline and never edited by hand";

    expect(refusal(variant((copy) => delete copy.counters["languages.files"]))).toBe(
      `${BASELINE_FILE}: counter languages.files is missing${suffix}`,
    );
    expect(refusal(variant((copy) => Object.assign(copy.counters, { extra: 1 })))).toBe(
      `${BASELINE_FILE}: counter extra is not a gate counter${suffix}`,
    );
    expect(refusal(variant((copy) => Object.assign(copy.counters, { "languages.files": "39" })))).toBe(
      `${BASELINE_FILE}: counter languages.files is not a non-negative integer${suffix}`,
    );
    expect(refusal(variant((copy) => Object.assign(copy.counters, { "languages.files": -1 })))).toBe(
      `${BASELINE_FILE}: counter languages.files is not a non-negative integer${suffix}`,
    );
    expect(refusal(variant((copy) => delete copy.ids["enginesInPackages.ids"]))).toBe(
      `${BASELINE_FILE}: id list enginesInPackages.ids is missing${suffix}`,
    );
    expect(refusal(variant((copy) => delete copy.ids["nonEnginePackages.engineIdsNamed"]))).toBe(
      `${BASELINE_FILE}: id list nonEnginePackages.engineIdsNamed is missing${suffix}`,
    );
    expect(refusal(variant((copy) => delete copy.counters["grantRegister.legacyRows"]))).toBe(
      `${BASELINE_FILE}: counter grantRegister.legacyRows is missing${suffix}`,
    );
    expect(refusal(variant((copy) => Object.assign(copy.counters, { "grantRegister.linesNamingAnEngine": 44 })))).toBe(
      `${BASELINE_FILE}: counter grantRegister.linesNamingAnEngine is not a gate counter${suffix}`,
    );
    expect(refusal(variant((copy) => Object.assign(copy.ids, { "grantRegister.engineIdsNamed": [] })))).toBe(
      `${BASELINE_FILE}: id list grantRegister.engineIdsNamed is not a baseline id list${suffix}`,
    );
    expect(refusal(variant((copy) => Object.assign(copy.ids, { "enginesInPackages.ids": [1] })))).toBe(
      `${BASELINE_FILE}: id list enginesInPackages.ids is not a list of strings${suffix}`,
    );
    expect(refusal(variant((copy) => Object.assign(copy.ids, { other: [] })))).toBe(
      `${BASELINE_FILE}: id list other is not a baseline id list${suffix}`,
    );
    expect(refusal("[]")).toBe(`${BASELINE_FILE}: the file is not an object with counters and ids${suffix}`);
    expect(refusal('{"counters": 1, "ids": {}}')).toBe(
      `${BASELINE_FILE}: the file is not an object with counters and ids${suffix}`,
    );
  });
});

describe("the command line", () => {
  function fakeIo(files: Files, committed: string | null) {
    const out = { written: [] as string[], log: [] as string[], error: [] as string[] };
    const io: Io = {
      list: () => Object.keys(files),
      read: tree(files).read,
      readBaseline: () => committed,
      writeBaseline: (text) => out.written.push(text),
      log: (line) => out.log.push(line),
      error: (line) => out.error.push(line),
    };
    return { io, out };
  }
  const SDK_ONLY: Files = { "packages/provider-sdk/src/index.ts": "" };
  /** The engines the real exceptions name, declared, and every real exception's line planted in its file. */
  function withExceptionLines(): Files {
    const files: Files = {
      ...SDK_ONLY,
      "src/lib/db/engine-declarations/libredb.json": "{}\n",
      "src/lib/db/engine-declarations/postgres.json": "{}\n",
      "src/lib/db/engine-declarations/sqlite.json": "{}\n",
    };
    for (const entry of EXCEPTIONS) files[entry.file] = `${files[entry.file] ?? ""}${entry.line}\n`;
    return files;
  }
  const measureForCli = (files: Files) =>
    measure(tree(files), { inward: INWARD_IMPORTS, exceptions: EXCEPTIONS, nonEnginePackages: NON_ENGINE_PACKAGES });

  test("--write writes the measured baseline", () => {
    const files = withExceptionLines();
    const first = fakeIo(files, null);

    expect(main(["--write"], first.io)).toBe(0);
    expect(first.out.written).toEqual([renderBaseline(measureForCli(files).baseline)]);
    expect(first.out.log).toEqual([`Wrote ${BASELINE_FILE}`]);

    const better = { ...files, "src/lib/db/providers/gone.ts": "" };
    const second = fakeIo(files, renderBaseline(measureForCli(better).baseline));

    expect(main(["--write"], second.io)).toBe(0);
    expect(second.out.written).toEqual(first.out.written);
  });

  test("--write refuses a measurement worse than the committed baseline and writes nothing", () => {
    const files = withExceptionLines();
    const worse = { ...files, "src/lib/db/providers/new.ts": "" };
    const { io, out } = fakeIo(worse, renderBaseline(measureForCli(files).baseline));

    expect(main(["--write"], io)).toBe(1);
    expect(out.written).toEqual([]);
    expect(out.error).toEqual([
      "legacyProviders.files: baseline 0, now 1; it may only fall",
      "The baseline is not rewritten: --write never raises a counter.",
    ]);
    for (const line of out.error) expect(line).not.toContain("isolation:baseline");
  });

  test("--write refuses an unclassified packages/ directory and writes nothing", () => {
    const files = { ...withExceptionLines(), "packages/registry/package.json": "{}\n" };
    const { io, out } = fakeIo(files, null);

    expect(main(["--write"], io)).toBe(1);
    expect(out.written).toEqual([]);
    expect(out.error).toEqual([
      "packages/registry/ is neither an engine package (provider-<id>), a NON_ENGINE_PACKAGES entry nor the grant register, so no counter counts it",
      "The baseline is not rewritten: classify each packages/ directory above.",
    ]);
  });

  test("--write refuses a stale exception and writes nothing", () => {
    const { io, out } = fakeIo(SDK_ONLY, null);

    expect(main(["--write"], io)).toBe(1);
    expect(out.written).toEqual([]);
    expect(out.error.length).toBe(EXCEPTIONS.length + 1);
    expect(out.error.at(-1)).toBe("The baseline is not rewritten: remove or correct each stale entry above.");
  });

  test("with no argument it prints every counter; any other argument prints the usage", () => {
    const { io, out } = fakeIo({ ...BASE }, null);

    expect(main([], io)).toBe(0);
    const names = out.log.map((line) => line.split(" ")[1]);
    expect(names).toEqual([
      ...GATE_COUNTERS.map((counter) => counter.name),
      ...REPORT_COUNTERS,
      "grantRegister.engineIdsNamed",
    ]);
    for (const line of out.log) expect(line.split(" ").length).toBe(3);
    expect(out.log[0]).toBe("gate enginesInPackages 0");
    expect(out.log.at(-1)).toBe("report grantRegister.engineIdsNamed []");

    const listed = fakeIo({ ...BASE, ...register([legacyRow("postgres"), legacyRow("alpha")]) }, null);
    expect(main([], listed.io)).toBe(0);
    expect(listed.out.log.at(-1)).toBe('report grantRegister.engineIdsNamed ["alpha","postgres"]');

    for (const argv of [["--check"], ["--write", "x"], ["x"]]) {
      const usage = fakeIo({ ...BASE }, null);
      expect(main(argv, usage.io)).toBe(2);
      expect(usage.out.error).toEqual(["Usage: bun scripts/isolation-ratchet.ts [--write]"]);
    }
  });

  test("package.json runs the script with --write as isolation:baseline", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["isolation:baseline"]).toBe("bun scripts/isolation-ratchet.ts --write");
  });

  test("the required CI job prints the counters", () => {
    const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const start = ci.indexOf("\n  lint-and-build:\n");
    const end = ci.indexOf("\n  test:\n", start);
    const job = ci.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(job).toContain("name: Lint, Typecheck and Build");
    expect(job).toMatch(
      /\n {6}- name: Isolation ratchet counters \(report only\)\n(?: {8}#.*\n)* {8}run: bun scripts\/isolation-ratchet\.ts\n/,
    );
  });

  test("the real io reads a missing baseline as null, writes the baseline file, and rethrows other read errors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "isolation-ratchet-"));
    try {
      const file = path.join(dir, "baseline.json");
      const io = realIo(ROOT, file);

      expect(io.readBaseline()).toBeNull();
      io.writeBaseline("{}\n");
      expect(io.readBaseline()).toBe("{}\n");
      expect(readFileSync(file, "utf8")).toBe("{}\n");
      expect(() => realIo(ROOT, dir).readBaseline()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the working tree", () => {
  test("the working tree holds no more provider knowledge in core than the committed baseline, and the baseline is exact", () => {
    const io = realIo(ROOT, path.join(ROOT, BASELINE_FILE));
    const measured = measure(
      { files: io.list(), read: io.read },
      { inward: INWARD_IMPORTS, exceptions: EXCEPTIONS, nonEnginePackages: NON_ENGINE_PACKAGES },
    );
    const committedText = io.readBaseline();
    if (committedText === null) throw new Error(`${BASELINE_FILE} is missing; ${REGENERATE}`);
    const committed = parseBaseline(committedText);

    for (const counter of GATE_COUNTERS) {
      console.log(
        `gate ${counter.name}: ${measured.baseline.counters[counter.name]} (baseline ${committed.counters[counter.name]}, ${counter.direction === "falls" ? "only falls" : "only rises"})`,
      );
    }
    for (const name of REPORT_COUNTERS) console.log(`report ${name}: ${measured.report[name]}`);
    console.log(
      `report grantRegister.engineIdsNamed: ${JSON.stringify(measured.reportIds["grantRegister.engineIdsNamed"])}`,
    );

    expect(measured.stale).toEqual([]);
    expect(measured.unclassified).toEqual([]);
    expect(compareWithBaseline(committed, measured.baseline)).toEqual([]);
    expect(committedText === renderBaseline(measured.baseline) ? "exact" : `not exact: ${REGENERATE}`).toBe("exact");
  }, 10_000);

  test("every generated and statement language module of the working tree is counted by exactly one line gate", () => {
    const io = realIo(ROOT, path.join(ROOT, BASELINE_FILE));
    const files = io.list();
    const measured = measure(
      { files, read: io.read },
      { inward: INWARD_IMPORTS, exceptions: EXCEPTIONS, nonEnginePackages: NON_ENGINE_PACKAGES },
    );
    const coreGenerated = (file: string) =>
      ["src/", "bin/", "scripts/", "vscode-extension/src/"].some((root) => file.startsWith(root)) &&
      /\.(c|m)?(t|j)sx?$/.test(file) &&
      !file.startsWith("src/lib/db/providers/") &&
      path.posix.basename(file).includes(".generated.");
    const statementLanguage = (file: string) =>
      file.startsWith("src/lib/languages/") ||
      /^src\/lib\/agent\/languages\/[^/]+\/./.test(file) ||
      /^src\/lib\/db\/operations\/[^/]+-admission\.ts$/.test(file) ||
      file === STATEMENT_LANGUAGE_PROJECTION;
    const expected = files.filter((file) => coreGenerated(file) || statementLanguage(file)).sort();
    const counted = LINE_GATES.flatMap((name) => measured.lineGateFiles[name]);

    expect(counted.length).toBe(new Set(counted).size);
    expect([...counted].sort()).toEqual(expected);
    for (const name of LINE_GATES) {
      const lines = measured.lineGateFiles[name].reduce((sum, file) => {
        const text = io.read(file);
        return sum + (text.match(/\n/g)?.length ?? 0) + (text !== "" && !text.endsWith("\n") ? 1 : 0);
      }, 0);
      expect({ name, lines }).toEqual({ name, lines: measured.baseline.counters[name] });
    }
  }, 10_000);
});
