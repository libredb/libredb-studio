/**
 * Where a Db2 connection goes and how it gets there (#786).
 *
 * THE TRANSPORT FAILS CLOSED. Without TLS, db2-node 1.0.22 downgrades every security mechanism to
 * SECMEC 3 in silence and sends the password in cleartext, even when an encrypted mechanism is
 * asked for (K11). A connection with no TLS is therefore REFUSED unless it carries
 * `allowInsecureAuth: true`, an explicit acceptance of that risk; the form shows it as a warning
 * checkbox, and the refusal lives here so that a stored connection, a seed or an embedding host
 * meets the same rule as the form.
 *
 * A stored `db2://` URL and the structured fields are read into one target with one precedence:
 * the URL's fields win over the form's, except the dial address while an SSH tunnel is open,
 * which is always the tunnel's local end. The URL's TLS parameters and `config.ssl` must agree,
 * and a parameter this provider does not read is an error rather than something dropped.
 *
 * The CA certificate arrives as PEM text and db2-node wants a FILE PATH, so it is written to a
 * private temporary directory for the life of the connection and removed on disconnect and on a
 * failed connect.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUNNEL_FAR_END, type DatabaseConnection, type SSLMode, type WithTunnelFarEnd } from "@/lib/types";
import { parseConnectionString } from "@/lib/connection-string-parser";
import { ConnectionError, DatabaseConfigError } from "../../../errors";
import { type Db2Client, type Db2ClientOptions, type Db2Driver, describeDriverAbsence, loadDb2Driver } from "./driver";

/** Db2 LUW's registered port, and the form's default. */
export const DB2_DEFAULT_PORT = 50000;

/** The query parameters a `db2://` URL may carry: its two TLS spellings, and nothing else. */
const URL_PARAMETERS = new Set(["ssl", "security"]);

/** Everything a connect needs, resolved from the connection and checked. */
export interface Db2Target {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Absent when neither the URL nor `config.ssl` asked for TLS. */
  tls?: SSLMode;
  /** The CA certificate as PEM text, when one was given and the mode verifies a chain. */
  caPem?: string;
}

/** The connection a provider holds, as the factory may hand it over: through a tunnel or not. */
export type Db2Connection = DatabaseConnection & WithTunnelFarEnd;

/** The fields a `db2://` URL supplies, after its own checks. */
function readConnectionString(connectionString: string): {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  tls?: SSLMode;
} {
  const parsed = parseConnectionString(connectionString);
  if (!connectionString.trim().startsWith("db2://")) {
    throw new DatabaseConfigError("A Db2 connection string must start with db2://", "db2");
  }
  if (parsed === null) throw new DatabaseConfigError("The Db2 connection string is not a valid URL", "db2");
  const names = [...new URL(connectionString.trim()).searchParams.keys()].map((name) => name.toLowerCase());
  const unread = names.find((name) => !URL_PARAMETERS.has(name));
  if (unread !== undefined) {
    throw new DatabaseConfigError(
      `A Db2 connection string carries the parameter "${unread}", which this provider does not read; remove it, ` +
        "or set what it asks for in the connection's own fields.",
      "db2",
    );
  }
  if (names.includes("ssl") && names.includes("security")) {
    throw new DatabaseConfigError(
      "A Db2 connection string carries both ssl and security; keep the one that says what you mean.",
      "db2",
    );
  }
  if (parsed.unmappedTLSParam !== undefined) {
    throw new DatabaseConfigError(
      `The Db2 connection string's TLS parameter "${parsed.unmappedTLSParam}" names no mode this provider can ` +
        "honour; use ssl=true, ssl=false or security=SSL, or set the mode under SSL / TLS.",
      "db2",
    );
  }
  return {
    host: parsed.host,
    port: parsed.port === undefined ? undefined : Number(parsed.port),
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    tls: parsed.sslMode,
  };
}

/**
 * The connection read into one target, refusing what this provider cannot honour.
 *
 * Sync and socket-free, so `validate()` can run it at construction. The transport rules that
 * depend on HOW the connection is reached (TLS present, tunnel open) are `assertTransport`'s,
 * run at connect, because a provider is also constructed with no intent to connect, to read
 * its capabilities.
 */
export function resolveTarget(config: Db2Connection): Db2Target {
  const ssl = config.ssl;
  if (ssl?.clientCert || ssl?.clientKey) {
    throw new DatabaseConfigError(
      "db2-node 1.0.22 has no client-certificate authentication; remove the client certificate and key from this " +
        "Db2 connection.",
      "db2",
    );
  }

  const url = config.connectionString ? readConnectionString(config.connectionString) : {};
  const tunnelled = config[TUNNEL_FAR_END] !== undefined;
  // Through a tunnel the dial address is the tunnel's local end, which the factory wrote into
  // `host` and `port`. Re-reading the URL's own address there would dial the far end directly,
  // around the tunnel, with a cleartext-capable driver.
  const host = tunnelled ? config.host : (url.host ?? config.host);
  const port = tunnelled ? config.port : (url.port ?? config.port);
  const database = url.database ?? config.database;
  if (!host) throw new DatabaseConfigError("Host is required for Db2", "db2");
  if (!database) throw new DatabaseConfigError("Database name is required for Db2", "db2");
  const user = url.user ?? config.user;
  if (!user) throw new DatabaseConfigError("User is required for Db2", "db2");

  const structured = ssl?.mode;
  if (structured !== undefined && url.tls !== undefined && structured !== url.tls) {
    throw new DatabaseConfigError(
      `This Db2 connection asks for TLS mode "${structured}" under SSL / TLS and "${url.tls}" in its connection ` +
        "string; make the two agree.",
      "db2",
    );
  }
  const tls = structured ?? url.tls;
  const verifiesChain = tls === "verify-ca" || tls === "verify-full";
  // verify-ca sends `sslClientHostnameValidation: "OFF"`, so with no CA of its own it would take
  // any certificate the system trust store chains, issued for any name, and hand it the password.
  if (tls === "verify-ca" && !ssl?.caCert) {
    throw new DatabaseConfigError(
      'TLS mode "verify-ca" checks the certificate against a CA and not the server\'s name, so it needs the ' +
        "server's CA certificate under SSL / TLS; without one, use verify-full or verify-system.",
      "db2",
    );
  }

  return {
    host,
    port: port ?? DB2_DEFAULT_PORT,
    database,
    user,
    password: url.password ?? config.password ?? "",
    ...(tls === undefined ? {} : { tls }),
    ...(verifiesChain && ssl?.caCert ? { caPem: ssl.caCert } : {}),
  };
}

/** The modes whose check compares the certificate with the name the driver dials. */
const CHECKS_HOST_NAME = new Set<SSLMode>(["verify-system", "verify-full"]);

/**
 * The transport rules, checked before any socket opens.
 *
 * No TLS without the explicit opt-in (K11). A tunnel the factory did not open is refused rather
 * than dialled around. And through a tunnel, a mode that checks the server's NAME is refused:
 * db2-node 1.0.22 has no option for the name to check, so it checks the certificate against the
 * address it dials, which is the tunnel's local end and not the server's own name.
 */
export function assertTransport(config: Db2Connection, target: Db2Target): void {
  if ((target.tls === undefined || target.tls === "disable") && config.allowInsecureAuth !== true) {
    throw new DatabaseConfigError(
      "This Db2 connection has no TLS, and without TLS db2-node 1.0.22 sends the password to the server in " +
        'cleartext whatever security mechanism is asked for. Turn TLS on under SSL / TLS, or tick "Send the ' +
        'password without TLS" to accept that risk for this connection.',
      "db2",
    );
  }
  const farEnd = config[TUNNEL_FAR_END];
  if (config.sshTunnel?.enabled === true && farEnd === undefined) {
    throw new DatabaseConfigError(
      "This Db2 connection asks for an SSH tunnel and none was opened for it, so it is not dialled directly; " +
        "fill in Host and Port, which the tunnel forwards to.",
      "db2",
    );
  }
  if (farEnd !== undefined && target.tls !== undefined && CHECKS_HOST_NAME.has(target.tls)) {
    throw new DatabaseConfigError(
      `TLS mode "${target.tls}" checks the server's name, and through an SSH tunnel db2-node 1.0.22 can only check ` +
        `the tunnel's local address rather than ${farEnd.host}. Use verify-ca with the server's CA certificate ` +
        "through a tunnel.",
      "db2",
    );
  }
}

/**
 * The five characters db2-node 1.0.22 cannot carry in a password (K23).
 *
 * They are exactly the printable ASCII characters EBCDIC code page 037 places differently from
 * code page 500, so the server reads a different password from the one typed. Measured on Db2
 * 12.1.0.0, with and without TLS: each of the five is rejected as "user id or password invalid",
 * `credentialEncoding: "utf8"` does not change that, the IBM CLP signs in over TCP with the same
 * password, and every other printable ASCII character tried is accepted. The section 4 note in
 * `docs/providers/db2.md` has the full matrix.
 */
const UNSENDABLE_PASSWORD_CHARACTERS = new Set(["!", "[", "]", "^", "|"]);

/**
 * Refuses a password the driver would send wrongly, before any socket opens.
 *
 * Without this the server's answer is "user id or password invalid", which sends a person to
 * check a password that is right. The refusal names the characters and never the password.
 */
export function assertPasswordSendable(target: Db2Target): void {
  const found = [...new Set([...target.password].filter((character) => UNSENDABLE_PASSWORD_CHARACTERS.has(character)))];
  if (found.length === 0) return;
  throw new DatabaseConfigError(
    `This Db2 password contains ${found.join(" and ")}, which db2-node 1.0.22 does not send correctly: the server ` +
      "would reject it as a wrong password even though it is right. Change the password of this Db2 user to one " +
      "without ! [ ] ^ or |, and use the new password here.",
    "db2",
  );
}

/**
 * The driver options for one target, per the TLS table in `docs/providers/db2.md`. Neither
 * `queryTimeout`, `currentSchema` nor `securityMechanism` is ever set (M6, M4, K11).
 */
export function clientOptions(target: Db2Target, caFile?: string): Db2ClientOptions {
  const base = {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
  };
  const ca = caFile === undefined ? {} : { caCert: caFile };
  switch (target.tls) {
    case undefined:
    case "disable":
      return { ...base, ssl: false };
    case "require":
      return { ...base, ssl: true, rejectUnauthorized: false };
    case "verify-system":
      return { ...base, ssl: true, rejectUnauthorized: true };
    case "verify-ca":
      return { ...base, ssl: true, rejectUnauthorized: true, sslClientHostnameValidation: "OFF", ...ca };
    case "verify-full":
      return { ...base, ssl: true, rejectUnauthorized: true, sslClientHostnameValidation: "Basic", ...ca };
  }
}

/** The three file operations the CA file needs, injectable so a test can reach every line. */
export interface CaFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

export const NODE_CA_FILE_SYSTEM: CaFileSystem = { mkdtemp, writeFile, rm };

/**
 * The PEM written to `ca.pem` in a fresh private directory (mkdtemp creates it 0700), the file
 * itself 0600. On Windows the mode bits do not apply and the per-user ACL on the temp directory
 * keeps it private. A failed write removes the directory before the error goes on.
 */
export async function writeCaFile(
  pem: string,
  fs: CaFileSystem = NODE_CA_FILE_SYSTEM,
): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(join(tmpdir(), "libredb-db2-"));
  const file = join(dir, "ca.pem");
  try {
    await fs.writeFile(file, pem, { mode: 0o600 });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, file };
}

/** One open client and the directory to remove when it closes. */
export interface OpenedClient {
  client: Db2Client;
  caDir?: string;
}

/**
 * The driver loaded, the client built and connected.
 *
 * A failed connect removes the CA directory and answers `Failed to connect to Db2: <reason>`,
 * except the driver's own absence, which keeps its message: it names the remedy.
 */
export async function openClient(
  config: Db2Connection,
  load: () => Promise<Db2Driver> = loadDb2Driver,
  fs: CaFileSystem = NODE_CA_FILE_SYSTEM,
): Promise<OpenedClient> {
  const target = resolveTarget(config);
  assertTransport(config, target);
  assertPasswordSendable(target);
  const driver = await load();
  const ca = target.caPem === undefined ? undefined : await writeCaFile(target.caPem, fs);
  try {
    const client = new driver.Client(clientOptions(target, ca?.file));
    await client.connect();
    return { client, ...(ca === undefined ? {} : { caDir: ca.dir }) };
  } catch (error) {
    if (ca !== undefined) await fs.rm(ca.dir, { recursive: true, force: true });
    const absence = describeDriverAbsence(error);
    if (absence) throw absence;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConnectionError(`Failed to connect to Db2: ${reason}`, "db2", target.host, target.port);
  }
}
