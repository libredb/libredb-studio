import { describe, it, expect } from "bun:test";
import { ENV_ALLOW_LIST } from "../../../docker/discover.mjs";
import type { DiscoveredService } from "@/lib/seed/discovery-export";
import {
  detectEngine,
  type EngineMatch,
  FINGERPRINT_ENV_KEYS,
  parseImageRepository,
} from "@/lib/seed/discovery-fingerprint";

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
