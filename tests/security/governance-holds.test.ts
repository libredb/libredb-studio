/**
 * Governance mode holds MCP and the agent off (docs/GOVERNANCE.md): this version runs neither under governance, so
 * both stay off whatever LIBREDB_MCP_ENABLED, LIBREDB_AGENT_ENABLED and the AI configuration say. The boot preflight
 * refuses an environment that switches either on. This file proves that both stay off when that check is
 * bypassed (docs/GOVERNANCE.md#what-governance-mode-switches-off): GOVERNANCE_SOURCE, both switches and a configured
 * model are all set after boot.
 *
 * Every route under src/app/api/agent/ is found on disk, so a route added later is held here without editing this
 * file. A provider is counted where it is built: a database provider by the connect of the SQLite provider the seed
 * names, which every path to that database reaches, and a model by the agent's one model factory. The control at the
 * end builds each of them with governance off, so a count of zero is the hold's and not a request that could reach
 * nothing.
 *
 * Identity is held open for the same reason: the session reader and the MCP token's owner check admit the caller, so
 * every answer here is the hold's and never an identity refusal.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as mcpRoute from "@/app/api/mcp/route";
import { AGENT_DRIVE_HEADER, mintAgentDriveToken } from "@/lib/agent/drive-token";
import * as modelAdapter from "@/lib/agent/model-adapter";
import * as auth from "@/lib/auth";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { logger } from "@/lib/logger";
import * as accountCheck from "@/lib/mcp/account-check";
import { configureAgentModel, restoreAgentModel } from "../helpers/agent-model-env";
import {
  countMethod,
  createSqliteFile,
  pinMcpTestEnvironment,
  resetMcpTestState,
  writeSeedFile,
} from "../helpers/mcp-fixtures";
import { legacyPost, readJsonRpc } from "../helpers/mcp-harness";
import { mintTestToken, useMcpChannel } from "../helpers/mcp-token";
import { discoverRoutes } from "./helpers/discover-routes";
import { mcpRequest } from "./helpers/mcp-requests";

pinMcpTestEnvironment();

const ROOT = resolve(import.meta.dir, "../..");
const AGENT_ROUTES = discoverRoutes(join(ROOT, "src/app/api/agent"));
const HANDLERS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** The value each dynamic segment of an agent route takes; a segment missing here fails the test that meets it. */
const SEGMENT_VALUES: Readonly<Record<string, string>> = {
  runId: "arun_0123456789abcdef",
  correlationId: "corr_governance_hold",
};

/** One body every agent handler can read: a run to open, an objective to classify and an action to take. */
const AGENT_BODY = { mode: "agent", objective: "why is checkout slow", connectionId: "seed:shop", action: "pause" };

const SESSION: auth.UserPayload = {
  role: "admin",
  username: "alice@example.com",
  idpSubject: "0f6c8d3e-5b1a-4c2e-9d7f-2a4b6c8e0f13",
  idpIssuer: "https://idp.example.com/realms/libredb",
};

/** Set here for one test each and put back afterwards. */
const ENV_NAMES = [
  "GOVERNANCE_SOURCE",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "LIBREDB_AGENT_ENABLED",
  "WORKFLOW_LOCAL_DATA_DIR",
  "SEED_CONFIG_PATH",
] as const;

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const dir = mkdtempSync(join(tmpdir(), "libredb-governance-holds-"));
const ledgerDir = join(dir, "ledger");
const saved = new Map<string, string | undefined>();
let restoreChannel: () => void = () => {};
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  for (const name of ENV_NAMES) saved.set(name, process.env[name]);
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
  process.env.LIBREDB_AGENT_ENABLED = "true";
  process.env.WORKFLOW_LOCAL_DATA_DIR = ledgerDir;
  restoreChannel = useMcpChannel();
  configureAgentModel();
  createSqliteFile(join(dir, "shop.db"), ["CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)"]);
  writeSeedFile(dir, [{ id: "shop", type: "sqlite", database: join(dir, "shop.db") }]);
  spies = [
    spyOn(auth, "getSession").mockResolvedValue(SESSION),
    spyOn(auth, "readSession").mockImplementation(async () => {
      const s = await auth.getSession();
      return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
    }),
    spyOn(accountCheck, "mcpTokenOwnerAllowed").mockResolvedValue(true),
    // The classifier and the classify route log a model they could not build; the count is what is read.
    spyOn(logger, "warn").mockImplementation(() => {}),
  ];
});

afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  restoreAgentModel();
  restoreChannel();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(ledgerDir, { recursive: true, force: true });
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A run_read_query call on the seeded SQLite database, the MCP request that builds a provider when it runs. */
function runReadQuery(token: string): Request {
  return legacyPost(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run_read_query", arguments: { connection_id: "seed:shop", sql: "SELECT id FROM users" } },
    },
    { token },
  );
}

/** Counts the database providers and the models built while `action` runs. Every model build is refused. */
async function countBuilds(action: () => Promise<void>): Promise<{ connects: number; models: number }> {
  const connects = countMethod(SQLiteProvider.prototype, "connect");
  const models = spyOn(modelAdapter, "createAgentModel").mockImplementation(async () => {
    throw new Error("this suite builds no model");
  });
  try {
    await action();
    return { connects: connects.calls, models: models.mock.calls.length };
  } finally {
    connects.restore();
    models.mockRestore();
  }
}

/** Calls one agent handler as Next.js would, with every dynamic segment filled in and the drive credential sent. */
async function callAgentHandler(key: string, method: string, handler: Handler, driveToken: string): Promise<Response> {
  const segments = [...key.matchAll(/\[(\w+)\]/g)].map(([, name]) => name);
  const missing = segments.filter((name) => !(name in SEGMENT_VALUES));
  if (missing.length > 0) throw new Error(`agent route "${key}" has segments this test has no value for: ${missing}`);
  const path = key.replace(/\[(\w+)\]/g, (_segment, name: string) => SEGMENT_VALUES[name]);
  const withBody = method === "POST" || method === "PUT" || method === "PATCH";
  const request = new Request(`http://localhost:3000/api/agent/${path}`, {
    method,
    headers: { "content-type": "application/json", [AGENT_DRIVE_HEADER]: driveToken },
    ...(withBody ? { body: JSON.stringify(AGENT_BODY) } : {}),
  });
  const params = Object.fromEntries(segments.map((name) => [name, SEGMENT_VALUES[name]]));
  return handler(request, { params: Promise.resolve(params) });
}

describe("governance holds MCP and the agent off", () => {
  test("the walk finds the agent routes, the probe among them", () => {
    const keys = AGENT_ROUTES.map(([key]) => key);
    expect(keys.length).toBeGreaterThanOrEqual(8);
    expect(keys).toContain("config");
    expect(keys).toContain("runs");
  });

  test("under governance with LIBREDB_MCP_ENABLED=true and an LLM configured, /api/mcp and every agent route answer 404, agent/config reports the agent off, and no provider is constructed", async () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    const token = await mintTestToken();
    const driveToken = await mintAgentDriveToken(SEGMENT_VALUES.runId);
    const answered: string[] = [];

    const builds = await countBuilds(async () => {
      for (const request of [runReadQuery(token), ...["GET", "DELETE"].map((method) => withBearer(method, token))]) {
        const response = await mcpServe(request);
        // Read whole before any assertion, so a call that was served has ended before the next test starts.
        const body = await response.text();
        expect(response.status, `${request.method} /api/mcp`).toBe(404);
        expect(JSON.parse(body)).toEqual({ error: "MCP is not enabled on this server" });
        answered.push(`${request.method} /api/mcp`);
      }

      for (const [key, load] of AGENT_ROUTES) {
        const routeModule = await load();
        for (const method of HANDLERS) {
          const handler = routeModule[method] as Handler | undefined;
          if (handler === undefined) continue;
          const label = `${method} /api/agent/${key}`;
          const response = await callAgentHandler(key, method, handler, driveToken);
          answered.push(label);
          if (key === "config") {
            // The probe answers for the surface instead of being one: the agent is off, and the hold is the reason.
            expect(response.status, label).toBe(200);
            const body = (await response.json()) as { enabled: unknown; reason: unknown; detail: string };
            expect(body).toMatchObject({ enabled: false, reason: "GOVERNANCE_HOLD" });
            expect(body.detail).toContain("GOVERNANCE_SOURCE");
          } else {
            expect(response.status, label).toBe(404);
          }
        }
      }
    });

    expect(answered).toContain("POST /api/agent/runs");
    expect(answered).toContain("POST /api/agent/drive");
    expect(answered).toContain("GET /api/agent/config");
    expect(builds).toEqual({ connects: 0, models: 0 });
    // No run service was reached either: the durable ledger was never opened.
    expect(existsSync(ledgerDir)).toBe(false);
  });

  test("the control: with governance off, the same MCP call connects, classify builds a model and the probe opens the ledger", async () => {
    const token = await mintTestToken();
    const classify = AGENT_ROUTES.find(([key]) => key === "classify");
    const config = AGENT_ROUTES.find(([key]) => key === "config");
    if (classify === undefined || config === undefined) throw new Error("the classify and config agent routes moved");
    const driveToken = await mintAgentDriveToken(SEGMENT_VALUES.runId);

    const builds = await countBuilds(async () => {
      expect((await readJsonRpc(await mcpServe(runReadQuery(token)))).error).toBeUndefined();
      const classified = await callAgentHandler(
        "classify",
        "POST",
        (await classify[1]()).POST as unknown as Handler,
        driveToken,
      );
      expect(await classified.json()).toEqual({ workflowType: "investigation", outcome: "unclassified" });
      const probe = await callAgentHandler("config", "GET", (await config[1]()).GET as unknown as Handler, driveToken);
      expect(await probe.json()).toMatchObject({ enabled: true, ledgerVerified: true });
    });

    expect(builds).toEqual({ connects: 1, models: 1 });
    expect(existsSync(ledgerDir)).toBe(true);
  });
});

/** A GET or DELETE to /api/mcp with the token as its bearer. */
function withBearer(method: string, token: string): Request {
  return mcpRequest(method, { authorization: `Bearer ${token}` });
}

/** The /api/mcp route's handler for the request's method. */
function mcpServe(request: Request): Promise<Response> {
  if (request.method === "POST") return mcpRoute.POST(request);
  if (request.method === "DELETE") return mcpRoute.DELETE(request);
  return mcpRoute.GET(request);
}
