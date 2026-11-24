/**
 * One engine's migration text moves only that engine's golden file. For each shipped type id a fresh `bun` process
 * replaces that id's entry of the generated migration DDL every row is composed from
 * (src/lib/db/engine-catalog/migration-ddl.generated.ts) with a sentinel refused entry through `mock.module`, the other
 * entries kept as committed, renders every golden key, and prints the renders as JSON: every other key must still equal
 * its committed golden file, and the replaced id's own render must carry the sentinel, which proves the mock took. A
 * render that throws counts as moved, under its key.
 *
 * A process per id because bun's module mocks are process-wide with no undo. The processes run eight at a time, and
 * `renderGolden` freezes the clock itself, so a process needs no setup.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { GOLDEN_KEYS } from "./fixtures";
import { ROOT } from "./modules";

const GOLDEN_DIR = join(import.meta.dir, "golden");
const FIXTURES = join(import.meta.dir, "fixtures.ts");
const SENTINEL = { tableDdl: "refused", refusal: "-- SENTINEL", transactionWrapper: null, reasons: [] };
const CONCURRENCY = 8;
const GENERATED = join(ROOT, "src", "lib", "db", "engine-catalog", "migration-ddl.generated.ts");

interface Run {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly renders: Record<string, string> | undefined;
}

function script(id: string): string {
  const path = JSON.stringify(GENERATED);
  return [
    'import { mock } from "bun:test";',
    `const real = (await import(${path})).BUNDLED_MIGRATION_DDL;`,
    `const replaced = { ...real, ${JSON.stringify(id)}: ${JSON.stringify(SENTINEL)} };`,
    `mock.module(${path}, () => ({ BUNDLED_MIGRATION_DDL: replaced }));`,
    `const { GOLDEN_KEYS, renderGolden } = await import(${JSON.stringify(FIXTURES)});`,
    "const renders = {};",
    // A render that throws is recorded as its error, so the key it broke is named rather than the whole run lost.
    "for (const key of GOLDEN_KEYS) {",
    "  try { renders[key] = renderGolden(key); } catch (error) { renders[key] = 'throws: ' + String(error); }",
    "}",
    "process.stdout.write(JSON.stringify(renders));",
  ].join("\n");
}

async function run(id: string): Promise<Run> {
  const child = Bun.spawn(["bun", "-e", script(id)], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, renders: exitCode === 0 ? JSON.parse(stdout) : undefined };
}

const runs = new Map<string, Run>();

beforeAll(async () => {
  const queue: string[] = [...SHIPPED_DATABASE_TYPES];
  // Each worker takes the next id when its process ends, so eight run at once.
  const worker = async (): Promise<void> => {
    const id = queue.shift();
    if (id === undefined) return;
    runs.set(id, await run(id));
    return worker();
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}, 120_000);

describe("migration DDL isolation", () => {
  test("one process per shipped type id", () => {
    expect([...runs.keys()].sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  for (const id of SHIPPED_DATABASE_TYPES) {
    test(`replacing ${id} moves only ${id}'s render`, () => {
      const result = runs.get(id);
      expect(result?.stderr).toBe("");
      expect(result?.exitCode).toBe(0);
      const renders = result?.renders ?? {};
      expect(renders[id]).toContain("-- SENTINEL");
      const moved = GOLDEN_KEYS.filter(
        (key) => key !== id && renders[key] !== readFileSync(join(GOLDEN_DIR, `${key}.txt`), "utf8"),
      );
      expect(moved).toEqual([]);
    });
  }
});
