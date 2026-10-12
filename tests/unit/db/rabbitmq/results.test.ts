/**
 * One read's outcome to a QueryResult: the stop's warning first, then the timestamp-start note, then the rendering
 * counts; the row limit is `wasLimited` with no warning; a 541 after consume-ok with no row is an error, never an empty
 * result presented as complete; and a large-message result keeps its offsets and sizes exact through export.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type { RawMessage, StopReason, StreamReadOutcome } from "@/lib/db/providers/stream/rabbitmq/amqp/read-loop";
import {
  amqp10Bodies,
  budgetWarning,
  cancelWarning,
  cellsCut,
  closedWarning,
  conversionAfter,
  conversionNoRowKeyword,
  conversionNoRowNumeric,
  cutBodies,
  deadlineWarning,
  deepPayloads,
  IDLE_WARNING,
  lastIdleWarning,
  NEXT_EMPTY_WARNING,
  serverCancelWarning,
  TIMESTAMP_START_WARNING,
  timestampsOutOfRange,
  wireOversizeAtOffset,
  wireOversizeUnknown,
  wireWarning,
} from "@/lib/db/providers/stream/rabbitmq/errors";
import { RABBITMQ_BODY_PREFIX_BYTES } from "@/lib/db/providers/stream/rabbitmq/limits";
import { parseReadRequest } from "@/lib/db/providers/stream/rabbitmq/request";
import { buildReadResult, RABBITMQ_RESULT_FIELDS } from "@/lib/db/providers/stream/rabbitmq/results";
import { buildResultExport } from "@/lib/export/result-export";

const utf8 = (text: string) => new TextEncoder().encode(text);
const offsetHeader = (offset: bigint) => ({
  name: utf8("x-stream-offset"),
  value: { tag: "l" as const, value: offset },
});

function message(offset: bigint, body = utf8(`{"n":${offset}}`), bodySize = body.length): RawMessage {
  return {
    offset,
    exchange: utf8(""),
    routingKey: utf8("orders"),
    properties: { headers: [offsetHeader(offset)] },
    body,
    bodySize,
    retainedHeaderBytes: 30,
  };
}

const outcome = (stop: StopReason, messages: readonly RawMessage[] = [], prefetch = 10): StreamReadOutcome => ({
  messages,
  stop,
  prefetch,
});
const request = (from: unknown = "last", vhost = "/", stream = "orders") =>
  parseReadRequest(JSON.stringify({ vhost, stream, from, limit: 3 }));
const two = [message(BigInt(120)), message(BigInt(121))];
const messages = (result: ReturnType<typeof buildReadResult>) => result.warnings?.map((w) => w.message);

describe("rows and pagination", () => {
  test("the row limit: rows in offset order, wasLimited, no warning, hasMore always false", () => {
    const result = buildReadResult(outcome({ kind: "limit" }, two), request(), 12, 30);
    expect(result.fields).toEqual([...RABBITMQ_RESULT_FIELDS]);
    expect(result.rows.map((row) => row.offset)).toEqual(["120", "121"]);
    expect(result.rows[0]).toMatchObject({ payload: { n: 120 }, payload_encoding: "json", headers: {} });
    expect(result.rowCount).toBe(2);
    expect(result.executionTime).toBe(12);
    expect(result.pagination).toEqual({ limit: 3, offset: 0, hasMore: false, totalReturned: 2, wasLimited: true });
    expect(result.warnings).toBeUndefined();
  });
});

describe("the stop's warning", () => {
  test("idle on a last read with rows names the earlier offset to read from", () => {
    const result = buildReadResult(outcome({ kind: "idle" }, two), request("last", "billing", "st"), 0, 30);
    expect(messages(result)).toEqual([lastIdleWarning("billing", "st", 2, BigInt(120))]);
    expect(result.pagination?.wasLimited).toBe(false);
  });

  test.each([
    ["first", two, IDLE_WARNING],
    ["last", [], IDLE_WARNING],
    ["next", [], NEXT_EMPTY_WARNING],
    ["next", two, IDLE_WARNING],
    [{ offset: 5 }, [], IDLE_WARNING],
  ] as const)("idle from %p with %#", (from, kept, expected) => {
    expect(messages(buildReadResult(outcome({ kind: "idle" }, kept), request(from), 0, 30))).toEqual([expected]);
  });

  test("budget and wire name the offset after the last row", () => {
    expect(messages(buildReadResult(outcome({ kind: "budget" }, two), request(), 0, 30))).toEqual([
      budgetWarning(BigInt(122)),
    ]);
    expect(messages(buildReadResult(outcome({ kind: "wire" }, two), request(), 0, 30))).toEqual([
      wireWarning(BigInt(122)),
    ]);
  });

  test("a byte stop with no row kept is not a result: the read's boundary words it", () => {
    expect(() => buildReadResult(outcome({ kind: "budget" }), request(), 0, 30)).toThrow(Error);
  });

  test("a message larger than one read may transfer: by its offset, or after the last row", () => {
    expect(messages(buildReadResult(outcome({ kind: "wire-oversize", offset: BigInt(37) }), request(), 0, 30))).toEqual(
      [wireOversizeAtOffset(BigInt(37))],
    );
    expect(messages(buildReadResult(outcome({ kind: "wire-oversize", offset: null }, two), request(), 0, 30))).toEqual([
      wireOversizeUnknown(BigInt(121)),
    ]);
    expect(messages(buildReadResult(outcome({ kind: "wire-oversize", offset: null }), request(), 0, 30))).toEqual([
      wireOversizeUnknown(null),
    ]);
  });

  test.each([
    [{ kind: "deadline" } as const, deadlineWarning(5, BigInt(121)), deadlineWarning(5, null)],
    [{ kind: "cancel" } as const, cancelWarning(BigInt(121)), cancelWarning(null)],
    [{ kind: "server-cancel" } as const, serverCancelWarning(BigInt(121)), serverCancelWarning(null)],
    [{ kind: "closed" } as const, closedWarning(BigInt(121)), closedWarning(null)],
  ])("%p with and without rows", (stop, withRows, withoutRows) => {
    expect(messages(buildReadResult(outcome(stop, two), request(), 0, 5))).toEqual([withRows]);
    expect(messages(buildReadResult(outcome(stop), request(), 0, 5))).toEqual([withoutRows]);
  });
});

describe("541 after consume-ok", () => {
  test("with rows: a warning on the partial result naming the last offset and the prefetch", () => {
    const result = buildReadResult(outcome({ kind: "conversion" }, two, 3), request("first", "/", "st"), 0, 30);
    expect(result.rows).toHaveLength(2);
    expect(messages(result)).toEqual([conversionAfter(BigInt(121), 3, "/", "st")]);
  });

  function zeroRows(from: unknown): QueryError {
    try {
      buildReadResult(outcome({ kind: "conversion" }, [], 10), request(from, "v", "st"), 0, 30);
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      return error as QueryError;
    }
    throw new Error("a zero-row 541 answered a result");
  }

  test("with no row from a numeric start: an error naming the start, never an empty result", () => {
    expect(zeroRows({ offset: "9007199254740993" }).message).toBe(
      conversionNoRowNumeric(BigInt("9007199254740993"), 10, "v", "st"),
    );
  });

  test.each([
    ["last", '"last"', true],
    ["first", '"first"', false],
    ["next", '"next"', false],
    [{ timestamp: "2026-10-11T08:30:15Z" }, '{"timestamp": "2026-10-11T08:30:15.000Z"}', false],
    [{ age: "5m" }, '{"age": "5m"}', false],
  ])("with no row from %p: the keyword sentence", (from, start, isLast) => {
    expect(zeroRows(from).message).toBe(conversionNoRowKeyword(start, isLast, "v", "st"));
  });
});

describe("notes after the stop's warning", () => {
  test("a timestamp or age start always adds the start note, after the stop's warning", () => {
    for (const from of [{ timestamp: "2026-10-11T08:30:15Z" }, { age: "1h" }]) {
      expect(messages(buildReadResult(outcome({ kind: "idle" }, two), request(from), 0, 30))).toEqual([
        IDLE_WARNING,
        TIMESTAMP_START_WARNING,
      ]);
      expect(messages(buildReadResult(outcome({ kind: "limit" }, two), request(from), 0, 30))).toEqual([
        TIMESTAMP_START_WARNING,
      ]);
    }
  });

  test("the rendering counts follow, one warning each, in a fixed order", () => {
    const deep = `${"[".repeat(65)}${"]".repeat(65)}`;
    const cut = new Uint8Array(RABBITMQ_BODY_PREFIX_BYTES).fill(0x61);
    const kept = [
      {
        ...message(BigInt(1)),
        properties: { headers: [offsetHeader(BigInt(1))], timestamp: BigInt("9223372036854775807") },
      },
      message(BigInt(2), cut, RABBITMQ_BODY_PREFIX_BYTES + 1),
      { ...message(BigInt(3), Uint8Array.from([0x00, 0x53, 0x77, 0x41])), properties: { type: utf8("amqp-1.0") } },
      message(BigInt(4), utf8(deep)),
    ];
    expect(messages(buildReadResult(outcome({ kind: "server-cancel" }, kept), request("first"), 0, 30))).toEqual([
      serverCancelWarning(BigInt(4)),
      timestampsOutOfRange(1),
      cellsCut(1),
      amqp10Bodies(1),
      deepPayloads(1),
      cutBodies(1),
    ]);
  });

  test("a payload cut at the cell, with no header at all, is counted as a cell, never as a headers cell", () => {
    const text = message(BigInt(7), utf8("a".repeat(100_000)));
    const kept = [{ ...text, properties: { headers: [offsetHeader(BigInt(7))] } }];
    const result = buildReadResult(outcome({ kind: "limit" }, kept, 1), request("first"), 0, 30);
    expect(result.rows[0]?.headers).toEqual({});
    expect(messages(result)).toEqual(["1 cell was cut at 65,536 characters."]);
  });
});

describe("streams of large messages, through export", () => {
  test("5 MiB JSON bodies: text rows with the exact size, a budget stop whose suggested read starts past it", () => {
    const fiveMiB = 5 * 1024 * 1024;
    const prefix = utf8(`{"blob":"${"z".repeat(RABBITMQ_BODY_PREFIX_BYTES)}`).subarray(0, RABBITMQ_BODY_PREFIX_BYTES);
    const base = BigInt("9007199254740993");
    const kept = Array.from({ length: 31 }, (_, i) => message(base + BigInt(i), prefix, fiveMiB));
    const result = buildReadResult(outcome({ kind: "budget" }, kept), request({ offset: base.toString() }), 0, 30);
    expect(result.rows.every((row) => row.payload_encoding === "text" && row.payload_bytes === fiveMiB)).toBe(true);
    const next = base + BigInt(31);
    expect(result.warnings?.[0].message).toBe(budgetWarning(next));
    const again = parseReadRequest(JSON.stringify({ vhost: "/", stream: "orders", from: { offset: next.toString() } }));
    expect(again.from).toEqual({ kind: "offset", value: next });
    expect(next > base + BigInt(30)).toBe(true);

    const source = { rows: result.rows, fields: result.fields, tabName: "orders", dialect: "rabbitmq" as const };
    const csv = buildResultExport("csv", source).content;
    expect(csv).toContain("9007199254740993");
    expect(csv).toContain(String(fiveMiB));
    const json = JSON.parse(buildResultExport("json", source).content) as Record<string, unknown>[];
    expect(json[0].offset).toBe("9007199254740993");
    expect(json[30].offset).toBe("9007199254741023");
    expect(json[0].payload_bytes).toBe(fiveMiB);
  });
});
