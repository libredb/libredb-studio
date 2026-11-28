/**
 * The monitoring, health and pool statistics routes on an engine an admitted provider package serves, through the real
 * `resolveServedConnection`, the provider factory's real caches, the real host core and the real monitoring facade
 * (docs/providers/CONTRACT.md, clauses C-66, C-107, C-111 and C-112): the dashboard and the health read answer the
 * package's panels and health on the record's metadata session, and pool statistics the package's pool on its editor
 * session; each refuses by the record's or the session's offer by name, never as the route-level 501; a package's open
 * failure and each read's failure answer the one answer, logged once; and a Studio error after the open is answered and
 * logged as Studio's own.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function calls the hook a case sets. Only `@/lib/auth` is mocked.
 * Paths are built with `path.join` by the fixture, no file mode, link or line ending is read, and nothing awaits a
 * timer, so every platform reaches the same step.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext, MonitoringPanelRequest } from "@libredb/provider-sdk/calls";
import { EXECUTE_SLACK_MS } from "@/lib/api/editor-query";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";
import { parseResponseJSON } from "../../helpers/mock-next";
import { admitSessionPackages, setHooks } from "../../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";

const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin", iat: 1_700_000_000 })),
  readSession: mock(async () => ({
    kind: "authenticated",
    session: { role: "admin", username: "admin", iat: 1_700_000_000 },
  })),
}));

/** Each route under test, by its path under /api/db. */
const ROUTES: Readonly<Record<string, { POST: (req: never) => Promise<Response> }>> = {
  monitoring: await import("@/app/api/db/monitoring/route"),
  health: await import("@/app/api/db/health/route"),
  "pool-stats": await import("@/app/api/db/pool-stats/route"),
};
const factory = await import("@/lib/db/factory");

/**
 * A package offering panels, pool statistics and maintenance runs, granted no words; one granted its words; one
 * offering neither panels nor pool statistics; and one whose connection serves one session.
 */
const MON = "acmemon";
const WORDS = "acmemonwords";
const BARE = "acmemonbare";
const ONE = "acmemonone";
/** The variable each package declares, which no case sets. */
const DECLARED_VARIABLE = "LIBREDB_TEST_ACMEMON";

/** The maintenance the monitoring packages declare: a typed whole-database card and a session operation. */
const MAINTENANCE_SPECS = [
  {
    operation: "vacuum",
    label: "Reclaim",
    perEntity: false,
    global: true,
    title: "Reclaim the store",
    description: "Reclaims the space the store no longer uses.",
    confirmation: "typed",
    preview: false,
    kinds: null,
  },
  {
    operation: "kill",
    label: "End",
    perEntity: false,
    global: false,
    title: null,
    description: null,
    confirmation: null,
    preview: false,
    kinds: null,
  },
];
const withMonitoring = {
  offered: ["monitoring.panel", "monitoring.poolStats", "maintenance.run"],
  env: [DECLARED_VARIABLE],
  edit: (engine: Record<string, Record<string, unknown>>) => {
    const panels = engine.facets.monitoring as Record<string, unknown>;
    panels.tables = "offered";
    engine.facets.maintenance = ["vacuum", "kill"];
    engine.facets.maintenanceSpecs = structuredClone(MAINTENANCE_SPECS);
  },
};
const providers = scratchDirectory("studio-package-engine-monitoring-");

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  await admitSessionPackages(
    providers,
    [
      { name: "acme-mon", engine: MON, ...withMonitoring },
      { name: "acme-mon-words", engine: WORDS, ...withMonitoring },
      { name: "acme-mon-bare", engine: BARE, env: [DECLARED_VARIABLE] },
      { name: "acme-mon-one", engine: ONE, ...withMonitoring },
    ],
    { [WORDS]: { ownWords: "scrubbed" }, [ONE]: { servesOneSession: "the tests' engine serves one session" } },
  );
});
afterAll(async () => {
  await factory.clearProviderCache();
  removeScratch(providers);
});

let spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

/** What one package's hooks saw, by call name. */
interface Seen {
  readonly calls: { name: string; args: unknown[] }[];
}

/** An overview panel's figures, its text generated at run time. */
function overviewOf(): Record<string, unknown> {
  return {
    version: randomUUID(),
    uptime: "1 day",
    maxConnections: 10,
    databaseSize: "1 MB",
    tableCount: 1,
    indexCount: 0,
  };
}

/** A health answer of the SDK's form. */
function healthOf(): Record<string, unknown> {
  return { activeConnections: 2, databaseSize: "1 MB", cacheHitRatio: "99%", slowQueries: [], activeSessions: [] };
}

/** The answers a package gives unless a case gives its own. */
const ANSWERS = {
  overview: overviewOf(),
  tables: [],
  health: healthOf(),
  pool: { total: 4, idle: 1, active: 3, waiting: 0 },
};

/** Hooks for `engine`'s package: open a fresh handle, close, and answer each monitoring read. */
function hooksFor(
  engine: string,
  options: {
    open?: () => Promise<unknown>;
    panel?: (request: MonitoringPanelRequest) => Promise<unknown>;
    health?: () => Promise<unknown>;
    poolStats?: () => Promise<unknown>;
  } = {},
): Seen {
  const seen: Seen = { calls: [] };
  const push =
    (name: string, answer: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      seen.calls.push({ name, args });
      return answer(...args);
    };
  setHooks(engine, {
    open: push("open", options.open ?? (() => Promise.resolve({ handle: { session: randomUUID() } }))),
    close: push("close", () => Promise.resolve()),
    panel: push("panel", (_handle, request) =>
      (
        options.panel ??
        ((asked: MonitoringPanelRequest) =>
          Promise.resolve(asked.panel === "overview" ? { overview: ANSWERS.overview } : { tables: ANSWERS.tables }))
      )(request as MonitoringPanelRequest),
    ),
    health: push("health", () => (options.health ?? (() => Promise.resolve(ANSWERS.health)))()),
    poolStats: push("poolStats", () => (options.poolStats ?? (() => Promise.resolve(ANSWERS.pool)))()),
  });
  return seen;
}

/** The names of the calls `seen` recorded. */
const names = (seen: Seen) => seen.calls.map(({ name }) => name);

/** The context each monitoring call of `seen` was handed, its last argument. */
const contexts = (seen: Seen) =>
  seen.calls.filter(({ name }) => name !== "open" && name !== "close").map(({ args }) => args.at(-1) as CallContext);

/** A connection of `engine` with its own id, a statement timeout and a generated secret. */
function connectionOf(engine: string): Record<string, unknown> {
  return {
    id: `conn-${randomUUID()}`,
    name: "Monitored",
    type: engine,
    host: "monitored.local",
    password: randomUUID(),
    queryTimeout: 4_321,
  };
}

/** The status and body `route` answers for `body`. */
async function post(route: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  clearRateLimitState();
  const handler = ROUTES[route] as { POST: (req: never) => Promise<Response> };
  const response = await handler.POST(
    new Request(`http://localhost:3000/api/db/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<unknown>(response) };
}

/** The lines `logger.error` and `logger.warn` write while the case runs, each as its message and its error's words. */
function loggedLines(): () => [string, string][] {
  const lines: [string, string][] = [];
  const record = (message: unknown, payload?: unknown) => {
    lines.push([String(message), payload instanceof Error ? payload.message : JSON.stringify(payload ?? null)]);
  };
  spies.push(
    spyOn(logger, "error").mockImplementation(record),
    spyOn(logger, "warn").mockImplementation(record),
    spyOn(logger, "info").mockImplementation(() => undefined),
  );
  return () => lines.splice(0);
}

/** The Studio form of the maintenance the monitoring packages declare. */
const ACCEPTED = {
  maintenanceOperations: ["vacuum", "kill"],
  maintenanceOperationSpecs: {
    vacuum: {
      label: "Reclaim",
      perEntity: false,
      global: true,
      title: "Reclaim the store",
      description: "Reclaims the space the store no longer uses.",
      confirmation: "typed",
    },
    kill: { label: "End", perEntity: false, global: false },
  },
};

describe("the monitoring routes on a provider package's engine", () => {
  test("monitoring, health and pool statistics answer a package engine through its package, each refused by the session's offer where it offers none", async () => {
    for (const engine of [MON, ONE]) {
      const connection = connectionOf(engine);
      const seen = hooksFor(engine);
      const before = Date.now();
      const dashboard = await post("monitoring", { connection });
      expect(dashboard.status).toBe(200);
      expect(dashboard.body).toMatchObject({
        overview: ANSWERS.overview,
        tables: [],
        notOffered: ["performance", "slowQueries", "activeSessions", "indexes", "storage"],
        maintenance: ACCEPTED,
      });
      expect(await post("health", { connection })).toEqual({ status: 200, body: ANSWERS.health });
      expect(await post("pool-stats", { connection })).toEqual({ status: 200, body: ANSWERS.pool });
      const after = Date.now();

      // The dashboard and the health read open the record's metadata session once beside the editor's, which pool
      // statistics reads; a one-session package's three reads share its editor's session.
      expect(names(seen).filter((name) => name === "open")).toEqual(engine === ONE ? ["open"] : ["open", "open"]);
      expect(names(seen).filter((name) => name !== "open")).toEqual(["panel", "panel", "health", "poolStats"]);
      // Each call carries the package's declared environment and a deadline from the connection's statement timeout.
      for (const ctx of contexts(seen)) {
        expect(ctx.env.get(DECLARED_VARIABLE)).toBeUndefined();
        expect(() => ctx.env.get("PATH")).toThrow();
        expect(ctx.deadline).toBeGreaterThanOrEqual(before + 4_321 + EXECUTE_SLACK_MS);
        expect(ctx.deadline).toBeLessThanOrEqual(after + 4_321 + EXECUTE_SLACK_MS);
      }
    }

    // A session that offers neither panels nor pool statistics: the dashboard refused by name, the health read answered,
    // and pool statistics' zeros.
    const connection = connectionOf(BARE);
    const seen = hooksFor(BARE);
    const refused = await post("monitoring", { connection });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: "This connection's provider package does not offer monitoring.panel, so Studio did not call it.",
      code: "FACET_NOT_OFFERED",
      outcome: "not-sent",
    });
    expect(await post("health", { connection })).toEqual({ status: 200, body: ANSWERS.health });
    expect(await post("pool-stats", { connection })).toEqual({
      status: 200,
      body: { total: 0, idle: 0, active: 0, waiting: 0, message: "Pool statistics not available for this provider" },
    });
    expect(names(seen).filter((name) => name !== "open")).toEqual(["health"]);
  });

  test("the monitoring, health and pool statistics routes refuse a package engine by the record's or the session's offer, by name, not-sent, and never answer 501", async () => {
    // A catalog the record does not offer is refused before any open.
    const connection = connectionOf(MON);
    const seen = hooksFor(MON);
    for (const route of ["monitoring", "health", "pool-stats"]) {
      const answer = await post(route, { connection, catalog: "shop" });
      expect([route, answer.status, answer.body]).toEqual([
        route,
        400,
        expect.objectContaining({
          error: "This connection's engine offers no catalog session in this LibreDB Studio, so Studio opened nothing.",
          code: "FACET_NOT_OFFERED",
          outcome: "not-sent",
        }),
      ]);
    }
    expect(names(seen)).toEqual([]);

    // No route answers a package engine 501, whatever the session offers.
    for (const engine of [MON, WORDS, BARE, ONE]) {
      hooksFor(engine);
      const engineConnection = connectionOf(engine);
      for (const route of ["monitoring", "health", "pool-stats"]) {
        const answer = await post(route, { connection: engineConnection });
        expect([engine, route, answer.status === 501]).toEqual([engine, route, false]);
        expect([engine, route, (answer.body as { code?: string }).code]).not.toEqual([
          engine,
          route,
          "PACKAGE_ENGINE_UNSUPPORTED",
        ]);
      }
    }
  });

  test("a package's open failure and each monitoring read's failure answer the one answer, code-only and granted, logged once, and a malformed answer answers the package's defect", async () => {
    const lines = loggedLines();
    for (const engine of [MON, WORDS]) {
      const granted = engine === WORDS;

      // The open fails, its words naming the connection's secret: not-sent, Studio's sentence or the words through
      // core's scrub, logged once.
      for (const route of ["monitoring", "health", "pool-stats"]) {
        const connection = connectionOf(engine);
        const words = `the monitor is away for ${String(connection.password)}`;
        hooksFor(engine, { open: () => Promise.reject(new Error(words)) });
        const opened = await post(route, { connection });
        expect([route, opened.status]).toEqual([route, 503]);
        expect(opened.body).toMatchObject({ code: "CONNECTION_ERROR", outcome: "not-sent" });
        const sentence = (opened.body as { error: string }).error;
        if (granted) expect(sentence).toBe(PROVIDER_TEXT_WITHHELD);
        else
          expect(sentence).toMatch(/^The provider package's open failed \(.+\); the server's log holds its words\.$/);
        const logged = lines();
        expect(logged.map(([message]) => message)).toEqual(["A provider package's open failed"]);
        expect(JSON.stringify([opened.body, logged])).not.toContain(String(connection.password));
      }

      // A health read and a pool statistics read that reject: 500, Studio's sentence or the words, one line each.
      const connection = connectionOf(engine);
      const own = `the monitor failed ${randomUUID()}`;
      hooksFor(engine, {
        health: () => Promise.reject(new Error(own)),
        poolStats: () => Promise.reject(new Error(own)),
        panel: async (request) => {
          if (request.panel === "tables") throw new Error(own);
          return { overview: ANSWERS.overview };
        },
      });
      for (const [route, call] of [
        ["health", "health"],
        ["pool-stats", "pool statistics read"],
      ] as const) {
        const failed = await post(route, { connection });
        expect([route, failed.status]).toEqual([route, 500]);
        expect((failed.body as { error: string }).error).toBe(
          granted ? own : `The provider package's ${call} failed (INTERNAL_ERROR); the server's log holds its words.`,
        );
        expect(lines().map(([message]) => message)).toEqual([`A provider package's ${call} failed`]);
      }

      // A dashboard whose one panel rejects keeps the other panel and holds the answer's sentence, one line.
      const dashboard = await post("monitoring", { connection });
      expect(dashboard.status).toBe(200);
      expect(dashboard.body).toMatchObject({
        overview: ANSWERS.overview,
        errors: {
          tables: granted
            ? own
            : "The provider package's panel read failed (INTERNAL_ERROR); the server's log holds its words.",
        },
      });
      expect(lines().map(([message]) => message)).toEqual(["A provider package's panel read failed"]);

      // A health answer missing its database size is the package's defect, named by its rule, one line.
      hooksFor(engine, {
        health: async () => {
          const { databaseSize: _, ...rest } = healthOf();
          return rest;
        },
      });
      const malformed = await post("health", { connection });
      expect(malformed.status).toBe(500);
      const defect = (malformed.body as { error: string }).error;
      expect(defect.startsWith(PACKAGE_DEFECT_PREFIX)).toBe(true);
      if (!granted) {
        expect(defect).toBe(
          `${PACKAGE_DEFECT_PREFIX} it broke the rule health-answer-unreadable; the server's log names where.`,
        );
      }
      const defectLines = lines();
      expect(defectLines.map(([message]) => message)).toEqual(["A provider package's health failed"]);
      expect(defectLines[0]?.[1].startsWith(PACKAGE_DEFECT_PREFIX)).toBe(true);
      expect(JSON.stringify([dashboard.body, malformed.body])).not.toContain(String(connection.password));
    }
  });

  test("a Studio error after a package engine's open is answered and logged as Studio's own, never as the package's", async () => {
    const connection = connectionOf(MON);
    const seen = hooksFor(MON);
    // The metadata session is open and cached before the host core is forgotten.
    expect((await post("health", { connection })).status).toBe(200);
    const lines = loggedLines();
    const real = hostCore();
    forgetHostCore();
    let answer: { status: number; body: unknown };
    try {
      answer = await post("monitoring", { connection });
    } finally {
      installHostCore(real, "test");
    }
    expect(answer.status).toBe(500);
    expect(answer.body).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(lines().map(([message]) => message)).toEqual(["Unhandled error"]);
    expect(names(seen)).toEqual(["open", "health"]);
  });
});
