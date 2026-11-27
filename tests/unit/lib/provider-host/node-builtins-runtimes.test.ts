/**
 * The bare built-in names admission admits (src/lib/provider-host/node-builtins.ts) on each Node.js release Studio
 * runs: every one is a built-in of that release, so none resolves as a package. A bare name a release no longer serves
 * is resolved by Node.js as a package, by walking node_modules directories up from the importing file and out of the
 * package's directory, so it must not be admitted bare.
 *
 * It runs one Node child per binary that NODE_TRANSPORT_NODES lists (or the node on PATH), so the required
 * "Unit & Integration Tests" job runs it on Node 24 in the suite and once more on the Node release the images' runner
 * stage names (tests/unit/ci-image-node.test.ts). A release that drops a name fails here by the name, on the pull
 * request that brings that release to the images.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isNodeBuiltin, NODE_BUILTIN_MODULES } from "@/lib/provider-host/node-builtins";

/** Every name admission admits in its bare form. */
const ADMITTED_BARE = NODE_BUILTIN_MODULES.filter((name) => !name.startsWith("node:") && isNodeBuiltin(name));

/** What one Node.js child reports. */
type NodeReport = { node: string; version: string; notBuiltin: string[] };

function binaries(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  const nodes = listed === undefined ? [Bun.which("node")] : listed.split(delimiter).filter((entry) => entry !== "");
  if (nodes.length === 0 || nodes.includes(null)) {
    throw new Error("No Node binary: set NODE_TRANSPORT_NODES or put Node 24 or later on PATH");
  }
  return nodes as string[];
}

let dir: string;
const reports: NodeReport[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "node-builtins-runtimes-"));
  writeFileSync(
    join(dir, "child.mjs"),
    [
      'import { isBuiltin } from "node:module";',
      `const names = ${JSON.stringify(ADMITTED_BARE)};`,
      "const report = { version: process.version, notBuiltin: names.filter((name) => !isBuiltin(name)) };",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "",
    ].join("\n"),
  );
  for (const node of binaries()) {
    const child = Bun.spawn([node, join(dir, "child.mjs")], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`The child ${node} exited ${exitCode}: ${stderr}`);
    // A Windows child ends its lines with CRLF, so the last line is trimmed before it is parsed.
    const report = JSON.parse(stdout.trim().split("\n").at(-1) as string) as Omit<NodeReport, "node">;
    reports.push({ node, ...report });
  }
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the bare built-in names on each Node.js release", () => {
  test("every bare name admission admits is a built-in of each Node.js release Studio runs", () => {
    expect(ADMITTED_BARE).toContain("fs");
    expect(reports.length).toBe(binaries().length);
    for (const { node, version, notBuiltin } of reports) {
      expect({ node, version, notBuiltin }).toEqual({ node, version, notBuiltin: [] });
    }
  });
});
