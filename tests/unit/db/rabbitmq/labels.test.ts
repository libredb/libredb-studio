/**
 * The RabbitMQ labels: every member, and a statementLanguage that carries the request schema, its defaults, every
 * start form and the two sentences about time a reader of the timestamp column needs.
 */
import { describe, expect, test } from "bun:test";
import {
  RABBITMQ_LABELS,
  RABBITMQ_STATEMENT_EXAMPLES,
  rabbitmqStatementLanguage,
} from "@/lib/db/providers/stream/rabbitmq/labels";

describe("RABBITMQ_LABELS", () => {
  test("names a stream and a message, and reads 'Read Last Chunk' on a click", () => {
    expect(RABBITMQ_LABELS).toMatchObject({
      entityName: "Stream",
      entityNamePlural: "Streams",
      rowName: "Message",
      rowNamePlural: "Messages",
      selectAction: "Read Last Chunk",
      generateAction: "Generate Read Request",
      searchPlaceholder: "Search streams, queues and exchanges...",
      slowQueriesEmptyState: "RabbitMQ has no query log",
      sessionsEmptyState:
        "Studio does not list broker connections, because they name other users and client addresses.",
    });
    expect(Object.isFrozen(RABBITMQ_LABELS)).toBe(true);
  });

  test("never says RMQ", () => {
    expect(JSON.stringify(RABBITMQ_LABELS)).not.toContain("RMQ");
  });
});

describe("statementLanguage", () => {
  const sentence = rabbitmqStatementLanguage();

  test("is the labels' member", () => {
    expect(RABBITMQ_LABELS.statementLanguage).toBe(sentence);
  });

  test("names the four keys, the required ones and both defaults", () => {
    expect(sentence).toStartWith("the JSON read request this editor executes - one object");
    for (const key of ['"vhost"', '"stream"', '"from"', '"limit"']) expect(sentence).toContain(key);
    expect(sentence).toContain('"vhost" and "stream" are required; "from" defaults to "last" and "limit" to 50');
    expect(sentence).toContain("<1 to 500>");
    expect(sentence).toContain("with no other key");
  });

  test("says a request reads streams only, never a queue or an exchange", () => {
    expect(sentence).toContain("a request reads a stream's messages only");
    expect(sentence).toContain("the queue and exchange names in the inventory are not readable");
  });

  test("says how an inventory name splits into the vhost and stream keys", () => {
    // The inventory joins the path with a dot, so the stream st-orders in "/" reaches the model as "/.st-orders"; two
    // plan runs copied that name into "stream" whole or as ".st-orders" when no sentence said where it splits.
    expect(sentence).toContain(
      'an inventory entry is named by its virtual host, a dot and its own name, and a plan run reads only the virtual host "/", so the entry "/.orders" is the stream "orders", written {"vhost": "/", "stream": "orders"}; "stream" never carries the "/." prefix or any part of it',
    );
  });

  test("lists every start form, months against minutes", () => {
    for (const form of ['"first"', '"last"', '"next"', '{"offset": <n>}', '{"timestamp": "<ISO-8601 with a zone>"}'])
      expect(sentence).toContain(form);
    expect(sentence).toContain('{"age": "<n><unit>"} with unit Y, M (months), D, h, m (minutes) or s');
  });

  test("says what the timestamp column is and what a time start uses", () => {
    expect(sentence).toContain(
      "the timestamp column is the message's timestamp property, set by the publisher (or by the broker's timestamp interceptor), in seconds",
    );
    expect(sentence).toContain(
      "A timestamp or age start uses the time the broker stored the messages; the timestamp column is the publisher's own property, which can be empty or differ",
    );
  });

  test("carries both examples, each one JSON object with the four keys at most", () => {
    for (const example of RABBITMQ_STATEMENT_EXAMPLES) {
      expect(sentence).toContain(example);
      const parsed = JSON.parse(example) as Record<string, unknown>;
      expect(Object.keys(parsed).every((key) => ["vhost", "stream", "from", "limit"].includes(key))).toBe(true);
    }
  });
});
