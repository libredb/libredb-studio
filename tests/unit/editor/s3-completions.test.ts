/**
 * Completion for the `s3` editor language: where the cursor stands, read through the
 * console's own lexer, and what is offered there. Completion never sends a request and offers no folder or key; the
 * bucket names come from the schema context the editor holds, which an S3 connection's own schema leaves empty.
 */
import { describe, expect, spyOn, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import * as shellWords from "@/lib/db/console/shell-words";
import { registerS3CompletionProvider, s3CompletionBucketsOf, s3CompletionContext } from "@/lib/editor/s3-completions";

describe("s3CompletionBucketsOf", () => {
  test("reads each object's first path segment, else its name, deduplicated in first-seen order", () => {
    expect(
      s3CompletionBucketsOf([
        { name: "sales", path: ["sales"] },
        { name: "logs" },
        { name: "x", path: ["sales", "x"] },
        { name: "a b", path: ["a b"] },
      ]),
    ).toEqual(["sales", "logs", "a b"]);
  });
});

describe("s3CompletionContext", () => {
  test.each([
    ["", { kind: "command", start: 0 }],
    ["pre", { kind: "command", start: 0 }],
    ["aws ", { kind: "command", start: 0 }],
    ["$ aws s3", { kind: "command", start: 2 }],
    ["aws s3 ", { kind: "operation", service: "s3", start: 7 }],
    ["aws s3api he", { kind: "operation", service: "s3api", start: 10 }],
    ["aws s3api head-object --", { kind: "flag", operation: "head-object", given: [], start: 22 }],
    ["aws s3api head-object --bucket b --", { kind: "flag", operation: "head-object", given: ["--bucket"], start: 33 }],
    ["preview s3://b/k --", { kind: "flag", operation: "preview", given: [], start: 17 }],
    ["aws s3api list-objects-v2 --delimiter ", { kind: "value", flag: "--delimiter", values: ["/"], start: 38 }],
    [
      "aws s3api list-objects-v2 --encoding-type ",
      { kind: "value", flag: "--encoding-type", values: ["url"], start: 42 },
    ],
    [
      "preview s3://b/k --format ",
      {
        kind: "value",
        flag: "--format",
        values: ["text", "json", "ndjson", "csv", "tsv", "parquet", "hex"],
        start: 26,
      },
    ],
    [
      "aws --output ",
      { kind: "value", flag: "--output", values: ["json", "text", "table", "yaml", "yaml-stream", "off"], start: 13 },
    ],
    ["aws s3 ls --color ", { kind: "value", flag: "--color", values: ["on", "off", "auto"], start: 18 }],
    ["aws s3api head-object --bucket ", { kind: "bucket", asPath: false, start: 31 }],
    ["aws s3 ls ", { kind: "bucket", asPath: true, start: 10 }],
    ["aws s3 ls s3://sa", { kind: "bucket", asPath: true, start: 10 }],
    ["preview ", { kind: "bucket", asPath: true, start: 8 }],
    ["aws s3 ls --recursive ", { kind: "bucket", asPath: true, start: 22 }],
    ["# list\naws s3", { kind: "command", start: 7 }],
  ] as const)("%j", (before, expected) => {
    expect(s3CompletionContext(before)).toEqual(expected);
  });

  test.each([
    ["aws s3 ls s3://sales/"],
    ["aws ec2 s3://"],
    ["aws --region s3://"],
    ["aws s3api head-object --key s3://"],
    ["aws s3api head-object --bucket s3://"],
    ["aws s3api head-object s3://"],
    ["aws s3api head-object --key "],
    ["aws s3api head-object "],
    ["aws --region "],
    ["aws ec2 "],
    ["aws s3api frob --"],
    ["aws s3 ls 'a"],
    ["aws s3 ls ; "],
    ["-"],
  ])("offers nothing at %j", (before) => {
    expect(s3CompletionContext(before)).toBeUndefined();
  });
});

describe("registerS3CompletionProvider", () => {
  type Provider = {
    triggerCharacters?: string[];
    provideCompletionItems: (
      model: unknown,
      position: { lineNumber: number; column: number },
    ) => { suggestions: Array<{ label: string; kind: number; insertText: string; range: unknown }> };
  };

  function register(buckets: readonly string[]): { readonly provider: Provider; readonly languageId: string } {
    let captured: { languageId: string; provider: Provider } | undefined;
    const monaco = {
      languages: {
        CompletionItemKind: { Keyword: 17, Property: 9, EnumMember: 16, Folder: 23 },
        registerCompletionItemProvider: (languageId: string, provider: Provider) => {
          captured = { languageId, provider };
          return { dispose: () => {} };
        },
      },
    } as unknown as typeof Monaco;
    registerS3CompletionProvider(monaco, buckets);
    if (captured === undefined) throw new Error("no provider registered");
    return captured;
  }

  const at = (provider: Provider, text: string) =>
    provider.provideCompletionItems(
      { getValue: () => text, getOffsetAt: () => text.length },
      { lineNumber: 1, column: text.length + 1 },
    ).suggestions;

  test("registers for the s3 language with - and / as trigger characters", () => {
    const { provider, languageId } = register([]);
    expect(languageId).toBe("s3");
    expect(provider.triggerCharacters).toEqual(["-", "/"]);
  });

  test("offers the commands, then the operations, then the operation's flags and the accepted globals", () => {
    const { provider } = register([]);
    expect(at(provider, "").map((item) => item.label)).toEqual(["aws s3 ls", "aws s3api", "preview"]);
    expect(at(provider, "aws s3 ").map((item) => item.label)).toEqual(["ls"]);
    expect(at(provider, "aws s3api ").map((item) => item.label)).toEqual([
      "list-buckets",
      "list-objects-v2",
      "list-object-versions",
      "head-bucket",
      "head-object",
      "get-object-tagging",
      "get-bucket-location",
      "get-bucket-versioning",
    ]);
    expect(at(provider, "aws s3api head-object --bucket b --").map((item) => item.label)).toEqual([
      "--key",
      "--endpoint-url",
      "--region",
      "--output",
      "--color",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ]);
  });

  test("offers a closed value set after its flag, as enum members", () => {
    const { provider } = register([]);
    expect(at(provider, "aws s3 ls --color ").map((item) => [item.label, item.kind])).toEqual([
      ["on", 16],
      ["off", 16],
      ["auto", 16],
    ]);
  });

  test("never offers a refused option", () => {
    const { provider } = register([]);
    const labels = at(provider, "aws s3api list-objects-v2 --").map((item) => item.label);
    for (const refused of ["--profile", "--query", "--start-after", "--fetch-owner", "--debug", "--no-sign-request"]) {
      expect(labels).not.toContain(refused);
    }
  });

  test("offers bucket names after --bucket and as s3:// paths, each insert quoted when it needs quotes", () => {
    // A name no command line spells (a carriage return) is not offered.
    const { provider } = register(["sales", "a b", "x\ry"]);
    expect(at(provider, "aws s3api head-bucket --bucket ").map((item) => [item.label, item.insertText])).toEqual([
      ["sales", "sales"],
      ["a b", "'a b'"],
    ]);
    expect(at(provider, "aws s3 ls s3://").map((item) => [item.label, item.insertText])).toEqual([
      ["s3://sales/", "s3://sales/"],
      ["s3://a b/", "'s3://a b/'"],
    ]);
    expect(at(provider, "preview s3://").map((item) => item.label)).toEqual(["s3://sales/", "s3://a b/"]);
  });

  test("a bucket name holding a NUL or a lone surrogate is not offered either", () => {
    const { provider } = register(["sales", "x\u0000y", "x\ud800"]);
    expect(at(provider, "aws s3api head-bucket --bucket ").map((item) => item.label)).toEqual(["sales"]);
  });

  test("any other error from quoteShellWord is let through, not read as a name with no spelling", () => {
    const { provider } = register(["sales"]);
    const spy = spyOn(shellWords, "quoteShellWord").mockImplementation(() => {
      throw new TypeError("quoting failed");
    });
    try {
      expect(() => at(provider, "aws s3api head-bucket --bucket ")).toThrow(new TypeError("quoting failed"));
    } finally {
      spy.mockRestore();
    }
  });

  test("a suggestion replaces the word typed so far, and after aws the whole lead", () => {
    const { provider } = register([]);
    const [first] = at(provider, "aws s3api head-object --bu");
    expect(first.range).toEqual({ startLineNumber: 1, startColumn: 23, endLineNumber: 1, endColumn: 27 });
    const [command] = at(provider, "aws s");
    expect(command.range).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 });
    expect(command.kind).toBe(17);
  });

  test("offers nothing where the context is unknown, or across a line break", () => {
    const { provider } = register(["sales"]);
    expect(at(provider, "aws ec2 ")).toEqual([]);
    expect(at(provider, "aws \\\ns3")).toEqual([]);
    expect(at(provider, "aws\n")).toEqual([]);
  });
});
