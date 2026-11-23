/**
 * A refinement `open` answers only narrows the manifest's calls, and any other refinement is refused by name
 * (docs/providers/CONTRACT.md, clause C-10).
 *
 * The declared calls offer cancel and not endScope and honour both request fields; each case asserts the exact
 * refusal list, every pointer rooted at the refinement.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type CallRefusal,
  CallRefusalError,
  callRefusalSentence,
  checkRefinement,
  type Refinement,
  sessionCalls,
} from "@libredb/provider-sdk/calls";
import type { Calls } from "@libredb/provider-sdk/manifest";

const DECLARED: Calls = Object.freeze({
  console: Object.freeze({
    execute: Object.freeze({ honours: Object.freeze(["params", "offset"] as const) }),
    cancel: "offered",
    endScope: "not-offered",
    transaction: "not-offered",
  }),
});

/** Declared calls that honour only `params`. */
const PARAMS_ONLY: Calls = { console: { ...DECLARED.console, execute: { honours: ["params"] } } };

function refused(rule: CallRefusal["rule"], pointer: string, name?: string): CallRefusal {
  return name === undefined ? { rule, pointer } : { rule, pointer, name };
}

/** Whether every object and array in `value` is frozen. */
function deepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

describe("checkRefinement and sessionCalls", () => {
  test("a refinement that narrows the declared calls is admitted, and the session's calls are the narrowed ones", () => {
    const narrowing: Refinement = {
      calls: { console: { cancel: "not-offered", execute: { honours: ["params"] } } },
    };

    for (const refine of [undefined, {}, { calls: {} }, { calls: { console: {} } }]) {
      expect(checkRefinement(DECLARED, refine)).toEqual([]);
      const calls = sessionCalls(DECLARED, refine);
      expect(calls).toEqual(DECLARED);
      expect(deepFrozen(calls)).toBe(true);
    }
    expect(checkRefinement(DECLARED, narrowing)).toEqual([]);
    const calls = sessionCalls(DECLARED, narrowing);
    expect(calls).toEqual({
      console: {
        execute: { honours: ["params"] },
        cancel: "not-offered",
        endScope: "not-offered",
        transaction: "not-offered",
      },
    });
    expect(deepFrozen(calls)).toBe(true);
    expect(DECLARED.console.cancel).toBe("offered");
    expect(DECLARED.console.execute.honours).toEqual(["params", "offset"]);
    const unfrozen: Calls = {
      console: { execute: { honours: ["params"] }, cancel: "offered", endScope: "offered", transaction: "offered" },
    };
    expect(deepFrozen(sessionCalls(unfrozen, { calls: { console: { endScope: "not-offered" } } }))).toBe(true);
    expect(Object.isFrozen(unfrozen.console.execute.honours)).toBe(false);
  });

  test("a refinement that widens a declared value is refused as refinement-widens", () => {
    const endScope = { calls: { console: { endScope: "offered" } } };
    const offset = { calls: { console: { execute: { honours: ["offset"] } } } };

    expect(checkRefinement(DECLARED, endScope)).toEqual([refused("refinement-widens", "/calls/console/endScope")]);
    expect(checkRefinement(PARAMS_ONLY, offset)).toEqual([
      refused("refinement-widens", "/calls/console/execute/honours/0"),
    ]);
    let thrown: unknown;
    try {
      sessionCalls(DECLARED, endScope as Refinement);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CallRefusalError);
    expect((thrown as CallRefusalError).refusals).toEqual([refused("refinement-widens", "/calls/console/endScope")]);
  });

  test("a refinement may withdraw console.transaction, and never offer it where the manifest does not", () => {
    const offering: Calls = { console: { ...DECLARED.console, transaction: "offered" } };
    const withdraw = { calls: { console: { transaction: "not-offered" } } };
    const offer = { calls: { console: { transaction: "offered" } } };
    let reads = 0;
    const accessor = Object.defineProperty({}, "transaction", {
      enumerable: true,
      get() {
        reads += 1;
        return "not-offered";
      },
    });

    expect(checkRefinement(offering, withdraw)).toEqual([]);
    expect(sessionCalls(offering, withdraw as Refinement).console.transaction).toBe("not-offered");
    expect(sessionCalls(offering, undefined).console.transaction).toBe("offered");
    expect(checkRefinement(offering, offer)).toEqual([]);
    expect(checkRefinement(DECLARED, withdraw)).toEqual([]);
    expect(checkRefinement(DECLARED, offer)).toEqual([refused("refinement-widens", "/calls/console/transaction")]);
    for (const value of ["maybe", true, null]) {
      expect(checkRefinement(offering, { calls: { console: { transaction: value } } })).toEqual([
        refused("refinement-unreadable", "/calls/console/transaction"),
      ]);
    }
    expect(checkRefinement(offering, { calls: { console: accessor } })).toEqual([
      refused("refinement-unreadable", "/calls/console/transaction"),
    ]);
    expect(reads).toBe(0);
  });

  test("an honours list longer than the declared one is refused as refinement-widens at the list, and no item is read", () => {
    let reads = 0;
    const counted = (items: unknown[]): unknown[] =>
      Object.defineProperty(items, "0", {
        enumerable: true,
        get() {
          reads += 1;
          return "params";
        },
      });
    const cases: [Calls, unknown[]][] = [
      [DECLARED, counted(["params", "offset", "params"])],
      [DECLARED, counted([7, 8, 9, 10])],
      [PARAMS_ONLY, ["params", "offset"]],
      [PARAMS_ONLY, ["offset", "offset"]],
    ];

    for (const [declared, honours] of cases) {
      expect(checkRefinement(declared, { calls: { console: { execute: { honours } } } })).toEqual([
        refused("refinement-widens", "/calls/console/execute/honours"),
      ]);
    }
    expect(reads).toBe(0);
  });

  test("a key a refinement cannot have is refused as refinement-key-unknown", () => {
    const cases: [unknown, CallRefusal][] = [
      [{ x: 1 }, refused("refinement-key-unknown", "/x", "x")],
      [{ calls: { x: 1 } }, refused("refinement-key-unknown", "/calls/x", "x")],
      [
        { calls: { console: { explain: "offered" } } },
        refused("refinement-key-unknown", "/calls/console/explain", "explain"),
      ],
      [
        { calls: { console: { execute: { honours: [], x: 1 } } } },
        refused("refinement-key-unknown", "/calls/console/execute/x", "x"),
      ],
      [{ "a/b": 1 }, refused("refinement-key-unknown", "/a~1b", "a/b")],
    ];

    for (const [refine, expected] of cases) expect(checkRefinement(DECLARED, refine)).toEqual([expected]);
  });

  test("a refinement value of the wrong type, an accessor or a repeated field is refused as refinement-unreadable", () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "cancel", {
      enumerable: true,
      get() {
        calls += 1;
        return "not-offered";
      },
    });
    class Shape {
      calls = {};
    }
    const cases: [unknown, string][] = [
      [null, ""],
      [[], ""],
      ["refine", ""],
      [new Shape(), ""],
      [{ calls: null }, "/calls"],
      [{ calls: { console: [] } }, "/calls/console"],
      [{ calls: { console: { cancel: "maybe" } } }, "/calls/console/cancel"],
      [{ calls: { console: { execute: null } } }, "/calls/console/execute"],
      [{ calls: { console: { execute: { honours: "params" } } } }, "/calls/console/execute/honours"],
      [{ calls: { console: { execute: { honours: ["params", "params"] } } } }, "/calls/console/execute/honours/1"],
      [{ calls: { console: { execute: { honours: [7] } } } }, "/calls/console/execute/honours/0"],
      [{ calls: { console: { execute: {} } } }, "/calls/console/execute/honours"],
      [{ calls: { console: accessor } }, "/calls/console/cancel"],
      [{ calls: Object.defineProperty({}, "console", { enumerable: true, get: () => ({}) }) }, "/calls/console"],
      [
        {
          calls: {
            console: {
              execute: { honours: Object.defineProperty([], "0", { enumerable: true, get: () => "params" }) },
            },
          },
        },
        "/calls/console/execute/honours/0",
      ],
    ];

    for (const [refine, pointer] of cases) {
      expect(checkRefinement(DECLARED, refine)).toEqual([refused("refinement-unreadable", pointer)]);
    }
    expect(calls).toBe(0);
  });

  test("no refinement refusal carries a value of the refinement", () => {
    const planted = `planted-${randomUUID()}`;
    const refine = {
      calls: {
        console: { cancel: planted, endScope: planted, execute: { honours: [planted, planted] } },
      },
    };

    const refusals = checkRefinement(DECLARED, refine);

    expect(refusals).toEqual([
      refused("refinement-unreadable", "/calls/console/cancel"),
      refused("refinement-unreadable", "/calls/console/endScope"),
      refused("refinement-unreadable", "/calls/console/execute/honours/0"),
      refused("refinement-unreadable", "/calls/console/execute/honours/1"),
    ]);
    expect(JSON.stringify(refusals)).not.toContain(planted);
    for (const item of refusals) expect(callRefusalSentence(item)).not.toContain(planted);
  });

  test("the session's honours are the indexed items the check read, and an iterator the refinement plants is never called", () => {
    const planted: string[] = [];
    const iterator = function* () {
      planted.push("called");
      yield "params";
      yield "offset";
    };
    const ownIterator = ["params"];
    Object.defineProperty(ownIterator, Symbol.iterator, { value: iterator });
    const swappedPrototype = ["params"];
    Object.setPrototypeOf(swappedPrototype, Object.create(Array.prototype, { [Symbol.iterator]: { value: iterator } }));

    for (const honours of [ownIterator, swappedPrototype]) {
      const refine = { calls: { console: { execute: { honours } } } } as unknown as Refinement;
      expect(checkRefinement(PARAMS_ONLY, refine)).toEqual([]);
      const calls = sessionCalls(PARAMS_ONLY, refine);
      expect(calls.console.execute.honours).toEqual(["params"]);
      expect(Array.isArray(calls.console.execute.honours)).toBe(true);
      expect(Object.getPrototypeOf(calls.console.execute.honours)).toBe(Array.prototype);
      expect(deepFrozen(calls)).toBe(true);
    }
    expect(planted).toEqual([]);
  });
});
