/**
 * The dial: what is checked, in what order, and what is never retried.
 *
 * Neither ssh2 nor a socket is involved. Both are ports, so the rules can be held without a
 * network: the pin is read before anything is dialled, the address is checked before it is
 * connected, the host key is checked before any credential leaves, and none of the three has a
 * second path.
 *
 * The last two tests are the exception, and a narrow one: they resolve the name `localhost` through
 * the lookup the dial installed, because the address rule cannot be read off the lookup's identity.
 * No socket is opened even there.
 */
import { afterEach, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { expectBe, expectEqual, expectMatch, expectNotBe, expectRejects, expectTruthy } from "./helpers";
import { BLOCKED_HOST } from "@/lib/db/http/egress-policy";
import {
  DialError,
  dialNetconf,
  NETCONF_PORT,
  NETCONF_SUBSYSTEM,
  type DialConfig,
  type SocketPort,
  type SshConnectOptions,
  type SshPort,
} from "@/lib/db/providers/network/netconf/dial";
import { fingerprintOf } from "@/lib/db/providers/network/netconf/hostkey";
import { classifyLoginFailure } from "@/lib/db/providers/network/netconf/auth";
import type { Transport } from "@/lib/db/providers/network/netconf/session";

const DEVICE_KEY = Buffer.from("the device's host key");
const PIN = fingerprintOf(DEVICE_KEY);

const transport: Transport = {
  write: () => {},
  onData: () => {},
  onClose: () => {},
  close: () => {},
};

interface Recorder {
  readonly dialled: { host: string; port: number; noDelay: true; lookup?: unknown }[];
  readonly connects: SshConnectOptions[];
  readonly subsystems: string[];
  /** Teardowns of the ssh client, so a dial that fails without one can be told apart. */
  ended: number;
}

function ports(
  over: {
    hostKey?: Buffer;
    subsystemError?: unknown;
    connectError?: unknown;
    /** The socket itself refusing, which is what an address with nobody on it does. */
    socketError?: unknown;
    /** A SECOND library error after the dial has already settled, which a real server sends. */
    lateError?: boolean;
    /**
     * What ssh2 does after the verifier returns false: it raises its own "Host denied
     * (verification failed)" a moment later. Without this the fake cannot show the two outcomes
     * meeting, which is the whole question.
     */
    libraryErrorAfterRefusal?: boolean;
    /** ssh2's `end()` throwing while a client that never finished connecting is torn down. */
    endThrows?: boolean;
  } = {},
): {
  ssh: SshPort;
  socket: SocketPort;
  seen: Recorder;
} {
  const seen: Recorder = { dialled: [], connects: [], subsystems: [], ended: 0 };
  const socket: SocketPort = {
    connect: async (options) => {
      seen.dialled.push(options);
      if (over.socketError !== undefined) throw over.socketError;
      return { socket: true };
    },
  };
  const ssh: SshPort = {
    connect: (options) => {
      seen.connects.push(options);
      let ready: (() => void) | null = null;
      let failed: ((error: unknown) => void) | null = null;
      queueMicrotask(() => {
        if (over.connectError !== undefined) {
          failed?.(over.connectError);
          // A real server keeps going after the first error: ssh2 raised "Connection lost before
          // handshake" on the same client a moment after the deadline had already answered. The
          // fake sends a second one so the handler's behaviour after settling is measurable.
          if (over.lateError) failed?.(new Error("Connection lost before handshake"));
          return;
        }
        // The library offers the host key before it authenticates, which is the order the rule
        // depends on: a refusal here means nothing was sent.
        const accepted = options.hostVerifier(over.hostKey ?? DEVICE_KEY);
        if (accepted) ready?.();
        else if (over.libraryErrorAfterRefusal) failed?.(new Error("Host denied (verification failed)"));
      });
      return {
        onReady: (handler) => {
          ready = handler;
        },
        onError: (handler) => {
          failed = handler;
        },
        subsystem: (name, handler) => {
          seen.subsystems.push(name);
          if (over.subsystemError !== undefined) handler(over.subsystemError, null);
          else handler(null, transport);
        },
        end: () => {
          seen.ended += 1;
          if (over.endThrows) throw new Error("the teardown failed");
        },
      };
    },
  };
  return { ssh, socket, seen };
}

const config = (over: Partial<DialConfig> = {}): DialConfig => ({
  host: "192.0.2.10",
  username: "ro-key",
  hostKeyFingerprint: PIN,
  privateKey: "a key",
  readyMs: 5000,
  ...over,
});

/**
 * The number is written out rather than compared against the constant it came from. A mutation
 * replacing `NETCONF_PORT` with a bare 830 survived the earlier version of this test, because the
 * test asserted that the constant equalled itself: it would have passed just as happily if the
 * constant had been 22. IANA registers 830/tcp as `netconf-ssh` and RFC 6242 section 3 names it,
 * so 830 is the fact and the constant is only its name.
 */
test("the default port is 830, the number the standard names, and a connection can override it", async () => {
  const { ssh, socket, seen } = ports();
  await dialNetconf(config(), ssh, socket);
  expectBe(seen.dialled[0]?.port, 830);
  expectBe(NETCONF_PORT, 830);
  expectBe(seen.dialled[0]?.noDelay, true);
  await dialNetconf(config({ port: 2830 }), ssh, socket);
  expectBe(seen.dialled[1]?.port, 2830);
});

test("the subsystem asked for is netconf and nothing else", async () => {
  const { ssh, socket, seen } = ports();
  await dialNetconf(config(), ssh, socket);
  expectEqual(seen.subsystems, [NETCONF_SUBSYSTEM]);
});

test("an empty pin is refused before anything is dialled", async () => {
  const { ssh, socket, seen } = ports();
  await expectRejects(dialNetconf(config({ hostKeyFingerprint: "" }), ssh, socket), DialError);
  expectBe(seen.dialled.length, 0);
  expectBe(seen.connects.length, 0);
});

test("a link-local literal is refused before anything is dialled", async () => {
  const { ssh, socket, seen } = ports();
  // The SENTENCE as well as the refusal: a dial refused for a different reason, a bad pin say,
  // would satisfy "it was refused" while proving nothing about the address rule.
  await expectRejects(dialNetconf(config({ host: "169.254.169.254" }), ssh, socket), /link-local/);
  expectBe(seen.dialled.length, 0);
});

/**
 * The address that was checked has to be the address that is dialled, which is the whole reason
 * this provider opens the socket instead of letting the library do it. The lookup the egress
 * policy answers carries that guarantee, so the socket has to receive it.
 *
 * Without this assertion a planted mutation that dropped the lookup failed no test.
 */
test("the egress lookup is handed to the socket, so the checked address is the dialled one", async () => {
  const { ssh, socket, seen } = ports();
  await dialNetconf(config({ host: "device.example.com" }), ssh, socket);
  expectTruthy(seen.dialled[0]?.lookup !== undefined);
  expectBe(typeof seen.dialled[0]?.lookup, "function");
});

test("a host key that does not match the pin ends the handshake, and the message names both", async () => {
  const { ssh, socket } = ports({ hostKey: Buffer.from("another host's key") });
  let caught: unknown;
  try {
    await dialNetconf(config(), ssh, socket);
  } catch (error) {
    caught = error;
  }
  expectTruthy(caught instanceof DialError);
  const failure = (caught as DialError).failure;
  expectBe(failure.kind, "host-key");
  // The two fingerprints are read from fields, not out of the sentence. A test that regexed them
  // out of the message would assert the wording: it would fail on a rewording that changed nothing
  // and pass if the wrong key were reported in the right words. The sentence is checked too, but
  // as a separate requirement below, because the user has to be told both causes.
  expectTruthy(failure.kind === "host-key");
  expectBe(failure.expected, PIN);
  expectBe(failure.seen, fingerprintOf(Buffer.from("another host's key")));
  expectNotBe(failure.expected, failure.seen);
  expectMatch(failure.message, /reinstalled/);
  expectMatch(failure.message, /another host/);
});

/**
 * Returning false from the verifier makes ssh2 raise its own "Host denied (verification failed)",
 * which arrives a moment later and classifies to this same kind carrying no fingerprints. Both
 * orders end the dial the same way, and the one that carries the fields always wins, because it is
 * built inside the verifier before it returns. That is why this is a fact and not a race.
 */
test("the host key failure carries its fields even when the library raises its own error after it", async () => {
  const { ssh, socket } = ports({
    hostKey: Buffer.from("another host's key"),
    libraryErrorAfterRefusal: true,
  });
  let caught: unknown;
  try {
    await dialNetconf(config(), ssh, socket);
  } catch (error) {
    caught = error;
  }
  const failure = (caught as DialError).failure;
  expectBe(failure.kind, "host-key");
  expectTruthy(failure.kind === "host-key");
  expectBe(failure.expected, PIN, "the library's own error must not be the one that settles this");
});

test("a refused host key has no second path: the session is never reached", async () => {
  const { ssh, socket, seen } = ports({ hostKey: Buffer.from("another host's key") });
  await expectRejects(dialNetconf(config(), ssh, socket), DialError);
  // The socket was dialled, the key was offered, and the subsystem was never asked for.
  expectBe(seen.dialled.length, 1);
  expectEqual(seen.subsystems, []);
});

test("a refused login carries one sentence and no detail", async () => {
  const { ssh, socket } = ports({ connectError: new Error("All configured authentication methods failed") });
  let caught: unknown;
  try {
    await dialNetconf(config(), ssh, socket);
  } catch (error) {
    caught = error;
  }
  expectBe((caught as DialError).failure.kind, "refused");
  expectBe((caught as DialError).failure.message, "authentication failed");
});

test("a key that cannot be opened is a configuration error, not an authentication failure", async () => {
  const { ssh, socket } = ports({
    connectError: new Error("Cannot parse privateKey: OpenSSH key integrity check failed -- bad passphrase?"),
  });
  let caught: unknown;
  try {
    await dialNetconf(config(), ssh, socket);
  } catch (error) {
    caught = error;
  }
  expectBe((caught as DialError).failure.kind, "configuration");
});

test("a device with no netconf subsystem is refused with a sentence that says so", async () => {
  const { ssh, socket } = ports({ subsystemError: null });
  await expectRejects(dialNetconf(config(), ssh, socket), /offers no netconf subsystem/);
});

test("the credential reaches ssh2 only as the connection supplied it", async () => {
  const { ssh, socket, seen } = ports();
  await dialNetconf(config({ privateKey: "a key", passphrase: "secret" }), ssh, socket);
  expectBe(seen.connects[0]?.privateKey, "a key");
  expectBe(seen.connects[0]?.passphrase, "secret");
  expectBe(seen.connects[0]?.password, undefined);
});

/**
 * The seam above says a lookup reached the socket. It cannot say which lookup: one is installed
 * whatever DB_HTTP_BLOCK_PRIVATE_HOSTS says, so that assertion would pass even if this dial always
 * installed the strictest check it could find. The question the provider has to answer is the other
 * one: with the flag off, is a device named by name on a local network still reachable?
 *
 * It has to be. The flag is opt-in, and `egress-policy.ts:63` says why: unset and false preserve
 * local-first connections. A NETCONF device sits on a management network nearly by definition, so a
 * provider that hardened past the flag would refuse the ordinary case. This dial asks `socketEgress`
 * for the rule and installs its answer, and the flag is read inside it (`egress-policy.ts:130`), so
 * the pair below drives the lookup the dial actually installed and shows the decision follows the
 * flag rather than this provider.
 *
 * `localhost` is resolved for real, as the shared policy's own test does: its answers are loopback,
 * which the guard refuses and the link-local rule does not, which is what separates the two cases.
 * No socket is opened to it; only the name is resolved.
 */
const EGRESS_FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const flagBefore = process.env[EGRESS_FLAG];

afterEach(() => {
  if (flagBefore === undefined) delete process.env[EGRESS_FLAG];
  else process.env[EGRESS_FLAG] = flagBefore;
});

async function lookupInstalledFor(host: string, flag: "on" | "off"): Promise<LookupFunction> {
  if (flag === "on") process.env[EGRESS_FLAG] = "true";
  else delete process.env[EGRESS_FLAG];
  const { ssh, socket, seen } = ports();
  await dialNetconf(config({ host }), ssh, socket);
  const lookup = seen.dialled[0]?.lookup;
  expectBe(typeof lookup, "function", `no lookup was installed for ${host} with the flag ${flag}`);
  return lookup as LookupFunction;
}

/** The answer the installed lookup gives for `name`: the addresses it accepted, or its refusal. */
function answerFor(lookup: LookupFunction, name: string): Promise<LookupAddress[] | Error> {
  return new Promise((resolve) => {
    lookup(name, { all: true }, (error, address) => {
      if (error) resolve(error);
      else if (Array.isArray(address)) resolve(address);
      else resolve(new Error(`the lookup answered a single address, ${address}, not a list`));
    });
  });
}

test("with the flag off, the installed lookup accepts a name that resolves to a local address", async () => {
  const lookup = await lookupInstalledFor("localhost", "off");
  const answer = await answerFor(lookup, "localhost");
  expectTruthy(Array.isArray(answer), `localhost was refused with the flag off: ${String(answer)}`);
  expectTruthy(answer.length > 0);
  // Every answer is loopback, so nothing here is public: the dial allowed it because the flag is
  // off, not because the addresses happened to pass a public-address check.
  expectTruthy(answer.every(({ address }) => address === "127.0.0.1" || address === "::1"));
});

test("with the flag on, the same dial's lookup refuses that name, and the sentence is the guard's", async () => {
  const lookup = await lookupInstalledFor("localhost", "on");
  const answer = await answerFor(lookup, "localhost");
  expectTruthy(answer instanceof Error, `localhost was accepted with the flag on: ${String(answer)}`);
  expectBe(answer.message, BLOCKED_HOST);
});

/**
 * Two configuration failures that are fixed in two different boxes must not answer one reason.
 *
 * MEASURED: both answered `key-unreadable`, the connection's private key and the device's host key
 * fingerprint alike. Their sentences differed, which helps a person reading the sentence and does
 * nothing for anything branching on the field, and a field that exists to be branched on has to
 * separate what the sentences separate. A reader sent to the key file when the fingerprint is the
 * problem edits the one thing that was correct.
 */
test("an unreadable fingerprint and an unreadable private key answer different reasons", async () => {
  const { ssh, socket } = ports();
  let caught: unknown;
  try {
    await dialNetconf(config({ hostKeyFingerprint: "MD5:aa:bb" }), ssh, socket);
  } catch (error) {
    caught = error;
  }
  const failure = (caught as DialError).failure;
  expectBe(failure.kind, "configuration");
  expectTruthy(failure.kind === "configuration");
  expectBe(failure.reason, "pin-unreadable");
  // The other one, from the same union, read off the classifier the library's error goes through.
  const key = classifyLoginFailure(new Error("Cannot parse privateKey: unsupported format"));
  expectBe(key.kind, "configuration");
  expectTruthy(key.kind === "configuration");
  expectBe(key.reason, "key-unreadable");
  expectNotBe(failure.reason, key.reason);
});

/**
 * THE SOCKET'S OWN FAILURE IS A DIAL FAILURE, and it was not before.
 *
 * MEASURED through the real route on the registration commit: an address with nobody on it answered
 * HTTP 500 `INTERNAL_ERROR`, logged "Unhandled error", carrying `connect ECONNREFUSED 127.0.0.1:9`,
 * while a port that listens and says nothing answered 503 on the same provider. Two facts of the
 * same class arriving as two different classes, and the cause was position rather than logic: the
 * `await socket.connect(...)` sat OUTSIDE the promise that classifies failures, so the raw socket
 * error never reached `classifyLoginFailure` and never became one of the four kinds.
 *
 * Asserted as the KIND and not as a sentence: the sentence is the platform's and will differ
 * between a refused connection, an unreachable network and a name that does not resolve, while the
 * kind is what decides the class the user is answered with.
 */
test("a socket that refuses leaves as a transport dial failure, not as a raw error", async () => {
  const { ssh, socket, seen } = ports({ socketError: new Error("connect ECONNREFUSED 127.0.0.1:9") });
  let caught: unknown;
  try {
    await dialNetconf(config(), ssh, socket);
  } catch (error) {
    caught = error;
  }
  expectTruthy(caught instanceof DialError);
  expectBe((caught as DialError).failure.kind, "transport");
  expectMatch((caught as DialError).failure.message, /ECONNREFUSED/);
  // The control: it failed at the socket, so the library was never asked to connect at all.
  expectEqual(seen.connects, []);
});

/**
 * A FAILED DIAL TEARS ITSELF DOWN, and the measurement behind it is a crash rather than a leak.
 *
 * On a port that listens and never speaks, the deadline answered correctly and ssh2 then raised
 * "Connection lost before handshake" on the same client. Nothing was left to receive it, so it
 * surfaced as an unhandled error out of the library, after the user had already been told the
 * truth. Two things fix it together and both are asserted here: the client is ended, and the error
 * handler stays attached, so a second delivery is ignored instead of having nowhere to go.
 */
test("a dial that fails ends its client, and a second error after that changes nothing", async () => {
  const { ssh, socket, seen } = ports({
    connectError: new Error("Timed out while waiting for handshake"),
    lateError: true,
  });
  let caught: unknown;
  try {
    await dialNetconf(config(), ssh, socket);
  } catch (error) {
    caught = error;
  }
  expectTruthy(caught instanceof DialError);
  expectBe((caught as DialError).failure.kind, "transport");
  // The teardown runs in a microtask, so it is awaited rather than assumed.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expectBe(seen.ended, 1, "the client was ended, so the socket is not left open");
});

test("a teardown that throws is not a second failure: the dial reports the first one, and nothing escapes", async () => {
  // The teardown runs in a microtask, where a throw would be an uncaught exception in the server.
  const { ssh, socket, seen } = ports({
    connectError: new Error("Timed out while waiting for handshake"),
    endThrows: true,
  });
  const caught = await dialNetconf(config(), ssh, socket).catch((error: unknown) => error);
  expectTruthy(caught instanceof DialError);
  expectBe((caught as DialError).failure.kind, "transport");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expectBe(seen.ended, 1);
});
