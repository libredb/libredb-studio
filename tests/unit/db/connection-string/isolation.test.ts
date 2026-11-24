/**
 * One engine's connection string module cannot reach another engine's output. The registry index composes each row
 * from its declaration and the functions it imports from the module beside each engine whose declaration names one
 * (`<ID>_URL_TLS`, `<ID>_PASTE_READER`, `<ID>_SEED_CHECK`). For each of `separatingGroups`' groups of those engines, a
 * fresh `bun test` process replaces every module in the group with sentinel functions (a TLS reader, a paste reader
 * that claims nothing and a seed refusal, each marked as a sentinel) before the parser, the seed schema and the golden
 * fixtures load, renders every golden key, and writes them out with whether each replaced engine's composed row holds
 * the sentinels. Every key OUTSIDE the group must still equal its committed golden file, and every replaced engine's
 * row must hold only sentinels, which proves the sentinel was read: a declaration states the scheme, so a sentinel can
 * no longer change one. The groups separate every ordered pair of those engines, so each is held real while each other
 * is replaced, and every engine that names no function is held real in every child.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTION_STRING } from "@/lib/db/connection-string";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { runPool, separatingGroups } from "../isolation-children";
import { GOLDEN_KEYS } from "./fixtures";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const GOLDEN_DIR = join(import.meta.dir, "golden");
const FIXTURES = join(import.meta.dir, "fixtures.ts");
const INDEX = join(ROOT, "src/lib/db/connection-string/index.ts");

/** Each engine module the registry index imports, with the exports it imports from it, read from the index itself. */
function engineImports(): Map<string, { readonly path: string; readonly names: readonly string[] }> {
  const imports = new Map<string, { readonly path: string; readonly names: readonly string[] }>();
  for (const match of readFileSync(INDEX, "utf8").matchAll(
    /import \{ ([^}]+) \} from "@\/(lib\/db\/providers\/[^"]+)";/g,
  )) {
    const names = (match[1] as string).split(",").map((name) => name.trim());
    const ids = new Set(names.map((name) => name.replace(/_(URL_TLS|PASTE_READER|SEED_CHECK)$/, "").toLowerCase()));
    if (ids.size !== 1) throw new Error(`the registry index imports ${names.join(", ")} from one module`);
    imports.set([...ids][0] as string, { path: join(ROOT, "src", `${match[2]}.ts`), names });
  }
  return imports;
}

const MODULES = engineImports();
const IDS = [...MODULES.keys()].sort();
const GROUPS = separatingGroups(IDS);

/** The sentinel standing in for the export `name`: a function, or a paste reader of three, each marked a sentinel. */
function sentinelOf(name: string): string {
  if (name.endsWith("_URL_TLS")) return 'sentinel(() => ({ sslMode: "verify-full" }))';
  if (name.endsWith("_SEED_CHECK")) return 'sentinel(() => [{ field: "host", sentence: "SENTINEL" }])';
  return "Object.freeze({ claims: sentinel(() => false), names: sentinel(() => false), parse: sentinel(() => null) })";
}

/**
 * A test file that swaps each of `group`'s modules for sentinels, then renders every golden key into `out`, with
 * whether each replaced engine's composed row holds only the sentinels.
 */
function childScript(group: readonly string[], out: string): string {
  const mocks = group
    .map((id) => {
      const { path, names } = MODULES.get(id) as { readonly path: string; readonly names: readonly string[] };
      const exports = names.map((name) => `  ${name}: ${sentinelOf(name)},`).join("\n");
      return `mock.module(${JSON.stringify(path)}, () => ({\n${exports}\n}));`;
    })
    .join("\n");
  return `import { mock, test } from "bun:test";
import { writeFileSync } from "node:fs";

const sentinel = (fn) => Object.assign(fn, { sentinel: true });
${mocks}
const { GOLDEN_KEYS, renderConnectionStringGolden } = await import(${JSON.stringify(FIXTURES)});
const { CONNECTION_STRING } = await import(${JSON.stringify(INDEX)});

test("render", () => {
  const rendered = Object.fromEntries(GOLDEN_KEYS.map((key) => [key, renderConnectionStringGolden(key)]));
  const held = Object.fromEntries(
    ${JSON.stringify(group)}.map((id) => {
      const row = CONNECTION_STRING[id];
      const functions = [row.readTls, row.paste?.claims, row.paste?.names, row.paste?.parse, row.validateSeed].filter(
        (fn) => fn !== null && fn !== undefined,
      );
      return [id, functions.length > 0 && functions.every((fn) => fn.sentinel === true)];
    }),
  );
  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ rendered, held }));
});
`;
}

let dir = "";
const rendered = new Map<number, Record<string, string>>();
const held = new Map<number, Record<string, boolean>>();
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
  const written = JSON.parse(readFileSync(out, "utf8"));
  rendered.set(index, written.rendered);
  held.set(index, written.held);
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
    expect(Object.keys(CONNECTION_STRING).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    // Every engine the index imports a module for is a shipped one, so every module is replaced in some child.
    expect(IDS.filter((id) => !Object.hasOwn(CONNECTION_STRING, id))).toEqual([]);
    expect(IDS.length).toBeGreaterThan(1);
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
        if (!group.includes(key)) expect({ key, rendered: output[key] }).toEqual({ key, rendered: golden });
      }
      // Every replaced engine's composed row holds the sentinels and nothing else: the replacement was read.
      expect(held.get(index)).toEqual(Object.fromEntries(group.map((id) => [id, true])));
    });
  });
});
