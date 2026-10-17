/**
 * The session. Every rule here was measured, and the measurement is in the module's own comment.
 */
import { describe, expect, test } from "bun:test";
import { MAX_TRANSACTIONS_IN_FLIGHT } from "@/lib/db/providers/industrial/modbus/constants";
import { ModbusFramingError, type Exchange } from "@/lib/db/providers/industrial/modbus/framing";
import { ModbusSession, ModbusTimeout, type Wire } from "@/lib/db/providers/industrial/modbus/session";

/**
 * The answer a fake wire gives back. The session never looks INSIDE an answer, it only carries
 * one, so the frame here is the request echoed: what these tests are about is ordering, timing
 * and pacing.
 */
const answerOf = (adu: Buffer): Exchange => ({
  kind: "answer",
  frame: {
    transactionId: adu.readUInt16BE(0),
    unitId: adu[6] ?? 0,
    functionCode: adu[7] ?? 0,
    body: Buffer.alloc(0),
    isException: false,
  },
});

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
  constructor(private readonly behave: (adu: Buffer) => Promise<Exchange>) {}
  async exchange(adu: Buffer): Promise<Exchange> {
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
      return answerOf(adu);
    });
    const session = new ModbusSession(wire);
    await Promise.all(Array.from({ length: 50 }, () => session.exchange(frame)));
    expect(wire.sent).toHaveLength(50);
    expect(wire.maxOutstanding).toBe(1);
  });
});

describe("transaction ids are never reused on a connection", () => {
  test("twenty exchanges carry twenty distinct ids", async () => {
    const wire = new Recorder(async (adu) => answerOf(adu));
    const session = new ModbusSession(wire);
    await Promise.all(Array.from({ length: 20 }, () => session.exchange(frame)));
    const ids = wire.sent.map((b) => b.readUInt16BE(0));
    expect(new Set(ids).size).toBe(20);
  });
});

describe("a request that never answers ends by our own timer", () => {
  test("it rejects with a timeout, and the sentence does not come from err.code", async () => {
    const wire = new Recorder(() => new Promise<Exchange>(() => undefined));
    const session = new ModbusSession(wire, { requestTimeoutMs: 40 });
    const error = await session.exchange(frame).catch((e) => e);
    expect(error).toBeInstanceOf(ModbusTimeout);
    expect((error as ModbusTimeout).message).toContain("did not answer");
    expect((error as ModbusTimeout).message).toContain("stays established");
  });

  test("the connection is closed, because the next answer may belong to the request we gave up on", async () => {
    const wire = new Recorder(() => new Promise<Exchange>(() => undefined));
    const session = new ModbusSession(wire, { requestTimeoutMs: 20 });
    await session.exchange(frame).catch(() => undefined);
    expect(wire.closes).toEqual(["request timed out"]);
  });

  /**
   * The TYPE and the OBLIGATION are two claims, and this holds them apart.
   *
   * MB-S4: after a frame that cannot be read there is no state in which continuing on the same
   * socket is safe, because the next answer to arrive may belong to the request just given up on.
   * The test above makes that claim with a stand-in error, which binds "any failure closes" and
   * says nothing about a framing error in particular. This one sends the real class and asserts
   * both separately: the connection closed with the right reason, AND the caller got that very
   * object rather than something wrapped or replaced on the way out.
   */
  test("a framing error closes the connection, and reaches the caller unchanged", async () => {
    const planted = new ModbusFramingError("the device sent an MBAP length of 0");
    const wire = new Recorder(async () => {
      throw planted;
    });
    const session = new ModbusSession(wire, { requestTimeoutMs: 500 });
    const caught = await session.exchange(frame).catch((e: unknown) => e);
    expect(caught).toBe(planted);
    expect(wire.closes).toEqual(["request failed"]);
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
        return new Promise<Exchange>(() => undefined);
      }
      return answerOf(adu);
    });
    const session = new ModbusSession(wire, { requestTimeoutMs: 20 });
    await session.exchange(frame).catch(() => undefined);
    await expect(session.exchange(frame)).resolves.toMatchObject({ kind: "answer" });
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
      return answerOf(adu);
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
      return answerOf(adu);
    });
    const session = new ModbusSession(wire);
    await Promise.all(Array.from({ length: 10 }, () => session.exchange(frame)));
    expect(wire.maxOutstanding).toBe(1);
  });
});

/**
 * The transaction id, read on its own rather than through an exchange.
 *
 * TCP 4.4.1.3 lets a device answer a request the client has already given up on, and the only
 * thing that tells that answer from this one is the id. The claim in the module is that an id is
 * never reused on one connection and that the counter wraps at sixteen bits, which is a claim
 * about a full cycle: a test that takes three ids measures the first half of the sentence and
 * nothing of the second.
 */
describe("the transaction id", () => {
  test("is handed out in order, and the cycle holds every id the protocol has, each once", () => {
    const session = new ModbusSession(new Recorder((adu) => Promise.resolve(answerOf(adu))));

    const cycle = Array.from({ length: 0xffff }, () => session.takeTransactionId());

    expect(cycle.slice(0, 3)).toEqual([1, 2, 3]);
    expect(new Set(cycle).size).toBe(0xffff);
    expect(Math.min(...cycle)).toBe(1);
    expect(Math.max(...cycle)).toBe(0xffff);
    // The id after a full cycle is the first one again, and zero is never handed out: a frame
    // carrying 0 is one this session did not send.
    expect(session.takeTransactionId()).toBe(1);
  });
});
