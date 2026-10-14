/**
 * The Apache Spark gRPC adapter over the fake server of tests/helpers/spark-connect-server.ts:
 * the loader options, the six allowlisted RPCs and the six the stub cannot call, the authorization metadata, a deadline
 * per call, the call's own signal, the 16 MiB receive cap and retries off, a reset connection, the unsent error, the
 * calls after close() and the call close() ends, the require, verify-ca and verify-full TLS modes, the cached
 * definition, and every request builder sent through the real descriptor and decoded by the fake, the fixed identity
 * included; and the fake's own answer to a statement it holds no answer for and to an ExecutePlan with no plan.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { credentials } from "@grpc/grpc-js";
import {
  buildSparkConnectionOptions,
  type SparkConnectionOptions,
} from "@/lib/db/providers/sql/spark/connection-options";
import { SPARK_ERROR_SENTENCES, SparkError, toSparkError } from "@/lib/db/providers/sql/spark/errors";
import {
  allowlistedService,
  grpcWireTransport,
  SPARK_ALLOWLISTED_RPCS,
  SPARK_LOADER_OPTIONS,
  type SparkWireCall,
  type SparkWireChannel,
  sparkCallMetadata,
  sparkDefinition,
} from "@/lib/db/providers/sql/spark/grpc-client";
import {
  configGetAllRequest,
  configGetOptionRequest,
  configSetRequest,
  fetchErrorDetailsRequest,
  interruptByTagRequest,
  relationRequest,
  releaseSessionRequest,
  type SparkSessionRef,
  sqlCommandRequest,
  versionRequest,
} from "@/lib/db/providers/sql/spark/requests";
import type { DatabaseConnection } from "@/lib/types";
import { type SparkFakeLogEntry, type SparkFakeServer, startSparkFake } from "../../../helpers/spark-connect-server";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const LIMITS = { maxReceivedBytes: 33_554_432 };
const TOKEN = "fake-token-3c9e1b77";
/**
 * The fixed identity every request carries, as the fake decodes it through the descriptor: a field the descriptor does
 * not hold is dropped on the wire, and the decoder answers an absent message field as null.
 */
const IDENTITY = {
  user_context: { user_id: "libredb-studio", user_name: "libredb-studio", extensions: [] },
  client_type: "libredb-studio",
};
const identityOf = (entry: SparkFakeLogEntry) => {
  const { user_context, client_type } = entry.request as { user_context?: unknown; client_type?: unknown };
  return { user_context, client_type };
};
const portOf = (fake: SparkFakeServer) => Number(fake.target.slice(fake.target.lastIndexOf(":") + 1));
const optionsFor = (fake: SparkFakeServer, overrides: Record<string, unknown> = {}): SparkConnectionOptions =>
  buildSparkConnectionOptions(
    {
      id: "c",
      name: "c",
      type: "spark",
      host: "127.0.0.1",
      port: portOf(fake),
      ...overrides,
    } as unknown as DatabaseConnection,
    {
      queryTimeout: 5_000,
    },
  );
const call = (
  metadata: Readonly<Record<string, string>> = {},
  deadlineMs = 2_000,
  signal = new AbortController().signal,
): SparkWireCall => ({
  metadata,
  deadline: new Date(Date.now() + deadlineMs),
  signal,
});
const fresh = (): SparkSessionRef => ({ sessionId: randomUUID() });
const run = () => ({ operationId: randomUUID(), tag: `libredb-studio-${randomUUID()}` });
async function failure(promise: Promise<unknown>): Promise<{ code?: number; details?: string } & Error> {
  return promise.then(
    () => {
      throw new Error("the call answered, though this test expects it to fail");
    },
    (error: unknown) => error as { code?: number; details?: string } & Error,
  );
}
/** What `act` throws before it returns. */
function thrownBy(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error("the call returned, though this test expects it to throw at once");
}
/** The connection a mapped failure names: the fake's address and no secret. */
const contextOf = (fake: SparkFakeServer) => ({
  connection: { host: "127.0.0.1", port: portOf(fake), secretForms: [] },
});
async function readAll(stream: { read(): Promise<object | undefined> }): Promise<object[]> {
  const responses: object[] = [];
  // oxlint-disable-next-line no-await-in-loop -- one reader awaits each message before it asks for the next.
  for (let response = await stream.read(); response !== undefined; response = await stream.read())
    responses.push(response);
  return responses;
}
/** Resolves once the fake has logged the operation, so a test acts on a call the server holds. */
async function arrived(fake: SparkFakeServer, operationId: string): Promise<void> {
  while (!fake.log.entries.some((entry) => entry.operationId === operationId)) {
    // oxlint-disable-next-line no-await-in-loop -- polls the fake's log every 5 ms until the call arrives.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let plain: SparkFakeServer;
let secured: SparkFakeServer;
let tokened: SparkFakeServer;
const channels: SparkWireChannel[] = [];
const open = (options: SparkConnectionOptions) => {
  const channel = grpcWireTransport(options);
  channels.push(channel);
  return channel;
};

beforeAll(async () => {
  plain = await startSparkFake({
    statements: {
      "SHOW TABLES": { kind: "command", ipc: new Uint8Array([1, 2, 3]) },
      "SELECT 1": { kind: "silent" },
      BIG: { kind: "oversized", bytes: 17 * 1024 * 1024, path: "command" },
      RESET: { kind: "reset" },
    },
  });
  secured = await startSparkFake({ tls: true, statements: {} });
  tokened = await startSparkFake({ token: TOKEN, statements: {} });
});

afterAll(() => {
  for (const channel of channels) channel.close();
  for (const fake of [plain, secured, tokened]) fake.close();
});

describe("the stub", () => {
  test("the loader options and the six allowlisted RPCs, and the six the stub cannot call", () => {
    expect(SPARK_LOADER_OPTIONS).toStrictEqual({
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    expect([...SPARK_ALLOWLISTED_RPCS]).toStrictEqual([
      "ExecutePlan",
      "AnalyzePlan",
      "Config",
      "Interrupt",
      "ReleaseSession",
      "FetchErrorDetails",
    ]);
    expect(Object.keys(allowlistedService()).sort()).toStrictEqual([...SPARK_ALLOWLISTED_RPCS].sort());
    const full = Object.keys(sparkDefinition()["spark.connect.SparkConnectService"] as object);
    expect(full).toHaveLength(12);
    for (const rpc of [
      "AddArtifacts",
      "ArtifactStatus",
      "ReattachExecute",
      "ReleaseExecute",
      "CloneSession",
      "GetStatus",
    ]) {
      expect(full).toContain(rpc);
      expect(Object.keys(allowlistedService())).not.toContain(rpc);
    }
  });

  test("the definition and the filtered service are built once per process", () => {
    expect(sparkDefinition()).toBe(sparkDefinition());
    expect(allowlistedService()).toBe(allowlistedService());
  });

  test("the authorization metadata: the exact Bearer prefix with a token, nothing without one", () => {
    expect(sparkCallMetadata(undefined)).toStrictEqual({});
    expect(sparkCallMetadata(TOKEN)).toStrictEqual({ authorization: `Bearer ${TOKEN}` });
  });
});

describe("every request builder, sent through the descriptor and decoded by the fake", () => {
  test("AnalyzePlan, Config set, get_option and get_all, Interrupt, FetchErrorDetails and ReleaseSession, each with the fixed identity", async () => {
    const channel = open(optionsFor(plain));
    const session = fresh();
    plain.log.clear();
    const version = (await channel.unary("AnalyzePlan", versionRequest(session), call())) as {
      spark_version: { version: string };
      server_side_session_id: string;
    };
    expect(version.spark_version.version).toBe("4.2.0");
    session.serverSideSessionId = version.server_side_session_id;
    await channel.unary("Config", configSetRequest(session, [["spark.sql.variable.substitute", "false"]]), call());
    const got = (await channel.unary(
      "Config",
      configGetOptionRequest(session, ["spark.sql.variable.substitute"]),
      call(),
    )) as { pairs: { key: string; value: string; _value: string }[] };
    // The loader's oneofs option also names the set member of the synthetic oneof proto3 gives the optional `value`.
    expect(got.pairs).toStrictEqual([{ key: "spark.sql.variable.substitute", value: "false", _value: "value" }]);
    const all = (await channel.unary("Config", configGetAllRequest(session, "spark.sql."), call())) as {
      pairs: { key: string }[];
    };
    expect(all.pairs.map((pair) => pair.key)).toStrictEqual(["variable.substitute"]);
    const interrupted = (await channel.unary(
      "Interrupt",
      interruptByTagRequest(session, "libredb-studio-x"),
      call(),
    )) as { interrupted_ids: string[] };
    expect(interrupted.interrupted_ids).toStrictEqual([]);
    expect(await channel.unary("FetchErrorDetails", fetchErrorDetailsRequest(session, "none"), call())).toMatchObject({
      errors: [],
    });
    await channel.unary("ReleaseSession", releaseSessionRequest(session), call());
    expect(plain.log.entries.map((entry) => entry.rpc)).toStrictEqual([
      "AnalyzePlan",
      "Config",
      "Config",
      "Config",
      "Interrupt",
      "FetchErrorDetails",
      "ReleaseSession",
    ]);
    for (const entry of plain.log.entries) {
      expect(entry.sessionId).toBe(session.sessionId);
      expect(entry.metadata.authorization).toBeUndefined();
      expect({ rpc: entry.rpc, ...identityOf(entry) }).toStrictEqual({ rpc: entry.rpc, ...IDENTITY });
    }
    const interrupt = plain.log.entries[4]?.request as {
      interrupt_type: string;
      operation_tag: string;
      client_observed_server_side_session_id: string;
    };
    expect(interrupt).toMatchObject({
      interrupt_type: "INTERRUPT_TYPE_TAG",
      operation_tag: "libredb-studio-x",
      client_observed_server_side_session_id: version.server_side_session_id,
    });
  });

  test("ExecutePlan: the fixed identity, the statement as SqlCommand.input, the tag, 4 MiB chunks and no reattach option; the inline answer", async () => {
    const channel = open(optionsFor(plain));
    const ids = run();
    plain.log.clear();
    const responses = await readAll(
      channel.executePlan(sqlCommandRequest(fresh(), "SHOW TABLES", ids), call(), LIMITS),
    );
    const result = responses.find((response) => (response as { sql_command_result?: unknown }).sql_command_result) as {
      sql_command_result: { relation: { local_relation: { data: Uint8Array } } };
    };
    expect([...result.sql_command_result.relation.local_relation.data]).toStrictEqual([1, 2, 3]);
    expect(plain.log.entries).toHaveLength(1);
    const entry = plain.log.entries[0] as SparkFakeLogEntry;
    expect(identityOf(entry)).toStrictEqual(IDENTITY);
    expect(entry.operationId).toBe(ids.operationId);
    expect(entry.tags).toStrictEqual([ids.tag]);
    expect(entry.reattachOptions).toBeUndefined();
    expect((entry.requestOptions[0] as { result_chunking_options: object }).result_chunking_options).toMatchObject({
      allow_arrow_batch_chunking: true,
      preferred_arrow_chunk_size: "4194304",
    });
    expect(
      (entry.request as { plan: { command: { sql_command: { input: { sql: { query: string } } } } } }).plan.command
        .sql_command.input.sql.query,
    ).toBe("SHOW TABLES");
  });
});

describe("the transport's rules", () => {
  test("the channel opens with the 16 MiB receive cap and grpc-js's retries off, so no call is ever sent twice", async () => {
    const inner = credentials.createInsecure();
    const connectors = spyOn(inner, "_createSecureConnector");
    const created = spyOn(credentials, "createInsecure").mockReturnValue(inner);
    try {
      await open(optionsFor(plain)).unary("AnalyzePlan", versionRequest(fresh()), call());
    } finally {
      created.mockRestore();
    }
    expect(connectors).toHaveBeenCalled();
    // The two options Spark chooses; the rest of the set is the shared transport's, held by its own tests.
    expect(connectors.mock.calls[0]?.[1]).toMatchObject({
      "grpc.max_receive_message_length": 16_777_216,
      "grpc.enable_retries": 0,
    });
  });

  test("a deadline ends a silent call with DEADLINE_EXCEEDED", async () => {
    const channel = open(optionsFor(plain));
    const stream = channel.executePlan(
      relationRequest(fresh(), { sql: { query: "SELECT 1" } }, run()),
      call({}, 200),
      LIMITS,
    );
    expect((await failure(readAll(stream))).code).toBe(4);
  });

  test("the call's own signal ends the call, and the channel still serves the next one", async () => {
    const channel = open(optionsFor(plain));
    const controller = new AbortController();
    const ids = run();
    const reading = readAll(
      channel.executePlan(
        relationRequest(fresh(), { sql: { query: "SELECT 1" } }, ids),
        call({}, 5_000, controller.signal),
        LIMITS,
      ),
    );
    await arrived(plain, ids.operationId);
    controller.abort();
    const error = await failure(reading);
    expect([error.code, error.details]).toStrictEqual([1, "Cancelled on client"]);
    expect(await channel.unary("AnalyzePlan", versionRequest(fresh()), call())).toMatchObject({
      spark_version: { version: "4.2.0" },
    });
  });

  test("a call whose signal aborted before it was sent is unsent", async () => {
    const channel = open(optionsFor(plain));
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      channel.unary("AnalyzePlan", versionRequest(fresh()), call({}, 2_000, controller.signal)),
    );
    expect(error).toBeInstanceOf(SparkError);
    expect((error as unknown as SparkError).category).toBe("unsent");
  });

  test("an inline answer above 16 MiB ends the call with RESOURCE_EXHAUSTED", async () => {
    const channel = open(optionsFor(plain));
    const error = await failure(
      readAll(channel.executePlan(sqlCommandRequest(fresh(), "BIG", run()), call({}, 5_000), LIMITS)),
    );
    expect(error.code).toBe(8);
    expect(error.details).toContain("Received message larger than max");
  });

  // grpc-js never sends a call again once the server took its stream, whatever the retry setting, so this case cannot
  // show that retries are off: the channel-options test above, which reads `grpc.enable_retries` 0, holds that rule.
  test("a reset connection fails the call with UNAVAILABLE, after the fake received it once", async () => {
    const channel = open(optionsFor(plain));
    const ids = run();
    plain.log.clear();
    const error = await failure(
      readAll(channel.executePlan(relationRequest(fresh(), { sql: { query: "RESET" } }, ids), call({}, 3_000), LIMITS)),
    );
    expect(error.code).toBe(14);
    expect(plain.log.entries.filter((entry) => entry.operationId === ids.operationId)).toHaveLength(1);
  });

  test("after close(), ExecutePlan throws at once and a unary call rejects, with grpc-js's error that has no gRPC code, which reads as a local client failure; nothing reaches the server", async () => {
    const channel = open(optionsFor(plain));
    await channel.unary("AnalyzePlan", versionRequest(fresh()), call());
    channel.close();
    plain.log.clear();
    const thrown = thrownBy(() =>
      channel.executePlan(sqlCommandRequest(fresh(), "SHOW TABLES", run()), call(), LIMITS),
    );
    const rejected = await failure(channel.unary("AnalyzePlan", versionRequest(fresh()), call()));
    for (const error of [thrown, rejected]) {
      expect(error).toBeInstanceOf(Error);
      const { message, code, details } = error as { code?: unknown; details?: unknown } & Error;
      expect({ message, code, details }).toStrictEqual({
        message: "Channel has been shut down",
        code: undefined,
        details: undefined,
      });
      const mapped = toSparkError(error, { ...contextOf(plain), phase: "relation", timeoutMs: 5_000 });
      expect([mapped.category, mapped.message]).toStrictEqual(["spark", SPARK_ERROR_SENTENCES.localClientError]);
    }
    expect(plain.log.entries).toStrictEqual([]);
    // A second close() changes nothing.
    channel.close();
  });

  test("close() ends a call still open with CANCELLED, which reads as cancelled", async () => {
    const channel = open(optionsFor(plain));
    const ids = run();
    const reading = readAll(
      channel.executePlan(relationRequest(fresh(), { sql: { query: "SELECT 1" } }, ids), call({}, 5_000), LIMITS),
    );
    await arrived(plain, ids.operationId);
    channel.close();
    const error = await failure(reading);
    expect([error.code, error.details]).toStrictEqual([1, "Cancelled on client"]);
    const mapped = toSparkError(error, { ...contextOf(plain), phase: "relation", timeoutMs: 5_000 });
    expect([mapped.category, mapped.message]).toStrictEqual(["cancelled", SPARK_ERROR_SENTENCES.cancelled]);
  });
});

describe("the fake's own answers", () => {
  test("a statement it holds no answer for, an Object.prototype name among them, ends with INVALID_ARGUMENT", async () => {
    const channel = open(optionsFor(plain));
    for (const text of ["NO SUCH STATEMENT", "toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      // oxlint-disable-next-line no-await-in-loop -- one statement at a time, each answered before the next.
      const error = await failure(
        readAll(channel.executePlan(sqlCommandRequest(fresh(), text, run()), call(), LIMITS)),
      );
      expect({ text, code: error.code, details: error.details }).toStrictEqual({
        text,
        code: 3,
        details: `the fake has no answer for ${JSON.stringify(text)}`,
      });
    }
  });

  test("an ExecutePlan with no plan ends with INVALID_ARGUMENT, as a statement with no answer does", async () => {
    const channel = open(optionsFor(plain));
    const error = await failure(
      readAll(channel.executePlan({ session_id: randomUUID(), operation_id: randomUUID() }, call(), LIMITS)),
    );
    expect([error.code, error.details]).toStrictEqual([3, "the fake has no answer for undefined"]);
  });
});

describe("tokens", () => {
  test("no token, a wrong one and a lower-case prefix are refused; the exact Bearer prefix is accepted", async () => {
    const channel = open(optionsFor(tokened));
    expect((await failure(channel.unary("AnalyzePlan", versionRequest(fresh()), call()))).details).toBe(
      "No authentication token provided",
    );
    expect(
      (await failure(channel.unary("AnalyzePlan", versionRequest(fresh()), call({ authorization: "Bearer wrong" }))))
        .details,
    ).toBe("Invalid authentication token");
    expect(
      (await failure(channel.unary("AnalyzePlan", versionRequest(fresh()), call({ authorization: `bearer ${TOKEN}` }))))
        .details,
    ).toBe("Invalid authentication token");
    expect(await channel.unary("AnalyzePlan", versionRequest(fresh()), call(sparkCallMetadata(TOKEN)))).toMatchObject({
      spark_version: { version: "4.2.0" },
    });
  });
});

describe("TLS", () => {
  const context = (fake: SparkFakeServer) => ({ ...contextOf(fake), phase: "connect" as const });
  const versionOver = async (channel: SparkWireChannel) =>
    ((await channel.unary("AnalyzePlan", versionRequest(fresh()), call())) as { spark_version: unknown }).spark_version;

  test("verify-full with the fake's CA answers, through the IP identity", async () => {
    const channel = open(optionsFor(secured, { ssl: { mode: "verify-full", caCert: secured.caPem } }));
    expect(await channel.unary("AnalyzePlan", versionRequest(fresh()), call())).toMatchObject({
      spark_version: { version: "4.2.0" },
    });
  });

  test("require with no CA answers: the channel encrypts without verifying the certificate", async () => {
    expect(await versionOver(open(optionsFor(secured, { ssl: { mode: "require" } })))).toStrictEqual({
      version: "4.2.0",
    });
  });

  test("verify-ca with the fake's CA answers", async () => {
    expect(
      await versionOver(open(optionsFor(secured, { ssl: { mode: "verify-ca", caCert: secured.caPem } }))),
    ).toStrictEqual({ version: "4.2.0" });
  });

  test("plaintext to the TLS port, TLS to the plaintext port and a CA that did not sign the certificate are tls failures", async () => {
    const plaintextToTls = await failure(
      open(optionsFor(secured)).unary("AnalyzePlan", versionRequest(fresh()), call()),
    );
    expect(toSparkError(plaintextToTls, context(secured)).category).toBe("tls");
    expect(toSparkError(plaintextToTls, context(secured)).message).toBe(
      SPARK_ERROR_SENTENCES.tlsPortExpected("127.0.0.1", portOf(secured)),
    );
    const tlsToPlaintext = await failure(
      open(optionsFor(plain, { ssl: { mode: "verify-full", caCert: secured.caPem } })).unary(
        "AnalyzePlan",
        versionRequest(fresh()),
        call(),
      ),
    );
    expect(toSparkError(tlsToPlaintext, context(plain)).category).toBe("tls");
    expect(toSparkError(tlsToPlaintext, context(plain)).message).toBe(
      SPARK_ERROR_SENTENCES.tlsPlaintextServer("127.0.0.1", portOf(plain)),
    );
    const wrongCa = await failure(
      open(optionsFor(secured, { ssl: { mode: "verify-full", caCert: loadTlsFixtures().otherCa } })).unary(
        "AnalyzePlan",
        versionRequest(fresh()),
        call(),
      ),
    );
    expect(toSparkError(wrongCa, context(secured)).category).toBe("tls");
    expect(toSparkError(wrongCa, context(secured)).message).toBe(SPARK_ERROR_SENTENCES.tlsUntrusted);
  });
});
