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
    expect(refusal("{}").message).toContain("topic");
    for (const topic of ["", "a b", "a/b", "x".repeat(250), "ü", 7]) {
      refusal(JSON.stringify({ topic }));
    }
    expect(parse('{"topic":"a.b_c-9"}').topic).toBe("a.b_c-9");
    expect(parse(JSON.stringify({ topic: "x".repeat(249) })).topic).toHaveLength(249);
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
    refusal('{"topic":"o","partition":0,"from":{"offset":-1}}');
    refusal('{"topic":"o","partition":0,"from":{"offset":1.5}}');
    refusal('{"topic":"o","partition":0,"from":{"offset":"12a"}}');
    refusal('{"topic":"o","partition":0,"from":{"offset":"-1"}}');
    refusal('{"topic":"o","partition":0,"from":{"offset":null}}');
  });

  test("an offset past the Kafka INT64 maximum is refused; the maximum itself is read exactly", () => {
    expect(parse('{"topic":"o","partition":0,"from":{"offset":"9223372036854775807"}}').from).toEqual({
      kind: "offset",
      offset: BigInt("9223372036854775807"),
    });
    expect(refusal('{"topic":"o","partition":0,"from":{"offset":"9223372036854775808"}}').message).toContain(
      "9223372036854775807",
    );
  });

  test("Review Focus 5: a timestamp without a zone is refused", () => {
    expect(refusal('{"topic":"o","from":{"timestamp":"2026-09-23T00:00"}}').message).toContain("zone");
    refusal('{"topic":"o","from":{"timestamp":"yesterday"}}');
    refusal('{"topic":"o","from":{"timestamp":1790121600000}}');
    refusal('{"topic":"o","from":{"timestamp":"2026-09-23T25:00:00Z"}}');
  });

  test("a calendar day the month does not have is refused, where Date.parse would roll it into the next month", () => {
    for (const timestamp of [
      "2026-02-30T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2027-02-29T00:00:00Z",
      "2026-09-00T00:00:00Z",
    ]) {
      expect(refusal(JSON.stringify({ topic: "o", from: { timestamp } })).message).toContain("day");
    }
    expect(parse('{"topic":"o","from":{"timestamp":"2028-02-29T00:00:00Z"}}').from).toMatchObject({
      iso: "2028-02-29T00:00:00.000Z",
    });
    expect(parse('{"topic":"o","from":{"timestamp":"2000-02-29T00:00:00Z"}}').from).toMatchObject({
      iso: "2000-02-29T00:00:00.000Z",
    });
    refusal('{"topic":"o","from":{"timestamp":"2100-02-29T00:00:00Z"}}');
  });

  test("an instant before 1970 is refused: -1 and -2 ms are the ListOffsets sentinels for latest and earliest", () => {
    expect(refusal('{"topic":"o","from":{"timestamp":"1969-12-31T23:59:59.999Z"}}').message).toContain("1970");
    refusal('{"topic":"o","from":{"timestamp":"1969-12-31T23:59:59.998Z"}}');
    expect(parse('{"topic":"o","from":{"timestamp":"1970-01-01T00:00:00Z"}}').from).toEqual({
      kind: "timestamp",
      timestampMs: BigInt(0),
      iso: "1970-01-01T00:00:00.000Z",
    });
  });

  test("an unknown from form is refused", () => {
    refusal('{"topic":"o","from":"newest"}');
    refusal('{"topic":"o","from":null}');
    refusal('{"topic":"o","from":[]}');
    refusal('{"topic":"o","from":{}}');
    refusal('{"topic":"o","from":{"offset":1,"timestamp":"2026-09-23T00:00:00Z"},"partition":0}');
  });

  test("limit is an integer from 1 to the maximum", () => {
    expect(parse('{"topic":"o","limit":500}').limit).toBe(500);
    expect(parse('{"topic":"o","limit":1}').limit).toBe(1);
    for (const limit of [0, 501, 2.5, "5", null]) {
      expect(refusal(JSON.stringify({ topic: "o", limit })).message).toContain("from 1 to 500");
    }
  });

  test("the maximum is the caller's", () => {
    expect(parseReadRequest('{"topic":"o","limit":20}', 20).limit).toBe(20);
    expect(() => parseReadRequest('{"topic":"o","limit":21}', 20)).toThrow("from 1 to 20");
  });
});
