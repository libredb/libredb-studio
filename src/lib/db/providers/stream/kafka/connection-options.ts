/**
 * Maps a saved connection to the client's options (spec 6.1), after the checks of
 * spec 3.6 K1 and K3. Pure: no socket opens here.
 *
 * Every field read here is checked before it is used, because a connection sent to the API
 * arrives as the caller wrote it (`resolveConnection` hands an inline connection on untouched)
 * and the client checks none of it: its SCRAM step reads the user as a string inside its socket
 * handler, where a number throws past every caller and ends a Node process that handles no
 * uncaught exception, and its PLAIN step joins the credential into text, so `["reader"]` would
 * authenticate as `reader`. The host and port go through the shared validators, the mechanism
 * through its list, and every other field is refused, naming the field and never its value, when
 * it is not the type `DatabaseConnection` declares for it; a null reads as absent, as a JSON body
 * writes an absent field.
 *
 * The TLS rule `rejectUnauthorized = ssl.rejectUnauthorized ?? ssl.mode !== "require"`
 * is the Couchbase mapping, written again here rather than imported, because the
 * isolation rule forbids importing another provider (spec 3.5). docs/BACKLOG.md D37
 * names this copy.
 *
 * The parameter is named `config` in every function here on purpose: the db-ui-config
 * test finds which addressing fields a provider reads by the `config.<field>` pattern.
 */
import { isIP } from "node:net";
import type { DatabaseConnection, SSHTunnelConfig, SSLConfig, SSLMode } from "@/lib/types";
import { validateHost, validatePort } from "@/lib/db/http/endpoint";
import { KafkaError } from "./client";

export type KafkaSaslMechanism = "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512";

const KAFKA_SASL_MECHANISMS: readonly KafkaSaslMechanism[] = Object.freeze(["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"]);

/** Every mode `SSLMode` names: a record, so a mode added there fails the typecheck here until this mapping answers for it. */
const KAFKA_TLS_MODES: Readonly<Record<SSLMode, true>> = Object.freeze({
  disable: true,
  require: true,
  "verify-system": true,
  "verify-ca": true,
  "verify-full": true,
});

export const KAFKA_DEFAULT_PORT = 9092;

const CLIENT_ID = "libredb-studio";

/** CR, LF and NUL cannot travel in a SASL exchange, and trimming them silently would send a different secret. */
const FORBIDDEN_IN_CREDENTIAL = /[\r\n\0]/;

export interface KafkaTlsOptions {
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
  readonly rejectUnauthorized: boolean;
}

export interface KafkaSaslOptions {
  readonly mechanism: KafkaSaslMechanism;
  readonly username: string;
  readonly password: string;
}

export interface KafkaConnectionOptions {
  readonly clientId: string;
  readonly broker: { readonly host: string; readonly port: number };
  readonly tls?: KafkaTlsOptions;
  /**
   * Present when TLS is on and the bootstrap host is a DNS name: the client then sends each
   * connection's own host as its TLS server name (SNI). Node sends none unless asked, and an
   * IP literal is not a legal server name (spec 6.1).
   */
  readonly tlsServerName?: true;
  readonly sasl?: KafkaSaslOptions;
  readonly timeoutMs: number;
}

export function kafkaConnectionOptions(config: DatabaseConnection, timeoutMs: number): KafkaConnectionOptions {
  // The server opens a tunnel for any `enabled` JavaScript reads as true (src/lib/db/factory.ts),
  // so a value that is not a boolean is refused rather than read as no tunnel, and so is a tunnel
  // that is not an object, as a TLS panel that is not one is.
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel");
  if (optionalBoolean(tunnel?.enabled, "sshTunnel.enabled") === true) {
    throw new KafkaError(
      "invalid-config",
      "Kafka does not run through an SSH tunnel: the tunnel forwards one address, and a Kafka client reads from every broker the cluster advertises, at the address the broker advertises. Connect to the brokers directly",
    );
  }
  // validateHost answers an IPv6 literal bracketed, which is the URL form; the client
  // takes a separate host and port, where the brackets would be part of the name.
  const host = validateHost(config.host).replace(/^\[(.*)\]$/, "$1");
  const port = validatePort(config.port ?? KAFKA_DEFAULT_PORT);
  const tls = tlsOptions(config);
  const sasl = saslOptions(config, tls !== undefined);
  return {
    clientId: CLIENT_ID,
    broker: { host, port },
    ...(tls === undefined ? {} : { tls }),
    ...(tls !== undefined && isIP(host) === 0 ? { tlsServerName: true as const } : {}),
    ...(sasl === undefined ? {} : { sasl }),
    timeoutMs,
  };
}

function tlsOptions(config: DatabaseConnection): KafkaTlsOptions | undefined {
  // The whole panel is checked, whatever its mode, before any of it is read.
  const panel = optionalObject<keyof SSLConfig>(config.ssl, "ssl");
  if (panel === undefined) return undefined;
  const mode = panel.mode;
  // A panel with no mode reads as a verifying one, as every provider with the Couchbase rule reads
  // it: a seed file's panel may omit the mode (src/lib/seed/types.ts).
  if (mode !== undefined && mode !== null && !(typeof mode === "string" && Object.hasOwn(KAFKA_TLS_MODES, mode))) {
    throw wrongType("ssl.mode", "disable, require, verify-system, verify-ca or verify-full");
  }
  const ca = optionalString(panel.caCert, "ssl.caCert");
  const cert = optionalString(panel.clientCert, "ssl.clientCert");
  const key = optionalString(panel.clientKey, "ssl.clientKey");
  const rejectUnauthorized = optionalBoolean(panel.rejectUnauthorized, "ssl.rejectUnauthorized");
  if (mode === "disable") return undefined;
  return {
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
    rejectUnauthorized: rejectUnauthorized ?? mode !== "require",
  };
}

function saslOptions(config: DatabaseConnection, tlsOn: boolean): KafkaSaslOptions | undefined {
  const mechanism = config.saslMechanism;
  const username = optionalString(config.user, "user") ?? "";
  const password = optionalString(config.password, "password") ?? "";
  if (mechanism === undefined) {
    if (username !== "" || password !== "") {
      throw new KafkaError(
        "invalid-config",
        "A Kafka user or password needs a SASL mechanism: choose PLAIN or SCRAM, or clear both fields",
      );
    }
    return undefined;
  }
  if (!KAFKA_SASL_MECHANISMS.includes(mechanism)) {
    throw new KafkaError("invalid-config", "The SASL mechanism must be PLAIN, SCRAM-SHA-256 or SCRAM-SHA-512");
  }
  if (!tlsOn) {
    throw new KafkaError(
      "invalid-config",
      `${mechanism} requires TLS: without it the credential or the session travels in the clear. Turn TLS on for this connection`,
    );
  }
  for (const [field, value] of [
    ["user", username],
    ["password", password],
  ] as const) {
    if (FORBIDDEN_IN_CREDENTIAL.test(value)) {
      throw new KafkaError(
        "invalid-config",
        `The ${field} contains a line break or NUL, which SASL cannot carry; nothing was sent`,
      );
    }
  }
  return { mechanism, username, password };
}

/** A field that holds an object when it is present, never an array; null reads as absent (the file header). */
function optionalObject<Key extends string>(value: unknown, field: string): Partial<Record<Key, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw wrongType(field, "an object");
  return value as Partial<Record<Key, unknown>>;
}

/** A field that holds a string when it is present; null reads as absent (the file header). */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw wrongType(field, "a string");
  return value;
}

/** A field that holds a boolean when it is present; null reads as absent (the file header). */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw wrongType(field, "true or false");
  return value;
}

/** Names the field and what it must be, never the value it holds, which can be a credential. */
function wrongType(field: string, expected: string): KafkaError {
  return new KafkaError("invalid-config", `The connection's ${field} must be ${expected}; nothing was sent`);
}
