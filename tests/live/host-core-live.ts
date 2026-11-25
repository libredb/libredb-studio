/**
 * Live check that the built standalone server's routes answer through the provider host core its boot installed, in
 * their own error classes (docs/providers/CONTRACT.md, clause C-52).
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. Next.js loads instrumentation, whose `register()` installs the host
 * core, and each route handler as separate module instances, each with its own copy of Studio's error classes.
 * tests/unit/lib/provider-host/cross-bundle.test.ts reproduces that with two bundles of its own; only the built server
 * shows that the bundles Next.js itself produces share the core through its registered symbol and that a record the
 * core answers becomes the route's own class. A route that found no core would answer `500 INTERNAL_ERROR` naming the
 * boot order, and a class from another bundle would answer `500` with kind `internal`.
 *
 * The script starts one server with `node server.js` from `LIBREDB_LIVE_STANDALONE_DIR`, a directory holding
 * `server.js`: a local `.next/standalone` after `DOCKER_BUILD=true bun run build`, or the CI payload tarball extracted
 * with `--strip-components=1`. The server gets an explicit environment, with only PATH and HOME taken from the caller,
 * so a developer's `.env` keys or `SEED_CONFIG_PATH` never reach it: its own free port and data directory, SQLite
 * storage, both samples off, and a JWT secret and passwords drawn at run time. It signs in as the admin and runs each
 * case on an inline SQLite connection whose file lives in a temporary directory, so no database service is needed:
 *
 * - L1: `SELECT 1` answers 200 with one row, so the route ran the core the boot installed.
 * - L2: a value larger than a page's 32 MiB answers `400 QUERY_ERROR` with kind `studio-byte-budget-refusal` and
 *   outcome `unknown`: the core answered a record, and the route's accessor built the route's own class.
 * - L3: a statement naming a missing table answers `400 QUERY_ERROR` with kind `query` and outcome `unknown`, as the
 *   same error answers in process: the provider's error passed through the core by reference.
 *
 * It prints one line per case, `ok   <case>` or `FAIL <case>` with the reason and the server's output, and exits
 * non-zero when any case failed.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 * CI runs it in the "Host Core Live Check" job of .github/workflows/ci.yml, against the engine smoke payload.
 *
 *   LIBREDB_LIVE_STANDALONE_DIR="$PWD/.next/standalone" bun tests/live/host-core-live.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_COOKIE } from "@/lib/auth-cookies";

/** The directory holding the standalone server.js, from `LIBREDB_LIVE_STANDALONE_DIR`. */
function standaloneDir(): string {
  const dir = process.env.LIBREDB_LIVE_STANDALONE_DIR;
  if (!dir || !existsSync(path.join(dir, "server.js"))) {
    throw new Error("LIBREDB_LIVE_STANDALONE_DIR must name a directory holding the standalone server.js");
  }
  return dir;
}

const STANDALONE_DIR = standaloneDir();

/** How long the server may take to answer `GET /health` with 200 after it was started. */
const READY_DEADLINE_MS = 60_000;
/** How long one request of a case may take. */
const REQUEST_DEADLINE_MS = 60_000;
/** How long the server may take to exit after SIGTERM before it is killed. */
const EXIT_DEADLINE_MS = 30_000;
/** One byte more than a page of a result may hold. */
const OVER_PAGE_BYTES = 33_554_433;

const ADMIN_EMAIL = "admin@libredb.org";

/** A port nothing listens on now; the server binds it a moment later, and a collision fails the start by name. */
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

interface Server {
  readonly child: ChildProcess;
  readonly port: number;
  readonly adminPassword: string;
  readonly dataDir: string;
  output(): string;
  hasExited(): boolean;
  readonly exited: Promise<void>;
}

function startServer(port: number): Server {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libredb-host-core-live-"));
  const password = randomUUID();
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
    ADMIN_EMAIL,
    ADMIN_PASSWORD: password,
    USER_PASSWORD: randomUUID(),
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
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => {
      hasExited = true;
      resolve();
    });
  });
  return { child, port, adminPassword: password, dataDir, output: () => output, hasExited: () => hasExited, exited };
}

/** Answers once `GET /health` is 200; throws when the server exits first or misses the deadline. */
async function ready(server: Server): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < READY_DEADLINE_MS) {
    if (server.hasExited()) throw new Error("the server exited before it answered GET /health");
    try {
      // oxlint-disable-next-line no-await-in-loop -- each probe waits for the one before it: the server is polled until it answers.
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, { signal: AbortSignal.timeout(2000) });
      // oxlint-disable-next-line no-await-in-loop -- the probe's body is read to its end before the next one.
      await response.text();
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    // oxlint-disable-next-line no-await-in-loop -- the pause between two probes of the server.
    await delay(100);
  }
  throw new Error(`the server did not answer GET /health with 200 within ${READY_DEADLINE_MS} ms`);
}

/** Stops the server with SIGTERM, killing it past the deadline, and removes its data directory. */
async function stop(server: Server): Promise<void> {
  if (!server.hasExited()) {
    server.child.kill("SIGTERM");
    const late = delay(EXIT_DEADLINE_MS).then(() => "late" as const);
    if ((await Promise.race([server.exited, late])) === "late") {
      server.child.kill("SIGKILL");
      await server.exited;
    }
  }
  rmSync(server.dataDir, { recursive: true, force: true });
}

/** Signs in as the admin and answers the session cookie, `name=value`. */
async function signIn(server: Server): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: server.adminPassword }),
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  await response.text();
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0] as string)
    .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
  if (response.status !== 200 || cookie === undefined) {
    throw new Error(`the admin sign-in answered ${response.status} with no ${SESSION_COOKIE} cookie`);
  }
  return cookie;
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** Runs `sql` on `connection` through `POST /api/db/query` and answers its status and JSON body. */
async function query(server: Server, cookie: string, connection: object, sql: string): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/db/query`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ connection, sql }),
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    throw new Error(
      `POST /api/db/query answered ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`,
    );
  }
}

/** The problems with an error answer: each of `expected` that `answer` does not carry, named with what it carried. */
function errorProblems(answer: Answer, expected: { status: number } & Record<string, unknown>): string[] {
  const { status, ...fields } = expected;
  return [
    ...(answer.status === status ? [] : [`expected status ${status}, got ${answer.status}`]),
    ...Object.entries(fields)
      .filter(([name, value]) => answer.body[name] !== value)
      .map(([name, value]) => `expected ${name} ${JSON.stringify(value)}, got ${JSON.stringify(answer.body[name])}`),
  ];
}

interface Case {
  readonly name: string;
  readonly sql: string;
  readonly check: (answer: Answer) => string[];
}

const CASES: readonly Case[] = [
  {
    name: "L1 a statement answers through the host core the server installed at boot",
    sql: "SELECT 1 AS one",
    check: (answer) => [
      ...(answer.status === 200 ? [] : [`expected status 200, got ${answer.status}: ${JSON.stringify(answer.body)}`]),
      ...(JSON.stringify(answer.body.rows) === JSON.stringify([{ one: 1 }])
        ? []
        : [`expected one row { one: 1 }, got ${JSON.stringify(answer.body.rows)}`]),
    ],
  },
  {
    name: "L2 a refusal the host core answers as a record is the route's own class",
    sql: `SELECT printf('%.*c', ${OVER_PAGE_BYTES}, 'x') AS big`,
    check: (answer) =>
      errorProblems(answer, {
        status: 400,
        code: "QUERY_ERROR",
        kind: "studio-byte-budget-refusal",
        outcome: "unknown",
      }),
  },
  {
    name: "L3 a provider error passes through the host core by reference",
    sql: "SELECT * FROM no_such_table",
    check: (answer) => errorProblems(answer, { status: 400, code: "QUERY_ERROR", kind: "query", outcome: "unknown" }),
  },
];

const databaseDir = mkdtempSync(path.join(tmpdir(), "libredb-host-core-live-db-"));
const server = startServer(await freePort());
let failed = 0;
try {
  await ready(server);
  const cookie = await signIn(server);
  const connection = {
    id: randomUUID(),
    name: "host core live",
    type: "sqlite",
    database: path.join(databaseDir, "host-core-live.db"),
  };
  for (const each of CASES) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the cases run one after another on one server, so each line names one case.
      const problems = each.check(await query(server, cookie, connection, each.sql));
      if (problems.length === 0) {
        console.log(`ok   ${each.name}`);
      } else {
        failed += 1;
        console.log(`FAIL ${each.name}: ${problems.join("; ")}\n${server.output()}`);
      }
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${each.name}: ${(error as Error).message}\n${server.output()}`);
    }
  }
} catch (error) {
  failed += 1;
  console.log(`FAIL the server did not start or sign in: ${(error as Error).message}\n${server.output()}`);
} finally {
  await stop(server);
  rmSync(databaseDir, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
