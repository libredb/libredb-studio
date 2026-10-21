import { ENGINE_URI_SCHEMES, parseConnectionString } from "@/lib/connection-string-parser";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { SeedConnectionSchema } from "@/lib/seed/types";
import type { DatabaseType } from "@/lib/types";

/**
 * Today's connection-string and seed-check output per engine, written by calling the public functions only, so a
 * move of the scheme map, the TLS readers or the seed load checks behind another shape is held to the same answers.
 *
 * Three keys outside the union ride along: `no-connection` reads the map with no type at all, `constructor` reads a
 * name every plain object inherits (today's map is an object literal, so it answers `Object`, a function), and
 * `not-an-engine` reads a name nothing defines.
 */
export const GOLDEN_KEYS: readonly string[] = Object.freeze([
  ...EXTERNAL_DATABASE_TYPES,
  "libredb",
  "no-connection",
  "constructor",
  "not-an-engine",
]);

const ID_KEYS: ReadonlySet<string> = new Set<string>([...EXTERNAL_DATABASE_TYPES, "libredb"]);

/**
 * One URL per TLS spelling `readQueryTLS` and `readADONetTLS` read, plus the same query on engines they do not read,
 * so an engine that starts or stops reading one shows up as a changed line.
 */
const PARSE_URLS: readonly string[] = [
  "postgres://u:p@h:5432/d?sslmode=verify-full",
  "postgres://u:p@h/d?ssl=true",
  "postgres://u:p@h/d?sslmode=disable&ssl=true",
  "postgresql://h/d?SSLMODE=require",
  "mysql://u:p@h:3306/d?ssl-mode=REQUIRED",
  "mysql://h/d?sslmode=VERIFY_IDENTITY",
  "mysql://h/d?useSSL=true",
  "mysql://h/d?ssl=0",
  "mssql://u:p@h:1433/d?encrypt=true&trustServerCertificate=true",
  "mssql://h/d?encrypt=true",
  "mssql://h/d?encrypt=yes&trustServerCertificate=no",
  "mssql://h/d?encrypt=strict",
  "mssql://h/d?encrypt=false",
  "Server=h,1433;Database=d;User Id=u;Password=p;Encrypt=true;TrustServerCertificate=false",
  "db2://u:p@h:50000/d?security=SSL",
  "db2://h/d?ssl=true",
  "oracle://u:p@h:1521/d?sslmode=require&ssl=true",
  "redis://h:6379/0?sslmode=require",
  "rediss://h:6379/0",
  "clickhouse://h:8123/d?sslmode=require",
  "couchbase://h/b?ssl=true",
  "libsql://db-org.turso.io?authToken=x&sslmode=require",
  "databend://u:p@h:8000/d?sslmode=disable",
  "mongodb://u:p@h:27017/d?tls=true",
];

/** The fields a type's own load checks need beyond a generic entry, as `tests/unit/seed/types.test.ts` gives them. */
const completeFor = (type: string): Record<string, unknown> =>
  type === "snowflake" ? { user: "u", role: "r", privateKey: "${SNOWFLAKE_PRIVATE_KEY}" } : {};

/** The smallest valid seed entry for a type, after `validConn` in `tests/unit/seed/types.test.ts`. */
export function seedBase(type: DatabaseType): Record<string, unknown> {
  return {
    id: "test-pg",
    name: "Test PG",
    type,
    host: "localhost",
    port: 5432,
    roles: ["admin"],
    ...completeFor(type),
  };
}

/** A schema parse's issues as `{ path, message }`, in issue order. */
export function seedIssues(input: Record<string, unknown>): { path: PropertyKey[]; message: string }[] {
  const result = SeedConnectionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map(({ path, message }) => ({ path, message }));
}

function schemeLine(key: string): string {
  const scheme =
    key === "no-connection"
      ? ENGINE_URI_SCHEMES[undefined as never]
      : (ENGINE_URI_SCHEMES as Record<string, unknown>)[key];
  return `scheme => ${typeof scheme === "string" ? JSON.stringify(scheme) : typeof scheme}`;
}

export function renderConnectionStringGolden(key: string): string {
  const lines = [schemeLine(key)];
  if (ID_KEYS.has(key)) {
    for (const url of PARSE_URLS) {
      const parsed = parseConnectionString(url);
      if (parsed?.type === key) lines.push(`parse(${url}) => ${JSON.stringify(parsed)}`);
    }
    const type = key as DatabaseType;
    lines.push(
      `seed => ${JSON.stringify(seedIssues({ ...seedBase(type), host: "", user: " ", authMethod: "bogus", role: "" }))}`,
    );
    lines.push(
      `seed => ${JSON.stringify(
        seedIssues({
          ...seedBase(type),
          host: "${SF_HOST}",
          user: "${SF_USER}",
          role: "${SF_ROLE}",
          authMethod: "pat",
          password: "",
        }),
      )}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
