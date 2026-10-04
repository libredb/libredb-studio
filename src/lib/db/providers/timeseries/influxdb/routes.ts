/**
 * The two closed InfluxDB route tables (InfluxDB spec 3.3; I5, E8, E9): every method, path, URL query key, JSON body
 * key and form key a connection of this directory can send. The client builds a request from a row and nothing
 * else, so a path or a key that is not written here cannot reach the wire.
 *
 * `INFLUXQL_ROUTES` serves the `influxdb` type on every line over the v1 `/query` API; `SQL_ROUTES` serves
 * `influxdb3` over `/api/v3/query_sql`. Both read `/ping` and `/health`, whose bodies name the server's version (R2).
 *
 * What is absent on purpose: every write, configure, token, cache, plugin and `/api/v3/engine/*` route, the one
 * exception being the database listing, a GET; `/api/v2/query` and every other `/api/v2/` path, so no Flux; and
 * the v1 `/query` keys `u`, `p`, `params`, `epoch`, `rp`, `pretty`, `async`, `time_format` and `verbose`, so no
 * credential travels outside the Authorization header and nothing changes the shape of an answer.
 *
 * This is the only file of the directory that holds a path literal (the seam guard checks it).
 */

/** One query or body value of a route: fixed by the table, or filled by the request. */
export type RouteValue = { readonly fixed: string } | { readonly fill: "required" | "optional" };

export interface InfluxRoute {
  readonly method: "GET" | "POST";
  /** An absolute literal path; no template parameter exists on any InfluxDB route. */
  readonly path: "/ping" | "/health" | "/query" | "/api/v3/query_sql" | "/api/v3/configure/database";
  /** Exactly the URL query keys this route may carry; empty on every POST route. */
  readonly query: Readonly<Record<string, RouteValue>>;
  /** Exactly the JSON body keys (POST only); absent on GET, which never takes a body; never beside `form`. */
  readonly body?: Readonly<Record<string, RouteValue>>;
  /** Exactly the application/x-www-form-urlencoded body keys (POST only, R14); never beside `body`. */
  readonly form?: Readonly<Record<string, RouteValue>>;
}

export type InfluxqlRouteId = "ping" | "health" | "query";
export type SqlRouteId = "ping" | "health" | "query" | "databases";
export type InfluxRouteTable<Id extends string> = Readonly<Record<Id, InfluxRoute>>;

/**
 * The points one document of a chunked `/query` answer holds (K4). The server's default is 10,000; 1,000 keeps each
 * document small for the integer-safe parse. Measured on 1.13.1 and 2.9.1 reading 1,000,000 points of `bench.bulk`:
 * the server's memory grew 0 to 9 MiB at 1,000 against 12 to 19 MiB at 10,000, the largest document was 57 KB
 * against 574 KB, and the parse took the same time.
 */
export const INFLUXQL_CHUNK_SIZE = 1000;

/** Freezes a table and everything it holds, so a route cannot gain a key after the module has loaded. */
function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}

export const INFLUXQL_ROUTES: InfluxRouteTable<InfluxqlRouteId> = deepFreeze({
  ping: { method: "GET", path: "/ping", query: {} },
  // R2: the 1.x and 2.x version body.
  health: { method: "GET", path: "/health", query: {} },
  query: {
    // R14: a form POST, never a URL query string. 3.12.0 answers 414 once the request target passes 65,534
    // characters, while a 64 KiB form body answers 200 on all three lines; the statement stays out of URL access
    // logs and proxy request-line limits.
    method: "POST",
    path: "/query",
    query: {},
    form: {
      db: { fill: "optional" },
      q: { fill: "required" },
      chunked: { fixed: "true" },
      chunk_size: { fixed: String(INFLUXQL_CHUNK_SIZE) },
    },
  },
});

export const SQL_ROUTES: InfluxRouteTable<SqlRouteId> = deepFreeze({
  ping: { method: "GET", path: "/ping", query: {} },
  // R2: names a 1.x or 2.x server for the mis-pick refusal.
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
