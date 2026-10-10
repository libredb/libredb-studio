/**
 * The S3 editor text as words and as the editor draws it: the Windows caret scan, the
 * prompt and the optional aws, the environment-assignment refusal, the option-word rule, where the service and the
 * operation stand, and the role of each token.
 */
import { describe, expect, test } from "bun:test";
import { readShellCommand, type ShellLineState, type ShellWord } from "@/lib/db/console/shell-words";
import {
  caretContinuationAt,
  INITIAL_S3_LEX_STATE,
  isOptionWord,
  S3_ASSIGNMENT_SENTENCE,
  S3_CARET_SENTENCE,
  S3_PROMPTS,
  S3_VALUE_GLOBAL_OPTIONS,
  s3CommandShape,
  s3Words,
  tokenizeS3Line,
} from "@/lib/db/providers/objectstore/s3/console/lexer";

function split(text: string): { readonly lead: string[]; readonly words: string[] } {
  const read = s3Words(text);
  if (!read.ok) throw new Error(`expected ${JSON.stringify(text)} to read, got: ${read.refusal.message}`);
  return { lead: read.lead.map((word) => word.text), words: read.words.map((word) => word.text) };
}

function refusalOf(text: string): { readonly code: string; readonly message: string } {
  const read = s3Words(text);
  if (read.ok) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  return { code: read.refusal.code, message: read.refusal.message };
}

/** Each token of one line as `role:text`, whitespace left out. */
function roles(line: string, state: ShellLineState = INITIAL_S3_LEX_STATE): string[] {
  return tokenizeS3Line(line, state)
    .tokens.filter((token) => token.role !== "whitespace")
    .map((token) => `${token.role}:${line.slice(token.start, token.end)}`);
}

/** The one word of a text, as the shared reader reads it. */
function wordOf(text: string): ShellWord {
  const read = readShellCommand(text);
  if (!read.ok || read.words.length !== 1) throw new Error(`expected one word in ${JSON.stringify(text)}`);
  return read.words[0];
}

/** The service and operation words a text names, by the lexer's positions. */
function shapeOf(text: string): { readonly service?: string; readonly operation?: string } {
  const read = s3Words(text);
  if (!read.ok) throw new Error(read.refusal.message);
  const shape = s3CommandShape(read.words, text);
  return {
    ...(shape.serviceAt === undefined ? {} : { service: read.words[shape.serviceAt].text }),
    ...(shape.operationAt === undefined ? {} : { operation: read.words[shape.operationAt].text }),
  };
}

describe("the sets the lexer and the parser share", () => {
  test("the prompts are $ and %, and the value-taking globals are the AWS CLI's eleven", () => {
    expect([...S3_PROMPTS]).toEqual(["$", "%"]);
    expect([...S3_VALUE_GLOBAL_OPTIONS].sort()).toEqual([
      "--ca-bundle",
      "--cli-binary-format",
      "--cli-connect-timeout",
      "--cli-error-format",
      "--cli-read-timeout",
      "--color",
      "--endpoint-url",
      "--output",
      "--profile",
      "--query",
      "--region",
    ]);
  });
});

describe("s3Words: the lead a pasted command line carries", () => {
  test.each([
    ["aws s3 ls", ["aws"], ["s3", "ls"]],
    ["s3 ls", [], ["s3", "ls"]],
    ["$ aws s3api list-buckets", ["$", "aws"], ["s3api", "list-buckets"]],
    ["% aws s3 ls", ["%", "aws"], ["s3", "ls"]],
    ["preview s3://sales/a.csv", [], ["preview", "s3://sales/a.csv"]],
  ] as const)("%s", (text, lead, words) => {
    expect(split(text)).toEqual({ lead: [...lead], words: [...words] });
  });

  test("a quoted aws or a quoted prompt is not a lead word", () => {
    expect(split("'aws' s3 ls")).toEqual({ lead: [], words: ["aws", "s3", "ls"] });
    expect(split("'$' aws s3 ls")).toEqual({ lead: [], words: ["$", "aws", "s3", "ls"] });
  });

  test("a backslash at the end of a line joins it to the next", () => {
    expect(split("aws s3api head-object --bucket b \\\n--key k")).toEqual({
      lead: ["aws"],
      words: ["s3api", "head-object", "--bucket", "b", "--key", "k"],
    });
  });

  test("a second command line is refused with the shared reader's sentence", () => {
    expect(refusalOf("aws s3 ls\naws s3 ls")).toEqual({
      code: "second-command",
      message:
        "Line 2 holds a second command: Studio runs one command per run. Select the line to run it, and the editor sends the selection.",
    });
  });
});

describe("the Windows caret, scanned before the shared reader", () => {
  test("a ^ word is refused with its sentence", () => {
    expect(refusalOf("aws s3 ls ^")).toEqual({ code: "caret", message: S3_CARET_SENTENCE });
    expect(S3_CARET_SENTENCE).toBe(
      "A ^ continues a line only in Windows cmd, which Studio does not read: join the lines, or end each one with a backslash.",
    );
  });

  test("on a two-line Windows paste the caret sentence is reported, not the second-command one", () => {
    expect(refusalOf("aws s3api head-object --bucket b ^\n--key k")).toEqual({
      code: "caret",
      message: S3_CARET_SENTENCE,
    });
    expect(caretContinuationAt("aws s3api head-object --bucket b ^\r\n--key k")).toEqual({ line: 1, column: 33 });
  });

  test("a quoted ^, a ^ inside a word and a ^ in a comment pass the scan", () => {
    expect(caretContinuationAt("aws s3api head-object --bucket b --key '^'")).toBeUndefined();
    expect(caretContinuationAt('aws s3api head-object --bucket b --key "^"')).toBeUndefined();
    expect(caretContinuationAt("aws s3api head-object --bucket b --key a^b")).toBeUndefined();
    expect(caretContinuationAt("aws s3 ls # ^")).toBeUndefined();
    expect(caretContinuationAt("aws s3 ls \\^")).toBeUndefined();
    expect(caretContinuationAt('aws s3 ls "a\\"^"')).toBeUndefined();
  });

  test("a ^ that starts a line after a backslash-newline, or a later line, is found with its place", () => {
    expect(caretContinuationAt("aws s3 ls \\\n^")).toEqual({ line: 2, column: 0 });
    expect(caretContinuationAt("# note\n\taws s3 ls ^\t")).toEqual({ line: 2, column: 11 });
  });
});

describe("the environment assignment, refused before anything else is read", () => {
  test("a leading assignment is refused and the sentence quotes nothing of it", () => {
    const refused = refusalOf("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI aws s3 ls");
    expect(refused).toEqual({ code: "assignment", message: S3_ASSIGNMENT_SENTENCE });
    expect(refused.message).not.toContain("wJalrXUtnFEMI");
    expect(refused.message).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(S3_ASSIGNMENT_SENTENCE).toBe(
      "The command begins with an environment assignment, which Studio does not read: the Access key and Secret on the connection sign every request. Remove the assignment.",
    );
  });

  test("after a prompt, a run of assignments is refused too", () => {
    expect(refusalOf("$ A=1 B=2 aws s3 ls")).toEqual({ code: "assignment", message: S3_ASSIGNMENT_SENTENCE });
  });

  test("an assignment whose value is quoted is refused, and its value is never quoted back", () => {
    const refused = refusalOf('AWS_SECRET_ACCESS_KEY="wJal rXUt" aws s3 ls');
    expect(refused).toEqual({ code: "assignment", message: S3_ASSIGNMENT_SENTENCE });
    expect(refused.message).not.toContain("wJal");
    expect(refusalOf("A='x y' aws s3 ls").code).toBe("assignment");
  });

  test("a word whose name or = is quoted is not an assignment", () => {
    expect(split("'A=1' aws s3 ls")).toEqual({ lead: [], words: ["A=1", "aws", "s3", "ls"] });
    expect(split("A'=1' aws s3 ls").words[0]).toBe("A=1");
  });
});

describe("isOptionWord: the leading -, the name and the = are unquoted", () => {
  test.each([
    ["--prefix=-x", "--prefix=-x"],
    ["--prefix='-x y'", "--prefix=-x y"],
    ['--key="a b"', "--key=a b"],
    ["--recursive", "--recursive"],
    ["-h", "-h"],
  ])("%s is an option word", (source, text) => {
    const word = wordOf(source);
    expect(word.text).toBe(text);
    expect(isOptionWord(word, source)).toBe(true);
  });

  test.each([["'--prefix'"], ['"-x"'], ["\\--key"], ["-"], ["s3://a"]])("%s is not an option word", (source) => {
    expect(isOptionWord(wordOf(source), source)).toBe(false);
  });

  test("the rule reads the word at its own line and column", () => {
    const text = "aws s3 ls \\\n  --recursive";
    const read = readShellCommand(text);
    if (!read.ok) throw new Error(read.refusal.message);
    expect(isOptionWord(read.words[3], text)).toBe(true);
  });
});

describe("s3CommandShape: where the service and the operation stand", () => {
  test.each([
    ["aws s3 ls", { service: "s3", operation: "ls" }],
    ["aws --region eu-west-1 s3api head-bucket --bucket b", { service: "s3api", operation: "head-bucket" }],
    ["aws --region=eu-west-1 s3api head-bucket", { service: "s3api", operation: "head-bucket" }],
    ["aws s3api --output json list-buckets", { service: "s3api", operation: "list-buckets" }],
    ["aws --no-cli-pager s3 ls", { service: "s3", operation: "ls" }],
    ["preview s3://b/k", { service: "preview" }],
    ["aws ec2 describe-instances", { service: "ec2" }],
    ["aws s3api", { service: "s3api" }],
    ["aws --region r", {}],
  ] as const)("%s", (text, expected) => {
    expect(shapeOf(text)).toEqual(expected);
  });

  test("an operation at word index 8 or later is still found, for the parser", () => {
    expect(
      shapeOf("aws --endpoint-url http://h:9000 --region r --output json s3api head-object --bucket b --key k"),
    ).toEqual({ service: "s3api", operation: "head-object" });
  });

  test("parity: the words after the lead are the shared reader's words minus the lead", () => {
    for (const text of [
      "aws s3 ls s3://sales/2026/ --recursive",
      "$ aws s3api head-object --bucket sales --key 2026/orders.csv",
      "preview s3://sales/part-0.parquet --max-rows 20",
      "s3api list-objects-v2 --bucket b --prefix='-x y'",
    ]) {
      const read = s3Words(text);
      const shared = readShellCommand(text);
      if (!read.ok || !shared.ok) throw new Error(text);
      expect([...read.lead, ...read.words]).toEqual([...shared.words]);
    }
  });
});

describe("tokenizeS3Line: the roles the editor draws", () => {
  test.each([
    [
      "$ aws s3api head-object --bucket b --key 'a b' # one object",
      [
        "lead:$",
        "lead:aws",
        "service:s3api",
        "operation:head-object",
        "flag:--bucket",
        "word:b",
        "flag:--key",
        "string:'a b'",
        "comment:# one object",
      ],
    ],
    [
      "aws s3 ls s3://sales/2026/ --recursive",
      ["lead:aws", "service:s3", "operation:ls", "path:s3://sales/2026/", "flag:--recursive"],
    ],
    ["aws --region r s3 ls", ["lead:aws", "flag:--region", "word:r", "service:s3", "operation:ls"]],
    ["preview s3://b/k --max-rows 20", ["service:preview", "path:s3://b/k", "flag:--max-rows", "word:20"]],
    ["aws ec2 describe-instances", ["lead:aws", "service:ec2", "word:describe-instances"]],
    ["'aws' s3 ls", ["string:'aws'", "word:s3", "word:ls"]],
  ] as const)("%s", (line, expected) => {
    expect(roles(line)).toEqual([...expected]);
  });

  test("a service or operation word at word index 8 or later is drawn as a plain word", () => {
    const line = "aws --endpoint-url http://h:9000 --region r --output json --no-cli-pager s3api head-object";
    const drawn = roles(line);
    expect(drawn).toContain("word:s3api");
    expect(drawn).toContain("word:head-object");
  });

  test("the lead and the operation are drawn only on the line the command begins on", () => {
    const first = tokenizeS3Line("aws s3api head-object \\", INITIAL_S3_LEX_STATE);
    expect(roles("aws s3api head-object \\")).toContain("operation:head-object");
    expect(roles("--bucket b s3://x", first.state)).toEqual(["flag:--bucket", "word:b", "path:s3://x"]);
  });

  test("a line that continues an open quote keeps the reader's state", () => {
    const open = tokenizeS3Line("aws s3api head-object --key 'a", INITIAL_S3_LEX_STATE);
    expect(open.state.quote).toBe("single");
    expect(roles("b'", open.state)).toEqual(["string:b'"]);
  });

  test("a word left open before the service decides nothing on its line", () => {
    expect(roles("aws 's3")).toEqual(["lead:aws", "string:'s3"]);
  });

  test.each([
    ["aws - s3 ls", []],
    ["aws -x'y' s3 ls", []],
    ["aws s3 - ls", ["service:s3"]],
    ["aws --region'' r s3 ls", ["service:s3", "operation:ls"]],
    ["aws --prefix='-x y' s3 ls", ["service:s3", "operation:ls"]],
  ] as const)("parity: %s draws the service and operation the parser reads", (line, expected) => {
    const drawn = roles(line).filter((role) => role.startsWith("service:") || role.startsWith("operation:"));
    expect(drawn).toEqual([...expected]);
    const shape = shapeOf(line);
    for (const role of drawn) {
      const [name, text] = role.split(":") as ["service" | "operation", string];
      expect(shape[name]).toBe(text);
    }
  });
});
