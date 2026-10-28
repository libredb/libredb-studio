/**
 * Threat: a signed-in account opening a Kubernetes-discovered database whose credential Secret its Kubernetes roles do
 * not let it read, or learning that such a database exists (docs/SECURITY.md, control 0.10).
 *
 * With `KUBERNETES_ACCESS_REVIEW` on, a connection that names its Kubernetes Secret has roles `*`, so the review is
 * its only gate. This file proves the gate on the routes themselves: every route that turns a request body into a
 * connection answers a reviewed connection the review keeps from the caller, an id that does not exist and a seed the
 * caller's role may not see with the same 404 CONNECTION_NOT_FOUND, and builds no provider for any of them, for an
 * admin as for a user; the admin fleet health check reports each one as that item's error without building one; and
 * the managed list never shows them. The route inventory is `CONNECTION_ROUTES` in ./helpers/provider-routes.ts,
 * which tests/security/governance-grants.test.ts holds to every provider route.
 *
 * The gate, the decision cache, the groups store and the review client are the real ones, against a fake API server
 * (tests/helpers/kubernetes-access/fake-api.ts). The seed file is the multi-role fixture, and the two reviewed
 * connections are added beside it through the seed lookups, as a Kubernetes discovery source would add them. A
 * provider is counted where it is built: the factory logs `[DB] Creating <type> provider` for every one, and the
 * control at the end sees that line for a connection the review allows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import * as auth from "@/lib/auth";
import * as seedIndex from "@/lib/seed";
import type { ManagedConnection } from "@/lib/seed/types";
import { type FakeKubernetesApi, startFakeKubernetesApi } from "../helpers/kubernetes-access/fake-api";
import { CONNECTION_ROUTES, PROVIDER_ROUTES } from "./helpers/provider-routes";

const FIXTURES = path.resolve(import.meta.dir, "../fixtures/seed-connections");
const ISSUER = "https://rancher.example.com/oidc";
const ALICE: auth.UserPayload = { role: "user", username: "u-alice", idpSubject: "u-alice", idpIssuer: ISSUER };
const ADMIN: auth.UserPayload = { role: "admin", username: "user-admin", idpSubject: "user-admin", idpIssuer: ISSUER };

function reviewed(id: string, namespace: string, secret: string): ManagedConnection {
  return {
    id: `seed:${id}`,
    seedId: id,
    name: `${namespace}/${id} (CloudNativePG)`,
    type: "postgres",
    host: `${id}-rw.${namespace}.svc`,
    port: 5432,
    database: "app",
    user: "app",
    password: "example-only-password",
    managed: true,
    roles: ["*"],
    createdAt: new Date(0),
    literal: true,
    kubernetesSecret: { namespace, name: secret },
  };
}

const REVIEWED: Readonly<Record<string, ManagedConnection>> = {
  "k8s-cnpg-orders": reviewed("k8s-cnpg-orders", "team-a", "orders-app"),
  "k8s-cnpg-analytics": reviewed("k8s-cnpg-analytics", "team-b", "analytics-app"),
};

const ENV: Readonly<Record<string, string>> = {
  SEED_CONFIG_PATH: path.join(FIXTURES, "multi-role-config.yaml"),
  ADMIN_PG_PASS: "admin-secret",
  USER_MYSQL_PASS: "user-secret",
  SHARED_PG_PASS: "shared-secret",
  BOTH_PG_PASS: "both-secret",
  KUBERNETES_ACCESS_REVIEW: "on",
  AUTH_SESSION_TTL_SECONDS: "900",
};

const NOT_FOUND_BODY = {
  error: "Connection not found: it does not exist or is not granted to you",
  code: "CONNECTION_NOT_FOUND",
  statusCode: 404,
};

const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { logger } = await import("@/lib/logger");
const { resetAccessReviewDecisions } = await import("@/lib/kubernetes-access/decisions");
const { recordGroups, resetGroupRecords } = await import("@/lib/kubernetes-access/groups");
const { GET: listManaged } = await import("@/app/api/connections/managed/route");

const getSeedConnectionById = seedIndex.getSeedConnectionById;
const getManagedConnections = seedIndex.getManagedConnections;

let api: FakeKubernetesApi;
let getSession: ReturnType<typeof spyOn>;
let readSession: ReturnType<typeof spyOn>;
const lookups: ReturnType<typeof spyOn>[] = [];

const signIn = (session: auth.UserPayload): void => {
  getSession.mockResolvedValue(session);
};

beforeAll(async () => {
  api = await startFakeKubernetesApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
  api.reset();
  api.useEnv();
  // Alice may read the orders Secret; nobody may read the analytics one.
  api.grants = [
    { user: "u-alice", verb: "get", apiGroup: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
  ];
  seedIndex.resetCache();
  resetAccessReviewDecisions();
  resetGroupRecords();
  clearRateLimitState();
  recordGroups(ISSUER, "u-alice", []);
  recordGroups(ISSUER, "user-admin", []);
  getSession = spyOn(auth, "getSession").mockResolvedValue(ALICE);
  readSession = spyOn(auth, "readSession").mockImplementation(async () => {
    const s = await auth.getSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  });
  lookups.push(
    spyOn(seedIndex, "getSeedConnectionById").mockImplementation(async (id: string, roles: string[]) => {
      const found = REVIEWED[id];
      return found === undefined ? getSeedConnectionById(id, roles) : { ...found };
    }),
    spyOn(seedIndex, "getManagedConnections").mockImplementation(async (roles: string[]) => [
      ...(await getManagedConnections(roles)),
      ...Object.values(REVIEWED).map((connection) => ({ ...connection })),
    ]),
  );
});

afterEach(() => {
  getSession.mockRestore();
  readSession.mockRestore();
  for (const spy of lookups.splice(0)) spy.mockRestore();
  api.restoreEnv();
  for (const name of Object.keys(ENV)) delete process.env[name];
  seedIndex.resetCache();
  resetAccessReviewDecisions();
  resetGroupRecords();
  clearRateLimitState();
});

const ROUTE_MODULES = new Map(PROVIDER_ROUTES);

type Handler = (request: Request) => Promise<Response>;

async function postHandler(route: string): Promise<Handler> {
  const load = ROUTE_MODULES.get(route);
  if (load === undefined) throw new Error(`"${route}" is not a provider route`);
  const { POST } = await load();
  if (typeof POST !== "function") throw new Error(`"${route}" exports no POST`);
  return POST as unknown as Handler;
}

function post(route: string, body: unknown): Request {
  return new Request(`http://localhost/api/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function answer(handler: Handler, route: string, body: unknown) {
  const response = await handler(post(route, body));
  return { status: response.status, body: (await response.json()) as unknown };
}

/** How many providers the factory announced while `log` was installed. */
function providersBuilt(log: { mock: { calls: unknown[][] } }): number {
  return log.mock.calls.filter((call) => typeof call[0] === "string" && call[0].startsWith("[DB] Creating ")).length;
}

async function listedFor(session: auth.UserPayload): Promise<string[]> {
  signIn(session);
  const response = await listManaged();
  expect(response.status).toBe(200);
  return ((await response.json()) as { connections: { id: string }[] }).connections.map((connection) => connection.id);
}

describe("with the Kubernetes access review on, the review is the only way to a reviewed connection", () => {
  test("every connection route answers a denied reviewed id, an unknown id and a seed the role may not see with the same 404, and builds no provider, for an admin", async () => {
    // An admin, so the admin-only routes reach their connection handling too; the review allows it no Secret, and its
    // role may not see the user-only seed.
    signIn(ADMIN);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const answers = Object.fromEntries(
        await Promise.all(
          Object.entries(CONNECTION_ROUTES).map(async ([route, body]) => {
            const handler = await postHandler(route);
            const [denied, unknown, hiddenByRole] = await Promise.all([
              answer(handler, route, { ...body, connectionId: "seed:k8s-cnpg-orders" }),
              answer(handler, route, { ...body, connectionId: "seed:no-such-connection" }),
              answer(handler, route, { ...body, connectionId: "seed:user-only" }),
            ]);
            return [route, { denied, unknown, hiddenByRole }] as const;
          }),
        ),
      );

      const notFound = { status: 404, body: NOT_FOUND_BODY };
      expect(answers).toEqual(
        Object.fromEntries(
          Object.keys(CONNECTION_ROUTES).map((route) => [
            route,
            { denied: notFound, unknown: notFound, hiddenByRole: notFound },
          ]),
        ),
      );
      expect(providersBuilt(log)).toBe(0);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("a user gets the same 404 for a reviewed connection the review keeps from it and for a seed its role may not see", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const query = await postHandler("db/query");
      for (const connectionId of ["seed:k8s-cnpg-analytics", "seed:admin-only", "seed:no-such-connection"]) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, as a browser sends them.
        expect(await answer(query, "db/query", { sql: "SELECT 1", connectionId })).toEqual({
          status: 404,
          body: NOT_FOUND_BODY,
        });
      }
      expect(providersBuilt(log)).toBe(0);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("the admin fleet health check reports each reviewed connection the review keeps from the admin as that item's error, and builds nothing", async () => {
    signIn(ADMIN);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const fleet = await postHandler("admin/fleet-health");
      const checked = await answer(fleet, "admin/fleet-health", {
        connections: Object.values(REVIEWED).map(({ id, name, type, managed, createdAt }) => ({
          id,
          name,
          type,
          managed,
          createdAt,
        })),
      });
      expect(checked.status).toBe(200);
      const results = (checked.body as { results: { connectionId: string; status: string; error?: string }[] }).results;
      expect(results.map(({ connectionId, status, error }) => ({ connectionId, status, error }))).toEqual([
        { connectionId: "seed:k8s-cnpg-orders", status: "error", error: NOT_FOUND_BODY.error },
        { connectionId: "seed:k8s-cnpg-analytics", status: "error", error: NOT_FOUND_BODY.error },
      ]);
      expect(providersBuilt(log)).toBe(0);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("the managed list shows a reviewed connection only to a subject the review allows", async () => {
    expect(await listedFor(ALICE)).toContain("seed:k8s-cnpg-orders");
    expect(await listedFor(ALICE)).not.toContain("seed:k8s-cnpg-analytics");
    expect((await listedFor(ADMIN)).filter((id) => id.startsWith("seed:k8s-"))).toEqual([]);
  });

  // The control: the same detector, and a connection the review allows Alice. A zero above is a measurement.
  test("the control: a reviewed connection the review allows reaches the factory", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const handler = await postHandler("db/provider-meta");
      const response = await handler(post("db/provider-meta", { connectionId: "seed:k8s-cnpg-orders" }));
      expect(response.status).toBe(200);
      expect(providersBuilt(log)).toBe(1);
    } finally {
      log.mockRestore();
    }
  });
});
