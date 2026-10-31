/**
 * The agent's reader of one RabbitMQ read request: the editor's own request shape, each admitted request pinned as
 * the whole read it sends, and every refusal worded in agent mode's own words with the read it holds.
 */
import { describe, expect, test } from "bun:test";
import {
  RABBITMQ_AGENT_SENTENCES,
  type RabbitMQAgentReading,
  readRabbitMQAgentStatement,
} from "@/lib/db/providers/stream/rabbitmq/agent-statement";

const reads = (text: string): RabbitMQAgentReading => readRabbitMQAgentStatement(text);

const AGENT_READ_START = "Agent mode on RabbitMQ reads one stream at a time";

describe("the read the table holds", () => {
  test.each([
    [
      '{"vhost": "/", "stream": "orders"}',
      { vhost: "/", stream: "orders", from: { kind: "keyword", value: "last" }, startText: '"last"', limit: 50 },
    ],
    [
      '{"vhost": "billing", "stream": "audit", "from": "first", "limit": 3}',
      { vhost: "billing", stream: "audit", from: { kind: "keyword", value: "first" }, startText: '"first"', limit: 3 },
    ],
    [
      '{"vhost": "/", "stream": "orders", "from": {"offset": 7}, "limit": 1}',
      {
        vhost: "/",
        stream: "orders",
        from: { kind: "offset", value: BigInt(7) },
        startText: '{"offset": "7"}',
        limit: 1,
      },
    ],
    [
      '{"vhost": "/", "stream": "orders", "from": {"age": "5m"}}',
      { vhost: "/", stream: "orders", from: { kind: "age", value: "5m" }, startText: '{"age": "5m"}', limit: 50 },
    ],
    [
      '{"vhost": "/", "stream": "orders", "from": {"timestamp": "2026-10-01T00:00:00Z"}}',
      {
        vhost: "/",
        stream: "orders",
        from: { kind: "timestamp", seconds: BigInt(1_790_812_800) },
        startText: '{"timestamp": "2026-10-01T00:00:00.000Z"}',
        limit: 50,
      },
    ],
  ])("%s", (text, plan) => {
    expect(reads(text)).toEqual({ ok: true, plan } as RabbitMQAgentReading);
  });
});

describe("a request outside the read request's shape", () => {
  test.each([
    ['{"vhost": "/", "stream": "orders", "filter": {"routing_key": "a"}}', 'Unknown key "filter" in the read request'],
    ['{"vhost": "/", "stream": "orders", "headers": {}}', 'Unknown key "headers" in the read request'],
    ['{"vhost": "/", "stream": "orders", "ack": true}', 'Unknown key "ack" in the read request'],
    ['{"vhost": "/", "stream": "orders", "vhost": "billing"}', 'The read request names "vhost" more than once'],
    ['{"vhost": "/", "stream": "."}', '"vhost" and "stream" are required strings'],
    ['{"vhost": "..", "stream": "orders"}', '"vhost" and "stream" are required strings'],
    ['{"vhost": "/"}', '"vhost" and "stream" are required strings'],
    ['{"vhost": "/", "stream": "orders", "limit": 0}', '"limit" must be a whole number from 1 to 500.'],
    ['{"vhost": "/", "stream": "orders", "from": "everything"}', '"from" is "first", "last", "next"'],
    ["basic.get orders", "A RabbitMQ read request is one JSON object"],
    ['[{"vhost": "/", "stream": "orders"}]', "A RabbitMQ read request is one JSON object"],
  ])("%s is refused with the parser's sentence and the agent's read", (text, start) => {
    const reading = reads(text);
    if (reading.ok) throw new Error("expected a refusal");
    expect(reading.code).toBe("request");
    expect(reading.message).toStartWith(start);
    expect(reading.message).toContain(AGENT_READ_START);
    expect(reading.message).toEndWith("Nothing was sent.");
  });

  test.each(["", "  \n\t"])("an empty request %j is refused with the agent's own sentence", (text) => {
    expect(reads(text)).toEqual({ ok: false, code: "request", message: RABBITMQ_AGENT_SENTENCES.empty });
  });

  test("the agent's read names what is withheld and offers no filter", () => {
    expect(RABBITMQ_AGENT_SENTENCES.empty).toBe(
      'The request holds no read. Agent mode on RabbitMQ reads one stream at a time, written as the editor\'s read request, one JSON object such as {"vhost": "/", "stream": "orders", "from": "first", "limit": 50}, and answers each message\'s offset and body size alone: a message\'s body, headers, properties and routing key are withheld. Nothing was sent.',
    );
  });
});
