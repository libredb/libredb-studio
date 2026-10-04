/**
 * The shell-word reader names no engine (SB2-2.5): it is shared by every console that takes a command line, so an
 * engine's name in it, in any case and inside an identifier too, is a rule of one engine written into all of them.
 *
 * The names are every shipped type-id, so a later engine joins the rule with no edit here, and four written out:
 * `oxia`, because this guard holds before that type-id is registered, and `etcdctl`, `pulsar` and `zookeeper`,
 * which are no type-id. Proven both ways: the real file passes, and a name planted in its text fails by name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SHELL_WORDS = "src/lib/db/console/shell-words.ts";

const ENGINE_NAMES: readonly string[] = [
  ...new Set<string>([...SHIPPED_DATABASE_TYPES, "etcdctl", "oxia", "pulsar", "zookeeper"]),
];

/** Each engine the text names, as a finding. */
function engineNameFindings(text: string): string[] {
  const lower = text.toLowerCase();
  return ENGINE_NAMES.filter((name) => lower.includes(name)).map((name) => `shell-words.ts names the engine ${name}`);
}

describe("src/lib/db/console/shell-words.ts names no engine", () => {
  const source = readFileSync(join(ROOT, SHELL_WORDS), "utf8");

  test("the list holds every shipped type-id and the four names written out", () => {
    for (const type of SHIPPED_DATABASE_TYPES) expect(ENGINE_NAMES).toContain(type);
    for (const name of ["etcdctl", "oxia", "pulsar", "zookeeper"]) expect(ENGINE_NAMES).toContain(name);
    // A census that read an empty list would certify nothing.
    expect(SHIPPED_DATABASE_TYPES.length).toBeGreaterThan(20);
  });

  test("the real file names none", () => {
    expect(engineNameFindings(source)).toEqual([]);
  });

  test.each([
    ['const label = "oxia";', ["oxia"]],
    ["// as etcdctl reads it", ["etcd", "etcdctl"]],
    ["const isRedisWord = true;", ["redis"]],
    ["/* a Pulsar key */", ["pulsar"]],
    ["const ZOOKEEPER = 1;", ["zookeeper"]],
  ])("a planted %s fails by name", (planted, names) => {
    expect(engineNameFindings(`${source}\n${planted}\n`).sort()).toEqual(
      names.map((name) => `shell-words.ts names the engine ${name}`).sort(),
    );
  });
});
