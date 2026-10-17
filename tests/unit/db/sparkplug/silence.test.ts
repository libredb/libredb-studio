import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";

import { ConnectionError } from "@/lib/db/errors";
import { SparkplugProvider } from "@/lib/db/providers/industrial/sparkplug";
import type { DatabaseConnection } from "@/lib/types";

/*
 * THE THREE SILENCES, AND WHY ONLY ONE OF THEM IS A SUCCESS.
 *
 * Measured against this provider before any of this existed: a port that accepts a TCP connection
 * and then says nothing came back as `200 success: true, "Connection successful", latency 0` after
 * the whole three-second window. Nothing had been read and nothing on the far side had answered,
 * and the panel reported a reached plant. The window ending is not a fact about the plant.
 *
 * What separates the three is the CONNACK, which is the only evidence that anything there speaks
 * MQTT at all. These three cases run against real sockets rather than the seam, because the seam
 * cannot produce the case: a reader that answers has already decided what the broker said.
 */

const CONNACK = [0x20, 0x03, 0x00, 0x00, 0x00];
const SUBACK = [0x90, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00];

function varint(n: number): number[] {
  const out: number[] = [];
  let value = n;
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return out;
}

function metric(name: string, alias: number, datatype: number, long: number): number[] {
  const encoded = [...new TextEncoder().encode(name)];
  const body = [0x0a, encoded.length, ...encoded, 0x18, ...varint(alias), 0x20, datatype, 0x70, ...varint(long)];
  return [0x12, ...varint(body.length), ...body];
}

function publish(topic: string, payload: number[]): number[] {
  const encoded = [...new TextEncoder().encode(topic)];
  const body = [(encoded.length >> 8) & 0xff, encoded.length & 0xff, ...encoded, 0x00, ...payload];
  return [0x30, ...varint(body.length), ...body];
}

/** One birth, which is the smallest thing a plant can say that counts as having spoken. */
const NBIRTH = publish("spBv1.0/Line1/NBIRTH/Press01", [0x18, ...varint(1), ...metric("Temperature", 11, 4, 42)]);

/** The packet kinds in one chunk, walked by remaining length so several in one read are all seen. */
function packetKinds(chunk: Buffer): number[] {
  const kinds: number[] = [];
  let at = 0;
  while (at < chunk.length) {
    const kind = chunk[at] & 0xf0;
    let length = 0;
    let shift = 0;
    let index = at + 1;
    for (;;) {
      const byte = chunk[index++] ?? 0;
      length += (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    kinds.push(kind);
    at = index + length;
  }
  return kinds;
}

let open: Server | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function readAgainst(answer: (socket: Socket) => void): Promise<{
  error: Error | undefined;
  warnings: readonly string[];
}> {
  const server = createServer(answer);
  open = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const provider = new SparkplugProvider({
    id: "c1",
    name: "plant",
    type: "sparkplug",
    host: "127.0.0.1",
    port,
    // One second rather than the default window: the case is the silence, not the waiting.
    database: JSON.stringify({ seconds: 1 }),
  } as DatabaseConnection);
  const error = await provider.connect().then(
    () => undefined,
    (caught: unknown) => caught as Error,
  );
  return { error, warnings: provider.connectWarnings().map((one) => one.message) };
}

const speaks = (withBirth: boolean) => (socket: Socket) => {
  socket.on("data", (raw) => {
    for (const kind of packetKinds(Buffer.from(raw))) {
      if (kind === 0x10) socket.write(Buffer.from(CONNACK));
      if (kind === 0x80) {
        socket.write(Buffer.from(SUBACK));
        if (withBirth) socket.write(Buffer.from(NBIRTH));
      }
    }
  });
};

describe("a socket that opened is not a broker that answered", () => {
  test("a port that accepts and then says nothing is a ConnectionError, not an empty read", async () => {
    const { error, warnings } = await readAgainst((socket) => socket.on("data", () => {}));
    expect(error).toBeInstanceOf(ConnectionError);
    // The sentence names what DID happen, because the dial-failed one would be wrong here: the
    // connection was accepted. And it names the two things a reader can act on.
    expect(error?.message).toContain("accepted a connection and then answered nothing");
    expect(error?.message).toContain("127.0.0.1:");
    expect(error?.message).toMatch(/MQTT port/);
    // A refusal carries no caution: the caution is for a connection that was made.
    expect(warnings).toEqual([]);
  }, 20_000);

  test("a broker that answers and then sends nothing SUCCEEDS, and says so with a caution", async () => {
    const { error, warnings } = await readAgainst(speaks(false));
    expect(error).toBeUndefined();
    expect(warnings).toHaveLength(1);
    // THE CAUTION IS ABOUT THE SILENCE AND NOT ABOUT THE PORT, which is the distinction the next
    // reader is most likely to narrow away: a real broker with an idle plant lands here too.
    expect(warnings[0]).toContain("accepted the connection and sent nothing");
    expect(warnings[0]).toContain("birth certificate");
    expect(warnings[0]).not.toContain("port");
  }, 20_000);

  test("a broker that sends a birth succeeds with NO caution, so the caution is not constant", async () => {
    const { error, warnings } = await readAgainst(speaks(true));
    expect(error).toBeUndefined();
    expect(warnings).toEqual([]);
  }, 20_000);
});
