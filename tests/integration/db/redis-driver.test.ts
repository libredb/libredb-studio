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
 * wait for the next connection; the stream keeps its error listener for its whole life; and a reset fails the
 * commands in flight with ioredis's own "Connection is closed." instead of leaving them unsettled, now that the
 * provider stops ioredis from sending them again on the next connection (`autoResendUnfulfilledCommands: false`).
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
  readonly database?: string;
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

  test("a reset while a command waits fails the command with a named error, once, and the next command answers", () => {
    for (const report of reports) {
      const reset = find(report, "reset while a command waits");
      // The exact message also holds the patch's `!stream.destroyed` check: without it, the reset's own error would
      // take the fatal-error path and fail the command with "read ECONNRESET" instead.
      expect(reset.call).toBe("QueryError: Redis error: Connection is closed.");
      // The server may have run the command before the reset, so it is not sent again on the next connection.
      expect(reset.delivered).toBe(1);
      expect(reset.next).toBe(PONG);
      expect(reset.escaped).toEqual([]);
    }
  });

  test("a command sent while the client reconnects after a reset waits for a connection that answers it, once", () => {
    for (const report of reports) {
      const queued = find(report, "reset, then a command sent while the client reconnects");
      // The command is sent once the reset is logged, so it is not written to the connection that reset.
      expect(queued.logged).toEqual(["[Redis] read ECONNRESET"]);
      expect(queued.call).toBe('ok {"result":"value"}');
      expect(queued.delivered).toBe(1);
      expect(queued.escaped).toEqual([]);
    }
  });

  test("a header no JS array can hold answering the SELECT of an object read fails the read as a failed connect", () => {
    for (const report of reports) {
      const read = find(report, "oversized array header answering an object read's SELECT");
      expect(read.call).toMatch(new RegExp(`^ConnectionError: Failed to connect to Redis: .+${FATAL}`));
      expect(read.escaped).toEqual([]);
    }
  });

  test("a header no JS array can hold answering an object read fails the read with a named error", () => {
    for (const report of reports) {
      const read = find(report, "oversized array header answering an object read");
      expect(read.call).toMatch(new RegExp(`^QueryError: Redis error: .+${FATAL}`));
      expect(read.escaped).toEqual([]);
    }
  });

  // ioredis selects a numbered database again on the connection that follows a reset with a SELECT it sends itself for
  // its `db` option, which no caller awaits, before the ready check. A failure of it is the client's `error` event, which
  // the provider logs; a reset before the ready check leaves it unsettled (D470 in docs/BACKLOG.md), and the next
  // connection sends its own. The next command still runs in the database.
  test("a reset while the reconnect's own SELECT waits is logged, and the next command runs in the database", () => {
    for (const report of reports) {
      const reselect = find(report, "reset while the reconnect's own SELECT of database 1 waits");
      expect(reselect.escaped).toEqual([]);
      expect(reselect.logged).toEqual(["[Redis] read ECONNRESET", "[Redis] read ECONNRESET"]);
      expect(reselect.call).toBe('ok {"result":"value"}');
      expect(reselect.database).toBe("1");
    }
  });

  test("a header no JS array can hold answering the reconnect's own SELECT is logged, and the next command answers", () => {
    for (const report of reports) {
      const reselect = find(report, "oversized array header answering the reconnect's own SELECT of database 1");
      expect(reselect.escaped).toEqual([]);
      expect(reselect.logged.some((line) => new RegExp(`^\\[Redis\\] .+${FATAL}`).test(line))).toBe(true);
      expect(reselect.call).toBe('ok {"result":"value"}');
      expect(reselect.database).toBe("1");
    }
  });

  test("a reset while an object read selects its database again marks the kind in flight unavailable by name", () => {
    for (const report of reports) {
      const read = find(report, "reset while an object read selects its database again after a reset");
      expect(read.escaped).toEqual([]);
      // countObjects answers a kind it could not count as unavailable, with the driver's message. The next kind's read
      // waits for a connection that is ready in the database, and is counted there.
      expect(read.call).toBe('ok {"keyspace":{"unavailable":"Connection is closed."},"function":{"count":0}}');
      expect(read.next).toBe(PONG);
    }
  });

  // ioredis records with a command queued while it reconnects the database the client is in, and the provider gives it
  // the session's database as its `db` option, so the command runs there and never in database 0.
  test("a command sent after the reconnect opens and before it is ready runs in the session's database", () => {
    for (const report of reports) {
      const queued = find(report, "a command sent after the reconnect opens and before it is ready, in database 1");
      expect(queued.call).toBe('ok {"result":"value"}');
      expect(queued.database).toBe("1");
      expect(queued.escaped).toEqual([]);
    }
  });

  test("a reconnect whose SELECT of the database is refused fails the next commands by name, and none of them runs", () => {
    const refusal = "QueryError: Redis refused database 1 after a reconnect: ERR DB index is out of range";
    for (const report of reports) {
      const refused = find(report, "the server refuses the reconnect's SELECT of database 1");
      expect(refused.logged).toContain("[Redis] ERR DB index is out of range");
      expect(refused.call).toBe(refusal);
      expect(refused.next).toBe(refusal);
      expect(refused.delivered).toBe(0);
      expect(refused.escaped).toEqual([]);
    }
  });

  test("a reset while an object read waits fails the read with the editor's named error, once", () => {
    for (const report of reports) {
      const read = find(report, "reset while an object read waits");
      expect(read.call).toBe("QueryError: Redis error: Connection is closed.");
      expect(read.delivered).toBe(1);
      expect(read.escaped).toEqual([]);
    }
  });
});
