import { describe, it, expect } from "bun:test";
import { ENV_ALLOW_LIST } from "../../../docker/discover.mjs";
import { type DiscoveredService, parseDiscoveryExport } from "@/lib/seed/discovery-export";
import {
  DISCOVERY_GROUP,
  DISCOVERY_ID_PREFIX,
  detectEngine,
  type EngineMatch,
  FINGERPRINT_ENV_KEYS,
  HOST_PATTERN,
  mapToSeedConnection,
  parseImageRepository,
  valkeyPasswordOf,
} from "@/lib/seed/discovery-fingerprint";
import type { SeedConnection } from "@/lib/seed/types";

function service(
  image: string,
  env: Record<string, string> = {},
  overrides: Partial<DiscoveredService> = {},
): DiscoveredService {
  return {
    id: "svc0001",
    name: "app1",
    appName: "app1",
    host: "srv-captain--app1",
    image,
    env,
    requirepassEnv: null,
    tasks: { running: 1, desired: 1 },
    ...overrides,
  };
}

describe("parseImageRepository", () => {
  it.each([
    ["postgres", "postgres"],
    ["postgres:16", "postgres"],
    ["postgres@sha256:0123abcd", "postgres"],
    ["postgres:16-alpine@sha256:4c5b2f1e8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170615243a", "postgres"],
    ["library/postgres:16", "postgres"],
    ["docker.io/library/postgres:16", "postgres"],
    ["index.docker.io/library/mongo:7", "mongo"],
    ["localhost/redis:7", "redis"],
    ["localhost:5000/mysql:8.4", "mysql"],
    ["valkey/valkey:8", "valkey/valkey"],
    ["docker.dragonflydb.io/dragonflydb/dragonfly:v1.23.0", "dragonflydb/dragonfly"],
    ["ghcr.io/libredb/libredb-studio:0.17.0", "libredb/libredb-studio"],
    ["img-captain-mariadb1:3", "img-captain-mariadb1"],
    ["registry.example.com:5000/team/img-captain-keydb1:2", "team/img-captain-keydb1"],
    ["localhost", "localhost"],
    ["mysql-client", "mysql-client"],
  ])("parses %s as %s", (image, repository) => {
    expect(parseImageRepository(image)).toBe(repository);
  });
});

describe("detectEngine: by image repository (spec section 9.3)", () => {
  it.each([
    ["postgres:16", "postgres", "PostgreSQL", "postgres"],
    ["docker.io/library/postgres:16", "postgres", "PostgreSQL", "postgres"],
    ["postgis/postgis:16-3.4", "postgres", "PostgreSQL", "postgres"],
    ["timescale/timescaledb:latest-pg16", "postgres", "PostgreSQL", "postgres"],
    ["timescale/timescaledb-ha:pg16", "postgres", "PostgreSQL", "postgres"],
    ["pgvector/pgvector:pg16", "postgres", "PostgreSQL", "postgres"],
    ["mysql:8.4", "mysql", "MySQL", "mysql"],
    ["mariadb:11", "mysql", "MariaDB", "mysql"],
    ["percona:8.0", "mysql", "Percona", "mysql"],
    ["percona/percona-server:8.0", "mysql", "Percona", "mysql"],
    ["mongo:7", "mongodb", "MongoDB", "mongodb"],
    ["redis:7", "redis", "Redis", "redis"],
    ["valkey/valkey:8", "redis", "Valkey", "valkey"],
    ["eqalpha/keydb:latest", "redis", "KeyDB", "keydb"],
    ["docker.dragonflydb.io/dragonflydb/dragonfly:v1.23.0", "redis", "Dragonfly", "dragonfly"],
  ])("detects %s as %s (%s)", (image, type, label, variant) => {
    expect(detectEngine(service(image))).toEqual({ type, label, variant, via: "image" } as EngineMatch);
  });

  it("matches the repository even when the image carries none of the env keys", () => {
    expect(detectEngine(service("postgres:16", {}))?.via).toBe("image");
  });

  it.each([
    "nginx:latest",
    "ghcr.io/libredb/libredb-studio:0.17.0",
    "bitnami/postgresql:16",
    "my-postgres:1",
    "constructor",
    "__proto__",
    "img-captain-app/web:1",
  ])("ignores %s", (image) => {
    expect(detectEngine(service(image, { POSTGRES_PASSWORD: "x" }))).toBeNull();
  });

  it("ignores a client app that carries a database key on an image CapRover did not build", () => {
    const odoo = service("odoo:17", { POSTGRES_USER: "odoo", POSTGRES_PASSWORD: "x", REDIS_PASSWORD: "y" });
    expect(detectEngine(odoo)).toBeNull();
  });
});

describe("detectEngine: env fallback for images CapRover built (spec section 9.3)", () => {
  const BUILT = ["img-captain-db1:3", "registry.example.com:5000/captain/img-captain-db1:3"];

  it.each(BUILT)("detects MYSQL_ROOT_PASSWORD on %s as MySQL-compatible", (image) => {
    expect(detectEngine(service(image, { MYSQL_ROOT_PASSWORD: "x" }))).toEqual({
      type: "mysql",
      label: "MySQL-compatible",
      variant: "mysql",
      via: "env",
    });
  });

  it.each(BUILT)("detects KEYDB_PASSWORD on %s as KeyDB", (image) => {
    expect(detectEngine(service(image, { KEYDB_PASSWORD: "x" }))).toEqual({
      type: "redis",
      label: "KeyDB",
      variant: "keydb",
      via: "env",
    });
  });

  it.each(BUILT)("detects POSTGRES_PASSWORD on %s as PostgreSQL", (image) => {
    expect(detectEngine(service(image, { POSTGRES_PASSWORD: "x" }))).toEqual({
      type: "postgres",
      label: "PostgreSQL",
      variant: "postgres",
      via: "env",
    });
  });

  it.each(BUILT)("detects MONGO_INITDB_ROOT_PASSWORD on %s as MongoDB", (image) => {
    expect(detectEngine(service(image, { MONGO_INITDB_ROOT_PASSWORD: "x" }))).toEqual({
      type: "mongodb",
      label: "MongoDB",
      variant: "mongodb",
      via: "env",
    });
  });

  it.each(BUILT)("detects REDIS_PASSWORD with a requirepassEnv on %s as Redis", (image) => {
    const svc = service(image, { REDIS_PASSWORD: "x" }, { requirepassEnv: "REDIS_PASSWORD" });
    expect(detectEngine(svc)).toEqual({ type: "redis", label: "Redis", variant: "redis", via: "env" });
  });

  it("ignores REDIS_PASSWORD without a requirepassEnv, which the redis image itself ignores", () => {
    expect(detectEngine(service("img-captain-db1:3", { REDIS_PASSWORD: "x" }))).toBeNull();
  });

  it("ignores a built image with none of the keys", () => {
    expect(detectEngine(service("img-captain-web1:4", { POSTGRES_USER: "u", POSTGRES_DB: "d" }))).toBeNull();
  });

  it("takes the first row of the table when several keys are present", () => {
    const svc = service("img-captain-db1:3", { POSTGRES_PASSWORD: "x", MYSQL_ROOT_PASSWORD: "y" });
    expect(detectEngine(svc)?.type).toBe("mysql");
  });

  it("counts a key with an empty value as present, so the mapping reports the missing value", () => {
    expect(detectEngine(service("img-captain-db1:3", { MYSQL_ROOT_PASSWORD: "" }))?.type).toBe("mysql");
  });
});

describe("FINGERPRINT_ENV_KEYS", () => {
  it("lists only keys the exporter's ENV_ALLOW_LIST copies into the file", () => {
    expect(FINGERPRINT_ENV_KEYS.length).toBeGreaterThan(0);
    for (const key of FINGERPRINT_ENV_KEYS) {
      expect(ENV_ALLOW_LIST).toContain(key);
    }
  });

  it("keeps Dragonfly's mixed-case key exactly", () => {
    expect(FINGERPRINT_ENV_KEYS).toContain("DFLY_requirepass");
    expect(FINGERPRINT_ENV_KEYS).not.toContain("DFLY_REQUIREPASS");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(FINGERPRINT_ENV_KEYS)).toBe(true);
  });
});

function matchOf(svc: DiscoveredService): EngineMatch {
  const match = detectEngine(svc);
  if (match === null) throw new Error(`expected ${svc.image} to be detected`);
  return match;
}

describe("FINGERPRINT_ENV_KEYS: the keys detection and mapping read", () => {
  it("lists exactly the env keys detection and mapping read", () => {
    const read = new Set<string>();
    const recordingEnv = (answer: string | undefined) =>
      new Proxy({} as Record<string, string>, {
        get(_target, key) {
          if (typeof key === "string") read.add(key);
          return answer;
        },
      });
    // Detection with no key present walks every fallback row.
    detectEngine(service("img-captain-db1:3", recordingEnv(undefined), { requirepassEnv: "REDIS_PASSWORD" }));
    // Mapping with every key present reads each optional field too.
    const variants: EngineMatch[] = [
      { type: "postgres", label: "PostgreSQL", variant: "postgres", via: "image" },
      { type: "mysql", label: "MySQL", variant: "mysql", via: "image" },
      { type: "mongodb", label: "MongoDB", variant: "mongodb", via: "image" },
      { type: "redis", label: "Redis", variant: "redis", via: "image" },
      { type: "redis", label: "Valkey", variant: "valkey", via: "image" },
      { type: "redis", label: "KeyDB", variant: "keydb", via: "image" },
      { type: "redis", label: "Dragonfly", variant: "dragonfly", via: "image" },
    ];
    for (const match of variants) {
      mapToSeedConnection(service("x:1", recordingEnv("v"), { requirepassEnv: "REDIS_PASSWORD" }), match);
    }
    expect([...read].sort()).toEqual([...FINGERPRINT_ENV_KEYS].sort());
  });
});

describe("valkeyPasswordOf", () => {
  it.each([
    ["--requirepass s3cret", "s3cret"],
    ["--maxmemory 1gb --requirepass s3cret --appendonly yes", "s3cret"],
    ["--requirepass    s3cret", "s3cret"],
    ["--requirepass\ts3cret", "s3cret"],
    ['--requirepass "s3 cret"', "s3 cret"],
    ["--requirepass 's3 cret'", "s3 cret"],
    ['--requirepass "s3cret" --maxmemory 1gb', "s3cret"],
    ["--requirepass p=a$$w0rd", "p=a$$w0rd"],
  ])("reads %s as %s", (flags, password) => {
    expect(valkeyPasswordOf(flags)).toBe(password);
  });

  it.each([
    ["no flags", ""],
    ["other flags only", "--maxmemory 1gb"],
    ["the flag without a value", "--requirepass"],
    ["the flag followed by blanks only", "--requirepass   "],
    ["an empty quoted value", '--requirepass ""'],
    ["a longer flag name", "--requirepassword s3cret"],
    ["the flag glued to another token", "x--requirepass s3cret"],
  ])("finds no password in %s", (_label, flags) => {
    expect(valkeyPasswordOf(flags)).toBeUndefined();
  });
});

describe("HOST_PATTERN", () => {
  it.each(["srv-captain--pgtest", "a", "a1", "pg-16", `a${"b".repeat(251)}c`])("accepts %s", (host) => {
    expect(HOST_PATTERN.test(host)).toBe(true);
  });

  it.each([
    "",
    "-a",
    "a-",
    "My_Postgres",
    "UPPER",
    "under_score",
    "a.b",
    "a b",
    "srv-captain--pg\n",
    `a${"b".repeat(252)}c`,
  ])("refuses %j", (host) => {
    expect(HOST_PATTERN.test(host)).toBe(false);
  });
});

describe("mapToSeedConnection (spec section 9.4)", () => {
  const forced: Pick<SeedConnection, "group" | "ssl" | "managed" | "roles"> = {
    group: "CapRover",
    ssl: { mode: "disable" },
    managed: true,
    roles: ["admin"],
  };

  it("maps PostgreSQL from all three keys", () => {
    const svc = service("postgres:16", { POSTGRES_USER: "app", POSTGRES_PASSWORD: "pw", POSTGRES_DB: "appdb" });
    expect(mapToSeedConnection(svc, matchOf(svc))).toEqual({
      ok: true,
      connection: {
        id: "caprover-app1",
        name: "app1 (PostgreSQL)",
        type: "postgres",
        host: "srv-captain--app1",
        port: 5432,
        user: "app",
        password: "pw",
        database: "appdb",
        ...forced,
      },
    });
  });

  it("defaults the PostgreSQL user to postgres and the database to the user", () => {
    const svc = service("postgres:16", { POSTGRES_PASSWORD: "pw" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && result.connection.user).toBe("postgres");
    expect(result.ok && result.connection.database).toBe("postgres");
  });

  it("defaults the PostgreSQL database to a custom user", () => {
    const svc = service("postgres:16", { POSTGRES_USER: "app", POSTGRES_PASSWORD: "pw", POSTGRES_DB: "" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && result.connection.database).toBe("app");
  });

  it("treats an empty POSTGRES_USER as absent", () => {
    const svc = service("postgres:16", { POSTGRES_USER: "", POSTGRES_PASSWORD: "pw" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && result.connection.user).toBe("postgres");
  });

  it.each([
    ["missing", {}],
    ["empty", { POSTGRES_PASSWORD: "" }],
  ])("skips PostgreSQL with POSTGRES_PASSWORD %s", (_label, env) => {
    const svc = service("postgres:16", { POSTGRES_USER: "app", ...env });
    expect(mapToSeedConnection(svc, matchOf(svc))).toEqual({
      ok: false,
      reason: "POSTGRES_PASSWORD is missing or empty",
    });
  });

  it.each([
    ["mysql:8.4", "MySQL"],
    ["mariadb:11", "MariaDB"],
    ["percona:8.0", "Percona"],
    ["img-captain-db1:3", "MySQL-compatible"],
  ])("maps %s as root on the mysql schema", (image, label) => {
    const svc = service(image, { MYSQL_ROOT_PASSWORD: "rootpw" });
    expect(mapToSeedConnection(svc, matchOf(svc))).toEqual({
      ok: true,
      connection: {
        id: "caprover-app1",
        name: `app1 (${label})`,
        type: "mysql",
        host: "srv-captain--app1",
        port: 3306,
        user: "root",
        password: "rootpw",
        database: "mysql",
        ...forced,
      },
    });
  });

  it("skips MySQL without MYSQL_ROOT_PASSWORD", () => {
    const svc = service("mysql:8.4", {});
    expect(mapToSeedConnection(svc, matchOf(svc))).toEqual({
      ok: false,
      reason: "MYSQL_ROOT_PASSWORD is missing or empty",
    });
  });

  it("maps MongoDB with authSource admin and no database", () => {
    const svc = service("mongo:7", { MONGO_INITDB_ROOT_USERNAME: "root", MONGO_INITDB_ROOT_PASSWORD: "mpw" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result).toEqual({
      ok: true,
      connection: {
        id: "caprover-app1",
        name: "app1 (MongoDB)",
        type: "mongodb",
        host: "srv-captain--app1",
        port: 27017,
        user: "root",
        password: "mpw",
        authSource: "admin",
        ...forced,
      },
    });
    expect(result.ok && "database" in result.connection).toBe(false);
  });

  it.each([
    ["MONGO_INITDB_ROOT_USERNAME", { MONGO_INITDB_ROOT_PASSWORD: "mpw" }],
    ["MONGO_INITDB_ROOT_PASSWORD", { MONGO_INITDB_ROOT_USERNAME: "root" }],
  ])("skips MongoDB without %s", (key, env) => {
    const svc = service("mongo:7", env);
    expect(mapToSeedConnection(svc, matchOf(svc))).toEqual({ ok: false, reason: `${key} is missing or empty` });
  });

  /** The redis one-click template: command ["sh", "-c", "redis-server --requirepass $REDIS_PASSWORD"]. */
  it("maps Redis with the password of the env var its command names", () => {
    const svc = service("redis:7", { REDIS_PASSWORD: "rpw" }, { requirepassEnv: "REDIS_PASSWORD" });
    expect(mapToSeedConnection(svc, matchOf(svc))).toEqual({
      ok: true,
      connection: {
        id: "caprover-app1",
        name: "app1 (Redis)",
        type: "redis",
        host: "srv-captain--app1",
        port: 6379,
        password: "rpw",
        database: "0",
        ...forced,
      },
    });
  });

  it("maps Redis without a password when no command names one, whatever REDIS_PASSWORD holds", () => {
    const svc = service("redis:7", { REDIS_PASSWORD: "ignored-by-the-image" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok).toBe(true);
    expect(result.ok && "password" in result.connection).toBe(false);
    expect(result.ok && "user" in result.connection).toBe(false);
  });

  it("maps Redis without a password when the named env var is absent", () => {
    const svc = service("redis:7", {}, { requirepassEnv: "REDIS_PASSWORD" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && "password" in result.connection).toBe(false);
  });

  it("never reads a requirepassEnv that is not a fingerprint key", () => {
    const svc = service("redis:7", { OTHER_SECRET: "not-for-redis" }, { requirepassEnv: "OTHER_SECRET" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && "password" in result.connection).toBe(false);
  });

  it("maps Valkey with the password from VALKEY_EXTRA_FLAGS, quotes removed", () => {
    const svc = service("valkey/valkey:8", { VALKEY_EXTRA_FLAGS: "--requirepass 'v pw' --maxmemory 1gb" });
    expect(mapToSeedConnection(svc, matchOf(svc))).toEqual({
      ok: true,
      connection: {
        id: "caprover-app1",
        name: "app1 (Valkey)",
        type: "redis",
        host: "srv-captain--app1",
        port: 6379,
        password: "v pw",
        database: "0",
        ...forced,
      },
    });
  });

  it.each([
    ["no VALKEY_EXTRA_FLAGS", {}],
    ["empty VALKEY_EXTRA_FLAGS", { VALKEY_EXTRA_FLAGS: "" }],
    ["flags without --requirepass", { VALKEY_EXTRA_FLAGS: "--maxmemory 1gb" }],
  ])("maps Valkey without a password for %s", (_label, env) => {
    const svc = service("valkey/valkey:8", env);
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok).toBe(true);
    expect(result.ok && "password" in result.connection).toBe(false);
  });

  it.each(["eqalpha/keydb:latest", "img-captain-db1:3"])("maps KeyDB on %s with KEYDB_PASSWORD", (image) => {
    const svc = service(image, { KEYDB_PASSWORD: "kpw" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && result.connection.name).toBe("app1 (KeyDB)");
    expect(result.ok && result.connection.password).toBe("kpw");
    expect(result.ok && result.connection.database).toBe("0");
  });

  it("maps KeyDB without a password when KEYDB_PASSWORD is absent", () => {
    const svc = service("eqalpha/keydb:latest", {});
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && "password" in result.connection).toBe(false);
  });

  it("maps Dragonfly with DFLY_requirepass", () => {
    const svc = service("docker.dragonflydb.io/dragonflydb/dragonfly:v1.23.0", { DFLY_requirepass: "dpw" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && result.connection.name).toBe("app1 (Dragonfly)");
    expect(result.ok && result.connection.password).toBe("dpw");
    expect(result.ok && result.connection.port).toBe(6379);
  });

  it("maps Dragonfly without a password when only an uppercase DFLY_REQUIREPASS is set", () => {
    const svc = service("docker.dragonflydb.io/dragonflydb/dragonfly:v1.23.0", { DFLY_REQUIREPASS: "dpw" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && "password" in result.connection).toBe(false);
  });

  it("builds the id from the app name and the display name from the engine label", () => {
    const svc = service("postgres:16", { POSTGRES_PASSWORD: "pw" }, { name: "srv-captain--legacy", appName: "legacy" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && result.connection.id).toBe(`${DISCOVERY_ID_PREFIX}legacy`);
    expect(result.ok && result.connection.name).toBe("legacy (PostgreSQL)");
    expect(result.ok && result.connection.group).toBe(DISCOVERY_GROUP);
  });

  it("uses the host exactly as exported", () => {
    const svc = service("postgres:16", { POSTGRES_PASSWORD: "pw" }, { host: "pgold" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && result.connection.host).toBe("pgold");
  });
});

describe("mapToSeedConnection: hosts and invalid connections", () => {
  /**
   * Review focus (Task 3): a non-CapRover service on the network can have a name CapRover would
   * never produce. It is skipped with a reason, and the call never throws.
   */
  it.each(["My_Postgres", "UPPERCASE", "under_score", "dotted.name"])("skips a service whose host is %s", (host) => {
    const svc = service("postgres:16", { POSTGRES_PASSWORD: "pw" }, { name: host, appName: host, host });
    const match = matchOf(svc);
    expect(() => mapToSeedConnection(svc, match)).not.toThrow();
    expect(mapToSeedConnection(svc, match)).toEqual({
      ok: false,
      reason: "the host is not a CapRover service name (lowercase letters, digits and hyphens)",
    });
  });

  it("checks the host before the credentials", () => {
    const svc = service("postgres:16", {}, { host: "Bad_Host" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok === false && result.reason).toStartWith("the host is not a CapRover service name");
  });

  it("skips an app name that cannot form a seed id, naming the field and never the password", () => {
    const svc = service("postgres:16", { POSTGRES_PASSWORD: "pw-never-in-a-reason" }, { appName: "Bad_Name" });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result).toEqual({ ok: false, reason: "the connection is not valid: id (invalid_format)" });
  });

  it("skips an app name too long for the 64-character id", () => {
    const appName = "a".repeat(56);
    const svc = service("postgres:16", { POSTGRES_PASSWORD: "pw" }, { appName });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result).toEqual({ ok: false, reason: "the connection is not valid: id (too_big)" });
  });

  it("accepts an app name of 55 characters, the longest that fits the id", () => {
    const svc = service("postgres:16", { POSTGRES_PASSWORD: "pw" }, { appName: "a".repeat(55) });
    const result = mapToSeedConnection(svc, matchOf(svc));
    expect(result.ok && result.connection.id).toHaveLength(64);
  });
});

describe("mapToSeedConnection: forced fields", () => {
  it("forces managed, the admin role, TLS off, no MCP, no read-only mode and no connection string", () => {
    const raw = JSON.stringify({
      version: 1,
      platform: "caprover",
      generatedAt: "2026-10-04T12:00:00.000Z",
      checkedAt: "2026-10-04T12:00:10.000Z",
      status: { ok: true },
      network: { name: "captain-overlay-network", id: "n1" },
      services: [
        {
          ...service("postgres:16", { POSTGRES_PASSWORD: "pw" }),
          managed: false,
          roles: ["*", "user"],
          mcp: true,
          readOnly: true,
          literal: false,
          connectionString: "postgres://attacker@example.com/x",
          ssl: { mode: "require" },
          group: "Elsewhere",
          environment: "production",
        },
      ],
      excluded: [],
    });
    const parsed = parseDiscoveryExport(raw);
    if (!parsed.ok) throw new Error(parsed.reason);
    const svc = parsed.value.services[0];
    const result = mapToSeedConnection(svc, matchOf(svc));
    if (!result.ok) throw new Error(result.reason);
    const conn = result.connection;
    expect(conn.managed).toBe(true);
    expect(conn.roles).toEqual(["admin"]);
    expect(conn.ssl).toEqual({ mode: "disable" });
    expect(conn.group).toBe("CapRover");
    expect("mcp" in conn).toBe(false);
    expect("readOnly" in conn).toBe(false);
    expect("connectionString" in conn).toBe(false);
    expect("environment" in conn).toBe(false);
    expect("literal" in conn).toBe(false);
  });

  it("forces the same fields on every engine", () => {
    const services = [
      service("postgres:16", { POSTGRES_PASSWORD: "pw" }),
      service("mariadb:11", { MYSQL_ROOT_PASSWORD: "pw" }),
      service("mongo:7", { MONGO_INITDB_ROOT_USERNAME: "u", MONGO_INITDB_ROOT_PASSWORD: "pw" }),
      service("redis:7", {}),
      service("img-captain-db1:3", { KEYDB_PASSWORD: "pw" }),
    ];
    for (const svc of services) {
      const result = mapToSeedConnection(svc, matchOf(svc));
      if (!result.ok) throw new Error(result.reason);
      expect(result.connection).toMatchObject({ managed: true, roles: ["admin"], ssl: { mode: "disable" } });
      expect("mcp" in result.connection).toBe(false);
    }
  });
});
