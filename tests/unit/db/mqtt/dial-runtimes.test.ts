/**
 * The MQTT dial's address rule on the runtimes production runs: a Bun child and one Node child per binary that
 * NODE_TRANSPORT_NODES lists (or the node on PATH), so CI's Node 24 step and its Node 26.10.0 step both run it.
 * `egress.test.ts` holds the same rule under Bun with mocked modules; this file holds it on Node too, where a socket
 * treats an error from its lookup differently.
 *
 * Each child runs a bundle of `session.ts`'s `readTopics`, with no transport injected, so the product's own dial runs.
 * It starts from an unbundled entry.mjs that answers two names itself: metadata.test with 169.254.169.254, and
 * pinned.test with 127.0.0.1, a name no resolver knows, so a dial that reaches the listener by it proves the address
 * dialled is the checked lookup's answer. The listener closes every connection it accepts, and counts them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BLOCKED_HOST, LINK_LOCAL_HOST } from "@/lib/db/http/egress-policy";
import type { readTopics } from "@/lib/db/providers/keyvalue/mqtt/session";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SESSION = join(ROOT, "src", "lib", "db", "providers", "keyvalue", "mqtt", "session.ts");

interface Outcome {
  readonly ok: boolean;
  readonly errorName?: string;
  readonly message?: string;
}

/**
 * Runs every case in turn. SELF-CONTAINED ON PURPOSE: each child runs this function's own text, so it names nothing
 * but its parameters and the runtime's globals.
 */
async function runCases(
  read: typeof readTopics,
  port: number,
): Promise<{ runtime: string; outcomes: Record<string, Outcome> }> {
  const outcomes: Record<string, Outcome> = {};
  const record = async (name: string, host: string, tls: boolean) => {
    try {
      await read({ host, port, tls, dialTimeoutMs: 2_000 });
      outcomes[name] = { ok: true };
    } catch (error) {
      const failure = error as Error;
      outcomes[name] = { ok: false, errorName: failure.name, message: failure.message };
    }
  };
  delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  await record("link-local literal, flag off", "169.254.169.254", false);
  await record("link-local answer, flag off", "metadata.test", false);
  await record("link-local answer over tls, flag off", "metadata.test", true);
  await record("name answered by the checked lookup, flag off", "pinned.test", false);
  process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "true";
  await record("private literal, flag on", "127.0.0.1", false);
  await record("private answer, flag on", "pinned.test", false);
  await record("private answer over tls, flag on", "pinned.test", true);
  delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  return { runtime: typeof Bun === "undefined" ? process.version : `bun ${Bun.version}`, outcomes };
}

function binaries(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  const nodes = listed === undefined ? [Bun.which("node")] : listed.split(delimiter).filter((entry) => entry !== "");
  if (nodes.length === 0 || nodes.includes(null)) {
    throw new Error("No Node binary: set NODE_TRANSPORT_NODES or put Node 24 or later on PATH");
  }
  return [process.execPath, ...(nodes as string[])];
}

interface Run {
  readonly runtime: string;
  readonly outcomes: Record<string, Outcome>;
  readonly accepted: number;
}
const runs: Run[] = [];
const sockets = new Set<Socket>();
let accepted = 0;
let dir: string;
const server = createServer((socket: Socket) => {
  accepted += 1;
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.destroy();
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  dir = mkdtempSync(join(tmpdir(), "mqtt-dial-"));
  const at = (file: string) => join(dir, file);
  writeFileSync(
    at("child.ts"),
    [
      `import { readTopics } from ${JSON.stringify(SESSION)};`,
      `const runCases = ${runCases.toString()};`,
      "const report = await runCases(readTopics, Number(process.argv[2]));",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
  // Unbundled, so the patch lands before the bundle's node:dns import.
  writeFileSync(
    at("entry.mjs"),
    [
      'import { createRequire, syncBuiltinESMExports } from "node:module";',
      'const dns = createRequire(import.meta.url)("node:dns");',
      "const original = dns.lookup;",
      'const answers = { "metadata.test": "169.254.169.254", "pinned.test": "127.0.0.1" };',
      "dns.lookup = function lookup(hostname, options, callback) {",
      "  const address = answers[hostname];",
      "  if (address === undefined) return original.call(this, hostname, options, callback);",
      '  const done = typeof options === "function" ? options : callback;',
      '  const all = typeof options === "object" && options !== null && options.all === true;',
      "  const answer = { address, family: 4 };",
      "  process.nextTick(() => (all ? done(null, [answer]) : done(null, answer.address, answer.family)));",
      "};",
      "syncBuiltinESMExports();",
      'await import("./child.js");',
      "",
    ].join("\n"),
  );
  for (const binary of binaries()) {
    const before = accepted;
    const child = Bun.spawn([binary, at("entry.mjs"), String(port)], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`The child ${binary} exited ${exitCode}: ${stderr}`);
    const report = JSON.parse(stdout.trim().split("\n").at(-1) as string) as Omit<Run, "accepted">;
    runs.push({ ...report, accepted: accepted - before });
  }
}, 120_000);

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("the MQTT dial's address rule on Bun and every listed Node", () => {
  test("a Bun child and at least one Node child ran", () => {
    expect(runs[0]?.runtime.startsWith("bun ")).toBe(true);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs.slice(1)) expect(["24", "26"]).toContain(run.runtime.slice(1).split(".")[0]);
  });

  test("a link-local literal or answer is refused with the flag off, over TCP and TLS, with the shared sentence", () => {
    // A function, not one shared object: Bun's toMatchObject checks a repeated reference only where it first appears.
    const refused = () => ({ ok: false, errorName: "DatabaseConfigError", message: LINK_LOCAL_HOST });
    for (const { runtime, outcomes } of runs) {
      expect({ runtime, outcomes }).toMatchObject({
        runtime,
        outcomes: {
          "link-local literal, flag off": refused(),
          "link-local answer, flag off": refused(),
          "link-local answer over tls, flag off": refused(),
        },
      });
    }
  });

  test("with the flag on a private literal or answer is refused, over TCP and TLS, with the shared sentence", () => {
    const refused = () => ({ ok: false, errorName: "DatabaseConfigError", message: BLOCKED_HOST });
    for (const { runtime, outcomes } of runs) {
      expect({ runtime, outcomes }).toMatchObject({
        runtime,
        outcomes: {
          "private literal, flag on": refused(),
          "private answer, flag on": refused(),
          "private answer over tls, flag on": refused(),
        },
      });
    }
  });

  test("a name the checked lookup answers is dialled at that answer, once, and only with the flag off", () => {
    for (const { runtime, outcomes, accepted } of runs) {
      expect(outcomes["name answered by the checked lookup, flag off"]?.errorName).not.toBe("DatabaseConfigError");
      expect({ runtime, accepted }).toEqual({ runtime, accepted: 1 });
    }
  });

  test("CI runs these cases on the Node version production runs", () => {
    const ci = parseYaml(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
      jobs: { test: { steps: { name?: string; run?: string }[] } };
    };
    const node26 = ci.jobs.test.steps.find(
      (step) => step.name?.includes("on Node 26.10.0") && step.run?.includes("NODE_TRANSPORT_NODES"),
    );
    expect(node26?.run).toContain("tests/unit/db/mqtt/dial-runtimes.test.ts");
  });
});
