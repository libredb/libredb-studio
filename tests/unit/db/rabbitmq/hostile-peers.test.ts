/**
 * R-S10: every AMQP read runs under a Studio deadline and cannot crash the process. Each hostile peer settles at one
 * of the stops its script allows, with no uncaught error, and the socket the read opened is destroyed by the time it
 * settles, under Bun in this process and under every Node binary in NODE_TRANSPORT_NODES (or the node on PATH), from a
 * bundle of the read loop and the peers. Node needs its own run because a throw inside a socket listener exits a Node
 * process, while Bun turns it into a rejection.
 *
 * The deadline is only asserted where it is the peer's expected stop. A wall-clock timer cannot preempt a loop a peer
 * is holding: the header-heavy pair's parse blocks it for about 300 ms, over 900 ms on a starved core. On a loaded
 * runner the 1,000 ms idle and the 2,000 ms deadline then race whichever stop the peer's own bytes would reach, and
 * the old `deadline + 100 ms` settle bound measured the runner rather than the read. Pinned to one core beside three
 * busy loops with three copies of this file running, `heartbeats-in-content` ended at the deadline instead of idle,
 * and `header-heavy-bytes` took 3,436 ms. So the peers whose expected stop is the deadline take HOSTILE_DEADLINE_MS
 * (2,000 ms), every other peer takes HOSTILE_PEER_DEADLINE_MS (10,000 ms) so its own stop wins that race, and what is
 * asserted is the property behind the old bound: a read the deadline stopped releases it promptly, which is what
 * catches a deadline that fires without ending the read.
 *
 * The read's own socket is checked through a dial that records it, not through the peer's accepted socket. Every stop
 * in `read-loop.ts` destroys that socket (a hard stop drops it, a graceful one waits for close-ok and then destroys
 * it, and the `finally` drops it), so the check needs no time window; the peer's socket can outlive it on a starved
 * loop, which is why `openAfter` is reported in a failure and not asserted.
 *
 * The file's budget is 20 s: about 3 s per runtime, plus the bundle.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { makeCertificates } from "../../../helpers/node-transport-fixtures";
import {
  HOSTILE_DEADLINE_MS,
  HOSTILE_PEER_DEADLINE_MS,
  HOSTILE_PEERS,
  type HostileOutcome,
  type HostilePeer,
  runHostileSet,
} from "../../../helpers/rabbitmq-fake-peer";

/** How long a read the deadline stopped may take to release it, measured at 0 to 1 ms unloaded on Linux. */
const RELEASE_LIMIT_MS = 250;
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
    const ms = Math.round(outcome.ms);
    const afterDeadlineMs = outcome.afterDeadlineMs === null ? null : Math.round(outcome.afterDeadlineMs);
    expect({
      runtime: run.runtime,
      name: outcome.name,
      label: outcome.label,
      ms,
      allowed: peer?.expect.includes(outcome.label),
    }).toEqual({
      runtime: run.runtime,
      name: outcome.name,
      label: outcome.label,
      ms,
      allowed: true,
    });
    expect({
      name: outcome.name,
      label: outcome.label,
      ms,
      afterDeadlineMs,
      openAfter: outcome.openAfter,
      readSocketDestroyed: outcome.readSocketDestroyed,
      released: outcome.afterDeadlineMs === null || outcome.afterDeadlineMs <= RELEASE_LIMIT_MS,
    }).toMatchObject({ readSocketDestroyed: true, released: true });
  }
}

describe("R-S10: hostile peers settle at an allowed stop, uncaught-free, with the read's socket destroyed", () => {
  test("the set holds the 36 peers, the header-heavy pair and the trickled header frame", () => {
    expect(HOSTILE_PEERS).toHaveLength(39);
  });

  test("only the header-heavy pair runs in the heavy-parse wave", () => {
    expect(HOSTILE_PEERS.filter((peer) => peer.heavyParse).map((peer) => peer.name)).toEqual([
      "header-heavy-void",
      "header-heavy-bytes",
    ]);
  });

  test("only the peers whose stop is the deadline take the tested 2,000 ms", () => {
    const stopsAtDeadline = (peer: HostilePeer): boolean =>
      peer.expect.some((label) => label === "error:TimeoutError" || label === "stop:deadline");
    const takesTestedDeadline = (peer: HostilePeer): boolean =>
      (peer.deadlineMs ?? HOSTILE_PEER_DEADLINE_MS) === HOSTILE_DEADLINE_MS;
    expect(HOSTILE_PEERS.filter(takesTestedDeadline).map((peer) => peer.name)).toEqual(
      HOSTILE_PEERS.filter(stopsAtDeadline).map((peer) => peer.name),
    );
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
