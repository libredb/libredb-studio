/**
 * Maps a saved connection to the client's options (spec 6.1), after the checks of
 * spec 3.6 K1 and K3. Pure: no socket opens here.
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
import type { DatabaseConnection } from "@/lib/types";
import { validateHost, validatePort } from "@/lib/db/http/endpoint";
import { KafkaError } from "./client";

export type KafkaSaslMechanism = "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512";

const KAFKA_SASL_MECHANISMS: readonly KafkaSaslMechanism[] = Object.freeze(["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"]);

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
  if (config.sshTunnel?.enabled === true) {
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
  const ssl = config.ssl;
  if (ssl === undefined || ssl.mode === "disable") return undefined;
  return {
    ...(ssl.caCert ? { ca: ssl.caCert } : {}),
    ...(ssl.clientCert ? { cert: ssl.clientCert } : {}),
    ...(ssl.clientKey ? { key: ssl.clientKey } : {}),
    rejectUnauthorized: ssl.rejectUnauthorized ?? ssl.mode !== "require",
  };
}

function saslOptions(config: DatabaseConnection, tlsOn: boolean): KafkaSaslOptions | undefined {
  const mechanism = config.saslMechanism;
  const username = config.user ?? "";
  const password = config.password ?? "";
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
