/**
 * The agent's reader of one Kafka read request (`agent-statement.ts`): the closed table of four metadata reads, each
 * pinned to the plan the provider sends, and every request outside it refused before anything is sent, in agent mode's
 * own words with the list of reads.
 */
import { describe, expect, test } from "bun:test";
import {
  KAFKA_AGENT_DEFAULT_LIMIT,
  KAFKA_AGENT_MAX_LIMIT,
  KAFKA_AGENT_SENTENCES,
  readKafkaAgentStatement,
} from "@/lib/db/providers/stream/kafka/agent-statement";

const refused = (text: string) => {
  const reading = readKafkaAgentStatement(text);
  if (reading.ok) throw new Error(`expected a refusal of ${text}, got ${JSON.stringify(reading.plan)}`);
  return reading;
};

describe("the closed table of reads", () => {
  test("the topic listing, with its default limit and no cursor", () => {
    expect(readKafkaAgentStatement('{"read": "topics"}')).toEqual({
      ok: true,
      plan: { op: "topics", limit: KAFKA_AGENT_DEFAULT_LIMIT },
    });
    expect(readKafkaAgentStatement('{"read": "topics", "after": "orders", "limit": 7}')).toEqual({
      ok: true,
      plan: { op: "topics", after: "orders", limit: 7 },
    });
  });

  test("the broker listing, with a node-id cursor", () => {
    expect(readKafkaAgentStatement('{"read":"brokers"}')).toEqual({
      ok: true,
      plan: { op: "brokers", limit: KAFKA_AGENT_DEFAULT_LIMIT },
    });
    expect(readKafkaAgentStatement('{"read":"brokers","after":0,"limit":2}')).toEqual({
      ok: true,
      plan: { op: "brokers", after: 0, limit: 2 },
    });
  });

  test("one topic's partitions and one topic's offsets, with a partition cursor", () => {
    expect(readKafkaAgentStatement('{"read": "partitions", "topic": "orders"}')).toEqual({
      ok: true,
      plan: { op: "partitions", topic: "orders", limit: KAFKA_AGENT_DEFAULT_LIMIT },
    });
    expect(readKafkaAgentStatement('{"read": "offsets", "topic": "a.b_c-1", "after": 3, "limit": 500}')).toEqual({
      ok: true,
      plan: { op: "offsets", topic: "a.b_c-1", after: 3, limit: 500 },
    });
  });

  test("a request of four keys is the largest there is", () => {
    expect(KAFKA_AGENT_MAX_LIMIT).toBe(500);
    expect(refused('{"read": "offsets", "topic": "orders", "after": 1, "limit": 2, "from": "earliest"}').code).toBe(
      "request",
    );
  });
});

describe("refusals before anything is sent", () => {
  test("an empty request, and a request that is not one JSON object", () => {
    expect(refused("  \n")).toEqual({ ok: false, code: "request", message: KAFKA_AGENT_SENTENCES.empty });
    for (const text of ["topics", '["topics"]', "null", '"topics"', '{"read": "topics"} {"read": "brokers"}']) {
      expect(refused(text)).toEqual({ ok: false, code: "request", message: KAFKA_AGENT_SENTENCES.notObject });
    }
  });

  test("a read outside the table names the reads there are, never Fetch, a produce or an admin call", () => {
    for (const read of [
      "records",
      "fetch",
      "produce",
      "messages",
      "groups",
      "configs",
      "logdirs",
      "acls",
      "",
      1,
      null,
    ]) {
      expect(refused(JSON.stringify({ read, topic: "orders" }))).toEqual({
        ok: false,
        code: "metadata-only",
        message: KAFKA_AGENT_SENTENCES.notARead,
      });
    }
    expect(refused('{"topic": "orders"}')).toEqual({
      ok: false,
      code: "metadata-only",
      message: KAFKA_AGENT_SENTENCES.notARead,
    });
    expect(KAFKA_AGENT_SENTENCES.notARead).toContain(
      "a record's key, value, headers and timestamp, consumer groups, configs and log directories are withheld",
    );
  });

  test("a key outside the four, a timestamp, a sentinel or an auto-create flag above all, is refused", () => {
    for (const extra of [
      '"from": "earliest"',
      '"timestamp": "2026-10-31T00:00:00Z"',
      '"time": -3',
      '"allowAutoTopicCreation": false',
      '"partition": 0',
      '"isolationLevel": 0',
      '"group": "g"',
      '"key": "k"',
    ]) {
      expect(refused(`{"read": "offsets", "topic": "orders", ${extra}}`)).toEqual({
        ok: false,
        code: "request",
        message: KAFKA_AGENT_SENTENCES.keys,
      });
    }
  });

  test("a key written twice is refused, whichever value JSON.parse would keep", () => {
    expect(refused('{"read": "topics", "read": "offsets", "topic": "orders"}')).toEqual({
      ok: false,
      code: "request",
      message: KAFKA_AGENT_SENTENCES.repeated,
    });
    expect(refused('{"read": "offsets", "topic": "a", "t\\u006fpic": "b"}').message).toBe(
      KAFKA_AGENT_SENTENCES.repeated,
    );
    // A quote inside a string is no key boundary.
    expect(readKafkaAgentStatement('{"read": "topics", "after": "a"}').ok).toBe(true);
  });

  test("a topic is required for partitions and offsets and refused for the listings", () => {
    expect(refused('{"read": "partitions"}').message).toBe(KAFKA_AGENT_SENTENCES.topicRequired);
    expect(refused('{"read": "offsets"}').message).toBe(KAFKA_AGENT_SENTENCES.topicRequired);
    expect(refused('{"read": "topics", "topic": "orders"}').message).toBe(KAFKA_AGENT_SENTENCES.topicNotTaken);
    expect(refused('{"read": "brokers", "topic": "orders"}').message).toBe(KAFKA_AGENT_SENTENCES.topicNotTaken);
  });

  test("a topic name must be one Kafka would hold, and no internal topic is named", () => {
    for (const topic of [".", "..", "", "a b", "a/b", "é", "x".repeat(250), 7, null, ["orders"], { name: "orders" }]) {
      expect(refused(JSON.stringify({ read: "offsets", topic })).message).toBe(KAFKA_AGENT_SENTENCES.topicName);
    }
    expect(readKafkaAgentStatement(JSON.stringify({ read: "offsets", topic: "x".repeat(249) })).ok).toBe(true);
    expect(readKafkaAgentStatement('{"read": "offsets", "topic": "..."}').ok).toBe(true);
    for (const topic of ["__consumer_offsets", "__transaction_state", "__share_group_state"]) {
      expect(refused(JSON.stringify({ read: "partitions", topic })).message).toBe(KAFKA_AGENT_SENTENCES.internal);
    }
    // Kafka's own list is matched whole and by case, as Kafka does.
    expect(readKafkaAgentStatement('{"read": "partitions", "topic": "__Consumer_offsets"}').ok).toBe(true);
  });

  test("a limit is a whole number from 1 to the largest a read takes", () => {
    for (const limit of [0, -1, 1.5, 501, "5", null, true]) {
      expect(refused(JSON.stringify({ read: "topics", limit })).message).toBe(KAFKA_AGENT_SENTENCES.limit);
    }
    expect(readKafkaAgentStatement('{"read": "topics", "limit": 1}').ok).toBe(true);
  });

  test("a cursor is a topic name for the topic listing and a whole number for the other reads", () => {
    expect(refused('{"read": "topics", "after": 3}').message).toBe(KAFKA_AGENT_SENTENCES.topicCursor);
    expect(refused('{"read": "topics", "after": "a b"}').message).toBe(KAFKA_AGENT_SENTENCES.topicCursor);
    for (const after of ["3", -1, 1.5, 2147483648, null]) {
      expect(refused(JSON.stringify({ read: "partitions", topic: "orders", after })).message).toBe(
        KAFKA_AGENT_SENTENCES.idCursor,
      );
      expect(refused(JSON.stringify({ read: "brokers", after })).message).toBe(KAFKA_AGENT_SENTENCES.idCursor);
    }
    expect(readKafkaAgentStatement('{"read": "offsets", "topic": "o", "after": 2147483647}').ok).toBe(true);
  });

  test("no refusal quotes the request: a value it wrote never comes back in the sentence", () => {
    const sentences = [
      refused('{"read": "topics", "after": "secret-topic-name with space"}').message,
      refused('{"read": "offsets", "topic": "secret value"}').message,
      refused('{"read": "secret-read"}').message,
      refused('{"read": "topics", "secret-key": 1}').message,
      refused("not json secret").message,
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toContain("secret");
      expect(sentence).toEndWith("Nothing was sent.");
      expect(sentence).toContain('{"read": "topics"}');
    }
  });
});
