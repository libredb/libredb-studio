/**
 * The one `GraphClient` implementation: neo4j-driver-lite 6.2.0 with a fixed, audited
 * configuration (Neo4j provider spec 3.3, revisions SR13, SR16, SR21).
 *
 * Every statement runs through `session.run` in a READ session: an auto-commit
 * transaction that the driver never retries once `disableAutoCommitRetries` is set.
 * The transaction functions and `driver.executeQuery` re-run their work on transient
 * errors, so a statement could reach the server twice; this file never calls them, and
 * the seam guard keeps it so. No logger is configured (at debug level the driver logs
 * every statement and row), telemetry is off, and no resolver is installed.
 *
 * Driver configuration, exactly: telemetry off, the caller's user agent, the connection
 * timeout for both the socket and pool acquisition, a pool of four, no transaction
 * retry time, lossless Integers (record-values.ts converts them), and notifications
 * off, since the provider reads no notification.
 *
 * A custom CA (K2): 6.2.0 reads `trustedCertificates` as FILE PATHS
 * (neo4j-driver-bolt-connection/lib/channel/node/node-channel.js hands each entry to
 * `fs.readFileSync` on every connection) and refuses a trust setting next to a `+s`
 * scheme. So the PEM is written to `<os.tmpdir()>/libredb-neo4j-ca/<sha256 of the PEM>.pem`
 * with mode 0600, in a directory of mode 0700 that must belong to this process's user
 * and be writable by no one else, and reused while its content is the PEM's; the URI
 * becomes `bolt://` with `encrypted` on and `TRUST_CUSTOM_CA_SIGNED_CERTIFICATES`. The
 * driver then verifies the chain against that CA and Node verifies the hostname, so
 * `verify-ca` behaves as `verify-full` (the provider doc says so). A CA certificate is
 * public material; the file mode keeps it from being replaced, not from being read.
 *
 * Cancellation is Neo4j's own: closing the session cancels its result and resets the
 * connection, and the server ends the transaction (measured: `session.close()` returns
 * in 1 to 3 ms and the transaction leaves `SHOW TRANSACTIONS` within 1.5 s, SR22). A
 * client timer one second past the Bolt transaction timeout does the same when the
 * server has not ended the statement itself.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import neo4j, { type AuthToken, type Config, type SessionMode } from "neo4j-driver-lite";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import {
  type BoltClientConfig,
  type GraphClient,
  GraphClientError,
  type GraphClientErrorCategory,
  type GraphClientFactory,
  type GraphQueryType,
  type GraphRunOptions,
  type GraphRunResult,
  type GraphServerInfo,
} from "./client";
import { boundedJsonCell, MAX_CELL_DEPTH, setOwn } from "./record-values";

/** The narrow shape of a driver record this file reads: its keys, and a value by position. */
export interface BoltRecord {
  readonly keys: readonly PropertyKey[];
  get(index: number): unknown;
}

export interface BoltResult extends AsyncIterable<BoltRecord> {
  keys(): Promise<readonly PropertyKey[]>;
  summary(): Promise<{ readonly queryType: string }>;
}

export interface BoltSession {
  run(
    statement: string,
    parameters: undefined,
    config: { timeout: number; metadata?: Readonly<Record<string, string>> },
  ): BoltResult;
  close(): Promise<void>;
}

export interface BoltDriver {
  verifyConnectivity(): Promise<unknown>;
  getServerInfo(): Promise<{
    readonly address?: string;
    readonly agent?: string;
    readonly protocolVersion?: { getMajor(): number; getMinor(): number };
  }>;
  session(config: { database?: string; defaultAccessMode: SessionMode; fetchSize: number }): BoltSession;
  close(): Promise<void>;
}

/** The members of the driver module this file uses; tests pass a fake with the same shape. */
export interface BoltDriverModule {
  driver(uri: string, auth: AuthToken | undefined, config: Config): BoltDriver;
  readonly auth: { basic(user: string, password: string): AuthToken };
  readonly session: { readonly READ: SessionMode };
}

const BOLT_SCHEME = /^(bolt|bolt\+s|bolt\+ssc):\/\//;
const CA_DIRECTORY = "libredb-neo4j-ca";
/** The driver pulls at most this many records per batch however large `maxRows` is. */
const MAX_FETCH_SIZE = 1000;
/** The client's own timer fires this long after the Bolt transaction timeout. */
const TIMER_GRACE_MS = 1000;

const QUERY_TYPES: ReadonlySet<string> = new Set<GraphQueryType>(["r", "rw", "w", "s"]);
const SOCKET_CODES = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"];
const TLS_MARKERS = ["self-signed", "self signed", "CERT_", "certificate", "ERR_TLS"];

/**
 * Whether the CA directory is this user's own, with no other user able to write into it.
 *
 * On POSIX that is its owner and its group and other write bits. Windows has neither: `lstat` reports
 * every directory as mode 0o40666 and there is no process uid, so the bits would refuse every directory;
 * the directory sits in the user's own temp directory, whose ACL is the protection there, and only its
 * shape is checked.
 */
export function caDirectoryIsPrivate(
  stat: { readonly mode: number; readonly uid: number; isDirectory(): boolean },
  uid: number | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (!stat.isDirectory()) return false;
  if (platform === "win32") return true;
  return (uid === undefined || stat.uid === uid) && (stat.mode & 0o022) === 0;
}

/**
 * The CA's file, written on first use (see the file header). Throws when the directory
 * is not this user's private directory or the file holds other content.
 */
function trustedCertificateFile(pem: string): string {
  const dir = join(tmpdir(), CA_DIRECTORY);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!caDirectoryIsPrivate(lstatSync(dir), process.getuid?.(), process.platform)) {
    throw new GraphClientError(
      "tls",
      `The CA certificate directory ${dir} is not a directory owned by this user, or is writable by other users, so the CA was not written there`,
    );
  }
  const file = join(dir, `${createHash("sha256").update(pem).digest("hex")}.pem`);
  // One step, no check before it: `wx` creates the file or fails because it exists, so nothing can place a
  // file between a check and the write. An existing file is then read and must hold exactly this PEM.
  try {
    writeFileSync(file, pem, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(file, "utf8") !== pem) {
      throw new GraphClientError("tls", `The file ${file} does not hold the CA certificate its name stands for`);
    }
  }
  return file;
}

function driverArguments(config: BoltClientConfig): { uri: string; driverConfig: Config } {
  if (!BOLT_SCHEME.test(config.uri)) {
    throw new GraphClientError("connection", "The Bolt URI must use bolt://, bolt+s:// or bolt+ssc://");
  }
  const driverConfig: Config = {
    telemetryDisabled: true,
    userAgent: config.userAgent,
    connectionTimeout: config.connectionTimeoutMs,
    connectionAcquisitionTimeout: config.connectionTimeoutMs,
    maxConnectionPoolSize: 4,
    maxTransactionRetryTime: 0,
    disableAutoCommitRetries: true,
    disableLosslessIntegers: false,
    useBigInt: false,
    notificationFilter: { minimumSeverityLevel: "OFF" },
  };
  if (config.trustedCertificatePem === undefined) return { uri: config.uri, driverConfig };

  if (!config.uri.startsWith("bolt+s://")) {
    throw new GraphClientError("tls", "A custom CA certificate needs a bolt+s:// URI");
  }
  return {
    uri: config.uri.replace(/^bolt\+s:/, "bolt:"),
    driverConfig: {
      ...driverConfig,
      encrypted: "ENCRYPTION_ON",
      trust: "TRUST_CUSTOM_CA_SIGNED_CERTIFICATES",
      trustedCertificates: [trustedCertificateFile(config.trustedCertificatePem)],
    },
  };
}

function categoryOfServerCode(code: string): GraphClientErrorCategory {
  if (code === "Neo.ClientError.Security.Forbidden" || code === "Neo.ClientError.Statement.AccessMode") {
    return "access-mode";
  }
  if (code.startsWith("Neo.ClientError.Security.")) return "auth";
  if (code === "Neo.ClientError.Statement.SyntaxError") return "syntax";
  if (code.startsWith("Neo.ClientError.Transaction.TransactionTimedOut")) return "timeout";
  if (code === "Neo.ClientError.Transaction.Terminated") return "cancelled";
  return "query";
}

/** A driver, socket or server failure as a classified GraphClientError, keeping the server's message. */
function toGraphClientError(error: unknown): GraphClientError {
  if (error instanceof GraphClientError) return error;
  const fields = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const message = typeof fields.message === "string" ? fields.message : String(error);
  const code = typeof fields.code === "string" ? fields.code : undefined;

  // A server status code decides alone: its message is the server's text, which can
  // quote the statement, so words in it say nothing about the transport.
  if (code?.startsWith("Neo.")) return new GraphClientError(categoryOfServerCode(code), message, code);

  const text = `${code ?? ""} ${message}`;
  let category: GraphClientErrorCategory = "query";
  if (TLS_MARKERS.some((marker) => text.includes(marker))) {
    category = "tls";
  } else if (
    code === "ServiceUnavailable" ||
    code === "SessionExpired" ||
    SOCKET_CODES.some((socket) => text.includes(socket)) ||
    (typeof fields.gqlStatus === "string" && fields.gqlStatus.startsWith("08"))
  ) {
    category = "connection";
  }
  return new GraphClientError(category, message, code);
}

function warningFor(column: string, replaced: "size" | "depth"): string {
  return replaced === "size"
    ? `A value in column ${column} was larger than 1 MiB as JSON and was replaced by its size.`
    : `A value in column ${column} was nested deeper than ${MAX_CELL_DEPTH} levels and was replaced.`;
}

async function readResult(result: BoltResult, maxRows: number): Promise<GraphRunResult> {
  const rows: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const warned = new Set<string>();
  let fields: string[] | undefined;
  let truncated = false;

  for await (const record of result) {
    // Neo4j refuses two output columns of one name but answers an empty one (`RETURN 1 AS \`\``, measured on
    // 5.26), so the names go through `uniqueFieldNames`; each value is read by position below.
    fields ??= uniqueFieldNames(record.keys.map(String));
    if (rows.length === maxRows) {
      truncated = true;
      break;
    }
    const row: Record<string, unknown> = {};
    fields.forEach((field, index) => {
      const cell = boundedJsonCell(record.get(index));
      setOwn(row, field, cell.value);
      if (cell.replaced !== undefined && !warned.has(field)) {
        warned.add(field);
        warnings.push(warningFor(field, cell.replaced));
      }
    });
    rows.push(row);
  }

  // Reading the summary drains the stream, so a cut result never asks for it.
  const queryType = truncated ? undefined : (await result.summary()).queryType;
  return {
    fields: fields ?? uniqueFieldNames((await result.keys()).map(String)),
    rows,
    truncated,
    ...(queryType !== undefined && QUERY_TYPES.has(queryType) ? { queryType: queryType as GraphQueryType } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * The real driver module in the shape above. `neo4j.driver` reads an absent token as
 * the `none` scheme (createAuthManager in neo4j-driver-lite/lib/index.js), which is how
 * a server without authentication is reached, but its declaration requires a token;
 * the one assertion here says what the runtime accepts.
 */
const DRIVER_MODULE: BoltDriverModule = {
  driver: (uri, auth, config) => neo4j.driver(uri, auth as AuthToken, config),
  auth: neo4j.auth,
  session: neo4j.session,
};

/** The client over a given driver module; `createBoltClient` passes the real one. */
export function buildBoltClient(config: BoltClientConfig, lib: BoltDriverModule = DRIVER_MODULE): GraphClient {
  const { uri, driverConfig } = driverArguments(config);
  const auth = config.user ? lib.auth.basic(config.user, config.password ?? "") : undefined;
  const driver = lib.driver(uri, auth, driverConfig);

  async function verify(): Promise<GraphServerInfo> {
    try {
      await driver.verifyConnectivity();
      const info = await driver.getServerInfo();
      if (info.address === undefined || info.agent === undefined || info.protocolVersion === undefined) {
        throw new GraphClientError("connection", "The server did not report its address, agent and protocol version");
      }
      const version = info.protocolVersion;
      return {
        address: info.address,
        agent: info.agent,
        protocolVersion: `${version.getMajor()}.${version.getMinor()}`,
      };
    } catch (error) {
      throw toGraphClientError(error);
    }
  }

  async function run(statement: string, options: GraphRunOptions): Promise<GraphRunResult> {
    const { signal } = options;
    if (signal?.aborted) throw new GraphClientError("cancelled", "The query was cancelled before it was sent");

    let session: BoltSession;
    try {
      session = driver.session({
        database: options.database,
        defaultAccessMode: lib.session.READ,
        fetchSize: Math.min(options.maxRows + 1, MAX_FETCH_SIZE),
      });
    } catch (error) {
      throw toGraphClientError(error);
    }
    let closing: Promise<void> | undefined;
    const closeSession = (): Promise<void> => {
      if (closing === undefined) {
        closing = session.close();
        // Awaited below; this only keeps a failure that lands before then from being
        // reported as unhandled.
        closing.catch(() => undefined);
      }
      return closing;
    };

    let stop: (error: GraphClientError) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
      stop = reject;
    });
    const onAbort = () => {
      void closeSession();
      stop(new GraphClientError("cancelled", "The query was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      void closeSession();
      stop(new GraphClientError("timeout", `The query did not finish within ${options.timeoutMs} ms`));
    }, options.timeoutMs + TIMER_GRACE_MS);
    const release = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const reading = (async () => {
      const result = session.run(statement, undefined, {
        timeout: options.timeoutMs,
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      });
      return readResult(result, options.maxRows);
    })();
    // When the abort or the timer wins, the closed session then fails the read; that
    // failure is the cancellation already reported, not a second error.
    reading.catch(() => undefined);

    let outcome: GraphRunResult;
    try {
      outcome = await Promise.race([reading, stopped]);
    } catch (error) {
      release();
      // The run's own failure is the one reported: a close that also fails (a session
      // closed on a dead connection, say) says nothing more about it.
      await closeSession().catch(() => undefined);
      throw toGraphClientError(error);
    }
    release();
    // After a complete result, a failed close is the run's failure: the connection the
    // result came over did not end cleanly.
    try {
      await closeSession();
    } catch (error) {
      throw toGraphClientError(error);
    }
    return outcome;
  }

  return { verify, run, close: () => driver.close() };
}

export const createBoltClient: GraphClientFactory = (config) => buildBoltClient(config);
