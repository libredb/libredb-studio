/**
 * The console's Format (vector-family spec 3.5): the body re-indented from the lexer's tokens, every other byte kept,
 * and a text the grammar cannot read refused with the parser's own refusal.
 */
import { describe, expect, test } from "bun:test";
import { formatConsole } from "@/lib/db/console/format";
import { ConsoleRefusal } from "@/lib/db/console/parser";
import { MILVUS_STAND_IN, QDRANT_STAND_IN } from "../../../helpers/console-stand-ins";

describe("formatConsole", () => {
  test("re-indents the body two spaces a level, a list of scalars on one line", () => {
    expect(
      formatConsole(
        MILVUS_STAND_IN,
        '# nearest\nPOST /v2/vectordb/entities/search\n{"collectionName":"docs","data":[[0.1,0.2]],"filter":"seq >= 10","limit":5,"outputFields":["id","seq"],"searchParams":{"params":{"ef":64}},"x":{},"y":[]}',
      ),
    ).toBe(
      [
        "# nearest",
        "POST /v2/vectordb/entities/search",
        "{",
        '  "collectionName": "docs",',
        '  "data": [',
        "    [0.1, 0.2]",
        "  ],",
        '  "filter": "seq >= 10",',
        '  "limit": 5,',
        '  "outputFields": ["id", "seq"],',
        '  "searchParams": {',
        '    "params": {',
        '      "ef": 64',
        "    }",
        "  },",
        '  "x": {},',
        '  "y": []',
        "}",
      ].join("\n"),
    );
  });

  test("keeps every literal's bytes: an integer above 2^53, a float's typed text, an escaped string", () => {
    expect(
      formatConsole(MILVUS_STAND_IN, 'POST entities/get {"id":[18446744073709551615],"f":1.50,"s":"a\\"b\\u00e9"}'),
    ).toBe(
      ["POST entities/get", "{", '  "id": [18446744073709551615],', '  "f": 1.50,', '  "s": "a\\"b\\u00e9"', "}"].join(
        "\n",
      ),
    );
  });

  test("keeps the comment and request lines as typed, and each body comment on a line of its own", () => {
    expect(
      formatConsole(
        QDRANT_STAND_IN,
        '// first\n\n  POST   /collections/docs/points/query?timeout=5   {"limit": 3, // three\r\n"url": "http://x//y"} // done',
      ),
    ).toBe(
      [
        "// first",
        "",
        "  POST   /collections/docs/points/query?timeout=5",
        "{",
        '  "limit": 3,',
        "  // three\r",
        '  "url": "http://x//y"',
        "}",
        "// done",
      ].join("\n"),
    );
  });

  test("a list holding a comment or a container is written one element a line", () => {
    expect(formatConsole(QDRANT_STAND_IN, 'POST x\n{"a": [1, // one\n2, {"b": true}]}')).toBe(
      [
        "POST x",
        "{",
        '  "a": [',
        "    1,",
        "    // one",
        "    2,",
        "    {",
        '      "b": true',
        "    }",
        "  ]",
        "}",
      ].join("\n"),
    );
  });

  test("a request with no body is its lines before the body", () => {
    expect(formatConsole(QDRANT_STAND_IN, "# list\nGET collections")).toBe("# list\nGET collections");
  });

  test("is idempotent", () => {
    const once = formatConsole(QDRANT_STAND_IN, 'POST x {"a":{"b":[1,2,{"c":null}]},"d":"e"} // tail');
    expect(formatConsole(QDRANT_STAND_IN, once)).toBe(once);
  });

  test("refuses a text the grammar cannot read, with the parser's own refusal", () => {
    for (const [text, code] of [
      ['POST x\n{"a": 1,}', "trailing-comma"],
      ['POST x\n{"a": ...}', "ellipsis"],
      ["  ", "empty"],
      ["# only", "no-request"],
    ] as const) {
      let refusal: unknown;
      try {
        formatConsole(MILVUS_STAND_IN, text);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ConsoleRefusal);
      expect((refusal as ConsoleRefusal).reason).toBe(code);
    }
  });
});
