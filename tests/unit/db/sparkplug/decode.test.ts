/**
 * The reader's bounds, each one built by hand so the test does not depend on an encoder.
 *
 * Deep payloads are assembled byte by byte on purpose: MEASURED by this session on 2026-10-13,
 * protobufjs 7.6.6's own `fromObject` overflows the stack at 100 Sparkplug levels under both
 * Bun 1.4.2 and Node 24.14.0, so an encoder cannot produce this test's input at all.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIMITS,
  decodePayload,
  MEASURED_PROTOBUFJS_LEVEL_CEILING,
  PayloadRefused,
  schemaFields,
  schemaMessageNames,
} from "@/lib/db/providers/industrial/sparkplug/decode";

/** A base-128 varint, the same encoding the reader reads. */
function varint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let digit = Number(v & BigInt(0x7f));
    v >>= BigInt(7);
    if (v > BigInt(0)) digit |= 0x80;
    out.push(digit);
  } while (v > BigInt(0));
  return out;
}

const tag = (field: number, wire: number) => varint((field << 3) | wire);
const delimited = (field: number, body: number[]) => [...tag(field, 2), ...varint(body.length), ...body];

/** `Metric { datatype = <n> }`, the leaf every nested payload below ends in. */
const leafMetric = (datatype = 10) => [...tag(4, 0), ...varint(datatype)];

/** Wrap a Metric body in `Metric { template_value = Template { metrics = <it> } }`. */
function oneLevelDeeper(metricBody: number[]): number[] {
  const template = delimited(2, metricBody); // Template.metrics
  return delimited(18, template); // Metric.template_value
}

/** A Payload holding one metric nested `levels` template levels deep. */
function nested(levels: number): Uint8Array {
  let metric = leafMetric();
  for (let i = 0; i < levels; i++) metric = oneLevelDeeper(metric);
  return new Uint8Array(delimited(2, metric)); // Payload.metrics
}

function refusal(run: () => unknown): PayloadRefused {
  try {
    run();
  } catch (error) {
    if (error instanceof PayloadRefused) return error;
    throw error;
  }
  throw new Error("the payload was read, but a refusal was expected");
}

describe("an ordinary payload reads into plain values", () => {
  test("a small NBIRTH-shaped payload", () => {
    const metric = [
      ...delimited(1, [...new TextEncoder().encode("ints/i8")]), // name
      ...tag(2, 0),
      ...varint(2), // alias
      ...tag(4, 0),
      ...varint(1), // datatype Int8
      ...tag(10, 0),
      ...varint(4294967295), // int_value, Tahu's form for -1
    ];
    const payload = new Uint8Array([
      ...tag(1, 0),
      ...varint(1760000000000), // timestamp
      ...delimited(2, metric),
      ...tag(3, 0),
      ...varint(0), // seq
    ]);
    const read = decodePayload(payload);
    expect(read.timestamp).toBe("1760000000000");
    expect(read.seq).toBe("0");
    const metrics = read.metrics as Record<string, unknown>[];
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ name: "ints/i8", alias: "2", datatype: "1", intValue: "4294967295" });
  });

  test("every integer comes back as decimal text, so 2^64-1 survives", () => {
    const payload = new Uint8Array([...tag(1, 0), ...varint(BigInt("18446744073709551615"))]);
    expect(decodePayload(payload).timestamp).toBe("18446744073709551615");
  });

  test("a repeated field collects instead of overwriting", () => {
    const payload = new Uint8Array([...delimited(2, leafMetric(1)), ...delimited(2, leafMetric(2))]);
    expect(decodePayload(payload).metrics).toHaveLength(2);
  });

  test("a float is read little-endian", () => {
    const metric = [...tag(12, 5), 0x00, 0x00, 0xc0, 0x3f];
    const metrics = decodePayload(new Uint8Array(delimited(2, metric))).metrics as Record<string, unknown>[];
    expect(metrics[0].floatValue).toBe(1.5);
  });
});

describe("the depth cap holds, and sits under the measured reference ceiling", () => {
  test("the default cap is below what protobufjs itself can read", () => {
    // MEASURED: protobufjs 7.6.6 accepts 49 Sparkplug levels and refuses 50. A cap above that
    // would let this reader accept payloads the reference reader cannot, which makes the
    // differential test impossible to run.
    const levels = Math.floor(DEFAULT_LIMITS.maxMessageDepth / 2);
    expect(levels).toBeLessThan(MEASURED_PROTOBUFJS_LEVEL_CEILING);
  });

  test("one level under the cap is read", () => {
    // 32 messages counting the Payload: the Payload is depth 1, so 15 template levels fit.
    expect(() => decodePayload(nested(15))).not.toThrow();
  });

  test("one level over the cap is refused, naming the cap", () => {
    const refused = refusal(() => decodePayload(nested(16)));
    expect(refused.reason).toBe("depth-cap");
    expect(refused.message).toContain("32");
    expect(refused.message).toContain("16 template levels");
  });

  test("a payload nested far past the cap is refused quickly, not walked", () => {
    // The payload is built OUTSIDE the timed region. The first version of this test timed the
    // build as well and failed at 273 ms against a 250 ms bound, measuring the test's own
    // byte assembly rather than the reader. The reader's work is what is bounded here.
    const payload = nested(5_000);
    const started = performance.now();
    expect(refusal(() => decodePayload(payload)).reason).toBe("depth-cap");
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("a tighter cap refuses what the default accepts", () => {
    const tight = { ...DEFAULT_LIMITS, maxMessageDepth: 4 };
    expect(() => decodePayload(nested(1), tight)).not.toThrow();
    expect(refusal(() => decodePayload(nested(8), tight)).reason).toBe("depth-cap");
  });
});

describe("a declared length is checked against the bytes left, before anything is taken", () => {
  test("sixteen bytes declaring two gigabytes are refused by the field bound", () => {
    // The shape protobufjs answers with `index out of range`; this reader names the bound instead.
    const payload = new Uint8Array([0x12, 0xff, 0xff, 0xff, 0xff, 0x07, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(refusal(() => decodePayload(payload)).reason).toBe("field-too-large");
  });

  test("a length past the end but inside the field bound is refused too", () => {
    const payload = new Uint8Array([...tag(5, 2), ...varint(5000), 1, 2, 3]);
    const refused = refusal(() => decodePayload(payload));
    expect(refused.reason).toBe("declared-length-past-end");
    expect(refused.message).toContain("3 left");
  });

  test("a payload that ends inside a varint is refused as truncated", () => {
    expect(refusal(() => decodePayload(new Uint8Array([0x08, 0x80]))).reason).toBe("truncated");
  });

  test("a payload that ends inside a fixed64 is refused as truncated", () => {
    expect(refusal(() => decodePayload(new Uint8Array([...delimited(2, [...tag(13, 1), 1, 2, 3])]))).reason).toBe(
      "truncated",
    );
  });

  test("a varint past ten groups is not a varint", () => {
    const payload = new Uint8Array([0x08, ...Array(12).fill(0x80), 0x01]);
    expect(refusal(() => decodePayload(payload)).reason).toBe("varint-too-long");
  });
});

describe("what the reader refuses rather than guesses", () => {
  test("a protobuf group marker is refused", () => {
    const payload = new Uint8Array([...tag(1, 3)]);
    expect(refusal(() => decodePayload(payload)).reason).toBe("group-wire-type");
  });

  test("a wire type outside the five is refused", () => {
    const payload = new Uint8Array([...tag(1, 6)]);
    expect(refusal(() => decodePayload(payload)).reason).toBe("unknown-wire-type");
  });

  test("a known field arriving with the wrong wire type is refused, not coerced", () => {
    // `timestamp` is a varint; here it arrives length-delimited. The wire type is one of the five,
    // so the refusal comes from the field dispatch rather than from the wire-type check.
    const payload = new Uint8Array([...delimited(1, [1, 2, 3])]);
    const refused = refusal(() => decodePayload(payload));
    expect(refused.reason).toBe("unknown-wire-type");
    expect(refused.message).toContain("timestamp");
  });

  test("the metric cap is named when it is hit", () => {
    const limits = { ...DEFAULT_LIMITS, maxMetrics: 3 };
    const many = Array.from({ length: 4 }, () => delimited(2, leafMetric())).flat();
    expect(refusal(() => decodePayload(new Uint8Array(many), limits)).reason).toBe("metric-cap");
  });

  test("THE MESSAGE CAP ACTUALLY TRIPS, which it did not before this test existed", () => {
    /*
     * MEASURED DEFECT, and the measurement is the reason this test is here. The counters used to
     * live on the reader, and a reader is built per message, so every nested message restarted
     * them: the message cap could never trip at all. A payload of 201 messages decoded in full
     * under a cap of 5.
     *
     * The literal value of the cap was pinned by a test the whole time. Lowering it turned exactly
     * one test red, and that test was the one asserting the number. The mechanism had no test, so
     * "the bound exists" and "the bound works" were different claims and only the first was held.
     */
    const limits = { ...DEFAULT_LIMITS, maxMessages: 5, maxMetrics: 999_999 };
    const many = Array.from({ length: 200 }, () => delimited(2, leafMetric())).flat();
    const refused = refusal(() => decodePayload(new Uint8Array(many), limits));
    expect(refused.reason).toBe("message-cap");
    expect(refused.message).toContain("5");
    // And the same payload is read when the cap allows it, so the test is not passing on an
    // unrelated failure.
    expect(() => decodePayload(new Uint8Array(many), { ...DEFAULT_LIMITS, maxMessages: 500 })).not.toThrow();
  });

  test("the METRIC cap counts a whole payload, not each message separately", () => {
    /*
     * The second half of the same defect. The metric counter was per message too, so ten templates
     * each holding nine metrics came to ninety metrics and passed a cap of ten. MEASURED before the
     * fix: that payload decoded in full.
     */
    const nested = Array.from({ length: 10 }, () => {
      const inner = Array.from({ length: 9 }, () => delimited(2, leafMetric())).flat();
      return delimited(2, [...leafMetric(), ...delimited(18, inner)]);
    }).flat();
    const refused = refusal(() => decodePayload(new Uint8Array(nested), { ...DEFAULT_LIMITS, maxMetrics: 10 }));
    expect(refused.reason).toBe("metric-cap");
    // A hundred metrics is the real total; a cap above it reads the payload.
    expect(() => decodePayload(new Uint8Array(nested), { ...DEFAULT_LIMITS, maxMetrics: 200 })).not.toThrow();
  });

  test("the field bound is named when it is hit", () => {
    const limits = { ...DEFAULT_LIMITS, maxFieldBytes: 4 };
    const payload = new Uint8Array([...delimited(5, [1, 2, 3, 4, 5])]);
    expect(refusal(() => decodePayload(payload, limits)).reason).toBe("field-too-large");
  });
});

describe("unknown fields are skipped, which is what an extension looks like", () => {
  test.each([
    ["a varint", [...tag(99, 0), ...varint(7)]],
    ["a fixed64", [...tag(99, 1), 1, 2, 3, 4, 5, 6, 7, 8]],
    ["a fixed32", [...tag(99, 5), 1, 2, 3, 4]],
    ["a delimited field", [...delimited(99, [1, 2, 3])]],
  ])("%s in an unknown field is skipped and the rest still reads", (_label, unknown) => {
    const payload = new Uint8Array([...unknown, ...tag(3, 0), ...varint(42)]);
    const read = decodePayload(payload);
    expect(read.seq).toBe("42");
    expect(read["99"]).toBeUndefined();
  });

  test("the Metric extension field (19) is skipped rather than read", () => {
    const metric = [...leafMetric(), ...delimited(19, [...tag(1, 0), ...varint(1)])];
    const metrics = decodePayload(new Uint8Array(delimited(2, metric))).metrics as Record<string, unknown>[];
    expect(metrics[0].datatype).toBe("10");
    expect(Object.keys(metrics[0])).not.toContain("extensionValue");
  });
});

describe("the schema table covers the eleven messages the payload can hold", () => {
  test("every message the table names has at least one field", () => {
    for (const name of schemaMessageNames()) {
      expect(Object.keys(schemaFields(name)).length).toBeGreaterThan(0);
    }
  });

  test("the field numbers the proposal's sections depend on are the ones in the table", () => {
    // Read off Tahu's sparkplug_b.proto at the digest named in decode.ts. A drift test against the
    // vendored copy replaces this once the proto is vendored, which is a pending decision.
    expect(schemaFields("Metric")[18]?.name).toBe("templateValue");
    expect(schemaFields("Metric")[10]?.name).toBe("intValue");
    expect(schemaFields("Metric")[11]?.name).toBe("longValue");
    expect(schemaFields("Payload")[2]?.name).toBe("metrics");
    expect(schemaFields("DataSet")[3]?.name).toBe("types");
    expect(schemaFields("Template")[5]?.name).toBe("isDefinition");
  });
});
