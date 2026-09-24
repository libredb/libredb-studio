import { describe, expect, test } from "bun:test";
import { BIGINT_ONE, BIGINT_ZERO, KafkaError } from "@/lib/db/providers/stream/kafka/client";

describe("KafkaError", () => {
  test("carries its category and detail, and is an Error", () => {
    const error = new KafkaError("offset-out-of-range", "Offset 1000 is outside partition 1's range 0 to 12", {
      validRange: { earliest: BigInt(0), latest: BigInt(12) },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("KafkaError");
    expect(error.category).toBe("offset-out-of-range");
    expect(error.detail.validRange).toEqual({ earliest: BigInt(0), latest: BigInt(12) });
  });

  test("detail defaults to an empty object", () => {
    expect(new KafkaError("timeout", "t").detail).toEqual({});
  });
});

describe("the shared bigint constants", () => {
  test("are the bigints 0 and 1, written without a literal", () => {
    expect(BIGINT_ZERO).toBe(BigInt(0));
    expect(BIGINT_ONE).toBe(BigInt(1));
  });
});
