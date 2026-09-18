import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({
  logger: { debug, info, warn, error },
}));

import {
  resolveConnectionCredentials,
  resolveVaultCredentials,
  resetPlaintextWarnings,
} from "@/lib/seed/credential-resolver";
import { resetVaultCache, VaultError } from "@/lib/seed/vault-client";
import type { SeedConnection } from "@/lib/seed/types";

const REFERENCE = "${vault:secret/data/prod/postgres#password}";

function secretResponse(password: string): Response {
  return new Response(JSON.stringify({ data: { data: { password } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const baseConn: SeedConnection = {
  id: "test",
  name: "Test",
  type: "postgres",
  host: "localhost",
  roles: ["*"],
};

describe("credential-resolver vault scheme", () => {
  beforeEach(() => {
    resetPlaintextWarnings();
    resetVaultCache();
    for (const logger of [debug, info, warn, error]) logger.mockClear();
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
  });

  afterEach(() => {
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
  });

  it("leaves a ${vault:...} reference untouched on the eager path", () => {
    const conn = { ...baseConn, password: REFERENCE };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.password).toBe(REFERENCE);
  });

  it("does not log the plaintext-password warning for a ${vault:...} reference", () => {
    resolveConnectionCredentials({ ...baseConn, password: REFERENCE });
    expect(warn).not.toHaveBeenCalled();
  });

  it("never writes the resolved value to a log line", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";

    const resolved = await resolveVaultCredentials(
      { ...baseConn, password: REFERENCE },
      { fetch: (async () => secretResponse("log-must-not-see-this")) as unknown as typeof fetch },
    );

    expect(resolved.password).toBe("log-must-not-see-this");
    const captured = JSON.stringify([debug, info, warn, error].flatMap((logger) => logger.mock.calls));
    expect(captured).not.toContain("log-must-not-see-this");
    // The reference may be logged; it is not a secret.
    expect(captured).toContain("secret/data/prod/postgres");
  });

  it("still resolves ${ENV_VAR} eagerly", () => {
    process.env.VAULT_RESOLVER_ENV_PASSWORD = "env-secret";
    try {
      const resolved = resolveConnectionCredentials({ ...baseConn, password: "${VAULT_RESOLVER_ENV_PASSWORD}" });
      expect(resolved.password).toBe("env-secret");
    } finally {
      delete process.env.VAULT_RESOLVER_ENV_PASSWORD;
    }
  });

  it("returns the connection unchanged and makes no request when it has no reference", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    const calls: string[] = [];
    const conn = { ...baseConn, password: "plaintext" };

    const resolved = await resolveVaultCredentials(conn, {
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return secretResponse("never");
      }) as unknown as typeof fetch,
    });

    expect(resolved).toBe(conn);
    expect(calls).toHaveLength(0);
  });

  it("resolves a reference through the injected transport", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const calls: string[] = [];

    const resolved = await resolveVaultCredentials(
      { ...baseConn, password: REFERENCE },
      {
        fetch: (async (input: RequestInfo | URL) => {
          calls.push(String(input));
          return secretResponse("vault-secret");
        }) as unknown as typeof fetch,
      },
    );

    expect(resolved.password).toBe("vault-secret");
    expect(resolved.id).toBe("test");
    expect(calls).toEqual(["http://127.0.0.1:8200/v1/secret/data/prod/postgres"]);
  });

  it("resolves references in the other resolvable fields", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";

    const resolved = await resolveVaultCredentials(
      { ...baseConn, user: "${vault:secret/data/prod/postgres#username}" },
      {
        fetch: (async () =>
          new Response(JSON.stringify({ data: { data: { username: "vaultuser" } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      },
    );

    expect(resolved.user).toBe("vaultuser");
  });

  it("raises on a ${vault:...} reference with no #key", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";

    const failure = resolveVaultCredentials({ ...baseConn, password: "${vault:secret/data/prod/postgres}" });
    await expect(failure).rejects.toBeInstanceOf(VaultError);
    await expect(failure).rejects.toThrow(/Invalid Vault reference.*#<key>/);
  });

  it("raises on a ${vault:...} reference with an empty key", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";

    const failure = resolveVaultCredentials({ ...baseConn, password: "${vault:secret/data/prod/postgres#}" });
    await expect(failure).rejects.toBeInstanceOf(VaultError);
    await expect(failure).rejects.toThrow(/Invalid Vault reference/);
  });

  it("fails with VAULT_ADDR named when the scheme is used but not configured", async () => {
    await expect(resolveVaultCredentials({ ...baseConn, password: REFERENCE })).rejects.toThrow(/VAULT_ADDR/);
  });
});
