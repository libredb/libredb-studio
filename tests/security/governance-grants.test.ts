/**
 * Threat: a signed-in account opening a governed connection it holds no grant for (docs/SECURITY.md, control 0.8).
 *
 * Under governance the governance source is Studio's only catalog of connections, and a grant to the session's
 * identity provider subject is the only way to one. This file proves it on the routes themselves: every route that
 * turns a request body into a connection answers a connection granted to someone else and one that does not exist
 * with the same 404 CONNECTION_NOT_FOUND, refuses a connection the caller supplies with 403
 * CUSTOM_CONNECTIONS_DISABLED, and builds no provider for either, for an admin as for a user, because the admin role
 * toggles admin pages and maintenance only. The route inventory is `CONNECTION_ROUTES` in
 * ./helpers/provider-routes.ts, which every provider route joins unless it is named there with the reason it passes no
 * request body to `resolveConnection`.
 *
 * The snapshot is the real one: Studio's own loader reads it from a fake `pg` that answers a governance source's rows
 * (tests/helpers/governance/pg-fake.ts), with envelopes sealed by the test sealer to a keyring file of a fresh key, so
 * admission and the effective grant rules are the code that runs in production. A provider is counted where it is
 * built: the factory logs `[DB] Creating <type> provider` for every one, as tests/security/custom-connections.test.ts
 * relies on, and the control at the end sees that line for a granted connection.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as auth from "@/lib/auth";
import { keyringFileOf, removeKeyringFiles, testKey } from "../helpers/governance/keyring-file";
import { sealSecret } from "../helpers/governance/lsb1-seal";
import { answerSnapshot, contractRow, FakePool, fakePg } from "../helpers/governance/pg-fake";
import {
  API_ROOT_DIR,
  CONNECTION_ROUTES,
  PROVIDER_ROUTES,
  PROVIDER_ROUTES_WITHOUT_A_CONNECTION_BODY,
} from "./helpers/provider-routes";

const realPg = await import("pg");
mock.module("pg", () => ({ Pool: FakePool, Client: realPg.Client, types: realPg.types }));

const ISSUER = "https://idp.example.com/realms/libredb";
const ADMIN: auth.UserPayload = {
  role: "admin",
  username: "admin@example.com",
  idpSubject: "admin-subject",
  idpIssuer: ISSUER,
};
const ALICE: auth.UserPayload = {
  role: "user",
  username: "alice@example.com",
  idpSubject: "alice-subject",
  idpIssuer: ISSUER,
};
const BOB: auth.UserPayload = {
  role: "user",
  username: "bob@example.com",
  idpSubject: "bob-subject",
  idpIssuer: ISSUER,
};

const { loadGovernanceSnapshot } = await import("@/lib/governance/snapshot");
const { closeGovernancePool } = await import("@/lib/governance/db");
const { governanceState, recordGovernanceFailure, recordGovernanceSnapshot, resetGovernanceState } = await import(
  "@/lib/governance/state"
);
const { resetGovernanceKeyring } = await import("@/lib/governance/keyring");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { logger } = await import("@/lib/logger");
const { GET: listManaged } = await import("@/app/api/connections/managed/route");

const KEY = testKey();

const ORDERS_DEFINITION = { host: "orders.db.example.internal", port: 5432, database: "orders" };
/** A PostgreSQL definition without a database reaches every database its credential can: never admitted. */
const SERVER_WIDE_DEFINITION = { host: "cluster.db.example.internal", port: 5432 };

function connectionRow(id: string, definition: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const seal = (level: "read" | "write", user: string) =>
    sealSecret(
      KEY.publicKey,
      { connectionId: id, level, engine: "postgres", definition },
      {
        user,
        password: `example-only-${id}-${level}-password`,
      },
    );
  return {
    connection_id: id,
    name: `Connection ${id}`,
    engine: "postgres",
    environment: "production",
    group_name: null,
    color: null,
    definition,
    read_secret: seal("read", "reader"),
    write_secret: seal("write", "writer"),
    mcp_enabled: false,
    updated_at: new Date("2026-10-15T08:00:00.000Z"),
  };
}

const grantRow = (subject: string, connectionId: string, level: "read" | "write") => ({
  subject,
  connection_id: connectionId,
  level,
  expires_at: null,
  downgraded: false,
  granted_at: new Date("2026-10-15T08:00:00.000Z"),
});

/** Alice holds orders; Bob holds a grant on a server-level row, which admission skips; the admin holds nothing. */
const SOURCE = {
  contract: [contractRow(1)],
  connections: [connectionRow("orders", ORDERS_DEFINITION), connectionRow("server-wide", SERVER_WIDE_DEFINITION)],
  grants: [
    grantRow(ALICE.idpSubject as string, "orders", "read"),
    grantRow(BOB.idpSubject as string, "server-wide", "write"),
  ],
  settings: [],
  revocations: [],
  canary: [],
};

const ENV: Readonly<Record<string, string | undefined>> = {
  GOVERNANCE_SOURCE: "postgres",
  GOVERNANCE_POSTGRES_URL: "postgresql://libredb_studio:example-only-url-password@db.internal:5432/libredb",
  GOVERNANCE_PRIVATE_KEYS_FILE: keyringFileOf(KEY),
  GOVERNANCE_POSTGRES_SCHEMA: undefined,
  GOVERNANCE_ALLOWED_ENGINES: undefined,
  GOVERNANCE_REFRESH_MS: undefined,
  GOVERNANCE_MAX_STALENESS_MS: undefined,
  ALLOW_CUSTOM_CONNECTIONS: undefined,
};
const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** The snapshot the loader read in beforeAll, swapped back in fresh before every test. */
let loaded: NonNullable<ReturnType<typeof governanceState>["snapshot"]>;

beforeAll(async () => {
  for (const [name, value] of Object.entries(ENV)) {
    saved.set(name, process.env[name]);
    setEnv(name, value);
  }
  fakePg.respond = answerSnapshot(SOURCE);
  // The loader announces the load and the skipped row; nothing here reads those lines.
  const quiet = [spyOn(logger, "info"), spyOn(logger, "warn")].map((spy) => spy.mockImplementation(() => {}));
  try {
    await loadGovernanceSnapshot();
  } finally {
    for (const spy of quiet) spy.mockRestore();
  }
  const { snapshot, failure } = governanceState();
  if (snapshot === null) throw new Error(`the governance snapshot did not load: ${failure?.detail ?? "no failure"}`);
  loaded = snapshot;
});

afterAll(async () => {
  await closeGovernancePool();
  resetGovernanceState();
  resetGovernanceKeyring();
  removeKeyringFiles();
  fakePg.reset();
  for (const [name, value] of saved) setEnv(name, value);
});

/** The session reader, answering as the admin unless a test signs another account in with `signIn`. */
let getSession: ReturnType<typeof spyOn>;
let readSession: ReturnType<typeof spyOn>;

const signIn = (session: auth.UserPayload): void => {
  getSession.mockResolvedValue(session);
};

beforeEach(() => {
  clearRateLimitState();
  recordGovernanceSnapshot({ ...loaded, loadedAt: Date.now() });
  getSession = spyOn(auth, "getSession").mockResolvedValue(ADMIN);
  readSession = spyOn(auth, "readSession").mockImplementation(async () => {
    const s = await auth.getSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  });
});

afterEach(() => {
  getSession.mockRestore();
  readSession.mockRestore();
});

/** A connection that would really open if anything let it through. */
const CUSTOM_CONNECTION = {
  id: "custom-target",
  name: "Custom target",
  type: "postgres",
  host: "platform-postgres",
  port: 5432,
  database: "platform",
  user: "postgres",
  password: "guessed",
  createdAt: "2026-10-15T08:00:00.000Z",
};

const NOT_FOUND_BODY = {
  error: "Connection not found: it does not exist or is not granted to you",
  code: "CONNECTION_NOT_FOUND",
  statusCode: 404,
};
const CUSTOM_REFUSAL_BODY = {
  error: "Custom connections are disabled on this server",
  code: "CUSTOM_CONNECTIONS_DISABLED",
  statusCode: 403,
};

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

/** The connection ids the managed route lists for `session`. */
async function listedFor(session: auth.UserPayload): Promise<string[]> {
  signIn(session);
  const response = await listManaged();
  expect(response.status).toBe(200);
  return ((await response.json()) as { connections: { id: string }[] }).connections.map((connection) => connection.id);
}

/** Blanks out comments, as route-auth.test.ts does, so a mention in prose is not a call. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the connection route inventory", () => {
  // A listing bug that found nothing would make every route test below pass vacuously.
  test("the connection route inventory finds at least today's 22 routes", () => {
    expect(Object.keys(CONNECTION_ROUTES).length).toBeGreaterThanOrEqual(22);
  });

  test("every provider route is a connection route or is named with its reason, and never both", () => {
    const providerRoutes = PROVIDER_ROUTES.map(([route]) => route).sort();
    const classified = [...Object.keys(CONNECTION_ROUTES), ...Object.keys(PROVIDER_ROUTES_WITHOUT_A_CONNECTION_BODY)];

    expect([...classified].sort()).toEqual(providerRoutes);
    for (const reason of Object.values(PROVIDER_ROUTES_WITHOUT_A_CONNECTION_BODY)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  test("every connection route resolves its connection through resolveConnection or handleObjectRequest", () => {
    const resolves = /\b(resolveConnection|handleObjectRequest)\s*\(/;
    const unresolved = Object.keys(CONNECTION_ROUTES).filter(
      (route) => !resolves.test(withoutComments(readFileSync(join(API_ROOT_DIR, route, "route.ts"), "utf8"))),
    );

    expect(unresolved).toEqual([]);
  });
});

describe("under governance, a grant is the only way to a connection", () => {
  test("under governance an admin session without grants gets 404 CONNECTION_NOT_FOUND for a non-granted seed id and 403 CUSTOM_CONNECTIONS_DISABLED for an inline connection on every connection route, and no provider is constructed", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      // Keyed by route, so a failing route names itself in the diff below.
      const answers = Object.fromEntries(
        await Promise.all(
          Object.entries(CONNECTION_ROUTES).map(async ([route, body]) => {
            const handler = await postHandler(route);
            const [notGranted, notAdmitted, unknown, inline] = await Promise.all([
              // Granted to Alice, so it exists; the admin holds no grant on it.
              answer(handler, route, { ...body, connectionId: "seed:orders" }),
              // A grant row names it, but admission never admitted it.
              answer(handler, route, { ...body, connectionId: "seed:server-wide" }),
              answer(handler, route, { ...body, connectionId: "seed:no-such-connection" }),
              answer(handler, route, { ...body, connection: CUSTOM_CONNECTION }),
            ]);
            return [route, { notGranted, notAdmitted, unknown, inline }] as const;
          }),
        ),
      );

      const notFound = { status: 404, body: NOT_FOUND_BODY };
      expect(answers).toEqual(
        Object.fromEntries(
          Object.keys(CONNECTION_ROUTES).map((route) => [
            route,
            {
              notGranted: notFound,
              notAdmitted: notFound,
              unknown: notFound,
              inline: { status: 403, body: CUSTOM_REFUSAL_BODY },
            },
          ]),
        ),
      );
      expect(providersBuilt(log)).toBe(0);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("an inline connection on POST /api/db/query answers 403 CUSTOM_CONNECTIONS_DISABLED", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const handler = await postHandler("db/query");
      // Alice holds a grant, and an inline record of her own is still refused, as is one supplied as the whole body.
      signIn(ALICE);

      expect(await answer(handler, "db/query", { sql: "SELECT 1", connection: CUSTOM_CONNECTION })).toEqual({
        status: 403,
        body: CUSTOM_REFUSAL_BODY,
      });
      expect(providersBuilt(log)).toBe(0);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("another user's granted connection is neither listed nor resolvable, and a server-level postgres row is never admitted", async () => {
    // The row is skipped at admission, so Bob's write grant on it grants nothing.
    expect(loaded.skipped.map(({ item }) => item)).toEqual([
      { kind: "connection", id: "server-wide", path: "database", code: "SERVER_LEVEL_NOT_ALLOWED" },
    ]);
    expect([...loaded.connections.keys()]).toEqual(["orders"]);

    expect(await listedFor(BOB)).toEqual([]);
    expect(await listedFor(ADMIN)).toEqual([]);
    expect(await listedFor(ALICE)).toEqual(["seed:orders"]);

    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const handler = await postHandler("db/query");
      signIn(BOB);
      for (const connectionId of ["seed:orders", "seed:server-wide"]) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, as a browser sends them.
        expect(await answer(handler, "db/query", { sql: "SELECT 1", connectionId })).toEqual({
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

  test("while the snapshot cannot be served, a seed id answers 503 GOVERNANCE_UNAVAILABLE and an inline connection still 403", async () => {
    recordGovernanceFailure({
      at: Date.now(),
      kind: "misconfigured",
      code: "42501",
      detail: "bridge.grants_v1: denied",
      publicDetail: "bridge.grants_v1: 42501",
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const handler = await postHandler("db/query");
      signIn(ALICE);

      expect(await answer(handler, "db/query", { sql: "SELECT 1", connectionId: "seed:orders" })).toEqual({
        status: 503,
        body: {
          error: "Connection access is unavailable while this server cannot read its governance source",
          code: "GOVERNANCE_UNAVAILABLE",
          statusCode: 503,
        },
      });
      expect(await answer(handler, "db/query", { sql: "SELECT 1", connection: CUSTOM_CONNECTION })).toEqual({
        status: 403,
        body: CUSTOM_REFUSAL_BODY,
      });
    } finally {
      warn.mockRestore();
    }
  });

  // The control: the same detector, and a connection Alice holds. A zero above is a measurement and not a blind spot.
  test("the control: Alice's granted connection reaches the factory", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const handler = await postHandler("db/provider-meta");
      signIn(ALICE);

      // provider-meta builds a provider and reads its capabilities without opening a socket.
      const response = await handler(post("db/provider-meta", { connectionId: "seed:orders" }));

      expect(response.status).toBe(200);
      expect(providersBuilt(log)).toBe(1);
    } finally {
      log.mockRestore();
    }
  });
});
