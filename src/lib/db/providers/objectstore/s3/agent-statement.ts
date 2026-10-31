/**
 * The agent's reader of one S3 command: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. It reads the text with the console's own parser (`console/commands.ts`), so a command is read by one grammar
 * wherever it is written, and then admits only the parsed commands of a closed table of six metadata reads, each
 * mapped to the requests the provider sends: the bucket listing, one bucket's head, location and versioning, one
 * bucket's object count and total size, and one object's head for the exact key the command names. No flag, global
 * option, prefix, delimiter, token, page size or address the command wrote beyond the bucket and that key reaches the
 * server. Everything else is refused with the agent's own sentence, or, for a command the console's parser cannot read
 * (a bad address, a missing value, shell syntax), the parser's sentence followed by the agent's reads. No refusal
 * quotes a key, a prefix or a token the command wrote.
 *
 * Metadata only. Bucket names and the region are object names; object keys count as stored values, since key paths
 * name tenants and people, so nothing here lists keys or reads an object: no object listing, version listing, tagging,
 * preview or GetObject. A count over a prefix, a delimiter level or a start position would spell out key names one
 * character at a time, so the only count is a whole bucket's, which Studio totals and never lists, and the bucket
 * listing takes no name filter either, since it answers every bucket name the key may list anyway.
 *
 * Not the boundary. The boundary is the provider's structural closed table: the agent's reads reach the transport
 * only through `S3AgentClient` (`client.ts`), which holds these reads alone over a transport that sends GET and HEAD
 * only, as tests/unit/db/s3/agent-boundary.test.ts pins. This is what lets the model read why it was refused, before
 * anything is sent.
 */
import { parseS3Command, type S3RefusalCode } from "./console/commands";
import { isOptionWord, s3Words } from "./console/lexer";

export type S3AgentRefusalCode = "request" | "metadata-only" | "arguments";

/** The metadata operations, each one row of the table and one projection of the answer. */
export type S3AgentOperation =
  | "list-buckets"
  | "head-bucket"
  | "get-bucket-location"
  | "get-bucket-versioning"
  | "summary"
  | "head-object";

/** One read the agent may send: its operation, and the bucket and key it names, if any. */
export type S3AgentPlan =
  | { readonly op: "list-buckets" }
  | {
      readonly op: "head-bucket" | "get-bucket-location" | "get-bucket-versioning" | "summary";
      readonly bucket: string;
    }
  | { readonly op: "head-object"; readonly bucket: string; readonly key: string };

export type S3AgentReading =
  | { readonly ok: true; readonly plan: S3AgentPlan }
  | { readonly ok: false; readonly code: S3AgentRefusalCode; readonly message: string };

/** What the connection holds the parse to: its pinned bucket, so a command naming another is refused. */
export interface S3AgentContext {
  readonly pinnedBucket?: string;
}

const NOTHING_SENT = "Nothing was sent.";

const AGENT_READS =
  "Agent mode on S3 reads metadata only, one command per read: aws s3api list-buckets for every bucket's name and creation time, aws s3api head-bucket, get-bucket-location or get-bucket-versioning --bucket BUCKET for one bucket, aws s3 ls s3://BUCKET --recursive --summarize for one whole bucket's object count and total size, never its keys, and aws s3api head-object --bucket BUCKET --key KEY for one object the request names in full, answered with its existence, size, last-modified time and storage class.";

export const S3_AGENT_SENTENCES = {
  reads: AGENT_READS,
  empty: `The request holds no command. ${AGENT_READS} ${NOTHING_SENT}`,
  metadataOnly: `That is not one of agent mode's reads: object keys, bodies, user metadata, tags, ETags, version ids, owners, ACLs, policies and endpoints are withheld, so nothing that lists keys or versions, reads an object or its tags, or writes is sent. ${AGENT_READS} ${NOTHING_SENT}`,
  filter: `A listing or count over a prefix, a delimiter level, a name prefix or a start position is withheld, since narrower and narrower counts would reveal key names: agent mode counts only a whole bucket, and lists every bucket name. ${AGENT_READS} ${NOTHING_SENT}`,
  listing: `aws s3 ls lists keys, which agent mode never does: it answers only a whole bucket's totals, written aws s3 ls s3://BUCKET --recursive --summarize with no key path. ${AGENT_READS} ${NOTHING_SENT}`,
  flags: `An agent read takes no flag but its --bucket and --key: the endpoint, region, output, paging and every other option are the connection's or Studio's, never the request's. ${AGENT_READS} ${NOTHING_SENT}`,
  nul: `A command cannot name a bucket or key that holds a NUL character. ${AGENT_READS} ${NOTHING_SENT}`,
  /** `message` is the console parser's refusal, which quotes no key; the agent's reads follow it. */
  request: (message: string): string => `${message} ${AGENT_READS} ${NOTHING_SENT}`,
} as const;

/**
 * The options that filter or position a listing. Each is refused with the filter sentence wherever it stands, before
 * the console's parser reads the command, so its refusal never depends on the value it carries.
 */
const FILTER_OPTIONS: ReadonlySet<string> = new Set([
  "--prefix",
  "--delimiter",
  "--starting-token",
  "--bucket-name-prefix",
  "--start-after",
  "--continuation-token",
  "--marker",
  "--key-marker",
  "--version-id-marker",
]);

/** The options each read takes, and nothing else: no global option, paging flag or output switch. */
const READ_OPTIONS: Readonly<Record<S3AgentOperation, readonly string[]>> = Object.freeze({
  "list-buckets": Object.freeze([]),
  "head-bucket": Object.freeze(["--bucket"]),
  "get-bucket-location": Object.freeze(["--bucket"]),
  "get-bucket-versioning": Object.freeze(["--bucket"]),
  summary: Object.freeze(["--recursive", "--summarize"]),
  "head-object": Object.freeze(["--bucket", "--key"]),
});

/** The parser's refusals of a command the table does not hold: the editor's sentences list the editor's commands. */
const OUTSIDE_THE_TABLE: ReadonlySet<S3RefusalCode> = new Set([
  "help",
  "not-s3",
  "aws-preview",
  "not-a-command",
  "write-command",
  "refused-command",
]);

/** The parser's refusals of an option: the editor's sentences list options the agent's reads do not take. */
const OPTION_REFUSALS: ReadonlySet<S3RefusalCode> = new Set([
  "refused-option",
  "connection-option",
  "unknown-flag",
  "abbreviated-flag",
  "end-of-options",
]);

function refuse(code: S3AgentRefusalCode, message: string): S3AgentReading {
  return { ok: false, code, message };
}

function admit(plan: S3AgentPlan): S3AgentReading {
  return { ok: true, plan };
}

/** A refusal of the console's parser, worded for the agent. */
function parserRefusal(code: S3RefusalCode, message: string): S3AgentReading {
  if (code === "empty") return refuse("request", S3_AGENT_SENTENCES.empty);
  if (OUTSIDE_THE_TABLE.has(code)) return refuse("metadata-only", S3_AGENT_SENTENCES.metadataOnly);
  if (OPTION_REFUSALS.has(code)) return refuse("arguments", S3_AGENT_SENTENCES.flags);
  if (code === "nul-character") return refuse("request", S3_AGENT_SENTENCES.nul);
  return refuse("request", S3_AGENT_SENTENCES.request(message));
}

/**
 * The name of every option word the command holds, as the console's parser reads one: up to an `=`. Undefined when
 * the words do not read, which the parser then refuses in its own words.
 */
function optionNames(text: string): readonly string[] | undefined {
  const read = s3Words(text);
  if (!read.ok) return undefined;
  return [...read.lead, ...read.words]
    .filter((word) => isOptionWord(word, text))
    .map((word) => {
      const equals = word.text.indexOf("=");
      return equals < 0 ? word.text : word.text.slice(0, equals);
    });
}

/** One agent command read to the request the provider sends, or to why it sends nothing. Never sends anything. */
export function readS3AgentStatement(text: string, context: S3AgentContext = {}): S3AgentReading {
  if (text.trim() === "") return refuse("request", S3_AGENT_SENTENCES.empty);
  const options = optionNames(text);
  if (options?.some((name) => FILTER_OPTIONS.has(name))) {
    return refuse("metadata-only", S3_AGENT_SENTENCES.filter);
  }
  // No endpoint and no region: a global option is read as an option like any other, and the table refuses every one.
  const parsed = parseS3Command(text, context.pinnedBucket === undefined ? {} : { pinnedBucket: context.pinnedBucket });
  if (!parsed.ok) return parserRefusal(parsed.refusal.code, parsed.refusal.message);
  const { command } = parsed.parsed;
  let plan: S3AgentPlan;
  switch (command.kind) {
    case "list-buckets":
      plan = { op: "list-buckets" };
      break;
    case "head-bucket":
    case "get-bucket-location":
    case "get-bucket-versioning":
      plan = { op: command.kind, bucket: command.bucket };
      break;
    case "head-object":
      plan = { op: "head-object", bucket: command.bucket, key: command.key };
      break;
    case "ls":
      // A key path is a prefix, whose count would bisect key names; any other listing lists keys or buckets.
      if (command.bucket !== "" && command.prefix !== "") return refuse("metadata-only", S3_AGENT_SENTENCES.filter);
      if (command.bucket === "" || !command.recursive || !command.summarize)
        return refuse("metadata-only", S3_AGENT_SENTENCES.listing);
      plan = { op: "summary", bucket: command.bucket };
      break;
    default:
      return refuse("metadata-only", S3_AGENT_SENTENCES.metadataOnly);
  }
  // The parser accepted the words, so they read.
  const allowed = READ_OPTIONS[plan.op];
  if ((options as readonly string[]).some((name) => !allowed.includes(name)))
    return refuse("arguments", S3_AGENT_SENTENCES.flags);
  return admit(plan);
}
