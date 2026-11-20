/**
 * Live Redis check: a reply nested deeper than the runtime's stack fails its command with a named error, and the
 * connection serves the next command.
 *
 * A Lua table comes back from `EVAL` and `EVAL_RO` as nested RESP arrays, so a real Redis builds such a reply on
 * request: redis 8.10.2 nests up to 7995 levels before its own `reached lua stack limit`. ioredis 5.11.1 reads replies
 * with a recursive parser inside its socket `data` listener, and patches/ioredis@5.11.1.patch sends a parser throw down
 * ioredis's fatal-error path instead of out of that listener (docs/TOOLCHAIN.md, "Patched dependencies"). The fatal
 * error rejects the command in flight, and the editor connection, which keeps ioredis's default retry strategy,
 * reconnects for the next one. This script drives the real provider against a real server through `query()`, the
 * method the editor route calls, and checks for each script: what the caller got, that a PING after it answers, and
 * that no error escaped a call meanwhile.
 *
 * The bytes are the same on every runtime, but whether the stack holds them is the runtime's: measured 2026-11-21,
 * Node 24.22.1 overflows at 3000 levels and Bun 1.4.4 reads 7990 levels. So under Node the 7990-level script must fail
 * with the named error, and under Bun it may answer instead; redis-driver.test.ts holds the same path on both runtimes
 * with a reply no stack holds.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 * CI runs it in the "Functional Smoke (PostgreSQL, MongoDB, RabbitMQ)" job of .github/workflows/ci.yml, under Bun and
 * then under Node through `bun build --target=node`. It needs Docker and nothing else:
 *
 *   bun tests/live/redis-nested-reply-live.ts
 *
 * The container publishes on a loopback port Docker picks and its name carries a per-run suffix.
 * `LIBREDB_LIVE_REDIS_CONTAINER_PREFIX` replaces the name's prefix for a local run.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { RedisProvider } from "@/lib/db/providers/keyvalue/redis";
import type { DatabaseConnection } from "@/lib/types";

const REDIS_CONTAINER = `${process.env.LIBREDB_LIVE_REDIS_CONTAINER_PREFIX ?? "libredb-live-nested-reply-redis"}-${randomBytes(4).toString("hex")}`;
const RUNTIME = typeof Bun === "undefined" ? "node" : "bun";
const NESTING_FAILED = /^Redis error: Maximum call stack size exceeded\.?\. Please report this\.$/;

/** Every error that escaped a call instead of reaching its caller, in order. */
const processEvents: string[] = [];
process.on("uncaughtException", (error) => processEvents.push(`uncaughtException: ${error.message}`));
process.on("unhandledRejection", (reason) =>
  processEvents.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`),
);

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startRedis(): Promise<number> {
  docker(["run", "-d", "--rm", "--name", REDIS_CONTAINER, "-p", "127.0.0.1::6379", "redis:8.10.2"]);
  const binding = docker(["port", REDIS_CONTAINER, "6379/tcp"]).trim().split("\n")[0] ?? "";
  const port = Number(binding.slice(binding.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Docker published no port for ${REDIS_CONTAINER}`);
  for (let i = 0; i < 60; i++) {
    try {
      if (docker(["exec", REDIS_CONTAINER, "redis-cli", "ping"]).trim() === "PONG") return port;
    } catch {
      // Not accepting connections yet.
    }
    // oxlint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  throw new Error(`live redis container ${REDIS_CONTAINER} did not answer PING within 60 s`);
}

/** A script whose answer is a Lua table nested `depth` levels deep around the integer 1. */
function nestedScript(verb: "EVAL" | "EVAL_RO", depth: number): string {
  return `${verb} "local root = {} local cur = root for i = 1, ${depth} do local nxt = {} cur[1] = nxt cur = nxt end cur[1] = 1 return root" 0`;
}

/** How a call settled: the error it rejected with, or `undefined` when it answered. Never left pending. */
async function settle(run: () => Promise<unknown>): Promise<Error | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("still pending after 10 s")), 10_000);
  });
  try {
    await Promise.race([run(), pending]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

async function check(provider: RedisProvider, verb: "EVAL" | "EVAL_RO", depth: number): Promise<void> {
  const label = `${verb} of a table nested ${depth} levels deep, on ${RUNTIME}`;
  processEvents.length = 0;
  const error = await settle(() => provider.query(nestedScript(verb, depth)));
  const mayAnswer = depth <= 1000 || RUNTIME === "bun";
  const named = error !== undefined && error.constructor.name === "QueryError" && NESTING_FAILED.test(error.message);
  if (error === undefined ? !mayAnswer : !named) {
    const got = error === undefined ? "answered" : `${error.constructor.name}: ${error.message}`;
    throw new Error(`${label}: ${got} (escaped errors: ${processEvents.join(" | ") || "none"})`);
  }
  const ping = await settle(() => provider.query("PING"));
  if (ping !== undefined) throw new Error(`${label}: the PING after it failed: ${ping.message}`);
  await sleep(300);
  if (processEvents.length > 0) throw new Error(`${label}: escaped errors: ${processEvents.join(" | ")}`);
  console.log(`ok   ${label}: ${error === undefined ? "answered" : error.message}; the next PING answered`);
}

async function main(): Promise<void> {
  try {
    const port = await startRedis();
    console.log(`Redis container ${REDIS_CONTAINER} started on 127.0.0.1:${port}`);
    const connection: DatabaseConnection = {
      id: "live-redis-nested-reply",
      type: "redis",
      name: "Live Redis nested reply",
      host: "127.0.0.1",
      port,
      createdAt: new Date(),
    };
    const provider = new RedisProvider(connection, { queryTimeout: 8_000 });
    await provider.connect();
    try {
      for (const verb of ["EVAL", "EVAL_RO"] as const) {
        // oxlint-disable-next-line no-await-in-loop
        for (const depth of [1000, 7990]) await check(provider, verb, depth);
      }
    } finally {
      await provider.disconnect();
    }
  } catch (error) {
    console.error("FAIL live Redis nested-reply check");
    console.error(error);
    // exitCode, not process.exit(1): exit would skip the finally below and leave the container running.
    process.exitCode = 1;
  } finally {
    try {
      docker(["rm", "-f", REDIS_CONTAINER]);
    } catch {
      // Container may not exist or may already have been removed.
    }
  }
}

await main();
