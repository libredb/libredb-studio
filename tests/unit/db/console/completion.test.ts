/** Route completions and the route list (vector-family spec 3.4). */
import { describe, expect, test } from "bun:test";
import type { RouteSpec } from "@/lib/db/console/dialect";
import { routeCompletions, routeListText } from "@/lib/db/console/completion";
import { parseConsole, ConsoleRefusal } from "@/lib/db/console/parser";
import { MILVUS_ROUTES, MILVUS_STAND_IN, QDRANT_ROUTES, QDRANT_STAND_IN } from "../../../helpers/console-stand-ins";

describe("routeCompletions", () => {
  test("offers every route of the method, in table order, its template inserted as plain text", () => {
    expect(routeCompletions(QDRANT_STAND_IN, QDRANT_ROUTES, "GET").map((completion) => completion.insertText)).toEqual([
      "",
      "collections",
      "collections/aliases",
      "collections/{collection_name}",
      "collections/{collection_name}/points/{id}",
      "collections/{collection_name}/optimizations",
    ]);
    const search = routeCompletions(MILVUS_STAND_IN, MILVUS_ROUTES, "POST")[1];
    expect(search).toEqual({ label: "entities/search", insertText: "entities/search", route: MILVUS_ROUTES[1] });
  });

  test("offers nothing after a method the dialect does not take", () => {
    expect(routeCompletions(MILVUS_STAND_IN, MILVUS_ROUTES, "GET")).toEqual([]);
  });

  test("a completion accepted unedited meets the template refusal rather than running", () => {
    const [completion] = routeCompletions(QDRANT_STAND_IN, QDRANT_ROUTES, "GET").filter((entry) =>
      entry.insertText.includes("{collection_name}"),
    );
    let refusal: unknown;
    try {
      parseConsole(QDRANT_STAND_IN, QDRANT_ROUTES, `GET ${completion.insertText}`);
    } catch (error) {
      refusal = error;
    }
    expect((refusal as ConsoleRefusal).reason).toBe("path-template");
  });
});

describe("routeListText", () => {
  const routes: readonly RouteSpec[] = [
    ...MILVUS_ROUTES,
    {
      method: "POST",
      template: "collections/load",
      op: "load",
      class: "admin",
      params: {},
      query: {},
      body: "required",
    },
    { method: "GET", template: "collections", op: "list", class: "read", params: {}, query: {}, body: "none" },
  ];

  test("writes the routes of the given classes as METHOD template, in table order", () => {
    expect(routeListText(MILVUS_STAND_IN, routes, ["read"])).toBe(
      "POST collections/list, POST entities/search, POST entities/query",
    );
    expect(routeListText(MILVUS_STAND_IN, routes, ["admin"])).toBe("POST collections/load");
    expect(routeListText(MILVUS_STAND_IN, routes, [])).toBe("");
  });
});
