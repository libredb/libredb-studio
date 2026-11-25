/**
 * The provider loader under Node.js, each case in a fresh bounded child (docs/providers/CONTRACT.md, clauses C-87 to
 * C-89).
 *
 * Studio's server and the VS Code extension's backend child run the loader under Node, which reads a CommonJS entry's
 * interop wrapper differently from Bun, and a case whose regression would hang must never run in the test process.
 * So each case runs in the node on PATH under `--max-old-space-size=256` with a timeout on the spawn: a child that
 * hangs is killed and fails its case within seconds. The child is a plain CommonJS script that requires the loader's
 * source by its absolute path, so nothing is bundled and Node runs the loader's own file.
 *
 * The child prints one JSON line per event: the loader's answer, and each late settle its port receives.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LOADER = path.resolve(import.meta.dir, "..", "..", "..", "..", "src", "lib", "provider-loader", "index.cjs");
const HEAP_LIMIT_MIB = 256;
const TIMEOUT_MS = 20_000;

/** The child: loads `entry` under `deadlineMs` and prints the answer, then the late settle when it waits for one. */
const CHILD = `"use strict";
const { loadPackage } = require(process.argv[2]);
const [, , , entry, deadline, waitForLate] = process.argv;
let settled;
const late = new Promise((resolve) => {
  settled = resolve;
});
loadPackage(entry, {
  deadlineMs: Number(deadline),
  onLateSettle: (settle) => {
    const cause = settle.cause instanceof Error ? settle.cause.message : undefined;
    process.stdout.write(JSON.stringify({ late: settle.outcome, cause }) + "\\n");
    settled();
  },
}).then(async (answer) => {
  const record = answer.loaded ? answer.record : undefined;
  process.stdout.write(JSON.stringify({ loaded: answer.loaded, reason: answer.reason, record }) + "\\n");
  if (waitForLate === "wait") await late;
});
`;

const FIXTURES: Record<string, string> = {
  "child.cjs": CHILD,
  "commonjs-wrapper.cjs": 'module.exports = { __esModule: true, default: { marker: "inner" } };',
  "own-dependency/index.mjs": ['import dep from "dep-y";', "export default { version: dep.version };"].join("\n"),
  "own-dependency/node_modules/dep-y/package.json": JSON.stringify({
    name: "dep-y",
    version: "1.0.0",
    main: "index.js",
  }),
  "own-dependency/node_modules/dep-y/index.js": 'module.exports = { version: "1.0.0-own" };',
  "never-settles.mjs": ["await new Promise(() => {});", "export default {};"].join("\n"),
  "late-rejection.mjs": [
    "await new Promise((resolve) => setTimeout(resolve, 300));",
    'throw new Error("rejected after the deadline");',
    "export default {};",
  ].join("\n"),
};

let dir = "";

/** Runs the child under Node on one fixture and answers its JSON lines; a child that fails or hangs fails the case. */
async function runChild(
  fixtureName: string,
  deadlineMs: number,
  options: { readonly nodeFlags?: readonly string[]; readonly waitForLate?: boolean } = {},
): Promise<unknown[]> {
  const node = Bun.which("node");
  if (node === null) throw new Error("No node on PATH: the provider loader's Node cases need Node 24");
  const child = Bun.spawn(
    [
      node,
      `--max-old-space-size=${HEAP_LIMIT_MIB}`,
      ...(options.nodeFlags ?? []),
      path.join(dir, "child.cjs"),
      LOADER,
      path.join(dir, fixtureName),
      String(deadlineMs),
      options.waitForLate === true ? "wait" : "no-wait",
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 || child.signalCode !== null) {
    throw new Error(`The ${fixtureName} child exited ${exitCode} (signal ${child.signalCode}): ${stderr.trim()}`);
  }
  return stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "provider-loader-node-"));
  for (const [name, text] of Object.entries(FIXTURES)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), `${text}\n`);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the provider loader under Node.js", () => {
  test("under Node, a CommonJS entry's interop wrapper is refused as interop-wrapper, in a bounded child", async () => {
    expect(await runChild("commonjs-wrapper.cjs", 5_000)).toEqual([{ loaded: false, reason: "interop-wrapper" }]);
  });

  test("under Node, a default record loads with its own dependency, in a bounded child", async () => {
    expect(await runChild("own-dependency/index.mjs", 5_000)).toEqual([
      { loaded: true, record: { version: "1.0.0-own" } },
    ]);
  });

  test("under Node, an import that never settles is refused at its deadline and holds no exit, in a bounded child", async () => {
    expect(await runChild("never-settles.mjs", 100)).toEqual([{ loaded: false, reason: "deadline-passed" }]);
  });

  test("under Node with --unhandled-rejections=strict, a rejection after the deadline reaches the port once and the child exits 0, in a bounded child", async () => {
    expect(
      await runChild("late-rejection.mjs", 100, { nodeFlags: ["--unhandled-rejections=strict"], waitForLate: true }),
    ).toEqual([
      { loaded: false, reason: "deadline-passed" },
      { late: "rejected", cause: "rejected after the deadline" },
    ]);
  });
});
