/**
 * A scripted MQTT 5.0 broker behind the provider's transport seam, for the agent path's tests.
 *
 * It answers what the provider writes, packet by packet: a CONNACK to a CONNECT, a SUBACK and then the matching
 * messages to a SUBSCRIBE, and it records every packet the provider wrote, whole, so a test pins the bytes rather than
 * a summary of them. `#` matches every topic that does not begin with `$` ([MQTT-4.7.2-1]); any other filter matches
 * only the topic it spells. No socket is opened.
 */
import { encodeString, encodeVariableByteInteger } from "@/lib/db/providers/keyvalue/mqtt/encoder";
import type { MqttTransport, MqttTransportFactory } from "@/lib/db/providers/keyvalue/mqtt/session";

export interface FakeMessage {
  readonly topic: string;
  readonly payload: string;
  readonly retain?: boolean;
  readonly qos?: number;
}

export interface FakeBrokerScript {
  /** Messages delivered right after the SUBACK, in order, to a subscription whose filter matches. */
  readonly messages?: readonly FakeMessage[];
  /** The CONNACK reason code. 0 accepts. */
  readonly connackCode?: number;
  /** The SUBACK reason code. 0 grants QoS 0. */
  readonly subackCode?: number;
  /** What the broker does after its messages: send DISCONNECT, close the transport, or wait for the budget. */
  readonly end?: "disconnect" | "close" | "wait";
  /** Fail the transport with this error as soon as it opens. */
  readonly transportError?: string;
  /** Accept the connection and never answer the CONNECT. */
  readonly silent?: boolean;
  /** Never open: the transport's ready event never fires, as a dropped SYN looks. */
  readonly neverReady?: boolean;
}

export interface FakeBroker {
  readonly factory: MqttTransportFactory;
  /** Every packet each connection wrote, in order, one buffer per write. */
  readonly connections: Buffer[][];
}

export function packet(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), Buffer.from(encodeVariableByteInteger(body.length)), body]);
}

export function publishPacket(message: FakeMessage): Buffer {
  const qos = message.qos ?? 0;
  const body = Buffer.concat([
    Buffer.from(encodeString(message.topic)),
    // A packet identifier is present only at QoS 1 and 2.
    qos > 0 ? Buffer.from([0x00, 0x01]) : Buffer.alloc(0),
    Buffer.from([0x00]),
    Buffer.from(message.payload, "utf8"),
  ]);
  return packet(3, (message.retain === false ? 0 : 1) | (qos << 1), body);
}

/** The topic filters of one SUBSCRIBE packet, read from its bytes. */
export function subscribeFilters(bytes: Buffer): string[] {
  let at = 1;
  while ((bytes[at] as number) & 0x80) at += 1;
  at += 1;
  at += 2; // packet identifier
  const propertiesLength = bytes[at] as number;
  at += 1 + propertiesLength;
  const filters: string[] = [];
  while (at < bytes.length) {
    const length = ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
    filters.push(bytes.subarray(at + 2, at + 2 + length).toString("utf8"));
    at += 2 + length + 1;
  }
  return filters;
}

const matches = (filter: string, topic: string): boolean =>
  filter === "#" ? !topic.startsWith("$") : filter === topic;

export function fakeBroker(script: FakeBrokerScript = {}): FakeBroker {
  const connections: Buffer[][] = [];
  const factory: MqttTransportFactory = () => {
    const written: Buffer[] = [];
    connections.push(written);
    const handlers = new Map<string, ((value: never) => void)[]>();
    let closed = false;
    const emit = (event: string, value?: unknown): void => {
      if (closed) return;
      for (const handler of handlers.get(event) ?? []) (handler as (v: unknown) => void)(value);
    };
    const later = (work: () => void): void => {
      setTimeout(work, 0);
    };
    const transport: MqttTransport = {
      write(bytes: Buffer): void {
        written.push(Buffer.from(bytes));
        const type = ((bytes[0] as number) >> 4) & 0x0f;
        if (type === 1 && script.silent !== true) {
          later(() => emit("data", Buffer.from([0x20, 0x03, 0x00, script.connackCode ?? 0, 0x00])));
        }
        if (type === 8) {
          const filters = subscribeFilters(bytes);
          later(() => {
            emit(
              "data",
              packet(9, 0, Buffer.from([bytes[2] as number, bytes[3] as number, 0x00, script.subackCode ?? 0])),
            );
            if ((script.subackCode ?? 0) >= 0x80) return;
            for (const message of script.messages ?? []) {
              if (filters.some((filter) => matches(filter, message.topic))) emit("data", publishPacket(message));
            }
            if (script.end === "disconnect") emit("data", packet(14, 0, Buffer.from([0x00])));
            if (script.end === "close") emit("close");
          });
        }
      },
      on(event: string, handler: (value: never) => void): void {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      once(event: string, handler: () => void): void {
        if (event !== "ready" || script.neverReady === true) return;
        later(() => {
          if (script.transportError !== undefined) {
            emit("error", new Error(script.transportError));
            return;
          }
          handler();
        });
      },
      destroy(): void {
        closed = true;
      },
    };
    return { transport, readyEvent: "ready" };
  };
  return { factory, connections };
}
