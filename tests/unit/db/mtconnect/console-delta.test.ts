/**
 * The console query value kinds, pinned before the delta lands.
 *
 * Decision K-102: MTConnect's request line fits the shared console with one change, a `"text"`
 * member on `QueryKeySpec["kind"]` in `src/lib/db/console/dialect.ts` and one arm each in the two
 * module private functions of `src/lib/db/console/parser.ts`. Those two files are shared, so this
 * session does not touch them. This suite exists so that the change arrives with its behaviour
 * already written down.
 *
 * It exists for a second reason, which is the one worth stating. MEASURED by searching the
 * repository: there is no exhaustive `Record` over that union anywhere, so adding a member breaks
 * no compilation. The compiler will not notice a missing arm, and a missing arm does not fail: it
 * produces a WRONG REFUSAL SENTENCE for a value the console should have accepted. Where the
 * compiler cannot enforce, a test has to.
 *
 * So this suite does not only show that the rules pass. For each rule it also breaks the rule and
 * shows the check failing, because a test that only ever sees the correct implementation cannot
 * tell a working guard from a guard that returns true.
 */
import { describe, expect, test } from "bun:test";
import { QDRANT_STAND_IN } from "@/../tests/helpers/console-stand-ins";
import { ConsoleRefusal, parseConsole } from "@/lib/db/console/parser";
import type { QueryKeySpec, RouteSpec } from "@/lib/db/console/dialect";

/**
 * The grammar rule a parse breaks, or "accepted".
 *
 * The rule is on `reason`, not on `code`: `parser.ts` says so where it defines the class, because
 * every `DatabaseError` already carries `code`, which is the API error code the routes map. Reading
 * `code` here returns `QUERY_ERROR` for every grammar refusal and tells a test nothing. An earlier
 * version of this helper read `code` and five expectations failed with `QUERY_ERROR`, which is how
 * the distinction was found.
 */
function parsed(routes: readonly RouteSpec[], text: string): string {
  try {
    parseConsole(QDRANT_STAND_IN, routes, text);
    return "accepted";
  } catch (error) {
    if (error instanceof ConsoleRefusal) return error.reason;
    throw error;
  }
}

function routeWith(key: string, spec: QueryKeySpec): readonly RouteSpec[] {
  return [
    Object.freeze({
      method: "GET",
      template: "thing",
      op: "read",
      class: "read" as const,
      params: Object.freeze({}),
      query: Object.freeze({ [key]: spec }),
      body: "none" as const,
    }),
  ];
}

describe("the three kinds the shared console has today, against the real parser", () => {
  test("positive-int takes a positive integer and nothing else", () => {
    const routes = routeWith("count", { kind: "positive-int" });
    expect(parsed(routes, "GET /thing?count=5")).toBe("accepted");
    expect(parsed(routes, "GET /thing?count=0")).toBe("query-value");
    expect(parsed(routes, "GET /thing?count=-3")).toBe("query-value");
    expect(parsed(routes, "GET /thing?count=1.5")).toBe("query-value");
    expect(parsed(routes, "GET /thing?count=abc")).toBe("query-value");
    // The safe integer ceiling, which is why a 64 bit sequence number does not fit this kind.
    expect(parsed(routes, "GET /thing?count=9007199254740991")).toBe("accepted");
    expect(parsed(routes, "GET /thing?count=9007199254740993")).toBe("query-value");
    expect(parsed(routes, "GET /thing?count=18446744073709551615")).toBe("query-value");
  });

  test("positive-int-or-words takes either", () => {
    const routes = routeWith("consistency", { kind: "positive-int-or-words", words: ["majority", "all"] });
    expect(parsed(routes, "GET /thing?consistency=3")).toBe("accepted");
    expect(parsed(routes, "GET /thing?consistency=majority")).toBe("accepted");
    expect(parsed(routes, "GET /thing?consistency=most")).toBe("query-value");
  });

  test("word-list takes a comma separated list from a closed set", () => {
    const routes = routeWith("with", { kind: "word-list", words: ["queued", "idle"] });
    expect(parsed(routes, "GET /thing?with=queued")).toBe("accepted");
    expect(parsed(routes, "GET /thing?with=queued,idle")).toBe("accepted");
    expect(parsed(routes, "GET /thing?with=queued,busy")).toBe("query-value");
    expect(parsed(routes, "GET /thing?with=")).toBe("query-value");
  });

  test("none of the three can carry an XPath, which is why the delta exists", () => {
    const path = '//DataItem[@category="CONDITION"]';
    const target = `GET /thing?path=${encodeURIComponent(path)}`;
    for (const spec of [
      { kind: "positive-int" } as QueryKeySpec,
      { kind: "positive-int-or-words", words: ["majority"] } as QueryKeySpec,
      { kind: "word-list", words: ["queued"] } as QueryKeySpec,
    ]) {
      expect(parsed(routeWith("path", spec), target)).toBe("query-value");
    }
  });

  test("and none of the three can carry a negative count, which the agent accepts", () => {
    // MEASURED on the pinned agent: count=-3 answered 200 with the newest three rows.
    for (const spec of [
      { kind: "positive-int" } as QueryKeySpec,
      { kind: "positive-int-or-words", words: ["majority"] } as QueryKeySpec,
    ]) {
      expect(parsed(routeWith("count", spec), "GET /thing?count=-3")).toBe("query-value");
    }
  });
});

/**
 * The `"text"` kind, mirrored here because the shared module does not have it yet.
 *
 * When the member lands, `accepts` below is replaced by the shared `queryValueAccepted` and the
 * expectations stay as they are. Until then this is what the arm has to do.
 */
const TEXT_MAX_BYTES = 4096;

function textKindAccepts(value: string): boolean {
  if (value === "") return false;
  return new TextEncoder().encode(value).length <= TEXT_MAX_BYTES;
}

describe("the text kind the delta adds", () => {
  test("it takes an XPath, a negative count and a 64 bit sequence number", () => {
    expect(textKindAccepts('//DataItem[@category="CONDITION"]')).toBe(true);
    expect(textKindAccepts("-3")).toBe(true);
    expect(textKindAccepts("18446744073709551615")).toBe(true);
  });

  test("it refuses an empty value and one past the byte bound", () => {
    expect(textKindAccepts("")).toBe(false);
    expect(textKindAccepts("x".repeat(TEXT_MAX_BYTES))).toBe(true);
    expect(textKindAccepts("x".repeat(TEXT_MAX_BYTES + 1))).toBe(false);
  });

  test("it counts bytes rather than characters, because the ceiling is on bytes", () => {
    // The agent's limit is on the request header block in bytes, so a multi byte character costs
    // what it costs on the wire.
    const multiByte = "ç".repeat(TEXT_MAX_BYTES);
    expect(multiByte.length).toBe(TEXT_MAX_BYTES);
    expect(new TextEncoder().encode(multiByte).length).toBe(TEXT_MAX_BYTES * 2);
    expect(textKindAccepts(multiByte)).toBe(false);
  });
});

/**
 * The part that makes the suite worth having: break each rule and show the check failing.
 *
 * A guard that is only ever shown the correct implementation proves nothing about itself. Each case
 * below installs a deliberately wrong version of the arm and asserts that the expectation above
 * would have caught it.
 */
describe("the checks catch a broken arm", () => {
  /** The failure the delta invites: the member is added to the union and the arm is forgotten. */
  function missingArm(): boolean {
    // With no arm for the kind, `queryValueAccepted` falls through to its last branch, which treats
    // the spec as a word list with no words, so every value is refused.
    return false;
  }

  /** The other failure: an arm that accepts anything, bounds included. */
  function unboundedArm(value: string): boolean {
    return value !== "";
  }

  test("a missing arm refuses a value the kind should take, and the check sees it", () => {
    expect(missingArm()).toBe(false);
    // The expectation of the suite above is `true`, so this implementation fails it.
    expect(missingArm()).not.toBe(textKindAccepts('//DataItem[@category="CONDITION"]'));
  });

  test("an unbounded arm accepts a value past the byte bound, and the check sees it", () => {
    const tooLong = "x".repeat(TEXT_MAX_BYTES + 1);
    expect(unboundedArm(tooLong)).toBe(true);
    expect(unboundedArm(tooLong)).not.toBe(textKindAccepts(tooLong));
  });

  test("an arm that counts characters instead of bytes passes the wrong value, and the check sees it", () => {
    const characterCounting = (value: string) => value !== "" && value.length <= TEXT_MAX_BYTES;
    const multiByte = "ç".repeat(TEXT_MAX_BYTES);
    expect(characterCounting(multiByte)).toBe(true);
    expect(textKindAccepts(multiByte)).toBe(false);
  });

  test("the real parser's own arms are exercised, not mirrored, so this suite fails if they change", () => {
    // If someone changes `positive-int` to accept zero, the first test in this file fails. That is
    // the point of calling `parseConsole` rather than re-implementing it.
    expect(parsed(routeWith("count", { kind: "positive-int" }), "GET /thing?count=0")).toBe("query-value");
    expect(parsed(routeWith("count", { kind: "positive-int" }), "GET /thing?count=1")).toBe("accepted");
  });
});
