/**
 * The wire cases and the pure decoder bounds, run once under Bun by grpc-runtimes.test.ts and once in a Node child it
 * bundles, because every bound must hold under both and the TLS failure texts differ by runtime while the sentences
 * Studio shows must not. No bun:test import and no Bun global.
 */
import { readFileSync } from "node:fs";
import { SPARK_HEARTBEAT_INTERVAL_MS } from "@/lib/db/providers/sql/spark/constants";
import { grpcWireTransport, type SparkWireTransport } from "@/lib/db/providers/sql/spark/grpc-client";
import { SparkProvider } from "@/lib/db/providers/sql/spark/index";
import { checkIpcStream } from "@/lib/db/providers/sql/spark/ipc-guard";
import { columnsFromDataType } from "@/lib/db/providers/sql/spark/schema";
import { readStatusDetails } from "@/lib/db/providers/sql/spark/status-details";
import { variantJson } from "@/lib/db/providers/sql/spark/variant";
import { wkbToWkt } from "@/lib/db/providers/sql/spark/wkb";
import type { DatabaseConnection } from "@/lib/types";
import { type SparkFakeOptions, type SparkFakeServer, startSparkFake } from "./spark-connect-server";
import { columnsStream, largeUtf8Stream, malformedStream, nestedSchemaStream } from "./spark-ipc";

export interface SparkRuntimeOutcome {
  readonly name: string;
  readonly outcome: string;
}

/** The SSL / TLS panel for verify-full, in the field names readGrpcTlsPanel reads, with a pasted CA when one is given. */
const TLS_VERIFY_FULL = (ca: string | undefined) => ({
  mode: "verify-full",
  ...(ca === undefined ? {} : { caCert: ca }),
});

const CURRENT = columnsStream([
  { name: "catalog", kind: "utf8", values: ["spark_catalog"] },
  { name: "namespace", kind: "utf8", values: ["default"] },
]);

const failed = (error: unknown) => `${(error as Error).constructor.name}: ${(error as Error).message}`;

/**
 * `google.rpc.Status` bytes written by hand, so the cases need no protobufjs: Status.details is field 3, Any.type_url
 * 1 and Any.value 2, ErrorInfo.reason 1 and ErrorInfo.metadata 3, a map entry's key 1 and value 2.
 */
const utf8 = (value: string) => new TextEncoder().encode(value);
function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const field = (number: number, bytes: Uint8Array) =>
  concat(Uint8Array.from([...varint((number << 3) | 2), ...varint(bytes.length)]), bytes);
const entry = (key: string, value: string) => field(3, concat(field(1, utf8(key)), field(2, utf8(value))));
/** One Status detail: an Any holding an ErrorInfo with this reason and these metadata entries. */
const detail = (reason: string, ...entries: Uint8Array[]) =>
  field(
    3,
    concat(
      field(1, utf8("type.googleapis.com/google.rpc.ErrorInfo")),
      field(2, concat(field(1, utf8(reason)), ...entries)),
    ),
  );
const CLASS_X = () => detail("R", entry("errorClass", "X"));
/** A Status of exactly `total` bytes (65,000 and more): one detail, then Status.message (field 2) as padding, whose length takes three varint bytes. */
const paddedTo = (total: number) => concat(CLASS_X(), field(2, utf8("m".repeat(total - CLASS_X().length - 4))));
/** The decoder's answer as a short text: its byte count first, each kept key in order, a value over 64 characters as its length. */
const details = (bytes: Uint8Array) => {
  const read = readStatusDetails(bytes);
  const shown =
    read === undefined
      ? "undefined"
      : Object.entries(read)
          .map(([key, value]) => `${key}=${value.length > 64 ? `${value.length} chars` : JSON.stringify(value)}`)
          .join(" ");
  return `${bytes.length} ${shown}`;
};

/** A CA that did not sign the fake's certificate, read from the working directory, which is the repository root. */
const OTHER_CA = () => readFileSync("tests/fixtures/tls/other-ca.crt", "utf8");

/**
 * Connects to a fresh fake, runs `body`, and answers its outcome text or the failure's class and sentence, led by the
 * fake's port and a space when `portFirst` is set (the TLS sentences name the port).
 */
async function withFake(
  options: Omit<SparkFakeOptions, "statements"> & { statements?: SparkFakeOptions["statements"] },
  config: Partial<DatabaseConnection>,
  body: (provider: SparkProvider, fake: SparkFakeServer) => Promise<string>,
  portFirst = false,
): Promise<string> {
  const fake = await startSparkFake({
    progressEveryMs: 0,
    ...options,
    statements: { "SHOW CURRENT NAMESPACE": { kind: "command", ipc: CURRENT }, ...options.statements },
  });
  const port = Number(fake.target.split(":").at(-1));
  const provider = new SparkProvider({
    id: `rt-${port}`,
    name: "rt",
    type: "spark",
    host: "127.0.0.1",
    port,
    ...config,
  } as DatabaseConnection);
  const lead = portFirst ? `${port} ` : "";
  try {
    await provider.connect();
    return lead + (await body(provider, fake));
  } catch (error) {
    return lead + failed(error);
  } finally {
    await provider.disconnect();
    fake.close();
  }
}

/** Waits for `ready`, polling every 5 ms, and fails naming `what` when it has not happened within two seconds. */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready(); waited += 5) {
    if (waited >= 2_000) throw new Error(`${what} did not happen within 2 s`);
    // oxlint-disable-next-line no-await-in-loop -- a poll: each wait follows the check before it.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Takes over the heartbeat's interval timer (the one set every SPARK_HEARTBEAT_INTERVAL_MS) so a case can fire its
 * ticks itself instead of waiting 15 s, and records whether it is cleared. Every other timer stays the runtime's own.
 */
function heartbeatTimer() {
  const { setInterval: realSet, clearInterval: realClear } = globalThis;
  const timer = { tick: undefined as (() => void) | undefined, cleared: false };
  const handle = {};
  globalThis.setInterval = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== SPARK_HEARTBEAT_INTERVAL_MS) return realSet(handler, ms, ...rest);
    timer.tick = handler;
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id?: unknown) => {
    if (id === handle) timer.cleared = true;
    else realClear(id as ReturnType<typeof realSet>);
  }) as typeof globalThis.clearInterval;
  const restore = () => {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  };
  return { timer, restore };
}

/** The Config get_option of spark.sql.ansi.enabled the fake received on `sessionId`, the beat the provider sends. */
const configBeats = (fake: SparkFakeServer, sessionId: string) =>
  fake.log.entries.filter(
    (entry) =>
      entry.rpc === "Config" &&
      entry.sessionId === sessionId &&
      JSON.stringify((entry.request as { operation?: { get_option?: object } }).operation?.get_option) ===
        JSON.stringify({ keys: ["spark.sql.ansi.enabled"] }),
  ).length;

/** An array VARIANT `levels` deep around a null, its offsets two bytes wide so no length wraps. */
function nestedVariant(levels: number): Uint8Array {
  let value = Uint8Array.of(0x00);
  for (let level = 0; level < levels; level += 1) {
    value = Uint8Array.from([0x07, 1, 0, 0, value.length & 0xff, value.length >> 8, ...value]);
  }
  return value;
}

/** A WKB point inside `levels` geometry collections. */
function nestedWkb(levels: number): Uint8Array {
  let nested = Uint8Array.from([1, 1, 0, 0, 0, ...new Uint8Array(Float64Array.of(1, 2).buffer)]);
  for (let level = 0; level < levels; level += 1) nested = Uint8Array.from([1, 7, 0, 0, 0, 1, 0, 0, 0, ...nested]);
  return nested;
}

/** A one-column struct whose column is `levels` arrays around an integer. */
function nestedDataType(levels: number): object {
  let type: object = { kind: "integer", integer: {} };
  for (let level = 0; level < levels; level += 1) type = { kind: "array", array: { element_type: type } };
  return { kind: "struct", struct: { fields: [{ name: "c", data_type: type, nullable: true }] } };
}

/** What `read` answers as text, or the failure's class and sentence. */
const outcomeOf = (read: () => unknown) => {
  try {
    return String(read());
  } catch (error) {
    return failed(error);
  }
};

const statementFails = (answer: SparkFakeOptions["statements"][string]) =>
  withFake({ statements: { "SELECT x": answer } }, {}, async (provider) => {
    await provider.query("SELECT x");
    return "answered";
  });

/**
 * A connect cut by a disconnect or by a second connect once its version answer arrived and before it sends its probe's
 * release: the real adapter over a fresh fake, with the cut started as the first version answer reaches the provider.
 * Answers how the cut connect and the cut itself ended, then the RPCs the fake received on each session, the sessions
 * in the order each was first used, once a last disconnect ended.
 */
async function cutAtVersionAnswer(cut: "disconnect" | "connect"): Promise<string> {
  const fake = await startSparkFake({
    progressEveryMs: 0,
    statements: { "SHOW CURRENT NAMESPACE": { kind: "command", ipc: CURRENT } },
  });
  const port = Number(fake.target.split(":").at(-1));
  let cutting: Promise<string> | undefined;
  const transport: SparkWireTransport = (options) => {
    const channel = grpcWireTransport(options);
    return {
      ...channel,
      unary: async (rpc, request, call) => {
        const answer = await channel.unary(rpc, request, call);
        if (rpc === "AnalyzePlan" && cutting === undefined) {
          cutting = provider[cut]().then(() => "answered", failed);
        }
        return answer;
      },
    };
  };
  const provider = new SparkProvider(
    { id: `rt-cut-${port}`, name: "rt", type: "spark", host: "127.0.0.1", port } as DatabaseConnection,
    {},
    { transport },
  );
  try {
    const cutConnect = await provider.connect().then(() => "connected", failed);
    const ended = await cutting;
    await provider.disconnect();
    const { entries } = fake.log;
    const sessions = [...new Set(entries.map((entry) => entry.sessionId))].map((id) =>
      entries
        .filter((entry) => entry.sessionId === id)
        .map((entry) => entry.rpc)
        .join(" "),
    );
    return `${cutConnect} | ${cut} ${ended} | ${sessions.join(", ")}`;
  } finally {
    await provider.disconnect();
    fake.close();
  }
}

export async function runSparkRuntimeCases(): Promise<readonly SparkRuntimeOutcome[]> {
  const cases: [string, () => Promise<string>][] = [
    [
      "interrupt",
      () =>
        withFake({ statements: { "SELECT x": { kind: "silent" } } }, {}, async (provider) => {
          const run = provider.query("SELECT x", undefined, "q-6").then(() => "answered", failed);
          await new Promise((resolve) => setTimeout(resolve, 50));
          const cancelled = await provider.cancelQuery("q-6");
          return `${cancelled} ${await run}`;
        }),
    ],
    [
      // The server's message names no class, so only the decoded ErrorInfo can add the TIME sentence.
      "error info",
      () =>
        statementFails({
          kind: "error",
          code: 13,
          message: "The data type TIME is not supported.",
          errorInfo: { errorClass: "UNSUPPORTED_TIME_TYPE", sqlState: "0A000" },
        }),
    ],
    ["oversized command", () => statementFails({ kind: "oversized", bytes: 17_000_000, path: "command" })],
    ["large var types", () => statementFails({ kind: "command", ipc: largeUtf8Stream() })],
    ["over-deep schema", () => statementFails({ kind: "command", ipc: nestedSchemaStream(65) })],
    [
      "heartbeat",
      () =>
        withFake({ statements: { "SELECT x": { kind: "silent" } } }, {}, async (provider, fake) => {
          const { timer, restore } = heartbeatTimer();
          try {
            fake.log.clear();
            const run = provider.query("SELECT x", undefined, "q-heartbeat").then(() => "answered", failed);
            const execute = () =>
              fake.log.entries.find(
                (entry) => entry.rpc === "ExecutePlan" && JSON.stringify(entry.request).includes("SELECT x"),
              );
            await until("the run's timer and ExecutePlan", () => timer.tick !== undefined && execute() !== undefined);
            const sessionId = (execute() as { sessionId: string }).sessionId;
            const before = configBeats(fake, sessionId);
            for (let tick = 0; tick < 3; tick += 1) (timer.tick as () => void)();
            await until("three beats on the run's session", () => configBeats(fake, sessionId) - before === 3);
            const clearedWhileRunning = timer.cleared;
            await provider.cancelQuery("q-heartbeat");
            await run;
            return `beats ${configBeats(fake, sessionId) - before}, cleared while running ${clearedWhileRunning}, cleared at the end ${timer.cleared}`;
          } finally {
            restore();
          }
        }),
    ],
    [
      "keepalive cut",
      () => statementFails({ kind: "status", code: 8, message: "Bandwidth exhausted or memory limit exceeded" }),
    ],
    ["no token", () => withFake({ token: "t0ken" }, {}, async () => "connected")],
    ["wrong token", () => withFake({ token: "t0ken" }, { password: "wrong" }, async () => "connected")],
    ["old version", () => withFake({ sparkVersion: "3.5.9" }, {}, async () => "connected")],
    ["vendor suffix", () => withFake({ sparkVersion: "4.1.3-vendor.1" }, {}, async () => "connected")],
    [
      "tls to plaintext",
      () =>
        withFake({}, { ssl: TLS_VERIFY_FULL(undefined) } as Partial<DatabaseConnection>, async () => "connected", true),
    ],
    ["plaintext to tls", () => withFake({ tls: true }, {}, async () => "connected", true)],
    [
      "untrusted ca",
      () =>
        withFake(
          { tls: true },
          { ssl: TLS_VERIFY_FULL(OTHER_CA()) } as Partial<DatabaseConnection>,
          async () => "connected",
        ),
    ],
    ["reset", () => statementFails({ kind: "reset" })],
    ["probe release past a disconnect", () => cutAtVersionAnswer("disconnect")],
    ["probe release past a second connect", () => cutAtVersionAnswer("connect")],
    [
      "ipc bounds",
      async () =>
        [
          ...(
            ["no-continuation", "metadata-too-large", "body-past-end", "no-end-marker", "dictionary-batch"] as const
          ).map((kind) => malformedStream(kind)),
          nestedSchemaStream(64),
          nestedSchemaStream(65),
        ]
          .map((stream) => outcomeOf(() => JSON.stringify(checkIpcStream(stream))))
          .join(" | "),
    ],
    ["status details", async () => String(readStatusDetails(Uint8Array.of(0x0a, 0xff)))],
    ["status details size", async () => `${details(paddedTo(65_536))} | ${details(paddedTo(65_537))}`],
    [
      "status details count",
      async () =>
        `${details(concat(...Array.from({ length: 16 }, CLASS_X)))} | ${details(concat(...Array.from({ length: 17 }, CLASS_X)))}`,
    ],
    [
      "status details value",
      async () =>
        [8_192, 8_193]
          .map((length) =>
            details(detail("R", entry("errorClass", "X"), entry("messageParameters", "p".repeat(length)))),
          )
          .join(" | "),
    ],
    ["status details bom", async () => details(detail("\ufeffR", entry("errorClass", "X")))],
    [
      "variant depth",
      async () =>
        [64, 65]
          .map((levels) =>
            outcomeOf(() => variantJson(nestedVariant(levels), Uint8Array.of(0x01, 0x00, 0x00), 1_000_000)),
          )
          .join(" | "),
    ],
    ["wkb depth", async () => [63, 64].map((levels) => String(wkbToWkt(nestedWkb(levels)))).join(" | ")],
    [
      "schema depth",
      async () =>
        [63, 64]
          .map((levels) =>
            outcomeOf(() => columnsFromDataType(nestedDataType(levels)).map((column) => column.spelling)),
          )
          .join(" | "),
    ],
  ];
  const outcomes: SparkRuntimeOutcome[] = [];
  for (const [name, run] of cases) {
    // oxlint-disable-next-line no-await-in-loop -- one case at a time, so no case's timers or fake share the loop with another's.
    outcomes.push({ name, outcome: await run() });
  }
  return outcomes;
}
