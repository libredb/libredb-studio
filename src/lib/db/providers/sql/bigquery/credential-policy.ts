/**
 * BigQuery's credential policy, composed over the shared Google auth (src/lib/db/auth/google): which credential a
 * connection uses, and when.
 *
 * - A credential in the password field: a service-account key JSON, an authorized-user JSON or an access token,
 *   parsed and used; it needs no server setting.
 * - An empty field: refused for a connection a browser sent and for a row of a seed file read in literal mode
 *   (SEED_LITERAL_VALUES, the record carries the literal-mode marker); for an operator seed (`managed: true`, which
 *   resolveConnection forces false on every browser-sent connection) refused unless BIGQUERY_SERVER_CREDENTIALS is
 *   exactly "true", and then the server's own identity in ADC order. The resolver passes the record it was given, so
 *   the marker reaches the shared gate.
 *
 * The real IO (process.env, the file system, the home directory, the platform) is read at each connect, so a changed
 * environment applies to the next connection. BIGQUERY_EMULATOR_HOST is the transport's rule, not this module's: the
 * credential is still resolved under it, and no token is minted.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  type GoogleCredentialIo,
  type GoogleCredentialRules,
  type GoogleCredentialsOf,
  resolveGoogleCredential,
} from "@/lib/db/auth/google/credentials";
import type { GoogleTokenSourceDeps } from "@/lib/db/auth/google/token-source";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import type { DatabaseConnection, WithLiteralSeedFile } from "@/lib/types";

const PROVIDER = "bigquery" as const;
const SERVER_CREDENTIALS_ENV = "BIGQUERY_SERVER_CREDENTIALS";
const TOKEN_RESPONSE_BYTES = 64 * 1024;

export const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";

const BIGQUERY_KINDS = Object.freeze(["service_account", "authorized_user", "access_token"] as const);
type BigQueryKind = (typeof BIGQUERY_KINDS)[number];
/** BigQuery's credentials: a kind another provider lists never reaches this type. */
export type BigQueryCredentials = GoogleCredentialsOf<BigQueryKind | "metadata">;

export const BIGQUERY_CREDENTIAL_SENTENCES = Object.freeze({
  browserEmpty:
    "BigQuery needs a service-account key or an access token in the password field: the server's own credentials are used only for operator-seeded connections",
  seedWithoutOptIn: `BigQuery needs a service-account key in the password field. To use the server's own credentials (ADC or Workload Identity) instead, set ${SERVER_CREDENTIALS_ENV}=true on the server.`,
  literalSeedFile:
    "BigQuery needs a service-account key or an access token in the password field: the server's own credentials are not used for a connection read from a seed file in literal mode (SEED_LITERAL_VALUES)",
});

const S = BIGQUERY_CREDENTIAL_SENTENCES;

/**
 * A letter first, so "." and "..", which encodeURIComponent keeps and which would climb out of /projects/ in a URL
 * path, never pass; then letters, digits, colons (a legacy domain prefix), dots and hyphens.
 */
const PROJECT_ID = /^[a-z][a-z0-9:.-]{0,200}$/i;

/** BigQuery's project id rule: null when the id passes, else the reason. */
export function projectIdRefusal(id: string): string | null {
  return PROJECT_ID.test(id) ? null : "a letter, then at most 200 letters, digits, colons, dots or hyphens";
}

export const BIGQUERY_CREDENTIAL_RULES: GoogleCredentialRules<BigQueryKind> = Object.freeze({
  provider: PROVIDER,
  accepts: BIGQUERY_KINDS,
  quotaProjectRefusal: projectIdRefusal,
  serverIdentity: Object.freeze({
    optIn: SERVER_CREDENTIALS_ENV,
    unmanaged: S.browserEmpty,
    literalSeedFile: S.literalSeedFile,
    withoutOptIn: S.seedWithoutOptIn,
  }),
});

/** The process's own environment, files, home directory and platform, read when a connection resolves. */
export function bigQueryCredentialIo(): GoogleCredentialIo {
  return {
    env: process.env,
    readFile: (path) => readFileSync(path, "utf8"),
    homeDir: homedir,
    platform: process.platform,
  };
}

export function resolveBigQueryCredential(
  connection: Pick<DatabaseConnection, "password" | "managed"> & WithLiteralSeedFile,
  io: GoogleCredentialIo = bigQueryCredentialIo(),
): BigQueryCredentials {
  return resolveGoogleCredential(connection, BIGQUERY_CREDENTIAL_RULES, io);
}

/** The token source's deps: BigQuery's scope and label, the wall clock, and createNodeTransport itself. */
export function bigQueryTokenSourceDeps(): GoogleTokenSourceDeps {
  return {
    scope: BIGQUERY_SCOPE,
    provider: PROVIDER,
    maxResponseBytes: TOKEN_RESPONSE_BYTES,
    now: () => Date.now(),
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
    createTransport: createNodeTransport,
  };
}
