/**
 * What the S3 generators write for a bucket or an object, given the provider's own path, the value rule every generated value
 * follows, and the read-on command the read-on notice names for `ls`. Every command line written, and
 * every generated comment line with its `# ` removed, is one the console's parser accepts, except the two notes for a
 * key no command line can spell.
 */
import { describe, expect, test } from "bun:test";
import { parseS3Command } from "@/lib/db/providers/objectstore/s3/console/commands";
import {
  s3FlagValue,
  s3ReadOnCommand,
  s3SelectQuery,
  s3TableQuery,
} from "@/lib/db/providers/objectstore/s3/console/generators";
import { encodeS3StartingToken } from "@/lib/db/providers/objectstore/s3/console/token";

const CR_NOTE = "# This key holds a carriage return, which a command line cannot spell: open it from the Keys panel.";
const NUL_NOTE = "# This key holds a NUL character, which a command line cannot pass: open it from the Keys panel.";

function expectParses(text: string): void {
  const parsed = parseS3Command(text, {});
  expect(parsed.ok ? "ok" : parsed.refusal.message, text).toBe("ok");
}

/** The whole text parses, and so does each generated comment line once its `# ` is removed. */
function expectEveryLineParses(text: string): void {
  if (text === CR_NOTE || text === NUL_NOTE) return;
  expectParses(text);
  for (const line of text.split("\n").filter((candidate) => candidate.startsWith("# "))) expectParses(line.slice(2));
}

describe("the tree click (run)", () => {
  test("a bucket lists its top level, and an object previews", () => {
    expect(s3TableQuery(["sales"])).toBe("aws s3 ls s3://sales/");
    expect(s3TableQuery(["sales/2026/orders.csv"])).toBe("preview s3://sales/2026/orders.csv");
  });

  test("the path is the provider's own: [bucket] for a bucket, [<bucket>/<key>] for an object", () => {
    expect(s3TableQuery(["sales/2026/a.csv"])).toBe("preview s3://sales/2026/a.csv");
    expect(s3SelectQuery(["sales/2026/a.csv"])).toBe(
      ["preview s3://sales/2026/a.csv", "# aws s3api head-object --bucket sales --key 2026/a.csv"].join("\n"),
    );
    expect(s3TableQuery(["sales/"])).toBe("aws s3 ls s3://sales/");
  });

  test("a path of any other length is refused", () => {
    expect(() => s3TableQuery(["sales", "2026/a.csv"])).toThrow(
      'An S3 bucket or object path is [name], received ["sales","2026/a.csv"]',
    );
    expect(() => s3SelectQuery([])).toThrow("An S3 bucket or object path is [name], received []");
  });

  test("a key with a space or a quote is quoted, and a key that begins with - stays in the path", () => {
    expect(s3TableQuery(["sales/a b.csv"])).toBe("preview 's3://sales/a b.csv'");
    expect(s3TableQuery(["sales/it's.csv"])).toBe("preview 's3://sales/it'\\''s.csv'");
    expect(s3TableQuery(["sales/-x"])).toBe("preview s3://sales/-x");
  });

  test("a key holding a carriage return or a NUL gets its note", () => {
    expect(s3TableQuery(["sales/a\rb"])).toBe(CR_NOTE);
    expect(s3TableQuery(["sales/a\u0000b"])).toBe(NUL_NOTE);
  });
});

describe("Generate Command (written, not run)", () => {
  test("a bucket: the listing, then two reads as comments", () => {
    expect(s3SelectQuery(["sales"])).toBe(
      [
        "aws s3 ls s3://sales/",
        "# aws s3api list-objects-v2 --bucket sales --delimiter / --max-items 50",
        "# aws s3api get-bucket-versioning --bucket sales",
      ].join("\n"),
    );
  });

  test("an object: the preview, then its head-object as a comment", () => {
    expect(s3SelectQuery(["sales/a b.csv"])).toBe(
      ["preview 's3://sales/a b.csv'", "# aws s3api head-object --bucket sales --key 'a b.csv'"].join("\n"),
    );
    expect(s3SelectQuery(["sales/-x"])).toBe(
      ["preview s3://sales/-x", "# aws s3api head-object --bucket sales --key=-x"].join("\n"),
    );
  });

  test("a key that is exactly ^ is quoted, so the caret scan does not refuse the line", () => {
    expect(s3SelectQuery(["sales/^"])).toBe(
      ["preview s3://sales/^", "# aws s3api head-object --bucket sales --key '^'"].join("\n"),
    );
    expectEveryLineParses(s3SelectQuery(["sales/^"]));
  });

  test("a key that begins with file:// or fileb:// writes the preview alone", () => {
    expect(s3SelectQuery(["sales/file://x"])).toBe("preview s3://sales/file://x");
    expect(s3SelectQuery(["sales/FILEB://y"])).toBe("preview s3://sales/FILEB://y");
    expectEveryLineParses(s3SelectQuery(["sales/file://x"]));
  });

  test("a key holding a line feed writes the preview alone, and CR and NUL keys get their notes", () => {
    expect(s3SelectQuery(["sales/a\nb"])).toBe("preview 's3://sales/a\nb'");
    expect(s3SelectQuery(["sales/a\rb"])).toBe(CR_NOTE);
    expect(s3SelectQuery(["sales/a\u0000b"])).toBe(NUL_NOTE);
  });

  test("every line written parses, over keys of every kind", () => {
    const keys = [
      "a.csv",
      "2026/q1/",
      "a b",
      "it's",
      "-x",
      "-x y",
      "^",
      "#hash",
      "a\nb",
      "file://x",
      "\u00e9\ud83d\ude00",
      "a\tb",
    ];
    for (const key of keys) {
      expectEveryLineParses(s3TableQuery([`sales/${key}`]));
      expectEveryLineParses(s3SelectQuery([`sales/${key}`]));
    }
    for (const bucket of ["sales", "a.b-c_d"]) {
      expectEveryLineParses(s3TableQuery([bucket]));
      expectEveryLineParses(s3SelectQuery([bucket]));
    }
  });
});

describe("the value rule", () => {
  test("a value that begins with - is written after =, any other after a space", () => {
    expect(s3FlagValue("--key", "-x")).toBe("--key=-x");
    expect(s3FlagValue("--prefix", "-x y")).toBe("--prefix='-x y'");
    expect(s3FlagValue("--prefix", "2026/")).toBe("--prefix 2026/");
    expect(s3FlagValue("--prefix", "a b")).toBe("--prefix 'a b'");
    expect(s3FlagValue("--prefix", "^")).toBe("--prefix '^'");
  });
});

describe("the read-on command the read-on notice names for ls", () => {
  const token = encodeS3StartingToken("t1");

  test("names list-objects-v2 with the bucket, the prefix when not empty, the delimiter unless recursive, and the token", () => {
    expect(s3ReadOnCommand({ bucket: "sales", prefix: "2026/", delimiter: true, startingToken: token })).toBe(
      `aws s3api list-objects-v2 --bucket sales --prefix 2026/ --delimiter / --starting-token ${token}`,
    );
    expect(s3ReadOnCommand({ bucket: "sales", prefix: "", delimiter: false, startingToken: token })).toBe(
      `aws s3api list-objects-v2 --bucket sales --starting-token ${token}`,
    );
  });

  test("every value follows the value rule, and every command parses", () => {
    for (const prefix of ["", "2026/", "-x", "-x y", "a b", "^", "it's/"]) {
      for (const delimiter of [true, false]) {
        const text = s3ReadOnCommand({ bucket: "sales", prefix, delimiter, startingToken: token });
        expectParses(text);
      }
    }
    expect(s3ReadOnCommand({ bucket: "sales", prefix: "-x", delimiter: true, startingToken: token })).toContain(
      "--prefix=-x",
    );
  });
});
