/**
 * The comment and string reader the repository-wide text guards use (tests/helpers/comment-text.ts): each comment
 * kind, strings and templates with their substitutions removed, the strings of each array literal, JSX text kept
 * out, and the `#` and `//` comment syntaxes read by line.
 */
import { describe, expect, test } from "bun:test";
import { codeExtension, codeText, hashCommentLines, slashCommentLines } from "../helpers/comment-text";

describe("codeText", () => {
  test("reads line, block and doc comments, each split into the lines it sits on", () => {
    const source = ["const a = 1; // trailing note", "/**", " * doc line", " */", "/* block */ const b = 2;"].join(
      "\n",
    );
    const { comments } = codeText(source, "x.ts");
    expect(comments).toEqual([
      { line: 0, text: "// trailing note" },
      { line: 1, text: "/**" },
      { line: 2, text: " * doc line" },
      { line: 3, text: " */" },
      { line: 4, text: "/* block */" },
    ]);
  });

  test("reads a comment left open to the end of the file", () => {
    const { comments } = codeText("const a = 1;\n/* never closed", "x.ts");
    expect(comments).toEqual([{ line: 1, text: "/* never closed" }]);
  });

  test("reads strings and templates, a substitution removed and its literal parts kept", () => {
    const source = [
      'const a = "plain";',
      "const b = `no substitution`;",
      "const c = `It runs on ${engines}.`;",
      "const d = `first ${x} middle ${y} last`;",
    ].join("\n");
    const { strings } = codeText(source, "x.ts");
    expect(strings).toEqual([
      { line: 0, text: "plain" },
      { line: 1, text: "no substitution" },
      { line: 2, text: "It runs on ." },
      { line: 3, text: "first  middle  last" },
    ]);
  });

  test("splits a template across lines onto the lines it starts from", () => {
    const { strings } = codeText("const a = `one\ntwo`;", "x.mjs");
    expect(strings).toEqual([
      { line: 0, text: "one" },
      { line: 1, text: "two" },
    ]);
  });

  test("never reads a regular expression or a comment-shaped string as a comment", () => {
    const source = 'const r = /\\/\\/ not a comment/; const s = "/* nor this */";';
    const { comments, strings } = codeText(source, "x.js");
    expect(comments).toEqual([]);
    expect(strings).toEqual([{ line: 0, text: "/* nor this */" }]);
  });

  test("keeps JSX text out, and reads a comment inside a JSX expression", () => {
    const source = "const v = <p>// text, not a comment {/* real */}</p>;";
    const { comments, strings } = codeText(source, "x.tsx");
    expect(comments).toEqual([{ line: 0, text: "/* real */" }]);
    expect(strings).toEqual([]);
  });

  test("collects the strings of each array literal, an outer array holding its nested ones", () => {
    const { arrays } = codeText('const a = [["one", 1], ["two"], `three`, x];', "x.cjs");
    expect(arrays).toEqual([
      { line: 0, strings: ["one", "two", "three"], caseTable: false },
      { line: 0, strings: ["one"], caseTable: false },
      { line: 0, strings: ["two"], caseTable: false },
    ]);
  });

  test("marks the array a .each call takes as its case table, and no other array", () => {
    const { arrays } = codeText('test.each([["a"], ["b"]])("%s", () => f(["c"]));', "x.ts");
    expect(arrays.map((array) => [array.strings, array.caseTable])).toEqual([
      [["a", "b"], true],
      [["a"], false],
      [["b"], false],
      [["c"], false],
    ]);
  });

  test("refuses a file it does not parse", () => {
    expect(() => codeText("", "notes.md")).toThrow("notes.md is not a file codeText parses");
  });
});

describe("codeExtension", () => {
  test("names the code extensions it parses, and null for every other file", () => {
    expect(["a.ts", "a.mts", "a.tsx", "a.js", "a.mjs", "a.cjs"].map(codeExtension)).toEqual([
      ".ts",
      ".mts",
      ".tsx",
      ".js",
      ".mjs",
      ".cjs",
    ]);
    expect(["a.md", "a.yaml", "Dockerfile"].map(codeExtension)).toEqual([null, null, null]);
  });
});

describe("hashCommentLines", () => {
  test("reads whole # lines and a # after whitespace, never a # inside a word", () => {
    const source = ["# whole line", "key: value  # after value", "url: http://host/a#b", "plain: line"].join("\n");
    expect(hashCommentLines(source)).toEqual([
      { line: 0, text: "# whole line" },
      { line: 1, text: "# after value" },
    ]);
  });
});

describe("slashCommentLines", () => {
  test("reads lines that hold only a // comment, never a URL inside a string", () => {
    const source = ["// whole line", "\t// indented", 'u := "http://host"'].join("\n");
    expect(slashCommentLines(source)).toEqual([
      { line: 0, text: "// whole line" },
      { line: 1, text: "// indented" },
    ]);
  });
});
