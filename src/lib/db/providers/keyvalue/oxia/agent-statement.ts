/**
 * The agent's reader of one Oxia command: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. It reads the text with the editor's own parser (`commands.ts`), so a command is
 * read by one grammar wherever it is written, and then admits only the parsed commands of a closed table of metadata
 * reads, each mapped to the reads the provider sends: no flag, comparison, partition key, secondary index, namespace or
 * address the request wrote reaches the server. Everything else is refused with the agent's own sentence, or, for a
 * request the editor's parser cannot read (a second command, a bad argument, shell syntax), the parser's sentence
 * followed by the agent's reads. No refusal quotes a stored value: at most it names the request's own command word.
 *
 * Metadata only. Key names count as stored values, since Pulsar and other applications put tenants, topics, ids and
 * emails in them, so nothing here lists keys or reads a value: no range-scan, no comparison get (its answer names a
 * neighbouring key), no secondary-index read (its answer names a primary key), no notification or sequence stream. What
 * an agent may read is the namespace's shard map (its shard and leader counts), for one key its own request names that
 * key's existence, version, times, value size and whether it is ephemeral, and the count of the keys in a range its own
 * request names, which Studio counts under the row budget and never lists.
 *
 * Not the boundary. The boundary is this table, which the provider sends nothing outside of, over a gRPC stub that holds
 * only reads; Oxia has no authorization, so no principal can be proved. This is what lets the model read why it was
 * refused, before anything is sent.
 */
import { type OxiaCommandRange, type OxiaRefusalCode, parseOxiaCommand } from "./commands";
import { oxiaWords } from "./lexer";

export type OxiaAgentRefusalCode = "request" | "metadata-only" | "arguments";

/** The metadata operations, each one row of the table and one projection of the answer. */
export type OxiaAgentOperation = "shards" | "key metadata" | "key count";

/** One read the agent may send: its operation, and the one argument it carries, if any. */
export type OxiaAgentPlan =
  | { readonly op: "shards" }
  | { readonly op: "key metadata"; readonly key: string }
  | { readonly op: "key count"; readonly range: OxiaCommandRange };

export type OxiaAgentReading =
  | { readonly ok: true; readonly plan: OxiaAgentPlan }
  | { readonly ok: false; readonly code: OxiaAgentRefusalCode; readonly message: string };

/** The word of the shard-map read: Studio's own, since the oxia CLI's client prints no shard map. */
export const OXIA_AGENT_SHARDS_WORD = "shards";

const NOTHING_SENT = "Nothing was sent.";

const AGENT_READS =
  "Agent mode on Oxia reads metadata only: shards for the namespace's shard and leader counts, get <key> for one key the request names, answered with its existence, version, creation and modification times, value size and whether it is ephemeral, and list [MIN [MAX]], list -s <min> -e <max> or list --prefix <prefix> for the count of the keys in that range, never their names.";

export const OXIA_AGENT_SENTENCES = {
  empty: `The request holds no command. ${AGENT_READS} ${NOTHING_SENT}`,
  metadataOnly: `That is not one of agent mode's reads: key names and stored values are withheld, so nothing that lists keys or reads a value is sent, and neither is a write, a delete, a session, a notification or sequence stream, or a read of another namespace. ${AGENT_READS} ${NOTHING_SENT}`,
  flags: `An agent read takes no flag but the bounds of a count (-s, -e and --prefix): its comparison, partition key, secondary index, limit, namespace and address are the provider's, never the request's. ${AGENT_READS} ${NOTHING_SENT}`,
  shards: `shards takes no argument and no flag. ${NOTHING_SENT}`,
  /** `message` is the editor parser's refusal, which quotes no stored value; the agent's reads follow it. */
  request: (message: string): string => `${message} ${AGENT_READS} ${NOTHING_SENT}`,
} as const;

function refuse(code: OxiaAgentRefusalCode, message: string): OxiaAgentReading {
  return { ok: false, code, message };
}

function admit(plan: OxiaAgentPlan): OxiaAgentReading {
  return { ok: true, plan };
}

/**
 * The parser's refusals of a command the table does not hold. Their editor sentences list the editor's commands or
 * point to the oxia CLI, so the agent reads its own sentence instead.
 */
const OUTSIDE_THE_TABLE: ReadonlySet<OxiaRefusalCode> = new Set([
  "unknown-command",
  "write-command",
  "stream-command",
  "not-client",
]);

/** The parser's refusals of a flag. The editor's sentences list flags the agent's reads do not take. */
const FLAG_REFUSALS: ReadonlySet<OxiaRefusalCode> = new Set([
  "unknown-flag",
  "refused-flag",
  "connection-flag",
  "repeated-flag",
  "conflicting-flags",
  "limit-out-of-range",
]);

/** A refusal of the editor's parser, worded for the agent. */
function parserRefusal(code: OxiaRefusalCode, message: string): OxiaAgentReading {
  if (code === "empty") return refuse("request", OXIA_AGENT_SENTENCES.empty);
  if (OUTSIDE_THE_TABLE.has(code)) return refuse("metadata-only", OXIA_AGENT_SENTENCES.metadataOnly);
  if (FLAG_REFUSALS.has(code)) return refuse("arguments", OXIA_AGENT_SENTENCES.flags);
  return refuse("request", OXIA_AGENT_SENTENCES.request(message));
}

/** The flags a count's bounds are written with, in every spelling the parser reads. */
const COUNT_FLAGS: ReadonlySet<string> = new Set(["-s", "--key-min", "-e", "--key-max", "--prefix"]);

/**
 * The name of every flag the request wrote before a `--`, as the parser would read it: `--name` up to an `=`, or a
 * shorthand's first letter. The parser drops a flag that changes only the editor's output (`-v`, `--limit`) from its
 * command, so the table reads the words themselves: a flag it does not hold is refused, not ignored.
 */
function flagNames(text: string): readonly string[] {
  const read = oxiaWords(text);
  // The parser read the same text first and accepted it, so the words read.
  if (!read.ok) return [];
  const names: string[] = [];
  for (const word of read.words) {
    if (word.quoted || word.text.length < 2 || !word.text.startsWith("-")) continue;
    if (word.text === "--") break;
    names.push(word.text.startsWith("--") ? word.text.split("=")[0] : word.text.slice(0, 2));
  }
  return names;
}

/** The shard-map read: the word `shards` alone, after an optional `oxia client` lead, or undefined for another verb. */
function readShards(text: string): OxiaAgentReading | undefined {
  const read = oxiaWords(text);
  if (!read.ok) return undefined;
  const [first, ...rest] = read.words;
  if (first === undefined || first.quoted || first.text !== OXIA_AGENT_SHARDS_WORD) return undefined;
  return rest.length === 0 ? admit({ op: "shards" }) : refuse("arguments", OXIA_AGENT_SENTENCES.shards);
}

/** One agent command read to the request the provider sends, or to why it sends nothing. Never sends anything. */
export function readOxiaAgentStatement(text: string): OxiaAgentReading {
  if (text.trim() === "") return refuse("request", OXIA_AGENT_SENTENCES.empty);
  const shards = readShards(text);
  if (shards !== undefined) return shards;
  // No connection context: an -a or -n is read as a flag like any other, and the table refuses every one.
  const parsed = parseOxiaCommand(text, {});
  if (!parsed.ok) return parserRefusal(parsed.refusal.code, parsed.refusal.message);
  const { command } = parsed.parsed;
  if (command.kind === "range-scan") return refuse("metadata-only", OXIA_AGENT_SENTENCES.metadataOnly);
  const allowed = command.kind === "list" ? COUNT_FLAGS : new Set<string>();
  if (flagNames(text).some((name) => !allowed.has(name))) return refuse("arguments", OXIA_AGENT_SENTENCES.flags);
  if (command.kind === "get") return admit({ op: "key metadata", key: command.key });
  return admit({ op: "key count", range: command.range });
}
