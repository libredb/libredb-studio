import { describe, expect, test } from "bun:test";
import { QueryError, ReadAllowanceExceededError } from "@/lib/db/errors";
import { READ_ALLOWANCE_PREFIX, RunReadAllowance } from "@/lib/db/read-allowance";

describe("RunReadAllowance", () => {
  test("starts with its whole limit remaining", () => {
    const allowance = new RunReadAllowance(10);
    expect(allowance.limit).toBe(10);
    expect(allowance.remaining()).toBe(10);
  });

  test("each charge draws the allowance down by its units", () => {
    const allowance = new RunReadAllowance(10);
    allowance.charge(3, "a catalog read");
    allowance.charge(4, "a statement");
    expect(allowance.remaining()).toBe(3);
  });

  test("a charge that spends exactly what is left is admitted", () => {
    const allowance = new RunReadAllowance(5);
    allowance.charge(2, "first");
    allowance.charge(3, "second");
    expect(allowance.remaining()).toBe(0);
  });

  test("a charge past the limit is refused before anything is spent, in a sentence that names the read", () => {
    const allowance = new RunReadAllowance(5);
    allowance.charge(4, "a catalog read");
    let refusal: unknown;
    try {
      allowance.charge(2, "the statement on orders");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ReadAllowanceExceededError);
    // A QueryError, so every caller that already settles a statement failure settles this one the same way.
    expect(refusal).toBeInstanceOf(QueryError);
    const message = (refusal as Error).message;
    expect(message.startsWith(READ_ALLOWANCE_PREFIX)).toBe(true);
    expect(message).toBe(
      `${READ_ALLOWANCE_PREFIX}: the statement on orders needs 2 billed reads, and 1 of the 5 this run may spend is left`,
    );
    // Refused whole: the failed charge took nothing, so a smaller read still fits.
    expect(allowance.remaining()).toBe(1);
    allowance.charge(1, "a smaller read");
    expect(allowance.remaining()).toBe(0);
  });

  test("once spent, every further charge is refused", () => {
    const allowance = new RunReadAllowance(1);
    allowance.charge(1, "the only read");
    expect(() => allowance.charge(1, "one more")).toThrow(ReadAllowanceExceededError);
    expect(allowance.remaining()).toBe(0);
  });

  test("concurrent statements of one run cannot both take the last unit", async () => {
    const allowance = new RunReadAllowance(3);
    allowance.charge(2, "earlier reads");
    // Two reads that reach their charge in the same tick, after each awaited something, as two in-flight
    // statements of one run would.
    const read = async (label: string): Promise<string> => {
      await Promise.resolve();
      allowance.charge(1, label);
      return label;
    };
    const settled = await Promise.allSettled([read("first"), read("second")]);
    expect(settled.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
    const rejected = settled[1];
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(ReadAllowanceExceededError);
    expect(allowance.remaining()).toBe(0);
  });

  test("two allowances are two ledgers: spending one leaves the other whole", () => {
    const first = new RunReadAllowance(4);
    const second = new RunReadAllowance(4);
    first.charge(4, "all of it");
    expect(second.remaining()).toBe(4);
  });

  test("reports what it has spent, the figure a run records so its next drive starts from it", () => {
    const allowance = new RunReadAllowance(10);
    expect(allowance.spent()).toBe(0);
    allowance.charge(3, "a read");
    expect(allowance.spent()).toBe(3);
  });

  test("an allowance opened with what earlier drives spent has only the rest left", () => {
    const allowance = new RunReadAllowance(10, { spent: 7 });
    expect(allowance.spent()).toBe(7);
    expect(allowance.remaining()).toBe(3);
    expect(() => allowance.charge(4, "the statement")).toThrow(
      `${READ_ALLOWANCE_PREFIX}: the statement needs 4 billed reads, and 3 of the 10 this run may spend is left`,
    );
    allowance.charge(3, "the rest");
    expect(allowance.spent()).toBe(10);
  });

  test("a recorded spend past the limit leaves nothing, not a negative balance", () => {
    // A run recorded under a larger limit and resumed under a smaller one.
    const allowance = new RunReadAllowance(10, { spent: 12 });
    expect(allowance.remaining()).toBe(0);
    expect(() => allowance.charge(1, "one more")).toThrow(ReadAllowanceExceededError);
  });

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "a recorded spend of %p is refused: what was spent is a whole number of reads, zero or more",
    (spent) => {
      expect(() => new RunReadAllowance(10, { spent })).toThrow(RangeError);
    },
  );

  test("an MCP call's allowance names the call, which has no run, in its refusal", () => {
    const allowance = new RunReadAllowance(5, { scope: "call" });
    expect(() => allowance.charge(6, "the statement")).toThrow(
      `${READ_ALLOWANCE_PREFIX}: the statement needs 6 billed reads, and 5 of the 5 this call may spend is left`,
    );
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "a limit of %p is refused: an allowance is a positive whole number of reads",
    (limit) => {
      expect(() => new RunReadAllowance(limit)).toThrow(RangeError);
    },
  );

  test.each([0, -2, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "a charge of %p units is a miswired caller, refused without spending anything",
    (units) => {
      const allowance = new RunReadAllowance(10);
      expect(() => allowance.charge(units, "a read")).toThrow(RangeError);
      expect(allowance.remaining()).toBe(10);
    },
  );
});

describe("ReadAllowanceExceededError", () => {
  test("keeps its own class and name through the QueryError constructor", () => {
    const error = new ReadAllowanceExceededError("probe", "postgres");
    expect(error).toBeInstanceOf(ReadAllowanceExceededError);
    expect(error.name).toBe("ReadAllowanceExceededError");
    expect(error.provider).toBe("postgres");
  });
});
