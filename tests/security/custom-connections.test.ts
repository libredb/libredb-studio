import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import * as realAuth from "@/lib/auth";
import { discoverRoutes } from "./helpers/discover-routes";

/**
 * Threat: a signed-in account opening a connection to a host the operator never seeded.
 *
 * Studio connects from wherever it runs. Deployed on an overlay network it shares with other
 * services, a connection a user types in reaches every one of them by service name: a platform's
 * own database, its control plane, anything listening. `ALLOW_CUSTOM_CONNECTIONS=false` is the
 * operator's answer, and this file proves it is a server rule and not a hidden button: every route
 * that builds a database provider refuses a connection the caller supplied, before any provider is
 * built, while a seed keeps opening.
 *
 * Every route.ts under src/app/api is enumerated from disk, like `route-auth.test.ts` does, so a
 * provider-building route added anywhere in the API tree later is red here by default instead of
 * silently exempt. A route under src/app/api/db is sent a caller's connection and must refuse it;
 * one there that builds no provider needs an entry below with its reason. A route anywhere else
 * whose own source calls a provider builder fails the census until it is listed below with the
 * reason a caller's connection cannot reach the factory through it, and the modules under src/lib
 * that build a provider outside the factory are pinned to a known set the same way.
 *
 * The detector is the factory's own announcement: `createDatabaseProvider` logs
 * `[DB] Creating <type> provider` for every provider it builds, and `getOrCreateProvider` and
 * `acquireExecutionProfileProvider` both build through it. The control at the bottom proves the
 * detector sees a build, so a zero above it is a measurement and not a blind spot.
 *
 * The agent runtime and the MCP endpoint are not sent a connection here because neither accepts
 * one at all: an agent run is opened on a seed id and refuses an inline connection with 400
 * (`tests/api/agent/runs.test.ts`), and an MCP tool reaches only the seeds that opted in
 * (`src/lib/mcp/context.ts`). Both are in the known set of src/lib modules below, which catches a
 * new module that builds a provider; what each of the two opens is pinned by its own tests.
 */

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// Spread over the real module: a partial replacement stays installed process-wide and breaks the
// next importer of an export this one forgot. An admin session, so the admin-only routes reach
// their connection handling too.
mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));

const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { resetCache } = await import("@/lib/seed/config-loader");
const { CUSTOM_CONNECTIONS_DISABLED_MESSAGE } = await import("@/lib/config/custom-connections");

/** The body every route answers a refused connection with, beside `statusCode: 403`. */
const REFUSAL = { error: CUSTOM_CONNECTIONS_DISABLED_MESSAGE, code: "CUSTOM_CONNECTIONS_DISABLED" };

const SRC_DIR = join(import.meta.dir, "..", "..", "src");
const API_DIR = join(SRC_DIR, "app", "api");
const LIB_DIR = join(SRC_DIR, "lib");
const DB_API_DIR = join(API_DIR, "db");
const DB_ROUTES = discoverRoutes(DB_API_DIR);

/** Routes under src/app/api/db that build no provider, each with its reason. */
const ROUTES_THAT_BUILD_NO_PROVIDER: Record<string, string> = {
  disconnect:
    "closes a provider already in the cache, named by connectionId, and never builds one; a body carrying only a connection is refused there as a missing connectionId (tests/api/db/disconnect.test.ts)",
};

/** The two routes that also read a bare connection object as the whole body. */
const ACCEPTS_A_BARE_CONNECTION = new Set(["provider-meta", "test-connection"]);

const PROVIDER_ROUTES = DB_ROUTES.filter(([key]) => !(key in ROUTES_THAT_BUILD_NO_PROVIDER));

/**
 * Routes outside src/app/api/db whose own source calls a provider builder, each with the reason a
 * connection the caller supplies never reaches the factory through it.
 */
const PROVIDER_ROUTES_OUTSIDE_DB: Record<string, string> = {
  "admin/fleet-health":
    "resolves every item through resolveConnection before the factory sees it; the fleet health case below sends it a caller's connection",
  "agent/runs/[runId]/handover":
    "opens only the run's recorded connectionId, resolved as a seed id under the run's own actor; the request carries no connection (tests/api/agent/handover.test.ts)",
};

/**
 * Modules under src/lib, outside the factory in src/lib/db, that build a provider, each with where
 * its connection comes from. Paths are relative to src/lib.
 */
const PROVIDER_MODULES_IN_LIB: Record<string, string> = {
  "agent/runtime.ts": "drives an agent run on the seed its recorded connectionId resolves to through resolveConnection",
  "api/object-route.ts":
    "handleObjectRequest resolves through resolveConnection before it builds; every db/objects route and db/keys/scan reach it, and the census sends each of them a caller's connection",
  "mcp/context.ts": "opens only seeds that opted in with mcp: true, read from getManagedConnections",
};

const PROVIDER_BUILDERS = [
  "createDatabaseProvider",
  "getOrCreateProvider",
  "acquireExecutionProfileProvider",
  "withOneShotTunnel",
];

/** In a route, `handleObjectRequest` builds too: it is the shared body of the object routes. */
const ROUTE_BUILDS = new RegExp(`\\b(${[...PROVIDER_BUILDERS, "handleObjectRequest"].join("|")})\\s*\\(`);

/** In src/lib, where `handleObjectRequest` is declared, only the factory's entry points count. */
const LIB_BUILDS = new RegExp(`\\b(${PROVIDER_BUILDERS.join("|")})\\s*\\(`);

/** Blanks out comments the way `route-auth.test.ts` does, so a mention in prose is not a call. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function calls(file: string, pattern: RegExp): boolean {
  return pattern.test(withoutComments(readFileSync(file, "utf8")));
}

const scratch = mkdtempSync(join(tmpdir(), "libredb-custom-connections-"));
const REFUSED_FILE = join(scratch, "refused.db");

/**
 * A connection that would really open if anything let it through: SQLite creates its file on
 * connect, so a refused request that reached a provider would also leave `refused.db` behind.
 */
const CUSTOM_CONNECTION = {
  id: "custom-target",
  name: "Custom target",
  type: "sqlite",
  database: REFUSED_FILE,
  createdAt: "2026-10-04T00:00:00.000Z",
};

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** How many providers the factory announced while `log` was installed. */
function providersBuilt(log: { mock: { calls: unknown[][] } }): number {
  return log.mock.calls.filter((call) => typeof call[0] === "string" && call[0].startsWith("[DB] Creating ")).length;
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("with ALLOW_CUSTOM_CONNECTIONS=false, no route builds a provider from a connection the caller supplied", () => {
  beforeEach(() => {
    clearRateLimitState();
    process.env.ALLOW_CUSTOM_CONNECTIONS = "false";
  });

  afterEach(() => {
    delete process.env.ALLOW_CUSTOM_CONNECTIONS;
  });

  // A listing bug that found nothing would make every test below pass vacuously.
  test("the enumeration finds at least today's 22 provider-building routes under src/app/api/db", () => {
    expect(PROVIDER_ROUTES.length).toBeGreaterThanOrEqual(22);
  });

  test("every exemption names a route that exists and carries a reason", () => {
    for (const [key, reason] of Object.entries(ROUTES_THAT_BUILD_NO_PROVIDER)) {
      expect(DB_ROUTES.some(([routeKey]) => routeKey === key)).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  for (const [route, load] of PROVIDER_ROUTES) {
    test(`POST /api/db/${route} answers 403 with the operator's sentence and builds nothing`, async () => {
      const { POST } = await load();
      if (typeof POST !== "function") {
        throw new Error(`"db/${route}" builds a provider but exports no POST - exempt it with a reason or add one`);
      }
      const bodies: unknown[] = [{ connection: CUSTOM_CONNECTION }];
      if (ACCEPTS_A_BARE_CONNECTION.has(route)) bodies.push(CUSTOM_CONNECTION);

      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        const answers = await Promise.all(bodies.map((body) => POST(post(`db/${route}`, body) as never)));
        const refusals = await Promise.all(answers.map(async (res) => (await res.json()) as Record<string, unknown>));

        expect(answers.map((res) => res.status)).toEqual(bodies.map(() => 403));
        // The code is what a client tells this refusal apart by: the role filter's 403 says AUTH_ERROR.
        expect(refusals).toEqual(bodies.map(() => expect.objectContaining(REFUSAL)));
        expect(providersBuilt(log)).toBe(0);
      } finally {
        log.mockRestore();
      }
    });
  }

  test("POST /api/admin/fleet-health reports the connection as refused, beside the rest, and builds nothing", async () => {
    const { POST } = await import("@/app/api/admin/fleet-health/route");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await POST(post("admin/fleet-health", { connections: [CUSTOM_CONNECTION] }));
      const data = (await res.json()) as { results: { connectionId: string; status: string; error?: string }[] };

      expect(res.status).toBe(200);
      expect(data.results).toEqual([
        expect.objectContaining({
          connectionId: "custom-target",
          status: "error",
          error: CUSTOM_CONNECTIONS_DISABLED_MESSAGE,
        }),
      ]);
      expect(providersBuilt(log)).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  test("and the database file the refused connection named was never opened", () => {
    expect(existsSync(REFUSED_FILE)).toBe(false);
  });
});

describe("the census reaches the whole API tree, not only src/app/api/db", () => {
  test("a route outside src/app/api/db builds a provider only with a recorded reason, and the db exemptions build none", () => {
    const problems: string[] = [];
    const builders = discoverRoutes(API_DIR)
      .map(([key]) => key)
      .filter((key) => calls(join(API_DIR, key, "route.ts"), ROUTE_BUILDS));

    for (const key of builders) {
      if (key.startsWith("db/")) {
        if (key.slice("db/".length) in ROUTES_THAT_BUILD_NO_PROVIDER) {
          problems.push(`"${key}" is exempted as building no provider, but its route.ts calls a provider builder`);
        }
      } else if (!(key in PROVIDER_ROUTES_OUTSIDE_DB)) {
        problems.push(
          `"${key}" builds a database provider outside src/app/api/db: resolve its connection through resolveConnection, add a case above that sends it a caller's connection, and record the reason in PROVIDER_ROUTES_OUTSIDE_DB`,
        );
      }
    }
    for (const [key, reason] of Object.entries(PROVIDER_ROUTES_OUTSIDE_DB)) {
      if (!builders.includes(key)) {
        problems.push(
          `"${key}" is listed in PROVIDER_ROUTES_OUTSIDE_DB but no longer builds a provider: drop its entry`,
        );
      }
      if (reason.length <= 20) problems.push(`"${key}" in PROVIDER_ROUTES_OUTSIDE_DB needs a reason`);
    }

    expect(problems).toEqual([]);
  });

  test("outside the factory, only the known src/lib modules build a provider", () => {
    const builders = readdirSync(LIB_DIR, { recursive: true })
      .map((path) => String(path).split(sep).join("/"))
      .filter((path) => /\.tsx?$/.test(path) && !path.startsWith("db/"))
      .filter((path) => calls(join(LIB_DIR, path), LIB_BUILDS))
      .sort();

    // A new name here is a module that builds a provider from a connection nobody has classified.
    expect(builders).toEqual(Object.keys(PROVIDER_MODULES_IN_LIB).sort());
  });
});

describe("the controls: the detector sees a build, and a seed still opens", () => {
  const seedFile = join(scratch, "seed-connections.json");
  const shopFile = join(scratch, "shop.db");
  const originalSeedPath = process.env.SEED_CONFIG_PATH;
  const originalSeedTtl = process.env.SEED_CACHE_TTL_MS;

  beforeEach(() => {
    clearRateLimitState();
  });

  afterEach(() => {
    delete process.env.ALLOW_CUSTOM_CONNECTIONS;
    if (originalSeedPath === undefined) delete process.env.SEED_CONFIG_PATH;
    else process.env.SEED_CONFIG_PATH = originalSeedPath;
    if (originalSeedTtl === undefined) delete process.env.SEED_CACHE_TTL_MS;
    else process.env.SEED_CACHE_TTL_MS = originalSeedTtl;
    resetCache();
  });

  test("with the switch unset, the same kind of connection is built and tested", async () => {
    const { POST } = await import("@/app/api/db/test-connection/route");
    const allowedFile = join(scratch, "allowed.db");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await POST(post("db/test-connection", { ...CUSTOM_CONNECTION, database: allowedFile }) as never);

      expect(res.status).toBe(200);
      expect(((await res.json()) as { success?: boolean }).success).toBe(true);
      expect(providersBuilt(log)).toBe(1);
      expect(existsSync(allowedFile)).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test("with the switch off, a seed opens by its id and as an unmanaged seed's edited copy", async () => {
    const shop = new Database(shopFile, { create: true });
    shop.run("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    shop.close();
    writeFileSync(
      seedFile,
      JSON.stringify({
        version: "1",
        connections: [
          { id: "shop", name: "Shop", type: "sqlite", database: shopFile, roles: ["admin"], managed: false },
        ],
      }),
    );
    process.env.SEED_CONFIG_PATH = seedFile;
    process.env.SEED_CACHE_TTL_MS = "0";
    resetCache();
    process.env.ALLOW_CUSTOM_CONNECTIONS = "false";
    const { POST } = await import("@/app/api/db/test-connection/route");
    const elsewhereFile = join(scratch, "elsewhere.db");

    const byId = await POST(post("db/test-connection", { connectionId: "seed:shop" }) as never);
    // The copy keeps the seed's id, so the server resolves the seed file and ignores the copy's
    // own database path: nothing is opened at `elsewhere.db`.
    const editedCopy = await POST(
      post("db/test-connection", {
        connection: { ...CUSTOM_CONNECTION, id: "seed:shop", name: "My edited copy", database: elsewhereFile },
      }) as never,
    );

    expect(byId.status).toBe(200);
    expect(((await byId.json()) as { success?: boolean }).success).toBe(true);
    expect(editedCopy.status).toBe(200);
    expect(((await editedCopy.json()) as { success?: boolean }).success).toBe(true);
    expect(existsSync(elsewhereFile)).toBe(false);
  });
});
