/**
 * One parsed read request, run against a device.
 *
 * This is the step that was missing while everything else existed: the client dialled, the session
 * serialised, the planner grouped and the decoder decoded, and nothing called them in order, so
 * `connect()` returned successfully and no byte ever left the process. A registered engine whose
 * connect succeeds and whose reads refuse is worse than an unregistered one, because the showcase
 * line promises it.
 *
 * WHAT THIS MODULE DOES NOT HOLD. It takes an `Exchanger` rather than a socket, so every rule here
 * is measurable without a network, and the socket's own rules (dial, TLS, egress) stay in
 * `client.ts`. The session gives it one exchange at a time; this module never runs two.
 */
import { QueryError } from "@/lib/db/errors";
import { MAX_IDENTIFICATION_ROUNDS } from "./constants";
import { nameOfObject, parseIdentificationResponse, valueOfObject, type IdentificationObject } from "./identification";
import { planReads, type Block } from "./plan";
import { buildIdentification, buildRead, EXCEPTION_SENTENCES, type Table } from "./pdu";
import type { ReadRequest } from "./request";
import type { MapPoint, ParsedMap } from "./register-map";
import { decodeBits, decodeScalar, REGISTERS_OF_TYPE, applyScale, type ByteOrder, type WordOrder } from "./values";
import type { Exchange } from "./framing";

/** What the session offers. Declared here so a test can run every rule below with no socket. */
export interface Exchanger {
  exchange(build: (transactionId: number) => Buffer): Promise<Exchange>;
}

export interface ReadRows {
  readonly fields: string[];
  readonly rows: Record<string, unknown>[];
  readonly warnings: readonly string[];
}

const BIT_TABLES: ReadonlySet<string> = new Set(["coil", "discrete_input"]);

/**
 * A device's own refusal, in its own words where the protocol gives them.
 *
 * `QueryError` rather than a bare throw: the device answered, the answer is a refusal of THIS
 * read, and the next read may well succeed. An exception code the protocol does not define is
 * reported as the number it is rather than guessed at.
 */
function refusal(code: number): QueryError {
  const sentence = EXCEPTION_SENTENCES[code];
  return new QueryError(
    sentence ?? `The device refused the read with exception code ${code}, which Modbus does not define.`,
  );
}

/** The data bytes of a read answer: the body is a byte count and then that many bytes. */
function dataOf(frame: { readonly body: Buffer }): Buffer {
  const declared = frame.body[0] ?? 0;
  const bytes = frame.body.subarray(1);
  if (bytes.length !== declared)
    throw new QueryError(
      `The device declared ${declared} bytes and sent ${bytes.length}, so the answer cannot be read.`,
    );
  return Buffer.from(bytes);
}

const wordsOf = (bytes: Buffer): number[] => {
  const out: number[] = [];
  for (let at = 0; at + 1 < bytes.length; at += 2) out.push(bytes.readUInt16BE(at));
  return out;
};

async function readBlock(session: Exchanger, block: Block): Promise<{ words: number[]; bits: boolean[] }> {
  const answer = await session.exchange((transactionId) =>
    buildRead(transactionId, block.unitId, block.table, block.address, block.quantity),
  );
  if (answer.kind === "exception") throw refusal(answer.code);
  const bytes = dataOf(answer.frame);
  return BIT_TABLES.has(block.table)
    ? { words: [], bits: decodeBits(bytes, block.quantity) }
    : { words: wordsOf(bytes), bits: [] };
}

/** The layout a point reads under: its own orders, which the map requires for anything wider. */
const layoutOf = (point: MapPoint): { wordOrder: WordOrder; byteOrder: ByteOrder } => ({
  wordOrder: point.wordOrder ?? "high_first",
  byteOrder: point.byteOrder ?? "high_first",
});

function valueOfPoint(point: MapPoint, block: Block, read: { words: number[]; bits: boolean[] }): unknown {
  const offset = point.address - block.address;
  if (BIT_TABLES.has(point.table)) return read.bits[offset] ?? null;
  const span = REGISTERS_OF_TYPE[point.type] ?? point.registers ?? 1;
  const words = read.words.slice(offset, offset + span);
  if (words.length !== span) return null;
  if (REGISTERS_OF_TYPE[point.type] === undefined) return words;
  const decoded = decodeScalar(point.type as keyof typeof REGISTERS_OF_TYPE, words, layoutOf(point));
  return applyScale(decoded, point.scale, point.offset);
}

const POINT_FIELDS = ["point", "unit", "table", "address", "type", "raw", "value", "unit_of_measure"];

async function readPoints(names: readonly string[], map: ParsedMap, session: Exchanger): Promise<ReadRows> {
  const byName = new Map(map.points.map((point) => [point.name, point]));
  const wanted = names.map((name) => byName.get(name)).filter((point): point is MapPoint => point !== undefined);
  const rows: Record<string, unknown>[] = [];
  // Planned, not read one by one: 125 registers in one request rather than 125 requests, and a
  // block is cut wherever the map has no point, because one undefined register fails the whole
  // block with exception 02.
  for (const block of planReads(wanted)) {
    const read = await readBlock(session, block);
    for (const point of block.points) {
      const offset = point.address - block.address;
      rows.push({
        point: point.name,
        unit: point.unitId,
        table: point.table,
        address: point.address,
        type: point.type,
        raw: BIT_TABLES.has(point.table)
          ? (read.bits[offset] ?? null)
          : read.words.slice(offset, offset + (REGISTERS_OF_TYPE[point.type] ?? point.registers ?? 1)),
        value: valueOfPoint(point, block, read),
        unit_of_measure: point.unit ?? null,
      });
    }
  }
  // The caller's order, not the planner's: blocks are grouped by unit and address, and a reader
  // asked for their names in the order they wrote them.
  const place = new Map(names.map((name, at) => [name, at]));
  rows.sort((a, b) => (place.get(String(a.point)) ?? 0) - (place.get(String(b.point)) ?? 0));
  return { fields: POINT_FIELDS, rows, warnings: map.warnings };
}

const RANGE_FIELDS = ["unit", "table", "address", "raw", "value"];

async function readRange(request: Extract<ReadRequest, { kind: "range" }>, session: Exchanger): Promise<ReadRows> {
  const block: Block = {
    unitId: request.unitId,
    table: request.table as Table,
    address: request.address,
    quantity: request.count,
    points: [],
  };
  const read = await readBlock(session, block);
  const rows: Record<string, unknown>[] = [];
  if (BIT_TABLES.has(request.table)) {
    read.bits.forEach((bit, at) => {
      rows.push({ unit: request.unitId, table: request.table, address: request.address + at, raw: bit, value: bit });
    });
    return { fields: RANGE_FIELDS, rows, warnings: [] };
  }
  const span = request.type === undefined ? 1 : (REGISTERS_OF_TYPE[request.type] ?? 1);
  for (let at = 0; at + span <= read.words.length; at += span) {
    const words = read.words.slice(at, at + span);
    rows.push({
      unit: request.unitId,
      table: request.table,
      address: request.address + at,
      raw: words,
      value:
        request.type === undefined
          ? words[0]
          : decodeScalar(request.type as keyof typeof REGISTERS_OF_TYPE, words, {
              wordOrder: request.wordOrder ?? "high_first",
              byteOrder: request.byteOrder ?? "high_first",
            }),
    });
  }
  return { fields: RANGE_FIELDS, rows, warnings: [] };
}

const IDENTIFY_FIELDS = ["object_id", "name", "value"];

/**
 * The identification walk, bounded in three ways at once (MB-S6).
 *
 * It follows Next Object Id while More Follows is 0xFF, for at most `MAX_IDENTIFICATION_ROUNDS`
 * rounds, and only while the next object id INCREASES. A device that repeats an id would otherwise
 * walk forever answering the same objects, and a round bound alone would make that a slow failure
 * rather than a refused one. A walk cut short returns what it has, with a warning: the objects
 * already read are real, and dropping them to report a bound helps nobody.
 */
async function readIdentification(
  level: "basic" | "regular" | "extended",
  unitId: number,
  session: Exchanger,
): Promise<ReadRows> {
  const seen: IdentificationObject[] = [];
  const warnings: string[] = [];
  let next = 0x00;
  for (let round = 0; ; round += 1) {
    if (round >= MAX_IDENTIFICATION_ROUNDS) {
      warnings.push(
        `The device was still sending identification objects after ${MAX_IDENTIFICATION_ROUNDS} requests, so the walk stopped there and this list is what it had.`,
      );
      break;
    }
    const at = next;
    const answer = await session.exchange((transactionId) => buildIdentification(transactionId, unitId, level, at));
    if (answer.kind === "exception") {
      // 01 to 43/14 means the device does not have the function (MB 6.21), which is a fact about
      // the device rather than a failed read, so a walk that already has objects keeps them.
      if (answer.code === 0x01 && seen.length > 0) {
        warnings.push("The device stopped answering identification requests partway through.");
        break;
      }
      throw refusal(answer.code);
    }
    const parsed = parseIdentificationResponse(answer.frame.body.subarray(1));
    seen.push(...parsed.objects);
    if (!parsed.moreFollows) break;
    if (parsed.nextObjectId <= at) {
      warnings.push(
        `The device asked the walk to continue at object 0x${parsed.nextObjectId.toString(16)}, which does not come after 0x${at.toString(16)}, so it stopped there.`,
      );
      break;
    }
    next = parsed.nextObjectId;
  }
  return {
    fields: IDENTIFY_FIELDS,
    rows: seen.map((object) => ({
      object_id: `0x${object.id.toString(16).padStart(2, "0")}`,
      name: nameOfObject(object.id),
      value: valueOfObject(object.bytes),
    })),
    warnings,
  };
}

/** Runs one parsed request. `unitId` is the connection's own, used where a shape names none. */
export async function runRead(
  request: ReadRequest,
  map: ParsedMap,
  session: Exchanger,
  unitId: number,
): Promise<ReadRows> {
  switch (request.kind) {
    case "points":
      return await readPoints(request.names, map, session);
    case "range":
      return await readRange(request, session);
    case "identify":
      return await readIdentification(request.level, unitId, session);
  }
}
