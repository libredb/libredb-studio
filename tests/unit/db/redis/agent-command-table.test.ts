/**
 * The agent's closed command table walked against what the servers say about each command: the `COMMAND INFO`
 * answers Redis 8.10.2 and Valkey 9.1.2 gave, captured in tests/fixtures/redis/<version>/agent-boundary/command-info.json
 * by that directory's run.sh.
 *
 * An entry passes only when the server flags it `readonly`, flags it none of `write`, `admin`, `pubsub`,
 * `may_replicate` or `script_runner`, puts it in none of the `@write`, `@admin`, `@dangerous`, `@scripting` or
 * `@pubsub` categories, and gives every key it names a read-only (RO) key spec, never RW, OW or RM. The negative cases
 * prove the walk refuses what it must: FLUSHALL carries only `write` and no key spec, CONFIG SET is admin, EVAL runs a
 * script, PFCOUNT reads with an RW key spec, since it may rewrite the key's cached cardinality and replicate it, DEBUG
 * is admin, and INFO carries no `readonly` flag at all.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { REDIS_AGENT_COMMANDS } from "@/lib/db/providers/keyvalue/redis-agent-statement";

const VERSIONS = ["8.10.2", "valkey-9.1.2"] as const;
const FIXTURES = posix.join(import.meta.dir.replaceAll("\\", "/"), "../../../fixtures/redis");

/** One `COMMAND INFO` entry as RESP2 answers it: name, arity, flags, first, last, step, categories, tips, key specs. */
type CommandInfo = [string, string, string[], string, string, string, string[], unknown[], unknown[][], unknown[]];

function captured(version: string): Readonly<Record<string, CommandInfo>> {
  const file = posix.join(FIXTURES, version, "agent-boundary/command-info.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { commands: Record<string, CommandInfo> }).commands;
}

const REFUSED_FLAGS = ["write", "admin", "pubsub", "may_replicate", "script_runner"];
const REFUSED_CATEGORIES = ["@write", "@admin", "@dangerous", "@scripting", "@pubsub"];

/** The flags of each key spec, read from its flat `name, value` pairs. */
function keySpecFlags(info: CommandInfo): string[][] {
  return info[8].map((spec) => {
    const at = spec.indexOf("flags");
    return at < 0 ? [] : (spec[at + 1] as string[]);
  });
}

/** Why the server's own description refuses `info` a place in the table, or an empty list when it admits it. */
function walk(info: CommandInfo | undefined): string[] {
  if (info === undefined) return ["the server does not know the command"];
  const reasons: string[] = [];
  const flags = info[2];
  if (!flags.includes("readonly")) reasons.push("not flagged readonly");
  for (const flag of REFUSED_FLAGS) if (flags.includes(flag)) reasons.push(`flagged ${flag}`);
  for (const category of REFUSED_CATEGORIES) if (info[6].includes(category)) reasons.push(`in ${category}`);
  for (const spec of keySpecFlags(info)) {
    if (!spec.includes("RO")) reasons.push(`a key spec that is not RO (${spec.join(",")})`);
    for (const flag of ["RW", "OW", "RM"]) if (spec.includes(flag)) reasons.push(`a key spec flagged ${flag}`);
  }
  return reasons;
}

describe.each(VERSIONS)("the agent's command table against %s's COMMAND INFO", (version) => {
  const commands = captured(version);

  test("the capture is that server's answer", () => {
    const header = JSON.parse(
      readFileSync(posix.join(FIXTURES, version, "agent-boundary/command-info.json"), "utf8"),
    ).$captured;
    expect(header.version).toBe(version.replace(/^valkey-/, ""));
    expect(header.image).toContain("@sha256:");
  });

  test.each(Object.entries(REDIS_AGENT_COMMANDS))("%s is a read the server describes as one", (_op, entry) => {
    const info = commands[entry.info];
    expect(walk(info)).toEqual([]);
    // A table row takes a key exactly when the server says its command names one.
    expect(info[8].length > 0).toBe(entry.takesKey);
  });

  test.each([
    ["flushall", ["flagged write", "in @write", "in @dangerous", "not flagged readonly"]],
    ["config|set", ["flagged admin", "in @admin", "in @dangerous", "not flagged readonly"]],
    [
      "eval",
      [
        "not flagged readonly",
        "in @scripting",
        "a key spec that is not RO (RW,access,update)",
        "a key spec flagged RW",
      ],
    ],
    ["pfcount", ["a key spec that is not RO (RW,access)", "a key spec flagged RW"]],
    ["debug", ["flagged admin", "in @admin", "in @dangerous", "not flagged readonly"]],
    ["info", ["not flagged readonly", "in @dangerous"]],
  ] as const)("the walk refuses %s", (name, reasons) => {
    expect(walk(commands[name]).sort()).toEqual(expect.arrayContaining([...reasons].sort()));
    expect(walk(commands[name]).length).toBeGreaterThan(0);
  });

  test("the walk refuses every read a reviewer would reach for first, so none of them can join the table unnoticed", () => {
    for (const name of [
      "keys",
      "sort_ro",
      "eval_ro",
      "evalsha_ro",
      "fcall_ro",
      "memory|doctor",
      "memory|stats",
      "client|list",
      "config|get",
      "hello",
      "acl|whoami",
    ]) {
      expect(walk(commands[name]), name).not.toEqual([]);
    }
    expect(walk(undefined)).toEqual(["the server does not know the command"]);
  });

  test("EVAL_RO is refused by its category even where the server drops its script_runner flag", () => {
    const info = commands.eval_ro;
    expect(walk(info)).toContain("in @scripting");
    if (version === "valkey-9.1.2") expect(info[2]).not.toContain("script_runner");
    else expect(info[2]).toContain("script_runner");
  });
});
