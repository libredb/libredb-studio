/**
 * What one token's tools/list holds (#2252, part 3): the metadata tools, and only the statement tools that serve the
 * engine of a connection the token can read, with `inspect_schema`'s hints read from those engines. The list is
 * presentation only: a call to a tool it leaves out still reaches Studio's own checks and audit. A seed file that
 * cannot be read or parsed answers tools/list with -32603, never a list, and a discovery export, which opts nothing in,
 * changes no answer. Every case runs in both protocol eras, against the production dispatcher.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { getServerAuditBuffer } from "@/lib/audit";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import { logger } from "@/lib/logger";
import { MCP_CONNECTION_UNAVAILABLE_TEXT } from "@/lib/mcp/availability";
import { MCP_CONNECTIONS_UNREADABLE_TEXT, McpConnectionContext } from "@/lib/mcp/context";
import { listedStatementArms, servingStatementArms } from "@/lib/mcp/tools/statement-arms";
import { resetCache } from "@/lib/seed";
import { resetDiscoveryCache } from "@/lib/seed/discovery-loader";
import { resetKubernetesDiscoveryCache } from "@/lib/seed/kubernetes-discovery-loader";
import { resetVaultCache } from "@/lib/seed/vault-client";
import type { DatabaseType } from "@/lib/types";
import { postgresService, writeDiscoveryExport } from "../../helpers/discovery-fixture";
import { writeKubernetesDiscoveryExport } from "../../helpers/kubernetes-discovery-fixture";
import {
  countMethod,
  pinMcpTestEnvironment,
  resetMcpTestState,
  type SeedEntry,
  writeSeedFile,
} from "../../helpers/mcp-fixtures";
import {
  connectClient,
  handlerServe,
  legacyPost,
  modernPost,
  readJsonRpc,
  routeServe,
  type ServeRequest,
} from "../../helpers/mcp-harness";
import { servedEngineSeeds } from "../../helpers/mcp-served-seeds";
import { mintTestToken, useMcpChannel } from "../../helpers/mcp-token";
import { listedMcpToolNames, registeredMcpToolNames } from "../../helpers/mcp-tool-names";

pinMcpTestEnvironment();

const route = await import("@/app/api/mcp/route");
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-tool-listing-"));
const STAND_IN = ["not", "a", "real", "secret"].join("-");
const ERAS = ["legacy", "pinned"] as const;
type Era = (typeof ERAS)[number];

/** Every variable a listing or an open reads that a developer's environment could set. */
const PINNED_VARIABLES = [
  "GOVERNANCE_SOURCE",
  "LIBREDB_ENABLED_PROVIDERS",
  "SEED_DISCOVERY_PATH",
  "SEED_DISCOVERY_MAX_AGE_MS",
  "SEED_KUBERNETES_DISCOVERY_PATH",
  "SEED_KUBERNETES_DISCOVERY_MAX_AGE_MS",
  "OIDC_ROLE_PREFIX",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "VAULT_ADDR",
  "VAULT_TOKEN",
] as const;
let saved: Array<readonly [string, string | undefined]> = [];

beforeEach(() => {
  saved = PINNED_VARIABLES.map((name) => [name, process.env[name]] as const);
  for (const name of PINNED_VARIABLES) delete process.env[name];
});

afterEach(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await resetMcpTestState();
  resetDiscoveryCache();
  resetKubernetesDiscoveryCache();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Caller {
  readonly username: string;
  readonly role: "admin" | "user";
  readonly claimRoles?: readonly string[];
}

const alice: Caller = { username: "alice", role: "admin" };
const bob: Caller = { username: "bob", role: "user" };

function auth(caller: Caller): AuthInfo {
  return {
    token: "handler-level-test-identity",
    clientId: `test:${caller.username}`,
    scopes: ["mcp:read"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: {
      username: caller.username,
      role: caller.role,
      ...(caller.claimRoles === undefined ? {} : { claimRoles: [...caller.claimRoles] }),
    },
  };
}

interface ListedTool {
  readonly name: string;
  readonly annotations?: Record<string, unknown>;
}

async function listed(caller: Caller, era: Era): Promise<ListedTool[]> {
  const session = await connectClient(handlerServe(auth(caller)), { negotiation: era });
  try {
    return (await session.client.listTools()).tools as ListedTool[];
  } finally {
    await session.close();
  }
}

const names = async (caller: Caller, era: Era) => (await listed(caller, era)).map((tool) => tool.name);

interface Row {
  readonly id: string;
  readonly read_tool: string | null;
  readonly unavailable?: string;
}

async function listConnections(caller: Caller, era: Era): Promise<Record<string, unknown> | undefined> {
  const session = await connectClient(handlerServe(auth(caller)), { negotiation: era });
  try {
    const result = (await session.client.callTool({ name: "list_connections", arguments: {} })) as {
      structuredContent?: Record<string, unknown>;
    };
    return result.structuredContent;
  } finally {
    await session.close();
  }
}

const rows = async (caller: Caller, era: Era): Promise<Row[]> =>
  ((await listConnections(caller, era))?.connections as Row[] | undefined) ?? [];

const reach = (...types: DatabaseType[]) => new Set<DatabaseType>(types);
const sqliteShop = (roles?: readonly string[]): SeedEntry => ({
  id: "shop",
  type: "sqlite",
  database: join(dir, "shop.db"),
  ...(roles === undefined ? {} : { roles }),
});
const mongo = (roles?: readonly string[]): SeedEntry => ({
  id: "mongo",
  type: "mongodb",
  host: "127.0.0.1",
  port: 27017,
  database: "app",
  ...(roles === undefined ? {} : { roles }),
});

describe.each(ERAS)("a token's tools/list (%s)", (era) => {
  test(`a user token lists the statement tool of a DuckDB seed offered to every role (${era})`, async () => {
    writeSeedFile(dir, [{ id: "warehouse", type: "duckdb", database: join(dir, "w.duckdb"), roles: ["*"] }]);
    expect(await names(bob, era)).toEqual(listedMcpToolNames(reach("duckdb")));
  });

  test(`an admin token lists the tools of an admin-only SQLite seed and a MongoDB seed, in record order (${era})`, async () => {
    writeSeedFile(dir, [sqliteShop(), mongo()]);
    const listedNames = await names(alice, era);
    expect(listedNames).toEqual(listedMcpToolNames(reach("sqlite", "mongodb")));
    const statementTools: string[] = listedStatementArms(reach("sqlite", "mongodb")).map((arm) => arm.tool);
    expect(listedNames.slice(2)).toEqual(statementTools);
    // The statement tools listed are the read tools list_connections names for the same token, in the list's order.
    const readTools = new Set((await rows(alice, era)).map((row) => row.read_tool).filter((tool) => tool !== null));
    expect(statementTools).toEqual(listedNames.filter((name) => readTools.has(name)));
    expect(readTools.size).toBe(statementTools.length);
  });

  test(`a token that reaches no connection lists the metadata tools alone (${era})`, async () => {
    writeSeedFile(dir, [sqliteShop(["admin"]), mongo(["admin"])]);
    expect(await names(bob, era)).toEqual(listedMcpToolNames(reach()));
    // An absent seed file lists no connection.
    process.env.SEED_CONFIG_PATH = join(dir, "never-written.json");
    resetCache();
    expect(await names(alice, era)).toEqual(listedMcpToolNames(reach()));
  });

  test(`a token whose only seed is unavailable lists the metadata tools alone (${era})`, async () => {
    for (const [caller, roles] of [
      [bob, ["user"]],
      [alice, ["*"]],
    ] as const) {
      writeSeedFile(dir, [sqliteShop(roles)]);
      // oxlint-disable-next-line no-await-in-loop -- one caller after the other, each on its own seed file
      expect(await names(caller, era)).toEqual(listedMcpToolNames(reach()));
      // oxlint-disable-next-line no-await-in-loop -- the same caller's row, on the same seed file
      expect(await rows(caller, era)).toEqual([
        expect.objectContaining({ id: "seed:shop", read_tool: null, unavailable: MCP_CONNECTION_UNAVAILABLE_TEXT }),
      ]);
    }
  });

  test(`an OIDC claim role reaches a seed offered to that role (${era})`, async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    process.env.OIDC_ROLE_PREFIX = "team-";
    writeSeedFile(dir, [mongo(["team-analytics"])]);
    const charlie: Caller = { username: "charlie", role: "user", claimRoles: ["team-analytics"] };
    expect(await names(charlie, era)).toEqual(listedMcpToolNames(reach("mongodb")));
    expect(await names({ username: "charlie", role: "user" }, era)).toEqual(listedMcpToolNames(reach()));
  });

  test(`a \${vault:...} seed is listed with no Vault read and no provider built (${era})`, async () => {
    const realFetch = globalThis.fetch;
    const vaultCalls: string[] = [];
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "not-a-real-token";
    resetVaultCache();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      vaultCalls.push(String(input));
      return new Response(JSON.stringify({ data: { data: { password: STAND_IN } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const acquire = spyOn(McpConnectionContext.prototype, "acquire");
    const builds = countMethod(PostgresProvider.prototype, "validate");
    const connect = spyOn(PostgresProvider.prototype, "connect").mockImplementation(async () => {
      throw new Error("stopped before any socket");
    });
    try {
      writeSeedFile(dir, [
        {
          id: "warehouse",
          type: "postgres",
          host: "127.0.0.1",
          port: 5432,
          user: "reader",
          password: "${vault:secret/data/mcp/warehouse#password}",
        },
      ]);
      expect(await names(alice, era)).toEqual(listedMcpToolNames(reach("postgres")));
      expect(vaultCalls).toEqual([]);
      expect(acquire).toHaveBeenCalledTimes(0);
      expect(builds.calls).toBe(0);
      // The control: a call that opens the connection reads the reference.
      const session = await connectClient(handlerServe(auth(alice)), { negotiation: era });
      try {
        await session.client.callTool({ name: "inspect_schema", arguments: { connection_id: "seed:warehouse" } });
      } finally {
        await session.close();
      }
      expect(vaultCalls).toHaveLength(1);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(builds.calls).toBe(1);
    } finally {
      connect.mockRestore();
      builds.restore();
      acquire.mockRestore();
      globalThis.fetch = realFetch;
      resetVaultCache();
    }
  });

  test(`an unreadable and an invalid seed file answer tools/list with -32603 and the sentence, while initialize and server/discover answer (${era})`, async () => {
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const directory = join(dir, "seed-as-directory");
      mkdirSync(directory, { recursive: true });
      const notJson = join(dir, "not-json.json");
      writeFileSync(notJson, "{ this is not json");
      const invalid = join(dir, "invalid.json");
      writeFileSync(
        invalid,
        JSON.stringify({ version: "1", connections: [{ ...sqliteShop(), name: "Shop", roles: ["*"], mcp: "yes" }] }),
      );
      for (const path of [directory, notJson, invalid]) {
        process.env.SEED_CONFIG_PATH = path;
        resetCache();
        // oxlint-disable-next-line no-await-in-loop -- one seed file after the other
        const session = await connectClient(handlerServe(auth(alice)), { negotiation: era });
        try {
          expect(session.client.getProtocolEra()).toBe(era === "legacy" ? "legacy" : "modern");
          // oxlint-disable-next-line no-await-in-loop -- the same session's list
          await expect(session.client.listTools()).rejects.toMatchObject({
            code: -32603,
            message: MCP_CONNECTIONS_UNREADABLE_TEXT,
          });
        } finally {
          // oxlint-disable-next-line no-await-in-loop -- closes the session before the next seed file
          await session.close();
        }
      }
      // Through the route: HTTP 200 with the JSON-RPC error.
      const restoreChannel = useMcpChannel();
      try {
        const token = await mintTestToken();
        const request =
          era === "legacy"
            ? legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token })
            : modernPost("tools/list", {}, { token });
        const response = await routeServe(route)(request);
        expect(response.status).toBe(200);
        expect((await readJsonRpc(response)).error).toMatchObject({
          code: -32603,
          message: MCP_CONNECTIONS_UNREADABLE_TEXT,
        });
      } finally {
        restoreChannel();
      }
    } finally {
      errorLog.mockRestore();
    }
  });

  test(`a failing discovery export changes neither tools/list nor list_connections (${era})`, async () => {
    writeSeedFile(dir, [sqliteShop(), mongo()]);
    const expectedNames = await names(alice, era);
    const expectedRows = await listConnections(alice, era);
    expect(expectedNames).toEqual(listedMcpToolNames(reach("sqlite", "mongodb")));
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();

    const exports: Array<{ readonly label: string; make(variable: string): { path: string; remove(): void } }> = [
      {
        label: "unreadable",
        make: () => {
          const path = mkdtempSync(join(tmpdir(), "libredb-discovery-directory-"));
          return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
        },
      },
      {
        label: "invalid",
        make: () => {
          const parent = mkdtempSync(join(tmpdir(), "libredb-discovery-invalid-"));
          const path = join(parent, "export.json");
          writeFileSync(path, "{ not json");
          return { path, remove: () => rmSync(parent, { recursive: true, force: true }) };
        },
      },
      {
        label: "stale",
        make: (variable) => {
          if (variable === "SEED_KUBERNETES_DISCOVERY_PATH")
            return writeKubernetesDiscoveryExport({ generatedAt: hourAgo });
          const fixture = writeDiscoveryExport([postgresService("orders", STAND_IN)]);
          const body = JSON.parse(readFileSync(fixture.path, "utf8")) as Record<string, unknown>;
          writeFileSync(fixture.path, JSON.stringify({ ...body, generatedAt: hourAgo }));
          return fixture;
        },
      },
      {
        label: "fresh",
        make: (variable) =>
          variable === "SEED_KUBERNETES_DISCOVERY_PATH"
            ? writeKubernetesDiscoveryExport()
            : writeDiscoveryExport([postgresService("orders", STAND_IN)]),
      },
    ];
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    const warnLog = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (const variable of ["SEED_DISCOVERY_PATH", "SEED_KUBERNETES_DISCOVERY_PATH"]) {
        for (const { label, make } of exports) {
          const fixture = make(variable);
          process.env[variable] = fixture.path;
          resetDiscoveryCache();
          resetKubernetesDiscoveryCache();
          resetCache();
          try {
            // oxlint-disable-next-line no-await-in-loop -- one export after the other
            expect(await names(alice, era), `${variable} ${label}`).toEqual(expectedNames);
            // oxlint-disable-next-line no-await-in-loop -- the same export's connection list
            expect(await listConnections(alice, era), `${variable} ${label}`).toEqual(expectedRows);
          } finally {
            delete process.env[variable];
            fixture.remove();
          }
        }
      }
    } finally {
      warnLog.mockRestore();
      errorLog.mockRestore();
    }
  });

  test(`a call to a statement tool the list leaves out gets Studio's refusal and its decision event (${era})`, async () => {
    writeSeedFile(dir, [sqliteShop()]);
    const arm = servingStatementArms().find(
      (serving) => !serving.types.includes("sqlite") && serving.argument === "statement",
    );
    if (arm === undefined) throw new Error("no serving statement tool that takes statement leaves SQLite out");
    const session = await connectClient(handlerServe(auth(alice)), { negotiation: era });
    try {
      const listedNames = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(listedNames).not.toContain(arm.tool);
      getServerAuditBuffer().clear();
      const result = (await session.client.callTool({
        name: arm.tool,
        arguments: { connection_id: "seed:shop", statement: "x" },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(result.isError).toBe(true);
      const text = result.content.map((part) => part.text).join("\n");
      expect(text).toContain("this tool does not serve SQLite; use run_read_query there");
      expect(text).not.toContain("not found");
    } finally {
      await session.close();
    }
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "mcp_operation");
    expect(events.map((event) => [event.action, event.target, event.result, event.reason])).toEqual([
      [arm.tool, "mcp/decision", "failure", "mcp_execution_failed"],
    ]);
  });

  test(`an admin seeded on every served engine lists exactly every registered tool (${era})`, async () => {
    writeSeedFile(dir, servedEngineSeeds(dir));
    expect(await names(alice, era)).toEqual(registeredMcpToolNames());
  });

  test(`inspect_schema tells Databend-only and LibreDB-only tokens it is not read-only, and every other tool and token keep the read-only hints (${era})`, async () => {
    const seeds: ReadonlyArray<readonly [SeedEntry, boolean]> = [
      [{ id: "warehouse", type: "databend", host: "127.0.0.1", port: 8000 }, true],
      [{ id: "kv", type: "libredb", database: join(dir, "kv.libredb") }, true],
      [{ id: "orders", type: "postgres", host: "127.0.0.1", port: 5432, database: "shop" }, false],
    ];
    for (const [seed, changesState] of seeds) {
      writeSeedFile(dir, [seed]);
      // oxlint-disable-next-line no-await-in-loop -- one seed file after the other
      const tools = await listed(alice, era);
      expect(tools.map((tool) => tool.name)).toEqual(listedMcpToolNames(reach(seed.type as DatabaseType)));
      for (const tool of tools) {
        const stateChanging = changesState && tool.name === "inspect_schema";
        expect(tool.annotations, `${seed.type} ${tool.name}`).toEqual(
          stateChanging
            ? { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
            : { readOnlyHint: true, openWorldHint: false },
        );
        expect(tool.annotations).not.toHaveProperty("idempotentHint");
      }
    }
  });

  test(`a seed edit shows at the next tools/list (${era})`, async () => {
    writeSeedFile(dir, [sqliteShop()]);
    expect(await names(alice, era)).toEqual(listedMcpToolNames(reach("sqlite")));
    writeSeedFile(dir, [sqliteShop(), mongo()]);
    expect(await names(alice, era)).toEqual(listedMcpToolNames(reach("sqlite", "mongodb")));
  });
});

test("the 2026-07-28 answer to tools/list carries ttlMs 0 and cacheScope private", async () => {
  const restoreChannel = useMcpChannel();
  try {
    writeSeedFile(dir, [sqliteShop()]);
    const token = await mintTestToken();
    const serve: ServeRequest = routeServe(route);
    const answer = await readJsonRpc(await serve(modernPost("tools/list", {}, { token })));
    expect(answer.result?.ttlMs).toBe(0);
    expect(answer.result?.cacheScope).toBe("private");
    expect(answer.result?.tools.map((tool: { name: string }) => tool.name)).toEqual(
      listedMcpToolNames(reach("sqlite")),
    );
  } finally {
    restoreChannel();
  }
});
