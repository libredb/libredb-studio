/**
 * The route pattern a console's refused-route table is written in, and the sentence a refused request line reads:
 * a fixed segment matches itself, `*` any one segment, and a trailing `**` one segment or more.
 */
import { describe, expect, test } from "bun:test";
import { refusedRouteSentenceFor, routePatternMatches } from "@/lib/db/console/route-pattern";

const segments = (path: string) => path.split("/");

describe("routePatternMatches", () => {
  test("a fixed pattern matches exactly its segments", () => {
    expect(routePatternMatches("graphql", segments("graphql"))).toBe(true);
    expect(routePatternMatches("graphql", segments("graphql/batch"))).toBe(false);
    expect(routePatternMatches("a/b", segments("a"))).toBe(false);
    expect(routePatternMatches("a/b", segments("a/c"))).toBe(false);
  });

  test("`*` stands for any one segment", () => {
    expect(routePatternMatches("search/*/near-text", segments("search/Article/near-text"))).toBe(true);
    expect(routePatternMatches("search/*/near-text", segments("search/near-text"))).toBe(false);
    expect(routePatternMatches("search/*/near-text", segments("search/A/B/near-text"))).toBe(false);
  });

  test("a trailing `**` stands for one segment or more, never none", () => {
    expect(routePatternMatches("batch/**", segments("batch/objects"))).toBe(true);
    expect(routePatternMatches("batch/**", segments("batch/objects/x/y"))).toBe(true);
    expect(routePatternMatches("batch/**", segments("batch"))).toBe(false);
    expect(routePatternMatches("batch/**", segments("backups/x"))).toBe(false);
    expect(routePatternMatches("collections/*/index/**", segments("collections/c/index/f"))).toBe(true);
  });
});

describe("refusedRouteSentenceFor", () => {
  const table = {
    pathPrefix: "/v9/",
    methods: ["GET", "POST"],
    runs: "It runs reads.",
    rows: [
      { what: "a narrow route", patterns: ["things/special"] },
      { what: "a thing write", patterns: ["things", "things/**"], methods: ["POST", "DELETE"] },
      { what: "a wide route", patterns: ["things/**"] },
    ],
  };

  test("the first row that matches names the route", () => {
    expect(refusedRouteSentenceFor(table, "GET", "things/special")).toBe(
      "GET /v9/things/special is a narrow route, which this console does not run. It runs reads.",
    );
    expect(refusedRouteSentenceFor(table, "POST", "things/x")).toBe(
      "POST /v9/things/x is a thing write, which this console does not run. It runs reads.",
    );
  });

  test("a row with methods matches those methods only", () => {
    expect(refusedRouteSentenceFor(table, "GET", "things/x")).toBe(
      "GET /v9/things/x is a wide route, which this console does not run. It runs reads.",
    );
  });

  test("a method the console does not send is named with the methods it sends", () => {
    expect(refusedRouteSentenceFor(table, "PUT", "other")).toBe(
      "PUT /v9/other is not a request this console runs: it sends GET and POST only. It runs reads.",
    );
  });

  test("any other line is not a route this console runs", () => {
    expect(refusedRouteSentenceFor(table, "GET", "other")).toBe(
      "GET /v9/other is not a route this console runs. It runs reads.",
    );
  });
});
