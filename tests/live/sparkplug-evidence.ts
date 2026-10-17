/**
 * Captures what the fixture broker actually sends, so the integration test can replay it.
 *
 * It subscribes to the fixture's two filters as MQTT 5 - the version the provider connects
 * with, so the PUBLISH packets carry the shape the provider's parser meets - and records every
 * packet BYTE FOR BYTE. Nothing here decodes a payload: the capture is raw, which is what keeps
 * it independent of the code that will read it back. The publisher is independent for the same
 * reason (docker/sparkplug/README.md), so neither end of the fixture shares code with the
 * provider.
 *
 * Usage, with the fixture up (docker compose -f docker/sparkplug/compose-service.yml up -d):
 *
 *   bun tests/live/sparkplug-evidence.ts
 *   bun tests/live/sparkplug-evidence.ts --host 127.0.0.1 --port 1884 --seconds 8
 */
import { createConnection } from "node:net";
import { writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..");
const OUT = path.join(ROOT, "tests/fixtures/sparkplug/plant.json");

/** The two filters the provider subscribes to when its Group field is empty. */
const FILTERS = ["spBv1.0/#", "$sparkplug/certificates/spBv1.0/#"];

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

function varint(value: number): number[] {
  const out: number[] = [];
  let left = value;
  do {
    let digit = left % 128;
    left = Math.floor(left / 128);
    if (left > 0) digit |= 0x80;
    out.push(digit);
  } while (left > 0);
  return out;
}

function readVarint(bytes: Uint8Array, from: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = from;
  for (;;) {
    const digit = bytes[at++] as number;
    value |= (digit & 0x7f) << shift;
    if ((digit & 0x80) === 0) return { value, next: at };
    shift += 7;
  }
}

function string(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

const host = argument("host", "127.0.0.1");
const port = Number(argument("port", "1884"));
const seconds = Number(argument("seconds", "8"));

const socket = createConnection({ host, port }, () => {
  // MQTT 5 CONNECT: protocol level 5, clean start, no properties.
  const body = [...string("MQTT"), 0x05, 0x02, 0x00, 0x3c, 0x00, ...string("sparkplug-evidence")];
  socket.write(Uint8Array.from([0x10, ...varint(body.length), ...body]));
});

const packets: { topic: string; hex: string }[] = [];
let buffered = new Uint8Array(0);
let subscribed = false;

socket.on("data", (chunk: Buffer) => {
  const joined = new Uint8Array(buffered.length + chunk.length);
  joined.set(buffered);
  joined.set(chunk, buffered.length);
  buffered = joined;

  for (;;) {
    if (buffered.length < 2) return;
    const { value: remaining, next } = readVarint(buffered, 1);
    const total = next + remaining;
    if (buffered.length < total) return;
    const packet = buffered.slice(0, total);
    buffered = buffered.slice(total);
    const kind = (packet[0] as number) >> 4;

    if (kind === 2 && !subscribed) {
      subscribed = true;
      const body = [0x00, 0x01, 0x00, ...FILTERS.flatMap((filter) => [...string(filter), 0x00])];
      socket.write(Uint8Array.from([0x82, ...varint(body.length), ...body]));
      continue;
    }
    if (kind === 3) {
      const topicLength = ((packet[next] as number) << 8) | (packet[next + 1] as number);
      const topic = new TextDecoder().decode(packet.slice(next + 2, next + 2 + topicLength));
      packets.push({ topic, hex: Buffer.from(packet).toString("hex") });
    }
  }
});

socket.on("error", (error: Error) => {
  console.error(`the fixture broker is not answering on ${host}:${port}: ${error.message}`);
  process.exit(1);
});

setTimeout(() => {
  socket.destroy();
  // An empty capture is a fault, not a result: the one way this script fails quietly is by
  // writing a fixture with no packets in it, which would make every replay below pass on nothing.
  if (packets.length === 0) {
    console.error("the capture holds no packets, so the fixture published nothing or the subscribe was refused");
    process.exit(1);
  }
  const topics = [...new Set(packets.map((one) => one.topic))].sort();
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString().slice(0, 10),
        broker: "eclipse-mosquitto:2.0.22@sha256:199ea8ef2e35ec2b1b37e59cfd1dbae538ed4dfa4a2251a121a52215a6248a21",
        publisher: "docker/sparkplug/publisher.py",
        windowSeconds: seconds,
        topics,
        packets,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${packets.length} packets on ${topics.length} topics written to ${path.relative(ROOT, OUT)}`);
  for (const topic of topics)
    console.log(
      `  ${packets
        .filter((one) => one.topic === topic)
        .length.toString()
        .padStart(3)} ${topic}`,
    );
}, seconds * 1000);
