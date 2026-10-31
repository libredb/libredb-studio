/**
 * The YANG statement reader the agent's withheld-node check stands on: keywords, arguments, blocks, comments, quoted
 * and joined strings, and the refusals of a text that breaks the grammar or a bound.
 */
import { describe, expect, test } from "bun:test";
import { MAX_YANG_STATEMENTS, parseYangText, YangTextError } from "@/lib/db/providers/network/netconf/yangtree";

describe("parseYangText", () => {
  test("reads statements, arguments and blocks, skipping both comment forms", () => {
    const [module] = parseYangText(`
      // a line comment
      module m { /* a block
      comment */ prefix "m";
        import ietf-netconf-acm { prefix nacm; }
        container c { leaf p { type ianach:crypt-hash; nacm:default-deny-all; } }
      }`);
    expect(module).toEqual({
      keyword: "module",
      argument: "m",
      children: [
        { keyword: "prefix", argument: "m", children: [] },
        {
          keyword: "import",
          argument: "ietf-netconf-acm",
          children: [{ keyword: "prefix", argument: "nacm", children: [] }],
        },
        {
          keyword: "container",
          argument: "c",
          children: [
            {
              keyword: "leaf",
              argument: "p",
              children: [
                { keyword: "type", argument: "ianach:crypt-hash", children: [] },
                { keyword: "nacm:default-deny-all", children: [] },
              ],
            },
          ],
        },
      ],
    });
  });

  test("keeps braces and semicolons inside quoted text, joins strings with +, and decodes double-quoted escapes", () => {
    const [statement] = parseYangText(`description "a { b ; c }" + 'd "e"' + "\\t\\n\\"\\\\";`);
    expect(statement).toEqual({ keyword: "description", argument: 'a { b ; c }d "e"\t\n"\\', children: [] });
  });

  test("an unquoted argument stops at a comment, a brace or a semicolon", () => {
    expect(parseYangText("leaf a//x\n;")).toEqual([{ keyword: "leaf", argument: "a", children: [] }]);
    expect(parseYangText("leaf a/*x*/;")).toEqual([{ keyword: "leaf", argument: "a", children: [] }]);
    expect(parseYangText("augment /a:b/a:c{}")).toEqual([{ keyword: "augment", argument: "/a:b/a:c", children: [] }]);
  });

  test("refuses every text that breaks the grammar, without quoting it", () => {
    const broken = [
      "module m { /* open",
      'module m { description "open',
      "module m { description 'open",
      'module m { description "\\q"; }',
      "module m { prefix m; ",
      "module m prefix",
      "{ leaf a; }",
      'leaf a "b" + c;',
    ];
    for (const text of broken) {
      expect(() => parseYangText(text)).toThrow(YangTextError);
      try {
        parseYangText(text);
      } catch (error) {
        expect((error as Error).message).not.toContain(text);
      }
    }
  });

  test("refuses a text past the byte, depth or statement bound", () => {
    expect(() => parseYangText("leaf a;", { maxBytes: 3, maxDepth: 64 })).toThrow("larger than 3 bytes");
    expect(() => parseYangText("a { b { c; } }", { maxBytes: 100, maxDepth: 1 })).toThrow("depth cap");
    expect(parseYangText("a { b; }", { maxBytes: 100, maxDepth: 1 })).toHaveLength(1);
    expect(() => parseYangText("a;".repeat(MAX_YANG_STATEMENTS + 1))).toThrow(`more than ${MAX_YANG_STATEMENTS}`);
  });
});
