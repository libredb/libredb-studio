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
 * `GET /health`, which proves `register()` has run and loads no provider factory, then sends one more, so the
 * request drain has seen the server, sends the signal to the server's PID, waits at most 30 s for it to exit (killing
 * it and failing past that), and removes the data directory.
 *
 * The drain cases (L5, L6, L7) hold a request in flight by its own body: `POST /api/auth/login` with a body whose
 * first bytes are sent before the signal, so the client decides when the request ends, and no database is involved.
 * L7 writes the request on a raw connection, so its last body bytes and the first byte of the next request go in one
 * write.
 *
 * The governance cases (G1, G2) are the query event delivery at a stop under governance, on the default image's
 * environment: `NEXT_MANUAL_SIG_HANDLE` as the `Dockerfile` runner stage sets it. They start their own PostgreSQL 17
 * in Docker (`docker run --memory 2g` on a loopback port Docker picks, removed at the end; the name's prefix is
 * `LIBREDB_LIVE_PG_CONTAINER_PREFIX` when set), build a governance source in a throwaway database with
 * tests/helpers/governance/fixture-ddl.ts, seal one governed PostgreSQL connection to a key drawn at run time, and
 * sign a session cookie with Studio's own `signJWT`. So they need Docker, and fail by name without it.
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
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { SESSION_COOKIE } from "@/lib/auth-cookies";
import { DRAIN_DEADLINE_MS } from "@/lib/shutdown-drain";
import { buildFixtureDdl, readFixtureManifest } from "../helpers/governance/fixture-ddl";
import { keyringFileOf, removeKeyringFiles, testKey } from "../helpers/governance/keyring-file";
import { sealSecret } from "../helpers/governance/lsb1-seal";
import { installNextHeadersMock } from "../helpers/next-cookie-jar";

// src/lib/auth.ts imports next/headers, which only a running Next.js provides; the cookie is signed here.
installNextHeadersMock();
const { signJWT } = await import("../../src/lib/auth");

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

const STUDIO_STEPS =
  "closing the HTTP server and waiting for the requests in flight, then running the shutdown hooks, then closing the providers, then exiting";
const STUDIO_OWNS_SIGTERM = `Received SIGTERM: ${STUDIO_STEPS}`;
const STUDIO_OWNS_SIGINT = `Received SIGINT: ${STUDIO_STEPS}`;
/** Studio's start line with the drain's counts, as the logger writes the context before the message. */
const studioStart = (line: string, servers: number, inFlight: number): string =>
  `servers=${servers}, inFlight=${inFlight}} ${line}`;
const INCOMPLETE_SIGTERM = "Shutdown incomplete, exiting with 143";
const NEXT_OWNS_SIGTERM = "Received SIGTERM: running the shutdown hooks; Next.js's handler ends the process";
const COMPLETE = "Shutdown complete, exiting with 0";
const NEXT_EXIT_AFTER_SIGTERM = "Exiting with 143 after SIGTERM";

interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Server {
  readonly child: ChildProcess;
  readonly port: number;
  readonly exited: Promise<Ended>;
  /** Whether the process has exited. */
  hasExited(): boolean;
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

/** The server's environment beyond the defaults; a variable given as undefined is left out of it. */
type Extra = Readonly<Record<string, string | undefined>>;

async function startServer(extra: Extra): Promise<Server> {
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
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
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
      let status: number;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        // Each body is read to its end, so the response has ended on the server too when the signal follows.
        await response.text();
        status = response.status;
      } catch {
        // Not listening yet.
        await delay(100);
        continue;
      }
      if (status === 200) {
        // The 200 proves `register()` has run, not that its own request came after the drain subscribed; this one
        // does, so every Studio-owned start line counts the server. Once the first answered, a failure here is one.
        let seen: number;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
          await response.text();
          seen = response.status;
        } catch (error) {
          throw new Error(`the second GET /health failed: ${(error as Error).message}`, { cause: error });
        }
        if (seen !== 200) throw new Error(`the second GET /health answered ${seen}`);
        return;
      }
      // The handlers are not ready yet.
      await delay(100);
    }
    throw new Error(`the server did not answer GET /health with 200 within ${READY_DEADLINE_MS} ms`);
  }

  return {
    child,
    port,
    hasExited: () => hasExited,
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
async function readyServer(extra: Extra): Promise<Server> {
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
      throw new Error(`${(error as Error).message}\n${server.output()}`, { cause: error });
    }
  }
}

type Check = (ended: Ended, output: string) => string[];

/** Starts a ready server with `extra`, sends `signal`, and answers what `check` found wrong with its end. */
async function signalCase(extra: Extra, signal: NodeJS.Signals, check: Check) {
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

/** How a request ended: answered with a status, or failed with an error code. */
interface Answer {
  readonly ok: boolean;
  readonly status?: number;
  readonly code?: string;
}

const describeAnswer = (answer: Answer): string => (answer.ok ? `answered ${answer.status}` : `failed ${answer.code}`);

/** One request to the server; it never rejects. */
function request(
  port: number,
  method: string,
  urlPath: string,
  options: { body?: unknown; cookie?: string; agent?: http.Agent | false } = {},
): Promise<Answer & { body?: string }> {
  return new Promise((resolve) => {
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        agent: options.agent ?? false,
        headers: { "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}) },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        response.on("end", () => resolve({ ok: true, status: response.statusCode, body: text }));
      },
    );
    sent.on("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, code: error.code }));
    if (options.body !== undefined) sent.write(JSON.stringify(options.body));
    sent.end();
  });
}

/**
 * A sign-in held in flight by its own body: the headers and the body's first bytes go now, over `agent`, and the rest
 * only when `finish()` is called, so the request is in flight until then.
 */
function heldLogin(
  port: number,
  agent: http.Agent,
  credentials: { email: string; password: string },
): { answered: Promise<Answer>; finish(): void } {
  const body = JSON.stringify(credentials);
  let finish: () => void = () => {};
  const answered = new Promise<Answer>((resolve) => {
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/auth/login",
        agent,
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ ok: true, status: response.statusCode }));
      },
    );
    sent.on("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, code: error.code }));
    sent.write(body.slice(0, 10));
    finish = () => sent.end(body.slice(10));
  });
  return { answered, finish };
}

/** How long a held request is given to reach the server's route before the signal. */
const IN_FLIGHT_SETTLE_MS = 1000;

/**
 * L5 and L6: a sign-in held in flight across SIGTERM where Studio owns the exit, its body completed `completeAfterMs`
 * after the signal, or never.
 */
async function drainCase(completeAfterMs: number | "never"): Promise<{ problems: string[]; output: string }> {
  const credentials = { email: "admin@libredb.org", password: randomUUID() };
  const server = await readyServer({
    NEXT_MANUAL_SIG_HANDLE: "true",
    ADMIN_EMAIL: credentials.email,
    ADMIN_PASSWORD: credentials.password,
  });
  const keptAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    if (server.child.pid === undefined) throw new Error("the server has no PID");
    const login = heldLogin(server.port, keptAlive, credentials);
    await delay(IN_FLIGHT_SETTLE_MS);
    const signalled = Date.now();
    process.kill(server.child.pid, "SIGTERM");
    await delay(300);
    const runningAtFresh = !server.hasExited();
    const fresh = await request(server.port, "GET", "/health");
    const problems: string[] = [];
    if (!runningAtFresh) problems.push("the server had exited 300 ms after the signal, with the sign-in in flight");
    if (fresh.ok || fresh.code !== "ECONNREFUSED") {
      problems.push(`a fresh connection 300 ms after the signal was not refused: ${describeAnswer(fresh)}`);
    }
    if (completeAfterMs === "never") {
      const ended = await endOf(server);
      const elapsed = Date.now() - signalled;
      const output = server.output();
      const incomplete = output.split("\n").find((line) => line.includes(INCOMPLETE_SIGTERM)) ?? "";
      return {
        problems: [
          ...problems,
          ...(ended.code === 143 && ended.signal === null ? [] : [`expected exit code 143, got ${describeEnd(ended)}`]),
          ...(elapsed >= DRAIN_DEADLINE_MS
            ? []
            : [`exited ${elapsed} ms after the signal, before the drain's deadline`]),
          ...(output.includes(studioStart(STUDIO_OWNS_SIGTERM, 1, 1))
            ? []
            : ["the start line with servers=1, inFlight=1 is missing"]),
          ...(incomplete.includes("responsesCut=1") ? [] : ["the end line with responsesCut=1 is missing"]),
        ],
        output,
      };
    }
    await delay(Math.max(0, completeAfterMs - (Date.now() - signalled)));
    login.finish();
    const answer = await login.answered;
    const after = await request(server.port, "GET", "/health", { agent: keptAlive });
    const ended = await endOf(server);
    const output = server.output();
    return {
      problems: [
        ...problems,
        ...(answer.ok && answer.status === 200
          ? []
          : [`the sign-in in flight was not answered 200: ${describeAnswer(answer)}`]),
        ...(after.ok
          ? [`a request on the kept-alive connection after the answer was served: ${describeAnswer(after)}`]
          : []),
        ...(ended.code === 0 && ended.signal === null ? [] : [`expected exit code 0, got ${describeEnd(ended)}`]),
        ...(output.includes(studioStart(STUDIO_OWNS_SIGTERM, 1, 1))
          ? []
          : ["the start line with servers=1, inFlight=1 is missing"]),
        ...(output.includes(COMPLETE) ? [] : ["Studio's end line is missing"]),
      ],
      output,
    };
  } finally {
    keptAlive.destroy();
    if (!server.hasExited()) {
      server.child.kill("SIGKILL");
      await server.exited;
    }
    server.remove();
  }
}

/**
 * The environment the default image starts the server with, as far as the shutdown goes: `NEXT_MANUAL_SIG_HANDLE` as
 * the `Dockerfile` runner stage sets it, absent when it sets none.
 */
function imageSignalHandling(): Record<string, string> {
  const dockerfile = readFileSync(path.resolve(import.meta.dir, "..", "..", "Dockerfile"), "utf8");
  const runner = dockerfile.split(/^FROM .* AS runner$/m)[1];
  if (runner === undefined) throw new Error("the Dockerfile has no runner stage");
  const value = /^ENV NEXT_MANUAL_SIG_HANDLE=(\S*)$/m.exec(runner)?.[1];
  return value === undefined ? {} : { NEXT_MANUAL_SIG_HANDLE: value };
}

const PG_CONTAINER = `${process.env.LIBREDB_LIVE_PG_CONTAINER_PREFIX ?? "libredb-live-shutdown-pg"}-${randomBytes(4).toString("hex")}`;
let containerStarted = false;

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

interface Governance {
  /** The fixture database, as its superuser. */
  readonly fixtureUrl: string;
  readonly database: string;
  /** `"<schema>"` of the governance source. */
  readonly schema: string;
  /** The server environment of governance, without the instance id. */
  readonly env: Extra;
  /** The session cookie of the governed user. */
  readonly cookie: string;
}

let governance: Promise<Governance> | undefined;

/** Starts PostgreSQL 17 and builds the governance source in a throwaway database; once per run. */
async function startGovernance(): Promise<Governance> {
  const adminPassword = randomBytes(16).toString("hex");
  docker([
    "run",
    "-d",
    "--rm",
    "--memory",
    "2g",
    "--name",
    PG_CONTAINER,
    "-e",
    `POSTGRES_PASSWORD=${adminPassword}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:17",
  ]);
  containerStarted = true;
  const binding = docker(["port", PG_CONTAINER, "5432/tcp"]).trim().split("\n")[0] ?? "";
  const pgPort = Number(binding.slice(binding.lastIndexOf(":") + 1));
  if (!Number.isInteger(pgPort) || pgPort <= 0) throw new Error(`Docker published no port: "${binding}"`);
  let ready = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    try {
      // Over TCP, where only the real server listens (see tests/live/postgres-read-only-live.ts).
      docker(["exec", PG_CONTAINER, "pg_isready", "-q", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres"]);
      ready = true;
    } catch (error) {
      lastError = error;
      await delay(1000);
    }
  }
  if (!ready) {
    throw new Error(`PostgreSQL did not become ready within 60 s: ${(lastError as Error).message}`, {
      cause: lastError,
    });
  }

  const manifest = readFixtureManifest();
  const schema = `"${manifest.schema}"`;
  const database = `shutdown_live_${randomBytes(4).toString("hex")}`;
  const studio = randomBytes(16).toString("hex");
  const target = { user: "libredb_live_shutdown_target", password: randomBytes(16).toString("hex") };
  const key = testKey();
  const adminUrl = `postgresql://postgres:${adminPassword}@127.0.0.1:${pgPort}/postgres?sslmode=disable`;
  const fixtureUrl = `postgresql://postgres:${adminPassword}@127.0.0.1:${pgPort}/${database}?sslmode=disable`;
  const ddl = buildFixtureDdl(manifest, { studioPassword: studio });
  await withClient(adminUrl, async (client) => {
    await client.query(`CREATE DATABASE ${database}`);
    await client.query(ddl.roles.join(";\n"));
    await client.query(`CREATE ROLE ${target.user} LOGIN PASSWORD '${target.password}'`);
  });
  const definition = { host: "127.0.0.1", port: pgPort, database, ssl: { mode: "disable" } };
  await withClient(fixtureUrl, async (client) => {
    await client.query(ddl.objects.join(";\n"));
    await client.query(
      `INSERT INTO ${schema}.contract_source (version, status, sunset_after, notify_channel) VALUES ($1, 'current', NULL, $2)`,
      [manifest.contractVersion, manifest.notification.channel],
    );
    const seal = (level: "read" | "write") =>
      sealSecret(key.publicKey, { connectionId: GOVERNED, level, engine: "postgres", definition }, target);
    await client.query(
      `INSERT INTO ${schema}.connections_v1_source (connection_id, name, engine, environment, group_name, color, definition, read_secret, write_secret, mcp_enabled, updated_at)
       VALUES ($1, 'Shutdown live', 'postgres', 'production', NULL, NULL, $2, $3, $4, false, now())`,
      [GOVERNED, JSON.stringify(definition), seal("read"), seal("write")],
    );
    await client.query(
      `INSERT INTO ${schema}.seal_canary_v1_source (kid, envelope, created_at) VALUES ($1, $2, now())`,
      [
        key.kid,
        sealSecret(
          key.publicKey,
          { connectionId: "canary", level: "read", engine: "canary", definition: {} },
          { user: "libredb-canary" },
        ),
      ],
    );
    await client.query(
      `INSERT INTO ${schema}.grants_v1_source (subject, connection_id, level, expires_at, downgraded, granted_at) VALUES ($1, $2, 'write', NULL, false, now())`,
      [SUBJECT, GOVERNED],
    );
  });
  const jwtSecret = randomBytes(32).toString("hex");
  process.env.JWT_SECRET = jwtSecret;
  const token = await signJWT({ role: "user", username: SUBJECT, idpSubject: SUBJECT, idpIssuer: OIDC_ISSUER });
  return {
    fixtureUrl,
    database,
    schema,
    cookie: `${SESSION_COOKIE}=${token}`,
    env: {
      JWT_SECRET: jwtSecret,
      // Governance mode signs in through the identity provider only (src/lib/governance/preflight.ts).
      ADMIN_PASSWORD: undefined,
      USER_PASSWORD: undefined,
      // Governance keeps Studio's storage tables in a schema of their own (src/lib/governance/preflight.ts).
      STORAGE_POSTGRES_SCHEMA: "studio",
      NEXT_PUBLIC_AUTH_PROVIDER: "oidc",
      OIDC_ISSUER,
      OIDC_CLIENT_ID: "libredb-studio",
      OIDC_CLIENT_SECRET: randomUUID(),
      OIDC_ROLE_CLAIM: "libredb_roles",
      OIDC_USER_ROLES: "user",
      OIDC_ADMIN_ROLES: "admin",
      GOVERNANCE_SOURCE: "postgres",
      GOVERNANCE_POSTGRES_URL: `postgresql://libredb_studio:${studio}@127.0.0.1:${pgPort}/${database}?sslmode=disable`,
      GOVERNANCE_PRIVATE_KEYS_FILE: keyringFileOf(key),
    },
  };
}

const GOVERNED = "live-shutdown";
const SUBJECT = "alice@example.com";
const OIDC_ISSUER = "https://idp.example/realms/libredb";

async function withClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Polls `check` every 100 ms for at most `ms`; answers whether it held. */
async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return true;
    await delay(100);
  }
  return false;
}

/**
 * Terminates every backend of Studio's governance pool on the fixture database. A G case does it once the server has
 * exited and before it releases the lock or counts rows: PostgreSQL does not notice a closed client while a backend
 * waits on a lock, so an insert the exit cut would otherwise still commit once the lock goes, and a base that lost the
 * events would look green.
 */
async function terminateGovernanceBackends(watcher: Client, database: string): Promise<void> {
  await watcher.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE 'libredb-studio-governance%' AND datname = $1",
    [database],
  );
}

/**
 * L7: a sign-in held in flight across SIGTERM on a raw connection, whose last body bytes go in one write with the first
 * byte of the next request, so that connection is not idle when the answer ends: the answer carries
 * `Connection: close`, the connection ends with it, and the exit is 0.
 */
async function begunNextRequestCase(): Promise<{ problems: string[]; output: string }> {
  const credentials = { email: "admin@libredb.org", password: randomUUID() };
  const server = await readyServer({
    NEXT_MANUAL_SIG_HANDLE: "true",
    ADMIN_EMAIL: credentials.email,
    ADMIN_PASSWORD: credentials.password,
  });
  const socket = connect(server.port, "127.0.0.1");
  try {
    if (server.child.pid === undefined) throw new Error("the server has no PID");
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
    });
    socket.on("error", () => {});
    const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const body = JSON.stringify(credentials);
    socket.write(
      `POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 10)}`,
    );
    await delay(IN_FLIGHT_SETTLE_MS);
    process.kill(server.child.pid, "SIGTERM");
    await delay(300);
    socket.write(`${body.slice(10)}G`);
    const answered = await until(async () => /\r\n\r\n/.test(text), 5000);
    const closedWithAnswer = await Promise.race([ended.then(() => true), delay(1000).then(() => false)]);
    const head = text.split("\r\n\r\n")[0] ?? "";
    const exit = await endOf(server);
    const output = server.output();
    return {
      problems: [
        ...(answered && head.startsWith("HTTP/1.1 200") ? [] : [`the sign-in in flight was not answered 200: ${head}`]),
        ...(/^connection: close$/im.test(head) ? [] : [`the answer did not carry Connection: close: ${head}`]),
        ...(closedWithAnswer ? [] : ["the connection did not end within 1 s of the answer"]),
        ...(exit.code === 0 && exit.signal === null ? [] : [`expected exit code 0, got ${describeEnd(exit)}`]),
        ...(output.includes(studioStart(STUDIO_OWNS_SIGTERM, 1, 1))
          ? []
          : ["the start line with servers=1, inFlight=1 is missing"]),
        ...(output.includes(COMPLETE) ? [] : ["Studio's end line is missing"]),
      ],
      output,
    };
  } finally {
    socket.destroy();
    if (!server.hasExited()) {
      server.child.kill("SIGKILL");
      await server.exited;
    }
    server.remove();
  }
}

/** A server under governance with its own instance id, ready, with one query's event inserted. */
async function governedServer(fixture: Governance, watcher: Client): Promise<{ server: Server; instance: string }> {
  const instance = `shutdown-live-${randomBytes(4).toString("hex")}`;
  const server = await readyServer({ ...fixture.env, ...imageSignalHandling(), GOVERNANCE_INSTANCE_ID: instance });
  try {
    const ready = await until(async () => {
      const answer = await request(server.port, "GET", "/api/ready");
      return answer.ok && answer.status === 200 && (answer.body ?? "").includes('"ok"');
    }, READY_DEADLINE_MS);
    if (!ready) throw new Error("GET /api/ready did not answer ok under governance");
    const warm = await query(server, fixture, "SELECT 1 AS one");
    if (!warm.ok || warm.status !== 200) {
      throw new Error(`the first query was not answered 200: ${describeAnswer(warm)} ${warm.body ?? ""}`);
    }
    // So the case starts with the sink idle.
    if (!(await until(async () => (await rowsOf(watcher, fixture, instance)) === 1, 10_000))) {
      throw new Error("the first query's event was not inserted within 10 s");
    }
    return { server, instance };
  } catch (error) {
    // The caller never gets this server, so it is stopped by PID and its data directory removed here.
    await release(server);
    throw new Error(`${(error as Error).message}\n${server.output()}`, { cause: error });
  }
}

function query(server: Server, fixture: Governance, sql: string): Promise<Answer & { body?: string }> {
  return request(server.port, "POST", "/api/db/query", {
    cookie: fixture.cookie,
    body: { connectionId: `seed:${GOVERNED}`, sql },
  });
}

async function rowsOf(watcher: Client, fixture: Governance, instance: string): Promise<number> {
  const result = await watcher.query(
    `SELECT count(*)::int AS n FROM ${fixture.schema}.query_event WHERE studio_instance = $1`,
    [instance],
  );
  return result.rows[0].n as number;
}

/** G1 and G2 share the fixture, the watcher connection and the clean-up of the server. */
async function governanceCase(
  run: (fixture: Governance, watcher: Client) => Promise<{ problems: string[]; output: string }>,
): Promise<{ problems: string[]; output: string }> {
  governance ??= startGovernance();
  const fixture = await governance;
  return withClient(fixture.fixtureUrl, (watcher) => run(fixture, watcher));
}

/** Kills the server when a case ended before it exited, and removes its data directory. */
async function release(server: Server): Promise<void> {
  if (!server.hasExited()) {
    server.child.kill("SIGKILL");
    await server.exited;
  }
  server.remove();
}

/** G1: query events queued at SIGTERM, their insert held by a lock, are inserted before the exit. */
function queuedEventsCase(): Promise<{ problems: string[]; output: string }> {
  return governanceCase(async (fixture, watcher) => {
    const { server, instance } = await governedServer(fixture, watcher);
    const locker = new Client({ connectionString: fixture.fixtureUrl });
    try {
      await locker.connect();
    } catch (error) {
      await release(server);
      throw error;
    }
    try {
      if (server.child.pid === undefined) throw new Error("the server has no PID");
      await locker.query("BEGIN");
      await locker.query(`LOCK TABLE ${fixture.schema}.query_event IN ACCESS EXCLUSIVE MODE`);
      for (const n of [2, 3, 4]) {
        const answer = await query(server, fixture, `SELECT ${n} AS n`);
        if (!answer.ok || answer.status !== 200) {
          throw new Error(`SELECT ${n} was not answered 200: ${describeAnswer(answer)} ${answer.body ?? ""}`);
        }
      }
      const waiting = await until(async () => {
        const result = await watcher.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE 'libredb-studio-governance%' AND datname = $1 AND wait_event_type = 'Lock'",
          [fixture.database],
        );
        return (result.rows[0].n as number) > 0;
      }, 10_000);
      if (!waiting) throw new Error("the sink's insert never waited on the lock");
      process.kill(server.child.pid, "SIGTERM");
      await until(async () => server.hasExited() || server.output().includes("Received SIGTERM"), 1000);
      await Promise.race([server.exited, delay(1000)]);
      if (server.hasExited()) await terminateGovernanceBackends(watcher, fixture.database);
      await locker.query("COMMIT");
      const ended = await endOf(server);
      await terminateGovernanceBackends(watcher, fixture.database);
      const rows = await rowsOf(watcher, fixture, instance);
      const output = server.output();
      return {
        problems: [
          ...(ended.code === 0 && ended.signal === null ? [] : [`expected exit code 0, got ${describeEnd(ended)}`]),
          ...(rows === 4 ? [] : [`expected the 4 query events inserted, found ${rows}`]),
          ...(output.includes(COMPLETE) ? [] : ["Studio's end line is missing"]),
        ],
        output,
      };
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${server.output()}`, { cause: error });
    } finally {
      await locker.end();
      await release(server);
    }
  });
}

/** G2: a statement in flight across SIGTERM is answered and its query event inserted before the exit. */
function inFlightStatementCase(): Promise<{ problems: string[]; output: string }> {
  return governanceCase(async (fixture, watcher) => {
    const { server, instance } = await governedServer(fixture, watcher);
    try {
      if (server.child.pid === undefined) throw new Error("the server has no PID");
      const inFlight = query(server, fixture, "SELECT pg_sleep(2) AS slept");
      const running = await until(async () => {
        const result = await watcher.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND state = 'active' AND query LIKE '%pg_sleep(2)%' AND pid <> pg_backend_pid()",
          [fixture.database],
        );
        return (result.rows[0].n as number) > 0;
      }, 10_000);
      if (!running) throw new Error("the statement never ran in PostgreSQL");
      process.kill(server.child.pid, "SIGTERM");
      await delay(300);
      const runningAtFresh = !server.hasExited();
      const fresh = await request(server.port, "GET", "/health");
      const answer = await inFlight;
      const ended = await endOf(server);
      await terminateGovernanceBackends(watcher, fixture.database);
      const rows = await rowsOf(watcher, fixture, instance);
      const output = server.output();
      return {
        problems: [
          ...(runningAtFresh ? [] : ["the server had exited 300 ms after the signal, with the statement in flight"]),
          ...(!fresh.ok && fresh.code === "ECONNREFUSED"
            ? []
            : [`a fresh connection 300 ms after the signal was not refused: ${describeAnswer(fresh)}`]),
          ...(answer.ok && answer.status === 200
            ? []
            : [`the statement in flight was not answered 200: ${describeAnswer(answer)}`]),
          ...(ended.code === 0 && ended.signal === null ? [] : [`expected exit code 0, got ${describeEnd(ended)}`]),
          ...(rows === 2 ? [] : [`expected the 2 query events inserted, found ${rows}`]),
          ...(output.includes(COMPLETE) ? [] : ["Studio's end line is missing"]),
        ],
        output,
      };
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${server.output()}`, { cause: error });
    } finally {
      await release(server);
    }
  });
}

const CASES: { name: string; run: () => Promise<{ problems: string[]; output: string }> }[] = [
  {
    name: "L1 NEXT_MANUAL_SIG_HANDLE=true, SIGTERM: Studio's handler exits with 0",
    run: () =>
      signalCase({ NEXT_MANUAL_SIG_HANDLE: "true" }, "SIGTERM", (ended, output) => [
        ...(ended.code === 0 && ended.signal === null ? [] : [`expected exit code 0, got ${describeEnd(ended)}`]),
        ...(output.includes(studioStart(STUDIO_OWNS_SIGTERM, 1, 0))
          ? []
          : ["Studio's start line with servers=1, inFlight=0 is missing"]),
        ...(output.includes(COMPLETE) ? [] : ["Studio's end line is missing"]),
      ]),
  },
  {
    name: "L2 NEXT_MANUAL_SIG_HANDLE unset, SIGTERM: Next.js's handler exits with 143 between Studio's start and exit lines",
    run: () =>
      signalCase({}, "SIGTERM", (ended, output) => [
        ...(ended.code === 143 && ended.signal === null ? [] : [`expected exit code 143, got ${describeEnd(ended)}`]),
        ...(output.includes(NEXT_OWNS_SIGTERM) ? [] : ["Studio's start line naming Next.js as the owner is missing"]),
        ...(output.includes(NEXT_EXIT_AFTER_SIGTERM) ? [] : ["Studio's exit line is missing"]),
      ]),
  },
  {
    name: "L3 NEXT_MANUAL_SIG_HANDLE=true, SIGINT: Studio's handler exits with 0",
    run: () =>
      signalCase({ NEXT_MANUAL_SIG_HANDLE: "true" }, "SIGINT", (ended, output) => [
        ...(ended.code === 0 && ended.signal === null ? [] : [`expected exit code 0, got ${describeEnd(ended)}`]),
        ...(output.includes(studioStart(STUDIO_OWNS_SIGINT, 1, 0))
          ? []
          : ["Studio's start line with servers=1, inFlight=0 is missing"]),
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
  {
    name: "L5 NEXT_MANUAL_SIG_HANDLE=true, SIGTERM with a sign-in in flight: no new connection, the sign-in answered, its kept-alive connection ended, exit 0",
    run: () => drainCase(IN_FLIGHT_SETTLE_MS),
  },
  {
    name: "L6 NEXT_MANUAL_SIG_HANDLE=true, SIGTERM with a sign-in that never completes: cut at the drain's deadline, exit 143 with responsesCut=1",
    run: () => drainCase("never"),
  },
  {
    name: "L7 NEXT_MANUAL_SIG_HANDLE=true, SIGTERM with a sign-in in flight whose connection has begun its next request: answered with Connection: close, the connection ended, exit 0",
    run: begunNextRequestCase,
  },
  {
    name: "G1 the default image's environment under governance, SIGTERM with query events queued behind a lock: all inserted before the exit, exit 0",
    run: queuedEventsCase,
  },
  {
    name: "G2 the default image's environment under governance, SIGTERM with a statement in flight: no new connection, answered, its event inserted, exit 0",
    run: inFlightStatementCase,
  },
];

let failed = 0;
try {
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
} finally {
  removeKeyringFiles();
  if (containerStarted) docker(["rm", "-f", PG_CONTAINER]);
}
process.exit(failed === 0 ? 0 : 1);
