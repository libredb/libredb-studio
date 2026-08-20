/**
 * Unit tests for the container bind-address resolver (`docker/bind-address.mjs`,
 * issue #432). The resolver is the ONLY thing standing between an IPv6-only VPS
 * (where today's hardcoded `0.0.0.0` makes the published image unreachable on
 * first run) and every existing IPv4 deployment, which must not lose a single
 * client. Each case below locks a decision that was measured on a real Docker
 * host, or an override rule that the measurements showed is easy to get wrong.
 *
 * The pure decision function `chooseBindAddress` takes every detector result as
 * an argument, so no test touches /proc, the network, or the machine's own
 * interface list — the table is exhaustive and hermetic. `probeDualStack` and
 * `listNonLoopbackIPv4` take injectable seams for the same reason; only one
 * test touches a real socket, it runs the module in a SUBPROCESS the way the
 * entrypoint does (bun's process-wide `mock.module` makes an in-process real
 * socket unreliable here - see the comment on that test), and it asserts the
 * CONTRACT rather than a value, so CI's network shape can never make it flaky.
 *
 * WHY each group is worth locking:
 *  - Precedence (R0/R1): Docker injects HOSTNAME=<container-id> when the image
 *    sets none, and that injected value equals the machine hostname. A resolver
 *    that treats it as "the operator chose" reproduces #432 forever, while one
 *    that ignores a genuine `-e HOSTNAME=0.0.0.0` silently overrides an operator
 *    who deliberately asked for IPv4-only. The hostname comparison is the only
 *    thing that separates the two.
 *  - Dual-stack proof (R2/R3): under `net.ipv6.bindv6only=1` a Node `::` listener
 *    was MEASURED to still serve IPv4 (libuv clears IPV6_V6ONLY), and under
 *    `disable_ipv6=1` the bind SUCCEEDS silently. So neither the sysctl nor a
 *    try/catch answers the question; only a positive IPv4-acceptance probe does.
 *  - Row F (R5): an IPv6-only host where the listener really is v6-only must
 *    still choose `::`. Falling back to `0.0.0.0` there serves nobody — this is
 *    the row a naive "not dual-stack => 0.0.0.0" rule gets exactly backwards.
 *  - Loopback (R4 guard): an IPv6-only container still has 127.0.0.1, so
 *    counting loopback as "IPv4 clients exist" reproduces #432 verbatim.
 *  - Logging: a reachability decision that leaves no trace is undebuggable when
 *    a user reports "I can't reach it", so every constrained branch must name
 *    both the address it chose and the evidence it chose it on.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  chooseBindAddress,
  isDirectExecution,
  listNonLoopbackIPv4,
  main,
  probeDualStack,
} from "../../docker/bind-address.mjs";

/** Looks like what Docker exports as HOSTNAME for every container process. */
const CONTAINER_ID = "3f9a1c2b4d5e";
/** Looks like what a kubelet exports as HOSTNAME inside a pod. */
const POD_NAME = "libredb-studio-7c9f5b8d64-2xqkz";

/** A dual-stack-capable namespace: `::` bound and accepted an IPv4 client. */
const PROBE_DUAL_STACK = { bound: true, ipv4: true } as const;
/** A v6-only listener: `::` bound, but the IPv4 client was refused. */
const PROBE_V6_ONLY = { bound: true, ipv4: false, error: "ECONNREFUSED" } as const;
/** No AF_INET6 at all (kernel built without IPv6): the bind itself throws. */
const PROBE_NO_IPV6 = { bound: false, error: "EAFNOSUPPORT" } as const;
/** The probe blew its own budget; we must decide on evidence alone. */
const PROBE_FAILED = { failed: true, error: "timeout" } as const;

function choose(overrides: Record<string, unknown> = {}) {
  return chooseBindAddress({
    libredbBind: undefined,
    hostnameEnv: undefined,
    systemHostname: CONTAINER_ID,
    probe: PROBE_DUAL_STACK,
    nonLoopbackIPv4: ["172.17.0.2"],
    ...overrides,
  });
}

describe("chooseBindAddress - explicit operator overrides (R0/R1)", () => {
  test("LIBREDB_BIND wins over everything, including an explicit HOSTNAME", () => {
    // LIBREDB_BIND already means "a literal bind address" in
    // packaging/linux/libredb-studio (#134); the container keeps that meaning.
    const decision = choose({ libredbBind: "192.0.2.7", hostnameEnv: "::" });
    expect(decision.address).toBe("192.0.2.7");
    expect(decision.reason).toBe("explicit-libredb-bind");
  });

  test.each([["::"], ["0.0.0.0"], ["127.0.0.1"], ["::1"], ["192.0.2.7"]])(
    "returns the explicit HOSTNAME %s unchanged, without probing",
    (address) => {
      // Every one of these is a legitimate deliberate choice: `::` forces
      // dual-stack, `0.0.0.0` keeps today's IPv4-only behaviour, and the two
      // loopback literals are how an operator confines the app to the
      // container itself. None of them may be second-guessed.
      const decision = choose({ hostnameEnv: address, probe: PROBE_NO_IPV6, nonLoopbackIPv4: [] });
      expect(decision.address).toBe(address);
      expect(decision.reason).toBe("explicit-hostname");
    },
  );

  test.each([["  ::  "], ["\t0.0.0.0\n"]])("trims surrounding whitespace off an explicit value (%p)", (raw) => {
    expect(choose({ hostnameEnv: raw }).address).toBe(raw.trim());
  });

  test("Docker's injected container id is NOT an operator choice", () => {
    // Measured: with no `ENV HOSTNAME` the daemon injects HOSTNAME=<container-id>,
    // and that value equals the container's own hostname. Honouring it would
    // make Next bind a name instead of a wildcard - the #432 failure, restored.
    const decision = choose({ hostnameEnv: CONTAINER_ID, systemHostname: CONTAINER_ID });
    expect(decision.address).toBe("::");
    expect(decision.reason).toBe("dual-stack-verified");
  });

  test("a kubelet-injected pod name is NOT an operator choice either", () => {
    // Kubernetes' injection behaviour is unverified against a live cluster, so
    // the same equal-to-os.hostname() discriminator has to cover it.
    const decision = choose({ hostnameEnv: POD_NAME, systemHostname: POD_NAME });
    expect(decision.reason).toBe("dual-stack-verified");
  });

  test.each([[""], ["   "], [undefined]])("treats %p as 'nobody chose' and auto-selects", (value) => {
    // The image ships `ENV HOSTNAME=""` precisely so that empty is the sentinel:
    // it suppresses Docker's injection while leaving a bypassed entrypoint on
    // Next's own `process.env.HOSTNAME || '0.0.0.0'` default.
    expect(choose({ hostnameEnv: value as string | undefined }).reason).toBe("dual-stack-verified");
  });

  test.each([[""], ["   "]])("a blank LIBREDB_BIND (%p) does not count as a choice", (value) => {
    expect(choose({ libredbBind: value }).reason).toBe("dual-stack-verified");
  });
});

describe("chooseBindAddress - auto-selection decision table (R2-R5)", () => {
  test("dual-stack proven -> :: (rows A, B, C, D, E, G, H, I)", () => {
    // Every configuration reachable via --sysctl, --network host or pod
    // sysctls measured as dual-stack for a Node `::` listener, INCLUDING
    // net.ipv6.bindv6only=1 and net.ipv6.conf.all.disable_ipv6=1.
    const decision = choose({ probe: PROBE_DUAL_STACK });
    expect(decision.address).toBe("::");
    expect(decision.reason).toBe("dual-stack-verified");
  });

  test("dual-stack proven with no IPv4 address at all -> :: (row B, the #432 reporter)", () => {
    const decision = choose({ probe: PROBE_DUAL_STACK, nonLoopbackIPv4: [] });
    expect(decision.address).toBe("::");
  });

  test("`::` cannot be bound at all -> 0.0.0.0 (R2a, reasoned not measured)", () => {
    // A kernel with CONFIG_IPV6=n makes socket(AF_INET6) fail outright. This is
    // the one branch that could not be reproduced on the recon host, which is
    // exactly why it is pinned here with an injected fake instead.
    const decision = choose({ probe: PROBE_NO_IPV6 });
    expect(decision.address).toBe("0.0.0.0");
    expect(decision.reason).toBe("ipv6-unavailable");
    expect(decision.detail).toContain("EAFNOSUPPORT");
  });

  test("v6-only listener + a real IPv4 address -> 0.0.0.0 (R4, never lose IPv4)", () => {
    const decision = choose({ probe: PROBE_V6_ONLY, nonLoopbackIPv4: ["172.17.0.2"] });
    expect(decision.address).toBe("0.0.0.0");
    expect(decision.reason).toBe("ipv6-only-listener-ipv4-present");
  });

  test("ROW F: v6-only listener with no non-loopback IPv4 -> :: , NOT 0.0.0.0", () => {
    // bindv6only=1 on an IPv6-only host. `0.0.0.0` here would bind an address
    // family no client can reach - strictly worse than the bug being fixed.
    const decision = choose({ probe: PROBE_V6_ONLY, nonLoopbackIPv4: [] });
    expect(decision.address).toBe("::");
    expect(decision.reason).toBe("ipv6-only-host");
  });

  test("probe failure falls back on evidence, not on a flat 0.0.0.0 (R6)", () => {
    const withIPv4 = choose({ probe: PROBE_FAILED, nonLoopbackIPv4: ["172.17.0.2"] });
    expect(withIPv4.address).toBe("0.0.0.0");
    expect(withIPv4.reason).toBe("probe-failed");

    const withoutIPv4 = choose({ probe: PROBE_FAILED, nonLoopbackIPv4: [] });
    expect(withoutIPv4.address).toBe("::");
    expect(withoutIPv4.reason).toBe("probe-failed");
  });

  test("a missing interface list is treated as no evidence of IPv4", () => {
    // If os.networkInterfaces() itself threw we know nothing; keeping today's
    // 0.0.0.0 is the no-regression answer for that unknown.
    const decision = choose({ probe: PROBE_FAILED, nonLoopbackIPv4: undefined });
    expect(decision.address).toBe("0.0.0.0");
  });
});

describe("listNonLoopbackIPv4 - the detector trap", () => {
  test("127.0.0.1 does NOT count as having IPv4", () => {
    // Measured: an IPv6-only container still has lo/127.0.0.1. A detector that
    // counts it picks 0.0.0.0 and reproduces #432 exactly.
    const addresses = listNonLoopbackIPv4({
      interfaces: {
        lo: [
          { address: "127.0.0.1", family: "IPv4", internal: true },
          { address: "::1", family: "IPv6", internal: true },
        ],
        eth0: [{ address: "fd00:c1a0:16::2", family: "IPv6", internal: false }],
      },
    });
    expect(addresses).toEqual([]);
  });

  test("a routable IPv4 address on eth0 counts", () => {
    const addresses = listNonLoopbackIPv4({
      interfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [
          { address: "172.17.0.2", family: "IPv4", internal: false },
          { address: "fe80::1", family: "IPv6", internal: false },
        ],
      },
    });
    expect(addresses).toEqual(["172.17.0.2"]);
  });

  test("link-local IPv6 is ignored - every namespace has fe80:: addresses", () => {
    const addresses = listNonLoopbackIPv4({
      interfaces: { eth0: [{ address: "fe80::c05f:37ff:fe4b:7457", family: "IPv6", internal: false }] },
    });
    expect(addresses).toEqual([]);
  });

  test("tolerates an empty or absent interface map", () => {
    expect(listNonLoopbackIPv4({ interfaces: {} })).toEqual([]);
    expect(listNonLoopbackIPv4({ interfaces: { eth0: undefined } })).toEqual([]);
  });
});

describe("probeDualStack - injected socket seams", () => {
  test("a bind that throws reports bound:false with the errno", async () => {
    const result = await probeDualStack({
      createServer: () => {
        throw Object.assign(new Error("socket EAFNOSUPPORT"), { code: "EAFNOSUPPORT" });
      },
    });
    expect(result.bound).toBe(false);
    expect(result.error).toContain("EAFNOSUPPORT");
  });

  test("a listener that refuses the IPv4 client reports bound:true, ipv4:false", async () => {
    const result = await probeDualStack({
      createServer: () => fakeServer(),
      createConnection: () => fakeRefusedConnection(),
    });
    expect(result.bound).toBe(true);
    expect(result.ipv4).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  test("a connection that never settles is reported as failed, not as v6-only", async () => {
    // Timing out is not evidence of anything; conflating it with "refused"
    // would send an IPv6-only host to 0.0.0.0 on a slow machine.
    const result = await probeDualStack({
      createServer: () => fakeServer(),
      createConnection: () => fakeHangingConnection(),
      timeoutMs: 5,
    });
    expect(result.failed).toBe(true);
  });

  test("closes the listener even when the client attempt fails", async () => {
    const server = fakeServer();
    await probeDualStack({ createServer: () => server, createConnection: () => fakeRefusedConnection() });
    expect(server.closed).toBe(true);
  });

  // The only test that touches a real socket, and it does so in a SUBPROCESS,
  // exactly the way the entrypoint runs the file. In-process it could not be
  // trusted: bun's `mock.module` is process-wide, tests/unit/ssh-tunnel.test.ts
  // replaces "node:net" for whatever shares its process, and this module's
  // static `import net from "node:net"` would then hand probeDualStack that
  // mock's server - whose `listen(port, host, cb)` signature cannot take the
  // `listen({ host, port }, cb)` call made here (measured: `bun test
  // tests/unit/ssh-tunnel.test.ts tests/unit/docker-bind-address.test.ts` fails
  // this one assertion, the file alone passes). A subprocess also covers the
  // direct-execution guard at the bottom of the module, which no in-process
  // test can reach.
  //
  // It asserts the CONTRACT, never a value: the answer legitimately differs
  // between an IPv6-capable CI runner and one without AF_INET6, and neither may
  // turn this suite red. HOSTNAME and LIBREDB_BIND are cleared so an inherited
  // one cannot short-circuit the probe into the explicit-choice branch.
  test("running the resolver for real prints one address and one log line", () => {
    const run = Bun.spawnSync(["node", `${import.meta.dir}/../../docker/bind-address.mjs`], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOSTNAME: "", LIBREDB_BIND: "" },
    });
    expect(run.exitCode).toBe(0);
    expect(["::\n", "0.0.0.0\n"]).toContain(run.stdout.toString());
    expect(run.stderr.toString().trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("main - stdout contract and the one stderr line", () => {
  async function run(overrides: Record<string, unknown> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main({
      env: {},
      systemHostname: CONTAINER_ID,
      probe: PROBE_DUAL_STACK,
      interfaces: { eth0: [{ address: "172.17.0.2", family: "IPv4", internal: false }] },
      stdout: (chunk: string) => out.push(chunk),
      stderr: (chunk: string) => err.push(chunk),
      ...overrides,
    });
    return { code, stdout: out.join(""), stderr: err.join("") };
  }

  test("prints only the address on stdout, newline-terminated, and exits 0", async () => {
    // The entrypoint consumes stdout verbatim; anything else on it becomes the
    // bind address and breaks the container.
    const result = await run();
    expect(result.stdout).toBe("::\n");
    expect(result.code).toBe(0);
  });

  test("logs exactly one line to stderr", async () => {
    const result = await run();
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stderr).toStartWith("libredb-studio: bind address :: ");
    expect(result.stderr).toEndWith("\n");
  });

  test("names the evidence when it auto-selected ::", async () => {
    const result = await run();
    expect(result.stderr).toContain("dual-stack verified");
  });

  test("names the variable when the operator chose explicitly", async () => {
    const viaHostname = await run({ env: { HOSTNAME: "0.0.0.0" } });
    expect(viaHostname.stdout).toBe("0.0.0.0\n");
    expect(viaHostname.stderr).toContain("libredb-studio: bind address 0.0.0.0 (explicit HOSTNAME)");

    const viaLibredbBind = await run({ env: { LIBREDB_BIND: "192.0.2.7" } });
    expect(viaLibredbBind.stdout).toBe("192.0.2.7\n");
    expect(viaLibredbBind.stderr).toContain("libredb-studio: bind address 192.0.2.7 (explicit LIBREDB_BIND)");
  });

  test("says IPv6 is unavailable, and that IPv6 clients will be refused", async () => {
    const result = await run({ probe: PROBE_NO_IPV6 });
    expect(result.stdout).toBe("0.0.0.0\n");
    expect(result.stderr).toContain("IPv6 unavailable");
    expect(result.stderr).toContain("EAFNOSUPPORT");
  });

  test("names the refused probe AND the IPv4 address it is protecting (R4)", async () => {
    const result = await run({ probe: PROBE_V6_ONLY });
    expect(result.stdout).toBe("0.0.0.0\n");
    expect(result.stderr).toContain("refused IPv4");
    expect(result.stderr).toContain("172.17.0.2");
    expect(result.stderr).toContain("HOSTNAME=::");
  });

  test("explains why it kept :: despite a v6-only listener (row F)", async () => {
    const result = await run({ probe: PROBE_V6_ONLY, interfaces: {} });
    expect(result.stdout).toBe("::\n");
    expect(result.stderr).toContain("no non-loopback IPv4");
  });

  test("a failed probe is a WARNING naming the address it fell back to", async () => {
    const withIPv4 = await run({ probe: PROBE_FAILED });
    expect(withIPv4.stdout).toBe("0.0.0.0\n");
    expect(withIPv4.stderr).toContain("WARNING");
    expect(withIPv4.stderr).toContain("timeout");
    expect(withIPv4.stderr).toContain("0.0.0.0");

    const withoutIPv4 = await run({ probe: PROBE_FAILED, interfaces: {} });
    expect(withoutIPv4.stdout).toBe("::\n");
    expect(withoutIPv4.stderr).toContain("WARNING");
  });

  test("never lets a broken interface list stop it from printing an address", async () => {
    // The entrypoint has its own 0.0.0.0 backstop, but a resolver that throws
    // burns a startup for nothing; it must still answer.
    const result = await run({
      probe: PROBE_FAILED,
      interfaces: new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("ENOSYS");
          },
        },
      ),
    });
    expect(result.stdout).toBe("0.0.0.0\n");
    expect(result.code).toBe(0);
  });
});

/** Minimal stand-ins for the two node:net objects the probe drives. */
function fakeServer() {
  const handlers = new Map<string, (arg?: unknown) => void>();
  return {
    closed: false,
    listen(_options: unknown, callback?: () => void) {
      queueMicrotask(() => callback?.());
      return this;
    },
    address() {
      return { address: "::", family: "IPv6", port: 45123 };
    },
    on(event: string, handler: (arg?: unknown) => void) {
      handlers.set(event, handler);
      return this;
    },
    once(event: string, handler: (arg?: unknown) => void) {
      handlers.set(event, handler);
      return this;
    },
    close(callback?: () => void) {
      this.closed = true;
      callback?.();
      return this;
    },
  };
}

function fakeRefusedConnection() {
  const handlers = new Map<string, (arg?: unknown) => void>();
  const socket = {
    destroyed: false,
    on(event: string, handler: (arg?: unknown) => void) {
      handlers.set(event, handler);
      return socket;
    },
    once(event: string, handler: (arg?: unknown) => void) {
      handlers.set(event, handler);
      return socket;
    },
    setTimeout() {
      return socket;
    },
    destroy() {
      socket.destroyed = true;
      return socket;
    },
  };
  queueMicrotask(() =>
    handlers.get("error")?.(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
  );
  return socket;
}

function fakeHangingConnection() {
  const socket = {
    destroyed: false,
    on() {
      return socket;
    },
    once() {
      return socket;
    },
    setTimeout() {
      return socket;
    },
    destroy() {
      socket.destroyed = true;
      return socket;
    },
  };
  return socket;
}

/**
 * The guard that decides whether the module runs or is merely imported. It is
 * the whole feature's on/off switch: when it says "imported" in the container,
 * the resolver prints nothing, the entrypoint warns and falls back to 0.0.0.0,
 * and #432 is silently back. Both failure shapes below were measured against a
 * naive `import.meta.url === \`file://${process.argv[1]}\`` comparison, which is
 * what this replaced.
 */
describe("isDirectExecution - the module's own on/off switch", () => {
  const here = fileURLToPath(import.meta.url);
  const hereUrl = pathToFileURL(here).href;

  test("no argv[1] is never direct execution", () => {
    expect(isDirectExecution(undefined, hereUrl)).toBe(false);
    expect(isDirectExecution("", hereUrl)).toBe(false);
  });

  test("the module run as itself is direct execution", () => {
    expect(isDirectExecution(here, hereUrl)).toBe(true);
  });

  test("a different file is not", () => {
    expect(isDirectExecution(here, pathToFileURL(join(dirname(here), "other.mjs")).href)).toBe(false);
  });

  test("a path that must be URL-encoded still matches - the naive comparison does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "libredb-guard with space-"));
    try {
      const file = join(dir, "bind.mjs");
      writeFileSync(file, "");
      const url = pathToFileURL(file).href;
      expect(url).toContain("%20");
      expect(url).not.toBe(`file://${file}`);
      expect(isDirectExecution(file, url)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invocation through a symlink matches - import.meta.url is already realpath'd", () => {
    const dir = mkdtempSync(join(tmpdir(), "libredb-guard-link-"));
    try {
      const target = join(dir, "bind.mjs");
      const link = join(dir, "link.mjs");
      writeFileSync(target, "");
      symlinkSync(target, link);
      expect(isDirectExecution(link, pathToFileURL(target).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an argv[1] that cannot be resolved is not direct execution, and does not throw", () => {
    expect(isDirectExecution(join(tmpdir(), "libredb-does-not-exist-432.mjs"), hereUrl)).toBe(false);
  });
});
