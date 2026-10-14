/**
 * The bounded hand decoder of grpc-status-details-bin. Reference bytes are encoded with
 * protobufjs here, independently of the decoder, and the captured answers of tests/fixtures/spark/ are decoded both
 * ways and must agree. Every bound and malformed input answers undefined and never throws, except a map value over
 * 8 KiB, which drops its own key only. An exception that is not the decoder's own malformed signal is a defect and
 * propagates.
 */
import { describe, expect, test } from "bun:test";
import protobuf from "protobufjs";
import { readStatusDetails } from "@/lib/db/providers/sql/spark/status-details";
import { captureBytes, readSparkCapture, type SparkCaptureVersion } from "../../../helpers/spark-captures";
import { SPARK_CAPTURE_CATALOG, capturesOf } from "../../../live/spark-evidence-plan";

const TYPES = protobuf.Root.fromJSON({
  nested: {
    google: {
      nested: {
        rpc: {
          nested: {
            Status: {
              fields: {
                code: { type: "int32", id: 1 },
                message: { type: "string", id: 2 },
                details: { rule: "repeated", type: "Any", id: 3 },
              },
            },
            Any: { fields: { type_url: { type: "string", id: 1 }, value: { type: "bytes", id: 2 } } },
            ErrorInfo: {
              fields: {
                reason: { type: "string", id: 1 },
                domain: { type: "string", id: 2 },
                metadata: { keyType: "string", type: "string", id: 3 } as protobuf.IMapField,
              },
            },
          },
        },
      },
    },
  },
});
const Status = TYPES.lookupType("google.rpc.Status");
const Any = TYPES.lookupType("google.rpc.Any");
const ErrorInfo = TYPES.lookupType("google.rpc.ErrorInfo");
const ERROR_INFO_URL = "type.googleapis.com/google.rpc.ErrorInfo";

function errorInfo(reason: string, metadata: Readonly<Record<string, string>>): Uint8Array {
  return ErrorInfo.encode(ErrorInfo.create({ reason, domain: "org.apache.spark", metadata })).finish();
}
function status(
  details: readonly { readonly type_url: string; readonly value: Uint8Array }[],
  message = "boom",
): Uint8Array {
  return Status.encode(Status.create({ code: 13, message, details })).finish();
}
const sparkInfo = (metadata: Readonly<Record<string, string>>) => ({
  type_url: ERROR_INFO_URL,
  value: errorInfo("org.apache.spark.sql.AnalysisException", metadata),
});
/** One length-delimited field, written by hand for shapes the map encoder never emits. */
function delimited(field: number, bytes: Uint8Array): Uint8Array {
  return protobuf.Writer.create()
    .uint32((field << 3) | 2)
    .bytes(bytes)
    .finish();
}
const utf8 = (value: string) => new TextEncoder().encode(value);

/** The reference reading of the same bytes, with protobufjs. */
function reference(bytes: Uint8Array): Record<string, string> | undefined {
  const decoded = Status.decode(bytes) as unknown as {
    readonly details: readonly { readonly type_url: string; readonly value: Uint8Array }[];
  };
  const detail = decoded.details.find((candidate) => candidate.type_url === ERROR_INFO_URL);
  if (detail === undefined) return undefined;
  const info = ErrorInfo.decode(detail.value) as unknown as {
    readonly reason: string;
    readonly metadata: Readonly<Record<string, string>>;
  };
  const kept = ["errorClass", "sqlState", "errorId", "messageParameters"].filter((key) => key in info.metadata);
  return {
    ...(info.reason === "" ? {} : { reason: info.reason }),
    ...Object.fromEntries(kept.map((key) => [key, info.metadata[key] as string])),
  };
}

describe("well-formed details", () => {
  test("one ErrorInfo: the reason and the four kept keys; classes and other keys ignored", () => {
    const bytes = status([
      sparkInfo({
        classes: '["org.apache.spark.sql.AnalysisException"]',
        errorClass: "TABLE_OR_VIEW_NOT_FOUND",
        sqlState: "42P01",
        errorId: "7a1b",
        messageParameters: '{"relationName":"`t`"}',
        other: "x",
      }),
    ]);
    expect(readStatusDetails(bytes)).toStrictEqual({
      reason: "org.apache.spark.sql.AnalysisException",
      errorClass: "TABLE_OR_VIEW_NOT_FOUND",
      sqlState: "42P01",
      errorId: "7a1b",
      messageParameters: '{"relationName":"`t`"}',
    });
  });

  test("an ErrorInfo after a detail of another type is found, and the first ErrorInfo wins", () => {
    const bytes = status([
      { type_url: "type.googleapis.com/google.rpc.DebugInfo", value: new Uint8Array([10, 1, 120]) },
      sparkInfo({ errorClass: "FIRST" }),
      sparkInfo({ errorClass: "SECOND" }),
    ]);
    expect(readStatusDetails(bytes)?.errorClass).toBe("FIRST");
  });

  test("an Any whose value comes before its type_url is read", () => {
    const value = errorInfo("r", { sqlState: "42601" });
    const any = new Uint8Array([
      18,
      value.length,
      ...value,
      10,
      ERROR_INFO_URL.length,
      ...new TextEncoder().encode(ERROR_INFO_URL),
    ]);
    const bytes = new Uint8Array([26, any.length, ...any]);
    expect(readStatusDetails(bytes)).toStrictEqual({ reason: "r", sqlState: "42601" });
  });

  test("unknown fields of every allowed wire type are skipped", () => {
    const info = status([sparkInfo({ errorClass: "X" })]);
    const fixed64 = [0x21, 1, 2, 3, 4, 5, 6, 7, 8];
    const fixed32 = [0x2d, 1, 2, 3, 4];
    const varint = [0x30, 0x96, 0x01];
    expect(readStatusDetails(new Uint8Array([...fixed64, ...fixed32, ...varint, ...info]))?.errorClass).toBe("X");
  });

  test("an unknown field inside an Any and inside a map entry is skipped", () => {
    const encoder = new TextEncoder();
    const entry = new Uint8Array([10, 7, ...encoder.encode("errorId"), 18, 2, ...encoder.encode("e1"), 24, 1]);
    const value = new Uint8Array([26, entry.length, ...entry]);
    const url = encoder.encode(ERROR_INFO_URL);
    const any = new Uint8Array([10, url.length, ...url, 24, 5, 18, value.length, ...value]);
    expect(readStatusDetails(new Uint8Array([26, any.length, ...any]))).toStrictEqual({ errorId: "e1" });
  });

  test("a later map entry with the same key replaces the earlier one", () => {
    const first = errorInfo("r", { errorClass: "OLD" });
    const second = new Uint8Array([
      26,
      18,
      10,
      10,
      ...new TextEncoder().encode("errorClass"),
      18,
      4,
      ...new TextEncoder().encode("NEWW"),
    ]);
    const value = new Uint8Array([...first, ...second]);
    expect(readStatusDetails(status([{ type_url: ERROR_INFO_URL, value }]))?.errorClass).toBe("NEWW");
  });

  test("a tag whose value passes 2^53 is an unknown field, skipped whole by the wire type of its first byte", () => {
    const after = status([sparkInfo({ errorClass: "X" })]);
    const covering = (inner: Uint8Array) => [0x80 | (inner.length & 0x7f), inner.length >> 7, ...inner];
    // Wire type 2, field number 127 * 2^46: the value rounds past 2^53, and the wire type must not round with it.
    const rounded = [
      0x82,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x7f,
      ...covering(status([sparkInfo({ errorClass: "INNER" })])),
    ];
    expect(readStatusDetails(new Uint8Array([...rounded, ...after]))?.errorClass).toBe("X");
    // Wire type 2, field number 2^53 + 3, its high bit in the ninth byte: never field 3, the details field.
    const ninth = [
      0x9a,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x80,
      0x01,
      ...covering(Any.encode(sparkInfo({ errorClass: "INNER" })).finish()),
    ];
    expect(readStatusDetails(new Uint8Array([...ninth, ...after]))?.errorClass).toBe("X");
  });

  test("a leading byte order mark is text, so a key that starts with one is not a kept key", () => {
    const bom = String.fromCharCode(0xfeff);
    const value = errorInfo(`${bom}r`, { [`${bom}errorClass`]: "X", sqlState: `${bom}42000` });
    const bytes = status([{ type_url: ERROR_INFO_URL, value }]);
    expect(readStatusDetails(bytes)).toStrictEqual({ reason: `${bom}r`, sqlState: `${bom}42000` });
    expect(readStatusDetails(bytes)).toStrictEqual(reference(bytes));
  });

  test("a later entry over 8 KiB removes an earlier in-bound value of the same key", () => {
    const oversized = delimited(
      3,
      new Uint8Array([...delimited(1, utf8("errorClass")), ...delimited(2, utf8("p".repeat(8_193)))]),
    );
    const value = new Uint8Array([...errorInfo("r", { errorClass: "A" }), ...oversized]);
    expect(readStatusDetails(status([{ type_url: ERROR_INFO_URL, value }]))).toStrictEqual({ reason: "r" });
  });

  test("a kept key whose map entry has no value field is kept as the empty string", () => {
    const value = delimited(3, delimited(1, utf8("errorClass")));
    expect(readStatusDetails(status([{ type_url: ERROR_INFO_URL, value }]))).toStrictEqual({ errorClass: "" });
  });

  test("a reason present on the wire with length 0 is left out", () => {
    const entry = delimited(3, new Uint8Array([...delimited(1, utf8("sqlState")), ...delimited(2, utf8("42000"))]));
    const value = new Uint8Array([10, 0, ...entry]);
    expect(readStatusDetails(status([{ type_url: ERROR_INFO_URL, value }]))).toStrictEqual({ sqlState: "42000" });
  });

  test("no ErrorInfo is undefined, and an ErrorInfo with none of the kept fields is {}", () => {
    expect(readStatusDetails(status([]))).toBeUndefined();
    expect(readStatusDetails(new Uint8Array(0))).toBeUndefined();
    expect(
      readStatusDetails(status([{ type_url: "type.googleapis.com/google.rpc.RetryInfo", value: new Uint8Array(0) }])),
    ).toBeUndefined();
    expect(readStatusDetails(status([{ type_url: ERROR_INFO_URL, value: new Uint8Array(0) }]))).toStrictEqual({});
  });
});

describe("bounds", () => {
  test("16 details are read, 17 are refused", () => {
    const filler = { type_url: "type.googleapis.com/google.rpc.DebugInfo", value: new Uint8Array(0) };
    const sixteen = status([...Array.from({ length: 15 }, () => filler), sparkInfo({ errorClass: "X" })]);
    expect(readStatusDetails(sixteen)?.errorClass).toBe("X");
    const seventeen = status([...Array.from({ length: 16 }, () => filler), sparkInfo({ errorClass: "X" })]);
    expect(readStatusDetails(seventeen)).toBeUndefined();
  });

  test("65,536 bytes are read and 65,537 are refused", () => {
    const info = status([sparkInfo({ errorClass: "X" })], "");
    const pad = (total: number) => {
      const room = total - info.length - 4;
      const message = new Uint8Array([
        0x12,
        0x80 | (room & 0x7f),
        0x80 | ((room >> 7) & 0x7f),
        room >> 14,
        ...new Uint8Array(room).fill(97),
      ]);
      return new Uint8Array([...message, ...info]);
    };
    expect(pad(65_536).length).toBe(65_536);
    expect(readStatusDetails(pad(65_536))?.errorClass).toBe("X");
    expect(readStatusDetails(pad(65_537))).toBeUndefined();
  });

  test("a map value of 8,192 bytes is kept, and one of 8,193 drops its own key only", () => {
    const at = (length: number) =>
      readStatusDetails(
        status([sparkInfo({ errorClass: "C", sqlState: "42000", messageParameters: "p".repeat(length) })]),
      );
    expect(at(8_192)?.messageParameters).toHaveLength(8_192);
    expect(at(8_193)).toStrictEqual({
      reason: "org.apache.spark.sql.AnalysisException",
      errorClass: "C",
      sqlState: "42000",
    });
  });
});

describe("malformed input answers undefined and never throws", () => {
  const good = status([sparkInfo({ errorClass: "X" })]);
  const anyBytes = Any.encode({ type_url: ERROR_INFO_URL, value: errorInfo("r", { errorClass: "X" }) }).finish();
  test.each([
    ["a varint cut short", new Uint8Array([0x80])],
    ["a varint of eleven bytes", new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01])],
    ["a length past the end", new Uint8Array([26, 50, 10, 1])],
    [
      "a length past the end by its ninth byte",
      new Uint8Array([26, 0x80 | anyBytes.length, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, ...anyBytes]),
    ],
    ["a fixed64 field cut short", new Uint8Array([0x21, 1, 2])],
    ["a group wire type", new Uint8Array([0x1b, 0x1c])],
    ["wire type 7", new Uint8Array([0x0f])],
    [
      "wire type 7 in a tag whose value passes 2^53",
      new Uint8Array([0x87, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f, 0x00, ...good]),
    ],
    ["the Status cut in the middle", good.subarray(0, good.length - 3)],
    [
      "an ErrorInfo reason that is not UTF-8",
      status([{ type_url: ERROR_INFO_URL, value: new Uint8Array([10, 1, 0xff]) }]),
    ],
    ["a map entry cut short", status([{ type_url: ERROR_INFO_URL, value: new Uint8Array([26, 5, 10, 3, 97]) }])],
  ] as const)("%s", (_name, bytes) => {
    expect(() => readStatusDetails(bytes)).not.toThrow();
    expect(readStatusDetails(bytes)).toBeUndefined();
  });
});

describe("an exception that is not malformed input is a defect", () => {
  test("it propagates instead of answering undefined", () => {
    class Faulty extends Uint8Array {
      override subarray(): never {
        throw new RangeError("a defect, not malformed bytes");
      }
    }
    expect(() => readStatusDetails(new Faulty([26, 1, 0]))).toThrow("a defect, not malformed bytes");
  });
});

describe("the captured answers decode as protobufjs decodes them", () => {
  const VERSIONS: SparkCaptureVersion[] = ["4.2.0", "4.1.3"];
  test.each(VERSIONS)("every error capture of %s that carries details", (version) => {
    let decoded = 0;
    for (const entry of SPARK_CAPTURE_CATALOG.filter((candidate) => candidate.versions.includes(version))) {
      for (const name of capturesOf(entry)) {
        const capture = readSparkCapture(version, name);
        if (capture.outcome !== "error" || capture.metadata["grpc-status-details-bin"] === undefined) continue;
        const bytes = captureBytes(capture.metadata["grpc-status-details-bin"]);
        expect({ name, info: readStatusDetails(bytes) }).toStrictEqual({ name, info: reference(bytes) });
        decoded += 1;
      }
    }
    expect(decoded).toBeGreaterThan(0);
  });

  test("the syntax error carries Spark's class, SQL state and error id", () => {
    const capture = readSparkCapture("4.2.0", "error-syntax");
    if (capture.outcome !== "error") throw new Error("error-syntax is a pass capture");
    const info = readStatusDetails(captureBytes(capture.metadata["grpc-status-details-bin"]));
    expect(info?.errorClass).toMatch(/^[A-Z_]+(?:\.[A-Z_]+)*$/);
    expect(info?.sqlState).toMatch(/^[0-9A-Z]{5}$/);
    expect(typeof info?.errorId).toBe("string");
  });
});
