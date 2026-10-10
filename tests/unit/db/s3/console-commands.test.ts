/**
 * The S3 command table and its parser: one accepted case per command
 * and per flag with its defaults, every refusal sentence verbatim, the AWS CLI's argument behaviours row by row, the
 * refusal order, the address rules, the connection's context, and the rule that no refusal quotes a typed value.
 */
import { describe, expect, test } from "bun:test";
import {
  type ParsedS3Command,
  parseS3Command,
  S3_ACCEPTED_GLOBAL_OPTIONS,
  S3_COMMAND_TABLE,
  type S3ConsoleCommand,
  S3_GLOBAL_OPTION_VALUES,
  type S3ParseContext,
} from "@/lib/db/providers/objectstore/s3/console/commands";

const SERVER: S3ParseContext = { endpoint: "http://localhost:9000", region: "us-east-1", readOnly: false };
const PINNED: S3ParseContext = { ...SERVER, pinnedBucket: "sales" };

function parsed(text: string, context: S3ParseContext = {}): ParsedS3Command {
  const result = parseS3Command(text, context);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(text)} to parse, got: ${result.refusal.message}`);
  return result.parsed;
}

const command = (text: string, context: S3ParseContext = {}): S3ConsoleCommand => parsed(text, context).command;

function refused(text: string, context: S3ParseContext = {}): string {
  const result = parseS3Command(text, context);
  if (result.ok) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  return result.refusal.message;
}

const codeOf = (text: string, context: S3ParseContext = {}): string => {
  const result = parseS3Command(text, context);
  if (result.ok) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  return result.refusal.code;
};

const EMPTY =
  "The editor holds no command: write one S3 read, such as aws s3 ls s3://bucket/ or aws s3api head-object --bucket bucket --key key.";
const HELP = "Studio prints no help: the provider doc lists every command and flag Studio runs.";
const W_OFF = (verb: string) =>
  `${verb} writes, and Studio's S3 support reads only in this version: run it with the AWS CLI or your server's own tools.`;
const W_ON = (verb: string) =>
  `${verb} writes, and this connection is read-only. Studio's S3 support also reads only in this version, so turning the mode off would not run it: run it with the AWS CLI or your server's own tools.`;
const S3API_READS =
  "list-buckets, list-objects-v2, list-object-versions, head-bucket, head-object, get-object-tagging, get-bucket-location and get-bucket-versioning";
const PIN =
  "The command names a bucket other than this connection's sales: the Bucket field on the connection decides which bucket Studio reads.";
const BUCKET_ADDRESS = (subject: string) =>
  `${subject} is not a bucket name Studio addresses: a bucket name is 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit.`;
const KEY_ADDRESS = (subject: string) =>
  `${subject} begins with /, and a measured S3 server read a different key for such a name, so Studio does not open it.`;
const DOT_SEGMENTS = (subject: string) =>
  `${subject} names no object inside its bucket once its . and .. segments are resolved, and a server or proxy that resolves them would read something else, so Studio does not open it.`;
const TOO_LONG = (subject: string) => `${subject} is longer than 1,024 bytes, the longest key S3 allows: shorten it.`;
const TOKEN =
  "--starting-token is not a token Studio or the AWS CLI wrote for list-objects-v2: run the command again without it, and use the token the result's notice gives.";
const MAX_ITEMS = "--max-items takes a whole number from 1 to 500, the most rows a Studio result holds.";
const LOCAL_FILE_VALUE = (flag: string) =>
  `${flag} takes no value that begins with file:// or fileb://: the AWS CLI reads such a value from a local file, which Studio never does.`;
const LOCAL_FILE_PATH =
  "The path begins with file:// or fileb://, which the AWS CLI reads as a local file and Studio never does: write s3://bucket/prefix.";
const ABC_TOKEN = "eyJDb250aW51YXRpb25Ub2tlbiI6ICJhYmMifQ==";

describe("the command table", () => {
  test("holds the nine reads and preview, with their arguments and flags, in order", () => {
    expect(
      S3_COMMAND_TABLE.map((entry) => [
        entry.service,
        entry.operation,
        entry.arguments,
        entry.flags.map((flag) => flag.name),
      ]),
    ).toEqual([
      ["s3", "ls", "[PATH]", ["--recursive", "--page-size", "--human-readable", "--summarize", "--bucket-name-prefix"]],
      ["s3api", "list-buckets", "", ["--prefix", "--max-items"]],
      [
        "s3api",
        "list-objects-v2",
        "",
        ["--bucket", "--prefix", "--delimiter", "--encoding-type", "--max-items", "--starting-token", "--page-size"],
      ],
      ["s3api", "list-object-versions", "", ["--bucket", "--prefix", "--delimiter", "--encoding-type", "--max-items"]],
      ["s3api", "head-bucket", "", ["--bucket"]],
      ["s3api", "head-object", "", ["--bucket", "--key"]],
      ["s3api", "get-object-tagging", "", ["--bucket", "--key"]],
      ["s3api", "get-bucket-location", "", ["--bucket"]],
      ["s3api", "get-bucket-versioning", "", ["--bucket"]],
      ["studio", "preview", "PATH", ["--format", "--columns", "--max-rows", "--schema"]],
    ]);
  });

  test("declares each flag's value set, bounds and requirement", () => {
    const flagsOf = (operation: string) => S3_COMMAND_TABLE.find((entry) => entry.operation === operation)?.flags;
    expect(flagsOf("list-objects-v2")).toEqual([
      { name: "--bucket", takes: "value", required: true },
      { name: "--prefix", takes: "value" },
      { name: "--delimiter", takes: "value", values: ["/"] },
      { name: "--encoding-type", takes: "value", values: ["url"] },
      { name: "--max-items", takes: "value", integer: { min: 1, max: 500 } },
      { name: "--starting-token", takes: "value" },
      { name: "--page-size", takes: "value", integer: { min: 1, max: 1_000 } },
    ]);
    expect(flagsOf("preview")).toEqual([
      { name: "--format", takes: "value", values: ["text", "json", "ndjson", "csv", "tsv", "parquet", "hex"] },
      { name: "--columns", takes: "value" },
      { name: "--max-rows", takes: "value", integer: { min: 1, max: 500 } },
      { name: "--schema", takes: "boolean" },
    ]);
    expect(Object.isFrozen(S3_COMMAND_TABLE)).toBe(true);
  });

  test("names the accepted global options and the no-ops' value sets", () => {
    expect(S3_ACCEPTED_GLOBAL_OPTIONS).toEqual([
      "--endpoint-url",
      "--region",
      "--output",
      "--color",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ]);
    expect(S3_GLOBAL_OPTION_VALUES).toEqual({
      "--output": ["json", "text", "table", "yaml", "yaml-stream", "off"],
      "--color": ["on", "off", "auto"],
    });
  });
});

describe("one accepted case per command and per flag, defaults applied", () => {
  test.each([
    [
      "aws s3 ls",
      {
        kind: "ls",
        bucket: "",
        prefix: "",
        recursive: false,
        pageSize: 1_000,
        humanReadable: false,
        summarize: false,
        maxItems: 500,
      },
    ],
    [
      "aws s3 ls --bucket-name-prefix sal",
      {
        kind: "ls",
        bucket: "",
        prefix: "",
        recursive: false,
        pageSize: 1_000,
        humanReadable: false,
        summarize: false,
        bucketNamePrefix: "sal",
        maxItems: 500,
      },
    ],
    [
      "aws s3 ls s3://sales/2026/ --recursive --human-readable --summarize --page-size 200",
      {
        kind: "ls",
        bucket: "sales",
        prefix: "2026/",
        recursive: true,
        pageSize: 200,
        humanReadable: true,
        summarize: true,
        maxItems: 500,
      },
    ],
    [
      "s3 ls sales/2026",
      {
        kind: "ls",
        bucket: "sales",
        prefix: "2026",
        recursive: false,
        pageSize: 1_000,
        humanReadable: false,
        summarize: false,
        maxItems: 500,
      },
    ],
    ["aws s3api list-buckets", { kind: "list-buckets", maxItems: 500 }],
    ["aws s3api list-buckets --prefix s --max-items 3", { kind: "list-buckets", prefix: "s", maxItems: 3 }],
    [
      "aws s3api list-objects-v2 --bucket sales",
      {
        kind: "list-objects-v2",
        bucket: "sales",
        prefix: "",
        delimiter: false,
        maxItems: 500,
        maxItemsGiven: false,
        pageSize: 1_000,
      },
    ],
    [
      `aws s3api list-objects-v2 --bucket sales --prefix 2026/ --delimiter / --encoding-type url --max-items 50 --starting-token ${ABC_TOKEN} --page-size 10`,
      {
        kind: "list-objects-v2",
        bucket: "sales",
        prefix: "2026/",
        delimiter: true,
        maxItems: 50,
        maxItemsGiven: true,
        pageSize: 10,
        resume: { continuationToken: "abc" },
      },
    ],
    [
      "aws s3api list-object-versions --bucket sales",
      { kind: "list-object-versions", bucket: "sales", prefix: "", delimiter: false, maxItems: 500 },
    ],
    [
      "aws s3api list-object-versions --bucket sales --prefix 2026/ --delimiter / --encoding-type url --max-items 7",
      { kind: "list-object-versions", bucket: "sales", prefix: "2026/", delimiter: true, maxItems: 7 },
    ],
    ["aws s3api head-bucket --bucket sales", { kind: "head-bucket", bucket: "sales" }],
    [
      "aws s3api head-object --bucket sales --key 2026/orders.csv",
      { kind: "head-object", bucket: "sales", key: "2026/orders.csv" },
    ],
    [
      "aws s3api get-object-tagging --bucket sales --key a.csv",
      { kind: "get-object-tagging", bucket: "sales", key: "a.csv" },
    ],
    ["aws s3api get-bucket-location --bucket sales", { kind: "get-bucket-location", bucket: "sales" }],
    ["aws s3api get-bucket-versioning --bucket sales", { kind: "get-bucket-versioning", bucket: "sales" }],
    ["preview s3://sales/a.csv", { kind: "preview", bucket: "sales", key: "a.csv", request: { maxRows: 100 } }],
    [
      "preview s3://sales/part-0.parquet --format parquet --columns ' a , b' --max-rows 500 --schema",
      {
        kind: "preview",
        bucket: "sales",
        key: "part-0.parquet",
        request: { format: "parquet", columns: ["a", "b"], maxRows: 500, schemaOnly: true },
      },
    ],
    ["preview s3://sales/2026/", { kind: "preview", bucket: "sales", key: "2026/", request: { maxRows: 100 } }],
  ] as const)("%s", (text, expected) => {
    expect(command(text)).toEqual(expected);
  });

  test("a flag reads as --flag value and as --flag=value, quoted after the =", () => {
    expect(command("aws s3api head-object --bucket=sales --key='a b'")).toEqual({
      kind: "head-object",
      bucket: "sales",
      key: "a b",
    });
  });

  test("a value that begins with - is passed with =, quoted or not", () => {
    expect(command("aws s3api list-objects-v2 --bucket b --prefix=-x")).toMatchObject({ prefix: "-x" });
    expect(command("aws s3api list-objects-v2 --bucket b --prefix='-x y'")).toMatchObject({ prefix: "-x y" });
  });

  test("global options stand anywhere after the lead", () => {
    expect(parsed("aws --output json s3api head-bucket --no-cli-pager --bucket sales --color off").noOps).toEqual([
      "--output",
      "--no-cli-pager",
      "--color",
    ]);
    expect(parsed("aws s3 ls --no-cli-auto-prompt").noOps).toEqual(["--no-cli-auto-prompt"]);
  });

  test("the parse names the operation word's line", () => {
    expect(parsed("# list\naws s3api head-object \\\n  --bucket b --key k").line).toBe(2);
  });
});

describe("the AWS CLI's argument behaviours, row by row", () => {
  const base = "aws s3api list-objects-v2 --bucket b";

  test("a flag given twice is refused", () => {
    expect(refused(`${base} --bucket c`)).toBe("--bucket is given twice: give it once.");
    expect(refused("aws s3 ls --region a --region a")).toBe("--region is given twice: give it once.");
  });

  test("an abbreviation is refused, and --pr never becomes --profile", () => {
    expect(refused("aws s3api list-objects-v2 --buck b")).toBe(
      "--buck is an abbreviation, which Studio does not expand: write --bucket.",
    );
    expect(refused(`${base} --pr x`)).toBe("--pr is an abbreviation, which Studio does not expand: write --prefix.");
    expect(refused(`${base} --max 5`)).toBe(
      "--max is an abbreviation, which Studio does not expand: write --max-items.",
    );
    expect(refused("aws s3 ls --endpoint http://h")).toBe(
      "--endpoint is an abbreviation, which Studio does not expand: write --endpoint-url.",
    );
  });

  test("a boolean with a value is refused", () => {
    expect(refused("aws s3 ls s3://b/ --recursive true")).toBe("--recursive takes no value: write --recursive alone.");
    expect(refused("aws s3 ls s3://b/ --recursive=true")).toBe("--recursive takes no value: write --recursive alone.");
    expect(refused("aws s3 ls --no-cli-pager=1")).toBe("--no-cli-pager takes no value: write --no-cli-pager alone.");
  });

  test("a separate value word that begins with -, quoted or not, is refused", () => {
    const sentence =
      "--prefix takes a value, and the word after it begins with -, which the AWS CLI reads as an option: write --prefix= followed by the value to pass a value that begins with -.";
    expect(refused(`${base} --prefix -x`)).toBe(sentence);
    expect(refused(`${base} --prefix '-x'`)).toBe(sentence);
  });

  test("a value flag written last is refused", () => {
    expect(refused(`${base} --prefix`)).toBe("--prefix takes a value: write it after --prefix.");
    expect(refused("aws --region")).toBe(EMPTY);
    expect(refused("aws s3api --bucket head-object")).toBe("--bucket takes a value: write it after --bucket.");
  });

  test("a file:// or fileb:// value or path is refused, in any case", () => {
    expect(refused(`${base} --prefix file://x`)).toBe(LOCAL_FILE_VALUE("--prefix"));
    expect(refused(`${base} --prefix=FILEB://x`)).toBe(LOCAL_FILE_VALUE("--prefix"));
    expect(refused("aws s3 ls --region file://r")).toBe(LOCAL_FILE_VALUE("--region"));
    expect(refused("aws s3 ls FILEB://x")).toBe(LOCAL_FILE_PATH);
    expect(refused("preview file://x/y")).toBe(LOCAL_FILE_PATH);
  });

  test("an unknown flag names what the operation takes", () => {
    expect(refused(`${base} --frob`)).toBe(
      "list-objects-v2 takes no option --frob: it takes --bucket, --prefix, --delimiter, --encoding-type, --max-items, --starting-token and --page-size.",
    );
    expect(refused("aws s3 ls --max-items 5")).toBe(
      "ls takes no option --max-items: it takes --recursive, --page-size, --human-readable, --summarize and --bucket-name-prefix.",
    );
    expect(refused("aws s3 ls -r")).toBe(
      "ls takes no option -r: it takes --recursive, --page-size, --human-readable, --summarize and --bucket-name-prefix.",
    );
  });

  test("a positional word on an s3api operation is refused with its place", () => {
    expect(refused("aws s3api head-object extra")).toBe(
      "head-object takes every value after its option, and the word at line 1, column 23 stands alone: write it after the option it belongs to.",
    );
  });

  test("help, --help and -h are refused", () => {
    for (const text of [
      "aws help",
      "aws s3 help",
      "aws s3api help",
      "aws s3api head-object help",
      "aws s3 ls --help",
      "aws s3 ls -h",
    ]) {
      expect(refused(text)).toBe(HELP);
    }
  });

  test("-- is refused", () => {
    expect(refused("aws s3 ls -- s3://b/")).toBe(
      "-- is not read here: write each value after its option, with = when it begins with -.",
    );
  });
});

describe("value shapes and their bounds", () => {
  test.each([
    ["aws s3api list-objects-v2 --bucket b --max-items 0", MAX_ITEMS],
    ["aws s3api list-objects-v2 --bucket b --max-items 01", MAX_ITEMS],
    ["aws s3api list-objects-v2 --bucket b --max-items +5", MAX_ITEMS],
    ["aws s3api list-objects-v2 --bucket b --max-items 501", MAX_ITEMS],
    ["aws s3api list-buckets --max-items 501", MAX_ITEMS],
    [
      "aws s3api list-objects-v2 --bucket b --page-size 1001",
      "--page-size takes a whole number from 1 to 1,000, the most keys S3 answers in one page.",
    ],
    [
      "aws s3 ls s3://b/ --page-size 0",
      "--page-size takes a whole number from 1 to 1,000, the most keys S3 answers in one page.",
    ],
    [
      "preview s3://b/k --max-rows 501",
      "--max-rows takes a whole number from 1 to 500, the most rows a Studio result holds.",
    ],
    [
      "aws s3api list-objects-v2 --bucket b --delimiter x",
      "--delimiter takes /, the one folder separator Studio reads.",
    ],
    [
      "aws s3api list-object-versions --bucket b --delimiter x",
      "--delimiter takes /, the one folder separator Studio reads.",
    ],
    [
      "aws s3api list-objects-v2 --bucket b --encoding-type base64",
      "--encoding-type takes url, which Studio always sends.",
    ],
    ["preview s3://b/k --format auto", "--format takes one of text, json, ndjson, csv, tsv, parquet, hex."],
    ["preview s3://b/k --columns a,,b", "--columns takes a comma-separated list of column names."],
    ["preview s3://b/k --columns ' '", "--columns takes a comma-separated list of column names."],
    ["aws s3 ls --output xml", "--output takes json, text, table, yaml, yaml-stream or off."],
    ["aws s3 ls --color maybe", "--color takes on, off or auto."],
    [
      "aws s3 ls --endpoint-url localhost:9000",
      "--endpoint-url takes a URL with http:// or https://, such as http://localhost:9000.",
    ],
    [
      "aws s3 ls --endpoint-url ftp://h",
      "--endpoint-url takes a URL with http:// or https://, such as http://localhost:9000.",
    ],
    [
      "aws s3 ls --endpoint-url http://h:9000/bucket",
      "--endpoint-url takes a URL with http:// or https://, such as http://localhost:9000.",
    ],
    [
      "aws s3 ls --endpoint-url http://u:p@h:9000",
      "--endpoint-url takes a URL with http:// or https://, such as http://localhost:9000.",
    ],
    ["aws s3api head-bucket", "head-bucket needs --bucket: write --bucket followed by the bucket's name."],
    ["aws s3api head-bucket --bucket=", "head-bucket needs --bucket: write --bucket followed by the bucket's name."],
    ["aws s3api head-object --bucket b", "head-object needs --key: write --key followed by the object's key."],
    [
      "aws s3api get-object-tagging --bucket b --key=",
      "get-object-tagging needs --key: write --key followed by the object's key.",
    ],
    [
      "aws s3api head-object --bucket b/k --key k",
      "--bucket takes a bucket name, which holds no /: write the key with --key.",
    ],
    [`aws s3api head-bucket --bucket ${"a".repeat(256)}`, "--bucket takes a name of at most 255 bytes."],
    [`aws s3api head-object --bucket b --key ${"k".repeat(1_025)}`, TOO_LONG("--key")],
    [`aws s3api list-objects-v2 --bucket b --prefix ${"p".repeat(1_025)}`, TOO_LONG("--prefix")],
    [`aws s3 ls --bucket-name-prefix ${"p".repeat(1_025)}`, TOO_LONG("--bucket-name-prefix")],
    [`aws s3 ls s3://b/${"\u00e9".repeat(513)}`, TOO_LONG("The path")],
    [`preview s3://b/${"k".repeat(1_025)}`, TOO_LONG("The path")],
    [
      "aws s3api head-object --bucket b --key a\u0000b",
      "The word at line 1, column 40 holds a NUL character, which no command line can pass: open such an object from the Keys panel, where its Source tab reads it.",
    ],
  ])("%s", (text, sentence) => {
    expect(refused(text)).toBe(sentence);
  });

  test("the largest values pass", () => {
    expect(command(`aws s3api head-bucket --bucket ${"a".repeat(255)}`)).toEqual({
      kind: "head-bucket",
      bucket: "a".repeat(255),
    });
    expect(command(`aws s3api head-object --bucket b --key ${"k".repeat(1_024)}`)).toMatchObject({
      key: "k".repeat(1_024),
    });
    expect(command("aws s3api list-objects-v2 --bucket b --page-size 1000 --max-items 500")).toMatchObject({
      pageSize: 1_000,
      maxItems: 500,
    });
  });
});

describe("refused commands and options", () => {
  test.each([
    ["aws s3 rm s3://b/k", W_OFF("rm")],
    ["aws s3 mb s3://b", W_OFF("mb")],
    ["aws s3 rb s3://b", W_OFF("rb")],
    ["aws s3 website s3://b", W_OFF("website")],
    ["aws s3 cp s3://b/k .", `${W_OFF("cp")} To read an object here, run preview s3://bucket/key.`],
    ["aws s3 mv s3://b/k s3://b/j", `${W_OFF("mv")} To read an object here, run preview s3://bucket/key.`],
    ["aws s3 sync . s3://b", `${W_OFF("sync")} To read an object here, run preview s3://bucket/key.`],
    [
      "aws s3 presign s3://b/k",
      "presign is refused: it signs a URL with this connection's secret key, and anyone who holds the URL can read the object without credentials until it expires.",
    ],
    [
      "aws s3 frobnicate",
      "frobnicate is not an aws s3 command Studio runs: it runs aws s3 ls, the aws s3api reads in the provider doc, and preview.",
    ],
    ["aws s3api put-object --bucket b --key k", W_OFF("put-object")],
    ["aws s3api delete-objects --bucket b", W_OFF("delete-objects")],
    ["aws s3api create-bucket --bucket b", W_OFF("create-bucket")],
    ["aws s3api copy-object --bucket b", W_OFF("copy-object")],
    ["aws s3api upload-part --bucket b", W_OFF("upload-part")],
    ["aws s3api restore-object --bucket b", W_OFF("restore-object")],
    ["aws s3api abort-multipart-upload --bucket b", W_OFF("abort-multipart-upload")],
    ["aws s3api complete-multipart-upload --bucket b", W_OFF("complete-multipart-upload")],
    ["aws s3api write-get-object-response", W_OFF("write-get-object-response")],
    [
      "aws s3api update-bucket-metadata-journal-table-configuration",
      // The verb is a typed word, so the sentence echoes its first 40 characters, as every other typed word.
      W_OFF("update-bucket-metadata-journal-table-con..."),
    ],
    ["aws s3api rename-object --bucket b", W_OFF("rename-object")],
    [
      "aws s3api get-object --bucket b --key k out.csv",
      "get-object writes the object to a local file, which Studio never does: run preview s3://bucket/key to see its first rows.",
    ],
    [
      "aws s3api get-object-attributes --bucket b --key k",
      "get-object-attributes is not read in this version: one of the servers Studio is verified on answers it with the whole object. Run aws s3api head-object for the size, ETag and storage class.",
    ],
    [
      "aws s3api select-object-content --bucket b --key k",
      "select-object-content runs SQL on the server, which this version does not: run preview s3://bucket/key to see an object's first rows.",
    ],
    [
      "aws s3api list-objects --bucket b",
      "list-objects is the older listing: run list-objects-v2, which takes the same --bucket, --prefix and --delimiter.",
    ],
    [
      "aws s3api get-bucket-policy --bucket b",
      `get-bucket-policy is not a read Studio runs on S3 in this version: it runs ${S3API_READS}.`,
    ],
    [
      "aws ec2 describe-instances",
      "ec2 is not S3: Studio's S3 console runs aws s3 ls, the aws s3api reads in the provider doc, and preview.",
    ],
    [
      "ls s3://b/",
      "ls is not S3: Studio's S3 console runs aws s3 ls, the aws s3api reads in the provider doc, and preview.",
    ],
    ["aws preview s3://b/k", "preview is Studio's own command, not the AWS CLI's: write it without aws."],
    ["aws s3 preview s3://b/k", "preview is Studio's own command, not the AWS CLI's: write it without aws."],
    ["", EMPTY],
    ["aws", EMPTY],
    ["# a comment only", EMPTY],
    ["aws s3api", EMPTY],
  ])("%s", (text, sentence) => {
    expect(refused(text)).toBe(sentence);
  });

  test.each([
    [
      "--profile prod",
      "--profile is refused: the Access key and Secret on the connection sign every request, and Studio reads no AWS profile or credentials file.",
    ],
    [
      "--no-sign-request",
      "--no-sign-request is refused: a connection with a blank Access key and Secret sends unsigned requests, and one with a key pair signs every request.",
    ],
    ["--ca-bundle ca.pem", "--ca-bundle is refused: TLS is set on the connection, and Studio reads no local file."],
    ["--no-verify-ssl", "--no-verify-ssl is refused: TLS verification is set on the connection, never by a command."],
    ["--debug", "--debug is refused: it prints request headers and signatures, which Studio never shows."],
    [
      '--query "Buckets[].Name"',
      "--query is refused in this version: Studio shows the whole result as a grid and runs no JMESPath expression.",
    ],
    [
      "--no-paginate",
      "--no-paginate is refused: Studio reads at most 500 rows per run and gives a --starting-token to read on.",
    ],
    ["--version", "--version is refused: Studio runs one S3 read per command, not the AWS CLI."],
    ["--cli-read-timeout 5", "--cli-read-timeout is refused: the connection's Query Timeout bounds every command."],
    [
      "--cli-connect-timeout 5",
      "--cli-connect-timeout is refused: the connection's Query Timeout bounds every command.",
    ],
    [
      "--cli-binary-format raw-in-base64-out",
      "--cli-binary-format is refused: no read Studio runs takes a blob value.",
    ],
    ["--cli-error-format json", "--cli-error-format is refused: Studio words every error itself."],
    ["--cli-auto-prompt", "--cli-auto-prompt is refused: Studio runs the command as written and asks nothing."],
    [
      "--cli-input-json {}",
      "--cli-input-json is refused: write each parameter as its own option, which Studio checks one by one.",
    ],
    [
      "--cli-input-yaml x",
      "--cli-input-yaml is refused: write each parameter as its own option, which Studio checks one by one.",
    ],
    [
      "--generate-cli-skeleton",
      "--generate-cli-skeleton is refused: the provider doc lists every option each command takes.",
    ],
  ])("the option %s is refused", (option, sentence) => {
    expect(refused(`aws s3api list-buckets ${option}`)).toBe(sentence);
    // A global option stands before the service as well; the two input options and the skeleton are the operation's.
    if (!/^--(cli-input|generate-cli-skeleton)/.test(option)) {
      expect(refused(`aws ${option} s3api list-buckets`)).toBe(sentence);
    }
  });

  test.each([
    [
      "aws s3api head-object --bucket b --key k --request-payer requester",
      "--request-payer is refused: it charges the request to your AWS account, and Studio is verified only on servers that bill no requests.",
    ],
    [
      "aws s3 ls s3://b/ --request-payer requester",
      "--request-payer is refused: it charges the request to your AWS account, and Studio is verified only on servers that bill no requests.",
    ],
    [
      "aws s3api head-bucket --bucket b --expected-bucket-owner 1",
      "--expected-bucket-owner is refused: it checks an AWS account id, which the servers Studio is verified on do not carry.",
    ],
    [
      "aws s3api list-objects-v2 --bucket b --optional-object-attributes RestoreStatus",
      "--optional-object-attributes is refused: it asks for archive restore status, which Studio does not show in this version.",
    ],
    [
      "aws s3 ls --bucket-region eu-west-1",
      "--bucket-region is refused: the Region field on the connection decides the region every request is signed for.",
    ],
    [
      "aws s3api list-buckets --bucket-region eu-west-1",
      "--bucket-region is refused: the Region field on the connection decides the region every request is signed for.",
    ],
    [
      "aws s3api head-object --bucket b --key k --sse-customer-key x",
      "--sse-customer-key is refused: Studio does not read objects encrypted with a customer-provided key in this version, and a key typed here would be kept in the query history.",
    ],
    [
      "aws s3api head-object --bucket b --key k --sse-customer-algorithm AES256",
      "--sse-customer-algorithm is refused: Studio does not read objects encrypted with a customer-provided key in this version, and a key typed here would be kept in the query history.",
    ],
    [
      "aws s3api head-object --bucket b --key k --sse-customer-key-md5 x",
      "--sse-customer-key-md5 is refused: Studio does not read objects encrypted with a customer-provided key in this version, and a key typed here would be kept in the query history.",
    ],
    [
      "aws s3api list-objects-v2 --bucket b --start-after 2026/",
      "--start-after is refused: with a delimiter some servers skip a whole folder after it, and others return an empty page. Use --starting-token to read on.",
    ],
    [
      "aws s3api list-objects-v2 --bucket b --fetch-owner",
      "--fetch-owner is refused: some of the servers Studio is verified on send no owner.",
    ],
    [
      "aws s3api list-objects-v2 --bucket b --no-fetch-owner",
      "--no-fetch-owner is refused: some of the servers Studio is verified on send no owner.",
    ],
    [
      `aws s3api list-object-versions --bucket b --starting-token ${ABC_TOKEN}`,
      "--starting-token is refused on list-object-versions: Studio reads one page of versions, at most 500 entries, and does not read on in this version.",
    ],
    [
      "aws s3api list-object-versions --bucket b --page-size 10",
      "--page-size is refused on list-object-versions: Studio reads one page of versions, at most 500 entries, and does not read on in this version.",
    ],
    [
      `aws s3api list-buckets --starting-token ${ABC_TOKEN}`,
      "--starting-token is refused on list-buckets: Studio reads every bucket in one request.",
    ],
    [
      "aws s3api list-buckets --page-size 10",
      "--page-size is refused on list-buckets: Studio reads every bucket in one request.",
    ],
    [
      "aws s3api list-buckets --continuation-token t",
      "--continuation-token is refused on list-buckets: Studio reads every bucket in one request.",
    ],
    [
      "aws s3api list-buckets --max-buckets 5",
      "--max-buckets is refused on list-buckets: Studio reads every bucket in one request.",
    ],
    [
      "aws s3 ls s3://b/ --continuation-token t",
      "--continuation-token is refused: use --page-size for the page and --starting-token to read on, which Studio checks.",
    ],
    [
      "aws s3api list-objects-v2 --bucket b --max-keys 5",
      "--max-keys is refused: use --page-size for the page and --starting-token to read on, which Studio checks.",
    ],
    [
      "aws s3api list-object-versions --bucket b --key-marker a",
      "--key-marker is refused: Studio reads one page of versions, at most 500 entries, and does not read on in this version.",
    ],
    [
      "aws s3api list-object-versions --bucket b --version-id-marker v",
      "--version-id-marker is refused: Studio reads one page of versions, at most 500 entries, and does not read on in this version.",
    ],
    [
      "aws s3api list-object-versions --bucket b --max-keys 5",
      "--max-keys is refused: Studio reads one page of versions, at most 500 entries, and does not read on in this version.",
    ],
    [
      "aws s3api head-object --bucket b --key k --version-id v",
      "head-object takes no option --version-id: it takes --bucket and --key.",
    ],
    [
      "aws s3api get-object-tagging --bucket b --key k --version-id v",
      "get-object-tagging takes no option --version-id: it takes --bucket and --key.",
    ],
    [
      "preview s3://b/k --version-id v",
      "preview takes no option --version-id: it takes --format, --columns, --max-rows and --schema.",
    ],
    [
      "aws s3api head-object --bucket b --key k --range bytes=0-1",
      "head-object takes no option --range: it takes --bucket and --key.",
    ],
    [
      "aws s3api head-object --bucket b --key k --if-match x",
      "head-object takes no option --if-match: it takes --bucket and --key.",
    ],
    [
      "aws s3api head-object --bucket b --key k --response-content-type x",
      "head-object takes no option --response-content-type: it takes --bucket and --key.",
    ],
    [
      "aws s3api head-object --bucket b --key k --part-number 1",
      "head-object takes no option --part-number: it takes --bucket and --key.",
    ],
    [
      "aws s3api head-object --bucket b --key k --checksum-mode ENABLED",
      "head-object takes no option --checksum-mode: it takes --bucket and --key.",
    ],
  ])("%s", (text, sentence) => {
    expect(refused(text)).toBe(sentence);
  });
});

describe("paths and the pinned bucket", () => {
  test.each([
    ["aws s3 ls s3://a/ s3://b/", "ls takes one path: write s3://bucket/prefix, in single quotes if it holds a space."],
    [
      "aws s3 ls s3://b/ --bucket-name-prefix x",
      "--bucket-name-prefix applies only when ls lists buckets: write ls with no path to use it.",
    ],
    [
      "aws s3 ls --page-size 10",
      "--page-size applies only when ls lists objects: Studio reads every bucket in one request.",
    ],
    [
      "aws s3 ls s3://arn:aws:s3:us-east-1:1:accesspoint/ap",
      "Studio does not read access points or Outposts, so it refuses a path that begins with arn:: write s3://bucket/prefix.",
    ],
    ["aws s3 ls https://h/b", "The path is not an s3:// path: write s3://bucket/prefix."],
    ["aws s3 ls s3:///x", "The path names no bucket: write s3://bucket/prefix."],
    ["preview", "preview needs an object: write preview s3://bucket/key."],
    ["preview s3://", "preview needs an object: write preview s3://bucket/key."],
    ["preview s3://sales", "preview needs an object: write preview s3://bucket/key."],
    ["preview s3://sales/", "preview needs an object: write preview s3://bucket/key."],
    [
      "preview s3://b/x s3://b/y",
      "preview takes one path: write preview s3://bucket/key, in single quotes if it holds a space.",
    ],
  ])("%s", (text, sentence) => {
    expect(refused(text)).toBe(sentence);
  });

  test.each([
    "aws s3 ls s3://other/",
    "aws s3api list-objects-v2 --bucket other",
    "aws s3api list-object-versions --bucket other",
    "aws s3api head-bucket --bucket other",
    "aws s3api head-object --bucket other --key k",
    "aws s3api get-object-tagging --bucket other --key k",
    "aws s3api get-bucket-location --bucket other",
    "aws s3api get-bucket-versioning --bucket other",
    "preview s3://other/k",
  ])("on a connection pinned to sales, %s is refused", (text) => {
    expect(refused(text, PINNED)).toBe(PIN);
    expect(parseS3Command(text, {}).ok).toBe(true);
  });

  test("the pinned bucket itself, and the bucket listings, are accepted on a pinned connection", () => {
    expect(command("aws s3 ls", PINNED)).toMatchObject({ kind: "ls", bucket: "" });
    expect(command("aws s3api list-buckets", PINNED)).toEqual({ kind: "list-buckets", maxItems: 500 });
    expect(command("aws s3 ls s3://sales/2026/", PINNED)).toMatchObject({ bucket: "sales", prefix: "2026/" });
  });
});

describe("the address rules of the core's names.ts, worded by the console", () => {
  test.each([
    ["aws s3api head-object --bucket .. --key k", BUCKET_ADDRESS("--bucket")],
    ["aws s3api head-object --bucket=.. --key k", BUCKET_ADDRESS("--bucket")],
    ["aws s3api head-object --bucket 'a b' --key k", BUCKET_ADDRESS("--bucket")],
    [
      "aws s3api head-bucket --bucket -b",
      "--bucket takes a value, and the word after it begins with -, which the AWS CLI reads as an option: write --bucket= followed by the value to pass a value that begins with -.",
    ],
    ["aws s3api head-bucket --bucket=-b", BUCKET_ADDRESS("--bucket")],
    ["aws s3api head-object --bucket b --key /x", KEY_ADDRESS("--key")],
    ["aws s3api head-object --bucket b --key=/x", KEY_ADDRESS("--key")],
    ["aws s3api get-object-tagging --bucket b --key /x", KEY_ADDRESS("--key")],
    ["preview s3://b//x", KEY_ADDRESS("The path's key")],
    ["aws s3api head-object --bucket b --key ../x", DOT_SEGMENTS("--key")],
    ["aws s3api get-object-tagging --bucket b --key a/../..", DOT_SEGMENTS("--key")],
    ["preview s3://b/a/..", DOT_SEGMENTS("The path's key")],
    ["preview s3://../k", BUCKET_ADDRESS("The path's bucket")],
    ["aws s3 ls s3://-b/", BUCKET_ADDRESS("The path's bucket")],
  ])("%s", (text, sentence) => {
    expect(refused(text)).toBe(sentence);
    expect(refused(text, SERVER)).toBe(sentence);
  });

  test("a key whose . and .. segments stay inside its bucket is read as typed", () => {
    expect(command("aws s3api head-object --bucket b --key a/../b")).toEqual({
      kind: "head-object",
      bucket: "b",
      key: "a/../b",
    });
    expect(command("preview s3://b/./x")).toMatchObject({ bucket: "b", key: "./x" });
  });

  test("no other verdict reaches the address step: an empty key is refused before it and a foreign bucket after it", () => {
    expect(refused("aws s3api head-object --bucket b --key=", PINNED)).toBe(
      "head-object needs --key: write --key followed by the object's key.",
    );
    expect(refused("aws s3api head-object --bucket other --key k", PINNED)).toBe(PIN);
    expect(refused("aws s3api head-object --bucket .. --key k", PINNED)).toBe(BUCKET_ADDRESS("--bucket"));
  });
});

describe("the starting token", () => {
  test.each(["bad", "abc___2", "eyJLZXlNYXJrZXIiOiAiYS50eHQiLCAiVmVyc2lvbklkTWFya2VyIjogIm51bGwifQ=="])(
    "%s is refused with the one sentence",
    (token) => {
      expect(refused(`aws s3api list-objects-v2 --bucket b --starting-token ${token}`)).toBe(TOKEN);
    },
  );

  test("a CLI token with a truncate amount is read", () => {
    expect(
      command(
        "aws s3api list-objects-v2 --bucket b --starting-token eyJDb250aW51YXRpb25Ub2tlbiI6ICIxdWVHY3hMUFJ4MVRyL1hZRXhIbmhiWUxndmVEczJKL3dtMzZIeTR2Yk93TT0iLCAiYm90b190cnVuY2F0ZV9hbW91bnQiOiAyfQ==",
      ),
    ).toMatchObject({
      resume: { continuationToken: "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=", truncateAmount: 2 },
    });
  });
});

describe("the connection's context", () => {
  test.each([
    ["http://localhost:9000", "http://localhost:9000"],
    ["http://LOCALHOST:9000/", "http://localhost:9000"],
    ["http://minio", "http://minio:80"],
    ["https://s3.example.com", "https://s3.example.com:443"],
    ["http://[::1]:9000", "http://[::1]:9000"],
  ])("--endpoint-url %s matches the connection's %s", (typed, endpoint) => {
    const result = parsed(`aws s3 ls --endpoint-url ${typed}`, { ...SERVER, endpoint });
    expect(result.matched).toEqual(["--endpoint-url"]);
  });

  test("an endpoint or a region other than the connection's is refused on the server, naming the connection's own", () => {
    expect(refused("aws s3 ls --endpoint-url http://other:9000", SERVER)).toBe(
      "--endpoint-url names an address other than this connection's http://localhost:9000: Host and Port on the connection decide where Studio connects.",
    );
    expect(refused("aws s3 ls --region eu-west-1", SERVER)).toBe(
      "--region names a region other than this connection's us-east-1: the Region field on the connection decides the region every request is signed for.",
    );
  });

  test("the browser knows no connection, so it accepts any well-formed endpoint and region", () => {
    expect(parsed("aws s3 ls --endpoint-url http://other:9000 --region eu-west-1").matched).toEqual([]);
  });

  test("matched options are recorded in the order typed", () => {
    expect(parsed("aws --region us-east-1 s3 ls --endpoint-url http://localhost:9000", SERVER).matched).toEqual([
      "--region",
      "--endpoint-url",
    ]);
  });

  test("a write names the read-only mode only while it holds", () => {
    expect(refused("aws s3 rm s3://b/k", { ...SERVER, readOnly: true })).toBe(W_ON("rm"));
    expect(refused("aws s3 rm s3://b/k", SERVER)).toBe(W_OFF("rm"));
    expect(refused("aws s3api put-object --bucket b --key k", { readOnly: true })).toBe(W_ON("put-object"));
  });
});

describe("the refusal order, one case per adjacent pair", () => {
  test("1 before 2: the text bound before the caret", () => {
    expect(codeOf(`aws s3 ls ^ #${"x".repeat(65_536)}`)).toBe("too-large");
    expect(refused(`aws s3 ls #${"x".repeat(65_536)}`)).toBe(
      "The command is longer than 65,536 bytes, the most an S3 command holds in Studio: shorten it.",
    );
  });

  test("2 before 3: the caret before the shared reader", () => {
    expect(codeOf("aws s3 ls ^ ;")).toBe("caret");
  });

  test("3 before 4: the shared reader before the assignment", () => {
    expect(codeOf("A=1 aws s3 ls ;")).toBe("shell-operator");
  });

  test("4 before 5: the assignment before the empty text", () => {
    expect(codeOf("A=1")).toBe("assignment");
  });

  test("5 before 6: the empty text before the service", () => {
    expect(codeOf("  # nothing")).toBe("empty");
  });

  test("6 before 7: the service and operation words before a NUL", () => {
    expect(codeOf("aws ec2 a\u0000")).toBe("not-s3");
    expect(codeOf("aws preview s3://b/a\u0000")).toBe("aws-preview");
    expect(codeOf("aws s3api put-object --key a\u0000")).toBe("write-command");
  });

  test("7 before 8: a NUL before the options", () => {
    expect(refused("aws s3api head-object --profile p --key a\u0000b")).toBe(
      "The word at line 1, column 41 holds a NUL character, which no command line can pass: open such an object from the Keys panel, where its Source tab reads it.",
    );
  });

  test("8 before 9: the options before building the command", () => {
    expect(codeOf("aws s3api head-object --profile p")).toBe("refused-option");
  });

  test("within 9: positionals, required flags, byte bounds, the address, the token, then the pin", () => {
    expect(codeOf("aws s3api head-object extra")).toBe("bad-argument");
    expect(refused("aws s3api head-object --bucket ..")).toBe(
      "head-object needs --key: write --key followed by the object's key.",
    );
    expect(refused(`aws s3api head-object --bucket b --key /${"x".repeat(1_024)}`)).toBe(TOO_LONG("--key"));
    expect(refused("aws s3api list-objects-v2 --bucket .. --starting-token bad")).toBe(BUCKET_ADDRESS("--bucket"));
    expect(refused("aws s3api list-objects-v2 --bucket other --starting-token bad", PINNED)).toBe(TOKEN);
  });
});

describe("no typed value reaches a sentence", () => {
  const SECRET = "SECRETVALUE";
  test.each([
    `aws s3api head-object --bucket ${SECRET}/x --key k`,
    `aws s3api head-object --bucket=..${SECRET}.. --key k`,
    `aws s3api head-object --bucket b --key=/${SECRET}`,
    `aws s3api head-object --bucket b --key /${SECRET}`,
    `aws s3 ls --region ${SECRET}`,
    `aws s3 ls --endpoint-url http://${SECRET}:1`,
    `aws s3 ls --endpoint-url ${SECRET}`,
    `aws s3api list-objects-v2 --bucket b --max-items ${SECRET}`,
    `aws s3api list-objects-v2 --bucket b --delimiter ${SECRET}`,
    `preview s3://b/k --format ${SECRET}`,
    `aws s3 ls --output ${SECRET}`,
    `aws s3api list-objects-v2 --bucket b --prefix file://${SECRET}`,
    `aws s3api list-objects-v2 --bucket b --starting-token ${SECRET}`,
    `aws s3 ls s3://b/ --recursive=${SECRET}`,
    `aws s3api head-bucket --bucket b --frob=${SECRET}`,
    `aws s3api head-bucket --buck=${SECRET}`,
    `AWS_SECRET_ACCESS_KEY=${SECRET} aws s3 ls`,
    `'X=${SECRET}' aws s3 ls`,
    `aws s3 a=${SECRET}`,
    `aws s3 ls s3://${SECRET}/ --bucket-name-prefix p`,
    `aws s3api head-object --bucket b --key k ${SECRET}`,
    `preview s3://other/${SECRET}`,
    `aws s3api head-object --profile=${SECRET}`,
    `aws s3api head-object --bucket b --key ../${SECRET}`,
    `preview s3://b/${SECRET}/../..`,
  ])("%s", (text) => {
    for (const context of [{}, SERVER, PINNED]) {
      const result = parseS3Command(text, context);
      if (result.ok) continue;
      expect(result.refusal.message).not.toContain(SECRET);
    }
  });

  test("a typed word is echoed at most 40 characters, and never past its first =", () => {
    expect(refused(`aws s3 ${"x".repeat(50)}`)).toBe(
      `${"x".repeat(40)}... is not an aws s3 command Studio runs: it runs aws s3 ls, the aws s3api reads in the provider doc, and preview.`,
    );
    expect(refused("aws s3 a=b")).toBe(
      "a is not an aws s3 command Studio runs: it runs aws s3 ls, the aws s3api reads in the provider doc, and preview.",
    );
    expect(refused("aws s3api head-bucket --bucket b --frob=x")).toBe(
      "head-bucket takes no option --frob: it takes --bucket.",
    );
  });
});
