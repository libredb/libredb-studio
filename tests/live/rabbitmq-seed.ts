/**
 * The RabbitMQ fixture's one seed entry point, run by the compose `rabbitmq-init` one-shot, by the CI step and by
 * hand, so every broker the live checks read holds the same content:
 *
 *   eval "$(bun tests/live/rabbitmq-seed.ts --env)"
 *   RABBITMQ_LIVE_DIGEST=sha256:... bun tests/live/rabbitmq-seed.ts
 *
 * The fixture's two passwords are built here at run time from parts (`fixturePasswords`), never written as one
 * literal: `--env` prints them as the two export lines the compose services and the live scripts read, and seeds
 * nothing. The seed itself takes both from the environment, so a run with other values (CI makes its own per run)
 * seeds with those.
 *
 * It creates the virtual hosts, users, permissions and topology through the management HTTP API as the admin, and
 * publishes over the network with the test-only publishers of `tests/helpers/`, so it needs neither Bun inside the
 * broker image nor the Docker socket.
 *
 * A stream publish appends, and every capture and expected outcome keys on an offset, so a second seed would move
 * them all: the seed refuses with a sentence when any fixture stream already exists, and the fixture is reset by
 * removing the broker container. Each benign message is published with its own confirm and each poison message
 * alone, so the chunk a message sits in is the same on every run.
 *
 * `RABBITMQ_SEED_TABLE` is the seed's content; `docs/providers/rabbitmq.md` prints it in its fixture section and
 * `tests/unit/db/rabbitmq/provider-doc.test.ts` holds the two equal. It is not in `bun run test`: the runner
 * excludes `tests/live/`.
 */
import { createHash } from "node:crypto";
import { patternBytes, patternSha256 } from "../helpers/rabbitmq-body-pattern";
import { AdminApi, liveTarget, type RabbitMQLiveTarget, segment } from "../helpers/rabbitmq-live";
import { Amqp10Sender, type Amqp10MessageInput, encodeValue, v } from "../helpers/rabbitmq-test-amqp10";
import {
  type TestBasicProperties,
  type TestFieldTable,
  type TestFieldValue,
  TestPublisher,
} from "../helpers/rabbitmq-test-amqp091";

export type SeedBody =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "hex"; readonly hex: string }
  | { readonly kind: "pattern"; readonly label: string; readonly size: number };

export type SeedMessage =
  | {
      readonly via: "amqp091";
      readonly exchange: string;
      readonly routingKey: string;
      readonly body: SeedBody;
      readonly properties?: TestBasicProperties;
      /** What the message is, as the provider doc's seed table prints it. */
      readonly note: string;
    }
  | { readonly via: "amqp10"; readonly message: Amqp10MessageInput; readonly note: string };

export interface SeedQueue {
  readonly vhost: string;
  readonly name: string;
  readonly type: "classic" | "quorum" | "stream";
  readonly arguments?: Readonly<Record<string, unknown>>;
  /** In publish order; a stream's offset is the message's index. */
  readonly messages: readonly SeedMessage[];
  /** The tests and captures that read it, for the provider doc's seed table. */
  readonly readBy: string;
  /** Whether `studio-reader`'s read pattern names it: every stream but `st-restricted`, no classic or quorum queue. */
  readonly readerMay: boolean;
}

export interface SeedExchange {
  readonly vhost: string;
  readonly name: string;
  readonly type: "direct" | "fanout" | "topic" | "headers";
  readonly internal?: boolean;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface SeedBinding {
  readonly vhost: string;
  readonly source: string;
  readonly destination: string;
  readonly destinationType: "q" | "e";
  readonly routingKey: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface SeedUser {
  readonly name: string;
  readonly tags: string;
  /** configure, write, read, the same on each vhost named. */
  readonly permissions: readonly [string, string, string] | "reader-pattern";
  readonly vhosts: readonly string[];
}

export const RABBITMQ_FIXTURE_VHOSTS = ["/", "billing"] as const;

const MIB = 1_048_576;
const encoder = new TextEncoder();
const json = (value: unknown): SeedBody => ({ kind: "text", text: JSON.stringify(value) });
const text = (value: string): SeedBody => ({ kind: "text", text: value });
const toDefault = (queue: string, body: SeedBody, note: string, properties?: TestBasicProperties): SeedMessage => ({
  via: "amqp091",
  exchange: "",
  routingKey: queue,
  body,
  properties,
  note,
});
const data = (value: string) => ({ kind: "data" as const, sections: [encoder.encode(value)] });
const uuidBytes = (fill: number): Uint8Array => new Uint8Array(16).fill(fill);

/** Every basic property and one header of each type a stream stores, as offset 12 of `st-orders` carries them. */
const ALL_PROPERTIES: TestBasicProperties = {
  contentType: "application/json",
  contentEncoding: "identity",
  deliveryMode: 2,
  priority: 5,
  correlationId: "corr-123",
  replyTo: "q-replies",
  expiration: "86400000",
  messageId: "msg-all-props-1",
  timestamp: BigInt(1760000000),
  type: "order.created",
  appId: "libredb-fixture-seed",
  headers: [
    ["h_string", { t: "S", v: "text" }],
    ["h_int8", { t: "b", v: -5 }],
    ["h_uint8", { t: "B", v: 250 }],
    ["h_int16", { t: "s", v: -300 }],
    ["h_uint16", { t: "u", v: 65000 }],
    ["h_int32", { t: "I", v: -70000 }],
    ["h_uint32", { t: "i", v: 4000000000 }],
    ["h_int64_above_2p53", { t: "l", v: BigInt("9007199254740993") }],
    ["h_float", { t: "f", v: 1.5 }],
    ["h_double", { t: "d", v: 2.25 }],
    ["h_bool", { t: "t", v: true }],
    ["h_timestamp", { t: "T", v: BigInt(1760000000) }],
    ["h_table", { t: "F", v: [["inner", { t: "S", v: "dropped by the stream" }]] }],
    ["h_array", { t: "A", v: [{ t: "I", v: 1 }] }],
    ["h_bytes", { t: "x", v: new Uint8Array([0x01, 0x02, 0x03]) }],
    ["h_void", { t: "V" }],
    ["h_invalid_utf8_bytes", { t: "x", v: new Uint8Array([0xff, 0xfe, 0xc3, 0x28]) }],
    ["h_html", { t: "S", v: "<img src=x onerror=alert(1)>" }],
  ],
};

function nested(depth: number): TestFieldValue {
  let value: TestFieldValue = { t: "S", v: "bottom" };
  for (let level = depth; level >= 1; level--) value = { t: "F", v: [[`level-${level}`, value]] };
  return value;
}

/** 4,000 keys: about 84 KB on the wire, under the 131,072-byte frame a publish must fit, and past the 65,536-character cell. */
function wide(): TestFieldTable {
  return Array.from(
    { length: 4000 },
    (_, index) => [`k${String(index).padStart(4, "0")}`, { t: "S", v: "wide-value" }] as const,
  );
}

const orders: SeedMessage[] = [
  ...[0, 1, 2, 3, 4].map((n) =>
    toDefault("st-orders", json({ orderId: n, item: "widget", qty: n + 1 }), `JSON order ${n}`, {
      contentType: "application/json",
    }),
  ),
  toDefault(
    "st-orders",
    { kind: "hex", hex: `89504e470d0a1a0a${Buffer.from(patternBytes("st-orders/5", 56)).toString("hex")}` },
    "PNG signature and 56 pattern bytes",
    { contentType: "application/octet-stream" },
  ),
  toDefault("st-orders", text(""), "empty body"),
  toDefault("st-orders", { kind: "pattern", label: "st-orders/7", size: MIB }, "1 MiB pattern body"),
  toDefault("st-orders", { kind: "pattern", label: "st-orders/8", size: 15 * MIB }, "15 MiB pattern body"),
  toDefault("st-orders", text("<script>alert(1)</script><b>x</b>"), "HTML", { contentType: "text/html" }),
  toDefault("st-orders", text("\u001b[31mred\u001b[0m and \u001b]0;title\u0007"), "terminal escapes", {
    contentType: "text/plain",
  }),
  toDefault("st-orders", { kind: "hex", hex: "fffec328a0a1" }, "invalid UTF-8"),
  toDefault("st-orders", json({ allProps: true }), "every basic property and typed headers", ALL_PROPERTIES),
];

/** The fixture's queues, streams first; the provider doc's seed table prints every row. */
export const RABBITMQ_SEED_TABLE: readonly SeedQueue[] = [
  {
    vhost: "/",
    name: "st-orders",
    type: "stream",
    messages: orders,
    readBy: "R-S7 offsets 9 to 12; the capture gate (0 to 6 and 9 to 12 whole, 7 and 8 as a prefix and a digest)",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-events",
    type: "stream",
    messages: Array.from({ length: 1000 }, (_, n) =>
      toDefault("st-events", json({ event: n, kind: n % 2 ? "odd" : "even" }), `JSON event ${n}`),
    ),
    readBy: "Read Last Chunk and the from forms",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-routes",
    type: "stream",
    messages: [
      toDefault("st-routes", text("default exchange"), "default exchange, timestamp 1760000000", {
        contentType: "text/plain",
        timestamp: BigInt(1760000000),
      }),
      {
        via: "amqp091",
        exchange: "ex-routes-direct",
        routingKey: "rk-a",
        body: text("named direct"),
        properties: { timestamp: BigInt(1760000001) },
        note: "ex-routes-direct, key rk-a",
      },
      {
        via: "amqp091",
        exchange: "ex-routes-topic",
        routingKey: "orders.eu.created",
        body: text("named topic"),
        properties: { timestamp: BigInt(1760000002) },
        note: "ex-routes-topic, key orders.eu.created",
      },
      {
        via: "amqp091",
        exchange: "ex-routes-direct",
        routingKey: "rk-x",
        body: text("carbon copy"),
        properties: { headers: [["CC", { t: "A", v: [{ t: "S", v: "rk-cc" }] }]] },
        note: "ex-routes-direct, key rk-x, header CC [rk-cc]",
      },
      toDefault("st-routes", text(""), "default exchange, empty body, no properties"),
      toDefault("st-routes", text("epoch"), "timestamp zero, 1970", { timestamp: BigInt(0) }),
      toDefault("st-routes", text("year 10000"), "timestamp 253402300800, the year 10000", {
        timestamp: BigInt(253402300800),
      }),
    ],
    readBy: "the exchange and routing_key columns",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-amqp10",
    type: "stream",
    messages: [
      {
        via: "amqp10",
        message: { body: { kind: "value", value: v.str("hello amqp-value") } },
        note: "amqp-value string",
      },
      {
        via: "amqp10",
        message: {
          body: {
            kind: "value",
            value: v.map(
              [v.str("a"), v.int(1)],
              [v.str("b"), v.str("x")],
              [v.str("c"), v.bool(true)],
              [v.str("d"), v.null()],
              [v.str("e"), v.double(1.5)],
              [v.str("f"), v.list(v.int(1), v.str("two"))],
              [v.str("g"), v.map([v.str("nested"), v.int(1)])],
            ),
          },
        },
        note: "amqp-value map",
      },
      {
        via: "amqp10",
        message: { body: { kind: "sequence", items: [v.int(1), v.str("a"), v.bool(false)] } },
        note: "amqp-sequence",
      },
      {
        via: "amqp10",
        message: { body: { kind: "data", sections: [encoder.encode("part1-"), encoder.encode("part2")] } },
        note: "two data sections",
      },
      {
        via: "amqp10",
        message: {
          applicationProperties: [
            ["p_string", v.str("ok")],
            ["p_ulong_max", v.ulong(BigInt("18446744073709551615"))],
            ["p_long_above_2p53", v.long(BigInt("9007199254740993"))],
            ["p_timestamp_ms", v.timestamp(BigInt(1760000000123))],
            ["p_binary", v.bin(new Uint8Array([0xff, 0xfe, 0x00]))],
            ["p_true", v.bool(true)],
            ["p_null", v.null()],
            ["p_double", v.double(2.5)],
          ],
          body: data("app-props"),
        },
        note: "typed application properties",
      },
      {
        via: "amqp10",
        message: { body: data("with-footer"), footer: [["x-footer-key", v.str("footer-value")]] },
        note: "data with a footer",
      },
      {
        via: "amqp10",
        message: {
          body: { kind: "value", value: v.str("value-with-footer") },
          footer: [["x-footer-key", v.str("footer-value")]],
        },
        note: "amqp-value with a footer",
      },
      { via: "amqp10", message: { body: { kind: "value", value: v.null() } }, note: "amqp-value null" },
      {
        via: "amqp10",
        message: { body: { kind: "data", sections: [new Uint8Array(0)] } },
        note: "one empty data section",
      },
    ],
    readBy: "R-S7 AMQP 1.0 bodies and the amqp-1.0 encoding",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-spoof",
    type: "stream",
    messages: [
      {
        via: "amqp091",
        exchange: "",
        routingKey: "st-spoof",
        body: { kind: "hex", hex: Buffer.from(encodeValue(v.described(0x77, v.str("spoof")))).toString("hex") },
        properties: { type: "amqp-1.0" },
        note: "0-9-1, type amqp-1.0, an encoded amqp-value body",
      },
      {
        via: "amqp10",
        message: { messageAnnotations: [["x-basic-type", v.str("amqp-1.0")]], body: data("plain data") },
        note: "AMQP 1.0 data, annotation x-basic-type amqp-1.0",
      },
      toDefault("st-spoof", text("control"), "0-9-1 control"),
    ],
    readBy: "R-S7: the spoof does not trigger the AMQP 1.0 label",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-uuid-key",
    type: "stream",
    messages: [
      {
        via: "amqp10",
        message: {
          messageAnnotations: [["x-map", v.map([v.uuid(uuidBytes(7)), v.str("uuid-key")])]],
          body: data("uuid key"),
        },
        note: "annotation x-map with a uuid key",
      },
    ],
    readBy: "R-S7: delivered with a 16-byte key on the pinned releases, without the entry on a fixed build",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-hostile-headers",
    type: "stream",
    messages: [
      toDefault("st-hostile-headers", text("prototype names"), "headers __proto__, constructor and an empty name", {
        headers: [
          ["__proto__", { t: "S", v: "p" }],
          ["constructor", { t: "S", v: "c" }],
          ["", { t: "S", v: "empty" }],
        ],
      }),
      toDefault("st-hostile-headers", text("deep"), "x-deep, a table nested 12 levels", {
        headers: [["x-deep", nested(12)]],
      }),
      toDefault("st-hostile-headers", text("wide"), "x-wide, a table of 4,000 keys", {
        headers: [["x-wide", { t: "F", v: wide() }]],
      }),
      toDefault("st-hostile-headers", text("<img src=x onerror=alert(1)>"), "markup in the body and a header", {
        headers: [["h_html", { t: "S", v: "<img src=x onerror=alert(1)>" }]],
      }),
    ],
    readBy: "R-S7 header depth, width and key names; the markup component case",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-buffer-shape",
    type: "stream",
    messages: [
      toDefault(
        "st-buffer-shape",
        json({ type: "Buffer", data: [1, 2, 3], note: "json" }),
        "a JSON object shaped like a Node Buffer",
        { contentType: "application/json" },
      ),
    ],
    readBy: "U119: how the results grid renders a JSON payload shaped like a Node Buffer",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-g2-poison-mid",
    type: "stream",
    messages: [
      { via: "amqp10", message: { applicationProperties: [["p", v.str("ok")]], body: data("good 0") }, note: "good" },
      { via: "amqp10", message: { applicationProperties: [["p", v.str("ok")]], body: data("good 1") }, note: "good" },
      {
        via: "amqp10",
        message: { applicationProperties: [["p_uuid", v.uuid(uuidBytes(1))]], body: data("poison uuid") },
        note: "poison: a uuid application property",
      },
      { via: "amqp10", message: { applicationProperties: [["p", v.str("ok")]], body: data("good 3") }, note: "good" },
    ],
    readBy: "R-S17, a numeric and a keyword start",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "g9-poison",
    type: "stream",
    messages: [
      ...[0, 1, 2, 3, 4].map((n) => toDefault("g9-poison", json({ n }), "good")),
      {
        via: "amqp10",
        message: { messageAnnotations: [["x-char", v.char(0x1f600)]], body: data("poison char") },
        note: "poison: annotation x-char, a char",
      },
      ...[6, 7, 8, 9].map((n) => toDefault("g9-poison", json({ n }), "good")),
    ],
    readBy: "R-S17, a poison between 0-9-1 messages",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "h1-props",
    type: "stream",
    messages: [
      { via: "amqp10", message: { body: data("ok 0") }, note: "good" },
      {
        via: "amqp10",
        message: { properties: { contentType: "t".repeat(300) }, body: data("long content type") },
        note: "poison: a content type of 300 bytes",
      },
      { via: "amqp10", message: { body: data("ok 2") }, note: "good" },
    ],
    readBy: "R-S17 offset 1",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "h3-solo",
    type: "stream",
    messages: [
      { via: "amqp10", message: { body: data("solo 0") }, note: "good, its own chunk" },
      { via: "amqp10", message: { body: data("solo 1") }, note: "good, its own chunk" },
      {
        via: "amqp10",
        message: { applicationProperties: [["p_uuid", v.uuid(uuidBytes(2))]], body: data("poison") },
        note: "poison: a uuid application property, its own chunk",
      },
      { via: "amqp10", message: { body: data("solo 3") }, note: "good, its own chunk" },
    ],
    readBy: "R-S17, one chunk per offset",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "h3-wide",
    type: "stream",
    messages: [
      ...Array.from({ length: 10 }, (_, n) =>
        toDefault("h3-wide", json({ n }), "good, x-wide of 4,000 keys", {
          headers: [["x-wide", { t: "F", v: wide() }]],
        }),
      ),
      {
        via: "amqp10",
        message: { applicationProperties: [["p_uuid", v.uuid(uuidBytes(3))]], body: data("poison") },
        note: "poison: a uuid application property",
      },
      ...Array.from({ length: 2 }, (_, n) =>
        toDefault("h3-wide", json({ n: n + 11 }), "good, x-wide of 4,000 keys", {
          headers: [["x-wide", { t: "F", v: wide() }]],
        }),
      ),
    ],
    readBy: "R-S17 with costly header tables",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-restricted",
    type: "stream",
    messages: [
      toDefault("st-restricted", json({ secret: false }), "JSON"),
      toDefault("st-restricted", json({ secret: false }), "JSON"),
    ],
    readBy: "the consume 403 as studio-reader, whose pattern does not name it",
    readerMay: false,
  },
  {
    vhost: "/",
    name: "st-invoices-0",
    type: "stream",
    messages: [0, 1, 2, 3].map(
      (n) =>
        ({
          via: "amqp091",
          exchange: "st-invoices",
          routingKey: "0",
          body: json({ invoice: n, partition: 0 }),
          note: "through the super stream exchange, key 0",
        }) as SeedMessage,
    ),
    readBy: "a super stream partition",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-invoices-1",
    type: "stream",
    messages: [0, 1, 2, 3].map(
      (n) =>
        ({
          via: "amqp091",
          exchange: "st-invoices",
          routingKey: "1",
          body: json({ invoice: n, partition: 1 }),
          note: "through the super stream exchange, key 1",
        }) as SeedMessage,
    ),
    readBy: "a super stream partition",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "st-invoices-2",
    type: "stream",
    messages: [0, 1, 2, 3].map(
      (n) =>
        ({
          via: "amqp091",
          exchange: "st-invoices",
          routingKey: "2",
          body: json({ invoice: n, partition: 2 }),
          note: "through the super stream exchange, key 2",
        }) as SeedMessage,
    ),
    readBy: "a super stream partition",
    readerMay: true,
  },
  {
    vhost: "billing",
    name: "st-billing-audit",
    type: "stream",
    messages: Array.from({ length: 10 }, (_, n) =>
      toDefault("st-billing-audit", json({ audit: n }), `JSON audit ${n}`),
    ),
    readBy: "a second virtual host",
    readerMay: true,
  },
  {
    vhost: "/",
    name: "q-classic-orders",
    type: "classic",
    messages: [0, 1, 2].map((n) => toDefault("q-classic-orders", json({ orderId: n }), "JSON")),
    readBy: "the queue detail; the R-S1 oracle",
    readerMay: false,
  },
  { vhost: "/", name: "q-classic-empty", type: "classic", messages: [], readBy: "an empty queue", readerMay: false },
  {
    vhost: "/",
    name: "q-classic-dead",
    type: "classic",
    messages: [],
    readBy: "the dead-letter target",
    readerMay: false,
  },
  {
    vhost: "/",
    name: "q-quorum-payments",
    type: "quorum",
    arguments: { "x-dead-letter-exchange": "dlx" },
    messages: [0, 1, 2].map((n) => toDefault("q-quorum-payments", json({ payment: n }), "JSON")),
    readBy: "a quorum queue with a dead-letter exchange",
    readerMay: false,
  },
  {
    vhost: "/",
    name: "q-quorum-nodlx",
    type: "quorum",
    messages: [0, 1, 2].map((n) => toDefault("q-quorum-nodlx", json({ n }), "JSON")),
    readBy: "a quorum queue",
    readerMay: false,
  },
  {
    vhost: "/",
    name: "q-canary",
    type: "classic",
    messages: [],
    readBy: "the R-S1 control take; the live check publishes its one message",
    readerMay: false,
  },
  {
    vhost: "billing",
    name: "q-billing-invoices",
    type: "classic",
    messages: [0, 1].map((n) => toDefault("q-billing-invoices", json({ invoice: n }), "JSON")),
    readBy: "a classic queue in billing",
    readerMay: false,
  },
  {
    vhost: "billing",
    name: "q-billing-ledger",
    type: "quorum",
    messages: [0, 1].map((n) => toDefault("q-billing-ledger", json({ entry: n }), "JSON")),
    readBy: "a quorum queue in billing",
    readerMay: false,
  },
];

export const RABBITMQ_SEED_EXCHANGES: readonly SeedExchange[] = [
  { vhost: "/", name: "dlx", type: "fanout" },
  { vhost: "/", name: "ex-direct", type: "direct" },
  { vhost: "/", name: "ex-fanout", type: "fanout" },
  { vhost: "/", name: "ex-topic", type: "topic" },
  { vhost: "/", name: "ex-headers", type: "headers" },
  { vhost: "/", name: "ex-internal", type: "direct", internal: true },
  { vhost: "/", name: "ex-with-ae", type: "direct", arguments: { "alternate-exchange": "ex-fanout" } },
  { vhost: "/", name: "ex-routes-direct", type: "direct" },
  { vhost: "/", name: "ex-routes-topic", type: "topic" },
  // A super stream is a direct exchange marked x-super-stream with one stream per partition, bound by partition
  // order; declared here as the stream plugin's own route declares it, so the seed needs no plugin.
  { vhost: "/", name: "st-invoices", type: "direct", arguments: { "x-super-stream": true } },
];

export const RABBITMQ_SEED_BINDINGS: readonly SeedBinding[] = [
  { vhost: "/", source: "dlx", destination: "q-classic-dead", destinationType: "q", routingKey: "" },
  { vhost: "/", source: "ex-direct", destination: "q-classic-orders", destinationType: "q", routingKey: "orders" },
  { vhost: "/", source: "ex-fanout", destination: "q-classic-empty", destinationType: "q", routingKey: "" },
  { vhost: "/", source: "ex-fanout", destination: "q-quorum-nodlx", destinationType: "q", routingKey: "" },
  {
    vhost: "/",
    source: "ex-topic",
    destination: "q-classic-orders",
    destinationType: "q",
    routingKey: "orders.*.created",
  },
  { vhost: "/", source: "ex-topic", destination: "ex-fanout", destinationType: "e", routingKey: "#" },
  {
    vhost: "/",
    source: "ex-headers",
    destination: "q-classic-empty",
    destinationType: "q",
    routingKey: "",
    arguments: { "x-match": "all", region: "eu", tier: "gold" },
  },
  { vhost: "/", source: "ex-routes-direct", destination: "st-routes", destinationType: "q", routingKey: "rk-a" },
  { vhost: "/", source: "ex-routes-direct", destination: "st-routes", destinationType: "q", routingKey: "rk-cc" },
  { vhost: "/", source: "ex-routes-topic", destination: "st-routes", destinationType: "q", routingKey: "orders.#" },
  ...[0, 1, 2].map(
    (order): SeedBinding => ({
      vhost: "/",
      source: "st-invoices",
      destination: `st-invoices-${order}`,
      destinationType: "q",
      routingKey: String(order),
      arguments: { "x-stream-partition-order": order },
    }),
  ),
];

/** Regex characters escaped, so a name in a permission pattern matches only itself. */
export const escapeForPattern = (name: string): string => name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/** `studio-reader`'s read pattern on one vhost: exactly the streams the table lets it read there, as the provider doc recommends. */
export function readerPattern(vhost: string): string {
  const names = RABBITMQ_SEED_TABLE.filter((q) => q.vhost === vhost && q.readerMay).map((q) =>
    escapeForPattern(q.name),
  );
  return names.length === 0 ? "^$" : `^(${names.join("|")})$`;
}

export const RABBITMQ_SEED_USERS: readonly SeedUser[] = [
  { name: "studio-reader", tags: "management", permissions: "reader-pattern", vhosts: ["/", "billing"] },
  { name: "studio-browse", tags: "management", permissions: ["^$", "^$", "^$"], vhosts: ["/", "billing"] },
  { name: "studio-wide-read", tags: "management", permissions: ["^$", "^$", ".*"], vhosts: ["/", "billing"] },
  { name: "studio-untagged", tags: "", permissions: ["^$", "^$", ".*"], vhosts: ["/"] },
];

export function bodyBytes(body: SeedBody): Uint8Array {
  if (body.kind === "text") return encoder.encode(body.text);
  if (body.kind === "hex") return new Uint8Array(Buffer.from(body.hex, "hex"));
  return patternBytes(body.label, body.size);
}

/** The SHA-256 of one 0-9-1 body, a pattern body's without building it. */
export function bodySha256(body: SeedBody): string {
  if (body.kind === "pattern") return patternSha256(body.label, body.size);
  return createHash("sha256").update(bodyBytes(body)).digest("hex");
}

/** A hash of the whole seed content; each capture's header carries it, so a capture names the seed it was taken from. */
export function seedHash(): string {
  const canonical = JSON.stringify(
    {
      queues: RABBITMQ_SEED_TABLE,
      exchanges: RABBITMQ_SEED_EXCHANGES,
      bindings: RABBITMQ_SEED_BINDINGS,
      users: RABBITMQ_SEED_USERS,
    },
    (_key, value) => {
      if (typeof value === "bigint") return `${value}n`;
      if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
      if (value && typeof value === "object" && "kind" in value && value.kind === "pattern")
        return { pattern: value.label, size: value.size, sha256: patternSha256(value.label, value.size) };
      return value;
    },
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/** A message's note in the seed table: AMQP 1.0 publishes are marked, so a reader knows which path made them. */
const noteOf = (message: SeedMessage): string =>
  message.via === "amqp10" ? `${message.note} (AMQP 1.0)` : message.note;

/**
 * The seed table as `docs/providers/rabbitmq.md` prints it between its seed-table markers, one row per queue:
 * consecutive messages whose notes differ only by a trailing number are one run, "0 to 999: JSON event".
 */
export function renderSeedTable(): string {
  const rows = RABBITMQ_SEED_TABLE.map((queue) => {
    const runs: string[] = [];
    let start = 0;
    const stem = (index: number) => noteOf(queue.messages[index]).replace(/ \d+$/, "");
    for (let index = 1; index <= queue.messages.length; index++) {
      if (index < queue.messages.length && stem(index) === stem(start)) continue;
      const range = index - 1 === start ? `${start}` : `${start} to ${index - 1}`;
      const notes = new Set(queue.messages.slice(start, index).map(noteOf));
      runs.push(`${range}: ${notes.size === 1 ? noteOf(queue.messages[start]) : stem(start)}`);
      start = index;
    }
    const content = queue.messages.length === 0 ? "empty" : runs.join("; ");
    return `| \`${queue.vhost}\` | \`${queue.name}\` | ${queue.type} | ${content} | ${queue.readBy} |`;
  });
  return ["| Vhost | Name | Type | Messages, by offset | Read by |", "|---|---|---|---|---|", ...rows].join("\n");
}

/** The stream and its vhost when one fixture stream already exists, else null. */
export async function existingFixtureStream(
  admin: AdminApi,
): Promise<{ readonly vhost: string; readonly name: string } | null> {
  for (const queue of RABBITMQ_SEED_TABLE.filter((q) => q.type === "stream")) {
    const answer = await admin.call(
      "GET",
      `/api/queues/${segment(queue.vhost)}/${segment(queue.name)}?columns=name`,
      undefined,
      [200, 404],
    );
    if (answer.status === 200) return { vhost: queue.vhost, name: queue.name };
  }
  return null;
}

/** Creates everything in the table on the broker `target` names, and publishes every message. */
export async function seed(target: RabbitMQLiveTarget): Promise<void> {
  const admin = new AdminApi(target);
  const existing = await existingFixtureStream(admin);
  if (existing) {
    throw new Error(
      `The RabbitMQ fixture is already seeded: stream "${existing.name}" exists in virtual host "${existing.vhost}". A stream publish appends, so a second seed would move every offset the captures key on; remove the broker container and start it again to seed it afresh.`,
    );
  }
  for (const vhost of RABBITMQ_FIXTURE_VHOSTS) {
    await admin.call("PUT", `/api/vhosts/${segment(vhost)}`, {});
    await admin.call("PUT", `/api/permissions/${segment(vhost)}/${segment(target.adminUser)}`, {
      configure: ".*",
      write: ".*",
      read: ".*",
    });
  }
  for (const user of RABBITMQ_SEED_USERS) {
    await admin.call("PUT", `/api/users/${segment(user.name)}`, { password: target.fixturePassword, tags: user.tags });
    for (const vhost of user.vhosts) {
      const [configure, write, read] =
        user.permissions === "reader-pattern" ? ["^$", "^$", readerPattern(vhost)] : user.permissions;
      await admin.call("PUT", `/api/permissions/${segment(vhost)}/${segment(user.name)}`, { configure, write, read });
    }
  }
  for (const exchange of RABBITMQ_SEED_EXCHANGES) {
    await admin.call("PUT", `/api/exchanges/${segment(exchange.vhost)}/${segment(exchange.name)}`, {
      type: exchange.type,
      durable: true,
      internal: exchange.internal ?? false,
      arguments: exchange.arguments ?? {},
    });
  }
  for (const queue of RABBITMQ_SEED_TABLE) {
    await admin.call("PUT", `/api/queues/${segment(queue.vhost)}/${segment(queue.name)}`, {
      durable: true,
      arguments: { "x-queue-type": queue.type, ...(queue.arguments ?? {}) },
    });
  }
  for (const binding of RABBITMQ_SEED_BINDINGS) {
    await admin.call(
      "POST",
      `/api/bindings/${segment(binding.vhost)}/e/${segment(binding.source)}/${binding.destinationType}/${segment(binding.destination)}`,
      { routing_key: binding.routingKey, arguments: binding.arguments ?? {} },
    );
  }
  for (const vhost of RABBITMQ_FIXTURE_VHOSTS) {
    const amqp = {
      host: target.host,
      port: target.amqpPort,
      vhost,
      username: target.adminUser,
      password: target.adminPassword,
    };
    const publisher = await TestPublisher.open(amqp);
    try {
      for (const queue of RABBITMQ_SEED_TABLE.filter((q) => q.vhost === vhost)) {
        for (const message of queue.messages) {
          if (message.via === "amqp091") {
            await publisher.publish(
              message.exchange,
              message.routingKey,
              bodyBytes(message.body),
              message.properties ?? {},
            );
          } else {
            const sender = await Amqp10Sender.open(amqp, queue.name);
            try {
              await sender.send(message.message);
            } finally {
              await sender.close();
            }
          }
        }
      }
    } finally {
      await publisher.close();
    }
  }
}

/** The administrator's password and the one the four Studio users share, built from parts on every call. */
export function fixturePasswords(): { readonly admin: string; readonly fixture: string } {
  return {
    admin: ["libredb", "rabbitmq", "admin", "fixture"].join("-"),
    fixture: ["libredb", "rabbitmq", "reader", "fixture"].join("-"),
  };
}

if (import.meta.main) {
  if (process.argv.slice(2).includes("--env")) {
    const { admin, fixture } = fixturePasswords();
    console.log(`export RABBITMQ_LIVE_ADMIN_PASSWORD=${admin}\nexport RABBITMQ_LIVE_FIXTURE_PASSWORD=${fixture}`);
  } else {
    const target = liveTarget();
    await seed(target);
    console.log(`seeded ${target.host}:${target.managementPort}; seed content sha256 ${seedHash()}`);
  }
}
