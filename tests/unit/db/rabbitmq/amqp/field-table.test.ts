/**
 * The content-header walk: every field tag of RabbitMQ's table, the depth marker, the retained limits, the stream
 * offset wherever it sits, the basic properties, and the malformed shapes that end a read.
 */
import { describe, expect, test } from "bun:test";
import { ProtocolViolation } from "@/lib/db/providers/stream/rabbitmq/amqp/codec";
import {
  type ContentHeader,
  ENTRY_OVERHEAD_BYTES,
  type FieldEntry,
  walkContentHeader,
} from "@/lib/db/providers/stream/rabbitmq/amqp/field-table";
import {
  RABBITMQ_HEADER_TABLE_RETAINED_BYTES,
  RABBITMQ_HEADER_VALUE_RETAINED_BYTES,
} from "@/lib/db/providers/stream/rabbitmq/limits";
import {
  bytesOf,
  encodeProperties,
  i64,
  longstr,
  nestedTable,
  rawArray,
  rawTable,
  u16,
  u32,
  u64,
} from "../../../../helpers/rabbitmq-fake-peer";

const name = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString();

interface Walked {
  readonly header: ContentHeader;
  readonly bodySizes: bigint[];
  readonly offsets: bigint[];
  /** The largest single take the walk asked for: no buffer it holds is larger. */
  readonly largestTake: number;
}

/** Drives the walk over one payload as a frame reader would, recording the hooks and the largest take. */
function walk(payload: Uint8Array, refuseBody?: bigint): Walked {
  const bodySizes: bigint[] = [];
  const offsets: bigint[] = [];
  const walker = walkContentHeader(payload.length, {
    bodySize: (size) => {
      if (refuseBody !== undefined && size > refuseBody) throw new ProtocolViolation("body-ceiling", 501);
      bodySizes.push(size);
    },
    streamOffset: (offset) => offsets.push(offset),
  });
  let at = 0;
  let largestTake = 0;
  let input = new Uint8Array(0);
  for (;;) {
    const step = walker.next(input);
    if (step.done) return { header: step.value, bodySizes, offsets, largestTake };
    if ("take" in step.value) {
      largestTake = Math.max(largestTake, step.value.take);
      input = payload.slice(at, at + step.value.take);
      at += step.value.take;
    } else {
      input = new Uint8Array(0);
      at += step.value.skip;
    }
  }
}

const header = (bodySize: bigint, properties: Uint8Array) => bytesOf(u16(60), u16(0), u64(bodySize), properties);
const withHeaders = (table: Uint8Array) => header(BigInt(5), bytesOf(u16(1 << 13), table));
const violationOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("field tags", () => {
  test("every tag of RabbitMQ's table decodes to its typed value", () => {
    const decimal = bytesOf(2, [0xff, 0xff, 0xff, 0x85]);
    const float = new Uint8Array(4);
    new DataView(float.buffer).setFloat32(0, 1.5);
    const double = new Uint8Array(8);
    new DataView(double.buffer).setFloat64(0, Number.NaN);
    const table = rawTable([
      ["x-stream-offset", "l", i64(BigInt(37))],
      ["t", "t", Uint8Array.of(1)],
      ["b", "b", Uint8Array.of(0xff)],
      ["B", "B", Uint8Array.of(0xff)],
      ["s", "s", Uint8Array.of(0xff, 0xfe)],
      ["u", "u", Uint8Array.of(0xff, 0xfe)],
      ["I", "I", u32(0xffff_fff0)],
      ["i", "i", u32(0xffff_fff0)],
      ["l", "l", i64(BigInt("9007199254740993"))],
      ["L", "L", i64(-BigInt("9007199254740993"))],
      ["T", "T", u64(BigInt(1_760_000_000))],
      ["f", "f", float],
      ["d", "d", double],
      ["D", "D", decimal],
      ["V", "V", new Uint8Array(0)],
      ["S", "S", longstr(Uint8Array.of(0xff, 0xfe, 0xc3, 0x28))],
      ["x", "x", longstr(Uint8Array.of(0, 1, 0xfe, 0xff))],
      ["F", "F", rawTable([["inner", "t", Uint8Array.of(0)]])],
      [
        "A",
        "A",
        rawArray([
          ["I", u32(7)],
          ["S", longstr("x")],
        ]),
      ],
      ["Fe", "F", rawTable([])],
      ["Ae", "A", rawArray([])],
    ]);
    const { header: walked, offsets } = walk(withHeaders(table));
    const values = Object.fromEntries(
      (walked.properties.headers ?? []).map((entry) => [text(entry.name), entry.value]),
    );
    expect(offsets).toEqual([BigInt(37)]);
    expect(values["x-stream-offset"]).toEqual({ tag: "l", value: BigInt(37) });
    expect(values.t).toEqual({ tag: "t", value: true });
    expect(values.b).toEqual({ tag: "b", value: -1 });
    expect(values.B).toEqual({ tag: "B", value: 255 });
    expect(values.s).toEqual({ tag: "s", value: -2 });
    expect(values.u).toEqual({ tag: "u", value: 65_534 });
    expect(values.I).toEqual({ tag: "I", value: -16 });
    expect(values.i).toEqual({ tag: "i", value: 4_294_967_280 });
    expect(values.l).toEqual({ tag: "l", value: BigInt("9007199254740993") });
    expect(values.L).toEqual({ tag: "L", value: -BigInt("9007199254740993") });
    expect(values.T).toEqual({ tag: "T", value: BigInt(1_760_000_000) });
    expect(values.f).toEqual({ tag: "f", value: 1.5 });
    expect(Number.isNaN((values.d as { value: number }).value)).toBe(true);
    expect(values.D).toEqual({ tag: "D", scale: 2, value: -123 });
    expect(values.V).toEqual({ tag: "V" });
    expect(values.S).toEqual({ tag: "S", bytes: Uint8Array.of(0xff, 0xfe, 0xc3, 0x28) });
    expect(values.x).toEqual({ tag: "x", bytes: Uint8Array.of(0, 1, 0xfe, 0xff) });
    expect(values.F).toEqual({ tag: "F", entries: [{ name: name("inner"), value: { tag: "t", value: false } }] });
    expect(values.A).toEqual({
      tag: "A",
      items: [
        { tag: "I", value: 7 },
        { tag: "S", bytes: name("x") },
      ],
    });
    expect(values.Fe).toEqual({ tag: "F", entries: [] });
    expect(values.Ae).toEqual({ tag: "A", items: [] });
  });

  test("an unknown tag, U included, is a protocol violation with 501", () => {
    for (const tag of ["U", "Z"]) {
      const error = violationOf(() => walk(withHeaders(rawTable([["k", tag, new Uint8Array(0)]]))));
      expect(error).toBeInstanceOf(ProtocolViolation);
      expect(error).toMatchObject({ fact: "unknown-field", replyCode: 501 });
    }
  });

  test("names are raw bytes kept as delivered: __proto__, constructor, the empty name and invalid UTF-8", () => {
    const table = rawTable([
      ["__proto__", "S", longstr("p")],
      ["constructor", "S", longstr("c")],
      ["", "t", Uint8Array.of(1)],
      [Uint8Array.of(0xff, 0x6b), "t", Uint8Array.of(0)],
      ["dup", "t", Uint8Array.of(1)],
      ["dup", "t", Uint8Array.of(0)],
    ]);
    const entries = walk(withHeaders(table)).header.properties.headers as readonly FieldEntry[];
    expect(entries.map((entry) => Buffer.from(entry.name).toString("hex"))).toEqual([
      Buffer.from("__proto__").toString("hex"),
      Buffer.from("constructor").toString("hex"),
      "",
      "ff6b",
      Buffer.from("dup").toString("hex"),
      Buffer.from("dup").toString("hex"),
    ]);
  });
});

describe("depth", () => {
  test("a table eight levels deep is kept, and a ninth level is a marker with its byte count", () => {
    const kept = walk(withHeaders(rawTable([["deep", "F", nestedTable(7)]])));
    let level = kept.header.properties.headers?.[0]?.value;
    for (let depth = 2; depth <= 8; depth++) {
      expect(level?.tag).toBe("F");
      level = (level as unknown as { entries: FieldEntry[] }).entries[0]?.value;
    }
    expect(level).toEqual({ tag: "S", bytes: name("x") });

    const deep = nestedTable(8);
    const marked = walk(withHeaders(rawTable([["deep", "F", nestedTable(8)]])));
    let inner = marked.header.properties.headers?.[0]?.value;
    for (let depth = 2; depth <= 8; depth++) inner = (inner as unknown as { entries: FieldEntry[] }).entries[0]?.value;
    expect(inner).toEqual({ tag: "too-deep", bytes: deep.length - 4 - 7 * 7 });
  });

  test("a table nested 10,000 levels deep is walked without recursion", () => {
    const walked = walk(withHeaders(rawTable([["deep", "F", nestedTable(10_000)]])));
    expect(walked.header.properties.headers?.[0]?.value.tag).toBe("F");
  });
});

describe("retained limits", () => {
  test("a value above the per-value limit is a marker with its size, and x-stream-offset after 15 MiB is kept", () => {
    const big = RABBITMQ_HEADER_VALUE_RETAINED_BYTES + 1;
    const huge = 15 * 1024 * 1024;
    const table = rawTable([
      ["big", "S", longstr(new Uint8Array(big))],
      ["huge", "x", longstr(new Uint8Array(huge))],
      ["x-stream-offset", "l", i64(BigInt(37))],
    ]);
    const walked = walk(withHeaders(table));
    const entries = walked.header.properties.headers as readonly FieldEntry[];
    expect(entries.map((entry) => [text(entry.name), entry.value])).toEqual([
      ["big", { tag: "omitted", bytes: big }],
      ["huge", { tag: "omitted", bytes: huge }],
      ["x-stream-offset", { tag: "l", value: BigInt(37) }],
    ]);
    expect(walked.offsets).toEqual([BigInt(37)]);
    expect(walked.largestTake).toBeLessThanOrEqual(RABBITMQ_HEADER_VALUE_RETAINED_BYTES);
  });

  test("past the table limit values become markers, and past it for names too entries are counted, not kept", () => {
    const value = 200_000;
    const entries = Array.from(
      { length: 8 },
      (_, index) => [`v${index}`, "S", longstr(new Uint8Array(value))] as const,
    );
    const tiny = Array.from({ length: 40_000 }, (_, index) => [`k${index}`, "V", new Uint8Array(0)] as const);
    const table = rawTable([...entries, ...tiny, ["x-stream-offset", "l", i64(BigInt(5))]]);
    const walked = walk(withHeaders(table));
    const kept = walked.header.properties.headers as readonly FieldEntry[];
    const markers = kept.filter((entry) => entry.value.tag === "omitted");
    expect(kept.slice(0, 5).every((entry) => entry.value.tag === "S")).toBe(true);
    expect(markers.length).toBeGreaterThan(0);
    expect(kept.at(-1)).toEqual({ name: name("x-stream-offset"), value: { tag: "l", value: BigInt(5) } });
    const omitted = walked.header.properties.headersOmitted;
    expect(omitted?.entries).toBeGreaterThan(30_000);
    expect(kept.length + (omitted?.entries ?? 0)).toBe(8 + 40_000 + 1);
    expect(walked.header.retainedBytes).toBeLessThanOrEqual(
      RABBITMQ_HEADER_TABLE_RETAINED_BYTES + 2 * (255 + ENTRY_OVERHEAD_BYTES + 8),
    );
  });

  test("past the table limit only the first x-stream-offset entry is kept; its repeats are counted, not kept", () => {
    const items = Array.from({ length: 20_000 }, () => ["V", new Uint8Array(0)] as const);
    const repeats = Array.from(
      { length: 1_000 },
      (_, index) => ["x-stream-offset", "l", i64(BigInt(index + 1))] as const,
    );
    const table = rawTable([["spent", "A", rawArray(items)], ...repeats]);
    const walked = walk(withHeaders(table));
    const kept = walked.header.properties.headers as readonly FieldEntry[];
    const offsets = kept.filter((entry) => text(entry.name) === "x-stream-offset");
    expect(offsets).toEqual([{ name: name("x-stream-offset"), value: { tag: "l", value: BigInt(1) } }]);
    expect(walked.offsets).toEqual([BigInt(1)]);
    expect(walked.header.properties.headersOmitted?.entries).toBeGreaterThanOrEqual(999);
    expect(walked.header.retainedBytes).toBeLessThanOrEqual(
      RABBITMQ_HEADER_TABLE_RETAINED_BYTES + 255 + ENTRY_OVERHEAD_BYTES + 8,
    );
  });

  test("a nested table that does not fit is one marker", () => {
    const table = rawTable([
      ["n", "F", rawTable([["s", "S", longstr(new Uint8Array(RABBITMQ_HEADER_VALUE_RETAINED_BYTES))]])],
    ]);
    const value = walk(withHeaders(table)).header.properties.headers?.[0]?.value;
    expect(value?.tag).toBe("omitted");
  });
});

describe("properties and the frame's shape", () => {
  test("the 13 other properties decode in flag order, and the hooks see the body size first", () => {
    const properties = encodeProperties({
      contentType: name("application/json"),
      contentEncoding: name("gzip"),
      headers: [],
      deliveryMode: 2,
      priority: 9,
      correlationId: name("c"),
      replyTo: name("r"),
      expiration: name("60000"),
      messageId: name("m"),
      timestamp: BigInt(1_760_000_000),
      type: name("amqp-1.0"),
      userId: name("u"),
      appId: name("a"),
      clusterId: name("k"),
    });
    const walked = walk(header(BigInt(42), properties));
    expect(walked.bodySizes).toEqual([BigInt(42)]);
    expect(walked.header.bodySize).toBe(BigInt(42));
    const p = walked.header.properties;
    expect(
      [p.contentType, p.contentEncoding, p.correlationId, p.replyTo, p.expiration, p.messageId].map((b) =>
        text(b as Uint8Array),
      ),
    ).toEqual(["application/json", "gzip", "c", "r", "60000", "m"]);
    expect([p.type, p.userId, p.appId, p.clusterId].map((b) => text(b as Uint8Array))).toEqual([
      "amqp-1.0",
      "u",
      "a",
      "k",
    ]);
    expect([p.deliveryMode, p.priority, p.timestamp]).toEqual([2, 9, BigInt(1_760_000_000)]);
    expect(p.headers).toEqual([]);
  });

  test("a header with no properties is empty, and the body-size hook can refuse", () => {
    expect(walk(header(BigInt(0), u16(0))).header.properties).toEqual({});
    expect(violationOf(() => walk(header(BigInt(2) ** BigInt(40), u16(0)), BigInt(512)))).toMatchObject({
      fact: "body-ceiling",
    });
  });

  test("malformed shapes are a protocol violation with 501", () => {
    const shapes = [
      bytesOf(u16(50), u16(0), u64(BigInt(0)), u16(0)),
      header(BigInt(0), u16(1)),
      header(BigInt(0), u16(2)),
      bytesOf(header(BigInt(0), u16(0)), 0),
      header(BigInt(0), bytesOf(u16(1 << 13), u32(100))),
      header(BigInt(0), bytesOf(u16(1 << 13), rawTable([["k", "S", u32(50)]]))),
      header(BigInt(0), bytesOf(u16(1 << 13), rawTable([["k", "F", u32(50)]]))),
      header(BigInt(0), bytesOf(u16(1 << 15), 9, "abc")),
    ];
    for (const shape of shapes) {
      expect(violationOf(() => walk(shape))).toMatchObject({ fact: "malformed-frame", replyCode: 501 });
    }
  });
});
