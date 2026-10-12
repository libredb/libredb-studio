import { describe, expect, test } from "bun:test";
import * as limits from "@/lib/db/providers/stream/rabbitmq/limits";
import { engineLimiter } from "@/lib/db/utils/bounded-limiter";

describe("rabbitmq limits", () => {
  test("every named constant, by value", () => {
    expect({
      minVersion: limits.RABBITMQ_MIN_VERSION,
      managementPort: limits.RABBITMQ_DEFAULT_MANAGEMENT_PORT,
      readDeadlineMs: limits.RABBITMQ_READ_DEADLINE_MS,
      readDefaultRows: limits.RABBITMQ_READ_DEFAULT_ROWS,
      readMaxRows: limits.RABBITMQ_READ_MAX_ROWS,
      prefetchMax: limits.RABBITMQ_PREFETCH_MAX,
      idleMs: limits.RABBITMQ_IDLE_MS,
      resultBudgetBytes: limits.RABBITMQ_RESULT_BUDGET_BYTES,
      cellChars: limits.RABBITMQ_CELL_CHARS,
      bodyPrefixBytes: limits.RABBITMQ_BODY_PREFIX_BYTES,
      bodyCeilingBytes: limits.RABBITMQ_BODY_CEILING_BYTES,
      readWireBytes: limits.RABBITMQ_READ_WIRE_BYTES,
      headerFrameMaxBytes: limits.RABBITMQ_HEADER_FRAME_MAX_BYTES,
      headerValueRetainedBytes: limits.RABBITMQ_HEADER_VALUE_RETAINED_BYTES,
      headerTableRetainedBytes: limits.RABBITMQ_HEADER_TABLE_RETAINED_BYTES,
      headerDepth: limits.RABBITMQ_HEADER_DEPTH,
      frameMaxCeiling: limits.RABBITMQ_FRAME_MAX_CEILING,
      frameMinBytes: limits.RABBITMQ_FRAME_MIN_BYTES,
      heartbeatCeilingS: limits.RABBITMQ_HEARTBEAT_CEILING_S,
      closeOkWaitMs: limits.RABBITMQ_CLOSE_OK_WAIT_MS,
      lastHintBackstep: limits.RABBITMQ_LAST_HINT_BACKSTEP,
      amqp1DescriptorDepth: limits.RABBITMQ_AMQP1_DESCRIPTOR_DEPTH,
      payloadJsonDepth: limits.RABBITMQ_PAYLOAD_JSON_DEPTH,
      listingPageSize: limits.RABBITMQ_LISTING_PAGE_SIZE,
      mgmtDepth: limits.RABBITMQ_MGMT_DEPTH,
      mgmtRequestDeadlineMs: limits.RABBITMQ_MGMT_REQUEST_DEADLINE_MS,
      bindingsMaxRows: limits.RABBITMQ_BINDINGS_MAX_ROWS,
      bindingsKeptBytes: limits.RABBITMQ_BINDINGS_KEPT_BYTES,
      smallAnswerBytes: limits.RABBITMQ_SMALL_ANSWER_BYTES,
      answerBytes: limits.RABBITMQ_ANSWER_BYTES,
      bindingsAnswerBytes: limits.RABBITMQ_BINDINGS_ANSWER_BYTES,
      nameMaxBytes: limits.RABBITMQ_NAME_MAX_BYTES,
      nameProseChars: limits.RABBITMQ_NAME_PROSE_CHARS,
      testCheckMaxVhosts: limits.RABBITMQ_TEST_CHECK_MAX_VHOSTS,
      testCheckMaxQueues: limits.RABBITMQ_TEST_CHECK_MAX_QUEUES,
      testCheckDeadlineMs: limits.RABBITMQ_TEST_CHECK_DEADLINE_MS,
      cautionNamedQueues: limits.RABBITMQ_CAUTION_NAMED_QUEUES,
      cautionMaxVhosts: limits.RABBITMQ_CAUTION_MAX_VHOSTS,
    }).toEqual({
      minVersion: "4.2.0",
      managementPort: 15672,
      readDeadlineMs: 30000,
      readDefaultRows: 50,
      readMaxRows: 500,
      prefetchMax: 10,
      idleMs: 1000,
      resultBudgetBytes: 8 * 1024 * 1024,
      cellChars: 65536,
      bodyPrefixBytes: 262144,
      bodyCeilingBytes: 512 * 1024 * 1024,
      readWireBytes: 64 * 1024 * 1024,
      headerFrameMaxBytes: 536870912,
      headerValueRetainedBytes: 262144,
      headerTableRetainedBytes: 1024 * 1024,
      headerDepth: 8,
      frameMaxCeiling: 131072,
      frameMinBytes: 8192,
      heartbeatCeilingS: 60,
      closeOkWaitMs: 1000,
      lastHintBackstep: 50,
      amqp1DescriptorDepth: 4,
      payloadJsonDepth: 64,
      listingPageSize: 500,
      mgmtDepth: 64,
      mgmtRequestDeadlineMs: 15000,
      bindingsMaxRows: 1000,
      bindingsKeptBytes: 1024 * 1024,
      smallAnswerBytes: 64 * 1024,
      answerBytes: 1024 * 1024,
      bindingsAnswerBytes: 16 * 1024 * 1024,
      nameMaxBytes: 255,
      nameProseChars: 64,
      testCheckMaxVhosts: 6,
      testCheckMaxQueues: 50,
      testCheckDeadlineMs: 10000,
      cautionNamedQueues: 5,
      cautionMaxVhosts: 3,
    });
  });

  test("the type id every error is tagged with", () => {
    expect(String(limits.RABBITMQ_TYPE)).toBe("rabbitmq");
  });

  test("the readable-queue check stays inside the ranges its bounds may move in", () => {
    expect(limits.RABBITMQ_TEST_CHECK_MAX_VHOSTS).toBeGreaterThanOrEqual(1);
    expect(limits.RABBITMQ_TEST_CHECK_MAX_VHOSTS).toBeLessThanOrEqual(20);
    expect(limits.RABBITMQ_TEST_CHECK_MAX_QUEUES).toBeGreaterThanOrEqual(1);
    expect(limits.RABBITMQ_TEST_CHECK_MAX_QUEUES).toBeLessThanOrEqual(50);
    expect(limits.RABBITMQ_TEST_CHECK_DEADLINE_MS).toBeLessThanOrEqual(10_000);
  });

  test("the three limiters: their keys and bounds, frozen", () => {
    expect([
      limits.RABBITMQ_READ_LIMITER_KEY,
      limits.RABBITMQ_MANAGEMENT_LIMITER_KEY,
      limits.RABBITMQ_BINDINGS_LIMITER_KEY,
    ]).toEqual(["rabbitmq-read", "rabbitmq-management", "rabbitmq-bindings"]);
    expect(limits.RABBITMQ_READ_LIMITS).toEqual({ perProvider: 1, perEngine: 4, queueDepth: 16 });
    expect(limits.RABBITMQ_MANAGEMENT_LIMITS).toEqual({ perProvider: 4, perEngine: 16, queueDepth: 64 });
    expect(limits.RABBITMQ_BINDINGS_LIMITS).toEqual({ perProvider: 1, perEngine: 2, queueDepth: 16 });
    for (const options of [
      limits.RABBITMQ_READ_LIMITS,
      limits.RABBITMQ_MANAGEMENT_LIMITS,
      limits.RABBITMQ_BINDINGS_LIMITS,
    ])
      expect(Object.isFrozen(options)).toBe(true);
  });

  test("each limiter's bounds are ones the shared limiter accepts", () => {
    expect(() => engineLimiter("rabbitmq-limits-test-read", limits.RABBITMQ_READ_LIMITS)).not.toThrow();
    expect(() => engineLimiter("rabbitmq-limits-test-management", limits.RABBITMQ_MANAGEMENT_LIMITS)).not.toThrow();
    expect(() => engineLimiter("rabbitmq-limits-test-bindings", limits.RABBITMQ_BINDINGS_LIMITS)).not.toThrow();
  });
});

describe("the system clock and deadline signal", () => {
  test("now() reads the process clock", () => {
    const before = Date.now();
    const now = limits.SYSTEM_CLOCK.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  test("a timer fires once, and its cancel stops it and is safe to call twice", async () => {
    let fired = 0;
    limits.SYSTEM_CLOCK.setTimer(() => fired++, 1);
    const cancel = limits.SYSTEM_CLOCK.setTimer(() => fired++, 1);
    cancel();
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toBe(1);
  });

  test("the deadline signal aborts with a TimeoutError DOMException, which the node transport reads as a deadline", async () => {
    const signal = limits.systemDeadlineSignal(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect((signal.reason as DOMException).name).toBe("TimeoutError");
  });
});
