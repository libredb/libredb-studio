/**
 * The InfluxDB evidence harness's own checks (InfluxDB spec 8, E22, K10), held without a server: how a cut body is
 * named, the admin read that proves the database that does not exist holds nothing, which policy a plan text is
 * judged by, and the fixed credentials read from database-compose.yml and docker/influxdb/seed.sh.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type InfluxCapture, loadInfluxCapture } from "../../helpers/influxdb-fixtures";
import {
  cutOf,
  type FixtureCredentials,
  midLineSlice,
  nowhereProblem,
  policyVerdict,
  readFixtureCredentials,
} from "../../live/influxdb-evidence-checks";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

describe("cutOf (K10)", () => {
  const bytes = (text: string) => Buffer.from(text, "utf8");

  test("a complete body is not cut, whatever it ends with", () => {
    expect(cutOf(true, bytes(""))).toBeUndefined();
    expect(cutOf(true, bytes('{"q":0}'))).toBeUndefined();
  });

  test("an incomplete body is zero-byte, mid-line or line-end by what arrived", () => {
    expect(cutOf(false, bytes(""))).toBe("zero-byte");
    expect(cutOf(false, bytes('{"q":0}\n{"q'))).toBe("mid-line");
    expect(cutOf(false, bytes('{"q":0}\n{"q":0}\n'))).toBe("line-end");
  });

  test("names each committed truncation capture by the label it carries, over the bytes it holds (R39)", () => {
    for (const name of ["sql-truncated-zero", "sql-truncated", "sql-truncated-mid-line"]) {
      const capture = loadInfluxCapture("3.12.0-core", name);
      const received = bytes(capture.body);
      expect([name, cutOf(false, received), received.length]).toEqual([name, capture.cut, capture.bytes]);
    }
  });
});

describe("midLineSlice (R39)", () => {
  const source = (overrides: Partial<InfluxCapture> = {}): InfluxCapture => ({
    version: "3.12.0-core",
    name: "sql-truncated",
    image: "influxdb:3.12.0-core@sha256:0",
    capturedAt: "2026-10-04",
    request: { method: "POST", path: "/api/v3/query_sql", query: {}, body: { q: "SELECT 1" }, auth: "bearer" },
    status: 200,
    contentType: "application/jsonl",
    body: '{"q":0}\n{"q":10}\n',
    cut: "line-end",
    bytes: 17,
    ...overrides,
  });

  test("cuts inside the last line, keeps the source's answer, and names the source and the offset", () => {
    expect(midLineSlice(source(), "sql-truncated-mid-line")).toEqual({
      ...source(),
      name: "sql-truncated-mid-line",
      body: '{"q":0}\n{"q"',
      cut: "mid-line",
      bytes: 12,
      synthetic:
        "SYNTHETIC (R39): the first 12 of the 17 bytes of sql-truncated.json, cut inside its last line; " +
        "3.12.0 flushes whole lines, so its truncation never ends inside one.",
    });
  });

  test("the slice of the committed line-end capture is the committed mid-line capture", () => {
    expect(midLineSlice(loadInfluxCapture("3.12.0-core", "sql-truncated"), "sql-truncated-mid-line")).toEqual(
      loadInfluxCapture("3.12.0-core", "sql-truncated-mid-line"),
    );
  });

  test("a single-line body is cut inside that line", () => {
    expect(midLineSlice(source({ body: '{"q":10}\n', bytes: 9 }), "x").body).toBe('{"q"');
  });

  test("a source that is not a line-end cut, or whose last line is too short to cut, stops the run", () => {
    expect(() => midLineSlice(source({ cut: "zero-byte", body: "", bytes: 0 }), "x")).toThrow(
      "sql-truncated is cut zero-byte, not line-end: nothing to slice",
    );
    expect(() => midLineSlice(source({ cut: undefined, bytes: undefined }), "x")).toThrow(
      "sql-truncated is cut none, not line-end: nothing to slice",
    );
    expect(() => midLineSlice(source({ body: '{"q":0}\n1\n', bytes: 10 }), "x")).toThrow(
      "sql-truncated ends in a line of 1 byte: nothing to cut inside",
    );
  });
});

describe("nowhereProblem (E22)", () => {
  const answer = (overrides: Partial<Parameters<typeof nowhereProblem>[0]> = {}) => ({
    status: 200,
    body: '{"results":[{"statement_id":0}]}\n',
    ...overrides,
  });

  test("an empty result, and 3.x's database-not-found statement error, prove the database holds nothing", () => {
    expect(nowhereProblem(answer())).toBeUndefined();
    const v3 =
      '{"results":[{"statement_id":0,"error":"Cannot retrieve database: External error: database not found: x"}]}';
    expect(nowhereProblem(answer({ body: v3 }))).toBeUndefined();
  });

  test("a series fails the run", () => {
    const body = '{"results":[{"statement_id":0,"series":[{"name":"measurements","values":[["m"]]}]}]}';
    expect(nowhereProblem(answer({ body }))).toBe("result 0 holds series");
  });

  test("a read that did not succeed proves nothing", () => {
    expect(nowhereProblem(answer({ cut: "zero-byte" }))).toBe("the answer was cut (zero-byte)");
    expect(nowhereProblem(answer({ status: 401, body: '{"error":"authorization failed"}' }))).toBe(
      "status 401, not 200",
    );
    expect(nowhereProblem(answer({ status: 500, body: "" }))).toBe("status 500, not 200");
    expect(nowhereProblem(answer({ body: "" }))).toBe("the body is not one JSON document");
    expect(nowhereProblem(answer({ body: '{"results":[]}{"results":[]}' }))).toBe("the body is not one JSON document");
    expect(nowhereProblem(answer({ body: '{"error":"json: unsupported value: +Inf"}' }))).toBe(
      "the body holds no results",
    );
    expect(nowhereProblem(answer({ body: '{"results":[]}' }))).toBe("the body holds no results");
    expect(nowhereProblem(answer({ body: '{"results":[{"statement_id":0,"error":"authorization failed"}]}' }))).toBe(
      'result 0 failed: "authorization failed"',
    );
    expect(nowhereProblem(answer({ body: '{"results":[null]}' }))).toBe("result 0 is not an object");
  });
});

describe("policyVerdict (E22)", () => {
  test("judges an InfluxQL text by the InfluxQL policy and a SQL text by the SQL policy", () => {
    // A regex holding a semicolon is one InfluxQL statement and a refused SQL text; a WITH is the other way round.
    const regex = 'SELECT * FROM "home" WHERE "room" =~ /a;b/';
    const withQuery = "WITH x AS (SELECT 1) SELECT * FROM x";
    expect([policyVerdict("influxql", regex).allowed, policyVerdict("sql", regex).allowed]).toEqual([true, false]);
    expect([policyVerdict("influxql", withQuery).allowed, policyVerdict("sql", withQuery).allowed]).toEqual([
      false,
      true,
    ]);
  });
});

describe("readFixtureCredentials", () => {
  test("reads the admin principals from database-compose.yml and the 1.x reader from seed.sh", () => {
    const credentials: FixtureCredentials = readFixtureCredentials(
      read("database-compose.yml"),
      read("docker/influxdb/seed.sh"),
    );
    // The fixed test credentials the compose file and seed.sh set (docker/influxdb/README.md, "The principals").
    expect(credentials).toEqual({
      v1Admin: { user: "admin", password: "password123" },
      v1Reader: { user: "reader", password: "readonly123" },
      v2OperatorToken: "libredb-influxdb2-operator-token",
      v3AdminToken: "apiv3_libredb-influxdb3-admin-token",
    });
  });

  test("a value missing from either file stops the run, naming it", () => {
    const seed = read("docker/influxdb/seed.sh");
    const compose = read("database-compose.yml");
    expect(() => readFixtureCredentials("services: {}\n", seed)).toThrow(
      "database-compose.yml: services.influxdb1.environment.INFLUXDB_ADMIN_USER is not set",
    );
    expect(() => readFixtureCredentials(compose, "#!/bin/sh\n")).toThrow(
      "docker/influxdb/seed.sh: V1_READER_USER is not set",
    );
  });
});
