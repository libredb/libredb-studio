/**
 * The seed file a platform writes, as Studio reads it: the golden fixture Dokploy's renderer produces.
 *
 * Dokploy renders one seed file per Studio from its database rows and writes it as
 * `JSON.stringify(config, null, 2)` followed by one newline. Its renderer test writes exactly the
 * bytes of tests/fixtures/dokploy-golden-seed.json, and the same bytes are committed in Dokploy at
 * apps/dokploy/__test__/libredb-studio/fixtures/golden-seed.json. The two copies are kept identical
 * by hand: change one, change both, and change the sha256 below and in Dokploy's test with them.
 *
 * What the file pins on this side is what a renderer could get wrong without any error: a key the
 * schema does not declare, which zod strips; a default that merges differently; a type Studio does
 * not have (`mariadb`, `mongo`); a password character YAML would read as syntax; and the fields each
 * engine authenticates with. Credentials are literal on purpose, because a platform that rewrites
 * the file whenever a database changes cannot use `${ENV}` references, which are fixed for the
 * life of the container.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getManagedConnections, resetCache } from "@/lib/seed";
import { resetPlaintextWarnings } from "@/lib/seed/credential-resolver";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { SeedConfigSchema, type ManagedConnection } from "@/lib/seed/types";

const FIXTURE = path.resolve(import.meta.dir, "../../fixtures/dokploy-golden-seed.json");
const FIXTURE_SHA256 = "f50ecd19298a8abc460801d70b4efbbdfda9633ae84da650780b7ce14a759c31";
const RAW = readFileSync(FIXTURE, "utf8");

/** The seed ids in the file's own order, which Dokploy sorts by lowercased name and then by id. */
const SEED_IDS = [
  "dokploy-redis-ba2973db12d2",
  "dokploy-libsql-6af07a96089c",
  "dokploy-mongo-789b883f1772",
  "dokploy-mysql-c489a25fa2b7",
  "dokploy-postgres-f298d8acf10d",
  "dokploy-mariadb-474206101a77",
];

/** The fields that decide where a connection goes and as whom, with an absent field kept as undefined. */
function addressOf(conn: ManagedConnection | undefined) {
  return {
    type: conn?.type,
    host: conn?.host,
    port: conn?.port,
    database: conn?.database,
    user: conn?.user,
    password: conn?.password,
    authSource: conn?.authSource,
  };
}

describe("the golden seed file shared with Dokploy", () => {
  it("is byte for byte the file Dokploy's renderer writes", () => {
    expect(createHash("sha256").update(RAW).digest("hex")).toBe(FIXTURE_SHA256);
    // The renderer's serialization, which the hash alone would not explain to a reader.
    expect(RAW).toBe(`${JSON.stringify(JSON.parse(RAW), null, 2)}\n`);
  });

  it("validates against SeedConfigSchema with nothing stripped and nothing added", () => {
    const result = SeedConfigSchema.safeParse(JSON.parse(RAW));

    expect(result.error?.issues).toBeUndefined();
    // Deep equality, key order aside: a key the schema did not declare would be missing from the parse.
    expect(result.data).toStrictEqual(JSON.parse(RAW));
  });
});

describe("what Studio makes of the golden seed file", () => {
  beforeEach(() => {
    resetCache();
    resetPlaintextWarnings();
    process.env.SEED_CONFIG_PATH = FIXTURE;
    // Dokploy's Studio runs with both built-in samples off, and a sample path in a local .env would
    // otherwise append one to the list in a test process.
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    // A discovery export path in a local .env would add discovered connections between the file seeds and
    // the samples, so the export is off as well, as it is in a Studio Dokploy runs.
    delete process.env.SEED_DISCOVERY_PATH;
  });

  afterEach(() => {
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.LIBREDB_EMBEDDED_SAMPLE;
    delete process.env.SQLITE_EMBEDDED_SAMPLE;
    resetCache();
  });

  it("lists every connection under its seed: id, managed by the file's defaults and with TLS off", async () => {
    const listed = await getManagedConnections(["admin"]);

    expect(listed.map((conn) => conn.id)).toEqual(SEED_IDS.map((seedId) => `seed:${seedId}`));
    for (const conn of listed) {
      expect(conn.seedId).toBe(conn.id.slice("seed:".length));
      // Neither is set on a connection: both come from `defaults`, merged by mergeDefaults.
      expect(conn.managed).toBe(true);
      expect(conn.ssl).toEqual({ mode: "disable" });
      expect(conn.environment).toBe("production");
      expect(conn.group).toBe("Demo Shop / production");
      expect(conn.roles).toEqual(["*"]);
    }
  });

  it("lists the same six for the user role, because every one admits '*'", async () => {
    const listed = await getManagedConnections(["user"]);

    expect(listed.map((conn) => conn.seedId)).toEqual(SEED_IDS);
  });

  it("gives each engine its type, host, port, database, user, password and authSource, with the ones it does not take left unset", async () => {
    const bySeedId = new Map((await getManagedConnections(["admin"])).map((conn) => [conn.seedId, conn]));

    expect(addressOf(bySeedId.get("dokploy-postgres-f298d8acf10d"))).toEqual({
      type: "postgres",
      host: "demo-shop-orders-db-e6qmrw",
      port: 5432,
      database: "orders",
      user: "orders",
      // Characters a YAML file would read as syntax arrive as the literal they are.
      password: "p@ss:w#rd%1",
      authSource: undefined,
    });
    expect(addressOf(bySeedId.get("dokploy-mysql-c489a25fa2b7"))).toEqual({
      type: "mysql",
      host: "demo-shop-legacy-mysql-a1b2c3",
      port: 3306,
      database: "legacy",
      user: "root",
      password: "root-pass",
      authSource: undefined,
    });
    // Studio has no `mariadb` type: MariaDB is served by the MySQL provider.
    expect(addressOf(bySeedId.get("dokploy-mariadb-474206101a77"))).toEqual({
      type: "mysql",
      host: "demo-shop-shop-mariadb-d4e5f6",
      port: 3306,
      database: "shop",
      user: "shop",
      password: "maria-pass",
      authSource: undefined,
    });
    // The user lives in `admin`, so the driver must be told to authenticate there.
    expect(addressOf(bySeedId.get("dokploy-mongo-789b883f1772"))).toEqual({
      type: "mongodb",
      host: "demo-shop-events-mongo-g7h8i9",
      port: 27017,
      database: undefined,
      user: "mongo",
      password: "mongo-pass",
      authSource: "admin",
    });
    // Password only: a one-argument AUTH, which Redis resolves to its default user.
    expect(addressOf(bySeedId.get("dokploy-redis-ba2973db12d2"))).toEqual({
      type: "redis",
      host: "demo-shop-cache-j1k2l3",
      port: 6379,
      database: undefined,
      user: undefined,
      password: "redis-pass",
      authSource: undefined,
    });
    // A user and a password, which the libSQL transport sends as HTTP Basic.
    expect(addressOf(bySeedId.get("dokploy-libsql-6af07a96089c"))).toEqual({
      type: "libsql",
      host: "demo-shop-edge-libsql-m4n5o6",
      port: 8080,
      database: undefined,
      user: "libsql",
      password: "libsql-pass",
      authSource: undefined,
    });
  });

  it("hands the libSQL seed's user and password to the server-side resolution a provider is built from", async () => {
    const resolved = await resolveConnection(
      { connectionId: "seed:dokploy-libsql-6af07a96089c" },
      { role: "user", username: "user@libredb.org" },
    );

    expect({ type: resolved.type, user: resolved.user, password: resolved.password }).toEqual({
      type: "libsql",
      user: "libsql",
      password: "libsql-pass",
    });
  });
});
