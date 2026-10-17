/**
 * End-to-end read over a REAL TCP socket, measured from BOTH ends.
 *
 * Not a mock and not the transport seam: a hand-written MQTT server listens on an ephemeral port,
 * records every byte the provider sent it, and answers with real CONNACK, SUBACK and PUBLISH frames.
 * The provider is built through the production factory, so the path under measurement is the one a
 * user gets.
 */
import { createServer } from "node:net";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseConnection } from "@/lib/types";

function varint(n: number): number[] {
  const out: number[] = [];
  let left = n;
  do {
    let d = left % 128;
    left = Math.floor(left / 128);
    if (left > 0) d |= 0x80;
    out.push(d);
  } while (left > 0);
  return out;
}
const str = (s: string) => {
  const b = [...new TextEncoder().encode(s)];
  return [(b.length >> 8) & 0xff, b.length & 0xff, ...b];
};
function metric(name: string, alias: number, datatype: number, long?: number): number[] {
  const body = [
    0x0a,
    ...varint(name.length),
    ...[...new TextEncoder().encode(name)],
    0x10,
    ...varint(alias),
    0x20,
    ...varint(datatype),
  ];
  if (long !== undefined) body.push(0x58, ...varint(long));
  return [0x12, ...varint(body.length), ...body];
}
function publish(topic: string, payload: number[]): number[] {
  const t = [...new TextEncoder().encode(topic)];
  const body = [(t.length >> 8) & 0xff, t.length & 0xff, ...t, 0x00, ...payload];
  return [0x30, ...varint(body.length), ...body];
}

const CONNACK = [0x20, 0x03, 0x00, 0x00, 0x00];
const SUBACK = [0x90, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00];
const INT64 = 4;
const NBIRTH = publish("spBv1.0/Line1/NBIRTH/Press01", [
  0x08,
  ...varint(1760000000000 % 128),
  ...metric("bdSeq", 0, INT64, 3),
  ...metric("Temperature", 11, INT64),
]);
const NDATA = publish("spBv1.0/Line1/NDATA/Press01", [0x18, ...varint(1), ...metric("", 11, INT64, 42)]);

/** Every packet type in one chunk, by walking the remaining-length of each (MQTT 5.0 1.5.5). */
function packetsIn(chunk: Buffer): number[] {
  const kinds: number[] = [];
  let at = 0;
  while (at < chunk.length) {
    const kind = chunk[at] & 0xf0;
    let shift = 0;
    let length = 0;
    let byte: number;
    let cursor = at + 1;
    do {
      byte = chunk[cursor++] ?? 0;
      length += (byte & 0x7f) << shift;
      shift += 7;
    } while ((byte & 0x80) !== 0 && cursor < chunk.length);
    kinds.push(kind);
    at = cursor + length;
  }
  return kinds;
}

const received: Buffer[] = [];
const server = createServer((socket) => {
  socket.on("data", (raw: Buffer | string) => {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    received.push(chunk);
    // ONE CHUNK CAN HOLD SEVERAL PACKETS, and the first version of this server read only the first
    // byte: the provider sends CONNECT and SUBSCRIBE together, so the SUBSCRIBE branch never fired
    // and the broker published nothing. The read then measured zero rows and the fault was in the
    // measuring apparatus. Every packet in the chunk is walked now.
    for (const kind of packetsIn(chunk)) {
      if (kind === 0x10) socket.write(Buffer.from(CONNACK));
      if (kind === 0x80) {
        socket.write(Buffer.from(SUBACK));
        socket.write(Buffer.from(NBIRTH));
        socket.write(Buffer.from(NDATA));
      }
    }
  });
  socket.on("error", () => {});
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const connection = {
  id: "e2e",
  name: "e2e",
  type: "sparkplug",
  host: "127.0.0.1",
  port,
  database: "Line1",
} as unknown as DatabaseConnection;

const began = Date.now();
const provider = await createDatabaseProvider(connection);
await provider.connect();
const result = await provider.query('{"seconds":1}');
const elapsed = Date.now() - began;

const bytes = Buffer.concat(received);
const names: Record<number, string> = {
  0x10: "CONNECT",
  0x80: "SUBSCRIBE",
  0xa0: "UNSUBSCRIBE",
  0xc0: "PINGREQ",
  0xe0: "DISCONNECT",
  0x30: "PUBLISH",
};
const kinds = received.flatMap((c) => packetsIn(c)).map((k) => names[k] ?? `0x${k.toString(16)}`);

console.log("=== WHAT THE BROKER SAW ===");
console.log(`  packets: ${kinds.join(", ")}`);
console.log(`  bytes in total: ${bytes.length}`);
console.log(`  protocol name inside CONNECT: ${bytes.includes(Buffer.from("MQTT")) ? "MQTT" : "absent"}`);
console.log(`  client id prefix inside CONNECT: ${bytes.includes(Buffer.from("libredb-")) ? "libredb-" : "absent"}`);
console.log(
  `  filter inside SUBSCRIBE: ${bytes.includes(Buffer.from("spBv1.0/Line1/#")) ? "spBv1.0/Line1/#" : "absent"}`,
);
console.log(`  did it PUBLISH: ${kinds.some((k) => k === "PUBLISH") ? "yes (it must not)" : "no"}`);

console.log("=== WHAT THE CALLER GOT ===");
console.log(`  rows: ${result.rows.length}`);
console.log(`  fields: ${Object.keys((result.rows[0] ?? {}) as Record<string, unknown>).join(", ")}`);
for (const row of result.rows.slice(0, 3)) console.log(`  ${JSON.stringify(row)}`);
console.log(`  took: ${elapsed} ms`);

await provider.disconnect();
server.close();
