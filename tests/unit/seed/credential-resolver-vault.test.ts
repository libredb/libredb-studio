import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({
  logger: { debug, info, warn, error },
}));

import {
  resolveAllCredentials,
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

  it("resolves a ${vault:...} reference on the Elasticsearch API key secret", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";

    const resolved = await resolveVaultCredentials(
      {
        ...baseConn,
        type: "elasticsearch",
        apiKeyId: "seed-key-id",
        apiKeySecret: "${vault:secret/data/prod/elastic#apiKeySecret}",
      },
      {
        fetch: (async () =>
          new Response(JSON.stringify({ data: { data: { apiKeySecret: "vault-key-secret" } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      },
    );

    expect(resolved.apiKeyId).toBe("seed-key-id");
    expect(resolved.apiKeySecret).toBe("vault-key-secret");
  });

  it("resolves a ${vault:...} reference in dataServers", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";

    const resolved = await resolveVaultCredentials(
      { ...baseConn, dataServers: "${vault:secret/data/oxia#servers}" },
      {
        fetch: (async () =>
          new Response(JSON.stringify({ data: { data: { servers: "a.internal:6648,b.internal:6648" } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      },
    );

    expect(resolved.dataServers).toBe("a.internal:6648,b.internal:6648");
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

  /**
   * The TLS material under `ssl` (#1089): a `${vault:...}` reference in `ssl.caCert`, `ssl.clientCert`
   * or `ssl.clientKey` is left alone on the list path and read on open, as a top-level one is, and no
   * value resolved there, from the environment or from Vault, reaches a log line.
   */
  describe("the TLS material under ssl (#1089)", () => {
    type SeedSsl = NonNullable<SeedConnection["ssl"]>;
    const ETCD_PATH_URL = "http://127.0.0.1:8200/v1/secret/data/prod/etcd";
    const vaultData = (data: Record<string, string>, calls: string[]) =>
      (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ data: { data } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

    beforeEach(() => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_TOKEN = "root";
    });

    afterEach(() => {
      delete process.env.SEED_TLS_CA;
      delete process.env.SEED_TLS_KEY;
    });

    it.each(["caCert", "clientCert", "clientKey"] as const)(
      "resolves a ${vault:...} reference in ssl.%s on open and keeps the rest of the ssl object",
      async (field) => {
        const calls: string[] = [];
        const ssl: SeedSsl = { mode: "verify-full", rejectUnauthorized: true };
        ssl[field] = `\${vault:secret/data/prod/etcd#${field}}`;
        const expected: SeedSsl = { mode: "verify-full", rejectUnauthorized: true };
        expected[field] = `vault ${field}`;

        const resolved = await resolveVaultCredentials(
          { ...baseConn, ssl },
          { fetch: vaultData({ [field]: `vault ${field}` }, calls) },
        );

        expect(resolved.ssl).toStrictEqual(expected);
        expect(calls).toEqual([ETCD_PATH_URL]);
      },
    );

    it("resolves the three from one path with one request, each read after the one before it", async () => {
      // One after another on purpose: the second and third read are answered from the cache the first
      // fills, where reads started together would each miss it.
      const calls: string[] = [];
      const resolved = await resolveVaultCredentials(
        {
          ...baseConn,
          ssl: {
            mode: "verify-full",
            caCert: "${vault:secret/data/prod/etcd#ca}",
            clientCert: "${vault:secret/data/prod/etcd#cert}",
            clientKey: "${vault:secret/data/prod/etcd#key}",
          },
        },
        { fetch: vaultData({ ca: "VAULT-CA", cert: "VAULT-CERT", key: "VAULT-KEY" }, calls) },
      );

      expect(resolved.ssl).toStrictEqual({
        mode: "verify-full",
        caCert: "VAULT-CA",
        clientCert: "VAULT-CERT",
        clientKey: "VAULT-KEY",
      });
      expect(calls).toEqual([ETCD_PATH_URL]);
    });

    it("returns the connection unchanged, and makes no request, when its ssl object holds no reference", async () => {
      const calls: string[] = [];
      const conn = { ...baseConn, ssl: { mode: "verify-full" as const, caCert: "CA-PEM", clientKey: "KEY-PEM" } };

      const resolved = await resolveVaultCredentials(conn, { fetch: vaultData({}, calls) });

      expect(resolved).toBe(conn);
      expect(calls).toHaveLength(0);
    });

    it("never writes into the connection's own ssl object", async () => {
      const ssl = { mode: "verify-full" as const, clientKey: "${vault:secret/data/prod/etcd#clientKey}" };
      const conn = { ...baseConn, ssl };

      const resolved = await resolveVaultCredentials(conn, { fetch: vaultData({ clientKey: "VAULT-KEY" }, []) });

      expect(resolved.ssl?.clientKey).toBe("VAULT-KEY");
      expect(conn.ssl).toBe(ssl);
      expect(ssl).toStrictEqual({ mode: "verify-full", clientKey: "${vault:secret/data/prod/etcd#clientKey}" });
    });

    it("names ssl.clientKey when its ${vault:...} reference has no #key", async () => {
      const failure = resolveVaultCredentials({
        ...baseConn,
        ssl: { mode: "verify-full", clientKey: "${vault:secret/data/prod/etcd}" },
      });

      await expect(failure).rejects.toBeInstanceOf(VaultError);
      await expect(failure).rejects.toThrow('(seed connection "test" field "ssl.clientKey")');
    });

    it("leaves a ${vault:...} reference under ssl untouched on the list path, with no plaintext warning", () => {
      const reference = "${vault:secret/data/prod/etcd#clientKey}";

      const resolved = resolveConnectionCredentials({
        ...baseConn,
        ssl: { mode: "verify-full", clientKey: reference },
      });

      expect(resolved.ssl?.clientKey).toBe(reference);
      expect(warn).not.toHaveBeenCalled();
    });

    it("never writes an ssl value it resolved to a log line, on the list path or on open", async () => {
      process.env.SEED_TLS_KEY = "ENV-KEY-must-not-be-logged";
      const listed = resolveConnectionCredentials({
        ...baseConn,
        ssl: { mode: "verify-full", clientKey: "${SEED_TLS_KEY}" },
      });
      const opened = await resolveVaultCredentials(
        { ...baseConn, ssl: { mode: "verify-full", clientKey: "${vault:secret/data/prod/etcd#clientKey}" } },
        { fetch: vaultData({ clientKey: "VAULT-KEY-must-not-be-logged" }, []) },
      );

      // Vacuity: both were resolved, so there was a value to leak.
      expect([listed.ssl?.clientKey, opened.ssl?.clientKey]).toEqual([
        "ENV-KEY-must-not-be-logged",
        "VAULT-KEY-must-not-be-logged",
      ]);
      const captured = JSON.stringify([debug, info, warn, error].flatMap((logger) => logger.mock.calls));
      expect(captured).not.toContain("must-not-be-logged");
    });

    it("skips, at load, a connection whose ssl reference is unset, logging the variable and ssl.clientKey and no value", () => {
      process.env.SEED_TLS_CA = "CA-must-not-be-logged";

      const resolved = resolveAllCredentials([
        {
          ...baseConn,
          id: "cluster",
          ssl: { mode: "verify-full", caCert: "${SEED_TLS_CA}", clientKey: "${SEED_TLS_KEY}" },
        },
        { ...baseConn, id: "other" },
      ]);

      expect(resolved.map((conn) => conn.id)).toEqual(["other"]);
      expect(error).toHaveBeenCalledTimes(1);
      const [message, failure, context] = error.mock.calls[0] as unknown as [string, Error, Record<string, unknown>];
      expect(message).toBe("Seed connection skipped due to credential resolution failure");
      expect(failure.message).toBe(
        'Environment variable SEED_TLS_KEY is not defined (required by seed connection "cluster" field "ssl.clientKey")',
      );
      expect(context).toEqual({ route: "seed/credential-resolver", connectionId: "cluster" });
    });
  });
});
