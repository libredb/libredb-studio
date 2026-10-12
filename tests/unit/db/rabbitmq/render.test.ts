/**
 * One message to one row (R-S7): headers by wire tag, names as own properties, bytes that are not UTF-8 in the base64
 * form, the AMQP 1.0 rule decided by the body's sections and never by the type property alone, and a JSON payload
 * deeper than 64 levels shown as base64, never as text the results grid could read back as JSON.
 */
import { describe, expect, test } from "bun:test";
import type { FieldEntry, FieldValue } from "@/lib/db/providers/stream/rabbitmq/amqp/field-table";
import type { RawMessage } from "@/lib/db/providers/stream/rabbitmq/amqp/read-loop";
import {
  RABBITMQ_BODY_PREFIX_BYTES,
  RABBITMQ_CELL_CHARS,
  RABBITMQ_PAYLOAD_JSON_DEPTH,
} from "@/lib/db/providers/stream/rabbitmq/limits";
import {
  emptyTally,
  isAmqp10Body,
  nestsTooDeep,
  renderMessage,
  type RenderTally,
} from "@/lib/db/providers/stream/rabbitmq/render";

const utf8 = (text: string) => new TextEncoder().encode(text);
const bytes = (...values: number[]) => Uint8Array.from(values);
const entry = (name: string | Uint8Array, value: FieldValue): FieldEntry => ({
  name: typeof name === "string" ? utf8(name) : name,
  value,
});
const offsetHeader = (offset: bigint) => entry("x-stream-offset", { tag: "l", value: offset });

function message(overrides: Partial<RawMessage> = {}): RawMessage {
  const body = overrides.body ?? utf8("hello");
  return {
    offset: BigInt(7),
    exchange: utf8(""),
    routingKey: utf8("orders"),
    properties: { headers: [offsetHeader(BigInt(7))] },
    body,
    bodySize: overrides.bodySize ?? body.length,
    retainedHeaderBytes: 0,
    ...overrides,
  };
}

function render(overrides: Partial<RawMessage> = {}): { row: ReturnType<typeof renderMessage>; tally: RenderTally } {
  const tally = emptyTally();
  return { row: renderMessage(message(overrides), "orders", tally), tally };
}

const headers = (...entries: FieldEntry[]) => render({ properties: { headers: entries } });
const base64 = (data: Uint8Array, declared = data.length) =>
  `${Buffer.from(data).toString("base64")} (${declared} bytes)`;

describe("offset, timestamp, exchange and routing key", () => {
  test("the offset is a decimal string past 2^53", () => {
    expect(render({ offset: BigInt("9223372036854775807") }).row.offset).toBe("9223372036854775807");
  });

  test("timestamp: absent is null, 0 is 1970, and an instant no Date holds is its seconds, counted", () => {
    expect(render().row.timestamp).toBeNull();
    expect(render({ properties: { timestamp: BigInt(0) } }).row.timestamp).toBe("1970-01-01T00:00:00.000Z");
    expect(render({ properties: { timestamp: BigInt(1791707415) } }).row.timestamp).toBe("2026-10-11T08:30:15.000Z");
    const far = render({ properties: { timestamp: BigInt("9223372036854775807") } });
    expect(far.row.timestamp).toBe("9223372036854775807");
    expect(far.tally.timestampsOutOfRange).toBe(1);
  });

  test("exchange and routing key are text, the base64 form when not UTF-8, and an empty key shows the stream", () => {
    const row = render({ exchange: bytes(0xff, 0xfe), routingKey: utf8("eu.orders") }).row;
    expect(row.exchange).toBe(base64(bytes(0xff, 0xfe)));
    expect(row.routing_key).toBe("eu.orders");
    expect(render({ exchange: utf8("amq.topic"), routingKey: utf8("") }).row).toMatchObject({
      exchange: "amq.topic",
      routing_key: "orders",
    });
  });
});

describe("headers by wire tag", () => {
  test("every tag", () => {
    const table = headers(
      entry("S", { tag: "S", bytes: utf8("text") }),
      entry("S-binary", { tag: "S", bytes: bytes(0xc3) }),
      entry("x", { tag: "x", bytes: utf8("raw") }),
      entry("t", { tag: "t", value: true }),
      entry("b", { tag: "b", value: -8 }),
      entry("B", { tag: "B", value: 255 }),
      entry("s", { tag: "s", value: -300 }),
      entry("u", { tag: "u", value: 65535 }),
      entry("I", { tag: "I", value: -70000 }),
      entry("i", { tag: "i", value: 4294967295 }),
      entry("l", { tag: "l", value: BigInt("-9223372036854775808") }),
      entry("L", { tag: "L", value: BigInt("9223372036854775807") }),
      entry("f", { tag: "f", value: 1.5 }),
      entry("d-nan", { tag: "d", value: Number.NaN }),
      entry("d-inf", { tag: "d", value: Number.POSITIVE_INFINITY }),
      entry("f-ninf", { tag: "f", value: Number.NEGATIVE_INFINITY }),
      entry("D", { tag: "D", scale: 2, value: 12345 }),
      entry("D-negative", { tag: "D", scale: 3, value: -5 }),
      entry("D-whole", { tag: "D", scale: 0, value: 7 }),
      entry("T", { tag: "T", value: BigInt(0) }),
      entry("V", { tag: "V" }),
      entry("F", { tag: "F", entries: [entry("inner", { tag: "t", value: false })] }),
      entry("F-empty", { tag: "F", entries: [] }),
      entry("A", {
        tag: "A",
        items: [
          { tag: "i", value: 1 },
          { tag: "S", bytes: utf8("two") },
        ],
      }),
      entry("A-empty", { tag: "A", items: [] }),
      entry("omitted", { tag: "omitted", bytes: 300000 }),
      entry("deep", { tag: "too-deep", bytes: 42 }),
    );
    expect(table.row.headers).toEqual({
      S: "text",
      "S-binary": base64(bytes(0xc3)),
      x: base64(utf8("raw")),
      t: true,
      b: -8,
      B: 255,
      s: -300,
      u: 65535,
      I: -70000,
      i: 4294967295,
      l: "-9223372036854775808",
      L: "9223372036854775807",
      f: 1.5,
      "d-nan": "NaN",
      "d-inf": "Infinity",
      "f-ninf": "-Infinity",
      D: "123.45",
      "D-negative": "-0.005",
      "D-whole": "7",
      T: "1970-01-01T00:00:00.000Z",
      V: null,
      F: { inner: false },
      "F-empty": {},
      A: [1, "two"],
      "A-empty": [],
      omitted: "[value omitted: 300000 bytes]",
      deep: "[nested deeper than 8: 42 bytes]",
    });
  });

  test("names are own properties, a non-UTF-8 name is its base64 form, and a repeated name is an array in order", () => {
    const table = headers(
      entry("__proto__", { tag: "S", bytes: utf8("p") }),
      entry("constructor", { tag: "S", bytes: utf8("c") }),
      entry("", { tag: "S", bytes: utf8("empty") }),
      entry(bytes(0xff), { tag: "t", value: true }),
      entry("dup", { tag: "i", value: 1 }),
      entry("dup", { tag: "i", value: 2 }),
      entry("dup", { tag: "i", value: 3 }),
    ).row.headers;
    expect(Object.getPrototypeOf(table)).toBe(Object.prototype);
    expect(Object.hasOwn(table, "__proto__")).toBe(true);
    expect(table.__proto__).toBe("p");
    expect(Object.keys(table)).toEqual(["__proto__", "constructor", "", base64(bytes(0xff)), "dup"]);
    expect(Object.getOwnPropertyDescriptor(table, "constructor")?.value).toBe("c");
    expect(table.dup).toEqual([1, 2, 3]);
  });

  test("the broker's x-stream-offset is left out, and a header of another type under that name is shown", () => {
    expect(render().row.headers).toEqual({});
    expect(headers(entry("x-stream-offset", { tag: "S", bytes: utf8("spoof") })).row.headers).toEqual({
      "x-stream-offset": "spoof",
    });
  });

  test("the cell stops adding entries before 65,536 characters of compact JSON and counts one cut cell", () => {
    const big = "a".repeat(40000);
    const cell = headers(
      entry("one", { tag: "S", bytes: utf8(big) }),
      entry("two", { tag: "S", bytes: utf8(big) }),
      entry("three", { tag: "t", value: true }),
    );
    expect(cell.row.headers).toEqual({ one: big });
    expect(JSON.stringify(cell.row.headers).length).toBeLessThanOrEqual(RABBITMQ_CELL_CHARS);
    expect(cell.tally.cellsCut).toBe(1);
  });

  test("a timestamp in an entry the cut dropped is not counted; one in a kept entry is", () => {
    const far = { tag: "T", value: BigInt("9223372036854775807") } as const;
    // `{"kept":"9223372036854775807","one":"a...a"}` is 65,519 characters; the next entry adds 32 and is the one cut.
    const cell = headers(
      entry("kept", far),
      entry("one", { tag: "S", bytes: utf8("a".repeat(65480)) }),
      entry("dropped", far),
    );
    expect(JSON.stringify(cell.row.headers)).toHaveLength(65519);
    expect(Object.keys(cell.row.headers as object)).toEqual(["kept", "one"]);
    expect(cell.tally.timestampsOutOfRange).toBe(1);
    expect(cell.tally.cellsCut).toBe(1);
  });

  test("a repeated name counts its array brackets against the cell", () => {
    const value = "b".repeat(32750);
    const cell = headers(entry("r", { tag: "S", bytes: utf8(value) }), entry("r", { tag: "S", bytes: utf8(value) }));
    // 2 values of 32,752 characters, the name, the comma and the brackets come to 65,513.
    expect(cell.row.headers).toEqual({ r: [value, value] });
    expect(cell.tally.cellsCut).toBe(0);
  });
});

describe("properties", () => {
  test("the twelve other properties in snake_case, text or base64, numbers as numbers, absent ones omitted", () => {
    const row = render({
      properties: {
        contentType: utf8("application/json"),
        contentEncoding: utf8("gzip"),
        headers: [offsetHeader(BigInt(7))],
        deliveryMode: 2,
        priority: 9,
        correlationId: utf8("c-1"),
        replyTo: utf8("amq.rabbitmq.reply-to"),
        expiration: utf8("60000"),
        messageId: bytes(0xff, 0x00),
        timestamp: BigInt(1),
        type: utf8("order.created"),
        userId: utf8("publisher"),
        appId: utf8("shop"),
        clusterId: utf8("c"),
      },
    }).row;
    expect(row.properties).toEqual({
      content_type: "application/json",
      content_encoding: "gzip",
      delivery_mode: 2,
      priority: 9,
      correlation_id: "c-1",
      reply_to: "amq.rabbitmq.reply-to",
      expiration: "60000",
      message_id: base64(bytes(0xff, 0x00)),
      type: "order.created",
      user_id: "publisher",
      app_id: "shop",
      cluster_id: "c",
    });
    expect(render({ properties: {} }).row.properties).toEqual({});
  });

  test("content_type never chooses the decoder", () => {
    const row = render({ body: utf8('{"a":1}'), properties: { contentType: utf8("application/octet-stream") } }).row;
    expect(row.payload_encoding).toBe("json");
  });
});

describe("payload decoder chain", () => {
  test("a 0-byte body is empty text", () => {
    expect(render({ body: new Uint8Array(0) }).row).toMatchObject({
      payload: "",
      payload_encoding: "text",
      payload_bytes: 0,
    });
  });

  test("JSON: object, array after whitespace, integers past 2^53 kept as digit strings", () => {
    expect(render({ body: utf8('{"id":12345678901234567890,"n":1}') }).row).toMatchObject({
      payload: { id: "12345678901234567890", n: 1 },
      payload_encoding: "json",
    });
    expect(render({ body: utf8(' \n[1,"x"]') }).row).toMatchObject({ payload: [1, "x"], payload_encoding: "json" });
  });

  test("text that starts like JSON but does not parse stays text", () => {
    expect(render({ body: utf8("{not json") }).row).toMatchObject({ payload: "{not json", payload_encoding: "text" });
  });

  test("markup is data: shown as the text it is", () => {
    const markup = "<img src=x onerror=alert(1)>";
    expect(render({ body: utf8(markup) }).row).toMatchObject({ payload: markup, payload_encoding: "text" });
  });

  test("text longer than the cell is cut on a code point boundary and counted", () => {
    const smile = String.fromCodePoint(0x1f600);
    const text = `${"a".repeat(RABBITMQ_CELL_CHARS - 1)}${smile}tail`;
    const { row, tally } = render({ body: utf8(text) });
    expect(row.payload).toBe("a".repeat(RABBITMQ_CELL_CHARS - 1));
    expect(row.payload_encoding).toBe("text");
    expect(tally.cellsCut).toBe(1);
  });

  test("bytes that are not UTF-8 are base64 with the declared size; a long one is cut to the cell", () => {
    expect(render({ body: bytes(0xff, 0x00, 0x01) }).row).toMatchObject({
      payload: base64(bytes(0xff, 0x00, 0x01)),
      payload_encoding: "base64",
      payload_bytes: 3,
    });
    const binary = new Uint8Array(100000).fill(0xff);
    const { row, tally } = render({ body: binary });
    expect(String(row.payload).endsWith(" (100000 bytes)")).toBe(true);
    expect(String(row.payload).length).toBeLessThanOrEqual(RABBITMQ_CELL_CHARS);
    expect(tally.cellsCut).toBe(1);
  });

  describe("JSON nesting depth", () => {
    const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;

    test("depth 64 is json, depth 65 is base64 and counted", () => {
      expect(render({ body: utf8(nested(RABBITMQ_PAYLOAD_JSON_DEPTH)) }).row.payload_encoding).toBe("json");
      const deep = render({ body: utf8(nested(RABBITMQ_PAYLOAD_JSON_DEPTH + 1)) });
      expect(deep.row.payload_encoding).toBe("base64");
      expect(deep.tally.deepPayloads).toBe(1);
    });

    test("the 8,920-byte and the 262,144-byte [[[...]]] bodies are base64, never text", () => {
      for (const size of [8920, RABBITMQ_BODY_PREFIX_BYTES]) {
        const { row } = render({ body: utf8(nested(size / 2)) });
        expect(row.payload_encoding).toBe("base64");
        expect(row.payload_bytes).toBe(size);
      }
    });

    test("leading whitespace does not hide the depth", () => {
      expect(render({ body: utf8(`   ${nested(100)}`) }).row.payload_encoding).toBe("base64");
    });

    test("brackets inside strings are not counted, an escaped quote included", () => {
      const strings = `[${'"\\"]]]}}}",'.repeat(3)}"${"]}".repeat(2000)}",${nested(4460)}]`;
      expect(nestsTooDeep(strings)).toBe(true);
      expect(render({ body: utf8(strings) }).row.payload_encoding).toBe("base64");
      const shallow = `${"[".repeat(RABBITMQ_PAYLOAD_JSON_DEPTH)}"${"[".repeat(10000)}"${"]".repeat(RABBITMQ_PAYLOAD_JSON_DEPTH)}`;
      expect(nestsTooDeep(shallow)).toBe(false);
      expect(render({ body: utf8(shallow) }).row.payload_encoding).toBe("json");
    });
  });

  describe("a cut body, longer than the 262,144-byte prefix", () => {
    test("JSON text is judged on its prefix: text, never json, with the full size, counted", () => {
      const prefix = utf8(`{"k":"${"v".repeat(RABBITMQ_BODY_PREFIX_BYTES)}`).subarray(0, RABBITMQ_BODY_PREFIX_BYTES);
      const { row, tally } = render({ body: prefix, bodySize: 5 * 1024 * 1024 });
      expect(row.payload_encoding).toBe("text");
      expect(row.payload_bytes).toBe(5242880);
      expect(tally.cutBodies).toBe(1);
      expect(tally.cellsCut).toBe(1);
    });

    test("a prefix that ends inside a UTF-8 sequence drops the split sequence only", () => {
      const head = "a".repeat(RABBITMQ_BODY_PREFIX_BYTES - 3);
      const split = Uint8Array.from([...utf8(head), 0xe2, 0x82, 0xac].slice(0, RABBITMQ_BODY_PREFIX_BYTES - 1));
      const whole = Uint8Array.from([...utf8(head), 0xe2, 0x82, 0xac]);
      expect(render({ body: split, bodySize: RABBITMQ_BODY_PREFIX_BYTES + 1 }).row.payload_encoding).toBe("text");
      const kept = render({ body: whole, bodySize: RABBITMQ_BODY_PREFIX_BYTES + 1 }).row.payload as string;
      expect(kept.endsWith("a")).toBe(true);
      expect(kept.length).toBe(RABBITMQ_CELL_CHARS);
    });

    test("a cut body whose kept text nests deeper than 64 is base64, never text", () => {
      const deep = `${"[".repeat(32768)}${"]".repeat(32768)}`;
      const prefix = utf8(deep.padEnd(RABBITMQ_BODY_PREFIX_BYTES, " "));
      const { row, tally } = render({ body: prefix, bodySize: 300000 });
      expect(row.payload_encoding).toBe("base64");
      expect(String(row.payload).endsWith(" (300000 bytes)")).toBe(true);
      expect(tally.deepPayloads).toBe(1);
      expect(tally.cutBodies).toBe(1);
    });

    test("binary is base64 naming the declared size", () => {
      const { row, tally } = render({ body: new Uint8Array(RABBITMQ_BODY_PREFIX_BYTES).fill(0xff), bodySize: 600000 });
      expect(row.payload_encoding).toBe("base64");
      expect(String(row.payload).endsWith(" (600000 bytes)")).toBe(true);
      expect(tally.cutBodies).toBe(1);
    });

    test("an AMQP 1.0 body that was cut cannot parse completely, so it is not labelled", () => {
      const body = Uint8Array.from([0x00, 0x53, 0x77, 0xb1, 0x00, 0x04, 0x00, 0x00, ...new Uint8Array(300)]);
      const row = render({
        body,
        bodySize: RABBITMQ_BODY_PREFIX_BYTES + 1,
        properties: { type: utf8("amqp-1.0") },
      }).row;
      expect(row.payload_encoding).not.toBe("amqp-1.0");
    });
  });

  describe("the AMQP 1.0 rule", () => {
    const value = (...section: number[]) => [0x00, 0x53, 0x77, ...section];
    const sequence = (...section: number[]) => [0x00, 0x53, 0x76, ...section];
    const footer = [0x00, 0x53, 0x78, 0xc1, 0x01, 0x00];
    // RabbitMQ 4.2 and 4.3 write a section descriptor as a full ulong: 0x80 and eight bytes, the code in the last.
    const ulong = (code: number) => [0x00, 0x80, 0, 0, 0, 0, 0, 0, 0, code];
    const amqp1 = utf8("amqp-1.0");

    test.each([
      ["an amqp-value string", value(0xa1, 0x05, ...utf8("hello"))],
      ["an amqp-value map", value(0xc1, 0x03, 0x02, 0x40, 0x40)],
      ["an amqp-value with a footer", [...value(0x41), ...footer]],
      ["two amqp-sequence sections", [...sequence(0x45), ...sequence(0xc0, 0x02, 0x01, 0x41)]],
      ["an amqp-value of a described value", value(0x00, 0xa3, 0x01, 0x78, 0x50, 0x01)],
      ["a 4-byte sized binary", value(0xb0, 0x00, 0x00, 0x00, 0x02, 0x01, 0x02)],
      [
        "every fixed width",
        [
          ...sequence(0xd0, 0, 0, 0, 4, 0, 0, 0, 0),
          ...sequence(0x60, 1, 2),
          ...sequence(0x70, 1, 2, 3, 4),
          ...sequence(0x80, 1, 2, 3, 4, 5, 6, 7, 8),
          ...sequence(0x98, ...new Array(16).fill(0)),
        ],
      ],
      ["an amqp-value with a ulong descriptor", [...ulong(0x77), 0xa1, 0x05, ...utf8("hello")]],
      [
        "two amqp-sequence sections with ulong descriptors",
        [...ulong(0x76), 0x45, ...ulong(0x76), 0xc0, 0x02, 0x01, 0x41],
      ],
      ["an amqp-value with a ulong footer", [...value(0x41), ...ulong(0x78), 0xc1, 0x01, 0x00]],
      ["a ulong amqp-value with a smallulong footer", [...ulong(0x77), 0x41, ...footer]],
    ])("%s is labelled amqp-1.0 when type says so", (_, body) => {
      expect(isAmqp10Body(Uint8Array.from(body))).toBe(true);
      const { row, tally } = render({ body: Uint8Array.from(body), properties: { type: amqp1 } });
      expect(row.payload_encoding).toBe("amqp-1.0");
      expect(row.payload).toBe(base64(Uint8Array.from(body)));
      expect(tally.amqp10Bodies).toBe(1);
    });

    test.each([
      ["no section", []],
      ["a data section", [0x00, 0x53, 0x75, 0xa0, 0x01, 0x61]],
      ["a value after a value", [...value(0x41), ...value(0x41)]],
      ["a sequence after a value", [...value(0x41), ...sequence(0x45)]],
      ["a section after the footer", [...sequence(0x45), ...footer, ...sequence(0x45)]],
      ["a footer first", footer],
      ["a byte left over", [...value(0x41), 0x41]],
      ["a size past the end", value(0xa1, 0x09, 0x61)],
      ["a 4-byte size field cut short", value(0xb1, 0x00, 0x00)],
      ["a fixed width past the end", value(0x80, 0x01)],
      ["an unknown constructor", value(0x99)],
      ["a value missing", value()],
      ["a descriptor chain deeper than 4", value(0x00, 0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0x41, 0x41)],
      ["a described descriptor", value(0x00, 0x00, 0x41, 0x41)],
      ["a descriptor with no value", value(0x00, 0xa3, 0x05)],
      ["the descriptor's code is not a smallulong", [0x00, 0x52, 0x77, 0x41]],
      ["a header cut short", [0x00, 0x53]],
      ["a ulong descriptor with a non-zero high byte", [0x00, 0x80, 1, 0, 0, 0, 0, 0, 0, 0x77, 0x41]],
      ["a ulong descriptor with a non-zero middle byte", [0x00, 0x80, 0, 0, 0, 0, 0, 0, 1, 0x77, 0x41]],
      ["a ulong data section", [...ulong(0x75), 0xa0, 0x01, 0x61]],
      ["a ulong descriptor cut short", [0x00, 0x80, 0, 0, 0, 0, 0, 0, 0]],
      ["a ulong footer first", [...ulong(0x78), 0xc1, 0x01, 0x00]],
    ])("%s is not AMQP 1.0", (_, body) => {
      expect(isAmqp10Body(Uint8Array.from(body))).toBe(false);
    });

    test("the type property alone never labels a body, and the x-basic-type header never does", () => {
      expect(render({ body: utf8('{"a":1}'), properties: { type: amqp1 } }).row.payload_encoding).toBe("json");
      const spoof = render({
        body: Uint8Array.from(value(0x41)),
        properties: { headers: [entry("x-basic-type", { tag: "S", bytes: amqp1 })] },
      });
      expect(spoof.row.payload_encoding).not.toBe("amqp-1.0");
      expect(spoof.tally.amqp10Bodies).toBe(0);
    });
  });
});
