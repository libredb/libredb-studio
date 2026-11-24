/**
 * One engine's SQL text cannot reach another engine's output. For each type id a fresh `bun` process replaces that id's
 * entry of the generated SQL text the registry composes its rows from with a sentinel entry that differs from it in its
 * grammar, its SQL text reading and its update target words, and for an engine whose grammar functions Studio's
 * function table binds, replaces its function module's exports with sentinel functions too; it then renders every
 * golden key and prints the renderings as JSON. Every key but the replaced one must still match its committed golden
 * file byte for byte; the replaced one must not, which is the positive control that the mock took hold.
 *
 * A process per id because `mock.module()` is process-wide with no undo.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { howItFailed } from "../../../helpers/spawn-outcome";
import { type EngineModule, engineModules, ROOT } from "./engine-modules";
import { GOLDEN_KEYS } from "./fixtures";

const GOLDEN_DIR = join(import.meta.dir, "golden");
const FIXTURES = join(import.meta.dir, "fixtures.ts");
const GENERATED = join(ROOT, "src", "lib", "db", "engine-catalog", "sql-text.generated.ts");
const CONCURRENCY = 8;

/** The child: replace one id's entry, and its function module where it has one, then render every key. */
function script(id: string, functions: EngineModule | undefined): string {
  const replaced =
    functions === undefined
      ? ""
      : `
const realFunctions = await import(${JSON.stringify(functions.path)});
mock.module(${JSON.stringify(functions.path)}, () => ({
  ...realFunctions,
  ${functions.exportNames.map((name) => `${name}: () => "SENTINEL"`).join(",\n  ")},
}));`;
  return `
import { mock } from "bun:test";
const { BUNDLED_SQL_TEXT } = await import(${JSON.stringify(GENERATED)});
const real = BUNDLED_SQL_TEXT[${JSON.stringify(id)}];
const SENTINEL = {
  readsSqlText: !real.readsSqlText,
  grammar: {
    ...real.grammar,
    hash: real.grammar.hash === "comment" ? "code" : "comment",
    bracket: real.grammar.bracket === "subscript" ? "quoted-identifier" : "subscript",
    blockComment: real.grammar.blockComment === "nesting" ? "flat" : "nesting",
    doubleSlashComment: !real.grammar.doubleSlashComment,
  },
  updateTarget: {
    dashCommentNeedsSeparator: !real.updateTarget.dashCommentNeedsSeparator,
    extraQueryOpeners: ["SENTINEL"],
    extraSetOperators: ["SENTINEL"],
  },
  completion: real.completion,
};
mock.module(${JSON.stringify(GENERATED)}, () => ({
  BUNDLED_SQL_TEXT: { ...BUNDLED_SQL_TEXT, ${JSON.stringify(id)}: SENTINEL },
}));${replaced}
const { GOLDEN_KEYS, renderGolden } = await import(${JSON.stringify(FIXTURES)});
const out = {};
for (const key of GOLDEN_KEYS) out[key] = renderGolden(key);
process.stdout.write(JSON.stringify(out));
`;
}

async function renderWithMock(id: string): Promise<Record<string, string>> {
  const functions = MODULES.find((engine) => engine.id === id);
  const child = Bun.spawn(["bun", "-e", script(id, functions)], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  if (child.exitCode !== 0) throw new Error(`${id}: the child ${howItFailed(child)}: ${stderr}`);
  return JSON.parse(stdout) as Record<string, string>;
}

/** Runs every id's child, `CONCURRENCY` at a time. */
async function renderAll(ids: readonly string[]): Promise<Map<string, Record<string, string>>> {
  const results = new Map<string, Record<string, string>>();
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next++];
      // oxlint-disable-next-line no-await-in-loop -- each lane runs one child at a time, so CONCURRENCY bounds the processes.
      results.set(id, await renderWithMock(id));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));
  return results;
}

const MODULES = engineModules();
const IDS = [...EXTERNAL_DATABASE_TYPES, "libredb"].sort();
const golden = (key: string): string => readFileSync(join(GOLDEN_DIR, `${key}.txt`), "utf8");

describe("one engine's SQL text cannot reach another engine's output", () => {
  test(
    "replacing each engine's SQL text and functions moves its own golden output and no other",
    async () => {
      expect(IDS.length).toBe(GOLDEN_KEYS.length - 1);
      const results = await renderAll(IDS);
      for (const id of IDS) {
        const rendered = results.get(id) ?? {};
        expect(Object.keys(rendered)).toEqual([...GOLDEN_KEYS]);
        for (const key of GOLDEN_KEYS) {
          if (key === id) {
            expect({ mocked: id, ownOutputMoved: rendered[key] !== golden(key) }).toEqual({
              mocked: id,
              ownOutputMoved: true,
            });
          } else {
            expect({ mocked: id, key, matches: rendered[key] === golden(key) }).toEqual({
              mocked: id,
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
