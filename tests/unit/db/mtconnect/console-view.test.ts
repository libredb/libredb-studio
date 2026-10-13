/**
 * The console's view of the route table, which is DERIVED from the guard's table (#1722).
 *
 * WHAT GOES WRONG WITHOUT THIS. `MTC_CONSOLE_ROUTES` exists so the editor draws and completes the
 * same routes the guard runs. A derivation can still lose the part that matters - a key dropped,
 * an order changed, a parameter renamed - and nothing would fail: the editor would simply stop
 * offering a key that works, or offer one that does not. So the two tables are compared key by key
 * here, and the real shared parser is run over the lines the agent actually answers.
 *
 * It also finishes the job `console-delta.test.ts` started. That suite mirrored the `"text"` kind
 * while the shared module did not have it; the member has landed (K-102), so the expectations it
 * pinned are asserted here against the shared parser itself rather than against a copy.
 */
import { describe, expect, test } from "bun:test";
import { ConsoleRefusal, parseConsole } from "@/lib/db/console/parser";
import { MTC_CONSOLE_DIALECT, MTC_CONSOLE_ROUTES, MTC_ROUTES } from "@/lib/db/providers/industrial/mtconnect/routes";

/** The rule a parse breaks, or "accepted". The rule is on `reason`, not on `code` (parser.ts). */
function parsed(text: string): string {
  try {
    parseConsole(MTC_CONSOLE_DIALECT, MTC_CONSOLE_ROUTES, text);
    return "accepted";
  } catch (error) {
    if (error instanceof ConsoleRefusal) return error.reason;
    throw error;
  }
}

describe("the derived table is the guard's table", () => {
  test("same routes, same order, same templates", () => {
    expect(MTC_CONSOLE_ROUTES.length).toBe(9);
    expect(MTC_CONSOLE_ROUTES.map((route) => route.template)).toEqual(MTC_ROUTES.map((route) => route.template));
    expect(MTC_CONSOLE_ROUTES.map((route) => route.op)).toEqual(MTC_ROUTES.map((route) => route.op));
  });

  test("same path parameters and same query keys, route by route", () => {
    for (const [index, route] of MTC_CONSOLE_ROUTES.entries()) {
      const own = MTC_ROUTES[index];
      expect([route.template, Object.keys(route.params)]).toEqual([own.template, Object.keys(own.params)]);
      expect([route.template, Object.keys(route.query)]).toEqual([own.template, Object.keys(own.query)]);
    }
  });

  test("every route reads, takes no body, and is a GET", () => {
    expect(MTC_CONSOLE_ROUTES.map((route) => route.class)).toEqual(Array(9).fill("read"));
    expect(MTC_CONSOLE_ROUTES.map((route) => route.body)).toEqual(Array(9).fill("none"));
    expect(MTC_CONSOLE_ROUTES.map((route) => route.method)).toEqual(Array(9).fill("GET"));
  });

  test("every query key is the text kind and every path parameter the name kind", () => {
    const kinds = new Set(MTC_CONSOLE_ROUTES.flatMap((route) => Object.values(route.query).map((key) => key.kind)));
    const params = new Set(MTC_CONSOLE_ROUTES.flatMap((route) => Object.values(route.params)));
    expect([...kinds]).toEqual(["text"]);
    expect([...params]).toEqual(["name"]);
    // Named rather than counted: a derivation that produced an empty query record for every route
    // would satisfy a set of one kind too, and this says the keys are there.
    expect(Object.keys(MTC_CONSOLE_ROUTES.find((route) => route.op === "sample")!.query).sort()).toEqual([
      "count",
      "deviceType",
      "from",
      "path",
      "to",
    ]);
  });
});

describe("the shared parser accepts what the agent answers", () => {
  test("the three values no older kind could carry", () => {
    expect(parsed(`GET /current?path=${encodeURIComponent('//DataItem[@category="CONDITION"]')}`)).toBe("accepted");
    // MEASURED on the pinned agent: count=-3 answered 200 with the newest three rows.
    expect(parsed("GET /sample?count=-3")).toBe("accepted");
    expect(parsed("GET /sample?from=18446744073709551615")).toBe("accepted");
  });

  test("a device in the path, which is the only place a device is written", () => {
    expect(parsed("GET /Mazak/current")).toBe("accepted");
    expect(parsed("GET /Mazak/probe")).toBe("accepted");
    expect(parsed("GET /asset/OKUMA.1")).toBe("accepted");
  });

  test("an empty value and a key no route declares are refused", () => {
    expect(parsed("GET /sample?count=")).toBe("query-value");
    expect(parsed("GET /probe?count=5")).toBe("query-key");
    // The streaming keys the provider refuses by name are not in any route's table either.
    expect(parsed("GET /sample?interval=100")).toBe("query-key");
  });

  /**
   * MEASURED, and it corrects what `console-delta.test.ts` pinned before the member landed: that
   * suite expected a value past the byte bound to be refused as a VALUE. It is not, and it cannot
   * be. The whole text is held to `maxTextBytes` before any value is read, and a decoded value is
   * never longer than the text that carried it, so the value level bound could never fire. The arm
   * therefore asks only that the value is not empty, and a long value is refused as `too-large` on
   * the text, which is the honest sentence: the request line is too long, not the value wrong.
   */
  test("a long value is refused on the text, not on the value, and the bound is one number", () => {
    expect(MTC_CONSOLE_DIALECT.maxTextBytes).toBe(4096);
    expect(parsed(`GET /current?path=${"x".repeat(1000)}`)).toBe("accepted");
    // Two bytes a character once encoded it is six, so this is past the text bound either way.
    expect(parsed(`GET /current?path=${encodeURIComponent("ç".repeat(2049))}`)).toBe("too-large");
    // Plain ASCII, past the bound by one byte of text: the same sentence, which is the point.
    expect(parsed(`GET /current?path=${"x".repeat(4096)}`)).toBe("too-large");
    // And the one thing the arm does decide.
    expect(parsed("GET /current?path=")).toBe("query-value");
  });

  /**
   * MEASURED, and this is why the dialect's four body bounds are the two existing dialects' numbers
   * rather than zero: `parseConsole` reads the body BEFORE it checks the route's body rule, so with
   * zeros this text was refused as `too-many-nodes`, a sentence about a bound, instead of being told
   * that the route takes no body.
   */
  test("a body is refused as a body, because the bounds let it parse first", () => {
    expect(parsed('GET /current\n{"a":1}')).toBe("body-not-allowed");
    expect(MTC_CONSOLE_DIALECT.maxNodes).toBe(4096);
    expect(MTC_CONSOLE_DIALECT.maxDepth).toBe(32);
    expect(MTC_CONSOLE_ROUTES.every((route) => route.body === "none")).toBe(true);
  });
});
