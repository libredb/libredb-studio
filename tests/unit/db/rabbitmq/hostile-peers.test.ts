/**
 * R-S10: every AMQP read runs under a Studio deadline and cannot crash the process. Each hostile peer, with a 2,000 ms
 * deadline, settles within the deadline plus the margin set below, with no uncaught error and no socket left open, under Bun in this
 * process and under every Node binary in NODE_TRANSPORT_NODES (or the node on PATH), from a bundle of the read loop and
 * the peers. Node needs its own run because a throw inside a socket listener exits a Node process, while Bun turns it
 * into a rejection.
 *
 * The margin is measured where the failures came from: 10 iterations of this set beside three busy loops on
 * windows-latest and macos-latest stretched the timeout-derived stops to 2,427 ms, and the reported CI failure sat at
 * 2,178 ms, so MARGIN_MS is 500. The old 100 ms covered the 3.9 ms overshoot measured for one read per process; a
 * starved runner stretches timers far beyond contention between the peers themselves.
 *
 * Several expected stops are a race on one event loop: a peer's close or cancel against the read's 1,000 ms idle timer,
 * and the idle timer against the 2,000 ms deadline. The client's parse of the header-heavy pair holds the loop for one
 * stretch of about 300 ms, and over 900 ms with the test pinned to one core beside three busy loops, which once turned
 * "socket-end-mid-read" into idle and "heartbeats-in-content" into deadline. So those two peers run in a wave of their
 * own after the rest, and the peers that close, cancel or end mid-read act on the client's acks instead of a 100 ms
 * wait. Measured on the starved core, the light wave's longest stall is under 200 ms, against the 1,000 ms an idle
 * stop needs, and every idle stop's last byte arrives by 320 ms, leaving 680 ms before the deadline could win. On a
 * starved runner the heavy pair's byte budget can lose to the wall-clock deadline instead (one of ten stretched runs
 * stopped header-heavy-bytes on deadline), so both heavy peers allow that stop. Their sockets always close once the
 * client drops, but a loaded macos runner under Bun can take seconds to see that close (3,540 ms worst across 30
 * probe runs), so the helper's wait is bounded at 5 s and no read-loop change was needed. The
 * file's budget is 20 s: about 3 s per runtime, plus the bundle.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { makeCertificates } from "../../../helpers/node-transport-fixtures";
import { HOSTILE_PEERS, type HostileOutcome, runHostileSet } from "../../../helpers/rabbitmq-fake-peer";

const DEADLINE_MS = 2_000;
const MARGIN_MS = 500;
const HELPER = join(import.meta.dir, "..", "..", "..", "helpers", "rabbitmq-fake-peer.ts");

/** The Node binaries NODE_TRANSPORT_NODES lists, or the node on PATH; an empty list or no node fails by name. */
function nodeBinaries(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  if (listed !== undefined) {
    const binaries = listed.split(delimiter).filter((entry) => entry !== "");
    if (binaries.length === 0) throw new Error("NODE_TRANSPORT_NODES is set and lists no Node binary");
    return binaries;
  }
  const onPath = Bun.which("node");
  if (onPath === null)
    throw new Error("No node on PATH: R-S10 runs the hostile peers under Node; install Node 24 or later");
  return [onPath];
}

interface RuntimeRun {
  readonly runtime: string;
  readonly outcomes: readonly HostileOutcome[];
  readonly uncaught: number;
}

let certificate: { key: string; cert: string };
let underBun: RuntimeRun;
const underNode: RuntimeRun[] = [];

beforeAll(async () => {
  const pair = makeCertificates().local;
  certificate = { key: pair.key, cert: pair.cert };
  let uncaught = 0;
  const count = (): void => {
    uncaught += 1;
  };
  process.on("uncaughtException", count);
  process.on("unhandledRejection", count);
  try {
    const outcomes = await runHostileSet(certificate);
    underBun = { runtime: `bun ${Bun.version}`, outcomes, uncaught };
  } finally {
    process.off("uncaughtException", count);
    process.off("unhandledRejection", count);
  }

  const work = mkdtempSync(join(tmpdir(), "rabbitmq-hostile-"));
  try {
    writeFileSync(
      join(work, "child.ts"),
      [
        'import { readFileSync } from "node:fs";',
        `import { runHostileSet } from ${JSON.stringify(HELPER)};`,
        "let uncaught = 0;",
        'process.on("uncaughtException", () => { uncaught += 1; });',
        'process.on("unhandledRejection", () => { uncaught += 1; });',
        'const certificate = JSON.parse(readFileSync(process.argv[2], "utf8"));',
        "const outcomes = await runHostileSet(certificate);",
        'process.stdout.write(JSON.stringify({ runtime: process.version, outcomes, uncaught }) + "\\n");',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    writeFileSync(join(work, "certificate.json"), JSON.stringify(certificate));
    const build = await Bun.build({
      entrypoints: [join(work, "child.ts")],
      target: "node",
      format: "esm",
      outdir: work,
    });
    expect({ success: build.success, logs: build.logs.map(String) }).toMatchObject({ success: true });
    for (const binary of nodeBinaries()) {
      const child = Bun.spawn([binary, join(work, "child.js"), join(work, "certificate.json")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ binary, exitCode, stderr }).toMatchObject({ exitCode: 0 });
      underNode.push(JSON.parse(stdout.trim().split("\n").at(-1) as string) as RuntimeRun);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 60_000);

function check(run: RuntimeRun): void {
  expect({ runtime: run.runtime, uncaught: run.uncaught }).toEqual({ runtime: run.runtime, uncaught: 0 });
  expect(run.outcomes.map((outcome) => outcome.name)).toEqual(HOSTILE_PEERS.map((peer) => peer.name));
  for (const [index, outcome] of run.outcomes.entries()) {
    const peer = HOSTILE_PEERS[index];
    // label and ms ride the asserted objects so a failure on a CI runner names the stop that happened and how long
    // the read took, rather than only the boolean that fell.
    expect({
      runtime: run.runtime,
      name: outcome.name,
      label: outcome.label,
      allowed: peer?.expect.includes(outcome.label),
    }).toEqual({
      runtime: run.runtime,
      name: outcome.name,
      label: outcome.label,
      allowed: true,
    });
    const ms = Math.round(outcome.ms);
    expect({
      name: outcome.name,
      label: outcome.label,
      ms,
      withinDeadline: ms <= DEADLINE_MS + MARGIN_MS,
    }).toMatchObject({
      name: outcome.name,
      label: outcome.label,
      withinDeadline: true,
    });
    expect({ name: outcome.name, label: outcome.label, openAfter: outcome.openAfter }).toEqual({
      name: outcome.name,
      label: outcome.label,
      openAfter: 0,
    });
  }
}

describe("R-S10: hostile peers settle within the deadline, uncaught-free, leaving no socket", () => {
  test("the set holds the 36 peers, the header-heavy pair and the trickled header frame", () => {
    expect(HOSTILE_PEERS).toHaveLength(39);
  });

  test("only the header-heavy pair runs in the heavy-parse wave", () => {
    expect(HOSTILE_PEERS.filter((peer) => peer.heavyParse).map((peer) => peer.name)).toEqual([
      "header-heavy-void",
      "header-heavy-bytes",
    ]);
  });

  test("under Bun", () => {
    check(underBun);
  });

  test("under Node", () => {
    expect(underNode.length).toBeGreaterThan(0);
    for (const run of underNode) {
      expect(["24", "26"]).toContain(run.runtime.slice(1).split(".")[0]);
      check(run);
    }
  });

  test("both runtimes come to the same outcome for every peer", () => {
    const labels = (run: RuntimeRun) =>
      run.outcomes.map((outcome) => [outcome.name, outcome.label.startsWith("error:") ? "error" : outcome.label]);
    for (const run of underNode) expect(labels(run)).toEqual(labels(underBun));
  });

  test("the reads that return rows return what the peer sent", () => {
    const rows = Object.fromEntries(underBun.outcomes.map((outcome) => [outcome.name, outcome.rows]));
    expect(rows).toMatchObject({
      good: 3,
      "tune-frame-max-0": 1,
      "heartbeats-in-content": 1,
      "table-depth-10": 1,
      "table-depth-20": 1,
      "server-cancel": 2,
      "server-close-320": 2,
      "blocked-unblocked": 2,
      "socket-end-mid-read": 2,
      "tls-half-close": 2,
      "flood-past-prefetch": 100,
      "ignores-close": 1,
    });
  });
});
