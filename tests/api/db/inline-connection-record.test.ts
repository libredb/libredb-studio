import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as realAuth from "@/lib/auth";
import { ALL_ROUTES, CONNECTION_ROUTES } from "../../security/helpers/provider-routes";

/**
 * An inline connection whose `type` is missing, empty or not a string, or whose `name` is present and not a string,
 * `null` included, is answered 400 CONFIG_ERROR, "Valid connection configuration is required", by every route that
 * resolves a caller's connection, before any provider is built.
 *
 * Measured on 2026-11-04 on the production server (Node 24) before the change, with an inline record sent to every
 * route below. A type of `5`, or a name of `5` or an object, answered 500 `INTERNAL_ERROR`, "e.replace is not a
 * function", on every route but the statement analysis, which refused it, and the disconnect route, which answered 200.
 * A missing or `null` type answered 500 with the runtime's own TypeError ("Cannot read properties of undefined (reading
 * 'length')") on the query, multi-query, transaction, cancel, pool-stats, profile and both maintenance routes, and 500
 * "Failed to disconnect" on the disconnect route; the health, monitoring, provider-meta, object and key-scan routes
 * refused it in this sentence without a code, and the test-connection route in a sentence of its own. An empty type
 * answered the factory's "Unknown database type" on the routes without a check of their own, and a `null` name was
 * built as a connection with no name everywhere but the statement analysis. The fleet health check reported the
 * runtime's TypeError as the item's error.
 *
 * The routes are the connection route inventory, `CONNECTION_ROUTES` in tests/security/helpers/provider-routes.ts,
 * which tests/security/governance-grants.test.ts holds equal to every provider route that passes its request body to
 * `resolveConnection`, so a route added there is sent these records too. `POST /api/db/disconnect`, which resolves a
 * record of the caller's own only to name the cache entries it removes, and `POST /api/admin/fleet-health`, which
 * resolves each item of its list and reports a refusal as that item's error, are sent them beside the inventory.
 *
 * Only the session reader is replaced, with an admin session, so the admin-only routes reach their connection handling
 * too. `resolveConnection` and the factory are the real ones. A provider is counted where it is built, by the
 * factory's `[DB] Creating <type> provider` line, as tests/security/custom-connections.test.ts counts it, and the
 * control at the end sees that line for a well-formed record.
 */

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }));

// Spread over the real module: a partial replacement stays installed process-wide and breaks the next importer of an
// export this one forgot.
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => ({ kind: "authenticated", session: await mockGetSession() })),
}));

const { clearRateLimitState } = await import("@/lib/api/rate-limit");

const SENTENCE = "Valid connection configuration is required";
const REFUSAL = { status: 400, body: { error: SENTENCE, code: "CONFIG_ERROR", statusCode: 400 } };

/** A record of the caller's own that would reach a server if anything let it through: nothing listens on port 1. */
const RECORD = { id: "user-probe", host: "127.0.0.1", port: 1, user: "u", password: "p", database: "d" };

const MALFORMED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["no type", { ...RECORD, name: "Probe" }],
  ["an empty type", { ...RECORD, name: "Probe", type: "" }],
  ["a type that is a number", { ...RECORD, name: "Probe", type: 5 }],
  ["a type that is null", { ...RECORD, name: "Probe", type: null }],
  ["a name that is a number", { ...RECORD, type: "postgres", name: 5 }],
  ["a name that is an object", { ...RECORD, type: "postgres", name: { first: "orders" } }],
  ["a name that is null", { ...RECORD, type: "postgres", name: null }],
];

/** The two routes that also read a bare connection object as the whole body. */
const ACCEPTS_A_BARE_CONNECTION = new Set(["db/provider-meta", "db/test-connection"]);

/** The inventory, and the disconnect route, which resolves a record of the caller's own without being in it. */
const ROUTES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  ...CONNECTION_ROUTES,
  "db/disconnect": {},
};

const ROUTE_MODULES = new Map(ALL_ROUTES);

type Handler = (request: Request) => Promise<Response>;

async function postHandler(route: string): Promise<Handler> {
  const load = ROUTE_MODULES.get(route);
  if (load === undefined) throw new Error(`"${route}" is not a route`);
  const { POST } = await load();
  if (typeof POST !== "function") throw new Error(`"${route}" exports no POST`);
  return POST as unknown as Handler;
}

async function answer(route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const handler = await postHandler(route);
  const response = await handler(
    new Request(`http://localhost/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as unknown };
}

/** The bodies a route is sent one record in: beside its own fields, and for two routes as the whole body. */
function bodiesFor(route: string, record: Record<string, unknown>): unknown[] {
  const bodies: unknown[] = [{ ...ROUTES[route], connection: record }];
  if (ACCEPTS_A_BARE_CONNECTION.has(route)) bodies.push(record);
  return bodies;
}

/** Runs `work` with the factory's announcement captured, and answers what it answered and how many providers it built. */
async function counted<T>(work: () => Promise<T>): Promise<{ result: T; built: number }> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = await work();
    const built = log.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[DB] Creating "),
    ).length;
    return { result, built };
  } finally {
    log.mockRestore();
  }
}

const previousCustomConnections = process.env.ALLOW_CUSTOM_CONNECTIONS;
const previousGovernanceSource = process.env.GOVERNANCE_SOURCE;

beforeAll(() => {
  // Custom connections on and governance off, the defaults, so an inline record reaches the record checks.
  delete process.env.ALLOW_CUSTOM_CONNECTIONS;
  delete process.env.GOVERNANCE_SOURCE;
});

afterAll(() => {
  if (previousCustomConnections !== undefined) process.env.ALLOW_CUSTOM_CONNECTIONS = previousCustomConnections;
  if (previousGovernanceSource !== undefined) process.env.GOVERNANCE_SOURCE = previousGovernanceSource;
});

beforeEach(() => {
  clearRateLimitState();
});

describe("the routes this file sends a record to", () => {
  // A listing bug that found nothing would make every route test below pass vacuously.
  test("are at least today's 23 connection routes and the disconnect route", () => {
    expect(Object.keys(ROUTES).length).toBeGreaterThanOrEqual(24);
    for (const route of Object.keys(ROUTES)) expect(ROUTE_MODULES.has(route)).toBe(true);
  });
});

for (const route of Object.keys(ROUTES)) {
  describe(`POST /api/${route}`, () => {
    test.each(MALFORMED)(
      "answers an inline connection with %s 400 CONFIG_ERROR, and builds nothing",
      async (_label, record) => {
        const { result, built } = await counted(() =>
          Promise.all(bodiesFor(route, record).map((body) => answer(route, body))),
        );

        expect(result).toEqual(bodiesFor(route, record).map(() => REFUSAL));
        expect(built).toBe(0);
      },
    );
  });
}

describe("POST /api/admin/fleet-health", () => {
  test.each(MALFORMED)(
    "reports an inline connection with %s as that item's refusal, and builds nothing",
    async (_label, record) => {
      const { result, built } = await counted(() => answer("admin/fleet-health", { connections: [record] }));

      expect(result.status).toBe(200);
      expect((result.body as { results: unknown[] }).results).toEqual([
        expect.objectContaining({ connectionId: "user-probe", status: "error", error: SENTENCE }),
      ]);
      expect(built).toBe(0);
    },
  );
});

describe("the control: the counter sees a build", () => {
  test("a well-formed record with no name is built by POST /api/db/provider-meta, which never connects", async () => {
    const { result, built } = await counted(() =>
      answer("db/provider-meta", { connection: { ...RECORD, type: "postgres" } }),
    );

    expect(result.status).toBe(200);
    expect(built).toBe(1);
  });
});
