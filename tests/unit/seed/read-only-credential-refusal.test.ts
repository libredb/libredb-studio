import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({
  logger: { debug, info, warn, error },
}));

import { readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import {
  resetPlaintextWarnings,
  resolveConnectionCredentials,
  resolveVaultCredentials,
} from "@/lib/seed/credential-resolver";
import { SeedConfigSchema, SeedConnectionSchema } from "@/lib/seed/types";
import { resetVaultCache } from "@/lib/seed/vault-client";
import {
  declareCredentialWarnings,
  SYNTHETIC_NO_SECRET,
  SYNTHETIC_PAIR,
} from "../../helpers/synthetic-credential-warnings";

/**
 * "Load refuses what the file shows; resolution refuses the rest." The load stage is the seed schema; the
 * resolution stage is `readOnlySeedRefusal` over what the resolver returns, which a declaring type's provider
 * runs before it dials. The declarations are synthetic, on etcd, the one type whose provider enforces readOnly.
 */

const PAIR_SENTENCE = `Credential warning: ${SYNTHETIC_PAIR.message}`;
const NO_SECRET_SENTENCE = `Credential warning: ${SYNTHETIC_NO_SECRET.message}`;
const VAULT_REFERENCE = "${vault:secret/data/etcd#password}";

const base = {
  id: "cluster-read",
  name: "Cluster",
  type: "etcd",
  host: "etcd.internal",
  port: 2379,
  roles: ["*"],
  managed: true,
  readOnly: true,
} as const;

function refusedAtLoad(refusal: string): string {
  return `Seed connection "cluster-read": ${refusal} readOnly: true is refused with this credential, because the mode would promise a boundary the server does not keep. Give this connection a credential of its own, or remove readOnly.`;
}

function issuesOf(connection: Record<string, unknown>): [string, string][] {
  const result = SeedConnectionSchema.safeParse(connection);
  return result.success ? [] : result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
}

function secretResponse(password: string): Response {
  return new Response(JSON.stringify({ data: { data: { password } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let restore: () => void = () => {};

beforeEach(() => {
  restore = declareCredentialWarnings("etcd", [SYNTHETIC_PAIR, SYNTHETIC_NO_SECRET]);
  resetPlaintextWarnings();
  resetVaultCache();
});

afterEach(() => {
  restore();
  delete process.env.SYNTH_SEED_PASSWORD;
  delete process.env.SYNTH_SEED_USER;
  delete process.env.VAULT_ADDR;
  delete process.env.VAULT_TOKEN;
});

describe("load: what the file shows", () => {
  it("refuses a literal root/Milvus on a read-only seed, naming the connection and the field, never the value", () => {
    const issues = issuesOf({ ...base, user: "root", password: "Milvus" });
    expect(issues).toEqual([["password", refusedAtLoad(PAIR_SENTENCE)]]);
    expect(JSON.stringify(issues)).not.toContain("Milvus");
  });

  it("accepts root with another password", () => {
    expect(issuesOf({ ...base, user: "root", password: "Other1" })).toEqual([]);
  });

  it("accepts root/Milvus on a seed that is not read-only", () => {
    expect(issuesOf({ ...base, readOnly: false, user: "root", password: "Milvus" })).toEqual([]);
    expect(issuesOf({ ...base, readOnly: undefined, user: "root", password: "Milvus" })).toEqual([]);
  });

  it("refuses an empty user with the password root:Milvus", () => {
    expect(issuesOf({ ...base, user: "", password: "root:Milvus" })).toEqual([
      ["password", refusedAtLoad(PAIR_SENTENCE)],
    ]);
    expect(issuesOf({ ...base, password: "root:Milvus" })).toEqual([["password", refusedAtLoad(PAIR_SENTENCE)]]);
  });

  it("refuses a read-only seed with no password, or an empty one, where the type declares no-secret", () => {
    expect(issuesOf({ ...base, user: "reader" })).toEqual([["password", refusedAtLoad(NO_SECRET_SENTENCE)]]);
    expect(issuesOf({ ...base, user: "reader", password: "" })).toEqual([
      ["password", refusedAtLoad(NO_SECRET_SENTENCE)],
    ]);
  });

  it("passes a ${ENV} or ${vault:...} reference, which the file cannot show", () => {
    expect(issuesOf({ ...base, user: "root", password: "${SYNTH_SEED_PASSWORD}" })).toEqual([]);
    expect(issuesOf({ ...base, user: "root", password: VAULT_REFERENCE })).toEqual([]);
    expect(issuesOf({ ...base, user: "${SYNTH_SEED_USER}", password: "Milvus" })).toEqual([]);
  });

  it("refuses a read-only seed with no password, or an empty one, even when its user is a reference", () => {
    expect(issuesOf({ ...base, user: "${SYNTH_SEED_USER}" })).toEqual([["password", refusedAtLoad(NO_SECRET_SENTENCE)]]);
    expect(issuesOf({ ...base, user: "${SYNTH_SEED_USER}", password: "" })).toEqual([
      ["password", refusedAtLoad(NO_SECRET_SENTENCE)],
    ]);
    expect(issuesOf({ ...base, user: "${vault:secret/data/etcd#user}" })).toEqual([
      ["password", refusedAtLoad(NO_SECRET_SENTENCE)],
    ]);
  });

  it("reads a value the resolver never resolves as the literal it is", () => {
    expect(issuesOf({ ...base, user: "${lower}", password: "" })).toEqual([
      ["password", refusedAtLoad(NO_SECRET_SENTENCE)],
    ]);
    expect(issuesOf({ ...base, user: "root", password: "${not a ref}" })).toEqual([]);
    restore();
    restore = declareCredentialWarnings("etcd", [{ ...SYNTHETIC_PAIR, password: "${lower}" }]);
    expect(issuesOf({ ...base, user: "root", password: "${lower}" })).toEqual([
      ["password", refusedAtLoad(PAIR_SENTENCE)],
    ]);
  });

  it("refuses inside a whole seed file under the connection's own path", () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [{ ...base, user: "root", password: "Milvus" }],
    });
    expect(result.success ? [] : result.error.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["connections.0.password", refusedAtLoad(PAIR_SENTENCE)],
    ]);
  });

  it("refuses nothing on a type that declares nothing", () => {
    restore();
    restore = () => {};
    expect(issuesOf({ ...base, user: "root", password: "Milvus" })).toEqual([]);
    expect(issuesOf({ ...base, user: "reader" })).toEqual([]);
  });
});

describe("resolution: what the references become", () => {
  it("refuses a ${ENV} password that resolves to the declared pair, with no request sent", () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      process.env.SYNTH_SEED_PASSWORD = "Milvus";
      const parsed = SeedConnectionSchema.parse({ ...base, user: "root", password: "${SYNTH_SEED_PASSWORD}" });
      const resolved = resolveConnectionCredentials(parsed);
      expect(readOnlySeedRefusal(resolved.type, resolved)).toBe(PAIR_SENTENCE);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("refuses a ${ENV} token that resolves to root:Milvus with an empty user", () => {
    process.env.SYNTH_SEED_PASSWORD = "root:Milvus";
    const parsed = SeedConnectionSchema.parse({ ...base, user: "", password: "${SYNTH_SEED_PASSWORD}" });
    expect(readOnlySeedRefusal(parsed.type, resolveConnectionCredentials(parsed))).toBe(PAIR_SENTENCE);
  });

  it("refuses a ${ENV} password that resolves to nothing where the type declares no-secret", () => {
    process.env.SYNTH_SEED_PASSWORD = "";
    const parsed = SeedConnectionSchema.parse({ ...base, user: "reader", password: "${SYNTH_SEED_PASSWORD}" });
    expect(readOnlySeedRefusal(parsed.type, resolveConnectionCredentials(parsed))).toBe(NO_SECRET_SENTENCE);
  });

  it("refuses a ${vault:...} password that resolves to the pair, after one Vault read and nothing else", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const vaultFetch = mock(async () => secretResponse("Milvus"));
    const globalFetch = spyOn(globalThis, "fetch");
    try {
      const parsed = SeedConnectionSchema.parse({ ...base, user: "root", password: VAULT_REFERENCE });
      const resolved = await resolveVaultCredentials(parsed, { fetch: vaultFetch as unknown as typeof fetch });
      expect(readOnlySeedRefusal(resolved.type, resolved)).toBe(PAIR_SENTENCE);
      expect(vaultFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("refuses a ${vault:...} password that resolves to an empty string where the type declares no-secret", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    const parsed = SeedConnectionSchema.parse({ ...base, user: "reader", password: VAULT_REFERENCE });
    const resolved = await resolveVaultCredentials(parsed, {
      fetch: (async () => secretResponse("")) as unknown as typeof fetch,
    });
    expect(readOnlySeedRefusal(resolved.type, resolved)).toBe(NO_SECRET_SENTENCE);
  });

  it("accepts a reference that resolves to another password", () => {
    process.env.SYNTH_SEED_PASSWORD = "Other1";
    const parsed = SeedConnectionSchema.parse({ ...base, user: "root", password: "${SYNTH_SEED_PASSWORD}" });
    expect(readOnlySeedRefusal(parsed.type, resolveConnectionCredentials(parsed))).toBeUndefined();
  });
});
