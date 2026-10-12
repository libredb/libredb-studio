/**
 * The optional `amqpPort` connection field, end to end through every layer a field passes before a provider reads it:
 * the seed schema, the seed filter, the credential resolver, the storage classification, the seed-copy resolution key,
 * the server fingerprint, the provider cache key and the agent's connection identity. No engine reads the field yet,
 * so every case runs on a shipped type that ignores it: no layer below gates the field on the type.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connectionResolutionKey } from "@/hooks/use-connection-payload";
import { connectionIdentity } from "@/lib/agent/context-snapshot";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
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
  id: "broker",
  name: "Broker",
  type: "postgres",
  host: "mq.example",
  port: 15672,
  createdAt: new Date(0),
};
const seed: SeedConnection = { id: "amqp-seed", name: "Seed", type: "postgres", host: "mq.example", roles: ["*"] };

afterEach(() => {
  delete process.env.AMQP_PORT_FIELD_TEST;
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

describe("the seed layer keeps the AMQP port", () => {
  test("the schema declares it, so zod does not strip it", () => {
    const parsed = SeedConnectionSchema.safeParse({ ...seed, amqpPort: "5672" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.amqpPort).toBe("5672");
  });

  test("a seed that names none leaves it absent", () => {
    expect(SeedConnectionSchema.safeParse(seed).data?.amqpPort).toBeUndefined();
  });

  test("an unquoted YAML number is refused naming the field, never dropped in silence", () => {
    const parsed = SeedConnectionSchema.safeParse({ ...seed, amqpPort: 5672 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual(["amqpPort"]);
  });

  test("the role filter copies it onto the managed connection, and a seed without it stays without it", () => {
    const [managed] = filterByRoles([{ ...seed, amqpPort: "5671" }], ["user"]);
    expect(managed.amqpPort).toBe("5671");
    const [bare] = filterByRoles([seed], ["user"]);
    expect(bare.amqpPort).toBeUndefined();
  });

  test("a whole-value ${VAR} reference is resolved, as an address a deployment keeps out of the seed", () => {
    process.env.AMQP_PORT_FIELD_TEST = "5671";
    expect(resolveConnectionCredentials({ ...seed, amqpPort: "${AMQP_PORT_FIELD_TEST}" }).amqpPort).toBe("5671");
  });

  test("a ${vault:...} reference is resolved through the injected transport, as the other resolvable fields are", async () => {
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = ["ro", "ot"].join("");
    const paths: string[] = [];
    const resolved = await resolveVaultCredentials(
      { ...seed, amqpPort: "${vault:secret/data/broker#amqpPort}" },
      {
        fetch: (async (input: RequestInfo | URL) => {
          paths.push(new URL(String(input)).pathname);
          return new Response(JSON.stringify({ data: { data: { amqpPort: "5671" } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
      },
    );
    expect(resolved.amqpPort).toBe("5671");
    expect(paths).toEqual(["/v1/secret/data/broker"]);
  });

  test("an undefined variable names the field, so a literal reference is never sent as a port", () => {
    const error = thrownBy(() => resolveConnectionCredentials({ ...seed, amqpPort: "${AMQP_PORT_FIELD_TEST}" }));
    expect(error).toBeInstanceOf(UndefinedSeedVariableError);
    expect(error).toMatchObject({ variable: "AMQP_PORT_FIELD_TEST", connectionId: "amqp-seed", field: "amqpPort" });
  });
});

describe("classification and identity of the AMQP port", () => {
  test("it is public: a port is an address, never a credential", () => {
    expect(CONNECTION_FIELDS.amqpPort).toBe("public");
  });

  test("a copy differing only in the port does not resolve to the same connection", () => {
    const plain = connectionResolutionKey(base);
    expect(connectionResolutionKey({ ...base, amqpPort: "5672" })).not.toBe(plain);
    expect(connectionResolutionKey({ ...base, amqpPort: "5672" })).not.toBe(
      connectionResolutionKey({ ...base, amqpPort: "5671" }),
    );
  });

  test("the port picks the server: it moves the fingerprint, and absent and empty leave it where it was", async () => {
    const plain = await connectionFingerprint(base);
    expect(await connectionFingerprint({ ...base, amqpPort: "" })).toBe(plain);
    const one = await connectionFingerprint({ ...base, amqpPort: "5672" });
    expect(one).not.toBe(plain);
    expect(one).not.toBe(await connectionFingerprint({ ...base, amqpPort: "5671" }));
    // Tagged frames: an AMQP port whose text is another field's frame is still another server.
    expect(await connectionFingerprint({ ...base, amqpPort: "tlsServerName=a" })).not.toBe(
      await connectionFingerprint({ ...base, tlsServerName: "a" }),
    );
  });

  test("two connections differing only in the port get different provider cache keys", async () => {
    const plain = await providerCacheKey(base);
    expect(await providerCacheKey({ ...base, amqpPort: "5672" })).not.toBe(plain);
    expect(await providerCacheKey({ ...base, amqpPort: "5672" })).not.toBe(
      await providerCacheKey({ ...base, amqpPort: "5671" }),
    );
    expect(await providerCacheKey({ ...base, amqpPort: "" })).toBe(plain);
  });

  test("the agent identity moves with the port, and absent and empty leave it where it was", () => {
    const plain = connectionIdentity(base);
    expect(connectionIdentity({ ...base, amqpPort: "" })).toBe(plain);
    expect(connectionIdentity({ ...base, amqpPort: "5672" })).not.toBe(plain);
    expect(connectionIdentity({ ...base, amqpPort: "5672" })).not.toBe(
      connectionIdentity({ ...base, amqpPort: "5671" }),
    );
    // Pinned to the digest before the field existed, so a positional element that moves every identity fails here.
    expect(
      connectionIdentity({
        id: "a",
        name: "A",
        type: "postgres",
        host: "db",
        port: 5432,
        database: "d",
        createdAt: new Date(0),
      }),
    ).toBe("f6ebee7d2ea62e65e9c42cf0e62a23224ff8c3526fbf68b947b1f70712c8bfcb");
  });
});
