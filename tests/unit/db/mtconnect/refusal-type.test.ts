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
import { MtcClientError } from "@/lib/db/providers/industrial/mtconnect/client";
import { MtcRefusal, type MtcGuardOptions, type MtcRequest } from "@/lib/db/providers/industrial/mtconnect/guard";
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect/index";

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
