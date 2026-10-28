import { parseGenericURL, withSSLMode } from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec, ParsedConnection } from "@/lib/db/connection-string/types";

const claimsRedis = (text: string): boolean => text.startsWith("redis://") || text.startsWith("rediss://");

/**
 * A `rediss://` or `redis://` URL. `rediss://` IS TLS (the secure form in Redis's own URI convention,
 * the one `redis-cli --tls` and every client library reads that way) and ioredis only
 * negotiates it when a `tls` option is present, which the provider builds from
 * `config.ssl` alone. `require` rather than a verifying mode: it maps to
 * `rejectUnauthorized: false`, and a self-hosted Redis presents a self-signed
 * certificate by default, so a verifying mode would refuse the ordinary
 * `--tls-port` deployment. A paste therefore encrypts but never silently claims to
 * have checked a chain; the panel is where verification is chosen. The plain scheme
 * is the explicit plaintext twin, so it clears a mode the form is still holding.
 */
function parseRedisURL(text: string): ParsedConnection | null {
  return withSSLMode(
    parseGenericURL(text, "redis", "6379", null),
    text.startsWith("rediss://") ? "require" : "disable",
  );
}

/**
 * `redis`: the `redis://` scheme, no TLS in the URL query (for `rediss://` the scheme IS the transport and already
 * decided), a paste of `redis://` or `rediss://`, no seed load check.
 */
export const REDIS_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "redis",
  readTls: null,
  paste: { catchAll: false, claims: claimsRedis, names: claimsRedis, parse: parseRedisURL },
  validateSeed: null,
};
