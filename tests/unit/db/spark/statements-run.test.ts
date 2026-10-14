/**
 * One run over the fake Spark Connect server: the two steps, each carrying the run's deadline, its one signal, the
 * connection's metadata and the 32 MiB stream bound, with every response's server-side id observed on the run's
 * session; the inline answer, an empty one included, and every column under a unique name as an own property; the
 * deadline as a QueryError after an Interrupt that reaches the fake after the deadline passed, one that passes while
 * the session is in setup ending the run as not sent, or with the sentence its caller gave, and one that passes between
 * the steps sending the second step nothing; Stop before and after the first ExecutePlan, which aborts the run's stream
 * without waiting for the Interrupt's answer while the Interrupt still leaves first on the shared connection under
 * Node, and answers within one control window of the Stop; Stop on a run already refused at its deadline, which answers
 * from that outcome; cancelAll, which stops every run as Stop does and refuses, before it asks for its session, every
 * run that starts once it began; through the provider, a metadata read that waited through a disconnect for a new
 * metadata session's setup, refused as cancelled with no statement sent; a Spark error with one FetchErrorDetails
 * before the statement session's release, and a fetch that fails leaving the ErrorInfo message as it is; every exit
 * before Spark ended the stream, each refusal of a result and a server-side id that changed on an open stream among
 * them, sending one Interrupt by the run's tag, none when Spark ended it (a Spark error, a closed or changed session, a
 * session released under the run), and an Interrupt that fails changing nothing; a channel closed between the steps,
 * whose second ExecutePlan grpc-js refuses before sending it, ending the run as a SparkError; the heartbeat; no
 * reattach option; a SET that changes only its own scope; and concurrent scopes that share no session, heartbeat
 * hold, tag or Interrupt.
 * A run stays in flight, and Stop reaches it, until it settled and its Interrupt, if it sent one, answered or failed,
 * in either order.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryCancelledError, QueryError } from "@/lib/db/errors";
import { buildSparkConnectionOptions } from "@/lib/db/providers/sql/spark/connection-options";
import { SPARK_CONTROL_DEADLINE_MS, SPARK_SESSION_CONF } from "@/lib/db/providers/sql/spark/constants";
import { SPARK_ERROR_SENTENCES, SparkError, toDatabaseError } from "@/lib/db/providers/sql/spark/errors";
import { SparkRuns } from "@/lib/db/providers/sql/spark/execute";
import {
  grpcWireTransport,
  type SparkWireCall,
  type SparkWireChannel,
  type SparkWireTransport,
} from "@/lib/db/providers/sql/spark/grpc-client";
import { SparkHeartbeat } from "@/lib/db/providers/sql/spark/heartbeat";
import { SparkProvider } from "@/lib/db/providers/sql/spark/index";
import {
  configGetOptionRequest,
  configSetRequest,
  relationRequest,
  releaseSessionRequest,
} from "@/lib/db/providers/sql/spark/requests";
import { type SparkSessionDeps, type SparkSessionHandle, SparkSessions } from "@/lib/db/providers/sql/spark/session";
import type { DatabaseConnection } from "@/lib/types";
import { captureBytes, readSparkCapture } from "../../../helpers/spark-captures";
import { type SparkFakeAnswer, type SparkFakeServer, startSparkFake } from "../../../helpers/spark-connect-server";
import { columnsStream, int64Batch, largeUtf8Stream, stringBatch } from "../../../helpers/spark-ipc";

const MiB = 1_048_576;
const LIMITS = { maxReceivedBytes: 33_554_432 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_SCHEMA = { struct: { fields: [{ name: "id", data_type: { long: {} }, nullable: true }] } };
const V_SCHEMA = { struct: { fields: [{ name: "v", data_type: { string: {} }, nullable: true }] } };
const VARIANT_SCHEMA = { struct: { fields: [{ name: "v", data_type: { variant: {} }, nullable: true }] } };
const BAD_TEXT = "[TABLE_OR_VIEW_NOT_FOUND] The table or view `t` cannot be found.";
const statements: Record<string, SparkFakeAnswer> = {
  // A provider's connect and its tree read the current namespace on the metadata session.
  "SHOW CURRENT NAMESPACE": {
    kind: "command",
    ipc: columnsStream([
      { name: "catalog", kind: "utf8", values: ["spark_catalog"] },
      { name: "namespace", kind: "utf8", values: ["default"] },
    ]),
  },
  "SELECT id FROM t": { kind: "relation", schema: ID_SCHEMA, ipc: [int64Batch(0, 3)] },
  "SHOW TABLES": { kind: "command", ipc: stringBatch(2, 3) },
  "CREATE TABLE x": { kind: "command", ipc: new Uint8Array(0) },
  "SELECT names": {
    kind: "command",
    ipc: columnsStream([
      { name: "__proto__", kind: "int64", values: [BigInt(1)] },
      { name: "a", kind: "int64", values: [BigInt(2)] },
      { name: "a", kind: "int64", values: [BigInt(3)] },
    ]),
  },
  // The DataType declares a bigint id; the batch holds a string v.
  DISAGREE: { kind: "relation", schema: ID_SCHEMA, ipc: [stringBatch(1, 3)] },
  // A VARIANT whose value holds no byte, not even its header.
  "BAD CELL": {
    kind: "relation",
    schema: VARIANT_SCHEMA,
    ipc: [
      columnsStream([
        {
          name: "v",
          kind: "struct",
          length: 1,
          children: [
            { name: "value", kind: "binary", values: [new Uint8Array(0)] },
            {
              name: "metadata",
              kind: "binary",
              values: [Uint8Array.of(0x01, 0x00, 0x00)],
              metadata: { variant: "true" },
            },
          ],
        },
      ]),
    ],
  },
  SLOW: { kind: "silent" },
  PROGRESS: { kind: "progress-only" },
  BAD: {
    kind: "error",
    code: 13,
    message: BAD_TEXT,
    errorInfo: { errorClass: "TABLE_OR_VIEW_NOT_FOUND", sqlState: "42P01", errorId: "err-bad-1" },
    fetch: {
      root_error_idx: 0,
      errors: [
        { error_type_hierarchy: [], message: "root", stack_trace: [], cause_idx: 1 },
        { error_type_hierarchy: [], message: "Permission denied", stack_trace: [] },
      ],
    },
  },
  DROPPED: { kind: "status", code: 14, message: "upstream reset" },
  PING: { kind: "status", code: 8, message: "Bandwidth exhausted or memory limit exceeded" },
  RESET: { kind: "reset" },
  HUGE: { kind: "oversized", bytes: 17 * MiB, path: "relation" },
  "HUGE COMMAND": { kind: "oversized", bytes: 17 * MiB, path: "command" },
  GAP: { kind: "relation", schema: V_SCHEMA, ipc: [stringBatch(1, 5 * MiB)], corrupt: "gap" },
  LARGE: { kind: "relation", schema: V_SCHEMA, ipc: [largeUtf8Stream()] },
};
let fake: SparkFakeServer;
let channel: SparkWireChannel;
let port = 0;
const control = () => ({ metadata: {}, deadline: new Date(Date.now() + 5_000), signal: new AbortController().signal });
const soon = (ms = 5_000) => new Date(Date.now() + ms);
const interrupts = () => fake.log.entries.filter((entry) => entry.rpc === "Interrupt");
const plans = () =>
  fake.log.entries.filter((entry) => entry.rpc === "ExecutePlan" && entry.tags[0]?.startsWith("libredb-studio-"));
const tagOf = (entry: { request: object }) => (entry.request as { operation_tag?: string }).operation_tag;
const observedId = (entry: { request: object }) =>
  (entry.request as { client_observed_server_side_session_id?: string }).client_observed_server_side_session_id;
/** A heartbeat's Config get_option, which arrives every 50 ms while a run holds its session. */
const isBeat = (entry: { rpc: string; request: object }) =>
  entry.rpc === "Config" && JSON.stringify(entry.request).includes("spark.sql.ansi.enabled");

function settle<T>(promise: Promise<T>): Promise<{ readonly value?: T; readonly error?: SparkError }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error as SparkError }),
  );
}
async function failure(promise: Promise<unknown>): Promise<SparkError> {
  const outcome = await settle(promise);
  if (outcome.error === undefined) throw new Error("the run answered, though this test expects it to fail");
  expect(outcome.error).toBeInstanceOf(SparkError);
  return outcome.error;
}
async function waitFor(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > 1_000) throw new Error("the condition did not hold within one second");
    // oxlint-disable-next-line no-await-in-loop -- the condition is polled once per turn.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** One turn of the event loop, by which every settled promise has run its handlers; Bun's fake timers leave it real. */
const turn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** The fake's channel, except that each RPC of `refused` fails before it is sent; `asked` records each refused call. */
function refusing(refused: readonly string[]): { readonly wire: SparkWireChannel; readonly asked: string[] } {
  const asked: string[] = [];
  const wire: SparkWireChannel = {
    unary: (rpc, request, call) => {
      if (!refused.includes(rpc)) return channel.unary(rpc, request, call);
      asked.push(rpc);
      return Promise.reject(new Error(`${rpc} refused by the test`));
    },
    executePlan: (request, call, limits) => channel.executePlan(request, call, limits),
    close: () => undefined,
  };
  return { wire, asked };
}

/** The fake's channel, with every ExecutePlan response's schema taken away, as a server that sends none would answer. */
function schemaless(): SparkWireChannel {
  return {
    unary: (rpc, request, call) => channel.unary(rpc, request, call),
    executePlan: (request, call, limits) => {
      const stream = channel.executePlan(request, call, limits);
      return {
        read: async () => {
          const response = await stream.read();
          return response === undefined ? undefined : { ...response, schema: null };
        },
        get receivedBytes() {
          return stream.receivedBytes;
        },
        get truncated() {
          return stream.truncated;
        },
        cancel: () => stream.cancel(),
      };
    },
    close: () => undefined,
  };
}

/**
 * The channel `inner`, the fake's unless given, with each unary `held` call waiting until the test opens it; `waiting`
 * settles once one does.
 */
function heldUnary(
  held: string,
  inner: SparkWireChannel = channel,
): {
  readonly wire: SparkWireChannel;
  readonly waiting: Promise<void>;
  readonly open: () => void;
} {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const wire: SparkWireChannel = {
    unary: async (rpc, request, call) => {
      if (rpc === held) {
        reached();
        await gate;
      }
      return inner.unary(rpc, request, call);
    },
    executePlan: (request, call, limits) => inner.executePlan(request, call, limits),
    close: () => undefined,
  };
  return { wire, waiting, open };
}

/** The fake's channel, recording the call and the limits each ExecutePlan is opened with. */
function recording(): {
  readonly wire: SparkWireChannel;
  readonly opened: { readonly call: SparkWireCall; readonly limits: object }[];
} {
  const opened: { readonly call: SparkWireCall; readonly limits: object }[] = [];
  const wire: SparkWireChannel = {
    unary: (rpc, request, call) => channel.unary(rpc, request, call),
    executePlan: (request, call, limits) => {
      opened.push({ call, limits });
      return channel.executePlan(request, call, limits);
    },
    close: () => undefined,
  };
  return { wire, opened };
}

/**
 * The fake's channel, with each ExecutePlan stream's reads passed through the function `change` makes for its request,
 * which sees each response in turn, the end (undefined) included.
 */
function readThrough(
  change: (request: object) => (response: object | undefined) => Promise<object | undefined>,
): SparkWireChannel {
  return {
    unary: (rpc, request, call) => channel.unary(rpc, request, call),
    executePlan: (request, call, limits) => {
      const stream = channel.executePlan(request, call, limits);
      const changed = change(request);
      return {
        read: async () => changed(await stream.read()),
        get receivedBytes() {
          return stream.receivedBytes;
        },
        get truncated() {
          return stream.truncated;
        },
        cancel: () => stream.cancel(),
      };
    },
    close: () => undefined,
  };
}

/** Each ExecutePlan's end handed over only once `time` has passed, so a deadline can pass between the two steps. */
const endAfter = (time: Date) =>
  readThrough(() => async (response) => {
    if (response === undefined) await new Promise((resolve) => setTimeout(resolve, time.getTime() - Date.now() + 5));
    return response;
  });

/**
 * The fake's channel for every unary call, and ExecutePlan over a channel of its own that is closed once the first
 * step's stream ended, so the second step meets a closed channel.
 */
function closedAfterFirstStep(): SparkWireChannel {
  const own = grpcWireTransport(
    buildSparkConnectionOptions(
      { id: "c", name: "c", type: "spark", host: "127.0.0.1", port } as unknown as DatabaseConnection,
      { queryTimeout: 5_000 },
    ),
  );
  return {
    unary: (rpc, request, call) => channel.unary(rpc, request, call),
    executePlan: (request, call, limits) => {
      const stream = own.executePlan(request, call, limits);
      return {
        read: async () => {
          const response = await stream.read();
          if (response === undefined) own.close();
          return response;
        },
        get receivedBytes() {
          return stream.receivedBytes;
        },
        get truncated() {
          return stream.truncated;
        },
        cancel: () => stream.cancel(),
      };
    },
    close: () => own.close(),
  };
}

/**
 * Every relation-step response after the first given a new server-side id, as a server that never checks the observed
 * id would answer once it restarted under an open stream.
 */
const rewritingIds = () =>
  readThrough((request) => {
    const relationStep = "root" in (request as { plan: object }).plan;
    let read = 0;
    return async (response) => {
      read += 1;
      return relationStep && read > 1 && response !== undefined
        ? { ...response, server_side_session_id: randomUUID() }
        : response;
    };
  });

/**
 * The fake's channel, with each Interrupt held before it is sent until the test lets it go or fails it; `order` records
 * the Interrupt when the run hands it over, the next event-loop turn after each Interrupt, the abort of the run's
 * signal, and each Interrupt's answer once the fake answered it.
 */
function heldInterrupt(): {
  readonly wire: SparkWireChannel;
  readonly order: string[];
  readonly letGo: (how: "send" | "fail") => void;
} {
  let letGo: (how: "send" | "fail") => void = () => undefined;
  const gate = new Promise<"send" | "fail">((resolve) => {
    letGo = resolve;
  });
  const order: string[] = [];
  const watched = new Set<AbortSignal>();
  const wire: SparkWireChannel = {
    unary: async (rpc, request, call) => {
      if (rpc !== "Interrupt") return channel.unary(rpc, request, call);
      order.push("Interrupt");
      setImmediate(() => order.push("turn"));
      if ((await gate) === "fail") throw new Error("Interrupt failed by the test");
      const answer = await channel.unary(rpc, request, call);
      order.push("answered");
      return answer;
    },
    executePlan: (request, call, limits) => {
      if (!watched.has(call.signal)) {
        watched.add(call.signal);
        call.signal.addEventListener("abort", () => order.push("abort"), { once: true });
      }
      return channel.executePlan(request, call, limits);
    },
    close: () => undefined,
  };
  return { wire, order, letGo: (how) => letGo(how) };
}

/** The SQL text of a command step's request. */
const commandText = (request: object) =>
  (request as { plan?: { command?: { sql_command?: { input?: { sql?: { query?: string } } } } } }).plan?.command
    ?.sql_command?.input?.sql?.query;

/**
 * A provider's transport: the real adapter over the fake, with the Config set of every session after the first held
 * until the test opens it; `held` settles once one waits. `sent` records, in order, each call the provider hands the
 * channel as it asks for it: an RPC by its name, an ExecutePlan with its statement, and the channel's close.
 */
function laterSetupsHeld(): {
  readonly transport: SparkWireTransport;
  readonly sent: string[];
  readonly held: Promise<void>;
  readonly open: () => void;
} {
  const sent: string[] = [];
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let setups = 0;
  const transport: SparkWireTransport = (options) => {
    const inner = grpcWireTransport(options);
    return {
      unary: async (rpc, request, call) => {
        sent.push(rpc);
        if (rpc === "Config" && (request as { operation?: { set?: object } }).operation?.set !== undefined) {
          setups += 1;
          if (setups > 1) {
            reached();
            await gate;
          }
        }
        return inner.unary(rpc, request, call);
      },
      executePlan: (request, call, limits) => {
        sent.push(`ExecutePlan ${commandText(request)}`);
        return inner.executePlan(request, call, limits);
      },
      close: () => {
        sent.push("close");
        inner.close();
      },
    };
  };
  return { transport, sent, held, open: () => open() };
}

const SPARK_SOURCE = join(import.meta.dir, "../../../../src/lib/db/providers/sql/spark");
const FAKE_SERVER = join(import.meta.dir, "../../../helpers/spark-connect-server.ts");
const NODE_STOPS = 5;

/**
 * A Node program that Stops `stops` silent runs over the fake, through a relay that reads the frames the client
 * writes, and prints for each Stop its answer, the run's category and which left the client first: the Interrupt's
 * last frame or the reset of the run's stream.
 */
function stopChild(stops: number): string {
  const spark = (file: string) => JSON.stringify(join(SPARK_SOURCE, file));
  return `import net from "node:net";
import { buildSparkConnectionOptions } from ${spark("connection-options.ts")};
import { SparkRuns } from ${spark("execute.ts")};
import { grpcWireTransport } from ${spark("grpc-client.ts")};
import { SparkHeartbeat } from ${spark("heartbeat.ts")};
import { configSetRequest, releaseSessionRequest } from ${spark("requests.ts")};
import { SparkSessions } from ${spark("session.ts")};
import { startSparkFake } from ${JSON.stringify(FAKE_SERVER)};

const DATA = 0;
const HEADERS = 1;
const RST_STREAM = 3;
const END_STREAM = 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fake = await startSparkFake({ statements: { SLOW: { kind: "silent" } } });
const fakePort = Number(fake.target.slice(fake.target.lastIndexOf(":") + 1));
// Each frame the client writes, as [type, flags, stream], in the order it leaves the client.
const frames = [];
const relay = net.createServer((client) => {
  const upstream = net.connect(fakePort, "127.0.0.1");
  let pending = Buffer.alloc(0);
  let preface = 24;
  client.on("data", (chunk) => {
    upstream.write(chunk);
    pending = Buffer.concat([pending, chunk]);
    const skipped = Math.min(preface, pending.length);
    pending = pending.subarray(skipped);
    preface -= skipped;
    while (pending.length >= 9 && pending.length >= 9 + pending.readUIntBE(0, 3)) {
      frames.push([pending[3], pending[4], pending.readUInt32BE(5) & 0x7fffffff]);
      pending = pending.subarray(9 + pending.readUIntBE(0, 3));
    }
  });
  upstream.on("data", (chunk) => client.write(chunk));
  client.on("error", () => client.destroy());
  upstream.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
});
await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
const port = relay.address().port;
const channel = grpcWireTransport(
  buildSparkConnectionOptions({ id: "c", name: "c", type: "spark", host: "127.0.0.1", port }, { queryTimeout: 5000 }),
);
const control = () => ({ metadata: {}, deadline: new Date(Date.now() + 5000), signal: new AbortController().signal });
const sessions = new SparkSessions(
  {
    configSet: async (session, pairs) =>
      (await channel.unary("Config", configSetRequest(session, pairs), control())).server_side_session_id,
    runSetup: async () => "",
    release: async (session) => {
      await channel.unary("ReleaseSession", releaseSessionRequest(session), control());
    },
  },
  {},
);
const runs = new SparkRuns({
  channel: () => channel,
  metadata: {},
  heartbeat: new SparkHeartbeat(async () => undefined),
  sessions,
  errorConnection: { host: "127.0.0.1", port, secretForms: [] },
  timeoutMs: 5000,
});
const stops = [];
for (let index = 0; index < ${stops}; index += 1) {
  fake.log.clear();
  const running = runs
    .run({
      sql: "SLOW",
      queryId: "q" + index,
      session: () => sessions.forScope("s" + index),
      deadline: new Date(Date.now() + 5000),
    })
    .then(() => "answered", (error) => error.category);
  for (let waited = 0; fake.log.entries.filter((entry) => entry.rpc === "ExecutePlan").length < 2; waited += 2) {
    if (waited > 2000) throw new Error("the run did not open its second step");
    await sleep(2);
  }
  // The second step's stream is the last one the client opened, and the Interrupt opens the next.
  const step = Math.max(...frames.filter(([type]) => type === HEADERS).map(([, , stream]) => stream));
  const mark = frames.length;
  const answered = await runs.cancel("q" + index);
  const category = await running;
  const found = () => {
    const later = frames.slice(mark);
    return {
      reset: later.findIndex(([type, , stream]) => type === RST_STREAM && stream === step),
      interrupt: later.findIndex(
        ([type, flags, stream]) => type === DATA && stream > step && (flags & END_STREAM) !== 0,
      ),
    };
  };
  for (let waited = 0; (found().reset === -1 || found().interrupt === -1) && waited < 1000; waited += 5) {
    await sleep(5);
  }
  const { reset, interrupt } = found();
  const first = reset === -1 || interrupt === -1 ? "missing" : interrupt < reset ? "Interrupt" : "reset";
  stops.push({ answered, category, first });
}
await sessions.releaseAll();
channel.close();
relay.close();
fake.close();
process.stdout.write(JSON.stringify({ version: process.version, stops }) + "\\n", () => process.exit(0));
`;
}

function world(wire: SparkWireChannel = channel, metadata: Readonly<Record<string, string>> = {}) {
  const deps: SparkSessionDeps = {
    configSet: async (session, pairs) =>
      (
        (await channel.unary("Config", configSetRequest(session, pairs), control())) as {
          server_side_session_id: string;
        }
      ).server_side_session_id,
    runSetup: async () => {
      throw new Error("these tests set no catalog and no namespace");
    },
    // Through the run's channel, so a test can hold the release of a statement session.
    release: async (session) => {
      await wire.unary("ReleaseSession", releaseSessionRequest(session), control());
    },
  };
  const sessions = new SparkSessions(deps, {});
  // Every beat's answer is kept, so a test can await a beat already in flight when the run released the heartbeat,
  // since the release stops later ticks but cannot wait for that one.
  const beatAnswers: Promise<unknown>[] = [];
  const heartbeat = new SparkHeartbeat(async (session) => {
    const answer = channel.unary("Config", configGetOptionRequest(session, ["spark.sql.ansi.enabled"]), control());
    beatAnswers.push(answer);
    await answer;
  }, 50);
  const runs = new SparkRuns({
    channel: () => wire,
    metadata,
    heartbeat,
    sessions,
    errorConnection: { host: "127.0.0.1", port, secretForms: [] },
    timeoutMs: 5_000,
  });
  return { sessions, runs, beatAnswers };
}

beforeAll(async () => {
  fake = await startSparkFake({ statements, progressEveryMs: 50, reattachWindowMs: 300 });
  port = Number(fake.target.slice(fake.target.lastIndexOf(":") + 1));
  channel = grpcWireTransport(
    buildSparkConnectionOptions(
      { id: "c", name: "c", type: "spark", host: "127.0.0.1", port } as unknown as DatabaseConnection,
      { queryTimeout: 5_000 },
    ),
  );
});
afterAll(() => {
  channel.close();
  fake.close();
});
beforeEach(() => fake.log.clear());

describe("the two steps", () => {
  test("a query: its lazy relation, then its batches; one tag, two operations, 4 MiB chunks, no reattach option", async () => {
    const { sessions, runs } = world();
    const result = await runs.run({
      sql: "SELECT id FROM t",
      session: () => sessions.forScope("s1"),
      deadline: soon(),
    });
    expect(result).toStrictEqual({
      fields: ["id"],
      rows: [{ id: 0 }, { id: 1 }, { id: 2 }],
      columnTypes: { id: "bigint" },
      cut: null,
    });
    const [first, second] = plans();
    expect(plans()).toHaveLength(2);
    expect(first?.tags).toStrictEqual(second?.tags ?? []);
    expect(first?.operationId).not.toBe(second?.operationId);
    for (const entry of plans()) {
      expect(entry.reattachOptions).toBeUndefined();
      expect(JSON.stringify(entry.requestOptions)).toContain("4194304");
    }
    expect(interrupts()).toHaveLength(0);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test("both steps carry the run's deadline, its one signal and the 32 MiB stream bound", async () => {
    const { wire, opened } = recording();
    const { sessions, runs } = world(wire);
    const deadline = soon();
    await runs.run({ sql: "SELECT id FROM t", session: () => sessions.forScope("s6"), deadline });
    expect(opened.map((entry) => entry.limits)).toStrictEqual([LIMITS, LIMITS]);
    for (const entry of opened) expect(entry.call.deadline.getTime()).toBe(deadline.getTime());
    const [first, second] = opened;
    expect(second?.call.signal).toBe(first?.call.signal);
    // The run's own signal, which its end aborts.
    expect(first?.call.signal.aborted).toBe(true);
    await sessions.releaseAll();
  });

  test("every ExecutePlan, Interrupt and FetchErrorDetails the run sends carries the connection's metadata", async () => {
    const { sessions, runs } = world(channel, { authorization: "Bearer t" });
    await failure(runs.run({ sql: "BAD", session: () => sessions.forScope("m1"), deadline: soon() }));
    await failure(runs.run({ sql: "SLOW", session: () => sessions.forScope("m2"), deadline: soon(150) }));
    const sent = fake.log.entries.filter((entry) =>
      ["ExecutePlan", "Interrupt", "FetchErrorDetails"].includes(entry.rpc),
    );
    expect([...new Set(sent.map((entry) => entry.rpc))].sort()).toStrictEqual([
      "ExecutePlan",
      "FetchErrorDetails",
      "Interrupt",
    ]);
    for (const entry of sent) expect(entry.metadata.authorization).toBe("Bearer t");
    await sessions.releaseAll();
  });

  test("a command answers inline in one ExecutePlan", async () => {
    const { sessions, runs } = world();
    const result = await runs.run({ sql: "SHOW TABLES", session: () => sessions.forScope("s2"), deadline: soon() });
    expect(result.rows).toHaveLength(2);
    expect(plans()).toHaveLength(1);
    await sessions.releaseAll();
  });

  test("an inline answer with no data is an empty result, whole and uninterrupted", async () => {
    const { sessions, runs } = world();
    const result = await runs.run({ sql: "CREATE TABLE x", session: () => sessions.forScope("s4"), deadline: soon() });
    expect(result).toStrictEqual({ fields: [], rows: [], columnTypes: {}, cut: null });
    expect(plans()).toHaveLength(1);
    expect(interrupts()).toHaveLength(0);
    await sessions.releaseAll();
  });

  test("each column is keyed under a unique name as an own property, __proto__ and a repeated name included", async () => {
    const { sessions, runs } = world();
    const result = await runs.run({ sql: "SELECT names", session: () => sessions.forScope("s5"), deadline: soon() });
    expect(result.fields).toStrictEqual(["__proto__", "a", "a (2)"]);
    expect(result.rows).toHaveLength(1);
    expect(Object.getPrototypeOf(result.rows[0])).toBe(Object.prototype);
    expect(Object.entries(result.rows[0] ?? {})).toStrictEqual([
      ["__proto__", 1],
      ["a", 2],
      ["a (2)", 3],
    ]);
    expect(Object.getPrototypeOf(result.columnTypes)).toBe(Object.prototype);
    expect(Object.entries(result.columnTypes)).toStrictEqual([
      ["__proto__", "bigint"],
      ["a", "bigint"],
      ["a (2)", "bigint"],
    ]);
    await sessions.releaseAll();
  });

  test("the run records the server-side id of its first answer on a session that had none, and the second step sends it", async () => {
    const { runs } = world();
    // Not set up through the registry, so only the run's own observe can record the fake's id.
    const session: SparkSessionHandle = { sessionId: randomUUID(), kind: "request" };
    const result = await runs.run({ sql: "SELECT id FROM t", session: async () => session, deadline: soon() });
    expect(result.rows).toHaveLength(3);
    expect(session.serverSideSessionId).toMatch(UUID);
    expect(plans().map(observedId)).toStrictEqual([undefined, session.serverSideSessionId]);
    await channel.unary("ReleaseSession", releaseSessionRequest(session), control());
  });
});

describe("the deadline and Stop", () => {
  test("the deadline is a QueryError sentence after one Interrupt that reaches the fake after it passed", async () => {
    const { sessions, runs } = world();
    const deadline = soon(200);
    const error = await failure(runs.run({ sql: "SLOW", session: () => sessions.forScope("d"), deadline }));
    expect(error.category).toBe("deadline");
    expect(error.message).toBe(SPARK_ERROR_SENTENCES.deadline(5_000));
    expect(interrupts()).toHaveLength(1);
    expect(interrupts()[0]?.at ?? 0).toBeGreaterThanOrEqual(deadline.getTime());
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    await sessions.releaseAll();
  });

  test("a deadline that passes while the session is still in setup ends the run as not sent: no ExecutePlan and no Interrupt", async () => {
    const { sessions, runs } = world();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const deadline = soon(50);
    const running = runs.run({
      sql: "CREATE TABLE x",
      session: async () => {
        await gate;
        return sessions.forScope("dp");
      },
      deadline,
    });
    // The setup outlives the deadline, so only a check made once the session is ready can refuse the statement.
    await waitFor(() => Date.now() >= deadline.getTime());
    open();
    const error = await failure(running);
    expect(error.category).toBe("deadline");
    expect(error.message).toBe(SPARK_ERROR_SENTENCES.deadlineBeforeSend(5_000));
    expect(toDatabaseError(error)).toBeInstanceOf(QueryError);
    expect(plans()).toHaveLength(0);
    expect(interrupts()).toHaveLength(0);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test("a run given its caller's sentence for a deadline that passes before its first ExecutePlan ends with that sentence, sending nothing", async () => {
    const { sessions, runs } = world();
    const gate = Promise.withResolvers<void>();
    const deadline = soon(50);
    const running = runs.run({
      sql: "CREATE TABLE x",
      session: async () => {
        await gate.promise;
        return sessions.forScope("ds");
      },
      deadline,
      deadlineBeforeSend: (timeoutMs) => `sent once before, ${timeoutMs} ms`,
    });
    await waitFor(() => Date.now() >= deadline.getTime());
    gate.resolve();
    const error = await failure(running);
    expect({ category: error.category, message: error.message }).toStrictEqual({
      category: "deadline",
      message: "sent once before, 5000 ms",
    });
    expect(plans()).toHaveLength(0);
    expect(interrupts()).toHaveLength(0);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test("a deadline that passes between the two steps sends no second ExecutePlan, then one Interrupt by the run's tag", async () => {
    const deadline = soon(100);
    const { sessions, runs } = world(endAfter(deadline));
    const error = await failure(
      runs.run({ sql: "SELECT id FROM t", session: () => sessions.forScope("db"), deadline }),
    );
    expect(error.category).toBe("deadline");
    expect(error.message).toBe(SPARK_ERROR_SENTENCES.deadline(5_000));
    expect(plans()).toHaveLength(1);
    expect(interrupts()).toHaveLength(1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    await sessions.releaseAll();
  });

  test("an Interrupt that fails changes nothing: the deadline still stands and the run ends", async () => {
    const { wire, asked } = refusing(["Interrupt"]);
    const { sessions, runs } = world(wire);
    const error = await failure(runs.run({ sql: "SLOW", session: () => sessions.forScope("di"), deadline: soon(200) }));
    expect(error.category).toBe("deadline");
    expect(error.message).toBe(SPARK_ERROR_SENTENCES.deadline(5_000));
    expect(asked).toStrictEqual(["Interrupt"]);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test("Stop answers true, sends one Interrupt by the run's tag and ends the run cancelled; then false", async () => {
    const { sessions, runs } = world();
    const running = settle(
      runs.run({ sql: "SLOW", queryId: "q1", session: () => sessions.forScope("c"), deadline: soon() }),
    );
    await waitFor(() => plans().length === 2);
    expect(await runs.cancel("q1")).toBe(true);
    expect((await running).error?.category).toBe("cancelled");
    expect(interrupts()).toHaveLength(1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    expect(await runs.cancel("q1")).toBe(false);
    expect(await runs.cancel("unknown")).toBe(false);
    await sessions.releaseAll();
  });

  test("Stop aborts the run's stream without waiting for the Interrupt's answer, and answers once the Interrupt did", async () => {
    const held = heldInterrupt();
    const { sessions, runs } = world(held.wire);
    let ended = false;
    const running = settle(
      runs.run({ sql: "SLOW", queryId: "qh", session: () => sessions.forScope("h"), deadline: soon() }),
    ).finally(() => {
      ended = true;
    });
    await waitFor(() => plans().length === 2);
    let answered: boolean | undefined;
    const stopping = runs.cancel("qh").then((value) => {
      answered = value;
      return value;
    });
    // The run ends while its Interrupt is held: the abort did not wait for the Interrupt's answer.
    await waitFor(() => ended);
    expect((await running).error?.category).toBe("cancelled");
    expect(held.order).toStrictEqual(["Interrupt", "turn", "abort"]);
    expect(answered).toBeUndefined();
    held.letGo("send");
    expect(await stopping).toBe(true);
    expect(interrupts()).toHaveLength(1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    await sessions.releaseAll();
  });

  test("with its Interrupt unanswered, Stop answers SPARK_CONTROL_DEADLINE_MS after the Stop, not after the abort or the run's end", async () => {
    const held = heldInterrupt();
    const { sessions, runs } = world(held.wire);
    const running = settle(
      runs.run({ sql: "SLOW", queryId: "qw", session: () => sessions.forScope("w"), deadline: soon() }),
    );
    await waitFor(() => plans().length === 2);
    let answered: boolean | undefined;
    // Bun's fake timers hold setTimeout and Date.now, not setImmediate, so the run's one turn to the abort stays real.
    jest.useFakeTimers();
    try {
      const stopping = runs.cancel("qw").then((value) => {
        answered = value;
      });
      // Four seconds pass before the abort, so a window counted from the abort or the run's end would close later.
      jest.advanceTimersByTime(4_000);
      expect((await running).error?.category).toBe("cancelled");
      jest.advanceTimersByTime(SPARK_CONTROL_DEADLINE_MS - 4_000 - 1);
      await turn();
      expect(answered).toBeUndefined();
      jest.advanceTimersByTime(1);
      await turn();
      expect(answered).toBe(true);
      await stopping;
    } finally {
      jest.useRealTimers();
    }
    held.letGo("send");
    await waitFor(() => interrupts().length === 1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    await sessions.releaseAll();
  });

  test("an Interrupt that fails after the abort changes nothing: Stop answers true and no rejection goes unhandled", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const held = heldInterrupt();
      const { sessions, runs } = world(held.wire);
      let ended = false;
      const running = settle(
        runs.run({ sql: "SLOW", queryId: "qf", session: () => sessions.forScope("f"), deadline: soon() }),
      ).finally(() => {
        ended = true;
      });
      await waitFor(() => plans().length === 2);
      const stopping = runs.cancel("qf");
      await waitFor(() => ended);
      held.letGo("fail");
      expect(await stopping).toBe(true);
      expect((await running).error?.category).toBe("cancelled");
      expect(interrupts()).toHaveLength(0);
      // A rejection that no handler took is reported once the turn that raised it is over.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toStrictEqual([]);
      await sessions.releaseAll();
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  test("Stop whose Interrupt fails still ends the run cancelled and answers true", async () => {
    const { wire, asked } = refusing(["Interrupt"]);
    const { sessions, runs } = world(wire);
    const running = settle(
      runs.run({ sql: "SLOW", queryId: "q3", session: () => sessions.forScope("ci"), deadline: soon() }),
    );
    await waitFor(() => plans().length === 2);
    expect(await runs.cancel("q3")).toBe(true);
    expect((await running).error?.category).toBe("cancelled");
    expect(asked).toStrictEqual(["Interrupt"]);
    await sessions.releaseAll();
  });

  test("Stop while the session is still in setup answers true at once and sends no ExecutePlan and no Interrupt", async () => {
    const { sessions, runs } = world();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const running = settle(
      runs.run({
        sql: "SELECT id FROM t",
        queryId: "q2",
        session: async () => {
          await gate;
          return sessions.forScope("g");
        },
        deadline: soon(),
      }),
    );
    expect(await runs.cancel("q2")).toBe(true);
    open();
    expect((await running).error?.category).toBe("cancelled");
    expect(plans()).toHaveLength(0);
    expect(interrupts()).toHaveLength(0);
    await sessions.releaseAll();
  });

  test("Stop while a run refused at its deadline releases its statement session waits for the run's end and answers false", async () => {
    const release = heldUnary("ReleaseSession");
    const { sessions, runs } = world(release.wire);
    const running = settle(
      runs.run({
        sql: "CREATE TABLE x",
        queryId: "qr",
        session: () => sessions.forScope(undefined),
        deadline: new Date(Date.now() - 1),
      }),
    );
    await release.waiting;
    let answered: boolean | undefined;
    const stopping = runs.cancel("qr").then((value) => {
      answered = value;
      return value;
    });
    // The run's outcome is not settled while its release is held, so Stop has nothing to answer from yet.
    await turn();
    expect(answered).toBeUndefined();
    release.open();
    expect(await stopping).toBe(false);
    const error = (await running).error;
    expect(error?.category).toBe("deadline");
    expect(error?.message).toBe(SPARK_ERROR_SENTENCES.deadlineBeforeSend(5_000));
    expect(plans()).toHaveLength(0);
    expect(interrupts()).toHaveLength(0);
    expect(fake.log.entries.filter((entry) => entry.rpc === "ReleaseSession")).toHaveLength(1);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test("Stop on a run refused as cancelled while its statement session's release is held answers true once the run settles", async () => {
    const release = heldUnary("ReleaseSession");
    const { sessions, runs } = world(release.wire);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const running = settle(
      runs.run({
        sql: "CREATE TABLE x",
        queryId: "qc",
        session: async () => {
          await gate;
          return sessions.forScope(undefined);
        },
        deadline: soon(),
      }),
    );
    expect(await runs.cancel("qc")).toBe(true);
    open();
    await release.waiting;
    let answered: boolean | undefined;
    const stopping = runs.cancel("qc").then((value) => {
      answered = value;
      return value;
    });
    // The run's outcome is not settled while its release is held, so Stop has nothing to answer from yet.
    await turn();
    expect(answered).toBeUndefined();
    release.open();
    expect(await stopping).toBe(true);
    expect((await running).error?.category).toBe("cancelled");
    expect(plans()).toHaveLength(0);
    expect(interrupts()).toHaveLength(0);
    expect(fake.log.entries.filter((entry) => entry.rpc === "ReleaseSession")).toHaveLength(1);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test("Stop on a run refused at its deadline whose release never answers answers false SPARK_CONTROL_DEADLINE_MS after the Stop", async () => {
    const release = heldUnary("ReleaseSession");
    const { sessions, runs } = world(release.wire);
    const running = settle(
      runs.run({
        sql: "CREATE TABLE x",
        queryId: "qt",
        session: () => sessions.forScope(undefined),
        deadline: new Date(Date.now() - 1),
      }),
    );
    await release.waiting;
    let answered: boolean | undefined;
    jest.useFakeTimers();
    try {
      const stopping = runs.cancel("qt").then((value) => {
        answered = value;
      });
      jest.advanceTimersByTime(SPARK_CONTROL_DEADLINE_MS - 1);
      await turn();
      expect(answered).toBeUndefined();
      jest.advanceTimersByTime(1);
      await turn();
      expect(answered).toBe(false);
      await stopping;
    } finally {
      jest.useRealTimers();
    }
    release.open();
    expect((await running).error?.category).toBe("deadline");
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test("cancelAll stops every run, and runsInFlight counts them", async () => {
    const { sessions, runs } = world();
    const one = settle(runs.run({ sql: "SLOW", session: () => sessions.forScope("x1"), deadline: soon() }));
    const two = settle(
      runs.run({ sql: "SLOW", queryId: "x2", session: () => sessions.forScope("x2"), deadline: soon() }),
    );
    await waitFor(() => plans().length === 4);
    expect(runs.runsInFlight()).toBe(2);
    await runs.cancelAll();
    expect((await one).error?.category).toBe("cancelled");
    expect((await two).error?.category).toBe("cancelled");
    expect(interrupts()).toHaveLength(2);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test.each(["send", "fail"] as const)(
    "cancelAll aborts each run one turn after its Interrupt without waiting for the answers, then awaits them (%s)",
    async (how) => {
      const unhandled: unknown[] = [];
      const record = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", record);
      try {
        const held = heldInterrupt();
        const { sessions, runs } = world(held.wire);
        let ended = 0;
        const end = () => {
          ended += 1;
        };
        const one = settle(runs.run({ sql: "SLOW", session: () => sessions.forScope("y1"), deadline: soon() })).finally(
          end,
        );
        const two = settle(
          runs.run({ sql: "SLOW", queryId: "y2", session: () => sessions.forScope("y2"), deadline: soon() }),
        ).finally(end);
        await waitFor(() => plans().length === 4);
        let stopped = false;
        const stopping = runs.cancelAll().then(() => {
          stopped = true;
        });
        // Both runs end while their Interrupts are held: no abort waited for an Interrupt's answer.
        await waitFor(() => ended === 2);
        expect((await one).error?.category).toBe("cancelled");
        expect((await two).error?.category).toBe("cancelled");
        expect(held.order).toStrictEqual(["Interrupt", "Interrupt", "turn", "abort", "turn", "abort"]);
        expect(stopped).toBe(false);
        held.letGo(how);
        await stopping;
        const tags = [...new Set(plans().map((entry) => entry.tags[0]))].sort();
        expect(interrupts().map(tagOf).sort()).toStrictEqual(how === "send" ? tags : []);
        // A rejection that no handler took is reported once the turn that raised it is over.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).toStrictEqual([]);
        expect(runs.runsInFlight()).toBe(0);
        await sessions.releaseAll();
      } finally {
        process.off("unhandledRejection", record);
      }
    },
  );

  test("a run ended under cancelAll stays in flight until its Interrupt answered, and a Stop then answers true and sends no second Interrupt", async () => {
    const held = heldInterrupt();
    const { sessions, runs } = world(held.wire);
    let ended = false;
    const running = settle(
      runs.run({ sql: "SLOW", queryId: "qs", session: () => sessions.forScope("s"), deadline: soon() }),
    ).finally(() => {
      ended = true;
    });
    await waitFor(() => plans().length === 2);
    const stopping = runs.cancelAll();
    // The run ends while cancelAll's Interrupt is held, so cancelAll is still stopping it.
    await waitFor(() => ended);
    expect((await running).error?.category).toBe("cancelled");
    expect(runs.runsInFlight()).toBe(1);
    expect(await runs.cancel("qs")).toBe(true);
    expect(held.order).toStrictEqual(["Interrupt", "turn", "abort"]);
    held.letGo("send");
    await stopping;
    expect(runs.runsInFlight()).toBe(0);
    expect(await runs.cancel("qs")).toBe(false);
    expect(interrupts()).toHaveLength(1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    await sessions.releaseAll();
  });

  test("a Stop's Interrupt that answers while the run releases its statement session leaves the run in flight until it settled, and a second Stop answers true", async () => {
    const held = heldInterrupt();
    const release = heldUnary("ReleaseSession", held.wire);
    const { sessions, runs } = world(release.wire);
    const running = settle(
      runs.run({ sql: "SLOW", queryId: "qv", session: () => sessions.forScope(undefined), deadline: soon() }),
    );
    await waitFor(() => plans().length === 2);
    const stopping = runs.cancel("qv");
    // The run ends cancelled and releases its statement session while the Stop's Interrupt is still held.
    await release.waiting;
    held.letGo("send");
    await waitFor(() => held.order.includes("answered"));
    expect(held.order).toStrictEqual(["Interrupt", "turn", "abort", "answered"]);
    // The Interrupt answered before the run settled, so the run is still registered and a Stop still reaches it.
    expect(runs.runsInFlight()).toBe(1);
    let answered: boolean | undefined;
    const second = runs.cancel("qv").then((value) => {
      answered = value;
      return value;
    });
    await turn();
    expect(answered).toBeUndefined();
    release.open();
    expect(await second).toBe(true);
    expect(await stopping).toBe(true);
    expect((await running).error?.category).toBe("cancelled");
    expect(runs.runsInFlight()).toBe(0);
    expect(await runs.cancel("qv")).toBe(false);
    expect(interrupts()).toHaveLength(1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    expect(fake.log.entries.filter((entry) => entry.rpc === "ReleaseSession")).toHaveLength(1);
    await sessions.releaseAll();
  });

  test("a run whose own Interrupt answered stays in flight while it releases its statement session, and a Stop then waits for its end and answers false", async () => {
    const release = heldUnary("ReleaseSession");
    const { sessions, runs } = world(release.wire);
    const running = settle(
      runs.run({ sql: "DROPPED", queryId: "qd", session: () => sessions.forScope(undefined), deadline: soon() }),
    );
    // The run awaits the answer of its own Interrupt before it releases its statement session.
    await release.waiting;
    expect(interrupts()).toHaveLength(1);
    expect(runs.runsInFlight()).toBe(1);
    let answered: boolean | undefined;
    const stopping = runs.cancel("qd").then((value) => {
      answered = value;
      return value;
    });
    // The run's outcome is not settled while its release is held, so Stop has nothing to answer from yet.
    await turn();
    expect(answered).toBeUndefined();
    release.open();
    // The run settled with the stream's failure, not as cancelled.
    expect(await stopping).toBe(false);
    const error = (await running).error;
    expect(error?.category).toBe("stream-failed");
    expect(error?.message).toBe(SPARK_ERROR_SENTENCES.streamFailed("upstream reset"));
    expect(runs.runsInFlight()).toBe(0);
    expect(interrupts()).toHaveLength(1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    expect(fake.log.entries.filter((entry) => entry.rpc === "ReleaseSession")).toHaveLength(1);
    await sessions.releaseAll();
  });
});

describe("a run that starts once cancelAll began", () => {
  test("a run that starts while cancelAll still stops another is refused as cancelled before it asks for its session, and nothing is sent for it", async () => {
    const held = heldInterrupt();
    const { sessions, runs } = world(held.wire);
    const first = settle(runs.run({ sql: "SLOW", session: () => sessions.forScope("k1"), deadline: soon() }));
    await waitFor(() => plans().length === 2);
    let stopped = false;
    const stopping = runs.cancelAll().then(() => {
      stopped = true;
    });
    const asked: string[] = [];
    const late = await failure(
      runs.run({
        sql: "SELECT id FROM t",
        queryId: "k2",
        session: () => {
          asked.push("k2");
          return sessions.forScope("k2");
        },
        deadline: soon(),
      }),
    );
    // cancelAll still waits for the first run's Interrupt: it had begun and had not answered.
    expect(stopped).toBe(false);
    expect({ category: late.category, message: late.message }).toStrictEqual({
      category: "cancelled",
      message: SPARK_ERROR_SENTENCES.cancelled,
    });
    expect(asked).toStrictEqual([]);
    expect(await runs.cancel("k2")).toBe(false);
    held.letGo("send");
    await stopping;
    expect((await first).error?.category).toBe("cancelled");
    // The first run's two steps and its one Interrupt, and nothing for the run that started late.
    expect(plans()).toHaveLength(2);
    expect(interrupts().map(tagOf)).toStrictEqual([plans()[0]?.tags[0]]);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test("a run that starts after cancelAll answered is refused as cancelled before it asks for its session, and nothing is sent for it", async () => {
    const { sessions, runs } = world();
    await runs.cancelAll();
    const asked: string[] = [];
    const late = await failure(
      runs.run({
        sql: "SELECT id FROM t",
        queryId: "k3",
        session: () => {
          asked.push("k3");
          return sessions.forScope("k3");
        },
        deadline: soon(),
      }),
    );
    expect({ category: late.category, message: late.message }).toStrictEqual({
      category: "cancelled",
      message: SPARK_ERROR_SENTENCES.cancelled,
    });
    expect(asked).toStrictEqual([]);
    expect(fake.log.entries.filter((entry) => !isBeat(entry))).toStrictEqual([]);
    expect(sessions.openCount()).toBe(0);
    expect(await runs.cancel("k3")).toBe(false);
    expect(runs.runsInFlight()).toBe(0);
  });

  test("through the provider: a metadata read that waits for a new metadata session's setup when a disconnect begins is refused as cancelled and sends no statement", async () => {
    const wire = laterSetupsHeld();
    const provider = new SparkProvider(
      { id: "late", name: "late", type: "spark", host: "127.0.0.1", port } as unknown as DatabaseConnection,
      {},
      { transport: wire.transport },
    );
    await provider.connect();
    // The server restarts, so the read meets a changed metadata session and waits for a new one's setup.
    fake.restart();
    const read = provider.listContainers().then(
      () => undefined,
      (error: unknown) => error,
    );
    await wire.held;
    wire.sent.push("disconnect");
    const closing = provider.disconnect();
    wire.open();
    await closing;
    const error = await read;
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect((error as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
    // Once the disconnect began: the new metadata session's release and the channel's close, and no statement.
    expect(wire.sent.slice(wire.sent.indexOf("disconnect"))).toStrictEqual(["disconnect", "ReleaseSession", "close"]);
    expect(wire.sent.filter((sent) => sent.startsWith("ExecutePlan"))).toStrictEqual([
      "ExecutePlan SHOW CURRENT NAMESPACE",
      "ExecutePlan SHOW CURRENT NAMESPACE",
    ]);
    expect(provider.hasRunsInFlight()).toBe(false);
  });
});

describe("Stop in a Node child, the production runtime", () => {
  test("each Stop's Interrupt leaves the client whole before the reset of the run's stream on the shared connection", async () => {
    const node = Bun.which("node");
    if (node === null) throw new Error("No node on PATH: this test runs Stop under Node; install Node 24 or later");
    const work = mkdtempSync(join(tmpdir(), "spark-stop-"));
    try {
      writeFileSync(join(work, "child.ts"), stopChild(NODE_STOPS));
      const build = await Bun.build({
        entrypoints: [join(work, "child.ts")],
        target: "node",
        format: "esm",
        outdir: work,
      });
      if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
      const child = Bun.spawn([node, join(work, "child.js")], { cwd: work, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`The Node child exited ${exitCode}: ${stderr}`);
      const { version, stops } = JSON.parse(stdout.trim()) as { version: string; stops: unknown[] };
      expect(version).toMatch(/^v\d+\.\d+\.\d+/);
      expect(stops).toStrictEqual(
        Array.from({ length: NODE_STOPS }, () => ({ answered: true, category: "cancelled", first: "Interrupt" })),
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("errors", () => {
  test("a Spark error: one FetchErrorDetails before the statement session's release, its cause shown, no Interrupt", async () => {
    const { sessions, runs } = world();
    const error = await failure(
      runs.run({ sql: "BAD", session: () => sessions.forScope(undefined), deadline: soon() }),
    );
    expect(error.category).toBe("spark");
    expect(error.message).toContain("\nCause: Permission denied");
    // A beat that a slow machine lets in between holds nothing about the order, so the beats are left out.
    expect(
      fake.log.entries
        .filter((entry) => !isBeat(entry))
        .map((entry) => entry.rpc)
        .slice(-3),
    ).toStrictEqual(["ExecutePlan", "FetchErrorDetails", "ReleaseSession"]);
    expect(interrupts()).toHaveLength(0);
  });

  test("a Stop that comes while a Spark error is decoded leaves that error, and answers false", async () => {
    const { wire, waiting: fetching, open } = heldUnary("FetchErrorDetails");
    const { sessions, runs } = world(wire);
    const running = settle(
      runs.run({ sql: "BAD", queryId: "qe", session: () => sessions.forScope("e1"), deadline: soon() }),
    );
    await fetching;
    const stopping = runs.cancel("qe");
    open();
    expect(await stopping).toBe(false);
    const error = (await running).error;
    expect(error?.category).toBe("spark");
    expect(error?.message).toContain("\nCause: Permission denied");
    // The Stop's own Interrupt, the run's at most one; Spark had ended the operation, so the run sent none of its own.
    expect(interrupts()).toHaveLength(1);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test("a relation answer without its schema is refused as unreadable after one Interrupt by the run's tag", async () => {
    const { sessions, runs } = world(schemaless());
    const error = await failure(
      runs.run({ sql: "SELECT id FROM t", session: () => sessions.forScope("ns"), deadline: soon() }),
    );
    expect(error.category).toBe("unreadable");
    expect(error.message).toBe(SPARK_ERROR_SENTENCES.unreadable("the result had no schema"));
    expect(interrupts()).toHaveLength(1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    await sessions.releaseAll();
  });

  test("a FetchErrorDetails that fails leaves the ErrorInfo message as it is", async () => {
    const { wire, asked } = refusing(["FetchErrorDetails"]);
    const { sessions, runs } = world(wire);
    const error = await failure(
      runs.run({ sql: "BAD", session: () => sessions.forScope(undefined), deadline: soon() }),
    );
    expect(error.category).toBe("spark");
    expect(error.message).toBe(BAD_TEXT);
    expect(asked).toStrictEqual(["FetchErrorDetails"]);
    expect(interrupts()).toHaveLength(0);
  });

  test("a session released under a run not marked cancelled ends it with Spark's own text, and no Interrupt", async () => {
    const { sessions, runs } = world();
    const running = settle(runs.run({ sql: "SLOW", session: () => sessions.forScope("rel"), deadline: soon() }));
    await waitFor(() => plans().length === 2);
    await sessions.endScope("rel");
    const error = (await running).error;
    expect(error?.category).toBe("spark");
    expect(error?.message).toContain("[INVALID_CURSOR.DISCONNECTED]");
    expect(interrupts()).toHaveLength(0);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test.each([
    ["closed", "session-closed", (sessions: SparkSessions) => sessions.endScope("closed")],
    ["restarted", "session-changed", () => fake.restart()],
  ] as const)("a session the server %s ends the run as %s, with no Interrupt", async (scope, category, end) => {
    const { sessions, runs } = world();
    const session = await sessions.forScope(scope);
    await end(sessions);
    const error = await failure(runs.run({ sql: "SELECT id FROM t", session: async () => session, deadline: soon() }));
    expect(error.category).toBe(category);
    expect(plans()).toHaveLength(1);
    expect(interrupts()).toHaveLength(0);
    await sessions.releaseAll();
  });

  test("a channel closed between the two steps ends the run as a SparkError: grpc-js refuses the second ExecutePlan before sending it, and no Interrupt follows", async () => {
    const { sessions, runs } = world(closedAfterFirstStep());
    const error = await failure(
      runs.run({ sql: "SELECT id FROM t", session: () => sessions.forScope("closed-channel"), deadline: soon() }),
    );
    expect([error.category, error.message]).toStrictEqual(["spark", SPARK_ERROR_SENTENCES.localClientError]);
    expect(toDatabaseError(error)).toBeInstanceOf(QueryError);
    expect(plans()).toHaveLength(1);
    expect(interrupts()).toHaveLength(0);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test("a server-side id that changes on a stream Spark has not ended ends the run as session-changed after one Interrupt by its tag", async () => {
    const { sessions, runs } = world(rewritingIds());
    const error = await failure(
      runs.run({ sql: "PROGRESS", session: () => sessions.forScope("sc"), deadline: soon() }),
    );
    expect(error.category).toBe("session-changed");
    expect(error.message).toBe(SPARK_ERROR_SENTENCES.sessionChanged);
    expect(plans()).toHaveLength(2);
    expect(interrupts()).toHaveLength(1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    expect(runs.runsInFlight()).toBe(0);
    await sessions.releaseAll();
  });

  test.each([
    ["DROPPED", "stream-failed", SPARK_ERROR_SENTENCES.streamFailed("upstream reset")],
    ["PING", "ping-goaway", SPARK_ERROR_SENTENCES.pingGoaway],
    ["HUGE", "receive-cap", SPARK_ERROR_SENTENCES.receiveCapRelation],
    ["HUGE COMMAND", "receive-cap", SPARK_ERROR_SENTENCES.receiveCapCommand],
    ["LARGE", "unreadable", SPARK_ERROR_SENTENCES.largeVarTypes],
  ] as const)("%s ends as %s after one Interrupt by the run's tag", async (sql, category, sentence) => {
    const { sessions, runs } = world();
    const error = await failure(runs.run({ sql, session: () => sessions.forScope(sql), deadline: soon() }));
    expect(error.category).toBe(category);
    expect(error.message).toBe(sentence);
    expect(interrupts()).toHaveLength(1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    await sessions.releaseAll();
  });

  test.each([
    ["DISAGREE", SPARK_ERROR_SENTENCES.unreadable("a result whose schema and batches name different columns")],
    ["BAD CELL", SPARK_ERROR_SENTENCES.cellUnreadable("variant", "v")],
  ] as const)("%s: the result is refused as unreadable after one Interrupt by the run's tag", async (sql, sentence) => {
    const { sessions, runs } = world();
    const error = await failure(runs.run({ sql, session: () => sessions.forScope(sql), deadline: soon() }));
    expect(error.category).toBe("unreadable");
    expect(error.message).toBe(sentence);
    expect(interrupts()).toHaveLength(1);
    expect(tagOf(interrupts()[0] as { request: object })).toBe(plans()[0]?.tags[0]);
    await sessions.releaseAll();
  });

  test("a chunk gap is refused as unreadable, and a reset connection fails the run; each after one Interrupt", async () => {
    const { sessions, runs } = world();
    expect(
      (await failure(runs.run({ sql: "GAP", session: () => sessions.forScope("gap"), deadline: soon() }))).category,
    ).toBe("unreadable");
    expect(interrupts()).toHaveLength(1);
    fake.log.clear();
    const reset = await failure(
      runs.run({ sql: "RESET", session: () => sessions.forScope("reset"), deadline: soon(3_000) }),
    );
    expect(["connection-dropped", "stream-failed"]).toContain(reset.category);
    await waitFor(() => interrupts().length === 1);
    await sessions.releaseAll();
  });
});

describe("the heartbeat and the reattach window", () => {
  test("beats arrive on the run's session while it runs, and stop when it ends", async () => {
    const { sessions, runs, beatAnswers } = world();
    await failure(runs.run({ sql: "SLOW", session: () => sessions.forScope("hb"), deadline: soon(320) }));
    // A beat sent by the last tick may still be on its way; await every beat's answer before counting.
    await Promise.allSettled(beatAnswers);
    const session = plans()[0]?.sessionId;
    const beats = () => fake.log.entries.filter((entry) => isBeat(entry) && entry.sessionId === session);
    expect(beats().length).toBeGreaterThanOrEqual(3);
    const settled = beats().length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(beats().length).toBe(settled);
    await sessions.releaseAll();
  });

  test("a control call that asks for reattachment ends at the 300 ms window while the run, which asks for none, outlives it", async () => {
    const { sessions, runs } = world();
    const running = settle(
      runs.run({ sql: "PROGRESS", queryId: "p", session: () => sessions.forScope("p"), deadline: soon() }),
    );
    await waitFor(() => plans().length === 2);
    const probe = channel.executePlan(
      {
        ...relationRequest(
          { sessionId: randomUUID() },
          { sql: { query: "PROGRESS" } },
          { operationId: randomUUID(), tag: "probe" },
        ),
        request_options: [{ reattach_options: { reattachable: true } }],
      },
      control(),
      LIMITS,
    );
    const started = Date.now();
    // oxlint-disable-next-line no-await-in-loop -- the probe's responses are read one after another to its end.
    for (let response = await probe.read(); response !== undefined; response = await probe.read()) void response;
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(runs.runsInFlight()).toBe(1);
    expect(await runs.cancel("p")).toBe(true);
    await running;
    for (const entry of plans()) expect(entry.reattachOptions).toBeUndefined();
    await sessions.releaseAll();
  });
});

describe("a SET and concurrent scopes", () => {
  const zstd = () => {
    const capture = readSparkCapture("4.2.0", "compressed-zstd");
    if (capture.outcome !== "pass") throw new Error("compressed-zstd is an error capture");
    const batch = (capture.payload as readonly { readonly arrow_batch?: { readonly data: unknown } | null }[]).find(
      (response) => response.arrow_batch,
    );
    return captureBytes(batch?.arrow_batch?.data);
  };

  test.each([
    [
      "SET spark.sql.execution.arrow.useLargeVarTypes=true",
      () => ({ kind: "relation", schema: V_SCHEMA, ipc: [largeUtf8Stream()] }) as SparkFakeAnswer,
      SPARK_ERROR_SENTENCES.largeVarTypes,
    ],
    [
      "SET spark.sql.execution.arrow.compression.codec=zstd",
      () => ({ kind: "relation", schema: V_SCHEMA, ipc: [zstd()] }) as SparkFakeAnswer,
      SPARK_ERROR_SENTENCES.compressed("zstd"),
    ],
    [
      "SET spark.connect.session.resultChunking.maxChunkSize=0",
      () => ({ kind: "oversized", bytes: 17 * MiB, path: "relation" }) as SparkFakeAnswer,
      SPARK_ERROR_SENTENCES.receiveCapRelation,
    ],
  ] as const)("a SET in one scope changes only that scope's later results (%s)", async (set, refused, sentence) => {
    // The fake answers by text and keeps no session state: the SET is answered as Spark's inline echo, and the test
    // switches the SELECT's answer between the scopes, so what is proven is the provider's side: the refusal, its one
    // Interrupt, and the next scope's fresh session setup.
    statements[set] = { kind: "command", ipc: stringBatch(1, 4) };
    statements["SELECT v FROM t"] = refused();
    const { sessions, runs } = world();
    await runs.run({ sql: set, session: () => sessions.forScope("A"), deadline: soon() });
    const sessionA = (await sessions.forScope("A")).sessionId;
    const error = await failure(
      runs.run({ sql: "SELECT v FROM t", session: () => sessions.forScope("A"), deadline: soon() }),
    );
    expect(error.message).toBe(sentence);
    const interruptsOnA = interrupts().filter((entry) => entry.sessionId === sessionA);
    expect(interruptsOnA).toHaveLength(1);
    // The SELECT's own tag, not the SET's.
    const select = plans().find(
      (entry) => entry.sessionId === sessionA && JSON.stringify(entry.request).includes("SELECT v FROM t"),
    );
    expect(tagOf(interruptsOnA[0] as { request: object })).toBe(select?.tags[0]);
    await sessions.endScope("A");
    statements["SELECT v FROM t"] = { kind: "relation", schema: V_SCHEMA, ipc: [stringBatch(2, 3)] };
    const whole = await runs.run({ sql: "SELECT v FROM t", session: () => sessions.forScope("B"), deadline: soon() });
    expect(whole.rows).toHaveLength(2);
    expect(whole.cut).toBeNull();
    const sessionB = (await sessions.forScope("B")).sessionId;
    expect(sessionB).not.toBe(sessionA);
    const setup = fake.log.entries.find((entry) => entry.rpc === "Config" && entry.sessionId === sessionB);
    const pairs = (setup?.request as { operation: { set: { pairs: { key: string; value: string }[] } } } | undefined)
      ?.operation.set.pairs;
    expect(pairs?.map((pair) => [pair.key, pair.value])).toStrictEqual(
      SPARK_SESSION_CONF.map(([key, value]) => [key, value]),
    );
    await sessions.releaseAll();
  });

  test("concurrent scopes share no session, tag or Interrupt, each holds its own heartbeat, and ending one scope leaves the other run reading", async () => {
    const { sessions, runs, beatAnswers } = world();
    const a = settle(
      runs.run({ sql: "SLOW", queryId: "qa", session: () => sessions.forScope("A2"), deadline: soon() }),
    );
    const b = settle(
      runs.run({ sql: "SLOW", queryId: "qb", session: () => sessions.forScope("B2"), deadline: soon() }),
    );
    await waitFor(() => plans().length === 4);
    expect(new Set(plans().map((entry) => entry.sessionId)).size).toBe(2);
    expect(new Set(plans().map((entry) => entry.tags[0])).size).toBe(2);
    const sessionA = (await sessions.forScope("A2")).sessionId;
    const sessionB = (await sessions.forScope("B2")).sessionId;
    const beatsOn = (session: string) =>
      fake.log.entries.filter((entry) => isBeat(entry) && entry.sessionId === session).length;
    // Both sessions beat while both runs are open.
    await waitFor(() => beatsOn(sessionA) > 0 && beatsOn(sessionB) > 0);
    expect(await runs.cancel("qa")).toBe(true);
    expect((await a).error?.category).toBe("cancelled");
    expect(interrupts()).toHaveLength(1);
    expect(interrupts()[0]?.sessionId).toBe(sessionA);
    const tagA = plans().find((entry) => entry.sessionId === sessionA)?.tags[0];
    expect(tagOf(interrupts()[0] as { request: object })).toBe(tagA);
    // A's hold ended with its run, B's did not: once every beat sent so far answered, only B's session beats on.
    await Promise.allSettled(beatAnswers);
    const beatsA = beatsOn(sessionA);
    const beatsB = beatsOn(sessionB);
    await waitFor(() => beatsOn(sessionB) >= beatsB + 2);
    expect(beatsOn(sessionA)).toBe(beatsA);
    await sessions.endScope("A2");
    expect(runs.runsInFlight()).toBe(1);
    expect(await runs.cancel("qb")).toBe(true);
    expect((await b).error?.category).toBe("cancelled");
    expect(new Set(interrupts().map((entry) => tagOf(entry))).size).toBe(2);
    await sessions.releaseAll();
  });
});
