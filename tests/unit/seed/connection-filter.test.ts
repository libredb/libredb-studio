import { describe, it, expect } from "bun:test";
import { filterByRoles, mergeDefaults } from "@/lib/seed/connection-filter";
import type { SeedConnection, SeedDefaults } from "@/lib/seed/types";

const baseConn: SeedConnection = {
  id: "test",
  name: "Test",
  type: "postgres",
  host: "localhost",
  roles: ["*"],
};

describe("mergeDefaults", () => {
  it("applies defaults when connection fields are missing", () => {
    const defaults: SeedDefaults = { managed: true, environment: "production" };
    const merged = mergeDefaults({ ...baseConn }, defaults);
    expect(merged.managed).toBe(true);
    expect(merged.environment).toBe("production");
  });

  it("connection-level values override defaults", () => {
    const defaults: SeedDefaults = { managed: true, environment: "production" };
    const merged = mergeDefaults({ ...baseConn, managed: false, environment: "staging" }, defaults);
    expect(merged.managed).toBe(false);
    expect(merged.environment).toBe("staging");
  });

  it("returns connection unchanged when no defaults", () => {
    const merged = mergeDefaults({ ...baseConn, managed: true }, undefined);
    expect(merged.managed).toBe(true);
  });

  it("merges ssl defaults", () => {
    const defaults: SeedDefaults = { ssl: { mode: "require", rejectUnauthorized: true } };
    const merged = mergeDefaults({ ...baseConn }, defaults);
    expect(merged.ssl).toEqual({ mode: "require", rejectUnauthorized: true });
  });

  it("connection ssl overrides default ssl", () => {
    const defaults: SeedDefaults = { ssl: { mode: "require" } };
    const merged = mergeDefaults({ ...baseConn, ssl: { mode: "disable" } }, defaults);
    expect(merged.ssl?.mode).toBe("disable");
  });
});

describe("filterByRoles: the no-scan choice", () => {
  it("carries a seeded connection's no-scan choice through to the managed connection", () => {
    // The second silent half (#765): this mapper is a hand-written field list, so a field
    // the schema validates and the mapper forgets reaches the browser as `undefined` and
    // the connection scans the catalog the deployment asked it not to.
    const [managed] = filterByRoles([{ ...baseConn, skipObjectScan: true }], ["admin"]);
    expect(managed.skipObjectScan).toBe(true);
  });

  it("leaves it absent for a seed that does not ask for it", () => {
    const [managed] = filterByRoles([{ ...baseConn }], ["admin"]);
    expect(managed.skipObjectScan).toBeUndefined();
  });
});

describe("the MCP opt-in", () => {
  it("is carried through to the managed connection, because the mapper is a hand-written field list", () => {
    const [managed] = filterByRoles([{ ...baseConn, mcp: true }], ["admin"]);
    expect(managed.mcp).toBe(true);
  });

  it("stays absent for a seed that does not opt in", () => {
    const [managed] = filterByRoles([{ ...baseConn }], ["admin"]);
    expect(managed.mcp).toBeUndefined();
  });

  it("is never merged from defaults: absent when the connection omits it, true when it sets it", () => {
    const defaults: SeedDefaults = { managed: true, environment: "production" };
    expect(mergeDefaults({ ...baseConn }, defaults).mcp).toBeUndefined();
    expect(mergeDefaults({ ...baseConn, mcp: true }, defaults).mcp).toBe(true);
  });
});

describe("filterByRoles: engine-specific fields", () => {
  it("carries a Cassandra connection's data centre through to the managed connection", () => {
    // The one field `cassandra-driver` refuses to start without. Dropped here, a
    // seeded ring would be a connection the product lists and cannot open - which is
    // exactly what a hand-written mapping loses silently.
    const [managed] = filterByRoles(
      [{ ...baseConn, type: "cassandra", port: 9042, database: "probe", localDataCenter: "datacenter1" }],
      ["user"],
    );

    expect(managed.localDataCenter).toBe("datacenter1");
  });

  it("carries a MongoDB connection's auth database through to the managed connection", () => {
    // Dropped here, a seeded connection whose users live in `admin` authenticates
    // against the data database instead and reports a credentials error - the same
    // silent loss, in the mapping that fails no gate.
    const [managed] = filterByRoles(
      [{ ...baseConn, type: "mongodb", port: 27017, database: "shop", authSource: "admin" }],
      ["user"],
    );

    expect(managed.authSource).toBe("admin");
  });

  it("carries an Elasticsearch connection's API key pair through to the managed connection", () => {
    // Same silent-loss shape as authSource above (#708). Deleting either half from
    // the mapper left every suite green: the seed validated, the connection listed,
    // and the transport fell back to user/password on a key that works.
    const [managed] = filterByRoles(
      [
        {
          ...baseConn,
          type: "elasticsearch",
          port: 9200,
          apiKeyId: "seed-key-id",
          apiKeySecret: "seed-key-secret",
        },
      ],
      ["user"],
    );

    expect(managed.apiKeyId).toBe("seed-key-id");
    expect(managed.apiKeySecret).toBe("seed-key-secret");
  });

  it("refuses an API key pair on OpenSearch rather than projecting it", () => {
    expect(() =>
      filterByRoles(
        [
          {
            ...baseConn,
            type: "opensearch",
            port: 9200,
            apiKeyId: "seed-key-id",
            apiKeySecret: "seed-key-secret",
          },
        ],
        ["user"],
      ),
    ).toThrow(/Elasticsearch-only/);
  });
  it("carries a Trino connection's session schema through to the managed connection", () => {
    const [managed] = filterByRoles(
      [{ ...baseConn, type: "trino", port: 8080, database: "memory", schema: "default" }],
      ["user"],
    );

    expect(managed.schema).toBe("default");
  });

  it("carries a Kafka connection's SASL mechanism through to the managed connection", () => {
    // Dropped here, a seeded SCRAM connection would list with its user and password and no
    // mechanism, which the provider refuses as a credential with no mechanism to send it by.
    const [managed] = filterByRoles(
      [
        {
          ...baseConn,
          type: "kafka",
          port: 9092,
          user: "reader",
          password: "reader-password",
          saslMechanism: "SCRAM-SHA-512",
        },
      ],
      ["user"],
    );

    expect(managed.saslMechanism).toBe("SCRAM-SHA-512");
  });

  it("carries a Db2 connection's consent to a cleartext password through (#786)", () => {
    // Dropped here, the provider would refuse a seed whose file did set the consent.
    const [managed] = filterByRoles([{ ...baseConn, type: "db2", port: 50000, allowInsecureAuth: true }], ["user"]);
    const [none] = filterByRoles([{ ...baseConn, type: "db2", port: 50000 }], ["user"]);

    expect(managed.allowInsecureAuth).toBe(true);
    expect(none.allowInsecureAuth).toBeUndefined();
  });

  it("a seed's dataServers is copied onto the managed connection", () => {
    const result = filterByRoles([{ ...baseConn, dataServers: "a.internal:6648 b.internal:6648" }], ["user"]);
    const [none] = filterByRoles([{ ...baseConn }], ["user"]);

    expect(result).toHaveLength(1);
    expect(result[0].dataServers).toBe("a.internal:6648 b.internal:6648");
    expect(none.dataServers).toBeUndefined();
  });

  it("leaves the mechanism absent on a seeded connection that names none", () => {
    const [managed] = filterByRoles([{ ...baseConn, type: "kafka", port: 9092 }], ["user"]);

    expect(managed.saslMechanism).toBeUndefined();
  });
});

describe("filterByRoles", () => {
  it("includes connections with wildcard role", () => {
    const result = filterByRoles([{ ...baseConn, roles: ["*"] }], ["user"]);
    expect(result).toHaveLength(1);
  });

  it("includes connections matching user role", () => {
    const result = filterByRoles([{ ...baseConn, roles: ["admin"] }], ["admin"]);
    expect(result).toHaveLength(1);
  });

  it("excludes connections not matching user role", () => {
    const result = filterByRoles([{ ...baseConn, roles: ["admin"] }], ["user"]);
    expect(result).toHaveLength(0);
  });

  it("handles multi-role connections", () => {
    const result = filterByRoles([{ ...baseConn, roles: ["admin", "user"] }], ["user"]);
    expect(result).toHaveLength(1);
  });

  it("maps SeedConnection to ManagedConnection correctly", () => {
    const result = filterByRoles(
      [
        {
          ...baseConn,
          id: "my-pg",
          managed: true,
          color: "#FF0000",
          group: "Backend",
        },
      ],
      ["admin"],
    );
    expect(result[0].seedId).toBe("my-pg");
    expect(result[0].id).toBe("seed:my-pg");
    expect(result[0].managed).toBe(true);
    expect(result[0].color).toBe("#FF0000");
    expect(result[0].group).toBe("Backend");
    expect(result[0].createdAt).toBeInstanceOf(Date);
  });

  it("defaults managed to true when not specified", () => {
    const result = filterByRoles([{ ...baseConn }], ["admin"]);
    expect(result[0].managed).toBe(true);
  });

  it("returns empty array when no connections match", () => {
    const result = filterByRoles(
      [
        { ...baseConn, roles: ["admin"] },
        { ...baseConn, id: "other", roles: ["admin"] },
      ],
      ["user"],
    );
    expect(result).toHaveLength(0);
  });
});

describe("filterByRoles: the read-only mode (#1089)", () => {
  it("carries a seeded connection's mode through, because the mapper is a hand-written field list", () => {
    // The load refuses the mode on an engine that does not enforce it; this pins the copy alone.
    const [managed] = filterByRoles([{ ...baseConn, readOnly: true }], ["admin"]);
    expect(managed.readOnly).toBe(true);
  });

  it("leaves it absent for a seed that does not set it", () => {
    const [managed] = filterByRoles([{ ...baseConn }], ["admin"]);
    expect(managed.readOnly).toBeUndefined();
  });

  it("refuses a read-only seed built in memory as unmanaged, naming the seed and both fields", () => {
    expect(() => filterByRoles([{ ...baseConn, readOnly: true, managed: false }], ["admin"])).toThrow(
      'Seed connection "test" sets readOnly: true with managed: false.',
    );
  });

  it("refuses the pair once defaults.managed: false has been merged, the order the loader runs them in", () => {
    const merged = mergeDefaults({ ...baseConn, readOnly: true }, { managed: false });
    expect(() => filterByRoles([merged], ["admin"])).toThrow(
      'Seed connection "test" sets readOnly: true with managed: false.',
    );
  });
});
