/**
 * The console's four commands, and the bounds this module enforces because nothing else does.
 *
 * The SMI bounds are here rather than further down for a measured reason: on 13 October 2026 the
 * client library's own MIB parser accepted 130 sub-identifiers, a 66-character descriptor and a
 * sub-identifier above 2^32-1, all three of which RFC 2578 forbids.
 */
import { describe, expect, test } from "bun:test";
import {
  bulkVarbindCount,
  checkBulkRequest,
  DEFAULT_WALK_BUDGET,
  MAX_REPETITIONS_CAP,
  MAX_VARBINDS_PER_REQUEST,
  MEASURED_VARBINDS_CARRIED,
  MEASURED_VARBINDS_REFUSED,
  parseNumericOid,
  parseObjectName,
  parseStatement,
  StatementError,
} from "@/lib/db/providers/network/snmp/statement";

describe("an object name reads in three forms", () => {
  test("a numeric OID, with or without a leading dot", () => {
    expect(parseObjectName("1.3.6.1.2.1.1.1.0")).toEqual({ form: "numeric", oid: [1, 3, 6, 1, 2, 1, 1, 1, 0] });
    expect(parseObjectName(".1.3.6.1")).toEqual({ form: "numeric", oid: [1, 3, 6, 1] });
  });
  test("a descriptor with an instance", () => {
    expect(parseObjectName("sysDescr.0")).toEqual({ form: "descriptor", descriptor: "sysDescr", instance: [0] });
  });
  test("a descriptor with no instance", () => {
    expect(parseObjectName("ifTable")).toEqual({ form: "descriptor", descriptor: "ifTable", instance: undefined });
  });
  test("a module-qualified descriptor", () => {
    expect(parseObjectName("IF-MIB::ifInOctets.3")).toEqual({
      form: "qualified",
      module: "IF-MIB",
      descriptor: "ifInOctets",
      instance: [3],
    });
  });
});

describe("the SMI's bounds are enforced here because the library does not", () => {
  test("129 sub-identifiers, where RFC 2578 section 3.5 allows 128", () => {
    expect(() => parseNumericOid(Array(129).fill("1").join("."))).toThrow(StatementError);
    expect(() => parseNumericOid(Array(128).fill("1").join("."))).not.toThrow();
  });
  test("a sub-identifier above 2^32-1", () => {
    expect(() => parseNumericOid("1.3.4294967296")).toThrow(StatementError);
    expect(() => parseNumericOid("1.3.4294967295")).not.toThrow();
  });
  test("a 65-character descriptor, where RFC 2578 section 3.1 allows 64", () => {
    expect(() => parseObjectName(`a${"b".repeat(64)}`)).toThrow(StatementError);
    expect(() => parseObjectName(`a${"b".repeat(63)}`)).not.toThrow();
  });
  test("a descriptor that is not one", () => {
    expect(() => parseObjectName("9lives")).toThrow(StatementError);
    expect(() => parseObjectName("has space")).toThrow(StatementError);
  });
  test("an empty name or an empty OID", () => {
    expect(() => parseObjectName("")).toThrow(StatementError);
    expect(() => parseNumericOid(".")).toThrow(StatementError);
  });
});

describe("the four commands, and the ones that are not commands", () => {
  test("get and next take one or more objects", () => {
    expect(parseStatement(["get", "sysDescr.0", "sysName.0"]).command).toBe("get");
    expect(parseStatement(["next", "1.3.6.1.2.1.1"]).command).toBe("next");
  });
  test("walk takes a subtree and an optional limit", () => {
    const walked = parseStatement(["walk", "1.3.6.1.2.1.2.2"]);
    expect(walked.command).toBe("walk");
    // The key is absent rather than present and undefined, which is the difference between
    // "no limit was asked for" and "a limit was asked for and it is nothing".
    expect("limit" in walked).toBe(false);
    expect(parseStatement(["walk", "ifTable", "limit", "25"])).toMatchObject({ command: "walk", limit: 25 });
  });
  test("a limit above the row budget is refused", () => {
    expect(() => parseStatement(["walk", "ifTable", "limit", String(DEFAULT_WALK_BUDGET.rows + 1)])).toThrow(
      StatementError,
    );
  });
  test("a limit that is not a whole number", () => {
    expect(() => parseStatement(["walk", "ifTable", "limit", "0"])).toThrow(StatementError);
    expect(() => parseStatement(["walk", "ifTable", "limit", "2.5"])).toThrow(StatementError);
  });
  test("table takes exactly one table", () => {
    expect(parseStatement(["table", "ifTable"]).command).toBe("table");
    expect(() => parseStatement(["table", "ifTable", "ifXTable"])).toThrow(StatementError);
  });
  test("a write command is refused by name, saying what this provider is", () => {
    for (const write of ["set", "trap", "inform"]) {
      expect(() => parseStatement([write, "sysName.0"])).toThrow(/reads and never writes/);
    }
  });
  test("bulkwalk is refused with its reason, not as an unknown word", () => {
    expect(() => parseStatement(["bulkwalk", "ifTable"])).toThrow(/uses GetBulk already/);
  });
  test("an unknown command lists the four", () => {
    expect(() => parseStatement(["select", "*"])).toThrow(/get, next, walk and table/);
  });
  test("an empty statement", () => {
    expect(() => parseStatement([])).toThrow(StatementError);
  });
});

describe("a request too large to send is stopped before it is sent", () => {
  test("a Get beyond the varbind bound is refused, and says it is not an answer", () => {
    const many = Array(MAX_VARBINDS_PER_REQUEST + 1).fill("1.3.6.1.2.1.1.1.0");
    expect(() => parseStatement(["get", ...many])).toThrow(/never sent/);
  });
  test("a Get at the bound is allowed", () => {
    const many = Array(MAX_VARBINDS_PER_REQUEST).fill("1.3.6.1.2.1.1.1.0");
    expect(() => parseStatement(["get", ...many])).not.toThrow();
  });
});

describe("a GetBulk is sized before it is sent, by RFC 3416 section 4.2.3", () => {
  test("N + (M * R)", () => {
    expect(bulkVarbindCount(1, 10, 3)).toBe(31);
    expect(bulkVarbindCount(0, 25, 1)).toBe(25);
  });
  test("max-repetitions is capped", () => {
    expect(() => checkBulkRequest(0, MAX_REPETITIONS_CAP + 1, 1)).toThrow(/capped/);
    expect(() => checkBulkRequest(0, MAX_REPETITIONS_CAP, 1)).not.toThrow();
  });
  test("max-repetitions below one", () => {
    expect(() => checkBulkRequest(0, 0, 1)).toThrow(StatementError);
  });
  test("a bulk whose product exceeds the varbind bound is refused", () => {
    expect(() => checkBulkRequest(0, 50, 20)).toThrow(/would draw 1000 varbinds/);
  });
});

/**
 * The boundary tests below say `MAX_VARBINDS_PER_REQUEST + 1`, so they follow the
 * constant wherever it is moved and hold the mechanism without holding the number. These two
 * hold the number, between the measurement it came from and the batch size it has to serve.
 */
describe("the varbind cap is a number, not just a mechanism", () => {
  /**
   * The two measurements are written out as the numbers they are, not compared with
   * themselves. Anchoring the chain on a literal is what stops a later edit from moving the
   * cap and its justification together and leaving the test agreeing with both.
   */
  test("the measurements the cap rests on are the ones that were taken", () => {
    expect(MEASURED_VARBINDS_CARRIED).toBe(500);
    expect(MEASURED_VARBINDS_REFUSED).toBe(600);
  });

  test("it sits below the count that was measured to be refused outright", () => {
    expect(MAX_VARBINDS_PER_REQUEST).toBeLessThan(MEASURED_VARBINDS_REFUSED);
    expect(MAX_VARBINDS_PER_REQUEST).toBeLessThanOrEqual(MEASURED_VARBINDS_CARRIED);
  });

  test("it is large enough to carry one GetBulk's worth of repetitions", () => {
    expect(MAX_VARBINDS_PER_REQUEST).toBeGreaterThanOrEqual(MAX_REPETITIONS_CAP);
  });

  /**
   * This one looks like it asserts nothing, and it is the only test here that holds the number.
   *
   * Measured on 13 October 2026: with only the two bounds above, moving the cap to 401 or to 200
   * turned nothing red, because a range cannot hold an exact value. The cap is a choice inside a
   * measured safe range and not a figure derived from anything, so the only thing that can hold
   * it is a written statement of the choice. Its job is to make a change to the cap a decision
   * somebody took on purpose rather than a drift nobody saw.
   */
  test("the cap chosen inside that range is four hundred", () => {
    expect(MAX_VARBINDS_PER_REQUEST).toBe(400);
  });
});

describe("a walk whose tail is neither empty nor a limit", () => {
  test("is refused with the shape the command takes", () => {
    // `walk <subtree>` and `walk <subtree> limit <n>` are the two forms. Anything between them
    // is a typo rather than a third form, and the refusal names the two rather than guessing
    // which one was meant.
    expect(() => parseStatement(["walk", "1.3.6.1.2.1.1", "10"])).toThrow(/takes one subtree/);
    expect(() => parseStatement(["walk", "1.3.6.1.2.1.1", "rows", "10"])).toThrow(/optional `limit/);
  });
});
