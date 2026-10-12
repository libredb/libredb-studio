/**
 * The closed management route table: the routes Studio calls and nothing else, each name encoded once per segment,
 * dot segments and empty names refused before any request, and the default exchange addressed as amq.default.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  MANAGEMENT_ROUTES,
  type ManagementRouteId,
  routeTarget,
} from "@/lib/db/providers/stream/rabbitmq/management/routes";

const ADDRESS_SENTENCE =
  "Studio cannot address a virtual host, queue, stream or exchange named . or .. over the management API.";
const EMPTY_SENTENCE =
  "Studio cannot address a virtual host, queue, stream or exchange with an empty name over the management API.";

/** The path and the decoded query of one route, as a key a reader can compare. */
function line(id: ManagementRouteId, parts: { vhost?: string; name?: string } = {}, prefix = ""): string {
  const { pathname, params } = routeTarget(id, parts, prefix);
  return params === undefined ? pathname : `${pathname}?${[...params].map(([k, v]) => `${k}=${v}`).join("&")}`;
}

describe("the route table", () => {
  test("holds exactly the eighteen routes some method calls", () => {
    expect(Object.keys(MANAGEMENT_ROUTES).sort()).toEqual(
      [
        "alarms",
        "exchange",
        "exchange-bindings-destination",
        "exchange-bindings-source",
        "exchanges-page",
        "extensions",
        "operator-policies",
        "overview-full",
        "overview-version",
        "policies",
        "queue",
        "queue-bindings",
        "queues-page",
        "stream-tracking",
        "stream-type",
        "streams-page",
        "vhosts",
        "whoami",
      ].sort(),
    );
  });

  test("builds every route's path and query exactly", () => {
    const v = { vhost: "/" };
    const q = { vhost: "/", name: "orders" };
    expect(line("whoami")).toBe("/api/whoami");
    expect(line("overview-version")).toBe("/api/overview?columns=rabbitmq_version,product_name");
    expect(line("overview-full")).toBe("/api/overview?columns=rabbitmq_version,product_name,management_version");
    expect(line("vhosts")).toBe("/api/vhosts");
    expect(line("queues-page", v)).toBe(
      "/api/queues/%2F?disable_stats=true&enable_queue_totals=true&page=1&page_size=500&sort=name&columns=name,type,state,messages,messages_ready,messages_unacknowledged",
    );
    expect(line("streams-page", v)).toBe(
      "/api/queues/%2F?disable_stats=true&page=1&page_size=500&sort=type&sort_reverse=true&columns=name,type,state",
    );
    expect(line("exchanges-page", v)).toBe(
      "/api/exchanges/%2F?page=1&page_size=500&sort=name&columns=name,type,durable,auto_delete,internal",
    );
    expect(line("queue", q)).toBe("/api/queues/%2F/orders");
    expect(line("stream-type", q)).toBe("/api/queues/%2F/orders?columns=type,online,members&disable_stats=true");
    expect(line("exchange", q)).toBe("/api/exchanges/%2F/orders");
    expect(line("queue-bindings", q)).toBe("/api/queues/%2F/orders/bindings");
    expect(line("exchange-bindings-source", q)).toBe("/api/exchanges/%2F/orders/bindings/source");
    expect(line("exchange-bindings-destination", q)).toBe("/api/exchanges/%2F/orders/bindings/destination");
    expect(line("policies", v)).toBe("/api/policies/%2F");
    expect(line("operator-policies", v)).toBe("/api/operator-policies/%2F");
    expect(line("alarms")).toBe("/api/health/checks/alarms");
    expect(line("extensions")).toBe("/api/extensions");
    expect(line("stream-tracking", q)).toBe("/api/stream/%2F/orders/tracking");
  });

  test("every route is a GET with a fixed label that names no path, and one limiter", () => {
    for (const route of Object.values(MANAGEMENT_ROUTES)) {
      expect(route.label).toMatch(/^the [a-z ]+$/);
      expect(route.label).not.toContain("/");
      expect(["management", "bindings"]).toContain(route.limiter);
    }
    const bindings = Object.values(MANAGEMENT_ROUTES)
      .filter((r) => r.limiter === "bindings")
      .map((r) => r.id);
    expect(bindings.sort()).toEqual(["exchange-bindings-destination", "exchange-bindings-source", "queue-bindings"]);
    const statusOnly = Object.values(MANAGEMENT_ROUTES)
      .filter((r) => r.statusOnly)
      .map((r) => r.id);
    expect(statusOnly).toEqual(["stream-tracking"]);
  });

  test("caps each answer at the size its route allows", () => {
    const caps = Object.fromEntries(Object.values(MANAGEMENT_ROUTES).map((r) => [r.id, r.maxResponseBytes]));
    const small = 65_536;
    const mid = 1_048_576;
    const big = 16_777_216;
    expect(caps).toEqual({
      whoami: small,
      "overview-version": small,
      "overview-full": small,
      vhosts: mid,
      "queues-page": mid,
      "streams-page": mid,
      "exchanges-page": mid,
      queue: mid,
      "stream-type": small,
      exchange: mid,
      "queue-bindings": big,
      "exchange-bindings-source": big,
      "exchange-bindings-destination": big,
      policies: mid,
      "operator-policies": mid,
      alarms: small,
      extensions: small,
      "stream-tracking": small,
    });
  });

  test("no route pairs enable_queue_totals with a sort other than name, and no listing asks for arguments", () => {
    for (const id of Object.keys(MANAGEMENT_ROUTES) as ManagementRouteId[]) {
      const { params } = routeTarget(id, { vhost: "v", name: "n" }, "");
      if (params === undefined) continue;
      if (params.get("enable_queue_totals") === "true") expect(params.get("sort")).toBe("name");
      expect(params.get("columns") ?? "").not.toContain("arguments");
      expect(params.has("name")).toBe(false);
      expect(params.has("use_regex")).toBe(false);
    }
  });

  test("the overview routes never ask for cluster_name", () => {
    for (const id of ["overview-version", "overview-full"] as const) {
      expect(routeTarget(id, {}, "").params?.get("columns")).not.toContain("cluster_name");
    }
  });
});

describe("names in paths", () => {
  test("encodes each name once per segment, so a vhost named %2F is %252F and / is %2F", () => {
    expect(line("queue", { vhost: "%2F", name: "a/b" })).toBe("/api/queues/%252F/a%2Fb");
    expect(line("queue", { vhost: "a b", name: "x,y" })).toBe("/api/queues/a%20b/x%2Cy");
    expect(line("queue", { vhost: '"q"', name: "x?y#z" })).toBe("/api/queues/%22q%22/x%3Fy%23z");
    expect(line("queue", { vhost: "v", name: `\n${String.fromCodePoint(0x202e)}` })).toBe("/api/queues/v/%0A%E2%80%AE");
    expect(line("queue", { vhost: "v", name: "\u20ac".repeat(85) })).toBe(`/api/queues/v/${"%E2%82%AC".repeat(85)}`);
  });

  test("refuses a vhost, queue or stream named . or .., before any request", () => {
    for (const parts of [
      { vhost: "..", name: "x" },
      { vhost: "v", name: "." },
      { vhost: "v", name: ".." },
      { vhost: "." },
    ]) {
      const id = parts.name === undefined ? "queues-page" : "queue";
      let thrown: unknown;
      try {
        routeTarget(id, parts, "");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(QueryError);
      expect((thrown as Error).message).toBe(ADDRESS_SENTENCE);
    }
  });

  test("writes the default exchange as amq.default in the exchange routes, and refuses an empty name anywhere else", () => {
    expect(line("exchange", { vhost: "/", name: "" })).toBe("/api/exchanges/%2F/amq.default");
    expect(line("exchange-bindings-source", { vhost: "/", name: "" })).toBe(
      "/api/exchanges/%2F/amq.default/bindings/source",
    );
    expect(line("exchange-bindings-destination", { vhost: "/", name: "" })).toBe(
      "/api/exchanges/%2F/amq.default/bindings/destination",
    );
    for (const [id, parts] of [
      ["queue", { vhost: "/", name: "" }],
      ["stream-tracking", { vhost: "/", name: "" }],
      ["queues-page", { vhost: "" }],
      ["exchange", { vhost: "", name: "x" }],
      ["queue", { vhost: "/" }],
    ] as const) {
      expect(() => routeTarget(id, parts, "")).toThrow(EMPTY_SENTENCE);
    }
  });

  test("puts every route under the Path prefix", () => {
    expect(line("whoami", {}, "/rabbitmq")).toBe("/rabbitmq/api/whoami");
    expect(line("queue", { vhost: "/", name: "q" }, "/a/b")).toBe("/a/b/api/queues/%2F/q");
  });

  test("an id outside the table is refused: the issue's four admin endpoints and a prototype key", () => {
    for (const id of ["definitions", "users", "permissions", "parameters", "toString"])
      expect(() => routeTarget(id as ManagementRouteId, {}, "")).toThrow(`No management route "${id}"`);
  });
});
