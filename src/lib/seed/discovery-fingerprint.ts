/**
 * Which discovered CapRover services are databases, and the seed connection each one becomes.
 *
 * Pure functions over one parsed export entry (discovery-export.ts). Detection reads the image
 * repository first; the env fallback applies only to an image CapRover built itself (img-captain-*),
 * because many client apps carry the same keys, and the loader lists such a match only after a TCP
 * probe answers.
 *
 * Every connection is built here with its access fields forced in code: managed, the admin role, no
 * MCP opt-in, no read-only mode, no connection string, TLS off. Nothing in the file can change them.
 * The literal marker is not set here: SeedConnectionSchema would strip it, so it is added after
 * filterByRoles (src/lib/seed/index.ts).
 *
 * A refusal names a field or an env key, never a value: the values are database passwords.
 */
import type { DiscoveredService } from "./discovery-export";
import { SeedConnectionSchema, type SeedConnection } from "./types";

export const DISCOVERY_ID_PREFIX = "caprover-";
export const DISCOVERY_GROUP = "CapRover";
/** A CapRover service name or network alias: lowercase letters, digits and inner hyphens, at most 253. */
export const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/;

const ENV_KEYS = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "MYSQL_ROOT_PASSWORD",
  "MONGO_INITDB_ROOT_USERNAME",
  "MONGO_INITDB_ROOT_PASSWORD",
  "REDIS_PASSWORD",
  "VALKEY_EXTRA_FLAGS",
  "KEYDB_PASSWORD",
  "DFLY_requirepass",
] as const;
type FingerprintEnvKey = (typeof ENV_KEYS)[number];

/**
 * Every env key detectEngine and mapToSeedConnection read. Each must be in the exporter's
 * ENV_ALLOW_LIST (docker/discover.mjs), or the key never reaches the file and the engine is
 * silently never detected; a unit test holds the two lists together.
 */
export const FINGERPRINT_ENV_KEYS: readonly string[] = Object.freeze([...ENV_KEYS]);

export interface EngineMatch {
  type: "postgres" | "mysql" | "mongodb" | "redis";
  label: string;
  via: "image" | "env";
  variant: "postgres" | "mysql" | "mongodb" | "redis" | "valkey" | "keydb" | "dragonfly";
}

type Engine = Omit<EngineMatch, "via">;

const POSTGRES: Engine = { type: "postgres", label: "PostgreSQL", variant: "postgres" };
const PERCONA: Engine = { type: "mysql", label: "Percona", variant: "mysql" };

/** A Map, not an object literal, so a repository named "constructor" finds nothing. */
const IMAGE_ENGINES: ReadonlyMap<string, Engine> = new Map([
  ["postgres", POSTGRES],
  ["postgis/postgis", POSTGRES],
  ["timescale/timescaledb", POSTGRES],
  ["timescale/timescaledb-ha", POSTGRES],
  ["pgvector/pgvector", POSTGRES],
  ["mysql", { type: "mysql", label: "MySQL", variant: "mysql" }],
  ["mariadb", { type: "mysql", label: "MariaDB", variant: "mysql" }],
  ["percona", PERCONA],
  ["percona/percona-server", PERCONA],
  ["mongo", { type: "mongodb", label: "MongoDB", variant: "mongodb" }],
  ["redis", { type: "redis", label: "Redis", variant: "redis" }],
  ["valkey/valkey", { type: "redis", label: "Valkey", variant: "valkey" }],
  ["eqalpha/keydb", { type: "redis", label: "KeyDB", variant: "keydb" }],
  ["dragonflydb/dragonfly", { type: "redis", label: "Dragonfly", variant: "dragonfly" }],
]);

/** The repository prefix of an image CapRover built from a template's dockerfileLines. */
const BUILT_IMAGE_PREFIX = "img-captain-";

/** Spec section 9.3, in its order: the first key present wins. */
const ENV_FALLBACKS: readonly { key: FingerprintEnvKey; engine: Engine }[] = [
  { key: "MYSQL_ROOT_PASSWORD", engine: { type: "mysql", label: "MySQL-compatible", variant: "mysql" } },
  { key: "KEYDB_PASSWORD", engine: { type: "redis", label: "KeyDB", variant: "keydb" } },
  { key: "POSTGRES_PASSWORD", engine: POSTGRES },
  { key: "MONGO_INITDB_ROOT_PASSWORD", engine: { type: "mongodb", label: "MongoDB", variant: "mongodb" } },
];

function isFingerprintEnvKey(key: string): key is FingerprintEnvKey {
  return FINGERPRINT_ENV_KEYS.includes(key);
}

function hasEnv(service: DiscoveredService, key: FingerprintEnvKey): boolean {
  return service.env[key] !== undefined;
}

/** The value of an env key, with an empty value counted as absent. */
function envValue(service: DiscoveredService, key: FingerprintEnvKey): string | undefined {
  const value = service.env[key];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The image's repository without registry, tag, digest or the library/ namespace:
 * "docker.io/library/postgres:16@sha256:..." becomes "postgres".
 */
export function parseImageRepository(image: string): string {
  const at = image.indexOf("@");
  let reference = at === -1 ? image : image.slice(0, at);
  const colon = reference.lastIndexOf(":");
  if (colon > reference.lastIndexOf("/")) reference = reference.slice(0, colon);
  const parts = reference.split("/");
  const first = parts[0];
  if (parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")) parts.shift();
  if (parts.length > 1 && parts[0] === "library") parts.shift();
  return parts.join("/");
}

export function detectEngine(service: DiscoveredService): EngineMatch | null {
  const repository = parseImageRepository(service.image);
  const byImage = IMAGE_ENGINES.get(repository);
  if (byImage !== undefined) return { ...byImage, via: "image" };

  const lastSegment = repository.slice(repository.lastIndexOf("/") + 1);
  if (!lastSegment.startsWith(BUILT_IMAGE_PREFIX)) return null;
  for (const fallback of ENV_FALLBACKS) {
    if (hasEnv(service, fallback.key)) return { ...fallback.engine, via: "env" };
  }
  // The official redis image ignores REDIS_PASSWORD; only a --requirepass $NAME command makes it real.
  if (hasEnv(service, "REDIS_PASSWORD") && service.requirepassEnv !== null) {
    return { type: "redis", label: "Redis", variant: "redis", via: "env" };
  }
  return null;
}

/**
 * The password in Valkey's VALKEY_EXTRA_FLAGS: the token after --requirepass, with one pair of
 * surrounding quotes removed, as valkey-server's own argument parser removes them.
 */
export function valkeyPasswordOf(flags: string): string | undefined {
  const match = /(?:^|\s)--requirepass\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(flags);
  if (match === null) return undefined;
  const token = match[1] ?? match[2] ?? match[3];
  return token === "" ? undefined : token;
}

function redisPasswordOf(service: DiscoveredService, variant: EngineMatch["variant"]): string | undefined {
  switch (variant) {
    case "valkey": {
      const flags = envValue(service, "VALKEY_EXTRA_FLAGS");
      return flags === undefined ? undefined : valkeyPasswordOf(flags);
    }
    case "keydb":
      return envValue(service, "KEYDB_PASSWORD");
    case "dragonfly":
      return envValue(service, "DFLY_requirepass");
    default: {
      // Redis: the env var the command names, never a value parsed out of the command itself.
      const name = service.requirepassEnv;
      return name !== null && isFingerprintEnvKey(name) ? envValue(service, name) : undefined;
    }
  }
}

type Credentials =
  | { ok: true; fields: Pick<SeedConnection, "port" | "user" | "password" | "database" | "authSource"> }
  | { ok: false; reason: string };

function missing(key: FingerprintEnvKey): Credentials {
  return { ok: false, reason: `${key} is missing or empty` };
}

/** Spec section 9.4. */
function credentialsOf(service: DiscoveredService, match: EngineMatch): Credentials {
  switch (match.type) {
    case "postgres": {
      const password = envValue(service, "POSTGRES_PASSWORD");
      if (password === undefined) return missing("POSTGRES_PASSWORD");
      const user = envValue(service, "POSTGRES_USER") ?? "postgres";
      return { ok: true, fields: { port: 5432, user, password, database: envValue(service, "POSTGRES_DB") ?? user } };
    }
    case "mysql": {
      const password = envValue(service, "MYSQL_ROOT_PASSWORD");
      if (password === undefined) return missing("MYSQL_ROOT_PASSWORD");
      return { ok: true, fields: { port: 3306, user: "root", password, database: "mysql" } };
    }
    case "mongodb": {
      const user = envValue(service, "MONGO_INITDB_ROOT_USERNAME");
      if (user === undefined) return missing("MONGO_INITDB_ROOT_USERNAME");
      const password = envValue(service, "MONGO_INITDB_ROOT_PASSWORD");
      if (password === undefined) return missing("MONGO_INITDB_ROOT_PASSWORD");
      return { ok: true, fields: { port: 27017, user, password, authSource: "admin" } };
    }
    case "redis": {
      const password = redisPasswordOf(service, match.variant);
      return { ok: true, fields: { port: 6379, database: "0", ...(password === undefined ? {} : { password }) } };
    }
  }
}

export type MappingResult = { ok: true; connection: SeedConnection } | { ok: false; reason: string };

export function mapToSeedConnection(service: DiscoveredService, match: EngineMatch): MappingResult {
  if (!HOST_PATTERN.test(service.host)) {
    return { ok: false, reason: "the host is not a CapRover service name (lowercase letters, digits and hyphens)" };
  }
  const credentials = credentialsOf(service, match);
  if (!credentials.ok) return credentials;

  const result = SeedConnectionSchema.safeParse({
    id: `${DISCOVERY_ID_PREFIX}${service.appName}`,
    name: `${service.appName} (${match.label})`,
    type: match.type,
    host: service.host,
    ...credentials.fields,
    group: DISCOVERY_GROUP,
    ssl: { mode: "disable" },
    managed: true,
    roles: ["admin"],
  });
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join(".")} (${issue.code})`).join(", ");
    return { ok: false, reason: `the connection is not valid: ${fields}` };
  }
  return { ok: true, connection: result.data };
}
