/**
 * One engine's module cannot reach another engine's output. For each type id a fresh `bun`
 * process replaces that id's module with a sentinel spec that differs from the default in every
 * field, renders every golden key, and prints the renderings as JSON. Every key but the mocked
 * one must still match its committed golden file byte for byte; the mocked one must not, which
 * is the positive control that the mock took hold.
 *
 * A process per id because `mock.module()` is process-wide with no undo.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { howItFailed } from "../../../helpers/spawn-outcome";
import { type EngineModule, engineModules, ROOT } from "./engine-modules";
import { GOLDEN_KEYS } from "./fixtures";

const GOLDEN_DIR = join(import.meta.dir, "golden");
const FIXTURES = join(import.meta.dir, "fixtures.ts");
const CONCURRENCY = 8;

/** The child: mock one module with the sentinel, then render every key through the real readers. */
function script(engine: EngineModule): string {
  return `
import { mock } from "bun:test";
import { DEFAULT_SQL_GRAMMAR } from "@/lib/db/sql-grammar/shared";
const SENTINEL = {
  grammar: { ...DEFAULT_SQL_GRAMMAR, hash: "comment", bracket: "subscript", blockComment: "nesting", doubleSlashComment: true },
  readsSqlText: false,
  redaction: { kind: "command", read: () => "SENTINEL" },
  updateTarget: {
    dashCommentNeedsSeparator: true,
    extraQueryOpeners: new Set(["SENTINEL"]),
    extraSetOperators: new Set(["SENTINEL"]),
  },
  completion: { formatSegment: () => "SENTINEL", readQuotedQualifier: () => "sentinel" },
};
mock.module(${JSON.stringify(engine.path)}, () => ({ ${engine.exportName}: SENTINEL }));
const { GOLDEN_KEYS, renderGolden } = await import(${JSON.stringify(FIXTURES)});
const out = {};
for (const key of GOLDEN_KEYS) out[key] = renderGolden(key);
process.stdout.write(JSON.stringify(out));
`;
}

async function renderWithMock(engine: EngineModule): Promise<Record<string, string>> {
  const child = Bun.spawn(["bun", "-e", script(engine)], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  if (child.exitCode !== 0) throw new Error(`${engine.id}: the child ${howItFailed(child)}: ${stderr}`);
  return JSON.parse(stdout) as Record<string, string>;
}

/** Runs every module's child, `CONCURRENCY` at a time. */
async function renderAll(modules: readonly EngineModule[]): Promise<Map<string, Record<string, string>>> {
  const results = new Map<string, Record<string, string>>();
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < modules.length) {
      const engine = modules[next++];
      // oxlint-disable-next-line no-await-in-loop -- each lane runs one child at a time, so CONCURRENCY bounds the processes.
      results.set(engine.id, await renderWithMock(engine));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));
  return results;
}

const MODULES = engineModules();
const golden = (key: string): string => readFileSync(join(GOLDEN_DIR, `${key}.txt`), "utf8");

describe("one engine's module cannot reach another engine's output", () => {
  test(
    "mocking each engine's module moves its own golden output and no other",
    async () => {
      expect(MODULES.length).toBe(GOLDEN_KEYS.length - 3);
      const results = await renderAll(MODULES);
      for (const engine of MODULES) {
        const rendered = results.get(engine.id) ?? {};
        expect(Object.keys(rendered)).toEqual([...GOLDEN_KEYS]);
        for (const key of GOLDEN_KEYS) {
          if (key === engine.id) {
            expect({ mocked: engine.id, ownOutputMoved: rendered[key] !== golden(key) }).toEqual({
              mocked: engine.id,
              ownOutputMoved: true,
            });
          } else {
            expect({ mocked: engine.id, key, matches: rendered[key] === golden(key) }).toEqual({
              mocked: engine.id,
              key,
              matches: true,
            });
          }
        }
      }
    },
    { timeout: 300_000 },
  );
});
