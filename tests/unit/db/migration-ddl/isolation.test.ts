/**
 * One engine's migration text moves only that engine's golden file. For each type id a fresh `bun` process replaces
 * that id's spec with a sentinel through `mock.module` (the module's other exports kept, which clickhouse, databend
 * and cassandra carry), renders every golden key, and prints the renders as JSON: every other key must still equal its
 * committed golden file, and the replaced id's own render must carry the sentinel, which proves the mock took. A
 * render that throws counts as moved, under its key.
 *
 * A process per id because bun's module mocks are process-wide with no undo. The processes run eight at a time, and
 * `renderGolden` freezes the clock itself, so a process needs no setup.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { GOLDEN_KEYS } from "./fixtures";
import { type EngineModule, engineModules, ROOT } from "./modules";

const GOLDEN_DIR = join(import.meta.dir, "golden");
const FIXTURES = join(import.meta.dir, "fixtures.ts");
const SENTINEL = { tableDdl: "refused", refusal: "-- SENTINEL", transactionWrapper: null, reasons: [] };
const CONCURRENCY = 8;
const MODULES = engineModules();

interface Run {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly renders: Record<string, string> | undefined;
}

function script(engine: EngineModule): string {
  const path = JSON.stringify(join(ROOT, engine.path));
  return [
    'import { mock } from "bun:test";',
    `const real = { ...(await import(${path})) };`,
    `mock.module(${path}, () => ({ ...real, ${engine.exportName}: ${JSON.stringify(SENTINEL)} }));`,
    `const { GOLDEN_KEYS, renderGolden } = await import(${JSON.stringify(FIXTURES)});`,
    "const renders = {};",
    // A render that throws is recorded as its error, so the key it broke is named rather than the whole run lost.
    "for (const key of GOLDEN_KEYS) {",
    "  try { renders[key] = renderGolden(key); } catch (error) { renders[key] = 'throws: ' + String(error); }",
    "}",
    "process.stdout.write(JSON.stringify(renders));",
  ].join("\n");
}

async function run(engine: EngineModule): Promise<Run> {
  const child = Bun.spawn(["bun", "-e", script(engine)], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, renders: exitCode === 0 ? JSON.parse(stdout) : undefined };
}

const runs = new Map<string, Run>();

beforeAll(async () => {
  const queue = [...MODULES];
  // Each worker takes the next id when its process ends, so eight run at once.
  const worker = async (): Promise<void> => {
    const engine = queue.shift();
    if (engine === undefined) return;
    runs.set(engine.id, await run(engine));
    return worker();
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}, 120_000);

describe("migration DDL isolation", () => {
  test("one process per type id", () => {
    expect(MODULES.length).toBe(EXTERNAL_DATABASE_TYPES.length + 1);
  });

  for (const engine of MODULES) {
    test(`replacing ${engine.id} moves only ${engine.id}'s render`, () => {
      const result = runs.get(engine.id);
      expect(result?.stderr).toBe("");
      expect(result?.exitCode).toBe(0);
      const renders = result?.renders ?? {};
      expect(renders[engine.id]).toContain("-- SENTINEL");
      const moved = GOLDEN_KEYS.filter(
        (key) => key !== engine.id && renders[key] !== readFileSync(join(GOLDEN_DIR, `${key}.txt`), "utf8"),
      );
      expect(moved).toEqual([]);
    });
  }
});
