/**
 * HashiCorp Vault reads for seed connection credentials.
 *
 * Opt-in and lazy: nothing here runs at module load, and `VAULT_ADDR` is read at the
 * moment a `${vault:...}` reference is resolved rather than when this file is imported.
 * A deployment with no such reference in its seed file never constructs a client, never
 * makes a request, and sees nothing about Vault in its log — whether or not `VAULT_ADDR`
 * happens to be set.
 *
 * Only the KV v2 read path is implemented. The response shape is `data.data.<key>`, and
 * a response without it is refused rather than read as an empty secret.
 */
import { readFile } from "fs/promises";
import { logger } from "@/lib/logger";

const DEFAULT_K8S_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Re-login this long before a Kubernetes auth lease lapses, so a token never dies mid-request. */
const TOKEN_REFRESH_SKEW_MS = 30_000;

/** A Vault read that could not be turned into a secret. The message names the path, never the value. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/**
 * Injectable seams. Tests pin the clock, the transport and the timeout so TTL boundaries,
 * error branches and timeouts are exercised without sleeping or reaching a real Vault.
 */
export interface VaultDeps {
  now?: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface SecretCacheEntry {
  data: Record<string, unknown>;
  expiresAt: number;
}

interface KubernetesToken {
  token: string;
  expiresAt: number;
}

const secretCache = new Map<string, SecretCacheEntry>();
let kubernetesToken: KubernetesToken | null = null;

/** Drops the secret cache and any Kubernetes auth token. Tests call this between cases. */
export function resetVaultCache(): void {
  secretCache.clear();
  kubernetesToken = null;
}

function vaultAddress(): string | undefined {
  const raw = process.env.VAULT_ADDR?.trim();
  if (!raw) return undefined;
  // A trailing slash would build "//v1/", which Vault answers with a 404 rather than a secret.
  return raw.replace(/\/+$/, "");
}

function cacheTtlMs(): number {
  const raw = Number(process.env.VAULT_CACHE_TTL_MS);
  return Number.isFinite(raw) ? raw : DEFAULT_CACHE_TTL_MS;
}

function vaultHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers["X-Vault-Token"] = token;
  const namespace = process.env.VAULT_NAMESPACE?.trim();
  if (namespace) headers["X-Vault-Namespace"] = namespace;
  return headers;
}

function canRelogin(): boolean {
  return !process.env.VAULT_TOKEN?.trim() && !!process.env.VAULT_ROLE?.trim();
}

async function vaultFetch(url: string, init: RequestInit, deps: Required<VaultDeps>, what: string): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new VaultError(`Vault request for "${what}" timed out after ${deps.timeoutMs}ms`));
    }, deps.timeoutMs);
  });

  try {
    return await Promise.race([deps.fetch(url, { ...init, signal: controller.signal }), timeout]);
  } catch (err) {
    if (err instanceof VaultError) throw err;
    throw new VaultError(`Vault is unreachable for "${what}": ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function kubernetesLogin(addr: string, role: string, deps: Required<VaultDeps>): Promise<KubernetesToken> {
  const tokenPath = process.env.VAULT_K8S_TOKEN_PATH || DEFAULT_K8S_TOKEN_PATH;

  let jwt: string;
  try {
    jwt = (await readFile(tokenPath, "utf-8")).trim();
  } catch {
    throw new VaultError(
      `Vault Kubernetes auth is enabled (VAULT_ROLE) but the service account token at "${tokenPath}" could not be read`,
    );
  }

  const url = `${addr}/v1/auth/kubernetes/login`;
  const res = await vaultFetch(
    url,
    {
      method: "POST",
      headers: { ...vaultHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ role, jwt }),
    },
    deps,
    url,
  );
  if (!res.ok) {
    throw new VaultError(`Vault Kubernetes login for role "${role}" failed with HTTP ${res.status}`);
  }

  let body: { auth?: { client_token?: unknown; lease_duration?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new VaultError(`Vault Kubernetes login for role "${role}" returned a body that is not JSON`);
  }

  const clientToken = body.auth?.client_token;
  if (typeof clientToken !== "string" || clientToken.length === 0) {
    throw new VaultError(`Vault Kubernetes login for role "${role}" returned no client token`);
  }

  // A token from auth/kubernetes/login carries a lease. Caching it for the process lifetime
  // works for hours in staging and then starts failing in production, where the lease lapses.
  const leaseSeconds = typeof body.auth?.lease_duration === "number" ? body.auth.lease_duration : 0;
  const ttl = Math.max(leaseSeconds * 1000 - TOKEN_REFRESH_SKEW_MS, 0);
  return { token: clientToken, expiresAt: deps.now() + ttl };
}

async function authToken(addr: string, deps: Required<VaultDeps>): Promise<string> {
  const staticToken = process.env.VAULT_TOKEN?.trim();
  if (staticToken) return staticToken;

  const role = process.env.VAULT_ROLE?.trim();
  if (!role) {
    throw new VaultError(
      'Vault credentials are not configured: set VAULT_TOKEN, or VAULT_ROLE for Kubernetes auth, to resolve a "${vault:...}" reference',
    );
  }

  if (kubernetesToken && deps.now() < kubernetesToken.expiresAt) return kubernetesToken.token;
  kubernetesToken = await kubernetesLogin(addr, role, deps);
  return kubernetesToken.token;
}

async function readData(addr: string, path: string, deps: Required<VaultDeps>): Promise<Record<string, unknown>> {
  const url = `${addr}/v1/${path}`;

  let token = await authToken(addr, deps);
  let res = await vaultFetch(url, { method: "GET", headers: vaultHeaders(token) }, deps, url);

  // A 403 means the token is wrong, absent or under-privileged — an unknown secret is a 404.
  // So re-login at most once for Kubernetes auth, and if the second attempt is refused too,
  // let the refusal stand rather than looping on a genuine permission denial.
  if (res.status === 403 && canRelogin()) {
    kubernetesToken = null;
    token = await authToken(addr, deps);
    res = await vaultFetch(url, { method: "GET", headers: vaultHeaders(token) }, deps, url);
  }

  if (res.status === 403) {
    throw new VaultError(
      `Vault denied the request for "${path}" (HTTP 403); the token is invalid, expired or lacks a policy for this path`,
    );
  }
  if (res.status === 404) {
    throw new VaultError(
      `Vault has no secret at "${path}" (HTTP 404); a KV v2 mount serves secrets at "<mount>/data/<name>"`,
    );
  }
  if (!res.ok) {
    throw new VaultError(`Vault returned HTTP ${res.status} for "${path}"`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new VaultError(`Vault returned a body that is not JSON for "${path}"`);
  }

  const data = (body as { data?: { data?: unknown } } | null)?.data?.data;
  if (typeof data !== "object" || data === null) {
    throw new VaultError(
      `Vault response for "${path}" has no data.data object; only KV v2 paths are supported (expected "<mount>/data/<name>")`,
    );
  }

  return data as Record<string, unknown>;
}

function secretValue(data: Record<string, unknown>, path: string, key: string): string {
  const value = data[key];
  if (typeof value !== "string") {
    // Deliberately not serialising `data`: an object under the key would otherwise land in a
    // password field and surface as a database authentication error, hours from its cause.
    throw new VaultError(`Vault secret "${path}" has no string key "${key}"`);
  }
  return value;
}

/**
 * Reads `<mount>/data/<path>` from Vault and returns the string at `key`.
 *
 * Results are cached per path for `VAULT_CACHE_TTL_MS` (default 60000), so a rotated secret
 * is picked up within one TTL and no restart, while a second connection to the same path
 * within the TTL costs no request.
 */
export async function readVaultSecret(path: string, key: string, deps: VaultDeps = {}): Promise<string> {
  const now = deps.now ?? Date.now;
  const resolved: Required<VaultDeps> = {
    now,
    fetch: deps.fetch ?? fetch,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  const cached = secretCache.get(path);
  if (cached && now() < cached.expiresAt) {
    return secretValue(cached.data, path, key);
  }

  const addr = vaultAddress();
  if (!addr) {
    throw new VaultError(`Vault address is not configured: set VAULT_ADDR to resolve "\${vault:${path}#${key}}"`);
  }

  logger.debug("Reading Vault secret", { route: "seed/vault-client", path });
  const data = await readData(addr, path, resolved);
  secretCache.set(path, { data, expiresAt: now() + cacheTtlMs() });
  return secretValue(data, path, key);
}
