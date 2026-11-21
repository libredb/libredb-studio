/**
 * The Redis provider over the real ioredis, on the runtimes production runs: a reply the parser cannot hold and a TLS
 * record the client cannot decrypt each reach the caller as a named error, and the connection serves the next command.
 *
 * redis-provider.test.ts replaces ioredis with a stand-in, so it cannot see the driver's own socket handling. This file
 * runs redis-driver-harness.ts in a Bun child and, bundled with `bun build --target=node`, in one Node child per binary
 * NODE_TRANSPORT_NODES lists (or the node on PATH), so CI's Node 24 suite and its step on the image's Node both run it.
 * The two runtimes report socket errors differently: after an unreadable TLS record Bun closes the socket while Node
 * keeps it open, so the Node child is the one that holds the fatal-error path for an error the socket survives, and
 * the one that reports a reset that follows the record while the connection closes.
 *
 * The driver is patched (docs/TOOLCHAIN.md, "Patched dependencies"): the parser's throw takes ioredis's own fatal-error
 * path, which rejects the commands in flight and reconnects under the provider's options (the editor connection keeps
 * ioredis's default retry strategy); an error the TLS socket survives takes the same path, and commands not yet sent
 * wait for the next connection; and the stream keeps its error listener for its whole life. A reset still takes
 * ioredis's own close path, which sends a command in flight again on the next connection.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { loadTlsFixtures } from "../../helpers/tls-fixtures";

interface CaseReport {
  readonly name: string;
  readonly call: string;
  readonly next?: string;
  readonly delivered?: number;
  readonly logged: string[];
  readonly escaped: string[];
}

interface Report {
  readonly runtime: "bun" | "node";
  readonly cases: CaseReport[];
}

const HARNESS = join(import.meta.dir, "redis-driver-harness.ts");
const PONG = 'ok {"result":"PONG"}';
/** ioredis's fatal-error path appends this sentence to the message of every error it takes. */
const FATAL = "\\. Please report this\\.$";
/** How Node (OpenSSL) and Bun (BoringSSL) word a TLS record the client cannot decrypt. */
const UNREADABLE = "(decryption failed or bad record mac|DECRYPTION_FAILED_OR_BAD_RECORD_MAC)";

function nodeBinaries(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  const nodes = listed === undefined ? [Bun.which("node")] : listed.split(delimiter).filter((entry) => entry !== "");
  if (nodes.length === 0 || nodes.includes(null)) {
    throw new Error("No Node binary: set NODE_TRANSPORT_NODES or put Node 24 or later on PATH");
  }
  return nodes as string[];
}

/** Runs one child to its end and reads the JSON report it prints last. */
function run(command: string, args: string[], env: Record<string, string>): Report {
  const child = spawnSync(command, args, { env: { ...process.env, ...env }, timeout: 120_000 });
  if (child.error) throw new Error(`${command} could not run the harness: ${child.error.message}`);
  if (child.status !== 0) {
    throw new Error(`${command} ended ${child.status ?? child.signal} running the harness: ${child.stderr.toString()}`);
  }
  const lines = child.stdout.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as Report;
}

let dir = "";
const reports: Report[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "redis-driver-"));
  const build = await Bun.build({ entrypoints: [HARNESS], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the harness: ${build.logs.join("\n")}`);
  const { server } = loadTlsFixtures();
  // LOG_LEVEL is set so an inherited LOG_LEVEL=error cannot hide the `[Redis]` warnings the TLS cases read.
  const env = { REDIS_HARNESS_TLS_CERT: server.cert, REDIS_HARNESS_TLS_KEY: server.key, LOG_LEVEL: "warn" };
  reports.push(run(process.execPath, [HARNESS], env));
  for (const node of nodeBinaries()) reports.push(run(node, [join(dir, "redis-driver-harness.js")], env));
}, 300_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function find(report: Report, name: string): CaseReport {
  const found = report.cases.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`the ${report.runtime} harness reported no case "${name}"`);
  return found;
}

describe("Redis over the patched ioredis, on Bun and Node", () => {
  test("every runtime ran", () => {
    expect(reports.map((report): string => report.runtime)).toEqual(["bun", ...nodeBinaries().map(() => "node")]);
  });

  test("an array header no JS array can hold fails the command with a named error, and the next command answers", () => {
    for (const report of reports) {
      const reply = find(report, "oversized array header");
      expect(reply.call).toMatch(new RegExp(`^QueryError: Redis error: .+${FATAL}`));
      expect(reply.next).toBe(PONG);
      expect(reply.escaped).toEqual([]);
    }
  });

  test("a reply nested deeper than the stack fails the command with a named error, and the next command answers", () => {
    for (const report of reports) {
      const reply = find(report, "deeply nested reply");
      expect(reply.call).toMatch(new RegExp(`^QueryError: Redis error: Maximum call stack size exceeded\\.?${FATAL}`));
      expect(reply.next).toBe(PONG);
      expect(reply.escaped).toEqual([]);
    }
  });

  test("the same header answering a connect fails the connect with a named error", () => {
    for (const report of reports) {
      const connect = find(report, "oversized array header while connecting");
      expect(connect.call).toMatch(new RegExp(`^ConnectionError: Failed to connect to Redis: .+${FATAL}`));
      expect(connect.escaped).toEqual([]);
    }
  });

  test("the same replies answering the SELECT of a numbered database fail the connect with a named error", () => {
    for (const report of reports) {
      for (const name of ["oversized array header answering SELECT", "deeply nested reply answering SELECT"]) {
        const connect = find(report, name);
        expect(connect.call).toMatch(new RegExp(`^ConnectionError: Failed to connect to Redis: .+${FATAL}`));
        expect(connect.escaped).toEqual([]);
      }
    }
  });

  test("the same replies answering the agent read-only proof fail the connect with a named error", () => {
    for (const report of reports) {
      for (const name of [
        "oversized array header answering the read-only proof",
        "deeply nested reply answering the read-only proof",
      ]) {
        const connect = find(report, name);
        expect(connect.call).toMatch(new RegExp(`^ConnectionError: Failed to connect to Redis: .+${FATAL}`));
        expect(connect.escaped).toEqual([]);
      }
    }
  });

  test("an unreadable TLS record and then a reset on an idle connection is reported, and the next command answers", () => {
    for (const report of reports) {
      const idle = find(report, "unreadable TLS record then reset");
      // The record closes the connection, so the reset reaches a socket the client has already left.
      expect(idle.logged).toEqual([expect.stringMatching(new RegExp(UNREADABLE))]);
      expect(idle.next).toBe(PONG);
      expect(idle.escaped).toEqual([]);
    }
  });

  test("an unreadable TLS record and then a command: the record is reported and the command answers", () => {
    for (const report of reports) {
      const write = find(report, "unreadable TLS record then a command");
      // The record closes the connection, so the command is written to the next one, not to the failed socket.
      expect(write.logged).toEqual([expect.stringMatching(new RegExp(UNREADABLE))]);
      expect(write.call).toBe(PONG);
      expect(write.escaped).toEqual([]);
    }
  });

  test("an unreadable TLS record and a reset while connecting fail the connect with a named error", () => {
    for (const report of reports) {
      const connect = find(report, "unreadable TLS record while connecting, then reset");
      expect(connect.call).toMatch(
        /^ConnectionError: Failed to connect to Redis: .*(decryption failed or bad record mac|DECRYPTION_FAILED_OR_BAD_RECORD_MAC)/,
      );
      expect(connect.escaped).toEqual([]);
    }
  });

  test("an unreadable TLS record fails the command in flight with a named error, once, and the next command answers", () => {
    for (const report of reports) {
      const inflight = find(report, "unreadable TLS record while a command waits");
      expect(inflight.call).toMatch(new RegExp(`^QueryError: Redis error: .*${UNREADABLE}`));
      // The server may have run the command before the record, so it is not sent again on the next connection.
      expect(inflight.delivered).toBe(1);
      expect(inflight.logged).toContainEqual(expect.stringMatching(new RegExp(UNREADABLE)));
      expect(inflight.next).toBe(PONG);
      expect(inflight.escaped).toEqual([]);
    }
  });

  test("an unreadable TLS record while connecting fails the connect with a named error", () => {
    for (const report of reports) {
      const connect = find(report, "unreadable TLS record while connecting");
      expect(connect.call).toMatch(new RegExp(`^ConnectionError: Failed to connect to Redis: .*${UNREADABLE}`));
      expect(connect.escaped).toEqual([]);
    }
  });

  test("an unreadable TLS record answering the SELECT or the read-only proof fails the connect with a named error", () => {
    for (const report of reports) {
      for (const name of [
        "unreadable TLS record answering SELECT",
        "unreadable TLS record answering the read-only proof",
      ]) {
        const connect = find(report, name);
        expect(connect.call).toMatch(new RegExp(`^ConnectionError: Failed to connect to Redis: .*${UNREADABLE}`));
        expect(connect.escaped).toEqual([]);
      }
    }
  });

  test("a reset that follows the record while the connection closes is reported like the first error", () => {
    for (const report of reports) {
      const closing = find(report, "unreadable TLS record then reset while the connection closes");
      // Bun has closed the socket by the time of the reset; Node keeps it open until ioredis's disconnect timeout.
      const after = report.runtime === "node" ? [expect.stringMatching(/read ECONNRESET/)] : [];
      expect(closing.logged).toEqual([expect.stringMatching(new RegExp(UNREADABLE)), ...after]);
      expect(closing.next).toBe(PONG);
      expect(closing.escaped).toEqual([]);
    }
  });

  test("a command sent while the client reconnects after the record waits for a connection that answers it", () => {
    for (const report of reports) {
      const queued = find(report, "unreadable TLS record, then a command sent while the client reconnects");
      expect(queued.call).toBe('ok {"result":"value"}');
      expect(queued.delivered).toBe(1);
      expect(queued.escaped).toEqual([]);
    }
  });

  test("a reset while a command waits keeps ioredis's own reconnect, which sends the command again", () => {
    for (const report of reports) {
      const reset = find(report, "reset while a command waits");
      expect(reset.call).toBe('ok {"result":"value"}');
      expect(reset.delivered).toBe(2);
      expect(reset.next).toBe(PONG);
      expect(reset.escaped).toEqual([]);
    }
  });
});
