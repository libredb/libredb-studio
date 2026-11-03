/**
 * An engine MCP reads only under a seed's own agent credential, refused without one at load and at open.
 *
 * The shipped `MCP_AGENT_CREDENTIAL_REQUIRED` registry names S3 alone, whose reads run-s3-read.test.ts drives, so this
 * file replaces it, in its own process, with a copy whose Postgres row the test sets. The seed schema and the MCP context both read the replaced
 * registry, so a refusal either one stopped making is a failure here, with the shipped rows unchanged.
 *
 * The load is the seed file's: the schema refuses it by name. The open is MCP's: a connection that was loaded while the
 * row was false is still in the seed cache when the row turns true, which is a connection loaded past the schema, and
 * both tools are driven against it through /api/mcp with a token minted at run time. The Postgres open is stubbed, so
 * a refusal that came too late shows up as an open.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseType } from "@/lib/types";
import * as realCompatibility from "@/lib/db/compatibility";

const STAND_IN_PASSWORD = ["not", "a", "real", "password"].join("-");

const required: Record<DatabaseType, boolean> = { ...realCompatibility.MCP_AGENT_CREDENTIAL_REQUIRED };

mock.module("@/lib/db/compatibility", () => ({ ...realCompatibility, MCP_AGENT_CREDENTIAL_REQUIRED: required }));

const route = await import("@/app/api/mcp/route");
const { PostgresProvider } = await import("@/lib/db/providers/sql/postgres");
const { SeedConfigSchema } = await import("@/lib/seed/types");
const { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } = await import("../../helpers/mcp-fixtures");
const { connectClient, routeServe } = await import("../../helpers/mcp-harness");
const { mintTestToken, useMcpChannel } = await import("../../helpers/mcp-token");

pinMcpTestEnvironment();

const serve = routeServe(route);
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-agent-credential-required-"));

interface ToolAnswer {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
}

let session: Awaited<ReturnType<typeof connectClient>> | null = null;
let restoreChannel: () => void = () => {};
let opened: unknown[] = [];
const spies: { mockRestore(): void }[] = [];

async function call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  session ??= await connectClient(serve, { token: await mintTestToken() });
  return (await session.client.callTool({ name, arguments: args })) as unknown as ToolAnswer;
}

/** A Postgres seed opted into MCP that carries no agent credential, as the file a test writes. */
function seedWithoutAgentCredential(): string {
  return writeSeedFile(dir, [
    { id: "warehouse", type: "postgres", host: "127.0.0.1", user: "owner", password: STAND_IN_PASSWORD },
  ]);
}

beforeEach(() => {
  restoreChannel = useMcpChannel();
  opened = [];
  spies.push(
    spyOn(PostgresProvider.prototype, "connect").mockImplementation(async function (
      this: InstanceType<typeof PostgresProvider>,
    ) {
      opened.push(this.config.user);
      throw new Error("the test stopped the open here");
    }),
  );
});

afterEach(async () => {
  await session?.close();
  session = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  required.postgres = false;
  process.env.SEED_CACHE_TTL_MS = "0";
  restoreChannel();
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("an engine the registry reads only under an agent credential", () => {
  test("refuses the seed file at load, by name, at mcp", () => {
    required.postgres = true;
    const path = seedWithoutAgentCredential();

    const parsed = SeedConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));

    expect(parsed.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      [
        "connections.0.mcp",
        'Seed connection "warehouse" sets mcp: true on postgres without an agent credential: MCP reads this engine only under an agent credential of its own, whose grants are what bound what it reads. Set agentUser and agentPassword to a read credential, or remove mcp from this connection.',
      ],
    ]);
  });

  test("admits the same file while the row is false, so the refusal is the row's", () => {
    const path = seedWithoutAgentCredential();

    expect(SeedConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8"))).success).toBe(true);
  });

  test("refuses the open of a connection loaded past the schema, in both tools, in Studio's words", async () => {
    const refusal =
      'Connection "seed:warehouse" is read by MCP only under an agent credential of its own, and it has none: an operator sets agentUser and agentPassword on this seed.';
    process.env.SEED_CACHE_TTL_MS = "600000";
    seedWithoutAgentCredential();
    const listed = await call("list_connections", {});
    expect(JSON.stringify(listed)).toContain("seed:warehouse");

    required.postgres = true;
    const inspected = await call("inspect_schema", { connection_id: "seed:warehouse" });
    const read = await call("run_read_query", { connection_id: "seed:warehouse", sql: "SELECT 1" });

    expect(inspected).toMatchObject({ isError: true, content: [{ type: "text", text: refusal }] });
    expect(read.isError).toBe(true);
    expect(read.content).toHaveLength(1);
    expect(read.content[0]?.text).toStartWith(`run_read_query cannot run on this connection: ${refusal.slice(0, -1)}`);
    expect(JSON.stringify([inspected, read])).not.toContain("The database refused or failed the call");
    expect(opened).toEqual([]);
  });

  test("opens the same cached connection while the row is false, so the open's refusal is the row's", async () => {
    process.env.SEED_CACHE_TTL_MS = "600000";
    seedWithoutAgentCredential();

    const inspected = await call("inspect_schema", { connection_id: "seed:warehouse" });

    expect(inspected.isError).toBe(true);
    expect(opened).toEqual(["owner"]);
  });
});
