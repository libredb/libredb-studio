/**
 * One engine's connection string module cannot reach another engine's output. For each of `separatingGroups`' groups
 * of type ids, a fresh `bun test` process replaces every module in the group with a sentinel spec (its own scheme, a
 * TLS reader and a seed refusal) before the parser, the seed schema and the golden fixtures load, renders every golden
 * key, and writes them out. Every key OUTSIDE the group must still equal its committed golden file, and every replaced
 * key must not, which proves the sentinel was read; the groups separate every ordered pair of ids, so each engine is
 * held real while each other engine is replaced.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTION_STRING } from "@/lib/db/connection-string";
import { runPool, separatingGroups } from "../isolation-children";
import { GOLDEN_KEYS } from "./fixtures";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const GOLDEN_DIR = join(import.meta.dir, "golden");
const FIXTURES = join(import.meta.dir, "fixtures.ts");
const INDEX = join(ROOT, "src/lib/db/connection-string/index.ts");
const IDS = Object.keys(CONNECTION_STRING).sort();
const GROUPS = separatingGroups(IDS);

/** The module path the registry index imports for `id`, read from the index itself. */
function modulePath(id: string): string {
  const name = `${id.toUpperCase()}_CONNECTION_STRING`;
  const match = readFileSync(INDEX, "utf8").match(new RegExp(`import \\{ ${name} \\} from "@/([^"]+)";`));
  if (match === null) throw new Error(`the registry index imports no ${name}`);
  return join(ROOT, "src", `${match[1]}.ts`);
}

/** A test file that swaps each of `group`'s modules for the sentinel, then renders every golden key into `out`. */
function childScript(group: readonly string[], out: string): string {
  const mocks = group
    .map(
      (id) => `mock.module(${JSON.stringify(modulePath(id))}, () => ({
  ${id.toUpperCase()}_CONNECTION_STRING: {
    scheme: "sentinel",
    readTls: () => ({ sslMode: "verify-full" }),
    validateSeed: () => [{ field: "host", sentence: "SENTINEL" }],
  },
}));`,
    )
    .join("\n");
  return `import { mock, test } from "bun:test";
import { writeFileSync } from "node:fs";

${mocks}
const { GOLDEN_KEYS, renderConnectionStringGolden } = await import(${JSON.stringify(FIXTURES)});

test("render", () => {
  const rendered = Object.fromEntries(GOLDEN_KEYS.map((key) => [key, renderConnectionStringGolden(key)]));
  writeFileSync(${JSON.stringify(out)}, JSON.stringify(rendered));
});
`;
}

let dir = "";
const rendered = new Map<number, Record<string, string>>();
const failures = new Map<number, string>();

async function runChild(index: number): Promise<void> {
  const script = join(dir, `group-${index}.test.ts`);
  const out = join(dir, `group-${index}.json`);
  writeFileSync(script, childScript(GROUPS[index] ?? [], out));
  const child = Bun.spawn(["bun", "test", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) {
    failures.set(index, stderr);
    return;
  }
  rendered.set(index, JSON.parse(readFileSync(out, "utf8")));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "connection-string-isolation-"));
  await runPool(
    GROUPS.map((_, index) => index),
    runChild,
  );
}, 300_000);

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("one engine's connection string module cannot reach another engine's output", () => {
  test("one row per shipped type id", () => {
    expect(IDS.length).toBe(43);
  });

  test("the groups replace every engine while holding every other engine real", () => {
    const unseparated: string[] = [];
    for (const a of IDS) {
      for (const b of IDS) {
        if (a !== b && !GROUPS.some((group) => group.includes(a) && !group.includes(b))) unseparated.push(`${a}>${b}`);
      }
    }
    expect(unseparated).toEqual([]);
  });

  GROUPS.forEach((group, index) => {
    test(`with ${group.join(", ")} replaced, every other key renders its golden`, () => {
      expect(failures.get(index)).toBeUndefined();
      const output = rendered.get(index) as Record<string, string>;
      expect(Object.keys(output).sort()).toEqual([...GOLDEN_KEYS].sort());
      for (const key of GOLDEN_KEYS) {
        const golden = readFileSync(join(GOLDEN_DIR, `${key}.txt`), "utf8");
        if (group.includes(key)) expect(output[key]).not.toBe(golden);
        else expect({ key, rendered: output[key] }).toEqual({ key, rendered: golden });
      }
    });
  });
});
