/**
 * A scripted broker for the agent read's tests: the bytes a broker would write, played back over the session's own
 * transport seam, and every packet the session writes recorded. Nothing is dialled and no address is resolved.
 *
 * THE PUBLISH BYTES HERE ARE THE BROKER'S, NOT THE PROVIDER'S: a test has to play the broker, and the provider has no
 * code that writes one, which `encoder.test.ts` holds from two sides.
 */
import { dialAndRead, SparkplugProvider, type SparkplugReader } from "@/lib/db/providers/industrial/sparkplug/index";
import type { Transport, TransportFactory } from "@/lib/db/providers/industrial/sparkplug/session";
import type { ProviderExecutionContext } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

export function varint(value: number): number[] {
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

export const CONNACK = [0x20, 0x03, 0x00, 0x00, 0x00];

/** A QoS 0 PUBLISH as a broker writes it, MQTT 5.0, with an empty property block. */
export function publish(topic: string, payload: readonly number[]): number[] {
  const topicBytes = [...new TextEncoder().encode(topic)];
  const body = [(topicBytes.length >> 8) & 0xff, topicBytes.length & 0xff, ...topicBytes, 0x00, ...payload];
  return [0x30, ...varint(body.length), ...body];
}

const INT64 = 4;

/** One Sparkplug B Metric field of a Payload: a name, an alias, the Int64 datatype and a value. */
export function metric(name: string, value: number): number[] {
  const nameBytes = [...new TextEncoder().encode(name)];
  const body = [0x0a, ...varint(nameBytes.length), ...nameBytes, 0x20, ...varint(INT64), 0x58, ...varint(value)];
  return [0x12, ...varint(body.length), ...body];
}

/** A Payload with a timestamp, a seq and the given metrics. */
export function payload(...metrics: number[][]): number[] {
  return [0x08, ...varint(1_000), 0x18, ...varint(0), ...metrics.flat()];
}

/** Bytes the Sparkplug decoder refuses: field 31 with wire type 7, which protobuf does not define. */
export const UNDECODABLE = [0xff, 0x01];

/** A broker that answers the ready event with `script`, then closes, and records what was written to it. */
export function scripted(script: readonly number[]): { factory: TransportFactory; written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  const handlers = new Map<string, ((value?: unknown) => void)[]>();
  const add = (event: string, handler: unknown) => {
    const list = handlers.get(event) ?? [];
    list.push(handler as (value?: unknown) => void);
    handlers.set(event, list);
  };
  const transport: Transport = {
    write(bytes) {
      written.push(Uint8Array.from(bytes));
    },
    on: (event, handler) => add(event, handler),
    once: (event, handler) => {
      add(event, handler);
      queueMicrotask(() => {
        for (const one of handlers.get(event) ?? []) one();
        const chunk = Buffer.from(Uint8Array.from(script));
        for (const one of handlers.get("data") ?? []) one(chunk);
        for (const one of handlers.get("close") ?? []) one();
      });
    },
    destroy() {},
  };
  return { factory: () => ({ transport, readyEvent: "connect" }), written };
}

/** The topic filters of every SUBSCRIBE in `written`, read from the packet bytes. */
export function subscribedFilters(written: readonly Uint8Array[]): string[] {
  const filters: string[] = [];
  for (const packet of written.filter((one) => one[0] === 0x82)) {
    // Fixed header, a remaining length of one or more bytes, a packet id and the property length (0).
    let at = 1;
    while ((packet[at] as number) & 0x80) at++;
    at += 1 + 2 + 1;
    while (at < packet.length) {
      const length = ((packet[at] as number) << 8) | (packet[at + 1] as number);
      filters.push(new TextDecoder().decode(packet.subarray(at + 2, at + 2 + length)));
      at += 2 + length + 1;
    }
  }
  return filters;
}

export const AGENT_PROFILE: ProviderExecutionContext = { readOnly: true, sendsStatements: true };

export const BUDGET = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 } as const;

export function connection(over: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "plant",
    name: "plant",
    type: "sparkplug",
    host: "broker.example",
    port: 1883,
    database: "",
    ...over,
  } as DatabaseConnection;
}

/**
 * A provider whose reads are scripted: the connect's handshake answers CONNACK, and each later read answers the next
 * script of `reads`. Every read's written packets are kept in order, the connect's first.
 */
export function scriptedProvider(
  reads: readonly (readonly number[])[],
  execution: ProviderExecutionContext = AGENT_PROFILE,
  over: Partial<DatabaseConnection> = {},
): { provider: SparkplugProvider; sessions: Uint8Array[][]; requests: Parameters<SparkplugReader>[0][] } {
  const sessions: Uint8Array[][] = [];
  const requests: Parameters<SparkplugReader>[0][] = [];
  const queue = [CONNACK, ...reads];
  const reader: SparkplugReader = (request) => {
    requests.push(request);
    const { factory, written } = scripted(queue.shift() ?? CONNACK);
    sessions.push(written);
    return dialAndRead(request, factory);
  };
  return { provider: new SparkplugProvider(connection(over), {}, execution, reader), sessions, requests };
}
