/**
 * `expectCalls` (tests/helpers/call-log.ts), the assertion every refusal test of the vector family makes about the
 * calls a provider sent (vector-family spec 3.9): an empty log for phase 0, exactly the metadata calls for
 * phase 1, in order.
 */
import { describe, expect, test } from "bun:test";
import { type CallLog, type ExpectedCall, expectCalls, type LoggedCall } from "../helpers/call-log";

describe("expectCalls", () => {
  test("a log is an array of calls or an object carrying them as calls, and both read the same", () => {
    const calls: readonly LoggedCall[] = [
      { method: "DescribeCollection", args: ["docs"] },
      { method: "DescribeIndex" },
    ];
    const logs: readonly CallLog[] = [calls, { calls }];
    const expected: readonly ExpectedCall[] = [{ method: "DescribeCollection", args: ["docs"] }, "DescribeIndex"];
    for (const log of logs) expect(() => expectCalls(log, expected)).not.toThrow();
  });

  test("an empty log passes an empty expectation, the phase 0 case", () => {
    expect(() => expectCalls([], [])).not.toThrow();
  });

  test("a log holding any call fails an empty expectation", () => {
    expect(() => expectCalls([{ method: "DescribeCollection", args: [] }], [])).toThrow();
  });

  test("the methods must match in number and in order", () => {
    const log = [{ method: "DescribeCollection" }, { method: "DescribeIndex" }];
    expect(() => expectCalls(log, ["DescribeCollection", "DescribeIndex"])).not.toThrow();
    expect(() => expectCalls(log, ["DescribeIndex", "DescribeCollection"])).toThrow();
    expect(() => expectCalls(log, ["DescribeCollection"])).toThrow();
    expect(() => expectCalls(log, ["DescribeCollection", "DescribeIndex", "Search"])).toThrow();
  });

  test("an expected entry with arguments compares them deeply", () => {
    const log = [{ method: "GET /collections/{collection_name}", args: [{ collection: "docs" }] }];
    expect(() =>
      expectCalls(log, [{ method: "GET /collections/{collection_name}", args: [{ collection: "docs" }] }]),
    ).not.toThrow();
    expect(() =>
      expectCalls(log, [{ method: "GET /collections/{collection_name}", args: [{ collection: "plain" }] }]),
    ).toThrow();
  });

  test("a call recorded without arguments compares as an empty argument list", () => {
    expect(() => expectCalls([{ method: "ShowCollections" }], [{ method: "ShowCollections", args: [] }])).not.toThrow();
  });

  test("a fake client's log, an object carrying `calls`, is read the same way", () => {
    const fake = { calls: [{ method: "DescribeCollection", args: ["docs_int64"] }] };
    expect(() => expectCalls(fake, ["DescribeCollection"])).not.toThrow();
    expect(() => expectCalls(fake, [])).toThrow();
  });
});
