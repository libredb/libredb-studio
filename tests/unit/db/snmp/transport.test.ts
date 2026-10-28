/**
 * The socket the client is given, and the two things it refuses (SN-S4, SN-S1).
 *
 * The guard lives in the `dgramModule` the client is handed, not in a patch on a socket's own
 * `send`. Measured on 13 October 2026 under Node 24.14.0 and Bun 1.4.2: a datagram sent before
 * a socket's bind completes is queued and flushed by re-entering the same public `send` with
 * the scatter and gather form, so a patch sits inside that path and sees a shape set that
 * depends on a race, while this facade sits above it. The facade still accepts both shapes and
 * joins a payload list before reading it, because the cost is small and the failure it prevents
 * is bytes reaching the wire unread.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import { createGuardedSocketFactory, EgressRefusal } from "@/lib/db/providers/network/snmp/transport";
import { ValveRefusal } from "@/lib/db/providers/network/snmp/valve";

const PORT = 21245;
const GET = Buffer.from([
  0x30, 0x0e, 0x02, 0x01, 0x01, 0x04, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63, 0xa0, 0x01, 0x00,
]);
const SET = Buffer.from([
  0x30, 0x0e, 0x02, 0x01, 0x01, 0x04, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63, 0xa3, 0x01, 0x00,
]);

let listener: dgram.Socket;
let socket: ReturnType<ReturnType<typeof createGuardedSocketFactory>["dgramModule"]["createSocket"]>;

beforeAll(async () => {
  listener = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => listener.bind(PORT, "127.0.0.1", () => resolve()));
  const factory = createGuardedSocketFactory({
    target: { address: "127.0.0.1", port: PORT },
    createRawSocket: () => dgram.createSocket("udp4"),
  });
  socket = factory.dgramModule.createSocket("udp4");
  await factory.start();
});

afterAll(() => {
  socket.close();
  listener.close();
});

const send = (run: (callback: (error?: Error) => void) => void): Promise<string> =>
  new Promise((resolve) => {
    try {
      run((error) => resolve(error ? error.constructor.name : "sent"));
    } catch (error) {
      resolve(`threw ${(error as Error).constructor.name}`);
    }
  });

describe("the guard refuses a target that is not this connection's agent", () => {
  test("in the six argument shape", async () => {
    expect(await send((cb) => socket.send(GET, 0, GET.length, 9999, "203.0.113.254", cb))).toBe(EgressRefusal.name);
  });
  test("in the four argument shape, where the target sits in different positions", async () => {
    expect(await send((cb) => socket.send([GET], 9999, "203.0.113.254", cb))).toBe(EgressRefusal.name);
  });
});

describe("the valve runs on both shapes, not only the one the client uses", () => {
  test("a write PDU in the six argument shape", async () => {
    expect(await send((cb) => socket.send(SET, 0, SET.length, PORT, "127.0.0.1", cb))).toBe(ValveRefusal.name);
  });
  test("a write PDU hidden in a payload list", async () => {
    expect(await send((cb) => socket.send([SET], PORT, "127.0.0.1", cb))).toBe(ValveRefusal.name);
  });
});

describe("a read to the right target goes out", () => {
  test("the six argument shape the client actually uses", async () => {
    expect(await send((cb) => socket.send(GET, 0, GET.length, PORT, "127.0.0.1", cb))).toBe("sent");
  });
});

/**
 * THE REFUSALS THAT HAD NO CASE, and why each of them is worth one.
 *
 * Every line below was uncovered when the coverage gate was first run against this branch. None
 * of them needed a socket or a fixture: each is a refusal the facade makes before anything
 * reaches the wire, which is the half of the egress guard that only shows when it is asked to
 * refuse. A guard with no case for its refusals is a guard that has only ever been seen saying
 * yes.
 */
describe("the payload shapes the facade refuses to read", () => {
  test("a payload list holding something that is not bytes", async () => {
    // The joined form is what the valve reads, so a list this wrapper cannot join is a list it
    // must not pass on: the bytes it would send are not the bytes it inspected.
    expect(await send((cb) => socket.send([GET, "not bytes"] as never, PORT, "127.0.0.1", cb))).toBe(
      `threw ${EgressRefusal.name}`,
    );
  });

  test("a payload that is neither bytes nor a list of bytes", async () => {
    expect(await send((cb) => socket.send(42 as never, PORT, "127.0.0.1", cb))).toBe(`threw ${EgressRefusal.name}`);
  });

  test("an offset and length that fall outside the payload", async () => {
    expect(await send((cb) => socket.send(GET, 0, GET.length + 5, PORT, "127.0.0.1", cb))).toBe(
      `threw ${EgressRefusal.name}`,
    );
  });

  test("a target that is not a port and an address", async () => {
    expect(await send((cb) => socket.send(GET, 0, 4, "not-a-port" as never, "127.0.0.1", cb))).toBe(
      `threw ${EgressRefusal.name}`,
    );
  });

  test("a send in a shape the library does not have is refused, not guessed at", async () => {
    const call = socket.send as unknown as (...args: unknown[]) => void;
    expect(await send(() => call(GET, PORT))).toBe(`threw ${EgressRefusal.name}`);
    expect(() => call(GET, PORT)).toThrow("refused a send in a shape this wrapper does not know (2 arguments)");
  });

  test("a write PDU to the right agent with no callback throws the valve's refusal", async () => {
    const call = socket.send as unknown as (...args: unknown[]) => void;
    expect(() => call(SET, 0, SET.length, PORT, "127.0.0.1")).toThrow(ValveRefusal);
  });

  test("a wrong target with no callback throws rather than reporting", async () => {
    // The callback form answers the caller; without one there is nowhere to answer, and the only
    // honest move left is to throw. Both arms are held, because a refusal that silently returns
    // would be a datagram the caller believes it sent.
    expect(await send(() => socket.send(GET, 0, GET.length, 9999, "203.0.113.254"))).toBe(
      `threw ${EgressRefusal.name}`,
    );
  });
});

describe("a send before the socket is connected", () => {
  const unstarted = () => {
    const factory = createGuardedSocketFactory({
      target: { address: "127.0.0.1", port: PORT },
      createRawSocket: () => dgram.createSocket("udp4"),
    });
    return { factory, socket: factory.dgramModule.createSocket("udp4") };
  };

  test("is refused through the callback", async () => {
    // `start` has not run, so there is no connected socket to send on. The guard refuses here
    // rather than letting node throw its own error about a missing address, which is a sentence
    // about this wrapper's own mistake and not about the caller's.
    const { socket: fresh } = unstarted();
    expect(await send((cb) => fresh.send(GET, 0, GET.length, PORT, "127.0.0.1", cb))).toBe(EgressRefusal.name);
    fresh.close();
  });

  test("and thrown when there is no callback", async () => {
    const { socket: fresh } = unstarted();
    expect(await send(() => fresh.send(GET, 0, GET.length, PORT, "127.0.0.1"))).toBe(`threw ${EgressRefusal.name}`);
    fresh.close();
  });

  test("and starting before asking for a socket is refused by name", async () => {
    const factory = createGuardedSocketFactory({
      target: { address: "127.0.0.1", port: PORT },
      createRawSocket: () => dgram.createSocket("udp4"),
    });
    await expect(factory.start()).rejects.toThrow(/has not asked for a socket/);
  });
});
