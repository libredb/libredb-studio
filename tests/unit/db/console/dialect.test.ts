/**
 * The console's refusal class (vector-family spec 3.4 and 3.9): a request refused before its execution call carries
 * the validation phase whose rule refused it, and the body key it names, and is a QueryError like every other
 * refusal a provider raises.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { RequestRefusal } from "@/lib/db/console/dialect";

describe("RequestRefusal", () => {
  test("a phase 0 refusal names no key unless it is given one", () => {
    const refusal = new RequestRefusal("The key exprParams is not accepted here.", 0);
    expect(refusal).toBeInstanceOf(QueryError);
    expect(refusal).toBeInstanceOf(RequestRefusal);
    expect({ name: refusal.name, message: refusal.message, phase: refusal.phase, key: refusal.key }).toEqual({
      name: "RequestRefusal",
      message: "The key exprParams is not accepted here.",
      phase: 0,
      key: null,
    });
  });

  test("a phase 1 refusal carries its phase and the body key it names", () => {
    const refusal = new RequestRefusal("annsField names a field no index covers.", 1, "annsField");
    expect({ phase: refusal.phase, key: refusal.key }).toEqual({ phase: 1, key: "annsField" });
  });

  test("is a query error the API maps as one, with the query error code", () => {
    const refusal = new RequestRefusal("refused", 0);
    expect(refusal.code).toBe(new QueryError("x").code);
  });
});
