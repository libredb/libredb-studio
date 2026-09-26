import { describe, expect, test } from "bun:test";
import { BIGINT_ONE, BIGINT_ZERO, KafkaError, partRead } from "@/lib/db/providers/stream/kafka/client";

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

describe("partRead", () => {
  test("answers the read's own answer, the very value", async () => {
    const answer = { entries: [] };
    const read = await partRead(async () => answer);
    expect(read).toEqual({ answer });
    expect("answer" in read && read.answer).toBe(answer);
  });

  test("answers the broker's refusal, a KafkaError of category authorization, as refused in its own words", async () => {
    const read = await partRead(async () => {
      throw new KafkaError("authorization", "The broker denied access to this topic", { resource: "topic" });
    });
    expect(read).toEqual({ refused: "The broker denied access to this topic" });
  });

  test("rejects with any other failure as itself: another category, a defect, or an error that only carries the category", async () => {
    const failures = [
      new KafkaError("network", "The broker could not be reached (connection-lost)"),
      new KafkaError("protocol", "The request to the broker failed (UNKNOWN_SERVER_ERROR)"),
      new KafkaError("unknown-object", 'Consumer group "g" does not exist'),
      new TypeError("a defect, not a refusal"),
      Object.assign(new Error("carries the category only"), { category: "authorization" }),
    ];
    const outcomes = await Promise.all(
      failures.map((failure) =>
        partRead(async () => {
          throw failure;
        }).then(
          () => "answered",
          (error) => error === failure,
        ),
      ),
    );
    expect(outcomes).toEqual(failures.map(() => true));
  });
});

describe("the shared bigint constants", () => {
  test("are the bigints 0 and 1, written without a literal", () => {
    expect(BIGINT_ZERO).toBe(BigInt(0));
    expect(BIGINT_ONE).toBe(BigInt(1));
  });
});
