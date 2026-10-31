/**
 * Captures the Modbus agent path's boundary on the pinned docker/modbus fixture and a single-client libmodbus device
 * into `boundary.json`, for `tests/unit/db/modbus/agent-boundary.test.ts` and `docs/providers/modbus.md` section 8.
 * Run by `tests/fixtures/modbus/2.3.0/agent-boundary/run.sh`, which starts both containers and removes them after.
 *
 * What it records:
 *   reads             what each admitted agent read answered, through a real `ModbusProvider` on the agent profile;
 *   refusedBeforeSend each refused agent request's opening words, and how many connections reached the device (0);
 *   pacing            two agent reads of one device sent at once through the process's pacer: the most connections
 *                     open at a time, and the gap from the first's close to the second's open;
 *   lockout           on each device, how long a second client waited while a first held its connection, how soon it
 *                     was answered once that closed, how soon a client dialling after a close was answered, and how
 *                     long one agent read held the single-client device;
 *   rawWrites         what the fixture did with each write function code, sent by THIS script on its own socket and
 *                     never by Studio, and whether the value it targets changed.
 *
 * Every device connection the agent makes goes through a counting proxy in this process, so a count of zero is
 * measured, not assumed. Modbus has no credential, so the capture holds none; it is still scanned for
 * credential-shaped keys before it is written.
 */
import { writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { MODBUS_AGENT_DEVICE_GAP_MS } from "@/lib/db/providers/industrial/modbus/agent-pacing";
import { ModbusProvider } from "@/lib/db/providers/industrial/modbus/index";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import type { DatabaseConnection } from "@/lib/types";

const PORT = Number(process.env.MODBUS_AGENT_PORT ?? "19502");
const SINGLE = Number(process.env.MODBUS_AGENT_SINGLE_PORT ?? "19503");
const OUT = process.env.MODBUS_AGENT_OUT ?? ".";
const IMAGE = "oitc/modbus-server:2.3.0@sha256:32bfe144512e1f070cf7e7e2513cdcb774d74db142ee5dbad45b21d6d705ab97";
const now = () => performance.now();
const ms = (value: number) => Math.round(value);

interface Proxy {
  readonly port: number;
  readonly opened: number[];
  readonly closed: number[];
  maxOpen: number;
  close(): Promise<void>;
}

/** A TCP proxy to a device that counts the connections made through it and when each opened and closed. */
async function proxy(target: number): Promise<Proxy> {
  let open = 0;
  const record: Proxy = { port: 0, opened: [], closed: [], maxOpen: 0, close: async () => {} };
  const server: Server = createServer((client) => {
    open += 1;
    record.maxOpen = Math.max(record.maxOpen, open);
    record.opened.push(now());
    const upstream = connect(target, "127.0.0.1");
    client.pipe(upstream).pipe(client);
    const end = () => {
      if (client.destroyed && upstream.destroyed) return;
      client.destroy();
      upstream.destroy();
      open -= 1;
      record.closed.push(now());
    };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  (record as { port: number }).port = (server.address() as { port: number }).port;
  record.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return record;
}

const MAP = JSON.stringify([
  { name: "hr0", unitId: 1, table: "holding_register", address: 0, type: "uint16" },
  { name: "hr1", unitId: 1, table: "holding_register", address: 1, type: "uint16" },
  { name: "ir0", unitId: 1, table: "input_register", address: 0, type: "uint16" },
  { name: "coil0", unitId: 1, table: "coil", address: 0, type: "bool" },
]);

function agent(port: number): ModbusProvider {
  return new ModbusProvider(
    {
      id: "capture",
      name: "capture",
      type: "modbus",
      host: "127.0.0.1",
      port,
      registerMap: MAP,
    } as unknown as DatabaseConnection,
    {},
    { readOnly: true, sendsStatements: true },
  );
}

const budget = () => ({
  statementTimeoutMs: 15_000,
  maxResultRows: 500,
  maxResultBytes: 1_000_000,
  readAllowance: new RunReadAllowance(10_000),
});

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** One raw request and its answer's PDU, or "unanswered" past the wait. */
function exchange(socket: Socket, pdu: Buffer, transactionId: number, waitMs = 6000): Promise<Buffer | "unanswered"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("unanswered"), waitMs);
    socket.once("data", (adu: Buffer) => {
      clearTimeout(timer);
      resolve(adu.subarray(7));
    });
    const head = Buffer.alloc(7);
    head.writeUInt16BE(transactionId, 0);
    head.writeUInt16BE(pdu.length + 1, 4);
    head[6] = 1;
    socket.write(Buffer.concat([head, pdu]));
  });
}

const READ_HR0 = Buffer.from([0x03, 0, 0, 0, 1]);

/** The lockout of one device: a first client holds its connection for `holdMs` while a second asks. */
async function lockout(port: number, holdMs: number) {
  const first = await dial(port);
  await exchange(first, READ_HR0, 1);
  const second = await dial(port);
  const asked = now();
  const answered = exchange(second, READ_HR0, 2, holdMs + 4000).then((answer) => ({ answer, at: now() }));
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  const closedAt = now();
  first.destroy();
  const { answer, at } = await answered;
  second.destroy();
  const afterClose: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const one = await dial(port);
    await exchange(one, READ_HR0, 10 + round);
    one.destroy();
    const started = now();
    const two = await dial(port);
    await exchange(two, READ_HR0, 20 + round);
    afterClose.push(ms(now() - started));
    two.destroy();
  }
  return {
    holdMs,
    secondWhileFirstHeldMs: answer === "unanswered" ? -1 : ms(at - asked),
    secondAnsweredAfterCloseMs: answer === "unanswered" ? -1 : Math.max(0, ms(at - closedAt)),
    dialAndReadAfterCloseMs: afterClose,
  };
}

async function main(): Promise<void> {
  process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "false";
  const counted = await proxy(PORT);
  const reads: Array<{ statement: string; rows: unknown[]; warnings: unknown[] }> = [];
  for (const statement of [
    '{"unit": 1, "table": "holding_register", "address": 0, "count": 3}',
    '{"unit": 1, "table": "input_register", "address": 0, "count": 2}',
    '{"unit": 1, "table": "coil", "address": 0, "count": 4}',
    '{"unit": 1, "table": "discrete_input", "address": 0, "count": 4}',
    '{"unit": 1, "table": "holding_register", "address": 0, "count": 2, "type": "uint32"}',
    '{"read": ["hr1", "ir0", "coil0", "hr0"]}',
    '{"identify": "basic"}',
    '{"identify": "extended"}',
  ]) {
    try {
      const result = await agent(counted.port).queryReadOnly(statement, budget());
      reads.push({ statement, rows: result.rows, warnings: result.warnings ?? [] });
    } catch (error) {
      reads.push({ statement, rows: [], warnings: [{ refused: (error as Error).message }] });
    }
  }

  const refusals = await proxy(PORT);
  const refusedBeforeSend: Array<{ statement: string; opening: string; connections: number }> = [];
  for (const statement of [
    '{"unit": 1, "table": "holding_register", "address": 0, "count": 1, "function": 6}',
    '{"unit": 1, "table": "holding_register", "address": 0, "count": 1, "value": 1}',
    '{"unit": 0, "table": "coil", "address": 0, "count": 1}',
    '{"unit": 1, "table": "coil", "address": 65536, "count": 1}',
    '{"unit": 1, "table": "holding_register", "address": 0, "count": 126}',
    '{"identify": "individual"}',
    '{"read": ["not-in-the-map"]}',
    "write 40001 1",
  ]) {
    const before = refusals.opened.length;
    try {
      await agent(refusals.port).queryReadOnly(statement, budget());
      refusedBeforeSend.push({ statement, opening: "ADMITTED", connections: refusals.opened.length - before });
    } catch (error) {
      refusedBeforeSend.push({
        statement,
        opening: (error as Error).message.split(". ")[0] ?? "",
        connections: refusals.opened.length - before,
      });
    }
  }

  const paced = await proxy(SINGLE);
  const text = '{"unit": 1, "table": "holding_register", "address": 0, "count": 1}';
  await Promise.all([agent(paced.port).queryReadOnly(text, budget()), agent(paced.port).queryReadOnly(text, budget())]);
  const concurrentReads = {
    maxOpen: paced.maxOpen,
    gapAfterCloseMs: ms((paced.opened[1] ?? 0) - (paced.closed[0] ?? 0)),
  };

  await new Promise((resolve) => setTimeout(resolve, MODBUS_AGENT_DEVICE_GAP_MS));
  const held = await proxy(SINGLE);
  await agent(held.port).queryReadOnly(text, budget());
  // The proxy hears the close on its own turn of the loop, after the read has settled.
  while (held.closed.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const agentReadHoldMs = ms((held.closed[0] ?? 0) - (held.opened[0] ?? 0));

  const lockouts = {
    pymodbus: await lockout(PORT, 1000),
    singleClient: { ...(await lockout(SINGLE, 2000)), agentReadHoldMs },
  };

  // The raw writes, last: sent by this script on its own socket, never by Studio, and each read back raw.
  const writer = await dial(PORT);
  let tid = 100;
  const rawWrites: Array<{ functionCode: number; answer: string; changed: boolean }> = [];
  const readBack = async (pdu: Buffer) => {
    const answer = await exchange(writer, pdu, (tid += 1));
    return answer === "unanswered" ? "unanswered" : answer.toString("hex");
  };
  const writes: ReadonlyArray<readonly [number, Buffer, Buffer]> = [
    [5, Buffer.from([0x05, 0, 1, 0xff, 0]), Buffer.from([0x01, 0, 1, 0, 1])],
    [6, Buffer.from([0x06, 0, 2, 0x04, 0xd2]), Buffer.from([0x03, 0, 2, 0, 1])],
    [15, Buffer.from([0x0f, 0, 2, 0, 2, 1, 0x03]), Buffer.from([0x01, 0, 2, 0, 2])],
    [16, Buffer.from([0x10, 0, 3, 0, 1, 2, 0x11, 0x11]), Buffer.from([0x03, 0, 3, 0, 1])],
    [22, Buffer.from([0x16, 0, 4, 0, 0, 0, 0x01]), Buffer.from([0x03, 0, 4, 0, 1])],
    [23, Buffer.from([0x17, 0, 5, 0, 1, 0, 5, 0, 1, 2, 0x22, 0x22]), Buffer.from([0x03, 0, 5, 0, 1])],
  ];
  for (const [functionCode, write, read] of writes) {
    const before = await readBack(read);
    const answer = await exchange(writer, write, (tid += 1));
    const after = await readBack(read);
    rawWrites.push({
      functionCode,
      answer:
        answer === "unanswered"
          ? "unanswered"
          : (answer[0] ?? 0) & 0x80
            ? `exception ${answer[1] ?? 0}`
            : `answered function ${answer[0] ?? 0}`,
      changed: before !== after,
    });
  }
  writer.destroy();

  for (const one of [counted, refusals, paced, held]) await one.close();

  const capture = {
    fixture: { image: IMAGE, singleClient: "libmodbus, one client at a time (single-client/server.c)" },
    reads,
    refusedBeforeSend,
    pacing: { gapMs: MODBUS_AGENT_DEVICE_GAP_MS, concurrentReads },
    lockout: lockouts,
    rawWrites,
  };
  const written = `${JSON.stringify(capture, null, 2)}\n`;
  // Modbus has no credential; a key shaped like one in the capture is a mistake in this script.
  if (/"(?:password|passwd|secret|token|community|key)"\s*:/i.test(written)) {
    console.error("modbus-agent-boundary: the capture holds a credential-shaped key; nothing was written.");
    process.exit(1);
  }
  writeFileSync(path.join(OUT, "boundary.json"), written);
  console.log(`modbus-agent-boundary: wrote ${path.join(OUT, "boundary.json")}`);
  process.exit(0);
}

await main();
