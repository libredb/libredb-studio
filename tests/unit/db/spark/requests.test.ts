/**
 * The request messages the Apache Spark provider sends: the fixed identity on every message,
 * the observed server-side session id once known, SqlCommand.input (field 6), the 4 MiB chunking option and no
 * reattach option on every ExecutePlan, Interrupt by tag, and a release that tombstones the id.
 */
import { describe, expect, test } from "bun:test";
import {
  configGetAllRequest,
  configGetOptionRequest,
  configSetRequest,
  fetchErrorDetailsRequest,
  interruptByTagRequest,
  relationRequest,
  releaseSessionRequest,
  type SparkSessionRef,
  sqlCommandRequest,
  versionRequest,
} from "@/lib/db/providers/sql/spark/requests";

const FRESH: SparkSessionRef = { sessionId: "5c0f9c1e-8d0a-4c4e-9b3a-2f8e6a1d7b90" };
const OBSERVED: SparkSessionRef = { ...FRESH, serverSideSessionId: "a1b2c3d4-0000-4000-8000-000000000001" };
const RUN = {
  operationId: "0e7c2d6a-1b3f-4a5e-8c9d-7f6a5b4c3d2e",
  tag: "libredb-studio-9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
};
const IDENTITY = {
  user_context: { user_id: "libredb-studio", user_name: "libredb-studio" },
  client_type: "libredb-studio",
};
const CHUNKING = [
  { result_chunking_options: { allow_arrow_batch_chunking: true, preferred_arrow_chunk_size: 4_194_304 } },
];

describe("ExecutePlan", () => {
  test("a statement is sent as SqlCommand.input, with the run's ids, the chunking option and no reattach option", () => {
    expect(sqlCommandRequest(FRESH, "SHOW TABLES", RUN)).toEqual({
      session_id: FRESH.sessionId,
      ...IDENTITY,
      operation_id: RUN.operationId,
      tags: [RUN.tag],
      request_options: CHUNKING,
      plan: { command: { sql_command: { input: { sql: { query: "SHOW TABLES" } } } } },
    });
  });

  test("the relation step sends the command step's relation as the plan root, the same tag and the same option", () => {
    const relation = { sql: { query: "SELECT 1" }, rel_type: "sql" };
    const request = relationRequest(OBSERVED, relation, { operationId: "op-2", tag: RUN.tag }) as Record<
      string,
      unknown
    >;
    expect(request).toEqual({
      session_id: OBSERVED.sessionId,
      client_observed_server_side_session_id: OBSERVED.serverSideSessionId,
      ...IDENTITY,
      operation_id: "op-2",
      tags: [RUN.tag],
      request_options: CHUNKING,
      plan: { root: relation },
    });
    expect(JSON.stringify(request)).not.toContain("reattach");
  });
});

describe("control requests", () => {
  test("Config set, get_option and get_all", () => {
    expect(
      configSetRequest(FRESH, [
        ["spark.sql.variable.substitute", "false"],
        ["a", "b"],
      ]),
    ).toEqual({
      session_id: FRESH.sessionId,
      ...IDENTITY,
      operation: {
        set: {
          pairs: [
            { key: "spark.sql.variable.substitute", value: "false" },
            { key: "a", value: "b" },
          ],
        },
      },
    });
    expect(configGetOptionRequest(OBSERVED, ["spark.sql.ansi.enabled"])).toEqual({
      session_id: OBSERVED.sessionId,
      client_observed_server_side_session_id: OBSERVED.serverSideSessionId,
      ...IDENTITY,
      operation: { get_option: { keys: ["spark.sql.ansi.enabled"] } },
    });
    expect(configGetAllRequest(FRESH, "spark.sql.catalog.")).toEqual({
      session_id: FRESH.sessionId,
      ...IDENTITY,
      operation: { get_all: { prefix: "spark.sql.catalog." } },
    });
  });

  test("AnalyzePlan spark_version, Interrupt by tag and FetchErrorDetails", () => {
    expect(versionRequest(FRESH)).toEqual({ session_id: FRESH.sessionId, ...IDENTITY, spark_version: {} });
    expect(interruptByTagRequest(OBSERVED, RUN.tag)).toEqual({
      session_id: OBSERVED.sessionId,
      client_observed_server_side_session_id: OBSERVED.serverSideSessionId,
      ...IDENTITY,
      interrupt_type: "INTERRUPT_TYPE_TAG",
      operation_tag: RUN.tag,
    });
    expect(fetchErrorDetailsRequest(FRESH, "err-1")).toEqual({
      session_id: FRESH.sessionId,
      ...IDENTITY,
      error_id: "err-1",
    });
  });

  test("ReleaseSession has no observed-id field and asks for no reconnect, so Spark tombstones the id", () => {
    expect(releaseSessionRequest(OBSERVED)).toEqual({
      session_id: OBSERVED.sessionId,
      ...IDENTITY,
      allow_reconnect: false,
    });
  });
});

describe("every message is fresh", () => {
  test("no two calls share an object, so a caller's change never reaches another request", () => {
    const first = sqlCommandRequest(FRESH, "SELECT 1", RUN) as { request_options: unknown[]; user_context: object };
    const second = sqlCommandRequest(FRESH, "SELECT 1", RUN) as { request_options: unknown[]; user_context: object };
    expect(first.request_options).not.toBe(second.request_options);
    expect(first.user_context).not.toBe(second.user_context);
    const pairs: [string, string][] = [["k", "v"]];
    const request = configSetRequest(FRESH, pairs) as { operation: { set: { pairs: { key: string }[] } } };
    pairs[0] = ["changed", "x"];
    expect(request.operation.set.pairs[0]?.key).toBe("k");
  });
});
