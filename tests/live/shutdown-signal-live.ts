/**
 * Live check of the shutdown handler (src/lib/shutdown-handler.ts) on the built standalone server.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. tests/unit/lib/shutdown-handler.test.ts drives the handler on a
 * stand-in process. Only the built server shows who really ends the process on a signal: Next.js's `startServer`
 * installs its own SIGTERM and SIGINT listener unless `NEXT_MANUAL_SIG_HANDLE` is set, `register()` runs in Next.js's
 * own start-up, and the exit code is what a platform sees (docs/DISTRIBUTION.md#stopping-the-server).
 *
 * Each case starts its own server with `node server.js` from `LIBREDB_LIVE_STANDALONE_DIR`, a directory holding
 * `server.js`: a local `.next/standalone` after `DOCKER_BUILD=true bun run build`, or the CI payload tarball extracted
 * with `--strip-components=1`. The server gets an explicit environment, with only PATH and HOME taken from the caller,
 * so a developer's `.env` keys or `SEED_CONFIG_PATH` never reach it: its own free port and data directory, SQLite
 * storage, both samples off, and a JWT secret and passwords generated at run time. The case waits for a 200 from
 * `GET /health`, which proves `register()` has run and loads no provider factory, sends the signal to the server's
 * PID, waits at most 30 s for it to exit (killing it and failing past that), and removes the data directory.
 *
 * It prints one line per case, `ok   <case>` or `FAIL <case>` with the reason and the server's output, and exits
 * non-zero when any case failed. Output written at exit reaches a pipe on Linux synchronously, which the cases that
 * read Studio's lines rely on, so it runs on Linux.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 * CI runs it in the "Shutdown Signal Live Check" job of .github/workflows/ci.yml, against the engine smoke payload.
 *
 *   LIBREDB_LIVE_STANDALONE_DIR="$PWD/.next/standalone" bun tests/live/shutdown-signal-live.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/** The directory holding the standalone server.js, from `LIBREDB_LIVE_STANDALONE_DIR`. */
function standaloneDir(): string {
  const dir = process.env.LIBREDB_LIVE_STANDALONE_DIR;
  if (!dir || !existsSync(path.join(dir, "server.js"))) {
    throw new Error("LIBREDB_LIVE_STANDALONE_DIR must name a directory holding the standalone server.js");
  }
  return dir;
}

const STANDALONE_DIR = standaloneDir();

/** How long a server may take to answer `GET /health` with 200 after it was started. */
const READY_DEADLINE_MS = 60_000;
/** How long a server may take to exit after the signal, or after its start when it must refuse to boot. */
const EXIT_DEADLINE_MS = 30_000;

const STUDIO_OWNS_SIGTERM = "Received SIGTERM: running the shutdown hooks, then closing the providers, then exiting";
const STUDIO_OWNS_SIGINT = "Received SIGINT: running the shutdown hooks, then closing the providers, then exiting";
const NEXT_OWNS_SIGTERM = "Received SIGTERM: running the shutdown hooks; Next.js's handler ends the process";
const COMPLETE = "Shutdown complete, exiting with 0";

interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Server {
  readonly child: ChildProcess;
  readonly exited: Promise<Ended>;
  output(): string;
  /** Answers once `GET /health` is 200; rejects when the server exits first or misses the deadline. */
  ready(): Promise<void>;
  remove(): void;
}

/** A port nothing listens on now; the server binds it a moment later, and a collision fails that start. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port);
        else reject(new Error("the port probe has no address"));
      });
    });
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(extra: Readonly<Record<string, string>>): Promise<Server> {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "libredb-shutdown-live-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? dataDir,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    LIBREDB_NO_BANNER: "1",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    STORAGE_PROVIDER: "sqlite",
    STORAGE_SQLITE_PATH: path.join(dataDir, "libredb-storage.db"),
    SEED_CONFIG_PATH: "",
    SQLITE_EMBEDDED_SAMPLE: "false",
    LIBREDB_EMBEDDED_SAMPLE: "false",
    JWT_SECRET: randomBytes(32).toString("hex"),
    ADMIN_PASSWORD: randomUUID(),
    USER_PASSWORD: randomUUID(),
    ...extra,
  };
  const child = spawn("node", ["server.js"], { cwd: STANDALONE_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  let hasExited = false;
  const exited = new Promise<Ended>((resolve) => {
    child.once("exit", (code, signal) => {
      hasExited = true;
      resolve({ code, signal });
    });
  });
  // Closing the pipes ends after the exit event; the output is complete once both have closed.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  async function ready(): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < READY_DEADLINE_MS) {
      if (hasExited) throw new Error("the server exited before it answered GET /health");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (response.status === 200) return;
      } catch {
        // Not listening yet, or the handlers are not ready yet.
      }
      await delay(100);
    }
    throw new Error(`the server did not answer GET /health with 200 within ${READY_DEADLINE_MS} ms`);
  }

  return {
    child,
    exited: exited.then(async (ended) => {
      await closed;
      return ended;
    }),
    output: () => output,
    ready,
    remove: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

/** The server's end, or a failure after killing it when it outlives the deadline. */
async function endOf(server: Server): Promise<Ended> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), EXIT_DEADLINE_MS);
  });
  const outcome = await Promise.race([server.exited, late]);
  clearTimeout(timer);
  if (outcome === "late") {
    server.child.kill("SIGKILL");
    await server.exited;
    throw new Error(`the server did not exit within ${EXIT_DEADLINE_MS} ms, so it was killed`);
  }
  return outcome;
}

/**
 * Starts a server, retrying once when the port was taken between the probe and the bind, and waits until it is ready.
 */
async function readyServer(extra: Readonly<Record<string, string>>): Promise<Server> {
  for (let attempt = 1; ; attempt += 1) {
    const server = await startServer(extra);
    try {
      await server.ready();
      return server;
    } catch (error) {
      if (!server.child.killed && server.child.exitCode === null) server.child.kill("SIGKILL");
      await server.exited;
      server.remove();
      if (attempt === 1 && server.output().includes("EADDRINUSE")) {
        console.log("     the port was taken before the server bound it; retrying once with a new port");
        continue;
      }
      throw new Error(`${(error as Error).message}\n${server.output()}`);
    }
  }
}

type Check = (ended: Ended, output: string) => string[];

/** Starts a ready server with `extra`, sends `signal`, and answers what `check` found wrong with its end. */
async function signalCase(extra: Readonly<Record<string, string>>, signal: NodeJS.Signals, check: Check) {
  const server = await readyServer(extra);
  try {
    if (server.child.pid === undefined) throw new Error("the server has no PID");
    process.kill(server.child.pid, signal);
    const ended = await endOf(server);
    return { problems: check(ended, server.output()), output: server.output() };
  } finally {
    server.remove();
  }
}

const describeEnd = (ended: Ended): string =>
  ended.signal === null ? `exit code ${ended.code}` : `killed by ${ended.signal}`;

const CASES: { name: string; run: () => Promise<{ problems: string[]; output: string }> }[] = [
  {
    name: "L1 NEXT_MANUAL_SIG_HANDLE=true, SIGTERM: Studio's handler exits with 0",
    run: () =>
      signalCase({ NEXT_MANUAL_SIG_HANDLE: "true" }, "SIGTERM", (ended, output) => [
        ...(ended.code === 0 && ended.signal === null ? [] : [`expected exit code 0, got ${describeEnd(ended)}`]),
        ...(output.includes(STUDIO_OWNS_SIGTERM) ? [] : ["Studio's start line is missing"]),
        ...(output.includes(COMPLETE) ? [] : ["Studio's end line is missing"]),
      ]),
  },
  {
    name: "L2 NEXT_MANUAL_SIG_HANDLE unset, SIGTERM: Next.js's handler exits with 143 after Studio's start line",
    run: () =>
      signalCase({}, "SIGTERM", (ended, output) => [
        ...(ended.code === 143 && ended.signal === null ? [] : [`expected exit code 143, got ${describeEnd(ended)}`]),
        ...(output.includes(NEXT_OWNS_SIGTERM) ? [] : ["Studio's start line naming Next.js as the owner is missing"]),
      ]),
  },
  {
    name: "L3 NEXT_MANUAL_SIG_HANDLE=true, SIGINT: Studio's handler exits with 0",
    run: () =>
      signalCase({ NEXT_MANUAL_SIG_HANDLE: "true" }, "SIGINT", (ended, output) => [
        ...(ended.code === 0 && ended.signal === null ? [] : [`expected exit code 0, got ${describeEnd(ended)}`]),
        ...(output.includes(STUDIO_OWNS_SIGINT) ? [] : ["Studio's start line is missing"]),
      ]),
  },
  {
    name: "L4 NEXT_MANUAL_SIG_HANDLE=1: the boot is refused with exit code 1, naming the variable",
    run: async () => {
      const server = await startServer({ NEXT_MANUAL_SIG_HANDLE: "1" });
      try {
        const ended = await endOf(server);
        const output = server.output();
        return {
          problems: [
            ...(ended.code === 1 && ended.signal === null ? [] : [`expected exit code 1, got ${describeEnd(ended)}`]),
            ...(output.includes('NEXT_MANUAL_SIG_HANDLE is set to "1"') ? [] : ["the banner naming it is missing"]),
          ],
          output,
        };
      } finally {
        server.remove();
      }
    },
  },
];

let failed = 0;
for (const each of CASES) {
  try {
    const { problems, output } = await each.run();
    if (problems.length === 0) {
      console.log(`ok   ${each.name}`);
    } else {
      failed += 1;
      console.log(`FAIL ${each.name}: ${problems.join("; ")}\n${output}`);
    }
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${each.name}: ${(error as Error).message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
