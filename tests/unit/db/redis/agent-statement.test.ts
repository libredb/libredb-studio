/**
 * The agent's reader of one Redis command (`redis-agent-statement.ts`): the exact argv each table read sends, and the
 * refusal of everything else before anything is sent, with sentences that quote nothing the request wrote.
 */
import { describe, expect, test } from "bun:test";
import {
  REDIS_AGENT_COMMANDS,
  REDIS_AGENT_MAX_KEY_CHARS,
  REDIS_AGENT_MAX_SAMPLES,
  REDIS_AGENT_SENTENCES,
  type RedisAgentOperation,
  readRedisAgentStatement,
} from "@/lib/db/providers/keyvalue/redis-agent-statement";

function argvOf(text: string): readonly string[] {
  const reading = readRedisAgentStatement(text);
  if (!reading.ok) throw new Error(`refused: ${reading.message}`);
  return reading.plan.argv;
}

function refusal(text: string): { code: string; message: string } {
  const reading = readRedisAgentStatement(text);
  if (reading.ok) throw new Error(`admitted: ${JSON.stringify(reading.plan)}`);
  return { code: reading.code, message: reading.message };
}

describe("the table's reads", () => {
  test("every read is the exact argv sent, command words uppercased and the key as written", () => {
    expect(argvOf("DBSIZE")).toEqual(["DBSIZE"]);
    expect(argvOf("dbsize")).toEqual(["DBSIZE"]);
    expect(argvOf("type user:1")).toEqual(["TYPE", "user:1"]);
    expect(argvOf("EXISTS user:1")).toEqual(["EXISTS", "user:1"]);
    expect(argvOf("TTL session:abc")).toEqual(["TTL", "session:abc"]);
    expect(argvOf("PTTL session:abc")).toEqual(["PTTL", "session:abc"]);
    expect(argvOf("STRLEN Greeting")).toEqual(["STRLEN", "Greeting"]);
    expect(argvOf("LLEN queue")).toEqual(["LLEN", "queue"]);
    expect(argvOf("HLEN user:1")).toEqual(["HLEN", "user:1"]);
    expect(argvOf("SCARD tags")).toEqual(["SCARD", "tags"]);
    expect(argvOf("ZCARD board")).toEqual(["ZCARD", "board"]);
    expect(argvOf("XLEN events")).toEqual(["XLEN", "events"]);
    expect(argvOf("object encoding user:1")).toEqual(["OBJECT", "ENCODING", "user:1"]);
    expect(argvOf("MEMORY USAGE user:1")).toEqual(["MEMORY", "USAGE", "user:1"]);
    expect(argvOf("memory usage user:1 samples 5")).toEqual(["MEMORY", "USAGE", "user:1", "SAMPLES", "5"]);
    expect(argvOf("MEMORY USAGE user:1 SAMPLES 1")).toEqual(["MEMORY", "USAGE", "user:1", "SAMPLES", "1"]);
  });

  test("the operation is the table's row, so the answer's projection is chosen by it", () => {
    const reading = readRedisAgentStatement("object ENCODING k");
    expect(reading).toEqual({ ok: true, plan: { op: "OBJECT ENCODING", argv: ["OBJECT", "ENCODING", "k"] } });
  });

  test("surrounding spaces and runs of spaces between words are not words", () => {
    expect(argvOf("  TYPE   user:1  ")).toEqual(["TYPE", "user:1"]);
    expect(argvOf("TYPE user:1\n")).toEqual(["TYPE", "user:1"]);
  });

  test("a double-quoted key carries spaces and the two escapes, and reaches the server as one argument", () => {
    expect(argvOf('TYPE "a key with spaces"')).toEqual(["TYPE", "a key with spaces"]);
    expect(argvOf('TYPE "say \\"hi\\""')).toEqual(["TYPE", 'say "hi"']);
    expect(argvOf('TYPE "back\\\\slash"')).toEqual(["TYPE", "back\\slash"]);
    expect(argvOf('"TYPE" k')).toEqual(["TYPE", "k"]);
  });

  test("a key may be as long as the bound and no longer", () => {
    const longest = "k".repeat(REDIS_AGENT_MAX_KEY_CHARS);
    expect(argvOf(`TYPE ${longest}`)).toEqual(["TYPE", longest]);
    expect(refusal(`TYPE ${longest}k`)).toEqual({
      code: "arguments",
      message: REDIS_AGENT_SENTENCES.arguments("TYPE"),
    });
  });

  test("every row of the table has a sentence for its arguments, which names its row and nothing the request wrote", () => {
    for (const op of Object.keys(REDIS_AGENT_COMMANDS) as RedisAgentOperation[]) {
      const sentence = REDIS_AGENT_SENTENCES.arguments(op);
      expect(sentence.startsWith(`${op} takes `)).toBe(true);
      expect(sentence).toEndWith("Nothing was sent.");
    }
    expect(REDIS_AGENT_SENTENCES.arguments("DBSIZE")).toBe("DBSIZE takes no argument. Nothing was sent.");
    expect(REDIS_AGENT_SENTENCES.arguments("MEMORY USAGE")).toContain(
      `optionally followed by SAMPLES and a count from 1 to ${REDIS_AGENT_MAX_SAMPLES}`,
    );
    expect(REDIS_AGENT_SENTENCES.arguments("TYPE")).not.toContain("SAMPLES");
  });
});

describe("what is refused before anything is sent", () => {
  test("nothing, or spaces alone, is no command", () => {
    expect(refusal("")).toEqual({ code: "request", message: REDIS_AGENT_SENTENCES.empty });
    expect(refusal("   ")).toEqual({ code: "request", message: REDIS_AGENT_SENTENCES.empty });
  });

  test("a second command, a CRLF, a tab and every other control character are refused, so one request is one command", () => {
    for (const text of [
      "TYPE a\nDEL a",
      "TYPE a\r\nDEL a",
      "TYPE a\rDEL a",
      "TYPE\ta",
      "TYPE a\u0000",
      "TYPE a\u007f",
      "TYPE a\u0085",
      "TYPE a\u2028DEL a",
      "TYPE a\u2029b",
      "MULTI\nTYPE a\nEXEC",
    ]) {
      expect(refusal(text), JSON.stringify(text)).toEqual({ code: "request", message: REDIS_AGENT_SENTENCES.control });
    }
  });

  test("a quote that opens and never closes, a single quote, a stray backslash and glued quotes break the grammar", () => {
    for (const text of [
      'TYPE "unclosed',
      "TYPE 'single'",
      "TYPE it's",
      "TYPE back\\slash",
      'TYPE "a"b',
      'TYPE a"b"',
      'TYPE "bad \\n escape"',
      'TYPE "ends with \\',
    ]) {
      expect(refusal(text), text).toEqual({ code: "request", message: REDIS_AGENT_SENTENCES.quoting });
    }
  });

  test("every command outside the table is refused as metadata only, and the sentence quotes none of it", () => {
    for (const text of [
      "GET secret:token",
      "HGETALL user:1",
      "KEYS *",
      "SCAN 0 MATCH user:* COUNT 10",
      "RANDOMKEY",
      "INFO",
      "INFO keyspace",
      "MULTI",
      "EXEC",
      "DEL user:1",
      "FLUSHALL",
      "CONFIG SET maxmemory 1",
      "CONFIG GET *",
      "EVAL_RO \"return redis.call('GET', KEYS[1])\" 1 k",
      "FCALL_RO f 0",
      "SORT_RO list",
      "PFCOUNT hll",
      "DEBUG OBJECT k",
      "CLIENT LIST",
      "MONITOR",
      "SELECT 1",
      "HELLO 3",
      "OBJECT FREQ k",
      "OBJECT IDLETIME k",
      "OBJECT",
      "MEMORY DOCTOR",
      "MEMORY STATS",
      "MEMORY",
      "XINFO STREAM s",
      "FT.SEARCH idx *",
      "JSON.GET k",
      "# a comment",
      "__proto__ k",
      "constructor k",
      "toString",
      "hasOwnProperty k",
      '"OBJECT ENCODING" k',
      "1) TYPE k",
      "redis-cli TYPE k",
    ]) {
      expect(refusal(text), text).toEqual({ code: "metadata-only", message: REDIS_AGENT_SENTENCES.metadataOnly });
    }
    expect(REDIS_AGENT_SENTENCES.metadataOnly).not.toContain("secret");
  });

  test("a read with the wrong arguments is refused by its row, the SAMPLES count clamped from 1 to 5", () => {
    const cases: Array<[string, RedisAgentOperation]> = [
      ["DBSIZE 0", "DBSIZE"],
      ["TYPE", "TYPE"],
      ["TYPE a b", "TYPE"],
      ['TYPE ""', "TYPE"],
      ["EXISTS a b", "EXISTS"],
      ["TTL a b", "TTL"],
      ["OBJECT ENCODING", "OBJECT ENCODING"],
      ["MEMORY USAGE", "MEMORY USAGE"],
      ["MEMORY USAGE k SAMPLES 0", "MEMORY USAGE"],
      ["MEMORY USAGE k SAMPLES 6", "MEMORY USAGE"],
      ["MEMORY USAGE k SAMPLES 10", "MEMORY USAGE"],
      ["MEMORY USAGE k SAMPLES 05", "MEMORY USAGE"],
      ["MEMORY USAGE k SAMPLES -1", "MEMORY USAGE"],
      ["MEMORY USAGE k SAMPLES", "MEMORY USAGE"],
      ["MEMORY USAGE k SAMPLES 5 x", "MEMORY USAGE"],
      ["MEMORY USAGE k COUNT 5", "MEMORY USAGE"],
      ["STRLEN k SAMPLES 5", "STRLEN"],
    ];
    for (const [text, op] of cases) {
      expect(refusal(text), text).toEqual({ code: "arguments", message: REDIS_AGENT_SENTENCES.arguments(op) });
    }
  });
});
