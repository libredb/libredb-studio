/**
 * Which discovered CapRover services are databases.
 *
 * Pure functions over one parsed export entry (discovery-export.ts). Detection reads the image
 * repository first; the env fallback applies only to an image CapRover built itself (img-captain-*),
 * because many client apps carry the same keys, and the loader lists such a match only after a TCP
 * probe answers.
 */
import type { DiscoveredService } from "./discovery-export";

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

function hasEnv(service: DiscoveredService, key: FingerprintEnvKey): boolean {
  return service.env[key] !== undefined;
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
