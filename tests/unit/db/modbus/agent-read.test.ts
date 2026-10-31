/**
 * The agent read's own rules, below the provider: the remaining failure categories, the turn that comes exactly at
 * the deadline, and the cost each shape is charged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import type { ModbusDevicePacer } from "@/lib/db/providers/industrial/modbus/agent-pacing";
import {
  deviceRequestsOf,
  MODBUS_AGENT_FAILURE_SENTENCES,
  runModbusAgentRead,
} from "@/lib/db/providers/industrial/modbus/agent-read";
import { dialModbus } from "@/lib/db/providers/industrial/modbus/client";
import { MAX_IDENTIFICATION_ROUNDS } from "@/lib/db/providers/industrial/modbus/constants";
import { parseRegisterMap } from "@/lib/db/providers/industrial/modbus/register-map";
import type { ReadRequest } from "@/lib/db/providers/industrial/modbus/request";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { fakeModbusDevice, type FakeModbusDevice } from "../../../helpers/modbus-fake-device";

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[FLAG];
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  delete process.env[FLAG];
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

const MAP = parseRegisterMap(
  JSON.stringify([
    { name: "a", unitId: 1, table: "holding_register", address: 0, type: "uint16" },
    { name: "b", unitId: 1, table: "holding_register", address: 1, type: "uint16" },
    { name: "c", unitId: 1, table: "input_register", address: 0, type: "uint16" },
    { name: "d", unitId: 2, table: "holding_register", address: 0, type: "uint16" },
    {
      name: "total",
      unitId: 1,
      table: "holding_register",
      address: 4,
      type: "int64",
      scale: 2,
      wordOrder: "high_first",
      byteOrder: "high_first",
    },
  ]),
);

/** The pacer of the provider, without its waits: every read takes its turn at once. */
const immediate = {
  run: (_key: string, _deadline: number, work: () => Promise<unknown>) => work(),
} as unknown as ModbusDevicePacer;

function budget(overrides: Partial<ReadOnlyStatementBudget> = {}): ReadOnlyStatementBudget {
  return {
    statementTimeoutMs: 3000,
    maxResultRows: 100,
    maxResultBytes: 1_000_000,
    readAllowance: new RunReadAllowance(10_000),
    ...overrides,
  };
}

async function device(): Promise<FakeModbusDevice> {
  const made = await fakeModbusDevice({ holding: [1, 2, 3, 4, 5, 6, 7, 8] });
  closers.push(() => made.close());
  return made;
}

/** A device that answers every request with one fixed PDU, for answers the fake device never sends. */
async function answering(pdu: Buffer): Promise<number> {
  const server: Server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.on("data", (adu: Buffer) => {
      const head = Buffer.alloc(7);
      head.writeUInt16BE(adu.readUInt16BE(0), 0);
      head.writeUInt16BE(pdu.length + 1, 4);
      head[6] = adu[6] ?? 0;
      socket.write(Buffer.concat([head, pdu]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

function run(
  port: number,
  plan: ReadRequest,
  overrides: Partial<ReadOnlyStatementBudget> = {},
  startedAt = performance.now(),
) {
  return runModbusAgentRead(
    { plan, map: MAP, endpoint: { host: "127.0.0.1", port }, unitId: 1, budget: budget(overrides), startedAt },
    { dial: dialModbus, pacer: immediate },
  );
}

async function message(work: Promise<unknown>): Promise<string> {
  const outcome = await work.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("the read was answered");
  return outcome.message;
}

describe("the cost of each shape, in device requests", () => {
  test("a points read costs one per planned block: a unit, a table and a hole each start one", () => {
    expect(deviceRequestsOf({ kind: "points", names: ["a", "b"] }, MAP)).toBe(1);
    expect(deviceRequestsOf({ kind: "points", names: ["a", "b", "c", "d"] }, MAP)).toBe(3);
    expect(deviceRequestsOf({ kind: "points", names: ["a", "total"] }, MAP)).toBe(2);
  });

  test("a block costs one, and identification the walk's most", () => {
    expect(deviceRequestsOf({ kind: "range", unitId: 1, table: "coil", address: 0, count: 2000 }, MAP)).toBe(1);
    expect(deviceRequestsOf({ kind: "identify", level: "extended" }, MAP)).toBe(MAX_IDENTIFICATION_ROUNDS);
  });
});

describe("failures by category", () => {
  test("a value the map's declaration cannot decode is the map's to fix, not the device's", async () => {
    const dev = await device();
    expect(await message(run(dev.port, { kind: "points", names: ["total"] }))).toBe(
      MODBUS_AGENT_FAILURE_SENTENCES.decode,
    );
  });

  test("an identification answer too short to read is unreadable", async () => {
    const port = await answering(Buffer.from([0x2b, 0x0e, 0x01]));
    expect(await message(run(port, { kind: "identify", level: "basic" }))).toBe(
      MODBUS_AGENT_FAILURE_SENTENCES.unreadable,
    );
  });

  test("an address the egress rule refuses is the connection's settings, and nothing is sent", async () => {
    process.env[FLAG] = "true";
    const dev = await device();
    expect(await message(run(dev.port, { kind: "range", unitId: 1, table: "coil", address: 0, count: 1 }))).toBe(
      MODBUS_AGENT_FAILURE_SENTENCES.settings,
    );
    expect(dev.connections).toHaveLength(0);
  });

  test("a defect on the path rises as it is, never dressed as the device's", async () => {
    await expect(
      runModbusAgentRead(
        {
          plan: { kind: "range", unitId: 1, table: "coil", address: 0, count: 1 },
          map: MAP,
          endpoint: { host: "127.0.0.1", port: 1 },
          unitId: 1,
          budget: budget(),
          startedAt: performance.now(),
        },
        {
          dial: () => Promise.reject(new TypeError("a defect")),
          pacer: immediate,
        },
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe("the deadline", () => {
  test("a turn that comes at or after the deadline is refused as a wait, and dials nothing", async () => {
    const dev = await device();
    const startedAt = performance.now() - 200;
    expect(
      await message(
        run(
          dev.port,
          { kind: "range", unitId: 1, table: "coil", address: 0, count: 1 },
          { statementTimeoutMs: 100 },
          startedAt,
        ),
      ),
    ).toStartWith("Read-only execution exceeded the time budget: the read waited 100ms");
    expect(dev.connections).toHaveLength(0);
  });
});
