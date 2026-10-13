/**
 * END TO END OVER A REAL SOCKET, which is the thing this provider did not do.
 *
 * Every other file here measures one module against fakes. This one opens a TCP server, lets the
 * provider dial it, and asserts BOTH ends: the bytes the device received are a Modbus read for the
 * address the register map names, and the rows the caller got back carry the value those bytes
 * answered with. Until this file existed the engine was registered, `connect()` returned
 * successfully, and nothing ever left the process.
 *
 * The server is written by hand rather than mocked, so the frame reader, the valve, the session's
 * transaction ids and the decoder all run for real.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { ModbusProvider } from "@/lib/db/providers/industrial/modbus/index";
import type { DatabaseConnection } from "@/lib/types";

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const originalFlag = process.env[FLAG];
let open: Server | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

/** Every ADU the device received, so a test can assert what actually went out. */
const received: Buffer[] = [];

/**
 * A Modbus TCP device, as small as one can be and still be real: it reads the MBAP header, answers
 * the four read function codes from a fixed word bank, and echoes the transaction id.
 */
async function device(bank: readonly number[], options: { exception?: number } = {}): Promise<number> {
  received.length = 0;
  const server = createServer((socket) => {
    socket.on("data", (adu: Buffer) => {
      received.push(Buffer.from(adu));
      const transactionId = adu.readUInt16BE(0);
      const unitId = adu[6] ?? 0;
      const functionCode = adu[7] ?? 0;
      const address = adu.readUInt16BE(8);
      const quantity = adu.readUInt16BE(10);
      const head = Buffer.alloc(7);
      head.writeUInt16BE(transactionId, 0);
      head.writeUInt16BE(0, 2);
      head[6] = unitId;
      if (options.exception !== undefined) {
        head.writeUInt16BE(3, 4);
        socket.write(Buffer.concat([head, Buffer.from([functionCode | 0x80, options.exception])]));
        return;
      }
      const words = bank.slice(address, address + quantity);
      const body = Buffer.alloc(words.length * 2);
      words.forEach((word, at) => body.writeUInt16BE(word, at * 2));
      const pdu = Buffer.concat([Buffer.from([functionCode, body.length]), body]);
      head.writeUInt16BE(pdu.length + 1, 4);
      socket.write(Buffer.concat([head, pdu]));
    });
  });
  open = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

const MAP = JSON.stringify([
  { name: "volts", unitId: 1, table: "holding_register", address: 0, type: "uint16", unit: "V" },
  { name: "amps", unitId: 1, table: "holding_register", address: 1, type: "uint16", unit: "A" },
]);

const provider = (port: number, registerMap = MAP) =>
  new ModbusProvider({ id: "m", name: "device", type: "modbus", host: "127.0.0.1", port, registerMap } as unknown as DatabaseConnection);

describe("a read reaches the device and comes back", () => {
  test("named points are read in one request, and the device gets a Modbus read for them", async () => {
    delete process.env[FLAG];
    const port = await device([230, 12]);
    const result = await provider(port).query('{"read":["volts","amps"]}');

    // The caller's end.
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ point: "volts", value: 230, unit_of_measure: "V" });
    expect(result.rows[1]).toMatchObject({ point: "amps", value: 12, unit_of_measure: "A" });

    // The device's end: ONE request, not two, because the planner put both points in one block.
    expect(received).toHaveLength(1);
    const adu = received[0] as Buffer;
    expect(adu.readUInt16BE(2)).toBe(0); // protocol id
    expect(adu[6]).toBe(1); // unit id
    expect(adu[7]).toBe(0x03); // read holding registers
    expect(adu.readUInt16BE(8)).toBe(0); // address
    expect(adu.readUInt16BE(10)).toBe(2); // quantity
  });

  test("a range read by address answers one row per register", async () => {
    delete process.env[FLAG];
    const port = await device([7, 8, 9]);
    const result = await provider(port).query('{"unit":1,"table":"holding_register","address":0,"count":3}');
    expect(result.rows.map((row) => row.value)).toEqual([7, 8, 9]);
    expect(received).toHaveLength(1);
    expect((received[0] as Buffer).readUInt16BE(10)).toBe(3);
  });

  test("the device's own refusal arrives as a refusal of this read, in the protocol's words", async () => {
    delete process.env[FLAG];
    const port = await device([], { exception: 0x02 });
    await expect(provider(port).query('{"read":["volts"]}')).rejects.toThrow(/no such address/i);
  });

  test("nothing is held open: a second read dials again", async () => {
    delete process.env[FLAG];
    const port = await device([230, 12]);
    const p = provider(port);
    await p.query('{"read":["volts"]}');
    await p.query('{"read":["amps"]}');
    expect(received).toHaveLength(2);
    // Transaction ids are per connection, so a fresh socket starts at 1 again. Reading the same id
    // twice is the evidence that the first socket really was closed rather than reused.
    expect((received[0] as Buffer).readUInt16BE(0)).toBe(1);
    expect((received[1] as Buffer).readUInt16BE(0)).toBe(1);
  });

  test("health is an answer, not a connect: it reads one point at the device", async () => {
    delete process.env[FLAG];
    const port = await device([230, 12]);
    const health = await provider(port).getHealth();
    expect(health.databaseSize).toBe("2 points");
    // The docblock claimed this read for a while before the body did it. One quantity-1 read.
    expect(received).toHaveLength(1);
    expect((received[0] as Buffer).readUInt16BE(10)).toBe(1);
  });

  test("with no map health asks the device nothing, because no point names an address", async () => {
    delete process.env[FLAG];
    const port = await device([230]);
    const health = await provider(port, "[]").getHealth();
    expect(health.databaseSize).toBe("unknown");
    expect(received).toHaveLength(0);
  });

  test("a request the parser refuses costs no connection at all", async () => {
    delete process.env[FLAG];
    const port = await device([230]);
    await expect(provider(port).query('{"read":["nothing_named_this"]}')).rejects.toThrow(/no point named/);
    expect(received).toHaveLength(0);
  });
});
