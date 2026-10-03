/** The class of the route a console text runs (vector-family spec 3.4). */
import { describe, expect, test } from "bun:test";
import type { RouteSpec } from "@/lib/db/console/dialect";
import { classifyConsole } from "@/lib/db/console/guard";
import { QDRANT_ROUTES, QDRANT_STAND_IN } from "../../../helpers/console-stand-ins";

describe("classifyConsole", () => {
  test("answers the route's class, and refused for any text the grammar refuses", () => {
    const routes: readonly RouteSpec[] = [
      ...QDRANT_ROUTES,
      {
        method: "POST",
        template: "collections/{collection_name}/points/delete",
        op: "delete_points",
        class: "write",
        params: { collection_name: "name" },
        query: {},
        body: "required",
      },
    ];
    expect(classifyConsole(QDRANT_STAND_IN, routes, "GET collections")).toBe("read");
    expect(classifyConsole(QDRANT_STAND_IN, routes, 'POST collections/docs/points/delete\n{"points": [1]}')).toBe(
      "write",
    );
    expect(classifyConsole(QDRANT_STAND_IN, routes, "DELETE collections/docs")).toBe("refused");
    expect(classifyConsole(QDRANT_STAND_IN, routes, "GET collections/{collection_name}")).toBe("refused");
  });

  test("an error that is not a refusal is not swallowed", () => {
    const broken = new Proxy([] as RouteSpec[], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new TypeError("the route table could not be read");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => classifyConsole(QDRANT_STAND_IN, broken, "GET collections")).toThrow(
      "the route table could not be read",
    );
  });
});
