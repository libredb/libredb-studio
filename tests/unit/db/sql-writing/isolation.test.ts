import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL_WRITING } from "@/lib/db/sql-writing";
import { runPool, separatingGroups } from "../isolation-children";
import { ROOT } from "./engine-modules";
import { GOLDEN_KEYS, goldenFileName } from "./fixtures";

/**
 * One engine's SQL writing declaration cannot reach another engine's output.
 *
 * For each of `separatingGroups`' groups of engines a fresh `bun` process replaces every
 * group member's entry of the generated SQL writing every row is composed from
 * (src/lib/db/engine-catalog/sql-writing.generated.ts) with a sentinel entry, then renders
 * every golden key through the public functions. Every key OUTSIDE the group must still match
 * its committed golden file; since the groups separate every ordered pair of engines, each
 * engine is held real while each other engine is replaced. Each engine's own output must show
 * the sentinel in the first child that replaces it, so a mock that never took hold cannot pass
 * as isolation. Each group runs in its own process because bun's module mocks are
 * process-wide with no undo.
 *
 * The sentinel entry keeps the engine's function names, so each still binds the function
 * Studio's SQL writing function table holds for it: which function runs at which slot is held
 * by the golden files and tests/unit/db/sql-writing/compose.test.ts. Every data fact is a
 * sentinel instead: the export's DDL types and non-finite literals are `SENTINEL`, no bare
 * name stands alone or is re-spelled, and the inline edit names no instant or exact decimal
 * type and reads every key as float64. The replaced engine's `ddl(inferred)` line must show a
 * sentinel type, so the export read the replaced entry and not a table of its own.
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
const GENERATED = join(ROOT, "src", "lib", "db", "engine-catalog", "sql-writing.generated.ts");
const IDS = Object.keys(SQL_WRITING);
const GROUPS = separatingGroups(IDS);

const keyOf = (key: string): string | undefined => (key === "no-connection" ? undefined : key);

/** The sentinel entry of a group member: its function names kept, every data fact replaced. */
const SENTINEL_ENTRY = `(entry) => ({
  ...entry,
  inlineEdit: { ...entry.inlineEdit, instantTypeNames: [], exactDecimalTypeNames: [], float64TypeNames: "all" },
  export: {
    ...entry.export,
    ddlTypes: { text: "SENTINEL", integer: "SENTINEL", numeric: "SENTINEL", boolean: "SENTINEL", timestamp: "SENTINEL", binary: "SENTINEL" },
    standsAlone: [],
    bareSpelling: [],
    typeVocabulary: {
      bareTypeFamily: { text: [], integer: [], numeric: [], boolean: [], timestamp: [], binary: [] },
      floatType: { source: "^Float64$", flags: "" },
      exactNumericType: { source: "^SENTINEL_EXACT$", flags: "" },
      numericWrapper: { source: "^SENTINEL_WRAPPER<(.*)>$", flags: "" },
    },
    nonFinite: { NaN: "SENTINEL", Infinity: "SENTINEL", "-Infinity": "SENTINEL" },
  },
})`;

function scriptFor(group: readonly string[]): string {
  return `
import { mock } from "bun:test";
const real = await import(${JSON.stringify(GENERATED)});
const sentinel = ${SENTINEL_ENTRY};
const replaced = { ...real.BUNDLED_SQL_WRITING };
for (const id of ${JSON.stringify(group)}) replaced[id] = sentinel(replaced[id]);
mock.module(${JSON.stringify(GENERATED)}, () => ({ BUNDLED_SQL_WRITING: replaced }));
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

let dir = "";

/**
 * Runs one group's child from a script FILE, as the other isolation tests do. Handed over as
 * `bun -e <script>` it was one command-line argument of about 40,000 characters for the
 * largest group, past Windows' 32,767-character command line, and the spawn failed there with
 * ENAMETOOLONG before the child ran. The script imports by absolute path, so where the file
 * sits does not change what it resolves.
 */
async function render(group: readonly string[], index: number): Promise<Run> {
  const script = join(dir, `group-${index}.ts`);
  writeFileSync(script, scriptFor(group));
  const child = Bun.spawn(["bun", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, rendered: exitCode === 0 ? (JSON.parse(stdout) as Record<string, string>) : {} };
}

const runs = new Map<number, Run>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sql-writing-isolation-"));
  await runPool(
    GROUPS.map((_, index) => index),
    async (index) => {
      runs.set(index, await render(GROUPS[index] ?? [], index));
    },
  );
}, 120_000);

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

/** The child that shows `id`'s own replaced output: the first group holding it, one half of the lowest bit. */
const ownRun = (id: string): Run | undefined => runs.get(GROUPS.findIndex((group) => group.includes(id)));

const golden = (key: string): string => readFileSync(join(GOLDEN_DIR, goldenFileName(key)), "utf8");

describe("SQL writing isolation", () => {
  test("the groups replace every engine while holding every other engine real", () => {
    const ids = IDS;
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

  for (const id of IDS) {
    test(`${id}: its replaced declaration is what its own output reads`, () => {
      const run = ownRun(id);
      expect({ exitCode: run?.exitCode, stderr: run?.stderr }).toEqual({ exitCode: 0, stderr: "" });
      const rendered = run?.rendered ?? {};
      const lineOf = (prefix: string): string | undefined =>
        (rendered[id] ?? "").split("\n").find((line) => line.startsWith(prefix));
      expect(lineOf("ddl(inferred) => ")).toMatch(/\S SENTINEL,\\n/);
      expect(lineOf('ddl("varchar2") => ')).toMatch(/\\n {2}\S+ varchar2(,|\\n)/);
      expect(lineOf("csv(numeric) => ")).toBe(
        `csv(numeric) => "nf,lc,df,nm,bd,tx,none\\n${Array(7).fill(`\\"'-Infinity\\"`).join(",")}\\n${Array(7).fill(`\\"'=1+1\\"`).join(",")}"`,
      );
    });
  }
});
