/**
 * Container bind-address resolver (issue #432).
 *
 * The published image used to hardcode `ENV HOSTNAME="0.0.0.0"`, which makes it
 * unreachable on a host that has a public IPv6 address and no IPv4 address at
 * all - an increasingly common VPS shape. The obvious fix (bind `::`) must not
 * be taken on faith: the requirement is that no existing IPv4 deployment loses
 * a single client, silently or otherwise.
 *
 * So this resolver PROVES dual-stack per container instead of inferring it. It
 * binds a throwaway `::` listener on an ephemeral port and connects to it over
 * 127.0.0.1. That positive check is the only thing that distinguishes the cases
 * that were measured on a real Docker host:
 *
 *   - `net.ipv6.bindv6only=1`: a Node `::` listener STILL serves IPv4 (libuv
 *     clears IPV6_V6ONLY unless `ipv6Only` is passed, and Next calls a plain
 *     `server.listen(port, hostname)`), so branching on that sysctl would pick
 *     `0.0.0.0` in namespaces where `::` demonstrably works.
 *   - `net.ipv6.conf.all.disable_ipv6=1`: the `::` bind SUCCEEDS and serves
 *     IPv4, so a try/catch fallback never fires and catches nothing.
 *
 * The resolver writes the chosen address to stdout (consumed verbatim by
 * docker-entrypoint.sh) and exactly one explanatory line to stderr, so a later
 * "I cannot reach it" report is a one-line diagnosis rather than a mystery.
 *
 * It is deliberately NOT under src/, bin/, scripts/ or packaging/, and is not
 * part of scripts/build-standalone-payload.sh: the native channels (npx, deb,
 * rpm, Homebrew, Snap, Windows) bind 127.0.0.1 by design (#134) and must never
 * inherit container bind policy.
 */
import { realpathSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { pathToFileURL } from "node:url";

/** How long the dual-stack probe may take before we decide on evidence alone. */
const DEFAULT_PROBE_TIMEOUT_MS = 250;

/** Trim a possibly-undefined env value down to a usable string, or "". */
function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Render an unknown throwable as a short, log-safe single-line string. */
function describeError(error) {
  if (!error) return "unknown error";
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" && error.message ? error.message : String(error);
  if (code && !message.includes(code)) return `${code} (${message})`;
  return message;
}

/**
 * An address the operator asked for, or null when nobody chose.
 *
 * `LIBREDB_BIND` keeps exactly the meaning it already has in
 * packaging/linux/libredb-studio (#134): a literal bind address.
 *
 * `HOSTNAME` is overloaded: Docker injects `HOSTNAME=<container-id>` when the
 * image sets none, and a kubelet injects the pod name. Both equal the machine's
 * own hostname, so a value that differs from `os.hostname()` is the only signal
 * that a human set it. That is what lets `-e HOSTNAME=0.0.0.0` keep an existing
 * deployment on IPv4 while an untouched container is auto-resolved.
 *
 * The known cost, measured: naming the container after the address you also pin
 * (`--hostname 0.0.0.0 -e HOSTNAME=0.0.0.0`) makes the two indistinguishable, so
 * the pin is dropped and the address is auto-resolved instead. Use LIBREDB_BIND,
 * which carries no second meaning. The choice is never hidden either way - the
 * startup line names the address and the reason it was picked.
 */
function explicitChoice(libredbBind, hostnameEnv, systemHostname) {
  const bind = trimmed(libredbBind);
  if (bind) return { address: bind, reason: "explicit-libredb-bind", detail: "LIBREDB_BIND" };
  const host = trimmed(hostnameEnv);
  if (host && host !== trimmed(systemHostname)) {
    return { address: host, reason: "explicit-hostname", detail: "HOSTNAME" };
  }
  return null;
}

/**
 * Non-loopback IPv4 addresses in this namespace.
 *
 * 127.0.0.1 MUST NOT count: an IPv6-only container still has it (measured), so
 * a detector that counts loopback answers "this host has IPv4 clients" for the
 * very host that has none - reproducing #432 exactly.
 */
export function listNonLoopbackIPv4({ interfaces } = {}) {
  const found = [];
  for (const entries of Object.values(interfaces ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.internal) continue;
      // Node 18+ reports family as the string "IPv4"; older shapes used 4.
      const family = entry.family === 4 ? "IPv4" : entry.family;
      if (family === "IPv4") found.push(entry.address);
    }
  }
  return found;
}

/**
 * Bind `::` on an ephemeral port and try to reach it over 127.0.0.1.
 *
 * Resolves `{ bound: false, error }` when AF_INET6 is unavailable (a kernel
 * built without IPv6 - reasoned, not measured: `--sysctl` cannot remove the
 * address family), `{ bound: true, ipv4: true }` when the listener accepted an
 * IPv4 client, `{ bound: true, ipv4: false, error }` when it refused one, and
 * `{ failed: true, error }` when the probe blew its budget. A timeout is NOT
 * folded into "refused": on a slow machine that would send an IPv6-only host to
 * an address family none of its clients can reach.
 *
 * Port 0 means the probe can never collide with anything, including under
 * `--network host`. The seams exist so the unit tests need no real network.
 */
export function probeDualStack({ createServer, createConnection, timeoutMs } = {}) {
  const makeServer = createServer ?? (() => net.createServer());
  const openConnection = createConnection ?? ((options) => net.createConnection(options));
  const budgetMs = timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let server;
    let timer;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        server?.close();
      } catch {
        // The listener may already be gone; the probe's answer stands either way.
      }
      resolve(result);
    };

    try {
      server = makeServer();
    } catch (error) {
      resolve({ bound: false, error: describeError(error) });
      return;
    }

    server.once("error", (error) => finish({ bound: false, error: describeError(error) }));
    timer = setTimeout(() => finish({ bound: true, failed: true, error: "timeout" }), budgetMs);

    server.listen({ host: "::", port: 0 }, () => {
      const bound = server.address();
      const port = bound && typeof bound === "object" ? bound.port : 0;
      let socket;
      try {
        socket = openConnection({ host: "127.0.0.1", port });
      } catch (error) {
        finish({ bound: true, ipv4: false, error: describeError(error) });
        return;
      }
      const done = (result) => {
        try {
          socket.destroy();
        } catch {
          // Already destroyed; nothing to clean up.
        }
        finish(result);
      };
      socket.once("error", (error) => done({ bound: true, ipv4: false, error: describeError(error) }));
      socket.once("connect", () => done({ bound: true, ipv4: true }));
    });
  });
}

/**
 * The decision itself: pure, every detector result passed in.
 *
 * Ordering matters. R0/R1 (explicit choices) run before any probe, so an
 * operator's address is never second-guessed. R5 is the row a naive
 * "not dual-stack => 0.0.0.0" rule gets backwards: on an IPv6-only host,
 * `0.0.0.0` binds a family no client can reach, which is strictly worse than
 * the bug being fixed.
 */
export function chooseBindAddress({ libredbBind, hostnameEnv, systemHostname, probe, nonLoopbackIPv4 } = {}) {
  const explicit = explicitChoice(libredbBind, hostnameEnv, systemHostname);
  if (explicit) return explicit;

  const result = probe ?? {};
  const knowsInterfaces = Array.isArray(nonLoopbackIPv4);
  const hasIPv4 = knowsInterfaces && nonLoopbackIPv4.length > 0;
  const error = String(result.error ?? "unknown");

  // R6: the probe told us nothing, so decide on evidence. No IPv4 to lose means
  // `::`; anything else keeps today's exact behaviour rather than gambling.
  if (result.failed) {
    return { address: knowsInterfaces && !hasIPv4 ? "::" : "0.0.0.0", reason: "probe-failed", detail: error };
  }
  // R2a: no AF_INET6 at all. Reasoned, not measured - see probeDualStack.
  if (result.bound === false) return { address: "0.0.0.0", reason: "ipv6-unavailable", detail: error };
  // R3: proven dual-stack. Every configuration measured on a real host lands here.
  if (result.ipv4) return { address: "::", reason: "dual-stack-verified", detail: "" };
  // R5: a v6-only listener with no IPv4 clients to protect.
  if (knowsInterfaces && !hasIPv4) return { address: "::", reason: "ipv6-only-host", detail: error };
  // R4: a v6-only listener while real IPv4 clients exist - never lose them.
  return { address: "0.0.0.0", reason: "ipv6-only-listener-ipv4-present", detail: error };
}

/** The single stderr line: always the address, always the evidence. */
function describeDecision(decision, nonLoopbackIPv4) {
  const { address, reason, detail } = decision;
  switch (reason) {
    case "explicit-libredb-bind":
    case "explicit-hostname":
      return `libredb-studio: bind address ${address} (explicit ${detail})`;
    case "dual-stack-verified":
      return `libredb-studio: bind address :: (dual-stack verified - an IPv4 client connected to the wildcard IPv6 listener; set HOSTNAME to override)`;
    case "ipv6-unavailable":
      return `libredb-studio: bind address 0.0.0.0 (IPv6 unavailable in this network namespace: ${detail}) - IPv6 clients will be refused`;
    case "ipv6-only-listener-ipv4-present":
      return `libredb-studio: bind address 0.0.0.0 (the :: listener refused IPv4: ${detail}; this namespace has non-loopback IPv4 ${describeIPv4(nonLoopbackIPv4)}, keeping it reachable) - set HOSTNAME=:: to force IPv6`;
    case "ipv6-only-host":
      return `libredb-studio: bind address :: (the :: listener refused IPv4, but this namespace has no non-loopback IPv4 address)`;
    default:
      return `libredb-studio: WARNING bind probe failed (${detail}); falling back to ${address} (${describeEvidence(nonLoopbackIPv4)})`;
  }
}

function describeIPv4(nonLoopbackIPv4) {
  return Array.isArray(nonLoopbackIPv4) && nonLoopbackIPv4.length > 0 ? nonLoopbackIPv4.join(", ") : "unknown";
}

function describeEvidence(nonLoopbackIPv4) {
  if (!Array.isArray(nonLoopbackIPv4)) return "the interface list could not be read";
  return nonLoopbackIPv4.length > 0 ? "non-loopback IPv4 present" : "no non-loopback IPv4 present";
}

/**
 * Entry point. stdout carries the address and nothing else - the entrypoint
 * consumes it verbatim, so anything extra there becomes the bind address.
 * Always resolves 0: a bind heuristic must never stop the container starting.
 */
export async function main({ env, systemHostname, probe, interfaces, stdout, stderr } = {}) {
  const environment = env ?? process.env;
  const write = stdout ?? ((chunk) => process.stdout.write(chunk));
  const log = stderr ?? ((chunk) => process.stderr.write(chunk));

  let hostname;
  try {
    hostname = systemHostname ?? os.hostname();
  } catch {
    hostname = "";
  }

  let decision;
  let addresses;
  const explicit = explicitChoice(environment.LIBREDB_BIND, environment.HOSTNAME, hostname);
  if (explicit) {
    decision = explicit;
  } else {
    try {
      addresses = listNonLoopbackIPv4({ interfaces: interfaces ?? os.networkInterfaces() });
    } catch {
      // An unreadable interface list is not fatal: it only means we have no
      // evidence, which chooseBindAddress treats as "keep today's behaviour".
      addresses = undefined;
    }
    let probeResult;
    if (probe === undefined) probeResult = await probeDualStack({});
    else if (typeof probe === "function") probeResult = await probe();
    else probeResult = probe;
    decision = chooseBindAddress({
      libredbBind: environment.LIBREDB_BIND,
      hostnameEnv: environment.HOSTNAME,
      systemHostname: hostname,
      probe: probeResult,
      nonLoopbackIPv4: addresses,
    });
  }

  write(`${decision.address}\n`);
  log(`${describeDecision(decision, addresses)}\n`);
  return 0;
}

/**
 * Whether this module is the program being run, rather than an import.
 *
 * Comparing `import.meta.url` against a hand-built `file://${argv[1]}` is wrong
 * in two ways that both end with the resolver silently printing nothing (the
 * entrypoint then warns and falls back to 0.0.0.0, i.e. the pre-#432 default):
 * a path component containing a space or any other character a URL must encode
 * makes the naive string differ, and `import.meta.url` is already realpath'd
 * while `argv[1]` is not, so invoking through a symlink never matches. Both are
 * measured, and `pathToFileURL` alone fixes only the first - hence the realpath.
 */
export function isDirectExecution(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    // An unreadable or vanished argv[1] is not this module, and must not throw.
    return false;
  }
}

// Run only when executed directly, so importing this file in a test is inert.
if (isDirectExecution(process.argv[1], import.meta.url)) {
  await main({});
}
