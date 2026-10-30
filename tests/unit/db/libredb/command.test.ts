/**
 * The LibreDB command reader: the tokenizer the editor's commands are read with, and the agent's read form on top of
 * it, which admits one read command on one line and refuses every other shape by name.
 */
import { describe, expect, test } from "bun:test";
import { readLibreDBReadCommand, tokenizeLibreDBCommand } from "@/lib/db/providers/embedded/libredb-command";

const READS = "the reads are get <key>, prefix <p> and range <start> <end>";

describe("tokenizeLibreDBCommand", () => {
  test("splits on whitespace and keeps a quoted token whole, either quote", () => {
    expect(tokenizeLibreDBCommand(`put k "a  b" 'c d'`)).toEqual(["put", "k", "a  b", "c d"]);
    expect(tokenizeLibreDBCommand("get   users:1  ")).toEqual(["get", "users:1"]);
  });

  test("keeps an empty quoted token, and one quote inside the other", () => {
    expect(tokenizeLibreDBCommand(`prefix ""`)).toEqual(["prefix", ""]);
    expect(tokenizeLibreDBCommand(`get "it's"`)).toEqual(["get", "it's"]);
  });

  test("answers null for an unmatched quote", () => {
    expect(tokenizeLibreDBCommand(`get "users:1`)).toBeNull();
  });
});

describe("readLibreDBReadCommand", () => {
  test.each([
    ["get users:1", { verb: "get", key: "users:1" }],
    ["GET users:1", { verb: "get", key: "users:1" }],
    ['get "a key with spaces"', { verb: "get", key: "a key with spaces" }],
    ["prefix users:", { verb: "prefix", prefix: "users:" }],
    ["  Prefix users:  ", { verb: "prefix", prefix: "users:" }],
    ["range a z", { verb: "range", start: "a", end: "z" }],
    ["range '' 'users:~'", { verb: "range", start: "", end: "users:~" }],
  ] as const)("admits %p", (text, command) => {
    expect(readLibreDBReadCommand(text)).toEqual({ ok: true, command });
  });

  test.each([
    ["put users:9 Mallory", "put"],
    ["PUT users:9 Mallory", "put"],
    ['"put" users:9 Mallory', "put"],
    ["delete users:1", "delete"],
    ["Delete users:1", "delete"],
    ["'delete' users:1", "delete"],
  ])("refuses the write %p by name", (text, verb) => {
    expect(readLibreDBReadCommand(text)).toEqual({
      ok: false,
      code: "write-command",
      message: `"${verb}" writes, and an agent read only reads: ${READS}. Nothing was sent.`,
    });
  });

  test.each(["set users:1 x", "del users:1", "remove users:1", "insert users:1 x", "scan users:", "getx users:1"])(
    "refuses %p, which is not a LibreDB command",
    (text) => {
      const reading = readLibreDBReadCommand(text);
      expect(reading.ok).toBe(false);
      expect(reading).toMatchObject({ code: "unknown-command" });
      expect((reading as { message: string }).message).toEndWith(
        `is not a LibreDB command: ${READS}. Nothing was sent.`,
      );
    },
  );

  test("names at most forty characters of an unknown command", () => {
    const reading = readLibreDBReadCommand(`${"x".repeat(100)} users:1`);
    expect(reading).toEqual({
      ok: false,
      code: "unknown-command",
      message: `"${"x".repeat(40)}..." is not a LibreDB command: ${READS}. Nothing was sent.`,
    });
  });

  test.each([
    ["get", "get takes exactly one key: get <key>, with a key that holds a space in quotes"],
    ["get a b", "get takes exactly one key: get <key>, with a key that holds a space in quotes"],
    ["prefix", "prefix takes exactly one prefix: prefix <p>, with a prefix that holds a space in quotes"],
    ["prefix a b", "prefix takes exactly one prefix: prefix <p>, with a prefix that holds a space in quotes"],
    ['prefix ""', "prefix needs at least one character: to read from the first key, use range"],
    ["range a", "range takes exactly a start and an end: range <start> <end>, the end excluded"],
    ["range a b c", "range takes exactly a start and an end: range <start> <end>, the end excluded"],
  ])("refuses %p, whose arguments do not fit the read", (text, sentence) => {
    expect(readLibreDBReadCommand(text)).toEqual({
      ok: false,
      code: "arguments",
      message: `${sentence}. Nothing was sent.`,
    });
  });

  test.each(["", "   ", "\t"])("refuses %p, which holds no command", (text) => {
    expect(readLibreDBReadCommand(text)).toEqual({
      ok: false,
      code: "empty",
      message: `The statement holds no command: write one read, where ${READS}. Nothing was sent.`,
    });
  });

  test.each(["# get users:1", "  #prefix users:"])("refuses the comment %p", (text) => {
    expect(readLibreDBReadCommand(text)).toEqual({
      ok: false,
      code: "comment",
      message: `The statement is a comment: write one read without a leading #, where ${READS}. Nothing was sent.`,
    });
  });

  test.each([
    "get users:1\nput users:9 x",
    "# a note\nget users:1",
    "get users:1\r\nget users:2",
    "get users:1\rput users:9 x",
    "get users:1\u2028put users:9 x",
    "get users:1\u2029put users:9 x",
    'get "users:1\nput users:9 x"',
  ])("refuses %p, which holds more than one line", (text) => {
    expect(readLibreDBReadCommand(text)).toEqual({
      ok: false,
      code: "lines",
      message:
        "The statement holds more than one line: an agent read is exactly one command on one line, with no comment line. Nothing was sent.",
    });
  });

  test("refuses an unmatched quote", () => {
    expect(readLibreDBReadCommand(`get "users:1`)).toEqual({
      ok: false,
      code: "unmatched-quote",
      message: "The statement has an unmatched quote: close it, or write the key without quotes. Nothing was sent.",
    });
  });
});
