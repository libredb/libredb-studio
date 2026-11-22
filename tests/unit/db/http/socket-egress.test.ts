/**
 * socketEgress: the egress rule for one socket dial, the same rule the shared node transport applies when it is built.
 * It decides by the egress decision it is handed and reads no setting (FND-2 slice 2b-2). The literal checks run before
 * a lookup is chosen, because an IP literal never reaches a lookup: with a blocking decision the guard's check, and with
 * `refusesLinkLocal` the link-local check whatever the decision says. A name passes both and dials through the lookup
 * handed back, which checks the address it dials.
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
import type { EgressDecision } from "@/lib/db/types";
import {
  closeAll,
  countingListener,
  httpsListener,
  jsonAnswer,
  type Listener,
  makeCertificates,
  type TransportCertificates,
} from "../../../helpers/node-transport-fixtures";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";

let certificates: TransportCertificates;
beforeAll(() => {
  certificates = makeCertificates();
}, 30_000);

afterEach(async () => {
  await closeAll();
});

/** The decision a case hands: "blocking" blocks private destinations, as an operator's `true` does. */
function decision(state: "blocking" | "allowing"): EgressDecision {
  return state === "blocking" ? BLOCKS_PRIVATE_HOSTS : ALLOWS_PRIVATE_HOSTS;
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
    ["blocking", true, guardedLinkLocalRefusingLookup],
    ["allowing", true, linkLocalRefusingLookup],
    ["blocking", false, publicAddressLookup],
    ["allowing", false, undefined],
  ] as const)("a %s decision, refusesLinkLocal %p", (state, refusesLinkLocal, expected) => {
    expect(socketEgress("db.example.test", { refusesLinkLocal }, decision(state))).toBe(
      expected as LookupFunction | undefined,
    );
  });
});

describe("a literal is checked before any lookup is chosen", () => {
  test.each(["10.0.0.5", "127.0.0.1", "::1", "[::1]", "[fd00::7]"])(
    "with a blocking decision: %s is refused with the guard's sentence under either rule",
    (host) => {
      for (const refusesLinkLocal of [true, false]) {
        const error = refusal(() => socketEgress(host, { refusesLinkLocal }, BLOCKS_PRIVATE_HOSTS));
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect(error.message).toBe(BLOCKED_HOST);
      }
    },
  );

  test("with a blocking decision: a link-local literal gets the guard's sentence, because the guard runs first", () => {
    expect(
      refusal(() => socketEgress("169.254.169.254", { refusesLinkLocal: true }, BLOCKS_PRIVATE_HOSTS)).message,
    ).toBe(BLOCKED_HOST);
  });

  test("with a blocking decision: an empty host is refused with the guard's sentence", () => {
    expect(refusal(() => socketEgress("", { refusesLinkLocal: true }, BLOCKS_PRIVATE_HOSTS)).message).toBe(
      BLOCKED_HOST,
    );
  });

  test.each([
    "169.254.169.254",
    "fe80::1",
    "[fe80::1]",
    "fe80::1%eth0",
    "[fe80::1%eth0]",
    "[::ffff:169.254.169.254]",
    "[fd00:ec2::254]",
  ])("with an allowing decision, refusesLinkLocal: %s is refused with the link-local sentence", (host) => {
    const error = refusal(() => socketEgress(host, { refusesLinkLocal: true }, ALLOWS_PRIVATE_HOSTS));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(LINK_LOCAL_HOST);
  });

  test("with an allowing decision, without refusesLinkLocal: a link-local literal gets the runtime's own lookup, as today", () => {
    expect(socketEgress("169.254.169.254", { refusesLinkLocal: false }, ALLOWS_PRIVATE_HOSTS)).toBeUndefined();
  });

  test.each(["127.0.0.1", "[::1]", "10.0.0.5"])(
    "with an allowing decision, refusesLinkLocal: the loopback or private literal %s passes",
    (host) => {
      expect(socketEgress(host, { refusesLinkLocal: true }, ALLOWS_PRIVATE_HOSTS)).toBe(linkLocalRefusingLookup);
    },
  );

  test.each(["::1%lo", "[::1%lo]", "fe80::1%eth0", "2606:4700::1%eth0"])(
    "with a blocking decision: the zoned literal %s is refused with the guard's sentence under either rule",
    (host) => {
      for (const refusesLinkLocal of [true, false]) {
        const error = refusal(() => socketEgress(host, { refusesLinkLocal }, BLOCKS_PRIVATE_HOSTS));
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect(error.message).toBe(BLOCKED_HOST);
      }
    },
  );
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
  test("with an allowing decision: localhost dials through the link-local-refusing lookup", async () => {
    const listener = await countingListener();
    expect(await dialPlain(listener, socketEgress("localhost", { refusesLinkLocal: true }, ALLOWS_PRIVATE_HOSTS))).toBe(
      "connected",
    );
    expect(listener.accepted()).toBe(1);
  });

  test("with a blocking decision: localhost is refused by the lookup with the guard's error, and nothing is accepted", async () => {
    const listener = await countingListener();
    const outcome = await dialPlain(
      listener,
      socketEgress("localhost", { refusesLinkLocal: true }, BLOCKS_PRIVATE_HOSTS),
    );
    expect(outcome).toBeInstanceOf(DatabaseConfigError);
    expect((outcome as Error).message).toBe(BLOCKED_HOST);
    expect(listener.accepted()).toBe(0);
  });

  test("with a blocking decision, over TLS: the lookup's refusal is the error, never a TLS failure, and no handshake starts", async () => {
    const listener = await httpsListener(certificates.local, jsonAnswer(200, "{}"));
    const material = nodeTlsMaterial({ mode: "verify-full", caCert: certificates.ca }, "localhost");
    if (material === null) throw new Error("expected TLS material");
    const lookup = socketEgress("localhost", { refusesLinkLocal: true }, BLOCKS_PRIVATE_HOSTS);
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
