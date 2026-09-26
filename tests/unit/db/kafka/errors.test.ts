import { describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import { KafkaError, type KafkaErrorCategory } from "@/lib/db/providers/stream/kafka/client";
import { toDatabaseError } from "@/lib/db/providers/stream/kafka/errors";

const B = { host: "broker-1", port: 9092 };
const cases: Array<[KafkaErrorCategory, new (...a: never[]) => Error]> = [
  ["invalid-request", DatabaseConfigError],
  ["invalid-config", DatabaseConfigError],
  ["unknown-topic", QueryError],
  ["unknown-object", QueryError],
  ["unreadable-topic", QueryError],
  ["offset-out-of-range", QueryError],
  ["authorization", AuthenticationError],
  ["authentication", AuthenticationError],
  ["tls", ConnectionError],
  ["network", ConnectionError],
  ["advertised-unreachable", ConnectionError],
  ["timeout", TimeoutError],
  ["unsupported-broker", QueryError],
  ["protocol", QueryError],
];

describe("toDatabaseError", () => {
  for (const [category, cls] of cases) {
    test(`${category} maps to ${cls.name}, stamped kafka`, () => {
      const mapped = toDatabaseError(new KafkaError(category, "m"), B, 30_000);
      expect(mapped).toBeInstanceOf(cls);
      expect((mapped as { provider?: string }).provider).toBe("kafka");
      expect(mapped.message).toBe("m");
    });
  }

  test("a product DatabaseConfigError from the validators is re-stamped kafka", () => {
    const mapped = toDatabaseError(new DatabaseConfigError("bad host"), B, 1);
    expect(mapped).toBeInstanceOf(DatabaseConfigError);
    expect((mapped as { provider?: string }).provider).toBe("kafka");
    expect(mapped.message).toBe("bad host");
  });

  test("a DatabaseConfigError already stamped with a provider passes through as the same object", () => {
    const stamped = new DatabaseConfigError("bad", "postgres");
    expect(toDatabaseError(stamped, B, 1)).toBe(stamped);
  });

  test("a network error carries the bootstrap host and port on the ConnectionError, not in the message", () => {
    const mapped = toDatabaseError(new KafkaError("network", "unreachable"), B, 1) as ConnectionError;
    expect([mapped.host, mapped.port]).toEqual(["broker-1", 9092]);
    expect(mapped.message).not.toContain("broker-1");
  });

  test("a TLS failure carries the bootstrap host and port too", () => {
    const mapped = toDatabaseError(new KafkaError("tls", "handshake"), B, 1) as ConnectionError;
    expect([mapped.host, mapped.port]).toEqual(["broker-1", 9092]);
  });

  test("an advertised address Studio cannot reach is carried as the advertised host and port, not the bootstrap", () => {
    const error = new KafkaError("advertised-unreachable", "advertised", { host: "kafka-2.internal", port: 29092 });
    const mapped = toDatabaseError(error, B, 1) as ConnectionError;
    expect([mapped.host, mapped.port]).toEqual(["kafka-2.internal", 29092]);
  });

  test("a timeout carries the deadline it ran under", () => {
    const mapped = toDatabaseError(new KafkaError("timeout", "t"), B, 12_345) as TimeoutError;
    expect(mapped.timeout).toBe(12_345);
  });

  test("anything else is rethrown untouched: an internal defect must not be dressed up as an engine sentence", () => {
    const defect = new TypeError("x is undefined");
    expect(toDatabaseError(defect, B, 1)).toBe(defect);
  });
});
