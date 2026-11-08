/**
 * A line of `;` and a line of `(`, a million characters each, through the confirmation gate and the etcd provider's own
 * guard, on Bun and on the Node the tests find on PATH: each is refused at its first character, as the line of one
 * character is, the gate asks nothing about a text that will not run, and the provider sends nothing.
 *
 * Each such character is a refusal of its own, and the lexer once added a line's refusals to the text's list as the
 * arguments of one call, so a long enough line overflowed the stack inside the reader that both the gate and the
 * provider call first. Measured on 2026-11-04: `isDestructiveNonSqlQuery(text, "etcd")` raised `RangeError: Maximum
 * call stack size exceeded` at 700,000 such characters under Bun 1.4.4 (600,000 passed) and at 130,000 under Node
 * 24.22.1 (120,000 passed), and `POST /api/db/statement/analyze` on the production server under that Node answered
 * 130,000 with 500 (120,000 with 200). The limit is each runtime's own, so the lines run on both, and a million is
 * past both.
 *
 * Under Node: tests/helpers/etcd-text-outcomes.ts is bundled for Node and run in a child process.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type EtcdTextCase, type EtcdTextOutcome, etcdTextOutcomes } from "../../../helpers/etcd-text-outcomes";

const LONG = 1_000_000;

const CASES: readonly EtcdTextCase[] = [
  { name: "a line of one ;", text: ";" },
  { name: "a line of 1,000,000 ;", text: ";".repeat(LONG) },
  { name: "a line of one (", text: "(" },
  { name: "a line of 1,000,000 (", text: "(".repeat(LONG) },
];

/** The sentence spec 5.1.1 refuses a shell operator with, here the text's first character. */
const refusedAtFirst = (name: string, char: string): EtcdTextOutcome => ({
  name,
  gate: false,
  guard: `QueryError: Studio runs one etcdctl command and no shell, so it refuses the ${char} at line 1, column 1: write the text between single quotes to keep it as written.`,
  sent: 0,
});

const EXPECTED: readonly EtcdTextOutcome[] = [
  refusedAtFirst("a line of one ;", ";"),
  refusedAtFirst("a line of 1,000,000 ;", ";"),
  refusedAtFirst("a line of one (", "("),
  refusedAtFirst("a line of 1,000,000 (", "("),
];

let inBun: EtcdTextOutcome[] = [];
let underNode: { version: string; outcomes: EtcdTextOutcome[] } = { version: "", outcomes: [] };

beforeAll(async () => {
  inBun = await etcdTextOutcomes(CASES);
  const node = Bun.which("node");
  if (node === null) {
    throw new Error(
      "No node on PATH: this test runs the gate and the provider under Node, the production runtime; install Node 24 or later",
    );
  }
  const work = mkdtempSync(join(tmpdir(), "etcd-long-line-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", "..", "..", "helpers", "etcd-text-outcomes.ts")],
      target: "node",
      format: "esm",
      outdir: work,
    });
    expect({ success: build.success, logs: build.logs.map(String) }).toMatchObject({ success: true });
    writeFileSync(join(work, "input.json"), JSON.stringify(CASES));
    writeFileSync(
      join(work, "run.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        `const { etcdTextOutcomes } = await import(${JSON.stringify(pathToFileURL(build.outputs[0].path).href)});`,
        `const cases = JSON.parse(readFileSync(${JSON.stringify(join(work, "input.json"))}, "utf8"));`,
        "process.stdout.write(JSON.stringify({ version: process.version, outcomes: await etcdTextOutcomes(cases) }));",
        "",
      ].join("\n"),
    );
    // A synchronous spawn holds this process, so the child carries its own bound.
    const run = Bun.spawnSync([node, join(work, "run.mjs")], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    expect({
      exitCode: run.exitCode,
      timedOut: run.exitedDueToTimeout === true,
      stderr: run.stderr.toString(),
    }).toMatchObject({ exitCode: 0, timedOut: false });
    underNode = JSON.parse(run.stdout.toString());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 180_000);

describe("a long line of shell operators, through the gate and the provider's guard", () => {
  test("under Bun, each line is refused at its first character, the gate asks nothing and nothing is sent", () => {
    expect(inBun).toEqual([...EXPECTED]);
  });

  test("under Node, the production runtime, the same", () => {
    expect(underNode.version).toMatch(/^v\d+\./);
    expect(underNode.outcomes).toEqual([...EXPECTED]);
  });
});
