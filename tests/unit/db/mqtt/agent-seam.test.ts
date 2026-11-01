/**
 * The agent path can send no PUBLISH and no Will (`docs/providers/mqtt.md` sections 3.1, 3.2 and 14.1).
 *
 * The boundary is structural: the encoder has five packets and no PUBLISH, CONNECT takes no Will, and the valve
 * re-checks every outbound byte. This file pins it from the agent's side: every read the agent can send, and every
 * request it is refused, writes only CONNECT, SUBSCRIBE, PINGREQ and DISCONNECT with the Will bits clear; the agent's
 * modules write nothing themselves and reach the wire only through the session; and the valve refuses a PUBLISH and a
 * CONNECT carrying a Will before a byte reaches the transport.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MqttProvider } from "@/lib/db/providers/keyvalue/mqtt/index";
import { encodeString } from "@/lib/db/providers/keyvalue/mqtt/encoder";
import { type MqttTransport, writeToTransport } from "@/lib/db/providers/keyvalue/mqtt/session";
import type { DatabaseConnection } from "@/lib/types";
import { fakeBroker, packet } from "./fake-broker";

const BUDGET = { statementTimeoutMs: 10_000, maxResultRows: 100, maxResultBytes: 100_000 };
const MQTT_DIR = path.resolve(import.meta.dir, "../../../../src/lib/db/providers/keyvalue/mqtt");
const AGENT_MODULES = ["agent-read.ts", "agent-statement.ts", "agent-surface.ts"] as const;

const REQUESTS = [
  '{"read": "window"}',
  '{"read": "topic", "topic": "plant/a"}',
  '{"read": "topic", "topic": "nobody/here"}',
  '{"read": "publish", "topic": "plant/a"}',
  '{"read": "window", "will": {"topic": "plant/a", "payload": "x"}}',
  '{"read": "topic", "topic": "plant/#"}',
  '{"read": "topic", "topic": "$share/g/plant/a"}',
  '{"read": "topic", "topic": "plant/a", "qos": 2}',
];

describe("what the agent path writes", () => {
  test("every admitted and refused request writes only CONNECT, SUBSCRIBE and DISCONNECT, never a Will", async () => {
    const broker = fakeBroker({ messages: [{ topic: "plant/a", payload: "1" }], end: "disconnect" });
    const provider = new MqttProvider(
      { id: "s", name: "s", type: "mqtt", host: "127.0.0.1", port: 1883 } as unknown as DatabaseConnection,
      {},
      { readOnly: true, sendsStatements: true },
      broker.factory,
    );
    await provider.connect();
    for (const request of REQUESTS) await provider.queryReadOnly(request, BUDGET).catch(() => undefined);
    const written = broker.connections.flat();
    // The connect handshake, and one session per admitted read: three.
    expect(broker.connections).toHaveLength(4);
    expect(new Set(written.map((bytes) => (bytes[0] as number) >> 4))).toEqual(new Set([1, 8, 14]));
    for (const bytes of written.filter((b) => (b[0] as number) >> 4 === 1)) {
      // The connect flags byte follows the two-byte name length, "MQTT" and the version: Will, Will QoS and Will Retain
      // (bits 2 to 5) are clear.
      expect((bytes[9] as number) & 0x3c).toBe(0);
    }
  });

  test("the valve refuses a PUBLISH and a CONNECT with a Will before a byte reaches the transport", () => {
    const sent: Buffer[] = [];
    const transport = { write: (bytes: Buffer) => sent.push(bytes) } as unknown as MqttTransport;
    const publish = packet(3, 0, Buffer.concat([Buffer.from(encodeString("plant/a")), Buffer.from([0x00, 0x31])]));
    expect(() => writeToTransport(transport, publish)).toThrow("a packet of type 3 was refused");
    const body = Buffer.concat([Buffer.from(encodeString("MQTT")), Buffer.from([5, 0x06, 0, 60, 0])]);
    expect(() => writeToTransport(transport, packet(1, 0, body))).toThrow("a CONNECT carrying a Will was refused");
    expect(sent).toHaveLength(0);
  });
});

describe("the agent's modules", () => {
  test.each(AGENT_MODULES)("%s writes nothing itself and imports no encoder and no valve", (file) => {
    const source = readFileSync(path.join(MQTT_DIR, file), "utf8");
    expect(source).not.toContain(".write(");
    expect(source).not.toMatch(/from "\.\/(?:encoder|valve)"/);
    expect(source).not.toMatch(/from "mqtt-packet/);
  });

  test("the agent read reaches the wire only through the session's readTopics", () => {
    const source = readFileSync(path.join(MQTT_DIR, "agent-read.ts"), "utf8");
    const imported = /import \{([^}]*)\} from "\.\/session";/.exec(source)?.[1] ?? "";
    const values = imported
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "" && !name.startsWith("type "));
    expect(values.sort()).toEqual(["MqttSessionError", "readTopics"]);
  });
});
