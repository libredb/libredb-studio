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
  assertSequence,
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
import type { MtcModel } from "@/lib/db/providers/industrial/mtconnect/model";
import type { QueryResult } from "@/lib/types";
import { guardOptionsFor, MTC_LIMITS, MTConnectProvider, ROW_CAP } from "@/lib/db/providers/industrial/mtconnect/index";

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

/**
 * The two settings the provider SENDS, as opposed to the rules that read them (#1722, KURAL 56).
 *
 * MEASURED in a copy of the tree: `window: session.window` changed to `undefined` where the request
 * options are built left all 202 tests green, and so did widening the limiter from one permit per
 * agent to eight. The rules themselves are tested - the guard refuses a sequence outside the buffer,
 * and the limiter is the shared one with its own suite - but what this provider hands them was held
 * by nothing, which is the difference between "the rule works" and "the rule is applied".
 *
 * The third setting of that family, `interval`, was already held: removing its entry from the refused
 * keys failed two tests. `scope` has nothing to hold, because `agentWalkScope` is not declared and
 * the measurement for that is in `capabilities.test.ts`.
 */
describe("the settings the provider sends", () => {
  const model = { devices: [{ name: "Mazak", uuid: "Mazak" }] } as unknown as MtcModel;
  const window: MtcWindow = {
    instanceId: "1",
    firstSequence: BigInt(10),
    lastSequence: BigInt(20),
    nextSequence: BigInt(21),
    bufferSize: BigInt(131_072),
  };

  test("the session's own window is carried, not dropped", () => {
    expect(guardOptionsFor({ window }, model).window).toBe(window);
    // And the consequence, through the rule that reads it: a sequence outside the buffer is refused
    // only because the window arrived.
    const options = guardOptionsFor({ window }, model);
    expect(() => assertSequence("from", "9", options.window)).toThrow(MtcRefusal);
    expect(assertSequence("from", "15", options.window)).toBe(BigInt(15));
    // With no window the same read is accepted, which is what the mutation silently turned on.
    expect(assertSequence("from", "9", undefined)).toBe(BigInt(9));
  });

  test("the row cap and the device names travel with it", () => {
    const options = guardOptionsFor({ window }, model);
    expect(options.rowCap).toBe(ROW_CAP);
    expect([...(options.knownDevices ?? [])].sort()).toEqual(["Mazak"]);
  });

  test("a session that has not read a window yet carries undefined rather than a guess", () => {
    expect(guardOptionsFor({ window: undefined }, model).window).toBeUndefined();
  });

  test("one request at a time per agent, and the two chosen numbers beside it", () => {
    expect(MTC_LIMITS.perProvider).toBe(1);
    expect(MTC_LIMITS.perEngine).toBe(4);
    expect(MTC_LIMITS.queueDepth).toBe(64);
  });
});

/**
 * WHAT A CAPPED READ SAYS ABOUT ITSELF (#1722).
 *
 * `readObservations` has reported `capped` since it was written, and `client.test.ts` asserts both
 * sides of it. The provider then THREW THAT RETURN VALUE AWAY: `streamed` was typed
 * `Promise<void>`, so a `sample` of more than ROW_CAP observations came back as exactly ROW_CAP
 * rows and nothing anywhere said the rest had been left behind. The half that was measured was the
 * half that already worked; this is the other side of the same separation, which is where the gap
 * was.
 *
 * Driven through the real `query()`, with the three seams it reaches stubbed on an instance of the
 * real class, because the wiring between the walk and the result IS the defect - asserting
 * `resultOf` alone would pass with `streamed` still dropping the flag.
 */
describe("a result says when this provider's row cap cut it", () => {
  const MODEL: MtcModel = {
    instanceId: "1",
    items: new Map(),
    devices: [{ name: "Mazak", uuid: "mazak-1", itemCount: 1 }],
  };
  const REQUEST = {
    op: "current",
    route: { op: "current" },
    params: {},
    query: {},
  } as unknown as MtcRequest;

  function providerWith(capped: boolean): { query(sql: string): Promise<QueryResult> } {
    const provider = Object.create(MTConnectProvider.prototype) as Record<string, unknown>;
    provider.require = () => ({ window: undefined });
    provider.model = async () => MODEL;
    provider.guard = () => REQUEST;
    provider.streamed = async () => ({ read: capped ? ROW_CAP : 2, capped });
    return provider as unknown as { query(sql: string): Promise<QueryResult> };
  }

  test("a cut read carries the bound the results strip renders", async () => {
    const result = await providerWith(true).query("GET /current");
    expect(result.pagination).toEqual({
      limit: ROW_CAP,
      offset: 0,
      hasMore: false,
      totalReturned: 0,
      wasLimited: true,
    });
  });

  test("a read that was not cut carries no pagination at all", async () => {
    // Absent rather than `wasLimited: false`, because the strip decides from the field's presence
    // and a present-but-false bound is a bound that was applied.
    const result = await providerWith(false).query("GET /current");
    expect(Object.hasOwn(result, "pagination")).toBe(false);
  });
});
