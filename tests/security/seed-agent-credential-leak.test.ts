/**
 * A seed's agent secret reaches the provider it signs in with, and nothing else: no response body, no log line, no
 * audit event and no MCP answer, on the paths that read a seed and on every way one is refused.
 *
 * The agent password is a marker the test looks for everywhere it could land. Each path is driven as a caller drives
 * it: the managed connection list a browser reads, `list_connections`, `inspect_schema` and `run_read_query` through
 * /api/mcp with a token minted at run time, the load's refusals of a seed file, the MCP open's refusal of an engine
 * read only under an agent credential, and the factory's refusal of an agent credential its engine does not take. The
 * Postgres open is stopped after it read its login, and the provider's own copy of the marker is the proof that it was
 * in play.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realAuth from "@/lib/auth";

mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "alice" })),
  readSession: mock(async () => ({ kind: "authenticated", session: { role: "admin", username: "alice" } })),
}));

const { GET: listManaged } = await import("@/app/api/connections/managed/route");
const route = await import("@/app/api/mcp/route");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { MCP_AGENT_CREDENTIAL_REQUIRED } = await import("@/lib/db/compatibility");
const { acquireExecutionProfileProvider } = await import("@/lib/db/factory");
const { PostgresProvider } = await import("@/lib/db/providers/sql/postgres");
const { logger } = await import("@/lib/logger");
const { assertAgentCredentialWhereRequired } = await import("@/lib/mcp/context");
const { getManagedConnections, resetCache } = await import("@/lib/seed");
const { projectSeedConnection } = await import("@/lib/seed/connection-filter");
const { resetPlaintextWarnings } = await import("@/lib/seed/credential-resolver");
const { SeedConfigSchema } = await import("@/lib/seed/types");
const { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } = await import("../helpers/mcp-fixtures");
const { connectClient, routeServe } = await import("../helpers/mcp-harness");
const { mintTestToken, useMcpChannel } = await import("../helpers/mcp-token");

pinMcpTestEnvironment();

const serve = routeServe(route);
const dir = mkdtempSync(join(tmpdir(), "libredb-seed-agent-leak-"));
const MARKER = "not-a-real-agent-password-marker-5c1e";

let written: string[] = [];
let opened: unknown[][] = [];
let sent: string[] = [];
const spies: { mockRestore(): void }[] = [];
let restoreChannel: () => void = () => {};

/** Every argument a log method or the stdout audit line was given, as text. */
function captureOutput(): void {
  for (const method of ["debug", "info", "warn", "error"] as const) {
    spies.push(
      spyOn(logger, method).mockImplementation((...args: unknown[]) => {
        written.push(
          args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : JSON.stringify(arg))).join(" "),
        );
      }),
    );
  }
  spies.push(
    spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      written.push(args.map(String).join(" "));
    }),
  );
}

/** Everything a caller could read, with every audit event, as one text the marker is looked for in. */
function everythingSent(): string {
  const audit = getServerAuditBuffer()
    .getAll()
    .map((event) => JSON.stringify(event));
  return [...sent, ...audit].join("\n");
}

/** A refusal's text, or the absence of one, recorded as sent. */
async function refusalOf(run: () => unknown): Promise<void> {
  try {
    await run();
    sent.push("no refusal");
  } catch (error) {
    sent.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

const AGENT_SEED = {
  id: "warehouse",
  type: "postgres",
  host: "127.0.0.1",
  port: 5432,
  user: "owner",
  password: "${LEAK_TEST_OWNER_PASSWORD}",
  agentUser: "agent_reader",
  agentPassword: MARKER,
};

beforeEach(() => {
  clearRateLimitState();
  resetPlaintextWarnings();
  restoreChannel = useMcpChannel();
  process.env.LEAK_TEST_OWNER_PASSWORD = "not-a-real-owner-password";
  written = [];
  opened = [];
  sent = [];
  captureOutput();
  spies.push(
    spyOn(PostgresProvider.prototype, "connect").mockImplementation(async function (
      this: InstanceType<typeof PostgresProvider>,
    ) {
      opened.push([this.config.user, this.config.password]);
      throw new Error("the test stopped the open here");
    }),
  );
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  restoreChannel();
  delete process.env.LEAK_TEST_OWNER_PASSWORD;
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a seed's agent secret", () => {
  test("reaches the provider, and no managed list, MCP answer, log line or audit event", async () => {
    writeSeedFile(dir, [AGENT_SEED]);

    const listed = await getManagedConnections(["admin"]);
    sent.push(JSON.stringify(listed.map((connection) => ({ ...connection, agentPassword: undefined }))));
    // The control for the list: the server-side listing does carry the secret, which the route strips.
    expect(listed[0]?.agentPassword).toBe(MARKER);
    const response = await listManaged();
    sent.push(await response.text());
    expect(response.status).toBe(200);

    const session = await connectClient(serve, { token: await mintTestToken() });
    try {
      for (const [name, args] of [
        ["list_connections", {}],
        ["inspect_schema", { connection_id: "seed:warehouse" }],
        ["run_read_query", { connection_id: "seed:warehouse", sql: "SELECT 1" }],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one tool call at a time on one session.
        sent.push(JSON.stringify(await session.client.callTool({ name, arguments: args })));
      }
    } finally {
      await session.close();
    }

    // The control for MCP: both opens signed in as the agent, so a leak would have had the secret to leak.
    expect(opened).toEqual([
      ["agent_reader", MARKER],
      ["agent_reader", MARKER],
    ]);
    expect(everythingSent()).not.toContain(MARKER);
    expect(written.join("\n")).not.toContain(MARKER);
  });

  test("is in no load refusal, of the file or through the routes that read it", async () => {
    const refused = [
      { ...AGENT_SEED, type: "oxia", user: undefined },
      { ...AGENT_SEED, agentUser: undefined },
      { ...AGENT_SEED, type: "qdrant", user: undefined },
      { ...AGENT_SEED, connectionString: "${LEAK_TEST_URL}" },
      { ...AGENT_SEED, agentUser: "guest", agentPassword: "guest", type: "rabbitmq", password: "${P}", user: MARKER },
      { ...AGENT_SEED, managed: false },
      { ...AGENT_SEED, type: "elasticsearch", apiKeyId: "${LEAK_TEST_KEY_ID}" },
      { ...AGENT_SEED, type: "libsql", agentUser: undefined, user: "owner" },
      { ...AGENT_SEED, type: "etcd", agentUser: "root", mcp: true },
    ];
    for (const entry of refused) {
      const config = { version: "1", connections: [{ name: entry.id, roles: ["admin"], ...entry }] };
      const result = SeedConfigSchema.safeParse(config);
      expect([entry.type, result.success]).toEqual([entry.type, false]);
      sent.push(JSON.stringify(result.error?.issues));
      const file = join(dir, "refused.json");
      writeFileSync(file, JSON.stringify(config));
      process.env.SEED_CONFIG_PATH = file;
      resetCache();
      // oxlint-disable-next-line no-await-in-loop -- each file is loaded on its own.
      await refusalOf(() => getManagedConnections(["admin"]));
      // oxlint-disable-next-line no-await-in-loop -- and read through the route a browser calls.
      const response = await listManaged();
      // oxlint-disable-next-line no-await-in-loop -- the body of that one response.
      sent.push(await response.text());
    }
    const defaults = SeedConfigSchema.safeParse({
      version: "1",
      defaults: { agentPassword: MARKER },
      connections: [{ name: "x", roles: ["admin"], ...AGENT_SEED }],
    });
    sent.push(JSON.stringify(defaults.error?.issues));

    expect(sent.some((text) => text.includes("Seed connection"))).toBe(true);
    expect(everythingSent()).not.toContain(MARKER);
    expect(written.join("\n")).not.toContain(MARKER);
  });

  test("is in no open refusal, of MCP or of the factory", async () => {
    const projected = projectSeedConnection({ name: "warehouse", roles: ["admin"], ...AGENT_SEED, type: "postgres" }, [
      "admin",
    ]);
    await refusalOf(() =>
      assertAgentCredentialWhereRequired(
        { ...projected, agentUser: undefined, agentPassword: undefined, password: MARKER },
        { ...MCP_AGENT_CREDENTIAL_REQUIRED, postgres: true },
      ),
    );
    await refusalOf(() => acquireExecutionProfileProvider({ ...projected, agentUser: undefined }, "agent-read-only"));
    await refusalOf(() =>
      acquireExecutionProfileProvider({ ...projected, connectionString: "postgres://127.0.0.1/x" }, "agent-read-only"),
    );

    expect(sent.filter((text) => text.startsWith("ExecutionProfileError"))).toHaveLength(3);
    expect(opened).toEqual([]);
    expect(everythingSent()).not.toContain(MARKER);
    expect(written.join("\n")).not.toContain(MARKER);
  });
});
