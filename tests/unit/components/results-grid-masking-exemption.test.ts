import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { ModbusProvider } from "@/lib/db/providers/industrial/modbus/index";
import { splitMaskedColumns } from "@/lib/db/masking-exemption";
import { DEFAULT_MASKING_CONFIG } from "@/lib/data-masking";
import { offersColumnProfiling } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * THE DEFECT THIS FILE HOLDS: a Modbus read answers a column called `address`, and the grid drew
 * it as `********`.
 *
 * `builtin-address` matches a column by NAME, so it read the register number as a postal address
 * and starred out the one value the request was about: a reader who asked for register 0 could
 * not see which register answered. It was found on a live device, not here.
 *
 * WHY THE COLUMNS COME FROM A REAL READ. The field names are taken from a query run through the
 * real provider against a real socket, never typed into this file. A literal list would keep
 * passing after the provider renamed its columns, which is the one way this guard could go quiet
 * while the defect came back.
 *
 * WHY THIS LAYER AND NOT THE PROVIDER'S. Masking happens in the browser; the provider hands back
 * the raw column. So no integration test or live check can hold this fact - there is nothing
 * wrong at that layer to hold. This is the layer where the decision is made.
 */

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const originalFlag = process.env[FLAG];
let open: Server | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

/** A Modbus TCP device small enough to answer one read, and real enough to be answered by one. */
async function device(bank: readonly number[]): Promise<number> {
  const server = createServer((socket) => {
    socket.on("data", (adu: Buffer) => {
      const transactionId = adu.readUInt16BE(0);
      const unitId = adu[6] ?? 0;
      const functionCode = adu[7] ?? 0;
      const address = adu.readUInt16BE(8);
      const quantity = adu.readUInt16BE(10);
      const words = bank.slice(address, address + quantity);
      const body = Buffer.alloc(words.length * 2);
      words.forEach((word, at) => body.writeUInt16BE(word, at * 2));
      const pdu = Buffer.concat([Buffer.from([functionCode, body.length]), body]);
      const head = Buffer.alloc(7);
      head.writeUInt16BE(transactionId, 0);
      head.writeUInt16BE(0, 2);
      head.writeUInt16BE(pdu.length + 1, 4);
      head[6] = unitId;
      socket.write(Buffer.concat([head, pdu]));
    });
  });
  open = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

const MAP = JSON.stringify([
  { name: "volts", unitId: 1, table: "holding_register", address: 0, type: "uint16", unit: "V" },
]);

const provider = (port: number) =>
  new ModbusProvider({
    id: "m",
    name: "device",
    type: "modbus",
    host: "127.0.0.1",
    port,
    registerMap: MAP,
  } as unknown as DatabaseConnection);

/** The columns a real read answers with, and the capabilities of the provider that answered. */
async function readColumns(statement: string): Promise<{ fields: readonly string[]; engine: ModbusProvider }> {
  delete process.env[FLAG];
  const port = await device([230, 231, 232]);
  const engine = provider(port);
  const result = await engine.query(statement);
  return { fields: result.fields, engine };
}

const RANGE = '{"unit":1,"table":"holding_register","address":0,"count":3}';
const POINTS = '{"read":["volts"]}';

describe("the grid leaves a Modbus address column open, and says why", () => {
  test.each([
    ["a range read", RANGE],
    ["a named-point read", POINTS],
  ])("%s answers an address column, and it is not masked", async (_, statement) => {
    const { fields, engine } = await readColumns(statement);
    // The read really did answer that column; otherwise the rest of this test would be measuring
    // a column that no longer exists.
    expect(fields).toContain("address");

    const declared = engine.getCapabilities().maskingExemptColumns;
    const { masked, exempt } = splitMaskedColumns(fields, DEFAULT_MASKING_CONFIG, declared);

    expect({ masked: masked.has("address"), exempt: exempt.has("address") }).toEqual({
      masked: false,
      exempt: true,
    });
  });

  /**
   * THE REJECTED FIX, held shut.
   *
   * The cheap way to stop a register number being starred out is to take `address` out of the
   * Address rule. It would work here and it would quietly stop masking a real
   * `customers.address` on every other connection - and the cost of that is not measurable in
   * this repository, because what the rule protects is in the user's own schema.
   *
   * So this case passes no declaration: it asks what the rules do when no engine has spoken, and
   * the answer must still be "masked". MEASURED: with `address` removed from `builtin-address`
   * it is the only case in this file that falls. It is not a canary for the exemption - the two
   * cases above are - it is the guard on the door the exemption was built to avoid.
   */
  test("the rules themselves are untouched: with no declaration the same column is still masked", async () => {
    const { fields } = await readColumns(RANGE);
    const { masked, exempt } = splitMaskedColumns(fields, DEFAULT_MASKING_CONFIG, undefined);
    expect({ masked: masked.has("address"), exempt: exempt.size }).toEqual({ masked: true, exempt: 0 });
  });

  test("the reason travels with it, because the header shows it", async () => {
    const { engine } = await readColumns(RANGE);
    const reason = engine.getCapabilities().maskingExemptColumns?.reason ?? "";
    // An exemption with no reason is a hole dug in two steps: the column stops being masked and
    // the screen has nothing to answer "why is this one not masked" with.
    expect(reason.trim().length).toBeGreaterThan(20);
  });

  test("it exempts, it never adds: a column the engine did not name stays masked", async () => {
    const { fields, engine } = await readColumns(RANGE);
    const declared = engine.getCapabilities().maskingExemptColumns;
    // A result of this engine that happened to carry a column the rules protect is still masked:
    // the declaration takes this engine's own column out, it does not open the engine up.
    const { masked, exempt } = splitMaskedColumns([...fields, "email"], DEFAULT_MASKING_CONFIG, declared);
    expect({ email: masked.has("email"), exemptEmail: exempt.has("email") }).toEqual({
      email: true,
      exemptEmail: false,
    });
  });
});

describe("the surfaces this exemption does NOT reach cannot be reached by this engine either", () => {
  test("Modbus is never offered the column profiler", async () => {
    const { engine } = await readColumns(RANGE);
    /*
     * The grid reads the exemption; `DataProfiler.tsx` does not. That is enough TODAY only
     * because the profiler is never offered for this engine - `offersColumnProfiling` is false
     * for every JSON dialect. The day that answer changes for a dialect, the exemption has to
     * travel to the profiler with it, or the same column reads one way in the grid and another
     * in the profiler. This assertion is what will say so.
     */
    expect(offersColumnProfiling(engine.getCapabilities())).toBe(false);
  });
});
