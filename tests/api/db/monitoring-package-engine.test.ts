/**
 * The monitoring, health, pool statistics, maintenance, maintenance preview and fleet health routes on an engine an
 * admitted provider package serves, through the real `resolveServedConnection`, the provider factory's real caches, the
 * real host core and the real monitoring and maintenance facades (docs/providers/CONTRACT.md, clauses C-66, C-67,
 * C-107, C-111 and C-112): the dashboard, the health read and fleet health answer the package's panels and health on
 * the record's metadata session, pool statistics the package's pool on its editor session, a maintenance run its
 * answer on the editor's session, or on the metadata session for a kill, and a preview its preview on the editor's;
 * each refuses by the record's or the session's offer by name, never as the route-level 501; a package's open failure
 * and each call's failure answer the one answer, logged once; the run's and the preview's sentences reach the client
 * as Studio's sentence where no register row grants the package its words; the maintenance audit names the engine
 * user the package's open answered; and a Studio error after the open is answered and logged as Studio's own.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function calls the hook a case sets. `@/lib/auth` is mocked, and the
 * query event sink's `recordQueryEvent`, which records each event a case reads. Paths are built with `path.join` by the
 * fixture, no file mode, link or line ending is read, and nothing awaits a timer: a run a case stops is stopped once
 * its hook was reached, a signal the hook gives, so every platform reaches the same step.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  CallContext,
  MaintenancePreviewRequest,
  MaintenanceRunRequest,
  MonitoringPanelRequest,
} from "@libredb/provider-sdk/calls";
import { EXECUTE_SLACK_MS } from "@/lib/api/editor-query";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { getServerAuditBuffer } from "@/lib/audit";
import { PACKAGE_SENTENCE_WITHHELD, PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import { logger } from "@/lib/logger";
import type { QueryEventInput } from "@/lib/query-events/types";
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
/** Each query event a route recorded, in order. */
const events: QueryEventInput[] = [];
const realSink = { ...(await import("@/lib/query-events/sink")) };
mock.module("@/lib/query-events/sink", () => ({
  ...realSink,
  recordQueryEvent: (input: QueryEventInput) => {
    events.push(input);
  },
}));

/** Each route under test, by its path under /api/db, and fleet health under /api/admin. */
const ROUTES: Readonly<Record<string, { POST: (req: never) => Promise<Response> }>> = {
  monitoring: await import("@/app/api/db/monitoring/route"),
  health: await import("@/app/api/db/health/route"),
  "pool-stats": await import("@/app/api/db/pool-stats/route"),
  maintenance: await import("@/app/api/db/maintenance/route"),
  "maintenance/preview": await import("@/app/api/db/maintenance/preview/route"),
  "fleet-health": await import("@/app/api/admin/fleet-health/route"),
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
/**
 * Two packages offering maintenance runs and previews, the second granted its words: an analyze on a row or over the
 * whole database, which previews, a vacuum likewise, which does not, and a session operation.
 */
const MAINT = "acmemaint";
const MAINT_WORDS = "acmemaintwords";
/** The maintenance specs the maintenance packages declare, each card field null. */
const MAINTENANCE_PACKAGE_SPECS = [
  { operation: "analyze", label: "Analyze", perEntity: true, global: true, preview: true },
  { operation: "vacuum", label: "Vacuum", perEntity: true, global: true, preview: false },
  { operation: "kill", label: "End", perEntity: false, global: false, preview: false },
].map((spec) => ({ title: null, description: null, confirmation: null, kinds: null, ...spec }));
const withMaintenance = {
  offered: ["maintenance.run", "maintenance.preview"],
  env: [DECLARED_VARIABLE],
  edit: (engine: Record<string, Record<string, unknown>>) => {
    engine.facets.maintenance = ["analyze", "vacuum", "kill"];
    engine.facets.maintenanceSpecs = structuredClone(MAINTENANCE_PACKAGE_SPECS);
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
      { name: "acme-maint", engine: MAINT, ...withMaintenance },
      { name: "acme-maint-words", engine: MAINT_WORDS, ...withMaintenance },
    ],
    {
      [WORDS]: { ownWords: "scrubbed" },
      [ONE]: { servesOneSession: "the tests' engine serves one session" },
      [MAINT_WORDS]: { ownWords: "scrubbed" },
    },
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

/** The run a package answers unless a case gives its own: a table of one row and a sentence generated at run time. */
function runAnswerOf(): Record<string, unknown> {
  return {
    success: true,
    executionTime: 5,
    message: `the engine reclaimed ${randomUUID()}`,
    rows: [{ pages: "12" }],
    fields: ["pages"],
  };
}

/** The preview a package answers unless a case gives its own, its sentences generated at run time. */
function previewOf(): Record<string, unknown> {
  return {
    summary: `reads ${randomUUID()} pages`,
    facts: [{ label: "Rows", value: "1200" }],
    note: `estimated ${randomUUID()}`,
  };
}

/** Hooks for `engine`'s package: open a fresh handle, close, and answer each monitoring read and maintenance call. */
function hooksFor(
  engine: string,
  options: {
    open?: () => Promise<unknown>;
    panel?: (request: MonitoringPanelRequest) => Promise<unknown>;
    health?: () => Promise<unknown>;
    poolStats?: () => Promise<unknown>;
    run?: (request: MaintenanceRunRequest) => Promise<unknown>;
    preview?: (request: MaintenancePreviewRequest) => Promise<unknown>;
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
    run: push("run", (_handle, request) =>
      (options.run ?? (() => Promise.resolve(runAnswerOf())))(request as MaintenanceRunRequest),
    ),
    preview: push("preview", (_handle, request) =>
      (options.preview ?? (() => Promise.resolve(previewOf())))(request as MaintenancePreviewRequest),
    ),
  });
  return seen;
}

/** The names of the calls `seen` recorded. */
const names = (seen: Seen) => seen.calls.map(({ name }) => name);

/** The context each monitoring call of `seen` was handed, its last argument. */
const contexts = (seen: Seen) =>
  seen.calls.filter(({ name }) => name !== "open" && name !== "close").map(({ args }) => args.at(-1) as CallContext);

/** A connection of `engine` with its own id and name, a statement timeout and a generated secret. */
function connectionOf(engine: string): Record<string, unknown> {
  return {
    id: `conn-${randomUUID()}`,
    name: `Monitored ${randomUUID()}`,
    type: engine,
    host: "monitored.local",
    password: randomUUID(),
    queryTimeout: 4_321,
  };
}

/** The status and body `route` answers for `body`, its request's signal `signal` where a case gives one. */
async function post(
  route: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  clearRateLimitState();
  const handler = ROUTES[route] as { POST: (req: never) => Promise<Response> };
  const path = route === "fleet-health" ? "admin/fleet-health" : `db/${route}`;
  const response = await handler.POST(
    new Request(`http://localhost:3000/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
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

/** The maintenance audit rows of `connection`, oldest first. */
function auditRowsOf(connection: Record<string, unknown>) {
  return getServerAuditBuffer()
    .getAll()
    .filter((row) => row.connectionName === connection.name);
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
  test("monitoring, health, pool statistics, maintenance and its preview answer a package engine through its package, each refused by the session's offer where it offers none", async () => {
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
      // A whole-database run on the editor's session and a kill on the metadata session, each answered with Studio's
      // sentence in place of the package's own, which no register row grants it.
      for (const request of [{ type: "vacuum" }, { type: "kill", target: "4242" }]) {
        const run = await post("maintenance", { connection, ...request });
        expect([request.type, run.status]).toEqual([request.type, 200]);
        expect(run.body).toMatchObject({ success: true, rows: [{ pages: "12" }], message: PACKAGE_SENTENCE_WITHHELD });
      }
      const after = Date.now();

      // The dashboard, the health read and the kill open the record's metadata session once beside the editor's, which
      // pool statistics and the vacuum read; a one-session package's five calls share its editor's session.
      expect(names(seen).filter((name) => name === "open")).toEqual(engine === ONE ? ["open"] : ["open", "open"]);
      expect(names(seen).filter((name) => name !== "open")).toEqual([
        "panel",
        "panel",
        "health",
        "poolStats",
        "run",
        "run",
      ]);
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
    // Its record lists no maintenance, so a run is refused by name before any open.
    const callsBefore = names(seen).length;
    const unlisted = await post("maintenance", { connection: connectionOf(BARE), type: "vacuum" });
    expect(unlisted.status).toBe(400);
    expect(unlisted.body).toMatchObject({
      error: `"vacuum" is not a maintenance operation LibreDB Studio offers on ${servedEngineRecord(BARE).displayName}, which offers none; no connection was opened and nothing was run.`,
      code: "FACET_NOT_OFFERED",
      outcome: "not-sent",
    });
    expect(names(seen)).toHaveLength(callsBefore);
    expect(names(seen).filter((name) => name !== "open")).toEqual(["health"]);

    // A maintenance package: a whole-database vacuum on the editor's session, a kill on the metadata session and the
    // preview of an analyze of one row on the editor's, each call under the declared environment and a deadline from
    // the connection's statement timeout; the sentences Studio's for a code-only package and its own for a granted
    // one; one audit row and one query event per run, the event's engine the package's.
    for (const engine of [MAINT, MAINT_WORDS]) {
      const granted = engine === MAINT_WORDS;
      const maintained = connectionOf(engine);
      const ownRun = runAnswerOf();
      const ownPreview = previewOf();
      const calls = hooksFor(engine, { run: async () => ownRun, preview: async () => ownPreview });
      events.length = 0;
      const before = Date.now();
      const vacuum = await post("maintenance", { connection: maintained, type: "vacuum" });
      const kill = await post("maintenance", { connection: maintained, type: "kill", target: "4242" });
      const preview = await post("maintenance/preview", {
        connection: maintained,
        type: "analyze",
        target: "orders",
        container: "app",
      });
      const after = Date.now();
      const runBody = granted ? ownRun : { ...ownRun, message: PACKAGE_SENTENCE_WITHHELD };
      expect(vacuum).toEqual({ status: 200, body: runBody });
      expect(kill).toEqual({ status: 200, body: runBody });
      expect(preview).toEqual({
        status: 200,
        body: {
          preview: granted
            ? ownPreview
            : { ...ownPreview, summary: PACKAGE_SENTENCE_WITHHELD, note: PACKAGE_SENTENCE_WITHHELD },
        },
      });
      expect(names(calls)).toEqual(["open", "run", "open", "run", "preview"]);
      expect(calls.calls.filter(({ name }) => name !== "open").map(({ args }) => args[1])).toEqual([
        { operation: "vacuum" },
        { operation: "kill", target: "4242" },
        { operation: "analyze", path: ["app", "orders"] },
      ]);
      for (const ctx of contexts(calls)) {
        expect(() => ctx.env.get("PATH")).toThrow();
        expect(ctx.deadline).toBeGreaterThanOrEqual(before + 4_321 + EXECUTE_SLACK_MS);
        expect(ctx.deadline).toBeLessThanOrEqual(after + 4_321 + EXECUTE_SLACK_MS);
      }
      expect(
        auditRowsOf(maintained).map(({ type, action, target, result, reason }) => [
          type,
          action,
          target,
          result,
          reason,
        ]),
      ).toEqual([
        ["maintenance", "VACUUM", "all", "success", undefined],
        ["kill_session", "KILL", "4242", "success", undefined],
      ]);
      expect(events.map(({ source, status, connection }) => [source, status, connection.engine])).toEqual([
        ["maintenance", "success", engine],
        ["maintenance", "success", engine],
      ]);
    }
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

describe("the maintenance routes and fleet health on a provider package's engine", () => {
  test("the maintenance routes refuse a package engine by the record's or the session's offer, by name, not-sent, and never answer 501", async () => {
    const displayName = servedEngineRecord(MAINT).displayName;
    // An operation the record does not list: refused by name before any open.
    const seen = hooksFor(MAINT);
    for (const route of ["maintenance", "maintenance/preview"]) {
      const unlisted = await post(route, { connection: connectionOf(MAINT), type: "optimize", target: "orders" });
      expect([route, unlisted.status, unlisted.body]).toEqual([
        route,
        400,
        expect.objectContaining({
          error: `"optimize" is not a maintenance operation LibreDB Studio offers on ${displayName}, which offers analyze, vacuum, kill; no connection was opened and nothing was run.`,
          code: "FACET_NOT_OFFERED",
          outcome: "not-sent",
        }),
      ]);
      // A catalog the record does not offer: refused by name, not-sent, before any open.
      const catalog = await post(route, {
        connection: connectionOf(MAINT),
        type: "analyze",
        target: "o",
        catalog: "shop",
      });
      expect([route, catalog.status, catalog.body]).toEqual([
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

    // A session whose open withdraws maintenance.run accepts none: refused after the open, nothing run, no row.
    const withdrawn = connectionOf(MAINT);
    const refusing = hooksFor(MAINT, {
      open: async () => ({
        handle: { session: randomUUID() },
        refine: { calls: { maintenance: { run: "not-offered", preview: "not-offered" } } },
      }),
    });
    events.length = 0;
    const none = await post("maintenance", { connection: withdrawn, type: "vacuum" });
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({
      error: `"vacuum" is not a maintenance operation the ${displayName} server this connection reaches accepts, which accepts none; nothing was run.`,
      code: "FACET_NOT_OFFERED",
      outcome: "not-sent",
    });
    expect(names(refusing)).toEqual(["open"]);
    expect([auditRowsOf(withdrawn), events]).toEqual([[], []]);

    // A session that narrows analyze to the whole database refuses a row by the placement sentence, on both routes.
    const narrowed = connectionOf(MAINT);
    const narrowing = hooksFor(MAINT, {
      open: async () => ({
        handle: { session: randomUUID() },
        refine: { maintenance: [{ operation: "analyze", perEntity: false, global: true }] },
      }),
    });
    for (const route of ["maintenance", "maintenance/preview"]) {
      const row = await post(route, { connection: narrowed, type: "analyze", target: "orders" });
      expect([route, row]).toEqual([
        route,
        {
          status: 400,
          body: { error: "Analyze takes no target on this database: it runs over the whole database. Omit 'target'." },
        },
      ]);
    }
    expect(names(narrowing)).toEqual(["open"]);

    // A preview of an operation whose spec does not preview, and one on a session that withdraws maintenance.preview.
    hooksFor(MAINT);
    const vacuumPreview = await post("maintenance/preview", {
      connection: connectionOf(MAINT),
      type: "vacuum",
      target: "o",
    });
    expect(vacuumPreview).toEqual({ status: 400, body: { error: "This operation has no preview" } });
    const unpreviewed = hooksFor(MAINT, {
      open: async () => ({
        handle: { session: randomUUID() },
        refine: { calls: { maintenance: { preview: "not-offered" } } },
      }),
    });
    const withdrawnPreview = await post("maintenance/preview", {
      connection: connectionOf(MAINT),
      type: "analyze",
      target: "o",
    });
    expect(withdrawnPreview).toEqual({ status: 400, body: { error: "This operation has no preview" } });
    expect(names(unpreviewed)).toEqual(["open"]);

    // No maintenance route answers a package engine 501, whatever its session offers.
    for (const engine of [MON, WORDS, BARE, ONE, MAINT, MAINT_WORDS]) {
      hooksFor(engine);
      for (const route of ["maintenance", "maintenance/preview"]) {
        const answer = await post(route, { connection: connectionOf(engine), type: "analyze", target: "o" });
        expect([engine, route, answer.status === 501]).toEqual([engine, route, false]);
        expect([engine, route, (answer.body as { code?: string }).code]).not.toEqual([
          engine,
          route,
          "PACKAGE_ENGINE_UNSUPPORTED",
        ]);
      }
    }
  });

  test("a package's open failure and each maintenance call's failure answer the one answer, code-only and granted, logged once, and the run's and the preview's sentences reach the client as Studio's sentence where no row grants the words", async () => {
    const lines = loggedLines();
    for (const engine of [MAINT, MAINT_WORDS]) {
      const granted = engine === MAINT_WORDS;

      // The open fails, its words naming the connection's secret: not-sent, Studio's sentence or the words through
      // core's scrub, logged once, nothing audited or recorded.
      for (const [route, body] of [
        ["maintenance", { type: "vacuum" }],
        ["maintenance/preview", { type: "analyze", target: "orders" }],
      ] as const) {
        const connection = connectionOf(engine);
        const words = `the store is away for ${String(connection.password)}`;
        hooksFor(engine, { open: () => Promise.reject(new Error(words)) });
        events.length = 0;
        const opened = await post(route, { connection, ...body });
        expect([route, opened.status]).toEqual([route, 503]);
        expect(opened.body).toMatchObject({ code: "CONNECTION_ERROR", outcome: "not-sent" });
        const sentence = (opened.body as { error: string }).error;
        if (granted) expect(sentence).toBe(PROVIDER_TEXT_WITHHELD);
        else
          expect(sentence).toMatch(/^The provider package's open failed \(.+\); the server's log holds its words\.$/);
        const logged = lines();
        expect(logged.map(([message]) => message)).toEqual(["A provider package's open failed"]);
        expect(JSON.stringify([opened.body, logged])).not.toContain(String(connection.password));
        expect([auditRowsOf(connection), events]).toEqual([[], []]);
      }

      // A run and a preview that reject: 500, Studio's sentence or the words, one line each; the run audited as failed.
      const connection = connectionOf(engine);
      const own = `the store failed ${randomUUID()}`;
      hooksFor(engine, {
        run: () => Promise.reject(new Error(own)),
        preview: () => Promise.reject(new Error(own)),
      });
      events.length = 0;
      for (const [route, body, call] of [
        ["maintenance", { type: "vacuum" }, "maintenance run"],
        ["maintenance/preview", { type: "analyze", target: "orders" }, "maintenance preview"],
      ] as const) {
        const failed = await post(route, { connection, ...body });
        expect([route, failed.status]).toEqual([route, 500]);
        expect((failed.body as { error: string }).error).toBe(
          granted ? own : `The provider package's ${call} failed (INTERNAL_ERROR); the server's log holds its words.`,
        );
        expect(lines().map(([message]) => message)).toEqual([`A provider package's ${call} failed`]);
      }
      expect(auditRowsOf(connection).map(({ result, reason }) => [result, reason])).toEqual([
        ["failure", "maintenance_execution_failed"],
      ]);
      expect(events.map(({ status }) => status)).toEqual(["error"]);

      // A run answer with rows and no fields is the package's defect, named by its rule, one line, audited as failed.
      hooksFor(engine, {
        run: async () => {
          const answer = runAnswerOf();
          delete answer.fields;
          return answer;
        },
      });
      const malformed = await post("maintenance", { connection, type: "vacuum" });
      expect(malformed.status).toBe(500);
      const defect = (malformed.body as { error: string }).error;
      expect(defect.startsWith(PACKAGE_DEFECT_PREFIX)).toBe(true);
      if (!granted) {
        expect(defect).toBe(
          `${PACKAGE_DEFECT_PREFIX} it broke the rule maintenance-run-answer-unreadable; the server's log names where.`,
        );
      }
      expect(lines().map(([message]) => message)).toEqual(["A provider package's maintenance run failed"]);

      // A run's message and a preview's summary, refusal and note: Studio's sentence where no row grants the words,
      // each logged once through core's scrub, and the words through the scrub where one does.
      const secret = `refused for ${String(connection.password)}`;
      const message = `reclaimed ${randomUUID()}`;
      hooksFor(engine, {
        run: async () => ({ success: false, executionTime: 1, message }),
        preview: async () => ({ summary: message, facts: [], refusal: secret, note: message }),
      });
      const run = await post("maintenance", { connection, type: "vacuum" });
      const preview = await post("maintenance/preview", { connection, type: "analyze", target: "orders" });
      expect(run).toEqual({
        status: 200,
        body: { success: false, executionTime: 1, message: granted ? message : PACKAGE_SENTENCE_WITHHELD },
      });
      expect(preview).toEqual({
        status: 200,
        body: {
          preview: granted
            ? { summary: message, facts: [], refusal: PROVIDER_TEXT_WITHHELD, note: message }
            : {
                summary: PACKAGE_SENTENCE_WITHHELD,
                facts: [],
                refusal: PACKAGE_SENTENCE_WITHHELD,
                note: PACKAGE_SENTENCE_WITHHELD,
              },
        },
      });
      const reasons = lines();
      const reasonLine = (route: string, reason: string): [string, string] => [
        "A provider package's answer gave a reason",
        JSON.stringify({ route, reason }),
      ];
      expect(reasons).toEqual(
        granted
          ? []
          : [
              reasonLine("POST /api/db/maintenance", message),
              reasonLine("POST /api/db/maintenance/preview", message),
              reasonLine("POST /api/db/maintenance/preview", PROVIDER_TEXT_WITHHELD),
              reasonLine("POST /api/db/maintenance/preview", message),
            ],
      );
      expect(JSON.stringify([run, preview, reasons])).not.toContain(String(connection.password));
    }
  });

  test("a maintenance run a package engine's session refuses before the call answers Studio's not-sent error, logged as Studio's own, with no audit row", async () => {
    const connection = connectionOf(MAINT);
    const seen = hooksFor(MAINT);
    const lines = loggedLines();
    events.length = 0;
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));
    const gone = await post("maintenance", { connection, type: "vacuum" }, caller.signal);
    expect(gone.status).toBe(499);
    expect(gone.body).toMatchObject({ code: "QUERY_CANCELLED", outcome: "not-sent" });
    expect(names(seen)).toEqual(["open"]);
    expect(auditRowsOf(connection)).toEqual([]);
    expect(events.map(({ status }) => status)).toEqual(["cancelled"]);
    expect(lines().filter(([message]) => message.startsWith("A provider package's"))).toEqual([]);
  });

  test("a package engine's maintenance audit row names the engine user its open answered, and a row of an open that answered none has no such key", async () => {
    const engineUser = `user-${randomUUID()}`;
    const opens = () => Promise.resolve({ handle: { session: randomUUID() }, engineUser });
    loggedLines();

    // Completed and failed.
    const connection = connectionOf(MAINT);
    hooksFor(MAINT, { open: opens });
    expect((await post("maintenance", { connection, type: "vacuum" })).status).toBe(200);
    hooksFor(MAINT, { open: opens, run: () => Promise.reject(new Error(randomUUID())) });
    expect((await post("maintenance", { connection, type: "vacuum" })).status).toBe(500);

    // Stopped once the run was reached: an unknown outcome, the run settled after the answer.
    let reached!: () => void;
    const running = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let settle!: () => void;
    hooksFor(MAINT, {
      open: opens,
      run: () =>
        new Promise((resolve) => {
          settle = () => resolve(runAnswerOf());
          reached();
        }),
    });
    const caller = new AbortController();
    const stopping = post("maintenance", { connection, type: "vacuum" }, caller.signal);
    await running;
    caller.abort(new DOMException("The request went away.", "AbortError"));
    const stopped = await stopping;
    settle();
    expect(stopped.status).toBe(499);
    expect(stopped.body).toMatchObject({ outcome: "unknown" });
    expect(auditRowsOf(connection).map(({ result, reason, engineUser: user }) => [result, reason, user])).toEqual([
      ["success", undefined, engineUser],
      ["failure", "maintenance_execution_failed", engineUser],
      ["failure", "maintenance_outcome_unknown", engineUser],
    ]);

    // An open that answered no engine user writes rows with no such key.
    const unnamed = connectionOf(MAINT);
    hooksFor(MAINT);
    expect((await post("maintenance", { connection: unnamed, type: "vacuum" })).status).toBe(200);
    const [row] = auditRowsOf(unnamed);
    expect(row === undefined ? null : "engineUser" in row).toBe(false);
  });

  test("fleet health reads a package engine's health", async () => {
    const lines = loggedLines();
    const healthy = connectionOf(MON);
    const failing = connectionOf(MON);
    const unopened = connectionOf(BARE);
    const seen = hooksFor(MON, {
      panel: async () => ({ overview: { ...overviewOf(), databaseSizeBytes: 1_048_576 } }),
    });
    hooksFor(BARE, { open: () => Promise.reject(new Error(`the store is away for ${String(unopened.password)}`)) });
    const answer = await post("fleet-health", { connections: [healthy] });
    expect(answer.status).toBe(200);
    expect((answer.body as { results: unknown[] }).results).toEqual([
      expect.objectContaining({
        connectionId: healthy.id,
        type: MON,
        status: "healthy",
        activeConnections: 2,
        databaseSize: "1 MB",
        databaseSizeBytes: 1_048_576,
      }),
    ]);
    // One open, of the metadata session, and no declarations read: the record offers none.
    expect(names(seen)).toEqual(["open", "health", "panel"]);
    expect(lines()).toEqual([]);

    // A code-only package whose health rejects answers its row's error in Studio's sentence, logged once, beside the
    // healthy row; an open failure answers the row's error as the open's not-sent sentence.
    hooksFor(MON, { health: () => Promise.reject(new Error(randomUUID())) });
    const rows = await post("fleet-health", { connections: [failing, unopened] });
    const results = (rows.body as { results: Record<string, unknown>[] }).results;
    expect(results.map(({ connectionId, status, error }) => [connectionId, status, error])).toEqual([
      [failing.id, "error", "The provider package's health failed (INTERNAL_ERROR); the server's log holds its words."],
      [
        unopened.id,
        "error",
        expect.stringMatching(/^The provider package's open failed \(.+\); the server's log holds its words\.$/),
      ],
    ]);
    expect(
      lines()
        .map(([message]) => message)
        .sort(),
    ).toEqual(["A provider package's health failed", "A provider package's open failed"]);
    expect(JSON.stringify(rows.body)).not.toContain(String(unopened.password));
  });
});
