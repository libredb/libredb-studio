/**
 * The checks of the InfluxDB evidence harness (tests/live/influxdb-evidence.ts) that need no server, kept apart so
 * tests/unit/live/influxdb-evidence-checks.test.ts holds them: how a body the server ended early is named (K10), the
 * admin read after the run that must prove the database that does not exist holds nothing (E22), which policy a plan
 * text is judged by (E22), and the fixed test credentials, read from the files that set them (spec 8).
 */
import { evaluateInfluxql } from "@/lib/db/providers/timeseries/influxdb/influxql-policy";
import { evaluateInfluxSql } from "@/lib/db/providers/timeseries/influxdb/sql-policy";
import { parse } from "yaml";
import type { InfluxCapture } from "../helpers/influxdb-fixtures";

/**
 * A body that ended before its terminating chunk: "zero-byte" when nothing arrived, "mid-line" when it stops inside
 * a line, "line-end" when rows streamed and the last one arrived whole. Each is recorded under its own name (R39);
 * 3.12.0 flushes whole lines, so a "mid-line" capture is the synthetic slice of `midLineSlice`.
 */
export type BodyCut = "zero-byte" | "mid-line" | "line-end";

export function cutOf(complete: boolean, received: Uint8Array): BodyCut | undefined {
  if (complete) return undefined;
  if (received.length === 0) return "zero-byte";
  return received[received.length - 1] === 0x0a ? "line-end" : "mid-line";
}

/**
 * The synthetic mid-line capture of R39: the first bytes of a real "line-end" capture, cut in the middle of its last
 * line, with everything else the server answered kept and a `synthetic` field naming the source and the offset. A
 * source that is not a "line-end" cut, or whose last line has fewer than two bytes, stops the run.
 */
export function midLineSlice(source: InfluxCapture, name: string): InfluxCapture {
  if (source.cut !== "line-end") {
    throw new Error(`${source.name} is cut ${source.cut ?? "none"}, not line-end: nothing to slice`);
  }
  const received = new TextEncoder().encode(source.body);
  const lineStart = received.lastIndexOf(0x0a, received.length - 2) + 1;
  const lineBytes = received.length - 1 - lineStart;
  if (lineBytes < 2) throw new Error(`${source.name} ends in a line of ${lineBytes} byte: nothing to cut inside`);
  const offset = lineStart + Math.floor(lineBytes / 2);
  return {
    ...source,
    name,
    body: new TextDecoder("utf-8", { fatal: true }).decode(received.subarray(0, offset)),
    cut: "mid-line",
    bytes: offset,
    synthetic:
      `SYNTHETIC (R39): the first ${offset} of the ${received.length} bytes of ${source.name}.json, cut inside its ` +
      "last line; 3.12.0 flushes whole lines, so its truncation never ends inside one.",
  };
}

/** The one statement error that still proves the database holds nothing: 3.x refuses a database it does not have. */
const NOT_FOUND = /database not found/;

/**
 * Why the admin read of the database that does not exist fails to prove it holds no series, or undefined when it
 * proves it: a 200, one complete results document, and every result empty or a "database not found" error.
 */
export function nowhereProblem(answer: {
  readonly status: number;
  readonly body: string;
  readonly cut?: string;
}): string | undefined {
  if (answer.cut !== undefined) return `the answer was cut (${answer.cut})`;
  if (answer.status !== 200) return `status ${answer.status}, not 200`;
  let document: unknown;
  try {
    document = JSON.parse(answer.body);
  } catch {
    return "the body is not one JSON document";
  }
  const results = (document as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return "the body holds no results";
  for (const [index, result] of results.entries()) {
    if (typeof result !== "object" || result === null) return `result ${index} is not an object`;
    const { series, error } = result as { series?: unknown; error?: unknown };
    if (series !== undefined) return `result ${index} holds series`;
    if (error !== undefined && !(typeof error === "string" && NOT_FOUND.test(error))) {
      return `result ${index} failed: ${JSON.stringify(error)}`;
    }
  }
  return undefined;
}

/** A plan text judged by its own type's policy: `evaluateInfluxql` for InfluxQL, `evaluateInfluxSql` for SQL. */
export function policyVerdict(
  language: "influxql" | "sql",
  text: string,
): { readonly allowed: boolean; readonly message?: string } {
  return language === "sql" ? evaluateInfluxSql(text) : evaluateInfluxql(text);
}

export interface FixtureCredentials {
  readonly v1Admin: { readonly user: string; readonly password: string };
  readonly v1Reader: { readonly user: string; readonly password: string };
  readonly v2OperatorToken: string;
  readonly v3AdminToken: string;
}

/**
 * The fixed test credentials, from the files that set them: the admin principals from database-compose.yml (the
 * 1.x admin user, the 2.x operator token, the 3.x admin token), the 1.x reader from docker/influxdb/seed.sh, which
 * creates it. A value either file does not set stops the run.
 */
export function readFixtureCredentials(composeText: string, seedText: string): FixtureCredentials {
  const services = ((parse(composeText) as { services?: Record<string, { environment?: unknown }> }).services ??
    {}) as Record<string, { environment?: Record<string, unknown> }>;
  const fromCompose = (service: string, name: string): string => {
    const value = services[service]?.environment?.[name];
    if (typeof value !== "string" || value === "") {
      throw new Error(`database-compose.yml: services.${service}.environment.${name} is not set`);
    }
    return value;
  };
  const fromSeed = (name: string): string => {
    const value = new RegExp(`^${name}="([^"]+)"$`, "m").exec(seedText)?.[1];
    if (value === undefined) throw new Error(`docker/influxdb/seed.sh: ${name} is not set`);
    return value;
  };
  return {
    v1Admin: {
      user: fromCompose("influxdb1", "INFLUXDB_ADMIN_USER"),
      password: fromCompose("influxdb1", "INFLUXDB_ADMIN_PASSWORD"),
    },
    v1Reader: { user: fromSeed("V1_READER_USER"), password: fromSeed("V1_READER_PASSWORD") },
    v2OperatorToken: fromCompose("influxdb2", "DOCKER_INFLUXDB_INIT_ADMIN_TOKEN"),
    v3AdminToken: fromCompose("influxdb3", "LIBREDB_INFLUXDB3_TOKEN"),
  };
}
