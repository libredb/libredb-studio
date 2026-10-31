/**
 * The composition root: a connection becomes a reader, or fails without leaving anything open.
 *
 * Every port is a fake, including the parser, so the join is held without a device: that the dial
 * is given what the connection and the credential say, that the session is opened on the dial's
 * transport, that the reader is opened on that session, and that a failure after the session exists
 * closes it.
 */
import { test } from "bun:test";
import { expectBe, expectEqual, expectRejects, expectTruthy } from "./helpers";
import {
  NETCONF_SESSION_LIMITS,
  openNetconfReader,
  openNetconfSession,
  type NetconfCredential,
} from "@/lib/db/providers/network/netconf/open";
import type { SocketPort, SshPort, SshConnectOptions } from "@/lib/db/providers/network/netconf/dial";
import type { Transport } from "@/lib/db/providers/network/netconf/session";
import type { XmlElement, XmlReaderPort } from "@/lib/db/providers/network/netconf/reader-port";
import type { DatabaseConnection } from "@/lib/db/types";
import { fingerprintOf } from "@/lib/db/providers/network/netconf/hostkey";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";

const DEVICE_KEY = Buffer.from("the device's host key");
const PIN = fingerprintOf(DEVICE_KEY);

const connection = {
  id: "c",
  name: "lab switch",
  type: "netconf",
  host: "198.51.100.7",
  createdAt: new Date(),
} as unknown as DatabaseConnection;
const credential: NetconfCredential = { username: "ro-key", hostKeyFingerprint: PIN, privateKey: "a key" };

function el(name: string, text?: string, children: XmlElement[] = []): XmlElement {
  const base = { name, attributes: new Map<string, string>(), children, bindings: new Map<string, string>() };
  return text === undefined ? base : { ...base, text };
}

const LIBRARY = el("rpc-reply", undefined, [
  el("data", undefined, [
    el("modules-state", undefined, [
      el("module", undefined, [
        el("name", "ietf-interfaces"),
        el("namespace", "urn:x:if"),
        el("conformance-type", "implement"),
      ]),
    ]),
  ]),
]);

interface Seen {
  readonly dialled: { host: string; port: number }[];
  readonly connects: SshConnectOptions[];
  readonly written: string[];
  readonly closed: { count: number };
}

function ports(over: { library?: XmlElement; parseThrows?: boolean; socketError?: unknown } = {}): {
  ports: { xml: XmlReaderPort; ssh: SshPort; socket: SocketPort };
  seen: Seen;
} {
  const seen: Seen = { dialled: [], connects: [], written: [], closed: { count: 0 } };
  let onData: ((chunk: string) => void) | null = null;
  const SERVER_HELLO =
    '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities><session-id>4</session-id></hello>';
  let requests = 0;
  const transport: Transport = {
    write: (text) => {
      seen.written.push(text);
      // The client's hello is not answered: it is the second hello, not a request. Only a request
      // gets a reply, and its message-id has to be the one that was asked, because the session
      // matches on it.
      if (text.includes("<hello")) return;
      requests += 1;
      queueMicrotask(() => onData?.(`<rpc-reply message-id="${requests}"><data/></rpc-reply>]]>]]>`));
    },
    onData: (handler) => {
      onData = handler;
      // The device speaks first. Netopeer2 sends its hello as soon as the channel opens, without
      // waiting to be asked, and the session is written to expect that: it reads the server's hello
      // and only then sends its own. A fake that answered the client's hello instead timed out, and
      // the timeout was the fake's fault, not the session's.
      queueMicrotask(() => onData?.(`${SERVER_HELLO}]]>]]>`));
    },
    onClose: () => {},
    close: () => void (seen.closed.count += 1),
  };
  return {
    seen,
    ports: {
      xml: {
        parse: () => {
          if (over.parseThrows) throw new Error("the parser refused this message");
          return over.library ?? LIBRARY;
        },
      },
      socket: {
        connect: async (options) => {
          seen.dialled.push({ host: options.host, port: options.port });
          if (over.socketError !== undefined) throw over.socketError;
          return { socket: true };
        },
      },
      ssh: {
        connect: (options) => {
          seen.connects.push(options);
          let ready: (() => void) | null = null;
          queueMicrotask(() => {
            if (options.hostVerifier(DEVICE_KEY)) ready?.();
          });
          return {
            onReady: (handler) => {
              ready = handler;
            },
            onError: () => {},
            subsystem: (_name, handler) => handler(null, transport),
            end: () => {},
          };
        },
      },
    },
  };
}

test("a connection and a credential become a reader, and the device's facts come back", async () => {
  const { ports: p, seen } = ports();
  const reader = await openNetconfReader(connection, p, credential);
  expectEqual(seen.dialled, [{ host: "198.51.100.7", port: 830 }]);
  expectBe(seen.connects[0]?.username, "ro-key");
  expectBe(seen.connects[0]?.privateKey, "a key");
  expectBe(reader.facts.sessionId, "4");
  expectEqual(reader.facts.modules, ["ietf-interfaces"]);
});

/**
 * Three cases, because one would not separate the two behaviours: a dial that always took
 * `config.port` and never defaulted would pass a test that only names a port, and a dial that
 * always defaulted would pass one that only omits it. The third is the case a connection form can
 * really produce, a port of 0, which must read as "not named" rather than as port zero.
 */
test("the port dialled is the one the connection names, and 830 when it names none", async () => {
  const named = ports();
  await openNetconfReader({ ...connection, port: 2830 } as DatabaseConnection, named.ports, credential);
  expectBe(named.seen.dialled[0]?.port, 2830);

  const unnamed = ports();
  await openNetconfReader(connection, unnamed.ports, credential);
  expectBe(unnamed.seen.dialled[0]?.port, 830);

  const zero = ports();
  await openNetconfReader({ ...connection, port: 0 } as DatabaseConnection, zero.ports, credential);
  expectBe(zero.seen.dialled[0]?.port, 830, "a port of zero is no port, not port zero");
});

test("the published session limits are what the dial and the session run under", async () => {
  const { ports: p, seen } = ports();
  await openNetconfReader(connection, p, credential);
  expectBe(seen.connects[0]?.readyTimeout, NETCONF_SESSION_LIMITS.helloMs);
  expectBe(NETCONF_SESSION_LIMITS.helloMs, 15_000);
  expectBe(NETCONF_SESSION_LIMITS.requestMs, 120_000);
  expectBe(NETCONF_SESSION_LIMITS.maxMessageBytes, 16_777_216);
  expectBe(NETCONF_SESSION_LIMITS.maxBufferBytes, 33_554_432);
});

/**
 * MEASURED 2026-10-13: a dial with no credential is refused by the device with the same sentence a
 * wrong password gets, so sending one teaches nothing and leaves a line in the device's auth log.
 */
test("a connection with neither a key nor a password is refused before anything is dialled", async () => {
  const { ports: p, seen } = ports();
  await expectRejects(
    openNetconfReader(connection, p, { username: "ro-key", hostKeyFingerprint: PIN }),
    DatabaseConfigError,
  );
  expectBe(seen.dialled.length, 0);
});

test("an address or an account the connection does not carry is refused by name", async () => {
  const { ports: p, seen } = ports();
  await expectRejects(
    openNetconfReader({ ...connection, host: "" } as DatabaseConnection, p, credential),
    /needs the device's address/,
  );
  await expectRejects(openNetconfReader(connection, p, { ...credential, username: "" }), /account name/);
  expectBe(seen.dialled.length, 0);
});

/**
 * A device's session table is a shared resource and a failure here is the moment it leaks: the
 * session exists, so nothing else will close it, and the device holds the channel until its own
 * idle timer runs. One leaked entry per failed open is what exhausts it.
 */
test("a failure after the session is open closes the session", async () => {
  const { ports: p, seen } = ports({ parseThrows: true });
  // The parser's own refusal has to be the one that comes out: a close that swallowed it and threw
  // its own error would still "reject", and the test would pass while the cause was lost.
  await expectRejects(openNetconfReader(connection, p, credential), /the parser refused this message/);
  expectTruthy(seen.closed.count >= 1, "the session was left open after the reader failed");
});

/**
 * THE TRANSLATION IS WIRED, which is a different claim from the translation being correct.
 *
 * `failures.test.ts` holds the table itself, and a mutation proved that is not enough: removing
 * the conversion from this composition root killed NO test, because every assertion about it was
 * made by calling the converter directly. That is the same "written but not connected" shape this
 * provider has already been caught by twice tonight, so the wiring gets its own test here.
 *
 * MEASURED through the real route before the wiring: HTTP 500 `INTERNAL_ERROR`, logged "Unhandled
 * error", for an address with nobody on it. The class below is what makes that a 503.
 */
test("a dial failure leaves this function as a ConnectionError that names the address", async () => {
  const { ports: p } = ports({ socketError: new Error("connect ECONNREFUSED") });
  let caught: unknown;
  try {
    await openNetconfReader({ ...connection, port: 1830 } as DatabaseConnection, p, credential);
  } catch (error) {
    caught = error;
  }
  expectTruthy(caught instanceof ConnectionError);
  // The address, because the platform's own sentence here carries none, and a reader told only
  // that a dial failed has not been told which device.
  expectTruthy((caught as Error).message.includes("1830"));
});

test("the agent's door opens a session and reads nothing on it, through the same dial and the same conversion", async () => {
  const { ports: p, seen } = ports();
  const session = await openNetconfSession(
    { ...connection, user: "ro-key", privateKey: "a key", hostKeyFingerprint: PIN } as DatabaseConnection,
    p,
  );
  expectEqual(seen.dialled, [{ host: "198.51.100.7", port: 830 }]);
  // The client's hello alone: the library is the agent client's first read, not this door's.
  expectBe(seen.written.length, 1);
  expectTruthy(seen.written[0]?.includes("<hello"));
  await session.close();
  expectTruthy(seen.written.some((text) => text.includes("<close-session/>")));
});

test("the agent's door refuses a missing address by name and names the address of a dial that fails", async () => {
  await expectRejects(
    openNetconfSession({ ...connection, host: "" } as DatabaseConnection, ports().ports),
    DatabaseConfigError,
  );
  const { ports: p } = ports({ socketError: new Error("connect ECONNREFUSED") });
  let caught: unknown;
  try {
    await openNetconfSession(
      { ...connection, port: 1830, user: "ro-key", privateKey: "a key", hostKeyFingerprint: PIN } as DatabaseConnection,
      p,
    );
  } catch (error) {
    caught = error;
  }
  expectTruthy(caught instanceof ConnectionError);
  expectTruthy((caught as Error).message.includes("1830"));
});
