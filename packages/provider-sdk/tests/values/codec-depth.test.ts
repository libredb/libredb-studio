/**
 * The value codec's depth bound (CONTRACT.md V-8) past any stack: a value nested 100,000 deep, and a cyclic one, is
 * refused by the bound with a `ValueCodecError`, on Node, the production runtime, and never overflows the stack.
 *
 * The cases run in a Node child with its old space limited to `HEAP_LIMIT_MIB` and a timeout of `CHILD_TIMEOUT_MS`,
 * so a codec without the bound fails here within milliseconds (the child reports a `RangeError`), and one that grew
 * without limit would end the child, never this process. The child runs a bundle that Bun.build({ target: "node" })
 * makes of `@libredb/provider-sdk/values` around the text of `runCases`, as tests/unit/db/databend/wire-heap.test.ts
 * runs its cases. The child is the node on PATH, so CI's Node 24 runs it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { decodeValue, encodeValue } from "@libredb/provider-sdk/values";
import { MAX_VALUE_DEPTH } from "@libredb/provider-sdk/values";

const HEAP_LIMIT_MIB = 64;
const CHILD_TIMEOUT_MS = 30_000;
/** Far past the deepest nesting either runtime's stack holds (measured 2026-11-23: under 20,000 on Bun and Node). */
const DEEP = 100_000;

interface CodecDeps {
  readonly encodeValue: typeof encodeValue;
  readonly decodeValue: typeof decodeValue;
}

interface CaseReport {
  readonly name: string;
  readonly verb: string;
  readonly error: string;
  readonly message: string;
  readonly segments: number;
}

/** Runs in the child, from its text, so it names nothing outside itself. */
function runCases(deps: CodecDeps, deep: number): CaseReport[] {
  const nested = (container: "array" | "object"): unknown => {
    let value: unknown = 1;
    for (let level = 0; level < deep; level++) value = container === "array" ? [value] : { a: value };
    return value;
  };
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const values: [string, unknown][] = [
    ["objects", nested("object")],
    ["arrays", nested("array")],
    ["a cycle", cyclic],
  ];
  const reports: CaseReport[] = [];
  for (const [name, value] of values) {
    for (const verb of ["encode", "decode"]) {
      try {
        if (verb === "encode") deps.encodeValue(value);
        else deps.decodeValue(value);
        reports.push({ name, verb, error: "none", message: "", segments: -1 });
      } catch (error) {
        const path = (error as { path?: unknown }).path;
        reports.push({
          name,
          verb,
          error: (error as Error).name,
          message: (error as Error).message.slice(0, 120),
          segments: typeof path === "string" ? path.split("/").length - 1 : -1,
        });
      }
    }
  }
  return reports;
}

const dir = mkdtempSync(join(tmpdir(), "value-codec-depth-"));
const at = (file: string) => join(dir, file);

beforeAll(async () => {
  // Node loads neither the package's TypeScript nor this bun:test file, so the child is a bundle.
  const values = fileURLToPath(import.meta.resolve("@libredb/provider-sdk/values"));
  writeFileSync(
    at("child.ts"),
    [
      `import { decodeValue, encodeValue } from ${JSON.stringify(values)};`,
      `const runCases = ${runCases.toString()};`,
      `const reports = runCases({ encodeValue, decodeValue }, ${DEEP});`,
      'process.stdout.write(JSON.stringify(reports) + "\\n");',
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a value nested far past any stack is refused by the depth rule in a bounded Node child, never a RangeError", () => {
  const node = Bun.which("node");
  if (node === null) throw new Error("No node on PATH: this file runs the codec under Node, the production runtime");
  const child = spawnSync(node, [`--max-old-space-size=${HEAP_LIMIT_MIB}`, at("child.js")], {
    cwd: dir,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  if (child.error !== undefined) throw new Error(`The child did not finish: ${child.error.message}`);
  if (child.status !== 0) {
    throw new Error(`The child exited ${child.status} (${child.signal}): ${child.stderr.trim().split("\n")[0]}`);
  }
  const reports = JSON.parse(child.stdout.trim()) as CaseReport[];
  const kind = `a value nested deeper than ${MAX_VALUE_DEPTH} arrays and objects`;
  expect(reports.map(({ name, verb }) => `${verb} ${name}`)).toEqual([
    "encode objects",
    "decode objects",
    "encode arrays",
    "decode arrays",
    "encode a cycle",
    "decode a cycle",
  ]);
  for (const report of reports) {
    const label = `${report.verb} ${report.name}`;
    expect(report.error, label).toBe("ValueCodecError");
    expect(report.message, label).toStartWith(`The value codec cannot ${report.verb} ${kind}, at "`);
    expect(report.segments, label).toBe(MAX_VALUE_DEPTH);
  }
}, 60_000);
