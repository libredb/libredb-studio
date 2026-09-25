import { describe, it, expect } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { SeedConnectionSchema, SeedConfigSchema, SeedDefaultsSchema } from "@/lib/seed/types";

describe("SeedConnectionSchema", () => {
  const validConn = {
    id: "test-pg",
    name: "Test PG",
    type: "postgres",
    host: "localhost",
    port: 5432,
    roles: ["admin"],
  };

  it("accepts a valid connection", () => {
    const result = SeedConnectionSchema.safeParse(validConn);
    expect(result.success).toBe(true);
  });

  /**
   * The silent half of the round-trip (#765). Unlike the three
   * `Record<keyof DatabaseConnection, ...>` maps, a zod object STRIPS a key it does not
   * declare, so a seed file setting this on an owner holding tens of thousands of objects
   * would validate, lose the field, and scan the catalog anyway with nothing to show for
   * it. Nothing fails at compile time here, so it is pinned at run time.
   */
  it("carries a connection's no-scan choice through validation", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, skipObjectScan: true });
    expect(result.success).toBe(true);
    expect(result.data?.skipObjectScan).toBe(true);
  });

  it("leaves the no-scan choice absent when the seed does not make one", () => {
    const result = SeedConnectionSchema.safeParse(validConn);
    expect(result.success).toBe(true);
    expect(result.data?.skipObjectScan).toBeUndefined();
  });

  it("rejects invalid id format (uppercase)", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, id: "INVALID" });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty roles array", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: [] });
    expect(result.success).toBe(false);
  });

  it("accepts wildcard role", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ["*"] });
    expect(result.success).toBe(true);
  });

  it("rejects unknown roles like data-team", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ["data-team"] });
    expect(result.success).toBe(false);
  });

  it("accepts combined admin and user roles", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ["admin", "user"] });
    expect(result.success).toBe(true);
  });

  it("rejects invalid port range", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, port: 99999 });
    expect(result.success).toBe(false);
  });

  it("accepts valid color hex", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, color: "#10B981" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid color format", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, color: "red" });
    expect(result.success).toBe(false);
  });

  it("rejects a database type outside the DatabaseType union", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, type: "clickhous" });
    expect(result.success).toBe(false);
  });

  it("accepts every valid database type", () => {
    const allTypes = [
      "postgres",
      "mysql",
      "sqlite",
      "mongodb",
      "redis",
      "oracle",
      "mssql",
      "libredb",
      "couchbase",
      "clickhouse",
      "druid",
      "trino",
      "cassandra",
    ];
    for (const type of allTypes) {
      const result = SeedConnectionSchema.safeParse({ ...validConn, type });
      expect(result.success).toBe(true);
    }
  });

  /**
   * The hand-kept enum held to the registry it has to follow (#1085). `SeedDatabaseType` is a zod
   * VALUE, so an id missing from it is no compile error: a seed file naming an engine the product
   * ships is refused at startup with "invalid enum value". Driven from `SHIPPED_DATABASE_TYPES`,
   * so the next type-id fails here the day it lands rather than on somebody's deployment.
   */
  it("accepts every type-id the product ships", () => {
    const refused = SHIPPED_DATABASE_TYPES.filter(
      (type) => !SeedConnectionSchema.safeParse({ ...validConn, type }).success,
    );
    // Vacuity, by name: an empty registry would refuse nothing and pass.
    expect(SHIPPED_DATABASE_TYPES.length).toBeGreaterThan(0);
    expect(refused).toEqual([]);
  });
});

describe("SeedConfigSchema", () => {
  it("accepts valid config with version 1", () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [{ id: "a", name: "A", type: "postgres", host: "h", roles: ["*"] }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects version 2", () => {
    const result = SeedConfigSchema.safeParse({
      version: "2",
      connections: [{ id: "a", name: "A", type: "postgres", host: "h", roles: ["*"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate connection IDs", () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [
        { id: "dup", name: "A", type: "postgres", host: "h", roles: ["*"] },
        { id: "dup", name: "B", type: "mysql", host: "h", roles: ["*"] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty connections array", () => {
    const result = SeedConfigSchema.safeParse({ version: "1", connections: [] });
    expect(result.success).toBe(false);
  });
});

describe("SeedDefaultsSchema", () => {
  it("accepts valid ssl config with mode require", () => {
    const result = SeedDefaultsSchema.safeParse({
      ssl: { mode: "require", rejectUnauthorized: true },
    });
    expect(result.success).toBe(true);
  });

  // D26: SSLMode gained `verify-system`, and this zod enum is a VALUE kept in step by hand -
  // a mode missing here is not a compile error, it is a seed file the server rejects for a
  // mode the product supports.
  it("accepts ssl mode verify-system", () => {
    const result = SeedDefaultsSchema.safeParse({ ssl: { mode: "verify-system" } });
    expect(result.success).toBe(true);
  });

  it("rejects ssl mode prefer (not in SSLMode type)", () => {
    const result = SeedDefaultsSchema.safeParse({
      ssl: { mode: "prefer" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid environment", () => {
    const result = SeedDefaultsSchema.safeParse({ environment: "unknown" });
    expect(result.success).toBe(false);
  });
});

describe("SeedConnectionSchema: MongoDB's authSource", () => {
  // A seeded MongoDB connection whose users live in `admin` is the ordinary
  // deployment. Without this key the descriptor could not say so, and the managed
  // connection reported a credentials error.
  it("accepts a seeded connection that names its auth database", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "shop",
      name: "Shop",
      type: "mongodb",
      host: "mongo.internal",
      port: 27017,
      database: "shop",
      user: "app",
      password: "s3cret",
      authSource: "admin",
      roles: ["*"],
    });

    expect(result.success).toBe(true);
  });

  it("rejects an auth database that is not a string", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "shop",
      name: "Shop",
      type: "mongodb",
      host: "mongo.internal",
      authSource: 1,
      roles: ["*"],
    });

    expect(result.success).toBe(false);
  });
});

describe("SeedConnectionSchema: Cassandra's localDataCenter", () => {
  // The driver refuses to connect without it, so a seeded Cassandra connection that
  // could not carry it would be a managed connection nobody can open. It is optional
  // in the SCHEMA - every other engine has no use for it - and required by the
  // provider, which is where the refusal belongs.
  it("accepts a seeded connection that names its data centre", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "ring",
      name: "Ring",
      type: "cassandra",
      host: "cassandra.internal",
      port: 9042,
      database: "probe",
      localDataCenter: "datacenter1",
      roles: ["*"],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a data centre that is not a string", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "ring",
      name: "Ring",
      type: "cassandra",
      host: "cassandra.internal",
      localDataCenter: 1,
      roles: ["*"],
    });

    expect(result.success).toBe(false);
  });
});

describe("SeedConnectionSchema: Elasticsearch's API key pair", () => {
  it("accepts a seeded Elasticsearch connection that carries the pair", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "logs",
      name: "Logs",
      type: "elasticsearch",
      host: "es.internal",
      port: 9200,
      apiKeyId: "seed-key-id",
      apiKeySecret: "seed-key-secret",
      roles: ["*"],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apiKeyId).toBe("seed-key-id");
      expect(result.data.apiKeySecret).toBe("seed-key-secret");
    }
  });

  it("rejects the pair on OpenSearch rather than stripping it", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "logs",
      name: "Logs",
      type: "opensearch",
      host: "os.internal",
      port: 9200,
      apiKeyId: "seed-key-id",
      apiKeySecret: "seed-key-secret",
      roles: ["*"],
    });

    expect(result.success).toBe(false);
  });
});

describe("SeedConnectionSchema: Trino's schema", () => {
  it("accepts a seeded connection that names its session schema", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "memory",
      name: "Shop",
      type: "trino",
      host: "trino.internal",
      port: 8080,
      database: "memory",
      user: "app",
      schema: "default",
      roles: ["*"],
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.schema).toBe("default");
  });

  it("rejects a session schema that is not a string", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "memory",
      name: "Shop",
      type: "trino",
      host: "trino.internal",
      schema: 1,
      roles: ["*"],
    });

    expect(result.success).toBe(false);
  });
});

describe("SeedConnectionSchema: Kafka's SASL mechanism", () => {
  const kafka = {
    id: "events",
    name: "Events",
    type: "kafka",
    host: "broker.internal",
    port: 9092,
    user: "reader",
    password: "reader-password",
    ssl: { mode: "verify-full" },
    roles: ["*"],
  };

  /**
   * The silent half zod has (#765): an undeclared key is STRIPPED, so a seeded SCRAM connection
   * would validate, lose its mechanism, and reach the provider as a user and password with no
   * mechanism to send them by. Nothing fails at compile time here, so it is pinned at run time.
   */
  it.each(["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"])("carries the %s mechanism through validation", (mechanism) => {
    const result = SeedConnectionSchema.safeParse({ ...kafka, saslMechanism: mechanism });

    expect(result.success).toBe(true);
    expect(result.data?.saslMechanism).toBe(mechanism);
  });

  it("leaves the mechanism absent when the seed names none", () => {
    const result = SeedConnectionSchema.safeParse({ ...kafka, user: undefined, password: undefined });

    expect(result.success).toBe(true);
    expect(result.data?.saslMechanism).toBeUndefined();
  });

  it.each([
    ["a mechanism the provider does not implement", "OAUTHBEARER"],
    ["a mechanism spelled in the wrong case", "scram-sha-512"],
    ["an empty mechanism", ""],
  ])("rejects %s, naming the field", (_label, mechanism) => {
    const result = SeedConnectionSchema.safeParse({ ...kafka, saslMechanism: mechanism });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["saslMechanism"]);
  });

  it("rejects an environment reference, because the field takes a literal mechanism name", () => {
    // A mechanism names no credential and no address, so it is not one of the fields a `${ENV}`
    // or `${vault:...}` reference is resolved in, and the file is validated before anything is.
    const result = SeedConnectionSchema.safeParse({ ...kafka, saslMechanism: "${KAFKA_MECHANISM}" });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["saslMechanism"]);
  });
});
