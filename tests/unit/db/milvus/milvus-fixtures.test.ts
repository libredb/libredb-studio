/**
 * The Milvus captures (vector-family spec 7.3), read through tests/helpers/milvus-fixtures.ts. This half pins the
 * reader's rules on values it builds itself; Task 16's half reads the captures the harness wrote.
 */
import { describe, expect, test } from "bun:test";
import {
  capturedAnswer,
  capturedFailure,
  MILVUS_FIXTURE_NAMES,
  type MilvusCapture,
  reviveMilvusFixture,
} from "../../../helpers/milvus-fixtures";

const provenance = {
  service: "milvus",
  image: "milvusdb/milvus:v3.0.2@sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0",
  version: "3.0.2",
  date: "2026-10-03",
  runtime: "bun 1.4.2",
  rpc: "Search",
  user: "root",
  surface: "s",
  request: {},
} as const;

describe("the capture reader's rules", () => {
  test("bytes, non-finite floats and nested values revive as grpc-js hands them over", () => {
    expect(
      reviveMilvusFixture({
        a: { $bytes: Buffer.from([1, 2, 255]).toString("base64") },
        scores: [{ $float: "Infinity" }, 0.5, { $float: "-Infinity" }],
        n: { $float: "NaN" },
        ids: { int_id: { data: ["469489107428444015"] } },
      }),
    ).toEqual({
      a: Buffer.from([1, 2, 255]),
      scores: [Number.POSITIVE_INFINITY, 0.5, Number.NEGATIVE_INFINITY],
      n: Number.NaN,
      ids: { int_id: { data: ["469489107428444015"] } },
    });
  });

  test("a gRPC failure revives as an error carrying its code, details and metadata, a missing code as undefined", () => {
    const failed: MilvusCapture = {
      $captured: provenance,
      outcome: "fail",
      payload: { error: { code: 16, details: "auth", message: "16 UNAUTHENTICATED: auth" } },
    };
    expect(capturedFailure(failed)).toMatchObject({ code: 16, details: "auth", message: "16 UNAUTHENTICATED: auth" });
    const broken: MilvusCapture = {
      $captured: provenance,
      outcome: "fail",
      payload: { error: { code: null, details: null, message: "x" } },
    };
    const error = capturedFailure(broken) as Error & { code?: unknown };
    expect(Object.hasOwn(error, "code")).toBe(true);
    expect(error.code).toBeUndefined();
  });

  test("a runtime throw revives as a plain error with its name and message", () => {
    const thrown: MilvusCapture = {
      $captured: provenance,
      outcome: "fail",
      payload: { error: { name: "Error", message: "key values mismatch" } },
    };
    const error = capturedFailure(thrown);
    expect(error.message).toBe("key values mismatch");
    expect(Object.hasOwn(error, "code")).toBe(false);
  });

  test("an answer is the revived payload, and asking for the failure of an answer, or the answer of a failure, throws", () => {
    const answered: MilvusCapture = {
      $captured: provenance,
      outcome: "pass",
      payload: { status: { code: 0 }, version: "3.0.2" },
    };
    expect(capturedAnswer(answered)).toEqual({ status: { code: 0 }, version: "3.0.2" });
    expect(() => capturedFailure(answered)).toThrow("holds an answer, not a failure");
    expect(() => capturedAnswer({ ...answered, payload: { error: { name: "Error", message: "x" } } })).toThrow(
      "holds a failure, not an answer",
    );
  });

  test("the catalog has 109 names, sorted, each under one of the three services", () => {
    expect(MILVUS_FIXTURE_NAMES).toHaveLength(109);
    expect([...MILVUS_FIXTURE_NAMES]).toEqual([...MILVUS_FIXTURE_NAMES].sort());
    for (const name of MILVUS_FIXTURE_NAMES) expect(name).toMatch(/^(milvus|milvus-tls|milvus-mtls)\/[a-z0-9_-]+$/);
  });
});
