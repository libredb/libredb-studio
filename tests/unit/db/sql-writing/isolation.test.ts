import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPool, separatingGroups } from "../isolation-children";
import { type EngineModule, ENGINE_MODULES, ROOT } from "./engine-modules";
import { GOLDEN_KEYS, goldenFileName } from "./fixtures";

/**
 * One engine's SQL writing module cannot reach another engine's output.
 *
 * For each of `separatingGroups`' groups of engines a fresh `bun` process replaces every
 * module in the group with a sentinel spec whose every function answers `"SENTINEL"`, then
 * renders every golden key through the public functions. Every key OUTSIDE the group must
 * still match its committed golden file; since the groups separate every ordered pair of
 * engines, each engine is held real while each other engine is replaced. Each engine's own
 * output must show the sentinel in the first child that replaces it, so a mock that never
 * took hold cannot pass as isolation. Each group runs in its own process because bun's
 * module mocks are process-wide with no undo.
 *
 * The inline edit field gets a sentinel of its own, `BOUND_EDIT`, because every other
 * sentinel already lands in an edit's SQL through the quoted names and the placeholders.
 * Where the committed golden file shows an edit reaching its UPDATE, every edit of a value
 * that is not NULL must carry `BOUND_EDIT`, so the hook read the mocked `inlineEdit`.
 *
 * The export field answers `SENTINEL` for every spelling it writes. The replaced engine's
 * `ddl(inferred)` line must show a quoted name followed by a sentinel type, so the export
 * read the mocked `export` and not a table of its own.
 *
 * Its type vocabulary is a sentinel too, one that disagrees with the shared vocabulary on
 * every declared type the fixtures use: no bare name has a family, no wrapper unwraps, no
 * exact numeric type matches, and only a bare `Float64` is a float. So `varchar2` stays
 * declared as it is, and the CSV formula guard quotes every `-Infinity` cell, where the
 * shared vocabulary would re-spell the one and leave five of the others bare. Either line
 * moving back to the golden means the export read a vocabulary other than the engine's.
 */
const GOLDEN_DIR = join(import.meta.dir, "golden");
const FIXTURES = join(import.meta.dir, "fixtures.ts");
const GROUPS = separatingGroups(ENGINE_MODULES.map(({ id }) => id));
const BOUND_EDIT = "INLINE_EDIT_SENTINEL";

const keyOf = (key: string): string | undefined =>
  key === "no-connection" ? undefined : key === "empty-string" ? "" : key;

function mockFor(engine: EngineModule, index: number): string {
  return `
const actual${index} = await import(${JSON.stringify(engine.absPath)});
mock.module(${JSON.stringify(engine.absPath)}, () => ({
  ...actual${index},
  ${engine.exportName}: {
    escapeLiteral: SENTINEL,
    unescapeLiteral: SENTINEL,
    quoteIdentifier: SENTINEL,
    placeholder: SENTINEL,
    temporalLiteral: SENTINEL,
    inlineEdit: {
      instantTypeNames: new Set(),
      exactDecimalTypeNames: new Set(),
      float64TypeNames: "all",
      boundEdit: () => ${JSON.stringify(BOUND_EDIT)},
    },
    export: {
      ddlTypes: { text: "SENTINEL", integer: "SENTINEL", numeric: "SENTINEL", boolean: "SENTINEL", timestamp: "SENTINEL", binary: "SENTINEL" },
      standsAlone: [],
      bareSpelling: {},
      typeVocabulary: {
        bareTypeFamily: {},
        floatType: /^Float64$/,
        exactNumericType: /^SENTINEL_EXACT$/,
        numericWrapper: /^SENTINEL_WRAPPER<(.*)>$/,
      },
      binaryLiteral: SENTINEL,
      nonFinite: { NaN: "SENTINEL", Infinity: "SENTINEL", "-Infinity": "SENTINEL" },
      insertForm: "values",
      typedLiteral: SENTINEL,
    },
  },
}));`;
}

function scriptFor(group: readonly EngineModule[]): string {
  return `
import { mock } from "bun:test";
const SENTINEL = () => "SENTINEL";
${group.map(mockFor).join("\n")}
const { GOLDEN_KEYS, renderGolden } = await import(${JSON.stringify(FIXTURES)});
const keyOf = ${keyOf.toString()};
const out = {};
for (const key of GOLDEN_KEYS) out[key] = await renderGolden(keyOf(key));
// Awaited: console.log of this much output into the pipe is cut at 64 KiB when the process exits.
await Bun.write(Bun.stdout, JSON.stringify(out));
`;
}

interface Run {
  readonly exitCode: number;
  readonly stderr: string;
  readonly rendered: Record<string, string>;
}

const membersOf = (group: readonly string[]): EngineModule[] => ENGINE_MODULES.filter(({ id }) => group.includes(id));

async function render(group: readonly string[]): Promise<Run> {
  // THE SCRIPT GOES IN A FILE, NOT IN ARGV, AND THAT IS MEASURED RATHER THAN
  // PREFERRED. `bun -e <script>` passes the whole generated module as one
  // command-line argument, and that argument grows with every engine this suite
  // covers. On 19 October 2026 it crossed Windows's command-line limit: the
  // `Cross-platform Tests (windows-latest)` job went red with `ENAMETOOLONG` out
  // of `uv_spawn`, and main stayed red from that commit onwards (runs for
  // 6e611bf7, 3220eb60, 9c983bb5) while macOS and Linux passed, because only
  // Windows caps the command line this low. A file has no such ceiling, so the
  // suite can keep gaining engines without this coming back.
  const dir = mkdtempSync(join(tmpdir(), "libredb-isolation-"));
  const file = join(dir, "child.ts");
  writeFileSync(file, scriptFor(membersOf(group)), "utf8");
  try {
    const child = Bun.spawn(["bun", file], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stderr, rendered: exitCode === 0 ? (JSON.parse(stdout) as Record<string, string>) : {} };
  } finally {
    // `finally`, not a last line: a child that fails leaves the directory behind
    // exactly on the runs where the suite is already failing, and a runner that
    // keeps those is the one that runs out of disk.
    rmSync(dir, { recursive: true, force: true });
  }
}

const runs = new Map<number, Run>();

beforeAll(async () => {
  await runPool(
    GROUPS.map((_, index) => index),
    async (index) => {
      runs.set(index, await render(GROUPS[index] ?? []));
    },
  );
}, 120_000);

/** The child that shows `id`'s own replaced output: the first group holding it, one half of the lowest bit. */
const ownRun = (id: string): Run | undefined => runs.get(GROUPS.findIndex((group) => group.includes(id)));

const golden = (key: string): string => readFileSync(join(GOLDEN_DIR, goldenFileName(key)), "utf8");

/** The `edit(` lines of a rendering whose edited text is a value, not NULL. */
const valueEdits = (rendered: string): string[] =>
  rendered.split("\n").filter((line) => line.startsWith("edit(") && !/^edit\([^,]+, "(NULL)?", /.test(line));

/** The engine's committed edits reach their UPDATE: the key check ran, so a bound edit has a statement to land in. */
const editsReachUpdate = (key: string): boolean =>
  valueEdits(golden(key)).every((line) => !line.includes('"keyCheck":null'));

describe("SQL writing isolation", () => {
  test("the groups replace every engine while holding every other engine real", () => {
    const ids = ENGINE_MODULES.map(({ id }) => id);
    const unseparated: string[] = [];
    for (const a of ids) {
      for (const b of ids) {
        if (a !== b && !GROUPS.some((group) => group.includes(a) && !group.includes(b))) unseparated.push(`${a}>${b}`);
      }
    }
    expect(unseparated).toEqual([]);
    expect(ids.filter((id) => !GROUPS[0]?.includes(id) && !GROUPS[1]?.includes(id))).toEqual([]);
  });

  GROUPS.forEach((group, index) => {
    test(`with ${group.join(", ")} replaced, every other key renders its golden`, () => {
      const run = runs.get(index);
      expect({ exitCode: run?.exitCode, stderr: run?.stderr }).toEqual({ exitCode: 0, stderr: "" });
      const rendered = run?.rendered ?? {};
      for (const key of GOLDEN_KEYS) {
        if (group.includes(key)) continue;
        expect({ key, rendered: rendered[key] }).toEqual({ key, rendered: golden(key) });
      }
    });
  });

  for (const engine of ENGINE_MODULES) {
    test(`${engine.id}: its replaced module is what its own output reads`, () => {
      const run = ownRun(engine.id);
      expect({ exitCode: run?.exitCode, stderr: run?.stderr }).toEqual({ exitCode: 0, stderr: "" });
      const rendered = run?.rendered ?? {};
      expect(rendered[engine.id]).toContain('=> "SENTINEL"');
      const ddl = (rendered[engine.id] ?? "").split("\n").find((line) => line.startsWith("ddl(inferred) => "));
      expect(ddl).toContain("SENTINEL SENTINEL");
      const lineOf = (prefix: string): string | undefined =>
        (rendered[engine.id] ?? "").split("\n").find((line) => line.startsWith(prefix));
      expect(lineOf('ddl("varchar2") => ')).toBe('ddl("varchar2") => "CREATE TABLE t (\\n  SENTINEL varchar2\\n);"');
      expect(lineOf("csv(numeric) => ")).toBe(
        `csv(numeric) => "nf,lc,df,nm,bd,tx,none\\n${Array(7).fill(`\\"'-Infinity\\"`).join(",")}\\n${Array(7).fill(`\\"'=1+1\\"`).join(",")}"`,
      );
      if (editsReachUpdate(engine.id)) {
        const edits = valueEdits(rendered[engine.id] ?? "");
        expect(edits.length).toBeGreaterThan(0);
        expect(edits.filter((line) => !line.includes(BOUND_EDIT))).toEqual([]);
      }
    });
  }
});
