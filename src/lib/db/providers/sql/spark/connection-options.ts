/**
 * Maps an Apache Spark connection to the options its gRPC channel opens with. No socket opens
 * here: every refusal is a DatabaseConfigError raised before any channel is built, and none repeats the value it
 * refuses (the Milvus rule). The checks run in one fixed order, and the first refusal answers: the tunnel, Host, Port,
 * User, Token, Catalog, Namespace, the SSL / TLS panel, the token's plaintext rule, then the query timeout.
 *
 * The target is `dns:` and the validated host and port. The TLS identity is the tunnel's far end when a tunnel carries
 * the connection, else the host; an IP identity is checked through SPARK_IP_SERVER_NAME. A token is never sent without
 * TLS to a host that is neither loopback nor tunnelled, with no opt-out: Spark Connect has no TLS of its own, so
 * a remote server is reached through a TLS proxy or the SSH tunnel.
 *
 * Host, Catalog and Namespace read as blank when they are absent, null, empty or only white space. Host and Namespace
 * are otherwise checked and used as written, as the dialog checks them, and the dialog refuses a padded Namespace.
 * Catalog is trimmed before it is checked: Spark looks the catalog name up literally in SET CATALOG, and the dialog
 * accepts both spellings. User takes no value at all: anything but an
 * absent, null or empty User is refused with userNotTaken, whatever its type.
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which addressing fields a
 * provider reads by the `config.<field>` pattern, and this file reads config.host, config.port, config.user,
 * config.password, config.database and config.schema as written.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  type GrpcConfigWords,
  type GrpcTlsOptions,
  grpcEndpointHost,
  grpcTarget,
  grpcTlsIdentity,
  readGrpcTlsPanel,
} from "@/lib/db/grpc/tls";
import { plaintextSecretRefusal, validatePort } from "@/lib/db/http/endpoint";
import { secretForms } from "@/lib/db/utils/server-text";
import {
  type DatabaseConnection,
  type SSHTunnelConfig,
  TUNNEL_FAR_END,
  type TunnelFarEnd,
  type WithTunnelFarEnd,
} from "@/lib/types";
import { SPARK_DEFAULT_PORT, SPARK_IP_SERVER_NAME } from "./constants";
import type { SparkErrorConnection } from "./errors";
import { parseNamespaceSpelling, SPARK_CATALOG_PATTERN, SPARK_TOKEN_PATTERN } from "./namespace";

export interface SparkConnectionOptions {
  /** `dns:<host>:<port>` from the validated parts; the local forward under a tunnel. */
  target: string;
  /** The endpoint as configured (the far end under a tunnel), bare host; what sentences name. */
  endpoint: { host: string; port: number };
  tls?: GrpcTlsOptions;
  token?: string;
  catalog?: string;
  /** The Namespace field's parts, read by parseNamespaceSpelling. */
  namespace?: readonly string[];
  callTimeoutMs: number;
  /** The token's forms, which serverText withholds from every sentence. */
  secretForms: readonly string[];
}

/**
 * The field refusals; hostEmpty, tokenCharacters, catalogFormat, namespaceFormat and userNotTaken end with
 * "Nothing was sent.". src/lib/db-ui-config.ts copies
 * hostEmpty, tokenCharacters, catalogFormat and namespaceFormat literally into SPARK_FIELD_RULES, and
 * tests/unit/lib/db-ui-config.test.ts holds each copy equal to these.
 */
export const SPARK_FIELD_SENTENCES = Object.freeze({
  hostEmpty:
    "Host is required: the name or address of the Spark Connect server, or of the TLS proxy in front of it. Nothing was sent.",
  tokenCharacters:
    "Token takes printable ASCII with no space at either end: a gRPC header cannot carry other characters, and Spark compares the token exactly. Nothing was sent.",
  catalogFormat: "Catalog takes one catalog name without dots, as spark.sql.catalog.<name> names it. Nothing was sent.",
  namespaceFormat:
    "Namespace takes a Spark SQL namespace: parts joined by dots, each a letter or _ followed by letters, digits or _, or written in backticks with a backtick doubled; at most 8 parts. Nothing was sent.",
  userNotTaken:
    "Apache Spark connections take no user: every Studio request uses one fixed Spark Connect user id, and Token is the credential. Clear User. Nothing was sent.",
  tunnelNotOpened:
    "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so Apache Spark was not dialled directly: the tunnel opens only when both Host and Port are set.",
  queryTimeout: "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
});

const MAX_QUERY_TIMEOUT_MS = 2_147_483_647;
/** What the shared TLS panel reader words its refusals with: Spark's name and Spark's own errors. */
const WORDS: GrpcConfigWords = { engine: "Apache Spark", refuse: configError, wrongType };

/** Throws DatabaseConfigError for every refusal of the connection's fields and its TLS panel; never echoes a value. */
export function buildSparkConnectionOptions(
  config: DatabaseConnection & WithTunnelFarEnd,
  context: { readonly queryTimeout: number },
): SparkConnectionOptions {
  const farEnd = tunnelFarEnd(config);
  if (
    config.host === undefined ||
    config.host === null ||
    (typeof config.host === "string" && config.host.trim() === "")
  ) {
    throw configError(SPARK_FIELD_SENTENCES.hostEmpty);
  }
  const targetHost = grpcEndpointHost(config.host, WORDS);
  const targetPort = shared(() => validatePort(config.port ?? SPARK_DEFAULT_PORT));
  const endpoint =
    farEnd === undefined
      ? { host: targetHost, port: targetPort }
      : { host: grpcEndpointHost(farEnd.host, WORDS), port: shared(() => validatePort(farEnd.port)) };
  // Any User but an absent, null or empty one, whatever its type: Spark Connect's identity is fixed.
  if (config.user !== undefined && config.user !== null && config.user !== "") {
    throw configError(SPARK_FIELD_SENTENCES.userNotTaken);
  }
  const token = optionalText(config.password, "password");
  if (token !== undefined && !SPARK_TOKEN_PATTERN.test(token)) throw configError(SPARK_FIELD_SENTENCES.tokenCharacters);
  const catalog = optionalName(config.database, "database")?.trim();
  if (catalog !== undefined && !SPARK_CATALOG_PATTERN.test(catalog)) {
    throw configError(SPARK_FIELD_SENTENCES.catalogFormat);
  }
  const namespaceText = optionalName(config.schema, "schema");
  const namespace = namespaceText === undefined ? undefined : parseNamespaceSpelling(namespaceText);
  if (namespaceText !== undefined && namespace === undefined) {
    throw configError(SPARK_FIELD_SENTENCES.namespaceFormat);
  }
  const material = readGrpcTlsPanel(config.ssl, WORDS);
  const tls = material === undefined ? undefined : grpcTlsIdentity(material, endpoint.host, SPARK_IP_SERVER_NAME);
  const plaintext = plaintextSecretRefusal({
    host: endpoint.host,
    tunnelled: farEnd !== undefined,
    tls: tls !== undefined,
    hasSecret: token !== undefined,
    secretLabel: "token",
  });
  if (plaintext !== undefined) throw configError(plaintext);
  return {
    target: grpcTarget(targetHost, targetPort),
    endpoint,
    ...(tls === undefined ? {} : { tls }),
    ...(token === undefined ? {} : { token }),
    ...(catalog === undefined ? {} : { catalog }),
    ...(namespace === undefined ? {} : { namespace }),
    callTimeoutMs: callTimeout(context.queryTimeout),
    secretForms: secretForms(token === undefined ? [] : [token]),
  };
}

/** The facts errors.ts words its sentences with: the configured endpoint and the secret forms. */
export function sparkErrorConnection(options: SparkConnectionOptions): SparkErrorConnection {
  return { host: options.endpoint.host, port: options.endpoint.port, secretForms: options.secretForms };
}

function tunnelFarEnd(config: DatabaseConnection & WithTunnelFarEnd): TunnelFarEnd | undefined {
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel");
  const enabled = optionalBoolean(tunnel?.enabled, "sshTunnel.enabled") === true;
  const farEnd = config[TUNNEL_FAR_END];
  if (enabled && farEnd === undefined) throw configError(SPARK_FIELD_SENTENCES.tunnelNotOpened);
  return farEnd;
}

/** The shared validators refuse with a DatabaseConfigError that names no provider; re-raised as Spark's. */
function shared<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw configError((error as Error).message);
  }
}

function callTimeout(queryTimeout: number): number {
  if (!Number.isInteger(queryTimeout) || queryTimeout < 1 || queryTimeout > MAX_QUERY_TIMEOUT_MS) {
    throw configError(SPARK_FIELD_SENTENCES.queryTimeout);
  }
  return queryTimeout;
}

/** A text field: absent, null and "" read as absent; any other type is refused naming the field. */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw wrongType(field, "a string");
  return value;
}

/** Catalog or Namespace: blank, white space only included, reads as absent; any other text is kept as written. */
function optionalName(value: unknown, field: string): string | undefined {
  const text = optionalText(value, field);
  return text === undefined || text.trim() === "" ? undefined : text;
}

function optionalObject<Key extends string>(value: unknown, field: string): Partial<Record<Key, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw wrongType(field, "an object");
  return value as Partial<Record<Key, unknown>>;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw wrongType(field, "true or false");
  return value;
}

function wrongType(field: string, expected: string): DatabaseConfigError {
  return configError(`The connection's ${field} must be ${expected}; nothing was sent.`);
}

function configError(message: string): DatabaseConfigError {
  return new DatabaseConfigError(message, "spark");
}
