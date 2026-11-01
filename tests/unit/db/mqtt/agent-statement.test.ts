/**
 * The agent's reader of one MQTT read request (`docs/providers/mqtt.md` section 14.2): the closed table of two reads,
 * and every request outside it refused before anything is sent, in agent mode's words with the list of reads.
 */
import { describe, expect, test } from "bun:test";
import {
  MQTT_AGENT_READS,
  MQTT_AGENT_SENTENCES,
  readMqttAgentStatement,
} from "@/lib/db/providers/keyvalue/mqtt/agent-statement";

const refusal = (text: string) => {
  const reading = readMqttAgentStatement(text);
  if (reading.ok) throw new Error(`admitted ${text}`);
  return reading;
};

describe("the two reads", () => {
  test("the window read takes no topic", () => {
    expect(readMqttAgentStatement('{"read": "window"}')).toEqual({ ok: true, plan: { op: "window" } });
    expect(readMqttAgentStatement(' { "read" : "window" } ')).toEqual({ ok: true, plan: { op: "window" } });
  });

  test("the topic read names one topic in full, kept exactly as written", () => {
    expect(readMqttAgentStatement('{"read": "topic", "topic": "plant/line1/temp"}')).toEqual({
      ok: true,
      plan: { op: "topic", topic: "plant/line1/temp" },
    });
    // A leading slash, a space and an empty level are legal topic names and are sent as written.
    expect(readMqttAgentStatement('{"topic": "/a b//c", "read": "topic"}')).toEqual({
      ok: true,
      plan: { op: "topic", topic: "/a b//c" },
    });
    // A look-alike of a separator or a wildcard is an ordinary character in a topic name: brokers compare bytes.
    expect(readMqttAgentStatement('{"read": "topic", "topic": "a\\uff0fb\\uff0b\\uff03"}')).toEqual({
      ok: true,
      plan: { op: "topic", topic: "a／b＋＃" },
    });
  });
});

describe("refused before anything is sent", () => {
  test.each([
    ["", MQTT_AGENT_SENTENCES.empty, "request"],
    ["   ", MQTT_AGENT_SENTENCES.empty, "request"],
    ["window", MQTT_AGENT_SENTENCES.notObject, "request"],
    ['["window"]', MQTT_AGENT_SENTENCES.notObject, "request"],
    ["null", MQTT_AGENT_SENTENCES.notObject, "request"],
    ['{"read": "window", "read": "topic"}', MQTT_AGENT_SENTENCES.repeated, "request"],
    ['{"read": "topic", "topic": "a", "t\\u006fpic": "b"}', MQTT_AGENT_SENTENCES.repeated, "request"],
    ['{"read": "window", "filter": "#"}', MQTT_AGENT_SENTENCES.keys, "request"],
    ['{"read": "topic", "topic": "a", "qos": 1}', MQTT_AGENT_SENTENCES.keys, "request"],
    ['{"read": "topic", "topic": "a", "noLocal": false}', MQTT_AGENT_SENTENCES.keys, "request"],
    ['{"read": "topic", "topic": "a", "retainHandling": 2}', MQTT_AGENT_SENTENCES.keys, "request"],
    ['{"read": "topic", "topic": "a", "topicAlias": 1}', MQTT_AGENT_SENTENCES.keys, "request"],
    ['{"read": "window", "will": {"topic": "a", "payload": "x"}}', MQTT_AGENT_SENTENCES.keys, "request"],
    ['{"read": "publish", "topic": "a"}', MQTT_AGENT_SENTENCES.notARead, "metadata-only"],
    ['{"read": "subscribe", "topic": "a/#"}', MQTT_AGENT_SENTENCES.notARead, "metadata-only"],
    ['{"read": "payload", "topic": "a"}', MQTT_AGENT_SENTENCES.notARead, "metadata-only"],
    ['{"read": "Window"}', MQTT_AGENT_SENTENCES.notARead, "metadata-only"],
    ['{"read": 1}', MQTT_AGENT_SENTENCES.notARead, "metadata-only"],
    ['{"topic": "a"}', MQTT_AGENT_SENTENCES.notARead, "metadata-only"],
    ['{"read": "window", "topic": "a"}', MQTT_AGENT_SENTENCES.topicNotTaken, "request"],
    ['{"read": "topic"}', MQTT_AGENT_SENTENCES.topicRequired, "request"],
    ['{"read": "topic", "topic": ""}', MQTT_AGENT_SENTENCES.topicName, "request"],
    ['{"read": "topic", "topic": 7}', MQTT_AGENT_SENTENCES.topicName, "request"],
    ['{"read": "topic", "topic": null}', MQTT_AGENT_SENTENCES.topicName, "request"],
    ['{"read": "topic", "topic": "a\\u0000b"}', MQTT_AGENT_SENTENCES.topicName, "request"],
    ['{"read": "topic", "topic": "a\\ud800b"}', MQTT_AGENT_SENTENCES.topicName, "request"],
    ['{"read": "topic", "topic": "#"}', MQTT_AGENT_SENTENCES.wildcard, "metadata-only"],
    ['{"read": "topic", "topic": "+"}', MQTT_AGENT_SENTENCES.wildcard, "metadata-only"],
    ['{"read": "topic", "topic": "plant/#"}', MQTT_AGENT_SENTENCES.wildcard, "metadata-only"],
    ['{"read": "topic", "topic": "plant/+/temp"}', MQTT_AGENT_SENTENCES.wildcard, "metadata-only"],
    ['{"read": "topic", "topic": "plant/\\u002b/temp"}', MQTT_AGENT_SENTENCES.wildcard, "metadata-only"],
    ['{"read": "topic", "topic": "a#b"}', MQTT_AGENT_SENTENCES.wildcard, "metadata-only"],
    ['{"read": "topic", "topic": "$share/g/plant/a"}', MQTT_AGENT_SENTENCES.dollar, "metadata-only"],
    ['{"read": "topic", "topic": "$queue/plant/a"}', MQTT_AGENT_SENTENCES.dollar, "metadata-only"],
    ['{"read": "topic", "topic": "$exclusive/plant/a"}', MQTT_AGENT_SENTENCES.dollar, "metadata-only"],
    ['{"read": "topic", "topic": "$SYS/broker/version"}', MQTT_AGENT_SENTENCES.dollar, "metadata-only"],
    ['{"read": "topic", "topic": "$SHARE/x"}', MQTT_AGENT_SENTENCES.dollar, "metadata-only"],
    ['{"read": "topic", "topic": "$share/g/plant/#"}', MQTT_AGENT_SENTENCES.dollar, "metadata-only"],
    ['{"read": "topic", "topic": "$SYS/#"}', MQTT_AGENT_SENTENCES.dollar, "metadata-only"],
  ] as const)("%s", (text, message, code) => {
    expect(refusal(text)).toEqual({ ok: false, code, message });
  });

  test("an overlong topic is refused, one byte past the MQTT string length and not at it", () => {
    const at = "a".repeat(65_535);
    expect(readMqttAgentStatement(JSON.stringify({ read: "topic", topic: at })).ok).toBe(true);
    expect(refusal(JSON.stringify({ read: "topic", topic: `${at}a` })).message).toBe(MQTT_AGENT_SENTENCES.topicName);
    // Counted in UTF-8 bytes, not characters: three-byte characters reach the length sooner.
    expect(refusal(JSON.stringify({ read: "topic", topic: "€".repeat(21_846) })).message).toBe(
      MQTT_AGENT_SENTENCES.topicName,
    );
  });

  test("every refusal ends with the list of reads and says nothing was sent, and none quotes the request", () => {
    for (const message of Object.values(MQTT_AGENT_SENTENCES)) {
      expect(message).toContain(MQTT_AGENT_READS);
      expect(message.endsWith("Nothing was sent.")).toBe(true);
    }
    const secretTopic = "people/alice-ozturk/heart-rate";
    for (const text of [
      `{"read": "topic", "topic": "${secretTopic}/#"}`,
      `{"read": "window", "topic": "${secretTopic}"}`,
      `{"read": "publish", "topic": "${secretTopic}"}`,
    ]) {
      expect(refusal(text).message).not.toContain("alice");
    }
  });

  test("a refusal is decided by the request's text alone, so a withheld topic and a missing one are refused alike", () => {
    // The reader never sees the broker: the same wildcard under a topic that exists and one that does not is the same
    // refusal, word for word.
    expect(refusal('{"read": "topic", "topic": "plant/line1/#"}')).toEqual(
      refusal('{"read": "topic", "topic": "nowhere/at-all/#"}'),
    );
  });
});
