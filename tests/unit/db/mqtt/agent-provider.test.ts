/**
 * The MQTT agent path end to end through the provider (`docs/providers/mqtt.md` section 14): the profile check, the
 * closed table refused before the network, the full packets each read writes, the metadata-only answer with its window
 * and its completeness sentence, the budgets' edges, failures by kind, and every other surface of an agent-mode handle
 * answering its reason. A scripted broker sits behind the transport seam, so no socket is opened.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import {
  MQTT_AGENT_MIN_STATEMENT_MS,
  MQTT_COMPLETENESS,
  mqttAgentFailure,
  mqttAgentResult,
  runMqttAgentRead,
} from "@/lib/db/providers/keyvalue/mqtt/agent-read";
import { measureResultBytes } from "@/lib/db/providers/sql/read-only-budget";
import { MQTT_AGENT_SENTENCES } from "@/lib/db/providers/keyvalue/mqtt/agent-statement";
import { MQTT_AGENT_WITHHELD } from "@/lib/db/providers/keyvalue/mqtt/agent-surface";
import {
  MQTT_READ_BUDGET_BYTES,
  MQTT_READ_BUDGET_MESSAGES,
  MQTT_READ_BUDGET_MS,
} from "@/lib/db/providers/keyvalue/mqtt/constants";
import { MqttProvider } from "@/lib/db/providers/keyvalue/mqtt/index";
import { encodeString, encodeVariableByteInteger } from "@/lib/db/providers/keyvalue/mqtt/encoder";
import type { MqttReadOutcome } from "@/lib/db/providers/keyvalue/mqtt/session";
import { MetadataProjectionError } from "@/lib/db/redaction/metadata-only";
import type { ProviderExecutionContext, QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { type FakeBrokerScript, fakeBroker, packet, publishPacket, subscribeFilters } from "./fake-broker";

const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 10_000, maxResultRows: 100, maxResultBytes: 100_000 };
const PROFILE: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true };

/** Topics whose names stand for the people and devices behind them; none may reach an agent answer. */
const PEOPLE = [
  { topic: "homes/ayse-yilmaz/door", payload: "OPEN-SECRET-PAYLOAD" },
  { topic: "people/alice/heart-rate", payload: "71" },
  { topic: "factory/press-7/temp", payload: "21.5", retain: false },
] as const;

function connection(over: Partial<Record<string, unknown>> = {}): DatabaseConnection {
  return {
    id: "mqtt-agent",
    name: "lab",
    type: "mqtt",
    host: "127.0.0.1",
    port: 1883,
    // The connection's own discovery filter, which no agent read uses.
    database: "sensors/#",
    user: "agent-reader",
    password: "not-a-real-password",
    ...over,
  } as unknown as DatabaseConnection;
}

async function opened(script: FakeBrokerScript = { messages: PEOPLE, end: "disconnect" }, context = PROFILE) {
  const broker = fakeBroker(script);
  const provider = new MqttProvider(connection(), {}, context, broker.factory);
  await provider.connect();
  return { provider, broker };
}

const types = (packets: readonly Buffer[]) => packets.map((bytes) => (bytes[0] as number) >> 4);

/** Every word of the answer a model could read: rows, column names and warnings. */
const answerText = (result: QueryResult) => JSON.stringify({ f: result.fields, r: result.rows, w: result.warnings });

const expectNoWithheld = (text: string) => {
  for (const { topic, payload } of PEOPLE) {
    expect(text).not.toContain(topic);
    expect(text).not.toContain(payload);
  }
  for (const word of ["ayse", "alice", "press-7", "agent-reader", "not-a-real-password", "sensors"]) {
    expect(text).not.toContain(word);
  }
};

/** A CONNECT read field by field. */
function connectFields(bytes: Buffer) {
  let at = 1;
  while ((bytes[at] as number) & 0x80) at += 1;
  at += 1;
  const nameLength = bytes.readUInt16BE(at);
  const name = bytes.subarray(at + 2, at + 2 + nameLength).toString();
  at += 2 + nameLength;
  const version = bytes[at] as number;
  const flags = bytes[at + 1] as number;
  const keepAlive = bytes.readUInt16BE(at + 2);
  at += 4;
  const propertiesLength = bytes[at] as number;
  const properties = [...bytes.subarray(at + 1, at + 1 + propertiesLength)];
  at += 1 + propertiesLength;
  const strings: string[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt16BE(at);
    strings.push(bytes.subarray(at + 2, at + 2 + length).toString());
    at += 2 + length;
  }
  return { first: bytes[0], name, version, flags, keepAlive, properties, strings };
}

describe("the profile", () => {
  test("an editor handle refuses queryReadOnly before anything is sent", async () => {
    const { provider, broker } = await opened(undefined, {});
    const before = broker.connections.length;
    const error = await provider.queryReadOnly('{"read": "window"}', BUDGET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect((error as Error).message).toBe(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    expect(broker.connections).toHaveLength(before);
  });

  test("the operations profile, which sends no statement, refuses it too", async () => {
    const { provider } = await opened(undefined, OPERATIONS);
    await expect(provider.queryReadOnly('{"read": "window"}', BUDGET)).rejects.toThrow(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
  });

  test("an unconnected handle meets the connection check first", async () => {
    const provider = new MqttProvider(connection(), {}, PROFILE, fakeBroker().factory);
    await expect(provider.queryReadOnly('{"read": "window"}', BUDGET)).rejects.toThrow("not connected");
  });

  test("an invalid budget and an estimate are refused before anything is sent", async () => {
    const { provider, broker } = await opened();
    await expect(provider.queryReadOnly('{"read": "window"}', { ...BUDGET, maxResultRows: 0 })).rejects.toThrow(
      "maxResultRows",
    );
    await expect(provider.queryReadOnly('{"read": "window"}', BUDGET, "estimate-plan")).rejects.toThrow(
      "MQTT composes no estimating plan for the agent",
    );
    expect(broker.connections).toHaveLength(1);
  });
});

describe("connecting an agent-mode handle", () => {
  test("is a handshake that subscribes to nothing, with the connection's credentials", async () => {
    const { broker } = await opened();
    expect(broker.connections).toHaveLength(1);
    const [connect, disconnect] = broker.connections[0] as Buffer[];
    expect(types(broker.connections[0] as Buffer[])).toEqual([1, 14]);
    const fields = connectFields(connect as Buffer);
    // Clean Start, a user name and a password, and no Will: 0b1100_0010.
    expect(fields).toMatchObject({ first: 0x10, name: "MQTT", version: 5, flags: 0xc2, keepAlive: 60 });
    expect(fields.properties).toEqual([0x11, 0, 0, 0, 0]);
    expect(fields.strings[0]).toMatch(/^libredb-[0-9a-f]{16}$/);
    expect(fields.strings.slice(1)).toEqual(["agent-reader", "not-a-real-password"]);
    expect([...(disconnect as Buffer)]).toEqual([0xe0, 0x01, 0x00]);
  });

  test("a refused handshake fails the connection", async () => {
    const broker = fakeBroker({ connackCode: 0x86 });
    const provider = new MqttProvider(connection(), {}, PROFILE, broker.factory);
    await expect(provider.connect()).rejects.toThrow("the username or password is wrong");
  });
});

describe("the closed table, refused before the network", () => {
  test.each([
    ['{"read": "publish", "topic": "a"}', MQTT_AGENT_SENTENCES.notARead],
    ['{"read": "window", "will": {"topic": "a"}}', MQTT_AGENT_SENTENCES.keys],
    ['{"read": "topic", "topic": "plant/+/temp"}', MQTT_AGENT_SENTENCES.wildcard],
    ['{"read": "topic", "topic": "plant/#"}', MQTT_AGENT_SENTENCES.wildcard],
    ['{"read": "topic", "topic": "$share/g/plant/a"}', MQTT_AGENT_SENTENCES.dollar],
    ['{"read": "topic", "topic": "$SYS/broker/clients/connected"}', MQTT_AGENT_SENTENCES.dollar],
    ['{"read": "window", "filter": "plant/#"}', MQTT_AGENT_SENTENCES.keys],
    ['{"read": "topic", "topic": "a", "retainHandling": 2}', MQTT_AGENT_SENTENCES.keys],
    ["SUBSCRIBE #", MQTT_AGENT_SENTENCES.notObject],
  ])("%s", async (statement, message) => {
    const { provider, broker } = await opened();
    const error = await provider.queryReadOnly(statement, BUDGET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect((error as Error).message).toBe(message);
    // Only the connect handshake ever reached the broker.
    expect(broker.connections).toHaveLength(1);
  });

  test("a time budget that cannot hold a whole window is refused, at one millisecond under the least and not at it", async () => {
    const { provider, broker } = await opened();
    const short = { ...BUDGET, statementTimeoutMs: MQTT_AGENT_MIN_STATEMENT_MS - 1 };
    const error = await provider.queryReadOnly('{"read": "window"}', short).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect((error as Error).message).toBe(
      "Read-only execution exceeded the time budget: an MQTT agent read listens for a 3,000 ms window and needs at least 4,000 ms with the dial, and this read was given 3,999 ms. A window is never shortened, so nothing was sent.",
    );
    expect(broker.connections).toHaveLength(1);
    const admitted = await provider.queryReadOnly('{"read": "window"}', {
      ...BUDGET,
      statementTimeoutMs: MQTT_AGENT_MIN_STATEMENT_MS,
    });
    expect(admitted.rowCount).toBe(1);
    expect(broker.connections).toHaveLength(2);
  });
});

describe("the window read", () => {
  test("writes CONNECT, one SUBSCRIBE to # and DISCONNECT, and answers totals with no topic name", async () => {
    const { provider, broker } = await opened();
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    const written = broker.connections[1] as Buffer[];
    expect(types(written)).toEqual([1, 8, 14]);
    // SUBSCRIBE: flags 0b0010, packet id 1, no properties, the filter #, options QoS 0 and No Local, retain handling 0.
    expect([...(written[1] as Buffer)]).toEqual([0x82, 0x07, 0x00, 0x01, 0x00, 0x00, 0x01, 0x23, 0x04]);
    expect(subscribeFilters(written[1] as Buffer)).toEqual(["#"]);
    expect(connectFields(written[0] as Buffer).flags).toBe(0xc2);
    expect(result.fields).toEqual([
      "window_ms",
      "listened_ms",
      "stop_reason",
      "scope",
      "broker_reason_code",
      "topics_seen",
      "messages",
      "retained_messages",
      "payload_bytes",
      "messages_lost",
    ]);
    const [row] = result.rows;
    // The broker ended the window long before Studio's own clock did.
    expect(row?.window_ms as number).toBeLessThan(MQTT_READ_BUDGET_MS);
    expect(row?.listened_ms as number).toBeLessThanOrEqual(row?.window_ms as number);
    expect(row).toMatchObject({
      stop_reason: "server-disconnect",
      scope: "incomplete",
      broker_reason_code: null,
      topics_seen: 3,
      messages: 3,
      retained_messages: 2,
      payload_bytes: 19 + 2 + 4,
      messages_lost: 0,
    });
    expect(typeof row?.listened_ms).toBe("number");
    expect(result.warnings?.map((w) => w.message)).toEqual([
      expect.stringContaining(
        "Studio listened to every topic (the filter #, which never matches a topic under a $ root) for ",
      ),
      MQTT_COMPLETENESS,
    ]);
    expect(result.warnings?.[0]?.message).toContain(
      "stopped because the broker closed the connection before the window ended. It counted 3 messages on 3 distinct topics, 2 retained.",
    );
    expectNoWithheld(answerText(result));
  });

  test("a window that runs to its end says so, and its scope is never complete", async () => {
    const { provider } = await opened({ messages: PEOPLE, end: "wait" });
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    expect(result.rows[0]).toMatchObject({ stop_reason: "budget-time", scope: "unknown" });
    expect(result.rows[0]?.listened_ms as number).toBeGreaterThanOrEqual(MQTT_READ_BUDGET_MS - 50);
    expect(result.warnings?.[0]?.message).toContain("stopped because the window ended.");
  }, 10_000);

  test("one message on one topic is counted in the singular", async () => {
    const { provider } = await opened({ messages: [PEOPLE[0]], end: "disconnect" });
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    expect(result.warnings?.[0]?.message).toContain("It counted 1 message on 1 distinct topic, 1 retained.");
  });

  test("the time it listened is its subscription's own, never more than the window, however long the handshake took", async () => {
    // The window opens when the connection is ready, so a slow dial is not in it and a slow CONNACK takes its share.
    const { provider } = await opened({ messages: PEOPLE, end: "wait", readyDelayMs: 500, connackDelayMs: 700 });
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    const row = result.rows[0] as Record<string, unknown>;
    const listened = row.listened_ms as number;
    expect(row.stop_reason).toBe("budget-time");
    expect(row.window_ms as number).toBeGreaterThanOrEqual(MQTT_READ_BUDGET_MS);
    expect(row.window_ms as number).toBeLessThan(MQTT_READ_BUDGET_MS + 100);
    expect(listened).toBeLessThanOrEqual((row.window_ms as number) - 600);
    expect(listened).toBeGreaterThan(MQTT_READ_BUDGET_MS - 1_000);
    expect(result.warnings?.[0]?.message).toBe(
      `Studio listened to every topic (the filter #, which never matches a topic under a $ root) for ${listened.toLocaleString("en-US")} ms after subscribing, in a window that ran ${(row.window_ms as number).toLocaleString("en-US")} ms from when the connection was ready (Studio's window is 3,000 ms), and stopped because the window ended. It counted 3 messages on 3 distinct topics, 2 retained.`,
    );
  }, 10_000);

  test("a refused subscription answers its code and that nothing was read", async () => {
    const { provider } = await opened({ messages: PEOPLE, subackCode: 0x87 });
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    expect(result.rows[0]).toMatchObject({
      stop_reason: "subscription-refused",
      scope: "incomplete",
      broker_reason_code: 0x87,
      topics_seen: 0,
      messages: 0,
    });
    expect(result.warnings?.[0]?.message).toContain(
      "stopped because the broker refused the subscription with reason code 135 (0x87), so nothing was read.",
    );
    expect(result.warnings?.at(-1)?.message).toBe(MQTT_COMPLETENESS);
  });

  test("a loss the read proves is counted and never named", async () => {
    const broker = fakeBroker({ end: "disconnect" });
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
            // A PUBLISH with an empty topic name (a Topic Alias never offered), before the broker's own DISCONNECT.
            if ((bytes[0] as number) >> 4 === 8) {
              const body = Buffer.concat([Buffer.from(encodeString("")), Buffer.from([0x00]), Buffer.from("x")]);
              setTimeout(() => data?.(packet(3, 0, body)), 0);
            }
            opened.transport.write(bytes);
          },
        },
      };
    };
    const provider = new MqttProvider(connection(), {}, PROFILE, factory);
    await provider.connect();
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    expect(result.rows[0]).toMatchObject({ messages_lost: 1, scope: "incomplete" });
    expect(result.warnings?.map((w) => w.message)).toContain(
      "1 loss was proved in this window: a message over the inbound limit, or messages that arrived with no topic name. Their topics are not named to agent mode.",
    );
  });

  test("two reads are two fresh sessions, and the second holds nothing of the first", async () => {
    const broker = fakeBroker({ messages: PEOPLE, end: "disconnect" });
    const provider = new MqttProvider(connection(), {}, PROFILE, broker.factory);
    await provider.connect();
    const first = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    const second = await provider.queryReadOnly('{"read": "topic", "topic": "nobody/here"}', BUDGET);
    expect(first.rows[0]?.topics_seen).toBe(3);
    expect(second.rows[0]).toMatchObject({ seen: false, messages: 0 });
    expect(broker.connections).toHaveLength(3);
    for (const written of broker.connections.slice(1)) {
      const fields = connectFields(written[0] as Buffer);
      expect(fields.flags & 0x02).toBe(0x02);
      expect(fields.properties).toEqual([0x11, 0, 0, 0, 0]);
    }
    // Every session has its own client id.
    const ids = broker.connections.map((written) => connectFields(written[0] as Buffer).strings[0]);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("the topic read", () => {
  const ask = (topic: string) => JSON.stringify({ read: "topic", topic });

  test("subscribes to the exact topic and answers its metadata, never its payload or its name", async () => {
    const { provider, broker } = await opened();
    const result = await provider.queryReadOnly(ask("homes/ayse-yilmaz/door"), BUDGET);
    const written = broker.connections[1] as Buffer[];
    expect(types(written)).toEqual([1, 8, 14]);
    const filter = Buffer.from(encodeString("homes/ayse-yilmaz/door"));
    const body = Buffer.concat([Buffer.from([0x00, 0x01, 0x00]), filter, Buffer.from([0x04])]);
    expect(written[1]).toEqual(
      Buffer.concat([Buffer.from([0x82]), Buffer.from(encodeVariableByteInteger(body.length)), body]),
    );
    expect(result.fields).toEqual([
      "window_ms",
      "listened_ms",
      "stop_reason",
      "scope",
      "broker_reason_code",
      "seen",
      "messages",
      "retained",
      "delivered_qos",
      "payload_bytes",
      "last_seen_ms",
      "messages_lost",
    ]);
    expect(result.rows[0]).toMatchObject({
      seen: true,
      messages: 1,
      retained: true,
      delivered_qos: 0,
      payload_bytes: 19,
      messages_lost: 0,
    });
    expect(typeof result.rows[0]?.last_seen_ms).toBe("number");
    expect(result.warnings?.[0]?.message).toContain("Studio listened to the one topic the request named for ");
    expect(result.warnings?.[0]?.message).toContain("It counted 1 message on that topic.");
    expect(result.warnings?.at(-1)?.message).toBe(MQTT_COMPLETENESS);
    expectNoWithheld(answerText(result));
  });

  test("when a topic was last seen is counted from the subscription, as the time it listened is", async () => {
    const { provider } = await opened({ messages: PEOPLE, end: "wait", connackDelayMs: 700 });
    const result = await provider.queryReadOnly(ask("homes/ayse-yilmaz/door"), BUDGET);
    const row = result.rows[0] as Record<string, number>;
    // The retained message arrives right after the SUBACK, so it was seen at the start of the subscription.
    expect(row.last_seen_ms).toBeLessThan(100);
    expect(row.last_seen_ms).toBeLessThanOrEqual(row.listened_ms as number);
    expect(row.listened_ms).toBeLessThanOrEqual(MQTT_READ_BUDGET_MS - 600);
  }, 10_000);

  test("a topic not seen answers null figures, never 0 or false, and the may-still-exist sentence", async () => {
    const { provider } = await opened();
    const result = await provider.queryReadOnly(ask("homes/nobody/door"), BUDGET);
    expect(result.rows[0]).toMatchObject({
      seen: false,
      messages: 0,
      retained: null,
      delivered_qos: null,
      payload_bytes: null,
      last_seen_ms: null,
    });
    expect(result.warnings?.at(-1)?.message).toBe(MQTT_COMPLETENESS);
  });

  test("a hit and a miss differ only in the topic's own figures, so neither says anything of another topic", async () => {
    const { provider } = await opened();
    // The two clocks are the read's own timing, which differs by a millisecond between any two reads.
    const own = new Set([
      "window_ms",
      "listened_ms",
      "seen",
      "messages",
      "retained",
      "delivered_qos",
      "payload_bytes",
      "last_seen_ms",
    ]);
    const strip = (result: QueryResult) => ({
      fields: result.fields,
      rest: Object.fromEntries(Object.entries(result.rows[0] ?? {}).filter(([column]) => !own.has(column))),
      last: result.warnings?.at(-1),
    });
    const hit = await provider.queryReadOnly(ask("people/alice/heart-rate"), BUDGET);
    const miss = await provider.queryReadOnly(ask("people/alicf/heart-rate"), BUDGET);
    expect(strip(hit)).toEqual(strip(miss));
    expect(hit.warnings).toHaveLength(miss.warnings?.length ?? 0);
  });

  test("the editor's own discovery filter is never the agent's", async () => {
    const { provider, broker } = await opened();
    await provider.queryReadOnly('{"read": "window"}', BUDGET);
    await provider.queryReadOnly(ask("factory/press-7/temp"), BUDGET);
    const filters = broker.connections.slice(1).map((written) => subscribeFilters(written[1] as Buffer));
    expect(filters).toEqual([["#"], ["factory/press-7/temp"]]);
  });
});

describe("the budgets", () => {
  const outcome: MqttReadOutcome = {
    topics: new Map([
      ["people/alice/heart-rate", { retained: true, payloadBytes: 2, qos: 0, messages: 1, lastSeenMs: 4 }],
    ]),
    scope: "unknown",
    endReason: "budget-time",
    provenLoss: [],
    messages: 1,
    retainedMessages: 1,
    payloadBytes: 2,
    elapsedMs: 3001,
    subscribedAtMs: 2,
  };

  test("an answer of exactly the byte budget is returned, and one byte past it is refused", () => {
    const answer = { op: "window", outcome } as const;
    const full = mqttAgentResult(answer, BUDGET, "s", 1);
    const exact = measureResultBytes(full.rows);
    expect(mqttAgentResult(answer, { ...BUDGET, maxResultBytes: exact }, "s", 1).rowCount).toBe(1);
    expect(() => mqttAgentResult(answer, { ...BUDGET, maxResultBytes: exact - 1 }, "s", 1)).toThrow(
      `Read-only execution exceeded the byte budget: ${exact} bytes > ${exact - 1} allowed`,
    );
  });

  test("a window Studio's message budget ended is answered as that window, with its own counts", async () => {
    const one = Buffer.concat(
      Array.from({ length: MQTT_READ_BUDGET_MESSAGES }, (_, i) =>
        publishPacket({ topic: PEOPLE[i % 3]?.topic as string, payload: "x", retain: false }),
      ),
    );
    const { provider } = await opened({ bulk: [one], end: "wait" });
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    const row = result.rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      stop_reason: "budget-messages",
      scope: "unknown",
      topics_seen: 3,
      messages: MQTT_READ_BUDGET_MESSAGES,
      retained_messages: 0,
      payload_bytes: MQTT_READ_BUDGET_MESSAGES,
      messages_lost: 0,
    });
    expect(result.warnings?.map((w) => w.message)).toEqual([
      `Studio listened to every topic (the filter #, which never matches a topic under a $ root) for ${(row.listened_ms as number).toLocaleString("en-US")} ms after subscribing, in a window that ran ${(row.window_ms as number).toLocaleString("en-US")} ms from when the connection was ready (Studio's window is 3,000 ms), and stopped because Studio's message budget of 50,000 messages was reached before the window ended. It counted 50,000 messages on 3 distinct topics, 0 retained.`,
      MQTT_COMPLETENESS,
    ]);
    expectNoWithheld(answerText(result));
  });

  test("a window Studio's byte budget ended is answered as that window, with its own counts", async () => {
    // Five messages of 7 MiB, each under the inbound limit, cross the 32 MiB byte budget on the fifth.
    const size = 7 * 1024 * 1024;
    const big = publishPacket({ topic: "people/alice/heart-rate", payload: "y".repeat(size), retain: false });
    const { provider } = await opened({ bulk: [big, big, big, big, big], end: "wait" });
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    const row = result.rows[0] as Record<string, unknown>;
    expect(5 * big.length).toBeGreaterThanOrEqual(MQTT_READ_BUDGET_BYTES);
    expect(4 * big.length).toBeLessThan(MQTT_READ_BUDGET_BYTES);
    expect(row).toMatchObject({
      stop_reason: "budget-bytes",
      scope: "unknown",
      topics_seen: 1,
      messages: 5,
      payload_bytes: 5 * size,
      messages_lost: 0,
    });
    expect(result.warnings?.map((w) => w.message)).toEqual([
      `Studio listened to every topic (the filter #, which never matches a topic under a $ root) for ${(row.listened_ms as number).toLocaleString("en-US")} ms after subscribing, in a window that ran ${(row.window_ms as number).toLocaleString("en-US")} ms from when the connection was ready (Studio's window is 3,000 ms), and stopped because Studio's byte budget of 33,554,432 bytes was reached before the window ended. It counted 5 messages on 1 distinct topic, 0 retained.`,
      MQTT_COMPLETENESS,
    ]);
    expectNoWithheld(answerText(result));
  });

  test("a row budget of one holds every answer, which is always one row", async () => {
    const { provider } = await opened();
    const result = await provider.queryReadOnly('{"read": "window"}', { ...BUDGET, maxResultRows: 1 });
    expect(result.rowCount).toBe(1);
  });
});

describe("failures by kind, never in the broker's or the transport's words", () => {
  test("a transport failure names no address", async () => {
    let calls = 0;
    const good = fakeBroker({ end: "disconnect" });
    const bad = fakeBroker({ transportError: "connect ECONNREFUSED 10.20.30.40:1883" });
    const provider = new MqttProvider(connection(), {}, PROFILE, (options) => {
      calls += 1;
      return calls === 1 ? good.factory(options) : bad.factory(options);
    });
    await provider.connect();
    const error = (await provider.queryReadOnly('{"read": "window"}', BUDGET).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(
      "The broker could not be reached for the read. The transport's and the broker's own words are not passed on to agent mode, since they can name an address.",
    );
  });

  test("a refused handshake keeps Studio's own sentence for the code, and no credential", async () => {
    let calls = 0;
    const good = fakeBroker({ end: "disconnect" });
    const bad = fakeBroker({ connackCode: 0x87 });
    const provider = new MqttProvider(connection(), {}, PROFILE, (options) => {
      calls += 1;
      return calls === 1 ? good.factory(options) : bad.factory(options);
    });
    await provider.connect();
    const error = (await provider.queryReadOnly('{"read": "window"}', BUDGET).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(
      "The broker refused the connection: this account is not authorized to connect (reason code 135, 0x87).",
    );
    expect(error.message).not.toContain("agent-reader");
  });

  test("a broker that never finishes the handshake", async () => {
    let calls = 0;
    const scripts: FakeBrokerScript[] = [{ end: "disconnect" }, { silent: true }];
    const provider = new MqttProvider(connection(), {}, PROFILE, (options) => {
      const script = scripts[Math.min(calls, scripts.length - 1)] as FakeBrokerScript;
      calls += 1;
      return fakeBroker(script).factory(options);
    });
    await provider.connect();
    const error = (await provider
      .queryReadOnly('{"read": "window"}', { ...BUDGET, statementTimeoutMs: MQTT_AGENT_MIN_STATEMENT_MS })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(
      "The broker did not complete the MQTT 5.0 handshake, so nothing was read. The transport's and the broker's own words are not passed on to agent mode, since they can name an address.",
    );
    expect(error.message).not.toContain("127.0.0.1");
  });

  test.each([
    // A length that is not a Variable Byte Integer: the inbound framing refuses it.
    ["a length that is not a Variable Byte Integer", Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x7f])],
    // A SUBACK with header flags MQTT 5.0 reserves: the decoder refuses it.
    ["a packet with reserved header flags", Buffer.from([0x9f, 0x03, 0x00, 0x01, 0x00])],
  ])("a broker that sends what is not MQTT after its CONNACK: %s", async (_name, bytes) => {
    let calls = 0;
    const provider = new MqttProvider(connection(), {}, PROFILE, (options) => {
      calls += 1;
      return fakeBroker(calls === 1 ? { end: "disconnect" } : { afterConnack: bytes, end: "wait" }).factory(options);
    });
    await provider.connect();
    const error = (await provider.queryReadOnly('{"read": "window"}', BUDGET).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "The broker's answer could not be read as MQTT 5.0, so the read was abandoned and nothing of it is answered. The transport's and the broker's own words are not passed on to agent mode, since they can name an address.",
    );
    expect(error.message).not.toContain("cannot read");
    expect(error.message).not.toContain("no longer MQTT");
  });

  test("an answer that is not metadata is refused in the projection's own words", () => {
    const projection = new MetadataProjectionError("messages", "count");
    const error = mqttAgentFailure(projection, 10_000, "s");
    expect(error).toBeInstanceOf(QueryError);
    expect(error?.message).toBe(projection.message);
  });

  test("the dial is given what the window leaves of the time budget, so a broker that never answers is unreachable in time", async () => {
    let calls = 0;
    const provider = new MqttProvider(connection(), {}, PROFILE, (options) => {
      calls += 1;
      return fakeBroker(calls === 1 ? { end: "disconnect" } : { neverReady: true }).factory(options);
    });
    await provider.connect();
    const started = Date.now();
    const error = (await provider
      .queryReadOnly('{"read": "window"}', { ...BUDGET, statementTimeoutMs: MQTT_AGENT_MIN_STATEMENT_MS })
      .catch((e: unknown) => e)) as Error;
    // The least budget leaves the dial 750 ms: the dial's own refusal, long before the read's deadline.
    expect(Date.now() - started).toBeLessThan(MQTT_AGENT_MIN_STATEMENT_MS - 1_000);
    expect(error.message).toBe(
      "The broker could not be reached for the read. The transport's and the broker's own words are not passed on to agent mode, since they can name an address.",
    );
  });

  test("a session that outlives the read's time budget is answered as the time budget", async () => {
    const never = () => new Promise<MqttReadOutcome>(() => undefined);
    const options = { host: "127.0.0.1", port: 1883, tls: false };
    const budget = { ...BUDGET, statementTimeoutMs: 30 };
    const pending = runMqttAgentRead(options, { op: "window" }, budget, never).catch((e: unknown) => e);
    const error = await pending;
    expect(mqttAgentFailure(error, 30)?.message).toBe(
      "Read-only execution exceeded the time budget: no answer within 30ms",
    );
  });
});

describe("every other surface of an agent-mode handle answers its reason", () => {
  test.each([
    ["getHealth", MQTT_AGENT_WITHHELD.health],
    ["getOverview", MQTT_AGENT_WITHHELD.overview],
    ["getPerformanceMetrics", MQTT_AGENT_WITHHELD.performance],
    ["getSlowQueries", MQTT_AGENT_WITHHELD.slowQueries],
    ["getActiveSessions", MQTT_AGENT_WITHHELD.sessions],
    ["getTableStats", MQTT_AGENT_WITHHELD.tableStats],
    ["getIndexStats", MQTT_AGENT_WITHHELD.indexStats],
    ["getStorageStats", MQTT_AGENT_WITHHELD.storage],
  ] as const)("%s, on either agent profile", async (method, sentence) => {
    for (const context of [PROFILE, OPERATIONS]) {
      const { provider, broker } = await opened(undefined, context);
      await expect((provider[method] as () => Promise<unknown>).call(provider)).rejects.toThrow(sentence);
      expect(broker.connections).toHaveLength(1);
    }
  });

  test("the Keys panel, a topic's listing, description and source, and the console are refused", async () => {
    const { provider, broker } = await opened();
    await expect(provider.scanKeysPage({ cursor: "0", count: 10 })).rejects.toThrow(MQTT_AGENT_WITHHELD.keys);
    await expect(provider.listObjects([], "topic")).rejects.toThrow(MQTT_AGENT_WITHHELD.topics);
    await expect(provider.describeObject(["plant/line1/temp"], "topic")).rejects.toThrow(MQTT_AGENT_WITHHELD.topics);
    await expect(provider.describeObjects([], "topic")).rejects.toThrow(MQTT_AGENT_WITHHELD.topics);
    await expect(provider.readObjectSource(["plant/line1/temp"], "topic")).rejects.toThrow(MQTT_AGENT_WITHHELD.source);
    const query = await provider.query("anything").catch((e: unknown) => e);
    expect(query).toBeInstanceOf(RefusedBeforeSendError);
    expect((query as Error).message).toBe(MQTT_AGENT_WITHHELD.query);
    // Nothing of them reached the broker: only the connect handshake did.
    expect(broker.connections).toHaveLength(1);
    // Kinds are counted as the editor counts them: none, since a broker publishes no count of its topics.
    expect(await provider.countObjects()).toEqual({});
    expect(await provider.listContainers()).toEqual([]);
  });

  test("an unconnected agent-mode handle meets the connection check, not a reason it was never asked", async () => {
    const provider = new MqttProvider(connection(), {}, PROFILE, fakeBroker().factory);
    await expect(provider.getHealth()).rejects.toThrow("not connected");
  });

  test("no withheld sentence names a topic, a payload or a credential", () => {
    expectNoWithheld(JSON.stringify(MQTT_AGENT_WITHHELD));
  });
});
