import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readVaultSecret, resetVaultCache, VaultError } from "@/lib/seed/vault-client";

const PASSWORD_PATH = "secret/data/prod/postgres";
const OTHER_PATH = "secret/data/prod/mysql";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function secretResponse(password: string): Response {
  return jsonResponse({ data: { data: { password }, metadata: { version: 1 } } });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A fetch double that records every call, so request counts are asserted rather than assumed. */
function transport(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return handler(url, requestInit);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function headersOf(call: { init: RequestInit }): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

function writeServiceAccountToken(contents: string): { dir: string; tokenPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-k8s-"));
  const tokenPath = path.join(dir, "token");
  writeFileSync(tokenPath, contents);
  return { dir, tokenPath };
}

const tokenDirs: string[] = [];

describe("vault-client", () => {
  beforeEach(() => {
    resetVaultCache();
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_ROLE;
    delete process.env.VAULT_K8S_TOKEN_PATH;
    delete process.env.VAULT_NAMESPACE;
    delete process.env.VAULT_CACHE_TTL_MS;
  });

  afterEach(() => {
    for (const dir of tokenDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the key from a KV v2 response", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { calls, fetchImpl } = transport(() => secretResponse("pg-secret"));

    const value = await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl });

    expect(value).toBe("pg-secret");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8200/v1/secret/data/prod/postgres");
    expect(calls[0].init.method).toBe("GET");
    expect(headersOf(calls[0])["X-Vault-Token"]).toBe("root");
  });

  it("normalizes a trailing slash on VAULT_ADDR instead of requesting //v1/", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200///";
    process.env.VAULT_TOKEN = "root";
    const { calls, fetchImpl } = transport(() => secretResponse("pg-secret"));

    await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl });

    expect(calls[0].url).toBe("http://127.0.0.1:8200/v1/secret/data/prod/postgres");
  });

  it("sends X-Vault-Namespace only when VAULT_NAMESPACE is set", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    process.env.VAULT_NAMESPACE = "team-a";
    const { calls, fetchImpl } = transport(() => secretResponse("pg-secret"));

    await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl });

    expect(headersOf(calls[0])["X-Vault-Namespace"]).toBe("team-a");
  });

  it("fails with the missing variable named when VAULT_ADDR is unset", async () => {
    const { calls, fetchImpl } = transport(() => secretResponse("pg-secret"));

    await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(/VAULT_ADDR/);
    expect(calls).toHaveLength(0);
  });

  it("fails with the missing variables named when neither VAULT_TOKEN nor VAULT_ROLE is set", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    const { fetchImpl } = transport(() => secretResponse("pg-secret"));

    await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(
      /VAULT_TOKEN.*VAULT_ROLE/,
    );
  });

  it("serves a second read within the cache TTL without another request", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { calls, fetchImpl } = transport(() => secretResponse("pg-secret"));

    await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl });
    const again = await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl });

    expect(again).toBe("pg-secret");
    expect(calls).toHaveLength(1);
  });

  it("refetches after the TTL, picking up a rotated secret", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    process.env.VAULT_CACHE_TTL_MS = "1000";
    let clock = 0;
    let writes = 0;
    const { calls, fetchImpl } = transport(() => secretResponse(writes++ === 0 ? "old-secret" : "new-secret"));

    const first = await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl, now: () => clock });
    clock += 999;
    const cached = await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl, now: () => clock });
    clock += 1;
    const rotated = await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl, now: () => clock });

    expect(first).toBe("old-secret");
    expect(cached).toBe("old-secret");
    expect(rotated).toBe("new-secret");
    expect(calls).toHaveLength(2);
  });

  it("drops the cached secret on resetVaultCache", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { calls, fetchImpl } = transport(() => secretResponse("pg-secret"));

    await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl });
    resetVaultCache();
    await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl });

    expect(calls).toHaveLength(2);
  });

  it("refuses a 403 as a denial, never as a missing secret", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "wrong";
    const { fetchImpl } = transport(() => jsonResponse({ errors: ["permission denied"] }, 403));

    const failure = readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl });
    await expect(failure).rejects.toThrow(/HTTP 403/);
    await expect(failure).rejects.not.toThrow(/no secret|not found|404/i);
  });

  it("names the path on a 404 and points at the KV v2 shape", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { fetchImpl } = transport(() => jsonResponse({ errors: [] }, 404));

    await expect(readVaultSecret("secret/prod/postgres", "password", { fetch: fetchImpl })).rejects.toThrow(
      /"secret\/prod\/postgres".*KV v2/,
    );
  });

  it("reports any other non-200 status", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { fetchImpl } = transport(() => jsonResponse({ errors: ["standby"] }, 503));

    await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(/HTTP 503/);
  });

  it("rejects a body that is not JSON", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { fetchImpl } = transport(() => new Response("<html>nope</html>", { status: 200 }));

    await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(/not JSON/);
  });

  it("refuses a response without data.data instead of reading an empty secret", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { fetchImpl } = transport(() => jsonResponse({ data: { password: "v1-shaped" } }));

    await expect(readVaultSecret("secret/prod/postgres", "password", { fetch: fetchImpl })).rejects.toThrow(
      /no data\.data/,
    );
  });

  it("raises when the key is absent or not a string, without serialising the data object", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { fetchImpl } = transport(() => jsonResponse({ data: { data: { password: { nested: "value" } } } }));

    const failure = readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl });
    await expect(failure).rejects.toThrow(/no string key "password"/);
    await expect(failure).rejects.not.toThrow(/nested/);
  });

  it("reports an unreachable Vault when the transport rejects", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { fetchImpl } = transport(() => {
      throw new Error("ECONNREFUSED");
    });

    await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(/unreachable/);
  });

  it("times out a request that never settles", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { fetchImpl } = transport(() => new Promise<Response>(() => {}));

    await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl, timeoutMs: 5 })).rejects.toThrow(
      /timed out/,
    );
  });

  describe("Kubernetes auth", () => {
    it("logs in with the service account token and uses the returned client token", async () => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_ROLE = "studio";
      const { dir, tokenPath } = writeServiceAccountToken("sa-jwt\n");
      tokenDirs.push(dir);
      process.env.VAULT_K8S_TOKEN_PATH = tokenPath;

      const { calls, fetchImpl } = transport((url) => {
        if (url.endsWith("/v1/auth/kubernetes/login")) {
          return jsonResponse({ auth: { client_token: "lease-token", lease_duration: 3600 } });
        }
        return secretResponse("pg-secret");
      });

      const value = await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl });

      expect(value).toBe("pg-secret");
      const login = calls.find((c) => c.url.endsWith("/v1/auth/kubernetes/login"))!;
      expect(login.init.method).toBe("POST");
      expect(JSON.parse(login.init.body as string)).toEqual({ role: "studio", jwt: "sa-jwt" });
      expect(headersOf(calls[calls.length - 1])["X-Vault-Token"]).toBe("lease-token");
    });

    it("reuses the lease for later reads and re-logs in before it lapses", async () => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_ROLE = "studio";
      const { dir, tokenPath } = writeServiceAccountToken("sa-jwt");
      tokenDirs.push(dir);
      process.env.VAULT_K8S_TOKEN_PATH = tokenPath;

      let logins = 0;
      let clock = 0;
      const { calls, fetchImpl } = transport((url) => {
        if (url.endsWith("/v1/auth/kubernetes/login")) {
          logins += 1;
          // 120s lease: the client re-logs in 30s before it lapses, so the token is good for 90s.
          return jsonResponse({ auth: { client_token: `token-${logins}`, lease_duration: 120 } });
        }
        return secretResponse("pg-secret");
      });

      await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl, now: () => clock });
      clock += 1000;
      await readVaultSecret(OTHER_PATH, "password", { fetch: fetchImpl, now: () => clock });
      expect(logins).toBe(1);

      clock += 90_000;
      await readVaultSecret("secret/data/prod/other", "password", { fetch: fetchImpl, now: () => clock });
      expect(logins).toBe(2);
      expect(calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(2);
    });

    it("re-logs in once on a 403 and fails if the second attempt is refused too", async () => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_ROLE = "studio";
      const { dir, tokenPath } = writeServiceAccountToken("sa-jwt");
      tokenDirs.push(dir);
      process.env.VAULT_K8S_TOKEN_PATH = tokenPath;

      let logins = 0;
      let denials = 0;
      const { calls, fetchImpl } = transport((url) => {
        if (url.endsWith("/v1/auth/kubernetes/login")) {
          logins += 1;
          return jsonResponse({ auth: { client_token: `token-${logins}`, lease_duration: 3600 } });
        }
        denials += 1;
        return jsonResponse({ errors: ["permission denied"] }, 403);
      });

      await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(/HTTP 403/);
      expect(logins).toBe(2);
      expect(denials).toBe(2);
      expect(calls.filter((c) => c.url.includes(PASSWORD_PATH))).toHaveLength(2);
    });

    it("retries a 403 once with a fresh token and succeeds", async () => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_ROLE = "studio";
      const { dir, tokenPath } = writeServiceAccountToken("sa-jwt");
      tokenDirs.push(dir);
      process.env.VAULT_K8S_TOKEN_PATH = tokenPath;

      let logins = 0;
      const { fetchImpl } = transport((url) => {
        if (url.endsWith("/v1/auth/kubernetes/login")) {
          logins += 1;
          return jsonResponse({ auth: { client_token: `token-${logins}`, lease_duration: 3600 } });
        }
        return logins === 1 ? jsonResponse({ errors: [] }, 403) : secretResponse("pg-secret");
      });

      expect(await readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).toBe("pg-secret");
      expect(logins).toBe(2);
    });

    it("does not re-login on a 403 when VAULT_TOKEN is the credential", async () => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_TOKEN = "root";
      process.env.VAULT_ROLE = "studio";
      const { calls, fetchImpl } = transport(() => jsonResponse({ errors: [] }, 403));

      await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(/HTTP 403/);
      expect(calls).toHaveLength(1);
    });

    it("fails when the service account token cannot be read", async () => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_ROLE = "studio";
      process.env.VAULT_K8S_TOKEN_PATH = path.join(tmpdir(), "vault-k8s-missing", "token");
      const { calls, fetchImpl } = transport(() => secretResponse("pg-secret"));

      await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(
        /service account token/,
      );
      expect(calls).toHaveLength(0);
    });

    it("reports a refused login", async () => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_ROLE = "studio";
      const { dir, tokenPath } = writeServiceAccountToken("sa-jwt");
      tokenDirs.push(dir);
      process.env.VAULT_K8S_TOKEN_PATH = tokenPath;
      const { fetchImpl } = transport(() => jsonResponse({ errors: ["invalid role"] }, 400));

      await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(
        /Kubernetes login for role "studio" failed with HTTP 400/,
      );
    });

    it("reports a login body that is not JSON", async () => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_ROLE = "studio";
      const { dir, tokenPath } = writeServiceAccountToken("sa-jwt");
      tokenDirs.push(dir);
      process.env.VAULT_K8S_TOKEN_PATH = tokenPath;
      const { fetchImpl } = transport(() => new Response("not json", { status: 200 }));

      await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(
        /login for role "studio" returned a body that is not JSON/,
      );
    });

    it("reports a login response without a client token", async () => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_ROLE = "studio";
      const { dir, tokenPath } = writeServiceAccountToken("sa-jwt");
      tokenDirs.push(dir);
      process.env.VAULT_K8S_TOKEN_PATH = tokenPath;
      const { fetchImpl } = transport(() => jsonResponse({ auth: { lease_duration: 3600 } }));

      await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toThrow(
        /returned no client token/,
      );
    });
  });

  it("is a VaultError", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const { fetchImpl } = transport(() => jsonResponse({}, 500));

    await expect(readVaultSecret(PASSWORD_PATH, "password", { fetch: fetchImpl })).rejects.toBeInstanceOf(VaultError);
  });
});
