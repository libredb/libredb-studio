import { describe, expect, test } from "bun:test";
import { BOUND_PARAMS_MESSAGE, readBoundParams } from "@/lib/api/bound-params";

// The parameter array is the channel that keeps a generated statement's values out
// of its grammar (#290), and it arrives from the client as JSON. What a driver does
// with a value it cannot bind is driver-specific — mysql2 and pg disagree about
// objects, and an unbindable element would surface as a confusing engine error at
// best — so the route decides what a parameter may be before the driver sees it.

describe("readBoundParams", () => {
  test("accepts an absent parameter list", () => {
    expect(readBoundParams(undefined)).toEqual({ valid: true, params: undefined });
  });

  test("accepts the scalar types JSON can carry", () => {
    expect(readBoundParams(["text", 42, true, null])).toEqual({ valid: true, params: ["text", 42, true, null] });
  });

  test("accepts an empty list", () => {
    expect(readBoundParams([])).toEqual({ valid: true, params: [] });
  });

  test("rejects a value that is not an array", () => {
    expect(readBoundParams("text")).toEqual({ valid: false, message: BOUND_PARAMS_MESSAGE });
    expect(readBoundParams(42)).toEqual({ valid: false, message: BOUND_PARAMS_MESSAGE });
    expect(readBoundParams({ 0: "text" })).toEqual({ valid: false, message: BOUND_PARAMS_MESSAGE });
    expect(readBoundParams(null)).toEqual({ valid: false, message: BOUND_PARAMS_MESSAGE });
  });

  test("rejects an element no driver binds as a scalar", () => {
    expect(readBoundParams([{ nested: true }])).toEqual({ valid: false, message: BOUND_PARAMS_MESSAGE });
    expect(readBoundParams([["nested"]])).toEqual({ valid: false, message: BOUND_PARAMS_MESSAGE });
    expect(readBoundParams([undefined])).toEqual({ valid: false, message: BOUND_PARAMS_MESSAGE });
  });

  test("names what is allowed, so a rejected request can be corrected", () => {
    expect(BOUND_PARAMS_MESSAGE).toContain("params");
  });
});
