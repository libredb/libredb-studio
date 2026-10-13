/**
 * What TYPE a refusal is when it leaves this provider (#1722).
 *
 * WHY THE TYPE AND NOT THE MESSAGE. MEASURED on `origin/main`:
 * `providers/platform/kubernetes/objects.ts:348` turns a `QueryError` or a `TimeoutError` into
 * `{ unavailable: error.message }` and re-throws everything else, and `errors.ts:244` defines
 * `isQueryError` as `instanceof QueryError`. A refusal thrown as a plain `Error` is therefore
 * handled as an unexpected failure, and the sentence it carries never reaches the reader. The
 * message can be reworded; the type cannot change without breaking that handling, so these
 * assertions name the type.
 *
 * This provider HAD that defect in its first version: `MtcRefusal` and `MtcClientError` both derive
 * from `Error`, and only the `query()` path converted one of them. Every byte cap, every 8 KiB
 * request ceiling and every guard refusal from `connect()`, from the tree's reads and from an
 * asset's Source tab left as a plain `Error`.
 *
 * WHY THE PRIVATE SEAM IS ADDRESSED DIRECTLY. The provider builds its own transport inside
 * `connect()`, so there is no injection point for a refusing socket at this level; `client.test.ts`
 * covers the transport with its own fakes. What is asserted here is the conversion itself, which is
 * the part that was missing.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { MtcClientError, MTC_TARGET_BUDGET_BYTES } from "@/lib/db/providers/industrial/mtconnect/client";
import {
  assertCount,
  assertPathInSubset,
  MAX_ALTERNATIVES,
  MtcRefusal,
  type MtcGuardOptions,
  type MtcRequest,
  type MtcWindow,
} from "@/lib/db/providers/industrial/mtconnect/guard";
import {
  MTCONNECT_HEALTH_REQUEST,
  MTCONNECT_HEALTH_UNKNOWN,
} from "@/lib/db/providers/industrial/mtconnect/capabilities";
import { MTC_REQUEST_HEADER_BUDGET_BYTES } from "@/lib/db/providers/industrial/mtconnect/routes";
import { MTConnectProvider, ROW_CAP } from "@/lib/db/providers/industrial/mtconnect/index";

const boundary = MTConnectProvider.prototype as unknown as {
  asQueryError(error: unknown): unknown;
  guard(line: string, options: MtcGuardOptions): MtcRequest;
};

const OPTIONS: MtcGuardOptions = { rowCap: 10_000 };

describe("every refusal leaves as a QueryError", () => {
  test("a guard refusal does, and its sentence survives the conversion", () => {
    const refusal = new MtcRefusal("method", "PUT is not a method this provider sends.");
    const converted = boundary.asQueryError(refusal);
    expect(converted).toBeInstanceOf(QueryError);
    expect((converted as QueryError).message).toBe("PUT is not a method this provider sends.");
    // Named rather than implied: the thing that was wrong is that this answered false.
    expect(refusal instanceof QueryError).toBe(false);
  });

  test("a client refusal does too, which is the half nothing converted", () => {
    const refusal = new MtcClientError("unreadable", "The sample answer could not be read.");
    const converted = boundary.asQueryError(refusal);
    expect(converted).toBeInstanceOf(QueryError);
    expect((converted as QueryError).message).toBe("The sample answer could not be read.");
  });

  /**
   * The second case the first one needs (K-48): a conversion that returned a `QueryError` for
   * everything would pass both tests above, and would bury a programming fault as a query refusal.
   */
  test("an unrelated failure is passed through as itself, not dressed as a refusal", () => {
    const bug = new RangeError("Maximum call stack size exceeded");
    expect(boundary.asQueryError(bug)).toBe(bug);
    expect(boundary.asQueryError(bug)).not.toBeInstanceOf(QueryError);
  });

  test("the guard seam throws the converted type, so no caller has to remember to convert", () => {
    const run = () => boundary.guard.call(boundary, "PUT /probe", OPTIONS);
    expect(run).toThrow(QueryError);
    // And the rule it broke is still the sentence the reader gets.
    try {
      run();
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toContain("It sends GET and nothing else.");
    }
  });

  test("a line the guard accepts comes back as a request, so the seam is not refusing everything", () => {
    expect(boundary.guard.call(boundary, "GET /probe", OPTIONS).op).toBe("probe");
  });
});

/**
 * The DEFAULT row cap, which is a different question from "is the cap enforced" (#1722).
 *
 * MEASURED, and this is why the suite needed it: `ROW_CAP` could be set to 1 and every one of the
 * other tests in this directory would stay green, because each passes its own `rowCap: 10_000`
 * literal to the guard. That proves the mechanism and says nothing about the number the provider
 * actually sends, so a reader would get one row per read and nothing would go red.
 *
 * Both halves are held here: the literal the constant has to be, and the behaviour that number
 * produces when it reaches the guard the way the provider sends it.
 */
describe("the default row cap", () => {
  test("it is ten thousand, as a literal", () => {
    expect(ROW_CAP).toBe(10_000);
  });

  test("the number is what the guard refuses against, at the boundary and one past it", () => {
    const window: MtcWindow = {
      instanceId: "1",
      firstSequence: BigInt(1),
      lastSequence: BigInt(100_000),
      nextSequence: BigInt(100_001),
      bufferSize: BigInt(131_072),
    };
    // Accepted at the cap, refused one past it: the pair is what makes this the cap and not a floor.
    expect(assertCount("10000", window, ROW_CAP)).toBe(10_000);
    expect(() => assertCount("10001", window, ROW_CAP)).toThrow(MtcRefusal);
    // And the reader is told the number rather than that something was too large.
    try {
      assertCount("10001", window, ROW_CAP);
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toContain("10000");
    }
  });

  test("a negative count is bounded by the same number, because it is the newest N", () => {
    expect(assertCount("-10000", undefined, ROW_CAP)).toBe(-10_000);
    expect(() => assertCount("-10001", undefined, ROW_CAP)).toThrow(MtcRefusal);
  });
});

/**
 * The other numbers a mutation showed nothing was holding (#1722, KURAL 70).
 *
 * MEASURED by changing each definition in a copy of the tree and running this directory: `MAX_PATH_BYTES`
 * 4096 to 8 failed 10 tests and `MAX_PARAM_BYTES` 256 to 2 failed 8, so those two were already held. These
 * were not: `MAX_ALTERNATIVES` 32 to 2, the header overhead 512 to 7000, `DEVICE_TYPE_SINCE` "2.3" to "9.9"
 * and the health request "/sample?count=1" to "/probe" each left all 199 tests green.
 *
 * Two of those four turned out to be dead rather than untested, which a test could not have told me:
 * `DEVICE_TYPE_SINCE` was read by no code at all and is gone, and the two health constants were declared
 * in `capabilities.ts` while `index.ts` carried the same strings as literals. They are read now, which is
 * what makes the assertions below mean anything.
 */
describe("the numbers nothing was holding", () => {
  test("the alternative cap is thirty-two, and it is the cap rather than a floor", () => {
    expect(MAX_ALTERNATIVES).toBe(32);
    const path = (count: number) => Array.from({ length: count }, (_, index) => `//D${index}`).join("|");
    expect(() => assertPathInSubset(path(32))).not.toThrow();
    expect(() => assertPathInSubset(path(33))).toThrow(MtcRefusal);
  });

  test("the request budget is the 8 KiB ceiling less the room left for headers", () => {
    expect(MTC_REQUEST_HEADER_BUDGET_BYTES).toBe(8192);
    expect(MTC_TARGET_BUDGET_BYTES).toBe(7680);
    // Named as a subtraction, so moving either number alone moves this and fails here.
    expect(MTC_REQUEST_HEADER_BUDGET_BYTES - MTC_TARGET_BUDGET_BYTES).toBe(512);
  });

  test("the health request is the one read every schema version answers, and it is sent as written", () => {
    expect(MTCONNECT_HEALTH_REQUEST).toBe("/sample?count=1");
    // It has to be a route this provider's own guard accepts, or `connect()` refuses itself.
    expect(boundary.guard.call(boundary, MTCONNECT_HEALTH_REQUEST, OPTIONS).op).toBe("sample");
    expect(MTCONNECT_HEALTH_UNKNOWN).toBe("unknown");
  });
});
