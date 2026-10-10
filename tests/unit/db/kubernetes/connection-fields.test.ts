/**
 * The three connection fields the Kubernetes provider adds (apiPath, namespaces, tlsServerName), end to end through
 * every layer a field passes before a provider reads it: the seed schema, the seed filter, the credential resolver,
 * the storage classification, the cache key, the server fingerprint and the agent's connection identity.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connectionIdentity } from "@/lib/agent/context-snapshot";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { providerCacheKey } from "@/lib/db/provider-cache-key";
import { filterByRoles } from "@/lib/seed/connection-filter";
import { resolveConnectionCredentials } from "@/lib/seed/credential-resolver";
import { SeedConnectionSchema, type SeedConnection } from "@/lib/seed/types";
import { CONNECTION_FIELDS } from "@/lib/storage/connection-secrets";
import type { DatabaseConnection } from "@/lib/types";

// The type is any shipped one: no layer below gates these fields on the type.
const base: DatabaseConnection = {
  id: "cluster",
  name: "Cluster",
  type: "postgres",
  host: "rancher.example",
  port: 443,
  createdAt: new Date(0),
};
const seed: SeedConnection = { id: "k", name: "K", type: "postgres", host: "rancher.example", roles: ["*"] };
const FIELDS = { apiPath: "/k8s/clusters/c-1", namespaces: "shop, web", tlsServerName: "kubernetes.default.svc" };

afterEach(() => {
  delete process.env.K8S_TEST_API_PATH;
  delete process.env.K8S_TEST_TLS_NAME;
});

describe("the seed layer keeps all three", () => {
  test("the schema declares them, so zod does not strip them", () => {
    const parsed = SeedConnectionSchema.safeParse({ ...seed, ...FIELDS });
    expect(parsed.success).toBe(true);
    expect([parsed.data?.apiPath, parsed.data?.namespaces, parsed.data?.tlsServerName]).toEqual([
      FIELDS.apiPath,
      FIELDS.namespaces,
      FIELDS.tlsServerName,
    ]);
  });

  test("a value that is not a string is refused, naming the field", () => {
    const parsed = SeedConnectionSchema.safeParse({ ...seed, apiPath: 7 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual(["apiPath"]);
  });

  test("the role filter copies them onto the managed connection", () => {
    const [managed] = filterByRoles([{ ...seed, ...FIELDS }], ["user"]);
    expect([managed.apiPath, managed.namespaces, managed.tlsServerName]).toEqual([
      FIELDS.apiPath,
      FIELDS.namespaces,
      FIELDS.tlsServerName,
    ]);
  });

  test("the API path and the TLS server name resolve ${VAR}; the namespace list is taken as written", () => {
    process.env.K8S_TEST_API_PATH = "/k8s/clusters/c-9";
    process.env.K8S_TEST_TLS_NAME = "api.internal";
    const resolved = resolveConnectionCredentials({
      ...seed,
      apiPath: "${K8S_TEST_API_PATH}",
      tlsServerName: "${K8S_TEST_TLS_NAME}",
      namespaces: "shop",
    });
    expect([resolved.apiPath, resolved.tlsServerName, resolved.namespaces]).toEqual([
      "/k8s/clusters/c-9",
      "api.internal",
      "shop",
    ]);
  });
});

describe("classification and identity", () => {
  test("all three are public: none is a credential", () => {
    expect([CONNECTION_FIELDS.apiPath, CONNECTION_FIELDS.namespaces, CONNECTION_FIELDS.tlsServerName]).toEqual([
      "public",
      "public",
      "public",
    ]);
  });

  test("the API path and the TLS server name pick the server; absent and empty leave the digest unchanged", async () => {
    const plain = await connectionFingerprint(base);
    expect(await connectionFingerprint({ ...base, apiPath: "" })).toBe(plain);
    expect(await connectionFingerprint({ ...base, tlsServerName: "" })).toBe(plain);
    const one = await connectionFingerprint({ ...base, apiPath: "/k8s/clusters/c-1" });
    expect(one).not.toBe(plain);
    expect(one).not.toBe(await connectionFingerprint({ ...base, apiPath: "/k8s/clusters/c-2" }));
    expect(await connectionFingerprint({ ...base, tlsServerName: "a.internal" })).not.toBe(plain);
    // Tagged frames: a path and a server name of the same text are two different servers.
    expect(await connectionFingerprint({ ...base, apiPath: "/x" })).not.toBe(
      await connectionFingerprint({ ...base, tlsServerName: "/x" }),
    );
    // The namespace list picks no server.
    expect(await connectionFingerprint({ ...base, namespaces: "shop" })).toBe(plain);
  });

  test("two connections differing only in apiPath, tlsServerName or namespaces get different cache keys", async () => {
    const plain = await providerCacheKey(base);
    expect(await providerCacheKey({ ...base, apiPath: "/k8s/clusters/c-1" })).not.toBe(plain);
    expect(await providerCacheKey({ ...base, tlsServerName: "a.internal" })).not.toBe(plain);
    expect(await providerCacheKey({ ...base, namespaces: "shop" })).not.toBe(
      await providerCacheKey({ ...base, namespaces: "web" }),
    );
  });

  test("the agent identity moves with the API path and the TLS server name, not with the namespace list", () => {
    const plain = connectionIdentity(base);
    expect(connectionIdentity({ ...base, apiPath: "/k8s/clusters/c-1" })).not.toBe(plain);
    expect(connectionIdentity({ ...base, tlsServerName: "a.internal" })).not.toBe(plain);
    expect(connectionIdentity({ ...base, namespaces: "shop" })).toBe(plain);
  });
});
