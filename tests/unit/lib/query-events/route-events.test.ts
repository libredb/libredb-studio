/**
 * The query events of the routes that run statements (src/lib/query-events/route-events.ts): what a route hands
 * `recordQueryEvent()` for a unit that ran and for a request refused before it ran. The sink is replaced, so each test
 * reads the input a route would record; the routes themselves are tested in tests/api/db/query.test.ts and
 * multi-query.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { QueryEventInput } from "@/lib/query-events/types";

const recorded: QueryEventInput[] = [];
mock.module("@/lib/query-events/sink", () => ({
  recordQueryEvent: (input: QueryEventInput) => {
    recorded.push(input);
  },
}));

const { queryEventRequest, recordExecutedUnit, recordRefusedRequest, requestedConnectionId } = await import(
  "@/lib/query-events/route-events"
);
const { mapDatabaseError, QueryCancelledError } = await import("@/lib/db/errors");
const { queryEventStart } = await import("@/lib/query-events/build");

const session = { role: "user" as const, username: "alice@example.com", idpSubject: "subject-1" };
const request = queryEventRequest("editor", session, { headers: new Headers() });
const connection = { id: "seed:orders", name: "Orders", type: "postgres" as const, createdAt: new Date(0) };

beforeEach(() => {
  recorded.length = 0;
});

describe("queryEventRequest", () => {
  test("names the session's subject, username and role, and the client address", () => {
    expect(request).toEqual({
      source: "editor",
      principal: { subject: "subject-1", username: "alice@example.com", role: "user" },
      clientIp: "unknown",
    });
  });

  test("a session without a subject is named by an empty one, which the builder refuses", () => {
    const { principal } = queryEventRequest("editor", { role: "admin", username: "root" }, { headers: new Headers() });
    expect(principal.subject).toBe("");
  });
});

describe("requestedConnectionId", () => {
  test("reads connectionId first, then the id an inline record claims", () => {
    expect(requestedConnectionId({ connectionId: "seed:a", connection: { id: "seed:b" } })).toBe("seed:a");
    expect(requestedConnectionId({ connection: { id: "seed:b" } })).toBe("seed:b");
  });

  test("answers undefined for a body that names no id", () => {
    expect(requestedConnectionId(null)).toBeUndefined();
    expect(requestedConnectionId("seed:a")).toBeUndefined();
    expect(requestedConnectionId({})).toBeUndefined();
    expect(requestedConnectionId({ connection: null })).toBeUndefined();
    expect(requestedConnectionId({ connection: { id: 7 } })).toBeUndefined();
  });
});

describe("recordExecutedUnit", () => {
  test("a success keeps a whole count and drops a count the driver did not report", () => {
    const started = queryEventStart();
    for (const rowCount of [4, 0, -1, 1.5, undefined]) {
      recordExecutedUnit(request, { connection, statement: "SELECT 1", started, ended: { rowCount } });
    }
    expect(recorded.map((input) => input.rowCount)).toEqual([4, 0, undefined, undefined, undefined]);
    expect(recorded[0]).toMatchObject({
      source: "editor",
      status: "success",
      statement: "SELECT 1",
      connection: { id: "seed:orders", name: "Orders", engine: "postgres", accessLevel: null },
    });
  });

  test("a governed record names the level of its credential", () => {
    recordExecutedUnit(request, {
      connection: { ...connection, grantLevel: "read" } as typeof connection,
      statement: "SELECT 1",
      started: queryEventStart(),
      ended: { rowCount: 1 },
    });
    expect(recorded[0].connection.accessLevel).toBe("read");
  });

  test("a failure records the driver's SQLSTATE, else the error's own code, else none", () => {
    const started = queryEventStart();
    const fail = (error: unknown) =>
      recordExecutedUnit(request, { connection, statement: "SELECT x", started, ended: { error } });
    fail(mapDatabaseError(Object.assign(new Error("column x does not exist"), { code: "42703" }), "postgres"));
    fail(mapDatabaseError(new Error("column x does not exist"), "postgres"));
    fail(Object.assign(new Error("refused"), { code: "SOME_CODE" }));
    fail("a thrown string");
    expect(recorded.map(({ status, errorCode, errorMessage }) => [status, errorCode, errorMessage])).toEqual([
      ["error", "42703", "column x does not exist"],
      ["error", "QUERY_ERROR", "column x does not exist"],
      ["error", "SOME_CODE", "refused"],
      ["error", undefined, "a thrown string"],
    ]);
  });

  test("a cancel records status cancelled", () => {
    recordExecutedUnit(request, {
      connection,
      statement: "SELECT pg_sleep(9)",
      started: queryEventStart(),
      ended: { error: new QueryCancelledError("The query was cancelled.") },
    });
    expect(recorded[0].status).toBe("cancelled");
  });
});

describe("recordRefusedRequest", () => {
  const refusal = Object.assign(new Error("refused"), { code: "CONNECTION_NOT_FOUND" });

  test("an unresolved connection is named by the requested id, without engine or level", () => {
    recordRefusedRequest(request, {
      requestedId: "seed:payroll",
      connection: undefined,
      statement: "SELECT 1",
      started: queryEventStart(),
      error: refusal,
    });
    expect(recorded[0]).toMatchObject({
      status: "refused",
      connection: { id: "seed:payroll", name: null, engine: null, accessLevel: null },
      errorCode: "CONNECTION_NOT_FOUND",
    });
  });

  test("a request that names no well-formed seed: id records nothing", () => {
    for (const requestedId of [undefined, "custom-1", "seed:Not_Valid"]) {
      recordRefusedRequest(request, {
        requestedId,
        connection: undefined,
        statement: "SELECT 1",
        started: queryEventStart(),
        error: refusal,
      });
    }
    expect(recorded).toEqual([]);
  });
});

describe("mapDatabaseError keeps the driver's SQLSTATE", () => {
  test("from code, sqlState or sqlstate, and only a five-character one", () => {
    const sqlstateOf = (fields: Record<string, unknown>) =>
      mapDatabaseError(Object.assign(new Error("failed"), fields), "postgres").sqlstate;
    expect(sqlstateOf({ code: "42P01" })).toBe("42P01");
    expect(sqlstateOf({ sqlState: "42000" })).toBe("42000");
    expect(sqlstateOf({ sqlstate: "42704" })).toBe("42704");
    expect(sqlstateOf({ code: "ECONNRESET" })).toBeUndefined();
    expect(sqlstateOf({ code: "EPIPE" })).toBeUndefined();
    expect(sqlstateOf({ code: "HY000" })).toBe("HY000");
    expect(sqlstateOf({})).toBeUndefined();
  });
});
