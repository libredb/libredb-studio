/**
 * The dial, and the one regression it exists to prevent.
 *
 * THE CASE THAT MATTERS. The shared egress helpers do not all behave the same way about
 * `DB_HTTP_BLOCK_PRIVATE_HOSTS`: `assertPublicLiteralHost` returns early when the flag is off,
 * `assertPublicDnsAnswers` checks no flag at all, and `guardedNodeOptions` returns `{}` when the
 * flag is off so the lookup is never installed. A provider that calls the DNS guard directly, or
 * installs the lookup unconditionally, therefore refuses every NAME-addressed device even with the
 * flag off. For Modbus that is the common case rather than an edge: a controller sits on a local
 * network and is usually addressed by name. The second test below is the one that fails if this
 * module ever stops asking `socketEgress` and starts deciding for itself.
 *
 * BOTH ADDRESS FORMS ARE PRESENT ON PURPOSE. A fixture of literals only leaves the DNS branch
 * unexercised, and a mutation there stays green while the branch is dead to the test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  dialModbus,
  exchangeOnce,
  ModbusDialError,
  ModbusDialTimeout,
} from "@/lib/db/providers/industrial/modbus/client";

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const originalFlag = process.env[FLAG];
const open: Server[] = [];

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
  for (const server of open.splice(0)) server.close();
});

/** A listener that answers one canned FC 03 response, or stays silent, on a loopback port. */
async function listener(behave: "answer" | "silent" | "close"): Promise<number> {
  const server = createServer((socket) => {
    if (behave === "close") {
      socket.destroy();
      return;
    }
    socket.on("data", () => {
      if (behave !== "answer") return;
      const pdu = Buffer.from([0x03, 0x04, 0x00, 0x07, 0x00, 0x0e]);
      const head = Buffer.alloc(7);
      head.writeUInt16BE(1, 0);
      head.writeUInt16BE(0, 2);
      head.writeUInt16BE(pdu.length + 1, 4);
      head[6] = 1;
      socket.write(Buffer.concat([head, pdu]));
    });
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

const request = () => {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(1, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(6, 4);
  b[6] = 1;
  b[7] = 3;
  b.writeUInt16BE(0, 8);
  b.writeUInt16BE(2, 10);
  return b;
};

describe("with the guard off, a local device is reachable both ways", () => {
  test("by IP literal", async () => {
    delete process.env[FLAG];
    const port = await listener("answer");
    const socket = await dialModbus({ host: "127.0.0.1", port });
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });

  /**
   * The regression test. A provider that installed the checked lookup unconditionally would refuse
   * this, because the DNS guard blocks loopback and checks no flag of its own.
   */
  test("by NAME, which is how a controller is usually addressed", async () => {
    delete process.env[FLAG];
    const port = await listener("answer");
    const socket = await dialModbus({ host: "localhost", port });
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });
});

describe("with the guard on, the shared rule refuses and its own words are kept", () => {
  test("a private literal is refused before any socket exists", async () => {
    process.env[FLAG] = "true";
    const error = await dialModbus({ host: "10.20.30.40", port: 502 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseConfigError);
  });

  test("a loopback literal is refused too, which is why the flag is off for local work", async () => {
    process.env[FLAG] = "true";
    const error = await dialModbus({ host: "127.0.0.1", port: 502 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseConfigError);
  });
});

describe("link-local, where the cost runs the other way than it does for a broker", () => {
  test("refused by default, whatever the flag says", async () => {
    delete process.env[FLAG];
    const error = await dialModbus({ host: "169.254.10.20", port: 502 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseConfigError);
  });

  test("reachable only when the call site says so, which is where that decision belongs", async () => {
    delete process.env[FLAG];
    const port = await listener("answer");
    const socket = await dialModbus({ host: "127.0.0.1", port, refusesLinkLocal: false });
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });
});

describe("one exchange on an open socket", () => {
  test("a complete answer resolves with the frame", async () => {
    delete process.env[FLAG];
    const port = await listener("answer");
    const socket = await dialModbus({ host: "127.0.0.1", port });
    const frame = await exchangeOnce(socket, request());
    expect(frame.functionCode).toBe(3);
    expect(frame.unitId).toBe(1);
    socket.destroy();
  });

  test("a silent device ends by our own timer and names the time", async () => {
    delete process.env[FLAG];
    const port = await listener("silent");
    const socket = await dialModbus({ host: "127.0.0.1", port });
    const error = await exchangeOnce(socket, request(), { timeoutMs: 40 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModbusDialTimeout);
    expect((error as Error).message).toContain("40 ms");
    socket.destroy();
  });

  test("a device that closes before answering is reported as that, not as a timeout", async () => {
    delete process.env[FLAG];
    const port = await listener("close");
    const socket = await dialModbus({ host: "127.0.0.1", port }).catch(() => undefined);
    if (socket === undefined) return;
    const error = await exchangeOnce(socket, request(), { timeoutMs: 500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModbusDialError);
  });
});

/**
 * The dial timer, measured directly rather than through the network.
 *
 * These tests exist because a mutation found the timer unbound: setting it to zero left the whole
 * suite green, while the commit that introduced it said the dial carries its own timer. A real
 * loopback listener connects immediately and an unroutable address makes the test depend on the
 * network, so the socket is supplied instead and the timer is the only thing under test.
 */
describe("the dial timer", () => {
  /** A socket that is never ready: it announces nothing, exactly like a listener that never accepts. */
  function silentSocket(): { socket: unknown; destroyed: () => boolean; timeoutMs: () => number } {
    let timeoutMs = -1;
    let destroyed = false;
    let fire: (() => void) | undefined;
    const socket = {
      setTimeout(ms: number, listener?: () => void) {
        timeoutMs = ms;
        if (listener !== undefined) fire = listener;
        if (ms > 0 && fire !== undefined) setTimeout(fire, ms);
        return socket;
      },
      on() {
        return socket;
      },
      once() {
        return socket;
      },
      write() {
        return true;
      },
      destroy() {
        destroyed = true;
        return socket;
      },
      get destroyed() {
        return destroyed;
      },
    };
    return { socket, destroyed: () => destroyed, timeoutMs: () => timeoutMs };
  }

  test("a listener that never accepts ends by our timer, and the time is in the sentence", async () => {
    delete process.env[FLAG];
    const fake = silentSocket();
    const error = await dialModbus(
      { host: "203.0.113.7", port: 502 },
      { dialTimeoutMs: 30, connect: () => fake.socket as never },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModbusDialTimeout);
    expect((error as Error).message).toContain("30 ms");
  });

  test("the socket is destroyed when the dial times out, so nothing is left half open", async () => {
    delete process.env[FLAG];
    const fake = silentSocket();
    await dialModbus(
      { host: "203.0.113.7", port: 502 },
      { dialTimeoutMs: 20, connect: () => fake.socket as never },
    ).catch(() => undefined);
    expect(fake.destroyed()).toBe(true);
  });

  test("the timer is armed with a positive value, which a zero would not be", async () => {
    delete process.env[FLAG];
    const fake = silentSocket();
    await dialModbus(
      { host: "203.0.113.7", port: 502 },
      { dialTimeoutMs: 25, connect: () => fake.socket as never },
    ).catch(() => undefined);
    expect(fake.timeoutMs()).toBe(25);
    expect(fake.timeoutMs()).toBeGreaterThan(0);
  });
});
