import { describe, expect, test } from "bun:test";
import { KafkaError } from "@/lib/db/providers/stream/kafka/client";
import { parseReadRequest } from "@/lib/db/providers/stream/kafka/request";

const parse = (text: string) => parseReadRequest(text, 500);
const refusal = (text: string): KafkaError => {
  try {
    parse(text);
  } catch (error) {
    expect(error).toBeInstanceOf(KafkaError);
    expect((error as KafkaError).category).toBe("invalid-request");
    return error as KafkaError;
  }
  throw new Error(`expected a refusal for ${text}`);
};

/**
 * Every refusal names the key it refuses (spec 5.1), in these words: a refusal that dropped its key's name would leave
 * the editor saying what is wrong without saying where.
 */
const TOPIC_REFUSAL =
  '"topic" is required and must be a Kafka topic name: 1 to 249 of the characters a-z, A-Z, 0-9, ".", "_" and "-", other than "." and ".."';
const FROM_REFUSAL = '"from" is "earliest", "latest", {"offset": n} or {"timestamp": "<ISO-8601 with a zone>"}';
const OFFSET_NUMBER_REFUSAL =
  "The offset must be a non-negative whole number; above 9007199254740991 write it as a digit string, because JSON numbers lose precision there";
const OFFSET_REFUSAL = "The offset must be a non-negative whole number or a digit string";
const TIMESTAMP_REFUSAL =
  'The timestamp must be ISO-8601 with a zone, such as "2026-09-23T00:00:00Z" or "2026-09-23T03:00:00+03:00"';
const limitRefusal = (maximum: number) => `"limit" must be a whole number from 1 to ${maximum}`;

describe("parseReadRequest", () => {
  test("defaults: from latest, limit 50", () => {
    expect(parse('{"topic":"orders"}')).toEqual({ topic: "orders", from: { kind: "latest" }, limit: 50 });
  });

  test("every from form", () => {
    expect(parse('{"topic":"o","from":"earliest"}').from).toEqual({ kind: "earliest" });
    expect(parse('{"topic":"o","from":"latest"}').from).toEqual({ kind: "latest" });
    expect(parse('{"topic":"o","partition":0,"from":{"offset":120}}').from).toEqual({
      kind: "offset",
      offset: BigInt(120),
    });
    expect(parse('{"topic":"o","partition":0,"from":{"offset":"9007199254740993"}}').from).toEqual({
      kind: "offset",
      // The string form: BigInt(9007199254740993) would round to ...992 before BigInt saw it.
      offset: BigInt("9007199254740993"),
    });
    expect(parse('{"topic":"o","from":{"timestamp":"2026-09-23T00:00:00Z"}}').from).toEqual({
      kind: "timestamp",
      timestampMs: BigInt(Date.parse("2026-09-23T00:00:00Z")),
      iso: "2026-09-23T00:00:00.000Z",
    });
    expect(parse('{"topic":"o","from":{"timestamp":"2026-09-23T03:00:00+03:00"}}').from).toMatchObject({
      iso: "2026-09-23T00:00:00.000Z",
    });
  });

  test("a partition is kept when given", () => {
    expect(parse('{"topic":"o","partition":2}')).toEqual({
      topic: "o",
      partition: 2,
      from: { kind: "latest" },
      limit: 50,
    });
  });

  test("invalid JSON and a non-object are refused; empty text is the provider's QueryError (Task 16)", () => {
    expect(refusal("{topic:").message).toContain("not valid JSON");
    expect(refusal("[]").message).toContain("one JSON object");
    expect(refusal("null").message).toContain("one JSON object");
    expect(refusal('"orders"').message).toContain("one JSON object");
  });

  test("invalid JSON is refused without echoing the text, which Node's parser message quotes", () => {
    const message = refusal("nope-this-is-the-request").message;
    expect(message).toContain("not valid JSON");
    expect(message).not.toContain("nope");
  });

  test("an unknown key is refused and named", () => {
    expect(refusal('{"topic":"o","offset":1}').message).toContain('"offset"');
    expect(refusal('{"topic":"o","__proto__":{}}').message).toContain('"__proto__"');
  });

  test("topic is required and must be a legal Kafka topic name", () => {
    expect(refusal("{}").message).toBe(TOPIC_REFUSAL);
    for (const topic of ["", "a b", "a/b", "x".repeat(250), "ü", 7]) {
      expect(refusal(JSON.stringify({ topic })).message).toBe(TOPIC_REFUSAL);
    }
    expect(parse('{"topic":"a.b_c-9"}').topic).toBe("a.b_c-9");
    expect(parse(JSON.stringify({ topic: "x".repeat(249) })).topic).toHaveLength(249);
  });

  test('"." and ".." are refused before any request, as Kafka refuses them, while other names of dots are legal', () => {
    // Kafka's Topic.validate refuses these two names on every broker, so a read of either could only fail there.
    for (const topic of [".", ".."]) {
      expect(refusal(JSON.stringify({ topic })).message).toBe(TOPIC_REFUSAL);
    }
    for (const topic of ["...", ".a", "a.", "._", "-."]) {
      expect(parse(JSON.stringify({ topic })).topic).toBe(topic);
    }
  });

  test("partition must be a non-negative integer a Kafka INT32 carries", () => {
    for (const partition of [-1, 1.5, "0", null, 2147483648]) {
      expect(refusal(JSON.stringify({ topic: "o", partition })).message).toContain('"partition"');
    }
    expect(parse('{"topic":"o","partition":2147483647}').partition).toBe(2147483647);
  });

  test("an offset needs a partition", () => {
    expect(refusal('{"topic":"o","from":{"offset":1}}').message).toContain("partition");
  });

  test("Review Focus 4: an offset number above MAX_SAFE_INTEGER is refused, with the digit-string advice", () => {
    expect(refusal('{"topic":"o","partition":0,"from":{"offset":9007199254740993}}').message).toContain("digit string");
    // A JSON number that is no safe whole number, and anything else that is no digit string: each names the offset.
    for (const offset of ["9007199254740993", "-1", "1.5"]) {
      expect(refusal(`{"topic":"o","partition":0,"from":{"offset":${offset}}}`).message).toBe(OFFSET_NUMBER_REFUSAL);
    }
    for (const offset of ['"12a"', '"-1"', "null", "true", '[""]']) {
      expect(refusal(`{"topic":"o","partition":0,"from":{"offset":${offset}}}`).message).toBe(OFFSET_REFUSAL);
    }
  });

  test("an offset past the Kafka INT64 maximum is refused; the maximum itself is read exactly", () => {
    expect(parse('{"topic":"o","partition":0,"from":{"offset":"9223372036854775807"}}').from).toEqual({
      kind: "offset",
      offset: BigInt("9223372036854775807"),
    });
    expect(refusal('{"topic":"o","partition":0,"from":{"offset":"9223372036854775808"}}').message).toBe(
      "The offset must be at most 9223372036854775807, Kafka's largest offset",
    );
  });

  test("Review Focus 5: a timestamp without a zone is refused", () => {
    expect(refusal('{"topic":"o","from":{"timestamp":"2026-09-23T00:00"}}').message).toContain("zone");
    for (const timestamp of ['"2026-09-23T00:00"', '"yesterday"', "1790121600000", '"2026-09-23T25:00:00Z"', "null"]) {
      expect(refusal(`{"topic":"o","from":{"timestamp":${timestamp}}}`).message).toBe(TIMESTAMP_REFUSAL);
    }
  });

  test("a calendar day the month does not have is refused, where Date.parse would roll it into the next month", () => {
    for (const [timestamp, day] of [
      ["2026-02-30T00:00:00Z", "30"],
      ["2026-04-31T00:00:00Z", "31"],
      ["2027-02-29T00:00:00Z", "29"],
      ["2026-09-00T00:00:00Z", "00"],
      ["2100-02-29T00:00:00Z", "29"],
    ]) {
      expect(refusal(JSON.stringify({ topic: "o", from: { timestamp } })).message).toBe(
        `The timestamp names day ${day} of a month that does not have it`,
      );
    }
    expect(parse('{"topic":"o","from":{"timestamp":"2028-02-29T00:00:00Z"}}').from).toMatchObject({
      iso: "2028-02-29T00:00:00.000Z",
    });
    expect(parse('{"topic":"o","from":{"timestamp":"2000-02-29T00:00:00Z"}}').from).toMatchObject({
      iso: "2000-02-29T00:00:00.000Z",
    });
  });

  test("an instant before 1970 is refused: -1 and -2 ms are the ListOffsets sentinels for latest and earliest", () => {
    for (const timestamp of ["1969-12-31T23:59:59.999Z", "1969-12-31T23:59:59.998Z"]) {
      expect(refusal(JSON.stringify({ topic: "o", from: { timestamp } })).message).toBe(
        "The timestamp must be at or after 1970-01-01T00:00:00Z: Kafka reads an earlier instant as a sentinel",
      );
    }
    expect(parse('{"topic":"o","from":{"timestamp":"1970-01-01T00:00:00Z"}}').from).toEqual({
      kind: "timestamp",
      timestampMs: BigInt(0),
      iso: "1970-01-01T00:00:00.000Z",
    });
  });

  test("an unknown from form is refused", () => {
    for (const text of [
      '{"topic":"o","from":"newest"}',
      '{"topic":"o","from":null}',
      '{"topic":"o","from":[]}',
      '{"topic":"o","from":{}}',
      '{"topic":"o","from":{"offset":1,"timestamp":"2026-09-23T00:00:00Z"},"partition":0}',
    ]) {
      expect(refusal(text).message).toBe(FROM_REFUSAL);
    }
  });

  test("limit is an integer from 1 to the maximum", () => {
    expect(parse('{"topic":"o","limit":500}').limit).toBe(500);
    expect(parse('{"topic":"o","limit":1}').limit).toBe(1);
    for (const limit of [0, 501, 2.5, "5", null]) {
      expect(refusal(JSON.stringify({ topic: "o", limit })).message).toBe(limitRefusal(500));
    }
  });

  test("the maximum is the caller's", () => {
    expect(parseReadRequest('{"topic":"o","limit":20}', 20).limit).toBe(20);
    expect(() => parseReadRequest('{"topic":"o","limit":21}', 20)).toThrow(limitRefusal(20));
  });
});
