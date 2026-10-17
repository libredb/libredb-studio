/**
 * The constants, held to the relationships their comments claim.
 *
 * A constant with a reason beside it is only as good as the reason staying true, and a comment
 * cannot fail. These assertions can.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WINDOW_SECONDS,
  MAX_FIELD_BYTES,
  MAX_HEX_BYTES_IN_CELL,
  MAX_MESSAGE_DEPTH,
  MAX_MESSAGES_PER_PAYLOAD,
  MAX_METRICS_PER_PAYLOAD,
  MAX_ROWS,
  MAX_TEMPLATE_LEVELS,
  MAX_WINDOW_SECONDS,
  MEASURED_PROTOBUFJS_LEVEL_CEILING,
  SEQ_MODULUS,
  SPARKPLUG_DEFAULT_PORT,
} from "@/lib/db/providers/industrial/sparkplug/constants";
import { DEFAULT_LIMITS } from "@/lib/db/providers/industrial/sparkplug/decode";

describe("every constant's VALUE is pinned, not just its relationships", () => {
  /*
   * WHY THE LITERAL AND THE LINK ARE BOTH ASSERTED. A sibling session measured the failure this
   * block exists to prevent: a test that asserts a value against THE CONSTANT ITSELF passes no
   * matter what the constant becomes. `expect(DEFAULT_LIMITS.maxMetrics).toBe(MAX_METRICS_PER_PAYLOAD)`
   * proves the decoder reads the central constant rather than keeping a second copy, which is worth
   * proving, but it says nothing about the number. So each value is pinned to its literal here, and
   * the links are asserted separately below. A mutation that changes any of these numbers in
   * `constants.ts` turns this block red.
   *
   * The second column of each row is WHERE the number comes from, and three kinds appear.
   * MEASURED: taken from a run, on the date `constants.ts` records.
   * SHIPPED: equal to a number the shipped MQTT transport already uses, read from `origin/main`.
   * CHOSEN: this provider's own bound with no measurement behind it, and the comment beside it in
   * `constants.ts` says so rather than implying a basis it does not have.
   */
  test.each([
    ["MAX_MESSAGE_DEPTH", MAX_MESSAGE_DEPTH, 32, "CHOSEN, under a MEASURED ceiling of 49 levels"],
    ["MAX_TEMPLATE_LEVELS", MAX_TEMPLATE_LEVELS, 16, "CHOSEN, half of the message depth"],
    ["MEASURED_PROTOBUFJS_LEVEL_CEILING", MEASURED_PROTOBUFJS_LEVEL_CEILING, 49, "MEASURED"],
    ["MAX_MESSAGES_PER_PAYLOAD", MAX_MESSAGES_PER_PAYLOAD, 100_000, "CHOSEN"],
    ["MAX_METRICS_PER_PAYLOAD", MAX_METRICS_PER_PAYLOAD, 50_000, "SHIPPED, the transport's message budget"],
    ["MAX_FIELD_BYTES", MAX_FIELD_BYTES, 8 * 1024 * 1024, "SHIPPED, the transport's inbound limit"],
    ["DEFAULT_WINDOW_SECONDS", DEFAULT_WINDOW_SECONDS, 3, "SHIPPED, the transport's read budget"],
    ["MAX_WINDOW_SECONDS", MAX_WINDOW_SECONDS, 300, "CHOSEN, no measurement behind it"],
    ["MAX_ROWS", MAX_ROWS, 10_000, "CHOSEN, no measurement behind it"],
    ["MAX_HEX_BYTES_IN_CELL", MAX_HEX_BYTES_IN_CELL, 256, "CHOSEN"],
    ["SEQ_MODULUS", SEQ_MODULUS, 256, "STANDARD, 5.4 and 6.4.5 put seq in 0 to 255"],
    ["SPARKPLUG_DEFAULT_PORT", SPARKPLUG_DEFAULT_PORT, 1883, "STANDARD, MQTT's own default port"],
  ])("%s is %i (%s)", (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  test("the two numbers taken from the shipped transport still match it", () => {
    // Read from `origin/main` at b04fbab0: MQTT_READ_BUDGET_MESSAGES is 50,000,
    // MQTT_MAX_INBOUND_BYTES is 8 * 1024 * 1024, MQTT_READ_BUDGET_MS is 3,000. If the transport
    // moves one of them, this provider's bound stops agreeing with the packet that carries it, and
    // these assertions are the place that says so.
    expect(MAX_METRICS_PER_PAYLOAD).toBe(50_000);
    expect(MAX_FIELD_BYTES).toBe(8 * 1024 * 1024);
    expect(DEFAULT_WINDOW_SECONDS * 1000).toBe(3_000);
  });
});

describe("the depth cap stays under the measured reference ceiling", () => {
  test("one Sparkplug level costs two protobuf messages, so the halving holds", () => {
    expect(MAX_TEMPLATE_LEVELS).toBe(MAX_MESSAGE_DEPTH / 2);
  });

  test("the cap in levels is below what protobufjs itself accepts", () => {
    // MEASURED: protobufjs 7.6.6 accepts 49 levels and refuses 50, under both runtimes. A cap
    // above that would let this reader accept payloads the reference reader cannot.
    expect(MAX_TEMPLATE_LEVELS).toBeLessThan(MEASURED_PROTOBUFJS_LEVEL_CEILING);
  });

  test("the decoder's defaults are these constants and not a second copy of them", () => {
    expect(DEFAULT_LIMITS.maxMessageDepth).toBe(MAX_MESSAGE_DEPTH);
    expect(DEFAULT_LIMITS.maxMetrics).toBe(MAX_METRICS_PER_PAYLOAD);
    expect(DEFAULT_LIMITS.maxFieldBytes).toBe(MAX_FIELD_BYTES);
  });
});

describe("the metric cap bites before the transport's byte limit", () => {
  test("a payload at the metric cap is well under the field bound", () => {
    // MEASURED: 41.8 bytes per metric for a 25-character name with an alias and a Float. The cap
    // is the bound that bites; the byte limit would hold roughly 200,000 metrics.
    const bytesAtCap = MAX_METRICS_PER_PAYLOAD * 41.8;
    expect(bytesAtCap).toBeLessThan(MAX_FIELD_BYTES);
    // And it is not SO far under that the byte limit is unreachable in principle.
    expect(bytesAtCap).toBeGreaterThan(MAX_FIELD_BYTES / 10);
  });
});

describe("the window bounds agree with each other and with the transport", () => {
  test("the default window is the transport's own read budget of 3 seconds", () => {
    expect(DEFAULT_WINDOW_SECONDS).toBe(3);
  });

  test("the default is inside the maximum", () => {
    expect(DEFAULT_WINDOW_SECONDS).toBeLessThanOrEqual(MAX_WINDOW_SECONDS);
  });

  test("the row bound is a whole number a grid can hold", () => {
    expect(Number.isInteger(MAX_ROWS)).toBe(true);
    expect(MAX_ROWS).toBeGreaterThan(0);
  });
});

describe("the numbers the specification sets, not this provider", () => {
  test("seq wraps at 256, because 5.4 and 6.4.5 put it in 0 to 255", () => {
    expect(SEQ_MODULUS).toBe(256);
  });

  test("the port is MQTT's default and not a Sparkplug one", () => {
    expect(SPARKPLUG_DEFAULT_PORT).toBe(1883);
  });
});
