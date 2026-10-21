import assert from "node:assert/strict";
import type { EditorQueryBody } from "@/lib/api/editor-query";
import type { TestConnectionAnswer } from "@/lib/api/test-connection";
import type { ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import {
  type BackendErrorCode,
  type BackendErrorData,
  EXIT_NOTIFICATION,
  METHODS,
  PROTOCOL_VERSION,
  type ProviderDescription,
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
      selectStatement: "objects/selectStatement",
      runTarget: "query/target",
    });
    assert.equal(EXIT_NOTIFICATION, "exit");
    assert.equal(PROTOCOL_VERSION, 1);
  });

  it("gives no two methods one name", () => {
    assert.equal(new Set(Object.values(METHODS)).size, Object.keys(METHODS).length);
  });

  it("describes an open connection with its editor language", () => {
    const capabilities = { supportsQueryCancel: true } as ProviderCapabilities & { supportsQueryCancel: boolean };
    const labels = {} as ProviderLabels;
    const description: ProviderDescription = { capabilities, labels, editorLanguage: "sql" };
    // @ts-expect-error A description without its editor language is a type error.
    const without: ProviderDescription = { capabilities, labels };
    assert.equal(description.editorLanguage, "sql");
    assert.equal(without.editorLanguage, undefined);
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
