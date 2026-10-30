/**
 * What an agent's Redis read answers (`redis-metadata-read.ts`): the one projected row of each table read, from the
 * replies Redis 8.10.2 and Valkey 9.1.2 gave a `+@read +info` user, and the wording of every failure without the
 * server's words.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { readRedisAgentStatement } from "@/lib/db/providers/keyvalue/redis-agent-statement";
import {
  REDIS_AGENT_FAILURE_SENTENCES,
  REDIS_METADATA_ONLY,
  redisAgentFailure,
  redisAgentResult,
} from "@/lib/db/providers/keyvalue/redis-metadata-read";
import { MetadataProjectionError } from "@/lib/db/redaction/metadata-only";
import { BYTE_BUDGET_PREFIX, ROW_BUDGET_PREFIX, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { principalCapture, REDIS_CAPTURE_VERSIONS, stepFor } from "../../../helpers/redis-agent";

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 65_536, statementTimeoutMs: 5_000 };

/** The seeded keys' names and stored values, none of which may reach an answer. */
const STORED = [
  "agent:string",
  "agent:hash",
  "agent:list",
  "agent:set",
  "agent:zset",
  "agent:stream",
  "agent:ttl",
  "agent:missing",
  "agent-field",
  "agent-member-a",
  "agent-stream-field",
  "not-a-real-stored-value",
  "not-a-real-field-value",
  "not-a-real-stream-value",
];

function answer(version: (typeof REDIS_CAPTURE_VERSIONS)[number], text: string) {
  const reading = readRedisAgentStatement(text);
  if (!reading.ok) throw new Error(reading.message);
  const step = stepFor(principalCapture(version, "reader-info").table, reading.plan.argv);
  if (step === undefined || step.outcome !== "ok") throw new Error(`no captured reply for ${text}`);
  return redisAgentResult(reading.plan.op, step.reply, BUDGET, text, 3);
}

describe.each(REDIS_CAPTURE_VERSIONS)("each read's answer from %s's reply", (version) => {
  test("the key count, a type, an existence and an encoding", () => {
    expect(answer(version, "DBSIZE")).toEqual({ fields: ["keys"], rows: [{ keys: 8 }], rowCount: 1, executionTime: 3 });
    expect(answer(version, "TYPE agent:hash").rows).toEqual([{ type: "hash" }]);
    expect(answer(version, "TYPE agent:missing").rows).toEqual([{ type: "none" }]);
    expect(answer(version, "EXISTS agent:hash").rows).toEqual([{ exists: true }]);
    expect(answer(version, "EXISTS agent:missing").rows).toEqual([{ exists: false }]);
    expect(answer(version, "OBJECT ENCODING agent:hash").rows).toEqual([{ encoding: "listpack" }]);
    expect(answer(version, "OBJECT ENCODING agent:missing").rows).toEqual([{ encoding: null }]);
  });

  test("a time to live says whether the key exists and expires, and its time only when it does", () => {
    expect(answer(version, "TTL agent:ttl")).toMatchObject({
      fields: ["exists", "expires", "ttl_seconds"],
      rows: [{ exists: true, expires: true }],
    });
    expect(answer(version, "TTL agent:ttl").rows[0].ttl_seconds).toBeGreaterThan(3500);
    expect(answer(version, "TTL agent:hash").rows).toEqual([{ exists: true, expires: false, ttl_seconds: null }]);
    expect(answer(version, "TTL agent:missing").rows).toEqual([{ exists: false, expires: false, ttl_seconds: null }]);
    expect(answer(version, "PTTL agent:ttl").fields).toEqual(["exists", "expires", "ttl_milliseconds"]);
    expect(answer(version, "PTTL agent:ttl").rows[0].ttl_milliseconds).toBeGreaterThan(3_500_000);
  });

  test("every length read answers one count, and a memory read a size or null", () => {
    for (const [text, length] of [
      ["STRLEN agent:string", 23],
      ["LLEN agent:list", 2],
      ["HLEN agent:hash", 1],
      ["SCARD agent:set", 1],
      ["ZCARD agent:zset", 1],
      ["XLEN agent:stream", 1],
    ] as const) {
      expect(answer(version, text), text).toMatchObject({ fields: ["length"], rows: [{ length }] });
    }
    expect(answer(version, "MEMORY USAGE agent:hash").rows[0].bytes).toBeGreaterThan(0);
    expect(answer(version, "MEMORY USAGE agent:hash SAMPLES 5").fields).toEqual(["bytes"]);
    expect(answer(version, "MEMORY USAGE agent:missing").rows).toEqual([{ bytes: null }]);
  });

  test("no answer holds a key name, a field, a member or a stored value", () => {
    for (const step of principalCapture(version, "reader-info").table) {
      if (step.outcome !== "ok") continue;
      const text = step.argv.join(" ");
      const serialised = JSON.stringify(answer(version, text));
      for (const stored of STORED) expect(serialised, text).not.toContain(stored);
    }
  });
});

describe("the projection refuses a reply that does not fit", () => {
  test("a reply that is not the read's own shape withholds the whole answer, naming the column only", () => {
    for (const [op, reply] of [
      ["DBSIZE", "not-a-real-stored-value"],
      ["DBSIZE", "-1"],
      ["DBSIZE", 1.5],
      ["EXISTS", "2"],
      ["TTL", "soon"],
      ["TTL", "-3"],
      ["TYPE", ["agent-field", "not-a-real-field-value"]],
      ["TYPE", "line\nbreak"],
      ["STRLEN", "1234567890123456"],
      ["OBJECT ENCODING", 7],
    ] as const) {
      expect(() => redisAgentResult(op, reply, BUDGET, op, 1), `${op} ${JSON.stringify(reply)}`).toThrow(
        MetadataProjectionError,
      );
    }
    expect(redisAgentResult("DBSIZE", 9, BUDGET, "DBSIZE", 1).rows).toEqual([{ keys: 9 }]);
    expect(() => redisAgentResult("DBSIZE", 2 ** 60, BUDGET, "DBSIZE", 1)).toThrow(MetadataProjectionError);
  });

  test("an answer past the row or byte budget is refused, never cut", () => {
    expect(() => redisAgentResult("DBSIZE", "1", { ...BUDGET, maxResultRows: 0 }, "DBSIZE", 1)).toThrow(
      ROW_BUDGET_PREFIX,
    );
    expect(() => redisAgentResult("DBSIZE", "1", { ...BUDGET, maxResultBytes: 2 }, "DBSIZE", 1)).toThrow(
      BYTE_BUDGET_PREFIX,
    );
  });

  test("the capability states every operation's columns and kinds, and nothing that reads", () => {
    expect(Object.keys(REDIS_METADATA_ONLY).sort()).toEqual(
      [
        "DBSIZE",
        "EXISTS",
        "HLEN",
        "LLEN",
        "MEMORY USAGE",
        "OBJECT ENCODING",
        "PTTL",
        "SCARD",
        "STRLEN",
        "TTL",
        "TYPE",
        "XLEN",
        "ZCARD",
      ].sort(),
    );
    expect(REDIS_METADATA_ONLY.TTL).toEqual([
      { column: "exists", kind: "flag" },
      { column: "expires", kind: "flag" },
      { column: "ttl_seconds", kind: "count" },
    ]);
    expect(REDIS_METADATA_ONLY.TYPE).toEqual([{ column: "type", kind: "name" }]);
  });
});

describe("the wording of a failure", () => {
  function replyError(message: string): Error {
    const error = new Error(message);
    error.name = "ReplyError";
    return error;
  }

  test("a server's error line is worded by its code alone, so a key or value it repeats never reaches the agent", () => {
    const echoes = replyError("ERR unknown command 'NOSUCHCOMMAND', with args beginning with: 'agent:string'");
    const worded = redisAgentFailure(echoes, BUDGET, "TYPE agent:string");
    expect(worded).toBeInstanceOf(QueryError);
    expect(worded?.message).toBe(REDIS_AGENT_FAILURE_SENTENCES.refused("ERR"));
    expect(worded?.message).not.toContain("agent:string");
    expect(
      redisAgentFailure(replyError("WRONGTYPE Operation against a key holding the wrong kind of value"), BUDGET, "x")
        ?.message,
    ).toBe(REDIS_AGENT_FAILURE_SENTENCES.wrongType);
    expect(redisAgentFailure(replyError("NOPERM No permissions to access a key"), BUDGET, "x")?.message).toBe(
      REDIS_AGENT_FAILURE_SENTENCES.noPerm,
    );
    expect(redisAgentFailure(replyError("LOADING Redis is loading the dataset in memory"), BUDGET, "x")?.message).toBe(
      "Redis refused the read with LOADING. The server's own words are not passed on to agent mode, since a Redis error can repeat a key or a value.",
    );
    for (const line of ["agent:string is gone", "SECRETVALUE leaked", "X", "ERRx no space", ""]) {
      expect(redisAgentFailure(replyError(line), BUDGET, "x")?.message, line).toBe(
        REDIS_AGENT_FAILURE_SENTENCES.refused(undefined),
      );
    }
    expect(REDIS_AGENT_FAILURE_SENTENCES.refused(undefined)).toStartWith("Redis refused the read. ");
  });

  test("the captured WRONGTYPE and key-permission refusals are worded without the server's words", () => {
    for (const version of REDIS_CAPTURE_VERSIONS) {
      const wrongType = stepFor(principalCapture(version, "reader-info").table, ["STRLEN", "agent:hash"]);
      const noPerm = stepFor(principalCapture(version, "prefix").table, ["TYPE", "agent:hash"]);
      expect(redisAgentFailure(replyError(wrongType?.error ?? ""), BUDGET, "x")?.message).toBe(
        REDIS_AGENT_FAILURE_SENTENCES.wrongType,
      );
      expect(redisAgentFailure(replyError(noPerm?.error ?? ""), BUDGET, "x")?.message).toBe(
        REDIS_AGENT_FAILURE_SENTENCES.noPerm,
      );
    }
  });

  test("a command timeout is the time budget's refusal, and a projection's refusal is its own sentence", () => {
    expect(redisAgentFailure(new Error("Command timed out"), BUDGET, "DBSIZE")?.message).toBe(
      `${TIME_BUDGET_PREFIX}: no answer within 5000ms`,
    );
    const projection = new MetadataProjectionError("keys", "count");
    expect(redisAgentFailure(projection, BUDGET, "DBSIZE")?.message).toBe(projection.message);
  });

  test("a failure that is not the server's error line is passed on as it is", () => {
    expect(redisAgentFailure(new Error("connect ECONNREFUSED 127.0.0.1:6379"), BUDGET, "x")).toBeUndefined();
    expect(redisAgentFailure("a string", BUDGET, "x")).toBeUndefined();
  });
});
