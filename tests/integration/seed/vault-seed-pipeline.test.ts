import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import { getManagedConnections, getSeedConnectionByIdUnfiltered, resetCache } from "@/lib/seed";
import { resetPlaintextWarnings } from "@/lib/seed/credential-resolver";
import { resetVaultCache } from "@/lib/seed/vault-client";
import { resolveConnection } from "@/lib/seed/resolve-connection";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
const REFERENCE = "${vault:secret/data/prod/postgres#password}";
const SESSION = { role: "admin", username: "admin@test.com" };

const realFetch = globalThis.fetch;
let vaultCalls: string[] = [];

function respondWithSecret(password: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    vaultCalls.push(String(input));
    return new Response(JSON.stringify({ data: { data: { password } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("seed pipeline with Vault references", () => {
  beforeEach(() => {
    resetCache();
    resetPlaintextWarnings();
    resetVaultCache();
    vaultCalls = [];
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "vault-config.yaml");
    process.env.VAULT_FIXTURE_ENV_PASSWORD = "env-secret";
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    respondWithSecret("vault-secret");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.VAULT_FIXTURE_ENV_PASSWORD;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
  });

  it("parses the quoted reference and lists it unresolved, with zero Vault requests", async () => {
    const conns = await getManagedConnections(["admin"]);

    expect(conns).toHaveLength(3);
    const unmanaged = conns.find((c) => c.seedId === "vault-mysql");
    expect(unmanaged?.password).toBe("${vault:secret/data/prod/mysql#password}");
    expect(conns.find((c) => c.seedId === "env-postgres")?.password).toBe("env-secret");
    expect(vaultCalls).toHaveLength(0);
  });

  it("resolves one reference when that connection is opened, then serves it from cache", async () => {
    const first = await resolveConnection({ connectionId: "seed:vault-postgres" }, SESSION);
    expect(first.password).toBe("vault-secret");
    expect(vaultCalls).toEqual(["http://127.0.0.1:8200/v1/secret/data/prod/postgres"]);

    const second = await resolveConnection({ connectionId: "seed:vault-postgres" }, SESSION);
    expect(second.password).toBe("vault-secret");
    expect(vaultCalls).toHaveLength(1);
  });

  it("leaves the unfiltered lookup unresolved, so a denied caller reads no secret", async () => {
    const conn = await getSeedConnectionByIdUnfiltered("vault-postgres");

    expect(conn?.password).toBe(REFERENCE);
    expect(vaultCalls).toHaveLength(0);
  });

  it("fails an unresolved reference explicitly rather than connecting with an empty password", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      vaultCalls.push(String(input));
      return new Response(JSON.stringify({ errors: ["standby"] }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(resolveConnection({ connectionId: "seed:vault-postgres" }, SESSION)).rejects.toThrow(/HTTP 503/);
  });

  it("names the missing VAULT_ADDR when the scheme is inert", async () => {
    delete process.env.VAULT_ADDR;

    await expect(resolveConnection({ connectionId: "seed:vault-postgres" }, SESSION)).rejects.toThrow(/VAULT_ADDR/);
    expect(vaultCalls).toHaveLength(0);
  });

  it("resolves env-var connections without touching Vault", async () => {
    const conn = await resolveConnection({ connectionId: "seed:env-postgres" }, SESSION);

    expect(conn.password).toBe("env-secret");
    expect(vaultCalls).toHaveLength(0);
  });
});
