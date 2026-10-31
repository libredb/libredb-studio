/**
 * A Modbus TCP device on a real loopback socket, for the agent path's tests: it answers the four reads from fixed
 * tables and Read Device Identification from a fixed object list, records every frame it receives with when it
 * arrived, and records when each connection opened and closed and how many were open at once, so a test can pin full
 * request frames and hold that two reads never overlapped on it.
 *
 * Written by hand rather than mocked, so the provider's frame reader, valve, transaction ids and decoder all run for
 * real. It answers whatever function code it is sent with exception 01, as a device that does not know it would.
 */
import { createServer, type Server } from "node:net";

export interface FakeModbusDevice {
  readonly port: number;
  /** Every frame received, in order, each with the time it arrived on `performance.now()`'s clock. */
  readonly received: Array<{ readonly adu: Buffer; readonly at: number }>;
  /** Each connection's open and close time, in the order they opened. */
  readonly connections: Array<{ opened: number; closed?: number }>;
  /** The most connections that were open at one time. */
  maxOpen: number;
  close(): Promise<void>;
}

export interface FakeModbusOptions {
  readonly holding?: readonly number[];
  readonly input?: readonly number[];
  readonly coils?: readonly boolean[];
  readonly discrete?: readonly boolean[];
  /** Identification objects, answered `perRound` at a time with More Follows set while any remain. */
  readonly objects?: ReadonlyArray<{ readonly id: number; readonly bytes: Buffer }>;
  readonly perRound?: number;
  /** Answers every read with this exception code. */
  readonly exception?: number;
  /** Holds every answer this long before sending it. */
  readonly answerAfterMs?: number;
  /** Never answers. */
  readonly silent?: boolean;
}

const BIT_CODES: Readonly<Record<number, "coils" | "discrete">> = { 1: "coils", 2: "discrete" };
const WORD_CODES: Readonly<Record<number, "holding" | "input">> = { 3: "holding", 4: "input" };

function frame(transactionId: number, unitId: number, pdu: Buffer): Buffer {
  const head = Buffer.alloc(7);
  head.writeUInt16BE(transactionId, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(pdu.length + 1, 4);
  head[6] = unitId;
  return Buffer.concat([head, pdu]);
}

function answerOf(adu: Buffer, options: FakeModbusOptions): Buffer {
  const functionCode = adu[7] ?? 0;
  if (options.exception !== undefined) return Buffer.from([functionCode | 0x80, options.exception]);
  const bits = BIT_CODES[functionCode];
  const words = WORD_CODES[functionCode];
  const address = bits !== undefined || words !== undefined ? adu.readUInt16BE(8) : 0;
  const quantity = bits !== undefined || words !== undefined ? adu.readUInt16BE(10) : 0;
  if (bits !== undefined) {
    const table = (bits === "coils" ? options.coils : options.discrete) ?? [];
    const bytes = Buffer.alloc(Math.ceil(quantity / 8));
    for (let at = 0; at < quantity; at += 1) {
      if (table[address + at] === true) bytes[at >> 3] = (bytes[at >> 3] ?? 0) | (1 << (at & 7));
    }
    return Buffer.concat([Buffer.from([functionCode, bytes.length]), bytes]);
  }
  if (words !== undefined) {
    const table = (words === "holding" ? options.holding : options.input) ?? [];
    const body = Buffer.alloc(quantity * 2);
    for (let at = 0; at < quantity; at += 1) body.writeUInt16BE(table[address + at] ?? 0, at * 2);
    return Buffer.concat([Buffer.from([functionCode, body.length]), body]);
  }
  if (functionCode === 0x2b && adu[8] === 0x0e) {
    const objects = options.objects ?? [];
    const start = adu[10] ?? 0;
    const from = Math.max(
      0,
      objects.findIndex((object) => object.id >= start),
    );
    const perRound = options.perRound ?? objects.length;
    const slice = objects.slice(from, from + perRound);
    const rest = objects[from + perRound];
    const head = Buffer.from([
      0x2b,
      0x0e,
      adu[9] ?? 1,
      0x83,
      rest === undefined ? 0 : 0xff,
      rest?.id ?? 0,
      slice.length,
    ]);
    const parts = slice.map((object) => Buffer.concat([Buffer.from([object.id, object.bytes.length]), object.bytes]));
    return Buffer.concat([head, ...parts]);
  }
  return Buffer.from([functionCode | 0x80, 0x01]);
}

export async function fakeModbusDevice(options: FakeModbusOptions = {}): Promise<FakeModbusDevice> {
  let open = 0;
  const device: FakeModbusDevice = {
    port: 0,
    received: [],
    connections: [],
    maxOpen: 0,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server: Server = createServer((socket) => {
    open += 1;
    device.maxOpen = Math.max(device.maxOpen, open);
    const record: { opened: number; closed?: number } = { opened: performance.now() };
    device.connections.push(record);
    socket.on("close", () => {
      open -= 1;
      record.closed = performance.now();
    });
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      device.received.push({ adu: Buffer.from(chunk), at: performance.now() });
      if (options.silent === true) return;
      const answer = frame(chunk.readUInt16BE(0), chunk[6] ?? 0, answerOf(chunk, options));
      const send = () => {
        if (!socket.destroyed) socket.write(answer);
      };
      if (options.answerAfterMs === undefined) send();
      else setTimeout(send, options.answerAfterMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  (device as { port: number }).port = (server.address() as { port: number }).port;
  return device;
}

/** The read request ADU a Modbus client sends: MBAP header then function code, address and quantity. */
export function readAdu(
  transactionId: number,
  unitId: number,
  functionCode: number,
  address: number,
  quantity: number,
) {
  const adu = Buffer.alloc(12);
  adu.writeUInt16BE(transactionId, 0);
  adu.writeUInt16BE(0, 2);
  adu.writeUInt16BE(6, 4);
  adu[6] = unitId;
  adu[7] = functionCode;
  adu.writeUInt16BE(address, 8);
  adu.writeUInt16BE(quantity, 10);
  return adu;
}
