import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import { getManagedConnections, resetCache } from "@/lib/seed";
import { resetPlaintextWarnings } from "@/lib/seed/credential-resolver";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");

describe("seed pipeline integration", () => {
  beforeEach(() => {
    resetCache();
    resetPlaintextWarnings();
  });

  afterEach(() => {
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.TEST_PG_PASSWORD;
    delete process.env.TEST_MYSQL_PASSWORD;
    delete process.env.TEST_MONGO_URI;
    delete process.env.TEST_REDIS_PASSWORD;
    delete process.env.SEED_CACHE_TTL_MS;
    delete process.env.GOOD_PASSWORD;
    delete process.env.TEST_KAFKA_PASSWORD;
    delete process.env.TEST_KAFKA_MECHANISM;
  });

  it("full pipeline: load -> resolve -> filter (admin)", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.yaml");
    process.env.TEST_PG_PASSWORD = "pg-secret";
    process.env.TEST_MYSQL_PASSWORD = "mysql-secret";
    process.env.TEST_MONGO_URI = "mongodb://host/db";
    process.env.TEST_REDIS_PASSWORD = "redis-secret";

    const conns = await getManagedConnections(["admin"]);
    expect(conns).toHaveLength(4);
    expect(conns[0].password).toBe("pg-secret");
    expect(conns[0].seedId).toBe("test-postgres");
    expect(conns[0].id).toBe("seed:test-postgres");
  });

  it("full pipeline: load -> resolve -> filter (user)", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.yaml");
    process.env.TEST_PG_PASSWORD = "pg-secret";
    process.env.TEST_MYSQL_PASSWORD = "mysql-secret";
    process.env.TEST_MONGO_URI = "mongodb://host/db";
    process.env.TEST_REDIS_PASSWORD = "redis-secret";

    const conns = await getManagedConnections(["user"]);
    expect(conns).toHaveLength(2);
    expect(conns.map((c) => c.seedId)).toEqual(["test-mysql", "test-redis"]);
  });

  it("partial failure: one connection skipped, others work", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "mixed-credentials.yaml");
    process.env.GOOD_PASSWORD = "good-pass";

    const conns = await getManagedConnections(["admin"]);
    expect(conns).toHaveLength(2);
    expect(conns[0].password).toBe("good-pass");
    expect(conns[1].password).toBe("hardcoded_secret");
  });

  it("returns empty array when config file missing", async () => {
    process.env.SEED_CONFIG_PATH = "/nonexistent/path.yaml";
    const conns = await getManagedConnections(["admin"]);
    expect(conns).toHaveLength(0);
  });

  it("hot-reload: cache expires, new config loaded", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.yaml");
    process.env.SEED_CACHE_TTL_MS = "1";
    process.env.TEST_PG_PASSWORD = "pg-secret";
    process.env.TEST_MYSQL_PASSWORD = "mysql-secret";
    process.env.TEST_MONGO_URI = "mongodb://host/db";
    process.env.TEST_REDIS_PASSWORD = "redis-secret";

    const conns1 = await getManagedConnections(["admin"]);
    expect(conns1).toHaveLength(4);

    await new Promise((r) => setTimeout(r, 10));

    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "minimal-config.yaml");
    resetCache();

    const conns2 = await getManagedConnections(["admin"]);
    expect(conns2).toHaveLength(1);
    expect(conns2[0].seedId).toBe("minimal-pg");
  });

  it("defaults merge: global defaults applied to connections", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.yaml");
    process.env.TEST_PG_PASSWORD = "pg-secret";
    process.env.TEST_MYSQL_PASSWORD = "mysql-secret";
    process.env.TEST_MONGO_URI = "mongodb://host/db";
    process.env.TEST_REDIS_PASSWORD = "redis-secret";

    const conns = await getManagedConnections(["admin"]);
    const mysql = conns.find((c) => c.seedId === "test-mysql");
    expect(mysql?.managed).toBe(false);

    const redis = conns.find((c) => c.seedId === "test-redis");
    expect(redis?.managed).toBe(true);
    expect(redis?.environment).toBe("production");
  });

  it("a seeded Kafka connection's SASL mechanism reaches the listed connection", async () => {
    // Both halves of the round trip fail silently: zod strips a key the schema does not declare,
    // and the filter is a hand-written field list. The listed connection is where both show.
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "kafka-config.yaml");
    process.env.TEST_KAFKA_PASSWORD = "kafka-secret";

    const conns = await getManagedConnections(["admin"]);
    expect(conns).toHaveLength(1);
    expect(conns[0].type).toBe("kafka");
    expect(conns[0].saslMechanism).toBe("SCRAM-SHA-512");
    // The control: the credential beside it is resolved from the environment as before.
    expect(conns[0].password).toBe("kafka-secret");
  });

  it("a seeded mechanism written as an environment reference refuses the file, naming the field", async () => {
    // A mechanism names no credential and no address, so no reference is resolved in it, and the
    // file is validated before anything is resolved: the refusal names the field.
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "kafka-mechanism-reference.yaml");
    process.env.TEST_KAFKA_MECHANISM = "SCRAM-SHA-512";
    process.env.TEST_KAFKA_PASSWORD = "kafka-secret";

    await expect(getManagedConnections(["admin"])).rejects.toThrow(
      /^Invalid seed config: connections\.0\.saslMechanism: /,
    );
  });
});
