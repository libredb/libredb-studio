/**
 * The Bolt transport over a fake driver module (Neo4j provider spec 3.3, revisions SR13, SR16, SR21)
 *
 * `buildBoltClient` takes the driver module as a parameter, so these tests hand it a
 * fake that records every `driver(...)` call and serves scripted sessions. They pin
 * the fixed driver configuration, the READ session with `maxRows + 1` as its fetch
 * size, the row cut that never reads the summary, the cancel and timeout paths that
 * close the session, the error categories, and how a custom CA reaches the driver
 * (K2): as a 0600 file named by the PEM's sha256 under the temporary directory,
 * because 6.2.0 reads `trustedCertificates` as file paths.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import neo4j from "neo4j-driver-lite";
import { GraphClientError, type GraphRunOptions } from "@/lib/db/graph/bolt/client";
import {
  type BoltDriverModule,
  type BoltRecord,
  type BoltResult,
  buildBoltClient,
  createBoltClient,
} from "@/lib/db/graph/bolt/bolt-client";
import { MAX_CELL_JSON_BYTES } from "@/lib/db/graph/bolt/record-values";

interface Script {
  readonly keys?: readonly string[];
  readonly records?: readonly Record<string, unknown>[];
  readonly queryType?: string;
  /** Thrown by `session.run` itself. */
  readonly runError?: unknown;
  /** Thrown by the iterator after the records. */
  readonly iterateError?: unknown;
  /** The iterator never answers until the session closes, then rejects with Terminated. */
  readonly hang?: boolean;
  readonly serverInfo?: {
    address?: string;
    agent?: string;
    protocolVersion?: { getMajor(): number; getMinor(): number };
  };
  readonly verifyError?: unknown;
  /** Thrown by `driver.session` itself. */
  readonly sessionError?: unknown;
  /** The rejection of `session.close`, after it has released a hanging iterator. */
  readonly closeError?: unknown;
}

function record(row: Record<string, unknown>): BoltRecord {
  const keys = Object.keys(row);
  return { keys, get: (index: number) => row[keys[index]] };
}

function fakeLib(script: Script = {}) {
  const calls = {
    driver: [] as unknown[][],
    sessions: [] as unknown[],
    runs: [] as unknown[][],
    closes: 0,
    driverCloses: 0,
    summaryReads: 0,
    iteratorReturns: 0,
  };
  const lib: BoltDriverModule = {
    auth: { basic: (user, password) => ({ scheme: "basic", principal: user, credentials: password }) },
    session: { READ: "READ" },
    driver(...args) {
      calls.driver.push(args);
      return {
        verifyConnectivity: async () => {
          if (script.verifyError !== undefined) throw script.verifyError;
        },
        getServerInfo: async () =>
          script.serverInfo ?? {
            address: "db:7687",
            agent: "Neo4j/5.26.0",
            protocolVersion: { getMajor: () => 5, getMinor: () => 8 },
          },
        close: async () => {
          calls.driverCloses++;
        },
        session(config) {
          calls.sessions.push(config);
          if (script.sessionError !== undefined) throw script.sessionError;
          let release: (() => void) | undefined;
          const closed = new Promise<void>((resolve) => {
            release = resolve;
          });
          let open = true;
          return {
            close: async () => {
              calls.closes++;
              open = false;
              release?.();
              if (script.closeError !== undefined) throw script.closeError;
            },
            run(...args): BoltResult {
              calls.runs.push(args);
              if (script.runError !== undefined) throw script.runError;
              const records = (script.records ?? []).map(record);
              return {
                keys: async () => script.keys ?? [],
                summary: async () => {
                  calls.summaryReads++;
                  return { queryType: script.queryType ?? "r" };
                },
                [Symbol.asyncIterator]() {
                  let index = 0;
                  return {
                    async next(): Promise<IteratorResult<BoltRecord>> {
                      if (script.hang) {
                        await closed;
                        throw new neo4j.Neo4jError("terminated", "Neo.ClientError.Transaction.Terminated", "25N05", "");
                      }
                      if (!open) throw new Error("session closed while iterating");
                      if (index < records.length) return { done: false, value: records[index++] };
                      if (script.iterateError !== undefined) throw script.iterateError;
                      return { done: true, value: undefined };
                    },
                    async return(): Promise<IteratorResult<BoltRecord>> {
                      calls.iteratorReturns++;
                      return { done: true, value: undefined };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { lib, calls };
}

const BASE = { uri: "bolt://db:7687", connectionTimeoutMs: 5000, userAgent: "libredb-studio/1.0" };
const RUN: GraphRunOptions = { timeoutMs: 30000, maxRows: 100 };

async function rejection(promise: Promise<unknown>): Promise<GraphClientError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GraphClientError);
    return error as GraphClientError;
  }
  throw new Error("expected a GraphClientError");
}

describe("driver configuration", () => {
  test("the URI, basic auth and exactly the audited options", () => {
    const { lib, calls } = fakeLib();
    buildBoltClient({ ...BASE, user: "neo4j", password: "secret" }, lib);
    expect(calls.driver).toEqual([
      [
        "bolt://db:7687",
        { scheme: "basic", principal: "neo4j", credentials: "secret" },
        {
          telemetryDisabled: true,
          userAgent: "libredb-studio/1.0",
          connectionTimeout: 5000,
          connectionAcquisitionTimeout: 5000,
          maxConnectionPoolSize: 4,
          maxTransactionRetryTime: 0,
          disableAutoCommitRetries: true,
          disableLosslessIntegers: false,
          useBigInt: false,
          notificationFilter: { minimumSeverityLevel: "OFF" },
        },
      ],
    ]);
  });

  test("no user sends no auth token; a user without a password sends an empty one", () => {
    const none = fakeLib();
    buildBoltClient(BASE, none.lib);
    expect(none.calls.driver[0][1]).toBeUndefined();
    const empty = fakeLib();
    buildBoltClient({ ...BASE, user: "" }, empty.lib);
    expect(empty.calls.driver[0][1]).toBeUndefined();
    const nopass = fakeLib();
    buildBoltClient({ ...BASE, user: "reader" }, nopass.lib);
    expect(nopass.calls.driver[0][1]).toEqual({ scheme: "basic", principal: "reader", credentials: "" });
  });

  test("the self-signed and system-CA schemes pass through unchanged", () => {
    for (const uri of ["bolt+s://db:7687", "bolt+ssc://db:7687"]) {
      const { lib, calls } = fakeLib();
      buildBoltClient({ ...BASE, uri }, lib);
      expect(calls.driver[0][0]).toBe(uri);
      expect(calls.driver[0][2]).not.toHaveProperty("trust");
    }
  });

  test.each(["neo4j://db:7687", "neo4j+s://db:7687", "http://db:7474", "db:7687"])("%s is refused", (uri) => {
    const { lib, calls } = fakeLib();
    expect(() => buildBoltClient({ ...BASE, uri }, lib)).toThrow(GraphClientError);
    expect(calls.driver).toEqual([]);
  });

  test("createBoltClient builds a real driver lazily, opening no socket", async () => {
    const client = createBoltClient({ ...BASE, uri: "bolt://127.0.0.1:1" });
    await client.close();
  });
});

describe("custom CA (K2)", () => {
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
  const digest = createHash("sha256").update(PEM).digest("hex");
  let root: string;
  let previous: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "bolt-ca-test-"));
    previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  test("the PEM is written once as a 0600 file and the driver trusts that file over bolt://", () => {
    const { lib, calls } = fakeLib();
    buildBoltClient({ ...BASE, uri: "bolt+s://db:7687", trustedCertificatePem: PEM }, lib);
    const file = join(root, "libredb-neo4j-ca", `${digest}.pem`);
    expect(calls.driver[0][0]).toBe("bolt://db:7687");
    expect(calls.driver[0][2]).toMatchObject({
      encrypted: "ENCRYPTION_ON",
      trust: "TRUST_CUSTOM_CA_SIGNED_CERTIFICATES",
      trustedCertificates: [file],
      telemetryDisabled: true,
    });
    expect(readFileSync(file, "utf8")).toBe(PEM);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "libredb-neo4j-ca")).mode & 0o777).toBe(0o700);

    const before = statSync(file).mtimeMs;
    const again = fakeLib();
    buildBoltClient({ ...BASE, uri: "bolt+s://db:7687", trustedCertificatePem: PEM }, again.lib);
    expect((again.calls.driver[0][2] as { trustedCertificates: string[] }).trustedCertificates).toEqual([file]);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  test("a file under the PEM's name with other content is refused", () => {
    const other = "-----BEGIN CERTIFICATE-----\nother\n-----END CERTIFICATE-----\n";
    const name = createHash("sha256").update(other).digest("hex");
    writeFileSync(join(root, "libredb-neo4j-ca", `${name}.pem`), "tampered", { mode: 0o600 });
    const { lib, calls } = fakeLib();
    const run = () => buildBoltClient({ ...BASE, uri: "bolt+s://db:7687", trustedCertificatePem: other }, lib);
    expect(run).toThrow(/does not hold the CA certificate/);
    expect(calls.driver).toEqual([]);
  });

  test("a CA directory others can write to is refused", () => {
    const dir = join(root, "libredb-neo4j-ca");
    chmodSync(dir, 0o777);
    try {
      const { lib } = fakeLib();
      expect(() =>
        buildBoltClient({ ...BASE, uri: "bolt+s://db:7687", trustedCertificatePem: `${PEM}\n` }, lib),
      ).toThrow(/writable by other users/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a CA directory path that is not a directory is refused", () => {
    const nested = mkdtempSync(join(root, "nested-"));
    writeFileSync(join(nested, "libredb-neo4j-ca"), "not a directory");
    process.env.TMPDIR = nested;
    try {
      const { lib } = fakeLib();
      expect(() => buildBoltClient({ ...BASE, uri: "bolt+s://db:7687", trustedCertificatePem: PEM }, lib)).toThrow();
    } finally {
      process.env.TMPDIR = root;
    }
  });

  test("a custom CA on a scheme other than bolt+s is refused", () => {
    for (const uri of ["bolt://db:7687", "bolt+ssc://db:7687"]) {
      const { lib, calls } = fakeLib();
      const error = (() => {
        try {
          buildBoltClient({ ...BASE, uri, trustedCertificatePem: PEM }, lib);
        } catch (caught) {
          return caught as GraphClientError;
        }
        throw new Error("expected a refusal");
      })();
      expect(error.category).toBe("tls");
      expect(calls.driver).toEqual([]);
    }
  });

  test("the directory is created when it does not exist", () => {
    rmSync(join(root, "libredb-neo4j-ca"), { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const { lib } = fakeLib();
    buildBoltClient({ ...BASE, uri: "bolt+s://db:7687", trustedCertificatePem: PEM }, lib);
    expect(readFileSync(join(root, "libredb-neo4j-ca", `${digest}.pem`), "utf8")).toBe(PEM);
  });
});

describe("verify", () => {
  test("connectivity, then the server's address, agent and protocol version", async () => {
    const { lib } = fakeLib();
    expect(await buildBoltClient(BASE, lib).verify()).toEqual({
      address: "db:7687",
      agent: "Neo4j/5.26.0",
      protocolVersion: "5.8",
    });
  });

  test("a server info without its fields is a connection error", async () => {
    const { lib } = fakeLib({ serverInfo: {} });
    expect((await rejection(buildBoltClient(BASE, lib).verify())).category).toBe("connection");
  });

  test("a verify failure is classified", async () => {
    const { lib } = fakeLib({
      verifyError: new neo4j.Neo4jError("bad credentials", "Neo.ClientError.Security.Unauthorized", "42NFF", ""),
    });
    const error = await rejection(buildBoltClient(BASE, lib).verify());
    expect(error.category).toBe("auth");
    expect(error.code).toBe("Neo.ClientError.Security.Unauthorized");
    expect(error.message).toBe("bad credentials");
  });
});

describe("run", () => {
  test("a READ session with maxRows + 1 as fetch size, the literal statement and the timeout", async () => {
    const { lib, calls } = fakeLib({ records: [{ n: neo4j.int(1) }] });
    await buildBoltClient(BASE, lib).run("RETURN 1 AS n", {
      ...RUN,
      database: "movies",
      metadata: { app: "libredb" },
    });
    expect(calls.sessions).toEqual([{ database: "movies", defaultAccessMode: "READ", fetchSize: 101 }]);
    expect(calls.runs).toEqual([["RETURN 1 AS n", undefined, { timeout: 30000, metadata: { app: "libredb" } }]]);
  });

  test("no database and no metadata are sent as absent", async () => {
    const { lib, calls } = fakeLib();
    await buildBoltClient(BASE, lib).run("RETURN 1", RUN);
    expect(calls.sessions).toEqual([{ database: undefined, defaultAccessMode: "READ", fetchSize: 101 }]);
    expect(calls.runs[0][2]).toEqual({ timeout: 30000 });
  });

  test("the fetch size is capped at 1000", async () => {
    const { lib, calls } = fakeLib();
    await buildBoltClient(BASE, lib).run("RETURN 1", { ...RUN, maxRows: 5000 });
    expect(calls.sessions[0]).toMatchObject({ fetchSize: 1000 });
  });

  test("rows are converted, fields come from the records, and the summary gives the query type", async () => {
    const { lib, calls } = fakeLib({
      records: [
        { n: neo4j.int("9223372036854775807"), f: Number.NaN },
        { n: neo4j.int(2), f: 1.5 },
      ],
      queryType: "r",
    });
    const result = await buildBoltClient(BASE, lib).run("MATCH (n) RETURN n", RUN);
    expect(result).toEqual({
      fields: ["n", "f"],
      rows: [
        { n: "9223372036854775807", f: "NaN" },
        { n: 2, f: 1.5 },
      ],
      truncated: false,
      queryType: "r",
    });
    expect(calls.summaryReads).toBe(1);
    expect(calls.closes).toBe(1);
  });

  test("an empty result takes its fields from the result's keys", async () => {
    const { lib } = fakeLib({ keys: ["a", "b"], queryType: "rw" });
    expect(await buildBoltClient(BASE, lib).run("MATCH (a) RETURN a, 1 AS b", RUN)).toEqual({
      fields: ["a", "b"],
      rows: [],
      truncated: false,
      queryType: "rw",
    });
  });

  test("a query type the driver does not document is left out", async () => {
    const { lib } = fakeLib({ queryType: "x" });
    const result = await buildBoltClient(BASE, lib).run("RETURN 1", RUN);
    expect(result).not.toHaveProperty("queryType");
  });

  test("a record beyond maxRows truncates, stops the stream and never reads the summary", async () => {
    const { lib, calls } = fakeLib({ records: [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }] });
    const result = await buildBoltClient(BASE, lib).run("UNWIND range(1, 4) AS i RETURN i", { ...RUN, maxRows: 2 });
    expect(result).toEqual({ fields: ["i"], rows: [{ i: 1 }, { i: 2 }], truncated: true });
    expect(calls.summaryReads).toBe(0);
    expect(calls.iteratorReturns).toBe(1);
    expect(calls.closes).toBe(1);
  });

  test("exactly maxRows records is not a truncation", async () => {
    const { lib, calls } = fakeLib({ records: [{ i: 1 }, { i: 2 }] });
    const result = await buildBoltClient(BASE, lib).run("RETURN 1", { ...RUN, maxRows: 2 });
    expect(result.truncated).toBe(false);
    expect(calls.summaryReads).toBe(1);
  });

  test("an oversized cell is replaced and its column named once in the warnings", async () => {
    const big = "x".repeat(MAX_CELL_JSON_BYTES);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    const { lib } = fakeLib({
      records: [
        { doc: big, ok: 1, tree: deep },
        { doc: big, ok: 2, tree: 1 },
      ],
    });
    const result = await buildBoltClient(BASE, lib).run("RETURN 1", RUN);
    expect(result.rows).toEqual([
      { doc: `<value too large: ${MAX_CELL_JSON_BYTES + 2} bytes>`, ok: 1, tree: "<value nested too deeply>" },
      { doc: `<value too large: ${MAX_CELL_JSON_BYTES + 2} bytes>`, ok: 2, tree: 1 },
    ]);
    expect(result.warnings).toEqual([
      "A value in column doc was larger than 1 MiB as JSON and was replaced by its size.",
      "A value in column tree was nested deeper than 32 levels and was replaced.",
    ]);
  });

  test("the session is closed when the run throws, and the error is classified", async () => {
    const { lib, calls } = fakeLib({
      runError: new neo4j.Neo4jError("Invalid input 'MATC'", "Neo.ClientError.Statement.SyntaxError", "42001", ""),
    });
    const error = await rejection(buildBoltClient(BASE, lib).run("MATC (n) RETURN n", RUN));
    expect(error.category).toBe("syntax");
    expect(error.message).toBe("Invalid input 'MATC'");
    expect(calls.closes).toBe(1);
  });

  test("an error during iteration is classified and the session closed", async () => {
    const { lib, calls } = fakeLib({
      records: [{ i: 1 }],
      iterateError: new neo4j.Neo4jError("/ by zero", "Neo.ClientError.Statement.ArithmeticError", "22012", ""),
    });
    const error = await rejection(buildBoltClient(BASE, lib).run("RETURN 1/0", RUN));
    expect(error.category).toBe("query");
    expect(error.code).toBe("Neo.ClientError.Statement.ArithmeticError");
    expect(calls.closes).toBe(1);
  });

  test("a column named __proto__ is a key of the row, not its prototype", async () => {
    const { lib } = fakeLib({ records: [JSON.parse('{"__proto__": 1, "b": 2}') as Record<string, unknown>] });
    const result = await buildBoltClient(BASE, lib).run("RETURN 1 AS `__proto__`, 2 AS b", RUN);
    expect(result.fields).toEqual(["__proto__", "b"]);
    const [row] = result.rows;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.keys(row)).toEqual(["__proto__", "b"]);
    expect(JSON.stringify(row)).toBe('{"__proto__":1,"b":2}');
  });

  test("a session the driver refuses to open is a classified error, and nothing is left to close", async () => {
    const { lib, calls } = fakeLib({ sessionError: new Error("The fetch size must be a positive number") });
    const error = await rejection(buildBoltClient(BASE, lib).run("RETURN 1", RUN));
    expect(error.category).toBe("query");
    expect(error.message).toBe("The fetch size must be a positive number");
    expect(calls.runs).toEqual([]);
    expect(calls.closes).toBe(0);
  });

  test("a close failure after a complete result is a classified error", async () => {
    const lost = fakeLib({
      records: [{ i: 1 }],
      closeError: new neo4j.Neo4jError("connection lost", "ServiceUnavailable", "08000", ""),
    });
    const error = await rejection(buildBoltClient(BASE, lost.lib).run("RETURN 1 AS i", RUN));
    expect(error.category).toBe("connection");
    expect(error.message).toBe("connection lost");
    expect(lost.calls.closes).toBe(1);

    const raw = fakeLib({ records: [{ i: 1 }], closeError: new Error("socket hang up") });
    const rawError = await rejection(buildBoltClient(BASE, raw.lib).run("RETURN 1 AS i", RUN));
    expect(rawError.category).toBe("query");
    expect(rawError.message).toBe("socket hang up");
  });

  test("a close failure after a run error leaves the run's error", async () => {
    const { lib, calls } = fakeLib({
      runError: new neo4j.Neo4jError("Invalid input 'MATC'", "Neo.ClientError.Statement.SyntaxError", "42001", ""),
      closeError: new Error("socket hang up"),
    });
    const error = await rejection(buildBoltClient(BASE, lib).run("MATC (n) RETURN n", RUN));
    expect(error.category).toBe("syntax");
    expect(error.message).toBe("Invalid input 'MATC'");
    expect(calls.closes).toBe(1);
  });

  test("close closes the driver", async () => {
    const { lib, calls } = fakeLib();
    await buildBoltClient(BASE, lib).close();
    expect(calls.driverCloses).toBe(1);
  });
});

describe("cancel and timeout", () => {
  test("an abort closes the session at once and the run rejects as cancelled", async () => {
    const { lib, calls } = fakeLib({ hang: true });
    const controller = new AbortController();
    const running = buildBoltClient(BASE, lib).run("UNWIND range(1, 2000000000) AS i RETURN count(i)", {
      ...RUN,
      signal: controller.signal,
    });
    await Bun.sleep(5);
    expect(calls.closes).toBe(0);
    controller.abort();
    expect(calls.closes).toBe(1);
    const error = await rejection(running);
    expect(error.category).toBe("cancelled");
    expect(calls.closes).toBe(1);
  });

  test("a close failure on abort leaves the cancellation", async () => {
    const { lib, calls } = fakeLib({ hang: true, closeError: new Error("socket hang up") });
    const controller = new AbortController();
    const running = buildBoltClient(BASE, lib).run("RETURN 1", { ...RUN, signal: controller.signal });
    await Bun.sleep(5);
    controller.abort();
    const error = await rejection(running);
    expect(error.category).toBe("cancelled");
    expect(calls.closes).toBe(1);
  });

  test("an already aborted signal opens no session", async () => {
    const { lib, calls } = fakeLib();
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(buildBoltClient(BASE, lib).run("RETURN 1", { ...RUN, signal: controller.signal }));
    expect(error.category).toBe("cancelled");
    expect(calls.sessions).toEqual([]);
  });

  test("an abort after the run finished changes nothing", async () => {
    const { lib, calls } = fakeLib({ records: [{ i: 1 }] });
    const controller = new AbortController();
    const result = await buildBoltClient(BASE, lib).run("RETURN 1 AS i", { ...RUN, signal: controller.signal });
    controller.abort();
    expect(result.rows).toEqual([{ i: 1 }]);
    expect(calls.closes).toBe(1);
  });

  test("the client's timer closes the session one second after the server timeout", async () => {
    const { lib, calls } = fakeLib({ hang: true });
    const started = performance.now();
    const error = await rejection(
      buildBoltClient(BASE, lib).run("CALL { MATCH (n) RETURN n }", { ...RUN, timeoutMs: 20 }),
    );
    const elapsed = performance.now() - started;
    expect(error.category).toBe("timeout");
    expect(error.message).toContain("20 ms");
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(calls.closes).toBe(1);
  });
});

describe("error categories", () => {
  const server = (code: string, message = "server says no") => new neo4j.Neo4jError(message, code, "50N42", "");
  const cases: Array<[string, unknown, string]> = [
    ["Unauthorized", server("Neo.ClientError.Security.Unauthorized"), "auth"],
    ["another security code", server("Neo.ClientError.Security.AuthenticationRateLimit"), "auth"],
    ["Forbidden", server("Neo.ClientError.Security.Forbidden"), "access-mode"],
    ["AccessMode", server("Neo.ClientError.Statement.AccessMode"), "access-mode"],
    ["SyntaxError", server("Neo.ClientError.Statement.SyntaxError"), "syntax"],
    [
      "TransactionTimedOutClientConfiguration",
      server("Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration"),
      "timeout",
    ],
    ["TransactionTimedOut", server("Neo.ClientError.Transaction.TransactionTimedOut"), "timeout"],
    ["Terminated", server("Neo.ClientError.Transaction.Terminated"), "cancelled"],
    ["a server code that names a certificate", server("Neo.ClientError.Statement.TypeError", "certificate"), "query"],
    ["another server code", server("Neo.DatabaseError.General.UnknownError"), "query"],
    ["ServiceUnavailable", new neo4j.Neo4jError("no server", "ServiceUnavailable", "08000", ""), "connection"],
    ["SessionExpired", new neo4j.Neo4jError("gone", "SessionExpired", "08000", ""), "connection"],
    [
      "a refused socket inside a driver error",
      new neo4j.Neo4jError("connect ECONNREFUSED 127.0.0.1:7687", "ServiceUnavailable", "08000", ""),
      "connection",
    ],
    ["a raw socket error", Object.assign(new Error("getaddrinfo ENOTFOUND db"), { code: "ENOTFOUND" }), "connection"],
    ["a raw timeout", Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }), "connection"],
    ["a socket code only in the text", new Error("connect ECONNREFUSED 10.0.0.1:7687"), "connection"],
    ["a GQL connection status without a code", { message: "lost", gqlStatus: "08N06" }, "connection"],
    [
      "a self-signed certificate",
      new neo4j.Neo4jError(
        "Server certificate is not trusted. Socket responded with: DEPTH_ZERO_SELF_SIGNED_CERT self-signed certificate",
        "ServiceUnavailable",
        "08000",
        "",
      ),
      "tls",
    ],
    ["a self signed chain", new Error("self signed certificate in certificate chain"), "tls"],
    ["a CERT_ code", Object.assign(new Error("handshake failed"), { code: "CERT_HAS_EXPIRED" }), "tls"],
    ["an ERR_TLS code", Object.assign(new Error("handshake"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "tls"],
    ["a certificate message", new Error("Hostname/IP does not match certificate's altnames"), "tls"],
    ["anything else", new Error("something odd"), "query"],
    ["a thrown string", "plain text", "query"],
  ];

  test.each(cases)("%s", async (_, thrown, category) => {
    const { lib } = fakeLib({ runError: thrown });
    const error = await rejection(buildBoltClient(BASE, lib).run("RETURN 1", RUN));
    expect(error.category).toBe(category as GraphClientError["category"]);
  });

  test("the server's message and code are kept", async () => {
    const { lib } = fakeLib({
      runError: server("Neo.ClientError.Statement.AccessMode", "Writing in read access mode"),
    });
    const error = await rejection(buildBoltClient(BASE, lib).run("CREATE ()", RUN));
    expect(error.message).toBe("Writing in read access mode");
    expect(error.code).toBe("Neo.ClientError.Statement.AccessMode");
  });

  test("an error without a code carries none", async () => {
    const { lib } = fakeLib({ runError: new Error("something odd") });
    const error = await rejection(buildBoltClient(BASE, lib).run("RETURN 1", RUN));
    expect("code" in error).toBe(false);
    expect(error.message).toBe("something odd");
  });

  test("a thrown string becomes the message", async () => {
    const { lib } = fakeLib({ runError: "plain text" });
    expect((await rejection(buildBoltClient(BASE, lib).run("RETURN 1", RUN))).message).toBe("plain text");
  });
});
