/**
 * The agent's reader of one etcdctl command: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure, and safe in a browser bundle. It reads the text with the editor's own parser (`commands.ts`), so a command is
 * read by one grammar wherever it is written, and then admits only the parsed commands of a closed table of metadata
 * reads, each mapped to the one fixed request the provider sends: no flag, revision, range end, limit or consistency
 * the request wrote reaches the server. Everything else is refused with the agent's own sentence, or, for a request
 * the editor's parser cannot read (a second command, a bad argument, shell syntax), the parser's sentence followed by
 * the agent's reads. No refusal quotes a stored value: at most it names the request's own command word or flag.
 *
 * Metadata only. Key names count as stored values, since applications put ids, emails and tokens in them, so nothing
 * here lists keys or reads a value: no ranged or prefix get but the count of every key, no keys-only read, no watch,
 * no txn and no lease time-to-live with its keys. What an agent may read is the cluster's own metadata (the answering
 * member's status, the member list, the raised alarms, the lease ids, whether authentication is on), the count of every
 * key, and, for one key its own request names, that key's existence, revisions, version, lease and value size.
 *
 * Not the boundary. The boundary is this table, which the provider sends nothing outside of, and the etcd user the
 * server must show, before every command, holds no root role and only READ permissions (`agent-read-only-proof.ts`);
 * this is what lets the model read why it was refused, before anything is sent.
 */
import type { EtcdBytes } from "./client";
import { type CommandRefusalCode, type EtcdCommand, type EtcdParseLimits, parseEtcdCommand } from "./commands";

export type EtcdAgentRefusalCode = "request" | "metadata-only" | "arguments";

/** The metadata operations, each one row of the table and one projection of the answer. */
export type EtcdAgentOperation =
  | "endpoint status"
  | "member list"
  | "alarm list"
  | "auth status"
  | "lease list"
  | "lease timetolive"
  | "key count"
  | "key metadata";

/** One read the agent may send: its operation, and the one argument it carries, if any. */
export type EtcdAgentPlan =
  | { readonly op: "endpoint status" | "member list" | "alarm list" | "auth status" | "lease list" | "key count" }
  | { readonly op: "lease timetolive"; readonly leaseHex: string }
  | { readonly op: "key metadata"; readonly key: EtcdBytes };

export type EtcdAgentReading =
  | { readonly ok: true; readonly plan: EtcdAgentPlan }
  | { readonly ok: false; readonly code: EtcdAgentRefusalCode; readonly message: string };

/** The longest key a request may name, in bytes. */
export const ETCD_AGENT_MAX_KEY_BYTES = 4096;

/**
 * The bounds the editor's parser reads an agent command under: none, as for a caller with no connection, since the
 * table refuses every flag they bound, with its own sentence, rather than the editor's sentence about the connection.
 */
const PARSE_LIMITS: EtcdParseLimits = Object.freeze({
  maxLimit: Number.POSITIVE_INFINITY,
  txnRangeLimit: 1,
  maxCommandTimeoutMs: Number.POSITIVE_INFINITY,
  maxWatchWindowMs: Number.POSITIVE_INFINITY,
});

const NOTHING_SENT = "Nothing was sent.";

const AGENT_READS =
  'Agent mode on etcd reads metadata only: endpoint status, member list, alarm list, auth status, lease list, lease timetolive <lease id> (without --keys), get "" --prefix --count-only for the count of every key, and get <key> for one key the request names, answered with its existence, revisions, version, lease and value size.';

export const ETCD_AGENT_SENTENCES = {
  empty: `The request holds no command. ${AGENT_READS} ${NOTHING_SENT}`,
  metadataOnly: `That is not one of agent mode's reads: key names and stored values are withheld, so nothing that lists keys or reads a value is sent, and neither is a write, a watch, a txn or a maintenance call. ${AGENT_READS} ${NOTHING_SENT}`,
  flags: `An agent read takes no flag but the two of the key count: the request's revision, range, limit, consistency, sort and timeout are the provider's, never the request's. ${AGENT_READS} ${NOTHING_SENT}`,
  key: `get takes exactly one key, a non-empty name of at most ${ETCD_AGENT_MAX_KEY_BYTES} bytes, and no range end. ${NOTHING_SENT}`,
  /** `message` is the editor parser's refusal, which quotes no stored value; the agent's reads follow it. */
  request: (message: string): string => `${message} ${AGENT_READS} ${NOTHING_SENT}`,
} as const;

function refuse(code: EtcdAgentRefusalCode, message: string): EtcdAgentReading {
  return { ok: false, code, message };
}

function admit(plan: EtcdAgentPlan): EtcdAgentReading {
  return { ok: true, plan };
}

/** The parser's refusals that say the command is one Studio's etcdctl grammar does not read at all. */
const NOT_A_COMMAND: ReadonlySet<CommandRefusalCode> = new Set(["empty"]);

/**
 * The parser's refusals of a command the table does not hold. Their editor sentences list the editor's commands or
 * point to its admin panels, which agent mode has neither of, so the agent reads its own sentence instead.
 */
const OUTSIDE_THE_TABLE: ReadonlySet<CommandRefusalCode> = new Set([
  "unknown-command",
  "maintenance-command",
  "not-offered",
  "blocking-command",
]);

/** The parser's refusals of a flag. The editor's sentences list flags the agent's reads do not take. */
const FLAG_REFUSALS: ReadonlySet<CommandRefusalCode> = new Set([
  "unknown-flag",
  "refused-flag",
  "global-flag",
  "conflicting-flags",
  "limit-too-large",
]);

/** A refusal of the editor's parser, worded for the agent. */
function parserRefusal(code: CommandRefusalCode, message: string): EtcdAgentReading {
  if (NOT_A_COMMAND.has(code)) return refuse("request", ETCD_AGENT_SENTENCES.empty);
  if (OUTSIDE_THE_TABLE.has(code)) return refuse("metadata-only", ETCD_AGENT_SENTENCES.metadataOnly);
  if (FLAG_REFUSALS.has(code)) return refuse("arguments", ETCD_AGENT_SENTENCES.flags);
  return refuse("request", ETCD_AGENT_SENTENCES.request(message));
}

/** The parsed get the table admits: one key, or the count of every key, and no other flag. */
function readGet(command: Extract<EtcdCommand, { kind: "get" }>): EtcdAgentReading {
  if (command.limit !== undefined || command.revision !== undefined || command.consistency !== "l") {
    return refuse("arguments", ETCD_AGENT_SENTENCES.flags);
  }
  if (command.keysOnly) return refuse("metadata-only", ETCD_AGENT_SENTENCES.metadataOnly);
  if (command.countOnly) {
    // The one count the table holds is every key's: a prefix count is an oracle for the key names under it.
    const everyKey = command.key.length === 0 && command.rangeEnd === undefined && command.prefix !== command.fromKey;
    return everyKey ? admit({ op: "key count" }) : refuse("metadata-only", ETCD_AGENT_SENTENCES.metadataOnly);
  }
  if (command.prefix || command.fromKey || command.rangeEnd !== undefined) {
    return refuse("metadata-only", ETCD_AGENT_SENTENCES.metadataOnly);
  }
  if (command.key.length === 0 || command.key.length > ETCD_AGENT_MAX_KEY_BYTES) {
    return refuse("arguments", ETCD_AGENT_SENTENCES.key);
  }
  return admit({ op: "key metadata", key: command.key });
}

/** One agent command read to the request the provider sends, or to why it sends nothing. Never sends anything. */
export function readEtcdAgentStatement(text: string): EtcdAgentReading {
  if (text.trim() === "") return refuse("request", ETCD_AGENT_SENTENCES.empty);
  const parsed = parseEtcdCommand(text, PARSE_LIMITS);
  if (!parsed.ok) {
    return parserRefusal(parsed.refusal.code, parsed.refusal.message);
  }
  if (parsed.parsed.commandTimeoutMs !== undefined) return refuse("arguments", ETCD_AGENT_SENTENCES.flags);
  const { command } = parsed.parsed;
  switch (command.kind) {
    case "get":
      return readGet(command);
    case "endpoint-status":
      return admit({ op: "endpoint status" });
    case "member-list":
      return command.consistency === "l"
        ? admit({ op: "member list" })
        : refuse("arguments", ETCD_AGENT_SENTENCES.flags);
    case "alarm-list":
      return admit({ op: "alarm list" });
    case "auth-status":
      return admit({ op: "auth status" });
    case "lease-list":
      return admit({ op: "lease list" });
    case "lease-timetolive":
      return command.keys
        ? refuse("metadata-only", ETCD_AGENT_SENTENCES.metadataOnly)
        : admit({ op: "lease timetolive", leaseHex: command.leaseHex });
    default:
      return refuse("metadata-only", ETCD_AGENT_SENTENCES.metadataOnly);
  }
}
