/**
 * R-S11's memory bound: inbound frames, headers and bodies are bounded before allocation, and what a read discards
 * costs no memory. Each read runs in a fresh child, one per read and runtime (Bun, and every Node binary in
 * NODE_TRANSPORT_NODES or the node on PATH), serialised; the child samples process.memoryUsage().rss every millisecond
 * of free event loop. The baseline is the RSS once the fake broker listens in the same child and one empty read has
 * completed.
 *
 * The reads: 30 bodies of 300 KiB and 30 bodies of 2 MiB (about 9 and 60 MiB on the wire, 7.5 MiB kept each) return 30
 * rows with no wire or budget stop and peak within ALLOWANCE_BYTES of each other; 40 bodies of 1 MiB stop at the budget
 * after exactly the row count computed from the first row's retained header bytes; one 300 MiB header frame ends at
 * the 64 MiB wire cap with no offset. The last two peak under the baseline plus 3 times the 8 MiB budget plus
 * ALLOWANCE_BYTES.
 *
 * ALLOWANCE_BYTES was fixed from the product parser on 2026-10-12, three runs each on Bun 1.4.2, Node 24.14.0 and Node
 * 26.10.0 (growth above the baseline in MB, the fake broker's own buffers included): 300 KiB bodies 15.9 to 19.3, 2 MiB
 * bodies 25.4 to 40.9, the budget read 22.8 to 31.2, the 300 MiB header frame 13.4 to 54.0. The two body reads were at
 * most 22.5 MB apart, and the header frame needs at least 28.8 MB above three budgets, so 48 MB holds both with margin
 * and stays under the 64 MB ceiling. The file takes about 19 s with two Node binaries.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { RABBITMQ_BODY_PREFIX_BYTES, RABBITMQ_RESULT_BUDGET_BYTES } from "@/lib/db/providers/stream/rabbitmq/limits";

const ALLOWANCE_BYTES = 48 * 1_000_000;
const HELPER = join(import.meta.dir, "..", "..", "..", "helpers", "rabbitmq-fake-peer.ts");
const READ_LOOP = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "src",
  "lib",
  "db",
  "providers",
  "stream",
  "rabbitmq",
  "amqp",
  "read-loop.ts",
);
const CASES = ["bodies-300k", "bodies-2m", "budget-1m", "header-300m"] as const;
type CaseName = (typeof CASES)[number];

interface Measured {
  readonly runtime: string;
  readonly baseline: number;
  readonly peak: number;
  readonly rows: number;
  /** The first row's retained header bytes; null with no row. */
  readonly retained: number | null;
  readonly stop: string;
  readonly offset: string | null;
}

/** One read in this child. SELF-CONTAINED ON PURPOSE: the child runs this function's own text. */
async function measure(
  name: string,
  h: typeof import("../../../helpers/rabbitmq-fake-peer"),
  read: typeof import("@/lib/db/providers/stream/rabbitmq/amqp/read-loop").readStream,
  dial: typeof import("@/lib/db/providers/stream/rabbitmq/amqp/dial").dialAmqp,
  clock: typeof import("@/lib/db/providers/stream/rabbitmq/limits").SYSTEM_CLOCK,
): Promise<Measured> {
  const MIB = 1024 * 1024;
  const one = (body: Uint8Array) => h.message({ deliveryTag: BigInt(1), offset: BigInt(0), body });
  const scripts: Record<string, readonly import("../../../helpers/rabbitmq-fake-peer").PeerStep[]> = {
    empty: [...h.handshakeSteps(), ...h.closeSteps],
    "bodies-300k": [...h.handshakeSteps(), { repeat: one(new Uint8Array(300 * 1024)), times: 30 }, ...h.closeSteps],
    "bodies-2m": [...h.handshakeSteps(), { repeat: one(new Uint8Array(2 * MIB)), times: 30 }, ...h.closeSteps],
    "budget-1m": [...h.handshakeSteps(), { repeat: one(new Uint8Array(MIB)), times: 40 }, ...h.closeSteps],
    "header-300m": [
      ...h.handshakeSteps(),
      {
        send: h.bytesOf(
          h.serverFrames.deliver({ deliveryTag: BigInt(1) }),
          2,
          h.u16(1),
          h.u32(300 * MIB),
          h.u16(60),
          h.u16(0),
          h.u64(BigInt(0)),
          h.u16(1 << 13),
          h.u32(300 * MIB - 18),
          3,
          "big",
          "x",
          h.u32(300 * MIB - 27),
        ),
      },
      { repeat: new Uint8Array(65_536), times: 4_800 },
    ],
  };
  const run = async (script: string) => {
    const peer = await h.startFakePeer(scripts[script] ?? []);
    try {
      return await read({
        endpoint: { host: "127.0.0.1", port: peer.port, tls: null, username: "u", password: "p", display: "local" },
        vhost: "/",
        stream: "st",
        from: { kind: "keyword", value: "first" },
        limit: 500,
        signal: AbortSignal.timeout(30_000),
        deadlineSeconds: 30,
        replicas: { online: [], members: [] },
        dial,
        clock,
        studioVersion: null,
      });
    } finally {
      await peer.stop();
    }
  };
  await run("empty");
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 1);
  const outcome = await run(name);
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  const stop = outcome.stop as { kind: string; offset?: bigint | null };
  return {
    runtime: typeof Bun === "undefined" ? process.version : `bun ${Bun.version}`,
    baseline,
    peak,
    rows: outcome.messages.length,
    retained: outcome.messages[0]?.retainedHeaderBytes ?? null,
    stop: stop.kind,
    offset: stop.offset === undefined || stop.offset === null ? null : String(stop.offset),
  };
}

function runtimes(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  const nodes = listed === undefined ? [Bun.which("node")] : listed.split(delimiter).filter((entry) => entry !== "");
  if (nodes.length === 0 || nodes.includes(null))
    throw new Error("No Node binary: set NODE_TRANSPORT_NODES or put Node 24 or later on PATH");
  return [process.execPath, ...(nodes as string[])];
}

const results = new Map<string, Record<CaseName, Measured>>();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "rabbitmq-memory-"));
  try {
    writeFileSync(
      join(dir, "child.ts"),
      [
        `import * as h from ${JSON.stringify(HELPER)};`,
        `import { readStream } from ${JSON.stringify(READ_LOOP)};`,
        `import { dialAmqp } from ${JSON.stringify(join(READ_LOOP, "..", "dial.ts"))};`,
        `import { SYSTEM_CLOCK } from ${JSON.stringify(join(READ_LOOP, "..", "..", "limits.ts"))};`,
        `const measure = ${measure.toString()};`,
        "const result = await measure(process.argv[2], h, readStream, dialAmqp, SYSTEM_CLOCK);",
        'process.stdout.write(JSON.stringify(result) + "\\n");',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const build = await Bun.build({ entrypoints: [join(dir, "child.ts")], target: "node", format: "esm", outdir: dir });
    if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
    for (const binary of runtimes()) {
      const measured = {} as Record<CaseName, Measured>;
      for (const name of CASES) {
        const child = Bun.spawn([binary, join(dir, "child.js"), name], { stdout: "pipe", stderr: "pipe" });
        // oxlint-disable-next-line no-await-in-loop -- the children run in turn, so no two reads share the machine.
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exitCode !== 0) throw new Error(`The child ${binary} ${name} exited ${exitCode}: ${stderr}`);
        measured[name] = JSON.parse(stdout.trim().split("\n").at(-1) as string) as Measured;
      }
      results.set(binary, measured);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

const growth = (m: Measured) => m.peak - m.baseline;

describe("R-S11: memory does not grow with the bytes a read discards", () => {
  test("the outcomes", () => {
    for (const measured of results.values()) {
      expect({ rows: measured["bodies-300k"].rows, stop: measured["bodies-300k"].stop }).toEqual({
        rows: 30,
        stop: "idle",
      });
      expect({ rows: measured["bodies-2m"].rows, stop: measured["bodies-2m"].stop }).toEqual({
        rows: 30,
        stop: "idle",
      });
      expect(measured["budget-1m"].stop).toBe("budget");
      // Every 1 MiB row costs its retained header bytes plus the body prefix, so the budget holds exactly `fit` rows.
      const retained = measured["budget-1m"].retained;
      expect(retained).toBeGreaterThan(0);
      const fit = Math.floor(RABBITMQ_RESULT_BUDGET_BYTES / ((retained as number) + RABBITMQ_BODY_PREFIX_BYTES));
      expect(measured["budget-1m"].rows).toBe(fit);
      expect({ stop: measured["header-300m"].stop, offset: measured["header-300m"].offset }).toEqual({
        stop: "wire-oversize",
        offset: null,
      });
    }
  });

  test("the 300 KiB and the 2 MiB reads peak within the allowance of each other", () => {
    for (const [binary, measured] of results) {
      const apart = Math.abs(growth(measured["bodies-2m"]) - growth(measured["bodies-300k"]));
      expect({ binary, within: apart <= ALLOWANCE_BYTES, apart }).toMatchObject({ binary, within: true });
    }
  });

  test("the budget read and the 300 MiB header frame peak under the baseline, three budgets and the allowance", () => {
    const bound = 3 * RABBITMQ_RESULT_BUDGET_BYTES + ALLOWANCE_BYTES;
    for (const [binary, measured] of results) {
      for (const name of ["budget-1m", "header-300m"] as const) {
        expect({ binary, name, within: growth(measured[name]) <= bound, growth: growth(measured[name]) }).toMatchObject(
          {
            binary,
            name,
            within: true,
          },
        );
      }
    }
  });
});
