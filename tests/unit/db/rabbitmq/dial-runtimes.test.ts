/**
 * The AMQP dial on the runtimes production runs: a Bun child and one Node child per binary that NODE_TRANSPORT_NODES
 * lists (or the node on PATH), so CI's Node 24 step and its Node 26.10.0 step both run it. Each child runs a bundle of
 * `amqp/dial.ts` against listeners this file starts, and starts from an unbundled entry.mjs that answers two names
 * itself: metadata.test with 169.254.169.254, and pinned.test with 127.0.0.1, a name no resolver knows, so a dial that
 * reaches the listener by it proves the address dialled is the checked lookup's answer.
 *
 * Covered on every runtime: the egress literal and lookup refusals with the flag on and off, the dialled address, the
 * server name for a DNS host only, a host with a trailing dot dialled with the identity `connection-options.ts` gives it
 * (the dot taken off), an IPv6 literal without brackets, the client certificate presented to a server that asks for one,
 * R-S8's three TLS failures, each one connection with no plain retry and each by its kind (the certificate twice, TLS
 * for the plain listener), and a TLS 1.2 broker refusing a dial without the client certificate it requires.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { BLOCKED_HOST } from "@/lib/db/http/egress-policy";
import type { dialAmqp } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import { makeCertificates } from "../../../helpers/node-transport-fixtures";

const DIAL = join(
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
  "dial.ts",
);

interface Plan {
  readonly plain: number;
  readonly amqp: number;
  readonly local: number;
  readonly v6: number;
  readonly farName: number;
  readonly asking: number;
  readonly refusing: number;
  readonly ca: string;
  readonly rogueCa: string;
  readonly client: { readonly cert: string; readonly key: string };
}

interface Outcome {
  readonly ok: boolean;
  readonly errorName?: string;
  readonly kind?: string;
  readonly message?: string;
}

/**
 * Runs every case in turn. SELF-CONTAINED ON PURPOSE: each child runs this function's own text, so it names nothing
 * but its parameters and the runtime's globals.
 */
async function runCases(
  dial: typeof dialAmqp,
  plan: Plan,
): Promise<{ runtime: string; outcomes: Record<string, Outcome> }> {
  const outcomes: Record<string, Outcome> = {};
  const tls = (identity: string, ca: string) => ({ rejectUnauthorized: true, ca: Buffer.from(ca), identity });
  type Material = ReturnType<typeof tls> & { readonly cert?: Buffer; readonly key?: Buffer };
  /** With `answered`, the case waits for the server's one-word answer and records it as `message`. */
  const record = async (name: string, host: string, port: number, material: Material | null, answered = false) => {
    try {
      const socket = await dial(
        { host, port, tls: material, username: "u", password: "p", display: `${host}:${port}` },
        new AbortController().signal,
      );
      const answer = answered
        ? await new Promise<string>((resolve) => {
            let text = "";
            socket.on("data", (chunk) => {
              text += Buffer.from(chunk).toString();
            });
            socket.on("end", () => resolve(text));
          })
        : undefined;
      socket.destroy();
      outcomes[name] = answer === undefined ? { ok: true } : { ok: true, message: answer };
    } catch (error) {
      const failure = error as Error & { kind?: string };
      outcomes[name] = {
        ok: false,
        errorName: failure.name,
        ...(failure.kind === undefined ? {} : { kind: failure.kind }),
        message: failure.message,
      };
    }
  };
  delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  await record("plain literal", "127.0.0.1", plan.plain, null);
  await record("name answered by the checked lookup", "pinned.test", plan.plain, null);
  await record("link-local answer, flag off", "metadata.test", plan.plain, null);
  await record("link-local literal, flag off", "169.254.169.254", plan.plain, null);
  await record("tls by name", "localhost", plan.local, tls("localhost", plan.ca));
  // The identity connection-options.ts gives a host with a trailing dot: the host without it.
  await record("tls by name with a trailing dot", "localhost.", plan.local, tls("localhost", plan.ca));
  const pair = { cert: Buffer.from(plan.client.cert), key: Buffer.from(plan.client.key) };
  await record(
    "tls with a client certificate",
    "localhost",
    plan.asking,
    { ...tls("localhost", plan.ca), ...pair },
    true,
  );
  await record("tls without a client certificate", "localhost", plan.asking, tls("localhost", plan.ca), true);
  await record("tls by IPv4 literal", "127.0.0.1", plan.local, tls("127.0.0.1", plan.ca));
  await record("tls by IPv6 literal", "::1", plan.v6, tls("::1", plan.ca));
  await record("tls wrong CA", "localhost", plan.local, tls("localhost", plan.rogueCa));
  await record("tls wrong name", "localhost", plan.farName, tls("localhost", plan.ca));
  await record("tls to a plain AMQP port", "localhost", plan.amqp, tls("localhost", plan.ca));
  await record("tls 1.2 refused without a client certificate", "localhost", plan.refusing, tls("localhost", plan.ca));
  process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "true";
  await record("flag on, private literal", "127.0.0.1", plan.plain, null);
  await record("flag on, name", "pinned.test", plan.plain, null);
  await record("flag on, name over tls", "pinned.test", plan.local, tls("pinned.test", plan.ca));
  delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  return { runtime: typeof Bun === "undefined" ? process.version : `bun ${Bun.version}`, outcomes };
}

interface Counted {
  readonly server: Server;
  accepted: number;
  /** Server names sent in a ClientHello, in order; a client that sends none adds nothing. */
  readonly names: string[];
}

const listeners: Counted[] = [];
const sockets = new Set<Socket>();
let dir: string;
let plan: Plan;
let counted: Record<"plain" | "amqp" | "local" | "v6" | "farName" | "asking" | "refusing", Counted>;

async function listen(
  kind:
    | "plain"
    | "amqp"
    | { readonly cert: string; readonly key: string; readonly clientCa?: string; readonly refuse?: true },
  host = "127.0.0.1",
): Promise<[Counted, number]> {
  const entry: Counted = { server: undefined as never, accepted: 0, names: [] };
  const server =
    typeof kind === "object"
      ? createTlsServer(
          {
            cert: kind.cert,
            key: kind.key,
            // Read at the ClientHello: a client that drops its socket at once may never send its Finished.
            SNICallback: (servername, done) => {
              entry.names.push(servername);
              done(null, undefined);
            },
            // With clientCa, the server asks for a client certificate and answers whether one it trusts came; with
            // refuse, it requires one and refuses the connection without it, over TLS 1.2 so every runtime fails the dial.
            ...(kind.clientCa === undefined
              ? {}
              : { ca: kind.clientCa, requestCert: true, rejectUnauthorized: kind.refuse === true }),
            ...(kind.refuse === true ? { maxVersion: "TLSv1.2" as const } : {}),
          },
          (socket: TLSSocket) => {
            socket.on("error", () => {});
            if (kind.clientCa !== undefined && kind.refuse !== true)
              socket.end(socket.authorized ? "authorized" : "unauthorized");
          },
        )
      : createServer((socket: Socket) => {
          socket.on("error", () => {});
          if (kind === "amqp")
            socket.once("data", () => socket.end(Buffer.from("AMQP\u0000\u0000\u0009\u0001", "latin1")));
        });
  server.on("connection", (socket: Socket) => {
    entry.accepted += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  Object.assign(entry, { server });
  listeners.push(entry);
  return [entry, (server.address() as AddressInfo).port];
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
  readonly accepted: Record<string, number>;
  readonly names: string[];
}
const runs: Run[] = [];

beforeAll(async () => {
  const certificates = makeCertificates();
  const [plain, plainPort] = await listen("plain");
  const [amqp, amqpPort] = await listen("amqp");
  const [local, localPort] = await listen(certificates.local);
  const [v6, v6Port] = await listen(certificates.local, "::1");
  const [farName, farNamePort] = await listen(certificates.farName);
  const [asking, askingPort] = await listen({ ...certificates.local, clientCa: certificates.ca });
  const [refusing, refusingPort] = await listen({ ...certificates.local, clientCa: certificates.ca, refuse: true });
  counted = { plain, amqp, local, v6, farName, asking, refusing };
  plan = {
    plain: plainPort,
    amqp: amqpPort,
    local: localPort,
    v6: v6Port,
    farName: farNamePort,
    asking: askingPort,
    refusing: refusingPort,
    ca: certificates.ca,
    rogueCa: certificates.rogueCa,
    client: certificates.client,
  };
  dir = mkdtempSync(join(tmpdir(), "rabbitmq-dial-"));
  const at = (file: string) => join(dir, file);
  writeFileSync(at("plan.json"), JSON.stringify(plan));
  writeFileSync(
    at("child.ts"),
    [
      'import { readFileSync } from "node:fs";',
      `import { dialAmqp } from ${JSON.stringify(DIAL)};`,
      `const runCases = ${runCases.toString()};`,
      'const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));',
      "const report = await runCases(dialAmqp, plan);",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [at("child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
  // Unbundled, so the patch lands before the bundle's node:dns import (the node-transport runtime test's entry.mjs).
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
    const before = Object.fromEntries(Object.entries(counted).map(([name, entry]) => [name, entry.accepted]));
    const namesFrom = local.names.length;
    const child = Bun.spawn([binary, at("entry.mjs"), at("plan.json")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`The child ${binary} exited ${exitCode}: ${stderr}`);
    const report = JSON.parse(stdout.trim().split("\n").at(-1) as string) as Omit<Run, "accepted" | "names">;
    runs.push({
      ...report,
      accepted: Object.fromEntries(
        Object.entries(counted).map(([name, entry]) => [name, entry.accepted - (before[name] as number)]),
      ),
      names: local.names.slice(namesFrom),
    });
  }
}, 120_000);

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  for (const { server } of listeners) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const BLOCKED = BLOCKED_HOST;
const tlsFailure = { ok: false, errorName: "DialFailed", kind: "tls" };
const certificateFailure = { ok: false, errorName: "DialFailed", kind: "certificate" };
const clientCertificateFailure = { ok: false, errorName: "DialFailed", kind: "client-certificate" };

describe("the AMQP dial on Bun and every listed Node", () => {
  test("a Bun child and at least one Node child ran", () => {
    expect(runs[0]?.runtime.startsWith("bun ")).toBe(true);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs.slice(1)) expect(["24", "26"]).toContain(run.runtime.slice(1).split(".")[0]);
  });

  test("egress: literals and lookup answers, flag on and off; the dialled address is the hook's answer", () => {
    for (const { runtime, outcomes } of runs) {
      expect({ runtime, outcomes }).toMatchObject({
        runtime,
        outcomes: {
          "plain literal": { ok: true },
          "name answered by the checked lookup": { ok: true },
          "link-local answer, flag off": { ok: false, errorName: "DatabaseConfigError" },
          "link-local literal, flag off": { ok: false, errorName: "DatabaseConfigError" },
          "flag on, private literal": { ok: false, errorName: "DatabaseConfigError", message: BLOCKED },
          "flag on, name": { ok: false, errorName: "DatabaseConfigError", message: BLOCKED },
          "flag on, name over tls": { ok: false, errorName: "DatabaseConfigError", message: BLOCKED },
        },
      });
      expect(outcomes["link-local answer, flag off"]?.message).toBe(outcomes["link-local literal, flag off"]?.message);
    }
  });

  test("TLS: the name only for a DNS host, a trailing-dot host by its identity; an IPv6 literal dials bare", () => {
    for (const { runtime, outcomes, names } of runs) {
      expect({ runtime, outcomes }).toMatchObject({
        runtime,
        outcomes: {
          "tls by name": { ok: true },
          "tls by name with a trailing dot": { ok: true },
          "tls by IPv4 literal": { ok: true },
          "tls by IPv6 literal": { ok: true },
        },
      });
      // Four handshakes reach this listener (by name, with the dot, by IPv4 literal, with the wrong CA); the literal sends none.
      expect({ runtime, names }).toEqual({ runtime, names: ["localhost", "localhost", "localhost"] });
    }
  });

  test("TLS: the material's client certificate and key are presented to a server that asks for one", () => {
    for (const { runtime, outcomes } of runs) {
      expect({ runtime, outcomes }).toMatchObject({
        runtime,
        outcomes: {
          "tls with a client certificate": { ok: true, message: "authorized" },
          "tls without a client certificate": { ok: true, message: "unauthorized" },
        },
      });
    }
  });

  test("R-S8: a wrong CA, a wrong name and a plain listener each fail once, by kind; a refused client certificate", () => {
    for (const { runtime, outcomes, accepted } of runs) {
      expect({ runtime, outcomes }).toMatchObject({
        runtime,
        outcomes: {
          "tls wrong CA": certificateFailure,
          "tls wrong name": certificateFailure,
          "tls to a plain AMQP port": tlsFailure,
          "tls 1.2 refused without a client certificate": clientCertificateFailure,
        },
      });
      expect({ runtime, accepted }).toEqual({
        runtime,
        accepted: { plain: 2, amqp: 1, local: 4, v6: 1, farName: 1, asking: 2, refusing: 1 },
      });
    }
  });
});
