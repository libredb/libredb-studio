/**
 * What one answer costs the heap on the runtime production runs (design 3.12; HASIM-D-2): an answer under the 16 MiB
 * cap made of the smallest values JSON has is refused or cut without the heap growing past a bound that a parse of it
 * would need many times over.
 *
 * Each case runs in a Node child, as production runs Studio, with the old space limited to `HEAP_LIMIT_MIB` and
 * `--expose-gc`. The child runs a bundle that Bun.build({ target: "node" }) makes of the real transport, connection
 * options and latch around the text of `runCase`, as tests/unit/db/http/node-transport-runtimes.test.ts runs its
 * cases, and serves one statement from a local `node:http` server: its answer is 16 MiB of `[]` rows, of `[null]` rows
 * under a one-column schema, or a JSON refusal of 16 MiB of `[]` or `""`. The body is built in a Buffer, outside the
 * heap, so the heap holds only what the transport makes of it: the text it reads, and what reading that text costs.
 * Measured on Node 24 by the smallest old space each case finishes in: before this bound, about 436, 309, 833 and 694
 * MiB, three of them past the production limit of 384 MiB, where Node ends; with it, about 11 MiB each. A child that
 * outgrows the limit here ends the same way and fails its case.
 *
 * One more case follows a statement's pages to its 16 MiB budget of answer text, each page holding 60,000 different
 * warnings and no row: past the first 100 a warning is counted, never kept (F4), so the warnings a statement keeps do
 * not grow with the pages it reads.
 *
 * The child is the node on PATH, so CI's Node 24 runs it; NODE_TRANSPORT_NODES, split on the path delimiter, names
 * other binaries, as it does for the runtimes test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { getHeapStatistics } from "node:v8";
import type { createAuthLatch } from "@/lib/db/providers/sql/databend/auth-latch";
import type { buildDatabendConnectionOptions } from "@/lib/db/providers/sql/databend/connection-options";
import { DATABEND_ERROR_SENTENCES as S, DATABEND_PROTOCOL_FAULTS as F } from "@/lib/db/providers/sql/databend/errors";
import type { createDatabendHttpTransport } from "@/lib/db/providers/sql/databend/http-transport";

/** The old space each child may use: about six times what the cases need, and a fifth of what a parse of them needed. */
const HEAP_LIMIT_MIB = 64;
/** What the heap may still hold after a case, past what it held before, once collected. */
const RETAINED_LIMIT_MIB = 4;

interface ChildDeps {
  readonly createDatabendHttpTransport: typeof createDatabendHttpTransport;
  readonly buildDatabendConnectionOptions: typeof buildDatabendConnectionOptions;
  readonly createAuthLatch: typeof createAuthLatch;
  readonly createServer: typeof createServer;
  readonly getHeapStatistics: typeof getHeapStatistics;
}

interface ChildReport {
  readonly shape: string;
  readonly category: string | null;
  readonly message: string;
  readonly bodyBytes: number;
  readonly requests: readonly string[];
  /** The server warnings the outcome kept, and the count of those it left out. */
  readonly kept: number;
  readonly leftOut: number;
  readonly usedBeforeMiB: number;
  readonly usedAfterMiB: number;
}

/**
 * Runs in the child, from its text, so it names nothing outside itself: one statement through the real transport,
 * answered with the 16 MiB body `shape` names, and the heap before and after it.
 */
async function runCase(deps: ChildDeps, shape: string): Promise<ChildReport> {
  const cap = 16 * 1024 * 1024;
  const mib = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  // A JSON array of `item` between `prefix` and `suffix`, as long as fits the cap, written into a Buffer.
  const filled = (prefix: string, item: string, suffix: string): Buffer => {
    const count = Math.floor((cap - prefix.length - suffix.length + 1) / (item.length + 1));
    const repeated = (count - 1) * (item.length + 1);
    const buffer = Buffer.allocUnsafe(prefix.length + repeated + item.length + suffix.length);
    buffer.write(prefix, 0, "latin1");
    buffer.fill(`${item},`, prefix.length, prefix.length + repeated, "latin1");
    buffer.write(`${item}${suffix}`, prefix.length + repeated, "latin1");
    return buffer;
  };
  const page = (schema: string, row: string) =>
    filled(`{"id":"q","session_id":"s","node_id":"n","state":"Running","schema":${schema},"data":[`, row, "]}");
  // Page `n` of different warnings and no row, linking the next page; within one answer's allowance of values. It is
  // the statement's own, as every later page must be.
  const warningsPage = (queryId: string, sessionId: string, n: number): Buffer => {
    const count = 60_000;
    const head = `{"id":"${queryId}","session_id":"${sessionId}","node_id":"n","state":"Running","schema":[],"data":[],"warnings":[`;
    const tail = `],"next_uri":"/v1/query/${queryId}/page/${n + 1}"}`;
    const prefix = `"p${String(n).padStart(4, "0")}w`;
    const buffer = Buffer.allocUnsafe(head.length + count * 14 - 1 + tail.length);
    let at = buffer.write(head, 0, "latin1");
    for (let index = 0; index < count; index++) {
      at += buffer.write(`${index === 0 ? "" : ","}${prefix}${String(index).padStart(5, "0")}"`, at, "latin1");
    }
    buffer.write(tail, at, "latin1");
    return buffer;
  };
  const cases: Record<
    string,
    { readonly where: "post" | "page" | "pages"; readonly status: number; readonly body: Buffer }
  > = {
    "page-empty-rows": { where: "page", status: 200, body: page("[]", "[]") },
    "page-null-rows": { where: "page", status: 200, body: page('[{"name":"c","type":"NULL"}]', "[null]") },
    "refusal-arrays": { where: "post", status: 500, body: filled("[", "[]", "]") },
    "refusal-strings": { where: "post", status: 500, body: filled("[", '""', "]") },
    "pages-of-warnings": { where: "pages", status: 200, body: Buffer.alloc(0) },
  };
  const { where, status, body } = cases[shape];
  const requests: string[] = [];
  const server = deps.createServer((request, response) => {
    const url = String(request.url);
    requests.push(`${request.method} ${url.replace(/[0-9a-f]{32}/, "<id>")}`);
    request.resume();
    const json = { "content-type": "application/json" };
    // The session every request of the statement carries, which its answers echo.
    const header = Buffer.from(String(request.headers["x-databend-session"]), "base64url").toString("utf8");
    const sessionId = (JSON.parse(header) as { id: string }).id;
    if (request.method === "POST" && where === "post") {
      response.writeHead(status, json);
      response.end(body);
    } else if (request.method === "POST") {
      // The first answer, for the statement's own ids: running, and pointing at its first page.
      const queryId = String(request.headers["x-databend-query-id"]);
      response.writeHead(200, json);
      response.end(
        JSON.stringify({
          id: queryId,
          session_id: sessionId,
          node_id: "n",
          state: "Running",
          schema: [],
          data: [],
          next_uri: `/v1/query/${queryId}/page/0`,
        }),
      );
    } else if (where === "pages" && url.includes("/page/")) {
      const [, , , queryId, , n] = url.split("/");
      response.writeHead(200, json);
      response.end(warningsPage(queryId, sessionId, Number(n)));
    } else if (url.endsWith("/page/0")) {
      response.writeHead(status, json);
      response.end(body);
    } else {
      response.writeHead(200);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const connection = {
    id: "heap",
    name: "Databend",
    type: "databend",
    host: "127.0.0.1",
    port,
    user: "reader",
    password: "stand-in-1",
    createdAt: new Date(0),
  } as unknown as Parameters<typeof deps.buildDatabendConnectionOptions>[0];
  // The allowing decision written out: this function runs in a bundled child that cannot import the test helpers.
  const options = deps.buildDatabendConnectionOptions(connection, {
    queryTimeout: 60_000,
    appVersion: "1.2.3",
    egress: { blocksPrivateHosts: false, source: "set" },
  });
  const transport = deps.createDatabendHttpTransport(options, { latch: deps.createAuthLatch({ now: Date.now }) });
  const collect = (globalThis as { gc?: () => void }).gc as () => void;
  collect();
  const before = deps.getHeapStatistics().used_heap_size;
  let category: string | null = null;
  let message = "";
  let kept = 0;
  let leftOut = 0;
  try {
    const outcome = await transport.run({
      sql: "SELECT 1",
      origin: "user",
      rowCut: 100_000,
      signal: new AbortController().signal,
    });
    for (const notice of outcome.notices) {
      if (notice.kind === "server-warning") kept += 1;
      else if (notice.kind === "warnings-left-out") leftOut = notice.count;
    }
  } catch (error) {
    category = (error as { category?: string }).category ?? "thrown";
    message = (error as Error).message;
  }
  collect();
  const after = deps.getHeapStatistics().used_heap_size;
  await transport.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return {
    shape,
    category,
    message,
    bodyBytes: body.length,
    requests,
    kept,
    leftOut,
    usedBeforeMiB: mib(before),
    usedAfterMiB: mib(after),
  };
}

const dir = mkdtempSync(join(tmpdir(), "databend-wire-heap-"));
const at = (file: string) => join(dir, file);
const DATABEND_SOURCES = join(import.meta.dir, "../../../../src/lib/db/providers/sql/databend");

beforeAll(async () => {
  // Node loads neither TypeScript with `@/` imports nor this file, which is a bun:test file, so the child is a bundle.
  writeFileSync(
    at("child.ts"),
    [
      'import { createServer } from "node:http";',
      'import { getHeapStatistics } from "node:v8";',
      `import { createAuthLatch } from ${JSON.stringify(join(DATABEND_SOURCES, "auth-latch.ts"))};`,
      `import { buildDatabendConnectionOptions } from ${JSON.stringify(join(DATABEND_SOURCES, "connection-options.ts"))};`,
      `import { createDatabendHttpTransport } from ${JSON.stringify(join(DATABEND_SOURCES, "http-transport.ts"))};`,
      `const runCase = ${runCase.toString()};`,
      "const deps = { createDatabendHttpTransport, buildDatabendConnectionOptions, createAuthLatch, createServer, getHeapStatistics };",
      "const report = await runCase(deps, process.argv[2]);",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The Node binaries NODE_TRANSPORT_NODES lists, or the node on PATH; no node fails by name. */
function nodeBinaries(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  if (listed !== undefined) return listed.split(delimiter).filter((entry) => entry !== "");
  const onPath = Bun.which("node");
  if (onPath === null) {
    throw new Error("No node on PATH: this file measures the heap under Node, the production runtime; install Node 24");
  }
  return [onPath];
}

async function runChild(binary: string, shape: string): Promise<ChildReport> {
  const child = Bun.spawn([binary, `--max-old-space-size=${HEAP_LIMIT_MIB}`, "--expose-gc", at("child.js"), shape], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Past its old space Node ends with "JavaScript heap out of memory" and a non-zero exit.
  if (exitCode !== 0) {
    const fatal = stderr.split("\n").find((line) => line.includes("FATAL")) ?? stderr.trim().split("\n")[0];
    throw new Error(`The ${shape} child exited ${exitCode}: ${fatal}`);
  }
  return JSON.parse(stdout.trim().split("\n").at(-1) as string) as ChildReport;
}

/** The first 300 characters of a refusal body that opens `[` and repeats `item,`, as the server sentence cuts it. */
const refusalText = (item: string) => `${`[${`${item},`.repeat(300)}`.slice(0, 300)}...`;

const CASES: ReadonlyArray<readonly [string, string, string, readonly string[]]> = [
  [
    "page-empty-rows",
    "protocol",
    S.protocol(F.rows),
    ["POST /v1/query", "GET /v1/query/<id>/page/0", "GET /v1/query/<id>/kill"],
  ],
  [
    "page-null-rows",
    "protocol",
    S.protocol(F.rows),
    ["POST /v1/query", "GET /v1/query/<id>/page/0", "GET /v1/query/<id>/kill"],
  ],
  ["refusal-arrays", "server", S.server(500, refusalText("[]")), ["POST /v1/query", "GET /v1/query/<id>/kill"]],
  ["refusal-strings", "server", S.server(500, refusalText('""')), ["POST /v1/query", "GET /v1/query/<id>/kill"]],
];

for (const binary of nodeBinaries()) {
  describe(`one answer of 16 MiB under --max-old-space-size=${HEAP_LIMIT_MIB}, in a Node child (${binary})`, () => {
    test.each(CASES)(
      "%s is %s, read without the heap growing past the limit, and nothing is retained",
      async (shape, category, message, requests) => {
        const report = await runChild(binary, shape);
        console.log(
          `databend wire heap: ${shape} under ${HEAP_LIMIT_MIB} MiB, used ${report.usedBeforeMiB} MiB before and ${report.usedAfterMiB} MiB after`,
        );
        expect(report.bodyBytes).toBeGreaterThan(16 * 1024 * 1024 - 8);
        expect(report.category).toBe(category);
        expect(report.message).toBe(message);
        expect(report.requests).toEqual([...requests]);
        expect(report.usedAfterMiB - report.usedBeforeMiB).toBeLessThan(RETAINED_LIMIT_MIB);
      },
      60_000,
    );

    test("a statement's pages of different warnings, to its 16 MiB budget, keep 100 of them and count the rest", async () => {
      const report = await runChild(binary, "pages-of-warnings");
      const pages = report.requests.filter((request) => request.startsWith("GET /v1/query/<id>/page/")).length;
      console.log(
        `databend wire heap: pages-of-warnings under ${HEAP_LIMIT_MIB} MiB, ${pages} pages, used ${report.usedBeforeMiB} MiB before and ${report.usedAfterMiB} MiB after`,
      );
      expect(report.category).toBeNull();
      // The 16 MiB budget of answer text ends the statement, after about 20 pages of 60,000 warnings.
      expect(pages).toBeGreaterThan(16);
      expect(report.requests).toEqual([
        "POST /v1/query",
        ...Array.from({ length: pages }, (_, n) => `GET /v1/query/<id>/page/${n}`),
        "GET /v1/query/<id>/final",
      ]);
      expect(report.kept).toBe(100);
      expect(report.leftOut).toBe(pages * 60_000 - 100);
      expect(report.usedAfterMiB - report.usedBeforeMiB).toBeLessThan(RETAINED_LIMIT_MIB);
    }, 60_000);
  });
}
