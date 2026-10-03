/**
 * The console tokeniser (vector-family spec 3.4): strings first, comments only at a token boundary outside strings
 * and only where the dialect takes them, a bounded line state, and nothing refused here.
 */
import { describe, expect, test } from "bun:test";
import {
  type ConsoleLineState,
  type ConsoleToken,
  consoleLineStatesEqual,
  INITIAL_CONSOLE_STATE,
  tokenizeLine,
} from "@/lib/db/console/lexer";
import { MILVUS_STAND_IN, QDRANT_STAND_IN } from "../../../helpers/console-stand-ins";

/** Each token as `kind:text`, whitespace left out, the way the assertions below read them. */
function read(spec = QDRANT_STAND_IN, line: string, state: ConsoleLineState = INITIAL_CONSOLE_STATE) {
  const result = tokenizeLine(spec, line, state);
  return {
    tokens: result.tokens
      .filter((token) => token.kind !== "whitespace")
      .map((token) => `${token.kind}:${line.slice(token.start, token.end)}`),
    state: result.state,
  };
}

/** A whole text, line by line, each from the state the line before left. */
function readText(spec: typeof QDRANT_STAND_IN, text: string): string[][] {
  let state = INITIAL_CONSOLE_STATE;
  return text.split("\n").map((line) => {
    const result = read(spec, line, state);
    state = result.state;
    return result.tokens;
  });
}

describe("before the request line", () => {
  test("a blank line and a comment line leave the state where it was", () => {
    expect(read(QDRANT_STAND_IN, "   ")).toEqual({ tokens: [], state: INITIAL_CONSOLE_STATE });
    expect(read(QDRANT_STAND_IN, "  // a note {")).toEqual({
      tokens: ["comment:// a note {"],
      state: INITIAL_CONSOLE_STATE,
    });
    expect(read(QDRANT_STAND_IN, "# a note")).toEqual({ tokens: ["comment:# a note"], state: INITIAL_CONSOLE_STATE });
  });

  test("a marker the dialect does not declare starts the request line, as an invalid method", () => {
    expect(read(MILVUS_STAND_IN, "// a note").tokens).toEqual(["invalid://", "path:a", "invalid:note"]);
  });
});

describe("the request line", () => {
  test("a method, a path, its parameters and a query string", () => {
    expect(read(QDRANT_STAND_IN, "GET /collections/{collection_name}/points/{id}?timeout=5").tokens).toEqual([
      "method:GET",
      "path:/collections/",
      "path-param:{collection_name}",
      "path:/points/",
      "path-param:{id}",
      "query:?timeout=5",
    ]);
  });

  test("a method the dialect does not take is invalid, and a fragment is invalid from its #", () => {
    expect(read(MILVUS_STAND_IN, "GET entities/search#top").tokens).toEqual([
      "invalid:GET",
      "path:entities/search",
      "invalid:#top",
    ]);
  });

  test("an unclosed brace runs to the end of the path", () => {
    expect(read(QDRANT_STAND_IN, "GET collections/{name").tokens).toEqual([
      "method:GET",
      "path:collections/",
      "path-param:{name",
    ]);
  });

  test("a body on the request line is read as the body", () => {
    const line = read(MILVUS_STAND_IN, 'POST entities/search {"limit": 5}');
    expect(line.tokens).toEqual([
      "method:POST",
      "path:entities/search",
      "punctuation:{",
      'key:"limit"',
      "punctuation::",
      "number:5",
      "punctuation:}",
    ]);
    expect(line.state).toEqual({ section: "after-body", inString: false, depth: 0 });
  });

  test("the request line moves the state to the body", () => {
    expect(read(QDRANT_STAND_IN, "GET collections").state).toEqual({ section: "body", inString: false, depth: 0 });
  });
});

describe("the body", () => {
  test("keys, strings, numbers, keywords and punctuation", () => {
    expect(
      readText(QDRANT_STAND_IN, 'POST collections/docs/points/query\n{"a": [1, -2.5e3, "x"], "b": true, "c": null}'),
    ).toEqual([
      ["method:POST", "path:collections/docs/points/query"],
      [
        "punctuation:{",
        'key:"a"',
        "punctuation::",
        "punctuation:[",
        "number:1",
        "punctuation:,",
        "number:-2.5e3",
        "punctuation:,",
        'string:"x"',
        "punctuation:]",
        "punctuation:,",
        'key:"b"',
        "punctuation::",
        "keyword:true",
        "punctuation:,",
        'key:"c"',
        "punctuation::",
        "keyword:null",
        "punctuation:}",
      ],
    ]);
  });

  test("a string holding // and # is a string, and a URL inside it keeps its bytes", () => {
    expect(readText(QDRANT_STAND_IN, 'POST x\n{"u": "http://h/#a // b"}')[1]).toEqual([
      "punctuation:{",
      'key:"u"',
      "punctuation::",
      'string:"http://h/#a // b"',
      "punctuation:}",
    ]);
  });

  test("an escaped quote does not close a string", () => {
    expect(readText(QDRANT_STAND_IN, 'POST x\n{"q": "say \\"hi\\" // ok"}')[1][3]).toBe('string:"say \\"hi\\" // ok"');
  });

  test("// at a token boundary is a comment where the dialect takes body comments, and invalid where it does not", () => {
    expect(readText(QDRANT_STAND_IN, 'POST x\n{"a": 1 // it\'s "quoted" {\n}')[1]).toEqual([
      "punctuation:{",
      'key:"a"',
      "punctuation::",
      "number:1",
      'comment:// it\'s "quoted" {',
    ]);
    expect(readText(MILVUS_STAND_IN, 'POST x\n{"a": 1 // note\n}')[1].at(-1)).toBe("invalid:// note");
  });

  test("// inside a word is not a comment", () => {
    expect(readText(QDRANT_STAND_IN, 'POST x\n{"a": 1//c}')[1]).toEqual([
      "punctuation:{",
      'key:"a"',
      "punctuation::",
      "invalid:1//c",
      "punctuation:}",
    ]);
  });

  test("a comment keeps the CR before the LF", () => {
    const tokens = tokenizeLine(QDRANT_STAND_IN, "1 // note\r", { section: "body", inString: false, depth: 1 }).tokens;
    expect(tokens.at(-1)).toEqual({ kind: "comment", line: 1, start: 2, end: 10 });
  });

  test("a # after the request line is invalid to the end of the line", () => {
    expect(readText(QDRANT_STAND_IN, "POST x\n# note\n{}")[1]).toEqual(["invalid:# note"]);
  });

  test("an ellipsis, a bare word and a malformed number are invalid", () => {
    expect(readText(QDRANT_STAND_IN, 'POST x\n{"a": ..., "b": NaN, "c": 01}')[1]).toEqual([
      "punctuation:{",
      'key:"a"',
      "punctuation::",
      "invalid:...",
      "punctuation:,",
      'key:"b"',
      "punctuation::",
      "invalid:NaN",
      "punctuation:,",
      'key:"c"',
      "punctuation::",
      "invalid:01",
      "punctuation:}",
    ]);
  });

  test("a key whose colon is on the next line reads as a string", () => {
    expect(readText(QDRANT_STAND_IN, 'POST x\n{"a"\n: 1}')[1]).toEqual(["punctuation:{", 'string:"a"']);
  });

  test("after the body, anything but whitespace and comments is invalid", () => {
    expect(readText(QDRANT_STAND_IN, "POST x\n{}\nGET collections // again")[2]).toEqual([
      "invalid:GET collections // again",
    ]);
    expect(readText(QDRANT_STAND_IN, "POST x\n{} // done")[1]).toEqual([
      "punctuation:{",
      "punctuation:}",
      "comment:// done",
    ]);
  });
});

describe("the line state", () => {
  test("an unclosed string is invalid, and the next line continues it as invalid text up to its quote", () => {
    const first = read(QDRANT_STAND_IN, '{"a": "http://x', { section: "body", inString: false, depth: 0 });
    expect(first.tokens).toEqual(["punctuation:{", 'key:"a"', "punctuation::", 'invalid:"http://x']);
    expect(first.state).toEqual({ section: "body", inString: true, depth: 1 });
    const second = read(QDRANT_STAND_IN, 'still" }', first.state);
    expect(second.tokens).toEqual(['invalid:still"', "punctuation:}"]);
    expect(second.state).toEqual({ section: "after-body", inString: false, depth: 0 });
    const unclosed = read(QDRANT_STAND_IN, "no quote here", first.state);
    expect(unclosed).toEqual({ tokens: ["invalid:no quote here"], state: first.state });
  });

  test("depth is capped at maxDepth + 1, so the state stays bounded", () => {
    const deep = read(QDRANT_STAND_IN, "[".repeat(100), { section: "body", inString: false, depth: 0 });
    expect(deep.state.depth).toBe(QDRANT_STAND_IN.maxDepth + 1);
  });

  test("states compare by value", () => {
    expect(
      consoleLineStatesEqual(INITIAL_CONSOLE_STATE, { section: "before-request", inString: false, depth: 0 }),
    ).toBe(true);
    expect(consoleLineStatesEqual(INITIAL_CONSOLE_STATE, { section: "body", inString: false, depth: 0 })).toBe(false);
    expect(consoleLineStatesEqual(INITIAL_CONSOLE_STATE, { section: "before-request", inString: true, depth: 0 })).toBe(
      false,
    );
    expect(
      consoleLineStatesEqual(INITIAL_CONSOLE_STATE, { section: "before-request", inString: false, depth: 1 }),
    ).toBe(false);
  });

  test("the initial state is frozen", () => {
    expect(Object.isFrozen(INITIAL_CONSOLE_STATE)).toBe(true);
  });
});

describe("the line number and the charge", () => {
  test("every token carries the line number it was given, and the charge sees each before it is kept", () => {
    const seen: ConsoleToken[] = [];
    const result = tokenizeLine(QDRANT_STAND_IN, "GET collections", INITIAL_CONSOLE_STATE, 7, (token) =>
      seen.push(token),
    );
    expect(result.tokens.every((token) => token.line === 7)).toBe(true);
    expect(seen).toEqual([...result.tokens]);
  });

  test("a charge that throws stops the line before its token is kept", () => {
    expect(() =>
      tokenizeLine(QDRANT_STAND_IN, "[1, 2]", { section: "body", inString: false, depth: 0 }, 1, (token) => {
        if (token.kind === "number") throw new Error("bound");
      }),
    ).toThrow("bound");
  });
});
