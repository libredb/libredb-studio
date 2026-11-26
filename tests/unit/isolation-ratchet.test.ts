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
  type Io,
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
} from "../../scripts/isolation-ratchet";
import { INWARD_IMPORTS } from "./lib/db/provider-imports/inward-allowlist";

const ROOT = path.resolve(import.meta.dir, "../..");
const REGENERATE = "run bun run isolation:baseline and commit the result";

type Files = Record<string, string>;

/** Two declared engines, one hand-written core file naming one of them, and the SDK package. */
const BASE: Files = {
  "src/lib/db/engine-declarations/kafka.json": "{}\n",
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
    for (const line of ["kafka: 1,", "  kafka?: 1,", "const x = {kafka:1};", "type T = { a: 1; kafka : 2 };"]) {
      const measured = measureFiles({ "src/lib/keys.ts": `${line}\n` }).baseline;

      expect({ line, lines: measured.counters["coreHandwritten.linesNamingAnEngine"] }).toEqual({ line, lines: 2 });
      expect(measured.ids["coreHandwritten.engineIdsNamed"]).toEqual(["kafka", "postgres"]);
    }
  });

  test("each quoted literal form names an engine, and a literal holding more than the id does not", () => {
    for (const line of ['a = "kafka";', "a = 'kafka';", "a = `kafka`;"]) {
      expect({ line, lines: gate({ "src/lib/q.ts": `${line}\n` })["coreHandwritten.linesNamingAnEngine"] }).toEqual({
        line,
        lines: 2,
      });
    }
    for (const line of [
      'a = "kafka-x";',
      "kafkaish: 1,",
      'a = "Kafka";',
      'import x from "./kafka/index";',
      "a = \"kafka';",
      "// the kafka engine",
    ]) {
      expect({ line, lines: gate({ "src/lib/q.ts": `${line}\n` })["coreHandwritten.linesNamingAnEngine"] }).toEqual({
        line,
        lines: 1,
      });
    }
  });

  test("two engines on one line count one line and both engines", () => {
    const measured = measureFiles({ "src/lib/two.ts": 'const both = ["kafka", "postgres"];\n' }).baseline;

    expect(measured.counters["coreHandwritten.linesNamingAnEngine"]).toBe(2);
    expect(measured.counters["coreHandwritten.distinctEngineIds"]).toBe(2);
  });

  test("only core source roots and code extensions count, and the ratchet script itself does not", () => {
    const line = 'x = "kafka";\n';
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
      "packages/provider-kafka/src/a.ts",
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
    const before = gate({ "src/lib/old.ts": 'x = "kafka";\n' });
    const after = gate({ "src/lib/provider-host/legacy-adapter/kafka.ts": 'x = "kafka";\n' });

    expect(after).toEqual(before);
    expect(after["coreHandwritten.filesNamingAnEngine"]).toBe(2);
  });
});

describe("generated and legacy provider files", () => {
  test("a generated module counts only toward generated lines", () => {
    const after = gate({
      "src/lib/db/engine-catalog/rows.generated.ts":
        "export const R = { kafka: 1 };\nconst T: Record<DatabaseType, 1> = {};\n",
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
    const after = gate({ "src/lib/db/providers/stream/kafka.ts": 'export const ID = "kafka";\n' });

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
      "docs/providers/kafka.md": "",
      "docs/providers/CONTRACT.md": "",
      "docs/providers/README.md": "",
      "docs/providers/sub/postgres.md": "",
    });

    expect(after.providerDocsInCore).toBe(1);
  });

  test("provider integration tests in core count tests/integration/db/*-provider.test.ts", () => {
    const after = gate({
      "tests/integration/db/kafka-provider.test.ts": "",
      "tests/integration/db/kafka-helpers.test.ts": "",
      "tests/unit/db/kafka-provider.test.ts": "",
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
    const moved: Files = { ...BASE, "packages/provider-kafka/src/index.ts": "export {};\n" };
    delete moved["src/lib/db/engine-declarations/kafka.json"];
    const measured = measure(tree({ ...moved, "src/lib/k.ts": 'x = "kafka";\n' }), {
      inward: [],
      exceptions: [],
      nonEnginePackages: NON_ENGINE_PACKAGES,
    });

    expect(measured.baseline.counters.enginesInPackages).toBe(1);
    expect(measured.baseline.ids["enginesInPackages.ids"]).toEqual(["kafka"]);
    expect(measured.baseline.ids["coreHandwritten.engineIdsNamed"]).toEqual(["kafka", "postgres"]);
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
      "src/lib/kafka/x.ts",
      "scripts/generate-kafka-descriptor.mjs",
      "src/lib/x.postgres.ts",
      "src/lib/a_kafka.ts",
      "vscode-extension/src/types/kafka.d.ts",
      "src/lib/kafka.generated.ts",
    ];
    const ignored = [
      "src/lib/postgresql.ts",
      "src/lib/kafkaish/x.ts",
      "src/lib/Kafka.ts",
      "src/lib/db/providers/stream/kafka.ts",
      "tests/unit/kafka.test.ts",
      "packages/provider-kafka/src/x.ts",
      "src/lib/kafka.md",
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
        'export type D = "kafka" | "postgres";\nconst k = { kafka: 1 };\nconst n = 1;\n',
    }).baseline;

    expect(before[SDK_LINES]).toBe(0);
    expect(measured.counters[SDK_LINES]).toBe(2);
    expect(measured.ids[SDK_IDS]).toEqual(["kafka", "postgres"]);
    const core: Record<string, number> = { ...measured.counters, [SDK_LINES]: 0 };
    expect(core).toEqual(before);
  });

  test("a file under a non-engine package's tests/ does not count", () => {
    expect(gate({ "packages/provider-sdk/tests/x.test.ts": 'x = "kafka";\n' })[SDK_LINES]).toBe(0);
    expect(gate({ "packages/provider-sdk/src/tests/x.ts": 'x = "kafka";\n' })[SDK_LINES]).toBe(1);
  });

  test("a JSON file of a non-engine package counts like a source file", () => {
    expect(gate({ "packages/provider-sdk/src/manifest/schema.json": '"enum": ["kafka"]\n' })[SDK_LINES]).toBe(1);
    expect(gate({ "packages/provider-sdk/README.md": "the `kafka` engine\n" })[SDK_LINES]).toBe(1);
  });

  test("a packages/provider-<id>/ directory of an engine counts toward engines in packages, not toward non-engine packages", () => {
    const measured = measureFiles({ "packages/provider-kafka/src/x.ts": 'export const ID = "kafka";\n' }).baseline;

    expect(measured.counters[SDK_LINES]).toBe(0);
    expect(measured.ids[SDK_IDS]).toEqual([]);
    expect(measured.counters.enginesInPackages).toBe(1);
  });

  test("an engine id newly named in a non-engine package is refused at an unchanged line count", () => {
    const file = "packages/provider-sdk/src/x.ts";
    const before = measureFiles({ [file]: 'x = "kafka";\n' }).baseline;
    const after = measureFiles({ [file]: 'x = "postgres";\n' }).baseline;

    expect(after.counters[SDK_LINES]).toBe(before.counters[SDK_LINES]);
    expect(compareWithBaseline(before, after)).toEqual([
      {
        kind: "worse",
        message: `${SDK_IDS}: postgres is named in a non-engine package and the baseline does not list it`,
      },
      {
        kind: "better",
        message: `${SDK_IDS}: kafka is no longer named in a non-engine package; ${REGENERATE}`,
      },
    ]);
  });
});

describe("direction and messages", () => {
  const worse: Record<string, Files> = {
    "coreHandwritten.distinctEngineIds": { "src/lib/core.ts": 'export const DEFAULT = ["postgres", "kafka"];\n' },
    "coreHandwritten.filesNamingAnEngine": { "src/lib/x.ts": 'x = "postgres";\n' },
    "coreHandwritten.linesNamingAnEngine": { "src/lib/core.ts": 'export const DEFAULT = "postgres";\n"postgres";\n' },
    "coreGenerated.lines": { "src/lib/x.generated.ts": "a\n" },
    "legacyProviders.files": { "src/lib/db/providers/x.ts": "" },
    "agentLanguages.filesInLanguageDirs": { "src/lib/agent/languages/sql/x.ts": "" },
    "languages.files": { "src/lib/languages/x.ts": "" },
    "engineDeclarations.files": { "src/lib/db/engine-declarations/mqtt.json": "{}\n" },
    providerDocsInCore: { "docs/providers/kafka.md": "" },
    providerIntegrationTestsInCore: { "tests/integration/db/kafka-provider.test.ts": "" },
    inwardImportPairs: {},
    engineKeyedTypePositions: { "src/lib/k.ts": "type K = Record<DatabaseType, 1>;\n" },
    "nonEnginePackages.linesNamingAnEngine": { "packages/provider-sdk/src/x.ts": 'x = "postgres";\n' },
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
    const packaged = { ...BASE, "packages/provider-kafka/src/index.ts": "" };
    const before = measureFiles({}, {}, packaged).baseline;
    const after = measureFiles({}, {}, BASE).baseline;

    expect(compareWithBaseline(before, after).filter((finding) => finding.kind === "worse")).toEqual([
      { kind: "worse", message: "enginesInPackages: baseline 1, now 0; it may only rise" },
      { kind: "worse", message: "enginesInPackages.ids: kafka is in the baseline and is no longer a package" },
    ]);
  });

  test("an id named in core that the baseline does not list is refused even at the same count", () => {
    const after = measureFiles({ "src/lib/core.ts": 'export const DEFAULT = "kafka";\n' }).baseline;

    expect(compareWithBaseline(measureFiles({}).baseline, after)).toEqual([
      {
        kind: "worse",
        message: "coreHandwritten.engineIdsNamed: kafka is named in core and the baseline does not list it",
      },
      { kind: "better", message: `coreHandwritten.engineIdsNamed: postgres is no longer named in core; ${REGENERATE}` },
    ]);
  });

  test("an improvement with a stale baseline is refused", () => {
    const before = measureFiles({ "src/lib/old.ts": 'x = "kafka";\n' }).baseline;
    const after = measureFiles({}).baseline;
    const messages = compareWithBaseline(before, after).map((finding) => finding.message);

    expect(REGENERATE_SENTENCE).toBe(REGENERATE);
    expect(messages).toEqual([
      `coreHandwritten.distinctEngineIds: baseline 2, now 1, an improvement; ${REGENERATE}`,
      `coreHandwritten.filesNamingAnEngine: baseline 2, now 1, an improvement; ${REGENERATE}`,
      `coreHandwritten.linesNamingAnEngine: baseline 2, now 1, an improvement; ${REGENERATE}`,
      `coreHandwritten.engineIdsNamed: kafka is no longer named in core; ${REGENERATE}`,
    ]);
    for (const message of messages) expect(message.endsWith(REGENERATE)).toBe(true);
  });

  test("a new package is an improvement the baseline must take in, and equal measurements yield nothing", () => {
    const after = measureFiles({ "packages/provider-kafka/src/index.ts": "" }).baseline;

    expect(compareWithBaseline(measureFiles({}).baseline, after)).toEqual([
      { kind: "better", message: `enginesInPackages: baseline 0, now 1, an improvement; ${REGENERATE}` },
      { kind: "better", message: `enginesInPackages.ids: kafka is a new package; ${REGENERATE}` },
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
      { exceptions: [{ ...storage, ids: ["postgres", "kafka"] }] },
    );

    expect(measured.stale).toEqual([
      'EXCEPTIONS: src/lib/storage/factory.ts names postgres, kafka on no line that reads exactly: case "postgres": {',
    ]);
  });

  test("an exception removes only its ids, only on its lines, only in its file", () => {
    const measured = measureFiles(
      {
        "src/lib/storage/factory.ts": `  ${storageLine}\n  ${storageLine}\n  case "postgres": { // kafka: too\n`,
        "src/lib/storage/other.ts": `${storageLine}\n`,
      },
      { exceptions: [storage] },
    );

    expect(measured.stale).toEqual([]);
    expect(measured.baseline.counters["coreHandwritten.filesNamingAnEngine"]).toBe(3);
    expect(measured.baseline.counters["coreHandwritten.linesNamingAnEngine"]).toBe(3);

    const twoIds = measureFiles(
      { "src/lib/storage/factory.ts": 'type T = "kafka" | "postgres";\n' },
      { exceptions: [{ ...storage, line: 'type T = "kafka" | "postgres";' }] },
    );

    expect(twoIds.stale).toEqual([]);
    expect(twoIds.baseline.counters["coreHandwritten.linesNamingAnEngine"]).toBe(2);
    expect(twoIds.baseline.ids["coreHandwritten.engineIdsNamed"]).toEqual(["kafka", "postgres"]);
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
    expect(names).toEqual([...GATE_COUNTERS.map((counter) => counter.name), ...REPORT_COUNTERS]);
    expect(out.log[0]).toBe("gate enginesInPackages 0");
    expect(out.log.at(-1)?.startsWith("report ")).toBe(true);

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

    expect(measured.stale).toEqual([]);
    expect(compareWithBaseline(committed, measured.baseline)).toEqual([]);
    expect(committedText === renderBaseline(measured.baseline) ? "exact" : `not exact: ${REGENERATE}`).toBe("exact");
  }, 10_000);
});
