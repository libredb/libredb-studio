/**
 * A seed's `${vault:...}` secret on MCP: read when a tool opens the connection, as the editor and agent routes read it,
 * and never written into an MCP answer, a log line or an audit event.
 *
 * Driven through /api/mcp with a token minted at run time. The Vault answer is a stub and the Postgres open is stopped
 * after it read its password, so the secret is a marker the test can look for everywhere it could land, and the
 * provider's own copy of it is the proof that it was in play.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as route from "@/app/api/mcp/route";
import { getServerAuditBuffer } from "@/lib/audit";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import { logger } from "@/lib/logger";
import { resetVaultCache } from "@/lib/seed/vault-client";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, routeServe, type TestClient } from "../../helpers/mcp-harness";
import { mintTestToken, useMcpChannel } from "../../helpers/mcp-token";

pinMcpTestEnvironment();

const serve = routeServe(route);
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-vault-secret-"));
const MARKER = "not-a-real-password-marker-7f3a";
const VAULT_DETAIL = "not-a-real-vault-detail";
const realFetch = globalThis.fetch;

interface ToolAnswer {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
}

let restoreChannel: () => void = () => {};
let session: TestClient | null = null;
let written: string[] = [];
let opened: unknown[] = [];
const spies: { mockRestore(): void }[] = [];

function vaultAnswers(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

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

function seedWarehouse(password: string): void {
  writeSeedFile(dir, [{ id: "warehouse", type: "postgres", host: "127.0.0.1", user: "reader", password }]);
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  session ??= await connectClient(serve, { token: await mintTestToken() });
  return (await session.client.callTool({ name, arguments: args })) as unknown as ToolAnswer;
}

function everythingSent(answers: readonly ToolAnswer[]): string {
  const audit = getServerAuditBuffer()
    .getAll()
    .map((event) => JSON.stringify(event));
  return [...answers.map((answer) => JSON.stringify(answer)), ...audit].join("\n");
}

beforeEach(async () => {
  clearRateLimitState();
  resetVaultCache();
  restoreChannel = useMcpChannel();
  process.env.VAULT_ADDR = "http://127.0.0.1:8200";
  process.env.VAULT_TOKEN = "not-a-real-token";
  written = [];
  opened = [];
  captureOutput();
  spies.push(
    spyOn(PostgresProvider.prototype, "connect").mockImplementation(async function (this: PostgresProvider) {
      opened.push(this.config.password);
      throw new Error("the test stopped the open here");
    }),
  );
});

afterEach(async () => {
  await session?.close();
  session = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  globalThis.fetch = realFetch;
  delete process.env.VAULT_ADDR;
  delete process.env.VAULT_TOKEN;
  restoreChannel();
  resetVaultCache();
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a secret a seed reads from Vault", () => {
  test("reaches the provider, and no answer, log line or audit event", async () => {
    vaultAnswers(200, { data: { data: { password: MARKER } } });
    seedWarehouse("${vault:secret/data/mcp/warehouse#password}");

    const answers = [
      await call("list_connections", {}),
      await call("inspect_schema", { connection_id: "seed:warehouse" }),
      await call("run_read_query", { connection_id: "seed:warehouse", sql: "SELECT 1" }),
    ];

    // The control: both opens were handed the secret, so a leak would have had it to leak.
    expect(opened).toEqual([MARKER, MARKER]);
    expect(everythingSent(answers)).not.toContain(MARKER);
    expect(written.join("\n")).not.toContain(MARKER);
  });
});

describe("a Vault reference that cannot be read", () => {
  const REFUSAL =
    'Connection "seed:warehouse" could not be opened: a secret reference in its seed entry could not be read from Vault, so nothing was sent to the database. The server log names the cause.';

  test("is answered by both tools in Studio's words, with no engine prefix and no Vault detail", async () => {
    vaultAnswers(503, { errors: [VAULT_DETAIL] });
    seedWarehouse("${vault:secret/data/mcp/warehouse#password}");

    const inspected = await call("inspect_schema", { connection_id: "seed:warehouse" });
    const read = await call("run_read_query", { connection_id: "seed:warehouse", sql: "SELECT 1" });

    expect(inspected).toMatchObject({ isError: true, content: [{ type: "text", text: REFUSAL }] });
    expect(read.isError).toBe(true);
    expect(read.content).toHaveLength(1);
    expect(read.content[0]?.text).toStartWith(`run_read_query cannot run on this connection: ${REFUSAL.slice(0, -1)}`);
    expect(opened).toEqual([]);
    expect(everythingSent([inspected, read])).not.toContain(VAULT_DETAIL);
    expect(everythingSent([inspected, read])).not.toContain("secret/data/mcp/warehouse");
    expect(everythingSent([inspected, read])).not.toContain("The database refused or failed the call");
  });

  test("of a password that only looks like one keeps that text out of every answer and audit event", async () => {
    vaultAnswers(200, {});
    seedWarehouse(`\${vault:${MARKER}`);

    const answers = [
      await call("inspect_schema", { connection_id: "seed:warehouse" }),
      await call("run_read_query", { connection_id: "seed:warehouse", sql: "SELECT 1" }),
    ];

    expect(answers.map((answer) => answer.isError)).toEqual([true, true]);
    expect(answers[0]?.content[0]?.text).toBe(REFUSAL);
    expect(opened).toEqual([]);
    // The server log may quote a malformed reference, as it does for every seed route; a caller never reads it.
    expect(everythingSent(answers)).not.toContain(MARKER);
  });
});
