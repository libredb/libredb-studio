/**
 * The TLS setting a `pg` Pool gets for a PostgreSQL connection string.
 *
 * The storage pool and the governance pool both build their `ssl` option here, so one URL
 * gets the same TLS handling in either place.
 */

/** The `ssl` option of a `pg` Pool, as this module answers it. */
export type PgSslConfig = boolean | { rejectUnauthorized: boolean };

const LOCAL_HOSTS = new Set([
  "localhost",
  "::1",
  "host.docker.internal",
  "docker.for.mac.localhost",
  "docker.for.win.localhost",
  "gateway.docker.internal",
]);

export function pgSslConfig(connectionString: string): PgSslConfig {
  const { host, searchParams } = parseConnectionString(connectionString);

  const sslMode = searchParams.get("sslmode")?.toLowerCase();
  if (sslMode === "disable") return false;
  // `verify-system` is not a libpq sslmode - it is this product's own mode name
  // (src/lib/types.ts), and someone configuring STORAGE_POSTGRES_URL from the connection
  // form's vocabulary will write it. It means "verify against the runtime's trust store",
  // so it is the one value here that turns verification ON; without this branch it fell
  // through to the non-local default below and got `rejectUnauthorized: false`, i.e. the
  // opposite of what it says (D26). The libpq spellings keep their existing behaviour: this
  // pool has no channel for a CA PEM, so a verifying default would break every deployment
  // whose storage database presents a self-signed certificate.
  if (sslMode === "verify-system") return { rejectUnauthorized: true };
  if (sslMode === "require" || sslMode === "prefer" || sslMode === "verify-ca" || sslMode === "verify-full") {
    return { rejectUnauthorized: false };
  }

  const sslParam = searchParams.get("ssl")?.toLowerCase();
  if (sslParam === "false" || sslParam === "0" || sslParam === "no") {
    return false;
  }
  if (sslParam === "true" || sslParam === "1" || sslParam === "yes") {
    return { rejectUnauthorized: false };
  }

  if (isLocalHost(host)) return false;
  return { rejectUnauthorized: false };
}

function parseConnectionString(connectionString: string): {
  host: string;
  searchParams: URLSearchParams;
} {
  try {
    const parsed = new URL(connectionString);
    return {
      host: parsed.hostname.toLowerCase(),
      searchParams: parsed.searchParams,
    };
  } catch {
    return {
      host: "",
      searchParams: new URLSearchParams(),
    };
  }
}

function isLocalHost(host: string): boolean {
  if (LOCAL_HOSTS.has(host)) return true;
  if (host.startsWith("127.")) return true;
  return false;
}
