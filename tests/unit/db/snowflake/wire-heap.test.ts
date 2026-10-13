/**
 * What a large or hostile result costs on the runtime production runs: a decompression bomb and a legitimate 76 MB
 * result are each cut at the 16 MiB budget with its warning, without the heap outgrowing a stated old-space limit, and
 * the 76 MB result without stalling the event loop.
 *
 * Each case runs in a Node child, as production runs Studio, with `--expose-gc` and, for the two heap cases, the old
 * space limited to `HEAP_LIMIT_MIB`. The child runs a bundle that Bun.build({ target: "node" }) makes of the real transport, statements
 * and row reader around the text of `runCase`, as tests/unit/db/databend/wire-heap.test.ts runs Databend's, and serves
 * one statement from a local `node:http` server: the asynchronous submit, a status answer naming its partitions with
 * partition 0 inline, and partitions 1 to n as gzip bodies. Both bodies are BUILT, since no account is asked for
 * either: the 1 GiB bomb (`gzipRowsBomb`, about 2 MB compressed, made once in the parent and read from a file) as
 * partition 1, and 76 MB of rows as partitions 1 to 5, built in Buffers outside the heap, so the heap holds only what
 * the reader makes of them. A child that outgrows the limit ends with "JavaScript heap out of memory" and fails its
 * case.
 *
 * The child's longest event-loop delay during the statement is read with `perf_hooks.monitorEventLoopDelay`; 50 ms
 * leaves room for a loaded runner above the 0.2 to 9 ms measured for streaming reads of this size. It is read in a
 * child with Node's default old space, not the limited one: at the limit the 76 MB read runs at the heap's edge, and
 * V8's full collections, 40 to 90 per read and up to 26 ms each on a loaded 20-core machine (measured 2026-10-13 with
 * --trace-gc), stall the loop for reasons that are not the reader's. The stall is asserted on Linux only: CI's
 * macos-latest runner measured 51.7 ms at the limit and 82.1 ms with the default old space (runs 38329987927 and
 * 38332056658, 2026-10-13), where Linux CI and that loaded machine measured 0.2 to 26 ms, and the reader is the same
 * JavaScript on every platform.
 *
 * The child is the node on PATH, so CI's Node 24 runs it; NODE_TRANSPORT_NODES, split on the path delimiter, names
 * other binaries, as it does for the runtimes test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { readFileSync } from "node:fs";
import type { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { monitorEventLoopDelay } from "node:perf_hooks";
import type { getHeapStatistics } from "node:v8";
import type { gzipSync } from "node:zlib";
import type { httpOrigin } from "@/lib/db/http/endpoint";
import type { patTokenSource } from "@/lib/db/providers/sql/snowflake/auth";
import { SNOWFLAKE_ROWS_SENTENCES } from "@/lib/db/providers/sql/snowflake/rows";
import type { createSnowflakeStatements } from "@/lib/db/providers/sql/snowflake/statements";
import type { createSnowflakeTransport, snowflakeProductionDeps } from "@/lib/db/providers/sql/snowflake/transport";
import { gzipRowsBomb } from "../../../helpers/snowflake-node-transport";

/** The old space each child may use, Databend's bound: a few times what the 16 MiB budget's rows need. */
const HEAP_LIMIT_MIB = 64;
/** The longest event-loop delay the 76 MB result may cause. */
const STALL_LIMIT_MS = 50;

interface ChildDeps {
  readonly createSnowflakeTransport: typeof createSnowflakeTransport;
  readonly createSnowflakeStatements: typeof createSnowflakeStatements;
  readonly snowflakeProductionDeps: typeof snowflakeProductionDeps;
  readonly patTokenSource: typeof patTokenSource;
  readonly httpOrigin: typeof httpOrigin;
  readonly createServer: typeof createServer;
  readonly monitorEventLoopDelay: typeof monitorEventLoopDelay;
  readonly getHeapStatistics: typeof getHeapStatistics;
  readonly gzipSync: typeof gzipSync;
  readonly readFileSync: typeof readFileSync;
}

interface ChildReport {
  readonly shape: string;
  readonly error: string | null;
  readonly rows: number;
  readonly cut: boolean;
  readonly warnings: readonly string[];
  readonly requests: readonly string[];
  readonly bodyBytes: number;
  readonly longestDelayMs: number;
  readonly peakUsedMiB: number;
}

/**
 * Runs in the child, from its text, so it names nothing outside itself: one statement through the real transport and
 * statements, its partitions answered with the bodies `shape` names, and the heap and event-loop delay meanwhile.
 */
async function runCase(deps: ChildDeps, shape: string, bombFile: string): Promise<ChildReport> {
  const mib = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  const handle = "019c06a4-0000-df4f-0000-00100006589e";
  const status = `/api/v2/statements/${handle}`;
  // 76 MB of two-cell rows, written into Buffers and gzipped once, five partitions of about 15.2 MB decoded each.
  const partitionOf = (index: number): Buffer => {
    const row = (n: number) => `["${n}","${"abcdefghij".repeat(20)}${String(n).padStart(10, "0")}"]`;
    const count = 68_000;
    const sample = row(index * count);
    const buffer = Buffer.allocUnsafe(10 + count * (sample.length + 8));
    let at = buffer.write('{"data":[', 0, "latin1");
    for (let n = 0; n < count; n++) at += buffer.write(`${n === 0 ? "" : ","}${row(index * count + n)}`, at, "latin1");
    at += buffer.write("]}", at, "latin1");
    return deps.gzipSync(buffer.subarray(0, at), { level: 1 });
  };
  const cases: Record<string, { readonly columns: number; readonly partitions: Buffer[] }> = {
    bomb: { columns: 1, partitions: [deps.readFileSync(bombFile)] },
    large: { columns: 2, partitions: [1, 2, 3, 4, 5].map(partitionOf) },
  };
  const { columns, partitions } = cases[shape];
  const bodyBytes = partitions.reduce((sum, body) => sum + body.length, 0);
  const rowType = Array.from({ length: columns }, (_, index) => ({
    name: `C${index}`,
    type: "text",
    length: 16777216,
    precision: null,
    scale: null,
    nullable: true,
  }));
  const requests: string[] = [];
  const server = deps.createServer((request, response) => {
    const url = new URL(String(request.url), "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.searchParams.has("partition") ? url.search : ""}`);
    request.resume();
    const json = (code: number, body: unknown) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "POST" && url.pathname === "/api/v2/statements") {
      json(202, { code: "333334", statementHandle: handle, statementStatusUrl: status });
    } else if (url.searchParams.has("partition")) {
      const body = partitions[Number(url.searchParams.get("partition")) - 1];
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(body);
    } else if (request.method === "GET") {
      json(200, {
        code: "090001",
        statementHandle: handle,
        statementStatusUrl: status,
        resultSetMetaData: {
          numRows: 400_000,
          format: "jsonv2",
          rowType,
          partitionInfo: Array.from({ length: partitions.length + 1 }, () => ({ rowCount: 0, uncompressedSize: 0 })),
        },
        data: [],
      });
    } else json(200, { code: "000604" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const production = deps.snowflakeProductionDeps();
  const origin = deps.httpOrigin("http", "127.0.0.1", port);
  const transport = deps.createSnowflakeTransport(
    { origin, tls: null, tokens: deps.patTokenSource("stand-in-pat") },
    production,
  );
  const statements = deps.createSnowflakeStatements({
    transport,
    origin,
    context: { role: "STUDIO_RO", warehouse: "STUDIO_WH" },
    queryTimeoutMs: 60_000,
    failure: {
      host: "127.0.0.1",
      user: "studio_svc",
      role: "STUDIO_RO",
      authMethod: "pat",
      accountClaim: "TEST",
      userClaim: "STUDIO_SVC",
      fingerprint: null,
      fingerprintHex8: null,
      publicKeyBody: null,
    },
    secrets: () => ["stand-in-pat"],
    deps: production,
  });
  (globalThis as { gc?: () => void }).gc?.();
  let peak = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, deps.getHeapStatistics().used_heap_size);
  }, 5);
  const delay = deps.monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  let error: string | null = null;
  let rows = 0;
  let cut = false;
  let warnings: string[] = [];
  try {
    const result = await statements.runUser("SHOW TABLES", undefined);
    rows = result.rows.length;
    cut = result.cut;
    warnings = result.warnings.map((warning) => warning.message);
  } catch (caught) {
    error = (caught as Error).message;
  }
  delay.disable();
  clearInterval(sampler);
  peak = Math.max(peak, deps.getHeapStatistics().used_heap_size);
  await statements.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return {
    shape,
    error,
    rows,
    cut,
    warnings,
    requests,
    bodyBytes,
    longestDelayMs: Math.round(delay.max / 1e5) / 10,
    peakUsedMiB: mib(peak),
  };
}

const dir = mkdtempSync(join(tmpdir(), "snowflake-wire-heap-"));
const at = (file: string) => join(dir, file);
const SOURCES = join(import.meta.dir, "../../../../src/lib/db");

beforeAll(async () => {
  writeFileSync(at("bomb.gz"), await gzipRowsBomb(1024 ** 3));
  // Node loads neither TypeScript with `@/` imports nor this file, which is a bun:test file, so the child is a bundle.
  writeFileSync(
    at("child.ts"),
    [
      'import { readFileSync } from "node:fs";',
      'import { createServer } from "node:http";',
      'import { monitorEventLoopDelay } from "node:perf_hooks";',
      'import { getHeapStatistics } from "node:v8";',
      'import { gzipSync } from "node:zlib";',
      `import { httpOrigin } from ${JSON.stringify(join(SOURCES, "http/endpoint.ts"))};`,
      `import { patTokenSource } from ${JSON.stringify(join(SOURCES, "providers/sql/snowflake/auth.ts"))};`,
      `import { createSnowflakeStatements } from ${JSON.stringify(join(SOURCES, "providers/sql/snowflake/statements.ts"))};`,
      `import { createSnowflakeTransport, snowflakeProductionDeps } from ${JSON.stringify(join(SOURCES, "providers/sql/snowflake/transport.ts"))};`,
      `const runCase = ${runCase.toString()};`,
      "const deps = { createSnowflakeTransport, createSnowflakeStatements, snowflakeProductionDeps, patTokenSource, httpOrigin, createServer, monitorEventLoopDelay, getHeapStatistics, gzipSync, readFileSync };",
      "const report = await runCase(deps, process.argv[2], process.argv[3]);",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
}, 120_000);

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

/** Runs one case in a Node child, with its old space limited to `heapLimitMiB` when one is given. */
async function runChild(binary: string, shape: string, heapLimitMiB?: number): Promise<ChildReport> {
  const limit = heapLimitMiB === undefined ? [] : [`--max-old-space-size=${heapLimitMiB}`];
  const child = Bun.spawn([binary, ...limit, "--expose-gc", at("child.js"), shape, at("bomb.gz")], {
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

for (const binary of nodeBinaries()) {
  describe(`a result past the budget under --max-old-space-size=${HEAP_LIMIT_MIB}, in a Node child (${binary})`, () => {
    test("a 1 GiB bomb as partition 1 is cut at 16 MiB with its warning", async () => {
      const report = await runChild(binary, "bomb", HEAP_LIMIT_MIB);
      console.log(
        `snowflake wire heap: bomb, ${report.bodyBytes} compressed bytes, ${report.rows} rows, peak ${report.peakUsedMiB} MiB`,
      );
      expect(report.error).toBeNull();
      expect(report.cut).toBe(true);
      expect(report.warnings).toEqual([SNOWFLAKE_ROWS_SENTENCES.byteCut(400_000)]);
      expect(report.rows).toBeGreaterThan(16_000);
      expect(report.requests).toEqual([
        "POST /api/v2/statements",
        "GET /api/v2/statements/019c06a4-0000-df4f-0000-00100006589e",
        "GET /api/v2/statements/019c06a4-0000-df4f-0000-00100006589e?partition=1",
      ]);
    }, 120_000);

    test("76 MB in partitions 1 to 5 is cut at 16 MiB with its warning", async () => {
      const report = await runChild(binary, "large", HEAP_LIMIT_MIB);
      console.log(`snowflake wire heap: 76 MB, ${report.rows} rows, peak ${report.peakUsedMiB} MiB`);
      expect(report.error).toBeNull();
      expect(report.cut).toBe(true);
      expect(report.warnings).toEqual([SNOWFLAKE_ROWS_SENTENCES.byteCut(400_000)]);
      expect(report.requests.filter((request) => request.includes("?partition="))).toEqual([
        "GET /api/v2/statements/019c06a4-0000-df4f-0000-00100006589e?partition=1",
        "GET /api/v2/statements/019c06a4-0000-df4f-0000-00100006589e?partition=2",
      ]);
    }, 120_000);
  });

  describe(`a result past the budget with the default old space, in a Node child (${binary})`, () => {
    test.skipIf(process.platform !== "linux")(
      "76 MB in partitions 1 to 5 never stalls the event loop 50 ms",
      async () => {
        const report = await runChild(binary, "large");
        console.log(
          `snowflake wire heap: 76 MB, default old space, longest event-loop delay ${report.longestDelayMs} ms`,
        );
        expect(report.error).toBeNull();
        expect(report.cut).toBe(true);
        expect(report.longestDelayMs).toBeLessThan(STALL_LIMIT_MS);
      },
      120_000,
    );
  });
}
