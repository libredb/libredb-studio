/**
 * The two closed InfluxDB route tables (InfluxDB spec 3.3; E8, E9, I5): every route a connection can send, held
 * here value for value, deeply frozen, with the keys and paths that must never appear in either.
 */
import { describe, expect, test } from "bun:test";
import {
  INFLUXQL_CHUNK_SIZE,
  INFLUXQL_ROUTES,
  type InfluxRoute,
  SQL_ROUTES,
} from "@/lib/db/providers/timeseries/influxdb/routes";

const TABLES: readonly (readonly [string, Readonly<Record<string, InfluxRoute>>])[] = [
  ["INFLUXQL_ROUTES", INFLUXQL_ROUTES],
  ["SQL_ROUTES", SQL_ROUTES],
];
const ROUTES: readonly (readonly [string, InfluxRoute])[] = TABLES.flatMap(([table, routes]) =>
  Object.entries(routes).map(([id, route]) => [`${table}.${id}`, route] as const),
);

/** E8: the v1 `/query` parameters that carry a credential, change the answer's shape or reach a write path. */
const NEVER_KEYS = ["u", "p", "params", "epoch", "rp", "pretty", "async", "time_format", "verbose"];

/** Every object reachable from `value`, itself included. */
function reachable(value: unknown, into: object[] = []): object[] {
  if (typeof value !== "object" || value === null) return into;
  into.push(value);
  for (const child of Object.values(value)) reachable(child, into);
  return into;
}

describe("INFLUXQL_ROUTES", () => {
  test("is the table of spec 3.3, exactly", () => {
    expect(INFLUXQL_ROUTES).toEqual({
      ping: { method: "GET", path: "/ping", query: {} },
      health: { method: "GET", path: "/health", query: {} },
      query: {
        method: "POST",
        path: "/query",
        query: {},
        form: {
          db: { fill: "optional" },
          q: { fill: "required" },
          chunked: { fixed: "true" },
          chunk_size: { fixed: "1000" },
        },
      },
    });
  });

  test("the query route is a form POST with no URL query key and no JSON body (R14)", () => {
    const { query } = INFLUXQL_ROUTES;
    expect(query.method).toBe("POST");
    expect(Object.keys(query.query)).toEqual([]);
    expect(query.body).toBeUndefined();
    expect(Object.keys(query.form ?? {})).toEqual(["db", "q", "chunked", "chunk_size"]);
  });

  test("the chunk size is 1,000, the form field's fixed value (K4)", () => {
    expect(INFLUXQL_CHUNK_SIZE).toBe(1000);
    expect(INFLUXQL_ROUTES.query.form?.chunk_size).toEqual({ fixed: String(INFLUXQL_CHUNK_SIZE) });
  });
});

describe("SQL_ROUTES", () => {
  test("is the table of spec 3.3, exactly", () => {
    expect(SQL_ROUTES).toEqual({
      ping: { method: "GET", path: "/ping", query: {} },
      health: { method: "GET", path: "/health", query: {} },
      query: {
        method: "POST",
        path: "/api/v3/query_sql",
        query: {},
        body: { db: { fill: "required" }, q: { fill: "required" }, format: { fixed: "jsonl" } },
      },
      databases: {
        method: "GET",
        path: "/api/v3/configure/database",
        query: { format: { fixed: "json" } },
      },
    });
  });

  test("the only configure route is the database listing, a GET (I5)", () => {
    const configure = Object.values(SQL_ROUTES).filter((route) => route.path.includes("configure"));
    expect(configure).toEqual([SQL_ROUTES.databases]);
    expect(SQL_ROUTES.databases.method).toBe("GET");
  });
});

describe("both tables", () => {
  test.each(TABLES)("%s is frozen at every depth", (_name, table) => {
    for (const part of reachable(table)) expect(Object.isFrozen(part)).toBe(true);
    expect(() => {
      (table as Record<string, unknown>).write = { method: "POST", path: "/write", query: {} };
    }).toThrow(TypeError);
    expect(() => {
      (table.query.query as Record<string, unknown>).u = { fill: "optional" };
    }).toThrow(TypeError);
    expect(Object.keys(table)).not.toContain("write");
  });

  test.each(TABLES)("%s reads the version from GET /health with no query key and no body (R2)", (_name, table) => {
    expect(table.health).toEqual({ method: "GET", path: "/health", query: {} });
    expect(table.ping).toEqual({ method: "GET", path: "/ping", query: {} });
  });

  test.each(ROUTES)("%s holds no key of the never-list, as a query, form or body key (E8)", (_name, route) => {
    const keys = [route.query, route.form ?? {}, route.body ?? {}].flatMap((part) => Object.keys(part));
    expect(keys.filter((key) => NEVER_KEYS.includes(key))).toEqual([]);
  });

  test.each(ROUTES)(
    "%s is a GET with no body, or a POST with no URL query key and one kind of body",
    (_name, route) => {
      if (route.method === "GET") {
        expect(route.body).toBeUndefined();
        expect(route.form).toBeUndefined();
        return;
      }
      expect(route.method).toBe("POST");
      expect(Object.keys(route.query)).toEqual([]);
      expect([route.body, route.form].filter((part) => part !== undefined)).toHaveLength(1);
    },
  );

  test("no route reaches Flux or any /api/v2/ path (E9)", () => {
    expect(ROUTES.map(([, route]) => route.path).filter((path) => path.includes("/api/v2"))).toEqual([]);
  });

  test("the paths are the five of the contract, and none writes, configures a token or reaches the engine (I5)", () => {
    expect([...new Set(ROUTES.map(([, route]) => route.path))].sort()).toEqual([
      "/api/v3/configure/database",
      "/api/v3/query_sql",
      "/health",
      "/ping",
      "/query",
    ]);
    const forbidden = /write|token|cache|plugin|engine|delete|v3\/configure\/(?!database$)/;
    expect(ROUTES.filter(([, route]) => forbidden.test(route.path))).toEqual([]);
  });
});
