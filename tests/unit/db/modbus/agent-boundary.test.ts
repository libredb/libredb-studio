/**
 * The Modbus agent's boundary: the structural closed table, held three ways.
 *
 * In the source, the agent's modules name no function code and build no frame: they reach the device only through the
 * console's reader (`read.ts`), whose two builders are `buildRead` (Read Coils, Read Discrete Inputs, Read Holding
 * Registers, Read Input Registers, chosen by the table) and `buildIdentification` (43/14), and the one `socket.write`
 * of the provider runs after the valve.
 *
 * On the wire, every frame the agent path writes for every admitted shape is one of those five, and the valve refuses
 * every write, diagnostic and record function code before a byte leaves.
 *
 * In the capture (`tests/fixtures/modbus/2.3.0/agent-boundary/boundary.json`, recorded by its run.sh against the
 * pinned docker/modbus fixture and a single-client libmodbus device), what the agent's reads answered, the measured
 * lockout the pacing rests on, and what a raw write, sent by the capture script and never by Studio, does on the
 * fixture.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ModbusDevicePacer, MODBUS_AGENT_DEVICE_GAP_MS } from "@/lib/db/providers/industrial/modbus/agent-pacing";
import { dialModbus, type Dialer, type ModbusSocket } from "@/lib/db/providers/industrial/modbus/client";
import { ModbusProvider } from "@/lib/db/providers/industrial/modbus/index";
import { assertOutboundAllowed, ModbusValveDefect } from "@/lib/db/providers/industrial/modbus/valve";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import type { DatabaseConnection } from "@/lib/types";
import { fakeModbusDevice, readAdu, type FakeModbusDevice } from "../../../helpers/modbus-fake-device";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const MODBUS = path.join(ROOT, "src/lib/db/providers/industrial/modbus");
const source = (file: string) => readFileSync(path.join(MODBUS, file), "utf8");
const AGENT_MODULES = readdirSync(MODBUS)
  .filter((file) => file.startsWith("agent-"))
  .sort();

describe("in the source", () => {
  test("the agent's modules are the four this provider declares", () => {
    expect(AGENT_MODULES).toEqual(["agent-pacing.ts", "agent-read.ts", "agent-statement.ts", "agent-surface.ts"]);
  });

  test("no agent module names a function code, builds a frame or writes to a socket", () => {
    for (const file of AGENT_MODULES) {
      const text = source(file);
      expect(
        `${file}: ${/\bFC_[A-Z_]+|FUNCTION_CODE_OF_TABLE|buildRead|buildIdentification|\.write\(|Buffer\.(?:from|alloc)\(/.exec(text)?.[0] ?? "none"}`,
      ).toBe(`${file}: none`);
    }
  });

  test("the agent read reaches the device only through the console's reader over the provider's socket wire", () => {
    const text = source("agent-read.ts");
    expect(text).toMatch(
      /^import \{ ModbusExceptionError, ModbusWalkBoundError, runRead, type ReadRows \} from "\.\/read";$/m,
    );
    expect(text).toMatch(
      /^import \{ socketWire, type Dialer, type Endpoint, type ModbusSocket \} from "\.\/client";$/m,
    );
    // From the builders' module it takes only the sentences of the device's exception codes.
    expect(text).toMatch(/^import \{ EXCEPTION_SENTENCES \} from "\.\/pdu";$/m);
  });

  test("the console's reader builds frames only with the read builders, and the one socket.write follows the valve", () => {
    const reader = source("read.ts");
    expect([...reader.matchAll(/\bbuild[A-Z]\w*\(/g)].map((match) => match[0]).sort()).toEqual([
      "buildIdentification(",
      "buildRead(",
    ]);
    const client = source("client.ts");
    expect([...client.matchAll(/socket\.write\(/g)]).toHaveLength(1);
    expect(client).toMatch(/assertOutboundAllowed\(adu\);\n\s+socket\.write\(adu\);/);
    // The builders take no function code from their caller: the table chooses it, and 43/14 is fixed.
    const pdu = source("pdu.ts");
    expect([...pdu.matchAll(/pdu\[0\] = ([^;]+);/g)].map((match) => match[1])).toEqual([
      "FUNCTION_CODE_OF_TABLE[table]",
    ]);
  });
});

describe("on the wire", () => {
  const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
  const original = process.env[FLAG];
  let dev: FakeModbusDevice | undefined;

  beforeEach(() => {
    delete process.env[FLAG];
  });

  afterEach(async () => {
    await dev?.close();
    dev = undefined;
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  test("every frame of every admitted shape is a read or 43/14, and nothing else ever leaves", async () => {
    dev = await fakeModbusDevice({ holding: [1, 2, 3, 4], objects: [{ id: 0, bytes: Buffer.from("v") }] });
    const written: Buffer[] = [];
    const recording: Dialer = async (endpoint, options) => {
      const socket = await dialModbus(endpoint, options);
      const write = socket.write.bind(socket);
      return Object.assign(socket, {
        write: (data: Uint8Array) => {
          written.push(Buffer.from(data));
          return write(data);
        },
      }) as ModbusSocket;
    };
    const map = JSON.stringify([
      { name: "h", unitId: 1, table: "holding_register", address: 0, type: "uint16" },
      { name: "i", unitId: 1, table: "input_register", address: 0, type: "uint16" },
      { name: "c", unitId: 1, table: "coil", address: 0, type: "bool" },
      { name: "d", unitId: 1, table: "discrete_input", address: 0, type: "bool" },
    ]);
    const provider = new ModbusProvider(
      {
        id: "m",
        name: "d",
        type: "modbus",
        host: "127.0.0.1",
        port: dev.port,
        registerMap: map,
      } as unknown as DatabaseConnection,
      {},
      { readOnly: true, sendsStatements: true },
      { dial: recording, pacer: new ModbusDevicePacer(0) },
    );
    const statements = [
      '{"read": ["h", "i", "c", "d"]}',
      ...["coil", "discrete_input", "holding_register", "input_register"].map(
        (table) => `{"unit": 255, "table": "${table}", "address": 0, "count": 1}`,
      ),
      ...["basic", "regular", "extended"].map((level) => `{"identify": "${level}"}`),
    ];
    for (const statement of statements)
      await provider.queryReadOnly(statement, {
        statementTimeoutMs: 5000,
        maxResultRows: 100,
        maxResultBytes: 100_000,
        readAllowance: new RunReadAllowance(1000),
      });
    const shapes = written.map((frame) => (frame[7] === 0x2b ? `43/${frame[8]}` : `${frame[7]}`));
    expect(new Set(shapes)).toEqual(new Set(["1", "2", "3", "4", "43/14"]));
    expect(written).toHaveLength(11);
  });

  test("the valve refuses every write, diagnostic and record function code, whatever builds it", () => {
    for (const code of [0x05, 0x06, 0x0f, 0x10, 0x16, 0x17, 0x08, 0x0b, 0x0c, 0x11, 0x14, 0x15, 0x18]) {
      const frame = readAdu(1, 1, code, 0, 1);
      expect(() => assertOutboundAllowed(frame)).toThrow(ModbusValveDefect);
    }
    // 43 with any MEI type but 14 (13 is CANopen General Reference, which can write).
    expect(() => assertOutboundAllowed(Buffer.from([0, 1, 0, 0, 0, 5, 1, 0x2b, 0x0d, 0x01, 0x00]))).toThrow(
      ModbusValveDefect,
    );
  });
});

interface Capture {
  readonly fixture: { readonly image: string; readonly singleClient: string };
  readonly reads: ReadonlyArray<{ readonly statement: string; readonly rows: unknown[] }>;
  readonly refusedBeforeSend: ReadonlyArray<{
    readonly statement: string;
    readonly opening: string;
    readonly connections: number;
  }>;
  readonly pacing: {
    readonly gapMs: number;
    readonly concurrentReads: { readonly maxOpen: number; readonly gapAfterCloseMs: number };
  };
  readonly lockout: {
    readonly pymodbus: { readonly secondWhileFirstHeldMs: number };
    readonly singleClient: {
      readonly holdMs: number;
      readonly secondWhileFirstHeldMs: number;
      readonly secondAnsweredAfterCloseMs: number;
      readonly dialAndReadAfterCloseMs: readonly number[];
      readonly agentReadHoldMs: number;
    };
  };
  readonly rawWrites: ReadonlyArray<{
    readonly functionCode: number;
    readonly answer: string;
    readonly changed: boolean;
  }>;
}

describe("in the capture", () => {
  const capture = JSON.parse(
    readFileSync(path.join(ROOT, "tests/fixtures/modbus/2.3.0/agent-boundary/boundary.json"), "utf8"),
  ) as Capture;

  test("is of the pinned fixture image and the single-client device", () => {
    expect(capture.fixture.image).toBe(
      "oitc/modbus-server:2.3.0@sha256:32bfe144512e1f070cf7e7e2513cdcb774d74db142ee5dbad45b21d6d705ab97",
    );
    expect(capture.fixture.singleClient).toBe("libmodbus, one client at a time (single-client/server.c)");
  });

  test("the agent's reads answered the fixture's values", () => {
    const block = capture.reads.find((read) => read.statement.includes('"holding_register"'));
    expect(block?.rows).toEqual([
      { unit: 1, table: "holding_register", address: 0, raw: [7000], value: 7000 },
      { unit: 1, table: "holding_register", address: 1, raw: [7011], value: 7011 },
      { unit: 1, table: "holding_register", address: 2, raw: [7022], value: 7022 },
    ]);
  });

  test("every refusal reached the device not at all", () => {
    expect(capture.refusedBeforeSend.length).toBeGreaterThan(0);
    for (const refusal of capture.refusedBeforeSend) expect(refusal.connections).toBe(0);
  });

  test("a single-client device answers nobody while a read holds it, and at once after it closes", () => {
    const single = capture.lockout.singleClient;
    expect(single.secondWhileFirstHeldMs).toBeGreaterThanOrEqual(single.holdMs - 50);
    expect(single.secondAnsweredAfterCloseMs).toBeLessThan(50);
    for (const ms of single.dialAndReadAfterCloseMs) expect(ms).toBeLessThan(50);
    // The pinned gap is many times the hold of one agent read on it.
    expect(MODBUS_AGENT_DEVICE_GAP_MS).toBeGreaterThan(100 * Math.max(1, single.agentReadHoldMs));
    // The pinned fixture serves clients concurrently, so it cannot show the lockout.
    expect(capture.lockout.pymodbus.secondWhileFirstHeldMs).toBeLessThan(50);
  });

  test("two agent reads of one device never overlapped, and the gap followed the first's close", () => {
    expect(capture.pacing.gapMs).toBe(MODBUS_AGENT_DEVICE_GAP_MS);
    expect(capture.pacing.concurrentReads.maxOpen).toBe(1);
    expect(capture.pacing.concurrentReads.gapAfterCloseMs).toBeGreaterThanOrEqual(MODBUS_AGENT_DEVICE_GAP_MS - 5);
  });

  test("the fixture takes a raw write from anyone, which is why the closed table is the boundary", () => {
    expect(capture.rawWrites.map((write) => write.functionCode)).toEqual([5, 6, 15, 16, 22, 23]);
    expect(capture.rawWrites.some((write) => write.changed)).toBe(true);
  });
});
