/**
 * The Redis Sentinel connection fields, end to end through every layer a field passes before the provider reads it:
 * the seed schema's declaration, the seed filter's copy, the credential resolver, the storage classification, the
 * seed-copy resolution key, the server fingerprint, the provider cache key and the agent's connection identity. The
 * provider's own side of the fields (validate, option building, the retry strategy) is
 * tests/integration/db/redis-provider.test.ts; this file holds the layers the provider cannot see.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connectionResolutionKey } from "@/hooks/use-connection-payload";
import { connectionIdentity } from "@/lib/agent/context-snapshot";
import { providerCacheKey } from "@/lib/db/provider-cache-key";
import { filterByRoles } from "@/lib/seed/connection-filter";
import {
  resolveConnectionCredentials,
  resolveVaultCredentials,
  UndefinedSeedVariableError,
} from "@/lib/seed/credential-resolver";
import { SeedConnectionSchema, type SeedConnection } from "@/lib/seed/types";
import { resetVaultCache } from "@/lib/seed/vault-client";
import { CONNECTION_FIELDS } from "@/lib/storage/connection-secrets";
import type { DatabaseConnection } from "@/lib/types";

const base: DatabaseConnection = {
  id: "cache",
  name: "Cache",
  type: "redis",
  host: "cache.internal",
  port: 6379,
  createdAt: new Date(0),
};
const seed: SeedConnection = {
  id: "sentinel-seed",
  name: "Seed",
  type: "redis",
  host: "cache.internal",
  roles: ["*"],
};
/** One Sentinel-shaped record: the two address fields set, the sentinels' password of their own. */
const sentinel: DatabaseConnection = {
  ...base,
  masterName: "mymaster",
  sentinelNodes: "s1:26379, s2:26379",
  sentinelPassword: "pw",
};

afterEach(() => {
  delete process.env.SENTINEL_FIELD_TEST;
  delete process.env.VAULT_ADDR;
  delete process.env.VAULT_TOKEN;
  resetVaultCache();
});

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("the seed layer keeps the Sentinel fields", () => {
  test("the schema declares all three, so zod does not strip them", () => {
    const parsed = SeedConnectionSchema.safeParse({
      ...seed,
      masterName: "mymaster",
      sentinelNodes: "s1:26379, s2:26379",
      sentinelPassword: "pw",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.masterName).toBe("mymaster");
    expect(parsed.data?.sentinelNodes).toBe("s1:26379, s2:26379");
    expect(parsed.data?.sentinelPassword).toBe("pw");
  });

  test("a seed that names none leaves all three absent", () => {
    const parsed = SeedConnectionSchema.safeParse(seed);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.masterName).toBeUndefined();
    expect(parsed.data?.sentinelNodes).toBeUndefined();
    expect(parsed.data?.sentinelPassword).toBeUndefined();
  });

  test("the role filter copies all three onto the managed connection, and a seed without them stays without them", () => {
    const [managed] = filterByRoles(
      [
        {
          ...seed,
          masterName: "mymaster",
          sentinelNodes: "s1:26379",
          sentinelPassword: "pw",
        },
      ],
      ["user"],
    );
    expect(managed.masterName).toBe("mymaster");
    expect(managed.sentinelNodes).toBe("s1:26379");
    expect(managed.sentinelPassword).toBe("pw");
    const [bare] = filterByRoles([seed], ["user"]);
    expect(bare.masterName).toBeUndefined();
    expect(bare.sentinelNodes).toBeUndefined();
    expect(bare.sentinelPassword).toBeUndefined();
  });

  test("a whole-value ${VAR} reference resolves in all three, as an address and a credential a deployment keeps out of the seed", () => {
    process.env.SENTINEL_FIELD_TEST = "resolved";
    const resolved = resolveConnectionCredentials({
      ...seed,
      masterName: "${SENTINEL_FIELD_TEST}",
      sentinelNodes: "${SENTINEL_FIELD_TEST}",
      sentinelPassword: "${SENTINEL_FIELD_TEST}",
    });
    expect(resolved.masterName).toBe("resolved");
    expect(resolved.sentinelNodes).toBe("resolved");
    expect(resolved.sentinelPassword).toBe("resolved");
  });

  test("a ${vault:...} reference resolves through the injected transport, as the other resolvable fields are", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = ["ro", "ot"].join("");
    const paths: string[] = [];
    const resolved = await resolveVaultCredentials(
      { ...seed, sentinelPassword: "${vault:secret/data/redis#sentinelPassword}" },
      {
        fetch: (async (input: RequestInfo | URL) => {
          paths.push(new URL(String(input)).pathname);
          return new Response(JSON.stringify({ data: { data: { sentinelPassword: "pw" } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
      },
    );
    expect(resolved.sentinelPassword).toBe("pw");
    expect(paths).toEqual(["/v1/secret/data/redis"]);
  });

  test("an undefined variable names the field, so a literal reference is never sent as a master name", () => {
    const error = thrownBy(() => resolveConnectionCredentials({ ...seed, masterName: "${SENTINEL_FIELD_TEST}" }));
    expect(error).toBeInstanceOf(UndefinedSeedVariableError);
    expect(error).toMatchObject({
      variable: "SENTINEL_FIELD_TEST",
      connectionId: "sentinel-seed",
      field: "masterName",
    });
  });
});

describe("classification and identity of the Sentinel fields", () => {
  test("the sentinels' password is a secret; the master name and the node list are addresses", () => {
    expect(CONNECTION_FIELDS.masterName).toBe("public");
    expect(CONNECTION_FIELDS.sentinelNodes).toBe("public");
    expect(CONNECTION_FIELDS.sentinelPassword).toBe("secret");
  });

  test("a copy differing in any one of the three does not resolve to the same connection", () => {
    const plain = connectionResolutionKey(base);
    for (const field of ["masterName", "sentinelNodes", "sentinelPassword"] as const) {
      expect(connectionResolutionKey({ ...base, [field]: "one" })).not.toBe(plain);
      expect(connectionResolutionKey({ ...base, [field]: "one" })).not.toBe(
        connectionResolutionKey({ ...base, [field]: "two" }),
      );
    }
  });

  test("the master group and the node list pick the server: they move the provider cache key with the fingerprint", async () => {
    // The fingerprint itself is pinned in tests/integration/db/redis-provider.test.ts, where the
    // provider lives; this file pins the LAYERS the provider cannot see, so the cache key and
    // the identity below are held to the same rule as the digest there.
    const plain = await providerCacheKey(base);
    for (const field of ["masterName", "sentinelNodes", "sentinelPassword"] as const) {
      expect(await providerCacheKey({ ...base, [field]: "one" })).not.toBe(plain);
      expect(await providerCacheKey({ ...base, [field]: "one" })).not.toBe(
        await providerCacheKey({ ...base, [field]: "two" }),
      );
    }
    expect(await providerCacheKey({ ...base, masterName: "", sentinelNodes: "", sentinelPassword: "" })).toBe(plain);
  });

  test("the agent identity moves with the two address fields, and the password never moves it", () => {
    const plain = connectionIdentity(base);
    expect(connectionIdentity(sentinel)).not.toBe(plain);
    expect(connectionIdentity({ ...sentinel, masterName: "othermaster" })).not.toBe(connectionIdentity(sentinel));
    expect(connectionIdentity({ ...sentinel, sentinelNodes: "s3:26379" })).not.toBe(connectionIdentity(sentinel));
    // Rotating a credential changes who may reach the catalog, never which catalog it is.
    expect(connectionIdentity({ ...sentinel, sentinelPassword: "other" })).toBe(connectionIdentity(sentinel));
    expect(connectionIdentity({ ...base, masterName: "", sentinelNodes: "" })).toBe(plain);
  });
});
