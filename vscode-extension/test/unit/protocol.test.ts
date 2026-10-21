import assert from "node:assert/strict";
import type { EditorQueryBody } from "@/lib/api/editor-query";
import type { TestConnectionAnswer } from "@/lib/api/test-connection";
import {
  type BackendErrorCode,
  type BackendErrorData,
  EXIT_NOTIFICATION,
  METHODS,
  PROTOCOL_VERSION,
  type QueryPage,
  type TestConnectionResult,
} from "../../src/protocol";

describe("the backend protocol", () => {
  it("names each method as part 1's method table does", () => {
    assert.deepEqual(METHODS, {
      initialize: "initialize",
      testConnection: "connection/test",
      openConnection: "connection/open",
      closeConnection: "connection/close",
      listContainers: "objects/containers",
      countObjects: "objects/counts",
      listObjects: "objects/list",
      describeObject: "objects/describe",
      runQuery: "query/run",
      cancelQuery: "query/cancel",
      shutdown: "shutdown",
      listEngines: "engines/list",
      parsePastedConnection: "connection/parse",
    });
    assert.equal(EXIT_NOTIFICATION, "exit");
    assert.equal(PROTOCOL_VERSION, 1);
  });

  it("carries the query route's body and Test Connection's answer as they are", () => {
    const body: EditorQueryBody = {
      rows: [{ n: 1 }],
      fields: ["n"],
      rowCount: 1,
      executionTime: 3,
      pagination: { limit: 2, offset: 0, hasMore: false, totalReturned: 1, wasLimited: false },
    };
    const page: QueryPage = { ...body, resultSetCount: 2 };
    const degraded: TestConnectionAnswer = {
      success: true,
      degraded: true,
      message: "Connected, but this server answered no health data: x",
    };
    const result: TestConnectionResult = degraded;
    assert.equal(page.resultSetCount, 2);
    assert.equal(result.success, true);
  });

  it("types an error's data.code as the route's ApiErrorCode or one of the six the extension adds", () => {
    const route: BackendErrorData = { code: "CONNECTION_ERROR", retryable: true };
    const added: BackendErrorCode[] = [
      "CONNECTION_NOT_OPEN",
      "SHUTTING_DOWN",
      "PROTOCOL_MISMATCH",
      "RUNTIME_UNSUPPORTED",
      "TEXT_TOO_LARGE",
      "CANCEL_UNSUPPORTED",
    ];
    // @ts-expect-error The union is closed: a code outside both is a type error.
    const outside: BackendErrorCode = "NOT_A_CODE";
    assert.equal(route.code, "CONNECTION_ERROR");
    assert.equal(new Set(added).size, 6);
    assert.equal(outside, "NOT_A_CODE");
  });
});
