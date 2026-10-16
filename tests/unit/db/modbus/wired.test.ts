/**
 * END TO END OVER A REAL SOCKET, which is the thing this provider did not do.
 *
 * Every other file here measures one module against fakes. This one opens a TCP server, lets the
 * provider dial it, and asserts BOTH ends: the bytes the device dev.received are a Modbus read for the
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

/**
 * Each device keeps its OWN counters, and they are not module-level.
 *
 * They were module-level and reset per test, and a close event from the previous test's socket
 * arrived after the reset and landed in the next test's count: connections 2, closes 3. A late
 * event has no way of knowing which test it belongs to, so the counter has to belong to a device
 * rather than to the file.
 */
interface Device {
  readonly port: number;
  readonly received: Buffer[];
  connections: number;
  closes: number;
}

/**
 * A Modbus TCP device, as small as one can be and still be real: it reads the MBAP header, answers
 * the four read function codes from a fixed word bank, and echoes the transaction id.
 */
async function device(bank: readonly number[], options: { exception?: number } = {}): Promise<Device> {
  const dev: Device = { port: 0, received: [], connections: 0, closes: 0 };
  const server = createServer((socket) => {
    dev.connections += 1;
    socket.on("close", () => {
      dev.closes += 1;
    });
    socket.on("data", (adu: Buffer) => {
      dev.received.push(Buffer.from(adu));
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
  (dev as { port: number }).port = (server.address() as { port: number }).port;
  return dev;
}

/**
 * Waits for the DEVICE's own side of a fact, rather than assuming it has happened.
 *
 * A client's `connect` resolves when the handshake completes on the client; the server's
 * `connection` handler runs on the server's own turn of the loop, and nothing orders the two. So
 * `await connect()` followed at once by `expect(dev.connections).toBe(1)` reads a counter that may
 * not have been written yet - which is a fact about the ASSERTION and not about the provider.
 * MEASURED, and the measurement is not the one this comment first carried. It said the file alone
 * was green and only the whole-directory run fell, so load was the cause; that reading was
 * retracted - the green run had been of a different file. Re-measured, this test falls ALONE too:
 * five runs of five at one head and three of three at the next, each 12 pass / 1 fail, with the
 * whole-directory run sometimes passing. So the race is in every run and load does not create it,
 * it only makes it lose more often; a run that passes is the race won, not the race absent.
 * A poll keeps the same claim (one connection arrived, and no more than one) without the race, and
 * it fails on the budget rather than passing silently, so a provider that never dials still fails.
 */
async function arrives(what: () => boolean, budgetMs = 1000): Promise<void> {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if (what()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`The device's side never arrived within ${budgetMs} ms.`);
}

const MAP = JSON.stringify([
  { name: "volts", unitId: 1, table: "holding_register", address: 0, type: "uint16", unit: "V" },
  { name: "amps", unitId: 1, table: "holding_register", address: 1, type: "uint16", unit: "A" },
]);

const provider = (port: number, registerMap = MAP) =>
  new ModbusProvider({
    id: "m",
    name: "device",
    type: "modbus",
    host: "127.0.0.1",
    port,
    registerMap,
  } as unknown as DatabaseConnection);

describe("connect answers for the device, not only for the map", () => {
  /**
   * `connect()` parsed the map and nothing else, so it answered successfully for an address with
   * no device behind it: MEASURED at 0 ms against a closed port. The route then reports a health
   * failure after a successful connect as a DEGRADED SUCCESS, so Test Connection answered
   * `success: true` for a device that does not exist and the dialog saved the connection. A reader
   * told "connected, but no health data" goes to fix their map when the fault is the address.
   */
  test("a closed port is refused, and the refusal names the address", async () => {
    delete process.env[FLAG];
    const dev = await device([230]);
    const port = dev.port;
    open?.close();
    open = undefined;
    await expect(provider(port).connect()).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${port}`));
  });

  test("an address that answers is accepted, and the map check is still done first", async () => {
    delete process.env[FLAG];
    const dev = await device([230]);
    await provider(dev.port).connect();
    // The dial sends nothing and holds nothing: one connection, no ADU, and it is closed.
    await arrives(() => dev.connections === 1);
    expect(dev.received).toHaveLength(0);
    await arrives(() => dev.closes === 1);
    // And not more than one of either, once both sides have been seen.
    expect(dev.connections).toBe(1);
    expect(dev.closes).toBe(1);
  });

  test("an empty map is a normal state: connect answers for the device and says nothing of the map", async () => {
    delete process.env[FLAG];
    const dev = await device([230]);
    await expect(provider(dev.port, "[]").connect()).resolves.toBeUndefined();
    await arrives(() => dev.connections === 1);
  });

  test("a malformed map is still refused before any socket is opened", async () => {
    delete process.env[FLAG];
    const dev = await device([230]);
    await expect(provider(dev.port, "{not json").connect()).rejects.toThrow(/valid JSON/);
    expect(dev.connections).toBe(0);
  });
});

describe("a read reaches the device and comes back", () => {
  test("named points are read in one request, and the device gets a Modbus read for them", async () => {
    delete process.env[FLAG];
    const dev = await device([230, 12]);
    const result = await provider(dev.port).query('{"read":["volts","amps"]}');

    // The caller's end.
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ point: "volts", value: 230, unit_of_measure: "V" });
    expect(result.rows[1]).toMatchObject({ point: "amps", value: 12, unit_of_measure: "A" });

    // The device's end: ONE request, not two, because the planner put both points in one block.
    expect(dev.received).toHaveLength(1);
    const adu = dev.received[0] as Buffer;
    expect(dev.connections).toBe(1); // the control for the assertion above: an accepted read DOES dial
    expect(adu.readUInt16BE(2)).toBe(0); // protocol id
    expect(adu[6]).toBe(1); // unit id
    expect(adu[7]).toBe(0x03); // read holding registers
    expect(adu.readUInt16BE(8)).toBe(0); // address
    expect(adu.readUInt16BE(10)).toBe(2); // quantity
  });

  test("a range read by address answers one row per register", async () => {
    delete process.env[FLAG];
    const dev = await device([7, 8, 9]);
    const result = await provider(dev.port).query('{"unit":1,"table":"holding_register","address":0,"count":3}');
    expect(result.rows.map((row) => row.value)).toEqual([7, 8, 9]);
    expect(dev.received).toHaveLength(1);
    expect((dev.received[0] as Buffer).readUInt16BE(10)).toBe(3);
  });

  test("the device's own refusal arrives as a refusal of this read, in the protocol's words", async () => {
    delete process.env[FLAG];
    const dev = await device([], { exception: 0x02 });
    await expect(provider(dev.port).query('{"read":["volts"]}')).rejects.toThrow(/no such address/i);
  });

  test("nothing is held open: a second read dials again", async () => {
    delete process.env[FLAG];
    const dev = await device([230, 12]);
    const p = provider(dev.port);
    await p.query('{"read":["volts"]}');
    await p.query('{"read":["amps"]}');
    expect(dev.received).toHaveLength(2);
    // Transaction ids are per connection, so a fresh socket starts at 1 again. Reading the same id
    // twice says a NEW socket was used; it does not say the first one was closed, because a read
    // that leaked its socket would dial again all the same. The close count is what says that, and
    // without it dropping `socket.destroy()` from the finally broke no test at all (MEASURED).
    await arrives(() => dev.closes === 2);
    expect((dev.received[0] as Buffer).readUInt16BE(0)).toBe(1);
    expect((dev.received[1] as Buffer).readUInt16BE(0)).toBe(1);
  });

  test("health is an answer, not a connect: it reads one point at the device", async () => {
    delete process.env[FLAG];
    const dev = await device([230, 12]);
    const health = await provider(dev.port).getHealth();
    expect(health.databaseSize).toBe("2 points");
    // The docblock claimed this read for a while before the body did it. One quantity-1 read.
    expect(dev.received).toHaveLength(1);
    expect((dev.received[0] as Buffer).readUInt16BE(10)).toBe(1);
  });

  test("with no map health still dials, so a wrong address cannot read as connected", async () => {
    delete process.env[FLAG];
    const dev = await device([230]);
    const health = await provider(dev.port, "[]").getHealth();
    expect(health.databaseSize).toBe("unknown");
    // Absence and zero are different facts: `activeConnections` is omitted rather than sent as 0,
    // because a device has no connection count a reader can ask for.
    expect(Object.hasOwn(health, "activeConnections")).toBe(false);
    expect(health.cacheHitRatio).toBe("unknown");
    // The dial claims nothing beyond reachability: the server dev.received no ADU at all.
    expect(dev.received).toHaveLength(0);
  });

  test("with no map a closed port fails health, which is the whole point of the dial", async () => {
    delete process.env[FLAG];
    const dev = await device([230]);
    open?.close();
    open = undefined;
    await expect(provider(dev.port, "[]").getHealth()).rejects.toThrow();
  });

  test("with a map the dial path is not taken: the read is what proves the device", async () => {
    delete process.env[FLAG];
    const dev = await device([230, 12]);
    await provider(dev.port).getHealth();
    // One ADU, the quantity-1 read. If the dial-only branch had run as well there would be two
    // connections and still one ADU, so the assertion that holds the branches apart is this one.
    expect(dev.received).toHaveLength(1);
    expect((dev.received[0] as Buffer).readUInt16BE(10)).toBe(1);
  });

  test("a request the parser refuses costs no connection at all", async () => {
    delete process.env[FLAG];
    const dev = await device([230]);
    await expect(provider(dev.port).query('{"read":["nothing_named_this"]}')).rejects.toThrow(/no point named/);
    // CONNECTIONS, not ADUs. A dial sends nothing, so counting ADUs cannot tell "refused before the
    // socket" from "dialled, then refused": both answer zero. MEASURED by reversing the order in
    // the provider - the ADU count stayed 0, and only the socket-less tests elsewhere noticed.
    expect(dev.connections).toBe(0);
    expect(dev.received).toHaveLength(0);
  });
});
