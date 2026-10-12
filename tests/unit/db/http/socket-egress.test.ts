/**
 * socketEgress: the egress rule for one socket dial, the same rule the shared node transport applies when it is built.
 * The literal checks run before a lookup is chosen, because an IP literal never reaches a lookup: with
 * DB_HTTP_BLOCK_PRIVATE_HOSTS on the guard's check, and with `refusesLinkLocal` the link-local check whatever the flag
 * says. A name passes both and dials through the lookup handed back, which checks the address it dials.
 *
 * No resolver is mocked: the four results are told apart by identity, a literal is refused before anything resolves,
 * and the dials go to `localhost`, which every resolver answers from the hosts file.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { connect as netConnect, type LookupFunction } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  assertPublicDnsAnswers,
  BLOCKED_HOST,
  guardedLinkLocalRefusingLookup,
  LINK_LOCAL_HOST,
  linkLocalRefusingLookup,
  publicAddressLookup,
  socketEgress,
} from "@/lib/db/http/egress-policy";
import { nodeTlsConnectOptions, nodeTlsMaterial } from "@/lib/db/http/node-transport";
import {
  closeAll,
  countingListener,
  httpsListener,
  jsonAnswer,
  type Listener,
  makeCertificates,
  type TransportCertificates,
} from "../../../helpers/node-transport-fixtures";

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[FLAG];

let certificates: TransportCertificates;
beforeAll(() => {
  certificates = makeCertificates();
}, 30_000);

afterEach(async () => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
  await closeAll();
});

function flag(state: "on" | "off"): void {
  if (state === "on") process.env[FLAG] = "true";
  else delete process.env[FLAG];
}

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

describe("the four results for a name", () => {
  test.each([
    ["on", true, guardedLinkLocalRefusingLookup],
    ["off", true, linkLocalRefusingLookup],
    ["on", false, publicAddressLookup],
    ["off", false, undefined],
  ] as const)("flag %s, refusesLinkLocal %p", (state, refusesLinkLocal, expected) => {
    flag(state);
    expect(socketEgress("db.example.test", { refusesLinkLocal })).toBe(expected as LookupFunction | undefined);
  });
});

describe("a literal is checked before any lookup is chosen", () => {
  test.each(["10.0.0.5", "127.0.0.1", "::1", "[::1]", "[fd00::7]"])(
    "flag on: %s is refused with the guard's sentence under either rule",
    (host) => {
      flag("on");
      for (const refusesLinkLocal of [true, false]) {
        const error = refusal(() => socketEgress(host, { refusesLinkLocal }));
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect(error.message).toBe(BLOCKED_HOST);
      }
    },
  );

  test("flag on: a link-local literal gets the guard's sentence, because the guard runs first", () => {
    flag("on");
    expect(refusal(() => socketEgress("169.254.169.254", { refusesLinkLocal: true })).message).toBe(BLOCKED_HOST);
  });

  test("flag on: an empty host is refused with the guard's sentence", () => {
    flag("on");
    expect(refusal(() => socketEgress("", { refusesLinkLocal: true })).message).toBe(BLOCKED_HOST);
  });

  test.each([
    "169.254.169.254",
    "fe80::1",
    "[fe80::1]",
    "fe80::1%eth0",
    "[fe80::1%eth0]",
    "[::ffff:169.254.169.254]",
    "[fd00:ec2::254]",
  ])("flag off, refusesLinkLocal: %s is refused with the link-local sentence", (host) => {
    flag("off");
    const error = refusal(() => socketEgress(host, { refusesLinkLocal: true }));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(LINK_LOCAL_HOST);
  });

  test("flag off, without refusesLinkLocal: a link-local literal gets the runtime's own lookup, as today", () => {
    flag("off");
    expect(socketEgress("169.254.169.254", { refusesLinkLocal: false })).toBeUndefined();
  });

  test.each(["127.0.0.1", "[::1]", "10.0.0.5"])(
    "flag off, refusesLinkLocal: the loopback or private literal %s passes",
    (host) => {
      flag("off");
      expect(socketEgress(host, { refusesLinkLocal: true })).toBe(linkLocalRefusingLookup);
    },
  );

  test.each(["::1%lo", "[::1%lo]", "fe80::1%eth0", "2606:4700::1%eth0"])(
    "flag on: the zoned literal %s is refused with the guard's sentence under either rule",
    (host) => {
      flag("on");
      for (const refusesLinkLocal of [true, false]) {
        const error = refusal(() => socketEgress(host, { refusesLinkLocal }));
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect(error.message).toBe(BLOCKED_HOST);
      }
    },
  );

  test("an invalid flag value fails closed before any address is read", () => {
    process.env[FLAG] = "maybe";
    const error = refusal(() => socketEgress("db.example.test", { refusesLinkLocal: true }));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Invalid DB_HTTP_BLOCK_PRIVATE_HOSTS: expected true or false");
  });
});

describe("a DNS answer with a zone index", () => {
  test.each(["::1%lo", "fe80::1%eth0", "2606:4700::1%eth0"])(
    "the guard's answer check refuses %s with the guard's sentence, alone or beside a public answer",
    (address) => {
      for (const answers of [
        [{ address, family: 6 }],
        [
          { address: "2606:4700::1", family: 6 },
          { address, family: 6 },
        ],
      ]) {
        const error = refusal(() => assertPublicDnsAnswers(answers));
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect(error.message).toBe(BLOCKED_HOST);
      }
    },
  );
});

/**
 * Dials `localhost` on the listener's port with the lookup given: "connected" once the listener has closed the
 * connection, or the error the socket raised. The client's connect event can come before the listener's connection
 * event (measured on macOS), and the counting listener closes each connection from that event, so waiting for the
 * close means its count already includes this dial.
 */
function dialPlain(listener: Listener, lookup: LookupFunction | undefined): Promise<"connected" | Error> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "localhost", port: listener.port, ...(lookup === undefined ? {} : { lookup }) });
    let connected = false;
    let failure = new Error("the socket closed before it connected, without an error");
    socket.once("connect", () => {
      connected = true;
    });
    socket.on("error", (error) => {
      failure = error;
    });
    socket.once("close", () => resolve(connected ? "connected" : failure));
  });
}

describe("a dial through the lookup handed back", () => {
  test("flag off: localhost dials through the link-local-refusing lookup", async () => {
    flag("off");
    const listener = await countingListener();
    expect(await dialPlain(listener, socketEgress("localhost", { refusesLinkLocal: true }))).toBe("connected");
    expect(listener.accepted()).toBe(1);
  });

  test("flag on: localhost is refused by the lookup with the guard's error, and nothing is accepted", async () => {
    flag("on");
    const listener = await countingListener();
    const outcome = await dialPlain(listener, socketEgress("localhost", { refusesLinkLocal: true }));
    expect(outcome).toBeInstanceOf(DatabaseConfigError);
    expect((outcome as Error).message).toBe(BLOCKED_HOST);
    expect(listener.accepted()).toBe(0);
  });

  test("flag on, over TLS: the lookup's refusal is the error, never a TLS failure, and no handshake starts", async () => {
    flag("on");
    const listener = await httpsListener(certificates.local, jsonAnswer(200, "{}"));
    const material = nodeTlsMaterial({ mode: "verify-full", caCert: certificates.ca }, "localhost");
    if (material === null) throw new Error("expected TLS material");
    const lookup = socketEgress("localhost", { refusesLinkLocal: true });
    const events: string[] = [];
    const outcome = await new Promise<Error>((resolve) => {
      const socket = tlsConnect({
        host: "localhost",
        port: listener.port,
        ...(lookup === undefined ? {} : { lookup }),
        ...nodeTlsConnectOptions(material),
      });
      socket.once("connect", () => events.push("connect"));
      socket.once("secureConnect", () => events.push("secureConnect"));
      socket.once("error", (error) => {
        socket.destroy();
        resolve(error);
      });
    });
    expect(outcome).toBeInstanceOf(DatabaseConfigError);
    expect(outcome.message).toBe(BLOCKED_HOST);
    expect(events).toEqual([]);
    expect(listener.accepted()).toBe(0);
  });
});
