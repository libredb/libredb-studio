/**
 * One engine's connection fields cannot reach another engine's form. For each of `separatingGroups`' groups of type
 * ids, a fresh `bun test` process loads the real `src/lib/db/connection-fields.ts`, replaces it with a copy whose row
 * for every id in the group is `["host"]` (every other export and row the real object), then loads the dialog through
 * the golden fixtures and renders the forms. Every engine OUTSIDE the group must still equal its committed golden
 * file; since the groups separate every ordered pair of ids, each engine is held real while each other engine is
 * replaced. Each engine's own form must differ from its golden in the first child that replaces it, which proves the
 * copy was read. `SEED_ONLY_FIELDS` stays real: a seed-only row is read for every other engine by design.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPool, separatingGroups } from "../isolation-children";
import { FORM_KEYS } from "./fixtures";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const GOLDEN_DIR = join(import.meta.dir, "golden");
const FIXTURES = join(import.meta.dir, "fixtures.tsx");
const CONNECTION_FIELDS_MODULE = join(ROOT, "src/lib/db/connection-fields.ts");
const GROUPS = separatingGroups(FORM_KEYS);
/** The child that renders each id's own replaced form: the first group holding it, the two halves of the lowest bit. */
const OWN_FORM_GROUPS = new Set([0, 1]);

/** A test file that swaps `group`'s connection fields for `["host"]`, then renders `keys`' forms into `out`. */
function childScript(group: readonly string[], keys: readonly string[], out: string): string {
  const replaced = group.map((id) => `${JSON.stringify(id)}: Object.freeze(["host"])`).join(", ");
  return `import { mock, test } from "bun:test";
import { writeFileSync } from "node:fs";

const real = await import(${JSON.stringify(CONNECTION_FIELDS_MODULE)});
const copy = {
  ...real,
  CONNECTION_FIELDS: Object.freeze({ ...real.CONNECTION_FIELDS, ${replaced} }),
};
mock.module(${JSON.stringify(CONNECTION_FIELDS_MODULE)}, () => copy);
const { renderFormGolden } = await import(${JSON.stringify(FIXTURES)});

test("render", async () => {
  const rendered = {};
  for (const key of ${JSON.stringify(keys)}) rendered[key] = await renderFormGolden(key);
  writeFileSync(${JSON.stringify(out)}, JSON.stringify(rendered));
}, 120_000);
`;
}

let dir = "";
const rendered = new Map<number, Record<string, string>>();
const failures = new Map<number, string>();

/** The forms group `index`'s child renders: every engine outside it, and its own members where it proves the copy. */
function keysFor(index: number): string[] {
  const group = GROUPS[index] ?? [];
  return FORM_KEYS.filter((key) => OWN_FORM_GROUPS.has(index) || !group.includes(key));
}

async function runChild(index: number): Promise<void> {
  const script = join(dir, `group-${index}.test.tsx`);
  const out = join(dir, `group-${index}.json`);
  writeFileSync(script, childScript(GROUPS[index] ?? [], keysFor(index), out));
  const child = Bun.spawn(["bun", "test", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) {
    failures.set(index, stderr);
    return;
  }
  rendered.set(index, JSON.parse(readFileSync(out, "utf8")));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "connection-form-isolation-"));
  await runPool(
    GROUPS.map((_, index) => index),
    runChild,
  );
}, 300_000);

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

const golden = (key: string): string => readFileSync(join(GOLDEN_DIR, `${key}.txt`), "utf8");

describe("one engine's connection fields cannot reach another engine's form", () => {
  test("one form per shipped type id", () => {
    expect(FORM_KEYS.length).toBe(43);
  });

  test("the groups replace every engine while holding every other engine real", () => {
    const unseparated: string[] = [];
    for (const a of FORM_KEYS) {
      for (const b of FORM_KEYS) {
        if (a !== b && !GROUPS.some((group) => group.includes(a) && !group.includes(b))) unseparated.push(`${a}>${b}`);
      }
    }
    expect(unseparated).toEqual([]);
    expect(FORM_KEYS.filter((key) => !GROUPS[0]?.includes(key) && !GROUPS[1]?.includes(key))).toEqual([]);
  });

  GROUPS.forEach((group, index) => {
    test(`with ${group.join(", ")} replaced, every other engine renders its golden`, () => {
      expect(failures.get(index)).toBeUndefined();
      const output = rendered.get(index) as Record<string, string>;
      expect(Object.keys(output).sort()).toEqual(keysFor(index).sort());
      for (const key of keysFor(index)) {
        if (group.includes(key)) expect({ key, rendered: output[key] }).not.toEqual({ key, rendered: golden(key) });
        else expect({ key, rendered: output[key] }).toEqual({ key, rendered: golden(key) });
      }
    });
  });
});
