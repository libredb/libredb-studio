/**
 * A discovered connection opened through POST /api/db/query (CapRover auto-connect spec 9.5 and 17).
 *
 * Its values are the literal text another app on the platform network carries, so a `${vault:...}` in them reaches
 * the provider as that text and Studio sends nothing to its own Vault. The Vault here is a real loopback HTTP
 * listener that records every request, so "nothing was sent" is measured on the server side. A seed-file connection
 * with a reference, opened through the same route, is the control that shows the fake Vault is wired and answers.
 *
 * Only the session and the provider cache are replaced; the seed loader, the discovery loader, resolveConnection
 * and the Vault client are the real ones.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as actualDb from "@/lib/db";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { resetCache } from "@/lib/seed";
import { resetDiscoveryCache } from "@/lib/seed/discovery-loader";
import { resetVaultCache } from "@/lib/seed/vault-client";
import type { DatabaseConnection } from "@/lib/types";
import { postgresService, writeDiscoveryExport, type DiscoveryExportFixture } from "../../helpers/discovery-fixture";
import { createMockProvider } from "../../helpers/mock-provider";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { closeAll, httpListener, jsonAnswer, type Listener } from "../../helpers/node-transport-fixtures";

const VAULT_REFERENCE = "${vault:secret/data/a#b}";

const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock<(connection: DatabaseConnection) => Promise<typeof mockProvider>>(
  async () => mockProvider,
);
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// The spread form, not a hand-written stub: only getSession is replaced (BACKLOG D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
mock.module("@/lib/db", () => ({ ...actualDb, getOrCreateProvider: mockGetOrCreateProvider }));

const { POST } = await import("@/app/api/db/query/route");

let vault: Listener;
let discovery: DiscoveryExportFixture;
let scratch: string;

async function query(connectionId: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await POST(
    createMockRequest("/api/db/query", { method: "POST", body: { connectionId, sql: "SELECT 1" } }) as never,
  );
  return { status: res.status, data: await parseResponseJSON<Record<string, unknown>>(res) };
}

function passwordGivenToProvider(): string | undefined {
  return mockGetOrCreateProvider.mock.calls[0]?.[0]?.password;
}

beforeEach(async () => {
  clearRateLimitState();
  resetCache();
  resetDiscoveryCache();
  resetVaultCache();
  mockGetOrCreateProvider.mockClear();
  mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));

  vault = await httpListener(jsonAnswer(200, JSON.stringify({ data: { data: { b: "from-vault" } } })));
  process.env.VAULT_ADDR = `http://127.0.0.1:${vault.port}`;
  process.env.VAULT_TOKEN = "root";

  scratch = mkdtempSync(join(tmpdir(), "libredb-discovered-query-"));
  const seedFile = join(scratch, "seed-connections.json");
  writeFileSync(
    seedFile,
    JSON.stringify({
      version: "1",
      connections: [
        {
          id: "vault-pg",
          name: "Vault PG",
          type: "postgres",
          host: "vault-pg.internal",
          password: VAULT_REFERENCE,
          roles: ["admin"],
        },
      ],
    }),
  );
  process.env.SEED_CONFIG_PATH = seedFile;

  discovery = writeDiscoveryExport([postgresService("x", VAULT_REFERENCE)]);
  process.env.SEED_DISCOVERY_PATH = discovery.path;
});

afterEach(async () => {
  await closeAll();
  delete process.env.VAULT_ADDR;
  delete process.env.VAULT_TOKEN;
  delete process.env.SEED_CONFIG_PATH;
  delete process.env.SEED_DISCOVERY_PATH;
  resetCache();
  resetDiscoveryCache();
  resetVaultCache();
  discovery.remove();
  rmSync(scratch, { recursive: true, force: true });
});

describe("POST /api/db/query on a discovered connection", () => {
  test("passes a discovered ${vault:...} password to the provider as text and sends nothing to Vault", async () => {
    const { status } = await query("seed:caprover-x");

    expect(status).toBe(200);
    expect(passwordGivenToProvider()).toBe(VAULT_REFERENCE);
    expect(vault.seen).toEqual([]);
    expect(vault.accepted()).toBe(0);
  });

  test("control: a seed-file reference through the same route is read from the fake Vault", async () => {
    const { status } = await query("seed:vault-pg");

    expect(status).toBe(200);
    expect(passwordGivenToProvider()).toBe("from-vault");
    expect(vault.seen.map((request) => request.url)).toEqual(["/v1/secret/data/a"]);
  });

  test("answers a standard user who names a discovered id with the 404 of an unknown id", async () => {
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "user" }));

    const discovered = await query("seed:caprover-x");
    const unknown = await query("seed:caprover-none");

    expect(discovered.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(discovered.data).toEqual({ error: 'Seed connection "caprover-x" not found', statusCode: 404 });
    expect(unknown.data).toEqual({ error: 'Seed connection "caprover-none" not found', statusCode: 404 });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(vault.seen).toEqual([]);
  });
});
