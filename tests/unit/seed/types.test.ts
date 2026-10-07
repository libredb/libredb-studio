import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  CONNECTION_STRING_ACCEPTED,
  MCP_EXPOSABLE,
  READ_ONLY_ENFORCED,
  SHIPPED_DATABASE_TYPES,
} from "@/lib/db/compatibility";
import { CREDENTIAL_WARNINGS } from "@/lib/db/credential-warnings";
import { refuseMcpWhereNotOffered, SeedConnectionSchema, SeedConfigSchema, SeedDefaultsSchema } from "@/lib/seed/types";

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

  /**
   * The MCP opt-in (#246), pinned for the reason the no-scan choice is: zod strips an undeclared
   * key, so without the field a seed file's opt-in would validate and vanish.
   */
  it("carries a connection's MCP opt-in through validation", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, mcp: true });
    expect(result.success).toBe(true);
    expect(result.data?.mcp).toBe(true);
  });

  it("leaves the MCP opt-in absent when the seed does not make one", () => {
    expect(SeedConnectionSchema.safeParse(validConn).data?.mcp).toBeUndefined();
  });

  it("refuses an MCP opt-in that is not a boolean", () => {
    expect(SeedConnectionSchema.safeParse({ ...validConn, mcp: "yes" }).success).toBe(false);
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
      "db2",
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

describe("SeedDefaultsSchema and the MCP opt-in", () => {
  it("refuses mcp in defaults, naming the per-connection rule, because a default would opt in every later connection", () => {
    const result = SeedDefaultsSchema.safeParse({ managed: true, mcp: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "mcp is set per connection and never in defaults: add mcp: true to each seed connection an MCP client may use",
    ]);
  });

  it("accepts defaults without it", () => {
    expect(SeedDefaultsSchema.safeParse({ managed: true }).success).toBe(true);
  });
});

/**
 * The MCP opt-in on an engine MCP is not offered for (#1089): refused at load, read from
 * `MCP_EXPOSABLE` and never from a type-id. The rule is pinned here through `refuseMcpWhereNotOffered`
 * handed a copy of the record that answers false for another shipped type, the way `offersReadOnlyToggle`
 * is handed its engine's answer, so no case depends on which engine the record refuses; etcd, the one
 * shipped engine it refuses, is pinned through the wired `SeedConfigSchema` in the describe "SeedConfigSchema:
 * MCP is not offered for etcd (#1089 E12)" below.
 */
describe("SeedConnectionSchema: the MCP opt-in where MCP is not offered (#1089)", () => {
  const connection = { id: "cluster", name: "Cluster", host: "cluster.internal", roles: ["*"] };
  const notOffered = (type: string) =>
    `mcp is not offered for ${type}: the product does not expose this engine to MCP clients. Remove mcp from this connection.`;
  const refusingOnly = (type: "kafka" | "redis") =>
    SeedConnectionSchema.superRefine(refuseMcpWhereNotOffered({ ...MCP_EXPOSABLE, [type]: false }));

  it("accepts mcp: true on every shipped engine the record offers MCP for", () => {
    const offered = SHIPPED_DATABASE_TYPES.filter((type) => MCP_EXPOSABLE[type]);
    // Vacuity, by name: an empty population would refuse nothing and pass.
    expect(offered).toContain("postgres");
    const refused = offered.filter(
      (type) => SeedConnectionSchema.safeParse({ ...connection, type, mcp: true }).data?.mcp !== true,
    );
    expect(refused).toEqual([]);
  });

  it.each(["kafka", "redis"] as const)(
    "refuses mcp: true on %s where the record answers false, naming the type and the field",
    (type) => {
      const result = refusingOnly(type).safeParse({ ...connection, type, mcp: true });
      expect(result.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
        ["mcp", notOffered(type)],
      ]);
    },
  );

  it("accepts mcp: false, and no mcp at all, on an engine the record answers false for", () => {
    expect(refusingOnly("kafka").safeParse({ ...connection, type: "kafka", mcp: false }).success).toBe(true);
    expect(refusingOnly("kafka").safeParse({ ...connection, type: "kafka" }).success).toBe(true);
  });

  it("refuses only the engine the record answers false for", () => {
    expect(refusingOnly("kafka").safeParse({ ...connection, type: "postgres", mcp: true }).success).toBe(true);
  });
});

describe("SeedConnectionSchema: Db2's consent to a cleartext password (#786)", () => {
  const db2 = {
    id: "warehouse",
    name: "Warehouse",
    type: "db2",
    host: "db2.internal",
    port: 50000,
    database: "TESTDB",
    user: "db2inst1",
    password: "secret",
    roles: ["*"],
  };

  // zod strips an undeclared key, so the consent would validate and vanish, and the provider would
  // then refuse a connection whose seed file did set it.
  it("carries the consent through validation", () => {
    const result = SeedConnectionSchema.safeParse({ ...db2, allowInsecureAuth: true });

    expect(result.success).toBe(true);
    expect(result.data?.allowInsecureAuth).toBe(true);
  });

  it("rejects a consent that is not a boolean, naming the field", () => {
    const result = SeedConnectionSchema.safeParse({ ...db2, allowInsecureAuth: "yes" });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["allowInsecureAuth"]);
  });

  // The schema has no type gate on this field: `db2` is only a valid seed to carry it.
  it("dataServers survives parsing (zod strips an undeclared key)", () => {
    const result = SeedConnectionSchema.safeParse({ ...db2, dataServers: "a.internal:6648" });

    expect(result.success).toBe(true);
    expect(result.data?.dataServers).toBe("a.internal:6648");
  });

  it("rejects a dataServers that is not a string, naming the field", () => {
    const result = SeedConnectionSchema.safeParse({ ...db2, dataServers: 6648 });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["dataServers"]]);
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

/**
 * The read-only mode (#1089). Declared for the reason skipObjectScan is (zod strips an undeclared
 * key, and a seed file's mode would validate and vanish, leaving a connection that writes), accepted
 * only on an engine whose provider enforces it, never a reference, never a default, and only on a
 * managed seed.
 */
describe("SeedConnectionSchema: the read-only mode (#1089)", () => {
  const validConn = {
    id: "test-pg",
    name: "Test PG",
    type: "postgres",
    host: "localhost",
    port: 5432,
    roles: ["admin"],
  };

  /** The load's refusal of `readOnly: true` on an engine whose provider does not enforce it. */
  const unenforced = (type: string) =>
    `readOnly is not offered for ${type}: its provider does not enforce a read-only mode, so the connection would be listed as read-only and still write. Remove readOnly from this connection, or connect with a database role that cannot write.`;

  it("carries readOnly: false through validation", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, readOnly: false });
    expect(result.success).toBe(true);
    expect(result.data?.readOnly).toBe(false);
  });

  it("leaves the mode absent when the seed does not set it", () => {
    const result = SeedConnectionSchema.safeParse(validConn);
    expect(result.success).toBe(true);
    expect(result.data?.readOnly).toBeUndefined();
  });

  it("refuses readOnly: true on every engine whose provider does not enforce it, naming the type and the field", () => {
    const refusing = SHIPPED_DATABASE_TYPES.filter((type) => !READ_ONLY_ENFORCED[type]);
    // Vacuity, by name: an empty population would refuse nothing and pass.
    expect(refusing).toContain("postgres");
    for (const type of refusing) {
      const result = SeedConnectionSchema.safeParse({ ...validConn, type, readOnly: true });
      expect({ type, issues: result.error?.issues.map((issue) => [issue.path.join("."), issue.message]) }).toEqual({
        type,
        issues: [["readOnly", unenforced(type)]],
      });
    }
  });

  it.each([
    ["the string true", "true"],
    ["an environment reference", "${SEED_READ_ONLY}"],
    ["null", null],
  ])(
    "refuses %s, naming the field, because the mode is a literal boolean that nothing resolves",
    (_label, readOnly) => {
      const result = SeedConnectionSchema.safeParse({ ...validConn, readOnly });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["readOnly"]);
    },
  );
});

describe("SeedDefaultsSchema and the read-only mode (#1089)", () => {
  it.each([true, false])("refuses readOnly: %p in defaults, naming the per-connection rule", (readOnly) => {
    // A default is merged only after the file is parsed, past the refusal of an engine whose provider
    // does not enforce the mode, so a merged default would reach engines that ignore it.
    const result = SeedDefaultsSchema.safeParse({ managed: true, readOnly });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      [
        "readOnly",
        "readOnly is set per connection and never in defaults: add readOnly: true to each seed connection that must refuse writes",
      ],
    ]);
  });
});

describe("SeedConfigSchema: a read-only seed must be managed (#1089)", () => {
  const connection = { id: "cluster", name: "Cluster", type: "postgres", host: "h", roles: ["*"] };
  const issuesOf = (config: unknown) => {
    const result = SeedConfigSchema.safeParse(config);
    return result.success ? [] : result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
  };
  const why =
    "an unmanaged seed is copied into the browser of every user its roles admit, with its password and TLS client key, and Duplicate turns that copy into a connection of the user's own whose readOnly can be cleared. Set managed: true on this connection, or remove readOnly.";
  const onConnection = `readOnly: true needs a managed connection, and this one has managed: false: ${why}`;
  const fromDefaults = `readOnly: true needs a managed connection, and this one has managed: false from defaults.managed: ${why}`;
  // This describe's engine, postgres, does not enforce the mode, so each read-only case also carries the
  // engine's own refusal first; the managed rule is the second issue, and its absence is the assertion where
  // the seed is managed. The same cases over etcd, which enforces it, are in the describe
  // "SeedConfigSchema: a read-only etcd seed (#1089 E6)" below.
  const enginePostgres =
    "readOnly is not offered for postgres: its provider does not enforce a read-only mode, so the connection would be listed as read-only and still write. Remove readOnly from this connection, or connect with a database role that cannot write.";

  it("refuses readOnly: true beside managed: false, naming both fields", () => {
    expect(issuesOf({ version: "1", connections: [{ ...connection, readOnly: true, managed: false }] })).toEqual([
      ["connections.0.readOnly", enginePostgres],
      ["connections.0.readOnly", onConnection],
    ]);
  });

  it("refuses it when managed: false comes from defaults.managed, and names defaults.managed", () => {
    expect(
      issuesOf({ version: "1", defaults: { managed: false }, connections: [{ ...connection, readOnly: true }] }),
    ).toEqual([
      ["connections.0.readOnly", enginePostgres],
      ["connections.0.readOnly", fromDefaults],
    ]);
  });

  it("takes the connection's own managed: true over defaults.managed: false, the precedence of the merge", () => {
    expect(
      issuesOf({
        version: "1",
        defaults: { managed: false },
        connections: [{ ...connection, readOnly: true, managed: true }],
      }),
    ).toEqual([["connections.0.readOnly", enginePostgres]]);
  });

  it("reads a seed that sets neither as managed, the default the mapper applies", () => {
    expect(issuesOf({ version: "1", connections: [{ ...connection, readOnly: true }] })).toEqual([
      ["connections.0.readOnly", enginePostgres],
    ]);
  });

  it("names the connection the refusal belongs to by its index", () => {
    expect(
      issuesOf({
        version: "1",
        connections: [
          { ...connection, id: "first", managed: false },
          { ...connection, id: "second", readOnly: true, managed: false },
        ],
      }),
    ).toEqual([
      ["connections.1.readOnly", enginePostgres],
      ["connections.1.readOnly", onConnection],
    ]);
  });

  it("asks nothing of a seed that is not read-only, managed or not", () => {
    expect(issuesOf({ version: "1", connections: [{ ...connection, managed: false }] })).toEqual([]);
    expect(issuesOf({ version: "1", connections: [{ ...connection, readOnly: false, managed: false }] })).toEqual([]);
  });
});

/**
 * The cases of the read-only rules that need an engine whose provider enforces the mode (#1089 E6), which no
 * engine did until etcd: each seed is refused by the managed rule alone, as one issue, or loads.
 */
describe("SeedConfigSchema: a read-only etcd seed (#1089 E6)", () => {
  const etcd = { id: "cluster", name: "Cluster", type: "etcd", host: "etcd.internal", roles: ["*"] };
  const issuesOf = (config: unknown) => {
    const result = SeedConfigSchema.safeParse(config);
    return result.success ? [] : result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
  };
  const why =
    "an unmanaged seed is copied into the browser of every user its roles admit, with its password and TLS client key, and Duplicate turns that copy into a connection of the user's own whose readOnly can be cleared. Set managed: true on this connection, or remove readOnly.";

  it("refuses readOnly: true beside managed: false, as the one managed issue", () => {
    expect(issuesOf({ version: "1", connections: [{ ...etcd, readOnly: true, managed: false }] })).toEqual([
      ["connections.0.readOnly", `readOnly: true needs a managed connection, and this one has managed: false: ${why}`],
    ]);
  });

  it("refuses it when managed: false comes from defaults.managed, naming defaults.managed", () => {
    expect(
      issuesOf({ version: "1", defaults: { managed: false }, connections: [{ ...etcd, readOnly: true }] }),
    ).toEqual([
      [
        "connections.0.readOnly",
        `readOnly: true needs a managed connection, and this one has managed: false from defaults.managed: ${why}`,
      ],
    ]);
  });

  it("loads readOnly: true with managed: true over defaults.managed: false, and with neither set", () => {
    expect(
      issuesOf({
        version: "1",
        defaults: { managed: false },
        connections: [{ ...etcd, readOnly: true, managed: true }],
      }),
    ).toEqual([]);
    expect(issuesOf({ version: "1", connections: [{ ...etcd, readOnly: true }] })).toEqual([]);
  });

  it("refuses a string readOnly on an etcd seed, naming the field", () => {
    const result = SeedConnectionSchema.safeParse({ ...etcd, readOnly: "true" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["readOnly"]);
  });

  it("carries readOnly: true on an etcd seed through validation", () => {
    const result = SeedConnectionSchema.safeParse({ ...etcd, readOnly: true });
    expect(result.success).toBe(true);
    expect(result.data?.readOnly).toBe(true);
  });
});

describe("SeedConfigSchema: MCP is not offered for etcd (#1089 E12)", () => {
  const etcd = { id: "cluster", name: "Cluster", type: "etcd", host: "etcd.internal", roles: ["*"] };

  it("refuses an etcd seed with mcp: true, with an issue on mcp that names etcd", () => {
    const result = SeedConfigSchema.safeParse({ version: "1", connections: [{ ...etcd, mcp: true }] });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues.map((issue) => issue.path.join("."))).toEqual(["connections.0.mcp"]);
    expect(issues[0]?.message).toContain("etcd");
    expect(issues[0]?.message).toContain("MCP");
  });

  it("parses an etcd seed that says nothing of mcp, and one with mcp: false", () => {
    expect(SeedConfigSchema.safeParse({ version: "1", connections: [etcd] }).success).toBe(true);
    expect(SeedConfigSchema.safeParse({ version: "1", connections: [{ ...etcd, mcp: false }] }).success).toBe(true);
  });
});

describe("SeedConnectionSchema: an oxia seed (SB2-10, SB3-5.6)", () => {
  const oxia = { id: "metadata", name: "Metadata", type: "oxia", host: "oxia.internal", port: 6648, roles: ["*"] };

  it("accepts the oxia type", () => {
    expect(SeedConnectionSchema.safeParse(oxia).success).toBe(true);
  });

  it("refuses an oxia seed with mcp: true, with the issue at mcp naming oxia", () => {
    const result = SeedConfigSchema.safeParse({ version: "1", connections: [{ ...oxia, mcp: true }] });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues.map((issue) => issue.path)).toEqual([["connections", 0, "mcp"]]);
    expect(issues[0]?.message).toBe(
      "mcp is not offered for oxia: the product does not expose this engine to MCP clients. Remove mcp from this connection.",
    );
  });

  it("accepts readOnly: true on an oxia seed, with no token", () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [{ ...oxia, readOnly: true, managed: true }],
    });
    expect(result.success).toBe(true);
  });
});

describe("SeedConnectionSchema: a milvus seed (vector-family spec 5.2)", () => {
  const milvus = { id: "vectors", name: "Vectors", type: "milvus", host: "milvus.internal", roles: ["*"] };

  it("accepts the milvus type", () => {
    expect(SeedConnectionSchema.safeParse(milvus).success).toBe(true);
  });

  it("loads a managed read-only milvus seed with a credential of its own", () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [
        { ...milvus, user: "reader", password: "${MILVUS_READER_PASSWORD}", readOnly: true, managed: true },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("loads a milvus seed with mcp: true, since MCP is offered for Milvus (vector-family E17)", () => {
    expect(SeedConfigSchema.safeParse({ version: "1", connections: [{ ...milvus, mcp: true }] }).success).toBe(true);
  });
});

describe("SeedConnectionSchema: a qdrant seed", () => {
  const qdrant = { id: "vectors", name: "Vectors", type: "qdrant", host: "qdrant.internal", roles: ["*"] };

  it("accepts the qdrant type, with no user and no database", () => {
    expect(SeedConnectionSchema.safeParse(qdrant).success).toBe(true);
  });

  it("loads a managed read-only qdrant seed holding a key reference", () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [{ ...qdrant, password: "${QDRANT_READ_ONLY_KEY}", readOnly: true, managed: true }],
    });
    expect(result.success).toBe(true);
  });

  it("loads a qdrant seed with mcp: true, since MCP is offered for Qdrant (vector-family spec 4.4)", () => {
    expect(SeedConfigSchema.safeParse({ version: "1", connections: [{ ...qdrant, mcp: true }] }).success).toBe(true);
  });
});

// The same five cases for each InfluxDB type: the type loads, a managed read-only seed with a secret reference
// loads, a read-only seed with no secret is refused with the type's no-secret sentence, and mcp and
// allowInsecureAuth both load.
for (const { type, secret } of [
  { type: "influxdb", secret: "${INFLUX_READER_PASSWORD}" },
  { type: "influxdb3", secret: "${INFLUXDB3_TOKEN}" },
] as const) {
  describe(`SeedConnectionSchema: an ${type} seed`, () => {
    const seed = { id: "metrics", name: "Metrics", type, host: "influx.internal", roles: ["*"] };

    it(`accepts the ${type} type`, () => {
      expect(SeedConnectionSchema.safeParse(seed).success).toBe(true);
    });

    it(`loads a managed read-only ${type} seed holding a secret reference`, () => {
      const result = SeedConfigSchema.safeParse({
        version: "1",
        connections: [{ ...seed, user: "reader", password: secret, readOnly: true, managed: true }],
      });
      expect(result.success).toBe(true);
    });

    it(`refuses a read-only ${type} seed with no secret, naming the no-secret warning`, () => {
      const result = SeedConfigSchema.safeParse({
        version: "1",
        connections: [{ ...seed, readOnly: true, managed: true }],
      });
      expect(result.success).toBe(false);
      const issues = result.error?.issues ?? [];
      expect(issues.map((issue) => issue.path.join("."))).toEqual(["connections.0.password"]);
      const warning = CREDENTIAL_WARNINGS[type]?.find((entry) => entry.kind === "no-secret");
      expect(warning).toBeDefined();
      expect(issues[0]?.message).toContain(warning?.message ?? "");
    });

    it(`loads an ${type} seed with mcp: true`, () => {
      expect(SeedConfigSchema.safeParse({ version: "1", connections: [{ ...seed, mcp: true }] }).success).toBe(true);
    });

    it(`loads an ${type} seed with allowInsecureAuth: true`, () => {
      const result = SeedConnectionSchema.safeParse({ ...seed, allowInsecureAuth: true });
      expect(result.success).toBe(true);
      expect(result.data?.allowInsecureAuth).toBe(true);
    });
  });
}

/**
 * A connection string the type's provider does not read (Spec A section 7, defect 2). Before this refusal the
 * schema accepted `connectionString` on every type, and a provider whose `supportsConnectionString` is false
 * dropped it in silence, so a seed listed a connection that opened somewhere else than its file said, or not
 * at all. Read from `CONNECTION_STRING_ACCEPTED`, never a type-id branch, and refused naming the connection
 * and the type, never the value.
 */
describe("SeedConnectionSchema: a connectionString the provider does not read (Spec A section 7)", () => {
  const seed = (type: string, connectionString = "scheme://db.internal:1/app") => ({
    id: `conn-${type}`,
    name: `Conn ${type}`,
    type,
    host: "db.internal",
    connectionString,
    roles: ["admin"],
  });

  const refusal = (type: string) =>
    `Seed connection "conn-${type}" sets connectionString, which the ${type} provider does not read: move the value into host, port, user, password and database`;

  const accepting = SHIPPED_DATABASE_TYPES.filter((type) => CONNECTION_STRING_ACCEPTED[type]);
  const refusing = SHIPPED_DATABASE_TYPES.filter((type) => !CONNECTION_STRING_ACCEPTED[type]);

  it("covers both populations, so neither loop below can pass empty", () => {
    expect(accepting).toContain("postgres");
    expect(accepting).toContain("mongodb");
    expect(accepting).toContain("sqlite");
    expect(refusing).toContain("redis");
    expect(refusing).toContain("mssql");
    expect(accepting.length + refusing.length).toBe(SHIPPED_DATABASE_TYPES.length);
  });

  it.each(accepting)("accepts a connectionString on %s, whose provider reads it", (type) => {
    const result = SeedConnectionSchema.safeParse(seed(type));
    expect(result.success).toBe(true);
    expect(result.data?.connectionString).toBe("scheme://db.internal:1/app");
  });

  it.each(refusing)("refuses a connectionString on %s, naming the connection and the type", (type) => {
    const result = SeedConnectionSchema.safeParse(seed(type));
    expect(result.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["connectionString", refusal(type)],
    ]);
  });

  // design 3.9: sqlite's flag says false, but its provider opens the string as the database file path, so a
  // seed that works on main keeps working.
  it("still loads a sqlite seed whose connectionString names its database file", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "app-file",
      name: "App file",
      type: "sqlite",
      connectionString: "file:/data/app.db",
      roles: ["admin"],
    });
    expect(result.success).toBe(true);
    expect(result.data?.connectionString).toBe("file:/data/app.db");
  });

  // design 3.9: mssql's flag says true, but its provider builds from the fields only, so before this refusal a
  // seed like this one loaded, passed validate(), and opened localhost instead of db.example.
  it("refuses an mssql seed whose connectionString the provider would ignore, naming the connection, mssql and the fix", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "orders-mssql",
      name: "Orders",
      type: "mssql",
      connectionString: "mssql://sa:pw@db.example:1433/app",
      roles: ["admin"],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      [
        "connectionString",
        'Seed connection "orders-mssql" sets connectionString, which the mssql provider does not read: move the value into host, port, user, password and database',
      ],
    ]);
  });

  it("never quotes the connection string in the refusal", () => {
    const result = SeedConnectionSchema.safeParse(seed("redis", "redis://:SEED-TYPES-CANARY-91c2@cache.internal:6379"));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain("SEED-TYPES-CANARY-91c2");
  });

  it("refuses an empty string and an unresolved reference the same way, because a set field is a set field", () => {
    for (const value of ["", "${REDIS_URL}"]) {
      const result = SeedConnectionSchema.safeParse(seed("redis", value));
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([refusal("redis")]);
    }
  });

  it("leaves a connection without connectionString alone on a type that refuses one", () => {
    const withoutString: Record<string, unknown> = seed("redis");
    delete withoutString.connectionString;
    expect(SeedConnectionSchema.safeParse(withoutString).success).toBe(true);
  });

  it("fails the whole file, naming the connection's index and field", () => {
    const result = SeedConfigSchema.safeParse({ version: "1", connections: [seed("postgres"), seed("redis")] });
    expect(result.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["connections.1.connectionString", refusal("redis")],
    ]);
  });

  it.each(["valid-config.yaml", "managed-secrets-config.yaml"])(
    "still loads %s, whose MongoDB connection carries a connectionString reference",
    (fixture) => {
      const file = path.resolve(import.meta.dir, "../../fixtures/seed-connections", fixture);
      const result = SeedConfigSchema.safeParse(parseYaml(readFileSync(file, "utf8")));
      expect(result.success).toBe(true);
    },
  );
});
