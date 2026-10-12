/**
 * What sixteen exchange details cost while their bindings answers are near the 16 MiB cap: each detail's destination
 * GET is held open while the sixteen source GETs of 16 MiB complete, so at most two answers are in transfer and parse
 * at once (the bindings limiter's process bound) and each held detail keeps at most 1 MiB of rows.
 *
 * Each case runs in a fresh child per runtime, Node (the production runtime) and Bun, from a bundle that
 * Bun.build({ target: "node" }) makes of the real management client, route table and detail reader around the text of
 * `runCase`, as tests/unit/db/databend/wire-heap.test.ts runs its cases. The child samples its RSS every millisecond
 * of free event loop; its baseline is the RSS after its in-memory management API is up and one detail has opened.
 * The answers are built in a Buffer and turned into a new string per response, as a socket's text would be.
 *
 * The child collects fully before its baseline and before serving each 16 MiB answer (Node with --expose-gc, Bun with
 * Bun.gc(true)), so the peak counts what the details hold and the answer in transfer, not garbage a lazy collector has
 * not reclaimed yet; without that, Bun's peak for the same run moved by 80 MiB between runs.
 *
 * The bound is baseline + 2 x 16 MiB x the multiplier + 18 x 1 MiB of kept rows + a fixed allowance of 64 MiB.
 * The multiplier was measured first. One 16 MiB bindings answer and its parse hold 1.27 to 1.92 times its bytes at
 * once (Node 24.14.0, Bun 1.4.2). With the collections, this run peaked 41 to 164 MiB above its baseline over twelve
 * runs (three per runtime and shape), at most 3.1 x 32 MiB with the allowance taken off, so the multiplier is 4 and the
 * bound 210 MiB, 46 MiB over the highest peak. With the kept-rows cap removed the same run peaked 267 to 406 MiB, at
 * least 57 MiB over the bound, so the bound tells a detail that holds whole answers from one that keeps 1 MiB.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const PARSE_MULTIPLIER = 4;
const KEPT_MIB = 1;
const ALLOWANCE_MIB = 64;
const BOUND_MIB = 2 * 16 * PARSE_MULTIPLIER + 18 * KEPT_MIB + ALLOWANCE_MIB;

const RABBITMQ_SOURCES = join(import.meta.dir, "../../../../src/lib/db/providers/stream/rabbitmq");

interface ChildDeps {
  readonly createManagementClient: typeof import("@/lib/db/providers/stream/rabbitmq/management/client").createManagementClient;
  readonly rabbitmqManagementLimiter: typeof import("@/lib/db/providers/stream/rabbitmq/management/client").rabbitmqManagementLimiter;
  readonly rabbitmqBindingsLimiter: typeof import("@/lib/db/providers/stream/rabbitmq/management/client").rabbitmqBindingsLimiter;
  readonly readSource: typeof import("@/lib/db/providers/stream/rabbitmq/source").readSource;
  readonly createTrackingProbe: typeof import("@/lib/db/providers/stream/rabbitmq/tracking-probe").createTrackingProbe;
  readonly RABBITMQ_OBJECT_KINDS: typeof import("@/lib/db/providers/stream/rabbitmq/objects").RABBITMQ_OBJECT_KINDS;
}

interface ChildReport {
  readonly runtime: string;
  readonly baselineMiB: number;
  readonly peakMiB: number;
  readonly sourcesServed: number;
  readonly destinationsStarted: number;
  readonly maxSourcesInFlight: number;
}

/**
 * The child's whole run, stringified into the bundle: it may use only `deps` and globals.
 * `shape` is "small" (many small rows) or "wide" (rows with 100 KB arguments).
 */
async function runCase(deps: ChildDeps, shape: string): Promise<ChildReport> {
  // A full collection before the baseline and before each 16 MiB answer is served, so the peak counts what the
  // details hold and the answers in transfer, not the garbage a lazy collector has not reclaimed yet.
  const collect = () => {
    if (typeof Bun !== "undefined") Bun.gc(true);
    else if (typeof (globalThis as { gc?: unknown }).gc === "function") (globalThis as { gc: () => void }).gc();
    else throw new Error("The child runs without --expose-gc");
  };
  const cap = 16 * 1024 * 1024 - 1024;
  const rows: string[] = [];
  let size = 2;
  for (let i = 0; ; i++) {
    const row = {
      source: "ex",
      vhost: "/",
      destination: `q-${i}`,
      destination_type: "queue",
      routing_key: shape === "small" ? `k.${i}` : "k",
      arguments: shape === "small" ? {} : { "x-big": "a".repeat(100_000) },
      properties_key: "k",
    };
    const text = JSON.stringify(row);
    if (size + text.length + 1 > cap) break;
    rows.push(text);
    size += text.length + 1;
  }
  const big = Buffer.from(`[${rows.join(",")}]`);
  rows.length = 0;
  const detail = JSON.stringify({
    type: "direct",
    durable: true,
    auto_delete: false,
    internal: false,
    arguments: {},
    policy: null,
  });

  let sourcesServed = 0;
  let sourcesInFlight = 0;
  let maxSourcesInFlight = 0;
  let destinationsStarted = 0;
  let small = true;
  const transport = () => ({
    async request(request: { url: string; signal: AbortSignal }) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/bindings/source")) {
        sourcesInFlight += 1;
        maxSourcesInFlight = Math.max(maxSourcesInFlight, sourcesInFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (!small) collect();
        const text = small ? "[]" : big.toString("utf8");
        sourcesInFlight -= 1;
        if (!small) sourcesServed += 1;
        return { status: 200, contentType: "application/json", retryAfter: null, text };
      }
      if (path.endsWith("/bindings/destination")) {
        if (small) return { status: 200, contentType: "application/json", retryAfter: null, text: "[]" };
        destinationsStarted += 1;
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
        });
      }
      return { status: 200, contentType: "application/json", retryAfter: null, text: detail };
    },
    close() {},
  });
  const lifetime = new AbortController();
  const client = deps.createManagementClient({
    endpoint: {
      origin: { scheme: "http", host: "127.0.0.1", port: 15672 },
      pathPrefix: "",
      tls: null,
      username: "u",
      password: ["p", "w"].join(""),
      display: "127.0.0.1:15672",
    },
    transport: transport as never,
    deadlineSignal: () => new AbortController().signal,
    queryTimeoutMs: 60_000,
    lifetime: lifetime.signal,
    limiters: { management: deps.rabbitmqManagementLimiter(), bindings: deps.rabbitmqBindingsLimiter() },
  });
  const readers = {
    client,
    tracking: deps.createTrackingProbe(client),
    capabilities: {
      containerLevels: [{ id: "schema", label: "Virtual host", labelPlural: "Virtual hosts" }],
      objectKinds: deps.RABBITMQ_OBJECT_KINDS,
    } as never,
    now: () => 0,
  };

  await deps.readSource(readers, ["/", "warm"], "exchange");
  small = false;
  collect();
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 1);

  const details = Array.from({ length: 16 }, (_, i) =>
    deps.readSource(readers, ["/", `ex-${i}`], "exchange").catch(() => undefined),
  );
  const served = () => sourcesServed;
  while (served() < 16) await new Promise((resolve) => setTimeout(resolve, 5));
  // Every source answer is decoded and held; the destination GETs wait for their permits or hang.
  await new Promise((resolve) => setTimeout(resolve, 100));
  peak = Math.max(peak, process.memoryUsage().rss);
  clearInterval(sampler);
  lifetime.abort(new Error("done"));
  await Promise.all(details);
  return {
    runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`,
    baselineMiB: baseline / 1024 / 1024,
    peakMiB: peak / 1024 / 1024,
    sourcesServed,
    destinationsStarted,
    maxSourcesInFlight,
  };
}

const dir = mkdtempSync(join(tmpdir(), "rabbitmq-management-memory-"));
const at = (name: string) => join(dir, name);

beforeAll(async () => {
  writeFileSync(
    at("child.ts"),
    [
      `import { createManagementClient, rabbitmqManagementLimiter, rabbitmqBindingsLimiter } from ${JSON.stringify(join(RABBITMQ_SOURCES, "management/client.ts"))};`,
      `import { readSource } from ${JSON.stringify(join(RABBITMQ_SOURCES, "source.ts"))};`,
      `import { createTrackingProbe } from ${JSON.stringify(join(RABBITMQ_SOURCES, "tracking-probe.ts"))};`,
      `import { RABBITMQ_OBJECT_KINDS } from ${JSON.stringify(join(RABBITMQ_SOURCES, "objects.ts"))};`,
      `const runCase = ${runCase.toString()};`,
      "const deps = { createManagementClient, rabbitmqManagementLimiter, rabbitmqBindingsLimiter, readSource, createTrackingProbe, RABBITMQ_OBJECT_KINDS };",
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

/** The Node binaries NODE_TRANSPORT_NODES lists, or the node on PATH, then this Bun. */
function runtimes(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  const nodes =
    listed !== undefined
      ? listed.split(delimiter).filter((entry) => entry !== "")
      : [Bun.which("node")].filter((n) => n !== null);
  if (nodes.length === 0)
    throw new Error("No node on PATH: this file measures memory under Node, the production runtime");
  return [...(nodes as string[]), process.execPath];
}

async function runChild(binary: string, shape: string): Promise<ChildReport> {
  const flags = binary === process.execPath ? [] : ["--expose-gc"];
  const child = Bun.spawn([binary, ...flags, at("child.js"), shape], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`The ${shape} child exited ${exitCode}: ${stderr.trim().split("\n")[0]}`);
  return JSON.parse(stdout.trim().split("\n").at(-1) as string) as ChildReport;
}

describe.serial("sixteen exchange details with 16 MiB bindings answers", () => {
  for (const binary of runtimes()) {
    for (const shape of ["small", "wide"]) {
      test(`${shape} rows, ${binary}: two answers in transfer at most, and RSS under baseline + ${BOUND_MIB} MiB`, async () => {
        const report = await runChild(binary, shape);
        expect(report.sourcesServed).toBe(16);
        expect(report.maxSourcesInFlight).toBeLessThanOrEqual(2);
        expect(report.destinationsStarted).toBeLessThanOrEqual(2);
        expect(report.peakMiB - report.baselineMiB).toBeLessThan(BOUND_MIB);
      }, 120_000);
    }
  }
});
