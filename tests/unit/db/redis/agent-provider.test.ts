/**
 * The Redis provider under the agent read-only profile, over a driver double that answers what Redis 8.10.2 answered
 * each principal (tests/fixtures/redis/8.10.2/agent-boundary/): the profile is refused on an editor handle, a
 * connection with no ACL user of its own is refused before any socket, every command is read against the closed table
 * before anything is sent, and each one runs on a connection of its own, proved read-only right before it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { REDIS_AGENT_SENTENCES } from "@/lib/db/providers/keyvalue/redis-agent-statement";
import { REDIS_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/keyvalue/redis-metadata-read";
import { REDIS_PROOF_SENTENCES } from "@/lib/db/providers/keyvalue/redis-read-only-proof";
import {
  asReply,
  type CapturedStep,
  principalCapture,
  probeLabel,
  readRedisCapture,
  stepFor,
} from "../../../helpers/redis-agent";

const VERSION = "8.10.2";

/** Which captured principal the double answers as, and the probe answers that override the capture's. */
let principal = "reader-info";
let probeOverride: readonly CapturedStep[] | undefined;
/** A reply that stands in for the next table read's, or an error to throw from it. */
let readOverride: { reply?: unknown; error?: Error } | undefined;

interface Opened {
  readonly options: Record<string, unknown>;
  readonly calls: string[][];
  readonly pipelines: string[][][];
  selected?: number;
  disconnected: boolean;
}
const opened: Opened[] = [];

function replyError(message: string): Error {
  const error = new Error(message);
  error.name = "ReplyError";
  return error;
}

function probeAnswer(argv: readonly string[]): [Error | null, unknown] {
  if (argv[0] === "HELLO") {
    const hello = asReply(stepFor(principalCapture(VERSION, "reader-info").outside, ["HELLO", "2"]) as CapturedStep);
    return hello.ok ? [null, hello.reply] : [replyError(hello.error), undefined];
  }
  const probes = probeOverride ?? principalCapture(VERSION, principal).probes;
  const step = probes.find((probe) => probeLabel(probe.argv) === probeLabel(argv));
  if (step === undefined) throw new Error(`no captured probe for ${argv.join(" ")}`);
  return step.outcome === "ok" ? [null, step.reply] : [replyError(step.error ?? ""), undefined];
}

mock.module("ioredis", () => {
  class MockRedis {
    private readonly state: Opened;
    constructor(options: Record<string, unknown>) {
      this.state = { options, calls: [], pipelines: [], disconnected: false };
      opened.push(this.state);
    }
    on() {
      return this;
    }
    async connect() {}
    async select(db: number) {
      this.state.selected = db;
      return "OK";
    }
    async call(command: string, ...args: string[]) {
      const argv = [command, ...args];
      this.state.calls.push(argv);
      if (readOverride !== undefined) {
        if (readOverride.error !== undefined) throw readOverride.error;
        return readOverride.reply;
      }
      const step = stepFor(principalCapture(VERSION, principal).table, argv);
      if (step === undefined) throw new Error(`no captured read for ${argv.join(" ")}`);
      if (step.outcome === "error") throw replyError(step.error ?? "");
      return step.reply;
    }
    pipeline() {
      const queued: string[][] = [];
      this.state.pipelines.push(queued);
      const pipeline = {
        call(command: string, ...args: string[]) {
          queued.push([command, ...args]);
          return pipeline;
        },
        async exec() {
          return queued.map(probeAnswer);
        },
      };
      return pipeline;
    }
    disconnect() {
      this.state.disconnected = true;
    }
    async quit() {
      this.state.disconnected = true;
    }
  }
  return { default: MockRedis };
});

const { RedisProvider } = await import("@/lib/db/providers/keyvalue/redis");

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 65_536, statementTimeoutMs: 4_000 };
const PROFILE = { readOnly: true, sendsStatements: true } as const;

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "redis-agent",
    name: "Redis",
    type: "redis",
    host: "127.0.0.1",
    port: 6379,
    user: "agent_reader_info",
    password: "not-a-real-password",
    createdAt: new Date(0),
    ...overrides,
  } as DatabaseConnection;
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

beforeEach(() => {
  principal = "reader-info";
  probeOverride = undefined;
  readOverride = undefined;
  opened.length = 0;
});

afterEach(() => {
  opened.length = 0;
});

describe("the profile", () => {
  test("queryReadOnly refuses an editor handle and an operations handle before anything is sent", async () => {
    for (const execution of [{}, { readOnly: true, sendsStatements: false }]) {
      const provider = new RedisProvider(connection(), {}, execution);
      await provider.connect();
      const before = opened.length;
      const error = await failureOf(provider.queryReadOnly("TYPE agent:hash", BUDGET));
      expect(error).toBeInstanceOf(RefusedBeforeSendError);
      expect((error as Error).message).toBe(
        "Read-only execution requires a provider opened under the agent read-only profile",
      );
      expect(opened.length).toBe(before);
      // Unproved: the editor's open sends no probe.
      expect(opened[0].pipelines).toEqual([]);
    }
  });

  test("a connection that names no ACL user, or default, is refused before any socket", async () => {
    for (const [user, sentence] of [
      [undefined, REDIS_PROOF_SENTENCES.noUser],
      ["", REDIS_PROOF_SENTENCES.noUser],
      ["default", REDIS_PROOF_SENTENCES.defaultUser],
    ] as const) {
      const provider = new RedisProvider(connection({ user }), {}, PROFILE);
      const error = await failureOf(provider.connect());
      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as Error).message).toBe(sentence);
      expect(opened).toEqual([]);
      expect(provider.isConnected()).toBe(false);
    }
  });

  test("the open proves the user in one round trip on the connection it keeps", async () => {
    const provider = new RedisProvider(connection(), {}, PROFILE);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0].options.username).toBe("agent_reader_info");
    expect(opened[0].pipelines).toHaveLength(1);
    expect(opened[0].pipelines[0][0]).toEqual(["HELLO", "2"]);
    expect(opened[0].pipelines[0].slice(1).map(probeLabel)).toEqual(
      principalCapture(VERSION, "reader").probes.map((step) => probeLabel(step.argv)),
    );
    expect(opened[0].calls).toEqual([]);
  });

  test.each([
    ["default-nopass", "DEL"],
    ["full", "DEL"],
    ["read-set", "SET"],
  ])("a %s user is refused at the open, and its connection closed", async (who, label) => {
    principal = who;
    const provider = new RedisProvider(connection({ user: `agent_${who}` }), {}, PROFILE);
    const error = await failureOf(provider.connect());
    expect((error as Error).message).toBe(REDIS_PROOF_SENTENCES.admitted(label));
    expect(opened[0].disconnected).toBe(true);
    expect(provider.isConnected()).toBe(false);
  });
});

describe("one agent command", () => {
  async function opened_(overrides: Partial<DatabaseConnection> = {}) {
    const provider = new RedisProvider(connection(overrides), {}, PROFILE);
    await provider.connect();
    opened.length = 0;
    return provider;
  }

  test("runs on a connection of its own in the session database, proved right before it, then closed", async () => {
    const provider = await opened_({ database: "3" });
    const result = await provider.queryReadOnly("TYPE agent:hash", BUDGET);
    expect(result.fields).toEqual(["type"]);
    expect(result.rows).toEqual([{ type: "hash" }]);
    expect(result.rowCount).toBe(1);
    expect(opened).toHaveLength(1);
    expect(opened[0].options.commandTimeout).toBe(4_000);
    expect(opened[0].selected).toBe(3);
    expect(opened[0].pipelines).toHaveLength(1);
    expect(opened[0].pipelines[0][0]).toEqual(["HELLO", "2"]);
    expect(opened[0].calls).toEqual([["TYPE", "agent:hash"]]);
    expect(opened[0].disconnected).toBe(true);

    await provider.queryReadOnly("memory usage agent:hash samples 5", BUDGET);
    expect(opened).toHaveLength(2);
    expect(opened[1].calls).toEqual([["MEMORY", "USAGE", "agent:hash", "SAMPLES", "5"]]);
    expect(opened[1].pipelines).toHaveLength(1);
  });

  test("every command outside the table is refused before any connection opens", async () => {
    const provider = await opened_();
    for (const text of ["GET agent:string", "KEYS *", "SCAN 0", "INFO keyspace", "DEL agent:hash", "TYPE a\nDEL a"]) {
      const error = await failureOf(provider.queryReadOnly(text, BUDGET));
      expect(error, text).toBeInstanceOf(RefusedBeforeSendError);
    }
    expect(((await failureOf(provider.queryReadOnly("GET agent:string", BUDGET))) as Error).message).toBe(
      REDIS_AGENT_SENTENCES.metadataOnly,
    );
    expect(opened).toEqual([]);
  });

  test("an estimate is refused, and so is a budget the shared check refuses", async () => {
    const provider = await opened_();
    expect(await failureOf(provider.queryReadOnly("DBSIZE", BUDGET, "estimate-plan"))).toBeInstanceOf(
      RefusedBeforeSendError,
    );
    expect(await failureOf(provider.queryReadOnly("DBSIZE", { ...BUDGET, maxResultRows: -1 }))).toBeInstanceOf(Error);
    expect(opened).toEqual([]);
  });

  test("a write granted mid-run is refused at the next command, which is never sent", async () => {
    principal = "midrun";
    probeOverride = readRedisCapture<{ probesBeforeGrant: CapturedStep[] }>(VERSION, "midrun").probesBeforeGrant;
    const provider = new RedisProvider(connection({ user: "agent_midrun" }), {}, PROFILE);
    await provider.connect();
    principal = "reader-info";
    expect((await provider.queryReadOnly("DBSIZE", BUDGET)).rows).toEqual([{ keys: 8 }]);
    probeOverride = readRedisCapture<{ probesAfterGrant: CapturedStep[] }>(VERSION, "midrun").probesAfterGrant;
    opened.length = 0;
    const error = await failureOf(provider.queryReadOnly("DBSIZE", BUDGET));
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as Error).message).toBe(REDIS_PROOF_SENTENCES.admitted("DEL"));
    expect(opened[0].calls).toEqual([]);
    expect(opened[0].disconnected).toBe(true);
  });

  test("a server refusal is worded without the server's words, so the key it repeats never reaches the agent", async () => {
    const provider = await opened_();
    const wrongType = await failureOf(provider.queryReadOnly("STRLEN agent:hash", BUDGET));
    expect(wrongType).toBeInstanceOf(QueryError);
    expect((wrongType as Error).message).toBe(REDIS_AGENT_FAILURE_SENTENCES.wrongType);
    readOverride = { error: replyError("ERR unknown command 'X', with args beginning with: 'agent:secret-key'") };
    const echo = await failureOf(provider.queryReadOnly("TYPE agent:secret-key", BUDGET));
    expect((echo as Error).message).toBe(REDIS_AGENT_FAILURE_SENTENCES.refused("ERR"));
    expect((echo as Error).message).not.toContain("agent:secret-key");
  });

  test("a reply that fits no column is withheld, and a failure that is not the server's passes as it is", async () => {
    const provider = await opened_();
    readOverride = { reply: ["agent-field", "not-a-real-field-value"] };
    const withheld = await failureOf(provider.queryReadOnly("TYPE agent:hash", BUDGET));
    expect(withheld).toBeInstanceOf(QueryError);
    expect((withheld as Error).message).not.toContain("not-a-real-field-value");
    const dropped = new Error("Connection is closed.");
    readOverride = { error: dropped };
    expect(await failureOf(provider.queryReadOnly("TYPE agent:hash", BUDGET))).toBe(dropped);
    readOverride = { error: new Error("Command timed out") };
    expect(((await failureOf(provider.queryReadOnly("DBSIZE", BUDGET))) as Error).message).toBe(
      "Read-only execution exceeded the time budget: no answer within 4000ms",
    );
  });
});

describe("the object surface under the profile", () => {
  async function profiled() {
    const provider = new RedisProvider(connection({ database: "2" }), {}, PROFILE);
    await provider.connect();
    opened.length = 0;
    return provider;
  }

  test("the grounding walk reads the session database alone, counts nothing and lists no key or library name", async () => {
    const provider = await profiled();
    expect(await provider.listContainers()).toEqual([{ path: ["2"], name: "2", level: 0, isSessionDefault: true }]);
    expect(await provider.listContainers(["2"])).toEqual([]);
    const counts = await provider.countObjects(["2"]);
    expect(Object.keys(counts).sort()).toEqual(["function", "keyspace"]);
    for (const count of Object.values(counts)) {
      expect(count).toEqual({
        unavailable:
          "Agent mode on Redis reads metadata only, and key names count as stored values, so no key, key grouping or library name is listed to it.",
      });
    }
    expect(await provider.listObjects(["2"], "keyspace")).toEqual([]);
    expect(await provider.listObjects(["2"], "function")).toEqual([]);
    expect(await provider.describeObjects(["2"], "keyspace")).toEqual({ details: [] });
    expect(opened).toEqual([]);
  });

  test("the editor's surfaces refuse: the key walk, a grouping's detail and a raw command", async () => {
    const provider = await profiled();
    const surface =
      "A Redis handle opened under the agent read-only profile answers only the agent's metadata reads, through queryReadOnly.";
    expect(((await failureOf(provider.scanKeysPage({ cursor: "0", count: 10 }))) as Error).message).toBe(surface);
    expect(((await failureOf(provider.describeObject(["2", "user:*"], "keyspace"))) as Error).message).toBe(surface);
    const raw = await failureOf(provider.query("DEL agent:hash"));
    expect(raw).toBeInstanceOf(RefusedBeforeSendError);
    expect((raw as Error).message).toBe(surface);
    expect(opened).toEqual([]);
  });
});
