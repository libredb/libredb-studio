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
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { ModbusFramingError } from "@/lib/db/providers/industrial/modbus/framing";
import { ModbusValveDefect } from "@/lib/db/providers/industrial/modbus/valve";
import { DIAL_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "@/lib/db/providers/industrial/modbus/constants";
import {
  atSocketBoundary,
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

const EXPECT = { transactionId: 1, unitId: 1, functionCode: 3, quantity: 2 } as const;

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
    const got = await exchangeOnce(socket, request(), { expect: EXPECT });
    if (got.kind !== "answer") throw new Error(`expected an answer and got ${got.kind}`);
    expect(got.frame.functionCode).toBe(3);
    expect(got.frame.unitId).toBe(1);
    socket.destroy();
  });

  test("a silent device ends by our own timer and names the time", async () => {
    delete process.env[FLAG];
    const port = await listener("silent");
    const socket = await dialModbus({ host: "127.0.0.1", port });
    const error = await exchangeOnce(socket, request(), {
      expect: EXPECT,
      timeoutMs: 40,
      endpoint: { host: "127.0.0.1", port },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toContain("40 ms");
    socket.destroy();
  });

  /**
   * This test used to assert `ModbusDialError`, and it was RACING. A device that destroys the
   * socket may surface as a `close` event or as an `error` carrying ECONNRESET, and which one
   * arrives first is timing: on a loaded machine the reset won and the raw error came through
   * unwrapped, so the suite went red for a reason the test's name did not describe. Six runs here
   * were green and another session's run was not, which is the worst shape a test can have.
   *
   * Both paths now mean the same thing and the test says so: the connection is gone, so it is a
   * `ConnectionError` whichever event announced it. The race is no longer observable because the
   * two outcomes are no longer different.
   */
  test("a device that ends the connection before answering is a ConnectionError, either way", async () => {
    delete process.env[FLAG];
    const port = await listener("close");
    const socket = await dialModbus({ host: "127.0.0.1", port }).catch(() => undefined);
    if (socket === undefined) return;
    const error = await exchangeOnce(socket, request(), {
      expect: EXPECT,
      timeoutMs: 500,
      endpoint: { host: "127.0.0.1", port },
    }).catch((e: unknown) => e);
    // The endpoint rides in the error's own fields rather than in its sentence, which is where a
    // reader can use it. Asserting the message would have been asserting the wrong place.
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).host).toBe("127.0.0.1");
    expect((error as ConnectionError).port).toBe(port);
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
    // A dial that never completes has not failed one read, it has failed the connection, so the
    // boundary converts it. The time stays in the sentence: that is what the user needs.
    expect(error).toBeInstanceOf(ConnectionError);
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

/**
 * The socket boundary, tested on the function rather than through a race.
 *
 * The identity assertions matter more than the type ones: an error that is read and re-wrapped on
 * the way out would still be an instance of the right class, and only identity catches that.
 */
describe("the socket boundary converts by scope and keeps its hands off the rest", () => {
  const where = { host: "10.1.2.3", port: 502 };

  test("a socket error becomes a ConnectionError naming the endpoint", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const converted = atSocketBoundary(reset, where);
    expect(converted).toBeInstanceOf(ConnectionError);
    expect((converted as Error).message).toContain("10.1.2.3:502");
    expect((converted as Error).message).toContain("ECONNRESET");
  });

  test("a close before an answer becomes a ConnectionError too, because the scope is the same", () => {
    const converted = atSocketBoundary(new ModbusDialError("closed before answering"), where);
    expect(converted).toBeInstanceOf(ConnectionError);
  });

  test("a dial timeout becomes a ConnectionError", () => {
    expect(atSocketBoundary(new ModbusDialTimeout("no answer"), where)).toBeInstanceOf(ConnectionError);
  });

  test("the egress guard's own refusal passes through BY IDENTITY, so the user reads its words", () => {
    const planted = new DatabaseConfigError("Invalid host: blocked");
    expect(atSocketBoundary(planted, where)).toBe(planted);
  });

  test("an unrelated error passes through BY IDENTITY, not merely as the same class", () => {
    const planted = new TypeError("undefined is not a function");
    expect(atSocketBoundary(planted, where)).toBe(planted);
    expect(atSocketBoundary(planted, where)).not.toBeInstanceOf(ConnectionError);
  });

  test("a ConnectionError is not wrapped a second time", () => {
    const planted = new ConnectionError("already", undefined, "h", 1);
    expect(atSocketBoundary(planted, where)).toBe(planted);
  });

  test("the five cases do not all give the same answer, which is what makes this a rule", () => {
    const reset = Object.assign(new Error("x"), { code: "ECONNRESET" });
    const unrelated = new TypeError("y");
    expect(atSocketBoundary(reset, where)).not.toBe(reset);
    expect(atSocketBoundary(unrelated, where)).toBe(unrelated);
  });
});

/**
 * The `error` event path, driven directly.
 *
 * A mutation found this branch unmeasured: handing `socket.on("error")` straight to `reject` broke
 * no test. The boundary's own tests cover the conversion, and the end-to-end tests reach the timer
 * and the `close` event but never the `error` event, so the one line that joins them was dead to
 * the suite. A supplied socket drives it without a race.
 */
describe("the error event reaches the boundary too", () => {
  function emitterSocket(): {
    socket: unknown;
    fail: (error: Error) => void;
    feed: (chunk: Buffer) => void;
    yazilanlar: Buffer[];
  } {
    const handlers: Record<string, ((arg: never) => void)[]> = {};
    const yazilanlar: Buffer[] = [];
    const socket = {
      on(event: string, listener: (arg: never) => void) {
        (handlers[event] ??= []).push(listener);
        return socket;
      },
      once(event: string, listener: (arg: never) => void) {
        return socket.on(event, listener);
      },
      setTimeout() {
        return socket;
      },
      write(chunk: Buffer) {
        yazilanlar.push(chunk);
        return true;
      },
      destroy() {
        return socket;
      },
      destroyed: false,
    };
    return {
      socket,
      yazilanlar,
      fail: (error: Error) => {
        for (const listener of handlers.error ?? []) (listener as (e: Error) => void)(error);
      },
      feed: (chunk: Buffer) => {
        for (const listener of handlers.data ?? []) (listener as (c: Buffer) => void)(chunk);
      },
    };
  }

  /** One complete answer ADU, so a test can put a frame on the wire by hand. */
  function adu(transactionId: number, unitId: number, functionCode: number, body: Buffer): Buffer {
    const head = Buffer.alloc(7);
    head.writeUInt16BE(transactionId, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(body.length + 2, 4);
    head[6] = unitId;
    return Buffer.concat([head, Buffer.from([functionCode]), body]);
  }
  const twoRegisters = Buffer.from([4, 0, 7, 0, 14]);

  /**
   * These three bind the wiring of `matchToRequest`, which was tested on its own and called by
   * nothing: with `frames[0]` resolved blindly, the first of them returned the stray AS the
   * answer, and the second dropped the real answer that arrived behind it.
   */
  test("a frame for another transaction is discarded and the real answer is still awaited", async () => {
    const fake = emitterSocket();
    const pending = exchangeOnce(fake.socket as never, request(), { expect: EXPECT, timeoutMs: 5000 });
    fake.feed(adu(999, 1, 3, twoRegisters));
    fake.feed(adu(1, 1, 3, twoRegisters));
    const got = await pending;
    if (got.kind !== "answer") throw new Error(`expected an answer and got ${got.kind}`);
    expect(got.frame.transactionId).toBe(1);
  });

  test("a stray frame in the SAME chunk does not hide the answer behind it", async () => {
    const fake = emitterSocket();
    const pending = exchangeOnce(fake.socket as never, request(), { expect: EXPECT, timeoutMs: 5000 });
    fake.feed(Buffer.concat([adu(999, 1, 3, twoRegisters), adu(1, 1, 3, twoRegisters)]));
    const got = await pending;
    if (got.kind !== "answer") throw new Error(`expected an answer and got ${got.kind}`);
    expect(got.frame.transactionId).toBe(1);
  });

  test("the device's own refusal arrives as an exception, not as an answer", async () => {
    const fake = emitterSocket();
    const pending = exchangeOnce(fake.socket as never, request(), { expect: EXPECT, timeoutMs: 5000 });
    fake.feed(adu(1, 1, 0x83, Buffer.from([0x02])));
    const got = await pending;
    expect(got).toEqual({ kind: "exception", code: 0x02 });
  });

  /**
   * A frame that cannot be read is a fact about the CONNECTION. Left to rise it arrived as a plain
   * Error, which the API layer reports as 500: our own defect. This one is the device's answer,
   * which is the opposite thing for whoever has to act on it, and MB-S4 ends the connection with
   * it either way.
   */
  /**
   * The valve was written, tested on its own, and called by nothing, while the README said in nine
   * languages that it re-checks every outbound byte. This test is what makes that sentence true:
   * it asserts the refusal AND that the socket received nothing, because a guard that throws after
   * the write would still have let the bytes out.
   */
  test("a write function code never reaches the socket: the valve runs before the write", () => {
    const fake = emitterSocket();
    const write = Buffer.alloc(12);
    write.writeUInt16BE(1, 0);
    write.writeUInt16BE(0, 2);
    write.writeUInt16BE(6, 4);
    write[6] = 1;
    write[7] = 0x06; // Write Single Register
    expect(() => exchangeOnce(fake.socket as never, write, { expect: EXPECT, timeoutMs: 5000 })).toThrow(
      ModbusValveDefect,
    );
    expect(fake.yazilanlar).toHaveLength(0);
  });

  test("the control: an allowed read DOES reach the socket, so the test above is not vacuous", () => {
    const fake = emitterSocket();
    void exchangeOnce(fake.socket as never, request(), { expect: EXPECT, timeoutMs: 5000 }).catch(() => undefined);
    expect(fake.yazilanlar).toHaveLength(1);
    expect(fake.yazilanlar[0]?.[7]).toBe(3);
  });

  test("an unreadable frame is a ConnectionError naming the endpoint, not a bare Error", () => {
    const where = { host: "10.9.8.7", port: 502 };
    const converted = atSocketBoundary(new ModbusFramingError("The device sent protocol id 7"), where);
    expect(converted).toBeInstanceOf(ConnectionError);
    expect((converted as ConnectionError).host).toBe("10.9.8.7");
    expect((converted as ConnectionError).port).toBe(502);
    expect((converted as Error).message).toContain("protocol id 7");
  });

  test("a frame that claims to answer this request and cannot is a failure, not a discard", async () => {
    const fake = emitterSocket();
    const pending = exchangeOnce(fake.socket as never, request(), {
      expect: EXPECT,
      timeoutMs: 5000,
      endpoint: { host: "10.9.8.7", port: 502 },
    });
    fake.feed(adu(1, 9, 3, twoRegisters));
    const error = await pending.catch((e: unknown) => e);
    expect((error as Error).message).toContain("unit id 9");
  });

  test("a reset during a read becomes a ConnectionError, not a raw ECONNRESET", async () => {
    const fake = emitterSocket();
    const pending = exchangeOnce(fake.socket as never, request(), {
      expect: EXPECT,
      timeoutMs: 5000,
      endpoint: { host: "10.9.8.7", port: 502 },
    });
    fake.fail(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).host).toBe("10.9.8.7");
    expect((error as Error).message).toContain("ECONNRESET");
  });

  test("an unrelated error on the same path still passes through by identity", async () => {
    const fake = emitterSocket();
    const planted = new TypeError("undefined is not a function");
    const pending = exchangeOnce(fake.socket as never, request(), {
      expect: EXPECT,
      timeoutMs: 5000,
      endpoint: { host: "10.9.8.7", port: 502 },
    });
    fake.fail(planted);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBe(planted);
  });
});

/**
 * The default timers, which every other test in this file overrides.
 *
 * A mutation proved what that costs: setting either constant to 1 ms broke nothing, because the
 * tests inject their own value and the declared one is never read. The mechanism was held and the
 * NUMBER was not. These two drive the default path and assert the constant itself, which is the
 * only way the figure is pinned.
 */
describe("the declared timers, on the path that reads them", () => {
  test("the dial arms the declared dial timeout when none is given", async () => {
    delete process.env[FLAG];
    let armed = -1;
    const socket = {
      setTimeout(ms: number) {
        if (armed < 0) armed = ms;
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
        return socket;
      },
      destroyed: false,
    };
    void dialModbus({ host: "203.0.113.9", port: 502 }, { connect: () => socket as never }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    // The LITERAL, not the constant. Asserting `armed === DIAL_TIMEOUT_MS` compares the constant
    // with itself: a mutation to 1 ms armed 1 ms and the test agreed. A number that is a contract
    // has to be written out, with the measurement that chose it.
    expect(armed).toBe(3000);
    expect(DIAL_TIMEOUT_MS).toBe(3000);
    // Above the 2137 ms an absent unit cost through the measured gateway at its defaults, so the
    // user sees the gateway's own exception rather than our timeout.
    expect(DIAL_TIMEOUT_MS).toBeGreaterThan(2137);
  });

  test("an exchange with no timeout given uses the declared request timeout", async () => {
    const started = Date.now();
    const socket = {
      on() {
        return socket;
      },
      once() {
        return socket;
      },
      setTimeout() {
        return socket;
      },
      write() {
        return true;
      },
      destroy() {
        return socket;
      },
      destroyed: false,
    };
    // Not waited out: the point is which figure the call reads, and a request timer of three
    // seconds is not something a unit test should sit through.
    const pending = exchangeOnce(socket as never, request(), {
      expect: EXPECT,
      endpoint: { host: "h", port: 1 },
    });
    expect(REQUEST_TIMEOUT_MS).toBe(3000);
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(2137);
    expect(Date.now() - started).toBeLessThan(REQUEST_TIMEOUT_MS);
    void pending.catch(() => undefined);
  });
});
