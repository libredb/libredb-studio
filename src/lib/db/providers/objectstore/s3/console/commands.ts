/**
 * The S3 command table and its parser: one console text to an
 * `S3ConsoleCommand`, or the first refusal that applies, as a whole sentence.
 *
 * Pure, and shipped to the browser: the confirmation gate reads the text with this parser and an empty context
 * (`guard.ts`), and the provider reads it again on the server with the connection's endpoint, region, pinned bucket
 * and read-only mode before any request (Oxia's split, `src/lib/db/providers/keyvalue/oxia/guard.ts`), so what the
 * editor accepts and what runs are one parse. Flags are read as the AWS CLI reads a shell-split argv where that is
 * safe and refused where it is not: a repeated or abbreviated flag, a separate value that begins with -, `--`, and a
 * value or path that names a local file.
 *
 * Every refusal names a place, a flag or the connection's own value and never quotes a value the user typed; a typed
 * word is echoed at most 40 characters and never past its first =. The address rules are the core's
 * (`../names.ts`), read as predicates and worded here, naming the flag or the path and never the name.
 */
import { exceedsUtf8Bytes, utf8ByteLength } from "@/lib/db/console/bounds";
import type { ShellRefusalCode, ShellWord } from "@/lib/db/console/shell-words";
import { bucketAddressRefusal, objectAddressRefusal } from "../names";
import type { S3PreviewFormat, S3PreviewRequest } from "../preview";
import { previewMaxRowsSentence } from "../preview-render";
import {
  S3_ECHO_WORD_CHARS,
  S3_KEY_MAX_BYTES,
  S3_KEY_SCAN_MAX_COUNT,
  S3_MAX_BUCKET_BYTES,
  S3_MAX_TEXT_BYTES,
  S3_PREVIEW_DEFAULT_ROWS,
  S3_RESULT_MAX_ROWS,
} from "./constants";
import { isOptionWord, s3CommandShape, s3Words } from "./lexer";
import { readS3Path } from "./paths";
import { decodeS3StartingToken, type S3ResumeToken } from "./token";

// ============================================================================
// The table
// ============================================================================

export type S3OperationKind =
  | "ls"
  | "list-buckets"
  | "list-objects-v2"
  | "list-object-versions"
  | "head-bucket"
  | "head-object"
  | "get-object-tagging"
  | "get-bucket-location"
  | "get-bucket-versioning"
  | "preview";

export interface S3FlagSpec {
  readonly name: string;
  readonly takes: "value" | "boolean";
  readonly required?: true;
  /** A closed value set, for the reader and for completion. */
  readonly values?: readonly string[];
  readonly integer?: { readonly min: number; readonly max: number };
}

export interface S3CommandSpec {
  readonly service: "s3" | "s3api" | "studio";
  readonly operation: S3OperationKind;
  /** "[PATH]", "PATH" or "". */
  readonly arguments: string;
  readonly flags: readonly S3FlagSpec[];
}

function flag(spec: S3FlagSpec): S3FlagSpec {
  return Object.freeze({
    ...spec,
    ...(spec.values === undefined ? {} : { values: Object.freeze([...spec.values]) }),
    ...(spec.integer === undefined ? {} : { integer: Object.freeze({ ...spec.integer }) }),
  });
}

const BUCKET = flag({ name: "--bucket", takes: "value", required: true });
const KEY = flag({ name: "--key", takes: "value", required: true });
const PREFIX = flag({ name: "--prefix", takes: "value" });
const DELIMITER = flag({ name: "--delimiter", takes: "value", values: ["/"] });
const ENCODING_TYPE = flag({ name: "--encoding-type", takes: "value", values: ["url"] });
const MAX_ITEMS = flag({ name: "--max-items", takes: "value", integer: { min: 1, max: S3_RESULT_MAX_ROWS } });
const PAGE_SIZE = flag({ name: "--page-size", takes: "value", integer: { min: 1, max: S3_KEY_SCAN_MAX_COUNT } });

/** The seven names `preview --format` takes, the preview engine's formats. */
const S3_PREVIEW_FORMATS: readonly S3PreviewFormat[] = Object.freeze([
  "text",
  "json",
  "ndjson",
  "csv",
  "tsv",
  "parquet",
  "hex",
]);

function command(
  service: S3CommandSpec["service"],
  operation: S3OperationKind,
  args: string,
  flags: readonly S3FlagSpec[],
): S3CommandSpec {
  return Object.freeze({ service, operation, arguments: args, flags: Object.freeze([...flags]) });
}

/** The table as data, for the labels, completion, the generators and the provider-doc test. */
export const S3_COMMAND_TABLE: ReadonlyArray<S3CommandSpec> = Object.freeze([
  command("s3", "ls", "[PATH]", [
    flag({ name: "--recursive", takes: "boolean" }),
    PAGE_SIZE,
    flag({ name: "--human-readable", takes: "boolean" }),
    flag({ name: "--summarize", takes: "boolean" }),
    flag({ name: "--bucket-name-prefix", takes: "value" }),
  ]),
  command("s3api", "list-buckets", "", [PREFIX, MAX_ITEMS]),
  command("s3api", "list-objects-v2", "", [
    BUCKET,
    PREFIX,
    DELIMITER,
    ENCODING_TYPE,
    MAX_ITEMS,
    flag({ name: "--starting-token", takes: "value" }),
    PAGE_SIZE,
  ]),
  command("s3api", "list-object-versions", "", [BUCKET, PREFIX, DELIMITER, ENCODING_TYPE, MAX_ITEMS]),
  command("s3api", "head-bucket", "", [BUCKET]),
  command("s3api", "head-object", "", [BUCKET, KEY]),
  command("s3api", "get-object-tagging", "", [BUCKET, KEY]),
  command("s3api", "get-bucket-location", "", [BUCKET]),
  command("s3api", "get-bucket-versioning", "", [BUCKET]),
  command("studio", "preview", "PATH", [
    flag({ name: "--format", takes: "value", values: S3_PREVIEW_FORMATS }),
    flag({ name: "--columns", takes: "value" }),
    flag({ name: "--max-rows", takes: "value", integer: { min: 1, max: S3_RESULT_MAX_ROWS } }),
    flag({ name: "--schema", takes: "boolean" }),
  ]),
]);

/** The global options Studio reads: two the connection owns, checked against it, and four that change nothing. */
export const S3_ACCEPTED_GLOBAL_OPTIONS: readonly string[] = Object.freeze([
  "--endpoint-url",
  "--region",
  "--output",
  "--color",
  "--no-cli-pager",
  "--no-cli-auto-prompt",
]);

/** The value sets of the two no-op globals that take a value (the AWS CLI's own). */
export const S3_GLOBAL_OPTION_VALUES: Readonly<Record<"--output" | "--color", readonly string[]>> = Object.freeze({
  "--output": Object.freeze(["json", "text", "table", "yaml", "yaml-stream", "off"]),
  "--color": Object.freeze(["on", "off", "auto"]),
});

const BOOLEAN_NO_OPS: ReadonlySet<string> = new Set(["--no-cli-pager", "--no-cli-auto-prompt"]);

// ============================================================================
// The parse's types
// ============================================================================

export type S3ConsoleCommand =
  | {
      readonly kind: "ls";
      /** "" lists buckets. */
      readonly bucket: string;
      readonly prefix: string;
      readonly recursive: boolean;
      readonly pageSize: number;
      readonly humanReadable: boolean;
      readonly summarize: boolean;
      readonly bucketNamePrefix?: string;
      readonly maxItems: number;
    }
  | { readonly kind: "list-buckets"; readonly prefix?: string; readonly maxItems: number }
  | {
      readonly kind: "list-objects-v2";
      readonly bucket: string;
      readonly prefix: string;
      readonly delimiter: boolean;
      readonly maxItems: number;
      /** Whether --max-items was typed, which words the read-on notice. */
      readonly maxItemsGiven: boolean;
      readonly pageSize: number;
      readonly resume?: S3ResumeToken;
    }
  | {
      readonly kind: "list-object-versions";
      readonly bucket: string;
      readonly prefix: string;
      readonly delimiter: boolean;
      readonly maxItems: number;
    }
  | { readonly kind: "head-bucket" | "get-bucket-location" | "get-bucket-versioning"; readonly bucket: string }
  | { readonly kind: "head-object" | "get-object-tagging"; readonly bucket: string; readonly key: string }
  | { readonly kind: "preview"; readonly bucket: string; readonly key: string; readonly request: S3PreviewRequest };

/** What the parse is held to; the browser knows none of it and passes {}. */
export interface S3ParseContext {
  /** The connection's endpoint as `s3EndpointText` writes it (`connection-options.ts`); undefined in the browser. */
  readonly endpoint?: string;
  /** The signing region; undefined in the browser. */
  readonly region?: string;
  /** The Bucket field; undefined in the browser and on a connection with no pin. */
  readonly pinnedBucket?: string;
  /** Whether the connection's read-only mode holds; undefined in the browser. */
  readonly readOnly?: boolean;
}

export interface ParsedS3Command {
  readonly command: S3ConsoleCommand;
  /** The connection-owned globals that named the connection's own value, in the order typed (the matched-options notice). */
  readonly matched: readonly ("--endpoint-url" | "--region")[];
  /** The no-op globals, in the order typed (the no-op options notice). */
  readonly noOps: readonly string[];
  /** 1-based line of the operation word. */
  readonly line: number;
}

export type S3RefusalCode =
  | ShellRefusalCode
  | "caret"
  | "assignment"
  | "too-large"
  | "empty"
  | "help"
  | "not-s3"
  | "aws-preview"
  | "not-a-command"
  | "write-command"
  | "refused-command"
  | "nul-character"
  | "end-of-options"
  | "refused-option"
  | "connection-option"
  | "unknown-flag"
  | "abbreviated-flag"
  | "repeated-flag"
  | "flag-value"
  | "missing-value"
  | "dash-value"
  | "local-file"
  | "bad-value"
  | "bad-argument"
  | "bad-path"
  | "too-long"
  | "bucket-address"
  | "key-address"
  | "bad-token"
  | "pinned-bucket";

export interface S3Refusal {
  readonly code: S3RefusalCode;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export type S3ParseResult =
  | { readonly ok: true; readonly parsed: ParsedS3Command }
  | { readonly ok: false; readonly refusal: S3Refusal };

// ============================================================================
// Sentences
// ============================================================================

const count = (n: number): string => n.toLocaleString("en-US");

/** A word the user typed, as a refusal may repeat it: at most 40 characters, cut between two of them. */
function bounded(text: string): string {
  const characters = Array.from(text);
  return characters.length > S3_ECHO_WORD_CHARS ? `${characters.slice(0, S3_ECHO_WORD_CHARS).join("")}...` : text;
}

/** A typed word as a sentence echoes it: never past its first =, whatever its role. */
const echo = (text: string): string => bounded(text.split("=")[0]);

/** "a", "a and b", "a, b and c". */
export function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const TOO_LARGE = `The command is longer than ${count(S3_MAX_TEXT_BYTES)} bytes, the most an S3 command holds in Studio: shorten it.`;
const EMPTY =
  "The editor holds no command: write one S3 read, such as aws s3 ls s3://bucket/ or aws s3api head-object --bucket bucket --key key.";
const HELP = "Studio prints no help: the provider doc lists every command and flag Studio runs.";
const AWS_PREVIEW = "preview is Studio's own command, not the AWS CLI's: write it without aws.";
const END_OF_OPTIONS = "-- is not read here: write each value after its option, with = when it begins with -.";
const COPY_HINT = " To read an object here, run preview s3://bucket/key.";
const PRESIGN =
  "presign is refused: it signs a URL with this connection's secret key, and anyone who holds the URL can read the object without credentials until it expires.";
const S3API_READS = joinWithAnd(
  S3_COMMAND_TABLE.filter((entry) => entry.service === "s3api").map((entry) => entry.operation),
);
const ENDPOINT_SHAPE = "--endpoint-url takes a URL with http:// or https://, such as http://localhost:9000.";
const LS_ONE_PATH = "ls takes one path: write s3://bucket/prefix, in single quotes if it holds a space.";
const BUCKET_NAME_PREFIX_WITH_PATH =
  "--bucket-name-prefix applies only when ls lists buckets: write ls with no path to use it.";
const PAGE_SIZE_WITHOUT_PATH =
  "--page-size applies only when ls lists objects: Studio reads every bucket in one request.";
const PREVIEW_NEEDS_OBJECT = "preview needs an object: write preview s3://bucket/key.";
const PREVIEW_ONE_PATH = "preview takes one path: write preview s3://bucket/key, in single quotes if it holds a space.";
const BUCKET_SLASH = "--bucket takes a bucket name, which holds no /: write the key with --key.";
const BUCKET_TOO_LONG = `--bucket takes a name of at most ${count(S3_MAX_BUCKET_BYTES)} bytes.`;
const COLUMNS = "--columns takes a comma-separated list of column names.";
const PATH_LOCAL_FILE =
  "The path begins with file:// or fileb://, which the AWS CLI reads as a local file and Studio never does: write s3://bucket/prefix.";
const S3_WRITE_VERBS: readonly string[] = ["rm", "mb", "rb", "website"];
const S3_COPY_VERBS: readonly string[] = ["cp", "mv", "sync"];
const S3API_WRITE_PREFIXES: readonly string[] = [
  "put-",
  "delete-",
  "create-",
  "copy-",
  "upload-",
  "restore-",
  "abort-",
  "complete-",
  "write-",
  "update-",
  "rename-",
];

/** W-off and W-on: the read-only mode is named only while it holds. */
function writeCommandSentence(verb: string, readOnly: boolean | undefined): string {
  const word = echo(verb);
  return readOnly === true
    ? `${word} writes, and this connection is read-only. Studio's S3 support also reads only in this version, so turning the mode off would not run it: run it with the AWS CLI or your server's own tools.`
    : `${word} writes, and Studio's S3 support reads only in this version: run it with the AWS CLI or your server's own tools.`;
}

const S3API_REFUSED: ReadonlyMap<string, string> = new Map([
  [
    "get-object",
    "get-object writes the object to a local file, which Studio never does: run preview s3://bucket/key to see its first rows.",
  ],
  [
    "get-object-attributes",
    "get-object-attributes is not read in this version: one of the servers Studio is verified on answers it with the whole object. Run aws s3api head-object for the size, ETag and storage class.",
  ],
  [
    "select-object-content",
    "select-object-content runs SQL on the server, which this version does not: run preview s3://bucket/key to see an object's first rows.",
  ],
  [
    "list-objects",
    "list-objects is the older listing: run list-objects-v2, which takes the same --bucket, --prefix and --delimiter.",
  ],
]);

const timeoutSentence = (option: string): string =>
  `${option} is refused: the connection's Query Timeout bounds every command.`;
const inputSentence = (option: string): string =>
  `${option} is refused: write each parameter as its own option, which Studio checks one by one.`;

/** Every global and operation-level CLI option Studio refuses wherever it stands. */
const REFUSED_GLOBALS: ReadonlyMap<string, string> = new Map([
  [
    "--profile",
    "--profile is refused: the Access key and Secret on the connection sign every request, and Studio reads no AWS profile or credentials file.",
  ],
  [
    "--no-sign-request",
    "--no-sign-request is refused: a connection with a blank Access key and Secret sends unsigned requests, and one with a key pair signs every request.",
  ],
  ["--ca-bundle", "--ca-bundle is refused: TLS is set on the connection, and Studio reads no local file."],
  ["--no-verify-ssl", "--no-verify-ssl is refused: TLS verification is set on the connection, never by a command."],
  ["--debug", "--debug is refused: it prints request headers and signatures, which Studio never shows."],
  [
    "--query",
    "--query is refused in this version: Studio shows the whole result as a grid and runs no JMESPath expression.",
  ],
  [
    "--no-paginate",
    `--no-paginate is refused: Studio reads at most ${count(S3_RESULT_MAX_ROWS)} rows per run and gives a --starting-token to read on.`,
  ],
  ["--version", "--version is refused: Studio runs one S3 read per command, not the AWS CLI."],
  ["--cli-read-timeout", timeoutSentence("--cli-read-timeout")],
  ["--cli-connect-timeout", timeoutSentence("--cli-connect-timeout")],
  ["--cli-binary-format", "--cli-binary-format is refused: no read Studio runs takes a blob value."],
  ["--cli-error-format", "--cli-error-format is refused: Studio words every error itself."],
  ["--cli-auto-prompt", "--cli-auto-prompt is refused: Studio runs the command as written and asks nothing."],
  ["--cli-input-json", inputSentence("--cli-input-json")],
  ["--cli-input-yaml", inputSentence("--cli-input-yaml")],
  [
    "--generate-cli-skeleton",
    "--generate-cli-skeleton is refused: the provider doc lists every option each command takes.",
  ],
]);

const S3API_OPERATIONS: readonly S3OperationKind[] = S3_COMMAND_TABLE.filter((entry) => entry.service === "s3api").map(
  (entry) => entry.operation,
);
const ONE_VERSION_PAGE = `Studio reads one page of versions, at most ${count(S3_RESULT_MAX_ROWS)} entries, and does not read on in this version.`;

/** The operation flags Studio refuses, each refused only on the operations its row names. */
const REFUSED_FLAGS: ReadonlyArray<{
  readonly flags: readonly string[];
  readonly operations: readonly S3OperationKind[];
  readonly sentence: (flag: string) => string;
}> = [
  {
    flags: ["--request-payer"],
    operations: ["ls", "list-objects-v2", "list-object-versions", "head-object", "get-object-tagging"],
    sentence: () =>
      "--request-payer is refused: it charges the request to your AWS account, and Studio is verified only on servers that bill no requests.",
  },
  {
    flags: ["--expected-bucket-owner"],
    operations: S3API_OPERATIONS,
    sentence: () =>
      "--expected-bucket-owner is refused: it checks an AWS account id, which the servers Studio is verified on do not carry.",
  },
  {
    flags: ["--optional-object-attributes"],
    operations: ["list-objects-v2", "list-object-versions"],
    sentence: () =>
      "--optional-object-attributes is refused: it asks for archive restore status, which Studio does not show in this version.",
  },
  {
    flags: ["--bucket-region"],
    operations: ["ls", "list-buckets"],
    sentence: () =>
      "--bucket-region is refused: the Region field on the connection decides the region every request is signed for.",
  },
  {
    flags: ["--sse-customer-algorithm", "--sse-customer-key", "--sse-customer-key-md5"],
    operations: ["head-object"],
    sentence: (name) =>
      `${name} is refused: Studio does not read objects encrypted with a customer-provided key in this version, and a key typed here would be kept in the query history.`,
  },
  {
    flags: ["--start-after"],
    operations: ["list-objects-v2"],
    sentence: () =>
      "--start-after is refused: with a delimiter some servers skip a whole folder after it, and others return an empty page. Use --starting-token to read on.",
  },
  {
    flags: ["--fetch-owner", "--no-fetch-owner"],
    operations: ["list-objects-v2"],
    sentence: (name) => `${name} is refused: some of the servers Studio is verified on send no owner.`,
  },
  {
    flags: ["--starting-token", "--page-size"],
    operations: ["list-object-versions"],
    sentence: (name) => `${name} is refused on list-object-versions: ${ONE_VERSION_PAGE}`,
  },
  {
    flags: ["--starting-token", "--page-size", "--continuation-token", "--max-buckets"],
    operations: ["list-buckets"],
    sentence: (name) => `${name} is refused on list-buckets: Studio reads every bucket in one request.`,
  },
  {
    flags: ["--continuation-token", "--max-keys"],
    operations: ["ls", "list-objects-v2"],
    sentence: (name) =>
      `${name} is refused: use --page-size for the page and --starting-token to read on, which Studio checks.`,
  },
  {
    flags: ["--key-marker", "--version-id-marker", "--max-keys"],
    operations: ["list-object-versions"],
    sentence: (name) => `${name} is refused: ${ONE_VERSION_PAGE}`,
  },
];

/** The sentence of a value outside a flag's closed set or bounds. */
const VALUE_SENTENCES: ReadonlyMap<string, string> = new Map([
  ["--delimiter", "--delimiter takes /, the one folder separator Studio reads."],
  ["--encoding-type", "--encoding-type takes url, which Studio always sends."],
  ["--format", `--format takes one of ${S3_PREVIEW_FORMATS.join(", ")}.`],
  [
    "--max-items",
    `--max-items takes a whole number from 1 to ${count(S3_RESULT_MAX_ROWS)}, the most rows a Studio result holds.`,
  ],
  [
    "--page-size",
    `--page-size takes a whole number from 1 to ${count(S3_KEY_SCAN_MAX_COUNT)}, the most keys S3 answers in one page.`,
  ],
  ["--max-rows", previewMaxRowsSentence(S3_RESULT_MAX_ROWS)],
  ["--output", "--output takes json, text, table, yaml, yaml-stream or off."],
  ["--color", "--color takes on, off or auto."],
]);

const bucketAddressSentence = (subject: "--bucket" | "The path's bucket"): string =>
  `${subject} is not a bucket name Studio addresses: a bucket name is 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit.`;
const keyAddressSentence = (subject: "--key" | "The path's key"): string =>
  `${subject} begins with /, and a measured S3 server read a different key for such a name, so Studio does not open it.`;
const dotSegmentsSentence = (subject: "--key" | "The path's key"): string =>
  `${subject} names no object inside its bucket once its . and .. segments are resolved, and a server or proxy that resolves them would read something else, so Studio does not open it.`;
const tooLongSentence = (subject: string): string =>
  `${subject} is longer than ${count(S3_KEY_MAX_BYTES)} bytes, the longest key S3 allows: shorten it.`;
const pinnedSentence = (pinned: string): string =>
  `The command names a bucket other than this connection's ${pinned}: the Bucket field on the connection decides which bucket Studio reads.`;
const tokenSentence = (operation: string): string =>
  `--starting-token is not a token Studio or the AWS CLI wrote for ${operation}: run the command again without it, and use the token the result's notice gives.`;
const nulSentence = (word: ShellWord): string =>
  `The word at line ${word.line}, column ${word.column + 1} holds a NUL character, which no command line can pass: open such an object from the Keys panel, where its Source tab reads it.`;

// ============================================================================
// Refusals and small readers
// ============================================================================

type Place = { readonly line: number; readonly column: number };

function refusal(code: S3RefusalCode, message: string, place?: Place): S3Refusal {
  return place === undefined ? { code, message } : { code, message, line: place.line, column: place.column };
}

const failed = (code: S3RefusalCode, message: string, place?: Place): S3ParseResult => ({
  ok: false,
  refusal: refusal(code, message, place),
});

/** A value or a path the AWS CLI would read from a local file, in any case. */
function namesLocalFile(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.startsWith("file://") || lower.startsWith("fileb://");
}

const INTEGER = /^[1-9][0-9]*$/;

/** A typed `--endpoint-url` in the same form, or undefined when it is not an http(s) URL of a host and nothing else. */
function typedEndpoint(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  const port = url.port === "" ? (url.protocol === "http:" ? 80 : 443) : Number(url.port);
  return `${url.protocol.slice(0, -1)}://${url.hostname}:${port}`;
}

// ============================================================================
// The service and the operation
// ============================================================================

interface Located {
  readonly spec: S3CommandSpec;
  /** The word that names the operation: the operation word, or `preview` itself. */
  readonly operationWord: ShellWord;
}

const specOf = (operation: S3OperationKind): S3CommandSpec =>
  S3_COMMAND_TABLE.find((entry) => entry.operation === operation) as S3CommandSpec;

/**
 * Where the service stands: `echoable` is false when the word before it is an option word with no `=`, so the
 * service word may be that option's typed value and a refusal names its place instead of its text.
 */
function locate(
  service: ShellWord,
  operation: ShellWord | undefined,
  afterAws: boolean,
  readOnly: boolean | undefined,
  echoable: boolean,
): Located | S3Refusal {
  const name = service.text;
  if (name === "help") return refusal("help", HELP, service);
  if (name === "preview")
    return afterAws
      ? refusal("aws-preview", AWS_PREVIEW, service)
      : { spec: specOf("preview"), operationWord: service };
  if (name !== "s3" && name !== "s3api")
    return refusal(
      "not-s3",
      `${echoable ? echo(name) : `The word at line ${service.line}, column ${service.column + 1}`} is not S3: Studio's S3 console runs aws s3 ls, the aws s3api reads in the provider doc, and preview.`,
      service,
    );
  if (operation === undefined) return refusal("empty", EMPTY, service);
  const op = operation.text;
  if (op === "help") return refusal("help", HELP, operation);
  if (op === "preview") return refusal("aws-preview", AWS_PREVIEW, operation);
  if (name === "s3") {
    if (op === "ls") return { spec: specOf("ls"), operationWord: operation };
    if (S3_WRITE_VERBS.includes(op)) return refusal("write-command", writeCommandSentence(op, readOnly), operation);
    if (S3_COPY_VERBS.includes(op))
      return refusal("write-command", `${writeCommandSentence(op, readOnly)}${COPY_HINT}`, operation);
    if (op === "presign") return refusal("refused-command", PRESIGN, operation);
    return refusal(
      "not-a-command",
      `${echo(op)} is not an aws s3 command Studio runs: it runs aws s3 ls, the aws s3api reads in the provider doc, and preview.`,
      operation,
    );
  }
  const spec = S3_COMMAND_TABLE.find((entry) => entry.service === "s3api" && entry.operation === op);
  if (spec !== undefined) return { spec, operationWord: operation };
  const special = S3API_REFUSED.get(op);
  if (special !== undefined) return refusal("refused-command", special, operation);
  if (S3API_WRITE_PREFIXES.some((prefix) => op.startsWith(prefix)))
    return refusal("write-command", writeCommandSentence(op, readOnly), operation);
  return refusal(
    "not-a-command",
    `${echo(op)} is not a read Studio runs on S3 in this version: it runs ${S3API_READS}.`,
    operation,
  );
}

// ============================================================================
// Options
// ============================================================================

interface ReadState {
  /** Each option given, by name: its value, or true for a boolean. */
  readonly values: Map<string, string | true>;
  /** The word each option was given in, for a refusal's place. */
  readonly words: Map<string, ShellWord>;
  readonly positionals: ShellWord[];
  readonly matched: ("--endpoint-url" | "--region")[];
  readonly noOps: string[];
}

interface Reading {
  readonly words: readonly ShellWord[];
  readonly serviceAt: number;
  readonly operationAt: number | undefined;
  readonly spec: S3CommandSpec;
  readonly context: S3ParseContext;
  readonly state: ReadState;
}

type Step = { readonly next: number } | { readonly refusal: S3Refusal };

const repeated = (name: string, word: ShellWord): Step => ({
  refusal: refusal("repeated-flag", `${name} is given twice: give it once.`, word),
});

/** A value option's value: after its =, or the next word, which the service and the operation never are. */
function readValue(
  r: Reading,
  at: number,
  name: string,
  inline: string | undefined,
): { readonly value: string; readonly next: number } | { readonly refusal: S3Refusal } {
  const word = r.words[at];
  let value: string;
  let next: number;
  if (inline !== undefined) {
    value = inline;
    next = at + 1;
  } else {
    const after = r.words[at + 1];
    if (after === undefined || at + 1 === r.serviceAt || at + 1 === r.operationAt)
      return { refusal: refusal("missing-value", `${name} takes a value: write it after ${name}.`, word) };
    if (after.text.startsWith("-"))
      return {
        refusal: refusal(
          "dash-value",
          `${name} takes a value, and the word after it begins with -, which the AWS CLI reads as an option: write ${name}= followed by the value to pass a value that begins with -.`,
          after,
        ),
      };
    value = after.text;
    next = at + 2;
  }
  if (namesLocalFile(value))
    return {
      refusal: refusal(
        "local-file",
        `${name} takes no value that begins with file:// or fileb://: the AWS CLI reads such a value from a local file, which Studio never does.`,
        word,
      ),
    };
  return { value, next };
}

/** A boolean takes no value: neither `=value` nor a bare `true` or `false` after it. */
function readBoolean(r: Reading, at: number, name: string, inline: string | undefined): Step {
  const word = r.words[at];
  const after = r.words[at + 1];
  const valueAfter =
    after !== undefined &&
    at + 1 !== r.serviceAt &&
    at + 1 !== r.operationAt &&
    !after.quoted &&
    (after.text === "true" || after.text === "false");
  if (inline !== undefined || valueAfter)
    return { refusal: refusal("flag-value", `${name} takes no value: write ${name} alone.`, word) };
  return { next: at + 1 };
}

/** A value's shape: its closed set, its whole-number bounds, the column list, and a bucket name's missing /. */
function checkValue(spec: S3FlagSpec, value: string, word: ShellWord): S3Refusal | undefined {
  const outside =
    (spec.values !== undefined && !spec.values.includes(value)) ||
    (spec.integer !== undefined && !(INTEGER.test(value) && Number(value) <= spec.integer.max));
  if (outside) return refusal("bad-value", VALUE_SENTENCES.get(spec.name) as string, word);
  if (spec.name === "--columns" && value.split(",").some((column) => column.trim() === ""))
    return refusal("bad-value", COLUMNS, word);
  if (spec.name === "--bucket" && value.includes("/")) return refusal("bad-value", BUCKET_SLASH, word);
  return undefined;
}

/** `--endpoint-url`, `--region`, `--output` and `--color`: checked against the connection or their value set. */
function readGlobalValue(r: Reading, at: number, name: string, inline: string | undefined): Step {
  const word = r.words[at];
  if (r.state.values.has(name)) return repeated(name, word);
  const read = readValue(r, at, name, inline);
  if ("refusal" in read) return read;
  const { context, state } = r;
  if (name === "--endpoint-url") {
    const typed = typedEndpoint(read.value);
    if (typed === undefined) return { refusal: refusal("bad-value", ENDPOINT_SHAPE, word) };
    if (context.endpoint !== undefined) {
      if (typed !== context.endpoint)
        return {
          refusal: refusal(
            "connection-option",
            `--endpoint-url names an address other than this connection's ${context.endpoint}: Host and Port on the connection decide where Studio connects.`,
            word,
          ),
        };
      state.matched.push("--endpoint-url");
    }
  } else if (name === "--region") {
    if (context.region !== undefined) {
      if (read.value !== context.region)
        return {
          refusal: refusal(
            "connection-option",
            `--region names a region other than this connection's ${context.region}: the Region field on the connection decides the region every request is signed for.`,
            word,
          ),
        };
      state.matched.push("--region");
    }
  } else {
    const allowed = S3_GLOBAL_OPTION_VALUES[name as "--output" | "--color"];
    if (!allowed.includes(read.value))
      return { refusal: refusal("bad-value", VALUE_SENTENCES.get(name) as string, word) };
    state.noOps.push(name);
  }
  state.values.set(name, read.value);
  return { next: read.next };
}

/** One option word at `at`, and the word after it when that is its value. */
function readOption(r: Reading, at: number): Step {
  const word = r.words[at];
  const equals = word.text.indexOf("=");
  const name = equals < 0 ? word.text : word.text.slice(0, equals);
  const inline = equals < 0 ? undefined : word.text.slice(equals + 1);
  const { spec, state } = r;
  if (name === "--") return { refusal: refusal("end-of-options", END_OF_OPTIONS, word) };
  if (name === "--help" || name === "-h") return { refusal: refusal("help", HELP, word) };
  const global = REFUSED_GLOBALS.get(name);
  if (global !== undefined) return { refusal: refusal("refused-option", global, word) };
  const refusedFlag = REFUSED_FLAGS.find(
    (entry) => entry.flags.includes(name) && entry.operations.includes(spec.operation),
  );
  if (refusedFlag !== undefined) return { refusal: refusal("refused-option", refusedFlag.sentence(name), word) };
  if (BOOLEAN_NO_OPS.has(name)) {
    if (state.values.has(name)) return repeated(name, word);
    const step = readBoolean(r, at, name, inline);
    if ("refusal" in step) return step;
    state.values.set(name, true);
    state.noOps.push(name);
    return step;
  }
  if (S3_ACCEPTED_GLOBAL_OPTIONS.includes(name)) return readGlobalValue(r, at, name, inline);
  const own = spec.flags.find((candidate) => candidate.name === name);
  if (own === undefined) {
    const expansions = [...spec.flags.map((candidate) => candidate.name), ...S3_ACCEPTED_GLOBAL_OPTIONS].filter(
      (candidate) => name.length > 2 && name.startsWith("--") && candidate.startsWith(name),
    );
    if (expansions.length === 1)
      return {
        refusal: refusal(
          "abbreviated-flag",
          `${echo(name)} is an abbreviation, which Studio does not expand: write ${expansions[0]}.`,
          word,
        ),
      };
    return {
      refusal: refusal(
        "unknown-flag",
        `${spec.operation} takes no option ${echo(name)}: it takes ${joinWithAnd(spec.flags.map((candidate) => candidate.name))}.`,
        word,
      ),
    };
  }
  if (state.values.has(name)) return repeated(name, word);
  if (own.takes === "boolean") {
    const step = readBoolean(r, at, name, inline);
    if ("refusal" in step) return step;
    state.values.set(name, true);
    state.words.set(name, word);
    return step;
  }
  const read = readValue(r, at, name, inline);
  if ("refusal" in read) return read;
  const shape = checkValue(own, read.value, word);
  if (shape !== undefined) return { refusal: shape };
  state.values.set(name, read.value);
  state.words.set(name, word);
  return { next: read.next };
}

// ============================================================================
// Building the command
// ============================================================================

const textOf = (state: ReadState, name: string): string | undefined => {
  const value = state.values.get(name);
  return typeof value === "string" ? value : undefined;
};

/** A path word read by `readS3Path`, after the local-file rule. */
function readPathWord(word: ShellWord | undefined): { readonly bucket: string; readonly key: string } | S3Refusal {
  const text = word?.text ?? "";
  if (namesLocalFile(text)) return refusal("local-file", PATH_LOCAL_FILE, word);
  const path = readS3Path(text);
  if (!path.ok) return refusal("bad-path", path.message, word);
  return path;
}

const outsidePin = (bucket: string, context: S3ParseContext): boolean =>
  context.pinnedBucket !== undefined && bucket !== context.pinnedBucket;

function buildLs(r: Reading): S3ConsoleCommand | S3Refusal {
  const { state, context } = r;
  if (state.positionals.length > 1) return refusal("bad-argument", LS_ONE_PATH, state.positionals[1]);
  const pathWord = state.positionals[0];
  const path = readPathWord(pathWord);
  if ("code" in path) return path;
  const bucketNamePrefix = textOf(state, "--bucket-name-prefix");
  if (path.bucket !== "" && bucketNamePrefix !== undefined)
    return refusal("bad-argument", BUCKET_NAME_PREFIX_WITH_PATH, state.words.get("--bucket-name-prefix"));
  if (path.bucket === "" && state.values.has("--page-size"))
    return refusal("bad-argument", PAGE_SIZE_WITHOUT_PATH, state.words.get("--page-size"));
  if (utf8ByteLength(path.key) > S3_KEY_MAX_BYTES) return refusal("too-long", tooLongSentence("The path"), pathWord);
  if (bucketNamePrefix !== undefined && utf8ByteLength(bucketNamePrefix) > S3_KEY_MAX_BYTES)
    return refusal("too-long", tooLongSentence("--bucket-name-prefix"), state.words.get("--bucket-name-prefix"));
  if (path.bucket !== "" && bucketAddressRefusal(path.bucket) !== undefined)
    return refusal("bucket-address", bucketAddressSentence("The path's bucket"), pathWord);
  if (path.bucket !== "" && outsidePin(path.bucket, context))
    return refusal("pinned-bucket", pinnedSentence(context.pinnedBucket as string), pathWord);
  return {
    kind: "ls",
    bucket: path.bucket,
    prefix: path.key,
    recursive: state.values.has("--recursive"),
    pageSize: Number(textOf(state, "--page-size") ?? S3_KEY_SCAN_MAX_COUNT),
    humanReadable: state.values.has("--human-readable"),
    summarize: state.values.has("--summarize"),
    ...(bucketNamePrefix === undefined ? {} : { bucketNamePrefix }),
    maxItems: S3_RESULT_MAX_ROWS,
  };
}

function buildPreview(r: Reading, operationWord: ShellWord): S3ConsoleCommand | S3Refusal {
  const { state, context } = r;
  if (state.positionals.length === 0) return refusal("bad-argument", PREVIEW_NEEDS_OBJECT, operationWord);
  if (state.positionals.length > 1) return refusal("bad-argument", PREVIEW_ONE_PATH, state.positionals[1]);
  const pathWord = state.positionals[0];
  const path = readPathWord(pathWord);
  if ("code" in path) return path;
  if (path.bucket === "" || path.key === "") return refusal("bad-argument", PREVIEW_NEEDS_OBJECT, pathWord);
  if (utf8ByteLength(path.key) > S3_KEY_MAX_BYTES) return refusal("too-long", tooLongSentence("The path"), pathWord);
  const verdict = objectAddressRefusal(path.bucket, path.key);
  if (verdict === "bucket-pattern")
    return refusal("bucket-address", bucketAddressSentence("The path's bucket"), pathWord);
  if (verdict === "key-dot-segments") return refusal("key-address", dotSegmentsSentence("The path's key"), pathWord);
  if (verdict !== undefined) return refusal("key-address", keyAddressSentence("The path's key"), pathWord);
  if (outsidePin(path.bucket, context))
    return refusal("pinned-bucket", pinnedSentence(context.pinnedBucket as string), pathWord);
  const format = textOf(state, "--format") as S3PreviewFormat | undefined;
  const columns = textOf(state, "--columns")
    ?.split(",")
    .map((column) => column.trim());
  const request: S3PreviewRequest = {
    ...(format === undefined ? {} : { format }),
    ...(columns === undefined ? {} : { columns }),
    maxRows: Number(textOf(state, "--max-rows") ?? S3_PREVIEW_DEFAULT_ROWS),
    ...(state.values.has("--schema") ? { schemaOnly: true } : {}),
  };
  return { kind: "preview", bucket: path.bucket, key: path.key, request };
}

function buildS3api(r: Reading, operationWord: ShellWord): S3ConsoleCommand | S3Refusal {
  const { spec, state, context } = r;
  const operation = spec.operation;
  if (state.positionals.length > 0) {
    const word = state.positionals[0];
    return refusal(
      "bad-argument",
      `${operation} takes every value after its option, and the word at line ${word.line}, column ${word.column + 1} stands alone: write it after the option it belongs to.`,
      word,
    );
  }
  const takesBucket = spec.flags.includes(BUCKET);
  const takesKey = spec.flags.includes(KEY);
  const bucket = textOf(state, "--bucket") ?? "";
  const key = textOf(state, "--key") ?? "";
  const prefix = textOf(state, "--prefix");
  if (takesBucket && bucket === "")
    return refusal(
      "bad-argument",
      `${operation} needs --bucket: write --bucket followed by the bucket's name.`,
      operationWord,
    );
  if (takesKey && key === "")
    return refusal(
      "bad-argument",
      `${operation} needs --key: write --key followed by the object's key.`,
      operationWord,
    );
  if (utf8ByteLength(bucket) > S3_MAX_BUCKET_BYTES)
    return refusal("too-long", BUCKET_TOO_LONG, state.words.get("--bucket"));
  if (utf8ByteLength(key) > S3_KEY_MAX_BYTES)
    return refusal("too-long", tooLongSentence("--key"), state.words.get("--key"));
  if (prefix !== undefined && utf8ByteLength(prefix) > S3_KEY_MAX_BYTES)
    return refusal("too-long", tooLongSentence("--prefix"), state.words.get("--prefix"));
  if (takesBucket) {
    const verdict = takesKey ? objectAddressRefusal(bucket, key) : bucketAddressRefusal(bucket);
    if (verdict === "bucket-pattern")
      return refusal("bucket-address", bucketAddressSentence("--bucket"), state.words.get("--bucket"));
    if (verdict === "key-dot-segments")
      return refusal("key-address", dotSegmentsSentence("--key"), state.words.get("--key"));
    if (verdict !== undefined) return refusal("key-address", keyAddressSentence("--key"), state.words.get("--key"));
  }
  const startingToken = textOf(state, "--starting-token");
  const resume = startingToken === undefined ? undefined : decodeS3StartingToken(startingToken);
  if (startingToken !== undefined && resume === undefined)
    return refusal("bad-token", tokenSentence(operation), state.words.get("--starting-token"));
  if (takesBucket && outsidePin(bucket, context))
    return refusal("pinned-bucket", pinnedSentence(context.pinnedBucket as string), state.words.get("--bucket"));
  const maxItems = Number(textOf(state, "--max-items") ?? S3_RESULT_MAX_ROWS);
  switch (operation) {
    case "list-buckets":
      return { kind: "list-buckets", ...(prefix === undefined ? {} : { prefix }), maxItems };
    case "list-objects-v2":
      return {
        kind: "list-objects-v2",
        bucket,
        prefix: prefix ?? "",
        delimiter: state.values.has("--delimiter"),
        maxItems,
        maxItemsGiven: state.values.has("--max-items"),
        pageSize: Number(textOf(state, "--page-size") ?? S3_KEY_SCAN_MAX_COUNT),
        ...(resume === undefined ? {} : { resume }),
      };
    case "list-object-versions":
      return {
        kind: "list-object-versions",
        bucket,
        prefix: prefix ?? "",
        delimiter: state.values.has("--delimiter"),
        maxItems,
      };
    case "head-bucket":
    case "get-bucket-location":
    case "get-bucket-versioning":
      return { kind: operation, bucket };
    default:
      return { kind: operation as "head-object" | "get-object-tagging", bucket, key };
  }
}

function build(r: Reading, operationWord: ShellWord): S3ConsoleCommand | S3Refusal {
  const help = r.state.positionals.find((word) => !word.quoted && word.text === "help");
  if (help !== undefined) return refusal("help", HELP, help);
  if (r.spec.operation === "ls") return buildLs(r);
  if (r.spec.operation === "preview") return buildPreview(r, operationWord);
  return buildS3api(r, operationWord);
}

// ============================================================================
// The parser
// ============================================================================

/** One S3 console command, or the first refusal in the parser's fixed order. */
export function parseS3Command(text: string, context: S3ParseContext): S3ParseResult {
  if (exceedsUtf8Bytes(text, S3_MAX_TEXT_BYTES)) return failed("too-large", TOO_LARGE);
  const read = s3Words(text);
  if (!read.ok) return { ok: false, refusal: read.refusal };
  const { lead, words } = read;
  const shape = s3CommandShape(words, text);
  if (shape.serviceAt === undefined) return failed("empty", EMPTY);
  const afterAws = lead.some((word) => !word.quoted && word.text === "aws");
  const operation = shape.operationAt === undefined ? undefined : words[shape.operationAt];
  const before = shape.serviceAt === 0 ? undefined : words[shape.serviceAt - 1];
  const echoable = before === undefined || !isOptionWord(before, text) || before.text.includes("=");
  const located = locate(words[shape.serviceAt], operation, afterAws, context.readOnly, echoable);
  if ("code" in located) return { ok: false, refusal: located };
  for (const word of words) {
    if (word.text.includes("\u0000")) return failed("nul-character", nulSentence(word), word);
  }
  const state: ReadState = { values: new Map(), words: new Map(), positionals: [], matched: [], noOps: [] };
  const r: Reading = {
    words,
    serviceAt: shape.serviceAt,
    operationAt: shape.operationAt,
    spec: located.spec,
    context,
    state,
  };
  for (let at = 0; at < words.length; ) {
    if (at === shape.serviceAt || at === shape.operationAt) {
      at += 1;
      continue;
    }
    const word = words[at];
    if (!isOptionWord(word, text)) {
      state.positionals.push(word);
      at += 1;
      continue;
    }
    const step = readOption(r, at);
    if ("refusal" in step) return { ok: false, refusal: step.refusal };
    at = step.next;
  }
  const built = build(r, located.operationWord);
  if ("code" in built) return { ok: false, refusal: built };
  return {
    ok: true,
    parsed: { command: built, matched: state.matched, noOps: state.noOps, line: located.operationWord.line },
  };
}
