/**
 * The session. Every rule here was measured, and the measurement is in the module's own comment.
 */
import { describe, expect, test } from "bun:test";
import { MAX_TRANSACTIONS_IN_FLIGHT } from "@/lib/db/providers/industrial/modbus/constants";
import { ModbusSession, ModbusTimeout, type Wire } from "@/lib/db/providers/industrial/modbus/session";

const frame = (tid: number) => {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(tid, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(6, 4);
  b[6] = 1;
  b[7] = 3;
  b.writeUInt16BE(0, 8);
  b.writeUInt16BE(1, 10);
  return b;
};

class Recorder implements Wire {
  sent: Buffer[] = [];
  closes: string[] = [];
  outstanding = 0;
  maxOutstanding = 0;
  constructor(private readonly behave: (adu: Buffer) => Promise<Buffer>) {}
  async exchange(adu: Buffer): Promise<Buffer> {
    this.sent.push(adu);
    this.outstanding += 1;
    this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
    try {
      return await this.behave(adu);
    } finally {
      this.outstanding -= 1;
    }
  }
  close(reason: string): void {
    this.closes.push(reason);
  }
}

describe("one request in flight", () => {
  test("fifty concurrent calls never put two on the wire at once", async () => {
    const wire = new Recorder(async (adu) => {
      await new Promise((r) => setTimeout(r, 1));
      return adu;
    });
    const session = new ModbusSession(wire);
    await Promise.all(Array.from({ length: 50 }, () => session.exchange(frame)));
    expect(wire.sent).toHaveLength(50);
    expect(wire.maxOutstanding).toBe(1);
  });
});

describe("transaction ids are never reused on a connection", () => {
  test("twenty exchanges carry twenty distinct ids", async () => {
    const wire = new Recorder(async (adu) => adu);
    const session = new ModbusSession(wire);
    await Promise.all(Array.from({ length: 20 }, () => session.exchange(frame)));
    const ids = wire.sent.map((b) => b.readUInt16BE(0));
    expect(new Set(ids).size).toBe(20);
  });
});

describe("a request that never answers ends by our own timer", () => {
  test("it rejects with a timeout, and the sentence does not come from err.code", async () => {
    const wire = new Recorder(() => new Promise<Buffer>(() => undefined));
    const session = new ModbusSession(wire, { requestTimeoutMs: 40 });
    const error = await session.exchange(frame).catch((e) => e);
    expect(error).toBeInstanceOf(ModbusTimeout);
    expect((error as ModbusTimeout).message).toContain("did not answer");
    expect((error as ModbusTimeout).message).toContain("stays established");
  });

  test("the connection is closed, because the next answer may belong to the request we gave up on", async () => {
    const wire = new Recorder(() => new Promise<Buffer>(() => undefined));
    const session = new ModbusSession(wire, { requestTimeoutMs: 20 });
    await session.exchange(frame).catch(() => undefined);
    expect(wire.closes).toEqual(["request timed out"]);
  });

  test("a failure of any other kind also closes the connection", async () => {
    const wire = new Recorder(async () => {
      throw new Error("malformed frame");
    });
    const session = new ModbusSession(wire, { requestTimeoutMs: 500 });
    await session.exchange(frame).catch(() => undefined);
    expect(wire.closes).toEqual(["request failed"]);
  });

  test("a timeout does not stop the next request from being made", async () => {
    let first = true;
    const wire = new Recorder(async (adu) => {
      if (first) {
        first = false;
        return new Promise<Buffer>(() => undefined);
      }
      return adu;
    });
    const session = new ModbusSession(wire, { requestTimeoutMs: 20 });
    await session.exchange(frame).catch(() => undefined);
    await expect(session.exchange(frame)).resolves.toBeInstanceOf(Buffer);
  });
});

describe("requests to one endpoint are paced", () => {
  /**
   * The wire here CONSUMES 30 ms of the fake clock, and that is what makes the test mean what its
   * name says. With a wire that takes no time, "counted from the last one finishing" and "counted
   * from the last one starting" fall on the same instant, and the test passes under either rule: it
   * was written that way first and a mutation proved it could not tell them apart. With the wire
   * taking 30 ms, counting from the finish still sleeps the full 100, while counting from the start
   * would sleep only 70.
   */
  test("a minimum interval is waited out, counted from the last one finishing", async () => {
    const slept: number[] = [];
    let clock = 1000;
    const wire = new Recorder(async (adu) => {
      clock += 30;
      return adu;
    });
    const session = new ModbusSession(wire, {
      minIntervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await session.exchange(frame);
    await session.exchange(frame);
    await session.exchange(frame);
    expect(slept).toEqual([100, 100]);
    expect(slept).not.toEqual([70, 70]);
  });
});

/**
 * NumberMaxOfClientTransaction, where the number itself is the contract.
 *
 * TCP 4.4.1.2 requires a client to publish this figure, so the provider documentation states it and
 * this test pins it. A mutation showed why it needs its own test: raising the constant to 8 broke
 * nothing, because the queue serialises regardless and the constant is only the published figure.
 * That makes it exactly the kind of value a test has to assert directly, rather than through
 * behaviour that does not depend on it.
 */
describe("the published transaction figure", () => {
  test("it is one, which is what the provider documentation says", () => {
    expect(MAX_TRANSACTIONS_IN_FLIGHT).toBe(1);
  });

  test("and the queue enforces it independently, so the figure is not the only guard", async () => {
    const wire = new Recorder(async (adu) => {
      await new Promise((r) => setTimeout(r, 1));
      return adu;
    });
    const session = new ModbusSession(wire);
    await Promise.all(Array.from({ length: 10 }, () => session.exchange(frame)));
    expect(wire.maxOutstanding).toBe(1);
  });
});
