import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { ModbusProvider } from "@/lib/db/providers/industrial/modbus/index";
import { MODBUS_OBJECT_KINDS } from "@/lib/db/providers/industrial/modbus/objects";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The Modbus provider end to end, over a real socket and without Docker.
 *
 * The device here answers the SAME tables as the fixture in `database-compose.yml`
 * (`docker/modbus/README.md`), built from the same formulas rather than copied from it, so this
 * layer and the live check are asking one device two ways. The formulas are what they are on
 * purpose: an off-by-one against `7000 + 11 x N` moves a value by eleven, where `1000 + N` would
 * move it by one and read like a plausible number.
 *
 * What this file holds that the unit tests do not: the whole provider runs - the map parser, the
 * planner, the valve, the session's transaction ids, the frame reader and the decoder - against
 * bytes that came back over a socket, and the object surface is checked by the same conformance
 * helper every other provider is checked by.
 */

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const originalFlag = process.env[FLAG];
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

/** The fixture's tables, as formulas. `docker/modbus/README.md` carries the same four. */
const holding = (address: number): number => 7000 + 11 * address;
const inputRegister = (address: number): number => 8500 - 7 * address;
const coil = (address: number): boolean => address % 3 === 0;
const prime = (n: number): boolean => n > 1 && [2, 3, 5, 7].some((p) => n === p || (n % p !== 0 && n < p * p));
const discreteInput = (address: number): boolean => prime(address);

/** A word bank and a bit bank, read by the device below the way a real one reads its memory. */
const WORDS = { 3: holding, 4: inputRegister } as const;
const BITS = { 1: coil, 2: discreteInput } as const;

interface Device {
  readonly port: number;
  /** Every connection the device accepted, so a test can ask whether one was held. */
  connections: number;
  closes: number;
}

/**
 * A Modbus TCP device.
 *
 * `oneClientAtATime` makes it serve a single client and leave any other connection UNANSWERED
 * until that one closes, which is what `docs/providers/modbus.md` section 3.4 recorded a
 * libmodbus server doing for 3003 ms. It is the consequence that is reproduced here, not the
 * library: what matters to a plant is that its own HMI stops being answered, and that happens
 * with any server built this way.
 */
async function device(options: { oneClientAtATime?: boolean } = {}): Promise<Device> {
  const dev: Device = { port: 0, connections: 0, closes: 0 };
  let serving: Socket | undefined;
  const waiting: Socket[] = [];

  const answer = (socket: Socket, adu: Buffer): void => {
    const transactionId = adu.readUInt16BE(0);
    const unitId = adu[6] ?? 0;
    const functionCode = adu[7] ?? 0;
    const address = adu.readUInt16BE(8);
    const quantity = adu.readUInt16BE(10);
    let body: Buffer;
    if (functionCode === 3 || functionCode === 4) {
      const read = WORDS[functionCode];
      body = Buffer.alloc(quantity * 2);
      for (let at = 0; at < quantity; at += 1) body.writeUInt16BE(read(address + at), at * 2);
    } else if (functionCode === 1 || functionCode === 2) {
      const read = BITS[functionCode];
      body = Buffer.alloc(Math.ceil(quantity / 8));
      for (let at = 0; at < quantity; at += 1) {
        if (read(address + at)) body[Math.floor(at / 8)] |= 1 << (at % 8);
      }
    } else {
      // Anything this device does not implement is refused the way a device refuses it, with
      // exception 01, rather than by going quiet - a silence would be read here as the lockout
      // the other test is about.
      const head = Buffer.alloc(7);
      head.writeUInt16BE(transactionId, 0);
      head.writeUInt16BE(2, 4);
      head[6] = unitId;
      socket.write(Buffer.concat([head, Buffer.from([functionCode | 0x80, 0x01])]));
      return;
    }
    const pdu = Buffer.concat([Buffer.from([functionCode, body.length]), body]);
    const head = Buffer.alloc(7);
    head.writeUInt16BE(transactionId, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(pdu.length + 1, 4);
    head[6] = unitId;
    socket.write(Buffer.concat([head, pdu]));
  };

  const serve = (socket: Socket): void => {
    socket.on("data", (adu: Buffer) => answer(socket, adu));
  };

  const server = createServer((socket) => {
    dev.connections += 1;
    socket.on("close", () => {
      dev.closes += 1;
      if (serving === socket) {
        serving = waiting.shift();
        if (serving !== undefined) serve(serving);
      }
    });
    if (options.oneClientAtATime !== true || serving === undefined || serving.destroyed) {
      serving = socket;
      serve(socket);
      return;
    }
    // Accepted and then left unanswered, which is the behaviour being reproduced.
    waiting.push(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  (dev as { port: number }).port = (server.address() as { port: number }).port;
  return dev;
}

/** One point per table, so every kind the provider declares has something to list. */
const POINTS = [
  { name: "volts", unitId: 1, table: "holding_register", address: 0, type: "uint16", unit: "V" },
  { name: "amps", unitId: 1, table: "holding_register", address: 1, type: "uint16", unit: "A" },
  { name: "inlet", unitId: 1, table: "input_register", address: 0, type: "uint16", unit: "kPa" },
  { name: "pump", unitId: 1, table: "coil", address: 0, type: "bool" },
  { name: "lid", unitId: 1, table: "discrete_input", address: 2, type: "bool" },
];
const MAP = JSON.stringify(POINTS);

/**
 * The counts the conformance helper checks, COUNTED FROM THE MAP rather than written out.
 *
 * A literal here would keep passing after a point was added to the map above, which is the one
 * way this expectation could drift from the thing it is an expectation about.
 */
const KIND_COUNTS: Readonly<Record<string, number>> = Object.fromEntries(
  MODBUS_OBJECT_KINDS.map((kind) => [kind.id, POINTS.filter((point) => point.table === kind.id).length]),
);

const provider = (port: number) =>
  new ModbusProvider({
    id: "m",
    name: "device",
    type: "modbus",
    host: "127.0.0.1",
    port,
    registerMap: MAP,
  } as unknown as DatabaseConnection);

/** Waits for the DEVICE's own side of a fact rather than assuming the two sides are ordered. */
async function arrives(what: () => boolean, budgetMs = 1000): Promise<void> {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if (what()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`The device's side never arrived within ${budgetMs} ms.`);
}

/** A raw client, standing in for the plant's own HMI: it is not this repository's code. */
function hmiRead(port: number, budgetMs: number): Promise<{ answeredInMs: number } | "unanswered"> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new (require("node:net").Socket)() as Socket;
    const give = (outcome: { answeredInMs: number } | "unanswered") => {
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => give("unanswered"), budgetMs);
    socket.on("error", () => {
      clearTimeout(timer);
      give("unanswered");
    });
    socket.connect(port, "127.0.0.1", () => {
      const pdu = Buffer.from([3, 0, 0, 0, 1]);
      const head = Buffer.alloc(7);
      head.writeUInt16BE(0x4242, 0);
      head.writeUInt16BE(pdu.length + 1, 4);
      head[6] = 1;
      socket.write(Buffer.concat([head, pdu]));
    });
    socket.on("data", () => {
      clearTimeout(timer);
      give({ answeredInMs: Date.now() - started });
    });
  });
}

describe("the object surface, by the same conformance the other providers answer", () => {
  test("every declared kind counts, lists and describes", async () => {
    delete process.env[FLAG];
    const dev = await device();
    await assertObjectSurface(provider(dev.port), {
      containers: [["1"]],
      kinds: KIND_COUNTS,
      sampleObject: { path: ["1", "volts"], kind: "holding_register" },
    });
  });
});

describe("the four tables, read through the whole provider", () => {
  /**
   * THE FORMULAS ARE TIED TO THE DEVICE THAT WAS MEASURED, and without this they are not.
   *
   * Everything below reads a value the device computed with the same function the expectation
   * computes with, which is right for what those cases are about - that the provider carries an
   * address to the right value and back - but it means a wrong formula would move both sides
   * together and pass. These four numbers came off the real fixture over raw Modbus TCP frames,
   * built by hand rather than with this repository's client, and they are what stops that.
   */
  test("the formulas are the fixture's own, measured on it rather than assumed", () => {
    expect([holding(0), holding(9)]).toEqual([7000, 7099]);
    expect([inputRegister(0), inputRegister(7)]).toEqual([8500, 8451]);
    expect([coil(0), coil(1), coil(3)]).toEqual([true, false, true]);
    expect([discreteInput(0), discreteInput(2), discreteInput(3)]).toEqual([false, true, true]);
  });

  test("a named-point read answers the value its table's formula holds", async () => {
    delete process.env[FLAG];
    const dev = await device();
    const result = await provider(dev.port).query('{"read":["volts","amps","inlet","pump","lid"]}');
    const byName = new Map(result.rows.map((row) => [row.point as string, row]));

    // Each one is checked against the formula rather than a literal, so a device built to a
    // different table than the fixture's cannot pass by both sides being wrong together.
    expect(byName.get("volts")?.value).toBe(holding(0));
    expect(byName.get("amps")?.value).toBe(holding(1));
    expect(byName.get("inlet")?.value).toBe(inputRegister(0));
    expect(byName.get("pump")?.value).toBe(coil(0));
    expect(byName.get("lid")?.value).toBe(discreteInput(2));
  });

  test("a range read answers the whole descending run, in order", async () => {
    delete process.env[FLAG];
    const dev = await device();
    const result = await provider(dev.port).query('{"unit":1,"table":"input_register","address":0,"count":8}');
    // A descending table is used here for the reason the fixture uses one: a reversed range reads
    // as an ascending run and would pass against `1000 + N`.
    expect(result.rows.map((row) => row.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(inputRegister));
  });

  test("the address column carries the register the row answered for", async () => {
    delete process.env[FLAG];
    const dev = await device();
    const result = await provider(dev.port).query('{"unit":1,"table":"holding_register","address":3,"count":2}');
    expect(result.rows.map((row) => row.address)).toEqual([3, 4]);
    expect(result.rows.map((row) => row.value)).toEqual([holding(3), holding(4)]);
  });
});

describe("nothing is held open between reads, which is what a single-client device measures", () => {
  /**
   * THE POSITIVE CONTROL, and the test below is worth nothing without it.
   *
   * It proves the device really does serve one client at a time. If it did not, the test after it
   * would pass whether the provider held its socket or released it, which is the shape of a guard
   * that measures nothing.
   */
  test("while one client is held open, another client's read goes unanswered", async () => {
    delete process.env[FLAG];
    const dev = await device({ oneClientAtATime: true });
    const held = await hmiRead(dev.port, 1000);
    expect(held).not.toBe("unanswered");

    // That client is still open, so a second one must wait. `hmiRead` opens its own socket and
    // never closes the first.
    const blocked = await new Promise<"unanswered" | { answeredInMs: number }>((resolve) => {
      const first = new (require("node:net").Socket)() as Socket;
      first.connect(dev.port, "127.0.0.1", () => {
        void hmiRead(dev.port, 400).then((outcome) => {
          first.destroy();
          resolve(outcome);
        });
      });
    });
    expect(blocked).toBe("unanswered");
  });

  test("after a read, the plant's own client is answered, because the provider kept nothing", async () => {
    delete process.env[FLAG];
    const dev = await device({ oneClientAtATime: true });
    await provider(dev.port).query('{"read":["volts"]}');
    // The provider's socket must be gone, not merely idle: on a device that serves one client at
    // a time, an idle socket it still owns is a plant whose HMI has stopped being answered.
    await arrives(() => dev.closes >= 1);

    const hmi = await hmiRead(dev.port, 1000);
    expect(hmi).not.toBe("unanswered");
  });

  test("three reads in a row take three connections, and leave none of them open", async () => {
    delete process.env[FLAG];
    const dev = await device({ oneClientAtATime: true });
    const engine = provider(dev.port);
    for (const statement of ['{"read":["volts"]}', '{"read":["amps"]}', '{"read":["inlet"]}']) {
      await engine.query(statement);
    }
    // One connection per read, each closed: a provider that held the first socket would have
    // taken one connection and left this device unable to answer anyone else.
    await arrives(() => dev.closes >= 3);
    expect({ connections: dev.connections, closes: dev.closes }).toEqual({ connections: 3, closes: 3 });
  });
});
