/**
 * What a read counts besides the topic tree, the handshake-only session, and the kind each session failure carries
 * (`docs/providers/mqtt.md` section 14): the figures and kinds agent mode answers and words its failures by.
 */
import { describe, expect, test } from "bun:test";
import { MqttSessionError, readTopics } from "@/lib/db/providers/keyvalue/mqtt/session";
import { fakeBroker } from "./fake-broker";

const OPTIONS = { host: "127.0.0.1", port: 1883, tls: false } as const;

describe("what a read counts", () => {
  test("messages, retained messages and payload bytes over the read, and each topic's QoS, count and last sighting", async () => {
    const broker = fakeBroker({
      messages: [
        { topic: "plant/a", payload: "12345" },
        { topic: "plant/b", payload: "xy", retain: false },
        { topic: "plant/a", payload: "123", retain: false },
      ],
      end: "disconnect",
    });
    const read = await readTopics({ ...OPTIONS, openTransport: broker.factory });
    expect(read.messages).toBe(3);
    expect(read.retainedMessages).toBe(1);
    expect(read.payloadBytes).toBe(10);
    const a = read.topics.get("plant/a");
    expect(a?.messages).toBe(2);
    expect(a?.retained).toBe(false);
    expect(a?.payloadBytes).toBe(3);
    expect(a?.qos).toBe(0);
    expect(typeof a?.lastSeenMs).toBe("number");
    expect(a?.lastSeenMs).toBeGreaterThanOrEqual(0);
    expect(a?.lastSeenMs).toBeLessThanOrEqual(read.elapsedMs);
    expect(read.topics.get("plant/b")?.messages).toBe(1);
  });

  test("a message the broker delivers at QoS 1 is recorded at 1, as the wire said", async () => {
    const broker = fakeBroker({ messages: [{ topic: "q/one", payload: "1", qos: 1 }], end: "disconnect" });
    const read = await readTopics({ ...OPTIONS, openTransport: broker.factory });
    expect(read.topics.get("q/one")?.qos).toBe(1);
  });
});

describe("the handshake-only session", () => {
  test("writes a CONNECT and a DISCONNECT and nothing else, and reads no topic", async () => {
    const broker = fakeBroker({ messages: [{ topic: "plant/a", payload: "1" }], end: "disconnect" });
    const read = await readTopics({ ...OPTIONS, openTransport: broker.factory, handshakeOnly: true });
    expect(read.endReason).toBe("handshake");
    expect(read.topics.size).toBe(0);
    expect(read.messages).toBe(0);
    expect(broker.connections).toHaveLength(1);
    expect(broker.connections[0]?.map((bytes) => (bytes[0] as number) >> 4)).toEqual([1, 14]);
  });

  test("a refused handshake still fails with the broker's reason code and its kind", async () => {
    const broker = fakeBroker({ connackCode: 0x86 });
    const error: unknown = await readTopics({ ...OPTIONS, openTransport: broker.factory, handshakeOnly: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MqttSessionError);
    expect((error as MqttSessionError).category).toBe("refused");
    expect((error as MqttSessionError).reasonCode).toBe(0x86);
  });
});

describe("the kind of a session failure", () => {
  test("a transport error is unreachable, and the editor's sentence is unchanged", async () => {
    const broker = fakeBroker({ transportError: "connect ECONNREFUSED 10.1.2.3:1883" });
    const error = (await readTopics({ ...OPTIONS, openTransport: broker.factory }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(MqttSessionError);
    expect((error as MqttSessionError).category).toBe("unreachable");
    expect(error.message).toBe("The broker could not be reached: connect ECONNREFUSED 10.1.2.3:1883");
  });

  test("a broker that hangs up before the handshake is a handshake failure", async () => {
    const broker = fakeBroker({ silent: true });
    const read = readTopics({ ...OPTIONS, openTransport: broker.factory, dialTimeoutMs: 20 });
    const error = (await read.catch((e: unknown) => e)) as MqttSessionError;
    expect(error.category).toBe("handshake");
  });

  test("a DISCONNECT before the CONNACK is a handshake failure with its code", async () => {
    // The CONNACK is replaced by a DISCONNECT with reason 0x9c (Use another server).
    const broker = fakeBroker({ silent: true });
    const factory: typeof broker.factory = (options) => {
      const opened = broker.factory(options);
      const write = opened.transport.write.bind(opened.transport);
      let data: ((chunk: Buffer) => void) | undefined;
      const transport = {
        ...opened.transport,
        on(event: string, handler: (value: never) => void) {
          if (event === "data") data = handler as (chunk: Buffer) => void;
          opened.transport.on(event as "data", handler as (chunk: Buffer) => void);
        },
        write(bytes: Buffer) {
          write(bytes);
          if ((bytes[0] as number) >> 4 === 1) setTimeout(() => data?.(Buffer.from([0xe0, 0x01, 0x9c])), 0);
        },
      };
      return { ...opened, transport };
    };
    const error = (await readTopics({ ...OPTIONS, openTransport: factory }).catch(
      (e: unknown) => e,
    )) as MqttSessionError;
    expect(error.category).toBe("handshake");
    expect(error.reasonCode).toBe(0x9c);
  });

  test("bytes that are not MQTT are a protocol failure", async () => {
    const broker = fakeBroker({ silent: true });
    const factory: typeof broker.factory = (options) => {
      const opened = broker.factory(options);
      let data: ((chunk: Buffer) => void) | undefined;
      return {
        ...opened,
        transport: {
          ...opened.transport,
          on(event: string, handler: (value: never) => void) {
            if (event === "data") data = handler as (chunk: Buffer) => void;
            opened.transport.on(event as "data", handler as (chunk: Buffer) => void);
          },
          write(bytes: Buffer) {
            opened.transport.write(bytes);
            setTimeout(() => data?.(Buffer.from([0x20, 0xff, 0xff, 0xff, 0xff, 0x01])), 0);
          },
        },
      };
    };
    const error = (await readTopics({ ...OPTIONS, openTransport: factory }).catch(
      (e: unknown) => e,
    )) as MqttSessionError;
    expect(error.category).toBe("protocol");
  });
});
